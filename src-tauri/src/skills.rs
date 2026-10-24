use crate::error::{fail, fail_invalid, hash_bytes, LofError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "android"))]
#[path = "skill_install.rs"]
mod install;
#[cfg(not(target_os = "android"))]
use crate::store::atomic_write_bytes;
#[cfg(not(target_os = "android"))]
use rfd::FileDialog;
#[cfg(not(target_os = "android"))]
use std::io::{Cursor, Write};
use tauri::WebviewWindow;
#[cfg(not(target_os = "android"))]
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const NAME: &str = "lof-writer";
const PATHS: [&str; 3] = ["SKILL.md", "references/api.md", "references/tools.json"];

struct SkillFile {
    path: &'static str,
    contents: Vec<u8>,
}

struct Bundle {
    version: String,
    revision: String,
    files: Vec<SkillFile>,
}

fn revision<'a>(files: impl IntoIterator<Item = (&'a str, Option<&'a [u8]>)>) -> String {
    let mut hash = Sha256::new();
    for (path, contents) in files {
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update([u8::from(contents.is_some())]);
        if let Some(contents) = contents {
            hash.update((contents.len() as u64).to_be_bytes());
            hash.update(contents);
        }
    }
    hex::encode(hash.finalize())
}

impl Bundle {
    fn new(version: &str) -> Result<Self, LofError> {
        let contents = [
            include_bytes!("../../skills/lof-writer/SKILL.md").to_vec(),
            include_bytes!("../../skills/lof-writer/references/api.md").to_vec(),
            serde_json::to_vec_pretty(&crate::api::tool_definitions()).map_err(|error| {
                fail(
                    format!("스킬 도구 정보를 만들지 못했습니다: {error}"),
                    "SKILL_EXPORT",
                )
            })?,
        ];
        let files: Vec<_> = PATHS
            .into_iter()
            .zip(contents)
            .map(|(path, contents)| SkillFile { path, contents })
            .collect();
        let revision = revision(
            files
                .iter()
                .map(|file| (file.path, Some(file.contents.as_slice()))),
        );
        Ok(Self {
            version: version.into(),
            revision,
            files,
        })
    }

    fn info(&self) -> Value {
        json!({
            "name": NAME, "version": self.version, "revision": self.revision,
            "source": "bundled", "installSupported": !cfg!(target_os = "android"),
            "files": self.files.iter().map(|file| json!({
                "path": file.path, "size": file.contents.len(), "sha256": hash_bytes(&file.contents),
            })).collect::<Vec<_>>(),
        })
    }
}

pub fn tool_definitions() -> Value {
    let mut tools = vec![
        json!({
            "name": "skill_status",
            "description": "앱에 포함된 Lof Writer 스킬의 버전·revision 조회. skillsDirectory를 지정하면 그 아래 lof-writer 설치본과 비교한다. 경로는 앱이 실행 중인 기기의 절대 경로이며 AI 클라이언트의 스킬 폴더를 추측하지 않는다",
            "inputSchema": {"type":"object","properties":{
                "skillsDirectory":{"type":"string","minLength":1,"description":"lof-writer 폴더가 들어갈 상위 스킬 디렉터리의 절대 경로"}
            },"required":[],"additionalProperties":false},
            "annotations":{"readOnlyHint":true},
        }),
        json!({
            "name": "skill_get",
            "description": "Lof Writer 스킬의 SKILL.md·API 안내·도구 스키마를 UTF-8 파일 내용으로 받는다. 원격 AI는 이 파일을 자기 기기의 스킬 폴더에 설치한다. knownRevision이 현재 revision과 같으면 파일 내용 전송을 생략한다",
            "inputSchema": {"type":"object","properties":{
                "knownRevision":{"type":"string","minLength":64,"maxLength":64}
            },"required":[],"additionalProperties":false},
            "annotations":{"readOnlyHint":true},
        }),
    ];
    if !cfg!(target_os = "android") {
        tools.push(json!({
            "name": "skill_install",
            "description": "앱이 실행 중인 기기의 지정된 skillsDirectory 아래에 Lof Writer 스킬을 설치하거나 업데이트한다. skill_status에서 확인한 expectedRevision을 전달한다. 기존 설치본은 expectedInstalledRevision으로 확인한 후 전체 폴더를 백업하고 교체하며 backupPath를 반환한다. 사용자 지정 파일도 백업에 보존된다. 같은 내용이면 변경하지 않는다. 설치 후 AI의 스킬 새로고침 또는 새 세션이 필요하다",
            "inputSchema":{"type":"object","properties":{
                "skillsDirectory":{"type":"string","minLength":1},
                "expectedRevision":{"type":"string","minLength":64,"maxLength":64},
                "expectedInstalledRevision":{"type":"string","minLength":64,"maxLength":64,"description":"기존 설치본이 있으면 skill_status의 installed.revision을 전달"}
            },"required":["skillsDirectory","expectedRevision"],"additionalProperties":false},
            "annotations":{"readOnlyHint":false,"destructiveHint":true},
        }));
    }
    Value::Array(tools)
}

fn optional_string<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, LofError> {
    args.get(key)
        .map(|value| {
            value
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| fail_invalid(format!("{key}는 비어 있지 않은 문자열이어야 합니다.")))
        })
        .transpose()
}

fn optional_revision<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, LofError> {
    let value = optional_string(args, key)?;
    if value.is_some_and(|text| text.len() != 64 || !text.bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err(fail_invalid(format!(
            "{key}는 스킬 도구에서 받은 revision이어야 합니다."
        )));
    }
    Ok(value)
}

pub fn tool(name: &str, args: &Value, version: &str) -> Result<Value, LofError> {
    let allowed: &[&str] = match name {
        "skill_status" => &["skillsDirectory"],
        "skill_get" => &["knownRevision"],
        "skill_install" => &[
            "skillsDirectory",
            "expectedRevision",
            "expectedInstalledRevision",
        ],
        _ => return Err(fail_invalid("지원하지 않는 스킬 도구입니다.")),
    };
    let input = args
        .as_object()
        .ok_or_else(|| fail_invalid("스킬 도구의 인자를 확인해 주세요."))?;
    if input.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(fail_invalid("스킬 도구에서 지원하지 않는 인자입니다."));
    }
    let bundle = Bundle::new(version)?;
    let mut result = bundle.info();
    match name {
        "skill_get" => {
            let unchanged =
                optional_revision(args, "knownRevision")? == Some(bundle.revision.as_str());
            result["unchanged"] = json!(unchanged);
            if !unchanged {
                result["files"] = json!(bundle
                    .files
                    .iter()
                    .map(|file| json!({
                        "path": file.path, "sha256": hash_bytes(&file.contents),
                        "content": String::from_utf8_lossy(&file.contents), "encoding": "utf-8",
                    }))
                    .collect::<Vec<_>>());
            }
        }
        "skill_status" => {
            if let Some(root) = optional_string(args, "skillsDirectory")? {
                #[cfg(not(target_os = "android"))]
                {
                    result["installed"] = install::status(root, &bundle)?;
                }
                #[cfg(target_os = "android")]
                {
                    let _ = root;
                    return Err(fail_invalid(
                        "Android에서는 skill_get으로 파일을 받아 AI 기기에 설치해 주세요.",
                    ));
                }
            }
        }
        "skill_install" => {
            #[cfg(not(target_os = "android"))]
            {
                return install::install(args, &bundle);
            }
            #[cfg(target_os = "android")]
            {
                return Err(fail_invalid(
                    "Android에서는 skill_get으로 파일을 받아 AI 기기에 설치해 주세요.",
                ));
            }
        }
        _ => unreachable!(),
    }
    Ok(result)
}

#[cfg(not(target_os = "android"))]
fn archive_error(error: zip::result::ZipError) -> LofError {
    fail(
        format!("스킬 패키지를 만들지 못했습니다: {error}"),
        "SKILL_EXPORT",
    )
}

#[cfg(not(target_os = "android"))]
fn archive() -> Result<Vec<u8>, LofError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    // 앱에 포함된 안내문과 현재 도구 스키마만 담아 사용자 데이터 없이 배포한다.
    let bundle = Bundle::new(env!("CARGO_PKG_VERSION"))?;
    for file in &bundle.files {
        zip.start_file(format!("{NAME}/{}", file.path), options)
            .map_err(archive_error)?;
        zip.write_all(&file.contents)?;
    }
    Ok(zip.finish().map_err(archive_error)?.into_inner())
}

pub fn download(window: &WebviewWindow) -> Result<Option<String>, LofError> {
    #[cfg(not(target_os = "android"))]
    {
        let picked = FileDialog::new()
            .set_parent(window)
            .set_title("Lof Writer 스킬 다운로드")
            .set_file_name("lof-writer-skill.zip")
            .add_filter("ZIP 스킬 패키지", &["zip"])
            .save_file();
        let Some(path) = picked else {
            return Ok(None);
        };
        atomic_write_bytes(&path, &archive()?)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
        Ok(None)
    }
}
