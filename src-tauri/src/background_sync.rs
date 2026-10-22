//! 앱을 닫은 뒤의 동기화 시점을 정한다.
//! Android에서는 30분 동안 화면에 있을 때처럼 변경 즉시 동기화하고, 이후에는 설정한 주기마다 한 번씩 확인한다.
//! PC는 창을 닫아도 계속 화면에 있을 때처럼 동기화한다.
use crate::AppState;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

pub const LIVE_WINDOW: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub struct BackgroundSync {
    // 기기가 잠들어 있던 시간도 세도록 벽시계로 기록한다.
    since: Mutex<Option<SystemTime>>,
    next_tick: Mutex<Option<Instant>>,
    tick: AtomicBool,
    realtime_pending: AtomicBool,
    files_pending: AtomicBool,
    pushed: Mutex<Option<(String, bool)>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Foreground,
    /// 앱을 닫은 뒤 30분 동안. 변경 알림을 받는 즉시 동기화한다.
    Live,
    /// 이후에는 연결을 닫고 설정한 주기마다 확인한다.
    Periodic,
    /// 백그라운드 동기화를 끈 경우.
    Paused,
}

pub fn keep_alive_mode(settings: &Value) -> &'static str {
    match settings
        .get("preferences")
        .and_then(|prefs| prefs.get("backgroundKeepAlive"))
        .and_then(Value::as_str)
    {
        Some("always") => "always",
        Some("off") => "off",
        _ => "live",
    }
}

fn elapsed(since: SystemTime) -> Duration {
    SystemTime::now().duration_since(since).unwrap_or_default()
}

pub fn phase(app: &AppHandle) -> Phase {
    // PC는 앱이 멈추지 않으므로 창을 닫아도 화면에 있을 때와 똑같이 동기화한다.
    if !cfg!(target_os = "android") {
        return Phase::Foreground;
    }
    let Some(since) = *app.state::<BackgroundSync>().since.lock().unwrap() else {
        return Phase::Foreground;
    };
    if !crate::auto_sync::background_enabled(&app.state::<AppState>().settings.lock().unwrap()) {
        Phase::Paused
    } else if elapsed(since) < LIVE_WINDOW {
        Phase::Live
    } else {
        Phase::Periodic
    }
}

/// 실시간 유지가 끝나는 시각. 이때 주기 확인으로 바뀐다.
pub fn live_deadline(app: &AppHandle) -> Option<Instant> {
    if !cfg!(target_os = "android") {
        return None;
    }
    let since = (*app.state::<BackgroundSync>().since.lock().unwrap())?;
    Some(Instant::now() + LIVE_WINDOW.saturating_sub(elapsed(since)))
}

pub fn set_background(app: &AppHandle, background: bool) {
    let state = app.state::<BackgroundSync>();
    let mut since = state.since.lock().unwrap();
    if background {
        if since.is_none() {
            *since = Some(SystemTime::now());
            drop(since);
            // 앱이 멈춰 있어도 실시간 유지가 끝날 때 깨어나 주기 확인을 시작한다.
            if pushed_active(app) {
                schedule(app, LIVE_WINDOW);
            }
        }
    } else if since.take().is_some() {
        drop(since);
        *state.next_tick.lock().unwrap() = None;
        state.tick.store(false, Ordering::SeqCst);
        cancel(app);
        finish(app);
    }
}

/// 파일 저장소가 백그라운드 주기를 쓸 때인지.
pub fn is_periodic(app: &AppHandle) -> bool {
    matches!(phase(app), Phase::Periodic | Phase::Paused)
}

/// 주기 확인 알람이 울렸을 때 호출한다.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn tick(app: &AppHandle) {
    let state = app.state::<BackgroundSync>();
    if state.since.lock().unwrap().is_none() || phase(app) != Phase::Periodic {
        finish(app);
        return;
    }
    state.realtime_pending.store(true, Ordering::SeqCst);
    state.files_pending.store(crate::auto_sync::resume(app), Ordering::SeqCst);
    state.tick.store(true, Ordering::SeqCst);
    crate::realtime::configure(app);
}

pub fn take_tick(app: &AppHandle) -> bool {
    app.state::<BackgroundSync>().tick.swap(false, Ordering::SeqCst)
}

pub fn next_tick(app: &AppHandle) -> Option<Instant> {
    *app.state::<BackgroundSync>().next_tick.lock().unwrap()
}

/// 실시간 동기화의 주기 확인을 마치면 다음 확인을 예약한다.
pub fn realtime_done(app: &AppHandle) {
    let seconds =
        crate::auto_sync::background_interval_seconds(&app.state::<AppState>().settings.lock().unwrap());
    let state = app.state::<BackgroundSync>();
    *state.next_tick.lock().unwrap() = Some(Instant::now() + Duration::from_secs(seconds));
    if pushed_active(app) {
        schedule(app, Duration::from_secs(seconds));
    }
    state.realtime_pending.store(false, Ordering::SeqCst);
    if !state.files_pending.load(Ordering::SeqCst) {
        finish(app);
    }
}

/// 파일 저장소의 주기 확인을 마쳤다.
pub fn files_done(app: &AppHandle) {
    let state = app.state::<BackgroundSync>();
    if state.files_pending.swap(false, Ordering::SeqCst)
        && !state.realtime_pending.load(Ordering::SeqCst)
    {
        finish(app);
    }
}

fn pushed_active(app: &AppHandle) -> bool {
    app.state::<BackgroundSync>()
        .pushed
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(_, active)| *active)
}

/// 앱을 닫을 때 알림을 띄울지 Android에 미리 알려 둔다. 동기화할 대상이 없으면 띄우지 않는다.
pub fn refresh(app: &AppHandle, has_peers: bool) {
    let (mode, enabled) = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        (
            keep_alive_mode(&settings).to_string(),
            crate::auto_sync::background_enabled(&settings),
        )
    };
    let active = enabled && (has_peers || crate::auto_sync::has_connections(app));
    let next = Some((mode.clone(), active));
    let state = app.state::<BackgroundSync>();
    let mut pushed = state.pushed.lock().unwrap();
    if *pushed == next {
        return;
    }
    *pushed = next;
    drop(pushed);
    call(app, "configure", json!({"mode": mode, "active": active}));
}

fn schedule(app: &AppHandle, delay: Duration) {
    call(app, "scheduleAlarm", json!({"delayMs": delay.as_millis() as u64}));
}

fn cancel(app: &AppHandle) {
    call(app, "cancelAlarm", json!({}));
}

fn finish(app: &AppHandle) {
    let state = app.state::<BackgroundSync>();
    state.realtime_pending.store(false, Ordering::SeqCst);
    state.files_pending.store(false, Ordering::SeqCst);
    call(app, "releaseWake", json!({}));
}

pub fn request_notifications(app: &AppHandle) {
    call(app, "requestNotifications", json!({}));
}

#[cfg(target_os = "android")]
struct Plugin(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("background-sync")
        .setup(|app, api| {
            let handle = api.register_android_plugin("local.lof.writer", "BackgroundSyncPlugin")?;
            app.manage(Plugin(handle));
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // 알람이 울릴 때마다 응답하는 요청을 이어서 기다린다.
                loop {
                    let result = app
                        .state::<Plugin>()
                        .0
                        .run_mobile_plugin_async::<Value>("waitAlarm", json!({}))
                        .await;
                    match result {
                        Ok(_) => tick(&app),
                        Err(_) => tokio::time::sleep(Duration::from_secs(5)).await,
                    }
                }
            });
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn call(app: &AppHandle, command: &'static str, payload: Value) {
    let Some(plugin) = app.try_state::<Plugin>() else {
        return;
    };
    let handle = plugin.0.clone();
    tauri::async_runtime::spawn(async move {
        let _ = handle.run_mobile_plugin_async::<Value>(command, payload).await;
    });
}

#[cfg(not(target_os = "android"))]
fn call(_app: &AppHandle, _command: &'static str, _payload: Value) {}
