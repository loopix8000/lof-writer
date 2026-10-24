use crate::database::LibraryDb;
use crate::error::{fail, now_iso, valid_id, LofError};
use git2::{Commit, ErrorCode, Oid, Repository, Signature, Time};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAIN: &str = "refs/heads/main";
const IMPORT: &str = "refs/lof/legacy-import-v1";
const MIGRATION: &str = "refs/lof/migration-v1";


pub struct Snapshot {
    pub documents: Vec<Value>,
    pub projects: Vec<Value>,
    pub assets: Vec<(String, PathBuf)>,
    pub deleted: Value,
}

pub struct LocalHistory {
    path: PathBuf,
    pub ready: bool,
    pub error: String,
    pub head: String,
    pub imported: usize,
    observed: Option<(u64, u64)>,
    changed_at: Instant,
    pending: bool,
    migration_files: Option<BTreeMap<String, Oid>>,
    migration_keys: HashSet<String>,
}

impl LocalHistory {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(".lof").join("git"),
            ready: false,
            error: String::new(),
            head: String::new(),
            imported: 0,
            observed: None,
            changed_at: Instant::now(),
            pending: true,
            migration_files: None,
            migration_keys: HashSet::new(),
        }
    }

    pub fn status(&self) -> Value {
        json!({"ready": self.ready, "message": self.error, "head": self.head,
            "importedHistory": self.imported, "path": self.path.to_string_lossy()})
    }

    pub(crate) fn common_memos(root: &Path) -> Result<Self, LofError> {
        let mut history = Self::new(root);
        history.path = root.join(".lof").join("common-memo-git");
        let repo = history.repository()?;
        let owner = repo.path().join("lof-owner.json");
        let format = json!({"format": 1, "vaultId": "common-memos"});
        match fs::read(&owner) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|error| fail(error.to_string(), "LOCAL_GIT"))?;
                check_format(&value, "common-memos")?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if repo.references()?.next().is_some() {
                    return Err(fail("앱이 만들지 않은 공용 메모 이력 저장소입니다.", "LOCAL_GIT"));
                }
                crate::store::atomic_write_bytes(&owner, &json_bytes(&format)?)?;
            }
            Err(error) => return Err(error.into()),
        }
        if let Some(head) = tip(&repo, MAIN)? {
            check_format(&read_json(&repo, &head.tree()?, "format.json")?, "common-memos")?;
            history.head = head.id().to_string();
        } else {
            if repo.references()?.next().is_some() {
                return Err(fail("공용 메모 이력의 현재 기록을 찾을 수 없습니다.", "LOCAL_GIT"));
            }
            let mut files = BTreeMap::new();
            put(&repo, &mut files, "format.json", &json_bytes(&format)?)?;
            let tree = repo.find_tree(tree(&repo, &files)?)?;
            let sig = signature()?;
            history.head = repo.commit(Some(MAIN), &sig, &sig, "공용 메모 이력 시작", &tree, &[])?.to_string();
        }
        history.ready = true;
        Ok(history)
    }

    pub(crate) fn repository(&self) -> Result<Repository, LofError> {
        // NAS 등 네트워크 공유 폴더는 파일 소유자가 현재 Windows 사용자와 달라
        // 소유자 검사에 걸린다. 앱 전용 저장소는 lof-owner.json으로 서재를 확인하므로 끈다.
        static OWNER_VALIDATION: std::sync::Once = std::sync::Once::new();
        OWNER_VALIDATION.call_once(|| {
            // SAFETY: 다른 스레드가 저장소를 열기 전에 한 번만 호출되는 전역 설정이다.
            let _ = unsafe { git2::opts::set_verify_owner_validation(false) };
        });
        // 부모 저장소를 검색하지 않으며, 기존의 알 수 없는 디렉터리를 덮어쓰지 않는다.
        let repo = if self.path.try_exists()? {
            Repository::open_bare(&self.path)?
        } else {
            let mut options = git2::RepositoryInitOptions::new();
            options.bare(true).no_reinit(true).initial_head("main");
            Repository::init_opts(&self.path, &options)?
        };
        if !repo.is_bare() {
            return Err(fail("앱 전용 Git 저장소 형식이 아닙니다.", "LOCAL_GIT"));
        }
        let mut config = repo.config()?;
        for key in ["core.fsyncObjectFiles", "core.logAllRefUpdates"] {
            if config.get_bool(key).ok() != Some(true) {
                config.set_bool(key, true)?;
            }
        }
        Ok(repo)
    }

    pub fn resume(&mut self, vault_id: &str, db: &LibraryDb) -> Result<bool, LofError> {
        let completed = db.get("gitMigrationV1")?.is_some();
        if completed && !self.path.try_exists()? {
            return Err(fail("이미 이관한 로컬 Git 저장소를 찾지 못했습니다. 서재의 .lof/git 폴더를 복구해 주세요.", "LOCAL_GIT"));
        }
        let repo = self.repository()?;
        let owner_path = repo.path().join("lof-owner.json");
        match fs::read(&owner_path) {
            Ok(bytes) => {
                let owner: Value = serde_json::from_slice(&bytes)
                    .map_err(|error| fail(error.to_string(), "LOCAL_GIT"))?;
                check_format(&owner, vault_id)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if repo.references()?.next().is_some() {
                    return Err(fail(
                        "앱이 만들지 않은 Git 저장소가 있습니다. 기존 저장소는 보존됩니다.",
                        "LOCAL_GIT",
                    ));
                }
                crate::store::atomic_write_bytes(
                    &owner_path,
                    &json_bytes(&json!({"format":1,"vaultId":vault_id}))?,
                )?;
            }
            Err(error) => return Err(error.into()),
        }
        let Some(anchor) = tip(&repo, MIGRATION)? else {
            if completed {
                return Err(fail(
                    "로컬 Git의 이관 완료 기록을 찾지 못했습니다. 기존 기록은 보존됩니다.",
                    "LOCAL_GIT",
                ));
            }
            return Ok(false);
        };
        let migration = read_json(&repo, &anchor.tree()?, "format.json")?;
        check_format(&migration, vault_id)?;
        let current = tip(&repo, MAIN)?
            .ok_or_else(|| fail("로컬 Git의 현재 이력을 찾을 수 없습니다.", "LOCAL_GIT"))?;
        check_format(
            &read_json(&repo, &current.tree()?, "format.json")?,
            vault_id,
        )?;
        // 지난번에 이어짐을 확인한 커밋부터 새로 쌓인 커밋만 따라간다. 저장할 때마다 늘어나는 전체 기록을 매번 거슬러 오르지 않는다.
        // 기억한 커밋에서 이어지지 않으면 처음 이관 기록부터 다시 확인한다.
        let verified = db.get("gitVerifiedHead")?.as_ref().and_then(Value::as_str)
            .and_then(|id| Oid::from_str(id).ok())
            .filter(|id| repo.find_commit(*id).is_ok());
        let connected = |base: Oid| -> Result<bool, LofError> {
            Ok(current.id() == base || repo.graph_descendant_of(current.id(), base)?)
        };
        let linked = match verified {
            Some(base) if connected(base)? => true,
            _ => connected(anchor.id())?,
        };
        if linked && verified != Some(current.id()) {
            db.set("gitVerifiedHead", &json!(current.id().to_string()))?;
        }
        if !linked {
            return Err(fail(
                "현재 Git 기록이 기존 이관 이력과 연결되지 않습니다. 기존 기록은 보존됩니다.",
                "LOCAL_GIT",
            ));
        }
        // Git의 완료 참조를 먼저 기록하므로 DB 표시 갱신 전에 중단되어도 재이관하지 않는다.
        if db.get("gitMigrationV1")?.is_none() {
            db.set(
                "gitMigrationV1",
                &json!({"version":1,"head":anchor.id().to_string(),
                "completedAt":now_iso(),"historyCount":migration["legacyHistory"]}),
            )?;
        }
        self.imported = migration["legacyHistory"].as_u64().unwrap_or(0) as usize;
        self.head = current.id().to_string();
        self.ready = true;
        Ok(true)
    }

    pub fn import_legacy(&mut self, db: &LibraryDb) -> Result<bool, LofError> {
        let repo = self.repository()?;
        // 원본 DB와 원고는 유지한다. 백업은 완료된 경로만 DB에 기록하며 중단 시 재사용한다.
        let backup = db.get("gitMigrationBackupV1")?;
        let backed_up = backup
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|path| Path::new(path).is_file());
        if !backed_up {
            if tip(&repo, IMPORT)?.is_some() {
                return Err(fail("이관 중 사용하던 이력 백업을 찾지 못했습니다. 기존 원고와 Git 기록은 보존됩니다.", "LOCAL_GIT"));
            }
            let directory = self
                .path
                .parent()
                .unwrap()
                .join("migrations")
                .join(format!("git-v1-{}", uuid::Uuid::new_v4()));
            let destination = directory.join("library.sqlite");
            db.backup(&destination)?;
            db.set(
                "gitMigrationBackupV1",
                &json!(destination.to_string_lossy()),
            )?;
        }
        if self.migration_files.is_none() {
            let mut files = BTreeMap::new();
            let mut imported = HashSet::new();
            if let Some(last) = tip(&repo, IMPORT)? {
                flatten(&repo, &last.tree()?, "", &mut files)?;
                let mut walk = repo.revwalk()?;
                walk.push(last.id())?;
                for oid in walk {
                    let commit = repo.find_commit(oid?)?;
                    if let Some(key) = commit
                        .message()?
                        .lines()
                        .find_map(|line| line.strip_prefix("Lof-Legacy: "))
                    {
                        imported.insert(key.to_string());
                    }
                }
            }
            self.imported = imported.len();
            self.migration_keys = imported;
            self.migration_files = Some(files);
        }
        let backup = db
            .get("gitMigrationBackupV1")?
            .and_then(|value| value.as_str().map(PathBuf::from))
            .ok_or_else(|| fail("이력 백업 경로가 없습니다.", "LOCAL_GIT"))?;
        let files = self.migration_files.as_mut().unwrap();
        let imported_count = &mut self.imported;
        let keys = &mut self.migration_keys;
        let imported_keys = keys.clone();
        let offset = *imported_count;
        // 한 번에 20개만 옮겨 긴 이력 이관 중에도 원고 저장 요청을 처리할 수 있게 한다.
        let mut import = |id: &str, name: &str, value: Value| -> Result<(), LofError> {
            if !valid_id(id) || !crate::database::history_name_valid(name) {
                return Err(fail(
                    "이관할 기존 이력의 식별자가 올바르지 않습니다.",
                    "LOCAL_GIT",
                ));
            }
            let key = format!("{id}/{name}");
            if keys.contains(&key) {
                return Ok(());
            }
            let body = value["body"]
                .as_str()
                .ok_or_else(|| fail("이관할 기존 이력의 본문이 없습니다.", "LOCAL_GIT"))?;
            let mut metadata = value.clone();
            metadata
                .as_object_mut()
                .ok_or_else(|| fail("기존 이력 형식이 올바르지 않습니다.", "LOCAL_GIT"))?
                .remove("body");
            put(
                &repo,
                files,
                &format!("documents/{id}/body.md"),
                body.as_bytes(),
            )?;
            put(
                &repo,
                files,
                &format!("documents/{id}/metadata.json"),
                &json_bytes(&metadata)?,
            )?;
            let tree = repo.find_tree(tree(&repo, files)?)?;
            // 원본 본문과 속성을 다시 읽어 확인한 뒤에만 재개 지점을 앞으로 옮긴다.
            let restored = read_document(&repo, &tree, id)?;
            if restored != value {
                return Err(fail(
                    "기존 이력의 Git 이관 검증에 실패했습니다.",
                    "LOCAL_GIT",
                ));
            }
            let saved_at = value["savedAt"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .ok_or_else(|| fail("기존 이력의 저장 시각이 올바르지 않습니다.", "LOCAL_GIT"))?;
            let author = Signature::new(
                "Lof Writer",
                "local@lof-writer.invalid",
                &Time::new(saved_at.timestamp(), 0),
            )?;
            let committer = signature()?;
            let parent = tip(&repo, IMPORT)?;
            let parents: Vec<_> = parent.iter().collect();
            repo.commit(
                Some(IMPORT),
                &author,
                &committer,
                &format!("기존 원고 이력 이관\n\nLof-Legacy: {key}"),
                &tree,
                &parents,
            )?;
            *imported_count += 1;
            keys.insert(key);
            Ok(())
        };
        let count = LibraryDb::visit_history_backup(&backup, offset, 20, &mut import)?;
        if count == 20 {
            return Ok(false);
        }
        // 백업 이후 이관 중에 저장된 이력도 완료 전에 옮긴다.
        let count = db.visit_unimported_history(&imported_keys, 20, &mut import)?;
        Ok(count < 20)
    }

    pub fn finish_migration(
        &mut self,
        vault_id: &str,
        db: &LibraryDb,
        snapshot: &Snapshot,
    ) -> Result<(), LofError> {
        let repo = self.repository()?;
        let format = json!({"format":1,"vaultId":vault_id,"legacyHistory":self.imported});
        let current_files = snapshot_files(&repo, snapshot, &format)?;
        let current_tree = repo.find_tree(tree(&repo, &current_files)?)?;
        let main = tip(&repo, MAIN)?;
        let legacy = tip(&repo, IMPORT)?;
        let mut parents: Vec<&Commit<'_>> = main.iter().collect();
        if let Some(parent) = legacy.as_ref() {
            if main.as_ref().is_none_or(|main| main.id() != parent.id()) {
                parents.push(parent);
            }
        }
        let sig = signature()?;
        let oid = repo.commit(
            Some(MAIN),
            &sig,
            &sig,
            "기존 서재의 로컬 Git 기록 시작",
            &current_tree,
            &parents,
        )?;
        repo.set_head(MAIN)?;
        repo.reference(MIGRATION, oid, false, "기존 서재 이관 완료")?;
        db.set("gitMigrationV1", &json!({"version":1,"head":oid.to_string(),"completedAt":now_iso(),"historyCount":self.imported}))?;
        self.ready = true;
        self.migration_files = None;
        self.head = oid.to_string();
        Ok(())
    }

    pub fn observe(&mut self, revision: (u64, u64)) {
        if self.observed != Some(revision) {
            self.observed = Some(revision);
            self.changed_at = Instant::now();
            self.pending = true;
        }
    }

    pub fn retry_migration(&mut self) {
        // 참조를 갱신한 직후 오류가 났어도 다음 시도는 실제 Git 기록에서 진행률을 복구한다.
        self.migration_files = None;
    }

    pub fn due(&self, force: bool, _editing: bool) -> bool {
        self.pending && force

    }

    pub fn commit(&mut self, vault_id: &str, snapshot: &Snapshot) -> Result<(), LofError> {
        let repo = self.repository()?;
        let previous = tip(&repo, MAIN)?
            .ok_or_else(|| fail("로컬 Git의 현재 이력이 없습니다.", "LOCAL_GIT"))?;
        let format = read_json(&repo, &previous.tree()?, "format.json")?;
        check_format(&format, vault_id)?;
        let files = snapshot_files(&repo, snapshot, &format)?;
        let next = tree(&repo, &files)?;
        if previous.tree_id() != next {
            let sig = signature()?;
            let tree = repo.find_tree(next)?;
            self.head = repo
                .commit(
                    Some(MAIN),
                    &sig,
                    &sig,
                    "입력을 마친 원고와 작품 정보 저장",
                    &tree,
                    &[&previous],
                )?
                .to_string();
        }
        self.pending = false;
        Ok(())
    }
}

fn check_format(value: &Value, vault_id: &str) -> Result<(), LofError> {
    if value["format"].as_u64() != Some(1) || value["vaultId"].as_str() != Some(vault_id) {
        return Err(fail(
            "다른 서재 또는 지원하지 않는 형식의 Git 저장소입니다. 기존 데이터는 보존됩니다.",
            "LOCAL_GIT",
        ));
    }
    Ok(())
}

fn signature() -> Result<Signature<'static>, LofError> {
    Ok(Signature::now("Lof Writer", "local@lof-writer.invalid")?)
}

fn tip<'a>(repo: &'a Repository, reference: &str) -> Result<Option<Commit<'a>>, LofError> {
    match repo.find_reference(reference) {
        Ok(reference) => Ok(Some(reference.peel_to_commit()?)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn json_bytes(value: &Value) -> Result<Vec<u8>, LofError> {
    fn ordered(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let sorted: BTreeMap<_, _> = map
                    .iter()
                    .map(|(key, value)| (key.clone(), ordered(value)))
                    .collect();
                Value::Object(sorted.into_iter().collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(ordered).collect()),
            value => value.clone(),
        }
    }
    serde_json::to_vec_pretty(&ordered(value)).map_err(|error| fail(error.to_string(), "LOCAL_GIT"))
}

pub(crate) fn put(
    repo: &Repository,
    files: &mut BTreeMap<String, Oid>,
    path: &str,
    data: &[u8],
) -> Result<(), LofError> {
    files.insert(path.to_string(), repo.blob(data)?);
    Ok(())
}

fn snapshot_files(
    repo: &Repository,
    snapshot: &Snapshot,
    format: &Value,
) -> Result<BTreeMap<String, Oid>, LofError> {
    let mut files = BTreeMap::new();
    let previous = tip(repo, MAIN)?.map(|commit| commit.tree()).transpose()?;
    put(repo, &mut files, "format.json", &json_bytes(format)?)?;
    put(
        repo,
        &mut files,
        "deleted.json",
        &json_bytes(&snapshot.deleted)?,
    )?;
    for project in &snapshot.projects {
        let id = project["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| fail("작품 ID가 올바르지 않습니다.", "LOCAL_GIT"))?;
        put(
            repo,
            &mut files,
            &format!("projects/{id}/project.json"),
            &json_bytes(project)?,
        )?;
    }
    for document in &snapshot.documents {
        let id = document["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| fail("문서 ID가 올바르지 않습니다.", "LOCAL_GIT"))?;
        put_document(repo, &mut files, previous.as_ref(), id, document)?;
    }
    for (path, source) in &snapshot.assets {
        files.insert(path.clone(), repo.blob_path(source)?);
    }
    Ok(files)
}

pub(crate) fn put_document(
    repo: &Repository,
    files: &mut BTreeMap<String, Oid>,
    previous: Option<&git2::Tree<'_>>,
    id: &str,
    document: &Value,
) -> Result<bool, LofError> {
    let body_path = format!("documents/{id}/body.md");
    let metadata_path = format!("documents/{id}/metadata.json");
    if let Some(previous) = previous {
        match previous.get_path(Path::new(&metadata_path)) {
            Ok(_) => {
                let old = read_document(repo, previous, id)?;
                if crate::database::same_history_content(&old, document) {
                    for path in [&body_path, &metadata_path] {
                        files.insert(path.clone(), previous.get_path(Path::new(path))?.id());
                    }
                    return Ok(false);
                }
            }
            Err(error) if error.code() == ErrorCode::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let body = document["body"].as_str()
        .ok_or_else(|| fail("원고 본문을 읽지 못했습니다.", "LOCAL_GIT"))?;
    let mut metadata = document.clone();
    let fields = metadata.as_object_mut()
        .ok_or_else(|| fail("원고 속성을 읽지 못했습니다.", "LOCAL_GIT"))?;
    for key in ["body", "revision", "fingerprint", "path"] {
        fields.remove(key);
    }
    put(repo, files, &body_path, body.as_bytes())?;
    put(repo, files, &metadata_path, &json_bytes(&metadata)?)?;
    Ok(true)
}

pub(crate) fn read_json(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    path: &str,
) -> Result<Value, LofError> {
    let entry = tree.get_path(Path::new(path))?;
    let blob = repo.find_blob(entry.id())?;
    serde_json::from_slice(blob.content()).map_err(|error| fail(error.to_string(), "LOCAL_GIT"))
}

pub fn read_document(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    id: &str,
) -> Result<Value, LofError> {
    let mut metadata = read_json(repo, tree, &format!("documents/{id}/metadata.json"))?;
    let entry = tree.get_path(Path::new(&format!("documents/{id}/body.md")))?;
    let blob = repo.find_blob(entry.id())?;
    let body = std::str::from_utf8(blob.content())
        .map_err(|error| fail(error.to_string(), "LOCAL_GIT"))?;
    metadata["body"] = json!(body);
    Ok(metadata)
}

#[derive(Default)]
struct Directory {
    files: BTreeMap<String, Oid>,
    directories: BTreeMap<String, Directory>,
}

fn directory_of(files: &BTreeMap<String, Oid>) -> Result<Directory, LofError> {
    let mut root = Directory::default();
    for (path, oid) in files {
        let parts: Vec<_> = path.split('/').collect();
        if parts.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | ".." | ".git" | ".lof")
                || part.contains('\\')
                || part.contains('\0')
        }) {
            return Err(fail("Git 기록 경로가 올바르지 않습니다.", "LOCAL_GIT"));
        }
        let mut directory = &mut root;
        for part in &parts[..parts.len() - 1] {
            directory = directory.directories.entry(part.to_string()).or_default();
        }
        directory
            .files
            .insert(parts.last().unwrap().to_string(), *oid);
    }
    Ok(root)
}

pub(crate) fn tree(repo: &Repository, files: &BTreeMap<String, Oid>) -> Result<Oid, LofError> {
    update_tree(repo, None, files)
}

// base 트리에 files만 바꿔 넣는다. 바뀐 경로의 하위 트리만 새로 쓰고, 나머지는 기존 트리를 그대로 가리킨다.
// 공유 저장소처럼 파일 접근이 느린 곳에서도 문서 수와 관계없이 몇 개의 개체만 읽고 쓴다.
pub(crate) fn update_tree(
    repo: &Repository,
    base: Option<&git2::Tree<'_>>,
    files: &BTreeMap<String, Oid>,
) -> Result<Oid, LofError> {
    fn write(repo: &Repository, base: Option<&git2::Tree<'_>>, directory: Directory) -> Result<Oid, LofError> {
        let mut builder = repo.treebuilder(base)?;
        for (name, oid) in directory.files {
            builder.insert(name, oid, 0o100644)?;
        }
        for (name, child) in directory.directories {
            let previous = match base.and_then(|tree| tree.get_name(&name)) {
                Some(entry) if entry.kind() == Some(git2::ObjectType::Tree) => Some(repo.find_tree(entry.id())?),
                _ => None,
            };
            let oid = write(repo, previous.as_ref(), child)?;
            builder.insert(name, oid, 0o040000)?;
        }
        Ok(builder.write()?)
    }
    write(repo, base, directory_of(files)?)
}

pub(crate) fn flatten(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    prefix: &str,
    files: &mut BTreeMap<String, Oid>,
) -> Result<(), LofError> {
    // 이관 재개에는 문서만 필요하므로 하위 트리를 저장소에서 직접 읽는다.
    for entry in tree {
        let name = entry.name()?;
        let path = format!("{prefix}{name}");
        if entry.kind() == Some(git2::ObjectType::Tree) {
            let child = repo.find_tree(entry.id())?;
            flatten(repo, &child, &format!("{path}/"), files)?;
        } else {
            files.insert(path, entry.id());
        }
    }
    Ok(())
}

pub fn collect_assets(
    id: &str,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), LofError> {
    if !valid_id(id) {
        return Err(fail("작품 ID가 올바르지 않습니다.", "LOCAL_GIT"));
    }
    let root = directory.join("assets");
    if !root.try_exists()? {
        return Ok(());
    }
    if fs::symlink_metadata(&root)?.file_type().is_symlink() {
        return Err(fail(
            "연결된 이미지 폴더는 로컬 Git에 기록할 수 없습니다.",
            "LOCAL_GIT",
        ));
    }
    fn visit(
        root: &Path,
        path: &Path,
        prefix: &str,
        files: &mut Vec<(String, PathBuf)>,
    ) -> Result<(), LofError> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.')
                || [".tmp", ".lofmv", ".lofnew"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
            {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(fail(
                    "연결된 이미지 파일은 로컬 Git에 기록할 수 없습니다.",
                    "LOCAL_GIT",
                ));
            }
            if kind.is_dir() {
                visit(root, &entry.path(), prefix, files)?;
            } else if kind.is_file() {
                let path = entry.path();
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| fail("이미지 경로를 확인할 수 없습니다.", "LOCAL_GIT"))?;
                files.push((
                    format!("{prefix}/{}", relative.to_string_lossy().replace('\\', "/")),
                    path,
                ));
            }
        }
        Ok(())
    }
    visit(&root, &root, &format!("projects/{id}/assets"), files)
}
