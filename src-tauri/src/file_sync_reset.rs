//! 파일 원본 동기화 규격으로 전환할 때 기존 연결을 한 번 초기화하고 안내한다.

use crate::error::LofError;
use crate::AppState;
#[cfg(not(target_os = "android"))]
use rfd::{MessageDialog, MessageLevel};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager};

const GENERATION: u64 = 1;
const KEY: &str = "fileSyncResetGeneration";
const NOTICE: &str = "fileSyncResetNoticePending";

pub fn migrate(path: &Path, settings: &mut Value) -> Result<(), LofError> {
    if settings[KEY].as_u64().unwrap_or(0) >= GENERATION {
        return Ok(());
    }
    let mut next = settings.clone();
    let mut removed = false;
    if let Some(connections) = next.get_mut("connections").and_then(Value::as_array_mut) {
        connections.retain(|connection| {
            let reset = matches!(
                connection["type"].as_str(),
                Some("folder" | "webdav" | "ftp")
            );
            removed |= reset;
            !reset
        });
    }
    next[KEY] = json!(GENERATION);
    if removed {
        next[NOTICE] = json!(true);
    }
    // 삭제와 완료 표시를 함께 저장한 뒤에만 앱의 동기화 작업을 시작한다.
    crate::persist_settings(path, &next)?;
    *settings = next;
    Ok(())
}

pub fn show_notice(app: &AppHandle) {
    if app.state::<AppState>().settings.lock().unwrap()[NOTICE].as_bool() != Some(true) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        #[cfg(not(target_os = "android"))]
        MessageDialog::new()
            .set_title("파일 동기화 연결 초기화 안내")
            .set_level(MessageLevel::Info)
            .set_description("파일 동기화 방식이 변경되어 기존 폴더·WebDAV·FTP 연결이 초기화되었습니다.\n\n원고와 저장소의 파일은 그대로 보관되어 있습니다. 설정 → 파일 동기화에서 저장소를 다시 연결해 주세요.")
            .show();
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        let mut next = settings.clone();
        next[NOTICE] = json!(false);
        // 안내 저장 실패 시 다음 실행에서 다시 안내한다.
        match crate::persist_settings(&state.config_file, &next) {
            Ok(()) => *settings = next,
            Err(error) => eprintln!(
                "파일 동기화 초기화 안내 상태를 저장하지 못했습니다: {}",
                error.message
            ),
        }
    });
}
