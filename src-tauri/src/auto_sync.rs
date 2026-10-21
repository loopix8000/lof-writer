use crate::store::{disk_inventory, skipped_name, DiskInventory};
use crate::{common_memo_root_of, schedule_notify, sync_connection, AppState};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Condvar, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_INTERVAL: Duration = Duration::from_secs(300);
const LOCAL_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_secs(30);

struct Destination {
    id: String,
    name: String,
}

struct Queue {
    root: PathBuf,
    pending: HashSet<String>,
    urgent: HashSet<String>,
    active: HashSet<String>,
    errors: HashMap<String, String>,
    local_dirty: bool,
    watch_restart: bool,
    local_error: Option<String>,
    interval: Duration,
    bg_enabled: bool,
    bg_interval: Duration,
    status: Value,
    realtime: Value,
}

pub struct AutoSyncState {
    queue: Mutex<Queue>,
    wake: Condvar,
    periodic_started: AtomicBool,
    backgrounded: AtomicBool,
    clear_retries: AtomicBool,
    stopped: AtomicBool,
}

impl Default for AutoSyncState {
    fn default() -> Self {
        Self {
            queue: Mutex::new(Queue {
                root: PathBuf::new(),
                pending: HashSet::new(),
                urgent: HashSet::new(),
                active: HashSet::new(),
                errors: HashMap::new(),
                local_dirty: true,
                watch_restart: false,
                local_error: None,
                interval: DEFAULT_INTERVAL,
                bg_enabled: true,
                bg_interval: DEFAULT_INTERVAL,
                status: json!({ "phase": "idle", "message": "", "hasConnections": false }),
                realtime: json!({ "phase": "idle", "message": "", "hasConnections": false }),
            }),
            wake: Condvar::new(),
            periodic_started: AtomicBool::new(false),
            backgrounded: AtomicBool::new(false),
            clear_retries: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }
}

impl AutoSyncState {
    pub fn status(&self) -> Value {
        self.queue.lock().unwrap().status.clone()
    }
}

fn destinations(app: &AppHandle) -> (PathBuf, Vec<Destination>) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    let root = PathBuf::from(settings["vaultPath"].as_str().unwrap_or(""));
    let connections = settings["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|connection| {
            if !matches!(connection["type"].as_str(), Some("folder" | "webdav" | "ftp")) {return None;}
            Some(Destination {
                id: connection["id"].as_str()?.to_string(),
                name: connection["name"]
                    .as_str()
                    .unwrap_or("외부 저장소")
                    .to_string(),
            })
        })
        .collect();
    (root, connections)
}

fn reconcile(queue: &mut Queue, root: &PathBuf, connections: &[Destination]) {
    if queue.root != *root {
        queue.root = root.clone();
        queue.pending.clear();
        queue.urgent.clear();
        queue.active.clear();
        queue.errors.clear();
        queue.local_dirty = true;
        queue.watch_restart = false;
        queue.local_error = None;
    }
    let known: HashSet<_> = connections
        .iter()
        .map(|c| c.id.clone())
        .collect();
    queue.pending.retain(|id| known.contains(id));
    queue.urgent.retain(|id| known.contains(id));
    queue.errors.retain(|id, _| known.contains(id));
}

// 파일 저장소 상태는 실시간 장치 연결과 분리해 표시한다.
fn publish(app:&AppHandle, queue:&mut Queue, connections:&[Destination]) {
    let mut errors:Vec<_>=connections.iter().filter_map(|c|queue.errors.get(&c.id).map(|error|format!("{}: {error}",c.name))).collect();
    if let Some(error)=&queue.local_error {errors.push(error.clone());}
    let phase=if connections.iter().any(|c|queue.active.contains(&c.id)){"syncing"}else if !errors.is_empty(){"error"}else if connections.iter().any(|c|queue.pending.contains(&c.id)){"pending"}else{"idle"};
    let progress=json!({"phase":phase,"message":errors.join(" · "),"hasConnections":!connections.is_empty()});
    let realtime = queue.realtime.clone();
    let has_files = progress["hasConnections"].as_bool().unwrap_or(false);
    let has_realtime = realtime["hasConnections"].as_bool().unwrap_or(false);
    let overall_phase = if progress["phase"] == "syncing" || realtime["phase"] == "syncing" {
        "syncing"
    } else if progress["phase"] == "error" || realtime["phase"] == "error" {
        "error"
    } else if progress["phase"] == "pending" || realtime["phase"] == "pending" {
        "pending"
    } else {
        "idle"
    };
    let mut messages = Vec::new();
    if let Some(m) = realtime["message"].as_str().filter(|s| !s.is_empty()) {
        messages.push(m.to_string());
    }
    if let Some(m) = progress["message"].as_str().filter(|s| !s.is_empty()) {
        messages.push(m.to_string());
    }
    let status = json!({
        "phase": overall_phase,
        "message": messages.join(" · "),
        "hasConnections": has_files || has_realtime,
        "channels": {
            "realtime": realtime,
            "files": progress,
        }
    });
    if queue.status!=status {queue.status=status;let _=app.emit("lof:auto-sync",queue.status.clone());}
}

// 파일 저장소는 설정한 주기를 사용하고 실시간 피어는 변경 알림만 예약한다.
pub fn request(app: &AppHandle) {
    crate::realtime::changed(app);
    enqueue(app, None, false);
}

pub fn refresh_realtime(app: &AppHandle) {
    let auto = app.state::<AutoSyncState>();
    if auto.stopped.load(Ordering::SeqCst) {
        return;
    }
    let (root, connections) = destinations(app);
    let realtime = crate::realtime::progress(app);
    let mut queue = auto.queue.lock().unwrap();
    reconcile(&mut queue, &root, &connections);
    queue.realtime = realtime;
    publish(app, &mut queue, &connections);
}

fn enqueue(app: &AppHandle, target: Option<&str>, immediate: bool) {
    let realtime = crate::realtime::progress(app);
    let auto = app.state::<AutoSyncState>();
    if auto.stopped.load(Ordering::SeqCst) {
        return;
    }
    let (root, connections) = destinations(app);
    let mut queue = auto.queue.lock().unwrap();
    reconcile(&mut queue, &root, &connections);
    queue.realtime = realtime;
    if !root.as_os_str().is_empty() {
        for connection in connections
            .iter()
            .filter(|c| target.is_none_or(|id| c.id == id))
        {
            queue.pending.insert(connection.id.clone());
            if immediate {
                queue.urgent.insert(connection.id.clone());
            }
        }
    }
    publish(app, &mut queue, &connections);
    auto.wake.notify_all();
}

pub fn interval_seconds(settings: &Value) -> u64 {
    settings
        .get("preferences")
        .and_then(|prefs| prefs.get("syncIntervalSeconds"))
        .and_then(Value::as_u64)
        .filter(|seconds| (60..=3600).contains(seconds))
        .unwrap_or(DEFAULT_INTERVAL.as_secs())
}

pub fn background_enabled(settings: &Value) -> bool {
    settings
        .get("preferences")
        .and_then(|prefs| prefs.get("backgroundSyncEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub fn background_interval_seconds(settings: &Value) -> u64 {
    settings
        .get("preferences")
        .and_then(|prefs| prefs.get("backgroundSyncIntervalSeconds"))
        .and_then(Value::as_u64)
        .filter(|seconds| (60..=3600).contains(seconds))
        .unwrap_or(DEFAULT_INTERVAL.as_secs())
}

pub fn configure(app: &AppHandle) {
    let (seconds, bg_enabled, bg_seconds) = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        (
            interval_seconds(&settings),
            background_enabled(&settings),
            background_interval_seconds(&settings),
        )
    };
    let auto = app.state::<AutoSyncState>();
    {
        let mut queue = auto.queue.lock().unwrap();
        queue.interval = Duration::from_secs(seconds);
        queue.bg_enabled = bg_enabled;
        queue.bg_interval = Duration::from_secs(bg_seconds);
    }
    auto.wake.notify_all();
    crate::realtime::configure(app);
}

// 수동 저장·최초 연결처럼 명시적인 요청은 주기를 기다리지 않는다.
pub fn request_now(app: &AppHandle) {
    crate::realtime::changed(app);
    enqueue(app, None, true);
}

// 지정한 파일 연결을 즉시 확인한다.
pub fn request_connection(app: &AppHandle, id: &str) {
    enqueue(app, Some(id), true);
}

// 트레이에서 복귀해도 변경 없는 서버에는 새 동기화 요청을 보내지 않는다.
pub fn resume(app: &AppHandle) {
    let (_, connections) = destinations(app);
    for connection in connections.iter() {
        request_connection(app, &connection.id);
    }
}

pub fn set_background(app: &AppHandle, background: bool) {
    let auto = app.state::<AutoSyncState>();
    let was_bg = auto.backgrounded.swap(background, Ordering::SeqCst);
    if background && !was_bg {
        let mut queue = auto.queue.lock().unwrap();
        if !queue.pending.is_empty() || queue.local_dirty {
            let pending: Vec<String> = queue.pending.iter().cloned().collect();
            queue.urgent.extend(pending);
            auto.wake.notify_all();
        }
    } else if !background && was_bg {
        auto.clear_retries.store(true, Ordering::SeqCst);
        resume(app);
        auto.wake.notify_all();
    }
}

pub fn start(app: &AppHandle) {
    let auto = app.state::<AutoSyncState>();
    if auto.periodic_started.swap(true, Ordering::SeqCst) {
        return;
    }
    configure(app);
    request_now(app);
    let app = app.clone();
    thread::spawn(move || worker(app));
}

pub fn stopped(app: &AppHandle) -> bool {
    app.state::<AutoSyncState>().stopped.load(Ordering::SeqCst)
}

pub fn stop(app: &AppHandle) {
    let auto = app.state::<AutoSyncState>();
    auto.stopped.store(true, Ordering::SeqCst);
    auto.wake.notify_all();
}

fn has_received_changes(result: &Value) -> bool {
    [
        "downloaded",
        "projectsUpdated",
        "assetsUpdated",
        "conflicts",
        "projectConflicts",
        "removed",
    ]
    .iter()
    .any(|key| result[*key].as_u64().unwrap_or(0) > 0)
}

// 화면의 상태 확인은 서버 전송 대기열에 새 작업을 만들지 않는다.
pub fn request_check(app: &AppHandle) -> Result<Value, crate::error::LofError> {
    let status = app.state::<AutoSyncState>().status();
    let busy = app.state::<AppState>().syncing.load(Ordering::SeqCst);
    Ok(json!({ "changed": false, "busy": busy, "errors": [],
        "hasConnections": status["hasConnections"], "scheduled": true }))
}

struct LocalWatch {
    roots: Vec<PathBuf>,
    source: Option<(PathBuf, String)>,
    watcher: Option<RecommendedWatcher>,
    error: Option<String>,
    retry_at: Instant,
}

impl LocalWatch {
    fn new() -> Self {
        Self {
            roots: Vec::new(),
            source: None,
            watcher: None,
            error: None,
            retry_at: Instant::now(),
        }
    }

    fn configure(&mut self, app: &AppHandle, root: &PathBuf) -> Result<(), String> {
        let state = app.state::<AppState>();
        let common_setting = state.settings.lock().unwrap()["preferences"]["commonMemoPath"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let source = (root.clone(), common_setting);
        // 설정이 같으면 경로 정규화와 존재 확인조차 반복하지 않는다.
        if self.source.as_ref() == Some(&source)
            && (self.watcher.is_some() || Instant::now() < self.retry_at)
        {
            return self.error.clone().map_or(Ok(()), Err);
        }
        self.source = Some(source);
        let common = common_memo_root_of(root, &state.settings.lock().unwrap());
        let mut roots = vec![root.clone()];
        if common != *root {
            roots.push(common);
        }
        self.roots = roots.clone();
        self.watcher = None;
        self.retry_at = Instant::now() + RETRY_DELAY;
        let app_clone = app.clone();
        let watch_root = root.clone();
        let result = (|| {
            let mut watcher =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    let restart = event.as_ref().map_or(true, |event| {
                        event.kind.is_remove() && event.paths.contains(&watch_root)
                    });
                    let relevant = match event {
                        Ok(event) => {
                            !event.kind.is_access()
                                && (event.need_rescan()
                                    || event.paths.iter().any(|path| {
                                        roots
                                            .iter()
                                            .filter_map(|root| path.strip_prefix(root).ok())
                                            .any(|relative| {
                                                !relative.components().any(|part| {
                                                    skipped_name(
                                                        &part.as_os_str().to_string_lossy(),
                                                    )
                                                })
                                            })
                                    }))
                        }
                        Err(error) => {
                            eprintln!("서재 파일 변경 감시 오류: {error}");
                            true
                        }
                    };
                    if relevant {
                        crate::realtime::changed(&app_clone);
                        let auto = app_clone.state::<AutoSyncState>();
                        let mut queue = auto.queue.lock().unwrap();
                        if queue.root == watch_root {
                            queue.local_dirty = true;
                            queue.watch_restart |= restart;
                        }
                        auto.wake.notify_all();
                    }
                })
                .map_err(|error| format!("서재 파일 변경 감시를 시작하지 못했습니다: {error}"))?;
            let mut watched = Vec::<PathBuf>::new();
            for path in &self.roots {
                // 아직 만들어지지 않은 공용 메모 폴더도 부모의 생성 알림으로 감지한다.
                let mut target = path.clone();
                while !target
                    .try_exists()
                    .map_err(|error| format!("감시 폴더를 확인하지 못했습니다: {error}"))?
                {
                    if !target.pop() {
                        return Err(format!(
                            "감시할 폴더를 찾을 수 없습니다: {}",
                            path.display()
                        ));
                    }
                }
                if watched.iter().any(|parent| target.starts_with(parent)) {
                    continue;
                }
                watcher
                    .watch(&target, RecursiveMode::Recursive)
                    .map_err(|error| {
                        format!(
                            "폴더 변경을 감시하지 못했습니다 ({}): {error}",
                            target.display()
                        )
                    })?;
                watched.push(target);
            }
            Ok(watcher)
        })();
        match result {
            Ok(watcher) => {
                self.watcher = Some(watcher);
                self.error = None;
                app.state::<AutoSyncState>()
                    .queue
                    .lock()
                    .unwrap()
                    .local_dirty = true;
                Ok(())
            }
            Err(error) => {
                self.error = Some(error.clone());
                Err(error)
            }
        }
    }
}

fn worker(app: AppHandle) {
    let auto = app.state::<AutoSyncState>();
    let mut interval = auto.queue.lock().unwrap().interval;
    let mut next_files = Instant::now() + interval;
    let mut next_local_check = Instant::now() + LOCAL_CHECK_INTERVAL;
    let mut retry_root = PathBuf::new();
    let mut retries: HashMap<String, Instant> = HashMap::new();
    let mut common_files: Option<(PathBuf, DiskInventory)> = None;
    let mut watch = LocalWatch::new();
    loop {
        {
            let mut queue = auto.queue.lock().unwrap();
            while !auto.stopped.load(Ordering::SeqCst) {
                let bg = auto.backgrounded.load(Ordering::SeqCst);
                let target_interval = if bg { queue.bg_interval } else { queue.interval };
                if target_interval != interval {
                    interval = target_interval;
                    next_files = Instant::now() + interval;
                }
                let due = if bg {
                    queue.bg_enabled && Instant::now() >= next_files
                } else {
                    Instant::now() >= next_files.min(next_local_check)
                };
                if !queue.urgent.is_empty() || due {
                    break;
                }
                let wait_dur = if bg {
                    if queue.bg_enabled {
                        next_files.saturating_duration_since(Instant::now())
                    } else {
                        Duration::from_secs(60)
                    }
                } else {
                    next_files
                        .min(next_local_check)
                        .saturating_duration_since(Instant::now())
                };
                queue = auto.wake.wait_timeout(queue, wait_dur).unwrap().0;
            }
        }
        if stopped(&app) {
            return;
        }
        if auto.clear_retries.swap(false, Ordering::SeqCst) {
            retries.clear();
        }
        let (root, connections) = destinations(&app);
        if root.as_os_str().is_empty() {
            next_local_check = Instant::now() + LOCAL_CHECK_INTERVAL;
            next_files = Instant::now() + interval;
            continue;
        }
        if retry_root != root {
            retry_root = root.clone();
            retries.clear();
            common_files = None;
        }
        let now = Instant::now();
        let files_due = now >= next_files;
        let local_check_due = now >= next_local_check;
        if files_due {
            next_files = now + interval;
        }
        if local_check_due {
            next_local_check = now + LOCAL_CHECK_INTERVAL;
        }
        if std::mem::take(&mut auto.queue.lock().unwrap().watch_restart) {
            watch.source = None;
        }
        let watch_error = watch.configure(&app, &root).err();
        let (local_dirty, urgent) = {
            let mut queue = auto.queue.lock().unwrap();
            reconcile(&mut queue, &root, &connections);
            queue.local_error = watch_error;
            (std::mem::take(&mut queue.local_dirty), queue.urgent.clone())
        };
        let has_files = !connections.is_empty();
        // 파일 저장소가 없으면 OS 변경 알림이나 명시적 요청 뒤에만 디스크를 읽는다.
        if local_dirty || (files_due && has_files) || !urgent.is_empty() {
            match poll_local(&app, &mut common_files) {
                Ok((changed, recheck)) => {
                    if changed {
                        request(&app);
                    }
                    if recheck {
                        auto.queue.lock().unwrap().local_dirty = true;
                    }
                }
                Err(error) => {
                    let mut queue = auto.queue.lock().unwrap();
                    queue.local_error = Some(error.message);
                    queue.local_dirty = true;
                    publish(&app, &mut queue, &connections);
                    continue;
                }
            }
        }
        sync_cycle(
            &app,
            &root,
            &connections,
            files_due,
            &mut retries,
        );
    }
}

// 전체 목록 비교는 변경 알림 뒤에만 수행한다. 파일 저장소의 주기 확인은 기존대로 유지한다.
fn poll_local(
    app: &AppHandle,
    common_files: &mut Option<(PathBuf, DiskInventory)>,
) -> Result<(bool, bool), crate::error::LofError> {
    let state = app.state::<AppState>();
    let (root, vault_changed, recheck) = {
        let mut guard = state.store.lock().unwrap();
        let Some(store) = guard.as_mut() else {
            return Ok((false, false));
        };
        (
            store.root.clone(),
            store.poll_disk()?,
            store.has_pending_disk_changes()? || store.has_busy_files(),
        )
    };
    let common_root = common_memo_root_of(&root, &state.settings.lock().unwrap());
    let inventory = if common_root.try_exists()? {
        disk_inventory(&common_root).ok()
    } else {
        Some(HashMap::new())
    };
    let mut changed = vault_changed;
    if let Some(files) = inventory {
        changed |= common_files
            .as_ref()
            .is_none_or(|(root, previous)| root != &common_root || previous != &files);
        *common_files = Some((common_root, files));
    }
    if changed {
        schedule_notify(app, &state.notify_seq);
    }
    // 공용 메모만 바뀐 경우에는 원고 전송을 예약하지 않는다.
    Ok((vault_changed, recheck))
}

fn sync_cycle(
    app: &AppHandle,
    root: &PathBuf,
    connections: &[Destination],
    files_due: bool,
    retries: &mut HashMap<String, Instant>,
) {
    let auto = app.state::<AutoSyncState>();
    let now = Instant::now();
    retries.retain(|id, _| connections.iter().any(|c| &c.id == id));
    let ready: Vec<_> = {
        let mut queue = auto.queue.lock().unwrap();
        reconcile(&mut queue, root, connections);
        let ready: Vec<_> = connections
            .iter()
            .filter(|c| {
                queue.urgent.contains(&c.id) || (files_due && retries.get(&c.id).is_none_or(|due| *due <= now))
            })
            .map(|c| c.id.clone())
            .collect();
        for id in &ready {
            queue.pending.remove(id);
            queue.urgent.remove(id);
            queue.active.insert(id.clone());
        }
        publish(app, &mut queue, connections);
        ready
    };
    if ready.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let mut received_changes = false;
    for id in &ready {
        if stopped(app) || auto.queue.lock().unwrap().root != *root {
            break;
        }
        let result = sync_connection(&state, id, root);
        let mut queue = auto.queue.lock().unwrap();
        queue.active.remove(id);
        match result {
            Ok(result) => {
                retries.remove(id);
                queue.errors.remove(id);
                received_changes |= has_received_changes(&result);
            }
            Err(error) if matches!(error.code.as_str(), "CONNECTION_REMOVED" | "VAULT_CHANGED") => {
                retries.remove(id);
                queue.errors.remove(id);
            }
            Err(error) if error.code == "SYNC_BUSY" => {
                queue.pending.insert(id.clone());
            }
            Err(error) => {
                retries.insert(id.clone(), Instant::now() + RETRY_DELAY);
                queue.errors.insert(id.clone(), error.message);
                queue.pending.insert(id.clone());
            }
        }
    }
    if received_changes {
        schedule_notify(app, &state.notify_seq);
    }
    let (current_root, current_connections) = destinations(app);
    let mut queue = auto.queue.lock().unwrap();
    for id in &ready {
        queue.active.remove(id);
    }
    if queue.root != *root || current_root != *root {
        return;
    }
    reconcile(&mut queue, root, &current_connections);
    if received_changes {
        // 받은 변경은 다른 저장소에 전달하고 같은 저장소를 즉시 다시 확인하지 않는다.
        queue.pending.extend(
            current_connections
                .iter()
                .filter(|c| !ready.contains(&c.id))
                .map(|c| c.id.clone()),
        );
    }
    publish(app, &mut queue, &current_connections);
}
