pub mod api;
pub mod assets;
pub mod episode;
pub mod error;
pub mod file_index;
pub mod import;
pub mod markdown;
pub mod memo;
pub mod platforms;
pub mod store;
pub mod sync;
pub mod text;

use crate::api::{start_api, ApiServer};
use crate::error::{fail_invalid, LofError};
use crate::import::import_files;
use crate::memo::Memos;
use crate::store::{atomic_write_str, strip_verbatim_prefix, HistoryPolicy, Store};
use crate::sync::sync_once;
use crate::text::plain_text;
use base64::Engine;
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
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
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

pub struct AppState {
    pub store: Arc<Mutex<Option<Store>>>,
    pub settings: Arc<Mutex<Value>>,
    pub config_file: PathBuf,
    pub user_dir: PathBuf,
    pub api: ApiServer,
    pub vault_watcher: Mutex<Option<RecommendedWatcher>>,
    pub common_watcher: Mutex<Option<RecommendedWatcher>>,
    pub syncing: Arc<AtomicBool>,
    pub title_bar_dimmed: AtomicBool,
    /// 집중 모드에서 요청한 작은 창 허용 여부와 실제로 적용된 값.
    pub compact_window: AtomicBool,
    pub compact_applied: AtomicBool,
    pub closing: Arc<AtomicBool>,
    pub close_pending: Arc<AtomicBool>,
    pub close_seq: Arc<AtomicU64>,
    pub notify_seq: Arc<AtomicU64>,
    pub refresh_seq: Arc<AtomicU64>,
}

pub fn get_user_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("LOF_USER_DATA") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("Lof Writer");
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("Lof Writer")
}

pub fn get_documents_dir() -> PathBuf {
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
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join("Documents")
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
    let has_pw = obj
        .remove("password")
        .and_then(|v| v.as_str().map(|s| !s.is_empty()))
        .unwrap_or(false);
    obj.insert("hasPassword".to_string(), json!(has_pw));
    Value::Object(obj)
}

fn encrypt_connection(c: &Value) -> Result<Value, LofError> {
    let mut obj = c.as_object().cloned().unwrap_or_default();
    if let Some(pw) = obj
        .get("password")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let enc = dpapi_encrypt(pw)?;
        obj.insert("password".to_string(), json!(enc));
    }
    Ok(Value::Object(obj))
}

fn decrypt_connection(c: &Value) -> Result<Value, LofError> {
    let mut obj = c.as_object().cloned().unwrap_or_default();
    if let Some(pw) = obj
        .get("password")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let dec = dpapi_decrypt(pw)?;
        obj.insert("password".to_string(), json!(dec));
    }
    Ok(Value::Object(obj))
}

fn history_policy_from_settings(settings: &Value) -> HistoryPolicy {
    let prefs = settings.get("preferences");
    let min_minutes = prefs
        .and_then(|p| p.get("historyMinMinutes"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let min_chars = prefs
        .and_then(|p| p.get("historyMinChars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(200) as usize;
    HistoryPolicy {
        min_minutes,
        min_chars,
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

fn schedule_index_refresh(store: &Arc<Mutex<Option<Store>>>, seq: &Arc<AtomicU64>) {
    let my_seq = seq.fetch_add(1, Ordering::SeqCst) + 1;
    let seq_clone = Arc::clone(seq);
    let store_clone = Arc::clone(store);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1000));
        if seq_clone.load(Ordering::SeqCst) == my_seq {
            if let Ok(mut guard) = store_clone.lock() {
                if let Some(ref mut st) = *guard {
                    let _ = st.refresh_index(false);
                }
            }
        }
    });
}

fn setup_vault_watcher(
    root: &Path,
    app: &AppHandle,
    store: &Arc<Mutex<Option<Store>>>,
    notify_seq: &Arc<AtomicU64>,
    refresh_seq: &Arc<AtomicU64>,
) -> Option<RecommendedWatcher> {
    let root_buf = root.to_path_buf();
    let app_clone = app.clone();
    let store_clone = Arc::clone(store);
    let n_seq = Arc::clone(notify_seq);
    let r_seq = Arc::clone(refresh_seq);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };
            if event.kind.is_access() {
                return;
            }
            let mut relevant = false;
            for path in &event.paths {
                let rel = path
                    .strip_prefix(&root_buf)
                    .unwrap_or(path.as_path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let low = rel.to_ascii_lowercase();
                if rel.starts_with(".lof")
                    || low.ends_with(".tmp")
                    || low.ends_with(".lofmv")
                    || low.ends_with(".lofnew")
                {
                    continue;
                }
                if let Ok(mut guard) = store_clone.lock() {
                    if let Some(ref mut st) = *guard {
                        st.invalidate_path(&rel);
                    }
                }
                relevant = true;
            }
            if relevant {
                schedule_notify(&app_clone, &n_seq);
                schedule_index_refresh(&store_clone, &r_seq);
            }
        },
        NotifyConfig::default(),
    )
    .ok()?;

    let _ = watcher.watch(root, RecursiveMode::Recursive);
    Some(watcher)
}

fn setup_common_watcher(
    store_root: &Path,
    common_root: &Path,
    app: &AppHandle,
    notify_seq: &Arc<AtomicU64>,
) -> Option<RecommendedWatcher> {
    if common_root.starts_with(store_root) {
        return None;
    }
    let _ = fs::create_dir_all(common_root);
    let app_clone = app.clone();
    let n_seq = Arc::clone(notify_seq);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };
            if event.kind.is_access() {
                return;
            }
            let relevant = event.paths.iter().any(|p| {
                let s = p.to_string_lossy().to_ascii_lowercase();
                !s.ends_with(".tmp") && !s.ends_with(".lofmv")
            });
            if relevant {
                schedule_notify(&app_clone, &n_seq);
            }
        },
        NotifyConfig::default(),
    )
    .ok()?;

    let _ = watcher.watch(common_root, RecursiveMode::Recursive);
    Some(watcher)
}

fn bind_vault(state: &AppState, app: &AppHandle, root: &Path) -> Result<(), LofError> {
    {
        let mut vw = state.vault_watcher.lock().unwrap();
        *vw = None;
    }
    let (policy, manual_lb) = {
        let s = state.settings.lock().unwrap();
        (
            history_policy_from_settings(&s),
            default_manual_line_break_from_settings(&s),
        )
    };
    let new_store = Store::new(root, policy, manual_lb)?;
    let clean_root = new_store.root.clone();
    {
        let mut st_guard = state.store.lock().unwrap();
        *st_guard = Some(new_store);
    }
    let common_root = {
        let mut s_guard = state.settings.lock().unwrap();
        if let Some(obj) = s_guard.as_object_mut() {
            obj.insert(
                "vaultPath".to_string(),
                json!(clean_root.to_string_lossy().to_string()),
            );
        }
        persist_settings(&state.config_file, &s_guard)?;
        common_memo_root_of(&clean_root, &s_guard)
    };
    {
        let mut vw = state.vault_watcher.lock().unwrap();
        *vw = setup_vault_watcher(
            &clean_root,
            app,
            &state.store,
            &state.notify_seq,
            &state.refresh_seq,
        );
    }
    {
        let mut cw = state.common_watcher.lock().unwrap();
        *cw = setup_common_watcher(&clean_root, &common_root, app, &state.notify_seq);
    }
    schedule_notify(app, &state.notify_seq);
    schedule_index_refresh(&state.store, &state.refresh_seq);
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
    let mut cb = arboard::Clipboard::new().map_err(|e| fail_invalid(e.to_string()))?;
    cb.set_text(text.to_string())
        .map_err(|e| fail_invalid(e.to_string()))
}

fn handle_method(
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

    match method {
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
            out.insert("preferences".to_string(), prefs);
            out.insert(
                "version".to_string(),
                json!(app.package_info().version.to_string()),
            );
            Ok(Value::Object(out))
        }
        "chooseVault" => {
            let picked = FileDialog::new().set_title("서재 폴더 선택").pick_folder();
            let Some(folder) = picked else {
                return Ok(json!(false));
            };
            bind_vault(state, app, &folder)?;
            Ok(json!(true))
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
            let bytes = fs::read(&file)?;
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
            let picked = FileDialog::new()
                .set_title("공용 메모 폴더 선택")
                .set_directory(&current_common)
                .pick_folder();
            let Some(folder) = picked else {
                return Ok(Value::Null);
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
            {
                let mut cw = state.common_watcher.lock().unwrap();
                *cw = setup_common_watcher(&store_root, &new_common, app, &state.notify_seq);
            }
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
        "historyRead" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let mut guard = state.store.lock().unwrap();
            let st = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("Store not initialized"))?;
            st.history_read(id, name)
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
            let picked = FileDialog::new()
                .set_title("원고 가져오기 (원본 파일 보존)")
                .add_filter("원고", &["md", "txt", "mvle"])
                .pick_files();
            let Some(files) = picked else {
                return Ok(Value::Null);
            };
            let file_strs: Vec<String> = files
                .into_iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let res = {
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                import_files(st, &file_strs, project_id)?
            };
            schedule_notify(app, &state.notify_seq);
            Ok(res)
        }
        "copyManuscript" => {
            if let Some(custom_text) = args.get("text").and_then(|v| v.as_str()) {
                set_clipboard_text(custom_text)?;
                return Ok(json!(true));
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
            set_clipboard_text(&plain_text(&body))?;
            Ok(json!(true))
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
                let m = st.markdown(id)?;
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
            let (store_root, common_root) = get_store_and_common()?;
            let s_guard = state.settings.lock().unwrap();
            let conns: Vec<Value> = s_guard
                .get("connections")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().map(safe_connection).collect())
                .unwrap_or_default();
            let prefs = s_guard
                .get("preferences")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Ok(json!({
                "connections": conns,
                "vaultPath": store_root.to_string_lossy().to_string(),
                "commonMemoPath": common_root.to_string_lossy().to_string(),
                "apiPort": state.api.port,
                "preferences": prefs,
                "syncing": state.syncing.load(Ordering::SeqCst),
            }))
        }
        "saveConnection" => {
            let ctype = args.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(ctype, "folder" | "ftp" | "webdav") {
                return Err(fail_invalid("지원하지 않는 연결"));
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

            if ctype == "folder" {
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
            Ok(json!(true))
        }
        "sync" => {
            if state
                .syncing
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err(fail_invalid("이미 동기화 중입니다."));
            }
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let sync_res = (|| -> Result<Value, LofError> {
                let (conn, device_id) = {
                    let s_guard = state.settings.lock().unwrap();
                    let found = s_guard
                        .get("connections")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| {
                            arr.iter()
                                .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
                        })
                        .cloned()
                        .ok_or_else(|| fail_invalid("연결을 찾을 수 없습니다."))?;
                    let dev = s_guard
                        .get("deviceId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    (decrypt_connection(&found)?, dev)
                };
                let mut guard = state.store.lock().unwrap();
                let st = guard
                    .as_mut()
                    .ok_or_else(|| fail_invalid("Store not initialized"))?;
                sync_once(st, &conn, &device_id)
            })();
            state.syncing.store(false, Ordering::SeqCst);
            schedule_notify(app, &state.notify_seq);
            sync_res
        }
        "setPreferences" => {
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
                if let Some(obj) = s_guard.as_object_mut() {
                    obj.insert("preferences".to_string(), prefs_val.clone());
                }
                persist_settings(&state.config_file, &s_guard)?;
                let policy = history_policy_from_settings(&s_guard);
                let manual_lb = default_manual_line_break_from_settings(&s_guard);
                if let Ok(mut st_guard) = state.store.lock() {
                    if let Some(ref mut st) = *st_guard {
                        st.history_policy = policy;
                        st.default_manual_line_break = manual_lb;
                    }
                }
                prefs_val
            };
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
    match handle_method(&method, args_val, &state, &app, &window) {
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
        thread::spawn(move || {
            MessageDialog::new()
                .set_level(MessageLevel::Warning)
                .set_title("Lof Writer")
                .set_description(
                    "저장하지 못한 원고가 있습니다.\n\n편집 화면에서 충돌을 해결한 뒤 다시 닫아 주세요. 임시 원고는 로컬에 보관됩니다.",
                )
                .set_buttons(MessageButtons::Ok)
                .show();
        });
        return;
    }
    state.closing.store(true, Ordering::SeqCst);
    let _ = window.close();
}

/// 집중 모드의 작은 창 허용 여부에 맞춰 창 최소 크기를 적용한다.
/// 최소 크기를 바꾸면 창 크기를 다시 지정하게 되어 최대화·전체 화면이 풀리므로,
/// 그 상태에서는 적용을 미뤘다가 창이 일반 상태로 돌아왔을 때(Resized) 적용한다.
fn apply_window_min_size(window: &WebviewWindow, state: &AppState) {
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

#[tauri::command]
fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn updater_status(app: AppHandle) -> Value {
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
    json!({ "supported": cfg!(target_os = "windows"), "configured": has_key && has_endpoint })
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) -> bool {
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max {
        let _ = window.unmaximize();
        false
    } else {
        let _ = window.maximize();
        true
    }
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn window_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn window_start_dragging(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[cfg(windows)]
fn acquire_single_instance_lock(user_dir: &Path) -> bool {
    use crate::error::hash_str;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    let dir_hash = &hash_str(&user_dir.to_string_lossy().to_lowercase())[..16];
    let mutex_name: Vec<u16> = format!("Local\\LofWriterSingleInstance_{}\0", dir_hash)
        .encode_utf16()
        .collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
        if !handle.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
            let title: Vec<u16> = "Lof Writer\0".encode_utf16().collect();
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                } else {
                    ShowWindow(hwnd, SW_SHOW);
                }
                SetForegroundWindow(hwnd);
            }
            return false;
        }
    }
    true
}

#[cfg(not(windows))]
fn acquire_single_instance_lock(_user_dir: &Path) -> bool {
    true
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
    if !acquire_single_instance_lock(&user_dir) {
        return;
    }

    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let app_id: Vec<u16> = "local.lof.writer\0".encode_utf16().collect();
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }

    if let Err(e) = fs::create_dir_all(&user_dir) {
        MessageDialog::new()
            .set_level(MessageLevel::Error)
            .set_title("Lof Writer 시작 실패")
            .set_description(e.to_string())
            .show();
        return;
    }

    let config_file = user_dir.join("settings.json");
    let mut settings: Value = match fs::read_to_string(&config_file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => {
            MessageDialog::new()
                .set_level(MessageLevel::Error)
                .set_title("Lof Writer 시작 실패")
                .set_description(e.to_string())
                .show();
            return;
        }
    };
    if !settings.is_object() {
        settings = json!({});
    }
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
                        .is_some_and(|t| matches!(t, "folder" | "ftp" | "webdav"))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    settings["connections"] = Value::Array(valid_conns);

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

    let initial_store = match Store::new(
        &vault_root,
        history_policy_from_settings(&settings),
        default_manual_line_break_from_settings(&settings),
    ) {
        Ok(st) => st,
        Err(e) => {
            MessageDialog::new()
                .set_level(MessageLevel::Error)
                .set_title("Lof Writer 시작 실패")
                .set_description(e.message)
                .show();
            return;
        }
    };

    let clean_vault_root = initial_store.root.clone();
    settings["vaultPath"] = json!(clean_vault_root.to_string_lossy().to_string());
    let _ = persist_settings(&config_file, &settings);

    let store_arc = Arc::new(Mutex::new(Some(initial_store)));
    let settings_arc = Arc::new(Mutex::new(settings));
    let notify_seq = Arc::new(AtomicU64::new(0));
    let refresh_seq = Arc::new(AtomicU64::new(0));
    let closing = Arc::new(AtomicBool::new(false));
    let close_pending = Arc::new(AtomicBool::new(false));
    let close_seq = Arc::new(AtomicU64::new(0));

    let app_handle_holder: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));
    let holder_for_api = Arc::clone(&app_handle_holder);
    let notify_seq_for_api = Arc::clone(&notify_seq);

    let api_server = match start_api(
        Arc::clone(&store_arc),
        Arc::new(move || {
            if let Ok(guard) = holder_for_api.lock() {
                if let Some(ref app) = *guard {
                    schedule_notify(app, &notify_seq_for_api);
                }
            }
        }),
    ) {
        Ok(srv) => srv,
        Err(e) => {
            MessageDialog::new()
                .set_level(MessageLevel::Error)
                .set_title("Lof Writer 시작 실패")
                .set_description(e.message)
                .show();
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
        vault_watcher: Mutex::new(None),
        common_watcher: Mutex::new(None),
        syncing: Arc::new(AtomicBool::new(false)),
        title_bar_dimmed: AtomicBool::new(false),
        compact_window: AtomicBool::new(false),
        compact_applied: AtomicBool::new(false),
        closing: Arc::clone(&closing),
        close_pending: Arc::clone(&close_pending),
        close_seq: Arc::clone(&close_seq),
        notify_seq: Arc::clone(&notify_seq),
        refresh_seq: Arc::clone(&refresh_seq),
    };

    let user_dir_for_exit = user_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            lof_invoke,
            lof_flushed,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            window_start_dragging,
            updater_status,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            {
                let mut h_guard = app_handle_holder.lock().unwrap();
                *h_guard = Some(handle.clone());
            }
            let st: State<AppState> = app.state();
            let (common_root, bg_color) = {
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
                (common_memo_root_of(&clean_vault_root, &s_guard), color)
            };
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(img) = image::load_from_memory(include_bytes!("../icons/icon.png")) {
                    let rgba = img.to_rgba8();
                    let (w, h) = rgba.dimensions();
                    let _ = win.set_icon(tauri::image::Image::new_owned(rgba.into_raw(), w, h));
                } else if let Some(default_icon) = app.default_window_icon().cloned() {
                    let _ = win.set_icon(default_icon);
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
                let _ = win.show();
                let _ = win.set_focus();
            }
            {
                let mut vw = st.vault_watcher.lock().unwrap();
                *vw = setup_vault_watcher(
                    &clean_vault_root,
                    &handle,
                    &st.store,
                    &st.notify_seq,
                    &st.refresh_seq,
                );
            }
            {
                let mut cw = st.common_watcher.lock().unwrap();
                *cw = setup_common_watcher(&clean_vault_root, &common_root, &handle, &st.notify_seq);
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
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
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = fs::remove_file(user_dir_for_exit.join("runtime.json"));
            }
        });
}
