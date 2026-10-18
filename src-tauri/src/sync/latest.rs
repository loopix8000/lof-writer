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

// 파일 원본 규격으로 전환할 때 구형 저장소는 읽기만 한다.
pub(super) fn receive(
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
        // 구형 원격 규격에는 쓰지 않고 기존 병합 기준만 이어받는다.
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
    let peer_files: Vec<_> = names
        .iter()
        .filter(|name| name.starts_with("device-") || name.starts_with("index-v2-"))
        .cloned()
        .collect();
    if peer_files.len() > 200 {
        return Err(fail_invalid("동기화 기기가 너무 많습니다."));
    }
    let mut total = json!({"downloaded":0,"conflicts":0,"projectConflicts":0,"projectsUpdated":0,"assetsUpdated":0,"removed":0,"uploaded":0,"downloadedFiles":0,"uploadedBytes":0,"downloadedBytes":0,"cleanedFiles":0,"protocol":2});
    let mut applied = state["applied"].as_object().cloned().unwrap_or_default();
    let mut peers = state["peers"].as_object().cloned().unwrap_or_default();
    let mut remote_versions = state["remoteVersions"].as_object().cloned().unwrap_or_default();

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

    Ok(total)
}
