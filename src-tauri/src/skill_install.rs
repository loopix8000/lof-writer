use super::{optional_revision, optional_string, revision, Bundle, NAME, PATHS};
use crate::error::{fail, fail_invalid, LofError};
use crate::store::strip_verbatim_prefix;
use serde_json::{json, Value};
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

static INSTALL_LOCK: Mutex<()> = Mutex::new(());
const RECEIPT: &str = ".lof-writer-skill.json";
const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024;

fn metadata(path: &Path) -> Result<Option<Metadata>, LofError> {
    match fs::symlink_metadata(path) {
        Ok(info) => {
            let linked = info.file_type().is_symlink();
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                linked || info.file_attributes() & 0x400 != 0
            };
            if linked {
                return Err(fail(
                    "스킬 설치 대상의 심볼릭 링크·정션은 지원하지 않습니다.",
                    "SKILL_PATH",
                ));
            }
            Ok(Some(info))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn directory(path: &Path) -> Result<bool, LofError> {
    match metadata(path)? {
        Some(info) if !info.is_dir() => {
            Err(fail("스킬 디렉터리 위치에 파일이 있습니다.", "SKILL_PATH"))
        }
        Some(_) => Ok(true),
        None => Ok(false),
    }
}

fn root_path(root: &str) -> Result<PathBuf, LofError> {
    let path = PathBuf::from(root);
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err(fail_invalid(
            "skillsDirectory는 상위 경로(..)가 없는 절대 경로여야 합니다.",
        ));
    }
    if path.file_name().is_none() {
        return Err(fail_invalid(
            "드라이브 루트 대신 AI 도구의 스킬 디렉터리를 지정해 주세요.",
        ));
    }
    // 상위 스킬 폴더의 링크는 실제 위치로 해석하고, 교체할 lof-writer 폴더 내부의 링크는 거절한다.
    if path.exists() {
        if !path.is_dir() {
            return Err(fail_invalid("skillsDirectory는 디렉터리여야 합니다."));
        }
        return Ok(strip_verbatim_prefix(&fs::canonicalize(path)?));
    }
    Ok(path)
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>, LofError> {
    let Some(info) = metadata(path)? else {
        return Ok(None);
    };
    if !info.is_file() || info.len() > MAX_FILE_SIZE {
        return Err(fail(
            "설치된 스킬 파일의 종류 또는 크기를 확인해 주세요.",
            "SKILL_PATH",
        ));
    }
    Ok(Some(fs::read(path)?))
}

fn installed(root: &Path, bundle: &Bundle) -> Result<Value, LofError> {
    let path = root.join(NAME);
    if !directory(&path)? {
        return Ok(
            json!({"path":path.to_string_lossy(),"exists":false,"revision":null,"version":null,"upToDate":false}),
        );
    }
    directory(&path.join("references"))?;
    let contents = PATHS
        .iter()
        .map(|rel| read_file(&path.join(rel)))
        .collect::<Result<Vec<_>, _>>()?;
    let current = revision(
        PATHS
            .into_iter()
            .zip(contents.iter().map(|bytes| bytes.as_deref())),
    );
    let receipt: Value = read_file(&path.join(RECEIPT))?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    Ok(json!({
        "path":path.to_string_lossy(), "exists":true, "revision":current,
        "version":receipt.get("version").and_then(Value::as_str),
        "upToDate":current == bundle.revision,
    }))
}

pub(super) fn status(root: &str, bundle: &Bundle) -> Result<Value, LofError> {
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| fail("스킬 설치 상태를 확인하지 못했습니다.", "SKILL_INSTALL"))?;
    installed(&root_path(root)?, bundle)
}

struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        // 새로 만든 고유 임시 폴더만 정리한다. 기존 설치본과 백업에는 적용하지 않는다.
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn install(args: &Value, bundle: &Bundle) -> Result<Value, LofError> {
    let expected = optional_revision(args, "expectedRevision")?
        .ok_or_else(|| fail_invalid("skill_status에서 확인한 expectedRevision이 필요합니다."))?;
    if expected != bundle.revision {
        return Err(fail(
            "앱의 스킬 패키지가 바뀌었습니다. skill_status를 다시 조회해 주세요.",
            "SKILL_CHANGED",
        ));
    }
    let expected_installed = optional_revision(args, "expectedInstalledRevision")?;
    let root = optional_string(args, "skillsDirectory")?
        .ok_or_else(|| fail_invalid("skillsDirectory가 필요합니다."))?;
    let _lock = INSTALL_LOCK
        .lock()
        .map_err(|_| fail("스킬 설치 상태를 확인하지 못했습니다.", "SKILL_INSTALL"))?;
    let root = root_path(root)?;
    let before = installed(&root, bundle)?;
    if before["upToDate"] == true {
        let mut result = bundle.info();
        result["installed"] = before;
        result["changed"] = json!(false);
        result["backupPath"] = Value::Null;
        return Ok(result);
    }
    if before["exists"] == true && before["revision"].as_str() != expected_installed {
        return Err(fail("기존 설치본을 확인하지 않았거나 내용이 바뀌었습니다. skill_status의 installed.revision을 expectedInstalledRevision으로 전달해 주세요.", "SKILL_CHANGED"));
    }
    if before["exists"] == false && expected_installed.is_some() {
        return Err(fail(
            "확인했던 설치본이 없습니다. skill_status를 다시 조회해 주세요.",
            "SKILL_CHANGED",
        ));
    }

    fs::create_dir_all(&root)?;
    let root = root_path(
        root.to_str()
            .ok_or_else(|| fail_invalid("스킬 경로를 확인해 주세요."))?,
    )?;
    let parent = root
        .parent()
        .ok_or_else(|| fail_invalid("스킬 디렉터리를 확인해 주세요."))?;
    let id = Uuid::new_v4().to_string();
    // 설치 준비본과 백업을 스킬 검색 폴더 밖에 두어 중복 스킬로 읽히지 않게 한다.
    let staging_path = parent.join(format!(".lof-writer-install-{id}"));
    fs::create_dir(&staging_path)?;
    let staging = Staging(staging_path);
    for file in &bundle.files {
        let path = staging.0.join(file.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &file.contents)?;
    }
    fs::write(
        staging.0.join(RECEIPT),
        serde_json::to_vec_pretty(&json!({
            "name":NAME,"version":bundle.version,"revision":bundle.revision,
        }))
        .map_err(|error| fail(error.to_string(), "SKILL_INSTALL"))?,
    )?;

    let current = installed(&root, bundle)?;
    if current["exists"] != before["exists"] || current["revision"] != before["revision"] {
        return Err(fail(
            "설치 중 기존 스킬이 바뀌었습니다. skill_status를 다시 조회해 주세요.",
            "SKILL_CHANGED",
        ));
    }
    let target = root.join(NAME);
    let backup = if before["exists"] == true {
        let backups = parent.join(".lof-writer-skill-backups");
        directory(&backups)?;
        fs::create_dir_all(&backups)?;
        let backup = backups.join(id);
        if fs::symlink_metadata(&backup).is_ok() {
            return Err(fail(
                "스킬 백업 경로가 이미 존재합니다. 다시 시도해 주세요.",
                "SKILL_INSTALL",
            ));
        }
        fs::rename(&target, &backup)?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(&staging.0, &target) {
        if let Some(backup) = &backup {
            if let Err(restore) = fs::rename(backup, &target) {
                return Err(fail(format!("스킬 교체와 원복에 실패했습니다: {error}; {restore}. 기존 설치본은 {}에 보존되어 있습니다.", backup.display()), "SKILL_INSTALL"));
            }
        }
        return Err(error.into());
    }
    let after = installed(&root, bundle)?;
    if after["upToDate"] != true {
        return Err(fail(
            "설치한 스킬의 내용을 확인하지 못했습니다. skill_status를 다시 조회해 주세요.",
            "SKILL_INSTALL",
        ));
    }
    let mut result = bundle.info();
    result["installed"] = after;
    result["changed"] = json!(true);
    result["backupPath"] = json!(backup.map(|path| path.to_string_lossy().into_owned()));
    result["reloadRequired"] = json!(true);
    Ok(result)
}
