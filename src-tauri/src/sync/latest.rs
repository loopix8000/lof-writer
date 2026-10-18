use super::{create_adapter, name_ok, with_store, RemoteAdapter, MAX_SYNC_BYTES};
use crate::error::{fail, fail_invalid, hash_str, valid_id, LofError};
use crate::store::{project_fields, Store, SyncConflictPolicy, FORMAT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    kind: String,
    key: String,
    file: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    protocol: u32,
    device_id: String,
    entries: Vec<Entry>,
    deleted: Map<String, Value>,
}

fn entry_name(device: &str, kind: &str, key: &str) -> String {
    format!("latest-v2-{device}-{kind}-{}.json", hash_str(key))
}

fn owned_latest(device: &str, name: &str) -> bool {
    ["document", "project"].iter().any(|kind| {
        name.strip_prefix(&format!("latest-v2-{device}-{kind}-"))
            .and_then(|tail| tail.strip_suffix(".json"))
            .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
    })
}

fn published_files_present(state: &Value, names: &HashSet<&str>, device: &str, own_index: &str) -> bool {
    state["ownIndexHash"].as_str().is_some() && names.contains(own_index)
        && state["files"].as_object().is_some_and(|files| {
            files.keys().all(|name| names.contains(name.as_str()))
                && !names.iter().any(|name| owned_latest(device, name) && !files.contains_key(*name))
        })
}

fn validate(index: &Index, name: &str) -> Result<(), LofError> {
    if index.protocol != 2 {
        return Err(fail(
            "지원하지 않는 동기화 규격입니다. 앱을 업데이트해 주세요.",
            "SYNC_VERSION",
        ));
    }
    if !valid_id(&index.device_id)
        || name != format!("index-v2-{}.json", index.device_id)
        || index.entries.len() > 40_000
        || index.deleted.len() > 20_000
    {
        return Err(fail_invalid("동기화 색인의 형식이 올바르지 않습니다."));
    }
    let mut keys = HashSet::new();
    for entry in &index.entries {
        if !["document", "project"].contains(&entry.kind.as_str())
            || !valid_id(&entry.key)
            || entry.file != entry_name(&index.device_id, &entry.kind, &entry.key)
            || !name_ok(&entry.file)
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || !keys.insert((entry.kind.clone(), entry.key.clone()))
        {
            return Err(fail_invalid(
                "동기화 항목의 이름 또는 해시가 올바르지 않습니다.",
            ));
        }
    }
    Ok(())
}

fn revisions(snapshot: &Value) -> Map<String, Value> {
    let mut result = Map::new();
    for doc in snapshot["documents"].as_array().into_iter().flatten() {
        if let (Some(id), Some(rev)) = (doc["id"].as_str(), doc["revision"].as_str()) {
            result.insert(id.to_string(), json!(rev));
        }
    }
    for project in snapshot["projects"].as_array().into_iter().flatten() {
        if let Some(id) = project["id"].as_str() {
            result.insert(
                format!("project:{id}"),
                json!(hash_str(&project_fields(project).to_string())),
            );
        }
    }
    result
}

fn base_for(state: &Value, peer: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for value in [
        state.get("published"),
        state.get("peers").and_then(|p| p.get(peer)),
    ]
    .into_iter()
    .flatten()
    {
        for (key, value) in value.as_object().into_iter().flatten() {
            if let Some(value) = value.as_str() {
                result.insert(key.clone(), value.to_string());
            }
        }
    }
    result
}

fn add_result(total: &mut Value, result: &Value) {
    for (count, items) in [
        ("downloaded", "imported"),
        ("conflicts", "conflicts"),
        ("projectConflicts", "projectConflicts"),
        ("projectsUpdated", "projectsUpdated"),
        ("assetsUpdated", "assetsUpdated"),
        ("removed", "removed"),
    ] {
        let old = total[count].as_u64().unwrap_or(0);
        total[count] = json!(old + result[items].as_array().map_or(0, Vec::len) as u64);
    }
}

fn parse(raw: &str) -> Result<Value, LofError> {
    if raw.len() > MAX_SYNC_BYTES {
        return Err(fail_invalid("동기화 항목이 50MB를 초과합니다."));
    }
    serde_json::from_str(raw).map_err(|e| fail_invalid(format!("동기화 데이터 형식 오류: {e}")))
}

// 객체 키와 목록 조회 순서가 바뀌어도 같은 서재는 같은 해시로 비교한다.
fn snapshot_hash(snapshot: &Value) -> String {
    fn ordered(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort();
                Value::Object(keys.into_iter().map(|key| (key.clone(), ordered(&object[key]))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(ordered).collect()),
            _ => value.clone(),
        }
    }
    let mut snapshot = ordered(snapshot);
    for (field, key) in [("projects", "id"), ("documents", "id"), ("assets", "projectId")] {
        if let Some(items) = snapshot[field].as_array_mut() {
            items.sort_by(|a, b| a[key].as_str().cmp(&b[key].as_str()));
        }
    }
    hash_str(&snapshot.to_string())
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
    if !valid_id(device) {
        return Err(fail_invalid("장치 ID 오류"));
    }
    let state_key = format!("sync-v2:{device}:{connection}");
    let mut state = with_store(store, root, |st| {
        let db = st.database()?;
        if let Some(state) = db.get(&state_key)? {
            return Ok(state);
        }
        // Preserve the old merge baseline without writing to the old remote format.
        let legacy = db
            .get(&format!("legacy:sync/{connection}.json"))?
            .unwrap_or_else(|| json!({}));
        Ok(
            json!({"peers":legacy.get("peers").cloned().unwrap_or(json!({})),
            "published":legacy.get("published").cloned().unwrap_or(json!({})),
            "applied":{},"files":{}}),
        )
    })?;
    if !state.is_object() {
        return Err(fail_invalid("로컬 동기화 상태가 올바르지 않습니다."));
    }
    let mut remote = create_adapter(config)?;
    let policy = if config["conflictPolicy"].as_str() == Some("latest") {
        SyncConflictPolicy::Latest
    } else {
        SyncConflictPolicy::KeepBoth
    };
    let result = run(store, root, device, &state_key, &mut state, &mut *remote, policy);
    remote.close();
    result
}

fn run(
    store: &Mutex<Option<Store>>,
    root: &Path,
    device: &str,
    state_key: &str,
    state: &mut Value,
    remote: &mut dyn RemoteAdapter,
    conflict_policy: SyncConflictPolicy,
) -> Result<Value, LofError> {
    let names = remote.list()?;
    let name_set: HashSet<_> = names.iter().map(String::as_str).collect();
    let peer_files: Vec<_> = names
        .iter()
        .filter(|name| name.starts_with("device-") || name.starts_with("index-v2-"))
        .cloned()
        .collect();
    if peer_files.len() > 200 {
        return Err(fail_invalid("동기화 기기가 너무 많습니다."));
    }
    let own_index = format!("index-v2-{device}.json");
    let mut total = json!({"downloaded":0,"conflicts":0,"projectConflicts":0,"projectsUpdated":0,"assetsUpdated":0,"removed":0,"uploaded":0,"downloadedFiles":0,"uploadedBytes":0,"downloadedBytes":0,"cleanedFiles":0,"protocol":2});
    let mut applied = state["applied"].as_object().cloned().unwrap_or_default();
    let mut peers = state["peers"].as_object().cloned().unwrap_or_default();
    let mut remote_versions = state["remoteVersions"].as_object().cloned().unwrap_or_default();
    let mut remote_changed = false;

    for peer in peer_files {
        if peer == format!("device-{device}.json") {
            continue;
        }
        if let Some(peer_device) = peer
            .strip_prefix("device-")
            .and_then(|v| v.strip_suffix(".json"))
        {
            if names.contains(&format!("index-v2-{peer_device}.json")) {
                continue;
            }
        }
        let version = remote.version(&peer);
        // 이전에 성공적으로 처리한 색인의 버전이 같으면 본문 다운로드와 비교를 생략한다.
        if version.as_deref().is_some_and(|version| {
            applied.contains_key(&peer) && remote_versions.get(&peer).and_then(Value::as_str) == Some(version)
        }) {
            continue;
        }
        let raw = remote.read(&peer)?;
        let digest = hash_str(&raw);
        total["downloadedBytes"] =
            json!(total["downloadedBytes"].as_u64().unwrap_or(0) + raw.len() as u64);
        if applied.get(&peer).and_then(Value::as_str) == Some(digest.as_str()) {
            if let Some(version) = version {
                remote_versions.insert(peer, json!(version));
                state["remoteVersions"] = json!(remote_versions);
                with_store(store, root, |st| st.database()?.set(state_key, state))?;
            }
            continue;
        }
        remote_changed = true;
        let mut cache_scope = None;
        let snapshot = if peer.starts_with("device-") {
            parse(&raw)?
        } else {
            let index: Index = serde_json::from_value(parse(&raw)?)
                .map_err(|e| fail_invalid(format!("동기화 색인 오류: {e}")))?;
            validate(&index, &peer)?;
            let cache_prefix = format!("sync-cache:{state_key}:{}:", index.device_id);
            let mut cache_keys = HashSet::new();
            let mut projects = Vec::new();
            let mut documents = Vec::new();
            let mut assets = Vec::new();
            for entry in &index.entries {
                let cache_key = format!("{cache_prefix}{}", entry.file);
                cache_keys.insert(cache_key.clone());
                let cached = with_store(store, root, |st| st.database()?.get(&cache_key))?;
                let payload = if cached.as_ref().and_then(|v| v["hash"].as_str())
                    == Some(entry.sha256.as_str())
                {
                    cached.unwrap()["payload"].clone()
                } else {
                    let content = remote.read(&entry.file)?;
                    if hash_str(&content) != entry.sha256 {
                        return Err(fail("동기화 도중 상대 기기의 문서가 변경됐습니다. 새 색인으로 다시 시도합니다.","SYNC_RETRY"));
                    }
                    let payload = parse(&content)?;
                    with_store(store, root, |st| {
                        st.database()?
                            .set(&cache_key, &json!({"hash":entry.sha256,"payload":payload}))
                    })?;
                    total["downloadedFiles"] =
                        json!(total["downloadedFiles"].as_u64().unwrap_or(0) + 1);
                    total["downloadedBytes"] = json!(
                        total["downloadedBytes"].as_u64().unwrap_or(0) + content.len() as u64
                    );
                    payload
                };
                if entry.kind == "document" {
                    if payload["id"].as_str() != Some(entry.key.as_str()) {
                        return Err(fail_invalid("원격 문서 ID 불일치"));
                    }
                    documents.push(payload);
                } else {
                    if payload["project"]["id"].as_str() != Some(entry.key.as_str()) {
                        return Err(fail_invalid("원격 작품 ID 불일치"));
                    }
                    projects.push(payload["project"].clone());
                    if let Some(asset) = payload.get("asset").filter(|v| !v.is_null()) {
                        assets.push(asset.clone());
                    }
                }
            }
            cache_scope = Some((cache_prefix, cache_keys));
            json!({"format":FORMAT,"projects":projects,"documents":documents,"assets":assets,"deleted":index.deleted})
        };
        let base = base_for(state, &peer);
        let merged = with_store(store, root, |st| st.merge(&snapshot, &base, conflict_policy))?;
        add_result(&mut total, &merged);
        peers.insert(peer.clone(), Value::Object(revisions(&snapshot)));
        applied.insert(peer.clone(), digest.into());
        // 병합까지 성공한 경우에만 다음 확인에서 사용할 원격 버전을 기억한다.
        if let Some(version) = version {
            remote_versions.insert(peer.clone(), json!(version));
        }
        state["peers"] = json!(peers);
        state["applied"] = json!(applied);
        state["remoteVersions"] = json!(remote_versions);
        with_store(store, root, |st| st.database()?.set(state_key, state))?;
        if let Some((prefix, keys)) = cache_scope {
            with_store(store, root, |st| st.database()?.retain_keys(&prefix, &keys))?;
        }
    }

    // 원격과 로컬이 모두 그대로면 서재 전체 읽기와 해시 계산도 하지 않는다.
    if !remote_changed && state["outboundHash"].as_str().is_some()
        && published_files_present(state, &name_set, device, &own_index)
        && with_store(store, root, |st| Ok(st.sync_unchanged(state_key)))?
    {
        return Ok(total);
    }
    let (snapshot, local_revision) = with_store(store, root, |st| {
        let revision = st.sync_revision();
        Ok((st.snapshot()?, revision))
    })?;
    let outbound_hash = snapshot_hash(&snapshot);
    // 수신 확인은 계속하되, 마지막 전송 내용과 같으면 업로드 단계 자체를 건너뛴다.
    // 원격에서 사라진 파일의 복구와 남은 구형 파일 정리는 기존 경로에서 처리한다.
    let unchanged = state["outboundHash"].as_str() == Some(outbound_hash.as_str())
        && published_files_present(state, &name_set, device, &own_index);
    if unchanged {
        with_store(store, root, |st| {
            st.retain_history(false)?;
            st.remember_sync_revision(state_key, local_revision);
            Ok(())
        })?;
        return Ok(total);
    }
    // 전송 도중 실패하거나 원고가 이전 내용으로 돌아가도, 미완료 전송을 완료 상태로 오인하지 않는다.
    state.as_object_mut().unwrap().remove("outboundHash");
    with_store(store, root, |st| st.database()?.set(state_key, state))?;
    let mut entries = Vec::new();
    let mut files = state["files"].as_object().cloned().unwrap_or_default();
    let mut payloads = Vec::new();
    for project in snapshot["projects"].as_array().into_iter().flatten() {
        let key = project["id"]
            .as_str()
            .ok_or_else(|| fail_invalid("작품 ID 오류"))?;
        let asset = snapshot["assets"]
            .as_array()
            .and_then(|assets| {
                assets
                    .iter()
                    .find(|asset| asset["projectId"].as_str() == Some(key))
            })
            .cloned()
            .unwrap_or(Value::Null);
        payloads.push((
            "project",
            key.to_string(),
            json!({"project":project,"asset":asset}),
        ));
    }
    for doc in snapshot["documents"].as_array().into_iter().flatten() {
        payloads.push((
            "document",
            doc["id"]
                .as_str()
                .ok_or_else(|| fail_invalid("문서 ID 오류"))?
                .to_string(),
            doc.clone(),
        ));
    }
    for (kind, key, payload) in payloads {
        let file = entry_name(device, kind, &key);
        let content = payload.to_string();
        let sha256 = hash_str(&content);
        if content.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid("동기화 항목이 50MB를 초과합니다."));
        }
        if files.get(&file).and_then(Value::as_str) != Some(sha256.as_str())
            || !names.contains(&file)
        {
            with_store(store, root, |st| st.require_database())?;
            remote.write(&file, &content)?;
            files.insert(file.clone(), json!(sha256));
            state["files"] = json!(files);
            // A successful body transfer can be reused if publishing the index fails.
            with_store(store, root, |st| st.database()?.set(state_key, state))?;
            total["uploaded"] = json!(total["uploaded"].as_u64().unwrap_or(0) + 1);
            total["uploadedBytes"] =
                json!(total["uploadedBytes"].as_u64().unwrap_or(0) + content.len() as u64);
        }
        entries.push(Entry {
            kind: kind.to_string(),
            key,
            file,
            sha256,
        });
    }
    entries.sort_by(|a, b| a.file.cmp(&b.file));
    let index = Index {
        protocol: 2,
        device_id: device.to_string(),
        entries,
        deleted: snapshot["deleted"].as_object().cloned().unwrap_or_default(),
    };
    let encoded = serde_json::to_string(&index).map_err(|e| fail_invalid(e.to_string()))?;
    if encoded.len() > MAX_SYNC_BYTES {
        return Err(fail_invalid("동기화 색인이 너무 큽니다."));
    }
    let index_hash = hash_str(&encoded);
    if state["ownIndexHash"].as_str() != Some(index_hash.as_str()) || !names.contains(&own_index) {
        with_store(store, root, |st| st.require_database())?;
        // The index becomes visible only after all referenced latest documents exist.
        remote.write(&own_index, &encoded)?;
        total["uploadedBytes"] =
            json!(total["uploadedBytes"].as_u64().unwrap_or(0) + encoded.len() as u64);
    }
    state["published"] = json!(revisions(&snapshot));
    state["ownIndexHash"] = json!(index_hash);
    state["outboundHash"] = json!(outbound_hash);
    applied.insert(own_index, json!(index_hash));
    state["applied"] = json!(applied);
    let keep: HashSet<_> = index
        .entries
        .iter()
        .map(|entry| entry.file.clone())
        .collect();
    files.retain(|name, _| keep.contains(name));
    state["files"] = json!(files);
    with_store(store, root, |st| st.database()?.set(state_key, state))?;

    // Only remove this device's obsolete latest files, after publishing its new index.
    for name in names
        .iter()
        .filter(|name| owned_latest(device, name) && !keep.contains(*name))
        .take(100)
    {
        if remote.remove(name).is_ok() {
            total["cleanedFiles"] = json!(total["cleanedFiles"].as_u64().unwrap_or(0) + 1);
        }
    }
    with_store(store, root, |st| {
        st.retain_history(false)?;
        st.remember_sync_revision(state_key, local_revision);
        Ok(())
    })?;
    Ok(total)
}
