use crate::{schedule_notify, sync_connection, AppState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const SAVE_DELAY: Duration = Duration::from_secs(2);
const RETRY_DELAY: Duration = Duration::from_secs(30);

struct Queue {
    root: PathBuf,
    pending: HashSet<String>,
    due: Option<Instant>,
    worker_running: bool,
    revision: u64,
    status: Value,
}

pub struct AutoSyncState {
    queue: Mutex<Queue>,
    wake: Condvar,
}

impl Default for AutoSyncState {
    fn default() -> Self {
        Self {
            queue: Mutex::new(Queue {
                root: PathBuf::new(),
                pending: HashSet::new(),
                due: None,
                worker_running: false,
                revision: 0,
                status: json!({ "phase": "idle", "message": "" }),
            }),
            wake: Condvar::new(),
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
    let (root, connections) = destinations(app);
    if root.as_os_str().is_empty() {
        return;
    }
    let state = app.state::<AutoSyncState>();
    let mut queue = state.queue.lock().unwrap();
    if queue.root != root {
        queue.pending.clear();
        queue.root = root;
    }
    let ids: HashSet<_> = connections.into_iter().map(|(id, _)| id).collect();
    queue.pending.retain(|id| ids.contains(id));
    queue.pending.extend(ids);
    queue.revision += 1;
    queue.due = (!queue.pending.is_empty()).then(|| Instant::now() + SAVE_DELAY);
    queue.status = json!({ "phase": if queue.pending.is_empty() { "idle" } else { "pending" }, "message": "" });
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

fn worker(app: AppHandle) {
    let auto = app.state::<AutoSyncState>();
    loop {
        let (root, ids, revision) = {
            let mut queue = auto.queue.lock().unwrap();
            loop {
                if queue.pending.is_empty() {
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
            queue.status = json!({ "phase": "syncing", "message": "" });
            (queue.root.clone(), ids, queue.revision)
        };
        let _ = app.emit(
            "lof:auto-sync",
            json!({ "phase": "syncing", "message": "" }),
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
                    received_changes |= ["downloaded", "conflicts", "removed"]
                        .iter()
                        .any(|key| result.get(*key).and_then(Value::as_u64).unwrap_or(0) > 0);
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
        schedule_notify(&app, &state.notify_seq);
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
                queue.status = json!({ "phase": "idle", "message": "" });
            } else {
                let delay = if busy || received_changes || queue.revision != revision {
                    SAVE_DELAY
                } else {
                    RETRY_DELAY
                };
                let due = Instant::now() + delay;
                queue.due = Some(queue.due.map_or(due, |current| current.min(due)));
                queue.status = json!({ "phase": if errors.is_empty() { "pending" } else { "error" },
                    "message": errors.join(" · ") });
            }
            queue.status.clone()
        };
        let _ = app.emit("lof:auto-sync", status);
    }
}
