use crate::assets::{normalize_tags, valid_cover, validate_cover};
use crate::episode::{
    check_meta_patch, custom_properties, line_break_default, normalize_document_meta, normalize_meta,
    normalize_status, normalize_status_val, status_token, stored_document_meta, stored_meta,
    DOCUMENT_META_FIELDS, LEGACY_STATUSES, META_FIELDS, STATUSES,
};
use crate::error::{
    fail, fail_invalid, hash_bytes, hash_str, now_iso, slice_utf16, sys_time_to_iso, utf16_len, valid_id,
    LofError,
};
use crate::file_index::{Catalog, CatalogProject, FileIndex, IndexedFileRecord};
use crate::markdown::{
    document_properties, markdown_entry, markdown_entry_with_parsed, read_markdown,
    read_markdown_body, write_markdown, write_properties,
};
use crate::platforms::normalize_writing;
use crate::text::{character_count, count_for_writing, manuscript_stats};
use base64::Engine;
use chrono::DateTime;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const FORMAT: i64 = 2;
pub const FOLDERS: &[&str] = &["assets", "doc", "episodes"];
pub const KINDS: &[&str] = &["episode", "plot", "memo"];
pub(crate) const SYNC_HOLD_MESSAGE: &str = "원고 충돌 정리가 끝날 때까지 전송을 보류합니다.";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SyncConflictPolicy {
    KeepBoth,
    Latest,
}

fn sync_remote_is_newer(remote: &Value, local: &Value, remote_hash: &str, local_hash: &str) -> bool {
    let modified = |value: &Value| value.get("updatedAt").and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok());
    // 수정 시각이 같으면 내용 해시로 순서를 고정해 기기마다 다른 본문을 고르지 않는다.
    (modified(remote), remote_hash) > (modified(local), local_hash)
}

static CHANGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CHANGED_PATHS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
static APP_WRITES: OnceLock<Mutex<HashMap<PathBuf, (String, SystemTime)>>> = OnceLock::new();
const EXTERNAL_WRITE_DELAY: Duration = Duration::from_secs(1);

fn app_writes() -> &'static Mutex<HashMap<PathBuf, (String, SystemTime)>> {
    APP_WRITES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_app_write(file: &Path, raw: &str, stat: &fs::Metadata) -> bool {
    app_writes().lock().unwrap().get(file).is_some_and(|(hash, modified)| {
        stat.modified().ok() == Some(*modified) && *hash == hash_str(raw)
    })
}

fn same_file_state(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
        && a.created().ok() == b.created().ok()
}

// 외부 편집기의 연속 쓰기와 임시 파일 교체가 끝난 뒤에만 내용을 관찰한다.
fn read_document_file(file: &Path) -> Result<(String, fs::Metadata), LofError> {
    let before = fs::metadata(file)?;
    let raw = fs::read_to_string(file)?;
    let after = fs::metadata(file)?;
    let modified = after.modified()?;
    if !same_file_state(&before, &after) || after.len() != raw.len() as u64
        || (!is_app_write(file, &raw, &after)
            && modified.elapsed().is_ok_and(|age| age < EXTERNAL_WRITE_DELAY))
    {
        return Err(fail("외부 편집기가 파일을 저장 중입니다. 잠시 후 다시 확인합니다.", "FILE_BUSY"));
    }
    Ok((raw, after))
}

fn changed_paths_map() -> &'static Mutex<HashMap<PathBuf, u64>> {
    CHANGED_PATHS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn record_change(file: &Path) {
    let s = file.to_string_lossy();
    let lower = s.to_ascii_lowercase();
    if lower.ends_with(".tmp") || lower.ends_with(".lofmv") || lower.ends_with(".lofnew") {
        return;
    }
    if file
        .components()
        .any(|c| c.as_os_str().to_string_lossy() == ".lof")
    {
        return;
    }
    let seq = CHANGE_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut map) = changed_paths_map().lock() {
        map.insert(file.to_path_buf(), seq);
    }
}

pub fn atomic_write_bytes(file: &Path, data: &[u8]) -> Result<(), LofError> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_name = format!(
        "{}.{}.tmp",
        file.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        Uuid::new_v4()
    );
    let temp = file.with_file_name(temp_name);
    let res = (|| -> Result<(), LofError> {
        {
            let mut handle = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            handle.write_all(data)?;
            handle.sync_all()?;
        }
        rename_with_retry(&temp, file)?;
        if file.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| {
            ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("lofnew")
        }) && !file.components().any(|part| part.as_os_str() == ".lof") {
            if let Ok(modified) = fs::metadata(file).and_then(|stat| stat.modified()) {
                app_writes().lock().unwrap().insert(file.to_path_buf(), (hash_bytes(data), modified));
            }
        }
        record_change(file);
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    res
}

pub fn atomic_write_str(file: &Path, data: &str) -> Result<(), LofError> {
    atomic_write_bytes(file, data.as_bytes())
}

pub fn changed_chars(a: &str, b: &str) -> usize {
    let au: Vec<u16> = a.encode_utf16().collect();
    let bu: Vec<u16> = b.encode_utf16().collect();
    let max = au.len().min(bu.len());
    let mut start = 0;
    while start < max && au[start] == bu[start] {
        start += 1;
    }
    let mut end = 0;
    while end < max - start && au[au.len() - 1 - end] == bu[bu.len() - 1 - end] {
        end += 1;
    }
    au.len().max(bu.len()) - start - end
}

pub fn rename_with_retry(from: &Path, to: &Path) -> Result<(), LofError> {
    let mut i = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => {
                let mut writes = app_writes().lock().unwrap();
                if let Some(written) = writes.remove(from) {
                    writes.insert(to.to_path_buf(), written);
                } else {
                    writes.remove(to);
                }
                drop(writes);
                record_change(from);
                record_change(to);
                return Ok(());
            }
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Other
                );
                if i >= 4 || !retryable {
                    return Err(LofError::from(e));
                }
                i += 1;
                thread::sleep(Duration::from_millis(80 * i));
            }
        }
    }
}

pub fn pad(n: i64) -> String {
    format!("{:03}", n)
}

pub fn abs(dir: &Path, rel: &str) -> PathBuf {
    let mut p = dir.to_path_buf();
    for part in rel.split('/') {
        if !part.is_empty() {
            p.push(part);
        }
    }
    p
}

pub fn folder_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[..idx],
        None => "",
    }
}

pub fn base_name(rel: &str) -> String {
    let name = match rel.rfind('/') {
        Some(idx) => &rel[idx + 1..],
        None => rel,
    };
    if name.len() >= 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md") {
        name[..name.len() - 3].to_string()
    } else {
        name.to_string()
    }
}

pub fn valid_rel(rel: &str) -> bool {
    let ulen = utf16_len(rel);
    if ulen == 0 || ulen >= 1000 || rel.contains('\\') || Path::new(rel).is_absolute() {
        return false;
    }
    rel.split('/').all(|s| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s.chars().any(|c| {
                matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) <= 0x1f
            })
    })
}

pub fn safe_name(title: &str, fallback: &str) -> String {
    let nfc: String = title.nfc().collect();
    let replaced: String = nfc
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (c as u32) <= 0x1f
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut collapsed = String::new();
    let mut prev_ws = false;
    for c in replaced.trim().chars() {
        if c.is_whitespace() {
            if !prev_ws {
                collapsed.push(' ');
                prev_ws = true;
            }
        } else {
            collapsed.push(c);
            prev_ws = false;
        }
    }
    let mut name: String = collapsed.chars().take(80).collect();
    name = name.trim_end_matches(|c| c == '.' || c == ' ').trim().to_string();
    if name.is_empty() {
        name = fallback.to_string();
    }
    static RESERVED_RE: OnceLock<Regex> = OnceLock::new();
    let re = RESERVED_RE
        .get_or_init(|| Regex::new(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$").unwrap());
    if re.is_match(&name) {
        name = format!("_{}", name);
    }
    name
}

pub fn unique_name(want: &str, ext: &str, taken: &mut HashSet<String>) -> String {
    let base = &want[..want.len().saturating_sub(ext.len())];
    let mut candidate = want.to_string();
    let mut n = 2;
    while taken.contains(&candidate.to_lowercase()) {
        candidate = format!("{} ({}){}", base, n, ext);
        n += 1;
    }
    taken.insert(candidate.to_lowercase());
    candidate
}

pub fn is_variant(cur: &str, want: &str, ext: &str) -> bool {
    if cur == want {
        return true;
    }
    let base = &want[..want.len().saturating_sub(ext.len())];
    if !cur.starts_with(base) || !cur.ends_with(ext) || cur.len() <= base.len() + ext.len() {
        return false;
    }
    let mid = &cur[base.len()..cur.len() - ext.len()];
    mid.starts_with(" (")
        && mid.ends_with(')')
        && mid[2..mid.len() - 1].chars().all(|c| c.is_ascii_digit())
}

pub fn skipped_name(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    name.starts_with('.') || low.ends_with(".tmp") || low.ends_with(".lofmv") || low.ends_with(".lofnew")
}

pub(crate) type DiskInventory = HashMap<PathBuf, (u64, Option<SystemTime>, Option<SystemTime>, bool)>;

// 본문을 읽지 않고 파일 목록과 메타데이터만 수집한다. 심볼릭 링크와 관리·임시 파일은 제외한다.
pub(crate) fn disk_inventory(root: &Path) -> Result<DiskInventory, LofError> {
    fn walk(root: &Path, dir: &Path, files: &mut DiskInventory) -> std::io::Result<()> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if dir != root && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            if skipped_name(&entry.file_name().to_string_lossy()) { continue; }
            let kind = entry.file_type()?;
            if !kind.is_dir() && !kind.is_file() { continue; }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let path = entry.path();
            files.insert(path.strip_prefix(root).unwrap_or(&path).to_path_buf(),
                (metadata.len(), metadata.modified().ok(), metadata.created().ok(), kind.is_dir()));
            if kind.is_dir() { walk(root, &path, files)?; }
        }
        Ok(())
    }
    let mut files = HashMap::new();
    walk(root, root, &mut files)?;
    Ok(files)
}

pub fn walk_rel(dir: &Path, rel: &str) -> Vec<String> {
    let mut files = Vec::new();
    let target = abs(dir, rel);
    let Ok(rd) = fs::read_dir(target) else {
        return files;
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if skipped_name(&name) {
            continue;
        }
        let r = format!("{}/{}", rel, name);
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            files.extend(walk_rel(dir, &r));
        } else if ft.is_file() {
            files.push(r);
        }
    }
    files
}

pub fn by_order_cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    let oa = a.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ob = b.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
    oa.partial_cmp(&ob)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            let ca = a.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
            let cb = b.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
            ca.cmp(cb)
        })
        .then_with(|| {
            let ia = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let ib = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
            ia.cmp(ib)
        })
}

pub fn memo_id(project_id: &str, rel: &str) -> String {
    let nfc: String = rel.nfc().collect();
    let h = hash_str(&format!("{}\n{}", project_id, nfc.to_lowercase()));
    format!("m{}", &h[..40])
}

pub fn fingerprint(d: &Value, body: &str) -> String {
    let kind = d.get("kind").and_then(|v| v.as_str()).unwrap_or("episode");
    let meta = if kind == "episode" {
        stored_meta(Some(d))
    } else {
        stored_document_meta(Some(d))
    };
    let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let status = status_token(d.get("status").and_then(|v| v.as_str()));
    let order = d.get("order").cloned().unwrap_or(json!(0));
    let archived = d.get("archived").and_then(|v| v.as_bool()).unwrap_or(false);
    let ep_id = d
        .get("episodeId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    let path_val = if kind != "episode" {
        let p = d
            .get("path")
            .or_else(|| d.get("relPath"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        Value::String(p.to_lowercase())
    } else {
        Value::Null
    };

    let mut arr = vec![
        json!(kind),
        json!(title),
        json!(status),
        order,
        json!(archived),
        ep_id,
        path_val,
    ];
    if !meta.is_empty() {
        arr.push(Value::Object(meta));
    }
    if let Some(props) = d.get("properties").and_then(|v| v.as_object()) {
        if !props.is_empty() {
            arr.push(Value::Object(props.clone()));
        }
    }
    let json_arr = serde_json::to_string(&Value::Array(arr)).unwrap_or_default();
    hash_str(&format!("{}\n{}", json_arr, body))
}

pub fn match_lines(
    body: &str,
    query: &str,
    case_sensitive: bool,
    max: usize,
) -> (Vec<Value>, bool) {
    let norm = |t: &str| -> String {
        if case_sensitive {
            t.to_string()
        } else {
            t.to_lowercase()
        }
    };
    let needle = norm(query);
    if needle.is_empty() {
        return (Vec::new(), false);
    }
    let hay = norm(body);
    // 검색어가 없는 문서는 위치 계산용 UTF-16 변환을 하지 않는다.
    if !hay.contains(needle.as_str()) {
        return (Vec::new(), false);
    }
    let body_u16: Vec<u16> = body.encode_utf16().collect();
    let hay_u16: Vec<u16> = hay.encode_utf16().collect();
    let needle_u16: Vec<u16> = needle.encode_utf16().collect();
    if needle_u16.is_empty() || hay_u16.len() < needle_u16.len() {
        return (Vec::new(), false);
    }

    let mut matches = Vec::new();
    let mut line: usize = 1;
    let mut scanned: usize = 0;
    let mut index: usize = 0;
    let mut pos: usize = 0;

    while pos + needle_u16.len() <= hay_u16.len() {
        let Some(rel_at) = hay_u16[pos..]
            .windows(needle_u16.len())
            .position(|w| w == needle_u16.as_slice())
        else {
            break;
        };
        let at = pos + rel_at;
        if matches.len() >= max {
            return (matches, true);
        }
        for &ch in &body_u16[scanned..at.min(body_u16.len())] {
            if ch == b'\n' as u16 {
                line += 1;
            }
        }
        scanned = at;
        let line_start = body_u16[..at.min(body_u16.len())]
            .iter()
            .rposition(|&c| c == b'\n' as u16)
            .map(|i| i + 1)
            .unwrap_or(0);
        let line_end = body_u16[at.min(body_u16.len())..]
            .iter()
            .position(|&c| c == b'\n' as u16)
            .map(|i| at + i)
            .unwrap_or(body_u16.len());

        let from = line_start.max(at.saturating_sub(40));
        let to = line_end.min(at + needle_u16.len() + 100);
        let cut = if from > line_start { "…" } else { "" };
        let cut_len = if from > line_start { 1 } else { 0 };
        let slice_str = String::from_utf16_lossy(&body_u16[from..to.min(body_u16.len())]);
        matches.push(json!({
            "index": index,
            "line": line,
            "text": format!("{}{}", cut, slice_str),
            "start": cut_len + at - from,
            "length": needle_u16.len(),
        }));
        index += 1;
        pos = at + needle_u16.len();
    }

    (matches, false)
}

pub fn project_tombstone(id: &str) -> String {
    format!("p-{}", id)
}

const PROJECT_FIELDS: &[&str] = &[
    "id",
    "index",
    "title",
    "description",
    "tags",
    "writing",
    "manualLineBreak",
    "archivedDocFolders",
    "cover",
    "createdAt",
    "updatedAt",
];

pub fn project_fields(p: &Value) -> Value {
    let mut out = Map::new();
    if let Some(obj) = p.as_object() {
        for &k in PROJECT_FIELDS {
            if let Some(v) = obj.get(k) {
                if !v.is_null() || k == "cover" {
                    out.insert(k.to_string(), v.clone());
                }
            }
        }
    }
    out.entry("archivedDocFolders").or_insert_with(|| json!([]));
    Value::Object(out)
}

fn public_project(p: &CatalogProject) -> Value {
    let mut pf = project_fields(&p.project);
    let folder = p
        .dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(obj) = pf.as_object_mut() {
        obj.insert("folder".to_string(), json!(folder));
    }
    pf
}

pub(crate) fn parse_project(raw: &str) -> Result<Value, LofError> {
    let mut p: Value = serde_json::from_str(raw)
        .map_err(|_| fail("작품 정보 형식이 올바르지 않습니다.", "FORMAT"))?;
    let Some(obj) = p.as_object_mut() else {
        return Err(fail("작품 정보 형식이 올바르지 않습니다.", "FORMAT"));
    };
    if obj.get("format").and_then(|v| v.as_i64()) != Some(FORMAT)
        || !obj.get("id").and_then(|v| v.as_str()).is_some_and(valid_id)
        || !obj.get("documents").is_some_and(|v| v.is_array())
    {
        return Err(fail("작품 정보 형식이 올바르지 않습니다.", "FORMAT"));
    }

    static NUM_PREFIX_RE: OnceLock<Regex> = OnceLock::new();
    let num_re = NUM_PREFIX_RE.get_or_init(|| Regex::new(r"^\d+\s+").unwrap());

    let mut ids = HashSet::new();
    if let Some(docs) = obj.get_mut("documents").and_then(|v| v.as_array_mut()) {
        for d in docs {
            let Some(dobj) = d.as_object_mut() else {
                return Err(fail("작품 정보의 문서 목록이 올바르지 않습니다.", "FORMAT"));
            };
            let id_ok = dobj.get("id").and_then(|v| v.as_str()).is_some_and(valid_id);
            let id_str = dobj
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let kind_ok = dobj
                .get("kind")
                .and_then(|v| v.as_str())
                .is_some_and(|k| k == "episode" || k == "plot");
            let path_str = dobj
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title_ok = dobj.get("title").is_none_or(|v| v.is_string() || v.is_null());
            if !id_ok || !ids.insert(id_str) || !kind_ok || !valid_rel(&path_str) || !title_ok {
                return Err(fail("작품 정보의 문서 목록이 올바르지 않습니다.", "FORMAT"));
            }
            if dobj.get("title").is_none() || dobj.get("title").unwrap().is_null() {
                let bn = base_name(&path_str);
                let stripped = num_re.replace(&bn, "").to_string();
                let t = if stripped.is_empty() {
                    "제목 없음".to_string()
                } else {
                    stripped
                };
                dobj.insert("title".to_string(), json!(t));
            }
        }
    }

    if let Some(dm) = obj.get("docMeta") {
        let Some(dm_obj) = dm.as_object() else {
            return Err(fail("작품 정보의 문서 속성이 올바르지 않습니다.", "FORMAT"));
        };
        if dm_obj.iter().any(|(k, v)| !valid_rel(k) || !v.is_object()) {
            return Err(fail("작품 정보의 문서 속성이 올바르지 않습니다.", "FORMAT"));
        }
    }

    if let Some(folders) = obj.get("archivedDocFolders") {
        if !folders.as_array().is_some_and(|a| a.iter().all(|v| v.as_str().is_some_and(valid_rel))) {
            return Err(fail("작품 정보의 보관한 폴더 목록이 올바르지 않습니다.", "FORMAT"));
        }
    }

    if let Some(am) = obj.get("archivedMemos") {
        let Some(arr) = am.as_array() else {
            return Err(fail(
                "작품 정보의 보관한 메모 목록이 올바르지 않습니다.",
                "FORMAT",
            ));
        };
        if !arr.iter().all(|v| v.as_str().is_some_and(valid_rel)) {
            return Err(fail(
                "작품 정보의 보관한 메모 목록이 올바르지 않습니다.",
                "FORMAT",
            ));
        }
    }

    if let Some(w) = obj.get("writing").cloned() {
        obj.insert("writing".to_string(), normalize_writing(Some(&w)));
    }

    Ok(p)
}

fn read_project_from_dir(dir: &Path) -> Result<Option<(Value, bool)>, LofError> {
    let mut errors = Vec::new();
    for name in ["project.json", "project.backup.json"] {
        let path = dir.join(name);
        match fs::read_to_string(&path) {
            Ok(raw) => match parse_project(&raw) {
                Ok(project) => return Ok(Some((project, name != "project.json"))),
                Err(e) => errors.push(e),
            },
            Err(e) => errors.push(LofError::from(e)),
        }
    }
    if let Some(real) = errors.into_iter().find(|e| e.code != "ENOENT") {
        return Err(real);
    }
    Ok(None)
}

fn doc_of(dir: &Path, project_id: &str, entry: &Value, raw: &str) -> Result<Value, LofError> {
    let parsed = read_markdown(raw)?;
    let entry = markdown_entry_with_parsed(&parsed, entry)?;
    let body = parsed.body;
    let eobj = entry.as_object().cloned().unwrap_or_default();
    let kind = eobj
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("episode");
    let rel_path = eobj.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let full_path = abs(dir, rel_path).to_string_lossy().to_string();
    let rev = hash_str(raw);
    let fp = fingerprint(&entry, &body);

    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        eobj.get("id").cloned().unwrap_or(json!("")),
    );
    out.insert("projectId".to_string(), json!(project_id));
    out.insert("kind".to_string(), json!(kind));
    out.insert(
        "title".to_string(),
        eobj.get("title").cloned().unwrap_or(json!("")),
    );
    out.insert(
        "status".to_string(),
        json!(normalize_status_val(eobj.get("status"))),
    );
    let meta_map = if kind == "episode" {
        normalize_meta(Some(&entry))
    } else {
        normalize_document_meta(Some(&entry))
    };
    for (k, v) in meta_map {
        out.insert(k, v);
    }
    out.insert(
        "order".to_string(),
        eobj.get("order").cloned().unwrap_or(json!(0)),
    );
    out.insert(
        "archived".to_string(),
        json!(eobj.get("archived").and_then(|v| v.as_bool()).unwrap_or(false)),
    );
    if let Some(ca) = eobj.get("createdAt") {
        out.insert("createdAt".to_string(), ca.clone());
    }
    if let Some(ua) = eobj.get("updatedAt") {
        out.insert("updatedAt".to_string(), ua.clone());
    }
    if let Some(ep_id) = eobj
        .get("episodeId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        out.insert("episodeId".to_string(), json!(ep_id));
    }
    if let Some(co) = eobj
        .get("conflictOf")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        out.insert("conflictOf".to_string(), json!(co));
    }
    if let Some(props) = eobj.get("properties").and_then(|v| v.as_object()) {
        if !props.is_empty() {
            out.insert("properties".to_string(), Value::Object(props.clone()));
        }
    }
    out.insert("relPath".to_string(), json!(rel_path));
    out.insert("path".to_string(), json!(full_path));
    out.insert("revision".to_string(), json!(rev));
    out.insert("fingerprint".to_string(), json!(fp));
    out.insert("body".to_string(), json!(body));
    Ok(Value::Object(out))
}

pub fn meta_of(project: &Value, rel: &str) -> Map<String, Value> {
    let low = rel.to_lowercase();
    if let Some(dm) = project.get("docMeta").and_then(|v| v.as_object()) {
        for (k, v) in dm {
            if k.to_lowercase() == low {
                if let Some(obj) = v.as_object() {
                    return obj.clone();
                }
            }
        }
    }
    Map::new()
}

fn doc_entry(
    project: &Value,
    rel: &str,
    meta_stat: &fs::Metadata,
    raw: &str,
) -> Result<Value, LofError> {
    let proj_id = project.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let m = meta_of(project, rel);
    let m_val = Value::Object(m.clone());
    let ep_id = m
        .get("episodeId")
        .and_then(|v| v.as_str())
        .filter(|eid| {
            project
                .get("documents")
                .and_then(|v| v.as_array())
                .is_some_and(|docs| {
                    docs.iter().any(|d| {
                        d.get("id").and_then(|x| x.as_str()) == Some(*eid)
                            && d.get("kind").and_then(|x| x.as_str()) == Some("episode")
                    })
                })
        })
        .map(|s| s.to_string());

    let created_at = meta_stat
        .created()
        .or_else(|_| meta_stat.modified())
        .map(sys_time_to_iso)
        .unwrap_or_else(|_| now_iso());
    let updated_at = meta_stat
        .modified()
        .map(sys_time_to_iso)
        .unwrap_or_else(|_| now_iso());

    let mut fb = Map::new();
    fb.insert("id".to_string(), json!(memo_id(proj_id, rel)));
    fb.insert(
        "kind".to_string(),
        json!(if m.get("type").and_then(|v| v.as_str()) == Some("plot") {
            "plot"
        } else {
            "memo"
        }),
    );
    fb.insert("title".to_string(), json!(base_name(rel)));
    fb.insert("status".to_string(), json!("초안"));
    fb.insert("order".to_string(), json!(0));
    fb.insert(
        "archived".to_string(),
        json!(m.get("archived").and_then(|v| v.as_bool()).unwrap_or(false)),
    );
    for (k, v) in normalize_document_meta(Some(&m_val)) {
        fb.insert(k, v);
    }
    if let Some(eid) = ep_id {
        fb.insert("episodeId".to_string(), json!(eid));
    }
    fb.insert("createdAt".to_string(), json!(created_at));
    fb.insert("updatedAt".to_string(), json!(updated_at));
    fb.insert("path".to_string(), json!(rel));

    markdown_entry(raw, &Value::Object(fb))
}

fn prune_empty(dir: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                prune_empty(&e.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

// 관리 DB가 없던 예전 보관함의 이력 폴더를 지우고, 지운 이력 파일 수를 돌려준다.
fn remove_history_dir(dir: &Path) -> Result<usize, LofError> {
    if !dir.exists() {
        return Ok(0);
    }
    let count = walkdir_count(dir);
    fs::remove_dir_all(dir)?;
    Ok(count)
}

fn walkdir_count(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| if e.path().is_dir() { walkdir_count(&e.path()) } else { 1 })
                .sum()
        })
        .unwrap_or(0)
}

const RENAME_FAILED: &str =
    "파일 이름을 바꾸지 못했습니다. 다른 프로그램에서 작품 폴더의 파일을 열고 있는지 확인해 주세요.";

// 기존 설정 및 Git 이관 중의 이력 기록과 호환한다. 이관 완료 후에는 Git 작업자가 자동 기록한다.
#[derive(Clone, Copy)]
pub struct HistoryPolicy {
    pub max_minutes: f64,
    pub min_chars: usize,
    // 이전 설정을 읽기 위한 필드이며 자동 삭제에는 사용하지 않는다.
    pub keep_count: usize,
    pub keep_days: i64,
}

#[derive(Clone)]
struct SnapshotEntry {
    at: u64,
    body: String,
}

pub struct Store {
    pub root: PathBuf,
    pub recovery_dir: Option<PathBuf>,
    pub vault: Value,
    pub index: FileIndex,
    pub catalog: Option<Catalog>,
    pub index_enabled: bool,
    pub index_sequence: u64,
    sync_sequence: AtomicU64,
    sync_checkpoints: HashMap<String, ((u64, u64), Instant)>,
    // 편집 화면이 임시본 보관과 최신본 반영을 마칠 때까지 문서별 전송을 보류한다.
    sync_holds: HashMap<String, (String, String)>,
    disk_inventory: Option<DiskInventory>,
    pub migration_warning: String,
    pub local_git: crate::local_git::LocalHistory,
    last_snapshot: HashMap<String, Option<SnapshotEntry>>,
    // 목록을 새로 그릴 때마다 표지를 다시 읽어 인코딩하지 않도록 크기·수정 시각이 같으면 재사용한다.
    cover_cache: HashMap<PathBuf, (u64, Option<SystemTime>, Value)>,
    // 변경이 없을 때 서재 목록 전체를 매번 다시 조립·정렬하지 않도록 캐시한다.
    list_cache: Option<((u64, u64), Value)>,
    pub history_policy: HistoryPolicy,
    pub default_manual_line_break: bool,
}

impl Store {
    pub fn has_pending_disk_changes(&self) -> Result<bool, LofError> {
        Ok(self.database()?.get("missingFiles")?
            .and_then(|value| value.as_object().map(|files| !files.is_empty())).unwrap_or(false))
    }

    // 표시용 경고와 별개로 아직 안전하게 비교할 수 없는 경로만 동기화에서 보류한다.
    pub fn sync_deferred_paths(&self) -> Result<Vec<String>, LofError> {
        let mut paths: Vec<String> = self.sync_holds.values().map(|(_, path)| path.clone()).collect();
        if let Some(catalog) = &self.catalog {
            for project in &catalog.projects {
                let Some(folder) = project.dir.file_name().and_then(|name| name.to_str()) else { continue };
                for relative in project.errors.keys() {
                    let relative = if relative == "project" { "project.json" } else { relative };
                    paths.push(if valid_rel(relative) {
                        format!("{folder}/{relative}")
                    } else {
                        folder.to_string()
                    });
                }
            }
        }
        if let Some(pending) = self.database()?.get("missingFiles")?.and_then(|value| value.as_object().cloned()) {
            for info in pending.values() {
                if let Some(relative) = info["path"].as_str().and_then(|path| Path::new(path).strip_prefix(&self.root).ok()) {
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if valid_rel(&relative) { paths.push(relative); }
                }
            }
        }
        Ok(paths)
    }

    pub(crate) fn ensure_sync_ready(&self, path: &str) -> Result<(), LofError> {
        if self.sync_holds.values().any(|(_, held)| held == path) {
            return Err(fail(SYNC_HOLD_MESSAGE, "SYNC_RETRY"));
        }
        Ok(())
    }

    pub fn finish_document_sync(&mut self, input: &Value) -> Result<bool, LofError> {
        let id = input["id"].as_str().filter(|id| valid_id(id))
            .ok_or_else(|| fail_invalid("잘못된 문서 ID"))?;
        let token = input["syncToken"].as_str().ok_or_else(|| fail_invalid("동기화 정리 식별자가 없습니다."))?;
        let current = self.read(id)?;
        if input["revision"] != current["revision"] { return Ok(false); }
        if self.sync_holds.get(token).is_some_and(|(held_id, _)| held_id == id) {
            self.sync_holds.remove(token);
        }
        Ok(true)
    }

    // 외부 편집기가 저장 중이라 읽지 못한 원고가 남아 있는지 확인한다.
    pub fn has_busy_files(&self) -> bool {
        !self.index.dirty.is_empty()
    }

    pub fn poll_disk(&mut self) -> Result<bool, LofError> {
        if let Some(db) = &self.index.database {
            crate::project_order::load(&self.root, db)?;
        }
        let files = disk_inventory(&self.root)?;
        self.apply_disk_inventory(files)
    }

    // 디스크 목록은 잠금 밖에서 미리 만들어 넘길 수 있다. 공유 저장소에서는 목록 작성이 오래 걸린다.
    // 그 사이 바뀐 파일은 다음 확인에서 다시 잡힌다.
    pub fn poll_disk_with(&mut self, files: DiskInventory) -> Result<bool, LofError> {
        if let Some(db) = &self.index.database {
            crate::project_order::load(&self.root, db)?;
        }
        self.apply_disk_inventory(files)
    }

    fn apply_disk_inventory(&mut self, files: DiskInventory) -> Result<bool, LofError> {
        let changed = self.disk_inventory.as_ref() != Some(&files);
        let revision = self.sync_revision();
        let pending_deletions = self.has_pending_disk_changes()? || self.has_busy_files();
        if changed {
            self.sync_sequence.fetch_add(1, Ordering::SeqCst);
            // 밀리초 단위 캐시 값이 같아도 더 정밀한 수정 시각이 달라졌다면 본문을 다시 읽는다.
            // 비교할 이전 목록이 없으면 저장된 색인의 크기·시각 비교를 믿고 서재 전체를 다시 읽지 않는다.
            if let (Some(catalog), Some(previous)) = (self.catalog.as_mut(), self.disk_inventory.as_ref()) {
                for (path, stamp) in &files {
                    if stamp.3 || previous.get(path) == Some(stamp) { continue; }
                    let relative = path.to_string_lossy().replace('\\', "/");
                    let Some((folder, relative)) = relative.split_once('/') else { continue };
                    if let Some(project) = catalog.projects.iter_mut().find(|project| project.dir == self.root.join(folder)) {
                        if let Some(file) = project.files.get_mut(relative) { file.stamp.clear(); }
                    }
                }
            }
        }
        // 삭제 유예 기간을 유지하며, 파일 목록이 그대로여도 다음 주기에 삭제 여부와 저장 중이던 원고를 재확인한다.
        // 그 밖에는 이전 목록과 비교해 추가·수정·삭제된 경로만 다시 확인한다. 폴더는 생기거나 없어질 때만 본다.
        // 폴더 안의 파일 변화는 파일 경로로 따로 잡힌다.
        let partial = match self.disk_inventory.as_ref() {
            Some(previous) if changed && !pending_deletions => Some(
                files.iter()
                    .filter(|(path, stamp)| match previous.get(*path) {
                        Some(before) => !stamp.3 && before != *stamp,
                        None => true,
                    })
                    .map(|(path, _)| path)
                    .chain(previous.keys().filter(|path| !files.contains_key(*path)))
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        };
        match partial {
            Some(paths) => {
                for path in paths { self.invalidate_path(&path); }
                self.refresh_index(false)?;
            }
            None if changed || pending_deletions => self.refresh_index(true)?,
            None => {}
        }
        self.disk_inventory = Some(files);
        Ok(changed || revision != self.sync_revision())
    }

    pub fn sync_revision(&self) -> (u64, u64) {
        (CHANGE_SEQUENCE.load(Ordering::SeqCst), self.sync_sequence.load(Ordering::SeqCst))
    }

    // 실행 중인 서재에서만 비교를 생략한다. 재시작 후와 60초마다 전체 확인을 다시 한다.
    pub fn sync_unchanged(&self, connection: &str) -> bool {
        self.index_enabled && self.index.dirty.is_empty()
            && self.sync_checkpoints.get(connection).is_some_and(|(revision, checked)| {
                *revision == self.sync_revision() && checked.elapsed() < Duration::from_secs(60)
            })
    }

    pub fn remember_sync_revision(&mut self, connection: &str, revision: (u64, u64)) {
        self.sync_checkpoints.insert(connection.to_string(), (revision, Instant::now()));
    }

    pub fn database(&self) -> Result<&crate::database::LibraryDb, LofError> {
        self.index.database.as_ref().ok_or_else(||fail(
            if self.index.database_error.is_empty(){"관리 DB가 준비되지 않았습니다.".to_string()}else{self.index.database_error.clone()},"DATABASE_NOT_READY"))
    }

    pub fn require_database(&self) -> Result<(),LofError> { self.database().map(|_|()) }

    // 이전 호출부와 호환하되 기존 이력과 Git 커밋을 그대로 보관한다.
    pub fn retain_history(&self, force: bool) -> Result<(), LofError> {
        let p = self.history_policy;
        if let Some(db) = &self.index.database {
            db.retain_history(p.keep_count, p.keep_days, force)?;
        }
        // Git 이력 전환 후에는 기존 DB와 Git 기록 모두 자동으로 삭제하지 않는다.
        Ok(())
    }

    fn save_deleted(&self, deleted:&Map<String,Value>)->Result<(),LofError>{
        self.database()?.set("deleted",&Value::Object(deleted.clone()))?;
        self.sync_sequence.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn storage_status(&self)->Value{
        self.database().map(|db|db.status()).unwrap_or_else(|e|json!({"ready":false,"message":e.message}))
    }

    pub fn git_tick(&mut self, force: bool, editing: bool) -> Result<(), LofError> {
        let result = self.update_git(force, editing);
        if result.is_err() { self.local_git.retry_migration(); }
        self.local_git.error = result.as_ref().err().map(|error| error.message.clone()).unwrap_or_default();
        result
    }

    fn update_git(&mut self, force: bool, editing: bool) -> Result<(), LofError> {
        self.require_database()?;
        let vault_id = self.vault["id"].as_str().unwrap_or("").to_string();
        if !self.local_git.ready {
            let db = self.index.database.as_ref().unwrap();
            if !self.local_git.resume(&vault_id, db)? {
                if !self.local_git.import_legacy(db)? { return Ok(()) }
                let snapshot = self.git_snapshot()?;
                self.local_git.finish_migration(&vault_id, self.index.database.as_ref().unwrap(), &snapshot)?;
            }
        }
        self.flush_received_history()?;
        self.local_git.observe(self.sync_revision());
        if self.local_git.due(force, editing) {
            let snapshot = self.git_snapshot()?;
            self.local_git.commit(&vault_id, &snapshot)?;
        }
        Ok(())
    }

    fn git_snapshot(&mut self) -> Result<crate::local_git::Snapshot, LofError> {
        let list = self.list()?;
        let unreadable = list["warnings"].as_array().is_some_and(|items| !items.is_empty());
        let missing = list["missing"].as_array().is_some_and(|items| !items.is_empty());
        if unreadable || missing {
            return Err(fail("읽지 못했거나 삭제 확인 중인 원고가 있어 로컬 Git 기록을 미뤘습니다.", "LOCAL_GIT"));
        }
        let projects: Vec<_> = list["projects"].as_array().into_iter().flatten().map(project_fields).collect();
        let mut documents = Vec::new();
        for entry in list["documents"].as_array().into_iter().flatten() {
            let id = entry["id"].as_str().ok_or_else(|| fail_invalid("원고 ID가 없습니다."))?;
            documents.push(self.read(id)?);
        }
        let mut assets = Vec::new();
        for project in list["projects"].as_array().into_iter().flatten() {
            let id = project["id"].as_str().unwrap_or("");
            let folder = project["folder"].as_str().ok_or_else(|| fail_invalid("작품 폴더가 없습니다."))?;
            crate::local_git::collect_assets(id, &self.root.join(folder), &mut assets)?;
        }
        Ok(crate::local_git::Snapshot { documents, projects, assets, deleted: json!(self.deleted()?) })
    }

    fn git_snapshot_for_reset(&mut self) -> Result<crate::local_git::Snapshot, LofError> {
        let list = self.list()?;
        let projects: Vec<_> = list["projects"].as_array().into_iter().flatten().map(project_fields).collect();
        let mut documents = Vec::new();
        for entry in list["documents"].as_array().into_iter().flatten() {
            if let Some(id) = entry["id"].as_str() {
                if let Ok(doc) = self.read(id) {
                    documents.push(doc);
                }
            }
        }
        let mut assets = Vec::new();
        for project in list["projects"].as_array().into_iter().flatten() {
            let id = project["id"].as_str().unwrap_or("");
            if let Some(folder) = project["folder"].as_str() {
                let _ = crate::local_git::collect_assets(id, &self.root.join(folder), &mut assets);
            }
        }
        Ok(crate::local_git::Snapshot {
            documents,
            projects,
            assets,
            deleted: json!(self.deleted().unwrap_or_default()),
        })
    }

    pub fn reset_history(&mut self, common_memo_root: &Path) -> Result<(), LofError> {
        self.require_database()?;
        let vault_id = self.vault["id"].as_str().unwrap_or("").to_string();
        let snapshot = self.git_snapshot_for_reset()?;
        let db = self.index.database.as_ref().unwrap();
        self.local_git.reset(&vault_id, db, &snapshot)?;
        self.local_git.observe(self.sync_revision());
        let lof = self.root.join(".lof");
        crate::local_git::remove_dir_force(&lof.join("history"))?;
        crate::local_git::remove_dir_force(&lof.join("migrations"))?;
        crate::local_git::LocalHistory::reset_common_memos(common_memo_root)?;
        self.last_snapshot.clear();
        Ok(())
    }

    pub fn new(
        root: impl AsRef<Path>,
        history_policy: HistoryPolicy,
        default_manual_line_break: bool,
    ) -> Result<Self, LofError> {
        let root_path = fs::canonicalize(root.as_ref()).unwrap_or_else(|_| root.as_ref().to_path_buf());
        // Strip Windows \\?\ extended path prefix so paths display cleanly in UI
        let clean_root = strip_verbatim_prefix(&root_path);
        let mut s = Self {
            index: FileIndex::new(&clean_root),
            local_git: crate::local_git::LocalHistory::new(&clean_root),
            root: clean_root,
            vault: Value::Null,
            catalog: None,
            index_enabled: false,
            index_sequence: CHANGE_SEQUENCE.load(Ordering::SeqCst),
            sync_sequence: AtomicU64::new(0),
            sync_checkpoints: HashMap::new(),
            sync_holds: HashMap::new(),
            recovery_dir: None,
            disk_inventory: None,
            migration_warning: String::new(),
            last_snapshot: HashMap::new(),
            cover_cache: HashMap::new(),
            list_cache: None,
            history_policy,
            default_manual_line_break,
        };
        s.init()?;
        Ok(s)
    }

    pub fn init(&mut self) -> Result<(), LofError> {
        let lof_dir = self.root.join(".lof");
        fs::create_dir_all(&lof_dir)?;
        let vault_file = lof_dir.join("vault.json");
        match fs::read_to_string(&vault_file) {
            Ok(raw) => {
                self.vault = serde_json::from_str(&raw)
                    .map_err(|e| fail(e.to_string(), "FORMAT"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.vault = json!({
                    "format": FORMAT,
                    "id": Uuid::new_v4().to_string(),
                    "createdAt": now_iso(),
                });
                let pretty = serde_json::to_string_pretty(&self.vault).unwrap_or_default();
                atomic_write_str(&vault_file, &pretty)?;
            }
            Err(e) => return Err(LofError::from(e)),
        }

        let vault_id = self
            .vault
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        self.index.open_database(&vault_id);
        if !self.index.database_error.is_empty() {
            self.migration_warning = self.index.database_error.clone();
            return Ok(());
        }

        let init_res: Result<(), LofError> = (|| {
            // 디스크 목록을 먼저 받아 두고 색인을 맞춘다. 첫 동기화 확인은 이 목록과 비교해 바뀐 경로만 다시 읽는다.
            // 그 사이에 바뀐 파일은 목록과 달라지므로 첫 확인에서 잡힌다.
            let files = disk_inventory(&self.root).ok();
            if let Some(cat) = self.index.load(&vault_id) {
                self.catalog = Some(cat);
                self.index_enabled = true;
                self.refresh_index(true)?;
            } else {
                let cat=self.scan_disk()?;
                self.index.save(&vault_id,&cat)?;
                self.catalog=Some(cat);
                self.index_enabled=true;
            }
            self.disk_inventory = files;
            Ok(())
        })();

        if let Err(e) = init_res {
            self.migration_warning = format!("문서 속성 이관을 완료하지 못했습니다: {}", e.message);
        }
        Ok(())
    }

    pub fn trash_path(&self, file: &Path) -> Result<(), LofError> {
        if !file.exists() {
            return Ok(());
        }
        #[cfg(not(target_os = "android"))]
        if trash::delete(file).is_ok() {
            record_change(file);
            return Ok(());
        }
        if file.is_dir() {
            fs::remove_dir_all(file)?;
        } else {
            fs::remove_file(file)?;
        }
        record_change(file);
        Ok(())
    }

    pub fn stamp(&self, file: &Path) -> Result<Option<String>, LofError> {
        match fs::metadata(file) {
            Ok(m) => {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                let ctime = m
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(mtime);
                Ok(Some(format!("{:.0}:{:.0}:{}", mtime, ctime, m.len())))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(LofError::from(e)),
        }
    }

    fn index_record(
        &mut self,
        dir: &Path,
        project: &Value,
        entry: &Value,
        raw: &str,
        meta_stat: &fs::Metadata,
    ) -> Result<IndexedFileRecord, LofError> {
        let project_id = project.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let entry_id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let mut full_doc = doc_of(dir, project_id, entry, raw)?;
        if let Some(db) = &self.index.database {
            let file = PathBuf::from(full_doc["path"].as_str().unwrap_or(""));
            full_doc = db.observe_file(&full_doc, &sys_time_to_iso(meta_stat.modified()?),
                is_app_write(&file, raw, meta_stat))?;
        }
        let body = full_doc
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(obj) = full_doc.as_object_mut() {
            obj.remove("body");
            let stats = manuscript_stats(&body);
            let chars = stats.utf16_without_spaces;
            let writing = normalize_writing(project.get("writing"));
            let pchars = count_for_writing(&stats, &writing);
            obj.insert("characters".to_string(), json!(chars));
            obj.insert("platformCharacters".to_string(), json!(pchars));
        }
        self.index.cache_body(project_id, entry_id, &body)?;
        let mut entry_with_hash = entry.clone();
        if let Some(eobj) = entry_with_hash.as_object_mut() {
            eobj.insert("hash".to_string(), json!(hash_str(&body)));
            if let Some(updated) = full_doc.get("updatedAt") {
                eobj.insert("updatedAt".to_string(), updated.clone());
            }
        }
        let mtime = meta_stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let ctime = meta_stat
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(mtime);
        let stamp = format!("{:.0}:{:.0}:{}", mtime, ctime, meta_stat.len());
        Ok(IndexedFileRecord {
            entry: entry_with_hash,
            doc: full_doc,
            stamp,
        })
    }

    pub fn invalidate_path(&mut self, relative: &str) {
        if !relative.is_empty()
            && !relative.split(['/', '\\']).any(|s| s == ".lof")
        {
            self.index.dirty.insert(relative.replace('\\', "/"));
            lof_realtime::file_index::changed(&self.root, &relative.replace('\\', "/"));
            self.sync_sequence.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn retry_busy_file(&mut self, file: &Path, error: &LofError) {
        if error.code == "FILE_BUSY" {
            if let Ok(relative) = file.strip_prefix(&self.root) {
                self.invalidate_path(&relative.to_string_lossy());
            }
        }
    }

    fn reconcile_index_project(p: &mut CatalogProject) {
        let mut docs: Vec<Value> = p
            .files
            .values()
            .filter(|f| f.entry.get("kind").and_then(|v| v.as_str()) == Some("episode"))
            .map(|f| f.entry.clone())
            .collect();
        docs.sort_by(by_order_cmp);
        if let Some(obj) = p.project.as_object_mut() {
            obj.insert("documents".to_string(), Value::Array(docs));
        }
    }

    fn refresh_indexed_file(&mut self, p: &mut CatalogProject, rel: &str) {
        let low = rel.to_ascii_lowercase();
        if !(low.starts_with("episodes/") || low.starts_with("doc/")) || !low.ends_with(".md") {
            return;
        }
        let file = abs(&p.dir, rel);
        let res: Result<(), LofError> = (|| {
            let stamp = self.stamp(&file)?;
            if let Some(ref st) = stamp {
                if p.files.get(rel).is_some_and(|f| &f.stamp == st)
                    && !p.errors.contains_key(rel)
                {
                    return Ok(());
                }
            }
            let (raw, stat) = read_document_file(&file)?;
            let proj_id = p
                .project
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            static EP_NUM_RE: OnceLock<Regex> = OnceLock::new();
            let ep_re = EP_NUM_RE.get_or_init(|| Regex::new(r"^episodes/(\d+)").unwrap());
            static NUM_PREFIX_RE: OnceLock<Regex> = OnceLock::new();
            let num_re = NUM_PREFIX_RE.get_or_init(|| Regex::new(r"^\d+\s+").unwrap());

            let fallback = if rel.starts_with("episodes/") {
                let order_num = ep_re
                    .captures(rel)
                    .and_then(|c| c.get(1))
                    .and_then(|m| m.as_str().parse::<i64>().ok())
                    .unwrap_or(1);
                let created_at = stat
                    .created()
                    .or_else(|_| stat.modified())
                    .map(sys_time_to_iso)
                    .unwrap_or_else(|_| now_iso());
                let updated_at = stat
                    .modified()
                    .map(sys_time_to_iso)
                    .unwrap_or_else(|_| now_iso());
                let bn = base_name(rel);
                json!({
                    "id": memo_id(&proj_id, rel),
                    "kind": "episode",
                    "path": rel,
                    "title": num_re.replace(&bn, "").to_string(),
                    "order": (order_num - 1).max(0),
                    "createdAt": created_at,
                    "updatedAt": updated_at,
                })
            } else {
                doc_entry(&p.project, rel, &stat, &raw)?
            };

            let mut merged_fb = fallback.as_object().cloned().unwrap_or_default();
            if let Some(prev_entry) = p.files.get(rel).and_then(|f| f.entry.as_object()) {
                for (k, v) in prev_entry {
                    merged_fb.insert(k.clone(), v.clone());
                }
            }
            merged_fb.insert("path".to_string(), json!(rel));

            let mut entry = markdown_entry(&raw, &Value::Object(merged_fb))?;
            let entry_id = entry
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let duplicate = p
                .files
                .iter()
                .find(|(other, f)| {
                    *other != rel
                        && f.entry.get("id").and_then(|v| v.as_str()) == Some(entry_id.as_str())
                })
                .map(|(other, _)| other.clone());
            if let Some(dup_rel) = duplicate {
                if abs(&p.dir, &dup_rel).exists() {
                    p.files.remove(rel);
                    return Err(fail(
                        "같은 문서 ID를 가진 파일이 여러 개 있습니다. 사본에는 새 ID를 지정해 주세요.",
                        "DUPLICATE",
                    ));
                }
            }

            // Missing attributes are kept in the index until an explicit document save.
            if let Some(eobj) = entry.as_object_mut() {
                eobj.insert("_markdown".to_string(), json!(true));
            }
            let rec = self.index_record(&p.dir, &p.project, &entry, &raw, &stat)?;
            p.files.insert(rel.to_string(), rec);
            p.errors.remove(rel);
            Ok(())
        })();

        if let Err(e) = res {
            self.retry_busy_file(&file, &e);
            if e.code == "ENOENT" {
                p.files.remove(rel);
                p.errors.remove(rel);
            } else {
                let title = p
                    .project
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                p.errors
                    .insert(rel.to_string(), format!("{} · {}: {}", title, rel, e.message));
            }
        }
    }

    fn refresh_project_files(&mut self, p: &mut CatalogProject, inventory: bool) {
        let mut present = HashSet::new();
        for folder in ["episodes", "doc"] {
            match fs::read_dir(p.dir.join(folder)){
                Ok(_)=>{p.errors.remove(folder);}
                Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{p.errors.remove(folder);},
                Err(e)=>{p.errors.insert(folder.to_string(),format!("폴더를 읽지 못했습니다: {folder}: {e}"));return;}
            }
            for rel in walk_rel(&p.dir, folder) {
                if !rel.to_ascii_lowercase().ends_with(".md") {
                    continue;
                }
                present.insert(rel.clone());
                let stamp = self.stamp(&abs(&p.dir, &rel)).ok().flatten();
                let current_stamp = p.files.get(&rel).map(|f| f.stamp.clone());
                if !inventory || current_stamp != stamp || p.errors.contains_key(&rel) {
                    self.refresh_indexed_file(p, &rel);
                }
            }
        }
        p.files.retain(|rel, _| present.contains(rel));
        // 사라진 원고의 이전 읽기 오류도 파일 목록과 함께 정리한다.
        p.errors.retain(|rel, _| {
            rel == "project" || rel == "episodes" || rel == "doc" || present.contains(rel)
        });
        Self::reconcile_index_project(p);
    }

    pub fn refresh_index(&mut self, inventory: bool) -> Result<(), LofError> {
        if !self.index_enabled || self.catalog.is_none() {
            return Ok(());
        }
        let cur_seq = CHANGE_SEQUENCE.load(Ordering::SeqCst);
        if cur_seq > self.index_sequence {
            if let Ok(map) = changed_paths_map().lock() {
                for (file, &seq) in map.iter() {
                    if seq > self.index_sequence {
                        if let Ok(rel) = file.strip_prefix(&self.root) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            if !rel_str.starts_with("..") {
                                self.invalidate_path(&rel_str);
                            }
                        }
                    }
                }
            }
            self.index_sequence = cur_seq;
        }
        // 변경된 경로가 없고 전체 스캔 요청도 아니면 디스크를 읽지 않고 바로 끝낸다.
        if !inventory && self.index.dirty.is_empty() {
            return Ok(());
        }
        self.list_cache = None;
        // A disconnected or unreadable vault must never become a deletion snapshot.
        let _=fs::read_dir(&self.root)?;
        let mut cat = self.catalog.take().unwrap();
        let before_projects:Vec<(String,PathBuf)>=cat.projects.iter().filter_map(|p|
            p.project["id"].as_str().map(|id|(id.to_string(),p.dir.clone()))).collect();
        let res = (|| -> Result<(), LofError> {
            if inventory {
                for p in &cat.projects {
                    if let Some(name) = p.dir.file_name().and_then(|n| n.to_str()) {
                        self.index.dirty.insert(name.to_string());
                    }
                }
                for entry in fs::read_dir(&self.root)? {
                    let entry = entry?;
                    let kind = entry.file_type()?;
                    if kind.is_dir() || kind.is_file() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !name.starts_with('.') {
                            self.index.dirty.insert(name);
                        }
                    }
                }
                // 경고를 누적하지 않고 현재 파일 상태로 다시 판단한다.
                // 이미 목록에서 빠진 작품의 폴더가 없어져도 이전 경고가 남지 않는다.
                cat.warnings.clear();
            }

            let dirty: Vec<String> = self.index.dirty.drain().collect();
            if dirty.is_empty() && !inventory {
                return Ok(());
            }

            let mut folders: HashMap<String, HashSet<String>> = HashMap::new();
            for rel in dirty {
                let mut parts = rel.split('/');
                let Some(folder) = parts.next() else { continue };
                let rest: Vec<&str> = parts.collect();
                let joined = rest.join("/");
                let low = rel.to_ascii_lowercase();
                if folder.starts_with('.')
                    || low.ends_with(".tmp")
                    || low.ends_with(".lofmv")
                    || low.ends_with(".lofnew")
                    || joined == "project.backup.json"
                {
                    continue;
                }
                folders
                    .entry(folder.to_string())
                    .or_default()
                    .insert(joined);
            }

            for (folder, paths) in folders {
                let dir = self.root.join(&folder);
                // 루트의 일반 파일은 작품 폴더가 아니다. 파일 아래에서 project.json을 찾지 않는다.
                if dir.is_file() {
                    if let Some(project) = cat.projects.iter_mut().find(|project| project.dir == dir) {
                        project.errors.insert("project".to_string(), format!("{}: 작품 폴더 위치에 일반 파일이 있습니다.", folder));
                    } else {
                        let prefix = format!("{}:", folder);
                        cat.warnings.retain(|warning| !warning.starts_with(&prefix));
                    }
                    continue;
                }
                if !dir.exists() {
                    cat.projects.retain(|x| x.dir != dir);
                    let prefix = format!("{}:", folder);
                    cat.warnings.retain(|m| !m.starts_with(&prefix));
                    continue;
                }

                let mut p_idx = cat.projects.iter().position(|x| x.dir == dir);
                let cur_proj_stamp = self.stamp(&dir.join("project.json")).ok().flatten();
                let proj_unchanged = p_idx.is_some_and(|i| {
                    cur_proj_stamp.is_some()
                        && cat.projects[i].project_stamp == cur_proj_stamp
                        && !cat.projects[i].errors.contains_key("project")
                        && cat.projects[i].project.get("fileCentric").and_then(Value::as_bool) == Some(true)
                });
                if p_idx.is_none() || paths.contains("project.json") || (paths.contains("") && !proj_unchanged) {
                    match read_project_from_dir(&dir) {
                        Ok(None) => {
                            if let Some(idx) = p_idx {
                                cat.projects.remove(idx);
                            }
                            // 작품 정보가 없는 폴더는 전체 스캔과 동일하게 건너뛴다.
                            // 남아 있는 원고는 건드리지 않고 목록과 이전 경고만 정리한다.
                            let prefix = format!("{}:", folder);
                            cat.warnings.retain(|warning| !warning.starts_with(&prefix));
                            continue;
                        }
                        Ok(Some((mut proj_val, from_backup))) => {
                            let proj_id = proj_val
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let dup = p_idx.is_none()
                                && cat.projects.iter().any(|x| {
                                    x.project.get("id").and_then(|v| v.as_str()) == Some(&proj_id)
                                        && x.dir != dir
                                        && x.dir.exists()
                                });
                            if dup {
                                let msg = format!("{}: 다른 작품 폴더와 ID가 겹칩니다.", folder);
                                let prefix = format!("{}:", folder);
                                cat.warnings.retain(|m| !m.starts_with(&prefix));
                                cat.warnings.push(msg);
                                continue;
                            }

                            if proj_val.get("fileCentric").and_then(|v| v.as_bool()) != Some(true)
                            {
                                let mut migration = CatalogProject {
                                    dir: dir.clone(),
                                    project: proj_val,
                                    from_backup,
                                    files: HashMap::new(),
                                    errors: HashMap::new(),
                                    project_stamp: None,
                                };
                                self.migrate_legacy(&mut migration)?;
                                self.migrate_properties(&mut migration)?;
                                proj_val = migration.project;
                            }

                            let prev_writing = p_idx.and_then(|idx| {
                                serde_json::to_string(&cat.projects[idx].project.get("writing"))
                                    .ok()
                            });
                            let changed_identity = p_idx.is_some_and(|idx| {
                                cat.projects[idx].project.get("id").and_then(|v| v.as_str())
                                    != Some(&proj_id)
                            });

                            let idx = match p_idx {
                                Some(i) => {
                                    let existing_docs = cat.projects[i]
                                        .project
                                        .get("documents")
                                        .cloned()
                                        .unwrap_or(json!([]));
                                    cat.projects[i].project = proj_val;
                                    if let Some(o) = cat.projects[i].project.as_object_mut() {
                                        o.insert("documents".to_string(), existing_docs);
                                    }
                                    i
                                }
                                None => {
                                    cat.projects.push(CatalogProject {
                                        dir: dir.clone(),
                                        project: proj_val,
                                        from_backup,
                                        files: HashMap::new(),
                                        errors: HashMap::new(),
                                        project_stamp: None,
                                    });
                                    cat.projects.len() - 1
                                }
                            };
                            p_idx = Some(idx);

                            let p = &mut cat.projects[idx];
                            if changed_identity {
                                p.files.clear();
                            }
                            p.project_stamp = self.stamp(&dir.join("project.json"))?;
                            if paths.contains("") || p.files.is_empty() {
                                self.refresh_project_files(p, true);
                            }
                            let cur_writing =
                                serde_json::to_string(&p.project.get("writing")).ok();
                            if prev_writing != cur_writing {
                                let writing = normalize_writing(p.project.get("writing"));
                                let pid = p
                                    .project
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let file_keys: Vec<String> = p.files.keys().cloned().collect();
                                for fk in file_keys {
                                    let eid = p.files[&fk]
                                        .entry
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let fpath = abs(&p.dir, &fk);
                                    let body = self.index.body(&pid, &eid).unwrap_or_else(|_| {
                                        fs::read_to_string(&fpath)
                                            .ok()
                                            .and_then(|r| read_markdown(&r).ok())
                                            .map(|m| m.body)
                                            .unwrap_or_default()
                                    });
                                    let pchars =
                                        count_for_writing(&manuscript_stats(&body), &writing);
                                    if let Some(rec) = p.files.get_mut(&fk) {
                                        if let Some(dobj) = rec.doc.as_object_mut() {
                                            dobj.insert(
                                                "platformCharacters".to_string(),
                                                json!(pchars),
                                            );
                                        }
                                    }
                                }
                            }
                            p.from_backup = from_backup;
                            if from_backup {
                                p.errors.insert(
                                    "project".to_string(),
                                    format!("{}: 복구용 작품 정보 사본으로 열었습니다.", folder),
                                );
                            } else {
                                p.errors.remove("project");
                            }
                            let prefix = format!("{}:", folder);
                            cat.warnings.retain(|m| !m.starts_with(&prefix));
                        }
                        Err(e) => {
                            if let Some(idx) = p_idx {
                                cat.projects[idx]
                                    .errors
                                    .insert("project".to_string(), format!("{}: {}", folder, e.message));
                            } else {
                                let prefix = format!("{}:", folder);
                                cat.warnings.retain(|m| !m.starts_with(&prefix));
                                cat.warnings.push(format!("{}: {}", folder, e.message));
                            }
                        }
                    }
                } else if paths.contains("") {
                    if let Some(idx) = p_idx {
                        self.refresh_project_files(&mut cat.projects[idx], true);
                    }
                }

                let Some(idx) = p_idx else { continue };
                let p = &mut cat.projects[idx];
                for rel in paths {
                    let low = rel.to_ascii_lowercase();
                    if (low.starts_with("episodes/") || low.starts_with("doc/"))
                        && low.ends_with(".md")
                    {
                        self.refresh_indexed_file(p, &rel);
                    } else if !rel.is_empty()
                        && rel != "project.json"
                        && rel != "project.backup.json"
                        && !low.ends_with(".tmp")
                        && !low.ends_with(".lofmv")
                        && !low.ends_with(".lofnew")
                    {
                        self.refresh_project_files(p, true);
                    }
                }
                Self::reconcile_index_project(p);
            }

            self.reconcile_missing(&mut cat,&before_projects)?;

            let vault_id = self
                .vault
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            self.index.save(&vault_id, &cat)?;
            self.retain_history(false)?;
            Ok(())
        })();

        self.catalog = Some(cat);
        res
    }

    fn reconcile_missing(&self,cat:&mut Catalog,before_projects:&[(String,PathBuf)])->Result<(),LofError>{
        let db=self.database()?;
        // 다른 파일의 경고와 무관하게 각 경로의 실제 존재 여부로 삭제를 확인한다.
        let present:HashSet<String>=cat.projects.iter().flat_map(|p|p.files.values())
            .filter_map(|f|f.doc["id"].as_str().map(str::to_string)).collect();
        let projects:HashSet<String>=cat.projects.iter().filter_map(|p|p.project["id"].as_str().map(str::to_string)).collect();
        let deleted=self.deleted()?;
        let mut pending=db.get("missingFiles")?.and_then(|v|v.as_object().cloned()).unwrap_or_default();
        let now=chrono::Utc::now().timestamp_millis();
        // 색인에 있거나 이미 삭제 표시한 문서는 아래 확인에서 대기 목록에서 빠진다.
        for doc in db.observations_except(|id|present.contains(id)||deleted.contains_key(id))?{
            let (Some(id),Some(pid),Some(path))=(doc["id"].as_str(),doc["projectId"].as_str(),doc["path"].as_str()) else{continue};
            if present.contains(id)||deleted.contains_key(id){pending.remove(id);continue;}
            if !Path::new(path).starts_with(&self.root){continue;}
            pending.entry(id.to_string()).or_insert_with(||json!({"projectId":pid,"path":path,"since":now,"project":false}));
        }
        for (pid,path) in before_projects {
            let key=project_tombstone(pid);
            if !projects.contains(pid)&&!deleted.contains_key(&key) {
                pending.entry(key).or_insert_with(||json!({"projectId":pid,"path":path.to_string_lossy(),"since":now,"project":true}));
            }
        }
        for (id,info) in pending.clone(){
            let pid=info["projectId"].as_str().unwrap_or("");
            if present.contains(&id)||(info["project"].as_bool()==Some(true)&&projects.contains(pid))||deleted.contains_key(&id){
                pending.remove(&id);continue;
            }
            let path=Path::new(info["path"].as_str().unwrap_or(""));
            if !path.starts_with(&self.root){pending.remove(&id);continue;}
            match fs::metadata(path){
                Ok(_)=>{pending.remove(&id);}
                Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{
                    if now-info["since"].as_i64().unwrap_or(now)>=5_000{
                        self.tombstone(&id,pid,&now_iso())?;pending.remove(&id);
                    }
                }
                Err(e)=>cat.warnings.push(format!("삭제 여부를 확인하지 못했습니다: {}: {e}",path.to_string_lossy())),
            }
        }
        db.set("missingFiles",&Value::Object(pending))
    }

    pub fn cached_body(&mut self, project_id: &str, id: &str) -> Result<String, LofError> {
        if let Ok(b) = self.index.body(project_id, id) {
            return Ok(b);
        }
        let fpath = self
            .catalog
            .as_ref()
            .and_then(|cat| {
                cat.projects
                    .iter()
                    .find(|p| p.project.get("id").and_then(|v| v.as_str()) == Some(project_id))
            })
            .and_then(|p| {
                p.files
                    .values()
                    .find(|f| f.entry.get("id").and_then(|v| v.as_str()) == Some(id))
                    .and_then(|f| f.entry.get("path").and_then(|v| v.as_str()))
                    .map(|rel| abs(&p.dir, rel))
            })
            .ok_or_else(|| fail("문서를 찾을 수 없습니다.", "NOT_FOUND"))?;
        let raw = fs::read_to_string(&fpath)?;
        let body = read_markdown(&raw)?.body;
        self.index.cache_body(project_id, id, &body)?;
        Ok(body)
    }

    pub fn scan(&mut self) -> Result<Catalog, LofError> {
        if !self.index_enabled || self.catalog.is_none() {
            return self.scan_disk();
        }
        self.refresh_index(false)?;
        let cat = self.catalog.as_ref().unwrap();
        let mut warnings = cat.warnings.clone();
        for p in &cat.projects {
            for err in p.errors.values() {
                warnings.push(err.clone());
            }
        }
        Ok(Catalog {
            projects: cat.projects.clone(),
            warnings,
        })
    }

    pub fn scan_disk(&mut self) -> Result<Catalog, LofError> {
        let mut projects = Vec::new();
        let mut warnings = Vec::new();
        let mut seen = HashSet::new();

        static EP_NUM_RE: OnceLock<Regex> = OnceLock::new();
        let ep_re = EP_NUM_RE.get_or_init(|| Regex::new(r"^episodes/(\d+)").unwrap());
        static NUM_PREFIX_RE: OnceLock<Regex> = OnceLock::new();
        let num_re = NUM_PREFIX_RE.get_or_init(|| Regex::new(r"^\d+\s+").unwrap());

        let mut dir_entries: Vec<_> = fs::read_dir(&self.root)
            .map(|rd| rd.filter_map(|e| e.ok()).collect())
            .unwrap_or_default();
        dir_entries.sort_by_key(|e| e.file_name());

        for e in dir_entries {
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let folder_name = e.file_name().to_string_lossy().to_string();
            if folder_name.starts_with('.') {
                continue;
            }
            let dir = self.root.join(&folder_name);
            let res: Result<(), LofError> = (|| {
                let Some((mut proj, from_backup)) = read_project_from_dir(&dir)? else {
                    return Ok(());
                };
                let proj_id = proj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !seen.insert(proj_id.clone()) {
                    warnings.push(format!(
                        "{}: 다른 작품 폴더와 ID가 겹쳐 건너뜁니다.",
                        folder_name
                    ));
                    return Ok(());
                }
                if from_backup {
                    warnings.push(format!("{}: 복구용 작품 정보 사본으로 열었습니다.", folder_name));
                }
                let cached: Vec<Value> = proj
                    .get("documents")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut discovered: Vec<Value> = Vec::new();
                let mut files: HashMap<String, IndexedFileRecord> = HashMap::new();
                let mut errors: HashMap<String, String> = HashMap::new();

                for rel in walk_rel(&dir, "episodes") {
                    if !rel.to_ascii_lowercase().ends_with(".md") {
                        continue;
                    }
                    let fpath = abs(&dir, &rel);
                    let ep_res: Result<(), LofError> = (|| {
                        let (raw, stat) = read_document_file(&fpath)?;
                        let old = cached.iter().find(|d| {
                            d.get("path")
                                .and_then(|v| v.as_str())
                                .is_some_and(|p| p.eq_ignore_ascii_case(&rel))
                        });
                        let fallback = match old {
                            Some(o) => o.clone(),
                            None => {
                                let order_num = ep_re
                                    .captures(&rel)
                                    .and_then(|c| c.get(1))
                                    .and_then(|m| m.as_str().parse::<i64>().ok())
                                    .unwrap_or(1);
                                let bn = base_name(&rel);
                                json!({
                                    "id": memo_id(&proj_id, &rel),
                                    "kind": "episode",
                                    "path": rel,
                                    "title": num_re.replace(&bn, "").to_string(),
                                    "order": (order_num - 1).max(0),
                                    "createdAt": stat.created().or_else(|_| stat.modified()).map(sys_time_to_iso).unwrap_or_else(|_| now_iso()),
                                    "updatedAt": stat.modified().map(sys_time_to_iso).unwrap_or_else(|_| now_iso()),
                                })
                            }
                        };
                        let mut entry = markdown_entry(&raw, &fallback)?;
                        let eid = entry
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if discovered
                            .iter()
                            .any(|d| d.get("id").and_then(|v| v.as_str()) == Some(&eid))
                        {
                            return Err(fail(
                                "같은 문서 ID를 가진 파일이 여러 개 있습니다.",
                                "DUPLICATE",
                            ));
                        }
                        let parsed = read_markdown(&raw)?;
                        if let Some(eobj) = entry.as_object_mut() {
                            if parsed.properties.get("lof").and_then(|v| v.as_i64()) == Some(1) {
                                eobj.insert("_markdown".to_string(), json!(true));
                            }
                            eobj.insert("hash".to_string(), json!(hash_str(&parsed.body)));
                        }
                        discovered.push(entry.clone());
                        let rec = self.index_record(&dir, &proj, &entry, &raw, &stat)?;
                        files.insert(rel.clone(), rec);
                        Ok(())
                    })();
                    if let Err(err) = ep_res {
                        self.retry_busy_file(&fpath, &err);
                        if err.code != "ENOENT" {
                            errors.insert(
                                rel.clone(),
                                format!("{} · {}: {}", folder_name, rel, err.message),
                            );
                        }
                    }
                }

                if proj.get("fileCentric").and_then(|v| v.as_bool()) != Some(true) {
                    for d in cached {
                        let did = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        if !discovered
                            .iter()
                            .any(|x| x.get("id").and_then(|v| v.as_str()) == Some(did))
                        {
                            discovered.push(d);
                        }
                    }
                }

                if let Some(pobj) = proj.as_object_mut() {
                    pobj.insert("documents".to_string(), Value::Array(discovered));
                }

                let mut doc_warnings = Vec::new();
                let doc_entries = self.scan_doc_files_disk(&dir, &proj, &mut doc_warnings);
                for entry in doc_entries {
                    let rel = entry
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let fpath = abs(&dir, &rel);
                    let (raw, stat) = match read_document_file(&fpath) {
                        Ok(value) => value,
                        Err(error) => {
                            self.retry_busy_file(&fpath, &error);
                            errors.insert(rel.clone(), format!("{} · {}: {}", folder_name, rel, error.message));
                            continue;
                        }
                    };
                    let eid = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if files
                        .values()
                        .any(|f| f.entry.get("id").and_then(|v| v.as_str()) == Some(eid))
                    {
                        errors.insert(
                            rel.clone(),
                            format!(
                                "{} · {}: 같은 문서 ID를 가진 파일이 여러 개 있습니다.",
                                folder_name, rel
                            ),
                        );
                        continue;
                    }
                    match self.index_record(&dir, &proj, &entry, &raw, &stat) {
                        Ok(rec) => { files.insert(rel, rec); }
                        Err(error) => { errors.insert(rel.clone(), format!("{} · {}: {}", folder_name, rel, error.message)); }
                    }
                }
                for w in doc_warnings {
                    errors.insert(w.clone(), w);
                }

                let project_stamp = self.stamp(&dir.join("project.json"))?;
                projects.push(CatalogProject {
                    dir,
                    project: proj,
                    from_backup,
                    files,
                    errors,
                    project_stamp,
                });
                Ok(())
            })();
            if let Err(err) = res {
                warnings.push(format!("{}: {}", folder_name, err.message));
            }
        }

        Ok(Catalog { projects, warnings })
    }

    fn scan_doc_files_disk(
        &self,
        dir: &Path,
        project: &Value,
        warnings: &mut Vec<String>,
    ) -> Vec<Value> {
        let mut out = Vec::new();
        let title = project.get("title").and_then(|v| v.as_str()).unwrap_or("");
        for rel in walk_rel(dir, "doc") {
            if !rel.to_ascii_lowercase().ends_with(".md") {
                continue;
            }
            let fpath = abs(dir, &rel);
            let res: Result<Value, LofError> = (|| {
                let stat = fs::metadata(&fpath)?;
                let raw = fs::read_to_string(&fpath)?;
                doc_entry(project, &rel, &stat, &raw)
            })();
            match res {
                Ok(entry) => out.push(entry),
                Err(e) => {
                    if e.code != "ENOENT" {
                        warnings.push(format!("{} · {}: {}", title, rel, e.message));
                    }
                }
            }
        }
        out
    }

    pub fn doc_files(&self, p: &CatalogProject) -> Vec<Value> {
        if self.index_enabled && !p.files.is_empty() {
            return p
                .files
                .iter()
                .filter(|(rel, _)| rel.starts_with("doc/"))
                .map(|(_, f)| f.entry.clone())
                .collect();
        }
        let mut dummy = Vec::new();
        self.scan_doc_files_disk(&p.dir, &p.project, &mut dummy)
    }

    pub fn get_project(&mut self, id: &str) -> Result<CatalogProject, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 작품 ID"));
        }
        let cat = self.scan()?;
        cat.projects
            .into_iter()
            .find(|x| x.project.get("id").and_then(|v| v.as_str()) == Some(id))
            .ok_or_else(|| fail("작품을 찾을 수 없습니다.", "NOT_FOUND"))
    }

    pub fn find_doc(&mut self, id: &str) -> Result<(CatalogProject, Value, PathBuf), LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID"));
        }
        // 색인을 쓰면 카탈로그 전체를 복제하지 않고 찾은 작품만 복제한다.
        if !self.index_enabled || self.catalog.is_none() {
            let cat = self.scan_disk()?;
            return self.find_doc_in(&cat.projects, id);
        }
        self.refresh_index(false)?;
        let cat = self.catalog.as_ref().unwrap();
        self.find_doc_in(&cat.projects, id)
    }

    fn find_doc_in(&self, projects: &[CatalogProject], id: &str) -> Result<(CatalogProject, Value, PathBuf), LofError> {
        let mut found: Option<(&CatalogProject, Value)> = None;
        for p in projects {
            let same = |entry: &Value| entry.get("id").and_then(|v| v.as_str()) == Some(id);
            let listed = p.project.get("documents").and_then(|v| v.as_array()).into_iter().flatten()
                .filter(|entry| same(entry)).cloned();
            let doc_entries: Vec<Value> = if self.index_enabled && !p.files.is_empty() {
                p.files
                    .iter()
                    .filter(|(rel, f)| rel.starts_with("doc/") && same(&f.entry))
                    .map(|(_, f)| f.entry.clone())
                    .collect()
            } else {
                self.doc_files(p).into_iter().filter(|entry| same(entry)).collect()
            };
            for entry in listed.chain(doc_entries) {
                if found.is_some() {
                    return Err(fail(
                        "같은 문서 ID를 가진 파일이 여러 개 있습니다. 사본에는 새 ID를 지정해 주세요.",
                        "DUPLICATE",
                    ));
                }
                found = Some((p, entry));
            }
        }
        let (p, entry) = found.ok_or_else(|| fail("문서를 찾을 수 없습니다.", "NOT_FOUND"))?;
        let file = abs(&p.dir, entry.get("path").and_then(|v| v.as_str()).unwrap_or(""));
        Ok((p.clone(), entry, file))
    }

    pub fn write_project(&self, p: &CatalogProject) -> Result<(), LofError> {
        let mut project = p.project.clone();
        if let Some(pobj) = project.as_object_mut() {
            let file_centric = pobj
                .get("fileCentric")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if file_centric {
                pobj.insert("documents".to_string(), json!([]));
            } else if let Some(docs) = pobj.get("documents").and_then(|v| v.as_array()).cloned() {
                let mapped: Vec<Value> = docs
                    .into_iter()
                    .map(|mut d| {
                        let is_md = d
                            .get("_markdown")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if is_md {
                            json!({
                                "id": d.get("id"),
                                "kind": d.get("kind"),
                                "path": d.get("path"),
                                "order": d.get("order"),
                                "hash": d.get("hash"),
                            })
                        } else {
                            if let Some(dobj) = d.as_object_mut() {
                                dobj.remove("_markdown");
                                dobj.remove("properties");
                            }
                            d
                        }
                    })
                    .collect();
                pobj.insert("documents".to_string(), Value::Array(mapped));
            }
            if pobj
                .get("docMeta")
                .and_then(|v| v.as_object())
                .is_some_and(|m| m.is_empty())
            {
                pobj.remove("docMeta");
            }
        }
        let data = serde_json::to_string_pretty(&project).unwrap_or_default();
        // 회차 본문만 바뀐 저장에서는 작품 파일 내용이 그대로라 다시 만들지 않는다.
        for name in ["project.json", "project.backup.json"] {
            let file = p.dir.join(name);
            if fs::read_to_string(&file).ok().as_deref() != Some(data.as_str()) {
                atomic_write_str(&file, &data)?;
            }
        }
        Ok(())
    }

    fn ordered_projects(&self, projects: &[CatalogProject]) -> Result<Vec<Value>, LofError> {
        let saved = match &self.index.database {
            Some(db) => crate::project_order::load(&self.root, db)?.map(|order| json!(order.ids)),
            None => None,
        };
        let positions: HashMap<&str, usize> = saved
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(position, id)| id.as_str().map(|id| (id, position)))
            .collect();
        let mut ordered: Vec<Value> = projects.iter().map(public_project).collect();
        // 새로 발견한 작품은 기존 폴더 순서를 유지하며 저장된 목록 뒤에 둔다.
        ordered.sort_by_key(|project| {
            positions
                .get(project["id"].as_str().unwrap_or(""))
                .copied()
                .unwrap_or(usize::MAX)
        });
        Ok(ordered)
    }

    pub fn reorder_projects(&mut self, input: &Value) -> Result<bool, LofError> {
        self.require_database()?;
        if input.get("root").and_then(Value::as_str) != self.root.to_str() {
            return Err(fail(
                "서재가 변경되었습니다. 현재 서재에서 다시 순서를 바꿔 주세요.",
                "VAULT_CHANGED",
            ));
        }
        let ids = input
            .get("ids")
            .and_then(Value::as_array)
            .ok_or_else(|| fail_invalid("작품 ID 목록이 필요합니다."))?;
        let mut unique = HashSet::new();
        for value in ids {
            let id = value
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or_else(|| fail_invalid("올바른 작품 ID가 필요합니다."))?;
            if !unique.insert(id) {
                return Err(fail_invalid("작품 ID가 중복되었습니다."));
            }
        }
        let catalog = self.scan()?;
        if ids.len() != catalog.projects.len()
            || catalog.projects.iter().any(|project| {
                !unique.contains(project.project["id"].as_str().unwrap_or(""))
            })
        {
            return Err(fail(
                "작품 목록이 변경되었습니다. 목록을 다시 확인한 뒤 순서를 바꿔 주세요.",
                "CONFLICT",
            ));
        }
        let current: Vec<Value> = self
            .ordered_projects(&catalog.projects)?
            .iter()
            .map(|project| project["id"].clone())
            .collect();
        if &current == ids {
            return Ok(false);
        }
        crate::project_order::set(
            &self.root,
            self.database()?,
            ids.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        )?;
        self.list_cache = None;
        Ok(true)
    }

    pub fn list(&mut self) -> Result<Value, LofError> {
        if self.index_enabled && self.catalog.is_some() {
            self.refresh_index(false)?;
            let rev = self.sync_revision();
            if let Some((cached_rev, cached_val)) = &self.list_cache {
                if *cached_rev == rev {
                    return Ok(cached_val.clone());
                }
            }
            let cat = self.catalog.as_ref().unwrap();
            let projects_out = self.ordered_projects(&cat.projects)?;
            let mut documents = Vec::new();
            let unlinked: Vec<Value> = Vec::new();
            let missing_files: Vec<Value> = Vec::new();
            let mut warnings = cat.warnings.clone();
            for p in &cat.projects {
                for err in p.errors.values() {
                    warnings.push(err.clone());
                }
            }
            if !self.migration_warning.is_empty() {
                warnings.push(self.migration_warning.clone());
            }
            let mut ids = HashSet::new();
            for p in &cat.projects {
                for file in p.files.values() {
                    let doc_id = file
                        .doc
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !ids.insert(doc_id.clone()) {
                        warnings.push(format!("중복 문서 ID: {}", doc_id));
                        continue;
                    }
                    documents.push(file.doc.clone());
                }
            }
            documents.sort_by(|a, b| {
                let oa = a.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let ob = b.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
                oa.partial_cmp(&ob)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        let ta = a.get("title").and_then(|v| v.as_str()).unwrap_or("");
                        let tb = b.get("title").and_then(|v| v.as_str()).unwrap_or("");
                        ta.cmp(tb)
                    })
                    .then_with(|| {
                        let ia = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let ib = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        ia.cmp(ib)
                    })
            });
            let out = json!({
                "root": self.root.to_string_lossy().to_string(),
                "vault": self.vault,
                "projects": projects_out,
                "documents": documents,
                "unlinked": unlinked,
                "missing": missing_files,
                "warnings": warnings,
            });
            self.list_cache = Some((self.sync_revision(), out.clone()));
            return Ok(out);
        }

        let cat = self.scan()?;
        let projects_out = self.ordered_projects(&cat.projects)?;
        let mut documents = Vec::new();
        let mut unlinked = Vec::new();
        let mut missing_files = Vec::new();
        let mut warnings = cat.warnings.clone();
        if !self.migration_warning.is_empty() {
            warnings.push(self.migration_warning.clone());
        }

        for p in &cat.projects {
            let proj_id = p.project.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let proj_title = p
                .project
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let writing = normalize_writing(p.project.get("writing"));
            let mut add = |entry: &Value, raw: &str| -> Result<(), LofError> {
                let mut d = doc_of(&p.dir, proj_id, entry, raw)?;
                let body = d
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(dobj) = d.as_object_mut() {
                    dobj.remove("body");
                    dobj.insert("characters".to_string(), json!(character_count(&body, false)));
                    dobj.insert(
                        "platformCharacters".to_string(),
                        json!(count_for_writing(&manuscript_stats(&body), &writing)),
                    );
                }
                documents.push(d);
                Ok(())
            };

            let docs_arr = p
                .project
                .get("documents")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for entry in &docs_arr {
                let rel = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
                match fs::read_to_string(abs(&p.dir, rel)) {
                    Ok(raw) => {
                        if let Err(e) = add(entry, &raw) {
                            warnings.push(format!("{} · {}: {}", proj_title, rel, e.message));
                        }
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::NotFound {
                            missing_files.push(json!({
                                "projectId": proj_id,
                                "id": entry.get("id"),
                                "kind": entry.get("kind"),
                                "title": entry.get("title"),
                                "path": rel,
                            }));
                            warnings.push(format!(
                                "{} · {}: 파일을 찾을 수 없습니다.",
                                proj_title, rel
                            ));
                        } else {
                            warnings.push(format!("{} · {}: {}", proj_title, rel, e));
                        }
                    }
                }
            }
            for entry in self.doc_files(p) {
                let rel = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if let Ok(raw) = fs::read_to_string(abs(&p.dir, rel)) {
                    if let Err(e) = add(&entry, &raw) {
                        warnings.push(format!("{} · {}: {}", proj_title, rel, e.message));
                    }
                }
            }

            let tracked: HashSet<String> = docs_arr
                .iter()
                .filter_map(|d| d.get("path").and_then(|v| v.as_str()))
                .map(|s| s.to_lowercase())
                .collect();
            for rel in walk_rel(&p.dir, "episodes") {
                if rel.to_ascii_lowercase().ends_with(".md") && !tracked.contains(&rel.to_lowercase())
                {
                    unlinked.push(json!({
                        "projectId": proj_id,
                        "path": rel,
                    }));
                }
            }
        }

        documents.sort_by(|a, b| {
            let oa = a.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let ob = b.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
            oa.partial_cmp(&ob)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    let ta = a.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    let tb = b.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    ta.cmp(tb)
                })
                .then_with(|| {
                    let ia = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let ib = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    ia.cmp(ib)
                })
        });

        Ok(json!({
            "root": self.root.to_string_lossy().to_string(),
            "vault": self.vault,
            "projects": projects_out,
            "documents": documents,
            "unlinked": unlinked,
            "missing": missing_files,
            "warnings": warnings,
        }))
    }

    pub fn locate(&mut self, id: &str) -> Result<PathBuf, LofError> {
        Ok(self.find_doc(id)?.2)
    }

    pub fn read(&mut self, id: &str) -> Result<Value, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID"));
        }
        // 색인이 활성화된 경우 메타 정보는 DB/색인에서 가져오고 본문만 마크다운 원문 파일에서 직접 읽는다.
        // 원문 해시가 색인의 revision과 같으면 YAML 재해석과 관찰 DB 재기록을 건너뛴다.
        if self.index_enabled && self.catalog.is_some() {
            self.refresh_index(false)?;
            let mut found: Option<(PathBuf, String, Value, bool)> = None;
            let mut matches = 0usize;
            if let Some(cat) = self.catalog.as_ref() {
                for p in &cat.projects {
                    let same = |entry: &Value| entry.get("id").and_then(|v| v.as_str()) == Some(id);
                    let listed_count = p.project.get("documents").and_then(|v| v.as_array()).into_iter().flatten()
                        .filter(|entry| same(entry)).count();
                    let doc_count = p.files.iter()
                        .filter(|(rel, f)| rel.starts_with("doc/") && same(&f.entry))
                        .count();
                    matches += listed_count + doc_count;
                    if matches == 1 && found.is_none() {
                        if let Some((rel, rec)) = p.files.iter().find(|(_, f)| same(&f.entry)) {
                            if !rec.stamp.is_empty() && !p.errors.contains_key(rel) {
                                let file = abs(&p.dir, rel);
                                let rev = rec.doc.get("revision").and_then(Value::as_str).unwrap_or("").to_string();
                                let has_fm = rec.entry.get("_markdown").and_then(Value::as_bool) == Some(true);
                                found = Some((file, rev, rec.doc.clone(), has_fm));
                            }
                        }
                    }
                }
            }
            if matches > 1 {
                return Err(fail(
                    "같은 문서 ID를 가진 파일이 여러 개 있습니다. 사본에는 새 ID를 지정해 주세요.",
                    "DUPLICATE",
                ));
            }
            if let Some((file, expected_rev, mut doc, has_fm)) = found {
                let (raw, stat) = read_document_file(&file)?;
                if !expected_rev.is_empty() && hash_str(&raw) == expected_rev {
                    let body = read_markdown_body(&raw, has_fm)?;
                    if let Some(obj) = doc.as_object_mut() {
                        obj.remove("characters");
                        obj.remove("platformCharacters");
                        obj.insert("body".to_string(), json!(body));
                    }
                    return Ok(doc);
                }
                // 파일 내용이 색인과 달라졌으면(외부 편집 등) 메타데이터와 관찰 DB를 다시 맞춘다.
                let (p, entry, _) = self.find_doc(id)?;
                let proj_id = p.project.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let doc = doc_of(&p.dir, proj_id, &entry, &raw)?;
                if let Some(db) = &self.index.database {
                    return db.observe_file(&doc, &sys_time_to_iso(stat.modified()?), is_app_write(&file, &raw, &stat));
                }
                return Ok(doc);
            }
        }
        let (p, entry, file) = self.find_doc(id)?;
        let (raw, stat) = read_document_file(&file)?;
        let proj_id = p.project.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let doc = doc_of(&p.dir, proj_id, &entry, &raw)?;
        if let Some(db) = &self.index.database {
            return db.observe_file(&doc, &sys_time_to_iso(stat.modified()?), is_app_write(&file, &raw, &stat));
        }
        Ok(doc)
    }

    pub fn markdown(&mut self, id: &str) -> Result<String, LofError> {
        let (_, _, file) = self.find_doc(id)?;
        Ok(fs::read_to_string(&file)?)
    }

    pub fn move_files(&self, dir: &Path, moves: &[(String, String)]) -> Result<(), LofError> {
        let mut done: Vec<(String, String)> = Vec::new();
        let mut temps: Vec<(String, String, String)> = Vec::new();
        let res: Result<(), LofError> = (|| {
            for (from, to) in moves {
                let temp = format!("{}.{}.lofmv", from, &Uuid::new_v4().to_string()[..8]);
                rename_with_retry(&abs(dir, from), &abs(dir, &temp))?;
                done.push((from.clone(), temp.clone()));
                temps.push((from.clone(), temp, to.clone()));
            }
            for (_from, temp, to) in &temps {
                let target = abs(dir, to);
                if target.exists() {
                    return Err(fail("같은 이름의 파일이 이미 있습니다.", "EXISTS"));
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                rename_with_retry(&abs(dir, temp), &target)?;
                done.push((temp.clone(), to.clone()));
            }
            Ok(())
        })();
        if let Err(e) = res {
            for (from, to) in done.into_iter().rev() {
                let _ = rename_with_retry(&abs(dir, &to), &abs(dir, &from));
            }
            return Err(fail(format!("{} ({})", RENAME_FAILED, e.message), "RENAME"));
        }
        Ok(())
    }

    fn layout(&self, p: &mut CatalogProject) -> Result<(), LofError> {
        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut episodes: Vec<Value> = docs
            .iter()
            .filter(|d| d.get("kind").and_then(|v| v.as_str()) == Some("episode"))
            .cloned()
            .collect();
        episodes.sort_by(by_order_cmp);

        let mut number = HashMap::new();
        for (i, d) in episodes.iter().enumerate() {
            if let Some(id) = d.get("id").and_then(|v| v.as_str()) {
                number.insert(id.to_string(), (i + 1) as i64);
            }
        }

        let tracked: HashSet<String> = episodes
            .iter()
            .filter_map(|d| d.get("path").and_then(|v| v.as_str()))
            .map(|s| s.to_lowercase())
            .collect();
        let mut taken = HashSet::new();
        for rel in walk_rel(&p.dir, "episodes") {
            if !tracked.contains(&rel.to_lowercase()) {
                taken.insert(rel.to_lowercase());
            }
        }

        let mut present_indices = Vec::new();
        for (idx, d) in episodes.iter().enumerate() {
            let path = d.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if abs(&p.dir, path).exists() {
                present_indices.push(idx);
            } else {
                taken.insert(path.to_lowercase());
            }
        }

        let mut targets: HashMap<String, String> = HashMap::new();
        for &idx in &present_indices {
            let d = &episodes[idx];
            let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let cur = d.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let want = format!(
                "episodes/{} {}.md",
                pad(*number.get(id).unwrap_or(&1)),
                safe_name(title, "제목 없음")
            );
            if !cur.is_empty()
                && is_variant(cur, &want, ".md")
                && !taken.contains(&cur.to_lowercase())
            {
                taken.insert(cur.to_lowercase());
                targets.insert(id.to_string(), cur.to_string());
            }
        }
        for &idx in &present_indices {
            let d = &episodes[idx];
            let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !targets.contains_key(id) {
                let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let want = format!(
                    "episodes/{} {}.md",
                    pad(*number.get(id).unwrap_or(&1)),
                    safe_name(title, "제목 없음")
                );
                let assigned = unique_name(&want, ".md", &mut taken);
                targets.insert(id.to_string(), assigned);
            }
        }

        let mut moves = Vec::new();
        for &idx in &present_indices {
            let d = &episodes[idx];
            let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let cur = d.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(t) = targets.get(id) {
                if t != cur {
                    moves.push((cur.to_string(), t.clone()));
                }
            }
        }

        self.move_files(&p.dir, &moves)?;

        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            for d in arr {
                let id = d
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(t) = targets.get(&id) {
                    if let Some(dobj) = d.as_object_mut() {
                        dobj.insert("path".to_string(), json!(t));
                    }
                }
            }
        }
        Ok(())
    }

    fn backup_project(&self, p: &CatalogProject, reason: &[String]) -> Result<PathBuf, LofError> {
        let stamp = now_iso().replace([':', '.'], "-");
        let proj_id = p.project.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let dir = self
            .root
            .join(".lof")
            .join("recovery")
            .join(format!("{}-{}", stamp, proj_id));
        fs::create_dir_all(&dir)?;
        for name in ["project.json", "project.backup.json"] {
            let _ = fs::copy(p.dir.join(name), dir.join(name));
        }
        let folder = p
            .dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let reason_json = serde_json::to_string_pretty(&json!({
            "at": now_iso(),
            "folder": folder,
            "reason": reason,
        }))
        .unwrap_or_default();
        atomic_write_str(&dir.join("reason.json"), &reason_json)?;
        Ok(dir)
    }

    fn migrate_legacy(&self, p: &mut CatalogProject) -> Result<bool, LofError> {
        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let legacy: Vec<Value> = docs
            .iter()
            .filter(|d| d.get("kind").and_then(|v| v.as_str()) != Some("episode"))
            .cloned()
            .collect();
        let mut dirs = Vec::new();
        for root in ["memo", "plot"] {
            if abs(&p.dir, root).exists() {
                dirs.push(root);
            }
        }
        let has_archived_memos = p.project.get("archivedMemos").is_some();
        if legacy.is_empty() && dirs.is_empty() && !has_archived_memos {
            return Ok(false);
        }

        self.backup_project(p, &["plot/·memo/의 문서를 doc/으로 옮김".to_string()])?;
        fs::create_dir_all(abs(&p.dir, "doc"))?;

        let mut taken: HashSet<String> = walk_rel(&p.dir, "doc")
            .into_iter()
            .map(|r| r.to_lowercase())
            .collect();
        let mut moved: HashMap<String, String> = HashMap::new();
        let proj_id = p
            .project
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        for root in &dirs {
            for rel in walk_rel(&p.dir, root) {
                let ext = Path::new(&rel)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| format!(".{}", e))
                    .unwrap_or_default();
                let want = format!("doc/{}", &rel[root.len() + 1..]);
                let to = unique_name(&want, &ext, &mut taken);
                let target = abs(&p.dir, &to);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                rename_with_retry(&abs(&p.dir, &rel), &target)?;
                moved.insert(rel.to_lowercase(), to.clone());
                if *root == "memo" && rel.to_ascii_lowercase().ends_with(".md") {
                    let _ = rename_with_retry(
                        &self
                            .root
                            .join(".lof")
                            .join("history")
                            .join(memo_id(&proj_id, &rel)),
                        &self
                            .root
                            .join(".lof")
                            .join("history")
                            .join(memo_id(&proj_id, &to)),
                    );
                }
            }
        }

        for d in &legacy {
            let dpath = d.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let Some(to) = moved.get(&dpath.to_lowercase()) else {
                continue;
            };
            let role = d.get("role").and_then(|v| v.as_str());
            let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let is_memo = role == Some("memo") || (role.is_none() && title.contains("메모"));
            let mut patch = Map::new();
            patch.insert(
                "type".to_string(),
                json!(if is_memo { "memo" } else { "plot" }),
            );
            patch.insert(
                "episodeId".to_string(),
                d.get("episodeId").cloned().unwrap_or(Value::Null),
            );
            patch.insert(
                "archived".to_string(),
                json!(d.get("archived").and_then(|v| v.as_bool()).unwrap_or(false)),
            );
            for (k, v) in stored_document_meta(Some(d)) {
                patch.insert(k, v);
            }
            Self::set_doc_meta(p, to, &patch, false);
            if let Some(did) = d.get("id").and_then(|v| v.as_str()) {
                let _ = rename_with_retry(
                    &self.root.join(".lof").join("history").join(did),
                    &self
                        .root
                        .join(".lof")
                        .join("history")
                        .join(memo_id(&proj_id, to)),
                );
            }
        }

        if let Some(archived_memos) = p
            .project
            .get("archivedMemos")
            .and_then(|v| v.as_array())
            .cloned()
        {
            for r in archived_memos {
                if let Some(r_str) = r.as_str() {
                    if let Some(to) = moved.get(&r_str.to_lowercase()) {
                        let mut patch = Map::new();
                        patch.insert("archived".to_string(), json!(true));
                        Self::set_doc_meta(p, to, &patch, false);
                    }
                }
            }
        }

        if let Some(pobj) = p.project.as_object_mut() {
            pobj.remove("archivedMemos");
            let ep_only: Vec<Value> = docs
                .into_iter()
                .filter(|d| d.get("kind").and_then(|v| v.as_str()) == Some("episode"))
                .collect();
            pobj.insert("documents".to_string(), Value::Array(ep_only));
        }

        for root in dirs {
            prune_empty(&abs(&p.dir, root));
        }
        Ok(true)
    }

    fn migrate_properties(&self, p: &mut CatalogProject) -> Result<(), LofError> {
        let mut entries: Vec<Value> = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        entries.extend(self.doc_files(p));

        let mut changes: Vec<(Value, String, String)> = Vec::new();
        let mut migrated_docs: Vec<String> = Vec::new();

        for entry in entries {
            let rel = entry
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let file = abs(&p.dir, &rel);
            let raw = match fs::read_to_string(&file) {
                Ok(r) => r,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(LofError::from(e)),
            };
            let parsed = read_markdown(&raw)?;
            let props = markdown_entry(&raw, &entry)?;
            let is_ep = entry.get("kind").and_then(|v| v.as_str()) == Some("episode");
            let lof_ok = parsed.properties.get("lof").and_then(|v| v.as_i64()) == Some(1);
            let id_ok = parsed
                .properties
                .get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            let order_ok = !is_ep || parsed.properties.contains_key("order");
            if !lof_ok || !id_ok || !order_ok {
                let next = write_markdown(&parsed.body, &props, &raw)?;
                changes.push((entry.clone(), raw, next));
            }
            if !is_ep {
                migrated_docs.push(rel);
            }
        }

        let file_centric = p
            .project
            .get("fileCentric")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let prop_storage_md = p.project.get("propertyStorage").and_then(|v| v.as_str())
            == Some("markdown");
        let has_doc_meta = migrated_docs
            .iter()
            .any(|rel| !meta_of(&p.project, rel).is_empty());
        let cleanup = !file_centric || !prop_storage_md || has_doc_meta;

        if changes.is_empty() && !cleanup {
            return Ok(());
        }

        let backup = self.backup_project(
            p,
            &["문서 속성을 Markdown YAML 프런트매터로 이관".to_string()],
        )?;
        for (entry, raw, _) in &changes {
            let rel = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
            atomic_write_str(&abs(&backup, &format!("files/{}", rel)), raw)?;
        }
        for (entry, raw, next) in &changes {
            let rel = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let file = abs(&p.dir, rel);
            if fs::read_to_string(&file)? != *raw {
                return Err(fail(
                    "속성 이관 중 외부에서 파일이 변경됐습니다. 다시 열어 주세요.",
                    "CONFLICT",
                ));
            }
            atomic_write_str(&file, next)?;
        }
        for rel in &migrated_docs {
            Self::drop_doc_meta(p, rel);
        }
        if let Some(pobj) = p.project.as_object_mut() {
            pobj.insert("propertyStorage".to_string(), json!("markdown"));
            pobj.insert("fileCentric".to_string(), json!(true));
        }
        self.write_project(p)?;
        Ok(())
    }

    pub fn set_doc_meta(
        p: &mut CatalogProject,
        rel: &str,
        patch: &Map<String, Value>,
        replace: bool,
    ) {
        let mut all = p
            .project
            .get("docMeta")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let existing_key = all
            .keys()
            .find(|k| k.eq_ignore_ascii_case(rel))
            .cloned();
        let mut next = if replace {
            Map::new()
        } else if let Some(ref k) = existing_key {
            all.get(k).and_then(|v| v.as_object()).cloned().unwrap_or_default()
        } else {
            Map::new()
        };
        if let Some(k) = existing_key {
            all.remove(&k);
        }
        for (k, v) in patch {
            next.insert(k.clone(), v.clone());
        }
        next.retain(|k, v| {
            !(v.is_null()
                || v.as_bool() == Some(false)
                || v.as_array().is_some_and(|a| a.is_empty())
                || (k == "type" && v.as_str() == Some("memo")))
        });
        if !next.is_empty() {
            all.insert(rel.to_string(), Value::Object(next));
        }
        if let Some(pobj) = p.project.as_object_mut() {
            pobj.insert("docMeta".to_string(), Value::Object(all));
        }
    }

    pub fn move_doc_meta(p: &mut CatalogProject, from: &str, to: &str) -> bool {
        let mut changed = false;
        let f = from.to_lowercase();
        let f_slash = format!("{}/", f);
        let mut next = Map::new();
        if let Some(dm) = p.project.get("docMeta").and_then(|v| v.as_object()) {
            for (k, v) in dm {
                let low = k.to_lowercase();
                if low == f || low.starts_with(&f_slash) {
                    let new_key = format!("{}{}", to, &k[from.len()..]);
                    next.insert(new_key, v.clone());
                    changed = true;
                } else {
                    next.insert(k.clone(), v.clone());
                }
            }
        }
        if let Some(pobj) = p.project.as_object_mut() {
            pobj.insert("docMeta".to_string(), Value::Object(next));
        }
        changed
    }

    pub fn drop_doc_meta(p: &mut CatalogProject, rel: &str) -> bool {
        let f = rel.to_lowercase();
        let f_slash = format!("{}/", f);
        let Some(dm) = p.project.get("docMeta").and_then(|v| v.as_object()).cloned() else {
            return false;
        };
        let before = dm.len();
        let next: Map<String, Value> = dm
            .into_iter()
            .filter(|(k, _)| {
                let low = k.to_lowercase();
                low != f && !low.starts_with(&f_slash)
            })
            .collect();
        let changed = next.len() != before;
        if let Some(pobj) = p.project.as_object_mut() {
            pobj.insert("docMeta".to_string(), Value::Object(next));
        }
        changed
    }

    fn unlinked_files(&self, p: &CatalogProject) -> Result<Vec<(String, String, Option<String>)>, LofError> {
        let tracked: HashSet<String> = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|d| d.get("path").and_then(|v| v.as_str()))
                    .map(|s| s.to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Vec::new();
        for rel in walk_rel(&p.dir, "episodes") {
            if rel.to_ascii_lowercase().ends_with(".md") && !tracked.contains(&rel.to_lowercase()) {
                match fs::read_to_string(abs(&p.dir, &rel)) {
                    Ok(raw) => {
                        let parsed = read_markdown(&raw)?;
                        let h = hash_str(&parsed.body);
                        let id = parsed
                            .properties
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        out.push((rel, h, id));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(LofError::from(e)),
                }
            }
        }
        Ok(out)
    }

    pub fn repair(&mut self) -> Result<Value, LofError> {
        let prev_enabled = self.index_enabled;
        self.index_enabled = false;
        let res = (|| -> Result<Value, LofError> {
            let mut cat = self.scan_disk()?;
            let mut restored = Vec::new();
            let mut relinked = Vec::new();
            let mut ambiguous = Vec::new();

            for p in &mut cat.projects {
                let mut write = self.migrate_legacy(p)?;
                let mut reasons = Vec::new();
                let proj_id = p
                    .project
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if p.from_backup {
                    reasons.push("project.json을 읽지 못해 project.backup.json으로 되살림".to_string());
                    restored.push(proj_id.clone());
                }

                let mut lost_indices = Vec::new();
                if let Some(docs) = p
                    .project
                    .get_mut("documents")
                    .and_then(|v| v.as_array_mut())
                {
                    for (idx, d) in docs.iter_mut().enumerate() {
                        let rel = d.get("path").and_then(|v| v.as_str()).unwrap_or("");
                        match fs::read_to_string(abs(&p.dir, rel)) {
                            Ok(raw) => {
                                let h = hash_str(&read_markdown(&raw)?.body);
                                if d.get("hash").and_then(|v| v.as_str()) != Some(&h) {
                                    if let Some(dobj) = d.as_object_mut() {
                                        dobj.insert("hash".to_string(), json!(h));
                                    }
                                    write = true;
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                                lost_indices.push(idx);
                            }
                            Err(e) => return Err(LofError::from(e)),
                        }
                    }
                }

                if !lost_indices.is_empty() {
                    let files = self.unlinked_files(p)?;
                    let root_of =
                        |rel: &str| rel.split('/').next().unwrap_or("").to_string();
                    let name_of = |rel: &str| {
                        rel.rfind('/')
                            .map(|i| &rel[i + 1..])
                            .unwrap_or(rel)
                            .to_lowercase()
                    };
                    let mut pick: HashMap<usize, String> = HashMap::new();
                    let docs_snapshot = p
                        .project
                        .get("documents")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();

                    for &idx in &lost_indices {
                        let d = &docs_snapshot[idx];
                        let did = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let dhash = d.get("hash").and_then(|v| v.as_str());
                        let dpath = d.get("path").and_then(|v| v.as_str()).unwrap_or("");
                        let dtitle = d.get("title").and_then(|v| v.as_str()).unwrap_or("");

                        let mut found: Vec<&(String, String, Option<String>)> = files
                            .iter()
                            .filter(|f| f.2.as_deref() == Some(did))
                            .collect();
                        if found.is_empty() {
                            if let Some(dh) = dhash {
                                found = files
                                    .iter()
                                    .filter(|f| {
                                        f.1 == dh && (f.2.is_none() || f.2.as_deref() == Some(did))
                                    })
                                    .collect();
                            }
                        }
                        if found.is_empty() {
                            found = files
                                .iter()
                                .filter(|f| {
                                    (f.2.is_none() || f.2.as_deref() == Some(did))
                                        && root_of(&f.0) == root_of(dpath)
                                        && name_of(&f.0) == name_of(dpath)
                                })
                                .collect();
                        }
                        if found.len() == 1 {
                            pick.insert(idx, found[0].0.clone());
                        } else if found.len() > 1 {
                            ambiguous.push(json!({
                                "projectId": proj_id,
                                "id": did,
                                "title": dtitle,
                            }));
                        }
                    }

                    let mut claims: HashMap<String, usize> = HashMap::new();
                    for fpath in pick.values() {
                        *claims.entry(fpath.clone()).or_insert(0) += 1;
                    }
                    if let Some(docs) = p
                        .project
                        .get_mut("documents")
                        .and_then(|v| v.as_array_mut())
                    {
                        for (idx, fpath) in pick {
                            let d = &mut docs[idx];
                            let did = d
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let dtitle = d
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let dpath = d
                                .get("path")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if claims.get(&fpath).copied().unwrap_or(0) > 1 {
                                ambiguous.push(json!({
                                    "projectId": proj_id,
                                    "id": did,
                                    "title": dtitle,
                                }));
                            } else {
                                reasons.push(format!("{} → {}", dpath, fpath));
                                relinked.push(json!({
                                    "projectId": proj_id,
                                    "id": did,
                                    "from": dpath,
                                    "to": fpath,
                                }));
                                if let Some(dobj) = d.as_object_mut() {
                                    dobj.insert("path".to_string(), json!(fpath));
                                }
                                write = true;
                            }
                        }
                    }
                }

                if !reasons.is_empty() {
                    self.backup_project(p, &reasons)?;
                }
                if write || p.from_backup {
                    self.write_project(p)?;
                }
                self.migrate_properties(p)?;
            }

            self.migration_warning.clear();
            let fresh_cat = self.scan_disk()?;
            let vault_id = self
                .vault
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            self.index.dirty.clear();
            self.index.save(&vault_id, &fresh_cat)?;
            self.catalog = Some(fresh_cat);
            self.list_cache = None;
            self.index_enabled = true;
            self.index_sequence = CHANGE_SEQUENCE.load(Ordering::SeqCst);

            Ok(json!({
                "restored": restored,
                "relinked": relinked,
                "ambiguous": ambiguous,
            }))
        })();

        if res.is_err() {
            self.index_enabled = prev_enabled;
        }
        res
    }

    pub fn project_file(&mut self, project_id: &str, rel: &str) -> Result<PathBuf, LofError> {
        if !valid_rel(rel) {
            return Err(fail_invalid("잘못된 경로"));
        }
        let p = self.get_project(project_id)?;
        Ok(abs(&p.dir, rel))
    }

    pub fn relink_document(&mut self, input: &Value) -> Result<Value, LofError> {
        let project_id = input.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
        let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");

        let mut p = self.get_project(project_id)?;
        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let Some(entry_idx) = docs
            .iter()
            .position(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
        else {
            return Err(fail("문서를 찾을 수 없습니다.", "NOT_FOUND"));
        };
        let old_path = docs[entry_idx]
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if abs(&p.dir, old_path).exists() {
            return Err(fail_invalid("이 문서의 파일은 이미 있습니다."));
        }
        let unlinked = self.unlinked_files(&p)?;
        let Some((file_path, file_hash, _)) = unlinked.into_iter().find(|f| f.0 == path) else {
            return Err(fail_invalid("연결되지 않은 파일이 아닙니다."));
        };
        let raw = fs::read_to_string(abs(&p.dir, &file_path))?;
        let backup = self.backup_project(&p, &[format!("수동 연결: {} → {}", old_path, file_path)])?;
        atomic_write_str(&abs(&backup, &format!("files/{}", file_path)), &raw)?;

        let mut entry = markdown_entry(&raw, &docs[entry_idx])?;
        if let Some(eobj) = entry.as_object_mut() {
            eobj.insert("path".to_string(), json!(file_path));
            eobj.insert("hash".to_string(), json!(file_hash));
            eobj.insert("_markdown".to_string(), json!(true));
        }
        let body = read_markdown(&raw)?.body;
        atomic_write_str(
            &abs(&p.dir, &file_path),
            &write_markdown(&body, &entry, &raw)?,
        )?;
        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            arr[entry_idx] = entry;
        }
        self.write_project(&p)?;
        self.read(id)
    }

    pub fn adopt_file(&mut self, input: &Value) -> Result<Value, LofError> {
        let project_id = input.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(k) = input.get("kind").and_then(|v| v.as_str()) {
            if k != "episode" {
                return Err(fail_invalid("회차만 등록할 수 있습니다."));
            }
        }
        let mut p = self.get_project(project_id)?;
        let unlinked = self.unlinked_files(&p)?;
        let Some((file_path, file_hash, file_id)) = unlinked.into_iter().find(|f| f.0 == path)
        else {
            return Err(fail_invalid("연결되지 않은 파일이 아닙니다."));
        };

        let cat = self.scan()?;
        let available_id = file_id.as_deref().is_some_and(|fid| {
            valid_id(fid)
                && !cat.projects.iter().any(|proj| {
                    proj.project
                        .get("documents")
                        .and_then(|v| v.as_array())
                        .is_some_and(|arr| {
                            arr.iter()
                                .any(|d| d.get("id").and_then(|v| v.as_str()) == Some(fid))
                        })
                })
        });
        let id = if available_id {
            file_id.unwrap()
        } else {
            Uuid::new_v4().to_string()
        };

        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let max_order = docs
            .iter()
            .filter(|d| d.get("kind").and_then(|v| v.as_str()) == Some("episode"))
            .filter_map(|d| d.get("order").and_then(|v| v.as_i64()))
            .max();
        let order = max_order.map(|m| m + 1).unwrap_or(0);

        static NUM_PREFIX_RE: OnceLock<Regex> = OnceLock::new();
        let num_re = NUM_PREFIX_RE.get_or_init(|| Regex::new(r"^\d+\s+").unwrap());
        let bn = base_name(&file_path);
        let stripped = num_re.replace(&bn, "").to_string();
        let title = if stripped.is_empty() {
            "제목 없음".to_string()
        } else {
            stripped
        };
        let now = now_iso();
        let manual_lb = line_break_default(Some(&p.project), self.default_manual_line_break);

        let mut base_entry = json!({
            "id": id,
            "kind": "episode",
            "title": title,
            "status": "in_progress",
            "order": order,
            "archived": false,
            "createdAt": now,
            "updatedAt": now,
            "hash": file_hash,
            "path": file_path,
        });
        if manual_lb {
            if let Some(o) = base_entry.as_object_mut() {
                o.insert("manualLineBreak".to_string(), json!(true));
            }
        }

        let raw = fs::read_to_string(abs(&p.dir, &file_path))?;
        let backup = self.backup_project(&p, &[format!("파일 등록: {}", file_path)])?;
        atomic_write_str(&abs(&backup, &format!("files/{}", file_path)), &raw)?;

        let mut entry = markdown_entry(&raw, &base_entry)?;
        let entry_id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let body = read_markdown(&raw)?.body;
        atomic_write_str(
            &abs(&p.dir, &file_path),
            &write_markdown(&body, &entry, &raw)?,
        )?;
        if let Some(eobj) = entry.as_object_mut() {
            eobj.insert("_markdown".to_string(), json!(true));
        }
        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            arr.push(entry);
        }
        let _ = self.layout(&mut p);
        self.write_project(&p)?;
        self.read(&entry_id)
    }

    pub fn forget_document(&mut self, input: &Value) -> Result<bool, LofError> {
        let project_id = input.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
        let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let mut p = self.get_project(project_id)?;
        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let Some(entry) = docs
            .iter()
            .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
        else {
            return Err(fail("문서를 찾을 수 없습니다.", "NOT_FOUND"));
        };
        let rel = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if abs(&p.dir, rel).exists() {
            return Err(fail_invalid(
                "파일이 있는 문서는 연결을 끊을 수 없습니다. 삭제를 사용해 주세요.",
            ));
        }
        self.backup_project(&p, &[format!("연결 해제: {}", rel)])?;
        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            arr.retain(|d| d.get("id").and_then(|v| v.as_str()) != Some(id));
        }
        self.write_project(&p)?;
        Ok(true)
    }

    pub fn create_project(&mut self, input: &Value) -> Result<Value, LofError> {
        self.require_database()?;
        let p = self.new_project(input, &Value::Null)?;
        Ok(public_project(&p))
    }

    pub fn new_project(
        &mut self,
        input: &Value,
        fixed: &Value,
    ) -> Result<CatalogProject, LofError> {
        let cat = self.scan()?;
        let used: HashSet<i64> = cat
            .projects
            .iter()
            .filter_map(|p| p.project.get("index").and_then(|v| v.as_i64()))
            .collect();
        let fixed_index = fixed.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
        let index = if fixed_index > 0 && !used.contains(&fixed_index) {
            fixed_index
        } else {
            used.iter().copied().max().unwrap_or(0) + 1
        };

        let raw_title = input
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("제목 없는 작품");
        let title = slice_utf16(raw_title, 300);

        let mut taken: HashSet<String> = fs::read_dir(&self.root)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        let folder = unique_name(
            &format!("{} {}", pad(index), safe_name(&title, "제목 없는 작품")),
            "",
            &mut taken,
        );
        let now = now_iso();
        let id = fixed
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let description = slice_utf16(
            input
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            3000,
        );
        let tags = normalize_tags(input.get("tags"))?;
        let writing = normalize_writing(input.get("writing"));
        let cover = fixed.get("cover").cloned().unwrap_or(Value::Null);
        let created_at = fixed
            .get("createdAt")
            .and_then(|v| v.as_str())
            .unwrap_or(&now)
            .to_string();
        let updated_at = fixed
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .unwrap_or(&now)
            .to_string();

        let mut proj = Map::new();
        proj.insert("format".to_string(), json!(FORMAT));
        proj.insert("id".to_string(), json!(id));
        proj.insert("index".to_string(), json!(index));
        proj.insert("title".to_string(), json!(title));
        proj.insert("description".to_string(), json!(description));
        proj.insert("tags".to_string(), json!(tags));
        proj.insert("writing".to_string(), writing);
        if let Some(mlb) = input.get("manualLineBreak").and_then(|v| v.as_bool()) {
            proj.insert("manualLineBreak".to_string(), json!(mlb));
        }
        proj.insert("cover".to_string(), cover);
        proj.insert("createdAt".to_string(), json!(created_at));
        proj.insert("updatedAt".to_string(), json!(updated_at));
        proj.insert("documents".to_string(), json!([]));
        proj.insert("propertyStorage".to_string(), json!("markdown"));
        proj.insert("fileCentric".to_string(), json!(true));
        if let Some(folders) = input.get("archivedDocFolders") {
            if !folders.as_array().is_some_and(|a| a.iter().all(|v| v.as_str().is_some_and(valid_rel))) {
                return Err(fail_invalid("잘못된 폴더 보관 목록"));
            }
            proj.insert("archivedDocFolders".to_string(), folders.clone());
        }

        let p = CatalogProject {
            dir: self.root.join(folder),
            project: Value::Object(proj),
            from_backup: false,
            files: HashMap::new(),
            errors: HashMap::new(),
            project_stamp: None,
        };
        for f in FOLDERS {
            fs::create_dir_all(p.dir.join(f))?;
        }
        self.write_project(&p)?;
        Ok(p)
    }

    pub fn update_project(&mut self, input: &Value) -> Result<Value, LofError> {
        self.update_project_inner(input, false)
    }

    pub fn update_project_inner(
        &mut self,
        input: &Value,
        keep_time: bool,
    ) -> Result<Value, LofError> {
        let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let mut p = self.get_project(id)?;
        let old = p.project.as_object().cloned().unwrap_or_default();

        let title = if let Some(t) = input.get("title") {
            if !t.is_null() {
                slice_utf16(t.as_str().unwrap_or(""), 300)
            } else {
                slice_utf16(old.get("title").and_then(|v| v.as_str()).unwrap_or(""), 300)
            }
        } else {
            slice_utf16(old.get("title").and_then(|v| v.as_str()).unwrap_or(""), 300)
        };

        let description = if let Some(d) = input.get("description") {
            if !d.is_null() {
                slice_utf16(d.as_str().unwrap_or(""), 3000)
            } else {
                slice_utf16(
                    old.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                    3000,
                )
            }
        } else {
            slice_utf16(
                old.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                3000,
            )
        };

        let mut next = old.clone();
        next.insert("title".to_string(), json!(title));
        next.insert("description".to_string(), json!(description));
        if let Some(folders) = input.get("archivedDocFolders") {
            if !folders.as_array().is_some_and(|a| a.iter().all(|v| v.as_str().is_some_and(valid_rel))) {
                return Err(fail_invalid("잘못된 폴더 보관 목록"));
            }
            next.insert("archivedDocFolders".to_string(), folders.clone());
        }

        if let Some(tags_in) = input.get("tags") {
            next.insert("tags".to_string(), json!(normalize_tags(Some(tags_in))?));
        }
        if let Some(w_in) = input.get("writing") {
            next.insert("writing".to_string(), normalize_writing(Some(w_in)));
        }
        if let Some(mlb_in) = input.as_object().and_then(|o| o.get("manualLineBreak")) {
            if let Some(b) = mlb_in.as_bool() {
                next.insert("manualLineBreak".to_string(), json!(b));
            } else {
                next.remove("manualLineBreak");
            }
        }
        if let Some(cov_in) = input.as_object().and_then(|o| o.get("cover")) {
            if cov_in.is_null() {
                next.insert("cover".to_string(), Value::Null);
            } else if valid_cover(cov_in.as_str()) {
                next.insert("cover".to_string(), cov_in.clone());
            } else {
                return Err(fail_invalid("잘못된 표지 경로"));
            }
        }
        let updated_at = if keep_time {
            input
                .get("updatedAt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(now_iso)
        } else {
            now_iso()
        };
        next.insert("updatedAt".to_string(), json!(updated_at));
        p.project = Value::Object(next);

        let index = p.project.get("index").and_then(|v| v.as_i64()).unwrap_or(1);
        let want = format!("{} {}", pad(index), safe_name(&title, "제목 없는 작품"));
        let cur_folder = p
            .dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if !is_variant(&cur_folder, &want, "") {
            let mut taken: HashSet<String> = fs::read_dir(&self.root)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .filter(|n| n != &cur_folder)
                        .map(|n| n.to_lowercase())
                        .collect()
                })
                .unwrap_or_default();
            let next_dir = self.root.join(unique_name(&want, "", &mut taken));
            if rename_with_retry(&p.dir, &next_dir).is_ok() {
                p.dir = next_dir;
            }
        }
        self.write_project(&p)?;
        Ok(public_project(&p))
    }

    pub fn set_cover(&mut self, id: &str, data: &[u8]) -> Result<Value, LofError> {
        let filename = validate_cover(data, None)?;
        let p = self.get_project(id)?;
        atomic_write_bytes(&p.dir.join("assets").join(&filename), data)?;
        self.update_project(&json!({ "id": id, "cover": filename }))
    }

    pub fn cover_data(&mut self, project: &Value) -> Result<Value, LofError> {
        let cover = project.get("cover").and_then(|v| v.as_str());
        let folder = project.get("folder").and_then(|v| v.as_str());
        if !valid_cover(cover) || folder.is_none() {
            return Ok(Value::Null);
        }
        let file = self
            .root
            .join(folder.unwrap())
            .join("assets")
            .join(cover.unwrap());
        match fs::metadata(&file) {
            Ok(m) => {
                if m.len() > 8_000_000 {
                    return Err(fail_invalid("표지 용량 초과"));
                }
                let modified = m.modified().ok();
                if let Some((len, at, data)) = self.cover_cache.get(&file) {
                    if *len == m.len() && *at == modified && modified.is_some() {
                        return Ok(data.clone());
                    }
                }
                let bytes = fs::read(&file)?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                let data = json!(format!("data:image/png;base64,{}", b64));
                self.cover_cache.insert(file, (m.len(), modified, data.clone()));
                Ok(data)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.cover_cache.remove(&file);
                Ok(Value::Null)
            }
            Err(e) => Err(LofError::from(e)),
        }
    }

    pub fn create(&mut self, input: &Value) -> Result<Value, LofError> {
        self.create_inner(input, &Value::Null)
    }

    pub fn create_inner(&mut self, input: &Value, fixed: &Value) -> Result<Value, LofError> {
        self.require_database()?;
        let kind = input
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("episode");
        if !KINDS.contains(&kind) {
            return Err(fail_invalid("잘못된 문서 종류"));
        }
        let project_id = input.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
        let mut p = self.get_project(project_id)?;
        let body = input
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if utf16_len(&body) > 10_000_000 {
            return Err(fail_invalid("본문은 10MB 이하만 지원합니다."));
        }
        let raw_title = input
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("제목 없음");
        let title = slice_utf16(raw_title, 300);

        if kind != "episode" {
            let ep_id = input
                .get("episodeId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            if let Some(eid) = ep_id {
                let exists_ep = p
                    .project
                    .get("documents")
                    .and_then(|v| v.as_array())
                    .is_some_and(|docs| {
                        docs.iter().any(|d| {
                            d.get("id").and_then(|v| v.as_str()) == Some(eid)
                                && d.get("kind").and_then(|v| v.as_str()) == Some("episode")
                                && d.get("archived").and_then(|v| v.as_bool()) != Some(true)
                        })
                    });
                if !exists_ep {
                    return Err(fail_invalid("연결할 회차를 찾을 수 없습니다."));
                }
            }
            for &key in DOCUMENT_META_FIELDS {
                if let Some(val) = input.get(key) {
                    if let Some(problem) = check_meta_patch(key, val) {
                        return Err(fail_invalid(problem));
                    }
                }
            }
            let folder = input.get("folder").and_then(|v| v.as_str());
            let mut attrs = stored_document_meta(Some(input));
            if let Some(id) = fixed["id"].as_str().filter(|id| valid_id(id)) {
                attrs.insert("id".to_string(), json!(id));
            }
            let props = custom_properties(input);
            attrs.insert("properties".to_string(), Value::Object(props));
            if let Some(co) = fixed
                .get("conflictOf")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                attrs.insert("conflictOf".to_string(), json!(co));
            }
            return self.create_doc_file(&p, kind, &title, &body, folder, ep_id, &attrs);
        }

        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let max_order = docs
            .iter()
            .filter(|d| d.get("kind").and_then(|v| v.as_str()) == Some("episode"))
            .filter_map(|d| d.get("order").and_then(|v| v.as_i64()))
            .max();
        let order = fixed
            .get("order")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| max_order.map(|m| m + 1).unwrap_or(0));

        let now = now_iso();
        let id = fixed
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        // 새 회차는 집필 중으로 시작한다.
        let status = normalize_status(fixed.get("status").and_then(|v| v.as_str()));

        let manual_lb = input
            .get("manualLineBreak")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| line_break_default(Some(&p.project), self.default_manual_line_break));
        let mut meta_input = input.as_object().cloned().unwrap_or_default();
        meta_input.insert("manualLineBreak".to_string(), json!(manual_lb));

        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(id));
        entry.insert("kind".to_string(), json!(kind));
        entry.insert("title".to_string(), json!(title));
        entry.insert("status".to_string(), json!(status));
        for (k, v) in stored_meta(Some(&Value::Object(meta_input))) {
            entry.insert(k, v);
        }
        entry.insert(
            "properties".to_string(),
            Value::Object(custom_properties(input)),
        );
        entry.insert("order".to_string(), json!(order));
        entry.insert(
            "archived".to_string(),
            json!(fixed.get("archived").and_then(|v| v.as_bool()).unwrap_or(false)),
        );
        entry.insert(
            "createdAt".to_string(),
            json!(fixed.get("createdAt").and_then(|v| v.as_str()).unwrap_or(&now)),
        );
        entry.insert(
            "updatedAt".to_string(),
            json!(fixed.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(&now)),
        );
        if let Some(co) = fixed
            .get("conflictOf")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            entry.insert("conflictOf".to_string(), json!(co));
        }
        entry.insert("hash".to_string(), json!(hash_str(&body)));
        entry.insert("path".to_string(), json!(""));

        let entry_val = Value::Object(entry);
        let eid = entry_val
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        self.insert_episode(&mut p, entry_val, &body)?;
        self.read(&eid)
    }

    fn insert_episode(
        &self,
        p: &mut CatalogProject,
        mut entry: Value,
        body: &str,
    ) -> Result<(), LofError> {
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let temp = format!("episodes/.{}.lofnew", id);
        if let Some(eobj) = entry.as_object_mut() {
            eobj.insert("path".to_string(), json!(temp));
            eobj.insert("_markdown".to_string(), json!(true));
        }
        atomic_write_str(&abs(&p.dir, &temp), &write_markdown(body, &entry, "")?)?;
        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            arr.push(entry);
        }
        if let Err(e) = self.layout(p) {
            let _ = fs::remove_file(abs(&p.dir, &temp));
            return Err(e);
        }
        self.write_project(p)
    }

    fn doc_folder(folder: Option<&str>) -> Result<String, LofError> {
        let Some(f) = folder.filter(|s| !s.is_empty()) else {
            return Ok("doc".to_string());
        };
        if !valid_rel(f) {
            return Err(fail_invalid("잘못된 문서 폴더"));
        }
        Ok(format!("doc/{}", f))
    }

    fn create_doc_file(
        &mut self,
        p: &CatalogProject,
        kind: &str,
        title: &str,
        body: &str,
        folder: Option<&str>,
        episode_id: Option<&str>,
        attributes: &Map<String, Value>,
    ) -> Result<Value, LofError> {
        let dir = Self::doc_folder(folder)?;
        let mut taken: HashSet<String> = walk_rel(&p.dir, "doc")
            .into_iter()
            .map(|r| r.to_lowercase())
            .collect();
        let rel = unique_name(
            &format!("{}/{}.md", dir, safe_name(title, "제목 없음")),
            ".md",
            &mut taken,
        );
        let now = now_iso();
        let id = attributes.get("id").and_then(Value::as_str).filter(|id| valid_id(id))
            .map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut doc = Map::new();
        for (k, v) in attributes {
            doc.insert(k.clone(), v.clone());
        }
        doc.insert("id".to_string(), json!(id));
        doc.insert("kind".to_string(), json!(kind));
        doc.insert("title".to_string(), json!(title));
        doc.insert(
            "episodeId".to_string(),
            episode_id.map(|s| json!(s)).unwrap_or(Value::Null),
        );
        doc.insert("createdAt".to_string(), json!(now));
        doc.insert("updatedAt".to_string(), json!(now));
        atomic_write_str(
            &abs(&p.dir, &rel),
            &write_markdown(body, &Value::Object(doc), "")?,
        )?;
        self.read(&id)
    }

    pub fn save(&mut self, input: &Value) -> Result<Value, LofError> {
        self.require_database()?;
        let id=input.get("id").and_then(Value::as_str).unwrap_or("");
        let current=self.read(id)?;
        if input.get("expectedRevision") != current.get("revision") {
            return Err(fail("다른 곳에서 수정된 문서입니다. 현재 내용을 다시 확인해 주세요.","CONFLICT"));
        }
        self.database()?.begin_write(&current)?;
        let saved=self.save_inner(input)?;
        self.database()?.finish_write(&saved)?;
        let saved_id = saved.get("id").and_then(Value::as_str).unwrap_or(id);
        let _ = self.clear_draft(id);
        if saved_id != id {
            let _ = self.clear_draft(saved_id);
        }
        let force_history = input.get("forceHistory").and_then(Value::as_bool).unwrap_or(false);
        let manual_history = input.get("manualHistory").and_then(Value::as_bool).unwrap_or(false);
        let restoring = input.get("restoring").and_then(Value::as_bool).unwrap_or(false);
        let current_body = current.get("body").and_then(Value::as_str).unwrap_or("");
        let saved_body = saved.get("body").and_then(Value::as_str).unwrap_or("");
        let metadata_changed = crate::database::history_metadata(&saved) != crate::database::history_metadata(&current);
        if !restoring && (manual_history || ((saved_body != current_body || metadata_changed) && (force_history || metadata_changed || self.history_due(saved_id, saved_body)))) {
            self.checkpoint(saved_id, manual_history)?;
            let _ = self.retain_history(false);
        }
        Ok(saved)
    }

    fn save_inner(&mut self, input: &Value) -> Result<Value, LofError> {
        let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let (mut f_proj, mut f_entry, f_file) = self.find_doc(id)?;
        let raw = fs::read_to_string(&f_file)?;
        let proj_id = f_proj
            .project
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let current = doc_of(&f_proj.dir, &proj_id, &f_entry, &raw)?;
        if current.get("id").and_then(|v| v.as_str()) != Some(id) {
            return Err(fail(
                "문서 ID가 외부에서 변경됐습니다. 문서를 다시 열어 주세요.",
                "CONFLICT",
            ));
        }
        let expected_rev = input.get("expectedRevision").and_then(|v| v.as_str());
        let current_rev = current.get("revision").and_then(|v| v.as_str());
        if expected_rev.is_none() || expected_rev != current_rev {
            return Err(fail(
                "다른 곳에서 수정된 문서입니다. 현재 내용을 다시 확인해 주세요.",
                "CONFLICT",
            ));
        }

        let is_doc = f_entry.get("kind").and_then(|v| v.as_str()) != Some("episode");
        let allowed_keys: Vec<&str> = if is_doc {
            let mut v = vec!["title", "archived", "episodeId", "kind", "properties"];
            v.extend_from_slice(DOCUMENT_META_FIELDS);
            v
        } else {
            let mut v = vec!["title", "status", "order", "archived", "properties"];
            v.extend_from_slice(META_FIELDS);
            v
        };

        let mut patch = Map::new();
        if let Some(in_obj) = input.as_object() {
            for &key in &allowed_keys {
                if let Some(val) = in_obj.get(key) {
                    patch.insert(key.to_string(), val.clone());
                }
            }
        }

        for &key in META_FIELDS {
            if let Some(val) = patch.get(key).cloned() {
                if let Some(problem) = check_meta_patch(key, &val) {
                    return Err(fail_invalid(problem));
                }
                let norm = normalize_meta(Some(&json!({ key: val })));
                if let Some(nv) = norm.get(key) {
                    patch.insert(key.to_string(), nv.clone());
                }
            }
        }

        if let Some(t) = patch.get("title").cloned() {
            let s = match t {
                Value::String(s) => s,
                other => other.to_string(),
            };
            patch.insert("title".to_string(), json!(slice_utf16(&s, 300)));
        }
        if let Some(st) = patch.get("status").cloned() {
            let s = st.as_str().unwrap_or("");
            if !STATUSES.contains(&s) && !LEGACY_STATUSES.contains(&s) {
                return Err(fail_invalid("잘못된 상태"));
            }
            patch.insert("status".to_string(), json!(normalize_status(Some(s))));
        }
        if let Some(ord) = patch.get("order") {
            if !ord.is_number() {
                return Err(fail_invalid("잘못된 순서"));
            }
        }
        if let Some(k) = patch.get("kind") {
            let ks = k.as_str().unwrap_or("");
            if ks != "plot" && ks != "memo" {
                return Err(fail_invalid("문서 타입은 플롯이나 메모여야 합니다."));
            }
        }
        if let Some(arch) = patch.get("archived") {
            if !arch.is_boolean() {
                return Err(fail_invalid("잘못된 보관 상태"));
            }
        }
        if let Some(props) = patch.get("properties") {
            if !props.is_object() {
                return Err(fail_invalid("사용자 속성은 객체여야 합니다."));
            }
        }
        if let Some(ep_id_val) = patch.get("episodeId") {
            let cur_ep = current
                .get("episodeId")
                .cloned()
                .unwrap_or(Value::Null);
            if *ep_id_val != cur_ep && !ep_id_val.is_null() {
                let target_ep = ep_id_val.as_str().unwrap_or("");
                let exists_ep = f_proj
                    .project
                    .get("documents")
                    .and_then(|v| v.as_array())
                    .is_some_and(|docs| {
                        docs.iter().any(|d| {
                            d.get("id").and_then(|v| v.as_str()) == Some(target_ep)
                                && d.get("kind").and_then(|v| v.as_str()) == Some("episode")
                                && d.get("archived").and_then(|v| v.as_bool()) != Some(true)
                        })
                    });
                if !exists_ep {
                    return Err(fail_invalid("연결할 회차를 찾을 수 없습니다."));
                }
            }
        }

        let current_body = current
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let body = if let Some(b_val) = input.as_object().and_then(|o| o.get("body")) {
            let Some(b_str) = b_val.as_str() else {
                return Err(fail_invalid("본문은 문자열이어야 합니다."));
            };
            if utf16_len(b_str) > 10_000_000 {
                return Err(fail_invalid("본문은 10MB 이하만 지원합니다."));
            }
            b_str.to_string()
        } else {
            current_body.clone()
        };

        let mut changed: Vec<String> = Vec::new();
        for (k, v) in &patch {
            let is_diff = if k == "tags" {
                let cur_tags = current.get("tags").cloned().unwrap_or_else(|| json!([]));
                &cur_tags != v
            } else if k == "properties" {
                let cur_props = current
                    .get("properties")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                &cur_props != v
            } else if k == "episodeId" {
                let cur_ep = f_entry.get("episodeId").cloned().unwrap_or(Value::Null);
                &cur_ep != v
            } else {
                current.get(k) != Some(v)
            };
            if is_diff {
                changed.push(k.clone());
            }
        }

        if changed.is_empty() && body == current_body {
            return Ok(current);
        }

        let cur_status = current.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let next_status = patch
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed");
        if !is_doc
            && cur_status == "completed"
            && next_status == "completed"
            && (body != current_body || changed.iter().any(|k| k == "title"))
        {
            return Err(fail(
                "집필 완료된 회차는 원고 보호 중이라 제목과 본문을 고칠 수 없습니다. 상태를 바꾼 뒤 편집해 주세요.",
                "PROTECTED",
            ));
        }

        let force_history = input
            .get("forceHistory")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let metadata_changed = !changed.is_empty();
        let restoring = input.get("restoring").and_then(Value::as_bool).unwrap_or(false);
        if (force_history || metadata_changed || (body != current_body && self.history_due(id, &current_body)))
            && (restoring || (self.latest_snapshot(id).is_none() && (metadata_changed || !current_body.is_empty())))
        {
            self.write_history(id, &current, &raw)?;
        }

        if hash_str(&fs::read_to_string(&f_file)?) != current_rev.unwrap_or("") {
            return Err(fail("파일이 외부에서 변경됐습니다.", "CONFLICT"));
        }

        if is_doc {
            return self.save_doc_file(&mut f_proj, &f_entry, &f_file, &patch, &body, &current, &raw);
        }

        if let Some(eobj) = f_entry.as_object_mut() {
            for k in &changed {
                if let Some(v) = patch.get(k) {
                    if k == "episodeId" && v.is_null() {
                        eobj.remove("episodeId");
                    } else {
                        eobj.insert(k.clone(), v.clone());
                    }
                }
            }
            if changed.iter().any(|k| META_FIELDS.contains(&k.as_str())) {
                let kept = stored_meta(Some(&Value::Object(eobj.clone())));
                for &mk in META_FIELDS {
                    if let Some(mv) = kept.get(mk) {
                        eobj.insert(mk.to_string(), mv.clone());
                    } else {
                        eobj.remove(mk);
                    }
                }
            }
            eobj.insert("updatedAt".to_string(), json!(now_iso()));
            eobj.insert("hash".to_string(), json!(hash_str(&body)));
            eobj.insert("_markdown".to_string(), json!(true));
        }

        if let Some(arr) = f_proj
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            if let Some(slot) = arr
                .iter_mut()
                .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
            {
                *slot = f_entry.clone();
            }
        }

        if changed.iter().any(|k| k == "title" || k == "order") {
            self.layout(&mut f_proj)?;
            if let Some(updated_entry) = f_proj
                .project
                .get("documents")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
                })
            {
                f_entry = updated_entry.clone();
            }
        }

        let entry_path = f_entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        atomic_write_str(
            &abs(&f_proj.dir, entry_path),
            &write_markdown(&body, &f_entry, &raw)?,
        )?;
        let file_centric = f_proj
            .project
            .get("fileCentric")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !file_centric || !changed.is_empty() {
            self.write_project(&f_proj)?;
        }
        self.read(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn save_doc_file(
        &mut self,
        f_proj: &mut CatalogProject,
        f_entry: &Value,
        f_file: &Path,
        patch: &Map<String, Value>,
        body: &str,
        current: &Value,
        raw: &str,
    ) -> Result<Value, LofError> {
        let rel = f_entry
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut next = current.as_object().cloned().unwrap_or_default();
        for (k, v) in patch {
            next.insert(k.clone(), v.clone());
        }
        next.insert("updatedAt".to_string(), json!(now_iso()));
        atomic_write_str(f_file, &write_markdown(body, &Value::Object(next), raw)?)?;
        if Self::drop_doc_meta(f_proj, &rel) {
            self.write_project(f_proj)?;
        }
        if let Some(title) = patch.get("title").and_then(|v| v.as_str()) {
            if safe_name(title, "제목 없음") != base_name(&rel) {
                let mut taken: HashSet<String> = walk_rel(&f_proj.dir, "doc")
                    .into_iter()
                    .filter(|r| r != &rel)
                    .map(|r| r.to_lowercase())
                    .collect();
                let next_rel = unique_name(
                    &format!("{}/{}.md", folder_of(&rel), safe_name(title, "제목 없음")),
                    ".md",
                    &mut taken,
                );
                self.move_files(&f_proj.dir, &[(rel.clone(), next_rel.clone())])?;
                if Self::move_doc_meta(f_proj, &rel, &next_rel) {
                    self.write_project(f_proj)?;
                }
            }
        }
        let cid = current.get("id").and_then(|v| v.as_str()).unwrap_or("");
        self.read(cid)
    }

    pub fn reorder(&mut self, input: &Value) -> Result<bool, LofError> {
        let project_id = input.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
        let mut p = self.get_project(project_id)?;
        let Some(ids_arr) = input.get("ids").and_then(|v| v.as_array()) else {
            return Err(fail_invalid("잘못된 순서 목록"));
        };
        if ids_arr.len() > 20000 {
            return Err(fail_invalid("잘못된 순서 목록"));
        }
        let docs = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut entries = Vec::with_capacity(ids_arr.len());
        for id_val in ids_arr {
            let Some(id_str) = id_val.as_str() else {
                return Err(fail_invalid("잘못된 순서 목록"));
            };
            let Some(found) = docs.iter().find(|d| {
                d.get("id").and_then(|v| v.as_str()) == Some(id_str)
                    && d.get("kind").and_then(|v| v.as_str()) == Some("episode")
            }) else {
                return Err(fail_invalid("잘못된 순서 목록"));
            };
            entries.push(found.clone());
        }

        for (i, d) in entries.iter_mut().enumerate() {
            let ord = i as i64;
            if d.get("order").and_then(|v| v.as_i64()) == Some(ord) {
                continue;
            }
            let rel = d
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // 순서만 바뀌고 본문은 그대로이므로 이력을 남기지 않는다. 한 회차를 옮겨도 사이의 회차가
            // 모두 밀려 회차마다 이력이 쌓이기 때문이다.
            let raw = fs::read_to_string(abs(&p.dir, &rel))?;
            if let Some(dobj) = d.as_object_mut() {
                dobj.insert("order".to_string(), json!(ord));
            }
            let body = read_markdown(&raw)?.body;
            atomic_write_str(&abs(&p.dir, &rel), &write_markdown(&body, d, &raw)?)?;
        }

        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            for ed in entries {
                let eid = ed.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(slot) = arr
                    .iter_mut()
                    .find(|x| x.get("id").and_then(|v| v.as_str()) == Some(eid))
                {
                    *slot = ed;
                }
            }
        }
        self.layout(&mut p)?;
        self.write_project(&p)?;
        Ok(true)
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn write_history(&mut self, id: &str, doc: &Value, previous_raw: &str) -> Result<(), LofError> {
        if self.local_git.ready {
            let body = doc.get("body").and_then(|v| v.as_str()).unwrap_or("");
            if self.local_git.capture_document(id, doc, "변경 전 원고 보존")? {
                self.last_snapshot.insert(id.to_string(), Some(SnapshotEntry { at: Self::now_ms(), body: body.to_string() }));
            }
            return Ok(());
        }
        let at = Self::now_ms();
        let body = doc.get("body").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(db) = &self.index.database {
            if db.latest_history(id)?.is_some_and(|(_, previous)| crate::database::same_history_content(&previous, doc)) {
                return Ok(());
            }
            let name=format!("{}-{}.md",at,Uuid::new_v4());
            db.insert_history(id,&name,&crate::database::history_value(doc,&now_iso()))?;
            self.last_snapshot.insert(id.to_string(),Some(SnapshotEntry{at,body:body.to_string()}));
            return Ok(());
        }
        let hfile = self
            .root
            .join(".lof")
            .join("history")
            .join(id)
            .join(format!("{}-{}.md", at, Uuid::new_v4()));
        let content = write_properties(body, &document_properties(doc), previous_raw)?;
        atomic_write_str(&hfile, &content)?;
        self.last_snapshot.insert(
            id.to_string(),
            Some(SnapshotEntry {
                at,
                body: body.to_string(),
            }),
        );
        Ok(())
    }

    fn latest_snapshot(&mut self, id: &str) -> Option<SnapshotEntry> {
        if let Some(cached) = self.last_snapshot.get(id) {
            return cached.clone();
        }
        if let Some(db)=&self.index.database {
            let latest = if self.local_git.ready {
                self.local_git.latest_document(id).ok().flatten().map(|(at, body)| SnapshotEntry { at, body })
            } else {
                db.latest_history(id).ok().flatten().map(|(at,doc)|SnapshotEntry{at,body:doc["body"].as_str().unwrap_or("").to_string()})
            };
            self.last_snapshot.insert(id.to_string(),latest.clone());
            return latest;
        }
        let dir = self.root.join(".lof").join("history").join(id);
        static HIST_RE: OnceLock<Regex> = OnceLock::new();
        let re = HIST_RE.get_or_init(|| Regex::new(r"^\d+-[a-f0-9-]+\.(json|md)$").unwrap());
        let mut names: Vec<String> = fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| re.is_match(n))
                    .collect()
            })
            .unwrap_or_default();
        names.sort_by_key(|a| {
            a.split('-')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        });
        let latest = if let Some(name) = names.last() {
            let at = name
                .split('-')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let raw = fs::read_to_string(dir.join(name)).unwrap_or_default();
            let body = if name.ends_with(".md") {
                read_markdown(&raw).map(|m| m.body).unwrap_or_default()
            } else {
                serde_json::from_str::<Value>(&raw)
                    .ok()
                    .and_then(|v| {
                        v.get("body")
                            .and_then(|b| b.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default()
            };
            Some(SnapshotEntry { at, body })
        } else {
            None
        };
        self.last_snapshot.insert(id.to_string(), latest.clone());
        latest
    }

    // 쉬지 않고 오래 쓸 때의 이력: 마지막 이력 뒤로 max_minutes가 지났고 본문이 min_chars 넘게 바뀌었으면
    // 저장하면서 저장 직전 원고를 남긴다. 평소의 이력은 checkpoint가 남긴다.
    fn history_due(&mut self, id: &str, body: &str) -> bool {
        let max_minutes = self.history_policy.max_minutes;
        let min_chars = self.history_policy.min_chars;
        let latest = self.latest_snapshot(id);
        let now = Self::now_ms();
        if let Some(ref l) = latest {
            let elapsed = now.saturating_sub(l.at) as f64;
            if elapsed < max_minutes * 60_000.0 {
                return false;
            }
        }
        let prev_body = latest.as_ref().map(|l| l.body.as_str()).unwrap_or("");
        changed_chars(prev_body, body) >= min_chars
    }

    // 작업의 끝(입력이 멈춤, 문서를 떠남, Ctrl+S)에 지금 저장된 원고를 이력으로 남긴다.
    // 본문과 실제 속성이 마지막 이력과 같으면 새 기록을 만들지 않는다.
    pub fn checkpoint(&mut self, id: &str, force: bool) -> Result<bool, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 ID"));
        }
        if self.local_git.ready {
            let current = self.read(id)?;
            let body = current.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let recorded = self.local_git.capture_document(id, &current, if force { "수동 저장한 원고 기록" } else { "원고 이력 기록" })?;
            if recorded {
                self.last_snapshot.insert(id.to_string(), Some(SnapshotEntry { at: Self::now_ms(), body: body.to_string() }));
            }
            if force {
                let _ = self.local_git.mark(id, "manual")?;
            }
            return Ok(recorded);
        }
        let (f_proj, f_entry, f_file) = self.find_doc(id)?;
        let raw = fs::read_to_string(&f_file)?;
        let proj_id = f_proj
            .project
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let current = doc_of(&f_proj.dir, &proj_id, &f_entry, &raw)?;
        let body = current.get("body").and_then(|v| v.as_str()).unwrap_or("");
        let latest = self.database()?.latest_history(id)?;
        if latest.as_ref().is_some_and(|(_, previous)| crate::database::same_history_content(previous, &current)) {
            if force {
                return self.database()?.mark_latest_history_manual(id);
            }
            return Ok(false);
        }
        if force {
            let mut value = crate::database::history_value(&current, &now_iso());
            value["manual"] = json!(true);
            let at = Self::now_ms();
            self.database()?.insert_history(id, &format!("{at}-{}.md", Uuid::new_v4()), &value)?;
            self.last_snapshot.insert(id.to_string(), Some(SnapshotEntry { at, body: body.to_string() }));
        } else { self.write_history(id, &current, &raw)?; }
        Ok(true)
    }

    pub fn history(&self, id: &str) -> Result<Value, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 ID"));
        }
        if self.local_git.ready { return Ok(self.local_git.history_page(id, 0, 100, None, self.history_policy)?["entries"].clone()) }
        if let Some(db)=&self.index.database {return db.history(id);}
        let dir = self.root.join(".lof").join("history").join(id);
        let mut names: Vec<String> = fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.ends_with(".json") || n.ends_with(".md"))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names.reverse();
        names.truncate(100);
        let out: Vec<Value> = names.into_iter().map(|name| json!({ "name": name })).collect();
        Ok(Value::Array(out))
    }

    pub fn history_page(&self, id: &str, offset: usize, limit: usize, anchor: Option<&str>) -> Result<Value, LofError> {
        if !valid_id(id) { return Err(fail_invalid("잘못된 문서 ID입니다.")); }
        if self.local_git.ready { self.local_git.history_page(id, offset, limit, anchor, self.history_policy) }
        else { self.database()?.legacy_history_page(id, offset, limit) }
    }

    // 이력을 지운다. id가 있으면 그 문서의 이력만(name이 있으면 그 하나만), 없으면 모든 문서의 이력을 지운다.
    // 지운 뒤에는 마지막 이력 기억을 버려 다음 이력 판단을 남은 이력으로 다시 한다. 지운 개수를 돌려준다.
    // Git 기록은 이력 하나씩만 지울 수 있고, 지운 이력은 목록과 열람에서 빠진다.
    pub fn history_delete(&mut self, id: Option<&str>, name: Option<&str>) -> Result<usize, LofError> {
        if self.local_git.ready {
            return match (id, name) {
                (Some(id), Some(name)) if name.starts_with("git-") => Ok(self.local_git.delete(id, name)? as usize),
                _ => Err(fail("Git 기록은 이력 하나씩만 지울 수 있습니다.", "HISTORY_READ_ONLY")),
            };
        }
        static HIST_RE: OnceLock<Regex> = OnceLock::new();
        let re = HIST_RE.get_or_init(|| Regex::new(r"^\d+-[a-f0-9-]+\.(json|md)$").unwrap());
        if id.is_some_and(|id| !valid_id(id)) || name.is_some_and(|n| id.is_none() || !re.is_match(n)) {
            return Err(fail_invalid("잘못된 이력"));
        }
        let removed = if let Some(db) = &self.index.database {
            db.delete_history(id, name)?
        } else {
            let base = self.root.join(".lof").join("history");
            match (id, name) {
                (Some(id), Some(name)) => {
                    let file = base.join(id).join(name);
                    if file.exists() {
                        fs::remove_file(file)?;
                        1
                    } else {
                        0
                    }
                }
                (Some(id), None) => remove_history_dir(&base.join(id))?,
                (None, _) => remove_history_dir(&base)?,
            }
        };
        match id {
            Some(id) => {
                self.last_snapshot.remove(id);
            }
            None => self.last_snapshot.clear(),
        }
        Ok(removed)
    }

    pub fn history_read(&self, id: &str, name: &str) -> Result<Value, LofError> {
        if name.starts_with("git-") {
            if !self.local_git.ready { return Err(fail("기존 이력을 Git으로 옮기는 중입니다.", "GIT_MIGRATING")); }
            return self.local_git.history_read(id, name);
        }
        static HIST_RE: OnceLock<Regex> = OnceLock::new();
        let re = HIST_RE.get_or_init(|| Regex::new(r"^\d+-[a-f0-9-]+\.(json|md)$").unwrap());
        if !valid_id(id) || !re.is_match(name) {
            return Err(fail_invalid("잘못된 이력"));
        }
        if let Some(db)=&self.index.database {return db.history_read(id,name)?.ok_or_else(||fail("이력을 찾을 수 없습니다.","NOT_FOUND"));}
        let raw = fs::read_to_string(self.root.join(".lof").join("history").join(id).join(name))?;
        if name.ends_with(".md") {
            let parsed = read_markdown(&raw)?;
            let attrs = parsed.properties.clone();
            let kind = attrs
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("episode");
            let title = attrs.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let normalized = markdown_entry(
                &raw,
                &json!({ "id": id, "kind": kind, "title": title }),
            )?;
            let ts_ms = name
                .split('-')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let saved_at = sys_time_to_iso(UNIX_EPOCH + Duration::from_millis(ts_ms));
            let mut attr_out = attrs;
            if let Some(p) = normalized.get("properties") {
                attr_out.insert("properties".to_string(), p.clone());
            }
            return Ok(json!({
                "id": id,
                "title": normalized.get("title"),
                "status": normalized.get("status"),
                "body": parsed.body,
                "savedAt": saved_at,
                "attributes": attr_out,
            }));
        }
        let v: Value = serde_json::from_str(&raw).map_err(|e| fail(e.to_string(), "FORMAT"))?;
        Ok(json!({
            "id": id,
            "title": v.get("title").and_then(|x| x.as_str()).unwrap_or(""),
            "status": normalize_status_val(v.get("status")),
            "body": v.get("body").and_then(|x| x.as_str()).unwrap_or(""),
            "savedAt": v.get("savedAt"),
        }))
    }

    pub fn restore(&mut self, input: &Value) -> Result<Value, LofError> {
        let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let expected_rev = input.get("expectedRevision").cloned().unwrap_or(Value::Null);
        let old = self.history_read(id, name)?;
        let before = self.read(id)?;
        if self.local_git.ready {
            self.local_git.capture_document(id, &before, "복원 전 원고 보존")?;
        }
        let mut attrs = old
            .get("attributes")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(ep_id) = attrs
            .get("episodeId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
        {
            let (cur_proj, _, _) = self.find_doc(id)?;
            let valid_ep = cur_proj
                .project
                .get("documents")
                .and_then(|v| v.as_array())
                .is_some_and(|docs| {
                    docs.iter().any(|d| {
                        d.get("id").and_then(|v| v.as_str()) == Some(ep_id.as_str())
                            && d.get("archived").and_then(|v| v.as_bool()) != Some(true)
                    })
                });
            if !valid_ep {
                attrs.insert("episodeId".to_string(), Value::Null);
            }
        }
        attrs.insert("id".to_string(), json!(id));
        attrs.insert("expectedRevision".to_string(), expected_rev);
        attrs.insert("forceHistory".to_string(), json!(true));
        attrs.insert("restoring".to_string(), json!(true));
        attrs.insert(
            "body".to_string(),
            old.get("body").cloned().unwrap_or(json!("")),
        );
        attrs.insert(
            "title".to_string(),
            old.get("title").cloned().unwrap_or(json!("")),
        );
        attrs.insert(
            "status".to_string(),
            old.get("status").cloned().unwrap_or(json!("in_progress")),
        );
        let mut restored = self.save(&Value::Object(attrs))?;
        if restored["fingerprint"] != before["fingerprint"] {
            if self.local_git.ready {
                let record = self.local_git.mark(id, "before-restore").and_then(|_| {
                    self.local_git.capture_document(id, &restored, "이전 원고 복원")
                }).and_then(|_| self.local_git.mark(id, "restore"));
                if let Err(error) = record {
                    self.local_git.error = error.message.clone();
                    restored["historyWarning"] = json!(format!("원고는 복원했지만 Git 기록을 완료하지 못했습니다: {}", error.message));
                }
            } else {
                let mut value = crate::database::history_value(&restored, &now_iso());
                value["recordKind"] = json!("restore");
                self.database()?.insert_history(id, &format!("{}-{}.md", Self::now_ms(), Uuid::new_v4()), &value)?;
            }
        }
        Ok(restored)
    }

    pub fn search(&mut self, query: &str, project_id: Option<&str>) -> Result<Value, LofError> {
        let q = query.to_lowercase();
        if q.trim().is_empty() {
            return Ok(json!([]));
        }
        let pid_filter = project_id.filter(|s| !s.is_empty());
        let list = self.list()?;
        let docs = list
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut results = Vec::new();
        for m in docs {
            if m.get("archived").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            let m_pid = m
                .get("projectId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(pf) = pid_filter {
                if m_pid != pf {
                    continue;
                }
            }
            let m_id = m
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let body = if self.index_enabled {
                self.cached_body(&m_pid, &m_id).unwrap_or_default()
            } else {
                self.read(&m_id)
                    .ok()
                    .and_then(|d| {
                        d.get("body")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default()
            };
            let title = m.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let body_low = body.to_lowercase();
            let title_low = title.to_lowercase();
            let body_u16: Vec<u16> = body.encode_utf16().collect();
            let body_low_u16: Vec<u16> = body_low.encode_utf16().collect();
            let q_u16: Vec<u16> = q.encode_utf16().collect();

            let pos_u16 = if !q_u16.is_empty() && body_low_u16.len() >= q_u16.len() {
                body_low_u16
                    .windows(q_u16.len())
                    .position(|w| w == q_u16.as_slice())
            } else {
                None
            };

            if pos_u16.is_some() || title_low.contains(&q) {
                let p = pos_u16.unwrap_or(0);
                let start = p.saturating_sub(35);
                let end = (p + 150).min(body_u16.len());
                let snippet = String::from_utf16_lossy(&body_u16[start..end]);
                let mut item = m.as_object().cloned().unwrap_or_default();
                item.insert("snippet".to_string(), json!(snippet));
                results.push(Value::Object(item));
                if results.len() >= 100 {
                    break;
                }
            }
        }
        Ok(Value::Array(results))
    }

    pub fn search_document_ids(&mut self, query: &str, project_id: &str) -> Result<Value, LofError> {
        let q = query.trim().to_lowercase();
        if q.is_empty() || project_id.is_empty() {
            return Ok(json!([]));
        }
        let list = self.list()?;
        let mut ids = Vec::new();
        if let Some(docs) = list.get("documents").and_then(Value::as_array) {
            for doc in docs {
                if doc.get("projectId").and_then(Value::as_str) != Some(project_id) {
                    continue;
                }
                let Some(id) = doc.get("id").and_then(Value::as_str) else { continue };
                let body = if self.index_enabled {
                    self.cached_body(project_id, id).unwrap_or_default()
                } else {
                    let Ok(document) = self.read(id) else { continue };
                    document.get("body").and_then(Value::as_str).unwrap_or("").to_string()
                };
                if body.to_lowercase().contains(&q) {
                    ids.push(id.to_string());
                }
            }
        }
        Ok(json!(ids))
    }

    pub fn search_text(
        &mut self,
        query: &str,
        project_id: Option<&str>,
        case_sensitive: bool,
    ) -> Result<Value, LofError> {
        if query.trim().is_empty() {
            return Ok(json!({ "results": [], "total": 0, "truncated": false }));
        }
        let pid_filter = project_id.filter(|s| !s.is_empty());
        let list = self.list()?;
        let docs = list
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut results = Vec::new();
        let mut total = 0;
        let mut truncated = false;

        for m in docs {
            let m_pid = m
                .get("projectId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(pf) = pid_filter {
                if m_pid != pf {
                    continue;
                }
            }
            let m_id = m
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let body = if self.index_enabled {
                self.cached_body(&m_pid, &m_id).unwrap_or_default()
            } else {
                let Ok(d) = self.read(&m_id) else { continue };
                d.get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let max_here = 100.min(2000usize.saturating_sub(total));
            let (found_matches, is_trunc) = match_lines(&body, query, case_sensitive, max_here);
            if is_trunc {
                truncated = true;
            }
            total += found_matches.len();
            if !found_matches.is_empty() {
                results.push(json!({
                    "id": m_id,
                    "projectId": m_pid,
                    "kind": m.get("kind"),
                    "title": m.get("title"),
                    "relPath": m.get("relPath"),
                    "archived": m.get("archived"),
                    "matches": found_matches,
                }));
            }
            if total >= 2000 {
                truncated = true;
                break;
            }
        }

        Ok(json!({
            "results": results,
            "total": total,
            "truncated": truncated,
        }))
    }

    pub fn search_all(
        &mut self,
        query: &str,
        project_id: Option<&str>,
        case_sensitive: bool,
    ) -> Result<Value, LofError> {
        let raw = query.trim();
        let empty = json!({
            "projects": [],
            "files": [],
            "results": [],
            "total": 0,
            "truncated": false,
        });
        if raw.is_empty() {
            return Ok(empty);
        }
        let norm = |t: &str| -> String {
            if case_sensitive {
                t.to_string()
            } else {
                t.to_lowercase()
            }
        };
        let tag_only = raw.starts_with('#');
        let q = norm(if tag_only {
            raw.trim_start_matches('#')
        } else {
            raw
        });
        if q.is_empty() {
            return Ok(empty);
        }

        let list = self.list()?;
        let mut projects = Vec::new();
        if let Some(projs) = list.get("projects").and_then(|v| v.as_array()) {
            for p in projs {
                let tags: Vec<String> = p
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str())
                            .filter(|t| norm(t).contains(&q))
                            .map(|t| t.to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                let title = p.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let desc = p.get("description").and_then(|v| v.as_str()).unwrap_or("");
                let mut fields = Vec::new();
                if tag_only {
                    if !tags.is_empty() {
                        fields.push("태그");
                    }
                } else {
                    if norm(title).contains(&q) {
                        fields.push("제목");
                    }
                    if norm(desc).contains(&q) {
                        fields.push("소개");
                    }
                    if !tags.is_empty() {
                        fields.push("태그");
                    }
                }
                if !fields.is_empty() {
                    projects.push(json!({
                        "id": p.get("id"),
                        "title": title,
                        "tags": tags,
                        "fields": fields,
                        "description": desc,
                    }));
                }
            }
        }
        let inner_rel = |rel: &str| -> String {
            for prefix in ["assets/", "doc/", "episodes/", "plot/", "memo/"] {
                // 바이트 위치가 한글 글자 중간일 수 있으므로 get으로 잘라 본다.
                if rel.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix)) {
                    return rel[prefix.len()..].to_string();
                }
            }
            rel.to_string()
        };
        let pid_filter = project_id.filter(|s| !s.is_empty());
        let mut files = Vec::new();
        if let Some(docs) = list.get("documents").and_then(|v| v.as_array()) {
            for d in docs {
                let d_pid = d.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(pf) = pid_filter {
                    if d_pid != pf {
                        continue;
                    }
                }
                let tags: Vec<String> = d
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str())
                            .filter(|t| norm(t).contains(&q))
                            .map(|t| t.to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let rel_path = d.get("relPath").and_then(|v| v.as_str()).unwrap_or("");
                let searchable_rel = inner_rel(rel_path);
                let matched = if tag_only {
                    !tags.is_empty()
                } else {
                    norm(title).contains(&q)
                        || norm(&searchable_rel).contains(&q)
                        || !tags.is_empty()
                };
                if matched {
                    files.push(json!({
                        "id": d.get("id"),
                        "projectId": d_pid,
                        "kind": d.get("kind"),
                        "title": title,
                        "relPath": rel_path,
                        "archived": d.get("archived"),
                        "tags": tags,
                    }));
                    if files.len() >= 200 {
                        break;
                    }
                }
            }
        }

        if tag_only {
            return Ok(json!({
                "projects": projects,
                "files": files,
                "results": [],
                "total": 0,
                "truncated": false,
            }));
        }

        let st = self.search_text(raw, project_id, case_sensitive)?;
        Ok(json!({
            "projects": projects,
            "files": files,
            "results": st.get("results").cloned().unwrap_or(json!([])),
            "total": st.get("total").cloned().unwrap_or(json!(0)),
            "truncated": st.get("truncated").cloned().unwrap_or(json!(false)),
        }))
    }

    // 임시본은 원본 파일을 바꾸지 않고 이력으로만 보관한다. 기존 이력과 같으면 기록하지 않는다.
    fn archive_document_draft(&mut self, input: &Value) -> Result<(), LofError> {
        let id = input["id"].as_str().filter(|id| valid_id(id))
            .ok_or_else(|| fail_invalid("잘못된 문서 ID"))?;
        let body = input["body"].as_str().ok_or_else(|| fail_invalid("임시 원고 본문이 없습니다."))?;
        if utf16_len(body) > 10_000_000 { return Err(fail_invalid("본문은 10MB 이하만 지원합니다.")); }
        let mut document = self.read(id)?;
        for key in ["body", "title", "status", "episodeId", "properties"].iter().copied().chain(META_FIELDS.iter().copied()) {
            if let Some(value) = input.get(key) { document[key] = value.clone(); }
        }
        let raw = self.markdown(id)?;
        self.write_history(id, &document, &raw)
    }

    fn stored_draft(&self, id: &str) -> Result<Option<Value>, LofError> {
        if let Some(db) = &self.index.database { return db.draft(id); }
        let file = self.root.join(".lof/drafts").join(format!("{id}.json"));
        match fs::read_to_string(file) {
            Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| fail(e.to_string(), "FORMAT")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub(crate) fn flush_received_history(&mut self) -> Result<(), LofError> {
        // 작품 정보가 원고 뒤에 도착해도 수신한 본문을 DB에 남겨 다음 확인에서 이어 기록한다.
        for (sequence, path, raw, applied) in self.database()?.received_history()? {
            // 쓰기 완료 표시 전에 종료됐다면 실제 파일로 완료 여부를 확인한다.
            if !applied && crate::sync::files::read_local(&self.root, &path)?.as_deref() != Some(raw.as_bytes()) {
                self.database()?.finish_received_history(sequence)?;
                continue;
            }
            let parsed = read_markdown(&raw)?;
            if let Some(id) = parsed.properties.get("id").and_then(Value::as_str).filter(|id| valid_id(id)) {
                let (project, mut entry, _) = match self.find_doc(id) {
                    Ok(document) => document,
                    Err(error) if error.code == "NOT_FOUND" || error.code == "ENOENT" => {
                        self.database()?.defer_received_history(sequence)?;
                        continue;
                    },
                    Err(error) => return Err(error),
                };
                if let Some(kind) = parsed.properties.get("kind") { entry["kind"] = kind.clone(); }
                let document = doc_of(&project.dir, project.project["id"].as_str().unwrap_or(""), &entry, &raw)?;
                self.write_history(id, &document, &raw)?;
            }
            self.database()?.finish_received_history(sequence)?;
        }
        Ok(())
    }

    pub(crate) fn preserve_sync_draft(&mut self, raw: &[u8]) -> Result<Option<String>, LofError> {
        let parsed = read_markdown(std::str::from_utf8(raw).map_err(|_| fail_invalid("원고 인코딩 오류"))?)?;
        let Some(id) = parsed.properties.get("id").and_then(Value::as_str).filter(|id| valid_id(id)) else { return Ok(None); };
        if let Some(input) = self.stored_draft(id)? {
            if self.archive_document_draft(&input).is_err() {
                let mut document = self.read(id).unwrap_or_else(|_| input.clone());
                if let (Some(target), Some(source)) = (document.as_object_mut(), input.as_object()) {
                    target.extend(source.clone());
                }
                self.save_recovery_copy(&json!({"document": document}))?;
            }
            return Ok(Some(id.to_string()));
        }
        Ok(None)
    }

    pub fn adopt_document(&mut self, input: &Value) -> Result<Value, LofError> {
        let id = input["id"].as_str().filter(|id| valid_id(id))
            .ok_or_else(|| fail_invalid("잘못된 문서 ID"))?;
        let token = input["syncToken"].as_str().filter(|token| !token.is_empty() && token.len() <= 256)
            .ok_or_else(|| fail_invalid("동기화 정리 식별자가 없습니다."))?;
        let file = self.locate(id)?;
        let relative = file.strip_prefix(&self.root).map_err(|_| fail_invalid("서재 밖의 문서입니다."))?
            .to_string_lossy().replace('\\', "/");
        self.sync_holds.insert(token.to_string(), (id.to_string(), relative));
        let current = self.read(id)?;
        if !input["discardDraft"].as_bool().unwrap_or(false) {
          let saved_draft = if input["draft"].is_object() { None } else { self.stored_draft(id)? };
          if let Some(draft) = input.get("draft").filter(|draft| draft.is_object()).or(saved_draft.as_ref()) {
            if draft["id"].as_str() != Some(id) { return Err(fail_invalid("임시본의 문서 ID가 다릅니다.")); }
            // 이력 저장에 실패해도 다른 문서로 이동할 수 있도록 임시본부터 별도로 남긴다.
            let mut saved = current.clone();
            if let (Some(target), Some(source)) = (saved.as_object_mut(), draft.as_object()) { target.extend(source.clone()); }
            self.persist_draft(id, &saved)?;
            self.archive_document_draft(draft)?;
          }
        }
        self.clear_draft(id)?;
        Ok(current)
    }

    pub fn draft(&mut self, input: &Value) -> Result<bool, LofError> {
        let id = input.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID"));
        }
        // 동기화 반영 뒤 늦게 도착한 이전 버전의 임시본이 복구 대상으로 되살아나지 않게 한다.
        if !input["recoveryOnly"].as_bool().unwrap_or(false) {
          if let Some(expected) = input["expectedRevision"].as_str() {
            if self.read(id).is_ok_and(|doc| doc["revision"].as_str() != Some(expected)) {
                if self.archive_document_draft(input).is_ok() { return Ok(true); }
            }
          }
        }
        self.persist_draft(id, input)
    }

    fn persist_draft(&self, id: &str, input: &Value) -> Result<bool, LofError> {
        let mut payload = input.as_object().cloned().unwrap_or_default();
        payload.insert("savedAt".to_string(), json!(now_iso()));
        if let Some(db) = &self.index.database {
            db.save_draft(id, &Value::Object(payload))?;
            return Ok(true);
        }
        let file = self
            .root
            .join(".lof")
            .join("drafts")
            .join(format!("{}.json", id));
        atomic_write_str(&file, &serde_json::to_string(&payload).unwrap_or_default())?;
        Ok(true)
    }

    pub fn drafts(&self) -> Result<Vec<Value>, LofError> {
        if let Some(db) = &self.index.database {
            return db.drafts();
        }
        let dir = self.root.join(".lof").join("drafts");
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(&dir) else {
            return Ok(out);
        };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                if let Ok(raw) = fs::read_to_string(e.path()) {
                    if let Ok(v) = serde_json::from_str(&raw) {
                        out.push(v);
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn clear_draft(&self, id: &str) -> Result<(), LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 ID"));
        }
        if let Some(db) = &self.index.database {
            db.clear_draft(id)?;
        }
        let file = self
            .root
            .join(".lof")
            .join("drafts")
            .join(format!("{}.json", id));
        let _ = fs::remove_file(file);
        Ok(())
    }

    fn deleted_file(&self) -> PathBuf {
        self.root.join(".lof").join("deleted.json")
    }

    pub fn deleted(&self) -> Result<Map<String, Value>, LofError> {
        if let Some(db)=&self.index.database {return Ok(db.get("deleted")?.and_then(|v|v.as_object().cloned()).unwrap_or_default());}
        match fs::read_to_string(self.deleted_file()) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|e| fail(e.to_string(), "FORMAT")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(LofError::from(e)),
        }
    }

    pub fn tombstone(&self, id: &str, project_id: &str, deleted_at: &str) -> Result<(), LofError> {
        self.require_database()?;
        let mut deleted = self.deleted()?;
        let is_proj = id == project_tombstone(project_id);
        let mut info = Map::new();
        info.insert("projectId".to_string(), json!(project_id));
        info.insert("deletedAt".to_string(), json!(deleted_at));
        if is_proj {
            info.insert("project".to_string(), json!(true));
        }
        deleted.insert(id.to_string(), Value::Object(info));
        self.save_deleted(&deleted)?;
        if !is_proj {self.database()?.forget_current(id)?;}
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<bool, LofError> {
        self.remove_inner(id, &now_iso())
    }

    pub fn remove_inner(&mut self, id: &str, deleted_at: &str) -> Result<bool, LofError> {
        self.require_database()?;
        if let Ok(current)=self.read(id){self.database()?.begin_write(&current)?;}
        let (mut f_proj, f_entry, f_file) = self.find_doc(id)?;
        if f_file.exists() {
            self.trash_path(&f_file)?;
        }
        record_change(&f_file);
        let rel = f_entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let is_ep = f_entry.get("kind").and_then(|v| v.as_str()) == Some("episode");
        let proj_id = f_proj
            .project
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if !is_ep && Self::drop_doc_meta(&mut f_proj, rel) {
            self.write_project(&f_proj)?;
        }
        if is_ep {
            if let Some(arr) = f_proj
                .project
                .get_mut("documents")
                .and_then(|v| v.as_array_mut())
            {
                arr.retain(|d| d.get("id").and_then(|v| v.as_str()) != Some(id));
            }
            for doc in self.doc_files(&f_proj) {
                if doc.get("episodeId").and_then(|v| v.as_str()) == Some(id) {
                    let drel = doc.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let did = doc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let dfile = abs(&f_proj.dir, drel);
                    if let Ok(raw) = fs::read_to_string(&dfile) {
                        if let Ok(cur_doc) = doc_of(&f_proj.dir, &proj_id, &doc, &raw) {
                            let _ = self.write_history(did, &cur_doc, &raw);
                        }
                        let mut updated_doc = doc.as_object().cloned().unwrap_or_default();
                        updated_doc.insert("episodeId".to_string(), Value::Null);
                        updated_doc.insert("updatedAt".to_string(), json!(now_iso()));
                        if let Ok(parsed) = read_markdown(&raw) {
                            if let Ok(next_md) = write_markdown(
                                &parsed.body,
                                &Value::Object(updated_doc),
                                &raw,
                            ) {
                                let _ = atomic_write_str(&dfile, &next_md);
                            }
                        }
                    }
                }
            }
            let _ = self.layout(&mut f_proj);
            self.write_project(&f_proj)?;
        }

        self.last_snapshot.remove(id);
        let _ = self.clear_draft(id);
        self.tombstone(id, &proj_id, deleted_at)?;
        self.sync_holds.retain(|_, (held_id, _)| held_id != id);
        Ok(true)
    }

    pub fn remove_project(&mut self, id: &str) -> Result<bool, LofError> {
        self.remove_project_inner(id, &now_iso())
    }

    pub fn remove_project_inner(&mut self, id: &str, deleted_at: &str) -> Result<bool, LofError> {
        self.require_database()?;
        let previous=self.list()?;
        let ids:Vec<String>=previous["documents"].as_array().into_iter().flatten()
            .filter(|doc|doc["projectId"].as_str()==Some(id)).filter_map(|doc|doc["id"].as_str().map(str::to_string)).collect();
        for did in ids {let doc=self.read(&did)?;self.database()?.begin_write(&doc)?;}
        let p = self.get_project(id)?;
        let mut ids: Vec<String> = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|d| d.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        for d in self.doc_files(&p) {
            if let Some(did) = d.get("id").and_then(|v| v.as_str()) {
                ids.push(did.to_string());
            }
        }
        self.trash_path(&p.dir)?;
        record_change(&p.dir);
        let mut deleted = self.deleted()?;
        for doc_id in ids {
            self.sync_holds.retain(|_, (held_id, _)| held_id != &doc_id);
            self.last_snapshot.remove(&doc_id);
            let _ = self.clear_draft(&doc_id);
            deleted.insert(
                doc_id.clone(),
                json!({
                    "projectId": id,
                    "deletedAt": deleted_at,
                }),
            );
            self.database()?.forget_current(&doc_id)?;
        }
        deleted.insert(
            project_tombstone(id),
            json!({
                "projectId": id,
                "deletedAt": deleted_at,
                "project": true,
            }),
        );
        self.save_deleted(&deleted)?;
        Ok(true)
    }

    pub fn snapshot(&mut self) -> Result<Value, LofError> {
        self.require_database()?;
        let list = self.list()?;
        if let Some(warnings) = list.get("warnings").and_then(|v| v.as_array()) {
            if !warnings.is_empty() {
                let joined: Vec<&str> = warnings.iter().filter_map(|w| w.as_str()).collect();
                return Err(fail_invalid(format!(
                    "읽을 수 없는 문서가 있어 동기화를 중단했습니다. {}",
                    joined.join("; ")
                )));
            }
        }
        let projects_arr = list
            .get("projects")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let projects_out: Vec<Value> = projects_arr.iter().map(project_fields).collect();
        let mut assets = Vec::new();
        for p in &projects_arr {
            let cov = p.get("cover").and_then(|v| v.as_str());
            let folder = p.get("folder").and_then(|v| v.as_str());
            if valid_cover(cov) && folder.is_some() {
                let bytes = fs::read(
                    self.root
                        .join(folder.unwrap())
                        .join("assets")
                        .join(cov.unwrap()),
                )?;
                assets.push(json!({
                    "projectId": p.get("id"),
                    "filename": cov.unwrap(),
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }));
            }
        }

        let docs_arr = list
            .get("documents")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut documents = Vec::with_capacity(docs_arr.len());
        for m in &docs_arr {
            let mid = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let d = self.read(mid)?;
            let kind = d.get("kind").and_then(|v| v.as_str()).unwrap_or("episode");
            let mut item = Map::new();
            item.insert("id".to_string(), d.get("id").cloned().unwrap_or(json!("")));
            item.insert(
                "projectId".to_string(),
                d.get("projectId").cloned().unwrap_or(json!("")),
            );
            item.insert("kind".to_string(), json!(kind));
            item.insert(
                "title".to_string(),
                d.get("title").cloned().unwrap_or(json!("")),
            );
            item.insert(
                "status".to_string(),
                d.get("status").cloned().unwrap_or(json!("in_progress")),
            );
            let meta = if kind == "episode" {
                stored_meta(Some(&d))
            } else {
                stored_document_meta(Some(&d))
            };
            for (k, v) in meta {
                item.insert(k, v);
            }
            if let Some(props) = d.get("properties").and_then(|v| v.as_object()) {
                if !props.is_empty() {
                    item.insert("properties".to_string(), Value::Object(props.clone()));
                }
            }
            item.insert(
                "order".to_string(),
                d.get("order").cloned().unwrap_or(json!(0)),
            );
            item.insert(
                "archived".to_string(),
                d.get("archived").cloned().unwrap_or(json!(false)),
            );
            if let Some(ca) = d.get("createdAt") {
                item.insert("createdAt".to_string(), ca.clone());
            }
            if let Some(ua) = d.get("updatedAt") {
                item.insert("updatedAt".to_string(), ua.clone());
            }
            if let Some(ep_id) = d
                .get("episodeId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                item.insert("episodeId".to_string(), json!(ep_id));
            }
            if kind != "episode" {
                if let Some(rp) = d.get("relPath") {
                    item.insert("path".to_string(), rp.clone());
                }
            }
            item.insert(
                "body".to_string(),
                d.get("body").cloned().unwrap_or(json!("")),
            );
            item.insert(
                "revision".to_string(),
                d.get("fingerprint").cloned().unwrap_or(json!("")),
            );
            documents.push(Value::Object(item));
        }

        let all_deleted = self.deleted()?;
        let mut deleted = Map::new();
        for (id, info) in all_deleted {
            let exists_doc = docs_arr
                .iter()
                .any(|d| d.get("id").and_then(|v| v.as_str()) == Some(&id));
            let exists_proj = projects_arr.iter().any(|p| {
                p.get("id")
                    .and_then(|v| v.as_str())
                    .is_some_and(|pid| project_tombstone(pid) == id)
            });
            if !exists_doc && !exists_proj {
                deleted.insert(id, info);
            }
        }

        Ok(json!({
            "format": FORMAT,
            "projects": projects_out,
            "assets": assets,
            "documents": documents,
            "deleted": deleted,
        }))
    }

    fn put_remote_doc(&mut self, remote: &Value) -> Result<(), LofError> {
        let project_id = remote
            .get("projectId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut p = self.get_project(project_id)?;
        let kind = remote
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("episode");
        let rid = remote.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let body = remote.get("body").and_then(|v| v.as_str()).unwrap_or("");

        if kind != "episode" {
            let rpath = remote.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let old = self
                .doc_files(&p)
                .into_iter()
                .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(rid));
            let old_path = old
                .as_ref()
                .and_then(|d| d.get("path").and_then(|v| v.as_str()));
            if abs(&p.dir, rpath).exists() && old_path != Some(rpath) {
                return Err(fail(
                    "동기화 대상 경로에 다른 문서가 있습니다. 파일 이름을 바꾼 뒤 다시 동기화해 주세요.",
                    "EXISTS",
                ));
            }
            if let Some(op) = old_path {
                if op != rpath {
                    self.move_files(&p.dir, &[(op.to_string(), rpath.to_string())])?;
                }
            }
            let ep_id = remote
                .get("episodeId")
                .and_then(|v| v.as_str())
                .filter(|eid| {
                    p.project
                        .get("documents")
                        .and_then(|v| v.as_array())
                        .is_some_and(|docs| {
                            docs.iter().any(|d| {
                                d.get("id").and_then(|v| v.as_str()) == Some(*eid)
                                    && d.get("kind").and_then(|v| v.as_str()) == Some("episode")
                            })
                        })
                });
            let mut rdoc = remote.as_object().cloned().unwrap_or_default();
            rdoc.insert(
                "episodeId".to_string(),
                ep_id.map(|s| json!(s)).unwrap_or(Value::Null),
            );
            atomic_write_str(
                &abs(&p.dir, rpath),
                &write_markdown(body, &Value::Object(rdoc), "")?,
            )?;
            if Self::drop_doc_meta(&mut p, rpath) {
                self.write_project(&p)?;
            }
            return Ok(());
        }

        let mut fields = Map::new();
        fields.insert(
            "title".to_string(),
            remote.get("title").cloned().unwrap_or(json!("")),
        );
        fields.insert(
            "status".to_string(),
            json!(normalize_status_val(remote.get("status"))),
        );
        for (k, v) in stored_meta(Some(remote)) {
            fields.insert(k, v);
        }
        fields.insert(
            "properties".to_string(),
            Value::Object(custom_properties(remote)),
        );
        let order = remote.get("order").and_then(|v| v.as_i64()).unwrap_or(0);
        fields.insert("order".to_string(), json!(order));
        fields.insert(
            "archived".to_string(),
            json!(remote.get("archived").and_then(|v| v.as_bool()).unwrap_or(false)),
        );
        let now = now_iso();
        fields.insert(
            "createdAt".to_string(),
            json!(remote.get("createdAt").and_then(|v| v.as_str()).unwrap_or(&now)),
        );
        fields.insert(
            "updatedAt".to_string(),
            json!(remote.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(&now)),
        );
        fields.insert("hash".to_string(), json!(hash_str(body)));

        let existing_idx = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .and_then(|docs| {
                docs.iter()
                    .position(|d| d.get("id").and_then(|v| v.as_str()) == Some(rid))
            });

        let Some(idx) = existing_idx else {
            let mut entry = fields;
            entry.insert("id".to_string(), json!(rid));
            entry.insert("kind".to_string(), json!(kind));
            self.insert_episode(&mut p, Value::Object(entry), body)?;
            return Ok(());
        };

        if let Some(arr) = p
            .project
            .get_mut("documents")
            .and_then(|v| v.as_array_mut())
        {
            if let Some(eobj) = arr[idx].as_object_mut() {
                for &mk in META_FIELDS {
                    eobj.remove(mk);
                }
                for (k, v) in fields {
                    eobj.insert(k, v);
                }
                eobj.insert("_markdown".to_string(), json!(true));
            }
        }
        self.layout(&mut p)?;
        let entry = p
            .project
            .get("documents")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.get(idx))
            .cloned()
            .unwrap_or(Value::Null);
        let epath = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        atomic_write_str(&abs(&p.dir, epath), &write_markdown(body, &entry, "")?)?;
        self.write_project(&p)
    }

    pub fn merge(
        &mut self,
        snapshot: &Value,
        base: &HashMap<String, String>,
        conflict_policy: SyncConflictPolicy,
    ) -> Result<Value, LofError> {
        let Some(snap_projects) = snapshot.get("projects").and_then(|v| v.as_array()) else {
            return Err(fail_invalid("지원하지 않는 동기화 형식"));
        };
        let Some(snap_docs) = snapshot.get("documents").and_then(|v| v.as_array()) else {
            return Err(fail_invalid("지원하지 않는 동기화 형식"));
        };
        if snapshot.get("format").and_then(|v| v.as_i64()) != Some(FORMAT)
            || snap_docs.len() > 20000
        {
            return Err(fail_invalid("지원하지 않는 동기화 형식"));
        }

        let assets = match snapshot.get("assets") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) if a.len() <= snap_projects.len() => a.clone(),
            _ => return Err(fail_invalid("잘못된 표지 목록")),
        };

        for p in snap_projects {
            let pid = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !valid_id(pid) || !p.get("title").is_some_and(|v| v.is_string()) {
                return Err(fail_invalid("잘못된 작품 데이터"));
            }
            normalize_tags(p.get("tags"))?;
            if let Some(cov) = p.get("cover").filter(|v| !v.is_null()) {
                if !valid_cover(cov.as_str()) {
                    return Err(fail_invalid("잘못된 표지 경로"));
                }
            }
        }

        let mut seen_assets = HashSet::new();
        for asset in &assets {
            let Some(data_str) = asset.get("data").and_then(|v| v.as_str()) else {
                return Err(fail_invalid("잘못된 표지 데이터"));
            };
            let apid = asset.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let afn = asset.get("filename").and_then(|v| v.as_str()).unwrap_or("");
            let matches_proj = snap_projects.iter().any(|p| {
                p.get("id").and_then(|v| v.as_str()) == Some(apid)
                    && p.get("cover").and_then(|v| v.as_str()) == Some(afn)
            });
            if data_str.len() > 11_000_000 || !matches_proj || !seen_assets.insert(apid.to_string())
            {
                return Err(fail_invalid("잘못된 표지 데이터"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_str)
                .map_err(|_| fail_invalid("잘못된 표지 데이터"))?;
            validate_cover(&bytes, Some(afn))?;
        }

        for p in snap_projects {
            if p.get("cover").is_some_and(|v| !v.is_null()) {
                let pid = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !seen_assets.contains(pid) {
                    return Err(fail_invalid("원격 표지가 누락됐습니다."));
                }
            }
        }

        let mut ids = HashSet::new();
        for remote in snap_docs {
            let rid = remote.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let rkind = remote.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let rpid = remote.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let Some(rbody) = remote.get("body").and_then(|v| v.as_str()) else {
                return Err(fail_invalid("잘못된 원격 문서"));
            };
            if !valid_id(rid)
                || !ids.insert(rid.to_string())
                || !KINDS.contains(&rkind)
                || !remote.get("title").is_some_and(|v| v.is_string())
                || utf16_len(rbody) > 10_000_000
                || !snap_projects
                    .iter()
                    .any(|p| p.get("id").and_then(|v| v.as_str()) == Some(rpid))
            {
                return Err(fail_invalid("잘못된 원격 문서"));
            }
            if rkind != "episode" {
                let rpath = remote.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let low = rpath.to_ascii_lowercase();
                if !valid_rel(rpath) || !low.starts_with("doc/") || !low.ends_with(".md") {
                    return Err(fail_invalid("잘못된 원격 문서 경로"));
                }
            }
            let rrev = remote.get("revision").and_then(|v| v.as_str()).unwrap_or("");
            if fingerprint(remote, rbody) != rrev {
                return Err(fail_invalid("원격 문서 체크섬 불일치"));
            }
        }

        let remote_deleted = match snapshot.get("deleted") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(m))
                if m.len() <= 20000 && m.keys().all(|id| valid_id(id)) =>
            {
                m.clone()
            }
            _ => return Err(fail_invalid("잘못된 삭제 기록")),
        };

        let mut local = self.list()?;
        if local.get("warnings").and_then(Value::as_array).is_some_and(|warnings| !warnings.is_empty()) {
            return Err(fail("읽을 수 없는 문서가 있어 원격 변경을 적용하지 않았습니다. 서재의 경고를 확인해 주세요.", "SYNC_LOCAL_ERROR"));
        }
        let mut tombstones = self.deleted()?;
        let mut removed = Vec::new();

        for (id, info) in &remote_deleted {
            if info.get("project").and_then(|v| v.as_bool()) != Some(true) || !id.starts_with("p-")
            {
                continue;
            }
            let project_id = &id[2..];
            let lp = local
                .get("projects")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(project_id))
                })
                .cloned();
            if let Some(lp_val) = lp {
                let pf_hash =
                    hash_str(&serde_json::to_string(&project_fields(&lp_val)).unwrap_or_default());
                let proj_unchanged =
                    base.get(&format!("project:{}", project_id)) == Some(&pf_hash);
                let docs_unchanged = local
                    .get("documents")
                    .and_then(|v| v.as_array())
                    .is_some_and(|arr| {
                        arr.iter()
                            .filter(|d| {
                                d.get("projectId").and_then(|v| v.as_str()) == Some(project_id)
                            })
                            .all(|d| {
                                let did = d.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let dfp =
                                    d.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("");
                                base.get(did).map(|s| s.as_str()) == Some(dfp)
                            })
                    });
                if proj_unchanged && docs_unchanged {
                    let del_at = info
                        .get("deletedAt")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(now_iso);
                    self.remove_project_inner(project_id, &del_at)?;
                    removed.push(id.clone());
                }
            } else if !tombstones.contains_key(id) {
                let del_at = info
                    .get("deletedAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(now_iso);
                tombstones.insert(
                    id.clone(),
                    json!({
                        "projectId": project_id,
                        "deletedAt": del_at,
                        "project": true,
                    }),
                );
                self.save_deleted(&tombstones)?;
            }
        }

        if !removed.is_empty() {
            local = self.list()?;
        }

        for (id, info) in &remote_deleted {
            let info_pid = info
                .get("projectId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if info.get("project").and_then(|v| v.as_bool()) == Some(true)
                || remote_deleted.contains_key(&project_tombstone(info_pid))
            {
                continue;
            }
            let lm = local
                .get("documents")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
                })
                .cloned();
            if let Some(lm_val) = lm {
                let lfp = lm_val
                    .get("fingerprint")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if base.get(id).map(|s| s.as_str()) == Some(lfp) {
                    let del_at = info
                        .get("deletedAt")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(now_iso);
                    self.remove_inner(id, &del_at)?;
                    removed.push(id.clone());
                }
            } else if !tombstones.contains_key(id) {
                let del_at = info
                    .get("deletedAt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(now_iso);
                tombstones.insert(
                    id.clone(),
                    json!({
                        "projectId": info_pid,
                        "deletedAt": del_at,
                    }),
                );
                self.save_deleted(&tombstones)?;
            }
        }

        if !removed.is_empty() {
            local = self.list()?;
        }

        let deleted_here = self.deleted()?;
        let mut imported = Vec::new();
        let mut conflicts = Vec::new();
        let mut project_conflicts = Vec::new();
        let mut projects_updated = Vec::new();
        let mut assets_updated = Vec::new();

        for p in snap_projects {
            let pid = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let existing = local
                .get("projects")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|x| x.get("id").and_then(|v| v.as_str()) == Some(pid))
                })
                .cloned();
            let fields = project_fields(p);
            if existing.is_none() && deleted_here.contains_key(&project_tombstone(pid)) {
                continue;
            }
            if existing.is_none() {
                self.new_project(
                    &fields,
                    &json!({
                        "id": pid,
                        "index": p.get("index"),
                        "cover": p.get("cover").cloned().unwrap_or(Value::Null),
                        "createdAt": p.get("createdAt"),
                        "updatedAt": p.get("updatedAt"),
                    }),
                )?;
                projects_updated.push(pid.to_string());
            } else if let Some(ex) = existing {
                let mine = project_fields(&ex);
                let mine_json = serde_json::to_string(&mine).unwrap_or_default();
                let fields_json = serde_json::to_string(&fields).unwrap_or_default();
                if mine_json == fields_json {
                    continue;
                }
                let old_hash = hash_str(&mine_json);
                let remote_hash = hash_str(&fields_json);
                let base_proj = base.get(&format!("project:{}", pid));
                let conflicting = base_proj != Some(&old_hash) && base_proj != Some(&remote_hash);
                let latest_remote = conflict_policy == SyncConflictPolicy::Latest && conflicting
                    && sync_remote_is_newer(p, &ex, &remote_hash, &old_hash);
                if base_proj == Some(&old_hash) || latest_remote {
                    let mut upd = fields.as_object().cloned().unwrap_or_default();
                    upd.insert(
                        "manualLineBreak".to_string(),
                        p.get("manualLineBreak").cloned().unwrap_or(Value::Null),
                    );
                    upd.insert(
                        "cover".to_string(),
                        p.get("cover").cloned().unwrap_or(Value::Null),
                    );
                    self.update_project_inner(&Value::Object(upd), true)?;
                    projects_updated.push(pid.to_string());
                } else if base_proj != Some(&remote_hash) && conflict_policy == SyncConflictPolicy::KeepBoth {
                    let cfile = self
                        .root
                        .join(".lof")
                        .join("project-conflicts")
                        .join(format!("{}-{}.json", pid, remote_hash));
                    let pretty = serde_json::to_string_pretty(p).unwrap_or_default();
                    if fs::read_to_string(&cfile).ok().as_deref() != Some(pretty.as_str()) {
                        atomic_write_str(&cfile, &pretty)?;
                        project_conflicts.push(pid.to_string());
                    }
                }
            }
        }

        for asset in &assets {
            let apid = asset.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let has_local_proj = local
                .get("projects")
                .and_then(|v| v.as_array())
                .is_some_and(|arr| {
                    arr.iter()
                        .any(|x| x.get("id").and_then(|v| v.as_str()) == Some(apid))
                });
            if deleted_here.contains_key(&project_tombstone(apid)) && !has_local_proj {
                continue;
            }
            let p = self.get_project(apid)?;
            let afn = asset.get("filename").and_then(|v| v.as_str()).unwrap_or("");
            let data_str = asset.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_str)
                .unwrap_or_default();
            let asset_path = p.dir.join("assets").join(afn);
            if fs::read(&asset_path).ok().as_deref() != Some(bytes.as_slice()) {
                atomic_write_bytes(&asset_path, &bytes)?;
                assets_updated.push(format!("{apid}/{afn}"));
            }
        }

        let mut sorted_docs = snap_docs.clone();
        sorted_docs.sort_by_key(|d| {
            if d.get("kind").and_then(|v| v.as_str()) == Some("episode") {
                0
            } else {
                1
            }
        });

        for remote in &sorted_docs {
            let rid = remote.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let rpid = remote.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let rkind = remote.get("kind").and_then(|v| v.as_str()).unwrap_or("episode");
            let rrev = remote.get("revision").and_then(|v| v.as_str()).unwrap_or("");

            let lm = local
                .get("documents")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(rid))
                })
                .cloned();

            if lm.is_none()
                && (deleted_here.contains_key(rid)
                    || deleted_here.contains_key(&project_tombstone(rpid)))
            {
                continue;
            }
            if lm.is_none() {
                self.put_remote_doc(remote)?;
                imported.push(rid.to_string());
            } else if let Some(lm_val) = lm {
                let lfp = lm_val
                    .get("fingerprint")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let lpid = lm_val
                    .get("projectId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let lkind = lm_val
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("episode");

                if lfp != rrev {
                    let kind_compat =
                        lkind == rkind || (lkind != "episode" && rkind != "episode");
                    let remote_changed = base.get(rid).map(|s| s.as_str()) != Some(rrev);
                    let latest_remote = conflict_policy == SyncConflictPolicy::Latest && remote_changed
                        && sync_remote_is_newer(remote, &lm_val, rrev, lfp);
                    if (base.get(rid).map(|s| s.as_str()) == Some(lfp) || latest_remote)
                        && lpid == rpid
                        && kind_compat
                    {
                        let current = self.read(rid)?;
                        if current.get("fingerprint").and_then(|v| v.as_str()) != Some(lfp) {
                            return Err(fail("동기화 중 로컬 문서가 변경됐습니다.", "CONFLICT"));
                        }
                        let (_, _, f_file) = self.find_doc(rid)?;
                        let prev_raw = fs::read_to_string(&f_file).unwrap_or_default();
                        self.database()?.begin_write(&current)?;
                        self.write_history(rid, &current, &prev_raw)?;
                        self.put_remote_doc(remote)?;
                        let received = self.read(rid)?;
                        self.database()?.finish_write(&received)?;
                        imported.push(rid.to_string());
                    } else if remote_changed && (conflict_policy == SyncConflictPolicy::KeepBoth
                        || lpid != rpid || !kind_compat) {
                        let key = format!("{}:{}", rid, rrev);
                        let already_has_conflict = local
                            .get("documents")
                            .and_then(|v| v.as_array())
                            .is_some_and(|arr| {
                                arr.iter().any(|d| {
                                    d.get("conflictOf").and_then(|v| v.as_str()) == Some(&key)
                                })
                            });
                        if !already_has_conflict {
                            let rtitle = remote
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("제목 없음");
                            let mut create_in = Map::new();
                            create_in.insert("projectId".to_string(), json!(rpid));
                            create_in.insert("kind".to_string(), json!(rkind));
                            create_in.insert(
                                "title".to_string(),
                                json!(format!("{} (동기화 충돌 사본)", rtitle)),
                            );
                            create_in.insert(
                                "body".to_string(),
                                remote.get("body").cloned().unwrap_or(json!("")),
                            );
                            if rkind != "episode" {
                                for (k, v) in stored_document_meta(Some(remote)) {
                                    create_in.insert(k, v);
                                }
                                let rpath =
                                    remote.get("path").and_then(|v| v.as_str()).unwrap_or("");
                                let folder = folder_of(rpath);
                                if folder.len() > 4 && folder.starts_with("doc/") {
                                    create_in.insert("folder".to_string(), json!(&folder[4..]));
                                }
                            }
                            create_in.insert(
                                "properties".to_string(),
                                Value::Object(custom_properties(remote)),
                            );
                            if let Some(rep_id) =
                                remote.get("episodeId").and_then(|v| v.as_str())
                            {
                                let has_ep = local
                                    .get("documents")
                                    .and_then(|v| v.as_array())
                                    .is_some_and(|arr| {
                                        arr.iter().any(|d| {
                                            d.get("id").and_then(|v| v.as_str()) == Some(rep_id)
                                        })
                                    });
                                if has_ep {
                                    create_in.insert("episodeId".to_string(), json!(rep_id));
                                }
                            }
                            let copy = self.create_inner(
                                &Value::Object(create_in),
                                &json!({ "conflictOf": key }),
                            )?;
                            if let Some(cid) = copy.get("id").and_then(|v| v.as_str()) {
                                conflicts.push(cid.to_string());
                            }
                        }
                    }
                }
            }
        }

        Ok(json!({
            "imported": imported,
            "conflicts": conflicts,
            "projectConflicts": project_conflicts,
            "projectsUpdated": projects_updated,
            "assetsUpdated": assets_updated,
            "removed": removed,
        }))
    }
}

pub fn strip_verbatim_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    // `\\?\UNC\server\share` is a network path; it must become `\\server\share`,
    // otherwise stripping only `\\?\` leaves a relative `UNC\...` path.
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        p.to_path_buf()
    }
}
