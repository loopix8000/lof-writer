use crate::error::{fail_invalid, LofError};

enum PatchLine<'a> {
    Context(&'a str),
    Remove(&'a str),
    Add(&'a str),
}

struct Hunk<'a> {
    lines: Vec<PatchLine<'a>>,
    end_of_file: bool,
}

#[derive(Clone, Copy)]
struct BodyLine<'a> {
    text: &'a str,
    ending: &'a str,
    offset: usize,
}

pub(crate) struct AppliedPatch {
    pub body: String,
    pub hunks: usize,
}

fn parse(patch: &str) -> Result<Vec<Hunk<'_>>, LofError> {
    let mut hunks: Vec<Hunk<'_>> = Vec::new();
    for (index, raw) in patch.split_terminator('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if hunks.last().is_some_and(|h| h.end_of_file) {
            return Err(fail_invalid(
                "*** End of File은 패치의 마지막 줄이어야 합니다.",
            ));
        }
        if line == "@@" {
            hunks.push(Hunk {
                lines: Vec::new(),
                end_of_file: false,
            });
            continue;
        }
        let Some(hunk) = hunks.last_mut() else {
            return Err(fail_invalid(
                "patch는 @@ 구간으로 시작해야 합니다. 파일 경로나 파일 작업은 지원하지 않습니다.",
            ));
        };
        if line == "*** End of File" {
            hunk.end_of_file = true;
            continue;
        }
        let parsed = match line.as_bytes().first() {
            Some(b' ') => PatchLine::Context(&line[1..]),
            Some(b'-') => PatchLine::Remove(&line[1..]),
            Some(b'+') => PatchLine::Add(&line[1..]),
            _ => return Err(fail_invalid(format!(
                "patch {}행: @@ 또는 공백·-·+로 시작하는 줄이 필요합니다. 빈 문맥 줄에도 공백을 붙이세요.",
                index + 1
            ))),
        };
        hunk.lines.push(parsed);
    }
    if hunks.is_empty() {
        return Err(fail_invalid("patch에 하나 이상의 @@ 구간이 필요합니다."));
    }
    for (index, hunk) in hunks.iter().enumerate() {
        if !hunk
            .lines
            .iter()
            .any(|line| !matches!(line, PatchLine::Context(_)))
        {
            return Err(fail_invalid(format!(
                "patch {}번 구간에 추가 또는 삭제 줄이 필요합니다.",
                index + 1
            )));
        }
    }
    Ok(hunks)
}

fn body_lines(body: &str) -> Vec<BodyLine<'_>> {
    let mut offset = 0;
    body.split_inclusive('\n')
        .map(|raw| {
            let (text, ending) = if let Some(text) = raw.strip_suffix("\r\n") {
                (text, "\r\n")
            } else if let Some(text) = raw.strip_suffix('\n') {
                (text, "\n")
            } else {
                (raw, "")
            };
            let line = BodyLine {
                text,
                ending,
                offset,
            };
            offset += raw.len();
            line
        })
        .collect()
}

// 모든 구간은 같은 원본에서 찾는다. 앞 구간의 수정으로 뒤 구간의 위치가 달라지지 않는다.
pub(crate) fn apply(body: &str, patch: &str) -> Result<AppliedPatch, LofError> {
    let hunks = parse(patch)?;
    let source = body_lines(body);
    let mut replacements = Vec::with_capacity(hunks.len());

    for (index, hunk) in hunks.iter().enumerate() {
        let old: Vec<&str> = hunk
            .lines
            .iter()
            .filter_map(|line| match line {
                PatchLine::Context(text) | PatchLine::Remove(text) => Some(*text),
                PatchLine::Add(_) => None,
            })
            .collect();
        let start = if old.is_empty() {
            if !source.is_empty() || hunks.len() != 1 {
                return Err(fail_invalid(format!(
                    "patch {}번 구간: 추가할 위치를 찾을 문맥 줄이 필요합니다. 문맥 없는 추가는 빈 본문의 단일 구간에만 허용됩니다.",
                    index + 1
                )));
            }
            0
        } else {
            let mut found = None;
            for (candidate, window) in source.windows(old.len()).enumerate() {
                if hunk.end_of_file && candidate + old.len() != source.len() {
                    continue;
                }
                if window
                    .iter()
                    .zip(&old)
                    .all(|(line, text)| line.text == *text)
                {
                    if found.is_some() {
                        return Err(fail_invalid(format!(
                            "patch {}번 구간: 문맥이 여러 위치에 일치합니다. 앞뒤 문맥을 더 포함하세요.",
                            index + 1
                        )));
                    }
                    found = Some(candidate);
                }
            }
            found.ok_or_else(|| {
                fail_invalid(format!(
                    "patch {}번 구간: 문맥 또는 삭제할 줄이 본문과 일치하지 않습니다.",
                    index + 1
                ))
            })?
        };
        let end = start + old.len();
        let start_byte = source.get(start).map_or(body.len(), |line| line.offset);
        let end_byte = source.get(end).map_or(body.len(), |line| line.offset);
        // 추가 줄은 구간의 줄바꿈을 따르고, 기존 문맥 줄은 각 줄의 원래 줄바꿈을 유지한다.
        let ending = source[start..end]
            .iter()
            .find(|line| !line.ending.is_empty())
            .or_else(|| {
                source[..start]
                    .iter()
                    .rev()
                    .find(|line| !line.ending.is_empty())
            })
            .or_else(|| source[end..].iter().find(|line| !line.ending.is_empty()))
            .map_or("\n", |line| line.ending);
        let mut next_lines = Vec::new();
        let mut cursor = start;
        for line in &hunk.lines {
            match line {
                PatchLine::Context(_) => {
                    next_lines.push((source[cursor].text, source[cursor].ending));
                    cursor += 1;
                }
                PatchLine::Remove(_) => cursor += 1,
                PatchLine::Add(text) => next_lines.push((*text, ending)),
            }
        }
        if end == source.len() {
            if let Some(last) = next_lines.last_mut() {
                last.1 = source.last().map_or("", |line| line.ending);
            }
        }
        let mut replacement = String::new();
        for (position, (text, line_ending)) in next_lines.iter().enumerate() {
            replacement.push_str(text);
            // 줄바꿈 없는 마지막 줄 뒤에 추가할 때는 새 줄과 구분한다.
            replacement.push_str(
                if line_ending.is_empty() && position + 1 < next_lines.len() {
                    ending
                } else {
                    line_ending
                },
            );
        }
        replacements.push((start_byte, end_byte, replacement, index + 1));
    }

    replacements.sort_by_key(|(start, _, _, _)| *start);
    for pair in replacements.windows(2) {
        if pair[1].0 < pair[0].1 || pair[1].0 == pair[0].0 {
            return Err(fail_invalid(format!(
                "patch {}번과 {}번 구간의 범위가 겹칩니다. 겹치는 문맥을 하나의 구간으로 합치세요.",
                pair[0].3, pair[1].3
            )));
        }
    }
    let mut next_body = String::new();
    let mut cursor = 0;
    for (start, end, replacement, _) in replacements {
        next_body.push_str(&body[cursor..start]);
        next_body.push_str(&replacement);
        cursor = end;
    }
    next_body.push_str(&body[cursor..]);
    Ok(AppliedPatch {
        body: next_body,
        hunks: hunks.len(),
    })
}
