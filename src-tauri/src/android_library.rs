//! 앱 내부 저장소 서재 경로 계산과 Android 시작 시 서재 준비를 담당한다.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use crate::error::LofError;
use crate::store::strip_verbatim_prefix;
use crate::{bind_vault, AppState};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

const DEFAULT_NAME: &str = "Lof Library";

// 화면이 다시 열리며 준비 요청이 겹쳐도 서재를 한 번만 열도록 순서대로 처리한다.
static PREPARE: Mutex<()> = Mutex::new(());

/// 앱 내부 저장소의 기본 서재 경로를 돌려준다.
pub fn internal_library_root(user_dir: &Path) -> PathBuf {
    let base = strip_verbatim_prefix(
        &fs::canonicalize(user_dir).unwrap_or_else(|_| user_dir.to_path_buf()),
    );
    base.join(DEFAULT_NAME)
}

/// 앱 전용 저장소(user_dir 또는 Android /data 아래)의 경로인지 확인한다.
pub fn is_internal(user_dir: &Path, path: &Path) -> bool {
    if path.starts_with(user_dir) {
        return true;
    }
    let clean_user = strip_verbatim_prefix(
        &fs::canonicalize(user_dir).unwrap_or_else(|_| user_dir.to_path_buf()),
    );
    let clean_path = strip_verbatim_prefix(
        &fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
    );
    if clean_path.starts_with(&clean_user) {
        return true;
    }
    #[cfg(target_os = "android")]
    if path.starts_with("/data") || clean_path.starts_with("/data") {
        return true;
    }
    false
}

/// Android에서 설정된 서재(기본값: 앱 내부 저장소)를 연다.
pub fn prepare(state: &AppState, app: &AppHandle, args: &Value) -> Result<Value, LofError> {
    let _guard = PREPARE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let default_root = internal_library_root(&state.user_dir);
    if args.get("internal").and_then(Value::as_bool) == Some(true) {
        open_library(state, app, &default_root)?;
        return Ok(json!({ "ready": true, "moved": [], "notice": Value::Null }));
    }
    let opened = state.store.lock().unwrap().as_ref().map(|store| store.root.clone());
    if opened.is_some() {
        return Ok(json!({ "ready": true, "moved": [], "notice": Value::Null }));
    }
    let configured = {
        let settings = state.settings.lock().unwrap();
        setting_path(settings.get("vaultPath"))
    };
    let target = configured.unwrap_or_else(|| default_root.clone());
    if is_internal(&state.user_dir, &target) {
        open_library(state, app, &target)?;
        return Ok(json!({ "ready": true, "moved": [], "notice": Value::Null }));
    }
    if args.get("onlyIfInternal").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "ready": false, "moved": [], "notice": Value::Null }));
    }

    let mut notice = Value::Null;
    if open_library(state, app, &target).is_err() {
        notice = json!(format!(
            "서재 폴더 {}을(를) 열 수 없어 앱 내부 기본 서재를 열었습니다.",
            target.to_string_lossy()
        ));
        open_library(state, app, &default_root)?;
    }

    Ok(json!({
        "ready": true,
        "moved": [],
        "notice": notice,
    }))
}

fn open_library(state: &AppState, app: &AppHandle, root: &Path) -> Result<(), LofError> {
    fs::create_dir_all(root)?;
    bind_vault(state, app, root)
}

fn setting_path(value: Option<&Value>) -> Option<PathBuf> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}
