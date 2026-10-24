use crate::error::{fail, fail_invalid, valid_id, LofError};
use crate::local_git::{
    put_document, read_document, read_json, remove_dir_force, update_tree, LocalHistory,
};
use git2::{Commit, Oid, Repository, Signature, Sort};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;

const MAIN: &str = "refs/heads/main";
// 백업 파일 안의 서재 이력과 공용 메모 이력 폴더 이름. 공용 메모 이력은 공용 메모 폴더의 .lof에 같은 이름으로 둔다.
const LIBRARY_REPOSITORY: &str = "git";
const COMMON_REPOSITORY: &str = "common-memo-git";

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
    if commit.parent_count() == 0 && commit.message() == Ok("변경 이력 초기화") {
        return Ok(false);
    }
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
        let mut entries = Vec::new();
        let mut skipped = 0;
        let mut total_for_doc = 0;
        for oid in walk(&repo, head)? {
            let commit = repo.find_commit(oid?)?;
            let is_manual_reset = commit.parent_count() == 0
                && commit.message() == Ok("변경 이력 초기화")
                && manual.contains(&commit.id())
                && document_tree(&commit, id)?.is_some();
            if deleted.contains(&commit.id()) || (!changed(&commit, id)? && !is_manual_reset) {
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
        // 최신 기록에 없는 문서(새 문서 등)는 처음 커밋까지 거슬러 찾지 않는다.
        if document_tree(&head, id)?.is_none() {
            return Ok(None);
        }
        for oid in walk(&repo, head.id())? {
            let commit = repo.find_commit(oid?)?;
            let is_reset_base = commit.parent_count() == 0
                && commit.message() == Ok("변경 이력 초기화")
                && document_tree(&commit, id)?.is_some();
            if !changed(&commit, id)? && !is_reset_base {
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
            let is_reset_base = commit.parent_count() == 0
                && commit.message() == Ok("변경 이력 초기화")
                && document_tree(&commit, id)?.is_some();
            if !changed(&commit, id)? && !is_reset_base {
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

    // 문서의 이력 하나를 지운다. 이미 지운 이력이거나 그 문서가 바뀌지 않은 커밋이면 false.
    pub fn delete(&self, id: &str, name: &str) -> Result<bool, LofError> {
        if !valid_id(id) {
            return Err(fail_invalid("잘못된 문서 ID입니다."));
        }
        let repo = self.repository()?;
        let commit = checked_commit(&repo, name)?;
        let is_reset_base = commit.parent_count() == 0
            && commit.message() == Ok("변경 이력 초기화")
            && document_tree(&commit, id)?.is_some();
        if (!changed(&commit, id)? && !is_reset_base) || is_deleted(&repo, id, commit.id())? {
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

    // 서재 이력은 git/, 공용 메모 이력은 common-memo-git/ 아래에 담는다. 공용 메모 이력이 없으면 서재 이력만 담는다.
    pub fn backup(&self, destination: &Path, common_root: &Path) -> Result<(), LofError> {
        let repo = self.repository()?;
        let common = common_root.join(".lof").join(COMMON_REPOSITORY);
        let common = if common.try_exists()? {
            Some(LocalHistory::common_memos(common_root)?.repository()?)
        } else {
            None
        };
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let mut archive = zip::ZipWriter::new(file);
        fn visit(
            root: &Path,
            directory: &Path,
            prefix: &str,
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
                    visit(root, &path, prefix, archive)?;
                } else if kind.is_file() {
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|_| fail_invalid("백업 경로가 올바르지 않습니다."))?;
                    let name = format!("{prefix}/{}", relative.to_string_lossy().replace('\\', "/"));
                    archive
                        .start_file(name, zip::write::SimpleFileOptions::default())
                        .map_err(|error| fail_invalid(error.to_string()))?;
                    io::copy(&mut fs::File::open(path)?, archive)?;
                }
            }
            Ok(())
        }
        visit(repo.path(), repo.path(), LIBRARY_REPOSITORY, &mut archive)?;
        if let Some(common) = &common {
            visit(common.path(), common.path(), COMMON_REPOSITORY, &mut archive)?;
        }
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

    // 백업 파일의 Git 기록을 현재 기록에 합친다. 현재 기록은 그대로 두고,
    // 백업의 마지막 기록을 두 번째 부모로 이어 붙여 문서별 이력 목록에 함께 보이게 한다.
    // 서재와 공용 메모 이력을 각각 합치며, 둘 다 이미 들어 있는 백업이면 false.
    pub fn import_backup(&mut self, archive: &Path, scratch: &Path, common_root: &Path) -> Result<bool, LofError> {
        let result = (|| {
            extract_backup(archive, scratch)?;
            let mut imported = false;
            let library = scratch.join(LIBRARY_REPOSITORY);
            if library.try_exists()? {
                let target = self.repository()?;
                imported |= self.merge_backup(&target, &library, false)?;
            }
            let common = scratch.join(COMMON_REPOSITORY);
            if common.try_exists()? {
                let mut history = LocalHistory::common_memos(common_root)?;
                let target = history.repository()?;
                imported |= history.merge_backup(&target, &common, true)?;
            }
            Ok(imported)
        })();
        let _ = remove_dir_force(scratch);
        result
    }

    fn merge_backup(&mut self, target: &Repository, source: &Path, common: bool) -> Result<bool, LofError> {
        let invalid = || fail_invalid("Lof Writer의 Git 이력 백업 파일이 아닙니다.");
        let source = Repository::open_bare(source).map_err(|_| invalid())?;
        let tip = latest(&source).map_err(|_| invalid())?;
        let format = read_json(&source, &tip.tree()?, "format.json").map_err(|_| invalid())?;
        // 서재 이력과 공용 메모 이력이 서로 바뀌어 들어가지 않게 확인한다.
        if format["format"].as_u64() != Some(1)
            || (format["vaultId"].as_str() == Some("common-memos")) != common
        {
            return Err(fail_invalid("지원하지 않는 형식의 Git 이력 백업입니다."));
        }
        let current = latest(target)?;
        if target.find_commit(tip.id()).is_ok()
            && (tip.id() == current.id() || target.graph_descendant_of(current.id(), tip.id())?)
        {
            return Ok(false);
        }
        let source_odb = source.odb()?;
        let target_odb = target.odb()?;
        let mut failure = None;
        let copied = source_odb.foreach(|oid| {
            if target_odb.exists(*oid) {
                return true;
            }
            match source_odb.read(*oid).and_then(|object| target_odb.write(object.kind(), object.data())) {
                Ok(_) => true,
                Err(error) => {
                    failure = Some(error);
                    false
                }
            }
        });
        if let Some(error) = failure {
            return Err(error.into());
        }
        copied?;
        // 수동 저장·복원·지움 표시도 함께 옮긴다. 현재 서재에 같은 표시가 있으면 그대로 둔다.
        for kind in ["manual", "restore", "before-restore", "deleted"] {
            for reference in source.references_glob(&format!("refs/lof/{kind}/*"))? {
                let reference = reference?;
                let (Ok(name), Some(oid)) = (reference.name(), reference.target()) else {
                    continue;
                };
                match target.reference(name, oid, false, "Git 이력 백업 불러오기") {
                    Err(error) if error.code() != git2::ErrorCode::Exists => return Err(error.into()),
                    _ => {}
                }
            }
        }
        let tip = target.find_commit(tip.id())?;
        let sig = Signature::now("Lof Writer", "local@lof-writer.invalid")?;
        self.head = target
            .commit(Some(MAIN), &sig, &sig, "Git 이력 백업 불러오기", &current.tree()?, &[&current, &tip])?
            .to_string();
        Ok(true)
    }
}

// 백업 파일의 git/과 common-memo-git/ 아래 파일만 같은 이름의 폴더로 꺼낸다.
// 폴더 밖을 가리키는 경로나 연결 파일은 받지 않는다.
fn extract_backup(archive: &Path, destination: &Path) -> Result<(), LofError> {
    let unreadable = || fail_invalid("Git 이력 백업 파일을 읽지 못했습니다.");
    let mut zip = zip::ZipArchive::new(fs::File::open(archive)?).map_err(|_| unreadable())?;
    let mut found = false;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| unreadable())?;
        let name = entry
            .enclosed_name()
            .ok_or_else(|| fail_invalid("백업 파일의 경로가 올바르지 않습니다."))?;
        if ![LIBRARY_REPOSITORY, COMMON_REPOSITORY].iter().any(|prefix| name.starts_with(prefix))
            || name.components().count() < 2
            || entry.is_dir()
        {
            continue;
        }
        if !entry.is_file() {
            return Err(fail_invalid("연결된 파일이 든 백업은 불러올 수 없습니다."));
        }
        let path = destination.join(&name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        io::copy(&mut entry, &mut fs::File::create(&path)?).map_err(|_| unreadable())?;
        found = true;
    }
    if !found {
        return Err(fail_invalid("Lof Writer의 Git 이력 백업 파일이 아닙니다."));
    }
    Ok(())
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
