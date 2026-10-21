//! Android 서재는 기기 저장공간의 폴더에만 둔다.
//! 예전 버전이 앱 내부에 만든 서재와 공용 메모 폴더는 처음 열 때 기기의 Documents 폴더로 옮긴다.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use crate::error::{fail_invalid, LofError};
use crate::{bind_vault, get_documents_dir, persist_settings, AppState};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

const DEFAULT_NAME: &str = "Lof Library";

// 화면이 다시 열리며 준비 요청이 겹쳐도 서재를 한 번만 열도록 순서대로 처리한다.
static PREPARE: Mutex<()> = Mutex::new(());

/// 앱 전용 저장공간(/data 아래)의 경로인지 확인한다.
pub fn is_internal(path: &Path) -> bool {
    path.starts_with("/data")
}

/// 모든 파일 접근 권한을 받은 뒤 서재를 연다. 앱 내부 서재가 남아 있으면 기기 폴더로 옮긴 다음 연다.
pub fn prepare(state: &AppState, app: &AppHandle) -> Result<Value, LofError> {
    let _guard = PREPARE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let opened = state.store.lock().unwrap().as_ref().map(|store| store.root.clone());
    if opened.as_deref().is_some_and(|root| !is_internal(root)) {
        return Ok(json!({ "moved": [], "notice": Value::Null }));
    }
    let (configured, common) = {
        let settings = state.settings.lock().unwrap();
        (
            setting_path(settings.get("vaultPath")),
            setting_path(settings.get("preferences").and_then(|p| p.get("commonMemoPath"))),
        )
    };
    let documents = get_documents_dir();
    fs::create_dir_all(&documents)
        .map_err(|_| fail_invalid("기기의 Documents 폴더를 만들 수 없습니다. 모든 파일 접근 권한을 확인해 주세요."))?;
    let default_root = documents.join(DEFAULT_NAME);

    // 옮긴 원본은 새 서재를 연 다음에 지운다. 도중에 실패해도 원본이 남는다.
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut target = match &configured {
        Some(path) if !is_internal(path) => path.clone(),
        Some(path) if has_content(path) => {
            let dest = copy_folder(path, &documents, DEFAULT_NAME)?;
            moved.push((path.clone(), dest.clone()));
            dest
        }
        _ => default_root.clone(),
    };

    let mut notice = Value::Null;
    if let Err(error) = open_library(state, app, &target) {
        if target == default_root {
            return Err(error);
        }
        notice = json!(format!(
            "서재 폴더 {}을(를) 열 수 없어 기본 서재를 열었습니다.",
            target.to_string_lossy()
        ));
        target = default_root.clone();
        open_library(state, app, &target)?;
    }

    // 현재 쓰지 않는 다른 앱 내부 서재도 옮긴다. 옮기지 못한 서재는 다음 실행 때 다시 시도한다.
    for source in internal_libraries(&state.user_dir) {
        if configured.as_deref().is_some_and(|path| same_path(path, &source)) || !has_content(&source) {
            continue;
        }
        let name = source.file_name().and_then(|n| n.to_str()).unwrap_or(DEFAULT_NAME).to_string();
        match copy_folder(&source, &documents, &name) {
            Ok(dest) => moved.push((source, dest)),
            Err(error) => eprintln!("{}", error.message),
        }
    }

    // 앱 내부의 공용 메모 폴더는 기기 폴더로 옮기고, 비어 있으면 서재 안의 기본 공용 메모를 쓴다.
    // 옮기지 못하면 설정을 그대로 두고 다음 실행 때 다시 시도한다.
    if let Some(common) = common.filter(|path| is_internal(path)) {
        let next = if has_content(&common) {
            let name = common.file_name().and_then(|n| n.to_str()).unwrap_or("CommonMemo").to_string();
            match copy_folder(&common, &documents, &name) {
                Ok(dest) => {
                    moved.push((common, dest.clone()));
                    Some(Some(dest))
                }
                Err(error) => {
                    eprintln!("{}", error.message);
                    None
                }
            }
        } else {
            Some(None)
        };
        if let Some(next) = next {
            let mut settings = state.settings.lock().unwrap();
            if let Some(prefs) = settings.get_mut("preferences").and_then(Value::as_object_mut) {
                match &next {
                    Some(dest) => prefs.insert("commonMemoPath".into(), json!(dest.to_string_lossy().to_string())),
                    None => prefs.remove("commonMemoPath"),
                };
            }
            persist_settings(&state.config_file, &settings)?;
        }
    }

    for (source, _) in &moved {
        let _ = fs::remove_dir_all(source);
    }
    Ok(json!({
        "moved": moved
            .iter()
            .map(|(_, dest)| dest.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
        "notice": notice,
    }))
}

fn open_library(state: &AppState, app: &AppHandle, root: &Path) -> Result<(), LofError> {
    fs::create_dir_all(root)?;
    bind_vault(state, app, root)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

fn setting_path(value: Option<&Value>) -> Option<PathBuf> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 숨김 항목(.lof 등)만 있는 폴더는 옮길 원고가 없는 것으로 본다.
fn has_content(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
    })
}

/// 예전 버전이 서재를 만들던 앱 내부 위치에서 서재 폴더(.lof가 있는 폴더)를 찾는다.
fn internal_libraries(user_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for parent in [user_dir.to_path_buf(), user_dir.join("Documents")] {
        let Ok(entries) = fs::read_dir(&parent) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.join(".lof").is_dir() {
                found.push(path);
            }
        }
    }
    found
}

/// 원본을 임시 폴더에 복사한 다음 겹치지 않는 이름으로 바꾼다.
fn copy_folder(source: &Path, parent: &Path, name: &str) -> Result<PathBuf, LofError> {
    let dest = available_path(parent, name)?;
    let leaf = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let temp = parent.join(format!(".{leaf}.moving"));
    if temp.exists() {
        fs::remove_dir_all(&temp)?;
    }
    if let Err(error) = copy_tree(source, &temp) {
        let _ = fs::remove_dir_all(&temp);
        return Err(fail_invalid(format!(
            "앱 내부 서재를 기기 폴더로 옮기지 못했습니다: {}",
            error
        )));
    }
    fs::rename(&temp, &dest)?;
    Ok(dest)
}

fn available_path(parent: &Path, name: &str) -> Result<PathBuf, LofError> {
    for index in 1..1000 {
        let candidate = if index == 1 {
            parent.join(name)
        } else {
            parent.join(format!("{name} {index}"))
        };
        if !candidate.exists() {
            return Ok(candidate);
        }
        if candidate.is_dir() && fs::read_dir(&candidate)?.next().is_none() {
            fs::remove_dir(&candidate)?;
            return Ok(candidate);
        }
    }
    Err(fail_invalid("서재를 옮길 폴더 이름을 정하지 못했습니다."))
}

fn copy_tree(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
