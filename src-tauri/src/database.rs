use crate::error::{fail, fail_invalid, hash_str, now_iso, valid_id, LofError};
use crate::markdown::{document_properties, markdown_entry, read_markdown};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const SCHEMA: i64 = 1;
const MAX_VALUE: u64 = 50_000_000;
pub const HISTORY_LIMIT: usize = 100;
pub const HISTORY_DAYS: i64 = 30;
pub const HISTORY_MINIMUM: usize = 10;

pub struct LibraryDb {
    connection: Connection,
    pub path: PathBuf,
    _lock: fs::File,
}

fn encode(value: &Value) -> Result<Vec<u8>, LofError> {
    let raw = serde_json::to_vec(value).map_err(|e| fail_invalid(e.to_string()))?;
    if raw.len() as u64 > MAX_VALUE {
        return Err(fail_invalid("관리 데이터 항목이 50MB를 초과합니다."));
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(&raw)?;
    Ok(encoder.finish()?)
}

fn decode(bytes: &[u8]) -> Result<Value, LofError> {
    let mut raw = Vec::new();
    GzDecoder::new(bytes)
        .take(MAX_VALUE + 1)
        .read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_VALUE {
        return Err(fail_invalid("압축된 관리 데이터가 너무 큽니다."));
    }
    serde_json::from_slice(&raw).map_err(|e| fail_invalid(e.to_string()))
}

pub fn history_name_valid(name: &str) -> bool {
    let Some((time, rest)) = name.split_once('-') else {
        return false;
    };
    !time.is_empty()
        && time.bytes().all(|b| b.is_ascii_digit())
        && [".md", ".json"].iter().any(|ext| {
            rest.strip_suffix(ext).is_some_and(|id| {
                !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            })
        })
}

pub fn history_value(doc: &Value, at: &str) -> Value {
    let mut attributes = document_properties(doc);
    attributes.insert(
        "properties".into(),
        doc.get("properties").cloned().unwrap_or_else(|| json!({})),
    );
    json!({"id": doc.get("id"), "title": doc.get("title"), "status": doc.get("status"),
        "body": doc.get("body"), "savedAt": at, "attributes": attributes})
}

// 저장 버전·시각·파일 위치와 파생 값은 제외하고, 실제 문서 속성만 비교한다.
pub fn history_metadata(doc: &Value) -> Value {
    let mut source = doc.get("attributes").cloned().unwrap_or_else(|| doc.clone());
    if doc.get("attributes").is_some() {
        for key in ["id", "title", "status"] {
            if source.get(key).is_none() {
                if let Some(value) = doc.get(key) {
                    source[key] = value.clone();
                }
            }
        }
    }
    let properties = source.as_object_mut().and_then(|fields| fields.remove("properties"))
        .unwrap_or_else(|| json!({}));
    let mut metadata = document_properties(&source);
    for key in ["lof", "id", "createdAt", "updatedAt", "conflictOf"] {
        metadata.remove(key);
    }
    // 사용자 속성은 별도로 유지해 객체 키 순서와 빈 속성의 유무에 영향받지 않는다.
    metadata.insert("properties".into(), properties);
    Value::Object(metadata)
}

pub fn same_history_content(left: &Value, right: &Value) -> bool {
    left.get("body") == right.get("body") && history_metadata(left) == history_metadata(right)
}

fn legacy_history(id: &str, name: &str, raw: &str) -> Result<Value, LofError> {
    let millis = name
        .split('-')
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| fail_invalid("이력 시각을 읽지 못했습니다."))?;
    let at = chrono::DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| fail_invalid("이력 시각이 올바르지 않습니다."))?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if name.ends_with(".md") {
        let parsed = read_markdown(raw)?;
        if !parsed.has_properties {
            return Err(fail_invalid(format!("이력 속성이 없습니다: {id}/{name}")));
        }
        let kind = parsed
            .properties
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("episode");
        let title = parsed
            .properties
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut doc = markdown_entry(raw, &json!({"id": id, "kind": kind, "title": title}))?;
        doc["body"] = json!(parsed.body);
        let mut result = history_value(&doc, &at);
        let mut attrs = parsed.properties;
        if let Some(props) = doc.get("properties") {
            attrs.insert("properties".into(), props.clone());
        }
        result["attributes"] = Value::Object(attrs);
        Ok(result)
    } else {
        let value: Value = serde_json::from_str(raw)
            .map_err(|e| fail_invalid(format!("이력 형식 오류 {id}/{name}: {e}")))?;
        if !value.get("body").is_some_and(Value::is_string) {
            return Err(fail_invalid("이력 본문이 없습니다."));
        }
        let mut result = value;
        result["id"] = json!(id);
        if result.get("savedAt").and_then(Value::as_str).is_none() {
            result["savedAt"] = json!(at);
        }
        Ok(result)
    }
}

impl LibraryDb {
    pub fn open(root: &Path, vault_id: &str) -> Result<Self, LofError> {
        let dir = root.join(".lof");
        fs::create_dir_all(&dir)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("library.sqlite.lock"))?;
        if let Err(error) = fs2::FileExt::try_lock_exclusive(&lock) {
            // 다른 프로세스가 잠금을 쥐고 있을 때만 사용 중으로 본다.
            if error.kind() == fs2::lock_contended_error().kind() {
                return Err(fail(
                    "다른 Lof Writer가 이 서재의 관리 DB를 사용 중입니다.",
                    "DATABASE_BUSY",
                ));
            }
            // Android 기기 저장공간은 파일 잠금을 지원하지 않을 수 있다. Android 앱은 프로세스가 하나뿐이므로 잠금 없이 연다.
            if !cfg!(target_os = "android") {
                return Err(fail(
                    format!("서재의 관리 DB를 잠그지 못했습니다: {error}"),
                    "DATABASE_BUSY",
                ));
            }
            eprintln!("서재 관리 DB 잠금을 건너뜁니다: {error}");
        }
        let target = dir.join("library.sqlite");
        let initial = !target.exists();
        let path = if initial {
            dir.join("library.sqlite.migrating")
        } else {
            target.clone()
        };
        let connection = Connection::open(&path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        if initial {
            connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
        }
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA {
            return Err(fail(
                "더 새로운 앱에서 만든 관리 DB입니다. 앱을 업데이트해 주세요.",
                "DATABASE_VERSION",
            ));
        }
        if !initial && version != SCHEMA {
            return Err(fail(
                "관리 DB 초기화가 완료되지 않았습니다. 원본은 보존됩니다.",
                "DATABASE_MIGRATION",
            ));
        }
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bodies (project_id TEXT NOT NULL, doc_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,doc_id));
            CREATE TABLE IF NOT EXISTS observations (doc_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, doc BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS history (doc_id TEXT NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL, saved_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(doc_id,name));
            CREATE INDEX IF NOT EXISTS history_time ON history(doc_id,saved_at DESC,name DESC);
            CREATE INDEX IF NOT EXISTS history_git_migration_time ON history(saved_at,doc_id,name);
            CREATE TABLE IF NOT EXISTS pending_writes (doc_id TEXT PRIMARY KEY, previous BLOB NOT NULL, started_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts (doc_id TEXT PRIMARY KEY, data BLOB NOT NULL, saved_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS legacy_sources (path TEXT PRIMARY KEY, hash TEXT NOT NULL);
            PRAGMA user_version=1;")?;
        let db = Self {
            connection,
            path: target.clone(),
            _lock: lock,
        };
        if initial {
            db.migrate(root, vault_id)?;
            let integrity: String =
                db.connection
                    .pragma_query_value(None, "integrity_check", |row| row.get(0))?;
            if integrity != "ok" {
                return Err(fail(
                    "임시 관리 DB 무결성 확인에 실패했습니다. 기존 파일은 보존됩니다.",
                    "DATABASE_MIGRATION",
                ));
            }
            let Self {
                connection, _lock, ..
            } = db;
            drop(connection);
            fs::rename(&path, &target)?;
            drop(_lock);
            return Self::open(root, vault_id);
        }
        let saved = db
            .get("vaultId")?
            .and_then(|v| v.as_str().map(str::to_string));
        if saved.as_deref() != Some(vault_id) {
            return Err(fail(
                "관리 DB와 작업 공간의 ID가 다릅니다. 원본 DB를 보존한 뒤 복구해 주세요.",
                "DATABASE_VAULT",
            ));
        }
        db.connection.pragma_update(None, "journal_mode", "WAL")?;
        db.connection
            .pragma_update(None, "wal_autocheckpoint", 500)?;
        crate::library_sync_reset::migrate_database(&db.connection)?;
        db.recover_pending()?;
        db.migrate_drafts(root)?;
        Ok(db)
    }

    fn migrate(&self, root: &Path, vault_id: &str) -> Result<(), LofError> {
        let lof = root.join(".lof");
        let backup = lof
            .join("migrations")
            .join(format!("sqlite-v1-{}", Uuid::new_v4()));
        fs::create_dir_all(&backup)?;
        let transaction = self.connection.unchecked_transaction()?;
        let mut sources = Vec::new();
        for name in ["vault.json", "index.json", "deleted.json"] {
            let file = lof.join(name);
            if file.exists() {
                sources.push((name.to_string(), file));
            }
        }
        for sub in ["history", "sync"] {
            let dir = lof.join(sub);
            if !dir.exists() {
                continue;
            }
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                if sub == "sync"
                    && entry.file_type()?.is_file()
                    && entry.path().extension().is_some_and(|e| e == "json")
                {
                    sources.push((
                        format!("sync/{}", entry.file_name().to_string_lossy()),
                        entry.path(),
                    ));
                } else if sub == "history" && entry.file_type()?.is_dir() {
                    let id = entry.file_name().to_string_lossy().to_string();
                    if !valid_id(&id) {
                        return Err(fail_invalid("기존 이력의 문서 ID가 올바르지 않습니다."));
                    }
                    for file in fs::read_dir(entry.path())? {
                        let file = file?;
                        let name = file.file_name().to_string_lossy().to_string();
                        if !file.file_type()?.is_file() || !history_name_valid(&name) {
                            return Err(fail_invalid(format!(
                                "확인할 수 없는 기존 이력: {id}/{name}"
                            )));
                        }
                        sources.push((format!("history/{id}/{name}"), file.path()));
                    }
                }
            }
        }
        let mut checks = Vec::new();
        for (relative, file) in &sources {
            if fs::metadata(file)?.len() > MAX_VALUE {
                return Err(fail_invalid(format!("이관 파일이 너무 큽니다: {relative}")));
            }
            let bytes = fs::read(file)?;
            let raw = std::str::from_utf8(&bytes).map_err(|e| fail_invalid(e.to_string()))?;
            let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw).to_string();
            let hash = crate::error::hash_bytes(&bytes);
            let dst = backup.join(relative);
            fs::create_dir_all(dst.parent().unwrap())?;
            crate::store::atomic_write_bytes(&dst, &bytes)?;
            if fs::read(&dst)? != bytes {
                return Err(fail("이관 백업 확인에 실패했습니다.", "DATABASE_MIGRATION"));
            }
            if relative == "index.json" {
                let catalog: Value =
                    serde_json::from_str(&raw).map_err(|e| fail_invalid(e.to_string()))?;
                for project in catalog["projects"].as_array().into_iter().flatten() {
                    let pid = project["project"]["id"].as_str().unwrap_or("");
                    if !valid_id(pid) {
                        return Err(fail_invalid("기존 색인 작품 ID 오류"));
                    }
                    for record in project["files"]
                        .as_object()
                        .into_iter()
                        .flat_map(|m| m.values())
                    {
                        let mut doc = record["doc"].clone();
                        let did = doc["id"].as_str().unwrap_or("").to_string();
                        if !valid_id(&did) {
                            return Err(fail_invalid("기존 색인 문서 ID 오류"));
                        }
                        let body_file = lof.join("search").join(pid).join(format!("{did}.txt"));
                        match fs::read_to_string(&body_file) {
                            Ok(body) => {
                                doc["body"] = json!(body);
                                self.cache_body(pid, &did, &body)?;
                                self.connection.execute(
                                    "INSERT OR IGNORE INTO observations VALUES(?1,?2,?3)",
                                    params![
                                        did,
                                        doc["fingerprint"].as_str().unwrap_or(""),
                                        encode(&doc)?
                                    ],
                                )?;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => return Err(e.into()),
                        }
                    }
                }
                self.set("catalog", &catalog)?;
            } else if relative == "deleted.json" {
                self.set(
                    "deleted",
                    &serde_json::from_str::<Value>(&raw)
                        .map_err(|e| fail_invalid(e.to_string()))?,
                )?;
            } else if relative.starts_with("history/") {
                let parts: Vec<_> = relative.split('/').collect();
                let history = legacy_history(parts[1], parts[2], &raw)?;
                self.insert_history(parts[1], parts[2], &history)?;
                if self.history_read(parts[1], parts[2])? != Some(history) {
                    return Err(fail("이력 이관 대조에 실패했습니다.", "DATABASE_MIGRATION"));
                }
            } else if relative.starts_with("sync/") {
                let state: Value = serde_json::from_str(&raw)
                    .map_err(|e| fail_invalid(format!("동기화 상태 이관 실패: {e}")))?;
                self.set(&format!("legacy:{}", relative), &state)?;
            }
            self.connection.execute("INSERT INTO legacy_sources(path,hash) VALUES(?1,?2) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash", params![relative, hash])?;
            checks.push((file, hash));
        }
        for (file, hash) in checks {
            if crate::error::hash_bytes(&fs::read(file)?) != hash {
                return Err(fail(
                    "이관 중 원본이 변경되었습니다. 다시 시도해 주세요.",
                    "DATABASE_MIGRATION",
                ));
            }
        }
        self.set("vaultId", &json!(vault_id))?;
        self.set("migration", &json!({"completedAt": now_iso(), "sources": sources.len(), "backup": backup.to_string_lossy()}))?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>, LofError> {
        let raw: Option<String> = self
            .connection
            .query_row("SELECT value FROM kv WHERE key=?1", [key], |row| row.get(0))
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(|e| fail_invalid(e.to_string())))
            .transpose()
    }

    pub fn set(&self, key: &str, value: &Value) -> Result<(), LofError> {
        self.connection.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![key, value.to_string()])?;
        Ok(())
    }

    pub fn cache_body(&self, project: &str, id: &str, body: &str) -> Result<(), LofError> {
        self.connection.execute("INSERT INTO bodies VALUES(?1,?2,?3) ON CONFLICT(project_id,doc_id) DO UPDATE SET body=excluded.body WHERE body<>excluded.body", params![project,id,body])?;
        Ok(())
    }

    pub fn body(&self, project: &str, id: &str) -> Result<Option<String>, LofError> {
        Ok(self
            .connection
            .query_row(
                "SELECT body FROM bodies WHERE project_id=?1 AND doc_id=?2",
                params![project, id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn observe(&self, doc: &Value) -> Result<(), LofError> {
        self.observe_document(doc, None, true).map(|_| ())
    }

    pub fn observe_file(&self, doc: &Value, modified: &str, app_write: bool) -> Result<Value, LofError> {
        self.observe_document(doc, Some(modified), app_write)
    }

    fn observe_document(
        &self,
        doc: &Value,
        modified: Option<&str>,
        app_write: bool,
    ) -> Result<Value, LofError> {
        let id = doc["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| fail_invalid("관찰 문서 ID 오류"))?;
        let fingerprint = doc["fingerprint"]
            .as_str()
            .ok_or_else(|| fail_invalid("관찰 문서 해시가 없습니다."))?;
        let old: Option<(String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT fingerprint,doc FROM observations WHERE doc_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let transaction = self.connection.unchecked_transaction()?;
        let pending: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pending_writes WHERE doc_id=?1)",
            [id],
            |row| row.get(0),
        )?;
        let mut observed = doc.clone();
        if let Some((hash, bytes)) = &old {
            let previous = decode(bytes)?;
            if !pending && !app_write {
                // 원고를 다시 쓰지 않고 실제 파일의 수정 시각을 관리 DB에 유지한다.
                if hash != fingerprint {
                    if let Some(modified) = modified {
                        observed["updatedAt"] = json!(modified);
                    }
                } else if let Some(updated) = previous.get("updatedAt") {
                    observed["updatedAt"] = updated.clone();
                }
            }
            if hash == fingerprint && previous == observed {
                transaction.commit()?;
                return Ok(observed);
            }
            if hash != fingerprint && !pending {
                self.insert_history(
                    id,
                    &format!(
                        "{}-{}.md",
                        chrono::Utc::now().timestamp_millis(),
                        Uuid::new_v4()
                    ),
                    &history_value(&previous, &now_iso()),
                )?;
            }
        }
        self.connection.execute("INSERT INTO observations VALUES(?1,?2,?3) ON CONFLICT(doc_id) DO UPDATE SET fingerprint=excluded.fingerprint,doc=excluded.doc",params![id,fingerprint,encode(&observed)?])?;
        transaction.commit()?;
        Ok(observed)
    }

    pub fn finish_write(&self, doc: &Value) -> Result<(), LofError> {
        self.observe(doc)?;
        self.connection.execute(
            "DELETE FROM pending_writes WHERE doc_id=?1",
            [doc["id"].as_str().unwrap_or("")],
        )?;
        Ok(())
    }

    fn recover_pending(&self) -> Result<(), LofError> {
        let mut query = self
            .connection
            .prepare("SELECT doc_id,previous,started_at FROM pending_writes")?;
        let pending = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(query);
        let transaction = self.connection.unchecked_transaction()?;
        for (id, bytes, at) in pending {
            let doc = decode(&bytes)?;
            let millis = chrono::DateTime::parse_from_rfc3339(&at)
                .map_err(|e| fail_invalid(e.to_string()))?
                .timestamp_millis();
            self.insert_history(
                &id,
                &format!("{millis}-{}.md", hash_str(&format!("{id}:{at}"))),
                &history_value(&doc, &at),
            )?;
            self.connection
                .execute("DELETE FROM pending_writes WHERE doc_id=?1", [id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn begin_write(&self, doc: &Value) -> Result<(), LofError> {
        self.recover_pending()?;
        self.observe(doc)?;
        self.connection.execute("INSERT INTO pending_writes VALUES(?1,?2,?3) ON CONFLICT(doc_id) DO UPDATE SET previous=excluded.previous,started_at=excluded.started_at", params![doc["id"].as_str().unwrap_or(""),encode(doc)?,now_iso()])?;
        Ok(())
    }

    pub fn insert_history(&self, id: &str, name: &str, value: &Value) -> Result<(), LofError> {
        if !valid_id(id)
            || !history_name_valid(name)
            || !value.get("body").is_some_and(Value::is_string)
        {
            return Err(fail_invalid("이력 데이터가 올바르지 않습니다."));
        }
        let saved = value
            .get("savedAt")
            .and_then(Value::as_str)
            .ok_or_else(|| fail_invalid("이력 시각이 없습니다."))?;
        chrono::DateTime::parse_from_rfc3339(saved)
            .map_err(|_| fail_invalid("이력 시각이 올바르지 않습니다."))?;
        if let Some(previous) = self.history_read(id, name)? {
            if previous != *value {
                return Err(fail(
                    "기존 이력과 내용이 다릅니다. 원본을 보존합니다.",
                    "HISTORY_CONFLICT",
                ));
            }
            return Ok(());
        }
        let saved = chrono::DateTime::parse_from_rfc3339(saved)
            .map_err(|e| fail_invalid(e.to_string()))?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.connection.execute(
            "INSERT INTO history(doc_id,name,data,saved_at) VALUES(?1,?2,?3,?4)",
            params![id, name, encode(value)?, saved],
        )?;
        Ok(())
    }

    pub fn history(&self, id: &str) -> Result<Value, LofError> {
        let mut query = self.connection.prepare(
            "SELECT name FROM history WHERE doc_id=?1 ORDER BY saved_at DESC,name DESC LIMIT 100",
        )?;
        let names = query
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!(names
            .into_iter()
            .map(|name| json!({"name":name}))
            .collect::<Vec<_>>()))
    }

    // 고정된 백업에서 조금씩 읽으므로 이관 중의 새 저장이나 이력 정리에 영향을 받지 않는다.
    pub fn visit_history_backup(path: &Path, offset: usize, limit: usize,
        mut visit: impl FnMut(&str, &str, Value) -> Result<(), LofError>) -> Result<usize, LofError> {
        let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut query = connection.prepare(
            "SELECT doc_id,name,data FROM history ORDER BY saved_at,doc_id,name LIMIT ?1 OFFSET ?2",
        )?;
        let mut rows = query.query(params![limit as i64, offset as i64])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let data: Vec<u8> = row.get(2)?;
            visit(&id, &name, decode(&data)?)?;
            count += 1;
        }
        Ok(count)
    }

    pub fn history_read(&self, id: &str, name: &str) -> Result<Option<Value>, LofError> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT data FROM history WHERE doc_id=?1 AND name=?2",
                params![id, name],
                |row| row.get(0),
            )
            .optional()?;
        bytes.map(|data| decode(&data)).transpose()
    }

    pub fn visit_unimported_history(&self, imported: &std::collections::HashSet<String>, limit: usize,
        mut visit: impl FnMut(&str, &str, Value) -> Result<(), LofError>) -> Result<usize, LofError> {
        let mut query = self.connection.prepare("SELECT doc_id,name,data FROM history ORDER BY saved_at,doc_id,name")?;
        let mut rows = query.query([])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            if imported.contains(&format!("{id}/{name}")) { continue; }
            let bytes: Vec<u8> = row.get(2)?;
            visit(&id, &name, decode(&bytes)?)?;
            count += 1;
            if count >= limit { break; }
        }
        Ok(count)
    }

    pub fn legacy_history_page(&self, id: &str, offset: usize, limit: usize) -> Result<Value, LofError> {
        let mut query = self.connection.prepare("SELECT name,data,saved_at FROM history WHERE doc_id=?1 ORDER BY saved_at DESC,name DESC LIMIT ?2 OFFSET ?3")?;
        let mut rows = query.query(params![id, (limit + 1) as i64, offset as i64])?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            let name: String = row.get(0)?;
            let bytes: Vec<u8> = row.get(1)?;
            let doc = decode(&bytes)?;
            entries.push(json!({"name":name,"savedAt":row.get::<_,String>(2)?,"title":doc["title"],
                "kind":if doc["manual"].as_bool()==Some(true){"manual"}else{"legacy"}}));
        }
        let more = entries.len() > limit;
        entries.truncate(limit);
        Ok(json!({"entries":entries,"nextOffset":if more{Some(offset+limit)}else{None},"anchor":Value::Null,"migrating":true}))
    }

    // 이력을 지운다. id가 있으면 그 문서의 이력만(name이 있으면 그 하나만), 없으면 모든 이력을 지운다. 지운 개수를 돌려준다.
    pub fn delete_history(&self, id: Option<&str>, name: Option<&str>) -> Result<usize, LofError> {
        let removed = match (id, name) {
            (Some(id), Some(name)) => self
                .connection
                .execute("DELETE FROM history WHERE doc_id=?1 AND name=?2", params![id, name])?,
            (Some(id), None) => self.connection.execute("DELETE FROM history WHERE doc_id=?1", [id])?,
            (None, _) => self.connection.execute("DELETE FROM history", [])?,
        };
        self.connection.execute_batch("PRAGMA incremental_vacuum(256);")?;
        Ok(removed)
    }

    pub fn latest_history(&self, id: &str) -> Result<Option<(u64, Value)>, LofError> {
        let name: Option<String> = self
            .connection
            .query_row(
                "SELECT name FROM history WHERE doc_id=?1 ORDER BY saved_at DESC,name DESC LIMIT 1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match name {
            Some(name) => Ok(self.history_read(id, &name)?.map(|v| {
                (
                    name.split('-')
                        .next()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0),
                    v,
                )
            })),
            None => Ok(None),
        }
    }

    pub fn observations(&self) -> Result<Vec<Value>, LofError> {
        let mut query = self.connection.prepare("SELECT doc FROM observations")?;
        let rows = query
            .query_map([], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.iter().map(|data| decode(data)).collect()
    }

    pub fn forget_current(&self, id: &str) -> Result<(), LofError> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT doc FROM observations WHERE doc_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let transaction = self.connection.unchecked_transaction()?;
        if let Some(bytes) = bytes {
            let doc = decode(&bytes)?;
            self.insert_history(
                id,
                &format!(
                    "{}-{}.md",
                    chrono::Utc::now().timestamp_millis(),
                    Uuid::new_v4()
                ),
                &history_value(&doc, &now_iso()),
            )?;
        }
        self.connection
            .execute("DELETE FROM observations WHERE doc_id=?1", [id])?;
        self.connection
            .execute("DELETE FROM bodies WHERE doc_id=?1", [id])?;
        self.connection
            .execute("DELETE FROM pending_writes WHERE doc_id=?1", [id])?;
        self.connection
            .execute("DELETE FROM drafts WHERE doc_id=?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    // 보관 규칙에 맞춰 오래된 이력을 지운다. 문서당 최근 limit개를 넘거나, days일이 지난 이력을 지우되
    // 최근 HISTORY_MINIMUM개는 기간과 상관없이 남긴다. 평소에는 하루 한 번, 설정을 바꾸면 바로(force) 정리한다.
    pub fn retain_history(&self, limit: usize, days: i64, force: bool) -> Result<(), LofError> {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if !force
            && self
                .get("lastHistoryCleanup")?
                .and_then(|v| v.as_str().map(str::to_string))
                .as_deref()
                == Some(today.as_str())
        {
            return Ok(());
        }
        let limit = limit.max(1);
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(days.max(1))).to_rfc3339();
        let transaction = self.connection.unchecked_transaction()?;
        self.connection.execute("DELETE FROM history WHERE pinned=0 AND rowid IN (SELECT rowid FROM (SELECT rowid,saved_at,ROW_NUMBER() OVER(PARTITION BY doc_id ORDER BY saved_at DESC,name DESC) AS position FROM history WHERE pinned=0) WHERE position>?1 OR saved_at<?2)",params![limit as i64,cutoff])?;
        self.set("lastHistoryCleanup", &json!(today))?;
        transaction.commit()?;
        self.connection
            .execute_batch("PRAGMA incremental_vacuum(256);")?;
        Ok(())
    }

    pub fn backup(&self, destination: &Path) -> Result<(), LofError> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        self.connection.backup("main", destination, None)?;
        Ok(())
    }

    pub fn retain_keys(
        &self,
        prefix: &str,
        keys: &std::collections::HashSet<String>,
    ) -> Result<(), LofError> {
        let mut query = self
            .connection
            .prepare("SELECT key FROM kv WHERE substr(key,1,length(?1))=?1")?;
        let existing = query
            .query_map([prefix], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(query);
        let transaction = self.connection.unchecked_transaction()?;
        for key in existing {
            if !keys.contains(&key) {
                self.connection
                    .execute("DELETE FROM kv WHERE key=?1", [key])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn status(&self) -> Value {
        json!({"ready":true,"schemaVersion":SCHEMA,"path":self.path.to_string_lossy(),"historyDays":HISTORY_DAYS,"historyLimit":HISTORY_LIMIT,"historyMinimum":HISTORY_MINIMUM,"historyLocalOnly":true})
    }

    fn migrate_drafts(&self, root: &Path) -> Result<(), LofError> {
        let dir = root.join(".lof").join("drafts");
        let Ok(rd) = fs::read_dir(&dir) else {
            return Ok(());
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                        if let Some(id) = val.get("id").and_then(Value::as_str).filter(|id| valid_id(id)) {
                            let _ = self.save_draft(id, &val);
                        }
                    }
                }
                let _ = fs::remove_file(&path);
            }
        }
        let _ = fs::remove_dir(&dir);
        Ok(())
    }

    pub fn save_draft(&self, id: &str, value: &Value) -> Result<(), LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID"));
        }
        let saved_at = value
            .get("savedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        self.connection.execute(
            "INSERT INTO drafts(doc_id, data, saved_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(doc_id) DO UPDATE SET data=excluded.data, saved_at=excluded.saved_at",
            params![id, encode(value)?, saved_at],
        )?;
        Ok(())
    }

    pub fn drafts(&self) -> Result<Vec<Value>, LofError> {
        let mut query = self
            .connection
            .prepare("SELECT data FROM drafts ORDER BY doc_id")?;
        let rows = query
            .query_map([], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.iter().map(|data| decode(data)).collect()
    }

    pub fn clear_draft(&self, id: &str) -> Result<(), LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 ID"));
        }
        self.connection
            .execute("DELETE FROM drafts WHERE doc_id=?1", [id])?;
        Ok(())
    }

    pub fn mark_latest_history_manual(&self, id: &str) -> Result<bool, LofError> {
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT name, data FROM history WHERE doc_id=?1 ORDER BY saved_at DESC, name DESC LIMIT 1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((name, bytes)) = row else {
            return Ok(false);
        };
        let mut doc = decode(&bytes)?;
        if doc["manual"].as_bool() == Some(true) {
            return Ok(false);
        }
        doc["manual"] = json!(true);
        self.connection.execute(
            "UPDATE history SET data=?1 WHERE doc_id=?2 AND name=?3",
            params![encode(&doc)?, id, name],
        )?;
        Ok(true)
    }
}
