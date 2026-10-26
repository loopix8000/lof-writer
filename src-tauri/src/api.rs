use crate::error::{fail, fail_invalid, slice_utf16, slice_utf16_range, utf16_len, LofError};
use crate::store::Store;
use rand::RngCore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MCP_INSTRUCTIONS: &str = r#"Lof Writer의 작품, 회차, 플롯, 메모를 조회하고 편집하는 서버입니다. Lof Writer 앱이 실행 중이어야 합니다.

- library_list로 작품과 문서를 확인하고, 조회 결과의 작품 id를 projectId로, 문서 id를 id로 사용하세요. ID를 추측하지 마세요.
- 제목·태그·본문 일부로 문서를 찾을 때는 먼저 document_search를 사용하세요. 검색어는 별도 옵션 없이 rg와 같은 문법의 정규식으로 해석됩니다. 앱 검색과 같은 결과 구조(projects, files, results, common)를 반환하며, results의 matches는 일치한 줄과 위치입니다. 보관 문서와 보관 공용 메모는 기본 제외하며 includeArchived: true로 함께 검색할 수 있습니다. #로 시작하는 검색어는 태그만 찾습니다. total이 많아 truncated가 true이면 projectId나 더 구체적인 검색어로 좁히세요.
- 문서를 수정하거나 이력을 복원하기 전에 document_read로 현재 내용과 revision을 조회하세요. document_update, document_patch, document_apply_patch, history_restore의 expectedRevision에는 조회한 revision을 그대로 전달하세요. 저장 후에는 새로 반환된 revision을 사용하세요.
- CONFLICT 오류가 나면 최신 문서를 다시 읽고 변경 내용을 비교한 뒤 사용자가 요청한 수정만 다시 적용하세요. revision만 최신 값으로 바꿔 이전 본문을 덮어쓰지 마세요.
- 일부 문장을 수정할 때는 document_patch를 사용하세요. find는 현재 본문에서 정확히 한 번 일치해야 하므로 필요한 앞뒤 문맥을 포함하세요. 전체 본문 교체는 document_update의 body를 사용하세요.
- 여러 구간을 줄 단위로 수정할 때는 document_apply_patch를 사용하세요. patch는 @@로 구간을 시작하고 공백 접두사의 문맥 줄, - 삭제 줄, + 추가 줄로 작성하세요. 각 구간은 원본 본문에서 유일하게 일치해야 하며 겹치는 구간은 합치세요. 파일 경로·파일 작업·메타데이터 변경은 지원하지 않고, 구간 하나라도 실패하면 저장하지 않습니다. 마지막 구간 끝의 *** End of File로 본문 끝에 일치하도록 제한할 수 있습니다.
- 필요한 구간만 읽을 때는 document_read의 startLine·endLine으로 본문 줄 범위를 지정하세요(1부터 시작, 양 끝 포함). 검색 결과 matches의 line과 같은 번호이며 YAML 헤더는 세지 않습니다. endLine 생략 시 최대 200줄을 반환합니다. body는 줄 번호를 붙이지 않은 원문이며 startLine, endLine, totalLines를 함께 반환합니다. offset과 줄 범위는 함께 지정할 수 없습니다.
- document_read의 truncated가 true이면 본문이 일부만 반환된 것입니다. 줄 범위 조회의 nextLine으로 다음 구간을 읽으세요. limit은 줄 범위 조회에서도 최대 본문 길이이며, rangeTruncated가 true이면 길이 제한으로 요청 구간이 잘린 것입니다. rangeTruncated가 true이고 nextLine이 null이면 긴 줄 중간에서 잘렸으므로 nextOffset을 offset으로 전달해 이어 읽으세요. offset, limit, totalLength, nextOffset은 UTF-16 코드 단위입니다. 전체 본문 교체 전에는 처음부터 끝까지 읽고, 여러 번 읽는 동안 revision이 바뀌면 다시 조회하세요.
- 문서 생성 시 kind를 episode(회차), plot(플롯), memo(메모) 중에서 지정하세요. 플롯과 메모의 folder는 doc/ 아래의 상대 경로이므로 doc/ 접두사 없이 전달하세요. 회차에 연결할 때는 해당 작품에 존재하는 회차의 id를 episodeId로 전달하세요.
- 사용자가 요청한 본문과 메타데이터만 변경하고, 나머지 문장, Markdown 서식, 태그, 속성, 줄바꿈 설정은 보존하세요. 순서 변경과 이력 복원은 사용자의 요청 범위에 포함된 경우에 수행하세요.
- 문서를 생성·수정·복원하거나 순서를 바꾸면 마지막 변경 2초 뒤에 자동으로 동기화하므로 sync_now를 따로 호출하지 않아도 됩니다. 동기화 상태는 sync_status로 확인하세요. 다른 장치에서 바뀐 내용을 먼저 받아야 할 때는 sync_now를 호출한 뒤, sync_status의 phase가 syncing 또는 pending이 아니게 될 때까지 확인하세요. 동기화 후에는 library_list와 document_read로 최신 revision을 다시 조회하세요. 연결 추가·삭제와 장치 페어링은 앱에서 진행하도록 안내하세요.
- PC 앱 업데이트는 update_check로 확인을 요청하고 update_status로 결과를 조회하세요. 사용자가 설치를 요청한 경우에만 availableVersion을 expectedVersion으로 전달해 update_install을 호출하세요. 확인·설치는 비동기이므로 요청 접수만으로 완료했다고 안내하지 마세요. error와 lastRequest.error를 확인하세요. 설치 시 앱과 MCP 연결이 종료될 수 있으며, 다시 연결한 뒤 currentVersion이 요청한 버전인지 확인하세요.
- Lof Writer 스킬의 설치·업데이트는 skill_status로 앱에 포함된 패키지를 확인하세요. AI 클라이언트의 실제 스킬 디렉터리를 확인한 뒤 앱과 같은 기기이면 skill_install을 사용하세요. skillsDirectory는 앱 기기의 절대 경로입니다. expectedRevision은 패키지 revision이고, 기존 설치본이 있으면 installed.revision도 expectedInstalledRevision으로 전달하세요. 원격 AI는 skill_get으로 받은 파일을 자기 기기에 설치하세요. 앱 업데이트 후 패키지가 바뀌었는지 다시 확인할 수 있으며, 설치 후 스킬 새로고침이나 새 세션이 필요합니다.
- 도구 응답의 isError와 오류 내용을 확인하고 성공한 작업만 완료했다고 안내하세요. 연결 오류가 나면 Lof Writer 앱의 실행 상태를 확인하도록 안내하세요."#;

pub fn tool_definitions() -> Value {
    let mut tools = json!([
        {
            "name": "library_list",
            "description": "작품과 문서 목록 및 revision 조회",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            }
        },
        {
            "name": "document_read",
            "description": "문서의 Markdown 본문과 revision 조회. startLine·endLine으로 필요한 줄만 읽거나 offset·limit으로 문자 구간을 읽는다. 줄 범위는 1부터 시작하며 양 끝을 포함한다",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0, "description": "본문의 UTF-16 시작 위치. 기본값 0. startLine·endLine과 함께 지정할 수 없음" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100000, "description": "반환할 본문의 최대 UTF-16 길이. 기본값 100000. 줄 범위 조회에도 적용" },
                    "startLine": { "type": "integer", "minimum": 1, "description": "읽기 시작할 본문 줄 번호. 기본값 1. document_search의 matches.line과 같으며 YAML 헤더 제외" },
                    "endLine": { "type": "integer", "minimum": 1, "description": "읽을 마지막 본문 줄 번호(포함). 생략하면 startLine부터 최대 200줄. 문서 끝을 넘으면 끝까지만 반환" }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_search",
            "description": "통합 검색. 작품(제목·소개·태그), 문서(제목·경로·태그), 본문의 일치한 줄, 공용 메모를 반환. 보관 문서는 기본 제외",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "검색어. rg처럼 정규식으로 해석하며 줄마다 적용(예: 주인공|조연, ^#{2,}\\s). 리터럴 괄호 등은 \\(처럼 이스케이프하고, 올바르지 않은 정규식은 입력한 글자 그대로 검색. #로 시작하면 태그만 검색" },
                    "projectId": { "type": "string", "description": "지정하면 해당 작품의 문서로 범위를 좁힘. 작품 검색은 항상 전체 대상" },
                    "caseSensitive": { "type": "boolean", "description": "대소문자 구분 여부. 기본값 false" },
                    "includeArchived": { "type": "boolean", "default": false, "description": "true이면 보관 문서와 보관 공용 메모도 포함. 기본값 false" }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "project_create",
            "description": "작품 만들기",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["title"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_create",
            "description": "회차, 플롯, 메모 생성. 플롯·메모는 doc/ 아래 folder에 만들고 episodeId로 회차에 연결할 수 있다",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": { "type": "string" },
                    "kind": { "type": "string", "enum": ["episode", "plot", "memo"] },
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "문서 태그" },
                    "manualLineBreak": { "type": "boolean", "description": "true 수동 줄바꿈 관리, false 자동 관리" },
                    "episodeId": { "type": "string" },
                    "folder": { "type": "string" },
                    "properties": { "type": "object", "description": "사용자 정의 YAML 속성" }
                },
                "required": ["projectId", "title"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_update",
            "description": "expectedRevision이 일치할 때만 본문과 메타데이터 저장",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "expectedRevision": { "type": "string" },
                    "body": { "type": "string" },
                    "title": { "type": "string" },
                    "status": { "type": "string", "enum": ["in_progress", "revision", "completed"] },
                    "episodeType": { "type": "integer", "enum": [0, 2, 3, 4, 6], "description": "0 일반, 2 프롤로그, 3 에필로그, 4 특별편, 6 단편" },
                    "description": { "type": "string", "description": "회차 요약" },
                    "authorComment": { "type": "string", "description": "작가의 말" },
                    "manualLineBreak": { "type": "boolean", "description": "true 수동 줄바꿈 관리, false 자동 줄바꿈 관리" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "properties": { "type": "object", "description": "사용자 정의 YAML 속성" },
                    "order": { "type": "number" },
                    "archived": { "type": "boolean" },
                    "episodeId": { "type": ["string", "null"] },
                    "kind": { "type": "string", "enum": ["plot", "memo"] }
                },
                "required": ["id", "expectedRevision"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_reorder",
            "description": "한 작품의 회차 순서를 ids 순서대로 바꾸고 파일 이름 번호를 다시 매김",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": { "type": "string" },
                    "ids": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["projectId", "ids"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_patch",
            "description": "정확히 한 번 일치하는 텍스트 교체. revision 필수",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "expectedRevision": { "type": "string" },
                    "find": { "type": "string", "minLength": 1 },
                    "replace": { "type": "string" }
                },
                "required": ["id", "expectedRevision", "find", "replace"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_apply_patch",
            "description": "본문에 문맥 기반 줄 패치를 한 번에 적용. @@ 구간, 공백 문맥 줄, - 삭제 줄, + 추가 줄을 사용한다. 여러 구간은 원본에서 각각 유일하게 일치하고 범위가 겹치지 않아야 한다. 빈 줄에도 접두사가 필요하다. 마지막 *** End of File은 본문 끝을 지정한다. 문맥 없는 추가는 빈 본문에만 허용한다. 파일 작업·줄 번호·메타데이터 변경은 지원하지 않는다. 실패 시 전체 미저장. 성공 시 문서와 새 revision, appliedHunks를 반환한다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "minLength": 1 },
                    "expectedRevision": { "type": "string", "minLength": 1 },
                    "patch": { "type": "string", "minLength": 1, "description": "예: @@\n 앞 문맥\n-이전 문장\n+새 문장\n 뒤 문맥. 기존 문맥과 삭제 줄은 공백까지 정확히 일치해야 한다. 추가 줄은 주변 CRLF/LF를 따르고 수정 범위 밖의 본문은 그대로 유지한다." }
                },
                "required": ["id", "expectedRevision", "patch"],
                "additionalProperties": false
            }
        },
        {
            "name": "sync_status",
            "description": "실시간 장치 연결과 파일 동기화(폴더, WebDAV, FTP)의 진행 상태, 오류, 연결 목록 조회. phase는 idle, pending, syncing, error 중 하나",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            }
        },
        {
            "name": "sync_now",
            "description": "주기를 기다리지 않고 동기화 요청. MCP로 문서를 변경하면 자동으로 요청되므로 다른 장치의 변경을 먼저 받을 때 사용한다. connectionId를 생략하면 모든 파일 연결과 실시간 장치에 요청하고, 지정하면 해당 파일 연결만 요청한다. 완료를 기다리지 않으므로 sync_status로 진행 상태를 확인한다",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connectionId": { "type": "string", "description": "sync_status의 connections에서 확인한 파일 연결 id" }
                },
                "required": [],
                "additionalProperties": false
            }
        },
        {
            "name": "history_list",
            "description": "최근 변경 이력 최대 100개",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }
        },
        {
            "name": "history_read",
            "description": "이력의 본문 확인",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["id", "name"],
                "additionalProperties": false
            }
        },
        {
            "name": "history_page",
            "description": "Git 문서 이력의 다음 페이지 조회. 첫 응답의 anchor를 다음 조회에도 전달하면 조회 중 새 기록이 생겨도 순서가 유지됩니다.",
            "inputSchema": {
                "type":"object",
                "properties":{"id":{"type":"string"},"offset":{"type":"integer","minimum":0},
                    "limit":{"type":"integer","minimum":1,"maximum":100},"anchor":{"type":"string"}},
                "required":["id"],"additionalProperties":false
            }
        },
        {
            "name": "history_restore",
            "description": "현재 revision 확인 후 이력 복원",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "name": { "type": "string" },
                    "expectedRevision": { "type": "string" }
                },
                "required": ["id", "name", "expectedRevision"],
                "additionalProperties": false
            }
        }
    ]);
    if cfg!(target_os = "windows") {
        tools.as_array_mut().unwrap().extend(crate::mcp_updater::tool_definitions().as_array().unwrap().iter().cloned());
    }
    tools.as_array_mut().unwrap().extend(crate::skills::tool_definitions().as_array().unwrap().iter().cloned());
    tools
}

// 서재와 별도로 처리하는 앱 도구의 실행기를 전달받는다.
pub type AppToolHandler = Arc<dyn Fn(&str, &Value) -> Result<Value, LofError> + Send + Sync>;

fn read_line_range(mut document: Value, args: &Value) -> Result<Value, LofError> {
    if args.get("offset").is_some() {
        return Err(fail_invalid("offset과 startLine·endLine은 함께 지정할 수 없습니다."));
    }
    let positive = |key: &str, default: usize| -> Result<usize, LofError> {
        match args.get(key) {
            None => Ok(default),
            Some(value) => value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| fail_invalid(format!("{key}은 1 이상의 정수여야 합니다."))),
        }
    };
    let start_line = positive("startLine", 1)?;
    let end_line = positive("endLine", start_line.saturating_add(199))?;
    let limit = positive("limit", 100_000)?;
    if end_line < start_line {
        return Err(fail_invalid("endLine은 startLine 이상이어야 합니다."));
    }
    if limit > 100_000 {
        return Err(fail_invalid("limit은 100000 이하여야 합니다."));
    }

    let body = document.get("body").and_then(Value::as_str).unwrap_or("");
    let mut start_byte = None;
    let mut end_byte = body.len();
    let mut total_lines = 0;
    // 검색과 동일하게 마지막 개행 뒤의 빈 줄과 빈 본문도 한 줄로 센다.
    for (index, byte) in std::iter::once(0)
        .chain(body.match_indices('\n').map(|(index, _)| index + 1))
        .enumerate()
    {
        let line = index + 1;
        total_lines = line;
        if line == start_line {
            start_byte = Some(byte);
        }
        if line.checked_sub(1) == Some(end_line) {
            end_byte = byte;
        }
    }
    let start_byte = start_byte.ok_or_else(|| {
        fail_invalid(format!("startLine이 문서의 전체 줄 수({total_lines})를 넘었습니다."))
    })?;
    let selected = &body[start_byte..end_byte];
    // 문자 경계에서 잘라 이모지 등 서로게이트 쌍을 보존한다.
    let sliced = slice_utf16(selected, limit);
    if sliced.is_empty() && !selected.is_empty() {
        return Err(fail_invalid("첫 문자를 반환할 수 있도록 limit을 2 이상으로 지정하세요."));
    }
    let range_truncated = sliced.len() < selected.len();
    let newline_count = sliced.bytes().filter(|byte| *byte == b'\n').count();
    let actual_end_line = if range_truncated {
        start_line + newline_count - usize::from(sliced.ends_with('\n'))
    } else {
        end_line.min(total_lines)
    };
    let next_line = if range_truncated {
        sliced.ends_with('\n').then_some(start_line + newline_count)
    } else {
        (actual_end_line < total_lines).then(|| actual_end_line + 1)
    };
    let offset = utf16_len(&body[..start_byte]);
    let next_offset = offset + utf16_len(&sliced);
    let total_length = utf16_len(body);
    let truncated = start_line > 1 || range_truncated || actual_end_line < total_lines;
    if let Some(object) = document.as_object_mut() {
        object.insert("body".into(), json!(sliced));
        object.insert("offset".into(), json!(offset));
        object.insert("totalLength".into(), json!(total_length));
        object.insert("startLine".into(), json!(start_line));
        object.insert("endLine".into(), json!(actual_end_line));
        object.insert("totalLines".into(), json!(total_lines));
        object.insert("truncated".into(), json!(truncated));
        object.insert("rangeTruncated".into(), json!(range_truncated));
        object.insert("nextLine".into(), json!(next_line));
        object.insert(
            "nextOffset".into(),
            json!((next_offset < total_length).then_some(next_offset)),
        );
    }
    Ok(document)
}

fn call_tool(
    store: &Arc<Mutex<Option<Store>>>,
    name: &str,
    args: &Value,
    on_mutate: &Arc<dyn Fn() + Send + Sync>,
    on_app_tool: &AppToolHandler,
) -> Result<Value, LofError> {
    // 앱 작업은 서재 잠금 없이 전달해 저장·설치 요청과 문서 작업이 서로 기다리지 않게 한다.
    if name == "document_search" || name.starts_with("sync_") || name.starts_with("update_") || name.starts_with("skill_") {
        return on_app_tool(name, args);
    }
    let mut guard = store
        .lock()
        .map_err(|_| fail("Store not initialized", "ERROR"))?;
    let Some(ref mut st) = *guard else {
        return Err(fail("Store not initialized", "ERROR"));
    };
    if matches!(name, "project_create" | "document_create" | "document_update" | "document_patch" | "document_apply_patch" | "document_reorder" | "history_restore") {
        on_app_tool("update_write_guard", &json!({}))?;
    }
    dispatch(st, name, args, &**on_mutate)
}

pub fn dispatch(
    store: &mut Store,
    name: &str,
    args: &Value,
    on_mutate: &dyn Fn(),
) -> Result<Value, LofError> {
    if !matches!(name,"library_list"|"document_read"|"history_list"|"history_read"|"history_page"){
        store.require_database()?;
    }
    match name {
        "library_list" => store.list(),
        "document_read" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut d = store.read(id)?;
            if args.get("startLine").is_some() || args.get("endLine").is_some() {
                return read_line_range(d, args);
            }
            let body = d
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let offset = args
                .get("offset")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .max(0) as usize;
            let limit = args
                .get("limit")
                .and_then(|v| v.as_i64())
                .unwrap_or(100_000)
                .clamp(1, 100_000) as usize;
            let total_len = utf16_len(&body);
            let sliced = slice_utf16_range(&body, offset, offset + limit);
            if let Some(dobj) = d.as_object_mut() {
                dobj.insert("body".to_string(), json!(sliced));
                dobj.insert("offset".to_string(), json!(offset));
                dobj.insert("totalLength".to_string(), json!(total_len));
                dobj.insert("truncated".to_string(), json!(offset + limit < total_len));
            }
            Ok(d)
        }
        "project_create" => {
            let r = store.create_project(args)?;
            on_mutate();
            Ok(r)
        }
        "document_create" => {
            let r = store.create(args)?;
            on_mutate();
            Ok(r)
        }
        "document_update" => {
            let r = store.save(args)?;
            on_mutate();
            Ok(r)
        }
        "document_reorder" => {
            let r = store.reorder(args)?;
            on_mutate();
            Ok(json!(r))
        }
        "document_patch" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let d = store.read(id)?;
            let Some(find_str) = args.get("find").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            else {
                return Err(fail_invalid("find와 replace가 필요합니다."));
            };
            let Some(replace_str) = args.get("replace").and_then(|v| v.as_str()) else {
                return Err(fail_invalid("find와 replace가 필요합니다."));
            };
            let body = d.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let Some(first_idx) = body.find(find_str) else {
                return Err(fail_invalid("find는 본문에서 정확히 한 번 일치해야 합니다."));
            };
            if body[first_idx + find_str.len()..].contains(find_str) {
                return Err(fail_invalid("find는 본문에서 정확히 한 번 일치해야 합니다."));
            }
            let next_body = format!(
                "{}{}{}",
                &body[..first_idx],
                replace_str,
                &body[first_idx + find_str.len()..]
            );
            let r = store.save(&json!({
                "id": d.get("id"),
                "expectedRevision": args.get("expectedRevision"),
                "body": next_body,
            }))?;
            on_mutate();
            Ok(r)
        }
        "document_apply_patch" => {
            let Some(input) = args.as_object() else {
                return Err(fail_invalid("id, expectedRevision, patch가 필요합니다."));
            };
            if input
                .keys()
                .any(|key| !matches!(key.as_str(), "id" | "expectedRevision" | "patch"))
            {
                return Err(fail_invalid(
                    "document_apply_patch는 id, expectedRevision, patch만 받습니다.",
                ));
            }
            let required = |key: &str| {
                args.get(key)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        fail_invalid(format!("{key}는 비어 있지 않은 문자열이어야 합니다."))
                    })
            };
            let id = required("id")?;
            let expected = required("expectedRevision")?;
            let patch = required("patch")?;
            let current = store.read(id)?;
            if current.get("revision").and_then(Value::as_str) != Some(expected) {
                return Err(fail(
                    "다른 곳에서 수정된 문서입니다. 현재 내용을 다시 확인해 주세요.",
                    "CONFLICT",
                ));
            }
            let applied = crate::document_patch::apply(
                current.get("body").and_then(Value::as_str).unwrap_or(""),
                patch,
            )?;
            let mut saved = store.save(&json!({
                "id": id,
                "expectedRevision": expected,
                "body": applied.body,
            }))?;
            saved["appliedHunks"] = json!(applied.hunks);
            on_mutate();
            Ok(saved)
        }
        "history_list" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            store.history(id)
        }
        "history_page" => {
            let id = args["id"].as_str().unwrap_or("");
            let offset = args["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize;
            let limit = args["limit"].as_u64().unwrap_or(100).clamp(1,100) as usize;
            store.history_page(id, offset, limit, args["anchor"].as_str())
        }
        "history_read" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let hname = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
            store.history_read(id, hname)
        }
        "history_restore" => {
            let r = store.restore(args)?;
            on_mutate();
            Ok(r)
        }
        _ => Err(fail_invalid("지원하지 않는 도구")),
    }
}

pub struct ApiServer {
    pub port: u16,
    pub token: String,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn send_json(stream: &mut TcpStream, status: u16, body: Option<&Value>) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Error",
    };
    let payload = body
        .map(|b| serde_json::to_string(b).unwrap_or_default())
        .unwrap_or_default();
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        payload.len(),
        payload
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn handle_client(
    mut stream: TcpStream,
    token: &str,
    store: &Arc<Mutex<Option<Store>>>,
    on_mutate: &Arc<dyn Fn() + Send + Sync>,
    on_app_tool: &AppToolHandler,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
        return;
    }
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0].to_string();
    let url = parts[1].to_string();

    let mut host = String::new();
    let mut origin = None;
    let mut auth = String::new();
    let mut content_length: usize = 0;

    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            match key.as_str() {
                "host" => host = val,
                "origin" => origin = Some(val),
                "authorization" => auth = val,
                "content-length" => content_length = val.parse::<usize>().unwrap_or(0),
                _ => {}
            }
        }
    }

    if origin.is_some() {
        send_json(
            &mut stream,
            403,
            Some(&json!({ "error": "Browser origins are not allowed" })),
        );
        return;
    }

    let valid_host = host
        .strip_prefix("127.0.0.1:")
        .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !valid_host {
        send_json(&mut stream, 403, Some(&json!({ "error": "Invalid host" })));
        return;
    }

    if url == "/health" && method == "GET" {
        send_json(
            &mut stream,
            200,
            Some(&json!({ "name": "Lof Writer", "version": env!("CARGO_PKG_VERSION") })),
        );
        return;
    }

    let expected_auth = format!("Bearer {}", token);
    if !constant_time_eq(auth.as_bytes(), expected_auth.as_bytes()) {
        send_json(&mut stream, 401, Some(&json!({ "error": "Unauthorized" })));
        return;
    }

    if method != "POST" || (url != "/mcp" && url != "/rpc") {
        send_json(&mut stream, 404, Some(&json!({ "error": "Not found" })));
        return;
    }

    if content_length > 12_000_000 {
        send_json(
            &mut stream,
            400,
            Some(&json!({ "error": "Request too large", "code": "ERROR" })),
        );
        return;
    }

    let mut body_buf = vec![0u8; content_length];
    if reader.read_exact(&mut body_buf).is_err() {
        send_json(
            &mut stream,
            400,
            Some(&json!({ "error": "Failed to read body", "code": "ERROR" })),
        );
        return;
    }

    let data: Value = match serde_json::from_slice(&body_buf) {
        Ok(v) => v,
        Err(e) => {
            send_json(
                &mut stream,
                400,
                Some(&json!({ "error": e.to_string(), "code": "ERROR" })),
            );
            return;
        }
    };

    let tools = tool_definitions();
    let tools_arr = tools.as_array().unwrap();

    if url == "/rpc" {
        let op_name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let has_def = tools_arr
            .iter()
            .any(|t| t.get("name").and_then(|v| v.as_str()) == Some(op_name));
        if !has_def {
            send_json(
                &mut stream,
                400,
                Some(&json!({ "error": "Unknown operation", "code": "ERROR" })),
            );
            return;
        }
        let args = data.get("arguments").cloned().unwrap_or_else(|| json!({}));
        match call_tool(store, op_name, &args, on_mutate, on_app_tool) {
            Ok(result) => send_json(&mut stream, 200, Some(&json!({ "result": result }))),
            Err(e) => {
                let status = if e.code == "CONFLICT" { 409 } else { 400 };
                send_json(
                    &mut stream,
                    status,
                    Some(&json!({ "error": e.message, "code": e.code })),
                );
            }
        }
        return;
    }

    // /mcp JSON-RPC 2.0
    let Some(id) = data.get("id").cloned() else {
        send_json(&mut stream, 202, None);
        return;
    };
    let rpc_method = data.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = data.get("params").cloned().unwrap_or_else(|| json!({}));

    match rpc_method {
        "initialize" => {
            let req_ver = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let proto_ver = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
                .contains(&req_ver)
            {
                req_ver
            } else {
                "2025-03-26"
            };
            send_json(
                &mut stream,
                200,
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": proto_ver,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "lof-writer", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": MCP_INSTRUCTIONS
                    }
                })),
            );
        }
        "ping" => {
            send_json(
                &mut stream,
                200,
                Some(&json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
            );
        }
        "tools/list" => {
            send_json(
                &mut stream,
                200,
                Some(&json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })),
            );
        }
        "tools/call" => {
            let tname = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let targs = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let res = call_tool(store, tname, &targs, on_mutate, on_app_tool);
            match res {
                Ok(val) => {
                    let text = serde_json::to_string(&val).unwrap_or_default();
                    send_json(
                        &mut stream,
                        200,
                        Some(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{ "type": "text", "text": text }]
                            }
                        })),
                    );
                }
                Err(e) => {
                    let err_text = serde_json::to_string(&json!({
                        "error": e.message,
                        "code": e.code,
                    }))
                    .unwrap_or_default();
                    send_json(
                        &mut stream,
                        200,
                        Some(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "isError": true,
                                "content": [{ "type": "text", "text": err_text }]
                            }
                        })),
                    );
                }
            }
        }
        _ => {
            send_json(
                &mut stream,
                200,
                Some(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "Method not found" }
                })),
            );
        }
    }
}

pub fn start_api(
    store: Arc<Mutex<Option<Store>>>,
    on_mutate: Arc<dyn Fn() + Send + Sync>,
    on_app_tool: AppToolHandler,
) -> Result<ApiServer, LofError> {
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = hex::encode(token_bytes);

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token_clone = token.clone();

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let tok = token_clone.clone();
            let st = Arc::clone(&store);
            let cb = Arc::clone(&on_mutate);
            let app_tool = Arc::clone(&on_app_tool);
            thread::spawn(move || {
                handle_client(stream, &tok, &st, &cb, &app_tool);
            });
        }
    });

    Ok(ApiServer { port, token })
}

pub fn run_mcp_stdio() {
    let runtime_path = std::env::var("LOF_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let config_root = std::env::var("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    let home = std::env::var("USERPROFILE")
                        .or_else(|_| std::env::var("HOME"))
                        .unwrap_or_else(|_| ".".to_string());
                    PathBuf::from(home).join(".config")
                });
            config_root.join("Lof Writer").join("runtime.json")
        });

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Option<Value> = serde_json::from_str(&line).ok();
        let msg_id = msg.as_ref().and_then(|m| m.get("id")).cloned();

        let res: Result<Option<String>, String> = (|| {
            let Some(ref m) = msg else {
                return Err("Invalid JSON".to_string());
            };
            let raw_rt = std::fs::read_to_string(&runtime_path).map_err(|e| e.to_string())?;
            let conn: Value = serde_json::from_str(&raw_rt).map_err(|e| e.to_string())?;
            let port = conn.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
            let token = conn.get("token").and_then(|v| v.as_str()).unwrap_or("");
            if port == 0 || port > 65535 || token.is_empty() {
                return Err("잘못된 연결 파일".to_string());
            }
            let resp = client
                .post(format!("http://127.0.0.1:{}/mcp", port))
                .header("Authorization", format!("Bearer {}", token))
                .header("Content-Type", "application/json")
                .body(line.clone())
                .send()
                .map_err(|e| e.to_string())?;
            if m.get("id").is_some() {
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status().as_u16()));
                }
                let text = resp.text().map_err(|e| e.to_string())?;
                let val: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                return Ok(Some(serde_json::to_string(&val).unwrap_or_default()));
            }
            Ok(None)
        })();

        match res {
            Ok(Some(out_line)) => {
                let _ = writeln!(stdout, "{}", out_line);
                let _ = stdout.flush();
            }
            Ok(None) => {}
            Err(err_msg) => {
                if let Some(id) = msg_id {
                    let err_json = serde_json::to_string(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32603,
                            "message": format!("Lof Writer 앱을 실행해 주세요. {}", err_msg)
                        }
                    }))
                    .unwrap_or_default();
                    let _ = writeln!(stdout, "{}", err_json);
                    let _ = stdout.flush();
                } else {
                    eprintln!("Lof Writer 연결 실패");
                }
            }
        }
    }
}
