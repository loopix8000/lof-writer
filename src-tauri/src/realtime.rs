//! 장치 공개키를 서재에 연결하고 변경 이벤트가 있을 때만 원본 파일을 교환한다.
use crate::{
    error::{fail, fail_invalid, hash_bytes, LofError},
    sync::{
        file_remote::{self, FileRemote, Info, ID_FILE},
        files,
    },
    AppState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::SecretKey;
use lof_realtime::{Connection, EndpointAddr, Host, Message, Node};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Default)]
pub struct Realtime {
    runtime: Mutex<Option<(tokio::runtime::Handle, Node)>>,
    dirty: AtomicU64,
    statuses: Mutex<HashMap<String, Value>>,
    invite: Mutex<Option<Invitation>>,
    pairing: Mutex<Option<PairingJob>>,
    lease: Mutex<Option<(String, PathBuf, Instant)>>,
    error: Mutex<String>,
    urgent: Mutex<bool>,
    wake: Condvar,
}
struct Invitation {
    id: String,
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
        json!({"id":self.id,"remainingMs":remaining,"durationMs":600_000,
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

fn ticket(code: &str) -> Result<(Value, EndpointAddr), LofError> {
    let invalid = || {
        fail("연결 코드 형식이 올바르지 않습니다. 다른 장치에서 복사한 코드 전체를 붙여 넣어 주세요.","PAIR_CODE_INVALID")
    };
    if code.len() > 16_384 {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(code.strip_prefix("lof-peer://").ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if value["version"] != 1
        || Uuid::parse_str(value["vault"].as_str().unwrap_or("")).is_err()
        || value["token"]
            .as_str()
            .is_none_or(|token| token.is_empty() || token.len() > 256)
    {
        return Err(invalid());
    }
    let address = serde_json::from_value(value["addr"].clone()).map_err(|_| invalid())?;
    Ok((value, address))
}

fn finish_pair(app: &AppHandle, id: &str, result: Result<Value, LofError>) {
    let rt = app.state::<Realtime>();
    let mut job = rt.pairing.lock().unwrap();
    let Some(job) = job.as_mut().filter(|job| job.id == id) else {
        return;
    };
    if *job.cancel.borrow() {
        return;
    }
    match result {
        Ok(peer) => {
            // 완료 직전에도 서재와 취소 상태를 확인한 뒤에만 연결 정보를 저장한다.
            let committed = (|| {
                if root(app)? != job.root {
                    return Err(fail("연결 중 서재가 변경되었습니다.", "VAULT_CHANGED"));
                }
                save_peer(app, peer.clone())?;
                Ok(())
            })();
            match committed {
                Ok(()) => {
                    job.result = json!({"id":id,"phase":"connected","peer":peer});
                    remote_changed(app);
                }
                Err(error) => {
                    job.result =
                        json!({"id":id,"phase":"error","error":error.message,"code":error.code})
                }
            }
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
    let (ticket, address) = ticket(args["code"].as_str().unwrap_or("").trim())?;
    if address.id == node.endpoint.id() {
        return Err(fail(
            "같은 장치의 코드는 사용할 수 없습니다. 다른 장치에서 코드를 만들어 주세요.",
            "PAIR_SELF",
        ));
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
            return Err(fail("이미 다른 장치에 연결하고 있습니다.", "PAIR_BUSY"));
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
                result=node.connect(address)=>result.map_err(|error|{eprintln!("장치 연결 실패: {error}");fail("다른 장치에 연결하지 못했습니다. 상대 앱과 인터넷 연결을 확인한 뒤 다시 시도해 주세요.","PAIR_NETWORK")})?,
                _=cancelled.changed()=>return Err(fail("연결을 취소했습니다.","PAIR_CANCELLED")),
            };
            let response=tokio::select!{
                result=lof_realtime::request(&connection,Message::json(json!({"op":"pair","vault":local_vault,"token":ticket["token"],"name":device_name()})))=>result.map_err(|error|{
                    let code=if error.starts_with("연결 코드가 만료되었습니다."){"PAIR_CODE_EXPIRED"}
                        else if error.contains("연결 코드"){"PAIR_CODE_REJECTED"}else{"PAIR_NETWORK"};
                    if code=="PAIR_NETWORK" {eprintln!("장치 연결 응답 오류: {error}");fail("연결을 완료하지 못했습니다. 상대 앱과 인터넷 연결을 확인한 뒤 다시 시도해 주세요.",code)}else{fail(error,code)}
                }),
                _=cancelled.changed()=>Err(fail("연결을 취소했습니다.","PAIR_CANCELLED")),
            };
            let endpoint=connection.remote_id().to_string();connection.close(0u8.into(),b"pair finished");
            let reply=response?;
            if root(&app)?!=local_root || vault(&app)?!=local_vault{return Err(fail("연결 중 서재가 변경되었습니다.","VAULT_CHANGED"));}
            if reply.meta["vault"]!=ticket["vault"]{return Err(fail("연결 코드와 상대 서재가 다릅니다. 새 코드를 받아 주세요.","PAIR_CODE_REJECTED"));}
            let remote_vault=ticket["vault"].as_str().unwrap();
            let name=reply.meta["name"].as_str().unwrap_or("다른 장치").chars().take(100).collect::<String>();
            Ok(json!({"id":format!("{endpoint}:{remote_vault}"),"endpoint":endpoint,"remoteVault":remote_vault,"root":local_root,"name":name,"storage":reply.meta["storage"].as_bool().unwrap_or(false)}))
        });
        finish_pair(&app, &attempt, result);
    });
    Ok(json!({"id":id,"phase":"connecting"}))
}

fn net(error: impl ToString) -> LofError {
    fail(error.to_string(), "REALTIME")
}
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Lof Writer".into())
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
fn peers(app: &AppHandle) -> Vec<Value> {
    app.state::<AppState>().settings.lock().unwrap()["realtimePeers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn save_peer(app: &AppHandle, peer: Value) -> Result<(), LofError> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    let mut next = settings.clone();
    let mut list = next["realtimePeers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    list.retain(|p| p["id"] != peer["id"]);
    list.push(peer);
    next["realtimePeers"] = json!(list);
    crate::persist_settings(&state.config_file, &next)?;
    *settings = next;
    Ok(())
}
fn authorized(app: &AppHandle, peer: &str, remote_vault: &str) -> Result<Value, LofError> {
    let current = root(app)?;
    peers(app)
        .into_iter()
        .find(|p| {
            p["endpoint"].as_str() == Some(peer)
                && p["remoteVault"].as_str() == Some(remote_vault)
                && p["root"].as_str() == Some(current.to_string_lossy().as_ref())
        })
        .ok_or_else(|| fail("장치가 이 서재에 연결되어 있지 않습니다.", "PEER_REVOKED"))
}
pub fn changed(app: &AppHandle) {
    app.state::<Realtime>().dirty.fetch_add(1, Ordering::SeqCst);
}
fn remote_changed(app: &AppHandle) {
    changed(app);
    let rt = app.state::<Realtime>();
    *rt.urgent.lock().unwrap() = true;
    rt.wake.notify_all();
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
        self.handle_inner(peer, session, message)
            .map_err(|e| e.message)
    }
    fn disconnected(&self, session: &str) {
        release(&self.0, session);
    }
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
        if op == "pair" {
            if message.data.len() > 0 {
                return Err(fail_invalid("연결 요청 형식 오류"));
            }
            let mut invite = rt.invite.lock().unwrap();
            let token = request["token"].as_str().unwrap_or("");
            let remote_vault = request["vault"]
                .as_str()
                .filter(|v| Uuid::parse_str(v).is_ok())
                .ok_or_else(|| fail_invalid("서재 식별자 오류"))?;
            let current = root(app)?;
            if !invite.as_ref().is_some_and(|invite| {
                invite.root == current
                    && invite.peer.is_none()
                    && token.len() == invite.token.len()
                    && bool::from(subtle::ConstantTimeEq::ct_eq(
                        token.as_bytes(),
                        invite.token.as_bytes(),
                    ))
            }) {
                return Err(fail_invalid(
                    "연결 코드가 올바르지 않거나 이미 사용되었습니다. 새 코드를 만들어 주세요.",
                ));
            }
            if Instant::now() >= invite.as_ref().unwrap().until {
                return Err(fail(
                    "연결 코드가 만료되었습니다. 새 코드를 만들어 주세요.",
                    "PAIR_CODE_EXPIRED",
                ));
            }
            let local_vault = vault(app)?;
            let name = request["name"]
                .as_str()
                .unwrap_or("다른 장치")
                .chars()
                .take(100)
                .collect::<String>();
            let connected = json!({"id":format!("{peer}:{remote_vault}"),"endpoint":peer,"remoteVault":remote_vault,
                "root":current,"name":name,"storage":request["storage"].as_bool().unwrap_or(false)});
            save_peer(app, connected.clone())?;
            invite.as_mut().unwrap().peer = Some(connected);
            changed(app);
            return Ok(Message::json(
                json!({"vault":local_vault,"name":device_name(),"storage":false}),
            ));
        }
        let peer_config = authorized(app, peer, request["vault"].as_str().unwrap_or(""))?;
        if request["target"].as_str() != Some(vault(app)?.as_str()) {
            return Err(fail_invalid("연결 대상 서재가 변경되었습니다."));
        }
        if op == "notify" {
            remote_changed(app);
            return Ok(Message::json(json!(true)));
        }
        if op == "hello" {
            return Ok(Message::json(json!({"storage":false})));
        }
        let current = root(app)?;
        let mut lease = rt.lease.lock().unwrap();
        if lease.as_ref().is_some_and(|l| Instant::now() > l.2) {
            *lease = None;
            state.syncing.store(false, Ordering::SeqCst);
        }
        if op == "begin" {
            // 양쪽에서 동시에 전체 비교를 실행하지 않도록 공개키 순서로 담당을 정한다.
            let own = rt
                .runtime
                .lock()
                .unwrap()
                .as_ref()
                .map(|(_, n)| n.endpoint.id().to_string())
                .unwrap_or_default();
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
                Instant::now() + Duration::from_secs(180),
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

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), LofError> {
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
            let node = runtime
                .block_on(Node::bind(secret, Arc::new(WriterHost(app.clone()))))
                .map_err(net)?;
            *app.state::<Realtime>().runtime.lock().unwrap() =
                Some((runtime.handle().clone(), node.clone()));
            let mut connected: HashMap<String, (Connection, u64)> = HashMap::new();
            let mut retry: HashMap<String, (Instant, u64)> = HashMap::new();
            let mut previous_root = PathBuf::new();
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
                let wanted: Vec<_> = peers(&app)
                    .into_iter()
                    .filter(|p| p["root"].as_str() == Some(current.to_string_lossy().as_ref()))
                    .collect();
                connected.retain(|id, (conn, _)| {
                    let keep = wanted.iter().any(|p| p["id"].as_str() == Some(id));
                    if !keep {
                        conn.close(0u8.into(), b"revoked");
                    }
                    keep
                });
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
                    let result = (|| -> Result<(), LofError> {
                        if !connected.contains_key(&id) {
                            rt.statuses
                                .lock()
                                .unwrap()
                                .insert(id.clone(), json!({"phase":"connecting"}));
                            let endpoint = peer["endpoint"]
                                .as_str()
                                .unwrap_or("")
                                .parse()
                                .map_err(net)?;
                            let conn = runtime
                                .block_on(node.connect(EndpointAddr::new(endpoint)))
                                .map_err(net)?;
                            let hello = json!({"op":"hello","vault":vault(&app)?,"target":peer["remoteVault"]});
                            runtime
                                .block_on(lof_realtime::request(&conn, Message::json(hello)))
                                .map_err(net)?;
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
                        let leader = peer["storage"].as_bool().unwrap_or(false)
                            || node.endpoint.id().to_string()
                                < peer["endpoint"].as_str().unwrap_or("").to_string();
                        if leader {
                            let outcome = sync(&app, &peer, conn, runtime.handle())?;
                            rt.statuses.lock().unwrap().insert(id.clone(),json!({"phase":"connected","lastSync":chrono::Utc::now().to_rfc3339(),"conflicts":outcome["fileConflicts"]}));
                        } else {
                            runtime.block_on(lof_realtime::request(conn,Message::json(json!({"op":"notify","vault":vault(&app)?,"target":peer["remoteVault"]})))).map_err(net)?;
                            let mut statuses = rt.statuses.lock().unwrap();
                            let status = statuses.entry(id.clone()).or_insert_with(|| json!({}));
                            status["phase"] = json!("connected");
                            status["message"] = Value::Null;
                        }
                        *seen = generation;
                        Ok(())
                    })();
                    match result {
                        Ok(()) => {
                            retry.remove(&id);
                        }
                        Err(error) => {
                            rt.statuses.lock().unwrap().insert(
                                id.clone(),
                                json!({"phase":"error","message":error.message}),
                            );
                            if let Some((conn, _)) = connected.remove(&id) {
                                conn.close(1u8.into(), b"retry");
                            }
                            let delay = retry.get(&id).map(|(_, d)| (*d * 2).min(60)).unwrap_or(5);
                            retry.insert(id, (Instant::now() + Duration::from_secs(delay), delay));
                        }
                    }
                }
                // 변경이 없으면 파일 목록이나 본문을 읽지 않고 대기한다.
                let urgent = rt.urgent.lock().unwrap();
                let (mut urgent, _) = rt
                    .wake
                    .wait_timeout_while(urgent, Duration::from_secs(5), |urgent| !*urgent)
                    .unwrap();
                *urgent = false;
            }
            runtime.block_on(node.endpoint.close());
            Ok(())
        })();
        *app.state::<Realtime>().runtime.lock().unwrap() = None;
        if let Err(error) = result {
            *app.state::<Realtime>().error.lock().unwrap() = error.message;
        }
    });
}

pub fn command(app: &AppHandle, method: &str, args: &Value) -> Result<Value, LofError> {
    let rt = app.state::<Realtime>();
    if method == "realtimeStatus" {
        let current = root(app)?;
        let list: Vec<_> = {
            let statuses = rt.statuses.lock().unwrap();
            peers(app).into_iter()
            .filter(|p|p["root"].as_str()==Some(current.to_string_lossy().as_ref()))
            .map(|p|json!({"id":p["id"],"name":p["name"],"endpoint":p["endpoint"],"storage":p["storage"],"status":statuses.get(p["id"].as_str().unwrap_or(""))})).collect()
        };
        let identity = rt
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .map(|(_, n)| n.endpoint.id().to_string());
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
        return Ok(
            json!({"uxVersion":1,"scope":current,"endpoint":identity,"peers":list,"invite":invite,"pairing":pairing,"error":*rt.error.lock().unwrap()}),
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
        let (_, address) = ticket(args["code"].as_str().unwrap_or("").trim())?;
        if rt
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(_, node)| address.id == node.endpoint.id())
        {
            return Err(fail(
                "같은 장치의 코드는 사용할 수 없습니다. 다른 장치에서 코드를 만들어 주세요.",
                "PAIR_SELF",
            ));
        }
        return Ok(json!(true));
    }
    if method == "realtimeClipboard" {
        let mut clipboard = arboard::Clipboard::new().map_err(|_| {
            fail_invalid("클립보드를 사용할 수 없습니다. 연결 코드를 직접 붙여 넣어 주세요.")
        })?;
        if args["action"] == "write" {
            let text = args["text"].as_str().unwrap_or("");
            if text.len() > 16_384 {
                return Err(fail_invalid("연결 코드가 너무 깁니다."));
            }
            clipboard.set_text(text.to_owned()).map_err(|_| {
                fail_invalid("코드를 복사하지 못했습니다. 내용을 펼쳐 직접 복사해 주세요.")
            })?;
            return Ok(json!(true));
        }
        let text = clipboard.get_text().map_err(|_| {
            fail_invalid("클립보드에 텍스트가 없습니다. 다른 장치에서 연결 코드를 복사해 주세요.")
        })?;
        if text.len() > 16_384 {
            return Err(fail_invalid(
                "클립보드의 내용이 너무 깁니다. 연결 코드만 복사해 주세요.",
            ));
        }
        return Ok(json!(text));
    }
    if method == "realtimeRename" {
        let current = root(app)?;
        let name = args["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(fail_invalid("장치 이름은 1~100자로 입력해 주세요."));
        }
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        let mut next = settings.clone();
        let peer = next["realtimePeers"]
            .as_array_mut()
            .and_then(|list| {
                list.iter_mut().find(|p| {
                    p["id"] == args["id"]
                        && p["root"].as_str() == Some(current.to_string_lossy().as_ref())
                })
            })
            .ok_or_else(|| fail_invalid("연결된 장치를 찾을 수 없습니다."))?;
        peer["name"] = json!(name);
        let result = peer.clone();
        crate::persist_settings(&state.config_file, &next)?;
        *settings = next;
        return Ok(result);
    }
    if method == "realtimeRemove" {
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        let mut next = settings.clone();
        let mut list = next["realtimePeers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        list.retain(|p| p["id"] != args["id"]);
        next["realtimePeers"] = json!(list);
        crate::persist_settings(&state.config_file, &next)?;
        *settings = next;
        drop(settings);
        // 해제한 장치를 완료 화면에 계속 표시하지 않는다.
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
        return Ok(json!(true));
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
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let address = node.endpoint.addr();
        let ticket = json!({"version":1,"addr":address,"vault":vault(app)?,"token":token});
        let code = format!(
            "lof-peer://{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&ticket).map_err(net)?)
        );
        let svg = qrcode::QrCode::new(code.as_bytes())
            .map_err(net)?
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(240, 240)
            .build();
        use base64::engine::general_purpose::STANDARD;
        if root(app)? != invite_root {
            return Err(fail(
                "코드를 만드는 중 서재가 변경되었습니다. 다시 만들어 주세요.",
                "VAULT_CHANGED",
            ));
        }
        let invitation = Invitation {
            id: Uuid::new_v4().to_string(),
            token,
            root: invite_root,
            until: Instant::now() + Duration::from_secs(600),
            code,
            qr: format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg)),
            peer: None,
        };
        let result = invitation.details();
        *rt.invite.lock().unwrap() = Some(invitation);
        return Ok(result);
    }
    if method == "realtimePair" {
        return begin_pair(app, node, handle, args);
    }
    Err(fail_invalid("지원하지 않는 실시간 명령입니다."))
}
