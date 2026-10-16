use crate::error::slice_utf16;
use serde_json::{json, Map, Value};

pub const STATUSES: &[&str] = &["planned", "in_progress", "revision", "completed"];

pub const EPISODE_TYPES: &[i64] = &[0, 1, 2, 3, 4, 5, 6];

pub const RESTRICTION_LEVELS: &[&str] = &[
    "ALL_AGES",
    "AGE_12_PLUS",
    "AGE_15_PLUS",
    "AGE_19_PLUS",
    "RESTRICTED",
    "PROHIBITED",
];

pub const POINTS_OF_VIEW: &[&str] = &[
    "FIRST_PERSON_PROTAGONIST",
    "FIRST_PERSON_OBSERVER",
    "SECOND_PERSON_OBSERVER",
    "THIRD_PERSON_OBJECTIVE",
    "OMNISCIENT_NARRATOR",
    "SELECTIVE_NARRATION",
    "MULTIPLE_POV",
    "STREAM_OF_CONSCIOUSNESS",
    "INDETERMINATE",
];

pub const META_FIELDS: &[&str] = &[
    "episodeType",
    "description",
    "authorComment",
    "tags",
    "contentRestrictionLevel",
    "pointOfView",
    "manualLineBreak",
];

pub const DOCUMENT_META_FIELDS: &[&str] = &["tags", "manualLineBreak"];

pub fn normalize_status(s: Option<&str>) -> String {
    match s {
        Some(v) if STATUSES.contains(&v) => v.to_string(),
        Some("초안") | Some("진행") => "in_progress".to_string(),
        Some("완료") => "completed".to_string(),
        _ => "in_progress".to_string(),
    }
}

pub fn normalize_status_val(v: Option<&Value>) -> String {
    normalize_status(v.and_then(|x| x.as_str()))
}

pub fn status_token(s: Option<&str>) -> String {
    let v = normalize_status(s);
    match v.as_str() {
        "in_progress" => "초안".to_string(),
        "completed" => "완료".to_string(),
        _ => v,
    }
}

pub fn normalize_type(t: Option<&Value>) -> i64 {
    let n = match t {
        Some(Value::Number(num)) => num.as_i64(),
        Some(Value::String(s)) => s.parse::<i64>().ok(),
        _ => None,
    };
    match n {
        Some(v) if EPISODE_TYPES.contains(&v) => v,
        _ => 0,
    }
}

fn text_field(v: Option<&Value>, max: usize) -> String {
    match v.and_then(|x| x.as_str()) {
        Some(s) => slice_utf16(s, max),
        None => String::new(),
    }
}

pub fn normalize_meta(e: Option<&Value>) -> Map<String, Value> {
    let obj = e.and_then(|v| v.as_object());
    let mut tags: Vec<String> = Vec::new();
    if let Some(arr) = obj.and_then(|o| o.get("tags")).and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(s) = item.as_str() {
                let trimmed = slice_utf16(s.trim(), 40);
                if !trimmed.is_empty() && !tags.contains(&trimmed) {
                    tags.push(trimmed);
                    if tags.len() >= 30 {
                        break;
                    }
                }
            }
        }
    }
    let episode_type = normalize_type(obj.and_then(|o| o.get("episodeType")));
    let description = text_field(obj.and_then(|o| o.get("description")), 2000);
    let author_comment = text_field(obj.and_then(|o| o.get("authorComment")), 10000);
    let restriction = obj
        .and_then(|o| o.get("contentRestrictionLevel"))
        .and_then(|v| v.as_str())
        .filter(|s| RESTRICTION_LEVELS.contains(s))
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    let pov = obj
        .and_then(|o| o.get("pointOfView"))
        .and_then(|v| v.as_str())
        .filter(|s| POINTS_OF_VIEW.contains(s))
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    let manual_line_break = obj
        .and_then(|o| o.get("manualLineBreak"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut out = Map::new();
    out.insert("episodeType".to_string(), json!(episode_type));
    out.insert("description".to_string(), json!(description));
    out.insert("authorComment".to_string(), json!(author_comment));
    out.insert("tags".to_string(), json!(tags));
    out.insert("contentRestrictionLevel".to_string(), restriction);
    out.insert("pointOfView".to_string(), pov);
    out.insert("manualLineBreak".to_string(), json!(manual_line_break));
    out
}

fn is_default(k: &str, v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) if s.is_empty() => true,
        Value::Bool(false) => true,
        Value::Number(n) if k == "episodeType" && n.as_i64() == Some(0) => true,
        Value::Array(arr) if arr.is_empty() => true,
        _ => false,
    }
}

pub fn stored_meta(e: Option<&Value>) -> Map<String, Value> {
    let m = normalize_meta(e);
    let mut out = Map::new();
    for &k in META_FIELDS {
        if let Some(v) = m.get(k) {
            if !is_default(k, v) {
                out.insert(k.to_string(), v.clone());
            }
        }
    }
    out
}

pub fn normalize_document_meta(e: Option<&Value>) -> Map<String, Value> {
    let m = normalize_meta(e);
    let mut out = Map::new();
    for &k in DOCUMENT_META_FIELDS {
        if let Some(v) = m.get(k) {
            out.insert(k.to_string(), v.clone());
        }
    }
    out
}

pub fn stored_document_meta(e: Option<&Value>) -> Map<String, Value> {
    let m = normalize_document_meta(e);
    let mut out = Map::new();
    for &k in DOCUMENT_META_FIELDS {
        if let Some(v) = m.get(k) {
            if !is_default(k, v) {
                out.insert(k.to_string(), v.clone());
            }
        }
    }
    out
}

pub fn check_meta_patch(k: &str, v: &Value) -> Option<&'static str> {
    match k {
        "episodeType" => {
            if let Some(n) = v.as_i64() {
                if EPISODE_TYPES.contains(&n) {
                    return None;
                }
            }
            Some("잘못된 유형")
        }
        "description" | "authorComment" => {
            if v.is_string() {
                None
            } else {
                Some("속성 값은 문자열이어야 합니다.")
            }
        }
        "tags" => {
            if let Some(arr) = v.as_array() {
                if arr.iter().all(|t| t.is_string()) {
                    return None;
                }
            }
            Some("태그는 문자열 목록이어야 합니다.")
        }
        "contentRestrictionLevel" => {
            if v.is_null()
                || v.as_str()
                    .is_some_and(|s| RESTRICTION_LEVELS.contains(&s))
            {
                None
            } else {
                Some("잘못된 수위")
            }
        }
        "pointOfView" => {
            if v.is_null() || v.as_str().is_some_and(|s| POINTS_OF_VIEW.contains(&s)) {
                None
            } else {
                Some("잘못된 시점")
            }
        }
        "manualLineBreak" => {
            if v.is_boolean() {
                None
            } else {
                Some("줄바꿈 방식은 true나 false여야 합니다.")
            }
        }
        _ => None,
    }
}

pub fn line_break_default(project: Option<&Value>, common: bool) -> bool {
    if let Some(b) = project
        .and_then(|p| p.get("manualLineBreak"))
        .and_then(|v| v.as_bool())
    {
        b
    } else {
        common
    }
}
