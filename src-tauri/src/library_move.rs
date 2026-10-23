use crate::error::{fail, fail_invalid, LofError};
use crate::store::{strip_verbatim_prefix, Store};
use crate::{persist_settings, schedule_notify, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use uuid::Uuid;

type Inventory = BTreeMap<PathBuf, Option<[u8; 32]>>;

fn database_file(relative: &Path) -> bool {
    relative.parent() == Some(Path::new(".lof"))
        && matches!(
            relative.file_name().and_then(|s| s.to_str()),
            Some(
                "library.sqlite"
                    | "library.sqlite-wal"
                    | "library.sqlite-shm"
                    | "library.sqlite.lock"
            )
        )
}

fn digest(path: &Path) -> Result<[u8; 32], LofError> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().into())
}

fn inventory(root: &Path, relative: &Path, out: &mut Inventory) -> Result<(), LofError> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let relative = relative.join(entry.file_name());
        let kind = entry.file_type()?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            entry.metadata()?.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = kind.is_symlink();
        if linked || (!kind.is_file() && !kind.is_dir()) {
            return Err(fail_invalid(format!(
                "연결된 폴더나 특수 파일은 이동할 수 없습니다: {}",
                relative.display()
            )));
        }
        if database_file(&relative) {
            continue;
        }
        if kind.is_dir() {
            out.insert(relative.clone(), None);
            inventory(root, &relative, out)?;
        } else {
            out.insert(relative, Some(digest(&entry.path())?));
        }
    }
    Ok(())
}

fn snapshot(root: &Path) -> Result<Inventory, LofError> {
    let mut out = Inventory::new();
    inventory(root, Path::new(""), &mut out)?;
    Ok(out)
}

fn copy_files(source: &Path, target: &Path, files: &Inventory) -> Result<(), LofError> {
    for (relative, hash) in files {
        let from = source.join(relative);
        let to = target.join(relative);
        if hash.is_none() {
            fs::create_dir_all(&to)?;
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&from, &to)?;
            if let Ok(modified) = fs::metadata(&from)?.modified() {
                if let Ok(file) = fs::OpenOptions::new().write(true).open(&to) {
                    let _ = file.set_times(fs::FileTimes::new().set_modified(modified));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn remap_path(value: &mut Value, source: &Path, target: &Path) {
    let Some(path) = value.as_str().map(PathBuf::from) else {
        return;
    };
    if let Ok(relative) = path.strip_prefix(source) {
        *value = json!(target.join(relative).to_string_lossy());
    }
}

fn remap_settings(settings: &mut Value, source: &Path, target: &Path) {
    settings["vaultPath"] = json!(target.to_string_lossy());
    if let Some(common) = settings
        .get_mut("preferences")
        .and_then(|p| p.get_mut("commonMemoPath"))
    {
        remap_path(common, source, target);
    }
    if let Some(groups) = settings
        .get_mut("realtimeGroups")
        .and_then(Value::as_array_mut)
    {
        // 비어 있는 대상 폴더에 예전 연결 설정이 남아 있어도 현재 서재의 그룹을 사용한다.
        groups.retain(|group| group["root"].as_str() != Some(target.to_string_lossy().as_ref()));
        for group in groups {
            if group["root"].as_str() == Some(source.to_string_lossy().as_ref()) {
                group["root"] = json!(target.to_string_lossy());
            }
        }
    }
    if let Some(connections) = settings
        .get_mut("connections")
        .and_then(Value::as_array_mut)
    {
        for connection in connections {
            if let Some(folder) = connection.get_mut("folder") {
                remap_path(folder, source, target);
            }
        }
    }
}

fn document_ids(store: &mut Store) -> Result<Vec<String>, LofError> {
    let list = store.list()?;
    let mut ids: Vec<_> = list["documents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|doc| doc["id"].as_str().map(str::to_string))
        .collect();
    ids.sort();
    Ok(ids)
}

// 복사 이후 외부에서 바뀌거나 새로 생긴 파일은 원래 위치에 남긴다.
fn remove_original(source: &Path, files: &Inventory) -> bool {
    for (relative, hash) in files {
        if let Some(hash) = hash {
            let path = source.join(relative);
            if digest(&path).ok().as_ref() == Some(hash) {
                let _ = fs::remove_file(path);
            }
        }
    }
    for name in [
        "library.sqlite",
        "library.sqlite-wal",
        "library.sqlite-shm",
        "library.sqlite.lock",
    ] {
        let _ = fs::remove_file(source.join(".lof").join(name));
    }
    let mut dirs: Vec<_> = files
        .iter()
        .filter(|(_, hash)| hash.is_none())
        .map(|(path, _)| path)
        .collect();
    dirs.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for relative in dirs {
        let _ = fs::remove_dir(source.join(relative));
    }
    fs::remove_dir(source).is_err()
}

/// 앱 내부 저장소 서재 폴더를 이동 대상(빈 폴더)으로 준비한다.
/// 이전에 빈 서재로 한 번 열려 `.lof`만 생성된 경우에는 빈 `.lof`를 정리한다.
fn prepare_internal_target(raw_target: &Path, store: &Store) -> Result<PathBuf, LofError> {
    if raw_target.exists() {
        let mut has_lof = false;
        for entry in fs::read_dir(raw_target)? {
            let entry = entry?;
            if entry.file_name() == ".lof" {
                has_lof = true;
            } else {
                return Err(fail_invalid(
                    "앱 내부 저장소에 이미 서재 파일이 있어 이동할 수 없습니다. 기존 서재와 합칠 수 없습니다.",
                ));
            }
        }
        if has_lof {
            let lof_dir = raw_target.join(".lof");
            for subdir in ["drafts", "backups", "file-conflicts"] {
                if fs::read_dir(lof_dir.join(subdir)).is_ok_and(|mut d| d.next().is_some()) {
                    return Err(fail_invalid(
                        "앱 내부 저장소에 이미 서재 데이터가 있어 이동할 수 없습니다. 기존 서재와 합칠 수 없습니다.",
                    ));
                }
            }
            if lof_dir.join("library.sqlite").exists() {
                let mut existing = Store::new(
                    raw_target,
                    store.history_policy,
                    store.default_manual_line_break,
                )?;
                let list = existing.list()?;
                let has_projects = list["projects"].as_array().is_some_and(|a| !a.is_empty());
                let has_docs = list["documents"].as_array().is_some_and(|a| !a.is_empty());
                drop(existing);
                if has_projects || has_docs {
                    return Err(fail_invalid(
                        "앱 내부 저장소에 이미 작품이나 원고가 있어 이동할 수 없습니다. 기존 서재와 합칠 수 없습니다.",
                    ));
                }
            }
            fs::remove_dir_all(&lof_dir)?;
        }
    } else {
        fs::create_dir_all(raw_target)?;
    }
    Ok(strip_verbatim_prefix(&fs::canonicalize(raw_target)?))
}

pub fn move_library(state: &AppState, app: &AppHandle, args: &Value) -> Result<Value, LofError> {
    let to_internal = args["internal"].as_bool() == Some(true);
    let custom_path = if to_internal {
        None
    } else {
        let path = args["path"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| fail_invalid("이동할 서재 폴더를 선택해 주세요."))?;
        if !Path::new(path).is_absolute() {
            return Err(fail_invalid("절대 경로의 폴더를 선택해 주세요."));
        }
        Some(strip_verbatim_prefix(&fs::canonicalize(path)?))
    };

    let _sync = state.syncing.try_exclusive().ok_or_else(|| fail(
            "동기화가 끝난 뒤 서재 이동을 다시 시도해 주세요.",
            "SYNC_BUSY",
        ))?;
    let mut guard = state.store.lock().unwrap();
    let store = guard
        .as_mut()
        .ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
    let source = store.root.clone();
    if args["expectedRoot"].as_str() != Some(source.to_string_lossy().as_ref()) {
        return Err(fail(
            "현재 서재가 바뀌었습니다. 다시 시도해 주세요.",
            "VAULT_CHANGED",
        ));
    }

    let target = if to_internal {
        let raw_target = crate::android_library::internal_library_root(&state.user_dir);
        if source == raw_target || crate::android_library::is_internal(&state.user_dir, &source) && source == raw_target {
            return Err(fail_invalid("현재 서재가 이미 앱 내부 저장소에 있습니다."));
        }
        prepare_internal_target(&raw_target, store)?
    } else {
        custom_path.unwrap()
    };

    if !target.is_dir() {
        return Err(fail_invalid("이동할 위치가 폴더가 아닙니다."));
    }
    if source == target {
        return Err(fail_invalid("현재 서재와 다른 폴더를 선택해 주세요."));
    }
    if target.starts_with(&source) || source.starts_with(&target) {
        return Err(fail_invalid(
            "현재 서재의 상위 또는 하위 폴더로는 이동할 수 없습니다.",
        ));
    }
    if state.config_file.starts_with(&source)
        || state.user_dir.starts_with(&source)
        || state.config_file.starts_with(&target)
        || state.user_dir.starts_with(&target)
    {
        return Err(fail_invalid(
            "앱 설정 폴더를 포함한 서재는 이동할 수 없습니다.",
        ));
    }
    if fs::read_dir(&target)?.next().transpose()?.is_some() {
        return Err(fail_invalid(
            "파일이 없는 빈 폴더를 선택해 주세요. 기존 서재와 합칠 수 없습니다.",
        ));
    }
    store.require_database()?;
    store.poll_disk()?;
    if let Err(error) = store.git_tick(true, false) {
        eprintln!(
            "서재 이동 전 로컬 이력 기록을 미뤘습니다: {}",
            error.message
        );
    }
    let expected_ids = document_ids(store)?;
    let files = snapshot(&source)?;
    let parent = target
        .parent()
        .ok_or_else(|| fail_invalid("기기나 드라이브의 루트 폴더로는 이동할 수 없습니다."))?;
    let staging = parent.join(format!(".lof-moving-{}", Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let mut promoted = false;
    let result = (|| -> Result<Store, LofError> {
        copy_files(&source, &staging, &files)?;
        store
            .database()?
            .backup(&staging.join(".lof/library.sqlite"))?;
        if snapshot(&staging)? != files || snapshot(&source)? != files {
            return Err(fail_invalid("복사 중 서재 파일이 변경되었거나 복사를 확인하지 못했습니다. 원본 서재를 유지합니다."));
        }
        {
            let db = crate::database::LibraryDb::open(
                &staging,
                store.vault["id"].as_str().unwrap_or(""),
            )?;
            db.remap_library_paths(&source, &target)?;
        }
        // 비어 있을 때만 교체한다. 폴더 선택 뒤 다른 파일이 생겼다면 여기서 중단한다.
        fs::remove_dir(&target)?;
        if let Err(error) = fs::rename(&staging, &target) {
            let _ = fs::create_dir(&target);
            return Err(error.into());
        }
        promoted = true;
        let mut next_store = Store::new(
            &target,
            store.history_policy,
            store.default_manual_line_break,
        )?;
        if let Some(base) = state.config_file.parent() {
            next_store.set_recovery_directory(base);
        }
        next_store.require_database()?;
        if next_store.vault["id"] != store.vault["id"]
            || document_ids(&mut next_store)? != expected_ids
        {
            return Err(fail_invalid(
                "새 위치의 서재 내용을 확인하지 못했습니다. 원본 서재를 유지합니다.",
            ));
        }
        if snapshot(&source)? != files {
            return Err(fail_invalid(
                "이동 중 원본 서재가 변경되었습니다. 원본 서재를 유지합니다.",
            ));
        }
        Ok(next_store)
    })();
    let copy = if promoted { &target } else { &staging };
    let move_error = |error: LofError| {
        fail(
            format!(
                "{}\n원본 서재는 유지했습니다. 복사본 위치: {}",
                error.message,
                copy.display()
            ),
            error.code,
        )
    };
    // 실패한 복사본은 남겨 두며, 기존 서재와 설정에는 손대지 않는다.
    let next_store = result.map_err(move_error)?;
    {
        let mut settings = state.settings.lock().unwrap();
        let mut next = settings.clone();
        remap_settings(&mut next, &source, &target);
        persist_settings(&state.config_file, &next).map_err(move_error)?;
        *settings = next;
    }
    *guard = Some(next_store);
    // 이전 DB 연결을 닫은 뒤 원본을 정리한다. 새 서재는 정리가 실패해도 계속 사용할 수 있다.
    let source_retained = remove_original(&source, &files);
    drop(guard);
    schedule_notify(app, &state.notify_seq);
    Ok(
        json!({ "root": target.to_string_lossy(), "sourceRetained": source_retained, "source": source.to_string_lossy() }),
    )
}
