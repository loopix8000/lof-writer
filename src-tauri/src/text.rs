use crate::error::utf16_len;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(rel_semi) = s[i..].find(';') {
                let entity = &s[i + 1..i + rel_semi];
                let decoded = match entity {
                    "amp" => Some("&".to_string()),
                    "lt" => Some("<".to_string()),
                    "gt" => Some(">".to_string()),
                    "quot" => Some("\"".to_string()),
                    "apos" => Some("'".to_string()),
                    "nbsp" => Some("\u{00a0}".to_string()),
                    "hellip" => Some("…".to_string()),
                    "mdash" => Some("—".to_string()),
                    "ndash" => Some("–".to_string()),
                    "ldquo" => Some("“".to_string()),
                    "rdquo" => Some("”".to_string()),
                    "lsquo" => Some("‘".to_string()),
                    "rsquo" => Some("’".to_string()),
                    _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                        u32::from_str_radix(&entity[2..], 16)
                            .ok()
                            .and_then(char::from_u32)
                            .map(|c| c.to_string())
                    }
                    _ if entity.starts_with('#') => entity[1..]
                        .parse::<u32>()
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string()),
                    _ => None,
                };
                if let Some(rep) = decoded {
                    out.push_str(&rep);
                    i += rel_semi + 1;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn process_inline(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // Escaped character: \x -> x (literal, no entity decoding)
        if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            if "\\`*_[](){}#+-!.~|<>".contains(next) {
                out.push(next);
                i += 2;
                continue;
            }
        }
        // Inline code: `...` -> literal
        if chars[i] == '`' {
            let mut ticks = 0;
            while i + ticks < chars.len() && chars[i + ticks] == '`' {
                ticks += 1;
            }
            let start = i + ticks;
            let mut found = None;
            let mut j = start;
            while j + ticks <= chars.len() {
                if (0..ticks).all(|k| chars[j + k] == '`')
                    && (j + ticks == chars.len() || chars[j + ticks] != '`')
                {
                    found = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(end) = found {
                let code: String = chars[start..end].iter().collect();
                out.push_str(&code);
                i = end + ticks;
                continue;
            }
        }
        // Image: ![alt](url) -> ""
        if chars[i] == '!' && i + 1 < chars.len() && chars[i + 1] == '[' {
            if let Some((_alt, next_i)) = parse_link_or_img(&chars, i + 1) {
                i = next_i;
                continue;
            }
        }
        // Link: [text](url) -> process_inline(text)
        if chars[i] == '[' {
            if let Some((text, next_i)) = parse_link_or_img(&chars, i) {
                out.push_str(&process_inline(&text));
                i = next_i;
                continue;
            }
        }
        // Strong / emphasis / strike markers: **, *, __, _, ~~
        if (chars[i] == '*' || chars[i] == '_' || chars[i] == '~')
            && i + 1 < chars.len()
            && chars[i + 1] == chars[i]
        {
            let marker = chars[i];
            if let Some(end) = find_double_marker(&chars, i + 2, marker) {
                let inner: String = chars[i + 2..end].iter().collect();
                out.push_str(&process_inline(&inner));
                i = end + 2;
                continue;
            }
        }
        if chars[i] == '*' || chars[i] == '_' {
            let marker = chars[i];
            if let Some(end) = find_single_marker(&chars, i + 1, marker) {
                let inner: String = chars[i + 1..end].iter().collect();
                out.push_str(&process_inline(&inner));
                i = end + 1;
                continue;
            }
        }
        // Inline HTML tags
        if chars[i] == '<' {
            if let Some((replacement, next_i)) = parse_html_tag(&chars, i) {
                out.push_str(&replacement);
                i = next_i;
                continue;
            }
        }
        // Collect normal text run for entity decoding
        let start = i;
        i += 1;
        while i < chars.len()
            && !matches!(chars[i], '\\' | '`' | '!' | '[' | '*' | '_' | '~' | '<')
        {
            i += 1;
        }
        let seg: String = chars[start..i].iter().collect();
        out.push_str(&decode_html_entities(&seg));
    }
    out
}

fn parse_link_or_img(chars: &[char], open_bracket: usize) -> Option<(String, usize)> {
    let mut depth = 0;
    let mut i = open_bracket;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            i += 2;
            continue;
        }
        if chars[i] == '[' {
            depth += 1;
        } else if chars[i] == ']' {
            depth -= 1;
            if depth == 0 {
                if i + 1 < chars.len() && chars[i + 1] == '(' {
                    let mut p = i + 2;
                    let mut pdepth = 1;
                    while p < chars.len() && pdepth > 0 {
                        if chars[p] == '(' {
                            pdepth += 1;
                        } else if chars[p] == ')' {
                            pdepth -= 1;
                        }
                        p += 1;
                    }
                    if pdepth == 0 {
                        let inner: String = chars[open_bracket + 1..i].iter().collect();
                        return Some((inner, p));
                    }
                }
                return None;
            }
        }
        i += 1;
    }
    None
}

fn find_double_marker(chars: &[char], start: usize, marker: char) -> Option<usize> {
    if start >= chars.len() || chars[start].is_whitespace() {
        return None;
    }
    let mut i = start;
    while i + 1 < chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == marker && chars[i + 1] == marker && i > start && !chars[i - 1].is_whitespace()
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_single_marker(chars: &[char], start: usize, marker: char) -> Option<usize> {
    if start >= chars.len() || chars[start].is_whitespace() || chars[start] == marker {
        return None;
    }
    let mut i = start;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == marker && i > start && !chars[i - 1].is_whitespace() {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn parse_html_tag(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut i = start + 1;
    if i >= chars.len() {
        return None;
    }
    if !(chars[i].is_ascii_alphabetic() || chars[i] == '/') {
        return None;
    }
    while i < chars.len() && chars[i] != '>' {
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    let tag: String = chars[start + 1..i].iter().collect();
    let low = tag.trim().to_ascii_lowercase();
    if low == "br" || low.starts_with("br ") || low.starts_with("br/") {
        return Some(("\n".to_string(), i + 1));
    }
    if matches!(
        low.as_str(),
        "/p" | "/div" | "/h1" | "/h2" | "/h3" | "/h4" | "/h5" | "/h6" | "/li"
    ) {
        return Some(("\n".to_string(), i + 1));
    }
    Some((String::new(), i + 1))
}

pub fn strip_jsdoc_comments(markdown: &str) -> String {
    if markdown.is_empty() || !markdown.contains("<!--") {
        return markdown.to_string();
    }
    const MARKER: &str = "\u{E002}";
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    static FENCE_RE: OnceLock<Regex> = OnceLock::new();
    let fence_re = FENCE_RE.get_or_init(|| {
        Regex::new(r"(?ms)^[ \t]*(?:```|~~~)[^\n]*\n.*?(?:^[ \t]*(?:```|~~~)[^\n]*$|\z)").unwrap()
    });
    static COMMENT_RE: OnceLock<Regex> = OnceLock::new();
    let comment_re = COMMENT_RE.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap());

    let mut marked = String::with_capacity(normalized.len());
    let mut last_idx = 0;
    for m in fence_re.find_iter(&normalized) {
        if m.start() > last_idx {
            marked.push_str(&comment_re.replace_all(&normalized[last_idx..m.start()], MARKER));
        }
        marked.push_str(m.as_str());
        last_idx = m.end();
    }
    if last_idx < normalized.len() {
        marked.push_str(&comment_re.replace_all(&normalized[last_idx..], MARKER));
    }
    if !marked.contains(MARKER) {
        return markdown.to_string();
    }

    static LEAD_RE: OnceLock<Regex> = OnceLock::new();
    let lead_re = LEAD_RE.get_or_init(|| Regex::new(r"^([ \t]*)\u{E002}+[ \t]?").unwrap());
    static TRAIL_RE: OnceLock<Regex> = OnceLock::new();
    let trail_re = TRAIL_RE.get_or_init(|| Regex::new(r"[ \t]*\u{E002}+[ \t]*$").unwrap());
    static MID_RE: OnceLock<Regex> = OnceLock::new();
    let mid_re = MID_RE.get_or_init(|| Regex::new(r"([ \t]+)\u{E002}+[ \t]+").unwrap());

    #[derive(PartialEq, Eq)]
    enum LineKind {
        Text,
        Blank,
        Removed,
    }

    let items: Vec<(LineKind, String)> = marked
        .split('\n')
        .map(|line| {
            if !line.contains(MARKER) {
                let kind = if line.trim().is_empty() {
                    LineKind::Blank
                } else {
                    LineKind::Text
                };
                return (kind, line.to_string());
            }
            if line.replace(MARKER, "").trim().is_empty() {
                return (LineKind::Removed, String::new());
            }
            let s1 = lead_re.replace(line, "$1");
            let s2 = trail_re.replace(&s1, "");
            let s3 = mid_re.replace_all(&s2, "$1");
            let cleaned = s3.replace(MARKER, "");
            if cleaned.trim().is_empty() {
                (LineKind::Removed, String::new())
            } else {
                (LineKind::Text, cleaned)
            }
        })
        .collect();

    let mut out: Vec<String> = Vec::with_capacity(items.len());
    let mut i = 0;
    while i < items.len() {
        if items[i].0 == LineKind::Text {
            out.push(items[i].1.clone());
            i += 1;
            continue;
        }
        let start = i;
        let mut has_removed = false;
        let mut blanks_before = 0usize;
        let mut seen_removed = false;
        let mut trailing_blanks = 0usize;
        while i < items.len() && items[i].0 != LineKind::Text {
            if items[i].0 == LineKind::Removed {
                has_removed = true;
                seen_removed = true;
                trailing_blanks = 0;
            } else if !seen_removed {
                blanks_before += 1;
            } else {
                trailing_blanks += 1;
            }
            i += 1;
        }
        if !has_removed {
            for item in &items[start..i] {
                out.push(item.1.clone());
            }
        } else if !out.is_empty() && i < items.len() {
            let keep_blanks = blanks_before.max(trailing_blanks);
            for _ in 0..keep_blanks {
                out.push(String::new());
            }
        }
    }
    out.join("\n")
}

pub fn plain_text(markdown: &str) -> String {
    let stripped = strip_jsdoc_comments(markdown);
    let normalized = stripped.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut out = String::with_capacity(normalized.len());
    let mut i = 0;

    static HR_RE: OnceLock<Regex> = OnceLock::new();
    let hr_re = HR_RE.get_or_init(|| {
        Regex::new(r"^[ ]{0,3}(?:\*[ \t]*\*[ \t]*\*[\* \t]*|-[ \t]*-[ \t]*-[- \t]*|_[ \t]*_[ \t]*_[_ \t]*)$").unwrap()
    });
    static HEADING_RE: OnceLock<Regex> = OnceLock::new();
    let heading_re =
        HEADING_RE.get_or_init(|| Regex::new(r"^[ ]{0,3}(#{1,6})[ \t]+(.*)$").unwrap());
    static LIST_RE: OnceLock<Regex> = OnceLock::new();
    let list_re =
        LIST_RE.get_or_init(|| Regex::new(r"^[ \t]*(?:[-*+]|\d+\.)[ \t]+(.*)$").unwrap());

    while i < lines.len() {
        let line = lines[i];

        // Blank lines (space token in marked)
        if line.trim().is_empty() {
            let start = i;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            // In marked, a paragraph break + blank lines has raw with (blank_lines + 1) newlines
            let raw_newlines = if start == 0 {
                i - start
            } else {
                (i - start) + 1
            };
            let extra = (raw_newlines / 2).saturating_sub(1);
            for _ in 0..extra {
                out.push('\n');
            }
            continue;
        }

        // Fenced code block
        let trimmed_start = line.trim_start();
        if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
            let fence = &trimmed_start[..3];
            i += 1;
            let mut code_lines = Vec::new();
            while i < lines.len() && !lines[i].trim_start().starts_with(fence) {
                code_lines.push(lines[i]);
                i += 1;
            }
            if i < lines.len() {
                i += 1;
            }
            out.push_str(&code_lines.join("\n"));
            out.push('\n');
            continue;
        }

        // Horizontal rule
        if hr_re.is_match(line) {
            out.push('\n');
            i += 1;
            continue;
        }

        // ATX Heading
        if let Some(caps) = heading_re.captures(line) {
            let content = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let content = content.trim_end_matches(|c| c == '#' || c == ' ');
            out.push_str(&process_inline(content));
            out.push('\n');
            i += 1;
            continue;
        }

        // List items
        if let Some(caps) = list_re.captures(line) {
            let item = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            out.push_str(&process_inline(item));
            out.push('\n');
            i += 1;
            continue;
        }

        // Paragraph (may span consecutive non-blank lines)
        let mut para_lines = Vec::new();
        while i < lines.len()
            && !lines[i].trim().is_empty()
            && !lines[i].trim_start().starts_with("```")
            && !lines[i].trim_start().starts_with("~~~")
            && !hr_re.is_match(lines[i])
            && !heading_re.is_match(lines[i])
        {
            let mut pline = lines[i];
            if let Some(stripped) = pline.trim_start().strip_prefix('>') {
                pline = stripped.strip_prefix(' ').unwrap_or(stripped);
            }
            // Hard break (2 trailing spaces or trailing \)
            if pline.ends_with("  ") {
                let trimmed = pline.trim_end_matches(' ');
                para_lines.push(format!("{}\n", process_inline(trimmed)));
            } else if pline.ends_with('\\') {
                let trimmed = &pline[..pline.len() - 1];
                para_lines.push(format!("{}\n", process_inline(trimmed)));
            } else {
                para_lines.push(process_inline(pline));
            }
            i += 1;
        }
        let mut joined = String::new();
        for (idx, part) in para_lines.iter().enumerate() {
            if idx > 0 && !para_lines[idx - 1].ends_with('\n') {
                joined.push('\n');
            }
            joined.push_str(part);
        }
        out.push_str(&joined);
        out.push('\n');
    }

    if out.ends_with('\n') {
        out.pop();
    }
    out
}

pub fn character_count(markdown: &str, spaces: bool) -> usize {
    let text = plain_text(markdown);
    if spaces {
        let filtered: String = text.chars().filter(|&c| c != '\r' && c != '\n').collect();
        utf16_len(&filtered)
    } else {
        let filtered: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        utf16_len(&filtered)
    }
}

pub struct ManuscriptStats {
    pub text: String,
    pub utf16_without_spaces: usize,
    pub utf16_with_spaces: usize,
    pub utf16_with_line_breaks: usize,
}

pub fn manuscript_stats(markdown: &str) -> ManuscriptStats {
    let raw = plain_text(markdown);
    let mut text = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\r' {
            if i + 1 < chars.len() && chars[i + 1] == '\n' {
                i += 1;
            }
            text.push('\n');
        } else if c == '\u{2028}' || c == '\u{2029}' {
            text.push('\n');
        } else if c == '\u{00a0}' {
            text.push(' ');
        } else {
            text.push(c);
        }
        i += 1;
    }
    let no_space: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let spaces: String = text.chars().filter(|&c| c != '\n' && c != '\r').collect();
    ManuscriptStats {
        utf16_without_spaces: utf16_len(&no_space),
        utf16_with_spaces: utf16_len(&spaces),
        utf16_with_line_breaks: utf16_len(&text),
        text,
    }
}

// 화면과 같은 ECMAScript 공백 규칙을 사용한다. Rust의 공백 판정과 BOM·NEL 처리가 다르다.
fn display_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

// Markdown 해석은 독립 작업자가 수행한다. 이 함수는 일반 텍스트에서 숫자만 계산해 반환한다.
pub fn display_counts(raw: &str, rules: &Value) -> Value {
    let text = raw.replace("\r\n", "\n").replace('\r', "\n")
        .replace('\u{2028}', "\n").replace('\u{2029}', "\n").replace('\u{00a0}', " ");
    let mut without_spaces = 0usize;
    let mut with_spaces = 0usize;
    let mut with_line_breaks = 0usize;
    let mut utf16_without_spaces = 0usize;
    let mut utf16_with_spaces = 0usize;
    let mut utf16_with_line_breaks = 0usize;
    let mut lines = usize::from(!text.is_empty());
    let mut paragraphs = 0usize;
    let mut has_text = false;
    for c in text.chars() {
        with_line_breaks += 1;
        utf16_with_line_breaks += c.len_utf16();
        if c != '\n' {
            with_spaces += 1;
            utf16_with_spaces += c.len_utf16();
        } else {
            lines += 1;
            if has_text { paragraphs += 1; }
            has_text = false;
        }
        if !display_whitespace(c) {
            without_spaces += 1;
            utf16_without_spaces += c.len_utf16();
            has_text = true;
        }
    }
    if has_text { paragraphs += 1; }
    let rule = rules.get("rule").and_then(Value::as_str).unwrap_or("noSpace");
    let manuscript_lines = manuscript_paper_lines(&text);
    let platform_characters = if rule == "manuscript" {
        manuscript_lines.div_ceil(10)
    } else if rule == "novelpia" {
        let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let filtered: String = escaped.chars().filter(|&c|
            !matches!(c, ' ' | '.' | ',' | '\n' | '\t' | '\r' | '!' | '?' | '\'' | '"' | '\u{00a0}')).collect();
        let filtered: String = filtered.trim_matches(display_whitespace).chars().filter(|&c| c != '\u{200e}').collect();
        utf16_len(&filtered)
    } else {
        let mut value = match rule {
            "noSpace" => text.chars().filter(|&c| !display_whitespace(c)).collect::<String>(),
            "collapsed" => {
                let mut result = String::new();
                let mut whitespace = false;
                for c in text.trim_matches(display_whitespace).chars() {
                    if display_whitespace(c) {
                        if !whitespace { result.push(' '); }
                        whitespace = true;
                    } else { result.push(c); whitespace = false; }
                }
                result
            }
            _ => text.clone(),
        };
        match rules.get("punctuation").and_then(Value::as_str).unwrap_or("include") {
            "ascii" => value.retain(|c| !matches!(c, '.' | ',' | '!' | '?' | '\'' | '"')),
            "unicode" => {
                static PUNCTUATION: OnceLock<Regex> = OnceLock::new();
                value = PUNCTUATION.get_or_init(|| Regex::new(r"\p{P}").unwrap()).replace_all(&value, "").into_owned();
            }
            _ => {}
        }
        if rules.get("excludeSpecial").and_then(Value::as_bool) == Some(true) {
            static SPECIAL: OnceLock<Regex> = OnceLock::new();
            let letters_and_numbers = SPECIAL.get_or_init(|| Regex::new(r"^[\p{L}\p{N}]$").unwrap());
            value.retain(|c| {
                let mut encoded = [0u8; 4];
                display_whitespace(c) || letters_and_numbers.is_match(c.encode_utf8(&mut encoded))
            });
        }
        let extra = if rules.get("ellipsisWeight").and_then(Value::as_u64) == Some(3) {
            value.chars().filter(|&c| c == '…').count() * 2
        } else { 0 };
        utf16_len(&value) + extra
    };
    serde_json::json!({
        "withoutSpaces": without_spaces, "withSpaces": with_spaces, "withLineBreaks": with_line_breaks,
        "utf16WithoutSpaces": utf16_without_spaces, "utf16WithSpaces": utf16_with_spaces,
        "utf16WithLineBreaks": utf16_with_line_breaks, "utf8Bytes": text.len(),
        "lines": lines, "paragraphs": paragraphs, "platformCharacters": platform_characters,
        "manuscriptLines": manuscript_lines
    })
}

// 200자 원고지(한 줄 20칸)에 옮겨 적을 때 차지하는 줄 수. core/text.mjs의 manuscriptPaperLines와 같은 규칙이다.
// 문단은 새 줄 첫 칸을 비우고 시작하며, 빈 줄은 옮기지 않는다. 로마자 소문자·숫자는 두 자를 한 칸에 쓰고,
// 줄 끝에 걸린 띄어쓰기는 다음 줄로 넘기지 않으며, 줄이 꽉 찬 뒤의 닫는 문장부호는 마지막 칸에 함께 쓴다.
const PAPER_COLUMNS: usize = 20;

fn paper_closing_mark(c: char) -> bool {
    matches!(c, '.' | ',' | '?' | '!' | ':' | ';' | ')' | ']' | '}' | '」' | '』' | '”' | '’' | '〉' | '》' | '、' | '。')
}

pub fn manuscript_paper_lines(text: &str) -> usize {
    let half_width = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut total = 0;
    for raw in text.split('\n') {
        let chars: Vec<char> = raw.trim_matches(display_whitespace).chars().collect();
        if chars.is_empty() { continue; }
        let (mut rows, mut column) = (1usize, 1usize);
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if display_whitespace(c) {
                if column < PAPER_COLUMNS { column += 1; }
            } else {
                if half_width(c) && chars.get(i + 1).is_some_and(|&next| half_width(next)) { i += 1; }
                if column < PAPER_COLUMNS {
                    column += 1;
                } else if !paper_closing_mark(c) {
                    rows += 1;
                    column = 1;
                }
            }
            i += 1;
        }
        total += rows;
    }
    total
}

pub fn novelpia_count(text: &str) -> usize {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let filtered: String = escaped
        .chars()
        .filter(|&c| {
            !matches!(
                c,
                ' ' | '.' | ',' | '\n' | '\t' | '\r' | '!' | '?' | '\'' | '"' | '\u{00a0}'
            )
        })
        .collect();
    let trimmed = filtered.trim();
    let final_str: String = trimmed
        .chars()
        .filter(|&c| c != '\u{200e}' && c != '\u{200E}')
        .collect();
    utf16_len(&final_str)
}

pub fn count_for_writing(stats: &ManuscriptStats, rules: &Value) -> usize {
    let rule = rules
        .get("rule")
        .and_then(|v| v.as_str())
        .unwrap_or("noSpace");
    if rule == "manuscript" {
        return manuscript_paper_lines(&stats.text).div_ceil(10);
    }
    if rule == "novelpia" {
        return novelpia_count(&stats.text);
    }
    let mut text = match rule {
        "noSpace" => stats.text.chars().filter(|c| !c.is_whitespace()).collect(),
        "collapsed" => {
            let mut out = String::new();
            let mut prev_ws = false;
            for c in stats.text.trim().chars() {
                if c.is_whitespace() {
                    if !prev_ws {
                        out.push(' ');
                        prev_ws = true;
                    }
                } else {
                    out.push(c);
                    prev_ws = false;
                }
            }
            out
        }
        _ => stats.text.clone(),
    };

    let punctuation = rules
        .get("punctuation")
        .and_then(|v| v.as_str())
        .unwrap_or("include");
    if punctuation == "ascii" {
        text = text
            .chars()
            .filter(|&c| !matches!(c, '.' | ',' | '!' | '?' | '\'' | '"'))
            .collect();
    } else if punctuation == "unicode" {
        static PUNCT_RE: OnceLock<Regex> = OnceLock::new();
        let re = PUNCT_RE.get_or_init(|| Regex::new(r"\p{P}").unwrap());
        text = re.replace_all(&text, "").into_owned();
    }

    if rules.get("excludeSpecial").and_then(|v| v.as_bool()) == Some(true) {
        static SPECIAL_RE: OnceLock<Regex> = OnceLock::new();
        let re = SPECIAL_RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}\s]").unwrap());
        text = re.replace_all(&text, "").into_owned();
    }

    let ellipsis_weight = rules
        .get("ellipsisWeight")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let extra = if ellipsis_weight == 3 {
        text.chars().filter(|&c| c == '…').count() * 2
    } else {
        0
    };
    utf16_len(&text) + extra
}

