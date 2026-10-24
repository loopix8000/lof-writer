pub mod api;
pub mod assets;
mod auto_sync;
mod android_library;
mod android_scanner;
mod android_biometric;
mod android_storage;
mod android_system_bars;
mod android_updater;
mod desktop_updater;
mod desktop_startup;
mod mcp_updater;
mod background_sync;
pub mod database;
mod common_memo_history;
mod document_patch;
pub mod episode;
pub mod error;
pub mod file_index;
pub mod export;
pub mod fonts;
mod file_sync_reset;
mod git_worker;
mod git_history;
mod library_sync_reset;
mod library_move;
mod realtime;
pub mod local_git;
pub mod import;
pub mod markdown;
pub mod memo;
pub mod platforms;
mod pin;
mod project_order;
#[cfg(not(target_os = "android"))]
mod single_instance;
mod skills;
pub mod store;
mod recovery;
pub mod sync;
mod sync_activity;
pub mod text;

use crate::api::{start_api, ApiServer};
use crate::error::{fail, fail_invalid, LofError};
use crate::import::import_files;
use crate::memo::Memos;
use crate::store::{atomic_write_str, strip_verbatim_prefix, HistoryPolicy, Store};
use crate::sync::sync_once;
use crate::text::plain_text;
use base64::Engine;
#[cfg(not(target_os = "android"))]
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use serde_json::{json, Value};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
#[cfg(not(target_os = "android"))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(target_os = "android"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

pub struct AppState {
    pub store: Arc<Mutex<Option<Store>>>,
    pub settings: Arc<Mutex<Value>>,
    pub config_file: PathBuf,
    pub user_dir: PathBuf,
    pub api: ApiServer,
    pub syncing: Arc<sync_activity::SyncActivity>,
    pub title_bar_dimmed: AtomicBool,
    /// 집중 모드에서 요청한 작은 창 허용 여부와 실제로 적용된 값.
    pub compact_window: AtomicBool,
    pub compact_applied: AtomicBool,
    pub closing: Arc<AtomicBool>,
    pub quit_requested: AtomicBool,
    pub startup_notice_pending: AtomicBool,
    pub close_pending: Arc<AtomicBool>,
    pub close_seq: Arc<AtomicU64>,
    pub notify_seq: Arc<AtomicU64>,
}

pub fn get_user_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("LOF_USER_DATA") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    #[cfg(target_os = "android")]
    {
        return PathBuf::from("/data/data/local.lof.writer/files");
    }
    #[cfg(not(target_os = "android"))]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Lof Writer");
        }
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".config").join("Lof Writer")
    }
}

pub fn get_documents_dir() -> PathBuf {
    // Android 서재는 파일 관리자와 다른 앱에서도 보이는 내장 저장공간의 Documents 폴더에 둔다.
    #[cfg(target_os = "android")]
    {
        let storage = std::env::var("EXTERNAL_STORAGE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/sdcard".to_string());
        let storage = PathBuf::from(storage);
        return fs::canonicalize(&storage).unwrap_or(storage).join("Documents");
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::{FOLDERID_Documents, SHGetKnownFolderPath};
        unsafe {
            let mut path_ptr: windows_sys::core::PWSTR = std::ptr::null_mut();
            if SHGetKnownFolderPath(&FOLDERID_Documents, 0, std::ptr::null_mut(), &mut path_ptr) == 0
                && !path_ptr.is_null()
            {
                let mut len = 0;
                while *path_ptr.add(len) != 0 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(path_ptr, len);
                let s = String::from_utf16_lossy(slice);
                windows_sys::Win32::System::Com::CoTaskMemFree(path_ptr as *const _);
                return PathBuf::from(s);
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join("Documents")
    }
}

#[cfg(windows)]
fn dpapi_encrypt(plain: &str) -> Result<String, LofError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let bytes = plain.as_bytes();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err(fail_invalid(
            "Windows 자격 증명 암호화를 사용할 수 없습니다.",
        ));
    }
    let encrypted =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted))
}

#[cfg(not(windows))]
fn dpapi_encrypt(plain: &str) -> Result<String, LofError> {
    Ok(base64::engine::general_purpose::STANDARD.encode(plain.as_bytes()))
}

#[cfg(windows)]
fn dpapi_decrypt(b64: &str) -> Result<String, LofError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| fail_invalid("저장된 자격 증명을 복호화할 수 없습니다."))?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err(fail_invalid("저장된 자격 증명을 복호화할 수 없습니다."));
    }
    let plain_bytes =
        unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
    String::from_utf8(plain_bytes)
        .map_err(|_| fail_invalid("저장된 자격 증명을 복호화할 수 없습니다."))
}

#[cfg(not(windows))]
fn dpapi_decrypt(b64: &str) -> Result<String, LofError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| fail_invalid("저장된 자격 증명을 복호화할 수 없습니다."))?;
    String::from_utf8(bytes).map_err(|_| fail_invalid("저장된 자격 증명을 복호화할 수 없습니다."))
}

fn safe_connection(c: &Value) -> Value {
    let mut obj = c.as_object().cloned().unwrap_or_default();
    obj.entry("conflictPolicy").or_insert(json!("keepBoth"));
    let has_pw = obj
        .remove("password")
        .and_then(|v| v.as_str().map(|s| !s.is_empty()))
        .unwrap_or(false);
    obj.insert("hasPassword".to_string(), json!(has_pw));
    Value::Object(obj)
}

fn encrypt_connection(c: &Value) -> Result<Value, LofError> {
    let mut obj = c.as_object().cloned().unwrap_or_default();
    if let Some(secret) = obj.get("password").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let encrypted = dpapi_encrypt(secret)?;
        obj.insert("password".to_string(), json!(encrypted));
    }
    Ok(Value::Object(obj))
}

fn decrypt_connection(c: &Value) -> Result<Value, LofError> {
    let mut obj = c.as_object().cloned().unwrap_or_default();
    if let Some(secret) = obj.get("password").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let decrypted = dpapi_decrypt(secret)?;
        obj.insert("password".to_string(), json!(decrypted));
    }
    Ok(Value::Object(obj))
}

// 설정의 '보관 및 이력'. 입력이 멈춘 뒤 이력을 남길 시간(historyIdleMinutes)은 화면이 쓴다.
fn history_policy_from_settings(settings: &Value) -> HistoryPolicy {
    let prefs = settings.get("preferences");
    let number = |key: &str, default: f64| {
        prefs
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_f64())
            .unwrap_or(default)
    };
    HistoryPolicy {
        max_minutes: number("historyMaxMinutes", 1.0).max(1.0),
        min_chars: number("historyMinChars", 200.0).max(0.0) as usize,
        keep_count: number("historyKeepCount", 100.0).max(1.0) as usize,
        keep_days: number("historyKeepDays", 30.0).max(1.0) as i64,
    }
}

fn default_manual_line_break_from_settings(settings: &Value) -> bool {
    settings
        .get("preferences")
        .and_then(|p| p.get("defaultManualLineBreak"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn common_memo_root_of(store_root: &Path, settings: &Value) -> PathBuf {
    if let Some(custom) = settings
        .get("preferences")
        .and_then(|p| p.get("commonMemoPath"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        let p = PathBuf::from(custom);
        return strip_verbatim_prefix(&fs::canonicalize(&p).unwrap_or(p));
    }
    store_root.join("공용 메모")
}

fn persist_settings(config_file: &Path, settings: &Value) -> Result<(), LofError> {
    let pretty = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".to_string());
    atomic_write_str(config_file, &pretty)
}

fn schedule_notify(app: &AppHandle, seq: &Arc<AtomicU64>) {
    let my_seq = seq.fetch_add(1, Ordering::SeqCst) + 1;
    let seq_clone = Arc::clone(seq);
    let app_clone = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(250));
        if seq_clone.load(Ordering::SeqCst) == my_seq {
            let _ = app_clone.emit("lof:change", ());
        }
    });
}

// MCP 편집이 이어지는 동안은 기다렸다가 마지막 편집 뒤에 한 번만 즉시 동기화한다.
fn schedule_api_sync(app: &AppHandle, seq: &Arc<AtomicU64>) {
    let my_seq = seq.fetch_add(1, Ordering::SeqCst) + 1;
    let seq_clone = Arc::clone(seq);
    let app_clone = app.clone();
    thread::spawn(move || {
        auto_sync::request(&app_clone);
        thread::sleep(Duration::from_secs(2));
        if seq_clone.load(Ordering::SeqCst) == my_seq {
            auto_sync::request_now(&app_clone);
        }
    });
}

fn bind_vault(state: &AppState, app: &AppHandle, root: &Path) -> Result<(), LofError> {
    let resolved=strip_verbatim_prefix(&fs::canonicalize(root).unwrap_or_else(|_|root.to_path_buf()));
    if state.store.lock().unwrap().as_ref().is_some_and(|store|store.root==resolved) {return Ok(());}
    let (policy, manual_lb) = {
        let s = state.settings.lock().unwrap();
        (
            history_policy_from_settings(&s),
            default_manual_line_break_from_settings(&s),
        )
    };
    let mut new_store = Store::new(root, policy, manual_lb)?;
    if let Some(base) = state.config_file.parent() { new_store.set_recovery_directory(base); }
    let clean_root = new_store.root.clone();
    {
        let mut st_guard = state.store.lock().unwrap();
        if let Some(previous) = st_guard.as_mut() {
            // Git 오류가 있어도 서재 전환을 막지 않는다. 저장된 원고와 이관 진행점은 원래 서재에 남는다.
            if let Err(error) = previous.git_tick(true, false) {
                eprintln!("서재 전환 전 로컬 이력 기록을 완료하지 못했습니다: {}", error.message);
            }
        }
        *st_guard = Some(new_store);
    }
    {
        let mut s_guard = state.settings.lock().unwrap();
        if let Some(obj) = s_guard.as_object_mut() {
            obj.insert(
                "vaultPath".to_string(),
                json!(clean_root.to_string_lossy().to_string()),
            );
        }
        persist_settings(&state.config_file, &s_guard)?;
    }
    schedule_notify(app, &state.notify_seq);
    Ok(())
}

fn show_item_in_folder(path: &Path) {
    let clean = strip_verbatim_prefix(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", clean.to_string_lossy()))
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(&clean).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(parent) = clean.parent() {
            let _ = Command::new("xdg-open").arg(parent).spawn();
        }
    }
}

fn open_folder_path(path: &Path) {
    let clean = strip_verbatim_prefix(path);
    #[cfg(windows)]
    {
        let _ = Command::new("explorer.exe").arg(&clean).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(&clean).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(&clean).spawn();
    }
}

fn set_clipboard_text(text: &str) -> Result<(), LofError> {
    #[cfg(not(target_os = "android"))]
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| fail_invalid(e.to_string()))?;
        cb.set_text(text.to_string())
            .map_err(|e| fail_invalid(e.to_string()))
    }
    #[cfg(target_os = "android")]
    {
        let _ = text;
        Ok(())
    }
}

fn sync_connection(state: &AppState, id: &str, root: &Path) -> Result<Value, LofError> {
    let _guard = state.syncing.try_exclusive()
        .ok_or_else(|| fail("이미 동기화 중입니다.", "SYNC_BUSY"))?;
    let (conn, device_id) = {
        let settings = state.settings.lock().unwrap();
        let conn = settings.get("connections").and_then(Value::as_array)
            .and_then(|connections| connections.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id)))
            .cloned().ok_or_else(|| fail("연결을 찾을 수 없습니다.", "CONNECTION_REMOVED"))?;
        let device = settings.get("deviceId").and_then(Value::as_str).unwrap_or("").to_string();
        (decrypt_connection(&conn)?, device)
    };

    {
        let store = state.store.lock().unwrap();
        if store.as_ref().map(|store| store.root.as_path()) != Some(root) {
            return Err(fail("동기화 중 서재가 변경되었습니다.", "VAULT_CHANGED"));
        }
    }
    sync_once(&state.store, root, &conn, &device_id)
}

// MCP 동기화 상태는 화면과 같은 자동 동기화 상태에 연결 목록과 장치 상태를 더해 알린다.
fn api_sync_status(app: &AppHandle) -> Value {
    let state = app.state::<AppState>();
    let connections: Vec<Value> = state.settings.lock().unwrap()["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| matches!(c["type"].as_str(), Some("folder" | "webdav" | "ftp")))
        .map(|c| json!({
            "id": c["id"],
            "name": c["name"],
            "type": c["type"],
            "conflictPolicy": c["conflictPolicy"].as_str().unwrap_or("keepBoth"),
        }))
        .collect();
    let devices: Vec<Value> = realtime::command(app, "realtimeStatus", &json!({}))
        .ok()
        .and_then(|status| status["peers"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|peer| json!({ "id": peer["id"], "name": peer["name"], "status": peer["status"] }))
        .collect();
    let mut status = app.state::<auto_sync::AutoSyncState>().status();
    status["syncing"] = json!(state.syncing.is_busy());
    status["connections"] = json!(connections);
    status["devices"] = json!(devices);
    status
}

// MCP 앱 작업은 기능별 처리기로 전달한다. 동기화는 화면과 같은 대기열을 사용한다.
fn api_app_tool(app: &AppHandle, name: &str, args: &Value) -> Result<Value, LofError> {
    if name.starts_with("skill_") {
        if name == "skill_install" && app.state::<AppState>().closing.load(Ordering::SeqCst) {
            return Err(fail("앱이 종료 중이라 스킬을 설치할 수 없습니다.", "SKILL_BUSY"));
        }
        return skills::tool(name, args, &app.package_info().version.to_string());
    }
    if name == "update_write_guard" { return mcp_updater::ensure_writable(app); }
    if name.starts_with("update_") {
        if name != "update_status" && app.state::<AppState>().closing.load(Ordering::SeqCst) {
            return Err(fail("앱이 종료 중이라 업데이트를 요청할 수 없습니다.", "UPDATE_BUSY"));
        }
        return mcp_updater::tool(app, name, args);
    }
    match name {
        "sync_status" => Ok(api_sync_status(app)),
        "sync_now" => {
            if auto_sync::stopped(app) {
                return Err(fail_invalid("앱이 종료 중이라 동기화를 요청할 수 없습니다."));
            }
            match args.get("connectionId").and_then(Value::as_str) {
                Some(id) => {
                    if !api_sync_status(app)["connections"]
                        .as_array()
                        .is_some_and(|list| list.iter().any(|c| c["id"].as_str() == Some(id)))
                    {
                        return Err(fail_invalid("파일 동기화 연결을 찾을 수 없습니다."));
                    }
                    auto_sync::request_connection(app, id);
                }
                None => {
                    auto_sync::request_now(app);
                    realtime::reconnect(app);
                }
            }
            let status = api_sync_status(app);
            Ok(json!({ "requested": status["hasConnections"], "status": status }))
        }
        _ => Err(fail_invalid("지원하지 않는 도구")),
    }
}

fn handle_method(
    method: &str,
    args: Value,
    state: &AppState,
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<Value, LofError> {
    if matches!(method,
        "createProject" | "updateProject" | "chooseCover" | "removeCover" | "createDocument" |
        "saveDocument" | "reorderDocuments" | "reorderProjects" | "deleteProject" | "repair" | "relinkDocument" |
        "adoptFile" | "forgetDocument" | "memoSave" | "memoCreate" | "memoCreateFolder" |
        "memoRename" | "memoMove" | "memoArchive" | "memoArchiveFolder" | "memoRemove" | "restore" | "deleteDocument" | "importFiles")
    {
        let store=state.store.lock().unwrap();
        store.as_ref().ok_or_else(||fail_invalid("서재가 열려 있지 않습니다."))?.require_database()?;
    }
    let result = dispatch_method(method, args, state, app, window);
    if result.as_ref().is_ok_and(|value| !value.is_null()) && matches!(method,
        "createProject" | "updateProject" | "chooseCover" | "removeCover" | "createDocument" |
        "saveDocument" | "reorderDocuments" | "reorderProjects" | "deleteProject" | "repair" | "relinkDocument" |
        "adoptFile" | "forgetDocument" | "memoSave" | "memoCreate" | "memoCreateFolder" |
        "memoRename" | "memoMove" | "memoArchive" | "memoArchiveFolder" | "memoRemove" | "restore" | "deleteDocument" | "importFiles" |
        "saveConnection" | "chooseVault" | "moveVault")
    {
        auto_sync::request(app);
    }
    result
}

fn dispatch_method(
    method: &str,
    args: Value,
    state: &AppState,
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<Value, LofError> {
    let get_store_and_common = || -> Result<(PathBuf, PathBuf), LofError> {
        let st_root = {
            let guard = state.store.lock().unwrap();
            let st = guard
                .as_ref()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.root.clone()
        };
        let s_guard = state.settings.lock().unwrap();
        let c_root = common_memo_root_of(&st_root, &s_guard);
        Ok((st_root, c_root))
    };
    // 원고 이미지를 둘 폴더. 공용 메모(space가 common)는 공용 메모 폴더, 그 밖에는 작품 폴더다.
    let image_root = |args: &Value| -> Result<PathBuf, LofError> {
        if args.get("space").and_then(|v| v.as_str()) == Some(memo::COMMON) {
            let (_, common_root) = get_store_and_common()?;
            return Ok(common_root);
        }
        let project_id = args.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
        let mut guard = state.store.lock().unwrap();
        let st = guard
            .as_mut()
            .ok_or_else(|| fail_invalid("Store not initialized"))?;
        Ok(st.get_project(project_id)?.dir)
    };

    if args["space"].as_str() == Some(memo::COMMON) && matches!(method,
        "history" | "historyPage" | "historyRead" | "deleteHistory" | "restore" | "checkpointDocument") {
        let (_, common_root) = get_store_and_common()?;
        let guard = state.store.lock().unwrap();
        let policy = guard.as_ref().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?.history_policy;
        let result = common_memo_history::request(&common_root, method, &args, policy)?;
        drop(guard);
        if matches!(method, "restore" | "checkpointDocument") { schedule_notify(app, &state.notify_seq); }
        return Ok(result);
    }
    match method {
        "realtimeStatus" | "realtimeInvite" | "realtimePair" | "realtimeRemove" | "realtimeSync" |
        "realtimeCancelPair" | "realtimeValidateCode" | "realtimeClipboard" | "realtimeRename" | "realtimeRenameDevice" | "realtimeLeave" |
        "realtimeResetNotice" | "realtimeDismissReset" => realtime::command(app, method, &args),
        "countManuscript" => Ok(crate::text::display_counts(
            args.get("text").and_then(Value::as_str).unwrap_or(""),
            &args.get("rules").cloned().unwrap_or_else(|| json!({})),
        )),
        "autoSyncStatus" => Ok(app.state::<auto_sync::AutoSyncState>().status()),
        "appLifecycle" => {
            let foreground = args
                .get("foreground")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            // Android는 백그라운드로 갈 때 잠가 다시 열면 PIN을 묻는다.
            // 파일 선택기처럼 앱이 연 화면으로 잠시 나갈 때는 화면에서 lock을 보내지 않는다.
            if !foreground && args.get("lock").and_then(Value::as_bool).unwrap_or(false) {
                let pin = app.state::<pin::PinState>();
                // 이미 잠긴 상태여도 진행 중인 PIN·지문 인증 결과를 무효화한다.
                pin.lock_for_tray();
                let _ = app.emit("lof:pin-state", pin_status(app));
            }
            // 실시간 유지 시간을 먼저 정해야 이어지는 동기화가 단계를 바로 읽는다.
            background_sync::set_background(app, !foreground);
            realtime::set_background(app, !foreground);
            auto_sync::set_background(app, !foreground);
            Ok(json!(true))
        }
        "backgroundNotifications" => {
            background_sync::request_notifications(app);
            Ok(json!(true))
        }
        "gitEditing" => git_worker::activity(app, &args),
        "backupStorage" => {
            let guard=state.store.lock().unwrap();
            let store=guard.as_ref().ok_or_else(||fail_invalid("서재가 열려 있지 않습니다."))?;
            let name=format!("library-{}-{}.sqlite",chrono::Utc::now().format("%Y%m%d-%H%M%S"),Uuid::new_v4());
            let destination=store.root.join(".lof").join("backups").join(name);
            store.database()?.backup(&destination)?;
            Ok(json!({"path":destination.to_string_lossy()}))
        }
        "backupGitHistory" => {
            let mut guard = state.store.lock().unwrap();
            let store = guard.as_mut().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
            if !store.local_git.ready { return Err(fail_invalid("이력 이관이 끝난 뒤 백업해 주세요.")); }
            store.git_tick(true, false)?;
            let directory = store.root.join(".lof").join("backups");
            fs::create_dir_all(&directory)?;
            let name = format!("git-history-{}-{}.zip", chrono::Utc::now().format("%Y%m%d-%H%M%S"), Uuid::new_v4());
            let destination = directory.join(name);
            let temporary = destination.with_extension("zip.tmp");
            store.local_git.backup(&temporary)?;
            fs::rename(&temporary, &destination)?;
            Ok(json!({"path":destination.to_string_lossy()}))
        }
        "resetHistory" => {
            let (_, common_root) = get_store_and_common()?;
            let mut guard = state.store.lock().unwrap();
            let store = guard.as_mut().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
            store.reset_history(&common_root)?;
            let status = store.local_git.status();
            drop(guard);
            schedule_notify(app, &state.notify_seq);
            Ok(status)
        }
        "pinStatus" => Ok(pin_status(app)),
        "pinReady" => {
            let generation = args.get("generation").and_then(Value::as_u64).unwrap_or(0);
            if app.state::<pin::PinState>().ready_to_show(generation) {
                show_main_window(app);
            }
            Ok(json!(true))
        }
        "prepareAndroidLibrary" => android_library::prepare(state, app, &args),
        "bootstrap" => {
            let prefs = {
                let s = state.settings.lock().unwrap();
                s.get("preferences").cloned().unwrap_or_else(|| json!({}))
            };
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            let list = st.list()?;
            let mut out = list.as_object().cloned().unwrap_or_default();
            if let Some(projs) = out.get("projects").and_then(|v| v.as_array()).cloned() {
                let mut enriched = Vec::with_capacity(projs.len());
                for mut p in projs {
                    let cd = st.cover_data(&p)?;
                    if let Some(pobj) = p.as_object_mut() {
                        pobj.insert("coverData".to_string(), cd);
                    }
                    enriched.push(p);
                }
                out.insert("projects".to_string(), Value::Array(enriched));
            }
            out.insert("drafts".to_string(), Value::Array(st.drafts()?));
            out.insert("localGit".to_string(), st.local_git.status());
            out.insert("preferences".to_string(), prefs);
            out.insert("platform".to_string(), json!(std::env::consts::OS));
            out.insert(
                "internalRoot".to_string(),
                json!(android_library::internal_library_root(&state.user_dir)
                    .to_string_lossy()
                    .to_string()),
            );
            out.insert(
                "isInternal".to_string(),
                json!(android_library::is_internal(&state.user_dir, &st.root)),
            );
            out.insert(
                "version".to_string(),
                json!(app.package_info().version.to_string()),
            );
            Ok(Value::Object(out))
        }
        "pickVaultDestination" => {
            #[cfg(not(target_os = "android"))]
            {
                let picked = FileDialog::new().set_title("서재를 이동할 빈 폴더 선택").pick_folder();
                Ok(picked.map(|folder| json!(strip_verbatim_prefix(&folder).to_string_lossy())).unwrap_or(Value::Null))
            }
            #[cfg(target_os = "android")]
            { Ok(Value::Null) }
        }
        "moveVault" => library_move::move_library(state, app, &args),
        "chooseVault" => {
            if args.get("internal").and_then(Value::as_bool) == Some(true) {
                let folder = android_library::internal_library_root(&state.user_dir);
                fs::create_dir_all(&folder)?;
                bind_vault(state, app, &folder)?;
                return Ok(json!(true));
            }
            if let Some(custom_path) = args
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let folder = if Path::new(custom_path).is_absolute() {
                    PathBuf::from(custom_path)
                } else {
                    let safe_name: String = custom_path
                        .chars()
                        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
                        .collect();
                    state.user_dir.join(if safe_name.is_empty() { "Lof Library" } else { &safe_name })
                };
                if state.config_file.starts_with(&folder) || state.user_dir.starts_with(&folder) {
                    return Err(fail_invalid("앱 설정 폴더는 서재로 지정할 수 없습니다."));
                }
                fs::create_dir_all(&folder)?;
                bind_vault(state, app, &folder)?;
                return Ok(json!(true));
            }
            #[cfg(not(target_os = "android"))]
            {
                let picked = FileDialog::new().set_title("서재 폴더 선택").pick_folder();
                let Some(folder) = picked else {
                    return Ok(json!(false));
                };
                bind_vault(state, app, &folder)?;
                Ok(json!(true))
            }
            #[cfg(target_os = "android")]
            {
                Ok(json!(false))
            }
        }
        "createProject" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.create_project(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "updateProject" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.update_project(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "chooseCover" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let bytes = if let Some(b64) = args.get("data").and_then(Value::as_str) {
                let raw = b64
                    .strip_prefix("data:")
                    .and_then(|s| s.split_once(";base64,").map(|(_, d)| d))
                    .unwrap_or(b64);
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(raw)
                    .map_err(|_| fail_invalid("이미지를 읽을 수 없습니다."))?;
                if decoded.len() > 20_000_000 {
                    return Err(fail_invalid("표지 원본은 20MB 이하로 선택해 주세요."));
                }
                decoded
            } else {
                #[cfg(not(target_os = "android"))]
                {
                    let picked = FileDialog::new()
                        .set_title("작품 표지 선택")
                        .add_filter("표지 이미지", &["png", "jpg", "jpeg", "webp"])
                        .pick_file();
                    let Some(file) = picked else {
                        return Ok(Value::Null);
                    };
                    let stat = fs::metadata(&file)?;
                    if stat.len() > 20_000_000 {
                        return Err(fail_invalid("표지 원본은 20MB 이하로 선택해 주세요."));
                    }
                    fs::read(&file)?
                }
                #[cfg(target_os = "android")]
                {
                    return Ok(Value::Null);
                }
            };
            let mut img = image::load_from_memory(&bytes).map_err(|_| {
                fail_invalid("이미지를 읽을 수 없습니다. PNG, JPEG, WebP 파일을 선택해 주세요.")
            })?;
            let width = img.width();
            let height = img.height();
            if (width as u64) * (height as u64) > 40_000_000 {
                return Err(fail_invalid("표지는 4천만 화소 이하로 선택해 주세요."));
            }
            if width > 1800 || height > 2400 {
                let ratio = (1800.0 / width as f64).min(2400.0 / height as f64);
                let new_w = ((width as f64) * ratio).round().max(1.0) as u32;
                let new_h = ((height as f64) * ratio).round().max(1.0) as u32;
                img = img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
            }
            let mut png_bytes = Vec::new();
            img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
                .map_err(|_| {
                    fail_invalid(
                        "이미지를 읽을 수 없습니다. PNG, JPEG, WebP 파일을 선택해 주세요.",
                    )
                })?;

            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                let mut p = st.set_cover(id, &png_bytes)?;
                let cd = st.cover_data(&p)?;
                if let Some(pobj) = p.as_object_mut() {
                    pobj.insert("coverData".to_string(), cd);
                }
                p
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "removeCover" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.update_project(&json!({ "id": id, "cover": Value::Null }))?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        // 원고 이미지 저장: data(base64)가 있으면 그 내용을, 없으면 파일 선택 창에서 고른 파일을 작품(공용 메모는 공용 메모 폴더)의 assets/에 둔다.
        "saveImage" => {
            let (name, bytes) = if let Some(data) = args.get("data").and_then(|v| v.as_str()) {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| fail_invalid("이미지를 읽을 수 없습니다."))?;
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("image");
                (name.to_string(), bytes)
            } else {
                #[cfg(not(target_os = "android"))]
                {
                    let picked = FileDialog::new()
                        .set_title("이미지 삽입")
                        .add_filter("이미지", &["png", "jpg", "jpeg", "gif", "webp"])
                        .pick_file();
                    let Some(file) = picked else {
                        return Ok(Value::Null);
                    };
                    if fs::metadata(&file)?.len() > assets::IMAGE_LIMIT {
                        return Err(fail_invalid("이미지는 20MB 이하만 넣을 수 있습니다."));
                    }
                    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("image").to_string();
                    (name, fs::read(&file)?)
                }
                #[cfg(target_os = "android")]
                {
                    return Ok(Value::Null);
                }
            };
            let dir = image_root(&args)?;
            let path = assets::save_image(&dir, &name, &bytes)?;
            Ok(json!({ "path": path, "name": name }))
        }
        "readImage" => {
            let doc_path = args.get("docPath").and_then(|v| v.as_str()).unwrap_or("");
            let src = args.get("src").and_then(|v| v.as_str()).unwrap_or("");
            let dir = image_root(&args)?;
            assets::image_data_url(&dir, doc_path, src)
        }
        // 집필 화면 우클릭 메뉴의 붙여넣기. 글이 있으면 글을, 없고 그림이 있으면 PNG(base64)를 돌려준다.
        "readClipboard" => {
            #[cfg(not(target_os = "android"))]
            {
                let mut cb = arboard::Clipboard::new().map_err(|e| fail_invalid(e.to_string()))?;
                if let Ok(text) = cb.get_text() {
                    if !text.is_empty() {
                        return Ok(json!({ "text": text }));
                    }
                }
                if let Ok(img) = cb.get_image() {
                    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
                        .ok_or_else(|| fail_invalid("클립보드 이미지를 읽을 수 없습니다."))?;
                    let mut png = Vec::new();
                    image::DynamicImage::ImageRgba8(rgba)
                        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
                        .map_err(|_| fail_invalid("클립보드 이미지를 읽을 수 없습니다."))?;
                    return Ok(json!({ "image": base64::engine::general_purpose::STANDARD.encode(png) }));
                }
            }
            Ok(json!({}))
        }
        "createDocument" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.create(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "readDocument" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.read(id)
        }
        "saveDocument" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.save(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "reorderProjects" => {
            let changed = {
                let mut guard = state.store.lock().unwrap();
                let store = guard.as_mut().ok_or_else(|| fail_invalid("Store not initialized"))?;
                store.reorder_projects(&args)?
            };
            if changed {
                schedule_notify(app, &state.notify_seq);
            }
            Ok(json!(changed))
        }
        "reorderDocuments" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.reorder(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(res))
        }
        "deleteProject" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.remove_project(id)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(res))
        }
        "repair" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.repair()?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "relinkDocument" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.relink_document(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "adoptFile" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.adopt_file(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "forgetDocument" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.forget_document(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(res))
        }
        "revealFile" => {
            let project_id = args.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let file = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.project_file(project_id, path)?
            };
            show_item_in_folder(&file);
            Ok(json!(true))
        }
        "memoSpaces" => {
            let (_, common_root) = get_store_and_common()?;
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            Memos::spaces(st, &common_root)
        }
        "memoTree" => {
            let space = args.get("space").and_then(|v| v.as_str()).unwrap_or("");
            let (_, common_root) = get_store_and_common()?;
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            Memos::tree(st, &common_root, space)
        }
        "memoRead" => {
            let space = args.get("space").and_then(|v| v.as_str()).unwrap_or("");
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let (_, common_root) = get_store_and_common()?;
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            Memos::read(st, &common_root, space, path)
        }
        "adoptMemo" => {
            let (_, common_root) = get_store_and_common()?;
            let mut guard = state.store.lock().unwrap();
            let st = guard.as_mut().ok_or_else(|| fail_invalid("Store not initialized"))?;
            Memos::adopt(st, &common_root, &args)
        }
        "memoSave" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::save(st, &common_root, &args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "memoCreate" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::create(st, &common_root, &args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "memoCreateFolder" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::create_folder(st, &common_root, &args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "memoRename" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::rename(st, &common_root, &args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "memoMove" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::move_entry(st, &common_root, &args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "memoArchive" | "memoArchiveFolder" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard.as_mut().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
                if method == "memoArchiveFolder" { Memos::archive_folder(st, &common_root, &args)? }
                else { Memos::archive(st, &common_root, &args)? }
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(res))
        }
        "memoRemove" => {
            let (_, common_root) = get_store_and_common()?;
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::remove(st, &common_root, &args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(res))
        }
        "memoReveal" => {
            let space = args.get("space").and_then(|v| v.as_str()).unwrap_or("");
            let path = args.get("path").and_then(|v| v.as_str());
            let (_, common_root) = get_store_and_common()?;
            let file = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                Memos::locate(st, &common_root, space, path)?
            };
            if path.is_some_and(|p| !p.is_empty()) {
                show_item_in_folder(&file);
            } else {
                open_folder_path(&file);
            }
            Ok(json!(true))
        }
        "chooseCommonMemo" => {
            let (store_root, current_common) = get_store_and_common()?;
            #[cfg(target_os = "android")]
            if android_library::is_internal(&state.user_dir, &store_root) {
                return Err(fail_invalid("내부 저장소를 쓰는 동안에는 공용 메모 위치를 바꿀 수 없습니다."));
            }
            let folder = if let Some(custom_path) = args
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                #[cfg(target_os = "android")]
                if !Path::new(custom_path).is_absolute() || android_library::is_internal(&state.user_dir, Path::new(custom_path)) {
                    return Err(fail_invalid("공용 메모는 기기 폴더에만 둘 수 있습니다. 기기 폴더를 선택해 주세요."));
                }
                let p = if Path::new(custom_path).is_absolute() {
                    PathBuf::from(custom_path)
                } else {
                    let safe_name: String = custom_path
                        .chars()
                        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
                        .collect();
                    state.user_dir.join(if safe_name.is_empty() { "CommonMemo" } else { &safe_name })
                };
                fs::create_dir_all(&p)?;
                p
            } else {
                #[cfg(not(target_os = "android"))]
                {
                    let picked = FileDialog::new()
                        .set_title("공용 메모 폴더 선택")
                        .set_directory(&current_common)
                        .pick_folder();
                    let Some(folder) = picked else {
                        return Ok(Value::Null);
                    };
                    folder
                }
                #[cfg(target_os = "android")]
                {
                    let _ = current_common;
                    return Ok(Value::Null);
                }
            };
            let clean_folder = strip_verbatim_prefix(&fs::canonicalize(&folder).unwrap_or(folder));
            let new_common = {
                let mut s_guard = state.settings.lock().unwrap();
                let mut prefs = s_guard
                    .get("preferences")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                prefs.insert(
                    "commonMemoPath".to_string(),
                    json!(clean_folder.to_string_lossy().to_string()),
                );
                if let Some(obj) = s_guard.as_object_mut() {
                    obj.insert("preferences".to_string(), Value::Object(prefs));
                }
                persist_settings(&state.config_file, &s_guard)?;
                common_memo_root_of(&store_root, &s_guard)
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(new_common.to_string_lossy().to_string()))
        }
        "search" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let project_id = args
                .get("projectId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.search(query, project_id)
        }
        "searchText" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let project_id = args
                .get("projectId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let case_sensitive = args
                .get("caseSensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let (_, common_root) = get_store_and_common()?;
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            let all = st.search_all(query, project_id, case_sensitive)?;
            let common = Memos::search_text(st, &common_root, "common", query, case_sensitive)?;
            let mut out = all.as_object().cloned().unwrap_or_default();
            out.insert("common".to_string(), common);
            Ok(Value::Object(out))
        }
        "history" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.history(id)
        }
        "historyPage" => {
            let id = args["id"].as_str().unwrap_or("");
            let offset = args["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize;
            let limit = args["limit"].as_u64().unwrap_or(100).clamp(1, 100) as usize;
            let guard = state.store.lock().unwrap();
            let store = guard.as_ref().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
            store.history_page(id, offset, limit, args["anchor"].as_str())
        }
        // 이력 지우기: id와 name이면 그 이력 하나, id만 있으면 그 문서의 이력 전부, 둘 다 없으면 모든 이력. 지운 개수를 돌려준다.
        "deleteHistory" => {
            let id = args.get("id").and_then(|v| v.as_str());
            let name = args.get("name").and_then(|v| v.as_str());
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            Ok(json!(st.history_delete(id, name)?))
        }
        // 직접 저장은 현재 원고를 기록하거나 기존 같은 버전에 수동 저장 표시를 추가한다.
        "checkpointDocument" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            let recorded = st.checkpoint(id, force)?;
            drop(guard);
            schedule_notify(app, &state.notify_seq);
            Ok(json!(recorded))
        }
        "historyRead" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            let mut previous = st.history_read(id, name)?;
            if args["compare"].as_bool() == Some(true) {
                let current = st.read(id)?;
                previous["comparison"] = git_history::comparison(&previous, &current)?;
            }
            Ok(previous)
        }
        "restore" => {
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.restore(&args)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "saveRecoveryCopy" | "recoveryCopies" | "readRecoveryCopy" | "deleteRecoveryCopy" | "restoreRecoveryCopy" => {
            let common_root = if method == "restoreRecoveryCopy" && args["space"].as_str() == Some(memo::COMMON) {
                Some(get_store_and_common()?.1)
            } else { None };
            let mut guard = state.store.lock().unwrap();
            let st = guard.as_mut().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
            let result = match method {
                "saveRecoveryCopy" => st.save_recovery_copy(&args),
                "recoveryCopies" => st.recovery_copies(),
                "readRecoveryCopy" => st.read_recovery_copy(args["key"].as_str().unwrap_or("")),
                "deleteRecoveryCopy" => st.remove_recovery_copy(args["key"].as_str().unwrap_or("")),
                _ => match common_root {
                    Some(root) => Memos::restore_common_copy(st, &root, args["key"].as_str().unwrap_or("")),
                    None => st.restore_recovery_copy(&args),
                },
            };
            drop(guard);
            if result.is_ok() && !matches!(method, "recoveryCopies" | "readRecoveryCopy") { schedule_notify(app, &state.notify_seq); }
            if result.is_ok() && method == "restoreRecoveryCopy" { auto_sync::request(app); }
            result
        }
        "adoptDocument" => {
            let mut guard = state.store.lock().unwrap();
            let st = guard.as_mut().ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.adopt_document(&args)
        }
        "finishDocumentSync" => {
            let mut guard = state.store.lock().unwrap();
            let st = guard.as_mut().ok_or_else(|| fail_invalid("Store not initialized"))?;
            let finished = st.finish_document_sync(&args)?;
            drop(guard);
            if finished { auto_sync::request(app); }
            Ok(json!(finished))
        }
        "saveDraft" => {
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            Ok(json!(st.draft(&args)?))
        }
        "clearDraft" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.clear_draft(id)?;
            Ok(Value::Null)
        }
        "deleteDocument" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                st.remove(id)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(json!(res))
        }
        "importFiles" => {
            let project_id = args.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let (file_strs, temp_dir_cleanup): (Vec<String>, Option<PathBuf>) =
                if let Some(items) = args.get("items").and_then(Value::as_array) {
                    let tmp_dir = state
                        .user_dir
                        .join(".tmp-imports")
                        .join(Uuid::new_v4().to_string());
                    fs::create_dir_all(&tmp_dir)?;
                    let mut written = Vec::new();
                    for (idx, item) in items.iter().enumerate() {
                        let raw_name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("imported.md");
                        let clean_name: String = raw_name
                            .chars()
                            .map(|c| {
                                if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                                    '_'
                                } else {
                                    c
                                }
                            })
                            .collect();
                        let b64 = item.get("data").and_then(Value::as_str).unwrap_or("");
                        let raw = b64
                            .strip_prefix("data:")
                            .and_then(|s| s.split_once(";base64,").map(|(_, d)| d))
                            .unwrap_or(b64);
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(raw)
                            .map_err(|_| fail_invalid("가져올 파일을 읽을 수 없습니다."))?;
                        let sub_dir = tmp_dir.join(format!("{idx}"));
                        fs::create_dir_all(&sub_dir)?;
                        let file_path = sub_dir.join(if clean_name.is_empty() {
                            "imported.md"
                        } else {
                            &clean_name
                        });
                        fs::write(&file_path, bytes)?;
                        written.push(file_path.to_string_lossy().to_string());
                    }
                    (written, Some(tmp_dir))
                } else {
                    #[cfg(not(target_os = "android"))]
                    {
                        let picked = FileDialog::new()
                            .set_title("원고 가져오기 (원본 파일 보존)")
                            .add_filter("원고", &["md", "txt", "mvle"])
                            .pick_files();
                        let Some(files) = picked else {
                            return Ok(Value::Null);
                        };
                        (
                            files
                                .into_iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect(),
                            None,
                        )
                    }
                    #[cfg(target_os = "android")]
                    {
                        return Ok(Value::Null);
                    }
                };
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                import_files(st, &file_strs, project_id)
            };
            if let Some(tmp_dir) = temp_dir_cleanup {
                let _ = fs::remove_dir_all(tmp_dir);
            }
            let res = res?;
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "copyManuscript" => {
            if let Some(custom_text) = args.get("text").and_then(|v| v.as_str()) {
                let out_text = text::strip_jsdoc_comments(custom_text);
                set_clipboard_text(&out_text)?;
                return Ok(json!({ "copied": true, "text": out_text }));
            }
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let body = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                let doc = st.read(id)?;
                doc.get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let out_text = plain_text(&body);
            set_clipboard_text(&out_text)?;
            Ok(json!({ "copied": true, "text": out_text }))
        }
        "exportDocument" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let (title, body, md_content) = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                let doc = st.read(id)?;
                let t = doc
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("제목 없음")
                    .to_string();
                let b = doc
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let m = text::strip_jsdoc_comments(&st.markdown(id)?);
                (t, b, m)
            };
            let safe_title: String = title
                .chars()
                .map(|c| {
                    if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                        '_'
                    } else {
                        c
                    }
                })
                .collect();
            #[cfg(not(target_os = "android"))]
            {
                let picked = FileDialog::new()
                    .set_file_name(format!("{}.md", safe_title))
                    .add_filter("Markdown", &["md"])
                    .add_filter("텍스트", &["txt"])
                    .save_file();
                let Some(file_path) = picked else {
                    return Ok(json!(false));
                };
                let is_txt = file_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("txt"));
                let out_str = if is_txt {
                    plain_text(&body)
                } else {
                    md_content
                };
                atomic_write_str(&file_path, &out_str)?;
                Ok(json!(file_path.to_string_lossy().to_string()))
            }
            #[cfg(target_os = "android")]
            {
                let exports_dir = state.user_dir.join("Exports");
                fs::create_dir_all(&exports_dir)?;
                let file_name = format!("{}.md", safe_title);
                let file_path = exports_dir.join(&file_name);
                atomic_write_str(&file_path, &md_content)?;
                Ok(json!({
                    "path": file_path.to_string_lossy().to_string(),
                    "fileName": file_name,
                    "content": md_content,
                    "txtContent": plain_text(&body),
                }))
            }
        }
        "reveal" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            if let Some(doc_id) = id {
                let file = {
                    let mut guard = state.store.lock().unwrap();
                    let st = guard
                        .as_mut()
                        .ok_or_else(|| fail_invalid("Store not initialized"))?;
                    st.locate(doc_id)?
                };
                show_item_in_folder(&file);
            } else {
                let (store_root, _) = get_store_and_common()?;
                open_folder_path(&store_root);
            }
            Ok(json!(true))
        }
        "settings" => {
            let settings = state.settings.lock().unwrap().clone();
            // 서재 색인·이력 작업 중에도 설정은 저장된 경로로 바로 조회한다.
            let (store_root, storage) = {
                let guard = state.store.try_lock().ok();
                let store = guard.as_ref().and_then(|guard| guard.as_ref());
                let root = store.map(|store| store.root.clone()).unwrap_or_else(|| {
                    PathBuf::from(settings["vaultPath"].as_str().unwrap_or(""))
                });
                (root, store.map(Store::storage_status))
            };
            let common_root = common_memo_root_of(&store_root, &settings);
            let s_guard = &settings;
            let conns: Vec<Value> = s_guard
                .get("connections")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter()
                    .filter(|connection| matches!(connection["type"].as_str(), Some("folder" | "webdav" | "ftp")))
                    .map(safe_connection).collect())
                .unwrap_or_default();
            let prefs = s_guard
                .get("preferences")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Ok(json!({
                "connections": conns,
                "vaultPath": store_root.to_string_lossy().to_string(),
                "internalVaultPath": android_library::internal_library_root(&state.user_dir).to_string_lossy().to_string(),
                "isInternalVault": android_library::is_internal(&state.user_dir, &store_root),
                "commonMemoPath": common_root.to_string_lossy().to_string(),
                "apiPort": state.api.port,
                "preferences": prefs,
                "syncing": state.syncing.is_busy(),
                "autoSync": app.state::<auto_sync::AutoSyncState>().status(),
                "storage": storage,
            }))
        }
        "saveConnection" => {
            let policy = args.get("conflictPolicy").and_then(Value::as_str).unwrap_or("keepBoth");
            if !matches!(policy, "keepBoth" | "latest") {
                return Err(fail_invalid("충돌 사본 처리 방식을 확인해 주세요."));
            }
            let ctype = args.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(ctype, "folder" | "ftp" | "webdav") {
                return Err(fail_invalid("지원하지 않는 연결"));
            }
            if ctype == "ftp" {
                sync::validate_ftp_config(&args)?;
            }
            let raw_name = args
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(ctype);
            let name: String = raw_name.chars().take(100).collect();
            let mut conn = serde_json::Map::new();
            conn.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
            conn.insert("name".to_string(), json!(name));
            conn.insert("type".to_string(), json!(ctype));
            conn.insert("conflictPolicy".to_string(), json!(policy));

            if ctype == "folder" {
                #[cfg(not(target_os = "android"))]
                {
                    let picked = FileDialog::new()
                        .set_title("로컬 동기화 폴더 선택")
                        .pick_folder();
                    let Some(folder) = picked else {
                        return Ok(Value::Null);
                    };
                    let clean = strip_verbatim_prefix(&folder);
                    conn.insert(
                        "folder".to_string(),
                        json!(clean.to_string_lossy().to_string()),
                    );
                }
                #[cfg(target_os = "android")]
                {
                    return Err(fail_invalid(
                        "모바일에서는 실시간 장치 연결(P2P)이나 WebDAV/FTP 서버 연결을 사용해 주세요.",
                    ));
                }
            } else {
                for k in [
                    "host",
                    "url",
                    "username",
                    "password",
                    "remotePath",
                    "port",
                    "secure",
                ] {
                    if let Some(v) = args.get(k) {
                        if !v.is_null() {
                            conn.insert(k.to_string(), v.clone());
                        }
                    }
                }
                if ctype == "ftp"
                    && conn
                        .get("host")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .is_empty()
                {
                    return Err(fail_invalid("FTP 호스트가 필요합니다."));
                }
                if ctype == "webdav" {
                    let url = conn.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    if !url.starts_with("http://") && !url.starts_with("https://") {
                        return Err(fail_invalid("WebDAV URL이 필요합니다."));
                    }
                }
            }

            let conn_val = Value::Object(conn);
            let encrypted = encrypt_connection(&conn_val)?;
            {
                let mut s_guard = state.settings.lock().unwrap();
                let mut conns = s_guard
                    .get("connections")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                conns.push(encrypted);
                if let Some(obj) = s_guard.as_object_mut() {
                    obj.insert("connections".to_string(), Value::Array(conns));
                }
                persist_settings(&state.config_file, &s_guard)?;
            }
            Ok(safe_connection(&conn_val))
        }
        "setSyncConflictPolicy" => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or("");
            let policy = args.get("conflictPolicy").and_then(Value::as_str).unwrap_or("");
            if !matches!(policy, "keepBoth" | "latest") {
                return Err(fail_invalid("충돌 사본 처리 방식을 확인해 주세요."));
            }
            let mut settings = state.settings.lock().unwrap();
            let mut next = settings.clone();
            let connection = next.get_mut("connections").and_then(Value::as_array_mut)
                .and_then(|connections| connections.iter_mut().find(|c| c["id"].as_str() == Some(id)))
                .ok_or_else(|| fail_invalid("외부 저장소 연결을 찾을 수 없습니다."))?;
            connection["conflictPolicy"] = json!(policy);
            let safe = safe_connection(connection);
            persist_settings(&state.config_file, &next)?;
            *settings = next;
            Ok(safe)
        }
        "checkSyncUpdates" => auto_sync::request_check(app),
        "requestSyncNow" => {
            auto_sync::request_now(app);
            Ok(json!(true))
        }
        "removeConnection" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut s_guard = state.settings.lock().unwrap();
            let conns: Vec<Value> = s_guard
                .get("connections")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter(|c| c.get("id").and_then(|v| v.as_str()) != Some(id))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if let Some(obj) = s_guard.as_object_mut() {
                obj.insert("connections".to_string(), Value::Array(conns));
            }
            persist_settings(&state.config_file, &s_guard)?;
            drop(s_guard);
            auto_sync::configure(app);
            Ok(json!(true))
        }
        "sync" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let root = {
                let mut guard = state.store.lock().unwrap();
                let store = guard.as_mut().ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
                store.poll_disk()?;
                store.root.clone()
            };
            let sync_res = sync_connection(state, id, &root);
            schedule_notify(app, &state.notify_seq);
            sync_res
        }
        "setPreferences" => {
            desktop_startup::validate(&args)?;
            if let Some(value) = args.get("syncIntervalSeconds") {
                if !value.as_u64().is_some_and(|seconds| (60..=3600).contains(&seconds)) {
                    return Err(fail_invalid("자동 동기화 주기는 1분부터 1시간 사이로 지정해 주세요."));
                }
            }
            if let Some(value) = args.get("backgroundSyncIntervalSeconds") {
                if !value.as_u64().is_some_and(|seconds| (900..=3600).contains(&seconds)) {
                    return Err(fail_invalid("백그라운드 동기화 주기는 15분부터 1시간 사이로 지정해 주세요."));
                }
            }
            if let Some(value) = args.get("backgroundKeepAlive") {
                if !matches!(value.as_str(), Some("live" | "always" | "off")) {
                    return Err(fail_invalid("앱을 닫은 뒤 알림 설정이 올바르지 않습니다."));
                }
            }
            if let Some(value) = args.get("backgroundLiveMode") {
                if !matches!(value.as_str(), Some("timed" | "always")) {
                    return Err(fail_invalid("즉시 동기화 유지 방식을 확인해 주세요."));
                }
            }
            if let Some(value) = args.get("backgroundLiveMinutes") {
                if !value.as_u64().is_some_and(|minutes| (1..=120).contains(&minutes)) {
                    return Err(fail_invalid("유지 시간은 1분부터 120분 사이로 지정해 주세요."));
                }
            }
            let new_prefs = {
                let mut s_guard = state.settings.lock().unwrap();
                let mut prefs = s_guard
                    .get("preferences")
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                if let Some(in_obj) = args.as_object() {
                    for (k, v) in in_obj {
                        prefs.insert(k.clone(), v.clone());
                    }
                }
                let prefs_val = Value::Object(prefs);
                let mut next = s_guard.clone();
                if let Some(obj) = next.as_object_mut() {
                    obj.insert("preferences".to_string(), prefs_val.clone());
                }
                let startup_change = desktop_startup::apply(&args)?;
                if let Err(error) = persist_settings(&state.config_file, &next) {
                    if let Some(change) = startup_change { change.rollback()?; }
                    return Err(error);
                }
                *s_guard = next;
                let policy = history_policy_from_settings(&s_guard);
                let manual_lb = default_manual_line_break_from_settings(&s_guard);
                // 보관 규칙을 바꾸면 다음 날까지 기다리지 않고 바로 정리한다.
                let retention_changed = args
                    .as_object()
                    .is_some_and(|o| o.contains_key("historyKeepCount") || o.contains_key("historyKeepDays"));
                if let Ok(mut st_guard) = state.store.lock() {
                    if let Some(ref mut st) = *st_guard {
                        st.history_policy = policy;
                        st.default_manual_line_break = manual_lb;
                        if retention_changed {
                            st.retain_history(true)?;
                        }
                    }
                }
                prefs_val
            };
            auto_sync::configure(app);
            Ok(new_prefs)
        }
        "setCompactWindow" => {
            let compact = args
                .get("compact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            state.compact_window.store(compact, Ordering::SeqCst);
            apply_window_min_size(window, state);
            Ok(json!(compact))
        }
        "setTitleBarDimmed" => {
            let dimmed = args
                .get("dimmed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            state.title_bar_dimmed.store(dimmed, Ordering::SeqCst);
            Ok(json!(dimmed))
        }
        "mcpConfig" => {
            let exe_path = std::env::current_exe()
                .unwrap_or_else(|_| PathBuf::from("Lof Writer.exe"))
                .to_string_lossy()
                .to_string();
            let runtime_path = state
                .user_dir
                .join("runtime.json")
                .to_string_lossy()
                .to_string();
            let config = json!({
                "mcpServers": {
                    "lof-writer": {
                        "command": exe_path,
                        "args": ["--mcp"],
                        "env": {
                            "LOF_RUNTIME": runtime_path,
                        }
                    }
                }
            });
            let text = serde_json::to_string_pretty(&config).unwrap_or_default();
            set_clipboard_text(&text)?;
            Ok(config)
        }
        "copyApi" => {
            let info = json!({
                "url": format!("http://127.0.0.1:{}/rpc", state.api.port),
                "headers": {
                    "Authorization": format!("Bearer {}", state.api.token),
                }
            });
            let text = serde_json::to_string_pretty(&info).unwrap_or_default();
            set_clipboard_text(&text)?;
            Ok(json!(true))
        }
        "downloadSkill" => Ok(json!(skills::download(window)?)),
        "installFontFiles" => {
            if let Some(items) = args.get("items").and_then(Value::as_array) {
                let tmp_dir = state
                    .user_dir
                    .join(".tmp-fonts")
                    .join(Uuid::new_v4().to_string());
                fs::create_dir_all(&tmp_dir)?;
                let mut temp_paths = Vec::new();
                for (idx, item) in items.iter().enumerate() {
                    let raw_name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("font.ttf");
                    let clean_name: String = raw_name
                        .chars()
                        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
                        .collect();
                    let b64 = item.get("data").and_then(Value::as_str).unwrap_or("");
                    let raw = b64
                        .strip_prefix("data:")
                        .and_then(|s| s.split_once(";base64,").map(|(_, d)| d))
                        .unwrap_or(b64);
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(raw)
                        .map_err(|_| fail_invalid("글꼴 파일을 읽을 수 없습니다."))?;
                    let sub_dir = tmp_dir.join(format!("{idx}"));
                    fs::create_dir_all(&sub_dir)?;
                    let file_path = sub_dir.join(if clean_name.is_empty() { "font.ttf" } else { &clean_name });
                    fs::write(&file_path, bytes)?;
                    temp_paths.push(file_path);
                }
                let res = fonts::install_font_files(
                    &state.user_dir,
                    &state.config_file,
                    &state.settings,
                    Some(temp_paths),
                );
                let _ = fs::remove_dir_all(tmp_dir);
                return res;
            }
            let paths = args.get("paths").and_then(Value::as_array).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(PathBuf::from))
                    .collect()
            });
            fonts::install_font_files(&state.user_dir, &state.config_file, &state.settings, paths)
        }
        "systemFonts" => {
            let refresh = args.get("refresh").and_then(Value::as_bool).unwrap_or(false);
            Ok(Value::Array(fonts::list_system_fonts(refresh)))
        }
        "addSystemFont" => fonts::add_system_font(&state.config_file, &state.settings, &args),
        "removeUserFont" => {
            fonts::remove_user_font(&state.user_dir, &state.config_file, &state.settings, &args)
        }
        "readUserFont" => fonts::read_user_font(&state.user_dir, &args),
        "exportLibrary" | "exportProject" => {
            let (_, common_root) = get_store_and_common()?;
            let default_preserve_breaks = {
                let s_guard = state.settings.lock().unwrap();
                s_guard
                    .get("preferences")
                    .and_then(|p| p.get("copyWithBlankLines"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            export::export_library_or_project(
                &state.store,
                &common_root,
                &args,
                default_preserve_breaks,
            )
        }
        "openExportFolder" => {
            if let Some(p) = args
                .get("path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let target = Path::new(p);
                if target.is_dir() {
                    open_folder_path(target);
                }
            }
            Ok(json!(true))
        }
        _ => Err(fail_invalid(format!("알 수 없는 요청: {}", method))),
    }
}

#[tauri::command]
async fn lof_invoke(
    method: String,
    args: Option<Value>,
    state: State<'_, AppState>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    let args_val = args.unwrap_or_else(|| json!({}));
    let result = if method.starts_with("realtime") || matches!(method.as_str(), "settings" | "searchText" | "search" | "adoptDocument" | "adoptMemo" | "finishDocumentSync" | "saveDraft" | "saveRecoveryCopy" | "recoveryCopies" | "readRecoveryCopy" | "deleteRecoveryCopy" | "restoreRecoveryCopy" | "sync" | "pinUnlock" | "pinSave" | "backupStorage" | "backupGitHistory" | "resetHistory" | "history" | "historyPage" | "historyRead" | "restore" | "checkpointDocument" | "countManuscript" | "downloadSkill" | "checkSyncUpdates" | "systemFonts" | "readUserFont" | "exportLibrary" | "exportProject" | "prepareAndroidLibrary" | "moveVault") {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            if method == "pinUnlock" || method == "pinSave" {
                let pin = app.state::<pin::PinState>();
                if method == "pinUnlock" {
                    pin.unlock(args_val.get("pin").and_then(Value::as_str).unwrap_or(""))?;
                } else {
                    let current = args_val.get("currentPin").and_then(Value::as_str).unwrap_or("");
                    let next = match args_val.get("newPin") {
                        Some(Value::String(pin)) => Some(pin.as_str()),
                        Some(Value::Null) => None,
                        _ => return Err(fail_invalid("새 PIN을 확인해 주세요.")),
                    };
                    if next.is_some() && args_val.get("confirmPin").and_then(Value::as_str) != next {
                        return Err(fail_invalid("새 PIN과 확인 번호가 일치하지 않습니다."));
                    }
                    pin.save(current, next)?;
                    if !window.is_visible().unwrap_or(false) {
                        pin.lock_for_tray();
                    }
                }
                let status = pin_status(&app);
                let _ = app.emit("lof:pin-state", &status);
                Ok(status)
            } else {
                handle_method(&method, args_val, &state, &app, &window)
            }
        })
        .await
        .unwrap_or_else(|_| Err(fail_invalid("요청 처리 중 오류가 발생했습니다.")))
    } else {
        handle_method(&method, args_val, &state, &app, &window)
    };
    match result {
        Ok(data) => Ok(json!({ "ok": true, "data": data })),
        Err(e) => Ok(json!({ "ok": false, "error": e.message, "code": e.code })),
    }
}

#[tauri::command]
fn lof_flushed(ok: bool, state: State<'_, AppState>, window: WebviewWindow) {
    if !state.close_pending.swap(false, Ordering::SeqCst) {
        return;
    }
    state.close_seq.fetch_add(1, Ordering::SeqCst);
    if !ok {
        state.quit_requested.store(false, Ordering::SeqCst);
        restore_main_window(window.app_handle());
        #[cfg(not(target_os = "android"))]
        thread::spawn(move || {
            MessageDialog::new()
                .set_level(MessageLevel::Warning)
                .set_title("Lof Writer")
                .set_description(
                    "저장하지 못한 원고가 있습니다.\n\n편집 화면에서 저장 상태와 충돌을 확인한 뒤 다시 시도해 주세요. 임시 원고는 로컬에 보관됩니다.",
                )
                .set_buttons(MessageButtons::Ok)
                .show();
        });
        return;
    }
    if state.quit_requested.swap(false, Ordering::SeqCst) {
        state.closing.store(true, Ordering::SeqCst);
        #[cfg(not(target_os = "android"))]
        {
            let _ = window.close();
        }
    } else {
        hide_to_tray(window.app_handle());
    }
}

fn pin_status(app: &AppHandle) -> Value {
    let mut status = app.state::<pin::PinState>().status();
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    let prefs = settings.get("preferences");
    status["theme"] = prefs.and_then(|p| p.get("theme")).cloned().unwrap_or(json!("light"));
    status["colorTheme"] = prefs.and_then(|p| p.get("colorTheme")).cloned().unwrap_or(json!("modern"));
    status
}

fn hide_to_tray(app: &AppHandle) {
    #[cfg(not(target_os = "android"))]
    if let Some(window) = app.get_webview_window("main") {
        if window.hide().is_ok() {
            app.state::<pin::PinState>().lock_for_tray();
            let _ = app.emit("lof:pin-state", pin_status(app));
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
    }
}

fn restore_main_window(app: &AppHandle) {
    let pin = app.state::<pin::PinState>();
    if pin.is_locked() {
        pin.request_show();
        let _ = app.emit("lof:pin-state", pin_status(app));
        return;
    }
    show_main_window(app);
}

fn show_main_window(app: &AppHandle) {
    #[cfg(not(target_os = "android"))]
    if let Some(window) = app.get_webview_window("main") {
        let was_hidden = !window.is_visible().unwrap_or(true);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if was_hidden && window.is_visible().unwrap_or(false) {
            auto_sync::resume(app);
            if app.state::<AppState>().startup_notice_pending.swap(false, Ordering::SeqCst) {
                file_sync_reset::show_notice(app);
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        auto_sync::resume(app);
    }
}

/// 집중 모드의 작은 창 허용 여부에 맞춰 창 최소 크기를 적용한다.
/// 최소 크기를 바꾸면 창 크기를 다시 지정하게 되어 최대화·전체 화면이 풀리므로,
/// 그 상태에서는 적용을 미뤘다가 창이 일반 상태로 돌아왔을 때(Resized) 적용한다.
fn apply_window_min_size(window: &WebviewWindow, state: &AppState) {
    #[cfg(target_os = "android")]
    {
        let _ = (window, state);
        return;
    }
    #[cfg(not(target_os = "android"))]
    {
        if window.is_maximized().unwrap_or(false)
            || window.is_fullscreen().unwrap_or(false)
            || window.is_minimized().unwrap_or(false)
        {
            return;
        }
        let compact = state.compact_window.load(Ordering::SeqCst);
        if state.compact_applied.swap(compact, Ordering::SeqCst) == compact {
            return;
        }
        let (min_w, min_h) = if compact {
            (320.0, 260.0)
        } else {
            (1000.0, 650.0)
        };
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)));
        if !compact {
            if let (Ok(size), Ok(scale)) = (window.outer_size(), window.scale_factor()) {
                let logical_w = size.width as f64 / scale;
                let logical_h = size.height as f64 / scale;
                if logical_w < min_w || logical_h < min_h {
                    let _ = window.set_size(tauri::LogicalSize::new(
                        logical_w.max(min_w),
                        logical_h.max(min_h),
                    ));
                }
            }
        }
    }
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) {
    #[cfg(not(target_os = "android"))]
    {
        let _ = window.minimize();
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
    }
}

#[tauri::command]
fn updater_status(app: AppHandle) -> Value {
    if cfg!(target_os = "android") {
        return json!({ "supported": true, "configured": true, "platform": "android" });
    }
    let updater = app.config().plugins.0.get("updater");
    let has_key = updater
        .and_then(|v| v.get("pubkey"))
        .and_then(Value::as_str)
        .is_some_and(|v| !v.trim().is_empty());
    let has_endpoint = updater
        .and_then(|v| v.get("endpoints"))
        .and_then(Value::as_array)
        .is_some_and(|urls| !urls.is_empty() && urls.iter().all(|v| {
            v.as_str().is_some_and(|s| s.starts_with("https://"))
        }));
    json!({ "supported": cfg!(target_os = "windows"), "configured": has_key && has_endpoint, "platform": "windows" })
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) -> bool {
    #[cfg(not(target_os = "android"))]
    {
        let is_max = window.is_maximized().unwrap_or(false);
        if is_max {
            let _ = window.unmaximize();
            false
        } else {
            let _ = window.maximize();
            true
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
        false
    }
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> bool {
    #[cfg(not(target_os = "android"))]
    {
        window.is_maximized().unwrap_or(false)
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
        false
    }
}

#[tauri::command]
fn window_close(window: WebviewWindow) {
    #[cfg(not(target_os = "android"))]
    {
        let _ = window.close();
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
    }
}

#[tauri::command]
fn window_start_dragging(window: WebviewWindow) {
    #[cfg(not(target_os = "android"))]
    {
        let _ = window.start_dragging();
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
    }
}

fn show_startup_error(msg: impl Into<String>) {
    let msg = msg.into();
    #[cfg(not(target_os = "android"))]
    {
        MessageDialog::new()
            .set_level(MessageLevel::Error)
            .set_title("Lof Writer 시작 실패")
            .set_description(msg)
            .show();
    }
    #[cfg(target_os = "android")]
    {
        eprintln!("Lof Writer 시작 실패: {msg}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args()
        .skip(1)
        .any(|a| a == "--mcp" || a.ends_with("mcp.mjs"))
    {
        api::run_mcp_stdio();
        return;
    }

    let user_dir = get_user_dir();
    #[cfg(not(target_os = "android"))]
    let instance = match single_instance::SingleInstance::acquire(&user_dir, !desktop_startup::background_launch()) {
        Ok(Some(instance)) => instance,
        Ok(None) => return,
        Err(error) => {
            show_startup_error(error.to_string());
            return;
        }
    };

    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let app_id: Vec<u16> = "local.lof.writer\0".encode_utf16().collect();
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }

    if let Err(e) = fs::create_dir_all(&user_dir) {
        show_startup_error(e.to_string());
        return;
    }

    let pin_state = match pin::PinState::load(user_dir.join("pin.json")) {
        Ok(pin) => pin,
        Err(error) => {
            show_startup_error(error.to_string());
            return;
        }
    };
    let config_file = user_dir.join("settings.json");
    let mut settings: Value = match fs::read_to_string(&config_file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => {
            show_startup_error(e.to_string());
            return;
        }
    };
    if !settings.is_object() {
        settings = json!({});
    }
    if let Err(error) = desktop_startup::load(&mut settings) {
        eprintln!("시작 프로그램 등록을 확인하지 못했습니다: {}", error.message);
    }
    if let Err(error) = library_sync_reset::migrate_settings(&config_file, &mut settings) {
        show_startup_error(format!("서버 연결 정보를 초기화하지 못했습니다: {}", error.message));
        return;
    }
    if let Err(error) = file_sync_reset::migrate(&config_file, &mut settings) {
        show_startup_error(format!("파일 동기화 연결을 초기화하지 못했습니다: {}", error.message));
        return;
    }
    // 허용 범위 밖의 기존 백그라운드 주기는 기본 30분으로 바꾸고 범위 안의 설정은 유지한다.
    let sync_interval = auto_sync::interval_seconds(&settings);
    let bg_sync_enabled = auto_sync::background_enabled(&settings);
    let bg_sync_interval = auto_sync::background_interval_seconds(&settings);
    if !settings.get("preferences").is_some_and(Value::is_object) {
        settings["preferences"] = json!({});
    }
    settings["preferences"]["syncIntervalSeconds"] = json!(sync_interval);
    settings["preferences"]["backgroundSyncEnabled"] = json!(bg_sync_enabled);
    settings["preferences"]["backgroundSyncIntervalSeconds"] = json!(bg_sync_interval);
    if settings
        .get("deviceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        settings["deviceId"] = json!(Uuid::new_v4().to_string());
    }
    let valid_conns: Vec<Value> = settings
        .get("connections")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|c| {
                    c.get("type")
                        .and_then(|v| v.as_str())
                        .is_some_and(|t| matches!(t, "folder" | "ftp" | "webdav" | "library"))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    settings["connections"] = Value::Array(valid_conns);

    #[cfg(not(target_os = "android"))]
    let initial_store = {
        let vault_root = std::env::var("LOF_VAULT")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                settings
                    .get("vaultPath")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| get_documents_dir().join("Lof Library"));
        let opened = Store::new(
            &vault_root,
            history_policy_from_settings(&settings),
            default_manual_line_break_from_settings(&settings),
        );
        match opened {
            Ok(mut st) => {
                st.set_recovery_directory(&user_dir);
                settings["vaultPath"] = json!(st.root.to_string_lossy().to_string());
                Some(st)
            }
            Err(e) => {
                show_startup_error(e.message);
                return;
            }
        }
    };
    // Android는 기본 서재가 앱 내부 저장소이며, 공유 저장소 폴더가 지정된 경우에만 권한 확인 뒤 연다.
    #[cfg(target_os = "android")]
    let initial_store: Option<Store> = {
        let vault_root = settings
            .get("vaultPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| android_library::internal_library_root(&user_dir));
        if android_library::is_internal(&user_dir, &vault_root) {
            let _ = fs::create_dir_all(&vault_root);
            match Store::new(
                &vault_root,
                history_policy_from_settings(&settings),
                default_manual_line_break_from_settings(&settings),
            ) {
                Ok(mut st) => {
                    st.set_recovery_directory(&user_dir);
                    settings["vaultPath"] = json!(st.root.to_string_lossy().to_string());
                    Some(st)
                }
                Err(_) => None,
            }
        } else {
            None
        }
    };
    let _ = persist_settings(&config_file, &settings);

    let store_arc = Arc::new(Mutex::new(initial_store));
    let settings_arc = Arc::new(Mutex::new(settings));
    let notify_seq = Arc::new(AtomicU64::new(0));
    let closing = Arc::new(AtomicBool::new(false));
    let close_pending = Arc::new(AtomicBool::new(false));
    let close_seq = Arc::new(AtomicU64::new(0));

    let app_handle_holder: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));
    let holder_for_api = Arc::clone(&app_handle_holder);
    let holder_for_sync = Arc::clone(&app_handle_holder);
    let notify_seq_for_api = Arc::clone(&notify_seq);
    let api_sync_seq = Arc::new(AtomicU64::new(0));

    let api_server = match start_api(
        Arc::clone(&store_arc),
        Arc::new(move || {
            if let Ok(guard) = holder_for_api.lock() {
                if let Some(ref app) = *guard {
                    schedule_notify(app, &notify_seq_for_api);
                    schedule_api_sync(app, &api_sync_seq);
                }
            }
        }),
        Arc::new(move |name: &str, args: &Value| {
            let app = holder_for_sync.lock().ok().and_then(|guard| guard.clone());
            let app = app.ok_or_else(|| fail_invalid("앱을 준비하는 중입니다. 잠시 후 다시 시도해 주세요."))?;
            api_app_tool(&app, name, args)
        }),
    ) {
        Ok(srv) => srv,
        Err(e) => {
            show_startup_error(e.message);
            return;
        }
    };

    let runtime_file = user_dir.join("runtime.json");
    let _ = atomic_write_str(
        &runtime_file,
        &serde_json::to_string(&json!({
            "port": api_server.port,
            "token": api_server.token,
            "pid": std::process::id(),
        }))
        .unwrap_or_default(),
    );

    let state = AppState {
        store: Arc::clone(&store_arc),
        settings: Arc::clone(&settings_arc),
        config_file,
        user_dir: user_dir.clone(),
        api: api_server,
        syncing: Arc::new(sync_activity::SyncActivity::default()),
        title_bar_dimmed: AtomicBool::new(false),
        compact_window: AtomicBool::new(false),
        compact_applied: AtomicBool::new(false),
        closing: Arc::clone(&closing),
        quit_requested: AtomicBool::new(false),
        startup_notice_pending: AtomicBool::new(false),
        close_pending: Arc::clone(&close_pending),
        close_seq: Arc::clone(&close_seq),
        notify_seq: Arc::clone(&notify_seq),
    };

    let user_dir_for_exit = user_dir.clone();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(android_updater::init())
        .plugin(android_storage::init())
        .plugin(android_scanner::init())
        .plugin(android_biometric::init())
        .plugin(android_system_bars::init())
        .plugin(background_sync::init());
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(instance);

    builder
        .manage(state)
        .manage(pin_state)
        .manage(auto_sync::AutoSyncState::default())
        .manage(realtime::Realtime::default())
        .manage(background_sync::BackgroundSync::default())
        .manage(git_worker::GitWorker::default())
        .manage(mcp_updater::McpUpdater::default())
        .invoke_handler(tauri::generate_handler![
            lof_invoke,
            lof_flushed,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            window_start_dragging,
            updater_status,
            desktop_updater::desktop_update_check,
            mcp_updater::desktop_update_register,
            mcp_updater::desktop_update_unregister,
            mcp_updater::desktop_update_claim,
            mcp_updater::desktop_update_report,
            android_updater::android_update_check,
            android_updater::android_update_download,
            android_updater::android_update_install,
            android_storage::android_pick_folder,
            android_storage::android_storage_access,
            android_storage::android_pick_image,
            android_scanner::android_scan_qr,
            android_biometric::android_biometric_status,
            android_biometric::android_biometric_set_enabled,
            android_biometric::android_biometric_unlock,
            android_system_bars::android_set_system_bars,
            background_sync::android_background_battery,
        ])
        .setup(move |app| {
            #[cfg(not(target_os = "android"))]
            {
                let open = MenuItem::with_id(app, "tray-open", "Lof Writer 열기", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "tray-quit", "종료", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                let icon = image::load_from_memory(include_bytes!("../icons/icon.png"))?.to_rgba8();
                let (width, height) = icon.dimensions();
                TrayIconBuilder::with_id("main-tray")
                    .icon(tauri::image::Image::new_owned(icon.into_raw(), width, height))
                    .tooltip("Lof Writer")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "tray-open" => restore_main_window(app),
                        "tray-quit" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let state: State<AppState> = app.state();
                                state.quit_requested.store(true, Ordering::SeqCst);
                                if window.close().is_err() {
                                    state.quit_requested.store(false, Ordering::SeqCst);
                                    restore_main_window(app);
                                }
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            restore_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            let handle = app.handle().clone();
            {
                let mut h_guard = app_handle_holder.lock().unwrap();
                *h_guard = Some(handle.clone());
            }
            let st: State<AppState> = app.state();
            let start_in_tray = desktop_startup::start_in_tray(&st.settings.lock().unwrap());
            let bg_color = {
                let s_guard = st.settings.lock().unwrap();
                let prefs = s_guard.get("preferences");
                let dark = prefs
                    .and_then(|p| p.get("theme"))
                    .and_then(|v| v.as_str())
                    == Some("dark");
                let bakery = prefs
                    .and_then(|p| p.get("colorTheme"))
                    .and_then(|v| v.as_str())
                    == Some("bakery");
                let color = if bakery {
                    if dark {
                        tauri::webview::Color(0x15, 0x15, 0x15, 0xff)
                    } else {
                        tauri::webview::Color(0xfc, 0xfc, 0xfb, 0xff)
                    }
                } else if dark {
                    tauri::webview::Color(0x1f, 0x1f, 0x1f, 0xff)
                } else {
                    tauri::webview::Color(0xff, 0xff, 0xff, 0xff)
                };
                color
            };
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(not(target_os = "android"))]
                {
                    if let Ok(img) = image::load_from_memory(include_bytes!("../icons/icon.png")) {
                        let rgba = img.to_rgba8();
                        let (w, h) = rgba.dimensions();
                        let _ = win.set_icon(tauri::image::Image::new_owned(rgba.into_raw(), w, h));
                    } else if let Some(default_icon) = app.default_window_icon().cloned() {
                        let _ = win.set_icon(default_icon);
                    }
                }
                #[cfg(windows)]
                {
                    use windows_sys::Win32::UI::Shell::{
                        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
                    };
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL,
                        IMAGE_ICON, LR_LOADFROMFILE, SM_CXICON, SM_CXSMICON, SM_CYICON,
                        SM_CYSMICON, WM_SETICON,
                    };
                    if let Ok(hwnd) = win.hwnd() {
                        let hwnd_ptr = hwnd.0 as windows_sys::Win32::Foundation::HWND;
                        let ico_path = std::env::current_exe()
                            .ok()
                            .and_then(|p| p.parent().map(|d| d.join("icon.ico")))
                            .filter(|p| p.exists())
                            .or_else(|| {
                                let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                    .join("icons")
                                    .join("icon.ico");
                                p.exists().then_some(p)
                            });
                        if let Some(ico) = ico_path {
                            let wide: Vec<u16> =
                                format!("{}\0", ico.to_string_lossy()).encode_utf16().collect();
                            unsafe {
                                let sm_w = GetSystemMetrics(SM_CXSMICON);
                                let sm_h = GetSystemMetrics(SM_CYSMICON);
                                let lg_w = GetSystemMetrics(SM_CXICON);
                                let lg_h = GetSystemMetrics(SM_CYICON);
                                let h_small = LoadImageW(
                                    std::ptr::null_mut(),
                                    wide.as_ptr(),
                                    IMAGE_ICON,
                                    sm_w,
                                    sm_h,
                                    LR_LOADFROMFILE,
                                );
                                let h_big = LoadImageW(
                                    std::ptr::null_mut(),
                                    wide.as_ptr(),
                                    IMAGE_ICON,
                                    lg_w,
                                    lg_h,
                                    LR_LOADFROMFILE,
                                );
                                if !h_small.is_null() {
                                    SendMessageW(
                                        hwnd_ptr,
                                        WM_SETICON,
                                        ICON_SMALL as usize,
                                        h_small as isize,
                                    );
                                }
                                if !h_big.is_null() {
                                    SendMessageW(
                                        hwnd_ptr,
                                        WM_SETICON,
                                        ICON_BIG as usize,
                                        h_big as isize,
                                    );
                                }
                            }
                        }
                    }
                    unsafe {
                        SHChangeNotify(
                            SHCNE_ASSOCCHANGED as i32,
                            SHCNF_IDLIST,
                            std::ptr::null(),
                            std::ptr::null(),
                        );
                    }
                }
                let _ = win.set_background_color(Some(bg_color));
                if start_in_tray {
                    st.startup_notice_pending.store(true, Ordering::SeqCst);
                    hide_to_tray(&handle);
                } else {
                    restore_main_window(&handle);
                }
            }
            if !start_in_tray { file_sync_reset::show_notice(&handle); }
            auto_sync::start(&handle);
            realtime::start(&handle);
            git_worker::start(&handle);
            #[cfg(not(target_os = "android"))]
            app.state::<single_instance::SingleInstance>().listen(&handle);
            Ok(())
        })
        .on_window_event(move |window, event| {
            #[cfg(target_os = "android")]
            {
                let _ = (window, event);
            }
            #[cfg(not(target_os = "android"))]
            {
                if let tauri::WindowEvent::Resized(_) = event {
                    let app = window.app_handle().clone();
                    let st: State<AppState> = app.state();
                    if st.compact_window.load(Ordering::SeqCst)
                        == st.compact_applied.load(Ordering::SeqCst)
                    {
                        return;
                    }
                    let label = window.label().to_string();
                    let app_for_main = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Some(w) = app_for_main.get_webview_window(&label) {
                            let st: State<AppState> = app_for_main.state();
                            apply_window_min_size(&w, &st);
                        }
                    });
                    return;
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() != "main" {
                        return;
                    }
                    let app = window.app_handle();
                    let st: State<AppState> = app.state();
                    if st.closing.load(Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_close();
                    if st
                        .close_pending
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_err()
                    {
                        return;
                    }
                    let my_seq = st.close_seq.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = window.emit("lof:flush", ());

                    let close_pending_clone = Arc::clone(&st.close_pending);
                    let closing_clone = Arc::clone(&st.closing);
                    let close_seq_clone = Arc::clone(&st.close_seq);
                    let win_clone = window.clone();

                    thread::spawn(move || {
                        thread::sleep(Duration::from_secs(10));
                        if !close_pending_clone.load(Ordering::SeqCst)
                            || close_seq_clone.load(Ordering::SeqCst) != my_seq
                        {
                            return;
                        }
                        let state: State<AppState> = win_clone.state();
                        if !state.quit_requested.load(Ordering::SeqCst) {
                            close_pending_clone.store(false, Ordering::SeqCst);
                            close_seq_clone.fetch_add(1, Ordering::SeqCst);
                            hide_to_tray(win_clone.app_handle());
                            return;
                        }
                        restore_main_window(win_clone.app_handle());
                        let res = MessageDialog::new()
                            .set_level(MessageLevel::Warning)
                            .set_title("Lof Writer")
                            .set_description(
                                "편집기 응답을 기다리고 있습니다.\n\n강제 종료하면 마지막 입력이 유실될 수 있습니다.",
                            )
                            .set_buttons(MessageButtons::OkCancelCustom(
                                "종료".to_string(),
                                "계속 편집".to_string(),
                            ))
                            .show();
                        if close_seq_clone.load(Ordering::SeqCst) != my_seq {
                            return;
                        }
                        close_pending_clone.store(false, Ordering::SeqCst);
                        state.quit_requested.store(false, Ordering::SeqCst);
                        if matches!(
                            res,
                            MessageDialogResult::Ok | MessageDialogResult::Custom(_)
                        ) && res != MessageDialogResult::Custom("계속 편집".to_string())
                        {
                            closing_clone.store(true, Ordering::SeqCst);
                            let _ = win_clone.close();
                        }
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                auto_sync::stop(app_handle);
                git_worker::stop(app_handle);
                let _ = fs::remove_file(user_dir_for_exit.join("runtime.json"));
            }
        });
}
