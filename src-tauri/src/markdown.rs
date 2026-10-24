use crate::episode::{
    check_meta_patch, normalize_document_meta, normalize_meta, normalize_status_val,
    DOCUMENT_META_FIELDS, META_FIELDS,
};
use crate::error::{fail, slice_utf16, valid_id, LofError};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

const COMMON_FIELDS: &[&str] = &[
    "lof",
    "id",
    "kind",
    "title",
    "tags",
    "manualLineBreak",
    "bookmarks",
    "episodeId",
    "archived",
    "createdAt",
    "updatedAt",
    "conflictOf",
];

fn format_error(msg: impl Into<String>) -> LofError {
    fail(
        format!("Markdown 속성을 읽을 수 없습니다: {}", msg.into()),
        "FORMAT",
    )
}

#[derive(Debug, Clone)]
pub struct ParsedMarkdown {
    pub body: String,
    pub properties: Map<String, Value>,
    pub has_properties: bool,
    pub prefix: String,
    pub raw_yaml: String,
}

fn yaml_to_json(v: serde_yaml::Value) -> Result<Value, LofError> {
    match v {
        serde_yaml::Value::Null => Ok(Value::Null),
        serde_yaml::Value::Bool(b) => Ok(Value::Bool(b)),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(json!(i))
            } else if let Some(u) = n.as_u64() {
                Ok(json!(u))
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() {
                    Ok(json!(f))
                } else {
                    Err(format_error("유효하지 않은 숫자 속성입니다."))
                }
            } else {
                Err(format_error("유효하지 않은 숫자 속성입니다."))
            }
        }
        serde_yaml::Value::String(s) => Ok(Value::String(s)),
        serde_yaml::Value::Sequence(seq) => {
            let mut arr = Vec::with_capacity(seq.len());
            for item in seq {
                arr.push(yaml_to_json(item)?);
            }
            Ok(Value::Array(arr))
        }
        serde_yaml::Value::Mapping(map) => {
            let mut obj = Map::new();
            let mut seen = HashSet::new();
            for (k, val) in map {
                let key_str = match k {
                    serde_yaml::Value::String(s) => s,
                    serde_yaml::Value::Number(n) => n.to_string(),
                    serde_yaml::Value::Bool(b) => b.to_string(),
                    _ => return Err(format_error("속성 키는 문자열이어야 합니다.")),
                };
                if !seen.insert(key_str.clone()) {
                    return Err(format_error("중복된 속성 키가 있습니다."));
                }
                obj.insert(key_str, yaml_to_json(val)?);
            }
            Ok(Value::Object(obj))
        }
        serde_yaml::Value::Tagged(tagged) => yaml_to_json(tagged.value),
    }
}

pub fn read_markdown(raw: &str) -> Result<ParsedMarkdown, LofError> {
    let source = raw.strip_prefix('\u{feff}').unwrap_or(raw);

    static START_RE: OnceLock<Regex> = OnceLock::new();
    let start_re = START_RE.get_or_init(|| Regex::new(r"^---[ \t]*\r?\n").unwrap());

    let Some(start_match) = start_re.find(source) else {
        return Ok(ParsedMarkdown {
            body: source.to_string(),
            properties: Map::new(),
            has_properties: false,
            prefix: String::new(),
            raw_yaml: String::new(),
        });
    };

    let rest = &source[start_match.end()..];
    static END_RE: OnceLock<Regex> = OnceLock::new();
    let end_re = END_RE.get_or_init(|| Regex::new(r"(?m)^---[ \t]*(?:\r?\n|$)").unwrap());
    static LOOKS_RE: OnceLock<Regex> = OnceLock::new();
    let looks_re =
        LOOKS_RE.get_or_init(|| Regex::new(r#"^\s*(?:[\w-]+|"[^"\n]+"|'[^'\n]+')\s*:"#).unwrap());
    let looks_like_properties = looks_re.is_match(rest);

    let Some(end_match) = end_re.find(rest) else {
        if looks_like_properties {
            return Err(format_error("속성 영역을 닫는 ---가 없습니다."));
        }
        return Ok(ParsedMarkdown {
            body: source.to_string(),
            properties: Map::new(),
            has_properties: false,
            prefix: String::new(),
            raw_yaml: String::new(),
        });
    };

    let yaml_slice = &rest[..end_match.start()];
    let parsed_yaml: serde_yaml::Value = match serde_yaml::from_str(yaml_slice) {
        Ok(v) => v,
        Err(e) => {
            if looks_like_properties {
                return Err(format_error(e.to_string()));
            }
            return Ok(ParsedMarkdown {
                body: source.to_string(),
                properties: Map::new(),
                has_properties: false,
                prefix: String::new(),
                raw_yaml: String::new(),
            });
        }
    };

    let json_val = match yaml_to_json(parsed_yaml) {
        Ok(v) => v,
        Err(e) => {
            if looks_like_properties {
                return Err(e);
            }
            return Ok(ParsedMarkdown {
                body: source.to_string(),
                properties: Map::new(),
                has_properties: false,
                prefix: String::new(),
                raw_yaml: String::new(),
            });
        }
    };

    let properties = match json_val {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        _ => {
            return Ok(ParsedMarkdown {
                body: source.to_string(),
                properties: Map::new(),
                has_properties: false,
                prefix: String::new(),
                raw_yaml: String::new(),
            });
        }
    };

    let offset = start_match.end() + end_match.end();
    let prefix_len = (raw.len() - source.len()) + offset;
    Ok(ParsedMarkdown {
        body: source[offset..].to_string(),
        properties,
        has_properties: true,
        prefix: raw[..prefix_len].to_string(),
        raw_yaml: yaml_slice.to_string(),
    })
}

fn extras_of(properties: &Map<String, Value>, kind: &str) -> Map<String, Value> {
    let mut managed: HashSet<&str> = COMMON_FIELDS.iter().copied().collect();
    if kind == "episode" {
        managed.insert("order");
        managed.insert("status");
        for &f in META_FIELDS {
            managed.insert(f);
        }
    }
    let mut out = Map::new();
    for (k, v) in properties {
        if !managed.contains(k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

// 색인에 이미 메타데이터가 검증·보관된 원고는 YAML을 다시 해석하지 않고 본문만 바로 잘라낸다.
pub fn read_markdown_body(raw: &str, has_frontmatter: bool) -> Result<String, LofError> {
    let source = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if !has_frontmatter {
        return Ok(source.to_string());
    }
    static START_RE: OnceLock<Regex> = OnceLock::new();
    let start_re = START_RE.get_or_init(|| Regex::new(r"^---[ \t]*\r?\n").unwrap());
    static END_RE: OnceLock<Regex> = OnceLock::new();
    let end_re = END_RE.get_or_init(|| Regex::new(r"(?m)^---[ \t]*(?:\r?\n|$)").unwrap());
    if let Some(start_match) = start_re.find(source) {
        let rest = &source[start_match.end()..];
        if let Some(end_match) = end_re.find(rest) {
            return Ok(source[start_match.end() + end_match.end()..].to_string());
        }
    }
    Ok(read_markdown(raw)?.body)
}

pub fn markdown_entry(raw: &str, fallback: &Value) -> Result<Value, LofError> {
    let parsed = read_markdown(raw)?;
    markdown_entry_with_parsed(&parsed, fallback)
}

pub fn markdown_entry_with_parsed(parsed: &ParsedMarkdown, fallback: &Value) -> Result<Value, LofError> {
    let fb_obj = fallback.as_object().cloned().unwrap_or_default();

    let mut source = Map::new();
    if parsed.has_properties {
        let is_lof_1 = parsed.properties.get("lof").and_then(|v| v.as_i64()) == Some(1);
        let is_md = fb_obj.get("_markdown").and_then(|v| v.as_bool()) == Some(true);
        if !is_lof_1 && !is_md {
            for (k, v) in &fb_obj {
                source.insert(k.clone(), v.clone());
            }
        }
        for (k, v) in &parsed.properties {
            source.insert(k.clone(), v.clone());
        }
    } else {
        source = fb_obj.clone();
    }

    let episode = fb_obj.get("kind").and_then(|v| v.as_str()) == Some("episode");
    let fields = &parsed.properties;

    if let Some(id_val) = fields.get("id") {
        let Some(id_str) = id_val.as_str() else {
            return Err(format_error(
                "id는 1~80자의 영문·숫자·하이픈·밑줄이어야 합니다.",
            ));
        };
        if !valid_id(id_str) {
            return Err(format_error(
                "id는 1~80자의 영문·숫자·하이픈·밑줄이어야 합니다.",
            ));
        }
    }
    if let Some(order_val) = fields.get("order") {
        if episode && !order_val.is_number() {
            return Err(format_error("order는 숫자여야 합니다."));
        }
    }
    if let Some(title_val) = fields.get("title") {
        if !title_val.is_string() {
            return Err(format_error("title은 문자열이어야 합니다."));
        }
    }
    if let Some(arch_val) = fields.get("archived") {
        if !arch_val.is_boolean() {
            return Err(format_error("archived는 true나 false여야 합니다."));
        }
    }
    if let Some(ep_id_val) = fields.get("episodeId") {
        if !ep_id_val.is_null() && !ep_id_val.is_string() {
            return Err(format_error("episodeId는 회차 ID 또는 null이어야 합니다."));
        }
    }
    if let Some(kind_val) = fields.get("kind") {
        let k_str = kind_val.as_str().unwrap_or("");
        if episode {
            if k_str != "episode" {
                return Err(format_error(
                    "회차와 메모·플롯 사이의 유형 전환은 지원하지 않습니다.",
                ));
            }
        } else if k_str != "plot" && k_str != "memo" {
            return Err(format_error(
                "회차와 메모·플롯 사이의 유형 전환은 지원하지 않습니다.",
            ));
        }
    }

    let check_fields = if episode {
        META_FIELDS
    } else {
        DOCUMENT_META_FIELDS
    };
    for &key in check_fields {
        if let Some(val) = fields.get(key) {
            if let Some(problem) = check_meta_patch(key, val) {
                return Err(format_error(format!("{}: {}", key, problem)));
            }
        }
    }

    let mut out = fb_obj.clone();
    if let Some(id_str) = fields.get("id").and_then(|v| v.as_str()) {
        if !id_str.is_empty() {
            out.insert("id".to_string(), json!(id_str));
        }
    }
    let order = if episode {
        fields
            .get("order")
            .and_then(|v| v.as_f64())
            .or_else(|| fb_obj.get("order").and_then(|v| v.as_f64()))
            .unwrap_or(0.0)
    } else {
        fb_obj
            .get("order")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
    };
    if order.fract() == 0.0 {
        out.insert("order".to_string(), json!(order as i64));
    } else {
        out.insert("order".to_string(), json!(order));
    }

    let kind = if episode {
        "episode"
    } else {
        let k = source
            .get("kind")
            .or_else(|| source.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("memo");
        if k == "plot" {
            "plot"
        } else {
            "memo"
        }
    };
    out.insert("kind".to_string(), json!(kind));

    let title = if let Some(s) = source.get("title").and_then(|v| v.as_str()) {
        slice_utf16(s, 300)
    } else {
        fb_obj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    out.insert("title".to_string(), json!(title));
    out.insert(
        "status".to_string(),
        json!(normalize_status_val(source.get("status"))),
    );

    let source_val = Value::Object(source.clone());
    let meta_map = if episode {
        normalize_meta(Some(&source_val))
    } else {
        normalize_document_meta(Some(&source_val))
    };
    for (k, v) in meta_map {
        out.insert(k, v);
    }

    let archived = source
        .get("archived")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    out.insert("archived".to_string(), json!(archived));

    if let Some(ep_id) = source
        .get("episodeId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        out.insert("episodeId".to_string(), json!(ep_id));
    } else {
        out.remove("episodeId");
    }

    if let Some(co) = source
        .get("conflictOf")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        out.insert("conflictOf".to_string(), json!(co));
    } else {
        out.remove("conflictOf");
    }

    if let Some(ca) = source
        .get("createdAt")
        .and_then(|v| v.as_str())
        .or_else(|| fb_obj.get("createdAt").and_then(|v| v.as_str()))
    {
        out.insert("createdAt".to_string(), json!(ca));
    }
    if let Some(ua) = source
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .or_else(|| fb_obj.get("updatedAt").and_then(|v| v.as_str()))
    {
        out.insert("updatedAt".to_string(), json!(ua));
    }

    let mut properties = extras_of(&parsed.properties, if episode { "episode" } else { "memo" });
    for key in ["contentRestrictionLevel", "pointOfView"] {
        if let Some(value) = source.get(key).filter(|v| !v.is_null()) {
            properties.entry(key.to_string()).or_insert_with(|| value.clone());
        }
        let custom_icon = properties.get("_lofPropertyIcons")
            .and_then(|v| v.as_object()).is_some_and(|icons| icons.contains_key(key));
        if properties.get(key).is_some_and(|v| v.is_null()) && !custom_icon {
            properties.remove(key);
        }
        out.remove(key);
    }
    out.insert("properties".to_string(), Value::Object(properties));

    Ok(Value::Object(out))
}

pub fn document_properties(doc: &Value) -> Map<String, Value> {
    let obj = doc.as_object().cloned().unwrap_or_default();
    let mut out = Map::new();
    if let Some(props) = obj.get("properties").and_then(|v| v.as_object()) {
        for (k, v) in props {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("lof".to_string(), json!(1));
    if let Some(id) = obj.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("id".to_string(), json!(id));
    }
    let kind = obj
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("episode");
    out.insert("kind".to_string(), json!(kind));
    out.insert(
        "title".to_string(),
        json!(obj.get("title").and_then(|v| v.as_str()).unwrap_or("")),
    );
    if kind == "episode" {
        out.insert(
            "status".to_string(),
            json!(normalize_status_val(obj.get("status"))),
        );
        for (k, v) in normalize_meta(Some(doc)) {
            out.insert(k, v);
        }
        let order = obj.get("order").cloned().unwrap_or(json!(0));
        out.insert("order".to_string(), order);
    } else {
        for (k, v) in normalize_document_meta(Some(doc)) {
            out.insert(k, v);
        }
    }
    // 북마크가 없으면 파일 머리에 빈 목록을 남기지 않는다.
    if out
        .get("bookmarks")
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.is_empty())
    {
        out.remove("bookmarks");
    }
    let ep_id = if kind != "episode" {
        obj.get("episodeId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    out.insert("episodeId".to_string(), ep_id);
    out.insert(
        "archived".to_string(),
        json!(obj.get("archived").and_then(|v| v.as_bool()).unwrap_or(false)),
    );
    if let Some(ca) = obj.get("createdAt").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("createdAt".to_string(), json!(ca));
    }
    if let Some(ua) = obj.get("updatedAt").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("updatedAt".to_string(), json!(ua));
    }
    if let Some(co) = obj.get("conflictOf").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("conflictOf".to_string(), json!(co));
    }
    out
}

pub fn write_markdown(body: &str, doc: &Value, previous_raw: &str) -> Result<String, LofError> {
    let parsed = read_markdown(previous_raw)?;
    let doc_obj = doc.as_object();
    let has_explicit_props = doc_obj.is_some_and(|o| o.contains_key("properties"));
    let mut properties = if has_explicit_props {
        document_properties(doc)
    } else {
        let kind = doc
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("episode");
        let mut base = extras_of(&parsed.properties, kind);
        for (k, v) in document_properties(doc) {
            base.insert(k, v);
        }
        base
    };
    // Ensure consistent key order if previous_raw had keys
    if parsed.has_properties {
        let mut ordered = Map::new();
        for k in parsed.properties.keys() {
            if let Some(v) = properties.remove(k) {
                ordered.insert(k.clone(), v);
            }
        }
        for (k, v) in properties {
            ordered.insert(k, v);
        }
        properties = ordered;
    }
    write_properties_with_parsed(body, &properties, previous_raw, &parsed)
}

fn format_yaml_key(k: &str) -> String {
    serde_json::to_string(k).unwrap_or_else(|_| format!("\"{}\"", k))
}

fn format_yaml_value(v: &Value, indent: usize, eol: &str) -> String {
    let pad = " ".repeat(indent);
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s)),
        Value::Array(arr) => {
            if arr.is_empty() {
                "[]".to_string()
            } else {
                let mut lines = Vec::with_capacity(arr.len());
                for item in arr {
                    match item {
                        Value::Object(_) | Value::Array(_) => {
                            let nested = format_yaml_value(item, indent + 2, eol);
                            lines.push(format!("{}- {}", pad, nested.trim_start()));
                        }
                        _ => {
                            lines.push(format!(
                                "{}- {}",
                                pad,
                                format_yaml_value(item, indent + 2, eol)
                            ));
                        }
                    }
                }
                format!("{}{}", eol, lines.join(eol))
            }
        }
        Value::Object(map) => {
            if map.is_empty() {
                "{}".to_string()
            } else {
                let mut lines = Vec::with_capacity(map.len());
                for (k, child) in map {
                    let key_str = format_yaml_key(k);
                    match child {
                        Value::Array(a) if !a.is_empty() => {
                            lines.push(format!(
                                "{}{}:{}",
                                pad,
                                key_str,
                                format_yaml_value(child, indent + 2, eol)
                            ));
                        }
                        Value::Object(m) if !m.is_empty() => {
                            lines.push(format!(
                                "{}{}:{}",
                                pad,
                                key_str,
                                format_yaml_value(child, indent + 2, eol)
                            ));
                        }
                        _ => {
                            lines.push(format!(
                                "{}{}: {}",
                                pad,
                                key_str,
                                format_yaml_value(child, indent + 2, eol)
                            ));
                        }
                    }
                }
                format!("{}{}", eol, lines.join(eol))
            }
        }
    }
}

pub fn write_properties(
    body: &str,
    properties: &Map<String, Value>,
    previous_raw: &str,
) -> Result<String, LofError> {
    let parsed = read_markdown(previous_raw)?;
    write_properties_with_parsed(body, properties, previous_raw, &parsed)
}

fn write_properties_with_parsed(
    body: &str,
    properties: &Map<String, Value>,
    previous_raw: &str,
    parsed: &ParsedMarkdown,
) -> Result<String, LofError> {
    if parsed.has_properties && &parsed.properties == properties {
        return Ok(format!("{}{}", parsed.prefix, body));
    }

    let eol = if parsed.prefix.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let bom = if previous_raw.starts_with('\u{feff}') {
        "\u{feff}"
    } else {
        ""
    };

    // Preserve top-level comments from previous YAML if present
    let mut header_comments = Vec::new();
    if parsed.has_properties {
        for line in parsed.raw_yaml.lines() {
            if line.trim_start().starts_with('#') {
                header_comments.push(line.to_string());
            } else {
                break;
            }
        }
    }

    let mut lines = Vec::new();
    for c in header_comments {
        lines.push(c);
    }

    let mut ordered_keys: Vec<&String> = Vec::new();
    if parsed.has_properties {
        for k in parsed.properties.keys() {
            if properties.contains_key(k) {
                ordered_keys.push(k);
            }
        }
    }
    for k in properties.keys() {
        if !ordered_keys.contains(&k) {
            ordered_keys.push(k);
        }
    }

    for k in ordered_keys {
        let v = &properties[k];
        let key_str = format_yaml_key(k);
        match v {
            Value::Array(a) if !a.is_empty() => {
                lines.push(format!("{}:{}", key_str, format_yaml_value(v, 2, eol)));
            }
            Value::Object(m) if !m.is_empty() => {
                lines.push(format!("{}:{}", key_str, format_yaml_value(v, 2, eol)));
            }
            _ => {
                lines.push(format!("{}: {}", key_str, format_yaml_value(v, 2, eol)));
            }
        }
    }

    let yaml_content = if lines.is_empty() {
        format!("{{}}{}", eol)
    } else {
        format!("{}{}", lines.join(eol), eol)
    };

    Ok(format!("{}---{}{}---{}{}", bom, eol, yaml_content, eol, body))
}
