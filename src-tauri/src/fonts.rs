use crate::error::{fail_invalid, hash_bytes, LofError};
use crate::store::{atomic_write_bytes, atomic_write_str};
use base64::Engine;
use flate2::read::ZlibDecoder;
#[cfg(not(target_os = "android"))]
use rfd::FileDialog;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use unicode_normalization::UnicodeNormalization;

pub const FONT_FILE_LIMIT: u64 = 50_000_000;

static SYSTEM_FONTS_CACHE: OnceLock<Mutex<Option<Vec<Value>>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct ParsedFace {
    pub family_ko: Option<String>,
    pub family_en: Option<String>,
    pub weight: u16,
    pub italic: bool,
    pub variable: bool,
}

pub fn font_format(data: &[u8]) -> Option<(&'static str, &'static str, &'static str)> {
    if data.len() < 12 {
        return None;
    }
    match &data[0..4] {
        [0x00, 0x01, 0x00, 0x00] | b"true" | b"typ1" => Some(("ttf", "truetype", "font/ttf")),
        b"OTTO" => Some(("otf", "opentype", "font/otf")),
        b"wOFF" => Some(("woff", "woff", "font/woff")),
        b"wOF2" => Some(("woff2", "woff2", "font/woff2")),
        b"ttcf" => Some(("ttc", "truetype", "font/collection")),
        _ => None,
    }
}

pub fn valid_font_filename(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("font-") else {
        return false;
    };
    let Some((hash, ext)) = rest.split_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(ext, "ttf" | "otf" | "woff" | "woff2" | "ttc")
}

fn clean_font_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .nfc()
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('@')
        || trimmed.starts_with('.')
        || trimmed.len() > 120
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn strip_style_suffix(family: &str, subfamily: Option<&str>) -> String {
    let trimmed = family.trim();
    if let Some(sub) = subfamily.map(str::trim).filter(|s| !s.is_empty()) {
        if trimmed.len() > sub.len() + 1 {
            let candidate = &trimmed[..trimmed.len() - sub.len()];
            if candidate.ends_with(' ') || candidate.ends_with('-') || candidate.ends_with('_') {
                let tail = &trimmed[trimmed.len() - sub.len()..];
                if tail.eq_ignore_ascii_case(sub) {
                    let stripped = candidate.trim_end_matches([' ', '-', '_']).trim();
                    if !stripped.is_empty() {
                        return stripped.to_string();
                    }
                }
            }
        }
    }
    const SUFFIXES: &[&str] = &[
        " ExtraLight Italic",
        " ExtraBold Italic",
        " SemiBold Italic",
        " SemiLight Italic",
        " DemiLight Italic",
        " UltraLight",
        " ExtraLight",
        " SemiLight",
        " DemiLight",
        " ExtraBold",
        " SemiBold",
        " DemiBold",
        " Regular",
        " Medium",
        " Normal",
        " Italic",
        " Light",
        " Heavy",
        " Black",
        " Thin",
        " Bold",
        " Book",
    ];
    for suffix in SUFFIXES {
        if trimmed.len() > suffix.len()
            && trimmed[trimmed.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        {
            let base = trimmed[..trimmed.len() - suffix.len()].trim();
            if !base.is_empty() {
                return base.to_string();
            }
        }
    }
    trimmed.to_string()
}

fn decode_utf16_be(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2 || bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    clean_font_name(&String::from_utf16_lossy(&units))
}

fn decode_mac_roman(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.iter().any(|&b| !(0x20..=0x7E).contains(&b)) {
        return None;
    }
    let s = std::str::from_utf8(bytes).ok()?;
    clean_font_name(s)
}

fn parse_name_table(data: &[u8]) -> (Option<String>, Option<String>) {
    if data.len() < 6 {
        return (None, None);
    }
    let count = u16::from_be_bytes([data[2], data[3]]) as usize;
    let storage_offset = u16::from_be_bytes([data[4], data[5]]) as usize;
    if count > 2000 || 6 + count * 12 > data.len() || storage_offset > data.len() {
        return (None, None);
    }

    let mut ko_16: Option<String> = None;
    let mut ko_1: Option<String> = None;
    let mut ko_2: Option<String> = None;
    let mut en_16: Option<String> = None;
    let mut en_1: Option<String> = None;
    let mut en_2: Option<String> = None;
    let mut any_16: Option<String> = None;
    let mut any_1: Option<String> = None;

    for i in 0..count {
        let rec = &data[6 + i * 12..6 + (i + 1) * 12];
        let platform_id = u16::from_be_bytes([rec[0], rec[1]]);
        let encoding_id = u16::from_be_bytes([rec[2], rec[3]]);
        let language_id = u16::from_be_bytes([rec[4], rec[5]]);
        let name_id = u16::from_be_bytes([rec[6], rec[7]]);
        if !matches!(name_id, 1 | 2 | 16) {
            continue;
        }
        let length = u16::from_be_bytes([rec[8], rec[9]]) as usize;
        let offset = u16::from_be_bytes([rec[10], rec[11]]) as usize;
        let Some(start) = storage_offset.checked_add(offset) else {
            continue;
        };
        let Some(end) = start.checked_add(length) else {
            continue;
        };
        if end > data.len() {
            continue;
        }
        let slice = &data[start..end];

        let decoded = match (platform_id, encoding_id) {
            (3, 1) | (3, 10) | (0, _) => decode_utf16_be(slice),
            (1, 0) if language_id == 0 => decode_mac_roman(slice),
            _ => None,
        };
        let Some(text) = decoded else {
            continue;
        };

        let is_ko = platform_id == 3 && language_id == 0x0412;
        let is_en = (platform_id == 3 && (language_id == 0x0409 || language_id == 0))
            || platform_id == 0
            || (platform_id == 1 && encoding_id == 0 && language_id == 0);

        match name_id {
            16 => {
                if is_ko && ko_16.is_none() {
                    ko_16 = Some(text);
                } else if is_en && en_16.is_none() {
                    en_16 = Some(text);
                } else if any_16.is_none() {
                    any_16 = Some(text);
                }
            }
            1 => {
                if is_ko && ko_1.is_none() {
                    ko_1 = Some(text);
                } else if is_en && en_1.is_none() {
                    en_1 = Some(text);
                } else if any_1.is_none() {
                    any_1 = Some(text);
                }
            }
            2 => {
                if is_ko && ko_2.is_none() {
                    ko_2 = Some(text);
                } else if is_en && en_2.is_none() {
                    en_2 = Some(text);
                }
            }
            _ => {}
        }
    }

    let family_ko = ko_16.or_else(|| {
        ko_1.map(|f| strip_style_suffix(&f, ko_2.as_deref().or(en_2.as_deref())))
    });
    let family_en = en_16
        .or_else(|| en_1.map(|f| strip_style_suffix(&f, en_2.as_deref())))
        .or(any_16)
        .or_else(|| any_1.map(|f| strip_style_suffix(&f, en_2.as_deref())));

    (family_ko, family_en)
}

fn parse_os2_table(data: &[u8]) -> (u16, bool) {
    if data.len() < 6 {
        return (400, false);
    }
    let raw_weight = u16::from_be_bytes([data[4], data[5]]);
    let weight = if (100..=900).contains(&raw_weight) {
        (raw_weight / 100) * 100
    } else {
        400
    };
    let italic = if data.len() >= 64 {
        let fs_selection = u16::from_be_bytes([data[62], data[63]]);
        (fs_selection & 0x01) != 0 || (fs_selection & 0x200) != 0
    } else {
        false
    };
    (weight.clamp(100, 900), italic)
}

fn parse_sfnt_at<R: Read + Seek>(reader: &mut R, dir_offset: u64) -> Option<ParsedFace> {
    reader.seek(SeekFrom::Start(dir_offset)).ok()?;
    let mut header = [0u8; 12];
    reader.read_exact(&mut header).ok()?;
    if !matches!(
        &header[0..4],
        [0x00, 0x01, 0x00, 0x00] | b"OTTO" | b"true" | b"typ1"
    ) {
        return None;
    }
    let num_tables = u16::from_be_bytes([header[4], header[5]]) as usize;
    if num_tables == 0 || num_tables > 200 {
        return None;
    }
    let mut records = vec![0u8; num_tables * 16];
    reader.read_exact(&mut records).ok()?;

    let mut name_loc: Option<(u64, usize)> = None;
    let mut os2_loc: Option<(u64, usize)> = None;
    let mut variable = false;

    for chunk in records.chunks_exact(16) {
        let tag = &chunk[0..4];
        let offset = u32::from_be_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]) as u64;
        let length = u32::from_be_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]) as usize;
        match tag {
            b"name" if (6..=512_000).contains(&length) => name_loc = Some((offset, length)),
            b"OS/2" if (6..=4096).contains(&length) => os2_loc = Some((offset, length)),
            b"fvar" => variable = true,
            _ => {}
        }
    }

    let (offset, length) = name_loc?;
    reader.seek(SeekFrom::Start(offset)).ok()?;
    let mut name_buf = vec![0u8; length];
    reader.read_exact(&mut name_buf).ok()?;
    let (family_ko, family_en) = parse_name_table(&name_buf);
    if family_ko.is_none() && family_en.is_none() {
        return None;
    }

    let (weight, italic) = if let Some((os2_off, os2_len)) = os2_loc {
        let read_len = os2_len.min(64);
        let mut os2_buf = vec![0u8; read_len];
        if reader.seek(SeekFrom::Start(os2_off)).is_ok()
            && reader.read_exact(&mut os2_buf).is_ok()
        {
            parse_os2_table(&os2_buf)
        } else {
            (400, false)
        }
    } else {
        (400, false)
    };

    Some(ParsedFace {
        family_ko,
        family_en,
        weight,
        italic,
        variable,
    })
}

fn parse_faces_from_reader<R: Read + Seek>(reader: &mut R) -> Vec<ParsedFace> {
    if reader.seek(SeekFrom::Start(0)).is_err() {
        return Vec::new();
    }
    let mut magic = [0u8; 4];
    if reader.read_exact(&mut magic).is_err() {
        return Vec::new();
    }
    if &magic == b"ttcf" {
        let mut ttc_hdr = [0u8; 8];
        if reader.read_exact(&mut ttc_hdr).is_err() {
            return Vec::new();
        }
        let num_fonts =
            u32::from_be_bytes([ttc_hdr[4], ttc_hdr[5], ttc_hdr[6], ttc_hdr[7]]) as usize;
        if num_fonts == 0 || num_fonts > 64 {
            return Vec::new();
        }
        let mut offsets_buf = vec![0u8; num_fonts * 4];
        if reader.read_exact(&mut offsets_buf).is_err() {
            return Vec::new();
        }
        let offsets: Vec<u64> = offsets_buf
            .chunks_exact(4)
            .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]) as u64)
            .collect();
        let mut out = Vec::new();
        for off in offsets {
            if let Some(face) = parse_sfnt_at(reader, off) {
                out.push(face);
            }
        }
        return out;
    }
    parse_sfnt_at(reader, 0).into_iter().collect()
}

fn read_woff1_table(data: &[u8], offset: usize, comp_len: usize, orig_len: usize) -> Option<Vec<u8>> {
    if orig_len == 0 || orig_len > 512_000 {
        return None;
    }
    let end = offset.checked_add(comp_len)?;
    if end > data.len() {
        return None;
    }
    let slice = &data[offset..end];
    if comp_len == orig_len {
        return Some(slice.to_vec());
    }
    let decoder = ZlibDecoder::new(slice);
    let mut out = Vec::with_capacity(orig_len);
    decoder.take(512_000).read_to_end(&mut out).ok()?;
    Some(out)
}

fn parse_woff1_bytes(data: &[u8]) -> Option<ParsedFace> {
    if data.len() < 44 || &data[0..4] != b"wOFF" {
        return None;
    }
    let num_tables = u16::from_be_bytes([data[12], data[13]]) as usize;
    if num_tables == 0 || num_tables > 200 || 44 + num_tables * 20 > data.len() {
        return None;
    }
    let mut name_bytes: Option<Vec<u8>> = None;
    let mut os2_bytes: Option<Vec<u8>> = None;
    let mut variable = false;

    for i in 0..num_tables {
        let entry = &data[44 + i * 20..44 + (i + 1) * 20];
        let tag = &entry[0..4];
        let offset = u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]) as usize;
        let comp_len = u32::from_be_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
        let orig_len = u32::from_be_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
        match tag {
            b"name" => name_bytes = read_woff1_table(data, offset, comp_len, orig_len),
            b"OS/2" => os2_bytes = read_woff1_table(data, offset, comp_len, orig_len),
            b"fvar" => variable = true,
            _ => {}
        }
    }

    let (family_ko, family_en) = parse_name_table(&name_bytes?);
    if family_ko.is_none() && family_en.is_none() {
        return None;
    }
    let (weight, italic) = os2_bytes
        .as_deref()
        .map(parse_os2_table)
        .unwrap_or((400, false));

    Some(ParsedFace {
        family_ko,
        family_en,
        weight,
        italic,
        variable,
    })
}

fn infer_from_filename(file_name: &str) -> ParsedFace {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("사용자 글꼴");
    let lower = stem.to_ascii_lowercase();
    let variable = lower.contains("variable") || lower.contains("-vf") || lower.ends_with("vf");
    let italic = lower.contains("italic") || lower.contains("oblique");
    let weight = if lower.contains("thin") || lower.contains("hairline") {
        100
    } else if lower.contains("extralight") || lower.contains("ultralight") {
        200
    } else if lower.contains("light") || lower.contains("demilight") || lower.contains("semilight")
    {
        300
    } else if lower.contains("medium") {
        500
    } else if lower.contains("semibold") || lower.contains("demibold") {
        600
    } else if lower.contains("extrabold") || lower.contains("ultrabold") {
        800
    } else if lower.contains("black") || lower.contains("heavy") {
        900
    } else if lower.contains("bold") {
        700
    } else {
        400
    };

    let mut clean = stem.replace('_', " ");
    for token in [
        "-VariableFont_wght",
        "-VariableFont",
        "-Variable",
        "Variable",
        "-ExtraLight",
        "-UltraLight",
        "-SemiLight",
        "-DemiLight",
        "-ExtraBold",
        "-UltraBold",
        "-SemiBold",
        "-DemiBold",
        "-Regular",
        "-Medium",
        "-Italic",
        "-Light",
        "-Heavy",
        "-Black",
        "-Thin",
        "-Bold",
        "-Book",
        "-bRg",
        "-cBd",
        "-aLt",
        "-dEb",
        "-eHv",
    ] {
        if clean.len() > token.len()
            && clean[clean.len() - token.len()..].eq_ignore_ascii_case(token)
        {
            clean = clean[..clean.len() - token.len()].to_string();
            break;
        }
    }
    let family = clean_font_name(&clean).unwrap_or_else(|| "사용자 글꼴".to_string());
    let has_korean = family.chars().any(is_korean_char);
    ParsedFace {
        family_ko: has_korean.then(|| family.clone()),
        family_en: (!has_korean).then_some(family),
        weight,
        italic,
        variable,
    }
}

pub fn parse_font_bytes(data: &[u8], file_name: &str) -> ParsedFace {
    if data.starts_with(b"wOFF") {
        if let Some(face) = parse_woff1_bytes(data) {
            return face;
        }
    } else if !data.starts_with(b"wOF2") {
        let mut cursor = std::io::Cursor::new(data);
        if let Some(face) = parse_faces_from_reader(&mut cursor).into_iter().next() {
            return face;
        }
    }
    infer_from_filename(file_name)
}

fn is_korean_char(c: char) -> bool {
    matches!(
        c as u32,
        0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F
    )
}

fn css_quote(name: &str) -> String {
    let escaped: String = name
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '"' | '\\' => ' ',
            _ => c,
        })
        .collect();
    format!("\"{}\"", escaped.trim())
}

fn is_serif_family(label: &str, en: Option<&str>) -> bool {
    let combined = format!("{} {}", label, en.unwrap_or("")).to_ascii_lowercase();
    combined.contains("바탕")
        || combined.contains("명조")
        || combined.contains("부리")
        || combined.contains("궁서")
        || combined.contains("batang")
        || combined.contains("myeongjo")
        || combined.contains("myungjo")
        || combined.contains("buri")
        || (combined.contains("serif") && !combined.contains("sans"))
        || combined.contains("mincho")
        || combined.contains("song")
}

pub fn build_font_value(family: &str, family_en: Option<&str>) -> String {
    let mut parts = vec![css_quote(family)];
    if let Some(en) = family_en.filter(|e| !e.is_empty() && !e.eq_ignore_ascii_case(family)) {
        parts.push(css_quote(en));
    }
    if is_serif_family(family, family_en) {
        parts.push("\"바탕\"".to_string());
        parts.push("Batang".to_string());
        parts.push("serif".to_string());
    } else {
        parts.push("\"Malgun Gothic\"".to_string());
        parts.push("sans-serif".to_string());
    }
    parts.join(", ")
}

fn is_excluded_system_font(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "marlett"
            | "webdings"
            | "wingdings"
            | "wingdings 2"
            | "wingdings 3"
            | "symbol"
            | "segoe mdl2 assets"
            | "segoe fluent icons"
            | "hololens mdl2 assets"
            | "bookshelf symbol 7"
            | "ms outlook"
            | "ms reference specialty"
            | "mt extra"
            | "ridibatang"
            | "리디바탕"
            | "pretendard variable"
            | "noto sans kr"
    )
}

fn system_font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(windir) = std::env::var("WINDIR") {
            dirs.push(PathBuf::from(windir).join("Fonts"));
        } else {
            dirs.push(PathBuf::from(r"C:\Windows\Fonts"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(home).join("Library").join("Fonts"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/system/fonts"));
        dirs.push(PathBuf::from("/usr/share/fonts"));
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        if let Ok(home) = std::env::var("HOME") {
            let h = PathBuf::from(home);
            dirs.push(h.join(".local/share/fonts"));
            dirs.push(h.join(".fonts"));
        }
    }
    dirs
}

fn collect_font_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            collect_font_files(&path, depth + 1, out);
        } else if ft.is_file() {
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if matches!(
                ext.to_ascii_lowercase().as_str(),
                "ttf" | "otf" | "ttc"
            ) {
                out.push(path);
            }
        }
    }
}

pub fn list_system_fonts(refresh: bool) -> Vec<Value> {
    let cache = SYSTEM_FONTS_CACHE.get_or_init(|| Mutex::new(None));
    if !refresh {
        if let Ok(guard) = cache.lock() {
            if let Some(ref list) = *guard {
                return list.clone();
            }
        }
    }

    let mut files = Vec::new();
    for dir in system_font_dirs() {
        collect_font_files(&dir, 0, &mut files);
    }

    // 대표 패밀리 키(소문자) -> (표시 이름, 영문 패밀리 이름)
    let mut families: BTreeMap<String, (String, Option<String>)> = BTreeMap::new();

    for path in files {
        let Ok(mut file) = File::open(&path) else {
            continue;
        };
        for face in parse_faces_from_reader(&mut file) {
            let primary = face
                .family_ko
                .clone()
                .or_else(|| face.family_en.clone());
            let Some(family) = primary else {
                continue;
            };
            if is_excluded_system_font(&family)
                || face
                    .family_en
                    .as_deref()
                    .is_some_and(is_excluded_system_font)
            {
                continue;
            }
            let key = family.to_lowercase();
            let entry = families
                .entry(key)
                .or_insert_with(|| (family.clone(), face.family_en.clone()));
            if entry.1.is_none() && face.family_en.is_some() {
                entry.1 = face.family_en;
            }
        }
    }

    let mut list: Vec<(bool, String, Value)> = families
        .into_values()
        .map(|(family, family_en)| {
            let has_ko = family.chars().any(is_korean_char);
            let en = family_en.filter(|e| !e.eq_ignore_ascii_case(&family));
            let value = build_font_value(&family, en.as_deref());
            let item = json!({
                "label": family,
                "family": family,
                "familyEn": en,
                "value": value,
            });
            (has_ko, family, item)
        })
        .collect();

    // 한국어 이름이 있는 글꼴을 먼저 가나다순으로, 이어서 영문 글꼴을 알파벳순으로 정렬한다.
    list.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });

    let result: Vec<Value> = list.into_iter().map(|(_, _, item)| item).collect();
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(result.clone());
    }
    result
}

pub fn user_fonts_from_settings(settings: &Value) -> Vec<Value> {
    settings
        .get("preferences")
        .and_then(|p| p.get("userFonts"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn save_user_fonts(
    config_file: &Path,
    settings: &mut Value,
    user_fonts: Vec<Value>,
) -> Result<Value, LofError> {
    let mut prefs = settings
        .get("preferences")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    prefs.insert("userFonts".to_string(), Value::Array(user_fonts));
    let prefs_val = Value::Object(prefs);
    if let Some(obj) = settings.as_object_mut() {
        obj.insert("preferences".to_string(), prefs_val.clone());
    }
    let pretty = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".to_string());
    atomic_write_str(config_file, &pretty)?;
    Ok(prefs_val)
}

pub fn install_font_files(
    user_dir: &Path,
    config_file: &Path,
    settings_mutex: &Mutex<Value>,
    paths: Option<Vec<PathBuf>>,
) -> Result<Value, LofError> {
    let picked = match paths {
        Some(list) => list,
        None => {
            #[cfg(not(target_os = "android"))]
            {
                let dialog = FileDialog::new()
                    .set_title("글꼴 파일 추가")
                    .add_filter("글꼴 파일", &["ttf", "otf", "woff", "woff2", "ttc"])
                    .pick_files();
                let Some(files) = dialog else {
                    return Ok(Value::Null);
                };
                files
            }
            #[cfg(target_os = "android")]
            {
                return Ok(Value::Null);
            }
        }
    };
    if picked.is_empty() {
        return Ok(Value::Null);
    }

    let fonts_dir = user_dir.join("fonts");
    fs::create_dir_all(&fonts_dir)?;

    let mut prepared = Vec::new();
    for path in picked {
        let meta = fs::metadata(&path)?;
        if meta.len() > FONT_FILE_LIMIT {
            return Err(fail_invalid("글꼴 파일은 50MB 이하만 추가할 수 있습니다."));
        }
        let bytes = fs::read(&path)?;
        let Some((ext, format, _mime)) = font_format(&bytes) else {
            return Err(fail_invalid(
                "지원하지 않는 글꼴 파일입니다. TTF, OTF, WOFF, WOFF2 파일을 선택해 주세요.",
            ));
        };
        let orig_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("font")
            .to_string();
        let face = parse_font_bytes(&bytes, &orig_name);
        let stored_name = format!("font-{}.{}", hash_bytes(&bytes), ext);
        let dest = fonts_dir.join(&stored_name);
        if !dest.exists() {
            atomic_write_bytes(&dest, &bytes)?;
        }
        prepared.push((stored_name, format, orig_name, face));
    }

    let mut s_guard = settings_mutex.lock().unwrap();
    let mut user_fonts = user_fonts_from_settings(&s_guard);
    let mut added_ids = Vec::new();

    for (stored_name, format, orig_name, face) in prepared {
        let family = face
            .family_ko
            .clone()
            .or_else(|| face.family_en.clone())
            .unwrap_or_else(|| "사용자 글꼴".to_string());
        let family_en = face
            .family_en
            .filter(|en| !en.eq_ignore_ascii_case(&family));
        let font_id = format!("file:{}", family.to_lowercase());
        let value = build_font_value(&family, family_en.as_deref());
        let file_entry = json!({
            "file": stored_name,
            "format": format,
            "weight": face.weight,
            "italic": face.italic,
            "variable": face.variable,
            "originalName": orig_name,
        });

        if let Some(existing) = user_fonts
            .iter_mut()
            .find(|f| f.get("id").and_then(Value::as_str) == Some(&font_id))
        {
            if let Some(obj) = existing.as_object_mut() {
                let mut files_arr = obj
                    .get("files")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !files_arr
                    .iter()
                    .any(|item| item.get("file") == file_entry.get("file"))
                {
                    files_arr.push(file_entry);
                    obj.insert("files".to_string(), Value::Array(files_arr));
                }
                if obj.get("familyEn").is_none() && family_en.is_some() {
                    obj.insert("familyEn".to_string(), json!(family_en));
                    obj.insert("value".to_string(), json!(value));
                }
            }
        } else {
            user_fonts.push(json!({
                "id": font_id,
                "label": family,
                "family": family,
                "familyEn": family_en,
                "value": value,
                "source": "file",
                "files": [file_entry],
            }));
        }

        if !added_ids.contains(&font_id) {
            added_ids.push(font_id);
        }
    }

    let added: Vec<Value> = added_ids
        .iter()
        .filter_map(|id| {
            user_fonts
                .iter()
                .find(|f| f.get("id").and_then(Value::as_str) == Some(id))
                .cloned()
        })
        .collect();

    let prefs = save_user_fonts(config_file, &mut s_guard, user_fonts.clone())?;
    Ok(json!({
        "added": added,
        "userFonts": user_fonts,
        "preferences": prefs,
    }))
}

pub fn add_system_font(
    config_file: &Path,
    settings_mutex: &Mutex<Value>,
    args: &Value,
) -> Result<Value, LofError> {
    let raw_family = args
        .get("family")
        .or_else(|| args.get("label"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let family = clean_font_name(raw_family)
        .ok_or_else(|| fail_invalid("글꼴 이름을 확인해 주세요."))?;
    let family_en = args
        .get("familyEn")
        .and_then(Value::as_str)
        .and_then(clean_font_name)
        .filter(|en| !en.eq_ignore_ascii_case(&family));
    let label = args
        .get("label")
        .and_then(Value::as_str)
        .and_then(clean_font_name)
        .unwrap_or_else(|| family.clone());
    let font_id = format!("system:{}", family.to_lowercase());
    let value = build_font_value(&family, family_en.as_deref());

    let mut s_guard = settings_mutex.lock().unwrap();
    let mut user_fonts = user_fonts_from_settings(&s_guard);

    let entry = if let Some(existing) = user_fonts.iter().find(|f| {
        f.get("id").and_then(Value::as_str) == Some(&font_id)
            || f.get("family")
                .and_then(Value::as_str)
                .is_some_and(|fam| fam.eq_ignore_ascii_case(&family))
    }) {
        existing.clone()
    } else {
        let item = json!({
            "id": font_id,
            "label": label,
            "family": family,
            "familyEn": family_en,
            "value": value,
            "source": "system",
        });
        user_fonts.push(item.clone());
        item
    };

    let prefs = save_user_fonts(config_file, &mut s_guard, user_fonts.clone())?;
    Ok(json!({
        "added": entry,
        "userFonts": user_fonts,
        "preferences": prefs,
    }))
}

pub fn remove_user_font(
    user_dir: &Path,
    config_file: &Path,
    settings_mutex: &Mutex<Value>,
    args: &Value,
) -> Result<Value, LofError> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() {
        return Err(fail_invalid("삭제할 글꼴 ID가 필요합니다."));
    }

    let mut s_guard = settings_mutex.lock().unwrap();
    let mut user_fonts = user_fonts_from_settings(&s_guard);
    let mut removed_values = HashSet::new();
    let mut removed_files = Vec::new();

    user_fonts.retain(|item| {
        let matched = item.get("id").and_then(Value::as_str) == Some(id);
        if matched {
            if let Some(val) = item.get("value").and_then(Value::as_str) {
                removed_values.insert(val.to_string());
            }
            if let Some(files) = item.get("files").and_then(Value::as_array) {
                for f in files {
                    if let Some(fname) = f.get("file").and_then(Value::as_str) {
                        removed_files.push(fname.to_string());
                    }
                }
            }
        }
        !matched
    });

    // 남은 글꼴 항목에서 참조하지 않는 폰트 파일만 디스크에서 정리한다.
    let still_used: HashSet<String> = user_fonts
        .iter()
        .filter_map(|item| item.get("files").and_then(Value::as_array))
        .flatten()
        .filter_map(|f| f.get("file").and_then(Value::as_str).map(String::from))
        .collect();

    let fonts_dir = user_dir.join("fonts");
    for file_name in removed_files {
        if !still_used.contains(&file_name) && valid_font_filename(&file_name) {
            let _ = fs::remove_file(fonts_dir.join(&file_name));
        }
    }

    // 삭제한 글꼴을 사용 중이던 조판 설정은 기본 글꼴로 되돌린다.
    if !removed_values.is_empty() {
        if let Some(prefs) = s_guard
            .get_mut("preferences")
            .and_then(Value::as_object_mut)
        {
            if prefs
                .get("fontFamily")
                .and_then(Value::as_str)
                .is_some_and(|v| removed_values.contains(v))
            {
                prefs.insert("fontFamily".to_string(), json!(""));
            }
            if let Some(by_kind) = prefs
                .get_mut("typesettingByKind")
                .and_then(Value::as_object_mut)
            {
                for kind_key in ["episode", "document", "plot", "memo"] {
                    if let Some(kobj) = by_kind.get_mut(kind_key).and_then(Value::as_object_mut) {
                        if kobj
                            .get("fontFamily")
                            .and_then(Value::as_str)
                            .is_some_and(|v| removed_values.contains(v))
                        {
                            kobj.insert("fontFamily".to_string(), json!(""));
                        }
                    }
                }
            }
        }
    }

    let prefs = save_user_fonts(config_file, &mut s_guard, user_fonts.clone())?;
    Ok(json!({
        "userFonts": user_fonts,
        "preferences": prefs,
    }))
}

pub fn read_user_font(user_dir: &Path, args: &Value) -> Result<Value, LofError> {
    let file_name = args
        .get("file")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !valid_font_filename(file_name) {
        return Err(fail_invalid("잘못된 글꼴 파일 이름입니다."));
    }
    let path = user_dir.join("fonts").join(file_name);
    let meta = fs::metadata(&path).map_err(|_| fail_invalid("글꼴 파일을 찾을 수 없습니다."))?;
    if !meta.is_file() || meta.len() > FONT_FILE_LIMIT {
        return Err(fail_invalid("글꼴 파일을 읽을 수 없습니다."));
    }
    let bytes = fs::read(&path)?;
    let Some((_ext, format, mime)) = font_format(&bytes) else {
        return Err(fail_invalid("유효하지 않은 글꼴 파일입니다."));
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(json!({
        "data": b64,
        "mime": mime,
        "format": format,
    }))
}
