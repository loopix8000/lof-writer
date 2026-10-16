use crate::error::{fail_invalid, hash_str, now_iso, valid_id, LofError};
use crate::store::{atomic_write_str, project_fields, Store};
use regex::Regex;
use reqwest::blocking::Client as HttpClient;
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use suppaftp::RustlsConnector;
use suppaftp::RustlsFtpStream;

mod google_drive;

const MAX_SYNC_BYTES: usize = 50_000_000;
const SYNC_PREFIX: &str = "lof-writer-sync-v1";

fn name_ok(n: &str) -> bool {
    static NAME_RE: OnceLock<Regex> = OnceLock::new();
    let re = NAME_RE.get_or_init(|| Regex::new(r"^device-[a-zA-Z0-9_-]+\.json$").unwrap());
    re.is_match(n)
}

trait RemoteAdapter {
    fn list(&mut self) -> Result<Vec<String>, LofError>;
    fn read(&mut self, name: &str) -> Result<String, LofError>;
    fn write(&mut self, name: &str, content: &str) -> Result<(), LofError>;
    fn close(&mut self) {}
}

struct FolderAdapter {
    root: PathBuf,
}

impl FolderAdapter {
    fn new(folder: &str) -> Result<Self, LofError> {
        let root = Path::new(folder).join(SYNC_PREFIX);
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }
}

impl RemoteAdapter for FolderAdapter {
    fn list(&mut self) -> Result<Vec<String>, LofError> {
        let mut out = Vec::new();
        for e in fs::read_dir(&self.root)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().to_string();
            if name_ok(&name) {
                out.push(name);
            }
        }
        out.sort();
        Ok(out)
    }

    fn read(&mut self, name: &str) -> Result<String, LofError> {
        let f = self.root.join(name);
        let stat = fs::metadata(&f)?;
        if stat.len() as usize > MAX_SYNC_BYTES {
            return Err(fail_invalid("동기화 파일이 50MB를 초과합니다."));
        }
        Ok(fs::read_to_string(&f)?)
    }

    fn write(&mut self, name: &str, content: &str) -> Result<(), LofError> {
        atomic_write_str(&self.root.join(name), content)
    }
}

struct WebDavAdapter {
    client: HttpClient,
    base_url: String,
    username: String,
    password: String,
    root_path: String,
}

impl WebDavAdapter {
    fn new(config: &Value) -> Result<Self, LofError> {
        let url_str = config.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let parsed = reqwest::Url::parse(url_str)
            .map_err(|_| fail_invalid("WebDAV 주소를 확인해 주세요."))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(fail_invalid("WebDAV 주소를 확인해 주세요."));
        }
        let remote_path = config
            .get("remotePath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_matches('/');
        let root_path = if remote_path.is_empty() {
            format!("/{}", SYNC_PREFIX)
        } else {
            format!("/{}/{}", remote_path, SYNC_PREFIX)
        };
        let client = HttpClient::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| fail_invalid(e.to_string()))?;
        let mut adapter = Self {
            client,
            base_url: url_str.trim_end_matches('/').to_string(),
            username: config
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            password: config
                .get("password")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            root_path,
        };
        adapter.ensure_dir()?;
        Ok(adapter)
    }

    fn full_url(&self, rel: &str) -> String {
        let mut p = self.root_path.clone();
        if !rel.is_empty() {
            p.push('/');
            p.push_str(rel.trim_start_matches('/'));
        }
        format!("{}{}", self.base_url, p)
    }

    fn ensure_dir(&mut self) -> Result<(), LofError> {
        let mkcol = Method::from_bytes(b"MKCOL").unwrap();
        let mut cur = String::new();
        for seg in self.root_path.split('/').filter(|s| !s.is_empty()) {
            cur.push('/');
            cur.push_str(seg);
            let url = format!("{}{}", self.base_url, cur);
            let _ = self
                .client
                .request(mkcol.clone(), &url)
                .basic_auth(&self.username, Some(&self.password))
                .send();
        }
        Ok(())
    }
}

impl RemoteAdapter for WebDavAdapter {
    fn list(&mut self) -> Result<Vec<String>, LofError> {
        let propfind = Method::from_bytes(b"PROPFIND").unwrap();
        let res = self
            .client
            .request(propfind, self.full_url(""))
            .basic_auth(&self.username, Some(&self.password))
            .header("Depth", "1")
            .send()
            .map_err(|e| fail_invalid(e.to_string()))?;
        if !res.status().is_success() {
            return Err(fail_invalid(format!("WebDAV 목록 조회 실패: {}", res.status())));
        }
        let xml = res.text().map_err(|e| fail_invalid(e.to_string()))?;
        static HREF_RE: OnceLock<Regex> = OnceLock::new();
        let re = HREF_RE
            .get_or_init(|| Regex::new(r"(?is)<(?:[a-z0-9_]+:)?href[^>]*>(.*?)</(?:[a-z0-9_]+:)?href>").unwrap());
        let mut names = Vec::new();
        for cap in re.captures_iter(&xml) {
            if let Some(m) = cap.get(1) {
                let href = m.as_str().trim().trim_end_matches('/');
                let basename = href.rsplit('/').next().unwrap_or(href);
                if name_ok(basename) && !names.contains(&basename.to_string()) {
                    names.push(basename.to_string());
                }
            }
        }
        Ok(names)
    }

    fn read(&mut self, name: &str) -> Result<String, LofError> {
        let res = self
            .client
            .get(self.full_url(name))
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .map_err(|e| fail_invalid(e.to_string()))?;
        if !res.status().is_success() {
            return Err(fail_invalid(format!("WebDAV 읽기 실패: {}", res.status())));
        }
        let bytes = res.bytes().map_err(|e| fail_invalid(e.to_string()))?;
        if bytes.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid("동기화 파일이 너무 큽니다."));
        }
        String::from_utf8(bytes.to_vec()).map_err(|e| fail_invalid(e.to_string()))
    }

    fn write(&mut self, name: &str, content: &str) -> Result<(), LofError> {
        let temp = format!(".{}.upload", name);
        let temp_url = self.full_url(&temp);
        let dest_url = self.full_url(name);
        let put_res = self
            .client
            .put(&temp_url)
            .basic_auth(&self.username, Some(&self.password))
            .body(content.to_string())
            .send()
            .map_err(|e| fail_invalid(e.to_string()))?;
        if !put_res.status().is_success() {
            return Err(fail_invalid(format!("WebDAV 업로드 실패: {}", put_res.status())));
        }
        let move_method = Method::from_bytes(b"MOVE").unwrap();
        let move_res = self
            .client
            .request(move_method, &temp_url)
            .basic_auth(&self.username, Some(&self.password))
            .header("Destination", &dest_url)
            .header("Overwrite", "T")
            .send()
            .map_err(|e| fail_invalid(e.to_string()))?;
        if !move_res.status().is_success() {
            return Err(fail_invalid(format!("WebDAV 파일 교체 실패: {}", move_res.status())));
        }
        Ok(())
    }
}

struct FtpAdapter {
    stream: RustlsFtpStream,
}

impl FtpAdapter {
    fn new(config: &Value) -> Result<Self, LofError> {
        let host = config.get("host").and_then(|v| v.as_str()).unwrap_or("");
        if host.is_empty() {
            return Err(fail_invalid("FTP 호스트가 필요합니다."));
        }
        let port = config
            .get("port")
            .and_then(|v| v.as_u64())
            .filter(|&p| p > 0 && p <= 65535)
            .unwrap_or(21) as u16;
        let username = config
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("anonymous");
        let password = config
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let secure = config
            .get("secure")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let remote_path = config
            .get("remotePath")
            .and_then(|v| v.as_str())
            .unwrap_or("/");

        let mut stream = RustlsFtpStream::connect(format!("{}:{}", host, port))
            .map_err(|e| fail_invalid(e.to_string()))?;
        if secure {
            let root_store = suppaftp::rustls::RootCertStore::empty();
            let tls_cfg = suppaftp::rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth();
            let connector = RustlsConnector::from(std::sync::Arc::new(tls_cfg));
            stream = stream
                .into_secure(connector, host)
                .map_err(|e| fail_invalid(e.to_string()))?;
        }
        stream
            .login(username, password)
            .map_err(|e| fail_invalid(e.to_string()))?;
        stream
            .transfer_type(suppaftp::types::FileType::Binary)
            .map_err(|e| fail_invalid(e.to_string()))?;

        let target_dir = format!("{}/{}", remote_path.trim_end_matches('/'), SYNC_PREFIX);
        for seg in target_dir.split('/').filter(|s| !s.is_empty()) {
            if stream.cwd(seg).is_err() {
                let _ = stream.mkdir(seg);
                stream.cwd(seg).map_err(|e| fail_invalid(e.to_string()))?;
            }
        }
        Ok(Self { stream })
    }
}

impl RemoteAdapter for FtpAdapter {
    fn list(&mut self) -> Result<Vec<String>, LofError> {
        let items = self
            .stream
            .nlst(None)
            .map_err(|e| fail_invalid(e.to_string()))?;
        let mut out = Vec::new();
        for item in items {
            let bn = item.rsplit('/').next().unwrap_or(&item);
            if name_ok(bn) {
                out.push(bn.to_string());
            }
        }
        Ok(out)
    }

    fn read(&mut self, name: &str) -> Result<String, LofError> {
        if let Ok(sz) = self.stream.size(name) {
            if sz > MAX_SYNC_BYTES {
                return Err(fail_invalid("동기화 파일이 너무 큽니다."));
            }
        }
        let cursor = self
            .stream
            .retr_as_buffer(name)
            .map_err(|e| fail_invalid(e.to_string()))?;
        let bytes = cursor.into_inner();
        if bytes.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid("동기화 파일이 너무 큽니다."));
        }
        String::from_utf8(bytes).map_err(|e| fail_invalid(e.to_string()))
    }

    fn write(&mut self, name: &str, content: &str) -> Result<(), LofError> {
        let temp = format!(".{}.upload", name);
        let mut reader = Cursor::new(content.as_bytes());
        self.stream
            .put_file(&temp, &mut reader)
            .map_err(|e| fail_invalid(e.to_string()))?;
        let _ = self.stream.rm(name);
        self.stream
            .rename(temp.as_str(), name)
            .map_err(|e| fail_invalid(e.to_string()))?;
        Ok(())
    }

    fn close(&mut self) {
        let _ = self.stream.quit();
    }
}

fn create_adapter(config: &Value) -> Result<Box<dyn RemoteAdapter>, LofError> {
    match config.get("type").and_then(|v| v.as_str()) {
        Some("folder") => {
            let f = config.get("folder").and_then(|v| v.as_str()).unwrap_or("");
            Ok(Box::new(FolderAdapter::new(f)?))
        }
        Some("webdav") => Ok(Box::new(WebDavAdapter::new(config)?)),
        Some("ftp") => Ok(Box::new(FtpAdapter::new(config)?)),
        Some("google-drive") => Ok(Box::new(google_drive::GoogleDriveAdapter::new(config)?)),
        _ => Err(fail_invalid("연결 방식을 선택해 주세요.")),
    }
}

pub fn sync_once(store: &mut Store, config: &Value, device_id: &str) -> Result<Value, LofError> {
    if !valid_id(device_id) {
        return Err(fail_invalid("잘못된 장치 ID"));
    }
    let cid = config.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let state_file = store
        .root
        .join(".lof")
        .join("sync")
        .join(format!("{}.json", cid));

    let mut state: Value = match fs::read_to_string(&state_file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "peers": {} })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "peers": {} }),
        Err(e) => return Err(LofError::from(e)),
    };

    let mut remote = create_adapter(config)?;
    let res = (|| -> Result<Value, LofError> {
        let peers = remote.list()?;
        if peers.len() > 100 {
            return Err(fail_invalid("동기화 장치가 100개를 초과합니다."));
        }
        let own_file = format!("device-{}.json", device_id);
        let mut downloaded = 0usize;
        let mut conflicts = 0usize;
        let mut project_conflicts = 0usize;
        let mut removed = 0usize;

        for n in peers.into_iter().filter(|n| n != &own_file) {
            if !name_ok(&n) {
                continue;
            }
            let raw = remote.read(&n)?;
            if raw.len() > MAX_SYNC_BYTES {
                return Err(fail_invalid("동기화 파일이 너무 큽니다."));
            }
            let snapshot: Value =
                serde_json::from_str(&raw).map_err(|e| fail_invalid(e.to_string()))?;

            let mut base: HashMap<String, String> = HashMap::new();
            if let Some(pub_map) = state.get("published").and_then(|v| v.as_object()) {
                for (k, v) in pub_map {
                    if let Some(s) = v.as_str() {
                        base.insert(k.clone(), s.to_string());
                    }
                }
            }
            if let Some(peer_map) = state
                .get("peers")
                .and_then(|v| v.get(&n))
                .and_then(|v| v.as_object())
            {
                for (k, v) in peer_map {
                    if let Some(s) = v.as_str() {
                        base.insert(k.clone(), s.to_string());
                    }
                }
            }

            let merged = store.merge(&snapshot, &base)?;
            downloaded += merged
                .get("imported")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            conflicts += merged
                .get("conflicts")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            project_conflicts += merged
                .get("projectConflicts")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            removed += merged
                .get("removed")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            let mut peer_record = serde_json::Map::new();
            if let Some(docs) = snapshot.get("documents").and_then(|v| v.as_array()) {
                for d in docs {
                    if let (Some(id), Some(rev)) = (
                        d.get("id").and_then(|v| v.as_str()),
                        d.get("revision").and_then(|v| v.as_str()),
                    ) {
                        peer_record.insert(id.to_string(), json!(rev));
                    }
                }
            }
            if let Some(projs) = snapshot.get("projects").and_then(|v| v.as_array()) {
                for p in projs {
                    if let Some(pid) = p.get("id").and_then(|v| v.as_str()) {
                        let h = hash_str(&serde_json::to_string(p).unwrap_or_default());
                        peer_record.insert(format!("project:{}", pid), json!(h));
                    }
                }
            }
            if let Some(sobj) = state.as_object_mut() {
                let peers_obj = sobj
                    .entry("peers")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .unwrap();
                peers_obj.insert(n, Value::Object(peer_record));
            }
        }

        let mut snapshot = store.snapshot()?;
        let uploaded = snapshot
            .get("documents")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);

        let mut published = serde_json::Map::new();
        if let Some(docs) = snapshot.get("documents").and_then(|v| v.as_array()) {
            for d in docs {
                if let (Some(id), Some(rev)) = (
                    d.get("id").and_then(|v| v.as_str()),
                    d.get("revision").and_then(|v| v.as_str()),
                ) {
                    published.insert(id.to_string(), json!(rev));
                }
            }
        }
        if let Some(projs) = snapshot.get("projects").and_then(|v| v.as_array()) {
            for p in projs {
                if let Some(pid) = p.get("id").and_then(|v| v.as_str()) {
                    let h = hash_str(&serde_json::to_string(&project_fields(p)).unwrap_or_default());
                    published.insert(format!("project:{}", pid), json!(h));
                }
            }
        }

        if let Some(sobj) = snapshot.as_object_mut() {
            sobj.insert("deviceId".to_string(), json!(device_id));
            sobj.insert("at".to_string(), json!(now_iso()));
        }
        let raw_snap = serde_json::to_string(&snapshot).unwrap_or_default();
        if raw_snap.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid("알파 동기화는 도서관당 50MB까지 지원합니다."));
        }
        remote.write(&own_file, &raw_snap)?;

        if let Some(sobj) = state.as_object_mut() {
            sobj.insert("published".to_string(), Value::Object(published));
        }
        atomic_write_str(
            &state_file,
            &serde_json::to_string_pretty(&state).unwrap_or_default(),
        )?;

        Ok(json!({
            "downloaded": downloaded,
            "conflicts": conflicts,
            "projectConflicts": project_conflicts,
            "removed": removed,
            "uploaded": uploaded,
        }))
    })();
    remote.close();
    res
}
