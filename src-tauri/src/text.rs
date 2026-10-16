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

pub fn plain_text(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
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
    if rule == "novelpia" {
        return novelpia_count(&stats.text);
    }
    let mut text = match rule {
        "noSpace" => stats.text.chars().filter(|c| !c.is_whitespace()).collect(),
        "spaces" => stats.text.chars().filter(|&c| c != '\n').collect(),
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

