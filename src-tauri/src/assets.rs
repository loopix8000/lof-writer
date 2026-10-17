use crate::error::{fail_invalid, hash_bytes, utf16_len, LofError};
use crate::store::atomic_write_bytes;
use base64::Engine;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
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

// 원고에 넣는 이미지. 작품 폴더의 assets/에 저장하고, 원고에는 Markdown 이미지 문법으로 경로를 남긴다.
pub const IMAGE_LIMIT: u64 = 20_000_000;

// 파일 머리로 이미지 형식을 확인한다. 확장자보다 실제 내용을 믿는다.
pub fn image_ext(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some("png")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("gif")
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn image_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "image/webp",
    }
}

// Markdown 경로에 그대로 쓸 수 있게 글자·숫자·'-'·'_'만 남긴 파일 이름.
fn image_stem(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let mut out = String::new();
    for c in stem.nfc() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(60).collect();
    if out.is_empty() {
        "image".to_string()
    } else {
        out
    }
}

// assets/에 이미지를 저장하고 작품 폴더 기준 경로(assets/이름.확장자)를 돌려준다.
// 같은 이름이 있으면 번호를 붙이고, 내용까지 같은 파일이 이미 있으면 그 파일을 쓴다.
pub fn save_image(project_dir: &Path, name: &str, data: &[u8]) -> Result<String, LofError> {
    if data.len() as u64 > IMAGE_LIMIT {
        return Err(fail_invalid("이미지는 20MB 이하만 넣을 수 있습니다."));
    }
    let ext = image_ext(data)
        .ok_or_else(|| fail_invalid("PNG, JPEG, GIF, WebP 이미지만 넣을 수 있습니다."))?;
    let dir = project_dir.join("assets");
    fs::create_dir_all(&dir)?;
    let stem = image_stem(name);
    for n in 0..10_000 {
        let file = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let path = dir.join(&file);
        match fs::read(&path) {
            Ok(old) if old == data => return Ok(format!("assets/{file}")),
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                atomic_write_bytes(&path, data)?;
                return Ok(format!("assets/{file}"));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(fail_invalid("이미지 이름을 정할 수 없습니다."))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

// 작품 폴더 안의 상대 경로로 정리한다. 폴더 밖으로 나가는 경로는 받지 않는다.
fn normalize_rel(path: &str) -> Option<PathBuf> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p if p.contains(':') => return None,
            p => parts.push(p),
        }
    }
    (!parts.is_empty()).then(|| parts.iter().collect())
}

// 원고의 이미지 경로를 화면에 그릴 data URL로 읽는다. 원고 파일 기준 상대 경로를 먼저 찾고,
// 문서가 다른 폴더로 옮겨져 경로가 어긋났으면 경로의 assets/ 뒷부분으로 작품의 assets/에서 찾는다.
pub fn image_data_url(project_dir: &Path, doc_rel: &str, src: &str) -> Result<Value, LofError> {
    let src = percent_decode(src.trim());
    if src.is_empty() || src.contains("://") || src.starts_with('/') || src.starts_with('\\') {
        return Ok(Value::Null);
    }
    let doc_dir = doc_rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut candidates = Vec::new();
    if let Some(rel) = normalize_rel(&format!("{doc_dir}/{src}")) {
        candidates.push(rel);
    }
    let unified = src.replace('\\', "/");
    if let Some(at) = unified.rfind("assets/") {
        if let Some(rel) = normalize_rel(&unified[at..]) {
            candidates.push(rel);
        }
    }
    for rel in candidates {
        let file = project_dir.join(rel);
        let Ok(meta) = fs::metadata(&file) else { continue };
        if !meta.is_file() || meta.len() > IMAGE_LIMIT {
            continue;
        }
        let bytes = fs::read(&file)?;
        let Some(ext) = image_ext(&bytes) else { continue };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(Value::String(format!("data:{};base64,{}", image_mime(ext), b64)));
    }
    Ok(Value::Null)
}
