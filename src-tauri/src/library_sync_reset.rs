//! 프로토콜 전환에 앞서 기존 서버 연결을 한 번 초기화한다.
//! 앱 버전과 별도로 관리하며, 다시 초기화할 때는 데몬의 같은 세대 값도 함께 올린다.

use crate::error::LofError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

const RESET_GENERATION: u64 = 1;
const RESET_KEY: &str = "librarySyncResetGeneration";

/// 숨겨진 연결도 정리한다. 새 연결은 완료 표시 덕분에 다음 실행 때 유지된다.
pub fn migrate_settings(path: &Path, settings: &mut Value) -> Result<(), LofError> {
    if settings[RESET_KEY].as_u64().unwrap_or(0) >= RESET_GENERATION {
        return Ok(());
    }
    let mut next = settings.clone();
    if let Some(connections) = next.get_mut("connections").and_then(Value::as_array_mut) {
        connections.retain(|connection| connection["type"].as_str() != Some("library"));
    }
    next[RESET_KEY] = json!(RESET_GENERATION);
    // 저장에 실패하면 완료로 간주하지 않고, 동기화 작업도 시작하지 않는다.
    crate::persist_settings(path, &next)?;
    *settings = next;
    Ok(())
}

/// 각 서재를 열 때 실행하므로 현재 열지 않은 서재도 다음에 열면 정리된다.
pub fn migrate_database(connection: &Connection) -> Result<(), LofError> {
    let transaction = connection.unchecked_transaction()?;
    let generation: Option<String> = transaction
        .query_row("SELECT value FROM kv WHERE key=?1", [RESET_KEY], |row| row.get(0))
        .optional()?;
    if generation.and_then(|value| value.parse::<u64>().ok()).unwrap_or(0) >= RESET_GENERATION {
        return Ok(());
    }
    // 원고·이력·파일 저장소 동기화 상태는 대상에 포함하지 않는다.
    transaction.execute(
        "DELETE FROM kv WHERE key GLOB 'library-v1:*'
            OR key GLOB 'library-cache:*' OR key GLOB 'library-asset:*'",
        [],
    )?;
    transaction.execute(
        "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![RESET_KEY, RESET_GENERATION.to_string()],
    )?;
    transaction.commit()?;
    Ok(())
}
