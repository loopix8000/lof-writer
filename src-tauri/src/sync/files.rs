//! 폴더·WebDAV·FTP의 서재 파일 원본을 마지막 동기화 해시와 비교해 양방향으로 반영한다.

use super::file_remote::{self, FileRemote, Info, ID_FILE};
use super::{latest, with_store, MAX_SYNC_BYTES};
use crate::error::{fail, fail_invalid, hash_bytes, valid_id, LofError};
use crate::store::{atomic_write_bytes, record_change, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use uuid::Uuid;
use lof_realtime::scope::DeferredPaths;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    remote_id: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    legacy_imported: bool,
    #[serde(default)]
    tags: BTreeMap<String, (String, String)>,
    #[serde(default)]
    identities: BTreeMap<String, String>,
}

struct Pair {
    local: Option<String>,
    remote: Option<String>,
    local_info: Option<Info>,
    remote_info: Option<Info>,
    local_id: Option<String>,
    remote_id: Option<String>,
}

fn identity(path: &str, bytes: &[u8]) -> Result<Option<String>, LofError> {
    if path.ends_with("/project.json") {
        let raw = std::str::from_utf8(bytes)
            .map_err(|_| fail_invalid("작품 메타 정보의 문자 인코딩 오류"))?;
        let project = crate::store::parse_project(raw)?;
        Ok(project["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .map(|id| format!("project:{id}")))
    } else if path.to_ascii_lowercase().ends_with(".md") {
        let raw = std::str::from_utf8(bytes)
            .map_err(|_| fail_invalid("Markdown 원고의 문자 인코딩 오류"))?;
        let parsed = crate::markdown::read_markdown(raw)?;
        Ok(parsed
            .properties
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .map(|id| format!("document:{id}")))
    } else {
        Ok(None)
    }
}

fn can_defer_file(error: &LofError) -> bool {
    matches!(error.code.as_str(), "ENOENT" | "EACCES" | "IO_ERROR" | "FILE_BUSY" | "FORMAT" | "INVALID" | "NOT_FOUND" | "CONFLICT" | "SYNC_RETRY" | "LOCAL_GIT")
}

// 목록 조회의 경고 문구로 전송 여부를 결정하지 않는다. 안전하지 않은 경로만 표시한다.
pub(crate) fn inventory(
    store: &Mutex<Option<Store>>, root: &Path,
) -> Result<BTreeMap<String, Info>, LofError> {
    // 서재 전체를 훑는 동안 잠금을 계속 쥐면 저장과 문서 열기가 기다린다.
    // 목록만 잠근 채 받고, 원고 확인은 문서마다 잠금을 잡았다 놓으며, 디스크 목록과 해시는 잠금 밖에서 계산한다.
    // 이후 전송 단계가 잠금 안에서 해시를 다시 확인하므로 그 사이에 바뀐 파일은 다음 주기에 다시 맞춘다.
    let is_internal = crate::android_library::is_internal_root(root);
    let disk = if is_internal {
        None
    } else {
        Some(crate::store::disk_inventory(root)?)
    };
    let (deferred_paths, documents) = with_store(store, root, |st| {
        st.require_database()?;
        if let Some(disk) = disk {
            st.poll_disk_with(disk)?;
        } else if st.has_pending_disk_changes()? || st.has_busy_files() {
            st.poll_disk()?;
        } else {
            if let Some(db) = &st.index.database {
                crate::project_order::load(&st.root, db)?;
            }
            st.refresh_index(false)?;
        }
        let deferred = st.sync_deferred_paths()?;
        let list = st.list()?;
        let documents: HashMap<String, String> = list["documents"].as_array().into_iter().flatten()
            .filter_map(|document| {
                let (id, path) = (document["id"].as_str()?, document["path"].as_str()?);
                let relative = Path::new(path).strip_prefix(root).ok()?;
                Some((relative.to_string_lossy().replace('\\', "/"), id.to_string()))
            })
            .collect();
        Ok((deferred, documents))
    })?;
    let mut files = file_remote::local_inventory(root)?;
    let mut deferred = DeferredPaths::default();
    for path in deferred_paths {
        deferred.insert(&path);
        files.insert(path, Info::unavailable());
    }
    let index = lof_realtime::file_index::Index::open(root).map_err(|e| fail(e, "DATABASE"))?;
    for (path, info) in &mut files {
        if info.unavailable || deferred.contains(path) { continue; }
        let mut changed = false;
        let checked = index.inspect(root, path, |bytes| {
            changed = true;
            original(path, bytes).map_err(|e| e.message)?;
            let header = if path.to_ascii_lowercase().ends_with(".md") {
                Value::Object(crate::markdown::read_markdown(std::str::from_utf8(bytes).map_err(|e| e.to_string())?)
                    .map_err(|e| e.message)?.properties)
            } else if path.ends_with("/project.json") {
                serde_json::from_slice(bytes).map_err(|e| e.to_string())?
            } else { Value::Null };
            Ok((identity(path, bytes).map_err(|e| e.message)?, header))
        }).map_err(|e| fail(e, "SYNC_RETRY"));
        let checked = checked.and_then(|entry| {
            // 변경된 원고만 관찰 DB에 반영한다. 전송 직전에는 실제 바이트를 다시 확인한다.
            if changed {
                if let Some(id) = documents.get(path) {
                    with_store(store, root, |st| st.read(id).map(|_| ()))?;
                }
            }
            Ok(entry)
        });
        match checked {
            Ok(entry) => {
                info.size = entry.size;
                info.modified = entry.modified;
                info.etag = Some(entry.index.version.clone());
                info.index = Some(entry.index);
            },
            Err(error) if can_defer_file(&error) => {
                index.invalidate(path).map_err(|e| fail(e, "DATABASE"))?;
                info.unavailable = true;
                deferred.insert(path);
            }
            Err(error) => return Err(error),
        }
    }
    index.retain(files.keys()).map_err(|e| fail(e, "DATABASE"))?;
    Ok(files)
}

// 이름 변경과 동시 편집이 겹쳐도 같은 ID의 문서를 두 경로에 만들지 않는다.
fn rename_losers(
    pairs: &BTreeMap<String, Pair>,
    base: &BTreeMap<String, String>,
    deferred: &mut DeferredPaths,
) -> HashSet<String> {
    let mut identities: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let (mut local, mut remote) = (HashSet::new(), HashSet::new());
    let mut duplicates = HashSet::new();
    for (path, pair) in pairs {
        for (id, seen) in [
            (pair.local_id.as_deref(), &mut local),
            (pair.remote_id.as_deref(), &mut remote),
        ] {
            if let Some(id) = id {
                if !seen.insert(id) {
                    duplicates.insert(id);
                }
                identities.entry(id).or_default().insert(path);
            }
        }
    }
    for (id, paths) in &identities {
        if duplicates.contains(id) {
            for path in paths { deferred.insert(path); }
        }
    }
    let mut losers = HashSet::new();
    for paths in identities.values().filter(|paths| paths.len() > 1) {
        if paths.iter().any(|path| deferred.contains(path)) { continue; }
        let new_paths: Vec<&str> = paths
            .iter()
            .copied()
            .filter(|path| !base.contains_key(*path))
            .collect();
        let winner = if new_paths.len() == 1 {
            new_paths[0]
        } else {
            *paths.last().unwrap()
        };
        for path in paths {
            if *path != winner {
                losers.insert((*path).to_string());
            }
        }
    }
    losers
}

fn retry() -> LofError {
    fail(
        "동기화 중 파일이 변경되었습니다. 다음 주기에 다시 확인합니다.",
        "SYNC_RETRY",
    )
}

fn sync_project_order(
    store: &Mutex<Option<Store>>,
    root: &Path,
    remote: &mut dyn FileRemote,
    pair: &Pair,
    total: &mut Value,
) -> Result<Option<String>, LofError> {
    let path = crate::project_order::FILE;
    let local = with_store(store, root, |_| read_local(root, path))?;
    let other = if pair.remote.is_some() {
        Some(remote.read(path)?)
    } else {
        None
    };
    if local.as_deref().map(hash_bytes) != pair.local
        || other.as_deref().map(hash_bytes) != pair.remote
    {
        return Err(retry());
    }
    let Some(merged) = crate::project_order::merge_bytes(local.as_deref(), other.as_deref()) else {
        // 알 수 없는 형식은 기존 파일 동기화 방식으로 전달한다.
        return Ok(None);
    };
    let hash = hash_bytes(&merged);
    if pair.local.as_deref() != Some(&hash) {
        apply_local(store, root, path, Some(&merged), pair.local.as_deref(), None)?;
        add(total, "downloaded", 1);
    }
    if pair.remote.as_deref() != Some(&hash) {
        with_store(store, root, |st| st.require_database())?;
        remote.write(path, &merged, pair.remote_info.as_ref())?;
        add(total, "uploaded", 1);
        add(total, "uploadedBytes", merged.len());
    }
    Ok(Some(hash))
}

fn add(total: &mut Value, key: &str, count: usize) {
    total[key] = json!(total[key].as_u64().unwrap_or(0) + count as u64);
}

pub(crate) fn read_local(root: &Path, path: &str) -> Result<Option<Vec<u8>>, LofError> {
    let target = file_remote::safe_path(root, path)?;
    let file = match fs::File::open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SYNC_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SYNC_BYTES {
        return Err(fail_invalid("동기화 파일이 50MB를 초과합니다."));
    }
    Ok(Some(bytes))
}

pub(crate) fn read_for_sync(store: &Mutex<Option<Store>>, root: &Path, path: &str) -> Result<Option<Vec<u8>>, LofError> {
    with_store(store, root, |st| {
        st.ensure_sync_ready(path)?;
        read_local(root, path)
    })
}

fn save(
    store: &Mutex<Option<Store>>,
    root: &Path,
    key: &str,
    state: &Checkpoint,
) -> Result<(), LofError> {
    let value = serde_json::to_value(state).map_err(|error| fail_invalid(error.to_string()))?;
    with_store(store, root, |st| st.database()?.set(key, &value))
}

fn original(path: &str, bytes: &[u8]) -> Result<(), LofError> {
    if path.rsplit('/').next() == Some("project.json") {
        let raw = std::str::from_utf8(bytes)
            .map_err(|_| fail_invalid("작품 메타 정보의 문자 인코딩 오류"))?;
        crate::store::parse_project(raw)?;
    } else if path.to_ascii_lowercase().ends_with(".md") {
        let raw = std::str::from_utf8(bytes)
            .map_err(|_| fail_invalid("Markdown 원고의 문자 인코딩이 올바르지 않습니다."))?;
        crate::markdown::read_markdown(raw)?;
    }
    Ok(())
}

pub(crate) fn apply_local(
    store: &Mutex<Option<Store>>,
    root: &Path,
    path: &str,
    bytes: Option<&[u8]>,
    expected: Option<&str>,
    modified: Option<i64>,
) -> Result<(), LofError> {
    with_store(store, root, |st| {
        st.require_database()?;
        st.ensure_sync_ready(path)?;
        let old = read_local(root, path)?;
        if old.as_deref().map(hash_bytes).as_deref() != expected {
            return Err(retry());
        }
        lof_realtime::file_index::Index::open(root).and_then(|index| index.invalidate(path))
            .map_err(|e| fail(e, "DATABASE"))?;
        let preserved_draft = if path.to_ascii_lowercase().ends_with(".md") {
            old.as_deref().map(|raw| st.preserve_sync_draft(raw)).transpose()?.flatten()
        } else { None };
        if path == crate::project_order::FILE
            && crate::project_order::receive(root, st.database()?, bytes)?
        {
            return Ok(());
        }
        let target = file_remote::safe_path(root, path)?;
        let project = path.rsplit('/').next() == Some("project.json");
        match bytes {
            Some(bytes) => {
                original(path, bytes)?;
                let received_raw = if path.to_ascii_lowercase().ends_with(".md") {
                    let raw = std::str::from_utf8(bytes).map_err(|_| fail_invalid("원고 인코딩 오류"))?;
                    st.database()?.queue_received_history(path, raw)?;
                    Some(raw)
                } else { None };
                atomic_write_bytes(&target, bytes)?;
                if let Some(raw) = received_raw {
                    st.database()?.mark_received_history(path, raw)?;
                }
                if let Some(seconds) = modified.filter(|seconds| *seconds >= 0) {
                    let times = fs::FileTimes::new()
                        .set_modified(UNIX_EPOCH + Duration::from_secs(seconds as u64));
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&target)?
                        .set_times(times)?;
                }
                if project {
                    let backup = path.strip_suffix("project.json").unwrap().to_string()
                        + "project.backup.json";
                    atomic_write_bytes(&file_remote::safe_path(root, &backup)?, bytes)?;
                }
            }
            None => {
                // 파일 하나만 삭제하고 작품 정보의 복구용 사본도 함께 정리한다.
                if project {
                    let backup = path.strip_suffix("project.json").unwrap().to_string()
                        + "project.backup.json";
                    let backup = file_remote::safe_path(root, &backup)?;
                    if backup.try_exists()? {
                        st.trash_path(&backup)?;
                    }
                }
                st.trash_path(&target)?;
                record_change(&target);
            }
        }
        if let Some(id) = preserved_draft { st.clear_draft(&id)?; }
        Ok(())
    })
}

fn archive(
    store: &Mutex<Option<Store>>,
    root: &Path,
    path: &str,
    bytes: &[u8],
) -> Result<bool, LofError> {
    let relative = format!(".lof/file-conflicts/{}/{path}", hash_bytes(bytes));
    with_store(store, root, |st| {
        st.require_database()?;
        let target = file_remote::safe_path(root, &relative)?;
        if let Some(previous) = read_local(root, &relative)? {
            if previous != bytes {
                return Err(fail_invalid("기존 충돌 사본의 내용이 예상과 다릅니다."));
            }
            return Ok(false);
        }
        atomic_write_bytes(&target, bytes)?;
        Ok(true)
    })
}

// 삭제된 작품의 다른 쪽 원고가 편집 중이면, 작품 전체를 보존해 메타 정보만 사라지지 않게 한다.
fn protected_projects(
    pairs: &BTreeMap<String, Pair>,
    base: &BTreeMap<String, String>,
) -> HashSet<String> {
    let mut protected = HashSet::new();
    for (path, pair) in pairs {
        let Some(folder) = path.strip_suffix("/project.json") else {
            continue;
        };
        if !base.contains_key(path) || pair.local.is_some() == pair.remote.is_some() {
            continue;
        }
        let prefix = format!("{folder}/");
        let local_remains = pair.local.is_some();
        if pairs
            .iter()
            .filter(|(path, _)| path.starts_with(&prefix))
            .any(|(path, pair)| {
                let current = if local_remains {
                    &pair.local
                } else {
                    &pair.remote
                };
                current
                    .as_ref()
                    .is_some_and(|hash| base.get(path) != Some(hash))
            })
        {
            protected.insert(folder.to_string());
        }
    }
    protected
}

pub(super) fn sync(
    store: &Mutex<Option<Store>>,
    root: &Path,
    config: &Value,
    device: &str,
) -> Result<Value, LofError> {
    let connection = config["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(|| fail_invalid("동기화 연결 ID 오류"))?;
    let key = format!("file-sync-v1:{device}:{connection}");
    let mut state: Checkpoint = with_store(store, root, |st| {
        st.require_database()?;
        serde_json::from_value(st.database()?.get(&key)?.unwrap_or_else(|| json!({})))
            .map_err(|error| fail_invalid(error.to_string()))
    })?;
    let mut total = json!({"downloaded":0,"conflicts":0,"projectConflicts":0,"projectsUpdated":0,"assetsUpdated":0,
        "removed":0,"uploaded":0,"downloadedFiles":0,"uploadedBytes":0,"downloadedBytes":0,"cleanedFiles":0,"fileConflicts":0,"protocol":"files-v1"});
    let mut remote = file_remote::lock(file_remote::connect(config, root)?)?;
    if !state.legacy_imported {
        let legacy = latest::receive(store, root, config, device)?;
        for field in [
            "downloaded",
            "conflicts",
            "projectConflicts",
            "projectsUpdated",
            "assetsUpdated",
            "removed",
            "downloadedFiles",
            "downloadedBytes",
        ] {
            total[field] = legacy[field].clone();
        }
        state.legacy_imported = true;
        save(store, root, &key, &state)?;
    }
    let result = run(
        store,
        root,
        &key,
        &mut state,
        &mut *remote,
        config["conflictPolicy"].as_str() == Some("latest"),
        &mut total,
    );
    remote.close();
    // 일부 파일만 반영된 뒤 통신에 실패해도 열린 서재와 로컬 이력을 갱신한다.
    let refreshed = refresh_disk(store, root);
    result?;
    refreshed?;
    Ok(total)
}

// 서재 파일 목록은 잠금 밖에서 만들고, 열린 서재에 반영할 때만 잠근다.
fn refresh_disk(store: &Mutex<Option<Store>>, root: &Path) -> Result<bool, LofError> {
    let files = crate::store::disk_inventory(root)?;
    with_store(store, root, |st| {
        let changed = st.poll_disk_with(files)?;
        st.flush_received_history()?;
        Ok(changed)
    })
}

/// 실시간 피어도 파일 저장소와 같은 충돌·삭제·이름 변경 규칙을 사용한다.
pub(crate) fn sync_peer(
    store: &Mutex<Option<Store>>, root: &Path, peer: &str, remote: &mut dyn FileRemote,
) -> Result<Value, LofError> {
    // 그룹 방식으로 바뀌며 이전 1:1 연결의 비교 기록은 이어 쓰지 않는다. 다시 연결한 첫 비교는 양쪽 파일을 합친다.
    let key = format!("realtime-files-v2:{peer}");
    let mut state: Checkpoint = with_store(store, root, |st| {
        st.require_database()?;
        serde_json::from_value(st.database()?.get(&key)?.unwrap_or_else(||json!({})))
            .map_err(|e|fail_invalid(e.to_string()))
    })?;
    let mut total=json!({"downloaded":0,"uploaded":0,"removed":0,"fileConflicts":0,"conflicts":0,"protocol":"realtime-files-v1"});
    let result=run(store,root,&key,&mut state,remote,false,&mut total);
    let refreshed=refresh_disk(store,root);
    result?; refreshed?;
    Ok(total)
}

fn run(
    store: &Mutex<Option<Store>>,
    root: &Path,
    key: &str,
    state: &mut Checkpoint,
    remote: &mut dyn FileRemote,
    latest: bool,
    total: &mut Value,
) -> Result<(), LofError> {
    let mut remote_files = remote.inventory()?;
    if remote_files.remove(ID_FILE).is_some() {
        let id = String::from_utf8(remote.read(ID_FILE)?)
            .map_err(|_| fail_invalid("저장소 식별자 형식 오류"))?;
        if Uuid::parse_str(&id).is_err() {
            return Err(fail_invalid("저장소 식별자를 확인할 수 없습니다."));
        }
        if state
            .remote_id
            .as_ref()
            .is_some_and(|previous| previous != &id)
        {
            return Err(fail("동기화 저장소가 새로 만들어졌거나 교체되었습니다. 저장소 경로를 확인한 뒤 연결을 다시 추가해 주세요.", "SYNC_REMOTE_RESET"));
        }
        state.remote_id = Some(id);
    } else {
        if state.remote_id.is_some() || !state.files.is_empty() {
            return Err(fail("저장소 식별 파일이 사라져 동기화를 중단했습니다. 저장소 경로와 연결 상태를 확인해 주세요.", "SYNC_REMOTE_RESET"));
        }
        let id = Uuid::new_v4().to_string();
        remote.write(ID_FILE, id.as_bytes(), None)?;
        if remote.read(ID_FILE)? != id.as_bytes() {
            return Err(retry());
        }
        state.remote_id = Some(id);
    }
    save(store, root, key, state)?;
    let mut local_files = inventory(store, root)?;
    local_files.remove(ID_FILE);
    let names: BTreeSet<_> = local_files
        .keys()
        .chain(remote_files.keys())
        .chain(state.files.keys())
        .cloned()
        .collect();
    let mut deferred = DeferredPaths::default();
    for (path, info) in local_files.iter().chain(remote_files.iter()) {
        if info.unavailable { deferred.insert(path); }
    }
    let mut folded = HashMap::new();
    for path in &names {
        if !file_remote::path_ok(path)
            || !file_remote::included(path)
        {
            deferred.insert(path);
            continue;
        }
        if let Some(other) = folded.insert(path.to_lowercase(), path) {
            deferred.insert(other);
            deferred.insert(path);
        }
        if deferred.contains(path) { continue; }
        for (index, _) in path.match_indices('/') {
            if names.contains(&path[..index]) {
                deferred.insert(&path[..index]);
                deferred.insert(path);
            }
        }
    }
    let mut pairs = BTreeMap::new();
    for path in &names {
        if deferred.contains(path) { continue; }
        remote.heartbeat()?;
        match with_store(store, root, |st| st.ensure_sync_ready(path)) {
            Ok(()) => {},
            Err(error) if can_defer_file(&error) => { deferred.insert(path); continue; },
            Err(error) => return Err(error),
        }
        let local_info = local_files.get(path).cloned();
        let (local, local_id) = if let Some(info) = &local_info {
            if let Some(index) = info.index.as_ref().filter(|index| index.matches(info.etag.as_deref())) {
                (info.etag.clone(), index.identity.clone())
            } else {
                let checked = with_store(store, root, |_| {
                    let bytes = read_local(root, path)?.ok_or_else(retry)?;
                    Ok((Some(hash_bytes(&bytes)), identity(path, &bytes)?))
                });
                match checked {
                    Ok(value) => value,
                    Err(error) if can_defer_file(&error) => { deferred.insert(path); continue; }
                    Err(error) => return Err(error),
                }
            }
        } else {
            (None, None)
        };
        let remote_info = remote_files.get(path).cloned();
        let mut remote_id = None;
        let remote_hash = if let Some(info) = &remote_info {
            let indexed = info.index.as_ref().filter(|index| remote.hash_etag() && index.matches(info.etag.as_deref()));
            let invalid_index = info.index.is_some() && indexed.is_none();
            let cached = info
                .etag
                .as_ref()
                .filter(|tag| !tag.starts_with("W/"))
                .and_then(|tag| {
                    state
                        .tags
                        .get(path)
                        .filter(|(previous, _)| !invalid_index && previous == tag)
                });
            if let Some(indexed) = indexed {
                remote_id = indexed.identity.clone();
                info.etag.clone()
            } else {
                match cached {
                    Some((_, hash)) => {
                        remote_id = state.identities.get(path).cloned();
                        Some(hash.clone())
                    }
                    None if !invalid_index && remote.hash_etag() && local.is_some() && info.etag == local => {
                        remote_id = local_id.clone();
                        local.clone()
                    }
                    None => {
                        let bytes = match remote.read(&path) {
                            Ok(bytes) => bytes,
                            Err(error) if can_defer_file(&error) => { deferred.insert(path); continue; }
                            Err(error) => return Err(error),
                        };
                        add(total, "downloadedBytes", bytes.len());
                        add(total, "downloadedFiles", 1);
                        remote_id = match identity(path, &bytes) {
                            Ok(id) => id,
                            Err(error) if can_defer_file(&error) => { deferred.insert(path); continue; }
                            Err(error) => return Err(error),
                        };
                        Some(hash_bytes(&bytes))
                    }
                }
            }
        } else {
            None
        };
        pairs.insert(
            path.clone(),
            Pair {
                local,
                remote: remote_hash,
                local_info,
                remote_info,
                local_id,
                remote_id,
            },
        );
    }
    let renamed = rename_losers(&pairs, &state.files, &mut deferred);
    // 읽을 수 없는 파일의 이름 변경 전 경로도 보존한다.
    let identities: Vec<(&str, &str)> = state.identities.iter().map(|(path, id)| (path.as_str(), id.as_str()))
        .chain(pairs.iter().flat_map(|(path, pair)| [pair.local_id.as_deref(), pair.remote_id.as_deref()]
            .into_iter().flatten().map(move |id| (path.as_str(), id)))).collect();
    deferred.protect_identities(&identities);
    let protected = protected_projects(&pairs, &state.files);
    // 원고 삭제를 먼저, 작품 메타 정보 삭제를 마지막에 적용한다.
    let mut paths: Vec<_> = pairs.keys().cloned().collect();
    paths.sort_by_key(|path| (path.ends_with("/project.json"), path.clone()));
    for path in paths {
        if deferred.contains(&path) { continue; }
        let operation = (|| -> Result<(), LofError> {
            with_store(store, root, |st| st.ensure_sync_ready(&path))?;
            let pair = &pairs[&path];
            let base = state.files.get(&path);
            let local = pair.local.as_deref();
            let other = pair.remote.as_deref();
            if renamed.contains(&path) {
                let bytes = if local.is_some() {
                    with_store(store, root, |_| read_local(root, &path))?.ok_or_else(retry)?
                } else {
                    remote.read(&path)?
                };
                let expected = local.or(other);
                if Some(hash_bytes(&bytes)).as_deref() != expected {
                    return Err(retry());
                }
                if base.map(String::as_str) != expected && archive(store, root, &path, &bytes)? {
                    add(total, "conflicts", 1);
                    add(total, "fileConflicts", 1);
                }
                if local.is_some() {
                    apply_local(store, root, &path, None, local, None)?;
                    add(total, "removed", 1);
                }
                if let Some(info) = &pair.remote_info {
                    if Some(hash_bytes(&remote.read(&path)?)).as_deref() != other {
                        return Err(retry());
                    }
                    with_store(store, root, |st| st.ensure_sync_ready(&path))?;
                    remote.remove(&path, info)?;
                    add(total, "cleanedFiles", 1);
                }
                checkpoint(state, &path, None, None);
                state.identities.remove(&path);
                save(store, root, key, state)?;
                return Ok(());
            }
            if local == other {
                checkpoint(state, &path, local, pair.remote_info.as_ref());
                if let Some(id) = &pair.remote_id {
                    state.identities.insert(path.clone(), id.clone());
                } else {
                    state.identities.remove(&path);
                }
                return Ok(());
            }
            if path == crate::project_order::FILE {
                if let Some(hash) = sync_project_order(store, root, remote, pair, total)? {
                    let tagged = Info { etag: Some(hash.clone()), ..Info::default() };
                    let info = if other == Some(hash.as_str()) {
                        pair.remote_info.as_ref()
                    } else if remote.hash_etag() {
                        Some(&tagged)
                    } else {
                        None
                    };
                    checkpoint(state, &path, Some(&hash), info);
                    save(store, root, key, state)?;
                    return Ok(());
                }
            }
            let protected = protected
                .iter()
                .any(|folder| path.starts_with(&format!("{folder}/")));
            let take_remote = if protected && (local.is_none() || other.is_none()) {
                other.is_some()
            } else if local.is_some() && other.is_some()
                && pair.local_id == pair.remote_id
                && pair.local_id.as_deref().is_some_and(|id| id.starts_with("document:")) {
                let ours = with_store(store, root, |_| read_local(root, &path))?.ok_or_else(retry)?;
                let theirs = remote.read(&path)?;
                if Some(hash_bytes(&ours)).as_deref() != local || Some(hash_bytes(&theirs)).as_deref() != other {
                    return Err(retry());
                }
                let ours_at = lof_realtime::document_version::modified(&ours, pair.local_info.as_ref().and_then(|info| info.modified));
                let theirs_at = lof_realtime::document_version::modified(&theirs, pair.remote_info.as_ref().and_then(|info| info.modified));
                (theirs_at, other) > (ours_at, local)
            } else if base.map(String::as_str) == local {
                true
            } else if base.map(String::as_str) == other {
                false
            } else if local.is_none() || other.is_none() {
                // 삭제와 편집이 동시에 발생하면 편집한 원본을 살린다.
                other.is_some()
            } else {
                let take_remote = if latest {
                    (
                        pair.remote_info.as_ref().and_then(|info| info.modified),
                        other,
                    ) > (
                        pair.local_info.as_ref().and_then(|info| info.modified),
                        local,
                    )
                } else {
                    other > local
                };
                if !latest {
                    let bytes = if take_remote {
                        with_store(store, root, |_| read_local(root, &path))?.ok_or_else(retry)?
                    } else {
                        remote.read(&path)?
                    };
                    let expected = if take_remote { local } else { other };
                    if Some(hash_bytes(&bytes)).as_deref() != expected {
                        return Err(retry());
                    }
                    if archive(store, root, &path, &bytes)? {
                        add(total, "conflicts", 1);
                        add(total, "fileConflicts", 1);
                    }
                }
                take_remote
            };
            if take_remote {
                let bytes = if other.is_some() {
                    Some(remote.read(&path)?)
                } else {
                    None
                };
                if bytes.as_deref().map(hash_bytes).as_deref() != other {
                    return Err(retry());
                }
                apply_local(
                    store,
                    root,
                    &path,
                    bytes.as_deref(),
                    local,
                    pair.remote_info.as_ref().and_then(|info| info.modified),
                )?;
                if bytes.is_some() {
                    add(total, "downloaded", 1);
                } else {
                    add(total, "removed", 1);
                }
                checkpoint(state, &path, other, pair.remote_info.as_ref());
                if let Some(id) = &pair.remote_id {
                    state.identities.insert(path.clone(), id.clone());
                } else {
                    state.identities.remove(&path);
                }
            } else {
                let bytes = with_store(store, root, |_| read_local(root, &path))?;
                if bytes.as_deref().map(hash_bytes).as_deref() != local {
                    return Err(retry());
                }
                if !remote.hash_etag() {
                    if other.is_some() {
                        if Some(hash_bytes(&remote.read(&path)?)).as_deref() != other {
                            return Err(retry());
                        }
                    } else if remote.exists(&path)? {
                        return Err(retry());
                    }
                }
                // 전송 직전에 서재가 바뀌거나 닫히지 않았는지도 확인한다.
                with_store(store, root, |st| { st.require_database()?; st.ensure_sync_ready(&path) })?;
                if let Some(bytes) = bytes {
                    original(&path, &bytes)?;
                    remote.write(&path, &bytes, pair.remote_info.as_ref())?;
                    add(total, "uploaded", 1);
                    add(total, "uploadedBytes", bytes.len());
                } else {
                    remote.remove(&path, pair.remote_info.as_ref().ok_or_else(retry)?)?;
                    add(total, "cleanedFiles", 1);
                }
                // 쓴 뒤의 ETag는 다음에 확인한다. 실시간 동기화는 파일 해시가 곧 ETag이므로 바로 기록한다.
                let tagged = local.map(|hash| Info { etag: Some(hash.to_string()), ..Info::default() });
                checkpoint(state, &path, local, if remote.hash_etag() { tagged.as_ref() } else { None });
                if let Some(id) = &pair.local_id {
                    state.identities.insert(path.clone(), id.clone());
                } else {
                    state.identities.remove(&path);
                }
            }
            save(store, root, key, state)?;
            Ok(())
        })();
        match operation {
            Ok(()) => {},
            Err(error) if can_defer_file(&error) => { deferred.insert(&path); },
            Err(error) => return Err(error),
        }
    }
    total["deferredFiles"] = json!(names.iter().filter(|path| deferred.contains(path)).count());
    save(store, root, key, state)?;
    Ok(())
}

fn checkpoint(state: &mut Checkpoint, path: &str, hash: Option<&str>, info: Option<&Info>) {
    state.tags.remove(path);
    if let Some(hash) = hash {
        state.files.insert(path.to_string(), hash.to_string());
        if let Some(tag) = info
            .and_then(|info| info.etag.as_ref())
            .filter(|tag| !tag.starts_with("W/"))
        {
            state
                .tags
                .insert(path.to_string(), (tag.clone(), hash.to_string()));
        }
    } else {
        state.files.remove(path);
    }
}
