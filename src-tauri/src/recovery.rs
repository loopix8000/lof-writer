use crate::error::{fail_invalid, hash_str, now_iso, utf16_len, LofError};
use crate::store::{atomic_write_str, Store};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn summary(mut copy: Value) -> Value {
    if let Some(document) = copy["document"].as_object_mut() {
        document.remove("body");
    }
    copy
}

impl Store {
    pub fn set_recovery_directory(&mut self, base: &std::path::Path) {
        let identity = self.vault["id"].as_str().unwrap_or("");
        self.recovery_dir = Some(base.join("recovery-copies").join(hash_str(identity)));
    }

    fn recovery_directory(&self) -> PathBuf {
        self.recovery_dir
            .clone()
            .unwrap_or_else(|| self.root.join(".lof/recovery-copies"))
    }
    fn recovery_file(&self, key: &str) -> Result<PathBuf, LofError> {
        if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(fail_invalid("잘못된 복구 사본입니다."));
        }
        Ok(self.recovery_directory().join(format!("{key}.json")))
    }

    // 원본 파일·관리 DB·Git 이력에 문제가 있어도 사본 저장은 독립적으로 처리한다.
    pub fn save_recovery_copy(&self, input: &Value) -> Result<Value, LofError> {
        let document = &input["document"];
        let body = document["body"]
            .as_str()
            .ok_or_else(|| fail_invalid("복구할 본문이 없습니다."))?;
        if utf16_len(body) > 10_000_000 {
            return Err(fail_invalid("본문은 10MB 이하만 지원합니다."));
        }
        let key =
            hash_str(&serde_json::to_string(document).map_err(|e| fail_invalid(e.to_string()))?);
        let file = self.recovery_file(&key)?;
        if let Some(existing) = self
            .read_recovery_copy(&key)
            .ok()
            .filter(|copy| copy["document"] == *document)
        {
            return Ok(summary(existing));
        }
        let copy = json!({"key": key, "savedAt": now_iso(), "document": document});
        atomic_write_str(
            &file,
            &serde_json::to_string(&copy).map_err(|e| fail_invalid(e.to_string()))?,
        )?;
        Ok(summary(copy))
    }

    pub fn recovery_copies(&self) -> Result<Value, LofError> {
        let mut copies = Vec::new();
        let dir = self.recovery_directory();
        if !dir.exists() {
            return Ok(json!([]));
        }
        for entry in fs::read_dir(dir)? {
            let Ok(entry) = entry else {
                continue;
            };
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let key = entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if self.recovery_file(&key).is_err() {
                continue;
            }
            // 한 사본을 읽지 못해도 다른 사본은 계속 표시한다.
            copies.push(match self.read_recovery_copy(&key) {
                Ok(copy) => summary(copy),
                Err(_) => json!({"key":key,"savedAt":"","unreadable":true,
                    "document":{"title":"읽을 수 없는 복구 사본"}}),
            });
        }
        copies.sort_by(|a, b| b["savedAt"].as_str().cmp(&a["savedAt"].as_str()));
        Ok(json!(copies))
    }

    pub fn remove_recovery_copy(&self, key: &str) -> Result<Value, LofError> {
        match fs::remove_file(self.recovery_file(key)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(json!(true))
    }

    pub fn read_recovery_copy(&self, key: &str) -> Result<Value, LofError> {
        let raw = fs::read_to_string(self.recovery_file(key)?)?;
        let mut copy: Value =
            serde_json::from_str(&raw).map_err(|e| fail_invalid(e.to_string()))?;
        if !copy["document"].is_object() || !copy["document"]["body"].is_string() {
            return Err(fail_invalid("복구 사본의 본문을 읽을 수 없습니다."));
        }
        copy["key"] = json!(key);
        Ok(copy)
    }

    pub fn restore_recovery_copy(&mut self, input: &Value) -> Result<Value, LofError> {
        let copy = self.read_recovery_copy(input["key"].as_str().unwrap_or(""))?;
        let mut document = copy["document"].clone();
        // 사본은 새 문서로 열고 원고를 덮어쓰지 않는다. 복구 성공 후에도 보관본은 남긴다.
        document["projectId"] = input["projectId"].clone();
        document["title"] = json!(format!(
            "{} (복구 사본)",
            document["title"].as_str().unwrap_or("제목 없음")
        ));
        let identity = hash_str(&format!(
            "{}:{}",
            input["projectId"].as_str().unwrap_or(""),
            input["key"].as_str().unwrap_or("")
        ));
        let id = format!("recovery_{}", &identity[..40]);
        if let Ok(existing) = self.read(&id) {
            return Ok(existing);
        }
        self.create_inner(&document, &json!({"id": id}))
    }
}
