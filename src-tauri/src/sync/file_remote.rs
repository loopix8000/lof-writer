//! 파일 저장소에는 서재의 상대 경로와 파일 바이트를 그대로 유지한다.

use super::{validate_ftp_config, MAX_SYNC_BYTES};
use crate::error::{fail, fail_invalid, LofError};
use crate::store::{atomic_write_bytes, skipped_name, valid_rel};
use percent_encoding::percent_decode_str;
use reqwest::blocking::{Client, Response};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use suppaftp::{RustlsConnector, RustlsFtpStream};
use uuid::Uuid;

pub(super) const DIRECTORY: &str = "lof-writer-files-v1";
pub(crate) const ID_FILE: &str = ".lof-sync-id";
const MAX_FILES: usize = 40_000;

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Info {
    pub size: u64,
    pub modified: Option<i64>,
    pub etag: Option<String>,
    // 삭제와 읽기 실패를 구분한다. 이 경로의 이전 비교 기록은 유지한다.
    #[serde(default)]
    pub unavailable: bool,
}

impl Info {
    pub fn unavailable() -> Self { Self { unavailable: true, ..Self::default() } }
}

pub(crate) trait FileRemote {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError>;
    fn read(&mut self, path: &str) -> Result<Vec<u8>, LofError>;
    fn write(&mut self, path: &str, data: &[u8], previous: Option<&Info>) -> Result<(), LofError>;
    fn remove(&mut self, path: &str, previous: &Info) -> Result<(), LofError>;
    fn exists(&mut self, path: &str) -> Result<bool, LofError>;
    fn modified(&mut self, path: &str) -> Result<Option<i64>, LofError>;
    fn mkdir_new(&mut self, path: &str) -> Result<bool, LofError>;
    fn rmdir(&mut self, path: &str) -> Result<(), LofError>;
    fn rename(&mut self, from: &str, to: &str) -> Result<(), LofError>;
    fn heartbeat(&mut self) -> Result<(), LofError> {
        Ok(())
    }
    fn hash_etag(&self) -> bool {
        false
    }
    fn close(&mut self) {}
}

pub(crate) fn path_ok(path: &str) -> bool {
    valid_rel(path)
        && path.split('/').count() <= 64
        && path.split('/').all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            part.encode_utf16().count() <= 240
                && !part.ends_with([' ', '.'])
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}

pub(crate) fn included(path: &str) -> bool {
    path == ID_FILE
        || path
            .split('/')
            .all(|part| !skipped_name(part) && !part.eq_ignore_ascii_case("project.backup.json"))
}

pub(super) fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

// 존재하는 모든 조상을 확인하여 링크를 통한 서재·저장소 밖 접근을 거부한다.
pub(crate) fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, LofError> {
    if !path_ok(relative) {
        return Err(fail_invalid("동기화 파일 경로가 올바르지 않습니다."));
    }
    let mut target = root.to_path_buf();
    for part in std::iter::once("").chain(relative.split('/')) {
        if !part.is_empty() {
            target.push(part);
        }
        match fs::symlink_metadata(&target) {
            Ok(metadata) if linked(&metadata) => {
                return Err(fail_invalid(
                    "동기화 경로에 심볼릭 링크나 연결 폴더를 사용할 수 없습니다.",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(target)
}

fn insert(files: &mut BTreeMap<String, Info>, path: String, info: Info) -> Result<(), LofError> {
    if !path_ok(&path) || info.size > MAX_SYNC_BYTES as u64 || files.len() >= MAX_FILES {
        return Err(fail_invalid(
            "동기화 파일 경로·개수·크기를 확인해 주세요. 파일은 50MB 이하만 지원합니다.",
        ));
    }
    if files.insert(path, info).is_some() {
        return Err(fail_invalid("동기화 목록에 중복된 경로가 있습니다."));
    }
    Ok(())
}

pub(super) fn seconds(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_secs()).ok())
}

pub(crate) fn local_inventory(root: &Path) -> Result<BTreeMap<String, Info>, LofError> {
    // 상위 폴더는 내려오면서 이미 링크가 아님을 확인했으므로 항목마다 자기 자신만 확인한다.
    // 항목마다 모든 상위 경로를 다시 조회하면 파일 접근이 느린 저장소에서 목록 작성이 몇 배로 늘어난다.
    fn walk(dir: &str, directory: &Path, files: &mut BTreeMap<String, Info>) -> Result<(), LofError> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| fail_invalid("파일 이름을 UTF-8로 읽지 못했습니다."))?;
            let path = join(dir, &name);
            if !included(&path) {
                continue;
            }
            if !path_ok(&path) {
                return Err(fail_invalid("동기화 파일 경로가 올바르지 않습니다."));
            }
            let full = entry.path();
            let metadata = fs::symlink_metadata(&full)?;
            if linked(&metadata) {
                return Err(fail_invalid(
                    "동기화 경로에 심볼릭 링크나 연결 폴더를 사용할 수 없습니다.",
                ));
            }
            if metadata.is_dir() {
                walk(&path, &full, files)?;
            } else if metadata.is_file() {
                insert(
                    files,
                    path,
                    Info {
                        size: metadata.len(),
                        modified: metadata.modified().ok().and_then(seconds),
                        etag: None,
                        ..Info::default()
                    },
                )?;
            } else {
                return Err(fail_invalid(
                    "동기화 대상에 일반 파일이 아닌 항목이 있습니다.",
                ));
            }
        }
        Ok(())
    }
    if linked(&fs::symlink_metadata(root)?) {
        return Err(fail_invalid("서재 루트에 연결 폴더를 사용할 수 없습니다."));
    }
    let mut files = BTreeMap::new();
    walk("", root, &mut files)?;
    let mut folded = HashSet::new();
    if files.keys().any(|path| !folded.insert(path.to_lowercase())) {
        return Err(fail_invalid("대소문자만 다른 동기화 파일 경로가 있습니다."));
    }
    Ok(files)
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn bounded(mut reader: impl Read) -> Result<Vec<u8>, LofError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_SYNC_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SYNC_BYTES {
        return Err(fail_invalid("동기화 파일이 50MB를 초과합니다."));
    }
    Ok(bytes)
}

struct Folder {
    root: PathBuf,
}

impl FileRemote for Folder {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError> {
        local_inventory(&self.root)
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, LofError> {
        bounded(fs::File::open(safe_path(&self.root, path)?)?)
    }
    fn write(&mut self, path: &str, data: &[u8], _: Option<&Info>) -> Result<(), LofError> {
        atomic_write_bytes(&safe_path(&self.root, path)?, data)
    }
    fn remove(&mut self, path: &str, _: &Info) -> Result<(), LofError> {
        let target = safe_path(&self.root, path)?;
        // 직전에 확인한 파일 하나만 지운다. 디렉터리를 재귀 삭제하지 않는다.
        fs::remove_file(target)?;
        Ok(())
    }
    fn exists(&mut self, path: &str) -> Result<bool, LofError> {
        Ok(safe_path(&self.root, path)?.try_exists()?)
    }
    fn modified(&mut self, path: &str) -> Result<Option<i64>, LofError> {
        Ok(fs::metadata(safe_path(&self.root, path)?)?
            .modified()
            .ok()
            .and_then(seconds))
    }
    fn mkdir_new(&mut self, path: &str) -> Result<bool, LofError> {
        match fs::create_dir(safe_path(&self.root, path)?) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    fn rmdir(&mut self, path: &str) -> Result<(), LofError> {
        Ok(fs::remove_dir(safe_path(&self.root, path)?)?)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), LofError> {
        Ok(fs::rename(
            safe_path(&self.root, from)?,
            safe_path(&self.root, to)?,
        )?)
    }
}

#[derive(Default, Deserialize)]
struct MultiStatus {
    #[serde(default, rename = "response")]
    responses: Vec<DavResponse>,
}
#[derive(Deserialize)]
struct DavResponse {
    href: String,
    #[serde(default, rename = "propstat")]
    props: Vec<PropStat>,
}
#[derive(Deserialize)]
struct PropStat {
    status: String,
    prop: Properties,
}
#[derive(Default, Deserialize)]
struct Properties {
    #[serde(default)]
    resourcetype: ResourceType,
    getcontentlength: Option<u64>,
    getlastmodified: Option<String>,
    getetag: Option<String>,
}
#[derive(Default, Deserialize)]
struct ResourceType {
    collection: Option<()>,
}

struct WebDav {
    client: Client,
    root: Url,
    username: String,
    password: String,
}

impl WebDav {
    fn url(&self, path: &str) -> Result<Url, LofError> {
        if !path.is_empty() && !path_ok(path) {
            return Err(fail_invalid("WebDAV 파일 경로가 올바르지 않습니다."));
        }
        let mut url = self.root.clone();
        if !path.is_empty() {
            url.path_segments_mut()
                .map_err(|_| fail_invalid("WebDAV 주소 오류"))?
                .pop_if_empty()
                .extend(path.split('/'));
        }
        Ok(url)
    }
    fn request(&self, method: Method, url: Url) -> reqwest::blocking::RequestBuilder {
        self.client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password))
    }
    fn mkdir_url(&self, url: Url) -> Result<(), LofError> {
        let response = self
            .request(Method::from_bytes(b"MKCOL").unwrap(), url)
            .send()
            .map_err(net)?;
        if response.status().is_success() || response.status().as_u16() == 405 {
            Ok(())
        } else {
            Err(fail_invalid(format!(
                "WebDAV 폴더 생성 실패: {}",
                response.status()
            )))
        }
    }
    fn parents(&self, path: &str) -> Result<(), LofError> {
        let parts: Vec<_> = path.split('/').collect();
        for end in 1..parts.len() {
            self.mkdir_url(self.url(&parts[..end].join("/"))?)?;
        }
        Ok(())
    }
    fn list_dir(&self, directory: &str) -> Result<Vec<(String, bool, Info)>, LofError> {
        let mut url = self.url(directory)?;
        if !url.path().ends_with('/') {
            let path = format!("{}/", url.path());
            url.set_path(&path);
        }
        let response = self.request(Method::from_bytes(b"PROPFIND").unwrap(), url.clone())
            .header("Depth", "1").header("Content-Type", "application/xml; charset=utf-8")
            .body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>")
            .send().map_err(net)?;
        let response = success(response, "목록 조회")?;
        let bytes = bounded(response)?;
        let xml = std::str::from_utf8(&bytes)
            .map_err(|_| fail_invalid("WebDAV 목록의 문자 인코딩이 올바르지 않습니다."))?;
        let parsed: MultiStatus = quick_xml::de::from_str(xml)
            .map_err(|error| fail_invalid(format!("WebDAV 목록 형식 오류: {error}")))?;
        let parent = percent_decode_str(url.path())
            .decode_utf8()
            .map_err(|_| fail_invalid("WebDAV 경로 오류"))?;
        let mut result = Vec::new();
        for entry in parsed.responses {
            let child = url
                .join(&entry.href)
                .map_err(|_| fail_invalid("WebDAV 목록의 주소 오류"))?;
            if child.origin() != url.origin() {
                return Err(fail_invalid("WebDAV 목록에 다른 서버의 주소가 있습니다."));
            }
            let decoded = percent_decode_str(child.path())
                .decode_utf8()
                .map_err(|_| fail_invalid("WebDAV 파일 이름 오류"))?;
            if decoded.trim_end_matches('/') == parent.trim_end_matches('/') {
                continue;
            }
            let name = decoded
                .strip_prefix(parent.as_ref())
                .ok_or_else(|| fail_invalid("WebDAV 목록이 요청한 폴더를 벗어났습니다."))?
                .trim_end_matches('/');
            if name.is_empty() || name.contains('/') || !path_ok(name) {
                return Err(fail_invalid("WebDAV 목록의 하위 경로 오류"));
            }
            let mut info = Info::default();
            let mut directory = false;
            let mut found = false;
            for prop in entry.props {
                if prop.status.split_whitespace().nth(1) != Some("200") {
                    continue;
                }
                found = true;
                directory |= prop.prop.resourcetype.collection.is_some();
                if let Some(size) = prop.prop.getcontentlength {
                    info.size = size;
                }
                if let Some(tag) = prop.prop.getetag {
                    info.etag = Some(tag);
                }
                if let Some(time) = prop.prop.getlastmodified {
                    info.modified = chrono::DateTime::parse_from_rfc2822(&time)
                        .ok()
                        .map(|time| time.timestamp());
                }
            }
            if !found {
                return Err(fail_invalid("WebDAV 목록의 파일 정보를 읽지 못했습니다."));
            }
            result.push((name.to_string(), directory, info));
        }
        Ok(result)
    }
}

impl FileRemote for WebDav {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError> {
        let mut files = BTreeMap::new();
        let mut pending = vec![String::new()];
        let mut count = 0;
        while let Some(directory) = pending.pop() {
            count += 1;
            if count > MAX_FILES {
                return Err(fail_invalid("WebDAV 동기화 폴더가 너무 많습니다."));
            }
            for (name, is_dir, info) in self.list_dir(&directory)? {
                let path = join(&directory, &name);
                if !included(&path) {
                    continue;
                }
                if !path_ok(&path) {
                    return Err(fail_invalid("WebDAV 폴더 깊이 또는 경로 오류"));
                }
                if is_dir {
                    pending.push(path);
                } else {
                    insert(&mut files, path, info)?;
                }
            }
        }
        Ok(files)
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, LofError> {
        let response = self
            .request(Method::GET, self.url(path)?)
            .send()
            .map_err(net)?;
        bounded(success(response, "읽기")?)
    }
    fn write(&mut self, path: &str, data: &[u8], previous: Option<&Info>) -> Result<(), LofError> {
        self.parents(path)?;
        let mut request = self
            .request(Method::PUT, self.url(path)?)
            .header("Content-Type", "application/octet-stream");
        if let Some(tag) = previous
            .and_then(|info| info.etag.as_deref())
            .filter(|tag| !tag.starts_with("W/"))
        {
            request = request.header("If-Match", tag);
        } else if previous.is_none() {
            request = request.header("If-None-Match", "*");
        }
        success(request.body(data.to_vec()).send().map_err(net)?, "업로드")?;
        Ok(())
    }
    fn remove(&mut self, path: &str, previous: &Info) -> Result<(), LofError> {
        let mut request = self.request(Method::DELETE, self.url(path)?);
        if let Some(tag) = previous
            .etag
            .as_deref()
            .filter(|tag| !tag.starts_with("W/"))
        {
            request = request.header("If-Match", tag);
        }
        success(request.send().map_err(net)?, "삭제")?;
        Ok(())
    }
    fn exists(&mut self, path: &str) -> Result<bool, LofError> {
        let response = self
            .request(Method::HEAD, self.url(path)?)
            .send()
            .map_err(net)?;
        if response.status().as_u16() == 404 {
            Ok(false)
        } else {
            success(response, "파일 확인")?;
            Ok(true)
        }
    }
    fn mkdir_new(&mut self, path: &str) -> Result<bool, LofError> {
        let response = self
            .request(Method::from_bytes(b"MKCOL").unwrap(), self.url(path)?)
            .send()
            .map_err(net)?;
        if response.status().as_u16() == 405 {
            Ok(false)
        } else {
            success(response, "잠금 폴더 생성")?;
            Ok(true)
        }
    }
    fn modified(&mut self, path: &str) -> Result<Option<i64>, LofError> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        Ok(self
            .list_dir(parent)?
            .into_iter()
            .find(|(candidate, _, _)| candidate == name)
            .and_then(|(_, _, info)| info.modified))
    }
    fn rmdir(&mut self, path: &str) -> Result<(), LofError> {
        self.remove(path, &Info::default())
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), LofError> {
        success(
            self.request(Method::from_bytes(b"MOVE").unwrap(), self.url(from)?)
                .header("Destination", self.url(to)?.as_str())
                .header("Overwrite", "F")
                .send()
                .map_err(net)?,
            "잠금 이동",
        )?;
        Ok(())
    }
}

fn net(_: reqwest::Error) -> LofError {
    fail(
        "WebDAV 서버에 연결하지 못했습니다. 주소와 실행 상태를 확인해 주세요.",
        "SYNC_OFFLINE",
    )
}
fn success(response: Response, action: &str) -> Result<Response, LofError> {
    if response.status().as_u16() == 412 {
        return Err(fail(
            "전송 도중 파일이 변경되었습니다. 다음 주기에 다시 확인합니다.",
            "SYNC_RETRY",
        ));
    }
    if !response.status().is_success() {
        return Err(fail_invalid(format!(
            "WebDAV {action} 실패: {}",
            response.status()
        )));
    }
    Ok(response)
}

struct Ftp {
    stream: RustlsFtpStream,
    root: String,
}

impl Ftp {
    fn path(&self, path: &str) -> Result<String, LofError> {
        if !path.is_empty() && !path_ok(path) {
            return Err(fail_invalid("FTP 파일 경로 오류"));
        }
        Ok(format!("{}/{}", self.root.trim_end_matches('/'), path))
    }
    fn parents(&mut self, path: &str) -> Result<(), LofError> {
        let parts: Vec<_> = path.split('/').collect();
        for end in 1..parts.len() {
            let directory = self.path(&parts[..end].join("/"))?;
            if self.stream.cwd(&directory).is_err() {
                self.stream.mkdir(&directory).map_err(ftp_error)?;
                self.stream.cwd(&directory).map_err(ftp_error)?;
            }
        }
        self.stream.cwd(&self.root).map_err(ftp_error)?;
        Ok(())
    }
    fn list_dir(&mut self, directory: &str) -> Result<Vec<(String, bool, Info)>, LofError> {
        let path = self.path(directory)?;
        if let Ok(lines) = self.stream.mlsd(Some(&path)) {
            let mut result = Vec::new();
            for line in lines {
                let (facts, name) = line
                    .split_once(' ')
                    .ok_or_else(|| fail_invalid("FTP MLSD 목록 형식 오류"))?;
                let facts: BTreeMap<_, _> = facts
                    .split(';')
                    .filter_map(|fact| fact.split_once('='))
                    .map(|(key, value)| (key.to_ascii_lowercase(), value.to_string()))
                    .collect();
                let kind = facts
                    .get("type")
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_default();
                if matches!(kind.as_str(), "cdir" | "pdir") {
                    continue;
                }
                if !matches!(kind.as_str(), "dir" | "file") {
                    return Err(fail_invalid(
                        "FTP 목록에 지원하지 않는 파일 종류가 있습니다.",
                    ));
                }
                let modified = facts
                    .get("modify")
                    .and_then(|time| {
                        chrono::NaiveDateTime::parse_from_str(time, "%Y%m%d%H%M%S%.f").ok()
                    })
                    .map(|time| time.and_utc().timestamp());
                let size = if kind == "dir" {
                    0
                } else {
                    facts
                        .get("size")
                        .and_then(|size| size.parse().ok())
                        .ok_or_else(|| fail_invalid("FTP 파일 크기를 확인하지 못했습니다."))?
                };
                result.push((
                    name.to_string(),
                    kind == "dir",
                    Info {
                        size,
                        modified,
                        etag: None,
                        ..Info::default()
                    },
                ));
            }
            return Ok(result);
        }
        let mut result = Vec::new();
        for line in self.stream.list(Some(&path)).map_err(ftp_error)? {
            let entry: suppaftp::list::File = line
                .parse()
                .map_err(|_| fail_invalid("FTP LIST 목록 형식 오류"))?;
            if matches!(entry.name(), "." | "..") {
                continue;
            }
            if entry.is_symlink() {
                return Err(fail_invalid(
                    "FTP 동기화 폴더에 심볼릭 링크를 사용할 수 없습니다.",
                ));
            }
            result.push((
                entry.name().to_string(),
                entry.is_directory(),
                Info {
                    size: entry.size() as u64,
                    modified: seconds(entry.modified()),
                    etag: None,
                    ..Info::default()
                },
            ));
        }
        Ok(result)
    }
}

impl FileRemote for Ftp {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError> {
        let mut files = BTreeMap::new();
        let mut pending = vec![String::new()];
        let mut count = 0;
        while let Some(directory) = pending.pop() {
            count += 1;
            if count > MAX_FILES {
                return Err(fail_invalid("FTP 동기화 폴더가 너무 많습니다."));
            }
            for (name, is_dir, info) in self.list_dir(&directory)? {
                if name.contains('/') || !path_ok(&name) {
                    return Err(fail_invalid("FTP 목록의 파일 경로 오류"));
                }
                let path = join(&directory, &name);
                if !included(&path) {
                    continue;
                }
                if !path_ok(&path) {
                    return Err(fail_invalid("FTP 폴더 깊이 또는 경로 오류"));
                }
                if is_dir {
                    pending.push(path);
                } else {
                    insert(&mut files, path, info)?;
                }
            }
        }
        Ok(files)
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, LofError> {
        let path = self.path(path)?;
        let result = self.stream.retr(&path, |reader| {
            bounded(reader).map_err(|error| {
                suppaftp::FtpError::ConnectionError(std::io::Error::other(error.message))
            })
        });
        result.map_err(ftp_error)
    }
    fn write(&mut self, path: &str, data: &[u8], previous: Option<&Info>) -> Result<(), LofError> {
        self.parents(path)?;
        let destination = self.path(path)?;
        let temporary = format!("{}.{}.tmp", destination, Uuid::new_v4());
        self.stream
            .put_file(&temporary, &mut Cursor::new(data))
            .map_err(ftp_error)?;
        // 서버의 이름 변경으로 교체한다. 먼저 기존 파일을 지우지 않는다.
        if let Err(error) = self.stream.rename(&temporary, &destination) {
            if previous.is_none() {
                return Err(ftp_error(error));
            }
            // 덮어쓰는 이름 변경을 거부하는 서버에서는 기존 파일을 옆으로 옮겨 보존한다.
            let backup = format!("{}.{}.lofmv", destination, Uuid::new_v4());
            self.stream
                .rename(&destination, &backup)
                .map_err(ftp_error)?;
            if let Err(error) = self.stream.rename(&temporary, &destination) {
                let _ = self.stream.rename(&backup, &destination);
                return Err(ftp_error(error));
            }
            self.stream.rm(&backup).map_err(ftp_error)?;
        }
        Ok(())
    }
    fn remove(&mut self, path: &str, _: &Info) -> Result<(), LofError> {
        let path = self.path(path)?;
        self.stream.rm(&path).map_err(ftp_error)
    }
    fn exists(&mut self, path: &str) -> Result<bool, LofError> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        Ok(self
            .list_dir(parent)?
            .iter()
            .any(|(candidate, _, _)| candidate == name))
    }
    fn modified(&mut self, path: &str) -> Result<Option<i64>, LofError> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        Ok(self
            .list_dir(parent)?
            .into_iter()
            .find(|(candidate, _, _)| candidate == name)
            .and_then(|(_, _, info)| info.modified))
    }
    fn mkdir_new(&mut self, path: &str) -> Result<bool, LofError> {
        let target = self.path(path)?;
        match self.stream.mkdir(&target) {
            Ok(()) => Ok(true),
            Err(_) if self.exists(path)? => Ok(false),
            Err(error) => Err(ftp_error(error)),
        }
    }
    fn rmdir(&mut self, path: &str) -> Result<(), LofError> {
        let path = self.path(path)?;
        self.stream.rmdir(path).map_err(ftp_error)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), LofError> {
        let (from, to) = (self.path(from)?, self.path(to)?);
        self.stream.rename(from, to).map_err(ftp_error)
    }
    fn close(&mut self) {
        let _ = self.stream.quit();
    }
}

const LOCK: &str = ".lof-sync-lock";
const OWNER: &str = ".lof-sync-lock/owner";

/// 같은 저장소를 쓰는 Writer끼리는 파일 묶음의 받기·보내기를 겹치지 않게 한다.
struct LockedRemote {
    inner: Box<dyn FileRemote>,
    owner: String,
    touched: Instant,
    held: bool,
    closed: bool,
}

fn now() -> i64 {
    seconds(SystemTime::now()).unwrap_or(0)
}
fn lock_busy() -> LofError {
    fail(
        "다른 기기에서 동기화 중입니다. 잠시 후 다시 시도합니다.",
        "SYNC_BUSY",
    )
}

impl LockedRemote {
    fn acquire(mut inner: Box<dyn FileRemote>) -> Result<Self, LofError> {
        if !inner.mkdir_new(LOCK)? {
            let timestamp = match inner.read(OWNER) {
                Ok(raw) => std::str::from_utf8(&raw)
                    .ok()
                    .and_then(|raw| raw.split_once('\n'))
                    .and_then(|(_, timestamp)| timestamp.parse::<i64>().ok()),
                Err(_) => None,
            };
            // 최초 소유자 기록 전에 종료된 빈 잠금도 폴더 수정 시각으로 회수한다.
            let timestamp = match timestamp {
                Some(timestamp) => timestamp,
                None => inner.modified(LOCK)?.ok_or_else(lock_busy)?,
            };
            if now().saturating_sub(timestamp) < 300 {
                return Err(lock_busy());
            }
            // 만료된 잠금을 다른 경로로 옮긴 뒤 새로 확보한다. 원본 파일에는 손대지 않는다.
            let stale = format!(".lof-sync-stale-{}", Uuid::new_v4());
            inner.rename(LOCK, &stale)?;
            // 중단된 임시 파일이 남아 있을 수 있어 격리한 폴더를 재귀 삭제하지 않는다.
            if !inner.mkdir_new(LOCK)? {
                return Err(lock_busy());
            }
        }
        let owner = Uuid::new_v4().to_string();
        inner.write(OWNER, format!("{owner}\n{}", now()).as_bytes(), None)?;
        let mut result = Self {
            inner,
            owner,
            touched: Instant::now(),
            held: true,
            closed: false,
        };
        result.touch(true)?;
        Ok(result)
    }
    fn touch(&mut self, force: bool) -> Result<(), LofError> {
        if !self.held {
            return Err(lock_busy());
        }
        if !force && self.touched.elapsed() < Duration::from_secs(15) {
            return Ok(());
        }
        let raw = self.inner.read(OWNER)?;
        if !raw.starts_with(format!("{}\n", self.owner).as_bytes()) {
            self.held = false;
            return Err(lock_busy());
        }
        self.inner.write(
            OWNER,
            format!("{}\n{}", self.owner, now()).as_bytes(),
            Some(&Info::default()),
        )?;
        self.touched = Instant::now();
        Ok(())
    }
    fn unlock(&mut self) -> Result<(), LofError> {
        if !self.held {
            return Ok(());
        }
        self.touch(true)?;
        self.inner.remove(OWNER, &Info::default())?;
        self.inner.rmdir(LOCK)?;
        self.held = false;
        Ok(())
    }
}

impl FileRemote for LockedRemote {
    fn inventory(&mut self) -> Result<BTreeMap<String, Info>, LofError> {
        self.touch(false)?;
        let result = self.inner.inventory()?;
        self.touch(true)?;
        Ok(result)
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, LofError> {
        self.touch(false)?;
        self.inner.read(path)
    }
    fn write(&mut self, path: &str, data: &[u8], previous: Option<&Info>) -> Result<(), LofError> {
        self.touch(false)?;
        self.inner.write(path, data, previous)
    }
    fn remove(&mut self, path: &str, previous: &Info) -> Result<(), LofError> {
        self.touch(false)?;
        self.inner.remove(path, previous)
    }
    fn exists(&mut self, path: &str) -> Result<bool, LofError> {
        self.touch(false)?;
        self.inner.exists(path)
    }
    fn modified(&mut self, path: &str) -> Result<Option<i64>, LofError> {
        self.touch(false)?;
        self.inner.modified(path)
    }
    fn mkdir_new(&mut self, path: &str) -> Result<bool, LofError> {
        self.touch(false)?;
        self.inner.mkdir_new(path)
    }
    fn rmdir(&mut self, path: &str) -> Result<(), LofError> {
        self.touch(false)?;
        self.inner.rmdir(path)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), LofError> {
        self.touch(false)?;
        self.inner.rename(from, to)
    }
    fn heartbeat(&mut self) -> Result<(), LofError> {
        self.touch(false)
    }
    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Err(error) = self.unlock() {
            eprintln!(
                "동기화 저장소 잠금을 해제하지 못했습니다: {}",
                error.message
            );
        }
        self.inner.close();
    }
}

impl Drop for LockedRemote {
    fn drop(&mut self) {
        self.close();
    }
}

pub(super) fn lock(remote: Box<dyn FileRemote>) -> Result<Box<dyn FileRemote>, LofError> {
    Ok(Box::new(LockedRemote::acquire(remote)?))
}

fn ftp_error(_: suppaftp::FtpError) -> LofError {
    fail(
        "FTP 파일 작업에 실패했습니다. 서버 주소·권한·연결 상태를 확인해 주세요.",
        "SYNC_FTP",
    )
}

pub(super) fn connect(config: &Value, vault: &Path) -> Result<Box<dyn FileRemote>, LofError> {
    match config["type"].as_str() {
        Some("folder") => {
            let folder = config["folder"]
                .as_str()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| fail_invalid("동기화 폴더를 선택해 주세요."))?;
            let base = fs::canonicalize(folder)?;
            let root = safe_path(&base, DIRECTORY)?;
            let vault = fs::canonicalize(vault)?;
            if root.starts_with(&vault) || vault.starts_with(&root) {
                return Err(fail_invalid(
                    "서재 안이나 서재를 포함하는 경로를 동기화 저장소로 사용할 수 없습니다.",
                ));
            }
            fs::create_dir_all(&root)?;
            Ok(Box::new(Folder { root }))
        }
        Some("webdav") => {
            let mut root = Url::parse(config["url"].as_str().unwrap_or(""))
                .map_err(|_| fail_invalid("WebDAV 주소 오류"))?;
            if !matches!(root.scheme(), "http" | "https")
                || root.host_str().is_none()
                || !root.username().is_empty()
                || root.password().is_some()
                || root.query().is_some()
                || root.fragment().is_some()
            {
                return Err(fail_invalid("WebDAV 주소를 확인해 주세요."));
            }
            let remote_path = config["remotePath"]
                .as_str()
                .unwrap_or("")
                .trim_matches('/');
            if !remote_path.is_empty() && !path_ok(remote_path) {
                return Err(fail_invalid("WebDAV 저장 경로 오류"));
            }
            let username = config["username"].as_str().unwrap_or("").to_string();
            let password = config["password"].as_str().unwrap_or("").to_string();
            let client = Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(net)?;
            let mut paths: Vec<String> = if remote_path.is_empty() {
                Vec::new()
            } else {
                remote_path.split('/').map(str::to_string).collect()
            };
            paths.push(DIRECTORY.to_string());
            for part in paths {
                root.path_segments_mut()
                    .map_err(|_| fail_invalid("WebDAV 주소 오류"))?
                    .pop_if_empty()
                    .push(&part);
                let temporary = WebDav {
                    client: client.clone(),
                    root: root.clone(),
                    username: username.clone(),
                    password: password.clone(),
                };
                temporary.mkdir_url(root.clone())?;
            }
            Ok(Box::new(WebDav {
                client,
                root,
                username,
                password,
            }))
        }
        Some("ftp") => {
            validate_ftp_config(config)?;
            let host = config["host"]
                .as_str()
                .filter(|host| !host.is_empty())
                .ok_or_else(|| fail_invalid("FTP 호스트가 필요합니다."))?;
            let port = config["port"]
                .as_u64()
                .filter(|port| (1..=65535).contains(port))
                .unwrap_or(21);
            let mut stream = RustlsFtpStream::connect((host, port as u16)).map_err(ftp_error)?;
            stream
                .get_ref()
                .set_read_timeout(Some(Duration::from_secs(30)))?;
            stream
                .get_ref()
                .set_write_timeout(Some(Duration::from_secs(30)))?;
            if config["secure"].as_bool().unwrap_or(false) {
                let mut roots = suppaftp::rustls::RootCertStore::empty();
                for certificate in rustls_native_certs::load_native_certs().certs {
                    let _ = roots.add(certificate);
                }
                let tls = suppaftp::rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth();
                stream = stream
                    .into_secure(RustlsConnector::from(std::sync::Arc::new(tls)), host)
                    .map_err(ftp_error)?;
            }
            stream
                .login(
                    config["username"].as_str().unwrap_or("anonymous"),
                    config["password"].as_str().unwrap_or(""),
                )
                .map_err(ftp_error)?;
            stream
                .transfer_type(suppaftp::types::FileType::Binary)
                .map_err(ftp_error)?;
            let remote = config["remotePath"].as_str().unwrap_or("/");
            if !remote.trim_matches('/').is_empty() && !path_ok(remote.trim_matches('/')) {
                return Err(fail_invalid("FTP 저장 경로 오류"));
            }
            if remote.starts_with('/') {
                stream.cwd("/").map_err(ftp_error)?;
            }
            for part in remote
                .split('/')
                .filter(|part| !part.is_empty())
                .chain(std::iter::once(DIRECTORY))
            {
                if stream.cwd(part).is_err() {
                    stream.mkdir(part).map_err(ftp_error)?;
                    stream.cwd(part).map_err(ftp_error)?;
                }
            }
            let root = stream.pwd().map_err(ftp_error)?;
            Ok(Box::new(Ftp { stream, root }))
        }
        _ => Err(fail_invalid("파일 저장소 연결 방식을 확인해 주세요.")),
    }
}
