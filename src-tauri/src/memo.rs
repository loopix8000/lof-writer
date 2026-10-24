use crate::error::{
    fail, fail_invalid, hash_str, now_iso, sys_time_to_iso, utf16_len, valid_id, LofError,
};
use crate::file_index::CommonIndexedFile;
use crate::markdown::{markdown_entry, read_markdown, write_markdown};
use crate::store::{
    abs, atomic_write_str, match_lines, memo_id, rename_with_retry, safe_name, skipped_name,
    strip_verbatim_prefix, valid_rel, Store,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const COMMON: &str = "common";

fn is_md(name: &str) -> bool {
    name.len() >= 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md")
}

fn strip_md_ext(name: &str) -> String {
    if is_md(name) {
        name[..name.len() - 3].to_string()
    } else {
        name.to_string()
    }
}

fn parent_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[..idx],
        None => "",
    }
}

fn name_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[idx + 1..],
        None => rel,
    }
}

fn join_rel(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", folder, name)
    }
}

#[derive(Clone)]
pub struct SpaceInfo {
    pub id: String,
    pub title: String,
    pub root: PathBuf,
    pub project_id: Option<String>,
}

pub struct Memos;

impl Memos {
    fn archived_folders(project: &Value) -> Vec<String> {
        project
            .get("archivedDocFolders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    }

    fn set_archived_folders(project: &mut Value, folders: Vec<String>) {
        if let Some(obj) = project.as_object_mut() {
            if folders.is_empty() {
                obj.remove("archivedDocFolders");
            } else {
                obj.insert("archivedDocFolders".to_string(), json!(folders));
            }
            obj.insert("updatedAt".to_string(), json!(now_iso()));
        }
    }

    pub fn spaces(store: &mut Store, common_root: &Path) -> Result<Value, LofError> {
        let cat = store.scan()?;
        let mut projs = cat.projects;
        projs.sort_by_key(|p| p.project.get("index").and_then(|v| v.as_i64()).unwrap_or(0));

        let c_root = strip_verbatim_prefix(
            &fs::canonicalize(common_root).unwrap_or_else(|_| common_root.to_path_buf()),
        );
        let mut out = vec![json!({
            "id": COMMON,
            "title": "공용 메모",
            "root": c_root.to_string_lossy().to_string(),
        })];
        for p in projs {
            out.push(json!({
                "id": p.project.get("id"),
                "title": p.project.get("title"),
                "root": p.dir.join("doc").to_string_lossy().to_string(),
            }));
        }
        Ok(Value::Array(out))
    }

    pub fn resolve_space(
        store: &mut Store,
        common_root: &Path,
        id: &str,
    ) -> Result<SpaceInfo, LofError> {
        if id == COMMON {
            fs::create_dir_all(common_root)?;
            let root = strip_verbatim_prefix(
                &fs::canonicalize(common_root).unwrap_or_else(|_| common_root.to_path_buf()),
            );
            return Ok(SpaceInfo {
                id: COMMON.to_string(),
                title: "공용 메모".to_string(),
                root,
                project_id: None,
            });
        }
        let p = store.get_project(id)?;
        let root = p.dir.join("doc");
        fs::create_dir_all(&root)?;
        let title = p
            .project
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let pid = p
            .project
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(SpaceInfo {
            id: id.to_string(),
            title,
            root,
            project_id: Some(pid),
        })
    }

    fn space_abs(space: &SpaceInfo, rel: &str) -> Result<PathBuf, LofError> {
        if !valid_rel(rel) {
            return Err(fail_invalid("잘못된 메모 경로"));
        }
        Ok(abs(&space.root, rel))
    }

    fn walk_space(space: &SpaceInfo, rel: &str) -> Vec<Value> {
        let mut out = Vec::new();
        let dir = if rel.is_empty() {
            space.root.clone()
        } else {
            abs(&space.root, rel)
        };
        let Ok(rd) = fs::read_dir(&dir) else {
            return out;
        };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if skipped_name(&name) {
                continue;
            }
            let r = join_rel(rel, &name);
            let Ok(ft) = e.file_type() else { continue };
            // 공용 메모의 이미지 폴더(assets/)는 메모 목록에 보이지 않는다.
            if ft.is_dir() && space.id == COMMON && rel.is_empty() && name.eq_ignore_ascii_case("assets") {
                continue;
            }
            if ft.is_dir() {
                out.push(json!({
                    "path": r,
                    "name": name,
                    "type": "folder",
                }));
                out.extend(Self::walk_space(space, &r));
            } else if ft.is_file() && is_md(&name) {
                if let Ok(stat) = fs::metadata(abs(&space.root, &r)) {
                    let updated_at = stat
                        .modified()
                        .map(sys_time_to_iso)
                        .unwrap_or_else(|_| now_iso());
                    out.push(json!({
                        "path": r,
                        "name": strip_md_ext(&name),
                        "type": "file",
                        "updatedAt": updated_at,
                    }));
                }
            }
        }
        out
    }

    pub fn tree(
        store: &mut Store,
        common_root: &Path,
        space_id: &str,
    ) -> Result<Value, LofError> {
        let space = Self::resolve_space(store, common_root, space_id)?;
        let mut entries = Self::walk_space(&space, "");
        entries.sort_by(|a, b| {
            let pa = parent_of(a.get("path").and_then(|v| v.as_str()).unwrap_or(""));
            let pb = parent_of(b.get("path").and_then(|v| v.as_str()).unwrap_or(""));
            pa.cmp(pb)
                .then_with(|| {
                    let ta = a.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let tb = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if ta == tb {
                        std::cmp::Ordering::Equal
                    } else if ta == "folder" {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    }
                })
                .then_with(|| {
                    let na = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let nb = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    na.cmp(nb)
                })
        });

        if let Some(ref pid) = space.project_id {
            let p = store.get_project(pid)?;
            let docs = store.doc_files(&p);
            let archived_folders = Self::archived_folders(&p.project);
            for e in &mut entries {
                if e.get("type").and_then(Value::as_str) == Some("folder") {
                    let path = e.get("path").and_then(Value::as_str).unwrap_or("");
                    let archived = archived_folders
                        .iter()
                        .any(|p| p.eq_ignore_ascii_case(path));
                    e["archived"] = json!(archived);
                }
                if e.get("type").and_then(|v| v.as_str()) == Some("file") {
                    let epath = e.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let doc_rel = format!("doc/{}", epath);
                    if let Some(m) = docs
                        .iter()
                        .find(|d| d.get("path").and_then(|v| v.as_str()) == Some(&doc_rel))
                    {
                        if let Some(eobj) = e.as_object_mut() {
                            if let Some(k) = m.get("kind") {
                                eobj.insert("kind".to_string(), k.clone());
                            }
                            if let Some(ep_id) = m
                                .get("episodeId")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                            {
                                eobj.insert("episodeId".to_string(), json!(ep_id));
                            }
                        }
                    }
                }
            }
        }

        Ok(json!({
            "space": {
                "id": space.id,
                "title": space.title,
                "root": space.root.to_string_lossy().to_string(),
            },
            "entries": entries,
        }))
    }

    pub fn read(
        store: &mut Store,
        common_root: &Path,
        space_id: &str,
        rel: &str,
    ) -> Result<Value, LofError> {
        let space = Self::resolve_space(store, common_root, space_id)?;
        if !is_md(rel) {
            return Err(fail_invalid("Markdown 메모만 열 수 있습니다."));
        }
        let file = Self::space_abs(&space, rel)?;
        let raw = match fs::read_to_string(&file) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(fail("메모를 찾을 수 없습니다.", "NOT_FOUND"));
            }
            Err(e) => return Err(LofError::from(e)),
        };
        let stat = fs::metadata(&file)?;
        let parsed = read_markdown(&raw)?;
        let mlb = parsed
            .properties
            .get("manualLineBreak")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let updated_at = stat
            .modified()
            .map(sys_time_to_iso)
            .unwrap_or_else(|_| now_iso());
        let mut value = json!({
            "space": space.id,
            "path": rel,
            "id": parsed.properties.get("id").and_then(Value::as_str).filter(|id| valid_id(id))
                .map(|id| json!(id)).unwrap_or_else(|| json!(crate::store::memo_id(&space.id, &format!("doc/{rel}")))),
            "title": strip_md_ext(name_of(rel)),
            "body": parsed.body,
            "manualLineBreak": mlb,
            "revision": hash_str(&raw),
            "updatedAt": updated_at,
        });
        if space.id == COMMON {
            if let Err(error) = crate::common_memo_history::record(&space.root, rel, &raw, None) {
                value["historyWarning"] = json!(format!("공용 메모 이력을 기록하지 못했습니다: {}", error.message));
            }
        }
        Ok(value)
    }

    pub fn adopt(
        store: &mut Store, common_root: &Path, input: &Value,
    ) -> Result<Value, LofError> {
        let space = input["space"].as_str().unwrap_or("");
        let path = input["path"].as_str().unwrap_or("");
        if space == COMMON { return Err(fail_invalid("작품 메모만 자동으로 반영할 수 있습니다.")); }
        let current = Self::read(store, common_root, space, path)?;
        let mut args = json!({"id":current["id"],"syncToken":input["syncToken"],"discardDraft":input["discardDraft"]});
        if let Some(body) = input["draftBody"].as_str() {
            args["draft"] = json!({"id":current["id"],"body":body});
        }
        store.adopt_document(&args)?;
        Self::read(store, common_root, space, path)
    }

    pub fn save(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<Value, LofError> {
        let space_id = input.get("space").and_then(|v| v.as_str()).unwrap_or("");
        let rel = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let space = Self::resolve_space(store, common_root, space_id)?;
        if !is_md(rel) {
            return Err(fail_invalid("Markdown 메모만 저장할 수 있습니다."));
        }
        let Some(body) = input.get("body").and_then(|v| v.as_str()) else {
            return Err(fail_invalid("본문은 10MB 이하 문자열이어야 합니다."));
        };
        if utf16_len(body) > 10_000_000 {
            return Err(fail_invalid("본문은 10MB 이하 문자열이어야 합니다."));
        }
        let file = Self::space_abs(&space, rel)?;
        let raw = match fs::read_to_string(&file) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(fail("메모를 찾을 수 없습니다.", "NOT_FOUND"));
            }
            Err(e) => return Err(LofError::from(e)),
        };
        let expected_rev = input.get("expectedRevision").and_then(|v| v.as_str());
        if expected_rev.is_none() || expected_rev != Some(&hash_str(&raw)) {
            return Err(fail(
                "다른 곳에서 수정된 메모입니다. 현재 내용을 다시 확인해 주세요.",
                "CONFLICT",
            ));
        }
        let parsed = read_markdown(&raw)?;
        if body != parsed.body {
            if let Some(ref pid) = space.project_id {
                let doc_id = parsed
                    .properties
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| memo_id(pid, &format!("doc/{}", rel)));
                store.save(&json!({
                    "id": doc_id,
                    "body": body,
                    "expectedRevision": expected_rev,
                    "forceHistory": input.get("forceHistory").and_then(|v| v.as_bool()).unwrap_or(false),
                    "manualHistory": input.get("manualHistory").and_then(|v| v.as_bool()).unwrap_or(false),
                }))?;
            } else {
                crate::common_memo_history::record(&space.root, rel, &raw, None)?;
                let doc = markdown_entry(
                    &raw,
                    &json!({
                        "id": memo_id(COMMON, &format!("doc/{rel}")),
                        "kind": "memo",
                        "title": strip_md_ext(name_of(rel)),
                    }),
                )?;
                let mut dobj = doc.as_object().cloned().unwrap_or_default();
                dobj.insert("updatedAt".to_string(), json!(now_iso()));
                atomic_write_str(
                    &file,
                    &write_markdown(body, &Value::Object(dobj), &raw)?,
                )?;
            }
        }
        let mut saved = Self::read(store, common_root, &space.id, rel)?;
        if space.id == COMMON && (input["forceHistory"].as_bool() == Some(true) || input["manualHistory"].as_bool() == Some(true)) {
            let raw = fs::read_to_string(&file)?;
            if let Err(error) = crate::common_memo_history::record(&space.root, rel, &raw, Some("manual")) {
                saved["historyWarning"] = json!(format!("메모는 저장했지만 수동 저장 이력을 기록하지 못했습니다: {}", error.message));
            }
        }
        Ok(saved)
    }

    fn unique_in_space(space: &SpaceInfo, folder: &str, name: &str, ext: &str) -> String {
        let dir = if folder.is_empty() {
            space.root.clone()
        } else {
            abs(&space.root, folder)
        };
        let taken: HashSet<String> = fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        let mut candidate = format!("{}{}", name, ext);
        let mut n = 2;
        while taken.contains(&candidate.to_lowercase()) {
            candidate = format!("{} ({}){}", name, n, ext);
            n += 1;
        }
        join_rel(folder, &candidate)
    }

    fn validate_folder<'a>(space: &SpaceInfo, folder: Option<&'a str>) -> Result<&'a str, LofError> {
        let Some(f) = folder.filter(|s| !s.is_empty()) else {
            return Ok("");
        };
        Self::space_abs(space, f)?;
        Ok(f)
    }

    pub fn restore_common_copy(
        store: &mut Store,
        common_root: &Path,
        key: &str,
    ) -> Result<Value, LofError> {
        let copy = store.read_recovery_copy(key)?;
        let document = &copy["document"];
        let body = document["body"].as_str().ok_or_else(|| fail_invalid("복구 사본의 본문을 읽을 수 없습니다."))?;
        let space = Self::resolve_space(store, common_root, COMMON)?;
        let title = format!("{} (복구 사본)", document["title"].as_str().unwrap_or("제목 없음"));
        let rel = Self::unique_in_space(&space, "", &safe_name(&title, "복구 사본"), ".md");
        let path = Self::space_abs(&space, &rel)?;
        let mut fields = document.as_object().cloned().unwrap_or_default();
        for key in ["body", "projectId", "space", "path", "relPath", "revision", "expectedRevision", "historyWarning"] {
            fields.remove(key);
        }
        fields.insert("id".into(), json!(Uuid::new_v4().to_string()));
        fields.insert("kind".into(), json!("memo"));
        fields.insert("title".into(), json!(title));
        fields.insert("archived".into(), json!(false));
        fields.insert("createdAt".into(), json!(now_iso()));
        fields.insert("updatedAt".into(), json!(now_iso()));
        atomic_write_str(&path, &write_markdown(body, &Value::Object(fields), "")?)?;
        Self::read(store, common_root, COMMON, &rel)
    }

    pub fn create(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<Value, LofError> {
        let space_id = input.get("space").and_then(|v| v.as_str()).unwrap_or("");
        let space = Self::resolve_space(store, common_root, space_id)?;
        let folder = Self::validate_folder(&space, input.get("folder").and_then(|v| v.as_str()))?;
        let body = input
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if utf16_len(&body) > 10_000_000 {
            return Err(fail_invalid("본문은 10MB 이하만 지원합니다."));
        }
        if let Some(ref pid) = space.project_id {
            let mut create_in = input.as_object().cloned().unwrap_or_default();
            create_in.insert("projectId".to_string(), json!(pid));
            create_in.insert("kind".to_string(), json!("memo"));
            create_in.insert("folder".to_string(), json!(folder));
            create_in.insert("body".to_string(), json!(body));
            let doc = store.create(&Value::Object(create_in))?;
            let rel_path = doc.get("relPath").and_then(|v| v.as_str()).unwrap_or("");
            let sub = if rel_path.starts_with("doc/") {
                &rel_path[4..]
            } else {
                rel_path
            };
            return Self::read(store, common_root, &space.id, sub);
        }
        let title_in = input.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let rel = Self::unique_in_space(&space, folder, &safe_name(title_in, "새 메모"), ".md");
        let now = now_iso();
        let content = write_markdown(
            &body,
            &json!({
                "id": Uuid::new_v4().to_string(),
                "kind": "memo",
                "title": strip_md_ext(name_of(&rel)),
                "createdAt": now,
                "updatedAt": now,
            }),
            "",
        )?;
        atomic_write_str(&abs(&space.root, &rel), &content)?;
        Self::read(store, common_root, &space.id, &rel)
    }

    pub fn create_folder(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<Value, LofError> {
        let space_id = input.get("space").and_then(|v| v.as_str()).unwrap_or("");
        let space = Self::resolve_space(store, common_root, space_id)?;
        let parent = Self::validate_folder(&space, input.get("parent").and_then(|v| v.as_str()))?;
        let name_in = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let rel = Self::unique_in_space(&space, parent, &safe_name(name_in, "새 폴더"), "");
        fs::create_dir_all(abs(&space.root, &rel))?;
        Ok(json!({ "path": rel }))
    }

    pub fn archive_folder(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<bool, LofError> {
        let space_id = input.get("space").and_then(Value::as_str).unwrap_or("");
        let path = input.get("path").and_then(Value::as_str).unwrap_or("");
        let archived = input
            .get("archived")
            .and_then(Value::as_bool)
            .ok_or_else(|| fail_invalid("잘못된 보관 상태"))?;
        let space = Self::resolve_space(store, common_root, space_id)?;
        if !fs::metadata(Self::space_abs(&space, path)?)?.is_dir() {
            return Err(fail_invalid("폴더만 보관할 수 있습니다."));
        }
        let pid = space
            .project_id
            .as_deref()
            .ok_or_else(|| fail_invalid("작품의 문서 폴더만 보관할 수 있습니다."))?;
        let p = store.get_project(pid)?;
        let prefix = format!("doc/{}/", path);
        for doc in store.doc_files(&p) {
            if !doc
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|p| p.starts_with(&prefix))
                || doc
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    == archived
            {
                continue;
            }
            let id = doc.get("id").and_then(Value::as_str).unwrap_or("");
            let current = store.read(id)?;
            store.save(&json!({ "id": id, "expectedRevision": current.get("revision"), "archived": archived }))?;
        }
        let mut p = store.get_project(pid)?;
        let prefix = format!("{}/", path);
        let mut folders = Self::archived_folders(&p.project);
        folders.retain(|p| p != path && !p.starts_with(&prefix));
        if archived {
            folders.push(path.to_string());
            folders.extend(
                Self::walk_space(&space, path)
                    .into_iter()
                    .filter(|e| e.get("type").and_then(Value::as_str) == Some("folder"))
                    .filter_map(|e| e.get("path").and_then(Value::as_str).map(str::to_string)),
            );
        }
        Self::set_archived_folders(&mut p.project, folders);
        store.write_project(&p)?;
        Ok(true)
    }

    pub fn rename(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<Value, LofError> {
        let space_id = input.get("space").and_then(|v| v.as_str()).unwrap_or("");
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let name_in = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let space = Self::resolve_space(store, common_root, space_id)?;
        let file = Self::space_abs(&space, path)?;
        let stat = fs::metadata(&file)?;
        let ext = if stat.is_dir() { "" } else { ".md" };
        let fallback = if stat.is_dir() { "새 폴더" } else { "새 메모" };
        let name = safe_name(name_in, fallback);
        let cur_name = name_of(path);
        let cand_name = format!("{}{}", name, ext);
        if cand_name == cur_name {
            return Ok(json!({ "path": path }));
        }
        let target = if cand_name.eq_ignore_ascii_case(cur_name) {
            join_rel(parent_of(path), &cand_name)
        } else {
            Self::unique_in_space(&space, parent_of(path), &name, ext)
        };
        Self::relocate(store, &space, path, &target)?;
        Ok(json!({ "path": target }))
    }

    pub fn move_entry(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<Value, LofError> {
        let space_id = input.get("space").and_then(|v| v.as_str()).unwrap_or("");
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let space = Self::resolve_space(store, common_root, space_id)?;
        Self::space_abs(&space, path)?;
        let to = Self::validate_folder(&space, input.get("to").and_then(|v| v.as_str()))?;
        if to == path || to.starts_with(&format!("{}/", path)) {
            return Err(fail_invalid("폴더를 자기 안으로 옮길 수 없습니다."));
        }
        if parent_of(path) == to {
            return Ok(json!({ "path": path }));
        }
        let stat = fs::metadata(abs(&space.root, path))?;
        if !to.is_empty() && !fs::metadata(abs(&space.root, to))?.is_dir() {
            return Err(fail_invalid("폴더로만 옮길 수 있습니다."));
        }
        let ext = if stat.is_dir() { "" } else { ".md" };
        let cur_name = name_of(path);
        let stem = &cur_name[..cur_name.len().saturating_sub(ext.len())];
        let target = Self::unique_in_space(&space, to, stem, ext);
        Self::relocate(store, &space, path, &target)?;
        Ok(json!({ "path": target }))
    }

    fn files_under(space: &SpaceInfo, rel: &str) -> Result<Vec<String>, LofError> {
        let stat = fs::metadata(abs(&space.root, rel))?;
        if !stat.is_dir() {
            return Ok(if is_md(rel) {
                vec![rel.to_string()]
            } else {
                Vec::new()
            });
        }
        Ok(Self::walk_space(space, rel)
            .into_iter()
            .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("file"))
            .filter_map(|e| e.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect())
    }

    fn relocate(
        store: &mut Store,
        space: &SpaceInfo,
        from: &str,
        to: &str,
    ) -> Result<(), LofError> {
        let before = Self::files_under(space, from)?;
        if space.project_id.is_none() {
            for path in &before {
                crate::common_memo_history::prepare_move(&space.root, path)?;
            }
        }
        let temp = format!("{}.{}.lofmv", from, Uuid::new_v4().simple());
        rename_with_retry(&abs(&space.root, from), &abs(&space.root, &temp))?;
        if let Err(e) = rename_with_retry(&abs(&space.root, &temp), &abs(&space.root, to)) {
            let _ = rename_with_retry(&abs(&space.root, &temp), &abs(&space.root, from));
            return Err(fail(
                format!(
                    "이름을 바꾸지 못했습니다. 다른 프로그램에서 열려 있는지 확인해 주세요. ({})",
                    e.message
                ),
                "RENAME",
            ));
        }

        if let Some(proj_folder) = space
            .root
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
        {
            store.invalidate_path(&format!("{}/doc/{}", proj_folder, from));
            store.invalidate_path(&format!("{}/doc/{}", proj_folder, to));
        }

        if let Some(ref pid) = space.project_id {
            let mut p = store.get_project(pid)?;
            let mut changed =
                Store::move_doc_meta(&mut p, &format!("doc/{}", from), &format!("doc/{}", to));
            let prefix = format!("{}/", from);
            let folders = Self::archived_folders(&p.project)
                .into_iter()
                .map(|path| {
                    if path == from || path.starts_with(&prefix) {
                        changed = true;
                        format!("{}{}", to, &path[from.len()..])
                    } else {
                        path
                    }
                })
                .collect();
            Self::set_archived_folders(&mut p.project, folders);
            if changed {
                store.write_project(&p)?;
            }
            if is_md(from)
                && before.len() == 1
                && before[0] == from
                && name_of(from) != name_of(to)
            {
                let file = abs(&space.root, to);
                let raw = fs::read_to_string(&file)?;
                let doc = markdown_entry(
                    &raw,
                    &json!({
                        "kind": "memo",
                        "title": strip_md_ext(name_of(from)),
                    }),
                )?;
                let mut dobj = doc.as_object().cloned().unwrap_or_default();
                dobj.insert("title".to_string(), json!(strip_md_ext(name_of(to))));
                dobj.insert("updatedAt".to_string(), json!(now_iso()));
                let body = read_markdown(&raw)?.body;
                atomic_write_str(&file, &write_markdown(&body, &Value::Object(dobj), &raw)?)?;
            }
        }
        Ok(())
    }

    pub fn remove(
        store: &mut Store,
        common_root: &Path,
        input: &Value,
    ) -> Result<bool, LofError> {
        let space_id = input.get("space").and_then(|v| v.as_str()).unwrap_or("");
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let space = Self::resolve_space(store, common_root, space_id)?;
        let file = Self::space_abs(&space, path)?;
        let files = if space.project_id.is_some() {
            Self::files_under(&space, path)?
        } else {
            Vec::new()
        };
        let mut ids: HashMap<String, String> = HashMap::new();
        let mut protected = HashSet::new();
        let is_folder = fs::metadata(&file)?.is_dir();
        let archived = input
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(ref pid) = space.project_id {
            let p = store.get_project(pid)?;
            let docs = store.doc_files(&p);
            // 폴더를 지워도 다른 보기의 문서는 원래 경로와 속성을 유지한다.
            if is_folder {
                let archived_folders = Self::archived_folders(&p.project);
                for entry in Self::walk_space(&space, path) {
                    let rel = entry.get("path").and_then(Value::as_str).unwrap_or("");
                    if entry.get("type").and_then(Value::as_str) == Some("folder")
                        && archived_folders.iter().any(|p| p.eq_ignore_ascii_case(rel)) != archived
                    {
                        protected.insert(rel.to_string());
                    }
                }
            }
            for rel in &files {
                let raw = fs::read_to_string(abs(&space.root, rel))?;
                let parsed = read_markdown(&raw)?;
                let doc_rel = format!("doc/{}", rel);
                let entry = docs
                    .iter()
                    .find(|d| d.get("path").and_then(Value::as_str) == Some(&doc_rel));
                let is_archived = parsed
                    .properties
                    .get("archived")
                    .or_else(|| entry.and_then(|d| d.get("archived")))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if is_folder && is_archived != archived {
                    protected.insert(rel.clone());
                    continue;
                }
                let id = parsed
                    .properties
                    .get("id")
                    .or_else(|| entry.and_then(|d| d.get("id")))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| memo_id(pid, &format!("doc/{}", rel)));
                ids.insert(rel.clone(), id);
            }
        }

        let mut retained_folders = Vec::new();
        Self::trash_except(store, &space, path, &protected, &mut retained_folders)?;
        if let Some(ref pid) = space.project_id {
            if let Some(proj_folder) = space
                .root
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
            {
                store.invalidate_path(&format!("{}/doc/{}", proj_folder, path));
            }
            let mut p = store.get_project(pid)?;
            if protected.is_empty() {
                Store::drop_doc_meta(&mut p, &format!("doc/{}", path));
            } else {
                for rel in ids.keys() {
                    Store::drop_doc_meta(&mut p, &format!("doc/{}", rel));
                }
            }
            let prefix = format!("{}/", path);
            let mut folders = Self::archived_folders(&p.project);
            folders.retain(|p| p != path && !p.starts_with(&prefix));
            if !archived {
                folders.extend(retained_folders);
            }
            Self::set_archived_folders(&mut p.project, folders);
            store.write_project(&p)?;
            for rel in &files {
                if let Some(id) = ids.get(rel) {
                    let _ = store.clear_draft(id);
                    store.tombstone(id, pid, &now_iso())?;
                }
            }
        }
        Ok(true)
    }

    fn trash_except(
        store: &Store,
        space: &SpaceInfo,
        path: &str,
        protected: &HashSet<String>,
        retained_folders: &mut Vec<String>,
    ) -> Result<(), LofError> {
        let file = Self::space_abs(space, path)?;
        let prefix = format!("{}/", path);
        let keep = protected.contains(path) || protected.iter().any(|p| p.starts_with(&prefix));
        if !keep {
            return store.trash_path(&file);
        }
        if !fs::symlink_metadata(&file)?.is_dir() {
            return Ok(());
        }
        // 목록을 먼저 읽어 삭제 범위를 확정한 뒤 보존 대상이 없는 항목만 휴지통으로 옮긴다.
        let entries = fs::read_dir(&file)?.collect::<Result<Vec<_>, _>>()?;
        for entry in entries {
            let rel = join_rel(path, &entry.file_name().to_string_lossy());
            Self::trash_except(store, space, &rel, protected, retained_folders)?;
        }
        retained_folders.push(path.to_string());
        Ok(())
    }

    pub fn search_text(
        store: &mut Store,
        common_root: &Path,
        space_id: &str,
        query: &str,
        case_sensitive: bool,
    ) -> Result<Value, LofError> {
        let raw = query.trim();
        if raw.is_empty() || raw.starts_with('#') {
            return Ok(json!({ "files": [], "results": [] }));
        }
        let space = Self::resolve_space(store, common_root, space_id)?;
        let norm = |t: &str| -> String {
            if case_sensitive {
                t.to_string()
            } else {
                t.to_lowercase()
            }
        };
        let q = norm(raw);
        let mut files = Vec::new();
        let mut results = Vec::new();

        let space_root_str = space.root.to_string_lossy().to_string();
        if store.index.common.root != space_root_str {
            store.index.common.root = space_root_str.clone();
            store.index.common.files.clear();
        }
        let mut changed = false;

        for e in Self::walk_space(&space, "") {
            if e.get("type").and_then(|v| v.as_str()) != Some("file") {
                continue;
            }
            let epath = e.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let ename = e.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if norm(epath).contains(&q) {
                files.push(json!({
                    "space": space.id,
                    "path": epath,
                    "name": ename,
                }));
            }
            let file = abs(&space.root, epath);
            let stamp = store.stamp(&file)?.unwrap_or_default();
            let needs_reindex = store
                .index
                .common
                .files
                .get(epath)
                .is_none_or(|ix| ix.stamp != stamp);
            let indexed_id = if needs_reindex {
                let raw_file = fs::read_to_string(&file).unwrap_or_default();
                let parsed = read_markdown(&raw_file).ok();
                let id = parsed
                    .as_ref()
                    .and_then(|p| p.properties.get("id").and_then(|v| v.as_str()))
                    .filter(|s| valid_id(s))
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| hash_str(&format!("{}/{}", space_root_str, epath)));
                let body = parsed.map(|p| p.body).unwrap_or_default();
                let _ = store.index.cache_body("common", &id, &body);
                store.index.common.files.insert(
                    epath.to_string(),
                    CommonIndexedFile {
                        id: id.clone(),
                        stamp,
                    },
                );
                changed = true;
                id
            } else {
                store.index.common.files[epath].id.clone()
            };

            let body = match store.index.body("common", &indexed_id) {
                Ok(b) => b,
                Err(_) => {
                    let raw_file = fs::read_to_string(&file).unwrap_or_default();
                    let b = read_markdown(&raw_file).map(|p| p.body).unwrap_or_default();
                    let _ = store.index.cache_body("common", &indexed_id, &b);
                    b
                }
            };

            let (found_matches, _) = match_lines(&body, raw, case_sensitive, 50);
            if !found_matches.is_empty() {
                results.push(json!({
                    "space": space.id,
                    "path": epath,
                    "name": ename,
                    "matches": found_matches,
                }));
            }
            if results.len() >= 200 {
                break;
            }
        }

        if changed {
            if let Some(ref cat) = store.catalog {
                let vault_id = store
                    .vault
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = store.index.save(&vault_id, cat);
            }
        }

        Ok(json!({ "files": files, "results": results }))
    }

    pub fn locate(
        store: &mut Store,
        common_root: &Path,
        space_id: &str,
        rel: Option<&str>,
    ) -> Result<PathBuf, LofError> {
        let space = Self::resolve_space(store, common_root, space_id)?;
        if let Some(r) = rel.filter(|s| !s.is_empty()) {
            Self::space_abs(&space, r)
        } else {
            Ok(space.root)
        }
    }
}
