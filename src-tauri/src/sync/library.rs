//! Lof Library 서버와 동기화한다. 서버를 상대 기기 하나처럼 보고, 기존 스냅샷 병합과 충돌 처리를 그대로 사용한다.

use super::{with_store, MAX_SYNC_BYTES};
use crate::error::{fail, fail_invalid, hash_bytes, hash_str, valid_id, LofError};
use crate::store::{Store, SyncConflictPolicy, FORMAT};
use base64::Engine;
use chrono::{SecondsFormat, TimeZone, Utc};
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;

const DOCUMENT_PREFIX: &str = "d_";
const PROJECT_PREFIX: &str = "p_";
const MAX_ATTEMPTS: usize = 3;

/// 서버 주소에서 경로 끝의 `/`와 쿼리를 정리한다. 계정 정보가 들어간 주소는 받지 않는다.
pub fn normalize_url(url: &str) -> Result<String, LofError> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| fail_invalid("서버 주소를 확인해 주세요. 예: http://192.168.0.10:8787"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some()
    {
        return Err(fail_invalid("서버 주소는 http:// 또는 https://로 시작해야 합니다."));
    }
    let mut base = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or_default());
    if let Some(port) = parsed.port() {
        base.push_str(&format!(":{port}"));
    }
    base.push_str(parsed.path().trim_end_matches('/'));
    Ok(base)
}

/// `lof-library://connect?server=…&code=…` 연결 정보에서 서버 주소와 연결 코드를 꺼낸다.
pub fn parse_connection(input: &str) -> Option<(String, String)> {
    let parsed = reqwest::Url::parse(input.trim()).ok()?;
    if parsed.scheme() != "lof-library" {
        return None;
    }
    let mut server = None;
    let mut code = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "server" => server = Some(value.to_string()),
            "code" => code = Some(value.to_string()),
            _ => {}
        }
    }
    Some((server?, code?))
}

fn network_error(_: reqwest::Error) -> LofError {
    fail("서버에 연결하지 못했습니다. 서버 주소와 실행 상태를 확인해 주세요.", "LIBRARY_OFFLINE")
}

fn server_error(status: u16, body: &Value) -> LofError {
    let code = body["error"].as_str().unwrap_or_default();
    let message = body["message"].as_str().filter(|message| !message.is_empty());
    match (status, code) {
        (401, _) => fail("서버에서 이 기기의 연결을 해제했습니다. 연결을 지우고 새 연결 코드로 다시 연결해 주세요.", "LIBRARY_UNAUTHORIZED"),
        (404, "library_not_found") => fail("서버에서 연결한 서재를 찾을 수 없습니다. 연결을 지우고 다시 연결해 주세요.", "LIBRARY_NOT_FOUND"),
        (429, _) => fail(message.unwrap_or("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."), "LIBRARY_THROTTLED"),
        _ => fail_invalid(message.map(str::to_string).unwrap_or_else(|| format!("서버 요청을 처리하지 못했습니다. ({status})"))),
    }
}

/// 서버 응답. 상태 코드와 JSON 본문을 함께 돌려준다.
struct Reply {
    status: u16,
    body: Value,
}

impl Reply {
    fn ok(self) -> Result<Value, LofError> {
        if (200..300).contains(&self.status) {
            Ok(self.body)
        } else {
            Err(server_error(self.status, &self.body))
        }
    }
}

pub struct Server {
    client: Client,
    base: String,
    token: String,
}

impl Server {
    pub fn new(url: &str, token: &str) -> Result<Self, LofError> {
        if !token.starts_with("lofd_") {
            return Err(fail("서버 연결 정보가 올바르지 않습니다. 연결을 지우고 다시 연결해 주세요.", "LIBRARY_UNAUTHORIZED"));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| fail_invalid(e.to_string()))?;
        Ok(Self { client, base: normalize_url(url)?, token: token.to_string() })
    }

    fn send(&self, request: RequestBuilder) -> Result<Reply, LofError> {
        let response = request.bearer_auth(&self.token).send().map_err(network_error)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().map_err(network_error)?;
        if bytes.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid("서버 응답이 너무 큽니다."));
        }
        let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
        Ok(Reply { status, body })
    }

    fn get(&self, path: &str) -> Result<Value, LofError> {
        self.send(self.client.get(format!("{}{path}", self.base)))?.ok()
    }

    fn post(&self, path: &str, body: &Value) -> Result<Reply, LofError> {
        self.send(self.client.post(format!("{}{path}", self.base)).json(body))
    }

    fn put(&self, path: &str, body: &Value) -> Result<Reply, LofError> {
        self.send(self.client.put(format!("{}{path}", self.base)).json(body))
    }

    fn get_bytes(&self, path: &str) -> Result<Vec<u8>, LofError> {
        let response = self.client.get(format!("{}{path}", self.base)).bearer_auth(&self.token).send().map_err(network_error)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().map_err(network_error)?;
        if !(200..300).contains(&status) {
            return Err(server_error(status, &serde_json::from_slice(&bytes).unwrap_or(Value::Null)));
        }
        Ok(bytes.to_vec())
    }

    fn put_bytes(&self, path: &str, bytes: Vec<u8>) -> Result<(), LofError> {
        let request = self.client.put(format!("{}{path}", self.base)).header("Content-Type", "application/octet-stream").body(bytes);
        self.send(request)?.ok().map(|_| ())
    }
}

// 연결과 서재 선택

/// 연결 코드로 이 기기를 서버에 등록하고 기기 인증 키를 받는다.
pub fn pair(input: &str, code: &str, device_name: &str) -> Result<Value, LofError> {
    let (url, code) = match parse_connection(input) {
        Some(found) => found,
        None => (input.trim().to_string(), code.trim().to_string()),
    };
    if code.is_empty() {
        return Err(fail_invalid("서버에서 발급한 연결 코드를 입력해 주세요."));
    }
    let base = normalize_url(&url)?;
    let client = Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| fail_invalid(e.to_string()))?;
    let response = client
        .post(format!("{base}/v1/pair"))
        .json(&json!({"code": code, "name": device_name, "platform": std::env::consts::OS}))
        .send()
        .map_err(network_error)?;
    let status = response.status().as_u16();
    let body: Value = response.json().unwrap_or(Value::Null);
    if status != 201 {
        return Err(server_error(status, &body));
    }
    let token = body["token"].as_str().filter(|token| token.starts_with("lofd_"));
    let device = body["device"]["id"].as_str().filter(|id| valid_id(id));
    let (Some(token), Some(device)) = (token, device) else {
        return Err(fail_invalid("서버 응답을 확인할 수 없습니다. 서버 버전을 확인해 주세요."));
    };
    Ok(json!({
        "url": base, "token": token, "deviceId": device,
        "serverId": body["server"]["id"], "serverName": body["server"]["name"],
    }))
}

pub fn libraries(url: &str, token: &str) -> Result<Vec<Value>, LofError> {
    let body = Server::new(url, token)?.get("/v1/libraries")?;
    Ok(body["libraries"].as_array().cloned().unwrap_or_default().into_iter()
        .map(|library| json!({"id": library["id"], "name": library["name"]}))
        .collect())
}

pub fn create_library(url: &str, token: &str, name: &str) -> Result<Value, LofError> {
    let name: String = name.trim().chars().take(200).collect();
    let id = format!("lib-{}", Uuid::new_v4().simple());
    let body = Server::new(url, token)?
        .post("/v1/libraries", &json!({"id": id, "name": if name.is_empty() { "내 서재".to_string() } else { name }}))?
        .ok()?;
    Ok(json!({"id": body["id"], "name": body["name"]}))
}

// 실시간 수신에서 이 기기가 보낸 변경을 거르기 위해 최근에 보낸 문서 버전을 기억한다.

fn own_changes() -> &'static Mutex<HashSet<(String, String, i64)>> {
    static OWN: OnceLock<Mutex<HashSet<(String, String, i64)>>> = OnceLock::new();
    OWN.get_or_init(|| Mutex::new(HashSet::new()))
}

fn remember_own(connection: &str, id: &str, version: i64) {
    let mut own = own_changes().lock().unwrap();
    if own.len() > 10_000 {
        own.clear();
    }
    own.insert((connection.to_string(), id.to_string(), version));
}

/// 이 기기가 보낸 변경이면 기록을 지우고 참을 돌려준다.
pub fn take_own(connection: &str, id: &str, version: i64) -> bool {
    own_changes().lock().unwrap().remove(&(connection.to_string(), id.to_string(), version))
}

// 서버 문서 ↔ Lof Writer 스냅샷 변환

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object.iter().map(|(key, value)| (key.clone(), canonical(value))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

/// 서버 문서와 보낼 내용을 같은 기준으로 비교하는 해시. 키 순서에 영향을 받지 않는다.
fn content_hash(kind: &Value, title: &Value, body: &Value, metadata: &Value) -> String {
    hash_str(&canonical(&json!({"kind": kind, "title": title, "body": body, "metadata": metadata})).to_string())
}

fn remote_hash(doc: &Value) -> String {
    content_hash(&doc["kind"], &doc["title"], &doc["body"], &doc["metadata"])
}

fn iso(seconds: Option<f64>) -> String {
    let millis = (seconds.unwrap_or(0.0) * 1000.0) as i64;
    Utc.timestamp_millis_opt(millis).single().unwrap_or_else(Utc::now).to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Outgoing {
    id: String,
    kind: Value,
    title: Value,
    body: Value,
    metadata: Value,
    cover: Option<(String, Vec<u8>)>,
}

impl Outgoing {
    fn hash(&self) -> String {
        content_hash(&self.kind, &self.title, &self.body, &self.metadata)
    }
}

/// 로컬 스냅샷을 서버 문서로 바꾼다. 작품은 `p_`, 문서는 `d_`로 시작하는 ID를 쓴다.
fn outgoing(snapshot: &Value) -> Result<Vec<Outgoing>, LofError> {
    let mut items = Vec::new();
    for project in snapshot["projects"].as_array().into_iter().flatten() {
        let id = project["id"].as_str().filter(|id| valid_id(id)).ok_or_else(|| fail_invalid("작품 ID 오류"))?;
        let asset = snapshot["assets"].as_array().into_iter().flatten().find(|asset| asset["projectId"].as_str() == Some(id));
        let cover = match asset {
            Some(asset) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(asset["data"].as_str().unwrap_or_default())
                    .map_err(|_| fail_invalid("표지 데이터를 읽지 못했습니다."))?;
                Some((asset["filename"].as_str().unwrap_or_default().to_string(), bytes))
            }
            None => None,
        };
        let metadata = json!({
            "project": project,
            "cover": cover.as_ref().map(|(filename, bytes)| json!({"filename": filename, "sha256": hash_bytes(bytes)})),
        });
        items.push(Outgoing {
            id: format!("{PROJECT_PREFIX}{id}"), kind: json!("project"), title: project["title"].clone(), body: json!(""), metadata,
            cover: cover.map(|(_, bytes)| (hash_bytes(&bytes), bytes)),
        });
    }
    for document in snapshot["documents"].as_array().into_iter().flatten() {
        let id = document["id"].as_str().filter(|id| valid_id(id)).ok_or_else(|| fail_invalid("문서 ID 오류"))?;
        let mut rest = document.as_object().cloned().unwrap_or_default();
        let (kind, title, body) = (rest.remove("kind"), rest.remove("title"), rest.remove("body"));
        rest.remove("id");
        items.push(Outgoing {
            id: format!("{DOCUMENT_PREFIX}{id}"), kind: kind.unwrap_or(json!("episode")), title: title.unwrap_or(json!("")),
            body: body.unwrap_or(json!("")), metadata: json!({"doc": rest}), cover: None,
        });
    }
    Ok(items)
}

fn revisions(snapshot: &Value) -> Map<String, Value> {
    let mut result = Map::new();
    for doc in snapshot["documents"].as_array().into_iter().flatten() {
        if let (Some(id), Some(revision)) = (doc["id"].as_str(), doc["revision"].as_str()) {
            result.insert(id.to_string(), json!(revision));
        }
    }
    for project in snapshot["projects"].as_array().into_iter().flatten() {
        if let Some(id) = project["id"].as_str() {
            result.insert(format!("project:{id}"), json!(hash_str(&crate::store::project_fields(project).to_string())));
        }
    }
    result
}

struct Job<'a> {
    store: &'a Mutex<Option<Store>>,
    root: &'a Path,
    server: Server,
    connection: String,
    library: String,
    device: String,
    state_key: String,
    policy: SyncConflictPolicy,
}

impl Job<'_> {
    fn path(&self, tail: &str) -> String {
        format!("/v1/libraries/{}{tail}", self.library)
    }

    fn cache_prefix(&self) -> String {
        format!("library-cache:{}:{}:", self.connection, self.library)
    }

    fn asset_prefix(&self) -> String {
        format!("library-asset:{}:{}:", self.connection, self.library)
    }

    fn db_get(&self, key: &str) -> Result<Option<Value>, LofError> {
        with_store(self.store, self.root, |st| st.database()?.get(key))
    }

    fn db_set(&self, key: &str, value: &Value) -> Result<(), LofError> {
        with_store(self.store, self.root, |st| st.database()?.set(key, value))
    }

    /// 표지 이미지는 해시별로 한 번만 받아 로컬에 보관한다.
    fn asset_data(&self, sha256: &str, used: &mut HashSet<String>, total: &mut Value) -> Result<String, LofError> {
        let key = format!("{}{sha256}", self.asset_prefix());
        used.insert(key.clone());
        if let Some(cached) = self.db_get(&key)?.and_then(|value| value["data"].as_str().map(str::to_string)) {
            return Ok(cached);
        }
        let bytes = self.server.get_bytes(&self.path(&format!("/assets/{sha256}")))?;
        if hash_bytes(&bytes) != sha256 {
            return Err(fail_invalid("서버의 표지 이미지가 손상되었습니다."));
        }
        add(total, "downloadedBytes", bytes.len() as u64);
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.db_set(&key, &json!({"data": data}))?;
        Ok(data)
    }

    /// 서버 문서를 병합에 쓸 Lof Writer 스냅샷으로 바꾼다.
    fn snapshot_of(&self, remote: &BTreeMap<String, Value>, total: &mut Value) -> Result<Value, LofError> {
        let mut projects = Vec::new();
        let mut documents = Vec::new();
        let mut assets = Vec::new();
        let mut deleted = Map::new();
        let mut project_ids = HashSet::new();
        let mut used_assets = HashSet::new();
        for (id, doc) in remote {
            let gone = doc["deleted"].as_bool().unwrap_or(false);
            let deleted_at = iso(doc["updated_at"].as_f64());
            if let Some(project_id) = id.strip_prefix(PROJECT_PREFIX) {
                if gone {
                    deleted.insert(format!("p-{project_id}"), json!({"projectId": project_id, "deletedAt": deleted_at, "project": true}));
                    continue;
                }
                let project = &doc["metadata"]["project"];
                if project["id"].as_str() != Some(project_id) {
                    return Err(fail_invalid("서버의 작품 정보가 올바르지 않습니다."));
                }
                if let Some(cover) = doc["metadata"]["cover"].as_object() {
                    let sha256 = cover.get("sha256").and_then(Value::as_str).unwrap_or_default();
                    let data = self.asset_data(sha256, &mut used_assets, total)?;
                    assets.push(json!({"projectId": project_id, "filename": cover.get("filename"), "data": data}));
                }
                projects.push(project.clone());
                project_ids.insert(project_id.to_string());
            } else if let Some(document_id) = id.strip_prefix(DOCUMENT_PREFIX) {
                let mut item = doc["metadata"]["doc"].as_object().cloned().unwrap_or_default();
                if gone {
                    deleted.insert(document_id.to_string(), json!({"projectId": item.get("projectId"), "deletedAt": deleted_at}));
                    continue;
                }
                item.insert("id".into(), json!(document_id));
                item.insert("kind".into(), doc["kind"].clone());
                item.insert("title".into(), doc["title"].clone());
                item.insert("body".into(), doc["body"].clone());
                documents.push(Value::Object(item));
            }
        }
        // 작품이 서버에 없는 문서는 병합할 수 없으므로 작품이 올라온 뒤 다시 확인한다.
        documents.retain(|doc| doc["projectId"].as_str().is_some_and(|id| project_ids.contains(id)));
        with_store(self.store, self.root, |st| st.database()?.retain_keys(&self.asset_prefix(), &used_assets))?;
        Ok(json!({"format": FORMAT, "projects": projects, "documents": documents, "assets": assets, "deleted": deleted}))
    }

    /// 서버 목록을 받고, 바뀐 문서의 본문만 내려받는다.
    fn pull(&self, total: &mut Value) -> Result<Option<(BTreeMap<String, Value>, HashSet<String>)>, LofError> {
        let listing = self.server.get(&self.path("/snapshot"))?;
        let entries = listing["documents"].as_array().cloned().unwrap_or_default();
        if entries.len() > 45_000 {
            return Err(fail_invalid("서버 서재의 문서가 너무 많습니다."));
        }
        let assets: HashSet<String> = listing["assets"].as_array().into_iter().flatten()
            .filter_map(|asset| asset["sha256"].as_str().map(str::to_string)).collect();
        let prefix = self.cache_prefix();
        let mut keys = HashSet::new();
        let mut remote = BTreeMap::new();
        for entry in entries {
            let Some(id) = entry["id"].as_str().map(str::to_string) else { continue };
            let sha256 = entry["sha256"].as_str().unwrap_or_default();
            let key = format!("{prefix}{id}");
            keys.insert(key.clone());
            let cached = self.db_get(&key)?.filter(|cached| cached["sha256"].as_str() == Some(sha256));
            let doc = match cached {
                Some(cached) => cached["doc"].clone(),
                // 삭제된 문서는 목록의 속성만으로 삭제 기록을 만들 수 있어 본문을 받지 않는다.
                None if entry["deleted"].as_bool() == Some(true) => entry.clone(),
                None => {
                    let doc = self.server.get(&self.path(&format!("/documents/{id}")))?;
                    if doc["sha256"].as_str() != Some(sha256) {
                        // 목록을 받은 뒤 다른 기기가 다시 바꿨다. 새 목록으로 처음부터 확인한다.
                        return Ok(None);
                    }
                    add(total, "downloadedFiles", 1);
                    add(total, "downloadedBytes", doc["body"].as_str().map_or(0, str::len) as u64);
                    self.db_set(&key, &json!({"sha256": sha256, "doc": doc}))?;
                    doc
                }
            };
            remote.insert(id, doc);
        }
        with_store(self.store, self.root, |st| st.database()?.retain_keys(&prefix, &keys))?;
        Ok(Some((remote, assets)))
    }

    /// 문서 하나를 서버 버전을 확인하며 보낸다. 다른 기기가 먼저 바꿨으면 거짓을 돌려준다.
    fn push(&self, id: &str, current: Option<&Value>, payload: Value) -> Result<Option<Value>, LofError> {
        let expected = current.and_then(|doc| doc["version"].as_i64()).unwrap_or(0);
        let mut request = payload;
        request["device_id"] = json!(self.device);
        request["mutation_id"] = json!(Uuid::new_v4().to_string());
        request["expected_version"] = json!(expected);
        let reply = self.server.put(&self.path(&format!("/documents/{id}")), &request)?;
        if reply.status == 409 {
            // 서버가 보존한 충돌 사본은 다음 병합에서 로컬 규칙으로 처리하므로 서버 쪽 사본은 정리한다.
            if let Some(conflict) = reply.body["conflict_id"].as_str() {
                let current_version = reply.body["current_version"].as_i64().unwrap_or(0);
                let _ = self.server.post(&self.path(&format!("/conflicts/{conflict}/resolve")), &json!({
                    "device_id": self.device, "mutation_id": Uuid::new_v4().to_string(),
                    "expected_version": current_version, "choice": "current",
                }));
            }
            return Ok(None);
        }
        let receipt = reply.ok()?["document"].clone();
        let version = receipt["version"].as_i64().unwrap_or(0);
        remember_own(&self.connection, id, version);
        let mut doc = request;
        if let Some(object) = doc.as_object_mut() {
            for key in ["device_id", "mutation_id", "expected_version"] {
                object.remove(key);
            }
        }
        doc["id"] = json!(id);
        doc["version"] = json!(version);
        doc["sha256"] = receipt["sha256"].clone();
        doc["updated_at"] = json!(Utc::now().timestamp_millis() as f64 / 1000.0);
        self.db_set(&format!("{}{id}", self.cache_prefix()), &json!({"sha256": receipt["sha256"], "doc": doc}))?;
        Ok(Some(doc))
    }

    /// 받기·병합·보내기를 한 번 수행한다. 다른 기기와 동시에 바꿔 다시 확인해야 하면 참을 돌려준다.
    fn run(&self, state: &mut Value, total: &mut Value) -> Result<bool, LofError> {
        let Some((mut remote, assets)) = self.pull(total)? else { return Ok(true) };
        let remote_snapshot = self.snapshot_of(&remote, total)?;
        let remote_digest = hash_str(&canonical(&remote_snapshot).to_string());
        let remote_changed = state["appliedHash"].as_str() != Some(remote_digest.as_str());
        // 서버와 로컬이 모두 그대로면 서재 전체 읽기와 비교를 하지 않는다.
        if !remote_changed && state["published"].is_object()
            && with_store(self.store, self.root, |st| Ok(st.sync_unchanged(&self.state_key)))?
        {
            return Ok(false);
        }
        if remote_changed {
            let mut base: HashMap<String, String> = HashMap::new();
            for field in ["published", "peer"] {
                for (key, value) in state[field].as_object().into_iter().flatten() {
                    if let Some(value) = value.as_str() {
                        base.insert(key.clone(), value.to_string());
                    }
                }
            }
            let merged = with_store(self.store, self.root, |st| st.merge(&remote_snapshot, &base, self.policy))?;
            for (count, items) in [("downloaded", "imported"), ("conflicts", "conflicts"), ("projectConflicts", "projectConflicts"),
                ("projectsUpdated", "projectsUpdated"), ("assetsUpdated", "assetsUpdated"), ("removed", "removed")]
            {
                add(total, count, merged[items].as_array().map_or(0, Vec::len) as u64);
            }
            state["peer"] = json!(revisions(&remote_snapshot));
            state["appliedHash"] = json!(remote_digest);
            self.db_set(&self.state_key, state)?;
        }

        let (local, local_revision) = with_store(self.store, self.root, |st| {
            let revision = st.sync_revision();
            Ok((st.snapshot()?, revision))
        })?;
        let mut changed = false;
        for item in outgoing(&local)? {
            let current = remote.get(&item.id);
            if current.is_some_and(|doc| doc["deleted"].as_bool() != Some(true) && remote_hash(doc) == item.hash()) {
                continue;
            }
            if let Some((sha256, bytes)) = &item.cover {
                if !assets.contains(sha256) {
                    add(total, "uploadedBytes", bytes.len() as u64);
                    self.server.put_bytes(&self.path(&format!("/assets/{sha256}")), bytes.clone())?;
                    self.db_set(&format!("{}{sha256}", self.asset_prefix()),
                        &json!({"data": base64::engine::general_purpose::STANDARD.encode(bytes)}))?;
                }
            }
            let size = item.body.as_str().map_or(0, str::len) as u64;
            let payload = json!({"kind": item.kind, "title": item.title, "body": item.body, "metadata": item.metadata, "deleted": false});
            match self.push(&item.id, current, payload)? {
                Some(doc) => {
                    remote.insert(item.id.clone(), doc);
                    add(total, "uploaded", 1);
                    add(total, "uploadedBytes", size);
                    changed = true;
                }
                None => return Ok(true),
            }
        }
        // 로컬에서 지운 문서와 작품을 서버에도 삭제로 표시한다. 서버는 삭제 직전 원고를 보관한다.
        for (id, info) in local["deleted"].as_object().into_iter().flatten() {
            let remote_id = match id.strip_prefix("p-") {
                Some(project) if info["project"].as_bool() == Some(true) => format!("{PROJECT_PREFIX}{project}"),
                _ => format!("{DOCUMENT_PREFIX}{id}"),
            };
            let Some(current) = remote.get(&remote_id).filter(|doc| doc["deleted"].as_bool() != Some(true)).cloned() else { continue };
            let payload = json!({"kind": current["kind"], "title": current["title"], "body": "", "metadata": current["metadata"], "deleted": true});
            match self.push(&remote_id, Some(&current), payload)? {
                Some(mut doc) => {
                    // 서버는 삭제할 때 마지막 원고를 그대로 보관하므로 보낸 빈 본문 대신 기존 내용을 기억한다.
                    doc["body"] = current["body"].clone();
                    remote.insert(remote_id, doc);
                    changed = true;
                }
                None => return Ok(true),
            }
        }
        if changed {
            // 보낸 뒤의 서버 상태를 기준으로 기억해, 내가 보낸 변경을 다음 주기에 다시 병합하지 않는다.
            let pushed = self.snapshot_of(&remote, total)?;
            state["peer"] = json!(revisions(&pushed));
            state["appliedHash"] = json!(hash_str(&canonical(&pushed).to_string()));
        }
        state["published"] = json!(revisions(&local));
        self.db_set(&self.state_key, state)?;
        with_store(self.store, self.root, |st| {
            st.remember_sync_revision(&self.state_key, local_revision);
            Ok(())
        })?;
        Ok(false)
    }
}

fn add(total: &mut Value, key: &str, amount: u64) {
    total[key] = json!(total[key].as_u64().unwrap_or(0) + amount);
}

pub(super) fn sync(store: &Mutex<Option<Store>>, root: &Path, config: &Value) -> Result<Value, LofError> {
    let connection = config["id"].as_str().filter(|id| valid_id(id)).ok_or_else(|| fail_invalid("동기화 연결 ID 오류"))?;
    let library = config["libraryId"].as_str().filter(|id| !id.is_empty())
        .ok_or_else(|| fail("외부 저장소 설정에서 연결할 서버의 서재를 선택해 주세요.", "LIBRARY_NOT_SELECTED"))?;
    let device = config["deviceId"].as_str().filter(|id| valid_id(id))
        .ok_or_else(|| fail("서버 연결 정보가 올바르지 않습니다. 연결을 지우고 다시 연결해 주세요.", "LIBRARY_UNAUTHORIZED"))?;
    let server = Server::new(config["url"].as_str().unwrap_or_default(), config["password"].as_str().unwrap_or_default())?;
    let policy = if config["conflictPolicy"].as_str() == Some("latest") { SyncConflictPolicy::Latest } else { SyncConflictPolicy::KeepBoth };
    let job = Job {
        store, root, server, policy,
        connection: connection.to_string(),
        library: library.to_string(),
        device: device.to_string(),
        state_key: format!("library-v1:{connection}:{library}"),
    };
    let mut total = json!({"downloaded":0,"conflicts":0,"projectConflicts":0,"projectsUpdated":0,"assetsUpdated":0,"removed":0,
        "uploaded":0,"downloadedFiles":0,"uploadedBytes":0,"downloadedBytes":0,"cleanedFiles":0,"protocol":"library"});
    for _ in 0..MAX_ATTEMPTS {
        let mut state = job.db_get(&job.state_key)?.filter(Value::is_object).unwrap_or_else(|| json!({}));
        if !job.run(&mut state, &mut total)? {
            return Ok(total);
        }
    }
    Err(fail("다른 기기와 동시에 수정하고 있습니다. 잠시 후 다시 동기화합니다.", "SYNC_RETRY"))
}
