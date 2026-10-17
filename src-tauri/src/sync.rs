use crate::error::{fail, fail_invalid, LofError};
use crate::store::{atomic_write_str, Store};
use regex::Regex;
use reqwest::blocking::Client as HttpClient;
use reqwest::Method;
use serde_json::Value;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use suppaftp::RustlsConnector;
use suppaftp::RustlsFtpStream;

mod google_drive;
mod latest;

const MAX_SYNC_BYTES: usize = 50_000_000;
const SYNC_PREFIX: &str = "lof-writer-sync-v1";

fn name_ok(n: &str) -> bool {
    static NAME_RE: OnceLock<Regex> = OnceLock::new();
    let re = NAME_RE.get_or_init(|| Regex::new(r"^(?:device-|index-v2-|latest-v2-)[a-zA-Z0-9_-]+\.json$").unwrap());
    n.len() <= 240 && re.is_match(n)
}

trait RemoteAdapter {
    fn list(&mut self) -> Result<Vec<String>, LofError>;
    fn read(&mut self, name: &str) -> Result<String, LofError>;
    fn write(&mut self, name: &str, content: &str) -> Result<(), LofError>;
    fn remove(&mut self, name: &str) -> Result<(), LofError>;
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

    fn remove(&mut self, name: &str) -> Result<(), LofError> {
        if !name_ok(name) { return Err(fail_invalid("잘못된 동기화 파일 이름")); }
        match fs::remove_file(self.root.join(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
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

    fn remove(&mut self, name: &str) -> Result<(), LofError> {
        if !name_ok(name) { return Err(fail_invalid("잘못된 동기화 파일 이름")); }
        let response=self.client.delete(self.full_url(name)).basic_auth(&self.username,Some(&self.password))
            .send().map_err(|e|fail_invalid(e.to_string()))?;
        if response.status().is_success() || response.status().as_u16()==404 {Ok(())}
        else {Err(fail_invalid(format!("WebDAV 정리 실패: {}",response.status())))}
    }
}

struct FtpAdapter {
    stream: RustlsFtpStream,
}

pub fn validate_ftp_config(config: &Value) -> Result<(), LofError> {
    for key in ["host", "username", "password", "remotePath"] {
        if let Some(value) = config.get(key).filter(|v| !v.is_null()) {
            let text = value.as_str().ok_or_else(|| fail_invalid("FTP 연결 정보는 문자열이어야 합니다."))?;
            if text.contains(['\r', '\n', '\0']) {
                return Err(fail_invalid("FTP 연결 정보에는 줄바꿈이나 NUL 문자를 사용할 수 없습니다."));
            }
        }
    }
    Ok(())
}

impl FtpAdapter {
    fn new(config: &Value) -> Result<Self, LofError> {
        validate_ftp_config(config)?;
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
        if !name_ok(name) {
            return Err(fail_invalid("잘못된 FTP 동기화 파일 이름입니다."));
        }
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
        if !name_ok(name) {
            return Err(fail_invalid("잘못된 FTP 동기화 파일 이름입니다."));
        }
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

    fn remove(&mut self, name: &str) -> Result<(), LofError> {
        if !name_ok(name) {return Err(fail_invalid("잘못된 FTP 동기화 파일 이름"));}
        self.stream.rm(name).map_err(|e|fail_invalid(e.to_string()))
    }
}

pub fn prepare_connection(config: &Value) -> Result<Value, LofError> {
    if config.get("type").and_then(Value::as_str) == Some("google-drive") {
        crate::google_drive::ensure_enabled()?;
        google_drive::prepare_connection(config)
    } else {
        Ok(config.clone())
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

fn with_store<T>(
    store: &Mutex<Option<Store>>,
    root: &Path,
    action: impl FnOnce(&mut Store) -> Result<T, LofError>,
) -> Result<T, LofError> {
    let mut guard = store.lock().unwrap();
    let store = guard.as_mut().ok_or_else(|| fail_invalid("Store not initialized"))?;
    if store.root != root {
        return Err(fail("동기화 중 서재가 변경되었습니다.", "VAULT_CHANGED"));
    }
    action(store)
}

pub fn sync_once(store: &Mutex<Option<Store>>, root: &Path, config: &Value, device_id: &str) -> Result<Value, LofError> {
    latest::sync(store,root,config,device_id)
}
