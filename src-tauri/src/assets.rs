use crate::error::{fail_invalid, hash_bytes, utf16_len, LofError};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

pub fn normalize_tags(value: Option<&Value>) -> Result<Vec<String>, LofError> {
    let arr = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        _ => return Err(fail_invalid("태그는 문자열 목록이어야 합니다.")),
    };
    if arr.iter().any(|t| !t.is_string()) {
        return Err(fail_invalid("태그는 문자열 목록이어야 합니다."));
    }
    let mut tags: Vec<String> = Vec::new();
    for item in arr {
        let s = item.as_str().unwrap_or("");
        let nfc: String = s.nfc().collect();
        let trimmed = nfc.trim().trim_start_matches('#').to_string();
        if !trimmed.is_empty() && !tags.contains(&trimmed) {
            tags.push(trimmed);
        }
    }
    if tags.len() > 30
        || tags
            .iter()
            .any(|t| utf16_len(t) > 40 || t.chars().any(|c| c == '\r' || c == '\n' || c == '\0'))
    {
        return Err(fail_invalid(
            "태그는 30개까지, 각 40자까지 입력할 수 있습니다.",
        ));
    }
    Ok(tags)
}

pub fn valid_cover(name: Option<&str>) -> bool {
    let Some(s) = name else { return false };
    s.starts_with("cover-")
        && s.ends_with(".png")
        && s.len() == 74
        && s[6..70]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn validate_cover(data: &[u8], name: Option<&str>) -> Result<String, LofError> {
    const PNG_MAGIC: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    if data.len() > 8_000_000 || !data.starts_with(&PNG_MAGIC) {
        return Err(fail_invalid("표지는 8MB 이하의 PNG여야 합니다."));
    }
    let filename = format!("cover-{}.png", hash_bytes(data));
    if let Some(expected) = name {
        if expected != filename {
            return Err(fail_invalid("표지 체크섬이 일치하지 않습니다."));
        }
    }
    Ok(filename)
}
