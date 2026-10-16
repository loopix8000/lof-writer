use crate::error::{fail_invalid, slice_utf16_range, utf16_len, LofError};
use crate::store::Store;
use rand::RngCore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub fn tool_definitions() -> Value {
    json!([
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
            "description": "문서의 Markdown 본문과 revision 조회",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100000 }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        },
        {
            "name": "document_search",
            "description": "제목과 본문 검색",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "projectId": { "type": "string" }
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
                    "status": { "type": "string", "enum": ["planned", "in_progress", "revision", "completed"] },
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
    ])
}

pub fn dispatch(
    store: &mut Store,
    name: &str,
    args: &Value,
    on_mutate: &dyn Fn(),
) -> Result<Value, LofError> {
    if !matches!(name,"library_list"|"document_read"|"document_search"|"history_list"|"history_read"){
        store.require_database()?;
    }
    match name {
        "library_list" => store.list(),
        "document_read" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let mut d = store.read(id)?;
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
        "document_search" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let pid = args.get("projectId").and_then(|v| v.as_str());
            store.search(q, pid)
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
        "history_list" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            store.history(id)
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
        let mut guard = match store.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(ref mut st) = *guard else {
            send_json(
                &mut stream,
                400,
                Some(&json!({ "error": "Store not initialized", "code": "ERROR" })),
            );
            return;
        };
        match dispatch(st, op_name, &args, &**on_mutate) {
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
                        "serverInfo": { "name": "lof-writer", "version": env!("CARGO_PKG_VERSION") }
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
            let res = {
                let mut guard = store.lock().unwrap();
                if let Some(ref mut st) = *guard {
                    dispatch(st, tname, &targs, &**on_mutate)
                } else {
                    Err(fail_invalid("Store not initialized"))
                }
            };
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
            thread::spawn(move || {
                handle_client(stream, &tok, &st, &cb);
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
