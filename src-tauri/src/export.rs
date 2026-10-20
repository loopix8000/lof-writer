use crate::episode::line_break_default;
use crate::error::{fail_invalid, LofError};
use crate::file_index::CatalogProject;
use crate::markdown::read_markdown;
use crate::store::{
    abs, base_name, by_order_cmp, pad, safe_name, skipped_name, strip_verbatim_prefix, unique_name,
    walk_rel, Store,
};
use crate::text::plain_text;
use regex::Regex;
use rfd::FileDialog;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

fn write_export_file(file: &Path, data: &str) -> Result<(), LofError> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(file, data.as_bytes())?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct ExportOptions {
    pub project_id: Option<String>,
    pub format: String,
    pub include_episodes: bool,
    pub include_docs: bool,
    pub include_common_memos: bool,
    pub include_archived: bool,
    pub merge_episodes: bool,
    pub preserve_paragraph_breaks: bool,
}

impl ExportOptions {
    pub fn from_args(args: &Value, default_preserve_breaks: bool) -> Self {
        let project_id = args
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let format = match args.get("format").and_then(Value::as_str) {
            Some(f) if f.eq_ignore_ascii_case("md") => "md".to_string(),
            _ => "txt".to_string(),
        };
        let include_episodes = args
            .get("includeEpisodes")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let include_docs = args
            .get("includeDocs")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let include_common_memos = args
            .get("includeCommonMemos")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let include_archived = args
            .get("includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let merge_episodes = args
            .get("mergeEpisodes")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let preserve_paragraph_breaks = args
            .get("preserveParagraphBreaks")
            .and_then(Value::as_bool)
            .unwrap_or(default_preserve_breaks);

        Self {
            project_id,
            format,
            include_episodes,
            include_docs,
            include_common_memos,
            include_archived,
            merge_episodes,
            preserve_paragraph_breaks,
        }
    }

    fn ext(&self) -> &'static str {
        if self.format == "md" {
            ".md"
        } else {
            ".txt"
        }
    }
}

fn strip_frontmatter(raw: &str) -> (String, Map<String, Value>) {
    if let Ok(parsed) = read_markdown(raw) {
        return (parsed.body, parsed.properties);
    }
    let source = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    static FALLBACK_FM_RE: OnceLock<Regex> = OnceLock::new();
    let re = FALLBACK_FM_RE
        .get_or_init(|| Regex::new(r"(?s)\A---[ \t]*\r?\n.*?\r?\n---[ \t]*(?:\r?\n|\z)").unwrap());
    if let Some(m) = re.find(source) {
        (source[m.end()..].to_string(), Map::new())
    } else {
        (source.to_string(), Map::new())
    }
}

fn plain_text_preserving_breaks(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut expanded = Vec::with_capacity(lines.len() * 2);
    let mut fence = false;
    let is_joined = |line: &str| {
        let trimmed = line.trim_start();
        trimmed.starts_with('|') || trimmed.starts_with('>')
    };
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            let start = i;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            let blank_count = i - start;
            let needed_blanks = if start == 0 {
                blank_count * 2
            } else {
                blank_count * 2 + 1
            };
            for _ in 0..needed_blanks {
                expanded.push(String::new());
            }
            continue;
        }
        let trimmed_start = line.trim_start();
        if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
            fence = !fence;
        }
        let next = lines.get(i + 1).copied();
        let split = !fence
            && next.is_some_and(|n| !n.trim().is_empty())
            && !(is_joined(line) && next.is_some_and(is_joined));
        if split {
            let cleaned = if line.ends_with('\\') {
                &line[..line.len() - 1]
            } else {
                line.trim_end_matches(' ')
            };
            expanded.push(cleaned.to_string());
            expanded.push(String::new());
            expanded.push(String::new());
            expanded.push(String::new());
        } else {
            expanded.push(line.to_string());
        }
        i += 1;
    }
    plain_text(&expanded.join("\n"))
}

fn format_body(body: &str, opts: &ExportOptions, manual_line_break: bool) -> String {
    if opts.format == "md" {
        body.to_string()
    } else if !manual_line_break && opts.preserve_paragraph_breaks {
        plain_text_preserving_breaks(body)
    } else {
        plain_text(body)
    }
}

fn unique_child_dir(parent: &Path, base_folder_name: &str, taken: &mut HashSet<String>) -> PathBuf {
    let mut candidate = base_folder_name.to_string();
    let mut n = 2;
    while taken.contains(&candidate.to_lowercase()) || parent.join(&candidate).exists() {
        candidate = format!("{} ({})", base_folder_name, n);
        n += 1;
    }
    taken.insert(candidate.to_lowercase());
    parent.join(candidate)
}

fn is_folder_archived(rel_folder: &str, archived_folders: &[String]) -> bool {
    if rel_folder.is_empty() {
        return false;
    }
    archived_folders.iter().any(|af| {
        af.eq_ignore_ascii_case(rel_folder)
            || (rel_folder.len() > af.len()
                && rel_folder[..af.len()].eq_ignore_ascii_case(af)
                && rel_folder.as_bytes().get(af.len()) == Some(&b'/'))
    })
}

fn sanitize_rel_dir(rel_folder: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for seg in rel_folder.split('/') {
        let trimmed = seg.trim();
        if !trimmed.is_empty() {
            out.push(safe_name(trimmed, "폴더"));
        }
    }
    out
}

fn export_project_files(
    p: &CatalogProject,
    project_out_dir: &Path,
    opts: &ExportOptions,
    default_manual_lb: bool,
) -> Result<usize, LofError> {
    let mut written = 0usize;
    let ext = opts.ext();
    let proj_default_lb = line_break_default(Some(&p.project), default_manual_lb);

    // 1. 에피소드 (원고)
    if opts.include_episodes {
        let mut episodes: Vec<Value> = if !p.files.is_empty() {
            p.files
                .values()
                .filter(|f| f.entry.get("kind").and_then(Value::as_str) == Some("episode"))
                .map(|f| f.entry.clone())
                .collect()
        } else {
            p.project
                .get("documents")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|d| d.get("kind").and_then(Value::as_str) == Some("episode"))
                .collect()
        };
        episodes.sort_by(by_order_cmp);

        let mut active_eps = Vec::new();
        let mut archived_eps = Vec::new();
        for ep in episodes {
            let is_arch = ep.get("archived").and_then(Value::as_bool).unwrap_or(false);
            if is_arch {
                if opts.include_archived {
                    archived_eps.push(ep);
                }
            } else {
                active_eps.push(ep);
            }
        }

        if opts.merge_episodes {
            for (group, is_arch) in [(&active_eps, false), (&archived_eps, true)] {
                if group.is_empty() {
                    continue;
                }
                let mut chunks = Vec::with_capacity(group.len());
                for (idx, ep) in group.iter().enumerate() {
                    let rel = ep.get("path").and_then(Value::as_str).unwrap_or("");
                    if rel.is_empty() {
                        continue;
                    }
                    let file_path = abs(&p.dir, rel);
                    let Ok(raw) = fs::read_to_string(&file_path) else {
                        continue;
                    };
                    let (body, props) = strip_frontmatter(&raw);
                    let manual_lb = props
                        .get("manualLineBreak")
                        .and_then(Value::as_bool)
                        .or_else(|| ep.get("manualLineBreak").and_then(Value::as_bool))
                        .unwrap_or(proj_default_lb);
                    let title = props
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| ep.get("title").and_then(Value::as_str))
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{}화", idx + 1));
                    let formatted = format_body(&body, opts, manual_lb);
                    let section = if opts.format == "md" {
                        format!("# {}\n\n{}", title, formatted.trim_end())
                    } else {
                        format!("{}\n\n{}", title, formatted.trim_end())
                    };
                    chunks.push(section);
                }
                if !chunks.is_empty() {
                    let proj_title = p
                        .project
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("제목 없는 작품");
                    let dir = if is_arch {
                        project_out_dir.join("보관함")
                    } else {
                        project_out_dir.to_path_buf()
                    };
                    let file_stem = if is_arch {
                        format!("{} (보관함)", safe_name(proj_title, "제목 없는 작품"))
                    } else {
                        safe_name(proj_title, "제목 없는 작품")
                    };
                    let out_file = dir.join(format!("{}{}", file_stem, ext));
                    write_export_file(&out_file, &chunks.join("\n\n\n"))?;
                    written += 1;
                }
            }
        } else {
            for (group, is_arch) in [(&active_eps, false), (&archived_eps, true)] {
                if group.is_empty() {
                    continue;
                }
                let dir = if is_arch {
                    project_out_dir.join("보관함")
                } else {
                    project_out_dir.to_path_buf()
                };
                let mut taken = HashSet::new();
                for (idx, ep) in group.iter().enumerate() {
                    let rel = ep.get("path").and_then(Value::as_str).unwrap_or("");
                    if rel.is_empty() {
                        continue;
                    }
                    let file_path = abs(&p.dir, rel);
                    let Ok(raw) = fs::read_to_string(&file_path) else {
                        continue;
                    };
                    let (body, props) = strip_frontmatter(&raw);
                    let manual_lb = props
                        .get("manualLineBreak")
                        .and_then(Value::as_bool)
                        .or_else(|| ep.get("manualLineBreak").and_then(Value::as_bool))
                        .unwrap_or(proj_default_lb);
                    let title = props
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| ep.get("title").and_then(Value::as_str))
                        .unwrap_or("");
                    let want = format!(
                        "{} {}{}",
                        pad((idx + 1) as i64),
                        safe_name(title, "제목 없음"),
                        ext
                    );
                    let filename = unique_name(&want, ext, &mut taken);
                    let formatted = format_body(&body, opts, manual_lb);
                    write_export_file(&dir.join(filename), &formatted)?;
                    written += 1;
                }
            }
        }
    }

    // 2. 플롯 · 작품 메모 (doc/ 폴더)
    if opts.include_docs {
        let archived_folders: Vec<String> = p
            .project
            .get("archivedDocFolders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let mut taken_by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();

        for rel in walk_rel(&p.dir, "doc") {
            if !rel.to_ascii_lowercase().ends_with(".md") {
                continue;
            }
            let file_path = abs(&p.dir, &rel);
            let Ok(raw) = fs::read_to_string(&file_path) else {
                continue;
            };
            let (body, props) = strip_frontmatter(&raw);
            let sub_rel = rel.strip_prefix("doc/").unwrap_or(&rel);
            let rel_folder = match sub_rel.rfind('/') {
                Some(idx) => &sub_rel[..idx],
                None => "",
            };
            let indexed_arch = p
                .files
                .get(&rel)
                .and_then(|f| f.entry.get("archived"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let doc_arch = props
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(indexed_arch)
                || is_folder_archived(rel_folder, &archived_folders);

            if doc_arch && !opts.include_archived {
                continue;
            }

            let manual_lb = props
                .get("manualLineBreak")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let title = props
                .get("title")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| base_name(&rel));

            let base_docs_dir = if doc_arch {
                if opts.include_episodes {
                    project_out_dir.join("보관함").join("문서")
                } else {
                    project_out_dir.join("보관함")
                }
            } else if opts.include_episodes {
                project_out_dir.join("문서")
            } else {
                project_out_dir.to_path_buf()
            };
            let target_dir = if rel_folder.is_empty() {
                base_docs_dir
            } else {
                base_docs_dir.join(sanitize_rel_dir(rel_folder))
            };
            let taken = taken_by_dir.entry(target_dir.clone()).or_default();
            let want = format!("{}{}", safe_name(&title, "문서"), ext);
            let filename = unique_name(&want, ext, taken);
            let formatted = format_body(&body, opts, manual_lb);
            write_export_file(&target_dir.join(filename), &formatted)?;
            written += 1;
        }
    }

    Ok(written)
}

fn walk_common_memos(root: &Path, rel: &str) -> Vec<String> {
    let mut files = Vec::new();
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        abs(root, rel)
    };
    let Ok(rd) = fs::read_dir(dir) else {
        return files;
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if skipped_name(&name) {
            continue;
        }
        let next_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel, name)
        };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            files.extend(walk_common_memos(root, &next_rel));
        } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".md") {
            files.push(next_rel);
        }
    }
    files
}

fn export_common_memos(
    common_root: &Path,
    out_dir: &Path,
    opts: &ExportOptions,
) -> Result<usize, LofError> {
    if !common_root.exists() {
        return Ok(0);
    }
    let mut written = 0usize;
    let ext = opts.ext();
    let mut taken_by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();

    for rel in walk_common_memos(common_root, "") {
        let file_path = abs(common_root, &rel);
        let Ok(raw) = fs::read_to_string(&file_path) else {
            continue;
        };
        let (body, props) = strip_frontmatter(&raw);
        let manual_lb = props
            .get("manualLineBreak")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let rel_folder = match rel.rfind('/') {
            Some(idx) => &rel[..idx],
            None => "",
        };
        let title = base_name(&rel);
        let target_dir = if rel_folder.is_empty() {
            out_dir.to_path_buf()
        } else {
            out_dir.join(sanitize_rel_dir(rel_folder))
        };
        let taken = taken_by_dir.entry(target_dir.clone()).or_default();
        let want = format!("{}{}", safe_name(&title, "메모"), ext);
        let filename = unique_name(&want, ext, taken);
        let formatted = format_body(&body, opts, manual_lb);
        write_export_file(&target_dir.join(filename), &formatted)?;
        written += 1;
    }

    Ok(written)
}

fn validate_export_destination(
    picked: &Path,
    store_root: &Path,
    common_root: &Path,
) -> Result<PathBuf, LofError> {
    let clean_picked =
        strip_verbatim_prefix(&fs::canonicalize(picked).unwrap_or_else(|_| picked.to_path_buf()));
    let clean_store = strip_verbatim_prefix(
        &fs::canonicalize(store_root).unwrap_or_else(|_| store_root.to_path_buf()),
    );
    let clean_common = strip_verbatim_prefix(
        &fs::canonicalize(common_root).unwrap_or_else(|_| common_root.to_path_buf()),
    );
    if clean_picked.starts_with(&clean_store) || clean_picked.starts_with(&clean_common) {
        return Err(fail_invalid(
            "현재 서재나 공용 메모 폴더 안으로는 내보낼 수 없습니다. 다른 폴더를 선택해 주세요.",
        ));
    }
    Ok(clean_picked)
}

pub fn export_library_or_project(
    store_mutex: &Mutex<Option<Store>>,
    common_root: &Path,
    args: &Value,
    default_preserve_breaks: bool,
) -> Result<Value, LofError> {
    let opts = ExportOptions::from_args(args, default_preserve_breaks);
    if !opts.include_episodes
        && !opts.include_docs
        && (opts.project_id.is_some() || !opts.include_common_memos)
    {
        return Err(fail_invalid("내보낼 항목을 하나 이상 선택해 주세요."));
    }

    if let Some(ref project_id) = opts.project_id {
        let (store_root, default_manual_lb, project) = {
            let mut guard = store_mutex.lock().unwrap();
            let store = guard
                .as_mut()
                .ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
            (
                store.root.clone(),
                store.default_manual_line_break,
                store.get_project(project_id)?,
            )
        };
        let proj_title = project
            .project
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("제목 없는 작품")
            .to_string();

        let Some(picked) = FileDialog::new()
            .set_title(format!("'{}' 내보낼 폴더 선택", proj_title))
            .pick_folder()
        else {
            return Ok(Value::Null);
        };
        let parent_dir = validate_export_destination(&picked, &store_root, common_root)?;
        let mut taken_dirs = HashSet::new();
        let target_dir = unique_child_dir(
            &parent_dir,
            &safe_name(&proj_title, "제목 없는 작품"),
            &mut taken_dirs,
        );

        let file_count = export_project_files(&project, &target_dir, &opts, default_manual_lb)?;
        if file_count == 0 {
            let _ = fs::remove_dir_all(&target_dir);
            return Err(fail_invalid("선택한 조건에 해당하는 내보낼 문서가 없습니다."));
        }

        return Ok(json!({
            "path": target_dir.to_string_lossy().to_string(),
            "fileCount": file_count,
            "projectCount": 1,
        }));
    }

    // 서재 전체 내보내기
    let (store_root, default_manual_lb, projects) = {
        let mut guard = store_mutex.lock().unwrap();
        let store = guard
            .as_mut()
            .ok_or_else(|| fail_invalid("서재가 열려 있지 않습니다."))?;
        let cat = store.scan()?;
        let list_val = store.list()?;
        let order_map: HashMap<String, usize> = list_val
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(i, p)| {
                p.get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_string(), i))
            })
            .collect();
        let mut projects = cat.projects;
        projects.sort_by_key(|p| {
            p.project
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| order_map.get(id).copied())
                .unwrap_or(usize::MAX)
        });
        (store.root.clone(), store.default_manual_line_break, projects)
    };

    let Some(picked) = FileDialog::new()
        .set_title("서재를 내보낼 폴더 선택")
        .pick_folder()
    else {
        return Ok(Value::Null);
    };
    let parent_dir = validate_export_destination(&picked, &store_root, common_root)?;
    let vault_name = store_root
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("내 서재");
    let mut root_taken = HashSet::new();
    let export_root = unique_child_dir(&parent_dir, &safe_name(vault_name, "내 서재"), &mut root_taken);

    let mut total_files = 0usize;
    let mut exported_projects = 0usize;
    let mut proj_dir_taken = HashSet::new();

    if opts.include_episodes || opts.include_docs {
        for p in &projects {
            let proj_title = p
                .project
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("제목 없는 작품");
            let proj_dir = unique_child_dir(
                &export_root,
                &safe_name(proj_title, "제목 없는 작품"),
                &mut proj_dir_taken,
            );
            let count = export_project_files(p, &proj_dir, &opts, default_manual_lb)?;
            if count > 0 {
                total_files += count;
                exported_projects += 1;
            } else {
                let _ = fs::remove_dir_all(&proj_dir);
            }
        }
    }

    if opts.include_common_memos {
        let common_out = unique_child_dir(&export_root, "공용 메모", &mut proj_dir_taken);
        let common_count = export_common_memos(common_root, &common_out, &opts)?;
        if common_count > 0 {
            total_files += common_count;
        } else {
            let _ = fs::remove_dir_all(&common_out);
        }
    }

    if total_files == 0 {
        let _ = fs::remove_dir_all(&export_root);
        return Err(fail_invalid("선택한 조건에 해당하는 내보낼 문서가 없습니다."));
    }

    Ok(json!({
        "path": export_root.to_string_lossy().to_string(),
        "fileCount": total_files,
        "projectCount": exported_projects,
    }))
}
