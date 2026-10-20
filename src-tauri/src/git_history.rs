use crate::error::{fail, fail_invalid, valid_id, LofError};
use crate::local_git::{flatten, json_bytes, put, read_document, read_json, tree, LocalHistory};
use git2::{Commit, Oid, Repository, Signature, Sort};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;

const MAIN: &str = "refs/heads/main";

fn latest(repo: &Repository) -> Result<Commit<'_>, LofError> {
    Ok(repo.find_reference(MAIN)?.peel_to_commit()?)
}

fn document_tree(commit: &Commit<'_>, id: &str) -> Result<Option<Oid>, LofError> {
    let tree = commit.tree()?;
    match tree.get_path(Path::new(&format!("documents/{id}"))) {
        Ok(entry) => Ok(Some(entry.id())),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn changed(commit: &Commit<'_>, id: &str) -> Result<bool, LofError> {
    let Some(current) = document_tree(commit, id)? else {
        return Ok(false);
    };
    Ok(commit.parent_count() == 0 || document_tree(&commit.parent(0)?, id)? != Some(current))
}

fn walk(repo: &Repository, head: Oid) -> Result<git2::Revwalk<'_>, LofError> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push(head)?;
    Ok(walk)
}

fn checked_commit<'a>(repo: &'a Repository, name: &str) -> Result<Commit<'a>, LofError> {
    let hex = name
        .strip_prefix("git-")
        .filter(|hex| hex.len() == 40 && hex.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| fail_invalid("잘못된 Git 이력 식별자입니다."))?;
    let oid = Oid::from_str(hex)?;
    let head = latest(repo)?.id();
    if oid != head && !repo.graph_descendant_of(head, oid)? {
        return Err(fail("이 서재에서 찾을 수 없는 이력입니다.", "NOT_FOUND"));
    }
    Ok(repo.find_commit(oid)?)
}

fn time(commit: &Commit<'_>) -> String {
    chrono::DateTime::from_timestamp(commit.author().when().seconds(), 0)
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

impl LocalHistory {
    pub fn history_page(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
        anchor: Option<&str>,
        policy: crate::store::HistoryPolicy,
    ) -> Result<Value, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID입니다."));
        }
        let repo = self.repository()?;
        let head = match anchor {
            Some(anchor) => checked_commit(&repo, &format!("git-{anchor}"))?.id(),
            None => latest(&repo)?.id(),
        };
        let mut manual = HashSet::new();
        let mut restored = HashSet::new();
        let mut before_restore = HashSet::new();
        for (kind, marks) in [
            ("manual", &mut manual),
            ("restore", &mut restored),
            ("before-restore", &mut before_restore),
        ] {
            for reference in repo.references_glob(&format!("refs/lof/{kind}/{id}/*"))? {
                let reference = reference?;
                if let Some(target) = reference.target() {
                    marks.insert(target);
                }
            }
        }
        let keep_count = policy.keep_count.max(1);
        let cutoff = chrono::Utc::now() - chrono::Duration::days(policy.keep_days.max(1));
        let mut entries = Vec::new();
        let mut skipped = 0;
        let mut total_for_doc = 0;
        for oid in walk(&repo, head)? {
            let commit = repo.find_commit(oid?)?;
            if !changed(&commit, id)? {
                continue;
            }
            let value = read_json(
                &repo,
                &commit.tree()?,
                &format!("documents/{id}/metadata.json"),
            )?;
            let legacy = commit.message()?.contains("\nLof-Legacy: ");
            let saved_at = if legacy {
                value["savedAt"].as_str().unwrap_or(&time(&commit)).to_string()
            } else {
                time(&commit)
            };
            if total_for_doc >= keep_count {
                break;
            }
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&saved_at) {
                if parsed.with_timezone(&chrono::Utc) < cutoff {
                    break;
                }
            }
            total_for_doc += 1;
            if skipped < offset {
                skipped += 1;
                continue;
            }
            let kind = if manual.contains(&commit.id()) || value["manual"].as_bool() == Some(true) {
                "manual"
            } else if restored.contains(&commit.id())
                || value["recordKind"].as_str() == Some("restore")
            {
                "restore"
            } else if before_restore.contains(&commit.id()) {
                "beforeRestore"
            } else if legacy {
                "legacy"
            } else {
                "auto"
            };
            entries.push(json!({"name":format!("git-{}",commit.id()),"commit":commit.id().to_string(),
                "savedAt":saved_at,"title":value["title"],"kind":kind}));
            if entries.len() > limit {
                break;
            }
        }
        let more = entries.len() > limit;
        entries.truncate(limit);
        Ok(
            json!({"entries":entries,"nextOffset":if more{Some(offset+limit)}else{None},"anchor":head.to_string(),"migrating":false}),
        )
    }

    pub fn latest_document(&self, id: &str) -> Result<Option<(u64, String)>, LofError> {
        if !valid_id(id) {
            return Ok(None);
        }
        let repo = self.repository()?;
        let Ok(head) = latest(&repo) else {
            return Ok(None);
        };
        for oid in walk(&repo, head.id())? {
            let commit = repo.find_commit(oid?)?;
            if !changed(&commit, id)? {
                continue;
            }
            let doc = read_document(&repo, &commit.tree()?, id)?;
            let body = doc["body"].as_str().unwrap_or("").to_string();
            let at = (commit.author().when().seconds().max(0) as u64) * 1000;
            return Ok(Some((at, body)));
        }
        Ok(None)
    }

    pub fn history_read(&self, id: &str, name: &str) -> Result<Value, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID입니다."));
        }
        let repo = self.repository()?;
        let commit = checked_commit(&repo, name)?;
        let value = read_document(&repo, &commit.tree()?, id)?;
        // 이관한 기록의 원래 속성과 새 Git 기록의 문서 속성을 같은 복원 형식으로 돌려준다.
        if value["attributes"].is_object() {
            return Ok(value);
        }
        Ok(crate::database::history_value(&value, &time(&commit)))
    }

    pub fn mark(&self, id: &str, kind: &str) -> Result<bool, LofError> {
        if !valid_id(id) || !matches!(kind, "manual" | "restore" | "before-restore") {
            return Err(fail_invalid("기록 표시가 올바르지 않습니다."));
        }
        let repo = self.repository()?;
        for oid in walk(&repo, latest(&repo)?.id())? {
            let commit = repo.find_commit(oid?)?;
            if !changed(&commit, id)? {
                continue;
            }
            let reference = format!("refs/lof/{kind}/{id}/{}", commit.id());
            match repo.find_reference(&reference) {
                Ok(_) => return Ok(false),
                Err(error) if error.code() == git2::ErrorCode::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            repo.reference(&reference, commit.id(), false, "원고 기록 종류 표시")?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn capture_document(
        &mut self,
        id: &str,
        document: &Value,
        message: &str,
    ) -> Result<(), LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID입니다."));
        }
        let repo = self.repository()?;
        let previous = latest(&repo)?;
        let mut files = BTreeMap::new();
        flatten(&repo, &previous.tree()?, "", &mut files)?;
        let mut metadata = document.clone();
        let fields = metadata
            .as_object_mut()
            .ok_or_else(|| fail_invalid("원고 속성이 없습니다."))?;
        for key in ["body", "revision", "fingerprint", "path"] {
            fields.remove(key);
        }
        let body = document["body"]
            .as_str()
            .ok_or_else(|| fail_invalid("원고 본문이 없습니다."))?;
        put(
            &repo,
            &mut files,
            &format!("documents/{id}/body.md"),
            body.as_bytes(),
        )?;
        put(
            &repo,
            &mut files,
            &format!("documents/{id}/metadata.json"),
            &json_bytes(&metadata)?,
        )?;
        let next = tree(&repo, &files)?;
        if previous.tree_id() != next {
            let sig = Signature::now("Lof Writer", "local@lof-writer.invalid")?;
            self.head = repo
                .commit(
                    Some(MAIN),
                    &sig,
                    &sig,
                    message,
                    &repo.find_tree(next)?,
                    &[&previous],
                )?
                .to_string();
        }
        Ok(())
    }

    pub fn backup(&self, destination: &Path) -> Result<(), LofError> {
        let repo = self.repository()?;
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let mut archive = zip::ZipWriter::new(file);
        fn visit(
            root: &Path,
            directory: &Path,
            archive: &mut zip::ZipWriter<fs::File>,
        ) -> Result<(), LofError> {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    return Err(fail_invalid("연결된 Git 파일은 백업할 수 없습니다."));
                }
                let path = entry.path();
                if kind.is_dir() {
                    visit(root, &path, archive)?;
                } else if kind.is_file() {
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|_| fail_invalid("백업 경로가 올바르지 않습니다."))?;
                    let name = format!("git/{}", relative.to_string_lossy().replace('\\', "/"));
                    archive
                        .start_file(name, zip::write::SimpleFileOptions::default())
                        .map_err(|error| fail_invalid(error.to_string()))?;
                    io::copy(&mut fs::File::open(path)?, archive)?;
                }
            }
            Ok(())
        }
        visit(repo.path(), repo.path(), &mut archive)?;
        let vault = repo
            .path()
            .parent()
            .ok_or_else(|| fail_invalid("서재 경로가 없습니다."))?
            .join("vault.json");
        archive
            .start_file("vault.json", zip::write::SimpleFileOptions::default())
            .map_err(|error| fail_invalid(error.to_string()))?;
        io::copy(&mut fs::File::open(vault)?, &mut archive)?;
        archive
            .finish()
            .map_err(|error| fail_invalid(error.to_string()))?
            .sync_all()?;
        Ok(())
    }
}

pub fn comparison(old: &str, current: &str) -> Result<Value, LofError> {
    if old.len() + current.len() > 4_000_000 {
        return Ok(
            json!({"available":false,"message":"원고가 커서 변경 비교를 생략했습니다. 원고 보기에서 내용을 확인해 주세요."}),
        );
    }
    let mut patch = git2::Patch::from_buffers(
        old.as_bytes(),
        Some(Path::new("이전 원고")),
        current.as_bytes(),
        Some(Path::new("현재 원고")),
        None,
    )?;
    let (_, added, removed) = patch.line_stats()?;
    let buffer = patch.to_buf()?;
    let text = String::from_utf8_lossy(&buffer);
    // 첫 변경 구간 앞의 파일 헤더만 제외한다. 본문에 있는 ---와 +++도 변경으로 표시한다.
    let visible = || text.lines().skip_while(|line| !line.starts_with("@@ "));
    let lines: Vec<_> = visible().take(3000).map(|line| json!({"text":line,
        "kind":if line.starts_with('+'){"added"}else if line.starts_with('-'){"removed"}else{"context"}})).collect();
    Ok(
        json!({"available":true,"added":added,"removed":removed,"lines":lines,"truncated":visible().count()>3000}),
    )
}
