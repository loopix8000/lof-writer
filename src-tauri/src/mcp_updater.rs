//! MCP의 업데이트 요청을 화면과 같은 저장·설치 경로에 전달한다.
use crate::error::{fail, fail_invalid, LofError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    channel: String,
    phase: String,
    available_version: Option<String>,
    progress: Option<f64>,
    error: String,
}

fn busy(phase: &str) -> bool {
    matches!(phase, "checking" | "downloading" | "saving" | "installing")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    session: String,
    action: String,
    channel: String,
    expected_version: Option<String>,
}
struct Pending {
    request: Request,
    queued_at: Instant,
    started: bool,
}
#[derive(Default)]
struct State {
    session: String,
    sequence: u64,
    snapshot: Option<Snapshot>,
    pending: Option<Pending>,
    last_request: Option<Value>,
}
impl State {
    fn expire(&mut self) {
        if self.pending.as_ref().is_some_and(|pending| {
            !pending.started && pending.queued_at.elapsed() > Duration::from_secs(15)
        }) {
            if let Some(pending) = &self.pending {
                self.last_request = Some(
                    json!({"id":pending.request.id,"action":pending.request.action,
                    "error":"업데이트 화면의 응답이 없습니다. 앱을 확인한 뒤 다시 시도해 주세요."}),
                );
            }
            self.pending = None;
            if let Some(snapshot) = self.snapshot.as_mut() {
                if !busy(&snapshot.phase) {
                    snapshot.phase = "error".into();
                    snapshot.error =
                        "업데이트 화면의 응답이 없습니다. 앱을 확인한 뒤 다시 시도해 주세요."
                            .into();
                }
            }
        }
    }
}
#[derive(Default)]
pub struct McpUpdater(Mutex<State>);

pub fn tool_definitions() -> Value {
    json!([
        {"name":"update_status","description":"PC 앱의 currentVersion, 선택된 channel, availableVersion, ready, busy, phase, progress, error와 lastRequest 조회. 마지막 MCP 요청의 오류는 lastRequest.error로 확인한다. 설치로 앱이 다시 시작되면 currentVersion으로 완료 여부를 확인한다",
         "inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"update_check","description":"PC 앱에서 현재 선택한 채널의 업데이트 확인 요청. 즉시 반환하므로 update_status로 pending/checking이 끝날 때까지 확인한다. 채널은 앱 설정에서 변경한다",
         "inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"update_install","description":"사용자가 앱 업데이트를 요청했을 때 확인한 버전의 다운로드·설치 요청. 열린 원고·메모 저장에 실패하면 설치를 중단한다. 설치 시 앱이 종료되고 다시 실행된다. 즉시 반환하므로 update_status로 진행 상태를 확인한다",
         "inputSchema":{"type":"object","properties":{"expectedVersion":{"type":"string","minLength":1,"description":"update_status의 availableVersion을 그대로 전달"}},"required":["expectedVersion"],"additionalProperties":false}}
    ])
}

pub fn status(app: &AppHandle) -> Value {
    let controller = app.state::<McpUpdater>();
    let mut state = controller.0.lock().unwrap();
    state.expire();
    let mut value = crate::updater_status(app.clone());
    value["currentVersion"] = json!(app.package_info().version.to_string());
    value["ready"] = json!(!state.session.is_empty() && state.snapshot.is_some());
    value["phase"] = json!("idle");
    value["channel"] = json!("stable");
    value["availableVersion"] = Value::Null;
    value["progress"] = Value::Null;
    value["error"] = json!("");
    if let Some(snapshot) = &state.snapshot {
        for (key, item) in serde_json::to_value(snapshot).unwrap().as_object().unwrap() {
            value[key] = item.clone();
        }
    }
    value["busy"] = json!(state.pending.is_some() || busy(value["phase"].as_str().unwrap_or("")));
    value["requestId"] = state
        .pending
        .as_ref()
        .map(|pending| json!(pending.request.id))
        .unwrap_or(Value::Null);
    value["lastRequest"] = state.last_request.clone().unwrap_or(Value::Null);
    if state.pending.is_some() && !busy(value["phase"].as_str().unwrap_or("")) {
        value["phase"] = json!("pending");
    }
    value
}

pub fn ensure_writable(app: &AppHandle) -> Result<Value, LofError> {
    let controller = app.state::<McpUpdater>();
    let state = controller.0.lock().unwrap();
    if state
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| matches!(snapshot.phase.as_str(), "saving" | "installing"))
    {
        return Err(fail(
            "업데이트 설치를 위해 원고를 저장 중입니다. 앱이 다시 실행된 뒤 시도해 주세요.",
            "UPDATE_BUSY",
        ));
    }
    Ok(json!(true))
}

pub fn tool(app: &AppHandle, name: &str, args: &Value) -> Result<Value, LofError> {
    if !cfg!(target_os = "windows") {
        return Err(fail(
            "PC Windows 앱에서만 사용할 수 있습니다.",
            "UPDATE_UNSUPPORTED",
        ));
    }
    if name == "update_status" {
        return Ok(status(app));
    }
    let action = match name {
        "update_check" => "check",
        "update_install" => "install",
        _ => return Err(fail_invalid("지원하지 않는 도구")),
    };
    let configured = crate::updater_status(app.clone());
    if configured["configured"] != true {
        return Err(fail(
            "앱 업데이트가 구성되지 않았습니다.",
            "UPDATE_UNAVAILABLE",
        ));
    }
    let request = {
        let controller = app.state::<McpUpdater>();
        let mut state = controller.0.lock().unwrap();
        state.expire();
        let snapshot = state.snapshot.as_ref().ok_or_else(|| {
            fail(
                "업데이트 화면을 준비하는 중입니다. 잠시 후 다시 시도해 주세요.",
                "UPDATE_NOT_READY",
            )
        })?;
        if state.pending.is_some() || busy(&snapshot.phase) {
            return Err(fail("이미 업데이트 작업을 진행 중입니다.", "UPDATE_BUSY"));
        }
        let version = if action == "install" {
            let version = args["expectedVersion"]
                .as_str()
                .filter(|version| !version.is_empty())
                .ok_or_else(|| fail_invalid("확인한 업데이트 버전이 필요합니다."))?;
            if snapshot.available_version.as_deref() != Some(version) {
                return Err(fail(
                    "업데이트 후보가 달라졌습니다. update_check로 다시 확인해 주세요.",
                    "UPDATE_CHANGED",
                ));
            }
            Some(version.to_string())
        } else {
            None
        };
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            session: state.session.clone(),
            action: action.into(),
            channel: snapshot.channel.clone(),
            expected_version: version,
        };
        state.pending = Some(Pending {
            request: request.clone(),
            queued_at: Instant::now(),
            started: false,
        });
        request
    };
    if let Err(error) = app.emit_to("main", "lof:update-request", &request) {
        let controller = app.state::<McpUpdater>();
        let mut state = controller.0.lock().unwrap();
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request.id == request.id)
        {
            state.pending = None;
        }
        return Err(fail(error.to_string(), "UPDATE_NOT_READY"));
    }
    Ok(json!({"requested":true,"requestId":request.id,"status":status(app)}))
}

#[tauri::command]
pub fn desktop_update_register(app: AppHandle, window: WebviewWindow) -> Result<String, String> {
    if !cfg!(target_os = "windows") || window.label() != "main" {
        return Err("PC 앱에서만 사용할 수 있습니다.".into());
    }
    let session = uuid::Uuid::new_v4().to_string();
    *app.state::<McpUpdater>().0.lock().unwrap() = State {
        session: session.clone(),
        ..State::default()
    };
    Ok(session)
}

#[tauri::command]
pub fn desktop_update_unregister(app: AppHandle, session: String) {
    let controller = app.state::<McpUpdater>();
    let mut state = controller.0.lock().unwrap();
    if state.session == session {
        *state = State::default();
    }
}

#[tauri::command]
pub fn desktop_update_claim(app: AppHandle, session: String, request_id: String) -> bool {
    let controller = app.state::<McpUpdater>();
    let mut state = controller.0.lock().unwrap();
    state.expire();
    if state.session != session {
        return false;
    }
    if let Some(pending) = state
        .pending
        .as_mut()
        .filter(|pending| pending.request.id == request_id && !pending.started)
    {
        pending.started = true;
        return true;
    }
    false
}

#[tauri::command]
pub fn desktop_update_report(
    app: AppHandle,
    session: String,
    sequence: u64,
    snapshot: Snapshot,
    completed: Option<String>,
    request_error: Option<String>,
) -> Result<(), String> {
    if !matches!(snapshot.channel.as_str(), "stable" | "rc" | "beta")
        || !matches!(
            snapshot.phase.as_str(),
            "idle"
                | "checking"
                | "current"
                | "available"
                | "downloading"
                | "saving"
                | "installing"
                | "error"
        )
    {
        return Err("업데이트 상태가 올바르지 않습니다.".into());
    }
    let controller = app.state::<McpUpdater>();
    let mut state = controller.0.lock().unwrap();
    if state.session != session {
        return Ok(());
    }
    if state
        .pending
        .as_ref()
        .is_some_and(|pending| completed.as_deref() == Some(pending.request.id.as_str()))
    {
        let pending = state.pending.as_ref().unwrap();
        let error = request_error.or_else(|| {
            if snapshot.phase == "error" {
                Some(snapshot.error.clone())
            } else {
                None
            }
        });
        state.last_request = Some(
            json!({"id":pending.request.id,"action":pending.request.action,
            "phase":snapshot.phase,"error":error}),
        );
        state.pending = None;
    }
    if sequence > state.sequence {
        state.sequence = sequence;
        state.snapshot = Some(snapshot);
    }
    Ok(())
}
