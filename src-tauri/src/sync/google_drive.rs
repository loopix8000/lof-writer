use super::{name_ok, RemoteAdapter, MAX_SYNC_BYTES};
use crate::error::{fail_invalid, valid_id, LofError};
use crate::google_drive::{check_response, http_client, network_error, refresh_access_token};
use reqwest::blocking::Client;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;

const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";

#[derive(Deserialize)]
struct DriveFile {
    id: String,
    name: String,
    size: Option<String>,
    version: Option<String>,
    #[serde(rename = "ownedByMe", default)]
    owned_by_me: bool,
}

pub(super) struct GoogleDriveAdapter {
    client: Client,
    token: String,
    root: String,
    files: HashMap<String, DriveFile>,
}

impl GoogleDriveAdapter {
    pub(super) fn new(config: &Value) -> Result<Self, LofError> {
        let client = http_client()?;
        let token = refresh_access_token(&client, config)?;
        let mut adapter = Self {
            client,
            token,
            root: String::new(),
            files: HashMap::new(),
        };
        if let Some(id) = config.get("folderId") {
            let id = id
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or_else(|| fail_invalid("저장된 Google Drive 폴더 ID가 올바르지 않습니다."))?;
            adapter.root = id.to_string();
        } else {
            let folders = adapter.list_files(
                "trashed = false and 'me' in owners and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key = 'lofWriterSync' and value = 'v1' }",
                "createdTime",
            )?;
            if folders.len() > 1 {
                return Err(fail_invalid("내 Google Drive에 동기화 폴더가 여러 개 있습니다. Lof Writer 폴더를 하나로 정리한 뒤 다시 연결해 주세요."));
            }
            if let Some(folder) = folders.into_iter().next() {
                if !folder.owned_by_me {
                    return Err(fail_invalid(
                        "내 소유의 Google Drive 폴더만 동기화할 수 있습니다.",
                    ));
                }
                adapter.root = folder.id;
            }
        }
        if adapter.root.is_empty() {
            let folder: Value = check_response(adapter.client.post(FILES_URL)
                .bearer_auth(&adapter.token).query(&[("fields", "id")])
                .json(&json!({ "name": "Lof Writer", "mimeType": "application/vnd.google-apps.folder",
                    "appProperties": { "lofWriterSync": "v1" } }))
                .send().map_err(network_error)?)?
                .json().map_err(|_| fail_invalid("Google Drive 동기화 폴더를 만들지 못했습니다."))?;
            let id = folder
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_id(id))
                .ok_or_else(|| fail_invalid("Google Drive 폴더 ID를 확인하지 못했습니다."))?;
            adapter.root = id.to_string();
        }
        adapter.validate_root()?;
        Ok(adapter)
    }

    fn validate_root(&self) -> Result<(), LofError> {
        let folder: Value = check_response(
            self.client
                .get(format!("{FILES_URL}/{}", self.root))
                .bearer_auth(&self.token)
                .query(&[("fields", "id,mimeType,ownedByMe,trashed,appProperties")])
                .send()
                .map_err(network_error)?,
        )?
        .json()
        .map_err(|_| fail_invalid("Google Drive 폴더 정보를 읽지 못했습니다."))?;
        if folder.get("id").and_then(Value::as_str) != Some(self.root.as_str())
            || folder.get("ownedByMe").and_then(Value::as_bool) != Some(true)
            || folder.get("trashed").and_then(Value::as_bool) != Some(false)
            || folder.get("mimeType").and_then(Value::as_str)
                != Some("application/vnd.google-apps.folder")
            || folder
                .pointer("/appProperties/lofWriterSync")
                .and_then(Value::as_str)
                != Some("v1")
        {
            return Err(fail_invalid("연결한 Google Drive 폴더의 소유자 또는 상태가 변경되었습니다. 폴더를 확인해 주세요."));
        }
        Ok(())
    }

    fn list_files(&self, query: &str, order: &str) -> Result<Vec<DriveFile>, LofError> {
        let mut files = Vec::new();
        let mut page = String::new();
        loop {
            let body: Value = check_response(
                self.client
                    .get(FILES_URL)
                    .bearer_auth(&self.token)
                    .query(&[
                        ("q", query),
                        ("spaces", "drive"),
                        ("fields", "nextPageToken,files(id,name,size,ownedByMe,version)"),
                        ("pageSize", "100"),
                        ("orderBy", order),
                        ("pageToken", &page),
                    ])
                    .send()
                    .map_err(network_error)?,
            )?
            .json()
            .map_err(|_| fail_invalid("Google Drive 파일 목록을 읽지 못했습니다."))?;
            let entries: Vec<DriveFile> =
                serde_json::from_value(body.get("files").cloned().unwrap_or(json!([])))
                    .map_err(|_| fail_invalid("Google Drive 파일 목록이 올바르지 않습니다."))?;
            for file in entries {
                if !valid_id(&file.id) {
                    return Err(fail_invalid("Google Drive 파일 ID가 올바르지 않습니다."));
                }
                files.push(file);
            }
            if files.len() > 100_000 {
                return Err(fail_invalid("Google Drive 동기화 파일이 너무 많습니다."));
            }
            page = body
                .get("nextPageToken")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if page.is_empty() {
                break;
            }
        }
        Ok(files)
    }
}

pub(super) fn prepare_connection(config: &Value) -> Result<Value, LofError> {
    if config.get("folderId").is_some() {
        return Ok(config.clone());
    }
    let adapter = GoogleDriveAdapter::new(config)?;
    let mut pinned = config.clone();
    pinned["folderId"] = json!(adapter.root);
    Ok(pinned)
}

impl RemoteAdapter for GoogleDriveAdapter {
    fn version(&self, name: &str) -> Option<String> {
        let file = self.files.get(name)?;
        Some(format!("{}:{}", file.id, file.version.as_ref()?))
    }

    fn list(&mut self) -> Result<Vec<String>, LofError> {
        let query = format!(
            "trashed = false and 'me' in owners and '{}' in parents",
            self.root
        );
        self.files.clear();
        for file in self.list_files(&query, "modifiedTime desc")? {
            if file.owned_by_me && name_ok(&file.name) {
                self.files.entry(file.name.clone()).or_insert(file);
            }
        }
        let mut names: Vec<_> = self.files.keys().cloned().collect();
        names.sort();
        Ok(names)
    }

    fn read(&mut self, name: &str) -> Result<String, LofError> {
        let file = self
            .files
            .get(name)
            .ok_or_else(|| fail_invalid("동기화 파일을 찾을 수 없습니다."))?;
        if file
            .size
            .as_ref()
            .and_then(|s| s.parse::<u64>().ok())
            .is_some_and(|s| s > MAX_SYNC_BYTES as u64)
        {
            return Err(fail_invalid("동기화 파일이 50MB를 초과합니다."));
        }
        let response = check_response(
            self.client
                .get(format!("{FILES_URL}/{}", file.id))
                .query(&[("alt", "media")])
                .bearer_auth(&self.token)
                .send()
                .map_err(network_error)?,
        )?;
        let mut bytes = Vec::new();
        response
            .take(MAX_SYNC_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid("동기화 파일이 50MB를 초과합니다."));
        }
        String::from_utf8(bytes)
            .map_err(|_| fail_invalid("Google Drive 동기화 파일이 올바른 UTF-8 문서가 아닙니다."))
    }

    fn write(&mut self, name: &str, content: &str) -> Result<(), LofError> {
        if !name_ok(name) || content.len() > MAX_SYNC_BYTES {
            return Err(fail_invalid(
                "동기화 파일 이름 또는 크기가 올바르지 않습니다.",
            ));
        }
        let (method, url, metadata) = match self.files.get(name) {
            Some(file) => (
                Method::PATCH,
                format!("{UPLOAD_URL}/{}", file.id),
                json!({}),
            ),
            None => (
                Method::POST,
                UPLOAD_URL.to_string(),
                json!({
                    "name": name, "mimeType": "application/json", "parents": [&self.root],
                }),
            ),
        };
        let response = check_response(
            self.client
                .request(method, url)
                .bearer_auth(&self.token)
                .query(&[("uploadType", "resumable"), ("fields", "id")])
                .header("X-Upload-Content-Type", "application/json")
                .header("X-Upload-Content-Length", content.len())
                .json(&metadata)
                .send()
                .map_err(network_error)?,
        )?;
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|url| reqwest::Url::parse(url).ok())
            .filter(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some("www.googleapis.com")
                    && url.port_or_known_default() == Some(443)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path().starts_with("/upload/drive/v3/files")
            })
            .ok_or_else(|| fail_invalid("Google Drive 업로드 주소를 확인하지 못했습니다."))?;
        check_response(
            self.client
                .put(location)
                .bearer_auth(&self.token)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(content.to_string())
                .send()
                .map_err(network_error)?,
        )?;
        Ok(())
    }

    fn remove(&mut self, name: &str) -> Result<(), LofError> {
        if !name_ok(name) { return Err(fail_invalid("잘못된 동기화 파일 이름")); }
        let Some(file)=self.files.get(name) else {return Ok(())};
        let response=self.client.delete(format!("{FILES_URL}/{}",file.id)).bearer_auth(&self.token)
            .send().map_err(network_error)?;
        if response.status().as_u16()!=404 {check_response(response)?;}
        self.files.remove(name);
        Ok(())
    }
}
