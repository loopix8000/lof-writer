use crate::error::LofError;
#[cfg(not(target_os = "android"))]
use crate::error::fail;
#[cfg(not(target_os = "android"))]
use crate::store::atomic_write_bytes;
#[cfg(not(target_os = "android"))]
use rfd::FileDialog;
#[cfg(not(target_os = "android"))]
use std::io::{Cursor, Write};
use tauri::WebviewWindow;
#[cfg(not(target_os = "android"))]
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

#[cfg(not(target_os = "android"))]
fn archive_error(error: zip::result::ZipError) -> LofError {
    fail(format!("스킬 패키지를 만들지 못했습니다: {error}"), "SKILL_EXPORT")
}

#[cfg(not(target_os = "android"))]
fn archive() -> Result<Vec<u8>, LofError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let tools = serde_json::to_vec_pretty(&crate::api::tool_definitions())
        .map_err(|error| fail(format!("스킬 도구 정보를 만들지 못했습니다: {error}"), "SKILL_EXPORT"))?;
    // 앱에 포함된 안내문과 현재 도구 스키마만 담아 사용자 데이터 없이 배포한다.
    let files: &[(&str, &[u8])] = &[
        ("lof-writer/SKILL.md", include_bytes!("../../skills/lof-writer/SKILL.md")),
        ("lof-writer/references/api.md", include_bytes!("../../skills/lof-writer/references/api.md")),
        ("lof-writer/references/tools.json", &tools),
    ];
    for (name, contents) in files {
        zip.start_file(*name, options).map_err(archive_error)?;
        zip.write_all(contents)?;
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
        let Some(path) = picked else { return Ok(None); };
        atomic_write_bytes(&path, &archive()?)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
        Ok(None)
    }
}
