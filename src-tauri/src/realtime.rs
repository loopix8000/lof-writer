//! 서재를 동기화 그룹에 연결하고 변경 이벤트가 있을 때만 원본 파일을 교환한다.
//!
//! 페어링 코드로 그룹에 한 번 가입하면 서명된 구성원 목록을 gossip과 연결 확인 요청으로 받아
//! 다른 구성원을 자동으로 찾는다. 파일 비교는 구성원마다 기존 1:1 비교 엔진을 그대로 사용한다.
use crate::{
    error::{fail, fail_invalid, hash_bytes, LofError},
    sync::{
        file_remote::{self, FileRemote, Info, ID_FILE},
        files,
    },
    AppState,
};
use iroh::SecretKey;
use lof_realtime::{
    group::{self, Announcement, Announcer, Event, Group, Member, Subscription},
    Connection, EndpointAddr, Host, Message, Node,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Default)]
pub struct Realtime {
    runtime: Mutex<Option<(tokio::runtime::Handle, Node)>>,
    key: Mutex<Option<SecretKey>>,
    // 현재 서재의 그룹. 설정에는 비밀값을 DPAPI로 암호화해 보관한다.
    group: Mutex<Option<(PathBuf, Option<Group>)>>,
    announcer: Mutex<Option<Announcer>>,
    live: Mutex<HashMap<String, Connection>>,
    dirty: AtomicU64,
    statuses: Mutex<HashMap<String, Value>>,
    invite: Mutex<Option<Invitation>>,
    pairing: Mutex<Option<PairingJob>>,
    lease: Mutex<Option<(String, PathBuf, Instant)>>,
    error: Mutex<String>,
    urgent: Mutex<bool>,
    // 상대가 먼저 접속했거나 gossip으로 다시 보인 장치는 재시도 대기를 건너뛰고 바로 연결한다.
    reconnect: Mutex<HashSet<String>>,
    backgrounded: AtomicBool,
    clear_retries: AtomicBool,
    wake: Condvar,
}
struct Invitation {
    id: String,
    group: String,
    token: String,
    root: PathBuf,
    until: Instant,
    code: String,
    qr: String,
    peer: Option<Value>,
}
impl Invitation {
    fn summary(&self) -> Value {
        let remaining = self
            .until
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        json!({"id":self.id,"remainingMs":remaining,"durationMs":group::INVITE_SECONDS*1000,
            "phase":if self.peer.is_some(){"connected"}else if remaining==0{"expired"}else{"waiting"},"peer":self.peer})
    }
    fn details(&self) -> Value {
        let mut result = self.summary();
        result["code"] = json!(self.code);
        result["qr"] = json!(self.qr);
        result
    }
}
struct PairingJob {
    id: String,
    root: PathBuf,
    cancel: tokio::sync::watch::Sender<bool>,
    result: Value,
}

fn ticket(code: &str) -> Result<group::Ticket, LofError> {
    group::parse_code(code).map_err(|message| fail(message, "PAIR_CODE_INVALID"))
}
fn group_conflict() -> LofError {
    fail(
        "이 서재는 이미 다른 동기화 그룹에 속해 있습니다. 그룹에서 나간 뒤 다시 가입해 주세요.",
        "PAIR_GROUP_CONFLICT",
    )
}
fn conflicts(app: &AppHandle, own: &str, target: &str) -> Result<bool, LofError> {
    with_group(app, |group| {
        Ok(group
            .as_ref()
            .is_some_and(|g| g.id() != target && g.others(own).next().is_some()))
    })
}

fn finish_pair(app: &AppHandle, id: &str, own: &str, result: Result<(Group, Member), LofError>) {
    let rt = app.state::<Realtime>();
    let mut job = rt.pairing.lock().unwrap();
    let Some(job) = job.as_mut().filter(|job| job.id == id) else {
        return;
    };
    if *job.cancel.borrow() {
        return;
    }
    // 완료 직전에도 서재와 취소 상태를 확인한 뒤에만 그룹 정보를 저장한다.
    let committed = result.and_then(|(joined, inviter)| {
        if root(app)? != job.root {
            return Err(fail("연결 중 서재가 변경되었습니다.", "VAULT_CHANGED"));
        }
        with_group(app, |group| {
            match group.as_mut() {
                Some(current) if current.id() == joined.id() => {
                    current.merge(&joined.members, true);
                }
                Some(current) if current.others(own).next().is_some() => {
                    return Err(group_conflict())
                }
                _ => *group = Some(joined.clone()),
            }
            Ok(())
        })?;
        Ok(peer_value(&inviter, &job.root, &Value::Null))
    });
    match committed {
        Ok(peer) => {
            job.result = json!({"id":id,"phase":"connected","peer":peer});
            remote_changed(app);
        }
        Err(error) => {
            job.result = json!({"id":id,"phase":"error","error":error.message,"code":error.code})
        }
    }
}

fn begin_pair(
    app: &AppHandle,
    node: Node,
    handle: tokio::runtime::Handle,
    args: &Value,
) -> Result<Value, LofError> {
    let ticket = ticket(args["code"].as_str().unwrap_or(""))?;
    let own = node.endpoint.id().to_string();
    if ticket.addr.id == node.endpoint.id() {
        return Err(fail(
            "같은 장치의 코드는 사용할 수 없습니다. 다른 장치에서 코드를 만들어 주세요.",
            "PAIR_SELF",
        ));
    }
    if conflicts(app, &own, &ticket.group)? {
        return Err(group_conflict());
    }
    let local_root = root(app)?;
    let local_vault = vault(app)?;
    let id = Uuid::new_v4().to_string();
    let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
    let rt = app.state::<Realtime>();
    let mut pairing = rt.pairing.lock().unwrap();
    if let Some(previous) = pairing
        .as_ref()
        .filter(|p| p.result["phase"] == "connecting")
    {
        if previous.root == local_root {
            return Err(fail("이미 다른 그룹에 가입하고 있습니다.", "PAIR_BUSY"));
        }
        let _ = previous.cancel.send(true);
    }
    *pairing = Some(PairingJob {
        id: id.clone(),
        root: local_root.clone(),
        cancel,
        result: json!({"id":id,"phase":"connecting"}),
    });
    drop(pairing);
    let app = app.clone();
    let attempt = id.clone();
    std::thread::spawn(move || {
        let result=handle.block_on(async {
            let connection=tokio::select!{
                result=node.connect(ticket.addr.clone())=>result.map_err(|error|{eprintln!("그룹 가입 연결 실패: {error}");fail("초대한 장치에 연결하지 못했습니다. 상대 앱과 인터넷 연결을 확인한 뒤 다시 시도해 주세요.","PAIR_NETWORK")})?,
                _=cancelled.changed()=>return Err(fail("연결을 취소했습니다.","PAIR_CANCELLED")),
            };
            let request=json!({"op":"join","group":ticket.group,"vault":local_vault,"token":ticket.token,"name":device_name(),"storage":false});
            let response=tokio::select!{
                result=lof_realtime::request(&connection,Message::json(request))=>result.map_err(|error|{
                    let code=if error.starts_with("페어링 코드가 만료되었습니다."){"PAIR_CODE_EXPIRED"}
                        else if error==group::FULL_MESSAGE{"GROUP_FULL"}
                        else if error.contains("코드"){"PAIR_CODE_REJECTED"}else{"PAIR_NETWORK"};
                    if code=="PAIR_NETWORK" {eprintln!("그룹 가입 응답 오류: {error}");fail("그룹 가입을 완료하지 못했습니다. 상대 앱과 인터넷 연결을 확인한 뒤 다시 시도해 주세요.",code)}else{fail(error,code)}
                }),
                _=cancelled.changed()=>Err(fail("연결을 취소했습니다.","PAIR_CANCELLED")),
            };
            let endpoint=connection.remote_id().to_string();connection.close(0u8.into(),b"joined");
            let reply=response?;
            if root(&app)?!=local_root || vault(&app)?!=local_vault{return Err(fail("연결 중 서재가 변경되었습니다.","VAULT_CHANGED"));}
            let rejected=||fail("페어링 코드와 상대 그룹 정보가 다릅니다. 새 코드를 받아 주세요.","PAIR_CODE_REJECTED");
            let mut joined=Group::from_secret(reply.meta["secret"].as_str().unwrap_or("")).map_err(|_|rejected())?;
            if joined.id()!=ticket.group || reply.meta["group"].as_str()!=Some(ticket.group.as_str()){return Err(rejected());}
            let members:Vec<Member>=serde_json::from_value(reply.meta["members"].clone()).map_err(|_|rejected())?;
            joined.merge(&members,true);
            let inviter=joined.member(&endpoint).cloned().ok_or_else(rejected)?;
            if joined.member(&own).is_none_or(|me|me.vault!=local_vault){return Err(rejected());}
            Ok((joined,inviter))
        });
        finish_pair(&app, &attempt, &own, result);
    });
    Ok(json!({"id":id,"phase":"connecting"}))
}

fn net(error: impl ToString) -> LofError {
    fail(error.to_string(), "REALTIME")
}
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| {
            if cfg!(target_os = "android") {
                "Android 기기".into()
            } else {
                "Lof Writer".into()
            }
        })
        .chars()
        .take(100)
        .collect()
}
fn root(app: &AppHandle) -> Result<PathBuf, LofError> {
    app.state::<AppState>()
        .store
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))
}
fn vault(app: &AppHandle) -> Result<String, LofError> {
    let state = app.state::<AppState>();
    let mut store = state.store.lock().unwrap();
    let store = store
        .as_mut()
        .ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
    store.require_database()?;
    if let Some(id) = store
        .database()?
        .get("realtime-vault-id")?
        .and_then(|v| v.as_str().map(str::to_owned))
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    store.database()?.set("realtime-vault-id", &json!(id))?;
    Ok(id)
}
fn own(app: &AppHandle) -> Option<String> {
    app.state::<Realtime>()
        .key
        .lock()
        .unwrap()
        .as_ref()
        .map(|key| key.public().to_string())
}
fn same_root(entry: &Value, root: &Path) -> bool {
    entry["root"].as_str() == Some(root.to_string_lossy().as_ref())
}
fn load_group(app: &AppHandle, root: &Path) -> Result<Option<Group>, LofError> {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let Some(entry) = settings["realtimeGroups"]
        .as_array()
        .and_then(|list| list.iter().find(|entry| same_root(entry, root)))
    else {
        return Ok(None);
    };
    let secret = crate::dpapi_decrypt(entry["secret"].as_str().unwrap_or(""))?;
    let mut group = Group::from_secret(&secret).map_err(fail_invalid)?;
    group.members = serde_json::from_value(entry["members"].clone()).unwrap_or_default();
    Ok(Some(group))
}
fn save_group(app: &AppHandle, root: &Path, group: Option<&Group>) -> Result<(), LofError> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    let mut next = settings.clone();
    let mut list = next["realtimeGroups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let index = list.iter().position(|entry| same_root(entry, root));
    match group {
        Some(group) => {
            let mut entry = index
                .map(|i| list[i].clone())
                .unwrap_or_else(|| json!({"root":root}));
            if entry["group"].as_str() != Some(group.id().as_str()) {
                entry["group"] = json!(group.id());
                entry["secret"] = json!(crate::dpapi_encrypt(&group.secret)?);
                entry["aliases"] = json!({});
            }
            entry["members"] = json!(group.members);
            match index {
                Some(i) => list[i] = entry,
                None => list.push(entry),
            }
        }
        None => {
            if let Some(i) = index {
                list.remove(i);
            }
        }
    }
    next["realtimeGroups"] = json!(list);
    crate::persist_settings(&state.config_file, &next)?;
    *settings = next;
    Ok(())
}
/// 현재 서재의 그룹을 읽거나 고친다. 바뀐 경우에만 설정에 저장한다.
fn with_group<T>(
    app: &AppHandle,
    edit: impl FnOnce(&mut Option<Group>) -> Result<T, LofError>,
) -> Result<T, LofError> {
    let current = root(app)?;
    let rt = app.state::<Realtime>();
    let mut cache = rt.group.lock().unwrap();
    if cache.as_ref().is_none_or(|(path, _)| *path != current) {
        *cache = Some((current.clone(), load_group(app, &current)?));
    }
    let (_, group) = cache.as_mut().unwrap();
    let mut next = group.clone();
    let result = edit(&mut next)?;
    if next != *group {
        save_group(app, &current, next.as_ref())?;
        *group = next;
    }
    Ok(result)
}
fn aliases(app: &AppHandle, root: &Path) -> Value {
    app.state::<AppState>().settings.lock().unwrap()["realtimeGroups"]
        .as_array()
        .and_then(|list| list.iter().find(|entry| same_root(entry, root)))
        .map(|entry| entry["aliases"].clone())
        .unwrap_or(Value::Null)
}
fn peer_value(member: &Member, root: &Path, aliases: &Value) -> Value {
    json!({"id":format!("{}:{}",member.endpoint,member.vault),"endpoint":member.endpoint,"remoteVault":member.vault,
        "root":root,"name":aliases[&member.endpoint].as_str().unwrap_or(&member.name),"storage":member.storage})
}
/// 이 장치를 제외한 현재 그룹 구성원.
fn peers(app: &AppHandle) -> Vec<Value> {
    let (Some(own), Ok(current)) = (own(app), root(app)) else {
        return Vec::new();
    };
    let members: Vec<Member> = with_group(app, |group| {
        Ok(group
            .as_ref()
            .map(|g| g.others(&own).cloned().collect())
            .unwrap_or_default())
    })
    .unwrap_or_default();
    let aliases = aliases(app, &current);
    members
        .iter()
        .map(|member| peer_value(member, &current, &aliases))
        .collect()
}
pub fn progress(app: &AppHandle) -> Value {
    let list = peers(app);
    if list.is_empty() {
        return json!({ "phase": "idle", "message": "", "hasConnections": false });
    }
    let rt = app.state::<Realtime>();
    let fatal = rt.error.lock().unwrap().clone();
    if !fatal.is_empty() {
        return json!({ "phase": "error", "message": fatal, "hasConnections": true });
    }
    let statuses = rt.statuses.lock().unwrap();
    let mut syncing = false;
    let mut reached = false;
    let mut unreached = Vec::new();
    for peer in &list {
        let id = peer["id"].as_str().unwrap_or("");
        let name = peer["name"].as_str().unwrap_or("다른 장치");
        match statuses.get(id).and_then(|s| s["phase"].as_str()) {
            Some("syncing") => syncing = true,
            Some("connected") => reached = true,
            Some("offline" | "error") => unreached.push(name.to_string()),
            _ => {}
        }
    }
    // 장치 간 연결은 늘 보장되지 않으므로 한 곳이라도 동기화되면 완료로 본다.
    let phase = if syncing {
        "syncing"
    } else if reached {
        "idle"
    } else {
        "pending"
    };
    // 연결되지 않은 장치는 오류로 보지 않고 이름만 안내한다.
    let message = if unreached.is_empty() {
        String::new()
    } else {
        format!("연결되지 않은 장치: {}", unreached.join(", "))
    };
    json!({
        "phase": phase,
        "message": message,
        "hasConnections": true,
    })
}
fn members(app: &AppHandle) -> Vec<Member> {
    with_group(app, |group| {
        Ok(group.as_ref().map(|g| g.members.clone()).unwrap_or_default())
    })
    .unwrap_or_default()
}
/// 다른 구성원이 보낸 목록을 반영한다. 이 장치가 제거된 기록이 오면 그룹에서 나간다.
fn absorb(app: &AppHandle, incoming: &[Member]) -> Result<bool, LofError> {
    let Some(own) = own(app) else {
        return Ok(false);
    };
    if incoming.is_empty() {
        return Ok(false);
    }
    let changed = with_group(app, |group| {
        let Some(current) = group.as_mut() else {
            return Ok(false);
        };
        if !current.merge(incoming, false) {
            return Ok(false);
        }
        if current.member(&own).is_none() {
            *group = None;
        }
        Ok(true)
    })?;
    if changed {
        wake(app);
    }
    Ok(changed)
}
fn announce(app: &AppHandle, announcement: Announcement) {
    let rt = app.state::<Realtime>();
    let handle = rt.runtime.lock().unwrap().as_ref().map(|(h, _)| h.clone());
    let sender = rt.announcer.lock().unwrap().clone();
    if let (Some(handle), Some(sender)) = (handle, sender) {
        handle.spawn(async move {
            let _ = sender.announce(&announcement).await;
        });
    }
}
fn gossip_event(app: &AppHandle, event: Event) {
    match event {
        Event::Announcement(Announcement::Members { members }) => {
            let app = app.clone();
            tokio::task::spawn_blocking(move || {
                let _ = absorb(&app, &members);
            });
        }
        Event::Announcement(Announcement::Changed { endpoint }) | Event::Neighbor(endpoint) => {
            let rt = app.state::<Realtime>();
            rt.reconnect.lock().unwrap().insert(endpoint);
            wake(app);
        }
    }
}
fn authorized(app: &AppHandle, peer: &str, remote_vault: &str) -> Result<Value, LofError> {
    peers(app)
        .into_iter()
        .find(|p| {
            p["endpoint"].as_str() == Some(peer) && p["remoteVault"].as_str() == Some(remote_vault)
        })
        .ok_or_else(|| fail("장치가 이 서재의 동기화 그룹에 없습니다.", "PEER_REVOKED"))
}
pub fn changed(app: &AppHandle) {
    app.state::<Realtime>().dirty.fetch_add(1, Ordering::SeqCst);
}
pub fn configure(app: &AppHandle) {
    app.state::<Realtime>().wake.notify_all();
}
fn wake(app: &AppHandle) {
    let rt = app.state::<Realtime>();
    *rt.urgent.lock().unwrap() = true;
    crate::auto_sync::refresh_realtime(app);
    rt.wake.notify_all();
}
fn remote_changed(app: &AppHandle) {
    changed(app);
    wake(app);
}
pub fn set_background(app: &AppHandle, background: bool) {
    let rt = app.state::<Realtime>();
    let was_bg = rt.backgrounded.swap(background, Ordering::SeqCst);
    if background && !was_bg {
        // 백그라운드 전환 직전 대기 중인 변경분을 즉시 전송하도록 한 번 깨운다.
        wake(app);
    } else if !background && was_bg {
        // 포그라운드 복귀 시 재시도 대기를 초기화하고 즉시 연결·동기화를 재개한다.
        rt.clear_retries.store(true, Ordering::SeqCst);
        remote_changed(app);
    }
}
fn release(app: &AppHandle, session: &str) {
    let realtime = app.state::<Realtime>();
    let mut lease = realtime.lease.lock().unwrap();
    if lease.as_ref().is_some_and(|l| l.0 == session) {
        *lease = None;
        app.state::<AppState>()
            .syncing
            .store(false, Ordering::SeqCst);
    }
}
struct WriterHost(AppHandle);
impl Host for WriterHost {
    fn handle(&self, peer: &str, session: &str, message: Message) -> lof_realtime::Result<Message> {
        let res = self.handle_inner(peer, session, message);
        crate::auto_sync::refresh_realtime(&self.0);
        res
            .map_err(|e| e.message)
    }
    fn disconnected(&self, session: &str) {
        release(&self.0, session);
    }
}
/// 일회용 토큰을 확인한 뒤 가입한 장치를 서명해 구성원에 추가하고 그룹 정보를 돌려준다.
fn join(app: &AppHandle, peer: &str, message: &Message) -> Result<Message, LofError> {
    let rt = app.state::<Realtime>();
    let request = &message.meta;
    if !message.data.is_empty() {
        return Err(fail_invalid("가입 요청 형식 오류"));
    }
    let remote_vault = request["vault"]
        .as_str()
        .filter(|v| Uuid::parse_str(v).is_ok())
        .ok_or_else(|| fail_invalid("서재 식별자 오류"))?;
    let key = rt
        .key
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| fail_invalid("실시간 연결을 준비 중입니다."))?;
    let current = root(app)?;
    let local_vault = vault(app)?;
    let mut invite = rt.invite.lock().unwrap();
    let token = request["token"].as_str().unwrap_or("");
    if !invite.as_ref().is_some_and(|invite| {
        invite.root == current
            && invite.peer.is_none()
            && request["group"].as_str() == Some(invite.group.as_str())
            && token.len() == invite.token.len()
            && bool::from(subtle::ConstantTimeEq::ct_eq(
                token.as_bytes(),
                invite.token.as_bytes(),
            ))
    }) {
        return Err(fail_invalid(
            "페어링 코드가 올바르지 않거나 이미 사용되었습니다. 새 코드를 만들어 주세요.",
        ));
    }
    if Instant::now() >= invite.as_ref().unwrap().until {
        return Err(fail(
            "페어링 코드가 만료되었습니다. 새 코드를 만들어 주세요.",
            "PAIR_CODE_EXPIRED",
        ));
    }
    let expected = invite.as_ref().unwrap().group.clone();
    let name = request["name"].as_str().unwrap_or("다른 장치").to_string();
    let storage = request["storage"].as_bool().unwrap_or(false);
    let (group, joined) = with_group(app, |group| {
        let group = group.as_mut().filter(|g| g.id() == expected).ok_or_else(|| {
            fail_invalid("코드를 만든 뒤 동기화 그룹이 변경되었습니다. 새 코드를 만들어 주세요.")
        })?;
        if group.member(peer).is_none() && group.full() {
            return Err(fail(group::FULL_MESSAGE, "GROUP_FULL"));
        }
        let joined = group.update(&key, peer, remote_vault, &name, storage, false);
        Ok((group.clone(), joined))
    })?;
    invite.as_mut().unwrap().peer = Some(peer_value(&joined, &current, &Value::Null));
    drop(invite);
    announce(
        app,
        Announcement::Members {
            members: group.members.clone(),
        },
    );
    changed(app);
    wake(app);
    Ok(Message::json(json!({"group":group.id(),"secret":group.secret,"members":group.members,
        "vault":local_vault,"name":device_name(),"storage":false})))
}
impl WriterHost {
    fn handle_inner(
        &self,
        peer: &str,
        session: &str,
        message: Message,
    ) -> Result<Message, LofError> {
        let app = &self.0;
        let rt = app.state::<Realtime>();
        let state = app.state::<AppState>();
        let request = &message.meta;
        let op = request["op"].as_str().unwrap_or("");
        if op == "join" {
            return join(app, peer, &message);
        }
        if op == "hello" || op == "members" {
            // 처음 보는 장치도 현재 구성원이 서명한 가입 기록을 가져오면 인증할 수 있다.
            let incoming: Vec<Member> =
                serde_json::from_value(request["members"].clone()).unwrap_or_default();
            absorb(app, &incoming)?;
            if op == "hello" {
                // 제거된 장치에는 제거 기록을 돌려주어 스스로 그룹에서 나가게 한다.
                let (removed, list) = with_group(app, |group| {
                    Ok(group.as_ref().map_or((false, Vec::new()), |g| {
                        (
                            g.member(peer).is_none() && g.members.iter().any(|m| m.endpoint == peer),
                            g.members.clone(),
                        )
                    }))
                })?;
                if removed {
                    return Ok(Message::json(json!({"removed":true,"members":list})));
                }
            }
        }
        let peer_config = authorized(app, peer, request["vault"].as_str().unwrap_or(""))?;
        if request["target"].as_str() != Some(vault(app)?.as_str()) {
            return Err(fail_invalid("연결 대상 서재가 변경되었습니다."));
        }
        if op == "members" {
            return Ok(Message::json(json!(true)));
        }
        if op == "notify" || op == "hello" {
            rt.reconnect.lock().unwrap().insert(peer.to_string());
        }
        if op == "notify" {
            remote_changed(app);
            return Ok(Message::json(json!(true)));
        }
        if op == "hello" {
            wake(app);
            return Ok(Message::json(
                json!({"storage":false,"members":members(app)}),
            ));
        }
        let current = root(app)?;
        let mut lease = rt.lease.lock().unwrap();
        if lease.as_ref().is_some_and(|l| Instant::now() > l.2) {
            *lease = None;
            state.syncing.store(false, Ordering::SeqCst);
        }
        if op == "begin" {
            // 양쪽에서 동시에 전체 비교를 실행하지 않도록 공개키 순서로 담당을 정한다.
            let own = own(app).unwrap_or_default();
            if peer >= own.as_str() && !peer_config["storage"].as_bool().unwrap_or(false) {
                return Err(fail_invalid("다른 장치가 비교를 담당합니다."));
            }
            if state
                .syncing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err(fail("다른 동기화가 진행 중입니다.", "SYNC_BUSY"));
            }
            *lease = Some((
                session.into(),
                current,
                {
                    rt.statuses.lock().unwrap().insert(
                        peer_config["id"].as_str().unwrap_or("").into(),
                        json!({"phase":"syncing"}),
                    );
                    Instant::now() + Duration::from_secs(180)
                },
            ));
            return Ok(Message::json(json!(true)));
        }
        if !lease
            .as_ref()
            .is_some_and(|l| l.0 == session && l.1 == current)
        {
            return Err(fail_invalid("동기화 세션을 다시 연결해 주세요."));
        }
        lease.as_mut().unwrap().2 = Instant::now() + Duration::from_secs(180);
        if op == "end" {
            *lease = None;
            state.syncing.store(false, Ordering::SeqCst);
            drop(lease);
            let mut store = state.store.lock().unwrap();
            if let Some(s) = store.as_mut() {
                s.poll_disk()?;
            }
            drop(store);
            crate::schedule_notify(app, &state.notify_seq);
            rt.statuses.lock().unwrap().insert(
                peer_config["id"].as_str().unwrap_or("").into(),
                json!({"phase":"connected","lastSync":chrono::Utc::now().to_rfc3339()}),
            );
            return Ok(Message::json(json!(true)));
        }
        if op == "touch" {
            return Ok(Message::json(json!(true)));
        }
        if op == "inventory" {
            let mut guard = state.store.lock().unwrap();
            let store = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("서재가 닫혔습니다."))?;
            store.poll_disk()?;
            let list = store.list()?;
            if list["warnings"].as_array().is_some_and(|w| !w.is_empty())
                || store.has_pending_disk_changes()?
            {
                return Err(fail_invalid("상대 서재의 파일 경고를 먼저 확인해 주세요."));
            }
            // 덮어쓰기 전에 이전 원고를 로컬 이력에 기록한다.
            for doc in list["documents"].as_array().into_iter().flatten() {
                if let Some(id) = doc["id"].as_str() {
                    store.read(id)?;
                }
            }
            let mut inventory = file_remote::local_inventory(&current)?;
            for (path, info) in &mut inventory {
                let bytes = files::read_local(&current, path)?
                    .ok_or_else(|| fail_invalid("목록을 읽는 중 파일이 변경되었습니다."))?;
                info.etag = Some(hash_bytes(&bytes));
            }
            inventory.insert(
                ID_FILE.into(),
                Info {
                    size: 36,
                    ..Info::default()
                },
            );
            return Ok(Message::json(serde_json::to_value(inventory).map_err(net)?));
        }
        let path = request["path"]
            .as_str()
            .ok_or_else(|| fail_invalid("파일 경로가 없습니다."))?;
        if path == ID_FILE && op == "read" {
            return Ok(Message {
                meta: json!(null),
                data: vault(app)?.into_bytes(),
            });
        }
        if path == ID_FILE || !file_remote::path_ok(path) || !file_remote::included(path) {
            return Err(fail_invalid("공유할 수 없는 파일 경로입니다."));
        }
        match op {
            "read" => Ok(Message {
                meta: json!(null),
                data: files::read_local(&current, path)?
                    .ok_or_else(|| fail_invalid("파일이 변경되었습니다."))?,
            }),
            "exists" => Ok(Message::json(json!(file_remote::safe_path(
                &current, path
            )?
            .try_exists()?))),
            "write" | "remove" => {
                let expected = request["expected"].as_str();
                files::apply_local(
                    &state.store,
                    &current,
                    path,
                    if op == "write" {
                        Some(&message.data)
                    } else {
                        None
                    },
                    expected,
                    None,
                )?;
                changed(app);
                Ok(Message::json(json!(true)))
            }
            _ => Err(fail_invalid("지원하지 않는 실시간 요청입니다.")),
        }
    }
}

struct PeerRemote {
    connection: Connection,
    handle: tokio::runtime::Handle,
    local_vault: String,
    remote_vault: String,
    last_touch: Instant,
}
impl PeerRemote {
    fn rpc(&self, mut meta: Value, data: Vec<u8>) -> Result<Message, LofError> {
        meta["vault"] = json!(self.local_vault);
        meta["target"] = json!(self.remote_vault);
        self.handle
            .block_on(lof_realtime::request(
                &self.connection,
                Message { meta, data },
            ))
            .map_err(net)
    }
}
impl FileRemote for PeerRemote {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError> {
        serde_json::from_value(self.rpc(json!({"op":"inventory"}), vec![])?.meta).map_err(net)
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, LofError> {
        Ok(self.rpc(json!({"op":"read","path":path}), vec![])?.data)
    }
    fn write(&mut self, path: &str, data: &[u8], previous: Option<&Info>) -> Result<(), LofError> {
        self.rpc(
            json!({"op":"write","path":path,"expected":previous.and_then(|p|p.etag.as_deref())}),
            data.to_vec(),
        )?;
        Ok(())
    }
    fn remove(&mut self, path: &str, previous: &Info) -> Result<(), LofError> {
        self.rpc(
            json!({"op":"remove","path":path,"expected":previous.etag}),
            vec![],
        )?;
        Ok(())
    }
    fn exists(&mut self, path: &str) -> Result<bool, LofError> {
        Ok(self
            .rpc(json!({"op":"exists","path":path}), vec![])?
            .meta
            .as_bool()
            .unwrap_or(false))
    }
    fn heartbeat(&mut self) -> Result<(), LofError> {
        if self.last_touch.elapsed() >= Duration::from_secs(15) {
            self.rpc(json!({"op":"touch"}), vec![])?;
            self.last_touch = Instant::now();
        }
        Ok(())
    }
    fn modified(&mut self, _: &str) -> Result<Option<i64>, LofError> {
        Ok(None)
    }
    fn mkdir_new(&mut self, _: &str) -> Result<bool, LofError> {
        Err(fail_invalid("지원하지 않는 요청"))
    }
    fn rmdir(&mut self, _: &str) -> Result<(), LofError> {
        Err(fail_invalid("지원하지 않는 요청"))
    }
    fn rename(&mut self, _: &str, _: &str) -> Result<(), LofError> {
        Err(fail_invalid("지원하지 않는 요청"))
    }
}
fn sync(
    app: &AppHandle,
    peer: &Value,
    connection: &Connection,
    handle: &tokio::runtime::Handle,
) -> Result<Value, LofError> {
    let state = app.state::<AppState>();
    if state
        .syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(fail("다른 동기화가 진행 중입니다.", "SYNC_BUSY"));
    }
    let _guard = crate::SyncGuard(&state.syncing);
    let current = root(app)?;
    if peer["root"].as_str() != Some(current.to_string_lossy().as_ref()) {
        return Err(fail_invalid("서재가 변경되었습니다."));
    }
    let mut remote = PeerRemote {
        connection: connection.clone(),
        handle: handle.clone(),
        local_vault: vault(app)?,
        remote_vault: peer["remoteVault"].as_str().unwrap_or("").into(),
        last_touch: Instant::now(),
    };
    remote.rpc(json!({"op":"begin"}), vec![])?;
    let result = files::sync_peer(
        &state.store,
        &current,
        peer["id"].as_str().unwrap_or(""),
        &mut remote,
    );
    let ended = remote.rpc(json!({"op":"end","success":result.is_ok()}), vec![]);
    crate::schedule_notify(app, &state.notify_seq);
    result.and_then(|r| ended.map(|_| r))
}

/// 그룹 방식으로 바꾸면서 이전 버전의 1:1 장치 연결은 한 번 초기화한다.
fn reset_legacy_pairing(app: &AppHandle) -> Result<(), LofError> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    if settings.get("realtimePeers").is_none() {
        return Ok(());
    }
    let mut next = settings.clone();
    // 실제로 연결했던 장치가 있었을 때만 초기화 안내를 띄운다.
    if settings["realtimePeers"]
        .as_array()
        .is_some_and(|list| !list.is_empty())
    {
        next["realtimeResetNotice"] = json!(true);
    }
    if let Some(object) = next.as_object_mut() {
        object.remove("realtimePeers");
    }
    crate::persist_settings(&state.config_file, &next)?;
    *settings = next;
    Ok(())
}
fn reset_notice(app: &AppHandle, dismiss: bool) -> Result<Value, LofError> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    // 시작 직후 초기화 작업보다 화면이 먼저 물어도 같은 결과를 돌려준다.
    let pending = settings["realtimeResetNotice"] == true
        || settings["realtimePeers"]
            .as_array()
            .is_some_and(|list| !list.is_empty());
    if dismiss && settings.get("realtimeResetNotice").is_some() {
        let mut next = settings.clone();
        if let Some(object) = next.as_object_mut() {
            object.remove("realtimeResetNotice");
        }
        crate::persist_settings(&state.config_file, &next)?;
        *settings = next;
    }
    Ok(json!(pending && !dismiss))
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), LofError> {
            reset_legacy_pairing(&app)?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(net)?;
            let secret = {
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().unwrap();
                if let Some(saved) = settings["realtimeSecret"].as_str() {
                    crate::dpapi_decrypt(saved)?
                        .parse::<SecretKey>()
                        .map_err(net)?
                } else {
                    let key = SecretKey::generate();
                    let mut next = settings.clone();
                    next["realtimeSecret"] =
                        json!(crate::dpapi_encrypt(&hex::encode(key.to_bytes()))?);
                    crate::persist_settings(&state.config_file, &next)?;
                    *settings = next;
                    key
                }
            };
            *app.state::<Realtime>().key.lock().unwrap() = Some(secret.clone());
            let node = runtime
                .block_on(Node::bind(secret, Arc::new(WriterHost(app.clone()))))
                .map_err(net)?;
            *app.state::<Realtime>().runtime.lock().unwrap() =
                Some((runtime.handle().clone(), node.clone()));
            let own = node.endpoint.id().to_string();
            let mut connected: HashMap<String, (Connection, u64)> = HashMap::new();
            let mut retry: HashMap<String, (Instant, u64)> = HashMap::new();
            let mut previous_root = PathBuf::new();
            let mut subscription: Option<Subscription> = None;
            let mut introduced: Vec<String> = Vec::new();
            let mut announced = u64::MAX;
            while !crate::auto_sync::stopped(&app) {
                let rt = app.state::<Realtime>();
                let current = root(&app)?;
                if current != previous_root {
                    for (conn, _) in connected.values() {
                        conn.close(0u8.into(), b"vault changed");
                    }
                    connected.clear();
                    retry.clear();
                    previous_root = current.clone();
                }
                // 그룹 주제에 참여해 구성원 목록과 변경 알림을 받는다.
                let group = with_group(&app, |group| Ok(group.clone())).unwrap_or(None);
                match &group {
                    None => {
                        subscription = None;
                        introduced.clear();
                        *rt.announcer.lock().unwrap() = None;
                    }
                    Some(group) => {
                        if subscription
                            .as_ref()
                            .is_none_or(|s| s.group != group.id() || s.finished())
                        {
                            drop(subscription.take());
                            let events = app.clone();
                            subscription = runtime
                                .block_on(Subscription::join(&node, group, &own, move |event| {
                                    gossip_event(&events, event)
                                }))
                                .map_err(|error| eprintln!("그룹 알림 참여 실패: {error}"))
                                .ok();
                            *rt.announcer.lock().unwrap() =
                                subscription.as_ref().map(Subscription::sender);
                            introduced = group.others(&own).map(|m| m.endpoint.clone()).collect();
                        }
                        let endpoints: Vec<String> =
                            group.others(&own).map(|m| m.endpoint.clone()).collect();
                        if endpoints != introduced {
                            if let Some(subscription) = &subscription {
                                let _ = runtime
                                    .block_on(subscription.sender().add_peers(group.endpoints(&own)));
                            }
                            introduced = endpoints;
                        }
                    }
                }
                let wanted = peers(&app);
                connected.retain(|id, (conn, _)| {
                    let keep = wanted.iter().any(|p| p["id"].as_str() == Some(id));
                    if !keep {
                        conn.close(0u8.into(), b"revoked");
                    }
                    keep
                });
                if rt.clear_retries.swap(false, Ordering::SeqCst) {
                    retry.clear();
                }
                for endpoint in rt.reconnect.lock().unwrap().drain() {
                    retry.retain(|id, _| id.split(':').next() != Some(endpoint.as_str()));
                }
                let generation = rt.dirty.load(Ordering::SeqCst);
                for peer in wanted {
                    let id = peer["id"].as_str().unwrap_or("").to_string();
                    if connected
                        .get(&id)
                        .is_some_and(|(c, _)| c.close_reason().is_some())
                    {
                        connected.remove(&id);
                    }
                    if retry
                        .get(&id)
                        .is_some_and(|(when, _)| Instant::now() < *when)
                    {
                        continue;
                    }
                    let mut initial = false;
                    let mut unreachable = false;
                    let result = (|| -> Result<(), LofError> {
                        if !connected.contains_key(&id) {
                            // 꺼져 있는 장치는 재시도 중에도 오프라인으로 둔다.
                            let mut statuses = rt.statuses.lock().unwrap();
                            if statuses.get(&id).map(|s| &s["phase"]) != Some(&json!("offline")) {
                                statuses.insert(id.clone(), json!({"phase":"connecting"}));
                            }
                            drop(statuses);
                            crate::auto_sync::refresh_realtime(&app);
                            let endpoint = peer["endpoint"]
                                .as_str()
                                .unwrap_or("")
                                .parse()
                                .map_err(net)?;
                            let conn = runtime
                                .block_on(node.connect(EndpointAddr::new(endpoint)))
                                .map_err(|error| {
                                    unreachable = true;
                                    net(error)
                                })?;
                            let hello = json!({"op":"hello","vault":vault(&app)?,"target":peer["remoteVault"],"members":members(&app)});
                            let reply = runtime
                                .block_on(lof_realtime::request(&conn, Message::json(hello)))
                                .map_err(net)?;
                            let list: Vec<Member> =
                                serde_json::from_value(reply.meta["members"].clone())
                                    .unwrap_or_default();
                            absorb(&app, &list)?;
                            if reply.meta["removed"] == true {
                                conn.close(0u8.into(), b"removed");
                                return Err(fail(
                                    "이 장치가 동기화 그룹에서 제거되었습니다.",
                                    "PEER_REVOKED",
                                ));
                            }
                            connected.insert(id.clone(), (conn, u64::MAX));
                            initial = true;
                        }
                        let (conn, seen) = connected.get_mut(&id).unwrap();
                        if !initial && *seen == generation {
                            return Ok(());
                        }
                        rt.statuses
                            .lock()
                            .unwrap()
                            .insert(id.clone(), json!({"phase":"syncing"}));
                        crate::auto_sync::refresh_realtime(&app);
                        let leader = peer["storage"].as_bool().unwrap_or(false)
                            || own < peer["endpoint"].as_str().unwrap_or("").to_string();
                        if leader {
                            let outcome = sync(&app, &peer, conn, runtime.handle())?;
                            rt.statuses.lock().unwrap().insert(id.clone(),json!({"phase":"connected","lastSync":chrono::Utc::now().to_rfc3339(),"conflicts":outcome["fileConflicts"]}));
                            crate::auto_sync::refresh_realtime(&app);
                        } else {
                            runtime.block_on(lof_realtime::request(conn,Message::json(json!({"op":"notify","vault":vault(&app)?,"target":peer["remoteVault"]})))).map_err(net)?;
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                            status["phase"] = json!("connected");
                            status["message"] = Value::Null;
                            drop(statuses);
                            crate::auto_sync::refresh_realtime(&app);
                        }
                        *seen = generation;
                        Ok(())
                    })();
                    match result {
                        Ok(()) => {
                            retry.remove(&id);
                        }
                        Err(error) => {
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = if unreachable {
                                let last = statuses.get(&id).map(|s| s["lastSync"].clone());
                                json!({"phase":"offline","lastSync":last.unwrap_or(Value::Null)})
                            } else {
                                json!({"phase":"error","message":error.message})
                            };
                            statuses.insert(id.clone(), status);
                            drop(statuses);
                            if let Some((conn, _)) = connected.remove(&id) {
                                conn.close(1u8.into(), b"retry");
                            }
                            let delay = retry.get(&id).map(|(_, d)| (*d * 2).min(60)).unwrap_or(5);
                            retry.insert(id, (Instant::now() + Duration::from_secs(delay), delay));
                        }
                    }
                }
                crate::auto_sync::refresh_realtime(&app);
                *rt.live.lock().unwrap() = connected
                    .iter()
                    .map(|(id, (conn, _))| (id.clone(), conn.clone()))
                    .collect();
                // 연결이 끊긴 구성원도 변경 알림을 받으면 재시도 대기 없이 다시 접속한다.
                if generation != announced && group.is_some() {
                    announce(&app, Announcement::Changed { endpoint: own.clone() });
                    announced = generation;
                }
                // 변경이 없으면 파일 목록이나 본문을 읽지 않고 대기한다.
                loop {
                    let bg = rt.backgrounded.load(Ordering::SeqCst);
                    let (bg_enabled, bg_seconds) = {
                        let state = app.state::<AppState>();
                        let settings = state.settings.lock().unwrap();
                        (
                            crate::auto_sync::background_enabled(&settings),
                            crate::auto_sync::background_interval_seconds(&settings),
                        )
                    };
                    let wait_dur = if bg {
                        Duration::from_secs(bg_seconds)
                    } else {
                        Duration::from_secs(5)
                    };
                    let urgent = rt.urgent.lock().unwrap();
                    let (mut urgent, _) = rt
                        .wake
                        .wait_timeout_while(urgent, wait_dur, |urgent| {
                            if crate::auto_sync::stopped(&app) {
                                return false;
                            }
                            if rt.backgrounded.load(Ordering::SeqCst) && !bg_enabled {
                                return true;
                            }
                            !*urgent
                        })
                        .unwrap();
                    *urgent = false;
                    if crate::auto_sync::stopped(&app)
                        || !rt.backgrounded.load(Ordering::SeqCst)
                        || crate::auto_sync::background_enabled(&app.state::<AppState>().settings.lock().unwrap())
                    {
                        break;
                    }
                }
            }
            drop(subscription);
            runtime.block_on(node.close());
            Ok(())
        })();
        *app.state::<Realtime>().runtime.lock().unwrap() = None;
        if let Err(error) = result {
            *app.state::<Realtime>().error.lock().unwrap() = error.message;
        }
    });
}

/// 이 장치를 그룹에서 제거했다고 서명해 알리고 로컬 그룹 정보를 지운다.
fn leave(app: &AppHandle) -> Result<Value, LofError> {
    let rt = app.state::<Realtime>();
    let key = rt
        .key
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| fail_invalid("실시간 연결을 준비 중입니다."))?;
    let own = key.public().to_string();
    let list = with_group(app, |group| {
        let Some(current) = group.as_mut() else {
            return Ok(None);
        };
        if let Some(me) = current.member(&own).cloned() {
            current.update(&key, &own, &me.vault, &me.name, me.storage, true);
        }
        let list = current.members.clone();
        *group = None;
        Ok(Some(list))
    })?;
    let Some(list) = list else {
        return Ok(json!(true));
    };
    announce(
        app,
        Announcement::Members {
            members: list.clone(),
        },
    );
    let local_vault = vault(app)?;
    let live = std::mem::take(&mut *rt.live.lock().unwrap());
    let handle = rt.runtime.lock().unwrap().as_ref().map(|(h, _)| h.clone());
    if let Some(handle) = handle {
        // 연결된 구성원에게도 직접 알린다. 응답을 오래 기다리지 않는다.
        let _ = std::thread::spawn(move || {
            handle.block_on(async move {
                let tasks: Vec<_> = live
                    .into_iter()
                    .map(|(id, conn)| {
                        let target = id.split(':').nth(1).unwrap_or("").to_string();
                        let meta = json!({"op":"members","vault":local_vault,"target":target,"members":list});
                        tokio::spawn(async move {
                            let _ = lof_realtime::request(&conn, Message::json(meta)).await;
                            conn.close(0u8.into(), b"left");
                        })
                    })
                    .collect();
                let _ = tokio::time::timeout(Duration::from_secs(3), async {
                    for task in tasks {
                        let _ = task.await;
                    }
                })
                .await;
            })
        })
        .join();
    }
    rt.statuses.lock().unwrap().clear();
    *rt.invite.lock().unwrap() = None;
    wake(app);
    Ok(json!(true))
}

pub fn command(app: &AppHandle, method: &str, args: &Value) -> Result<Value, LofError> {
    let rt = app.state::<Realtime>();
    if method == "realtimeStatus" {
        let current = root(app)?;
        let identity = own(app);
        let group = with_group(app, |group| {
            Ok(group.as_ref().map(|g| json!({"id":g.id(),"members":g.active().count()})))
        })?;
        let list: Vec<_> = {
            let peers = peers(app);
            let statuses = rt.statuses.lock().unwrap();
            peers.into_iter()
            .map(|p|json!({"id":p["id"],"name":p["name"],"endpoint":p["endpoint"],"storage":p["storage"],"status":statuses.get(p["id"].as_str().unwrap_or(""))})).collect()
        };
        let invite = rt
            .invite
            .lock()
            .unwrap()
            .as_ref()
            .filter(|i| i.root == current)
            .map(Invitation::summary);
        let pairing = rt
            .pairing
            .lock()
            .unwrap()
            .as_ref()
            .filter(|p| p.root == current)
            .map(|p| p.result.clone());
        let ready = rt.runtime.lock().unwrap().is_some();
        return Ok(
            json!({"uxVersion":2,"scope":current,"endpoint":identity.filter(|_|ready),"group":group,"peers":list,"invite":invite,"pairing":pairing,"error":*rt.error.lock().unwrap()}),
        );
    }
    if method == "realtimeCancelPair" {
        let mut pairing = rt.pairing.lock().unwrap();
        if let Some(job) = pairing
            .as_mut()
            .filter(|job| Some(job.id.as_str()) == args["id"].as_str())
        {
            if job.result["phase"] == "connecting" {
                let _ = job.cancel.send(true);
                job.result = json!({"id":job.id,"phase":"cancelled"});
            }
            let result = job.result.clone();
            if args["dismiss"].as_bool() == Some(true) {
                *pairing = None;
            }
            return Ok(result);
        }
        return Ok(Value::Null);
    }
    if method == "realtimeValidateCode" {
        let ticket = ticket(args["code"].as_str().unwrap_or(""))?;
        let own = own(app).unwrap_or_default();
        if ticket.addr.id.to_string() == own {
            return Err(fail(
                "같은 장치의 코드는 사용할 수 없습니다. 다른 장치에서 코드를 만들어 주세요.",
                "PAIR_SELF",
            ));
        }
        if conflicts(app, &own, &ticket.group)? {
            return Err(group_conflict());
        }
        return Ok(json!(true));
    }
    if method == "realtimeClipboard" {
        #[cfg(not(target_os = "android"))]
        {
            let mut clipboard = arboard::Clipboard::new().map_err(|_| {
                fail_invalid("클립보드를 사용할 수 없습니다. 페어링 코드를 직접 붙여 넣어 주세요.")
            })?;
            if args["action"] == "write" {
                let text = args["text"].as_str().unwrap_or("");
                if text.len() > 16_384 {
                    return Err(fail_invalid("페어링 코드가 너무 깁니다."));
                }
                clipboard.set_text(text.to_owned()).map_err(|_| {
                    fail_invalid("코드를 복사하지 못했습니다. 내용을 펼쳐 직접 복사해 주세요.")
                })?;
                return Ok(json!(true));
            }
            let text = clipboard.get_text().map_err(|_| {
                fail_invalid("클립보드에 텍스트가 없습니다. 다른 장치에서 페어링 코드를 복사해 주세요.")
            })?;
            if text.len() > 16_384 {
                return Err(fail_invalid(
                    "클립보드의 내용이 너무 깁니다. 페어링 코드만 복사해 주세요.",
                ));
            }
            return Ok(json!(text));
        }
        #[cfg(target_os = "android")]
        {
            return Err(fail_invalid(
                "모바일에서는 클립보드 버튼을 통해 브라우저 클립보드를 사용합니다.",
            ));
        }
    }
    if method == "realtimeRename" {
        let current = root(app)?;
        let name = args["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(fail_invalid("장치 이름은 1~100자로 입력해 주세요."));
        }
        let mut peer = peers(app)
            .into_iter()
            .find(|p| p["id"] == args["id"])
            .ok_or_else(|| fail_invalid("그룹 구성원을 찾을 수 없습니다."))?;
        let endpoint = peer["endpoint"].as_str().unwrap_or("").to_string();
        // 장치 이름은 이 장치에서만 쓰는 별칭으로 저장한다.
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        let mut next = settings.clone();
        let entry = next["realtimeGroups"]
            .as_array_mut()
            .and_then(|list| list.iter_mut().find(|entry| same_root(entry, &current)))
            .ok_or_else(|| fail_invalid("그룹 구성원을 찾을 수 없습니다."))?;
        if !entry["aliases"].is_object() {
            entry["aliases"] = json!({});
        }
        entry["aliases"][&endpoint] = json!(name);
        crate::persist_settings(&state.config_file, &next)?;
        *settings = next;
        peer["name"] = json!(name);
        return Ok(peer);
    }
    if method == "realtimeRemove" {
        let key = rt
            .key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| fail_invalid("실시간 연결을 준비 중입니다."))?;
        let target = peers(app)
            .into_iter()
            .find(|p| p["id"] == args["id"])
            .and_then(|p| p["endpoint"].as_str().map(str::to_owned));
        let list = with_group(app, |group| {
            let Some(current) = group.as_mut() else {
                return Ok(None);
            };
            let Some(member) = target.as_deref().and_then(|e| current.member(e)).cloned() else {
                return Ok(None);
            };
            current.update(
                &key,
                &member.endpoint,
                &member.vault,
                &member.name,
                member.storage,
                true,
            );
            Ok(Some(current.members.clone()))
        })?;
        if let Some(list) = list {
            announce(app, Announcement::Members { members: list });
        }
        // 제거한 장치를 완료 화면에 계속 표시하지 않는다.
        let mut invitation = rt.invite.lock().unwrap();
        if invitation
            .as_ref()
            .and_then(|i| i.peer.as_ref())
            .is_some_and(|p| p["id"] == args["id"])
        {
            *invitation = None;
        }
        drop(invitation);
        let mut pairing = rt.pairing.lock().unwrap();
        if pairing.as_ref().is_some_and(|p| {
            p.result["phase"] == "connected" && p.result["peer"]["id"] == args["id"]
        }) {
            *pairing = None;
        }
        drop(pairing);
        changed(app);
        wake(app);
        return Ok(json!(true));
    }
    if method == "realtimeLeave" {
        return leave(app);
    }
    if method == "realtimeResetNotice" || method == "realtimeDismissReset" {
        return reset_notice(app, method == "realtimeDismissReset");
    }
    if method == "realtimeSync" {
        remote_changed(app);
        return Ok(json!(true));
    }
    if method == "realtimeInvite" && args["reuse"].as_bool() == Some(true) {
        let current = root(app)?;
        return Ok(rt
            .invite
            .lock()
            .unwrap()
            .as_ref()
            .filter(|i| i.root == current)
            .map(Invitation::details)
            .unwrap_or(Value::Null));
    }
    let (handle, node) = rt
        .runtime
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| fail_invalid("실시간 연결을 준비 중입니다."))?;
    if method == "realtimeInvite" {
        let invite_root = root(app)?;
        let key = rt
            .key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| fail_invalid("실시간 연결을 준비 중입니다."))?;
        let own = key.public().to_string();
        let local_vault = vault(app)?;
        // 아직 그룹이 없으면 이 서재를 첫 구성원으로 새 그룹을 만든다.
        let group = with_group(app, |group| {
            let current = group
                .get_or_insert_with(|| Group::create(&key, &local_vault, &device_name(), false));
            if current.member(&own).is_none_or(|me| me.vault != local_vault) {
                current.update(&key, &own, &local_vault, &device_name(), false, false);
            }
            if current.full() {
                return Err(fail(group::FULL_MESSAGE, "GROUP_FULL"));
            }
            Ok(current.clone())
        })?;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let code = group.code(&node.endpoint.addr(), &token).map_err(net)?;
        let svg = qrcode::QrCode::new(code.as_bytes())
            .map_err(net)?
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(240, 240)
            .build();
        use base64::{engine::general_purpose::STANDARD, Engine};
        if root(app)? != invite_root {
            return Err(fail(
                "코드를 만드는 중 서재가 변경되었습니다. 다시 만들어 주세요.",
                "VAULT_CHANGED",
            ));
        }
        let invitation = Invitation {
            id: Uuid::new_v4().to_string(),
            group: group.id(),
            token,
            root: invite_root,
            until: Instant::now() + Duration::from_secs(group::INVITE_SECONDS),
            code,
            qr: format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg)),
            peer: None,
        };
        let result = invitation.details();
        *rt.invite.lock().unwrap() = Some(invitation);
        wake(app);
        return Ok(result);
    }
    if method == "realtimePair" {
        return begin_pair(app, node, handle, args);
    }
    Err(fail_invalid("지원하지 않는 실시간 명령입니다."))
}
