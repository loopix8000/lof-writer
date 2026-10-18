use crate::{common_memo_root_of, schedule_notify, sync_connection, AppState};
use crate::store::{disk_inventory, DiskInventory};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_INTERVAL: Duration = Duration::from_secs(300);
const RETRY_DELAY: Duration = Duration::from_secs(30);

struct Queue {
    root: PathBuf,
    pending: HashSet<String>,
    worker_running: bool,
    interval: Duration,
    immediate: bool,
    status: Value,
}

pub struct AutoSyncState {
    queue: Mutex<Queue>,
    wake: Condvar,
    periodic_started: AtomicBool,
    stopped: AtomicBool,
}

impl Default for AutoSyncState {
    fn default() -> Self {
        Self {
            queue: Mutex::new(Queue {
                root: PathBuf::new(),
                pending: HashSet::new(),
                worker_running: false,
                interval: DEFAULT_INTERVAL,
                immediate: false,
                status: json!({ "phase": "idle", "message": "", "hasConnections": false }),
            }),
            wake: Condvar::new(),
            periodic_started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }
}

impl AutoSyncState {
    pub fn status(&self) -> Value {
        self.queue.lock().unwrap().status.clone()
    }
}

fn destinations(app: &AppHandle) -> (PathBuf, Vec<(String, String)>) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    let root = PathBuf::from(settings.get("vaultPath").and_then(Value::as_str).unwrap_or(""));
    let connections = settings.get("connections").and_then(Value::as_array).map(|connections| {
        connections.iter()
            .filter(|connection| crate::google_drive::connection_enabled(connection))
            .filter_map(|connection| {
                let id = connection.get("id").and_then(Value::as_str)?.to_string();
                let name = connection.get("name").and_then(Value::as_str).unwrap_or("외부 저장소").to_string();
                Some((id, name))
            }).collect()
    }).unwrap_or_default();
    (root, connections)
}

// 앱 내부 저장은 대기에만 등록하며, 네트워크 작업은 공통 주기에서 실행한다.
pub fn request(app: &AppHandle) {
    let auto = app.state::<AutoSyncState>();
    if auto.stopped.load(Ordering::SeqCst) { return; }
    let (root, connections) = destinations(app);
    let mut queue = auto.queue.lock().unwrap();
    if queue.root != root {
        queue.root = root;
        queue.pending.clear();
    }
    let ids: HashSet<_> = connections.into_iter().map(|(id, _)| id).collect();
    queue.pending.retain(|id| ids.contains(id));
    if !queue.root.as_os_str().is_empty() { queue.pending.extend(ids.iter().cloned()); }
    if !queue.worker_running {
        queue.status = json!({ "phase": if queue.pending.is_empty() { "idle" } else { "pending" },
            "message": "", "hasConnections": !ids.is_empty() });
    }
    let status = queue.status.clone();
    drop(queue);
    let _ = app.emit("lof:auto-sync", status);
}

pub fn interval_seconds(settings: &Value) -> u64 {
    settings
        .get("preferences").and_then(|prefs| prefs.get("syncIntervalSeconds"))
        .and_then(Value::as_u64).filter(|seconds| (300..=3600).contains(seconds))
        .unwrap_or(DEFAULT_INTERVAL.as_secs())
}

// 설정 변경 시 대기 중인 작업자를 깨워 새 주기로 다시 예약한다.
pub fn configure(app: &AppHandle) {
    let state = app.state::<AppState>();
    let seconds = interval_seconds(&state.settings.lock().unwrap());
    let auto = app.state::<AutoSyncState>();
    let mut queue = auto.queue.lock().unwrap();
    let interval = Duration::from_secs(seconds);
    if queue.interval != interval {
        queue.interval = interval;
        auto.wake.notify_all();
    }
}

// 실행·트레이 복귀 요청은 한 작업자에 모아 중복 네트워크 작업을 막는다.
pub fn request_now(app: &AppHandle) {
    request(app);
    let auto = app.state::<AutoSyncState>();
    if auto.stopped.load(Ordering::SeqCst) { return; }
    let mut queue = auto.queue.lock().unwrap();
    queue.immediate = true;
    auto.wake.notify_all();
}

// 화면과 트레이 상태에 관계없이 한 작업자가 설정한 주기로 받기·병합·보내기를 수행한다.
pub fn start(app: &AppHandle) {
    let auto = app.state::<AutoSyncState>();
    if auto.periodic_started.swap(true, Ordering::SeqCst) { return; }
    configure(app);
    request_now(app);
    let app = app.clone();
    thread::spawn(move || worker(app));
}

pub fn stop(app: &AppHandle) {
    let auto = app.state::<AutoSyncState>();
    auto.stopped.store(true, Ordering::SeqCst);
    auto.wake.notify_all();
}

fn has_received_changes(result: &Value) -> bool {
    ["downloaded", "projectsUpdated", "assetsUpdated", "conflicts", "projectConflicts", "removed"]
        .iter().any(|key| result[*key].as_u64().unwrap_or(0) > 0)
}

// 기존 화면 확인 요청도 즉시 동기화하지 않고 다음 공통 주기에 합친다.
pub fn request_check(app: &AppHandle) -> Result<Value, crate::error::LofError> {
    request(app);
    let status = app.state::<AutoSyncState>().status();
    let busy = app.state::<AppState>().syncing.load(Ordering::SeqCst);
    Ok(json!({ "changed": false, "busy": busy, "errors": [],
        "hasConnections": status["hasConnections"], "scheduled": true }))
}

fn worker(app: AppHandle) {
    let auto = app.state::<AutoSyncState>();
    let mut interval = auto.queue.lock().unwrap().interval;
    let mut next_tick = Instant::now() + interval;
    let mut retry_root = PathBuf::new();
    let mut retries: HashMap<String, (Instant, String)> = HashMap::new();
    let mut common_files: Option<(PathBuf, DiskInventory)> = None;
    loop {
        {
            let mut queue = auto.queue.lock().unwrap();
            while !auto.stopped.load(Ordering::SeqCst) {
                if queue.interval != interval {
                    interval = queue.interval;
                    next_tick = Instant::now() + interval;
                }
                if queue.immediate {
                    queue.immediate = false;
                    next_tick = Instant::now();
                }
                if Instant::now() >= next_tick { break; }
                queue = auto.wake.wait_timeout(queue, next_tick.saturating_duration_since(Instant::now())).unwrap().0;
            }
        }
        if auto.stopped.load(Ordering::SeqCst) { return; }
        match poll_local(&app, &mut common_files) {
            Ok(()) => sync_cycle(&app, &mut retry_root, &mut retries),
            Err(error) => {
                let mut queue = auto.queue.lock().unwrap();
                queue.status = json!({ "phase": "error", "message": error.message,
                    "hasConnections": queue.status["hasConnections"] });
                let _ = app.emit("lof:auto-sync", queue.status.clone());
            }
        }
        // 작업이 주기를 넘겨도 밀린 횟수만큼 연속 실행하지 않고 다음 주기로 넘어간다.
        next_tick += interval;
        let now = Instant::now();
        while next_tick <= now { next_tick += interval; }
    }
}

// OS 감시자 대신 같은 동기화 주기에서 로컬 파일의 메타데이터와 목록을 확인한다.
fn poll_local(app: &AppHandle, common_files: &mut Option<(PathBuf, DiskInventory)>) -> Result<(), crate::error::LofError> {
    let state = app.state::<AppState>();
    let (root, mut changed) = {
        let mut guard = state.store.lock().unwrap();
        let Some(store) = guard.as_mut() else { return Ok(()) };
        (store.root.clone(), store.poll_disk()?)
    };
    let common_root = common_memo_root_of(&root, &state.settings.lock().unwrap());
    // 공용 메모는 원격 동기화 대상과 별도로 목록·화면 갱신만 처리한다.
    let inventory = if common_root.try_exists()? { disk_inventory(&common_root).ok() } else { Some(HashMap::new()) };
    if let Some(files) = inventory {
        if common_files.as_ref().is_none_or(|(root, previous)| root != &common_root || previous != &files) {
            changed = true;
        }
        *common_files = Some((common_root, files));
    }
    if changed { schedule_notify(app, &state.notify_seq); }
    Ok(())
}

fn sync_cycle(app: &AppHandle, retry_root: &mut PathBuf, retries: &mut HashMap<String, (Instant, String)>) {
    let auto = app.state::<AutoSyncState>();
    let (root, connections) = destinations(app);
    if *retry_root != root {
        *retry_root = root.clone();
        retries.clear();
    }
    retries.retain(|id, _| connections.iter().any(|(known, _)| known == id));
    let now = Instant::now();
    let ready: Vec<_> = connections.iter()
        .filter(|(id, _)| retries.get(id).is_none_or(|(due, _)| *due <= now)).cloned().collect();
    let status = {
        let mut queue = auto.queue.lock().unwrap();
        if queue.root != root {
            queue.root = root.clone();
            queue.pending.clear();
        }
        queue.pending.retain(|id| connections.iter().any(|(known, _)| known == id));
        if root.as_os_str().is_empty() || connections.is_empty() {
            queue.pending.clear();
            queue.worker_running = false;
            queue.status = json!({ "phase": "idle", "message": "", "hasConnections": false });
        } else if ready.is_empty() {
            queue.worker_running = false;
            queue.status = json!({ "phase": "error", "message": connections.iter()
                .filter_map(|(id, name)| retries.get(id).map(|(_, error)| format!("{name}: {error}")))
                .collect::<Vec<_>>().join(" · "), "hasConnections": true });
        } else {
            // 실행 중 새로 저장된 내용은 pending에 남겨 다음 주기에서 다시 확인한다.
            for (id, _) in &ready { queue.pending.remove(id); }
            queue.worker_running = true;
            queue.status = json!({ "phase": "syncing", "message": "", "hasConnections": true });
        }
        queue.status.clone()
    };
    let _ = app.emit("lof:auto-sync", status);
    if root.as_os_str().is_empty() || ready.is_empty() { return; }

    let state = app.state::<AppState>();
    let mut received_changes = false;
    let mut busy = false;
    for (id, _) in ready {
        if auto.stopped.load(Ordering::SeqCst) || auto.queue.lock().unwrap().root != root { break; }
        match sync_connection(&state, &id, &root) {
            Ok(result) => {
                retries.remove(&id);
                received_changes |= has_received_changes(&result);
            }
            Err(error) if matches!(error.code.as_str(), "CONNECTION_REMOVED" | "VAULT_CHANGED") => {
                retries.remove(&id);
            }
            Err(error) if error.code == "SYNC_BUSY" => { busy = true; break; }
            Err(error) => { retries.insert(id, (Instant::now() + RETRY_DELAY, error.message)); }
        }
    }
    if received_changes { schedule_notify(app, &state.notify_seq); }
    let (current_root, current_connections) = destinations(app);
    let status = {
        let mut queue = auto.queue.lock().unwrap();
        queue.worker_running = false;
        if queue.root != root || current_root != root {
            drop(queue);
            request(app);
            return;
        }
        retries.retain(|id, _| current_connections.iter().any(|(known, _)| known == id));
        queue.pending.retain(|id| current_connections.iter().any(|(known, _)| known == id));
        queue.pending.extend(retries.keys().cloned());
        if busy || (received_changes && current_connections.len() > 1) {
            queue.pending.extend(current_connections.iter().map(|(id, _)| id.clone()));
        }
        let errors: Vec<_> = current_connections.iter().filter_map(|(id, name)| {
            retries.get(id).map(|(_, error)| format!("{name}: {error}"))
        }).collect();
        let phase = if !errors.is_empty() { "error" } else if !queue.pending.is_empty() { "pending" } else { "idle" };
        queue.status = json!({ "phase": phase, "message": errors.join(" · "),
            "hasConnections": !current_connections.is_empty() });
        queue.status.clone()
    };
    let _ = app.emit("lof:auto-sync", status);
}
