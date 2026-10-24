use crate::error::{fail, fail_invalid, valid_id, LofError};
use crate::local_git::{
    put_document, read_document, read_json, update_tree, LocalHistory,
};
use git2::{Commit, Oid, Repository, Signature, Sort};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
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

fn content_key(commit: &Commit<'_>, id: &str, metadata: &Value) -> Result<String, LofError> {
    let body = commit.tree()?.get_path(Path::new(&format!("documents/{id}/body.md")))?.id();
    Ok(format!("{}:{}", body, crate::database::history_metadata_key(metadata)))
}

// Git 커밋은 다른 문서와 공유하므로 중복 자동 기록만 문서별 삭제 표시로 정리한다.
fn discard_automatic_duplicates(repo: &Repository, id: &str, manual: &Commit<'_>) -> Result<usize, LofError> {
    let metadata = read_json(repo, &manual.tree()?, &format!("documents/{id}/metadata.json"))?;
    let key = content_key(manual, id, &metadata)?;
    let mut duplicates = Vec::new();
    for oid in walk(repo, latest(repo)?.id())? {
        let commit = repo.find_commit(oid?)?;
        if commit.id() == manual.id() || !changed(&commit, id)? || is_deleted(repo, id, commit.id())?
            || (commit.parent_count() == 0 && commit.message() == Ok("변경 이력 초기화")) {
            continue;
        }
        let mut marked = false;
        for kind in ["manual", "restore", "before-restore"] {
            match repo.find_reference(&format!("refs/lof/{kind}/{id}/{}", commit.id())) {
                Ok(_) => { marked = true; break; }
                Err(error) if error.code() == git2::ErrorCode::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if marked { continue; }
        let metadata = read_json(repo, &commit.tree()?, &format!("documents/{id}/metadata.json"))?;
        if metadata["manual"].as_bool() == Some(true) || metadata["recordKind"].as_str() == Some("restore") {
            continue;
        }
        if content_key(&commit, id, &metadata)? == key { duplicates.push(commit.id()); }
    }
    for oid in &duplicates {
        repo.reference(&deleted_ref(id, *oid), *oid, false, "수동 저장본과 중복된 자동 기록 정리")?;
    }
    Ok(duplicates.len())
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

// 지운 이력 표시. Git 기록은 다시 쓰지 않고, 문서별로 지운 커밋을 표시해 목록과 열람에서 뺀다.
fn deleted_ref(id: &str, oid: Oid) -> String {
    format!("refs/lof/deleted/{id}/{oid}")
}

fn is_deleted(repo: &Repository, id: &str, oid: Oid) -> Result<bool, LofError> {
    match repo.find_reference(&deleted_ref(id, oid)) {
        Ok(_) => Ok(true),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
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
        let mut deleted = HashSet::new();
        for (kind, marks) in [
            ("manual", &mut manual),
            ("restore", &mut restored),
            ("before-restore", &mut before_restore),
            ("deleted", &mut deleted),
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
        let mut candidates = Vec::new();
        let mut manual_contents = HashSet::new();
        for oid in walk(&repo, head)? {
            let commit = repo.find_commit(oid?)?;
            if deleted.contains(&commit.id()) || !changed(&commit, id)? {
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
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&saved_at) {
                if parsed.with_timezone(&chrono::Utc) < cutoff {
                    break;
                }
            }
            let kind = if commit.parent_count() == 0 && commit.message() == Ok("변경 이력 초기화") {
                "initial"
            } else if manual.contains(&commit.id()) || value["manual"].as_bool() == Some(true) {
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
            // 본문 blob과 정규화한 속성을 비교해 저장 시각·경로만 다른 기록도 묶는다.
            let key = content_key(&commit, id, &value)?;
            if kind == "manual" { manual_contents.insert(key.clone()); }
            candidates.push((json!({"name":format!("git-{}",commit.id()),"commit":commit.id().to_string(),
                "savedAt":saved_at,"title":value["title"],"kind":kind}), key, matches!(kind, "auto" | "legacy")));
        }
        // 중복 제거 뒤 보관 개수와 페이지를 계산해야 페이지 사이에 자동 기록이 다시 나타나지 않는다.
        let mut entries: Vec<_> = candidates.into_iter()
            .filter(|(_, key, automatic)| !automatic || !manual_contents.contains(key))
            .take(keep_count).skip(offset).take(limit.saturating_add(1))
            .map(|(entry, _, _)| entry).collect();
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
        // 최신 기록에 없는 문서(새 문서 등)는 처음 커밋까지 거슬러 찾지 않는다.
        if document_tree(&head, id)?.is_none() {
            return Ok(None);
        }
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
        if is_deleted(&repo, id, commit.id())? {
            return Err(fail("지운 이력입니다.", "NOT_FOUND"));
        }
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
            let marked = match repo.find_reference(&reference) {
                Ok(_) => true,
                Err(error) if error.code() == git2::ErrorCode::NotFound => false,
                Err(error) => return Err(error.into()),
            };
            if !marked { repo.reference(&reference, commit.id(), false, "원고 기록 종류 표시")?; }
            let mut updated = !marked;
            if kind == "manual" {
                if is_deleted(&repo, id, commit.id())? {
                    repo.find_reference(&deleted_ref(id, commit.id()))?.delete()?;
                    updated = true;
                }
                updated |= discard_automatic_duplicates(&repo, id, &commit)? > 0;
            }
            return Ok(updated);
        }
        Ok(false)
    }

    // 문서의 이력 하나를 지운다. 이미 지운 이력이거나 그 문서가 바뀌지 않은 커밋이면 false.
    pub fn delete(&self, id: &str, name: &str) -> Result<bool, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID입니다."));
        }
        let repo = self.repository()?;
        let commit = checked_commit(&repo, name)?;
        if !changed(&commit, id)? || is_deleted(&repo, id, commit.id())? {
            return Ok(false);
        }
        repo.reference(&deleted_ref(id, commit.id()), commit.id(), false, "원고 기록 지움 표시")?;
        Ok(true)
    }

    pub fn capture_document(
        &mut self,
        id: &str,
        document: &Value,
        message: &str,
    ) -> Result<bool, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID입니다."));
        }
        let repo = self.repository()?;
        let previous = latest(&repo)?;
        // 이 문서의 본문과 속성만 바꿔 넣는다. 다른 문서의 기록은 읽거나 다시 쓰지 않는다.
        let mut files = BTreeMap::new();
        let previous_tree = previous.tree()?;
        if !put_document(&repo, &mut files, Some(&previous_tree), id, document)? {
            return Ok(false);
        }
        let next = update_tree(&repo, Some(&previous_tree), &files)?;
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
        Ok(true)
    }
}

pub fn comparison(previous: &Value, document: &Value) -> Result<Value, LofError> {
    let old_metadata = crate::database::history_metadata(previous);
    let current_metadata = crate::database::history_metadata(document);
    let mut metadata_changes = Vec::new();
    for (property, old, current) in [
        (false, &old_metadata, &current_metadata),
        (true, &old_metadata["properties"], &current_metadata["properties"]),
    ] {
        let keys: std::collections::BTreeSet<_> = old.as_object().into_iter().chain(current.as_object())
            .flat_map(|fields| fields.keys()).collect();
        for key in keys {
            if (!property && key == "properties") || old.get(key) == current.get(key) {
                continue;
            }
            metadata_changes.push(json!({"key":key,"property":property,
                "previous":old.get(key),"current":current.get(key),
                "previousExists":old.get(key).is_some(),"currentExists":current.get(key).is_some()}));
        }
    }
    let old = previous["body"].as_str().unwrap_or("");
    let current = document["body"].as_str().unwrap_or("");
    if old.len() + current.len() > 4_000_000 {
        return Ok(
            json!({"available":false,"metadataChanges":metadata_changes,"message":"원고가 커서 본문 비교를 생략했습니다. 원고 보기에서 내용을 확인해 주세요."}),
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
        json!({"available":true,"added":added,"removed":removed,"lines":lines,"truncated":visible().count()>3000,"metadataChanges":metadata_changes}),
    )
}
