use crate::error::{fail_invalid, valid_id, LofError};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct CommonIndexCache {
    pub root: String,
    pub files: HashMap<String, CommonIndexedFile>,
}

#[derive(Debug, Clone)]
pub struct CommonIndexedFile {
    pub id: String,
    pub stamp: String,
}

#[derive(Debug, Clone)]
pub struct IndexedFileRecord {
    pub entry: Value,
    pub doc: Value,
    pub stamp: String,
}

#[derive(Debug, Clone)]
pub struct CatalogProject {
    pub dir: PathBuf,
    pub project: Value,
    pub from_backup: bool,
    pub files: HashMap<String, IndexedFileRecord>,
    pub errors: HashMap<String, String>,
    pub project_stamp: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Catalog {
    pub projects: Vec<CatalogProject>,
    pub warnings: Vec<String>,
}

pub struct FileIndex {
    pub root: PathBuf,
    pub file: PathBuf,
    pub bodies: HashMap<String, String>,
    pub dirty: HashSet<String>,
    pub common: CommonIndexCache,
}

impl FileIndex {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            file: root.join(".lof").join("index.json"),
            bodies: HashMap::new(),
            dirty: HashSet::new(),
            common: CommonIndexCache {
                root: String::new(),
                files: HashMap::new(),
            },
        }
    }

    pub fn load(&mut self, vault_id: &str) -> Option<Catalog> {
        let raw = fs::read_to_string(&self.file).ok()?;
        let data: Value = serde_json::from_str(&raw).ok()?;
        if data.get("version").and_then(|v| v.as_i64()) != Some(1)
            || data.get("vaultId").and_then(|v| v.as_str()) != Some(vault_id)
        {
            return None;
        }
        let projects_arr = data.get("projects")?.as_array()?;
        let mut projects = Vec::with_capacity(projects_arr.len());

        for p in projects_arr {
            let folder = p.get("folder")?.as_str()?;
            if folder.is_empty()
                || folder.starts_with('.')
                || folder.chars().any(|c| {
                    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                        || (c as u32) <= 0x1f
                })
                || Path::new(folder).file_name().and_then(|n| n.to_str()) != Some(folder)
            {
                return None;
            }
            let proj_obj = p.get("project")?;
            let proj_id = proj_obj.get("id")?.as_str()?;
            if !valid_id(proj_id) {
                return None;
            }
            let files_obj = p.get("files")?.as_object()?;
            let dir = self.root.join(folder);
            let mut files_map = HashMap::new();

            for (rel, f) in files_obj {
                let low = rel.to_ascii_lowercase();
                if !(low.starts_with("episodes/") || low.starts_with("doc/"))
                    || !low.ends_with(".md")
                {
                    return None;
                }
                if rel
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
                {
                    return None;
                }
                let entry = f.get("entry")?;
                let entry_id = entry.get("id")?.as_str()?;
                let entry_path = entry.get("path")?.as_str()?;
                let mut doc = f.get("doc")?.clone();
                let doc_id = doc.get("id")?.as_str()?;
                if !valid_id(entry_id) || entry_path != rel || doc_id != entry_id {
                    return None;
                }
                let stamp = f
                    .get("stamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let mut full_path = dir.clone();
                for seg in rel.split('/') {
                    full_path.push(seg);
                }
                if let Some(doc_obj) = doc.as_object_mut() {
                    doc_obj.insert(
                        "path".to_string(),
                        json!(full_path.to_string_lossy().to_string()),
                    );
                    doc_obj.insert("relPath".to_string(), json!(rel));
                }
                files_map.insert(
                    rel.clone(),
                    IndexedFileRecord {
                        entry: entry.clone(),
                        doc,
                        stamp,
                    },
                );
            }

            let mut errors_map = HashMap::new();
            if let Some(errs) = p.get("errors").and_then(|v| v.as_object()) {
                for (k, v) in errs {
                    if let Some(s) = v.as_str() {
                        errors_map.insert(k.clone(), s.to_string());
                    }
                }
            }

            projects.push(CatalogProject {
                dir,
                project: proj_obj.clone(),
                from_backup: p
                    .get("fromBackup")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                files: files_map,
                errors: errors_map,
                project_stamp: p
                    .get("projectStamp")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }

        if let Some(common_obj) = data.get("common").and_then(|v| v.as_object()) {
            if let (Some(root_str), Some(cfiles)) = (
                common_obj.get("root").and_then(|v| v.as_str()),
                common_obj.get("files").and_then(|v| v.as_object()),
            ) {
                let mut valid_common = true;
                let mut map = HashMap::new();
                for (k, v) in cfiles {
                    if let Some(id_str) = v.get("id").and_then(|x| x.as_str()) {
                        if valid_id(id_str) {
                            let stamp_str = v
                                .get("stamp")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            map.insert(
                                k.clone(),
                                CommonIndexedFile {
                                    id: id_str.to_string(),
                                    stamp: stamp_str,
                                },
                            );
                        } else {
                            valid_common = false;
                            break;
                        }
                    } else {
                        valid_common = false;
                        break;
                    }
                }
                if valid_common {
                    self.common = CommonIndexCache {
                        root: root_str.to_string(),
                        files: map,
                    };
                }
            }
        }

        let warnings = data
            .get("warnings")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        Some(Catalog { projects, warnings })
    }

    pub fn body_file(&self, project_id: &str, id: &str) -> Result<PathBuf, LofError> {
        if !valid_id(project_id) || !valid_id(id) {
            return Err(fail_invalid("검색 캐시의 문서 ID가 올바르지 않습니다."));
        }
        Ok(self
            .root
            .join(".lof")
            .join("search")
            .join(project_id)
            .join(format!("{}.txt", id)))
    }

    pub fn cache_body(&mut self, project_id: &str, id: &str, body: &str) -> Result<(), LofError> {
        let key = format!("{}:{}", project_id, id);
        self.bodies.insert(key, body.to_string());
        let f = self.body_file(project_id, id)?;
        crate::store::atomic_write_str(&f, body)?;
        Ok(())
    }

    pub fn body(&mut self, project_id: &str, id: &str) -> Result<String, LofError> {
        let key = format!("{}:{}", project_id, id);
        if let Some(b) = self.bodies.get(&key) {
            return Ok(b.clone());
        }
        let f = self.body_file(project_id, id)?;
        let content = fs::read_to_string(f)?;
        self.bodies.insert(key, content.clone());
        Ok(content)
    }

    pub fn save(&self, vault_id: &str, catalog: &Catalog) -> Result<(), LofError> {
        let projects_json: Vec<Value> = catalog
            .projects
            .iter()
            .map(|p| {
                let folder = p
                    .dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let mut files_obj = serde_json::Map::new();
                for (rel, rec) in &p.files {
                    files_obj.insert(
                        rel.clone(),
                        json!({
                            "entry": rec.entry,
                            "doc": rec.doc,
                            "stamp": rec.stamp,
                        }),
                    );
                }
                let mut errors_obj = serde_json::Map::new();
                for (k, v) in &p.errors {
                    errors_obj.insert(k.clone(), json!(v));
                }
                json!({
                    "folder": folder,
                    "project": p.project,
                    "fromBackup": p.from_backup,
                    "files": files_obj,
                    "errors": errors_obj,
                    "projectStamp": p.project_stamp,
                })
            })
            .collect();

        let mut common_files = serde_json::Map::new();
        for (k, v) in &self.common.files {
            common_files.insert(
                k.clone(),
                json!({
                    "id": v.id,
                    "stamp": v.stamp,
                }),
            );
        }

        let payload = serde_json::to_string(&json!({
            "version": 1,
            "vaultId": vault_id,
            "projects": projects_json,
            "common": {
                "root": self.common.root,
                "files": common_files,
            },
            "warnings": catalog.warnings,
        }))
        .unwrap_or_default();

        crate::store::atomic_write_str(&self.file, &payload)
    }
}
