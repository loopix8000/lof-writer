use crate::error::{fail_invalid, now_iso, LofError};
use crate::markdown::{markdown_entry, read_markdown};
use crate::store::{atomic_write_str, Store};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use uuid::Uuid;

fn escape_md_prose(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn text_content(node: &Value, warnings: &mut Vec<String>, seen: &mut HashSet<String>) -> String {
    if let Some(s) = node.as_str() {
        return s.to_string();
    }
    let Some(obj) = node.as_object() else {
        return String::new();
    };
    let ntype = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ntype == "hardBreak" || ntype == "hard_break" {
        return "  \n".to_string();
    }
    let mut value = if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
        escape_md_prose(t)
    } else if let Some(arr) = obj.get("content").and_then(|v| v.as_array()) {
        arr.iter()
            .map(|n| text_content(n, warnings, seen))
            .collect::<Vec<_>>()
            .join("")
    } else {
        String::new()
    };

    if let Some(marks) = obj.get("marks").and_then(|v| v.as_array()) {
        for m in marks {
            let mtype = m.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match mtype {
                "bold" => value = format!("**{}**", value),
                "italic" => value = format!("*{}*", value),
                "strike" => value = format!("~~{}~~", value),
                _ => {
                    let msg = format!("지원하지 않는 서식: {} (원본 보관)", mtype);
                    if seen.insert(msg.clone()) {
                        warnings.push(msg);
                    }
                }
            }
        }
    }
    value
}

fn add_warning(warnings: &mut Vec<String>, seen: &mut HashSet<String>, msg: &str) {
    if seen.insert(msg.to_string()) {
        warnings.push(msg.to_string());
    }
}

pub fn import_files(
    store: &mut Store,
    files: &[String],
    project_id: &str,
) -> Result<Value, LofError> {
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();
    let mut imported_count = 0;
    let batch = Uuid::new_v4().to_string();

    for file_str in files {
        let file = Path::new(file_str);
        let stat = fs::metadata(file)?;
        if stat.len() > 20_000_000 {
            return Err(fail_invalid("가져오기는 파일당 20MB 이하만 지원합니다."));
        }
        let raw_content = fs::read_to_string(file)?;
        let raw = raw_content.strip_prefix('\u{feff}').unwrap_or(&raw_content);
        let file_stem = file
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("제목 없음")
            .to_string();
        let ext = file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let mut title = file_stem;
        let mut body = raw.to_string();
        let mut attributes = Map::new();
        let mut kind = "episode".to_string();

        if ext == "mvle" {
            let obj: Value = serde_json::from_str(raw)
                .map_err(|_| fail_invalid("지원하지 않는 mvle 구조입니다."))?;
            let Some(blocks) = obj.get("blocks").and_then(|v| v.as_array()) else {
                return Err(fail_invalid("지원하지 않는 mvle 구조입니다."));
            };
            if let Some(t) = obj
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                title = t.to_string();
            }
            let mut sorted_blocks = blocks.clone();
            sorted_blocks.sort_by_key(|b| b.get("order").and_then(|v| v.as_i64()).unwrap_or(0));
            body = sorted_blocks
                .iter()
                .map(|b| {
                    if let Some(arr) = b.get("content").and_then(|v| v.as_array()) {
                        arr.iter()
                            .map(|n| text_content(n, &mut warnings, &mut seen))
                            .collect::<Vec<_>>()
                            .join("")
                    } else {
                        let txt = b.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        escape_md_prose(txt)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n\n");

            if obj
                .get("comments")
                .and_then(|v| v.as_array())
                .is_some_and(|a| !a.is_empty())
            {
                add_warning(
                    &mut warnings,
                    &mut seen,
                    "Muvel 댓글은 원본 파일에 보관됩니다. 댓글 UI 변환은 지원하지 않습니다.",
                );
            }
            if blocks.iter().any(|b| {
                b.get("attr")
                    .and_then(|v| v.as_object())
                    .is_some_and(|m| !m.is_empty())
            }) {
                add_warning(
                    &mut warnings,
                    &mut seen,
                    "문단별 부가 속성은 원본 파일에 보관됩니다.",
                );
            }
            if blocks.iter().any(|b| {
                b.get("blockType")
                    .and_then(|v| v.as_str())
                    .is_some_and(|bt| !bt.is_empty() && bt != "describe")
            }) {
                add_warning(
                    &mut warnings,
                    &mut seen,
                    "특수 블록은 문단 텍스트로 가져오며 원본 파일을 보관합니다.",
                );
            }
        } else if ext == "txt" {
            let escaped = escape_md_prose(raw);
            body = escaped
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .replace('\n', "\n\n");
        } else if ext == "md" {
            let parsed = read_markdown(raw)?;
            if parsed.has_properties {
                let pkind = parsed
                    .properties
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("episode");
                kind = if pkind == "plot" || pkind == "memo" {
                    pkind.to_string()
                } else {
                    "episode".to_string()
                };
                let entry = markdown_entry(raw, &json!({ "kind": kind, "title": title }))?;
                attributes = entry.as_object().cloned().unwrap_or_default();
                if let Some(t) = attributes.get("title").and_then(|v| v.as_str()) {
                    title = t.to_string();
                }
                body = parsed.body;
                if let Some(ep_id) = attributes
                    .get("episodeId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                {
                    let p = store.get_project(project_id)?;
                    let exists_ep = p
                        .project
                        .get("documents")
                        .and_then(|v| v.as_array())
                        .is_some_and(|docs| {
                            docs.iter()
                                .any(|d| d.get("id").and_then(|v| v.as_str()) == Some(&ep_id))
                        });
                    if !exists_ep {
                        attributes.insert("episodeId".to_string(), Value::Null);
                        add_warning(
                            &mut warnings,
                            &mut seen,
                            "가져온 문서의 연결 회차가 현재 작품에 없어 독립 문서로 등록했습니다.",
                        );
                    }
                }
            }
        }

        let batch_dir = store.root.join(".lof").join("imports").join(&batch);
        fs::create_dir_all(&batch_dir)?;
        let base_fn = file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("imported");
        let backup = batch_dir.join(format!("{}-{}", Uuid::new_v4(), base_fn));
        fs::copy(file, backup)?;

        attributes.insert("projectId".to_string(), json!(project_id));
        attributes.insert("kind".to_string(), json!(kind));
        attributes.insert("title".to_string(), json!(title));
        attributes.insert("body".to_string(), json!(body));
        store.create(&Value::Object(attributes))?;
        imported_count += 1;
    }

    let report_file = store
        .root
        .join(".lof")
        .join("imports")
        .join(&batch)
        .join("report.json");
    let report = serde_json::to_string_pretty(&json!({
        "at": now_iso(),
        "count": imported_count,
        "warnings": warnings,
    }))
    .unwrap_or_default();
    atomic_write_str(&report_file, &report)?;

    Ok(json!({
        "count": imported_count,
        "warnings": warnings,
    }))
}
