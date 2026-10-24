//! 서재를 동기화 그룹에 연결하고 변경 이벤트가 있을 때만 원본 파일을 교환한다.
//!
//! 페어링 코드로 그룹에 한 번 가입하면 서명된 구성원 목록을 gossip과 연결 확인 요청으로 받아
//! 다른 구성원을 자동으로 찾는다. 파일 비교는 구성원마다 기존 1:1 비교 엔진을 그대로 사용한다.
use crate::{
    background_sync::Phase,
    error::{fail, fail_invalid, LofError},
    sync::{
        file_remote::{self, FileRemote, Info, ID_FILE},
        files,
    },
    sync_activity::{SyncPermit, MAX_PEER_SYNCS},
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
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SYNC_BUSY_MESSAGE: &str = "다른 동기화가 진행 중입니다.";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(8);
// 파일 목록을 바뀐 항목만 주고받는 응답 형식. 이전 앱은 이 표시 없이 전체 목록을 보낸다.
const INVENTORY_DELTA: &str = "inventory-delta-v1";
const INVENTORY_INDEX: &str = lof_realtime::file_index::FORMAT;

fn inventory_digest(files: &BTreeMap<String, Info>) -> Result<String, LofError> {
    Ok(crate::error::hash_bytes(&serde_json::to_vec(files).map_err(net)?))
}

struct Session {
    root: PathBuf,
    connection: Connection,
    authenticated: bool,
}

struct ConnectionProbe {
    task: tokio::task::JoinHandle<lof_realtime::Result<(Connection, Message)>>,
    // 기존 연결 확인인지, 새 연결 시도인지 구분한다.
    connection: Option<usize>,
}

type Revision = (u64, u64, u64);
struct PeerSyncJob {
    task: tokio::task::JoinHandle<()>,
    result: mpsc::Receiver<Result<Value, LofError>>,
    connection: usize,
    revision: Revision,
}

struct InboundSync {
    root: PathBuf,
    until: Instant,
    permit: Arc<SyncPermit>,
}

async fn control(
    app: &AppHandle,
    connection: &Connection,
    message: Message,
) -> lof_realtime::Result<Message> {
    let request = lof_realtime::request(connection, message);
    tokio::pin!(request);
    loop {
        match tokio::time::timeout(CONTROL_TIMEOUT, &mut request).await {
            Ok(result) => return result,
            // 파일 전송과 연결 확인이 겹치면 기존 전송 제한 시간 안에서 응답을 더 기다린다.
            Err(_) if app.state::<AppState>().syncing.is_busy() => continue,
            Err(_) => return Err("장치의 연결 확인 응답이 없습니다.".into()),
        }
    }
}

#[derive(Default)]
pub struct Realtime {
    runtime: Mutex<Option<(tokio::runtime::Handle, Node)>>,
    key: Mutex<Option<SecretKey>>,
    // 현재 서재의 그룹. 설정에는 비밀값을 DPAPI로 암호화해 보관한다.
    group: Mutex<Option<(PathBuf, Option<Group>)>>,
    announcer: Mutex<Option<Announcer>>,
    live: Mutex<HashMap<String, Connection>>,
    sessions: Mutex<HashMap<String, Session>>,
    dirty: AtomicU64,
    requested: AtomicU64,
    // 특정 장치가 알린 변경은 그 장치와만 다시 비교하도록 공개키별로 센다.
    peer_requests: Mutex<HashMap<String, u64>>,
    subscription_lost: AtomicBool,
    statuses: Mutex<HashMap<String, Value>>,
    // 그룹 동기화 도중 파일 전송이 시작되면 모든 구성원 작업이 끝날 때까지 전송 방향 표시를 유지한다.
    transfer_activity: Mutex<Option<String>>,
    invite: Mutex<Option<Invitation>>,
    pairing: Mutex<Option<PairingJob>>,
    leases: Mutex<HashMap<String, InboundSync>>,
    error: Mutex<String>,
    urgent: Mutex<bool>,
    // 상대가 먼저 접속했거나 gossip으로 다시 보인 장치는 재시도 대기를 건너뛰고 바로 연결한다.
    reconnect: Mutex<HashSet<String>>,
    backgrounded: AtomicBool,
    clear_retries: AtomicBool,
    // 상대마다 마지막으로 보낸 파일 목록과 받은 파일 목록. 요약값이 맞으면 바뀐 항목만 주고받는다.
    sent_inventories: Mutex<HashMap<String, (String, BTreeMap<String, Info>)>>,
    received_inventories: Mutex<HashMap<String, (String, BTreeMap<String, Info>)>>,
    // 연결된 데몬이 변경 목록 교환을 지원하지 않으면 앱에서 업데이트를 안내한다.
    legacy_daemons: Mutex<HashSet<(PathBuf, String)>>,
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
        Ok(peer_value(&inviter, &job.root))
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
    let name = device_name(app);
    let app = app.clone();
    let attempt = id.clone();
    std::thread::spawn(move || {
        let result=handle.block_on(async {
            let connection=tokio::select!{
                result=node.connect(ticket.addr.clone())=>result.map_err(|error|{eprintln!("그룹 가입 연결 실패: {error}");fail("초대한 장치에 연결하지 못했습니다. 상대 앱과 인터넷 연결을 확인한 뒤 다시 시도해 주세요.","PAIR_NETWORK")})?,
                _=cancelled.changed()=>return Err(fail("연결을 취소했습니다.","PAIR_CANCELLED")),
            };
            let request=json!({"op":"join","group":ticket.group,"vault":local_vault,"token":ticket.token,"name":name,"storage":false});
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
/// 사용자가 정한 이 장치 이름. 없으면 시스템 이름을 쓴다.
fn device_name(app: &AppHandle) -> String {
    let custom = app.state::<AppState>().settings.lock().unwrap()["realtimeDeviceName"]
        .as_str()
        .map(|name| name.trim().chars().take(100).collect::<String>())
        .unwrap_or_default();
    if !custom.is_empty() {
        return custom;
    }
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
/// 현재 그룹에 기록된 이 장치 이름이 설정과 다르면 새 버전으로 서명해 교체한다.
fn sync_own_name(app: &AppHandle, notify: bool) -> Result<(), LofError> {
    let Some(key) = app.state::<Realtime>().key.lock().unwrap().clone() else {
        return Ok(());
    };
    let own = key.public().to_string();
    let name = device_name(app);
    let list = with_group(app, |group| {
        let Some(current) = group.as_mut() else {
            return Ok(None);
        };
        let Some(me) = current.member(&own).cloned() else {
            return Ok(None);
        };
        if me.name == name {
            return Ok(None);
        }
        current.update(&key, &own, &me.vault, &name, me.storage, false);
        Ok(Some(current.members.clone()))
    })?;
    if let Some(members) = list.filter(|_| notify) {
        announce(app, Announcement::Members { members });
    }
    Ok(())
}
fn peer_value(member: &Member, root: &Path) -> Value {
    json!({"id":format!("{}:{}",member.endpoint,member.vault),"endpoint":member.endpoint,"remoteVault":member.vault,
        "root":root,"name":member.name,"storage":member.storage})
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
    members
        .iter()
        .map(|member| peer_value(member, &current))
        .collect()
}
fn daemon_protocol(app: &AppHandle, peer: &Value, supported: bool) {
    if peer["storage"] != true {
        return;
    }
    let Ok(current) = root(app) else { return; };
    let Some(id) = peer["id"].as_str() else { return; };
    let rt = app.state::<Realtime>();
    let key = (current, id.to_string());
    let changed = {
        let mut legacy = rt.legacy_daemons.lock().unwrap();
        if supported {
            legacy.remove(&key)
        } else {
            legacy.insert(key)
        }
    };
    if changed {
        crate::auto_sync::refresh_realtime(app);
    }
}

fn supports_inventory_delta(message: &Value) -> bool {
    message["capabilities"].as_array().is_some_and(|values| {
        values.iter().any(|value| value.as_str() == Some(INVENTORY_DELTA))
    })
}

fn daemon_updates(app: &AppHandle, list: &[Value]) -> Vec<Value> {
    let Ok(current) = root(app) else { return Vec::new(); };
    let rt = app.state::<Realtime>();
    let legacy = rt.legacy_daemons.lock().unwrap();
    let live = rt.live.lock().unwrap();
    list.iter().filter(|peer| {
        let id = peer["id"].as_str().unwrap_or("");
        peer["storage"] == true && legacy.contains(&(current.clone(), id.to_string()))
            && live.get(id).is_some_and(|conn| conn.close_reason().is_none())
    }).map(|peer| json!({"id":peer["id"],"name":peer["name"]})).collect()
}

// 이 장치에서 수행하는 파일 작업을 화면에 알린다.
fn sync_activity(app: &AppHandle, peer: &str, activity: &str) {
    let rt = app.state::<Realtime>();
    if matches!(activity, "uploading" | "downloading") {
        *rt.transfer_activity.lock().unwrap() = Some(activity.to_string());
    }
    let changed = {
        let mut statuses = rt.statuses.lock().unwrap();
        let status = statuses.entry(peer.to_string()).or_insert_with(|| json!({}));
        if status["phase"] == "syncing" && status["activity"] == activity {
            false
        } else {
            status["phase"] = json!("syncing");
            status["activity"] = json!(activity);
            status["message"] = Value::Null;
            true
        }
    };
    if changed {
        crate::auto_sync::refresh_realtime(app);
    }
}

pub fn progress(app: &AppHandle) -> Value {
    let list = peers(app);
    if list.is_empty() {
        return json!({ "phase": "idle", "message": "", "hasConnections": false });
    }
    let rt = app.state::<Realtime>();
    let updates = daemon_updates(app, &list);
    let fatal = rt.error.lock().unwrap().clone();
    if !fatal.is_empty() {
        return json!({ "phase": "error", "message": fatal, "hasConnections": true, "daemonUpdates": updates });
    }
    let statuses = rt.statuses.lock().unwrap();
    let mut syncing = false;
    let mut activity: Option<String> = None;
    let mut pending = false;
    let mut reached = false;
    let mut unreached = Vec::new();
    for peer in &list {
        let id = peer["id"].as_str().unwrap_or("");
        let name = peer["name"].as_str().unwrap_or("다른 장치");
        match statuses.get(id).and_then(|s| s["phase"].as_str()) {
            Some("syncing") => {
                syncing = true;
                let current = statuses.get(id).and_then(|s| s["activity"].as_str());
                if matches!(current, Some("uploading" | "downloading"))
                    && !matches!(activity.as_deref(), Some("uploading" | "downloading"))
                {
                    activity = current.map(str::to_string);
                } else if activity.is_none() {
                    activity = current.map(str::to_string);
                }
            }
            Some("pending") => pending = true,
            Some("connected") => reached = true,
            Some("offline" | "error") => unreached.push(name.to_string()),
            _ => {}
        }
    }
    drop(statuses);
    let mut last_transfer = rt.transfer_activity.lock().unwrap();
    if syncing {
        if matches!(activity.as_deref(), Some("uploading" | "downloading")) {
            *last_transfer = activity.clone();
        } else if last_transfer.is_some() {
            activity = last_transfer.clone();
        }
    } else {
        *last_transfer = None;
    }
    drop(last_transfer);
    // 진행 중인 작업과 대기를 우선하고, 나머지는 연결된 장치가 있으면 완료로 본다.
    let phase = if syncing {
        "syncing"
    } else if pending {
        "pending"
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
    let mut progress = json!({
        "phase": phase,
        "message": message,
        "hasConnections": true,
        "daemonUpdates": updates,
    });
    if let Some(activity) = activity {
        progress["activity"] = json!(activity);
    }
    progress
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
    let mut renamed = None;
    let changed = with_group(app, |group| {
        let Some(current) = group.as_mut() else {
            return Ok(false);
        };
        let previous_name = current.member(&own).map(|me| me.name.clone());
        if !current.merge(incoming, false) {
            return Ok(false);
        }
        match current.member(&own) {
            Some(me) => {
                if previous_name.as_deref() != Some(me.name.as_str()) {
                    renamed = Some(me.name.clone());
                }
            }
            None => *group = None,
        }
        Ok(true)
    })?;
    if let Some(name) = renamed {
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        if settings["realtimeDeviceName"].as_str() != Some(name.as_str()) {
            let mut next = settings.clone();
            next["realtimeDeviceName"] = json!(name);
            crate::persist_settings(&state.config_file, &next)?;
            *settings = next;
        }
    }
    if changed {
        wake(app);
    }
    Ok(changed)
}
fn announce(app: &AppHandle, announcement: Announcement) {
    let rt = app.state::<Realtime>();
    let handle = rt.runtime.lock().unwrap().as_ref().map(|(h, _)| h.clone());
    let sender = rt.announcer.lock().unwrap().clone();
    if let Some(handle) = handle {
        if let Announcement::Members { ref members } = announcement {
            if let Ok(local_vault) = vault(app) {
                let live: Vec<_> = rt
                    .live
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(id, conn)| (id.clone(), conn.clone()))
                    .collect();
                for (id, conn) in live {
                    let target = id.split(':').nth(1).unwrap_or("").to_string();
                    let meta = json!({"op":"members","vault":local_vault,"target":target,"members":members});
                    handle.spawn(async move {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(3),
                            lof_realtime::request(&conn, Message::json(meta)),
                        )
                        .await;
                    });
                }
            }
        }
        if let Some(sender) = sender {
            handle.spawn(async move {
                let _ = sender.announce(&announcement).await;
            });
        }
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
        Event::Announcement(Announcement::Changed { endpoint }) => peer_changed(app, &endpoint),
        // 다시 보인 장치는 재시도 대기만 건너뛴다. 새로 연결되면 그때 비교한다.
        Event::Neighbor(endpoint) => {
            app.state::<Realtime>().reconnect.lock().unwrap().insert(endpoint);
            wake(app);
        }
        Event::SubscriptionClosed => {
            app.state::<Realtime>().subscription_lost.store(true, Ordering::SeqCst);
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
    let rt = app.state::<Realtime>();
    rt.dirty.fetch_add(1, Ordering::SeqCst);
    signal(&rt);
}
pub fn configure(app: &AppHandle) {
    signal(&app.state::<Realtime>());
}
pub fn reconnect(app: &AppHandle) {
    refresh_network(app, true);
}
/// Android는 iroh가 네트워크 변경을 직접 감지하지 못하므로 시스템 알림을 받아 전달한다.
/// 끊긴 장치만 다시 접속하고, 연결된 장치와는 변경이 없으면 다시 비교하지 않는다.
#[cfg(target_os = "android")]
pub fn network_changed(app: &AppHandle) {
    refresh_network(app, false);
}
// 바뀐 네트워크가 있으면 소켓과 중계 연결을 다시 맞춘 뒤 끊긴 장치에 한 번 더 접속한다.
fn refresh_network(app: &AppHandle, recheck: bool) {
    retry_now(app, recheck);
    let runtime = app.state::<Realtime>().runtime.lock().unwrap().clone();
    if let Some((handle, node)) = runtime {
        let app = app.clone();
        handle.spawn(async move {
            node.endpoint.network_change().await;
            tokio::time::sleep(Duration::from_secs(1)).await;
            retry_now(&app, false);
        });
    }
}
// recheck이면 연결된 장치와도 다시 비교한다.
fn retry_now(app: &AppHandle, recheck: bool) {
    app.state::<Realtime>()
        .clear_retries
        .store(true, Ordering::SeqCst);
    if recheck {
        remote_changed(app);
    } else {
        wake(app);
    }
}
fn peer_changed(app: &AppHandle, endpoint: &str) {
    let rt = app.state::<Realtime>();
    *rt.peer_requests.lock().unwrap().entry(endpoint.to_string()).or_default() += 1;
    rt.reconnect.lock().unwrap().insert(endpoint.to_string());
    wake(app);
}
fn signal(rt: &Realtime) {
    *rt.urgent.lock().unwrap() = true;
    rt.wake.notify_all();
}
fn wake(app: &AppHandle) {
    let rt = app.state::<Realtime>();
    signal(&rt);
    crate::auto_sync::refresh_realtime(app);
}
// 연결이 닫히면 대기 중인 동기화 루프를 깨워 바로 재접속을 시도하게 한다.
fn watch_close(runtime: &tokio::runtime::Runtime, app: &AppHandle, conn: &Connection) {
    let conn = conn.clone();
    let app = app.clone();
    runtime.spawn(async move {
        conn.closed().await;
        wake(&app);
    });
}
fn remote_changed(app: &AppHandle) {
    // 상대의 알림은 재전파하지 않고, 실제로 받아 저장한 변경만 다른 장치에 알린다.
    app.state::<Realtime>().requested.fetch_add(1, Ordering::SeqCst);
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
        reconnect(app);
    }
}
fn release(app: &AppHandle, session: &str) {
    app.state::<Realtime>().leases.lock().unwrap().remove(session);
}
struct WriterHost(AppHandle);
impl Host for WriterHost {
    fn connected(&self, _peer: &str, session: &str, connection: Connection) {
        if let Ok(root) = root(&self.0) {
            self.0.state::<Realtime>().sessions.lock().unwrap().insert(
                session.into(),
                Session {
                    root,
                    connection,
                    authenticated: false,
                },
            );
        }
    }
    fn handle(&self, peer: &str, session: &str, message: Message) -> lof_realtime::Result<Message> {
        let error_codes = message.meta["errorCodes"].as_bool().unwrap_or(false);
        let res = self.handle_inner(peer, session, message);
        crate::auto_sync::refresh_realtime(&self.0);
        match res {
            Err(e) if error_codes => Ok(Message::json(json!({"fileError":{"code":e.code,"message":e.message}}))),
            other => other.map_err(|e| e.message),
        }
    }
    fn disconnected(&self, session: &str) {
        release(&self.0, session);
        let rt = self.0.state::<Realtime>();
        let removed = rt.sessions.lock().unwrap().remove(session);
        if let Some(session) = removed {
            session.connection.close(0u8.into(), b"disconnected");
            let mut live = rt.live.lock().unwrap();
            live.retain(|_, connection| connection.stable_id() != session.connection.stable_id());
        }
        wake(&self.0);
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
    invite.as_mut().unwrap().peer = Some(peer_value(&joined, &current));
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
        "vault":local_vault,"name":device_name(app),"storage":false})))
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
        // 전송 계층의 접속만으로는 온라인으로 간주하지 않는다. 서재와 구성원을 확인한
        // 첫 요청에서만 연결을 등록해, 상대가 먼저 연 연결도 양방향으로 재사용한다.
        let current = root(app)?;
        let accepted = {
            let mut sessions = rt.sessions.lock().unwrap();
            sessions.get_mut(session).and_then(|session| {
                if session.root != current || session.authenticated {
                    None
                } else {
                    session.authenticated = true;
                    Some(session.connection.clone())
                }
            })
        };
        if let Some(connection) = accepted {
            let id = peer_config["id"].as_str().unwrap_or("").to_string();
            rt.live.lock().unwrap().insert(id.clone(), connection);
            let mut statuses = rt.statuses.lock().unwrap();
            let status = statuses.entry(id).or_insert_with(|| json!({}));
            if !matches!(status["phase"].as_str(), Some("syncing" | "pending")) {
                status["phase"] = json!("connected");
                status["message"] = Value::Null;
            }
            drop(statuses);
            wake(app);
        }
        if op == "members" {
            return Ok(Message::json(json!(true)));
        }
        if op == "hello" {
            daemon_protocol(app, &peer_config, supports_inventory_delta(request));
            rt.reconnect.lock().unwrap().insert(peer.to_string());
        }
        if op == "notify" {
            peer_changed(app, peer);
            return Ok(Message::json(json!(true)));
        }
        if op == "hello" {
            wake(app);
            return Ok(Message::json(
                json!({"storage":false,"capabilities":[INVENTORY_DELTA, INVENTORY_INDEX],"members":members(app)}),
            ));
        }
        let current = root(app)?;
        let mut leases = rt.leases.lock().unwrap();
        leases.retain(|_, lease| Instant::now() <= lease.until);
        if op == "begin" {
            // 양쪽에서 동시에 전체 비교를 실행하지 않도록 공개키 순서로 담당을 정한다.
            let own = own(app).unwrap_or_default();
            if peer >= own.as_str() && !peer_config["storage"].as_bool().unwrap_or(false) {
                return Err(fail_invalid("다른 장치가 비교를 담당합니다."));
            }
            if leases.contains_key(session) {
                return Err(fail(SYNC_BUSY_MESSAGE, "SYNC_BUSY"));
            }
            let permit = state.syncing.try_peer(peer_config["id"].as_str().unwrap_or(""))
                .ok_or_else(|| fail(SYNC_BUSY_MESSAGE, "SYNC_BUSY"))?;
            leases.insert(session.into(), InboundSync {
                root: current,
                until: Instant::now() + Duration::from_secs(180),
                permit: Arc::new(permit),
            });
            drop(leases);
            sync_activity(app, peer_config["id"].as_str().unwrap_or(""), "comparing");
            wake(app);
            return Ok(Message::json(json!(true)));
        }
        let Some(lease) = leases.get_mut(session).filter(|lease| lease.root == current) else {
            return Err(fail_invalid("동기화 세션을 다시 연결해 주세요."));
        };
        lease.until = Instant::now() + Duration::from_secs(180);
        // 세션 만료·연결 종료 중에도 진행 중인 파일 쓰기까지는 실행 권한을 유지한다.
        let _permit = lease.permit.clone();
        if op == "end" {
            leases.remove(session);
            drop(leases);
            let mut store = state.store.lock().unwrap();
            if let Some(s) = store.as_mut() {
                s.poll_disk()?;
                s.flush_received_history()?;
            }
            drop(store);
            crate::schedule_notify(app, &state.notify_seq);
            rt.statuses.lock().unwrap().insert(
                peer_config["id"].as_str().unwrap_or("").into(),
                json!({"phase":"connected","lastSync":chrono::Utc::now().to_rfc3339()}),
            );
            wake(app);
            return Ok(Message::json(json!(true)));
        }
        drop(leases);
        if op == "touch" {
            return Ok(Message::json(json!(true)));
        }
        if op == "inventory" {
            sync_activity(app, peer_config["id"].as_str().unwrap_or(""), "comparing");
            let mut inventory = files::inventory(&state.store, &current)?;
            // 구형 피어에는 기존 필드만 보내 목록 요약값의 직렬화 규칙을 유지한다.
            if request["index"] != true {
                for info in inventory.values_mut() { info.index = None; }
            }
            // 이전 클라이언트가 보류 표시를 삭제로 오인하지 않도록 지원 여부를 확인한다.
            if request["deferredPaths"] != true && inventory.values().any(|info| info.unavailable) {
                return Err(fail("일부 파일을 확인 중입니다. 연결한 앱을 업데이트해 주세요.", "SYNC_RETRY"));
            }
            inventory.insert(
                ID_FILE.into(),
                Info {
                    size: 36,
                    ..Info::default()
                },
            );
            if request["delta"] != true {
                return Ok(Message::json(serde_json::to_value(inventory).map_err(net)?));
            }
            // 상대가 마지막으로 받은 목록을 가지고 있으면 바뀐 항목과 지워진 경로만 보낸다.
            let digest = inventory_digest(&inventory)?;
            let format = if request["index"] == true { INVENTORY_INDEX } else { INVENTORY_DELTA };
            let key = format!("{peer}\n{}", current.to_string_lossy());
            let mut sent = rt.sent_inventories.lock().unwrap();
            let reply = match sent.get(&key) {
                Some((base, previous)) if request["known"].as_str() == Some(base.as_str()) => {
                    let changed: BTreeMap<&String, &Info> = inventory
                        .iter()
                        .filter(|(path, info)| previous.get(*path) != Some(*info))
                        .collect();
                    let removed: Vec<&String> =
                        previous.keys().filter(|path| !inventory.contains_key(*path)).collect();
                    json!({"format":format,"digest":digest,"base":base,"changed":changed,"removed":removed})
                }
                _ => json!({"format":format,"digest":digest,"files":inventory}),
            };
            sent.insert(key, (digest, inventory));
            return Ok(Message::json(reply));
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
            "read" => {
                sync_activity(app, peer_config["id"].as_str().unwrap_or(""), "uploading");
                Ok(Message {
                    meta: json!(null),
                    data: files::read_for_sync(&state.store, &current, path)?
                        .ok_or_else(|| fail_invalid("파일이 변경되었습니다."))?,
                })
            }
            "exists" => Ok(Message::json(json!(file_remote::safe_path(
                &current, path
            )?
            .try_exists()?))),
            "write" | "remove" => {
                sync_activity(app, peer_config["id"].as_str().unwrap_or(""), "downloading");
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
    app: AppHandle,
    peer: String,
    connection: Connection,
    handle: tokio::runtime::Handle,
    local_vault: String,
    remote_vault: String,
    last_touch: Instant,
}
impl PeerRemote {
    fn rpc(&self, mut meta: Value, data: Vec<u8>) -> Result<Message, LofError> {
        let activity = match meta["op"].as_str() {
            Some("begin" | "inventory") => Some("comparing"),
            Some("read") if meta["path"] != ID_FILE => Some("downloading"),
            Some("write" | "remove") if meta["path"] != ID_FILE => Some("uploading"),
            _ => None,
        };
        if let Some(activity) = activity {
            sync_activity(&self.app, &self.peer, activity);
        }
        meta["vault"] = json!(self.local_vault);
        meta["target"] = json!(self.remote_vault);
        meta["errorCodes"] = json!(true);
        let response = self.handle
            .block_on(lof_realtime::request(
                &self.connection,
                Message { meta, data },
            ))
            .map_err(|error| {
                // 이전 앱도 오류 문구만 전송하므로 수신 시 대기 사유를 복원한다.
                if matches!(error.as_str(), SYNC_BUSY_MESSAGE | "다른 기기가 동기화 중입니다.") {
                    fail(error, "SYNC_BUSY")
                } else if error == crate::store::SYNC_HOLD_MESSAGE || error.contains("다시 비교합니다") {
                    fail(error, "SYNC_RETRY")
                } else {
                    net(error)
                }
            })?;
        if let Some(error) = response.meta.get("fileError") {
            return Err(fail(error["message"].as_str().unwrap_or("파일을 처리하지 못했습니다."),
                error["code"].as_str().unwrap_or("SYNC_RETRY")));
        }
        Ok(response)
    }
}
impl FileRemote for PeerRemote {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError> {
        let key = format!("{}\n{}\n{}", self.peer, self.local_vault, self.remote_vault);
        let app = self.app.clone();
        let rt = app.state::<Realtime>();
        // 지난번에 받은 목록의 요약값을 보내 바뀐 항목만 받는다.
        let mut cached = rt.received_inventories.lock().unwrap().remove(&key);
        for _ in 0..2 {
            let known = cached.as_ref().map(|(digest, _)| digest.clone());
            let mut reply = self
                .rpc(json!({"op":"inventory","deferredPaths":true,"delta":true,"index":true,"known":known}), vec![])?
                .meta;
            if let Some(peer) = peers(&self.app).iter().find(|peer| peer["id"].as_str() == Some(self.peer.as_str())) {
                daemon_protocol(&self.app, peer, matches!(reply["format"].as_str(), Some(INVENTORY_DELTA | INVENTORY_INDEX)));
            }
            if !matches!(reply["format"].as_str(), Some(INVENTORY_DELTA | INVENTORY_INDEX)) {
                // 이전 앱은 요약값을 모르고 항상 전체 목록을 보낸다.
                return serde_json::from_value(reply).map_err(net);
            }
            let digest = reply["digest"].as_str().unwrap_or_default().to_string();
            let full = reply["files"].is_object();
            let files = if full {
                serde_json::from_value::<BTreeMap<String, Info>>(reply["files"].take()).map_err(net)?
            } else {
                let Some((base, mut files)) = cached.take() else { continue };
                if reply["base"].as_str() != Some(base.as_str()) {
                    continue;
                }
                let changed: BTreeMap<String, Info> =
                    serde_json::from_value(reply["changed"].take()).map_err(net)?;
                files.extend(changed);
                for path in reply["removed"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    files.remove(path);
                }
                files
            };
            if inventory_digest(&files)? == digest {
                rt.received_inventories.lock().unwrap().insert(key, (digest, files.clone()));
                return Ok(files);
            }
            // 합친 목록이 상대와 다르면 전체 목록을 다시 받는다.
        }
        Err(fail("파일 목록이 변경되어 다시 비교합니다.", "SYNC_RETRY"))
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
    fn hash_etag(&self) -> bool {
        true
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
    let _guard = state.syncing.try_peer(peer["id"].as_str().unwrap_or(""))
        .ok_or_else(|| fail(SYNC_BUSY_MESSAGE, "SYNC_BUSY"))?;
    let current = root(app)?;
    if peer["root"].as_str() != Some(current.to_string_lossy().as_ref()) {
        return Err(fail_invalid("서재가 변경되었습니다."));
    }
    let mut remote = PeerRemote {
        app: app.clone(),
        peer: peer["id"].as_str().unwrap_or("").into(),
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
    let complete = result.as_ref().is_ok_and(|value| value["deferredFiles"].as_u64().unwrap_or(0) == 0);
    let ended = remote.rpc(json!({"op":"end","success":complete}), vec![]);
    if result.as_ref().is_ok_and(|result| {
        ["downloaded", "removed", "fileConflicts"].iter()
            .any(|key| result[*key].as_u64().unwrap_or(0) > 0)
    }) {
        // 알림만 받은 경우와 구분해, 이 장치에 반영된 변경은 다른 구성원에게도 전한다.
        changed(app);
    }
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
            let mut connected: HashMap<String, (Connection, Revision)> = HashMap::new();
            let mut retry: HashMap<String, (Instant, u64)> = HashMap::new();
            // 접속에 실패한 상대. 재접속 알림이나 앱 복귀 같은 신호가 올 때까지 다시 시도하지 않는다.
            let mut offline: HashSet<String> = HashSet::new();
            let mut probes: HashMap<String, ConnectionProbe> = HashMap::new();
            let mut jobs: HashMap<String, PeerSyncJob> = HashMap::new();
            let mut periodic_active = false;
            let mut periodic_attempted = HashSet::new();
            let mut previous_root = PathBuf::new();
            let mut subscription: Option<Subscription> = None;
            let mut subscription_retry: Option<Instant> = None;
            let mut introduced: Vec<String> = Vec::new();
            let mut announced = u64::MAX;
            let mut network_checked: Option<Instant> = None;
            while !crate::auto_sync::stopped(&app) {
                let rt = app.state::<Realtime>();
                rt.leases.lock().unwrap().retain(|_, lease| Instant::now() <= lease.until);
                // Android는 저장공간 권한을 확인한 뒤 서재를 열므로 서재가 열릴 때까지 기다린다.
                let Ok(current) = root(&app) else {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                };
                if current != previous_root {
                    for (_, job) in jobs.drain() { job.task.abort(); }
                    for (_, probe) in probes.drain() {
                        probe.task.abort();
                    }
                    for (_, conn) in rt.live.lock().unwrap().drain() {
                        conn.close(0u8.into(), b"vault changed");
                    }
                    rt.sessions.lock().unwrap().retain(|_, session| {
                        if session.root == current { return true; }
                        session.connection.close(0u8.into(), b"vault changed");
                        false
                    });
                    rt.leases.lock().unwrap().retain(|_, lease| lease.root == current);
                    for (conn, _) in connected.values() {
                        conn.close(0u8.into(), b"vault changed");
                    }
                    connected.clear();
                    retry.clear();
                    offline.clear();
                    *rt.transfer_activity.lock().unwrap() = None;
                    subscription_retry = None;
                    previous_root = current.clone();
                    // 다른 서재에 있을 때 바꾼 장치 이름은 연결 확인 요청으로 전한다.
                    let _ = sync_own_name(&app, false);
                }
                let phase = crate::background_sync::phase(&app);
                let live = matches!(phase, Phase::Foreground | Phase::Live);
                // 주기 확인·일시 중지 중에는 gossip 연결도 내려 유지 패킷과 별도 재접속을 멈춘다.
                // 주기 확인에 필요한 구성원 정보는 파일 연결의 hello 요청으로도 교환한다.
                let group = with_group(&app, |group| Ok(group.clone())).unwrap_or(None);
                match &group {
                    _ if !live => {
                        *rt.announcer.lock().unwrap() = None;
                        subscription = None;
                        subscription_retry = None;
                        introduced.clear();
                    }
                    None => {
                        subscription = None;
                        subscription_retry = None;
                        introduced.clear();
                        *rt.announcer.lock().unwrap() = None;
                    }
                    Some(group) => {
                        let lost = rt.subscription_lost.swap(false, Ordering::SeqCst);
                        if lost || subscription
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
                            subscription_retry = subscription.is_none().then(|| Instant::now() + Duration::from_secs(30));
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
                crate::background_sync::refresh(&app, !wanted.is_empty());
                if phase == Phase::Periodic && !periodic_active {
                    // 주기 확인에서는 재시도 대기와 관계없이 모든 구성원을 확인한다.
                    retry.clear();
                    offline.clear();
                    periodic_active = true;
                    periodic_attempted.clear();
                }
                if phase != Phase::Periodic { periodic_active = false; }
                retry.retain(|id, _| wanted.iter().any(|peer| peer["id"].as_str() == Some(id.as_str())));
                offline.retain(|id| wanted.iter().any(|peer| peer["id"].as_str() == Some(id.as_str())));
                probes.retain(|id, probe| {
                    let keep = wanted.iter().any(|peer| peer["id"].as_str() == Some(id.as_str()));
                    if !keep { probe.task.abort(); }
                    keep
                });
                rt.live.lock().unwrap().retain(|id, connection| {
                    let keep = connection.close_reason().is_none()
                        && wanted.iter().any(|peer| peer["id"].as_str() == Some(id.as_str()));
                    if !keep { connection.close(0u8.into(), b"revoked or closed"); }
                    keep
                });
                connected.retain(|id, (conn, _)| {
                    let keep = wanted.iter().any(|p| p["id"].as_str() == Some(id));
                    if !keep {
                        conn.close(0u8.into(), b"revoked");
                    }
                    keep
                });
                jobs.retain(|id, job| {
                    let keep = connected.get(id).is_some_and(|(conn, _)|
                        conn.stable_id() == job.connection && conn.close_reason().is_none());
                    if !keep { job.task.abort(); }
                    keep
                });
                let completed: Vec<_> = jobs.iter().filter_map(|(id, job)| {
                    match job.result.try_recv() {
                        Ok(result) => Some((id.clone(), result)),
                        Err(mpsc::TryRecvError::Disconnected) => Some((id.clone(), Err(fail(
                            "장치 동기화 작업이 종료되었습니다.", "SYNC_CONNECTION")))),
                        Err(mpsc::TryRecvError::Empty) => None,
                    }
                }).collect();
                for (id, result) in completed {
                    let job = jobs.remove(&id).unwrap();
                    // 이미 교체된 연결의 완료 결과로 새 연결 상태를 바꾸지 않는다.
                    let Some((conn, seen)) = connected.get_mut(&id)
                        .filter(|(conn, _)| conn.stable_id() == job.connection) else { continue; };
                    match result {
                        Ok(outcome) => {
                            *seen = job.revision;
                            retry.remove(&id);
                            offline.remove(&id);
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = statuses.entry(id).or_insert_with(|| json!({}));
                            if !outcome.is_null() {
                                *status = json!({"phase":"connected","lastSync":chrono::Utc::now().to_rfc3339(),"conflicts":outcome["fileConflicts"]});
                            } else if !matches!(status["phase"].as_str(), Some("syncing" | "pending")) {
                                status["phase"] = json!("connected");
                                status["message"] = Value::Null;
                            }
                        }
                        Err(error) if matches!(error.code.as_str(), "SYNC_BUSY" | "SYNC_RETRY") => {
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                            status["phase"] = json!("pending");
                            status["message"] = Value::Null;
                            retry.insert(id, (Instant::now() + Duration::from_secs(2), 2));
                        }
                        Err(error) => {
                            rt.statuses.lock().unwrap().insert(id.clone(), json!({"phase":"error","message":error.message}));
                            conn.close(1u8.into(), b"retry");
                            connected.remove(&id);
                            rt.live.lock().unwrap().retain(|key, conn|
                                key != &id || conn.close_reason().is_none());
                            offline.insert(id);
                        }
                    }
                }
                if rt.clear_retries.swap(false, Ordering::SeqCst) {
                    retry.clear();
                    offline.clear();
                    probes.retain(|_, probe| {
                        if probe.connection.is_some() { return true; }
                        probe.task.abort();
                        false
                    });
                }
                for endpoint in rt.reconnect.lock().unwrap().drain() {
                    retry.retain(|id, _| id.split(':').next() != Some(endpoint.as_str()));
                    offline.retain(|id| id.split(':').next() != Some(endpoint.as_str()));
                }
                let generation = rt.dirty.load(Ordering::SeqCst);
                let requested = rt.requested.load(Ordering::SeqCst);
                let peer_requests = rt.peer_requests.lock().unwrap().clone();
                for peer in wanted {
                    if phase == Phase::Paused { break; }
                    let id = peer["id"].as_str().unwrap_or("").to_string();
                    let asked = peer["endpoint"].as_str().and_then(|endpoint| peer_requests.get(endpoint)).copied().unwrap_or(0);
                    let revision = (generation, requested, asked);
                    let accepted = rt.live.lock().unwrap().get(&id).cloned();
                    if let Some(conn) = accepted {
                        if connected.get(&id).is_none_or(|(old, _)| old.stable_id() != conn.stable_id()) {
                            watch_close(&runtime, &app, &conn);
                            connected.insert(id.clone(), (conn, (u64::MAX, u64::MAX, u64::MAX)));
                            retry.remove(&id);
                            offline.remove(&id);
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                            if !matches!(status["phase"].as_str(), Some("syncing" | "pending")) {
                                status["phase"] = json!("connected");
                                status["message"] = Value::Null;
                            }
                            drop(statuses);
                            if probes.get(&id).is_some_and(|probe| probe.connection.is_none()) {
                                if let Some(probe) = probes.remove(&id) { probe.task.abort(); }
                            }
                        }
                    }
                    if connected
                        .get(&id)
                        .is_some_and(|(c, _)| c.close_reason().is_some())
                    {
                        connected.remove(&id);
                        if matches!(phase, Phase::Foreground | Phase::Live) {
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                            status["phase"] = json!("offline");
                            status["message"] = Value::Null;
                        }
                    }
                    if probes.get(&id).is_some_and(|probe| probe.task.is_finished()) {
                        let probe = probes.remove(&id).unwrap();
                        let result = runtime.block_on(probe.task)
                            .map_err(|error| error.to_string()).and_then(|result| result);
                        // 새 연결이 성립한 뒤 오래된 확인 결과로 다시 끊지 않는다.
                        let obsolete = probe.connection.is_some_and(|checked_id|
                            connected.get(&id).is_some_and(|(conn, _)| conn.stable_id() != checked_id));
                        if !obsolete {
                            let result = result.and_then(|(conn, reply)| {
                                let list: Vec<Member> = serde_json::from_value(reply.meta["members"].clone()).unwrap_or_default();
                                absorb(&app, &list).map_err(|error| error.message)?;
                                if reply.meta["removed"] == true {
                                    conn.close(0u8.into(), b"removed");
                                    return Err("이 장치가 동기화 그룹에서 제거되었습니다.".into());
                                }
                                daemon_protocol(&app, &peer, supports_inventory_delta(&reply.meta));
                                if !connected.contains_key(&id) {
                                    rt.live.lock().unwrap().insert(id.clone(), conn.clone());
                                    watch_close(&runtime, &app, &conn);
                                    connected.insert(id.clone(), (conn, (u64::MAX, u64::MAX, u64::MAX)));
                                }
                                Ok(())
                            });
                            match result {
                                Ok(()) => {
                                    retry.remove(&id);
                                    offline.remove(&id);
                                    let mut statuses = rt.statuses.lock().unwrap();
                                    let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                                    if !matches!(status["phase"].as_str(), Some("syncing" | "pending")) {
                                        status["phase"] = json!("connected");
                                        status["message"] = Value::Null;
                                    }
                                }
                                Err(_) if probe.connection.is_none() && connected.contains_key(&id) => {
                                    // 역방향 연결이 먼저 성공했으면 별도 발신 실패는 무시한다.
                                    retry.remove(&id);
                                    offline.remove(&id);
                                }
                                Err(_) => {
                                    if let Some((conn, _)) = connected.remove(&id) {
                                        conn.close(1u8.into(), b"connection check failed");
                                    }
                                    rt.live.lock().unwrap().retain(|key, conn|
                                        key != &id || conn.close_reason().is_none());
                                    let mut statuses = rt.statuses.lock().unwrap();
                                    let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                                    status["phase"] = json!("offline");
                                    status["message"] = Value::Null;
                                    drop(statuses);
                                    // 감지하지 못한 네트워크 변경으로 접속이 계속 실패할 수 있어 주소를 다시 확인한다.
                                    let network_interval = if phase == Phase::Live { 300 } else { 60 };
                                    if probe.connection.is_none()
                                        && network_checked.is_none_or(|at| at.elapsed() >= Duration::from_secs(network_interval))
                                    {
                                        network_checked = Some(Instant::now());
                                        let node = node.clone();
                                        runtime.spawn(async move { node.endpoint.network_change().await });
                                    }
                                    offline.insert(id.clone());
                                }
                            }
                        }
                    }
                    if retry
                        .get(&id)
                        .is_some_and(|(when, _)| Instant::now() < *when)
                    {
                        continue;
                    }
                    if offline.contains(&id) {
                        continue;
                    }
                    // 연결된 뒤에는 라이브러리의 연결 유지 신호가 끊김을 감지하므로 별도 확인 요청을 보내지 않는다.
                    if !connected.contains_key(&id) && !probes.contains_key(&id)
                        && (phase != Phase::Periodic || !periodic_attempted.contains(&id)) {
                        let existing = connected.get(&id).map(|(conn, _)| conn.clone());
                        let connection = existing.as_ref().map(Connection::stable_id);
                        if existing.is_none() {
                            let mut statuses = rt.statuses.lock().unwrap();
                            if statuses.get(&id).and_then(|s| s["phase"].as_str()) != Some("offline") {
                                statuses.insert(id.clone(), json!({"phase":"connecting"}));
                            }
                        }
                        let node = node.clone();
                        let events = app.clone();
                        let endpoint = peer["endpoint"].as_str().unwrap_or("").to_string();
                        let hello = json!({"op":"hello","vault":vault(&app)?,"target":peer["remoteVault"],"capabilities":[INVENTORY_DELTA, INVENTORY_INDEX],"members":members(&app)});
                        let task = runtime.spawn(async move {
                            let result = async {
                                let conn = match existing {
                                    Some(conn) => conn,
                                    None => node.connect(EndpointAddr::new(endpoint.parse().map_err(|error| format!("{error}"))?)).await?,
                                };
                                match control(&events, &conn, Message::json(hello)).await {
                                    Ok(reply) => Ok((conn, reply)),
                                    Err(error) => {
                                        if connection.is_none() {
                                            conn.close(1u8.into(), b"connection check failed");
                                        }
                                        Err(error)
                                    }
                                }
                            }.await;
                            wake(&events);
                            result
                        });
                        probes.insert(id.clone(), ConnectionProbe { task, connection });
                        periodic_attempted.insert(id.clone());
                    }
                    if !connected.contains_key(&id) || probes.contains_key(&id)
                        || jobs.contains_key(&id) || jobs.len() >= MAX_PEER_SYNCS {
                        continue;
                    }
                    let (conn, seen) = connected.get(&id).unwrap();
                    if *seen == revision { continue; }
                    let leader = peer["storage"].as_bool().unwrap_or(false)
                        || own < peer["endpoint"].as_str().unwrap_or("").to_string();
                    if leader {
                        let mut statuses = rt.statuses.lock().unwrap();
                        let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                        if status["phase"] != "syncing" {
                            status["phase"] = json!("syncing");
                            status["activity"] = json!("comparing");
                            status["message"] = Value::Null;
                        }
                    }
                    let connection = conn.stable_id();
                    let conn = conn.clone();
                    let events = app.clone();
                    let handle = runtime.handle().clone();
                    let (sender, result) = mpsc::channel();
                    let task = runtime.spawn(async move {
                        let worker_app = events.clone();
                        let outcome = tokio::task::spawn_blocking(move || {
                            if leader {
                                let outcome = sync(&worker_app, &peer, &conn, &handle)?;
                                if outcome["deferredFiles"].as_u64().unwrap_or(0) > 0 {
                                    return Err(fail("일부 문서의 정리를 기다리고 있습니다.", "SYNC_RETRY"));
                                }
                                Ok(outcome)
                            } else {
                                handle.block_on(control(&worker_app, &conn, Message::json(json!({
                                    "op":"notify","vault":vault(&worker_app)?,"target":peer["remoteVault"]
                                })))).map_err(net)?;
                                Ok(Value::Null)
                            }
                        }).await.unwrap_or_else(|error| Err(net(error)));
                        // 결과를 넣은 뒤 깨워 완료 알림과 대기 진입 사이의 누락을 막는다.
                        let _ = sender.send(outcome);
                        wake(&events);
                    });
                    jobs.insert(id, PeerSyncJob { task, result, connection, revision });
                }
                crate::auto_sync::refresh_realtime(&app);
                // 연결이 끊긴 구성원도 변경 알림을 받으면 재시도 대기 없이 다시 접속한다.
                if generation != announced && subscription.is_some() {
                    announce(&app, Announcement::Changed { endpoint: own.clone() });
                    announced = generation;
                }
                if matches!(phase, Phase::Periodic | Phase::Paused) {
                    if phase == Phase::Periodic && (!probes.is_empty() || !jobs.is_empty() || !rt.leases.lock().unwrap().is_empty()) {
                        // 전송을 마칠 때까지 기다리되, 진행 중에는 별도 상태 확인 패킷을 보내지 않는다.
                        let mut urgent = rt.urgent.lock().unwrap();
                        if *urgent {
                            *urgent = false;
                        } else {
                            let probe = (!probes.is_empty()).then(|| Instant::now() + Duration::from_millis(250));
                            let lease = rt.leases.lock().unwrap().values().map(|lease| lease.until).min();
                            if let Some(deadline) = probe.into_iter().chain(lease).min() {
                                drop(rt.wake.wait_timeout(urgent, deadline.saturating_duration_since(Instant::now())).unwrap());
                            } else {
                                drop(rt.wake.wait(urgent).unwrap());
                            }
                        }
                        continue;
                    }
                    for (_, job) in jobs.drain() { job.task.abort(); }
                    // 확인을 마치면 연결을 닫아 다음 주기까지 배터리를 아낀다.
                    for (conn, _) in connected.values() {
                        conn.close(0u8.into(), b"background");
                    }
                    connected.clear();
                    for (_, probe) in probes.drain() { probe.task.abort(); }
                    for (_, conn) in rt.live.lock().unwrap().drain() {
                        conn.close(0u8.into(), b"background");
                    }
                    // 인증 대기나 교체된 연결도 전송 작업이 참조할 수 있어 핸들 해제만으로는 닫히지 않는다.
                    for session in rt.sessions.lock().unwrap().values() {
                        session.connection.close(0u8.into(), b"background");
                    }
                    rt.leases.lock().unwrap().clear();
                    periodic_active = false;
                    if phase == Phase::Periodic { crate::background_sync::realtime_done(&app); }
                }
                // 화면에 있거나 즉시 동기화를 유지하는 동안 저장·수신·접속 알림을 기다린다.
                // 이후에는 알림을 미루고 주기 확인 시각에만 깨어난다.
                loop {
                    let current_phase = crate::background_sync::phase(&app);
                    if current_phase != phase { break; }
                    let mut urgent = rt.urgent.lock().unwrap();
                    if crate::auto_sync::stopped(&app) {
                        break;
                    }
                    let deadline = match current_phase {
                        Phase::Foreground | Phase::Live => {
                            if *urgent {
                                *urgent = false;
                                break;
                            }
                            let live = (current_phase == Phase::Live)
                                .then(|| crate::background_sync::live_deadline(&app))
                                .flatten();
                            let pending = (!probes.is_empty()).then(|| Instant::now() + Duration::from_millis(250));
                            let lease = rt.leases.lock().unwrap().values().map(|lease| lease.until).min();
                            retry.iter().filter(|(id, (when, _))|
                                *when > Instant::now() && !probes.contains_key(*id) && !jobs.contains_key(*id)).map(|(_, (when, _))| *when)
                                .chain(subscription_retry).chain(live).chain(pending).chain(lease).min()
                        }
                        Phase::Periodic => {
                            *urgent = false;
                            if crate::background_sync::take_tick(&app) {
                                break;
                            }
                            // 실시간 유지가 막 끝났으면 바로 첫 확인을 한다.
                            let Some(next) = crate::background_sync::next_tick(&app) else { break };
                            Some(next)
                        }
                        Phase::Paused => {
                            *urgent = false;
                            None
                        }
                    };
                    // 설정 변경이나 앱 복귀 알림을 놓치지 않도록 깨어날 때마다 상태를 다시 읽는다.
                    if let Some(deadline) = deadline {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        let waited = rt.wake.wait_timeout(urgent, remaining).unwrap();
                        if waited.1.timed_out() { break; }
                    } else {
                        drop(rt.wake.wait(urgent).unwrap());
                    }
                }
            }
            for (_, probe) in probes { probe.task.abort(); }
            for (_, job) in jobs { job.task.abort(); }
            drop(subscription);
            runtime.block_on(node.close());
            app.state::<Realtime>().leases.lock().unwrap().clear();
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
    rt.legacy_daemons.lock().unwrap().clear();
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
            let updates = daemon_updates(app, &peers);
            let statuses = rt.statuses.lock().unwrap();
            peers.into_iter()
            .map(|p|json!({"id":p["id"],"name":p["name"],"endpoint":p["endpoint"],"storage":p["storage"],"updateRequired":updates.iter().any(|update| update["id"] == p["id"]),"status":statuses.get(p["id"].as_str().unwrap_or(""))})).collect()
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
        let device = json!({"name":device_name(app)});
        return Ok(
            json!({"uxVersion":2,"scope":current,"endpoint":identity.filter(|_|ready),"device":device,"group":group,"peers":list,"invite":invite,"pairing":pairing,"error":*rt.error.lock().unwrap()}),
        );
    }
    if method == "realtimeRenameDevice" {
        let name = args["name"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(fail_invalid("장치 이름은 1~100자로 입력해 주세요."));
        }
        // 이 장치 이름은 모든 서재에 공통으로 쓰고, 현재 그룹에는 바로 알린다.
        let state = app.state::<AppState>();
        {
            let mut settings = state.settings.lock().unwrap();
            let mut next = settings.clone();
            next["realtimeDeviceName"] = json!(name);
            crate::persist_settings(&state.config_file, &next)?;
            *settings = next;
        }
        if root(app).is_ok() {
            sync_own_name(app, true)?;
        }
        return Ok(json!({"name":name}));
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
        let key = rt
            .key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| fail_invalid("실시간 연결을 준비 중입니다."))?;
        let target = peers(app)
            .into_iter()
            .find(|p| p["id"] == args["id"])
            .and_then(|p| p["endpoint"].as_str().map(str::to_owned))
            .ok_or_else(|| fail_invalid("그룹 구성원을 찾을 수 없습니다."))?;
        // 구성원 이름을 새 버전으로 서명해 그룹의 다른 기기에도 함께 반영한다.
        let (peer, list) = with_group(app, |group| {
            let current_group = group
                .as_mut()
                .ok_or_else(|| fail_invalid("그룹 구성원을 찾을 수 없습니다."))?;
            let member = current_group
                .member(&target)
                .cloned()
                .ok_or_else(|| fail_invalid("그룹 구성원을 찾을 수 없습니다."))?;
            let updated = current_group.update(
                &key,
                &member.endpoint,
                &member.vault,
                name,
                member.storage,
                false,
            );
            Ok((
                peer_value(&updated, &current),
                current_group.members.clone(),
            ))
        })?;
        announce(app, Announcement::Members { members: list });
        if let Some(invite_peer) = rt
            .invite
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|i| i.peer.as_mut())
            .filter(|p| p["id"] == args["id"])
        {
            invite_peer["name"] = json!(peer["name"]);
        }
        if let Some(pairing) = rt
            .pairing
            .lock()
            .unwrap()
            .as_mut()
            .filter(|p| p.result["phase"] == "connected" && p.result["peer"]["id"] == args["id"])
        {
            pairing.result["peer"]["name"] = json!(peer["name"]);
        }
        wake(app);
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
        reconnect(app);
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
        let name = device_name(app);
        // 아직 그룹이 없으면 이 서재를 첫 구성원으로 새 그룹을 만든다.
        let group = with_group(app, |group| {
            let current =
                group.get_or_insert_with(|| Group::create(&key, &local_vault, &name, false));
            if current.member(&own).is_none_or(|me| me.vault != local_vault) {
                current.update(&key, &own, &local_vault, &name, false, false);
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
