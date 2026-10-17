use crate::{schedule_notify, sync_connection, AppState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const SAVE_DELAY: Duration = Duration::from_secs(2);
const RETRY_DELAY: Duration = Duration::from_secs(30);
const BACKGROUND_INTERVAL: Duration = Duration::from_secs(60);

struct Queue {
    root: PathBuf,
    pending: HashSet<String>,
    due: Option<Instant>,
    worker_running: bool,
    urgent: bool,
    revision: u64,
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
                due: None,
                worker_running: false,
                urgent: false,
                revision: 0,
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
    let root = PathBuf::from(
        settings
            .get("vaultPath")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let connections = settings
        .get("connections")
        .and_then(Value::as_array)
        .map(|connections| {
            connections
                .iter()
                .filter(|connection| crate::google_drive::connection_enabled(connection))
                .filter_map(|connection| {
                    let id = connection.get("id").and_then(Value::as_str)?.to_string();
                    let name = connection
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("외부 저장소")
                        .to_string();
                    Some((id, name))
                })
                .collect()
        })
        .unwrap_or_default();
    (root, connections)
}

pub fn request(app: &AppHandle) {
    enqueue(app, false);
}

pub fn request_now(app: &AppHandle) {
    enqueue(app, true);
}

// 화면과 WebView 타이머에 의존하지 않아 트레이와 다른 페이지에서도 동작한다.
pub fn start(app: &AppHandle) {
    let state = app.state::<AutoSyncState>();
    if state.periodic_started.swap(true, Ordering::SeqCst) { return; }
    request_now(app);
    let app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(BACKGROUND_INTERVAL);
        if app.state::<AutoSyncState>().stopped.load(Ordering::SeqCst) { break; }
        request_now(&app);
    });
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<AutoSyncState>();
    state.stopped.store(true, Ordering::SeqCst);
    state.wake.notify_all();
}

fn enqueue(app: &AppHandle, immediate: bool) {
    let state = app.state::<AutoSyncState>();
    if state.stopped.load(Ordering::SeqCst) { return; }
    let (root, connections) = destinations(app);
    if root.as_os_str().is_empty() {
        return;
    }
    let mut queue = state.queue.lock().unwrap();
    if queue.root != root {
        queue.pending.clear();
        queue.root = root;
        queue.due = None;
        queue.urgent = false;
    }
    let ids: HashSet<_> = connections.into_iter().map(|(id, _)| id).collect();
    queue.pending.retain(|id| ids.contains(id));
    queue.pending.extend(ids);
    queue.revision += 1;
    if queue.pending.is_empty() {
        queue.due = None;
        queue.urgent = false;
    } else if immediate {
        let now = Instant::now();
        queue.due = Some(queue.due.map_or(now, |due| due.min(now)));
        queue.urgent = true;
    } else if !queue.urgent {
        // 저장 요청이 뒤따라도 파일 감시에서 요청한 즉시 전송을 다시 미루지 않는다.
        queue.due = Some(Instant::now() + SAVE_DELAY);
    }
    queue.status = json!({ "phase": if queue.pending.is_empty() { "idle" } else { "pending" }, "message": "", "hasConnections": !queue.pending.is_empty() });
    let start = !queue.worker_running && !queue.pending.is_empty();
    if start {
        queue.worker_running = true;
    }
    let status = queue.status.clone();
    drop(queue);
    let _ = app.emit("lof:auto-sync", status);
    state.wake.notify_one();
    if start {
        let app = app.clone();
        thread::spawn(move || worker(app));
    }
}

// 다운로드 캐시만 갱신된 경우는 실제 서재 내용의 변경으로 취급하지 않는다.
fn has_received_changes(result: &Value) -> bool {
    ["downloaded", "projectsUpdated", "assetsUpdated", "conflicts", "projectConflicts", "removed"]
        .iter()
        .any(|key| result[*key].as_u64().unwrap_or(0) > 0)
}

// 작품·작문 페이지의 수신 확인은 저장 대기 시간을 다시 미루지 않고 즉시 수행한다.
pub fn check_now(app: &AppHandle) -> Result<Value, crate::error::LofError> {
    let (root, connections) = destinations(app);
    if root.as_os_str().is_empty() || connections.is_empty() {
        return Ok(json!({"changed":false,"busy":false,"hasConnections":false}));
    }
    let state = app.state::<AppState>();
    let mut changed = false;
    let mut busy = false;
    let mut errors = Vec::new();
    for (id, name) in connections {
        match sync_connection(&state, &id, &root) {
            Ok(result) => changed |= has_received_changes(&result),
            Err(error) if error.code == "SYNC_BUSY" => { busy = true; break; }
            Err(error) if matches!(error.code.as_str(), "CONNECTION_REMOVED" | "VAULT_CHANGED") => {}
            Err(error) => errors.push(format!("{name}: {}", error.message)),
        }
    }
    if changed { schedule_notify(app, &state.notify_seq); }
    let auto = app.state::<AutoSyncState>();
    let mut queue = auto.queue.lock().unwrap();
    if !queue.worker_running && !busy && queue.root == root {
        queue.status = json!({"phase": if errors.is_empty() {"idle"} else {"error"}, "message": errors.join(" · "), "hasConnections": true});
        let _ = app.emit("lof:auto-sync", queue.status.clone());
    }
    Ok(json!({"changed":changed,"busy":busy,"errors":errors,"hasConnections":true}))
}

fn worker(app: AppHandle) {
    let auto = app.state::<AutoSyncState>();
    loop {
        let (root, ids, revision) = {
            let mut queue = auto.queue.lock().unwrap();
            loop {
                if queue.pending.is_empty() || auto.stopped.load(Ordering::SeqCst) {
                    queue.worker_running = false;
                    return;
                }
                let due = queue.due.unwrap_or_else(Instant::now);
                if due <= Instant::now() {
                    break;
                }
                queue = auto
                    .wake
                    .wait_timeout(queue, due.saturating_duration_since(Instant::now()))
                    .unwrap()
                    .0;
            }
            let mut ids: Vec<_> = queue.pending.drain().collect();
            ids.sort();
            queue.due = None;
            queue.urgent = false;
            queue.status = json!({ "phase": "syncing", "message": "", "hasConnections": true });
            (queue.root.clone(), ids, queue.revision)
        };
        let _ = app.emit(
            "lof:auto-sync",
            json!({ "phase": "syncing", "message": "", "hasConnections": true }),
        );
        let (current_root, connections) = destinations(&app);
        if current_root != root {
            request(&app);
            continue;
        }
        let state = app.state::<AppState>();
        let mut retry = HashSet::new();
        let mut errors = Vec::new();
        let mut received_changes = false;
        let mut busy = false;
        for id in ids {
            let Some((_, name)) = connections.iter().find(|(known, _)| known == &id) else {
                continue;
            };
            // 새 서재의 대기 작업이 들어오면 이전 서재 작업은 이어서 실행하지 않는다.
            if auto.queue.lock().unwrap().root != root {
                break;
            }
            match sync_connection(&state, &id, &root) {
                Ok(result) => {
                    received_changes |= has_received_changes(&result);
                }
                Err(error)
                    if matches!(error.code.as_str(), "CONNECTION_REMOVED" | "VAULT_CHANGED") => {}
                Err(error) if error.code == "SYNC_BUSY" => {
                    retry.insert(id);
                    busy = true;
                }
                Err(error) => {
                    retry.insert(id);
                    errors.push(format!("{name}: {}", error.message));
                }
            }
        }
        if received_changes { schedule_notify(&app, &state.notify_seq); }
        let (current_root, current_connections) = destinations(&app);
        let status = {
            let mut queue = auto.queue.lock().unwrap();
            if queue.root != root {
                continue;
            }
            if current_root != root {
                drop(queue);
                request(&app);
                continue;
            }
            retry.retain(|id| current_connections.iter().any(|(known, _)| known == id));
            queue.pending.extend(retry);
            if received_changes && current_connections.len() > 1 {
                queue
                    .pending
                    .extend(current_connections.iter().map(|(id, _)| id.clone()));
            }
            if queue.pending.is_empty() {
                queue.due = None;
                queue.status = json!({ "phase": "idle", "message": "", "hasConnections": !current_connections.is_empty() });
            } else {
                let delay = if busy || received_changes || queue.revision != revision {
                    SAVE_DELAY
                } else {
                    RETRY_DELAY
                };
                let due = Instant::now() + delay;
                queue.due = Some(queue.due.map_or(due, |current| current.min(due)));
                queue.status = json!({ "phase": if errors.is_empty() { "pending" } else { "error" },
                    "message": errors.join(" · "), "hasConnections": !current_connections.is_empty() });
            }
            queue.status.clone()
        };
        let _ = app.emit("lof:auto-sync", status);
    }
}
