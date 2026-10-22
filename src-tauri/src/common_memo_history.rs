use crate::error::{fail, fail_invalid, hash_str, now_iso, valid_id, LofError};
use crate::local_git::LocalHistory;
use crate::markdown::{markdown_entry, read_markdown, write_markdown};
use crate::store::{atomic_write_str, memo_id, HistoryPolicy};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn document(path: &str, raw: &str) -> Result<Value, LofError> {
    let title = Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let mut value = markdown_entry(
        raw,
        &json!({
            "id": memo_id("common", &format!("doc/{path}")), "kind": "memo", "title": title,
        }),
    )?;
    if !value["id"].as_str().is_some_and(valid_id) {
        value["id"] = json!(memo_id("common", &format!("doc/{path}")));
    }
    value["title"] = json!(title);
    value["kind"] = json!("memo");
    Ok(value)
}

pub(crate) fn record(
    root: &Path,
    path: &str,
    raw: &str,
    kind: Option<&str>,
) -> Result<(), LofError> {
    let value = document(path, raw)?;
    let id = value["id"]
        .as_str()
        .ok_or_else(|| fail_invalid("메모 ID가 없습니다."))?;
    let mut history = LocalHistory::common_memos(root)?;
    history.capture_document(id, &value, "공용 메모 변경 내용 기록")?;
    if let Some(kind) = kind {
        history.mark(id, kind)?;
    }
    Ok(())
}

// 예전 파일에 ID가 없으면 이동 전에 저장해 이름이나 폴더가 달라져도 같은 이력을 이어 쓴다.
pub(crate) fn prepare_move(root: &Path, path: &str) -> Result<(), LofError> {
    let file = crate::sync::file_remote::safe_path(root, path)?;
    let raw = fs::read_to_string(&file)?;
    record(root, path, &raw, None)?;
    let parsed = read_markdown(&raw)?;
    if !parsed
        .properties
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(valid_id)
    {
        let value = document(path, &raw)?;
        atomic_write_str(&file, &write_markdown(&parsed.body, &value, &raw)?)?;
    }
    Ok(())
}

pub(crate) fn request(
    root: &Path,
    method: &str,
    input: &Value,
    policy: HistoryPolicy,
) -> Result<Value, LofError> {
    let path = input["path"]
        .as_str()
        .filter(|path| path.to_ascii_lowercase().ends_with(".md"))
        .ok_or_else(|| fail_invalid("공용 메모 경로가 없습니다."))?;
    let file = crate::sync::file_remote::safe_path(root, path)?;
    let raw = fs::read_to_string(&file)?;
    let current = document(path, &raw)?;
    let id = current["id"]
        .as_str()
        .ok_or_else(|| fail_invalid("메모 ID가 없습니다."))?;
    if input["id"].as_str().is_some_and(|expected| expected != id) {
        return Err(fail(
            "메모가 변경되었습니다. 이력을 다시 열어 주세요.",
            "CONFLICT",
        ));
    }
    let mut history = LocalHistory::common_memos(root)?;
    if matches!(method, "history" | "historyPage" | "checkpointDocument") {
        history.capture_document(id, &current, "공용 메모 현재 내용 기록")?;
    }
    let name = input["name"].as_str().unwrap_or("");
    match method {
        "history" | "historyPage" => {
            let offset = input["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize;
            let limit = input["limit"].as_u64().unwrap_or(100).clamp(1, 100) as usize;
            let page = history.history_page(id, offset, limit, input["anchor"].as_str(), policy)?;
            Ok(if method == "history" {
                page["entries"].clone()
            } else {
                page
            })
        }
        "checkpointDocument" => Ok(json!(history.mark(id, "manual")?)),
        "deleteHistory" => Ok(json!(history.delete(id, name)? as usize)),
        "historyRead" => {
            let mut previous = history.history_read(id, name)?;
            if input["compare"].as_bool() == Some(true) {
                previous["comparison"] = crate::git_history::comparison(&previous, &current)?;
            }
            Ok(previous)
        }
        "restore" => {
            if input["expectedRevision"].as_str() != Some(hash_str(&raw).as_str()) {
                return Err(fail(
                    "다른 곳에서 수정된 메모입니다. 현재 내용을 다시 확인해 주세요.",
                    "CONFLICT",
                ));
            }
            let previous = history.history_read(id, name)?;
            history.capture_document(id, &current, "복원 전 공용 메모 보존")?;
            history.mark(id, "before-restore")?;
            let mut attrs = previous["attributes"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            attrs.insert("id".into(), json!(id));
            attrs.insert("kind".into(), json!("memo"));
            attrs.insert("title".into(), current["title"].clone());
            attrs.insert("updatedAt".into(), json!(now_iso()));
            if let Some(created) = current.get("createdAt") {
                attrs.insert("createdAt".into(), created.clone());
            }
            let body = previous["body"]
                .as_str()
                .ok_or_else(|| fail_invalid("이력 본문이 없습니다."))?;
            let restored = write_markdown(body, &Value::Object(attrs), &raw)?;
            if fs::read_to_string(&file)? != raw {
                return Err(fail(
                    "복원 중 메모가 변경되었습니다. 다시 확인해 주세요.",
                    "CONFLICT",
                ));
            }
            atomic_write_str(&file, &restored)?;
            let mut result = document(path, &restored)?;
            if let Err(error) = record(root, path, &restored, Some("restore")) {
                result["historyWarning"] = json!(format!(
                    "메모는 복원했지만 이력을 기록하지 못했습니다: {}",
                    error.message
                ));
            }
            Ok(result)
        }
        _ => Err(fail_invalid("지원하지 않는 공용 메모 이력 요청입니다.")),
    }
}
