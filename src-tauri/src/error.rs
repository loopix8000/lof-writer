use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct LofError {
    pub message: String,
    pub code: String,
}

impl fmt::Display for LofError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for LofError {}

impl From<std::io::Error> for LofError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::AlreadyExists => "EEXIST",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "IO_ERROR",
        };
        LofError {
            message: e.to_string(),
            code: code.to_string(),
        }
    }
}

pub fn fail(message: impl Into<String>, code: impl Into<String>) -> LofError {
    LofError {
        message: message.into(),
        code: code.into(),
    }
}

pub fn fail_invalid(message: impl Into<String>) -> LofError {
    fail(message, "INVALID")
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn valid_id_val(val: Option<&serde_json::Value>) -> bool {
    val.and_then(|v| v.as_str()).is_some_and(valid_id)
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn hash_str(text: &str) -> String {
    hash_bytes(text.as_bytes())
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn sys_time_to_iso(time: SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn slice_utf16(s: &str, max: usize) -> String {
    let mut units = 0;
    let mut end_byte = 0;
    for ch in s.chars() {
        let len16 = ch.len_utf16();
        if units + len16 > max {
            break;
        }
        units += len16;
        end_byte += ch.len_utf8();
    }
    s[..end_byte].to_string()
}

pub fn slice_utf16_range(s: &str, start_u16: usize, end_u16: usize) -> String {
    let mut out: Vec<u16> = Vec::new();
    for (i, u) in s.encode_utf16().enumerate() {
        if i >= end_u16 {
            break;
        }
        if i >= start_u16 {
            out.push(u);
        }
    }
    String::from_utf16_lossy(&out)
}
