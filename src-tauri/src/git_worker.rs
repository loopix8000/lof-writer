use crate::{schedule_notify, AppState};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Condvar, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct GitWorker {
    activities: Mutex<HashMap<String, (u64, bool, Instant)>>,
    stopped: AtomicBool,
    wait: Mutex<()>,
    wake: Condvar,
}

impl GitWorker {
    pub fn editing(&self, client: &str, sequence: u64, active: bool) {
        let mut activities = self.activities.lock().unwrap();
        if activities
            .get(client)
            .is_none_or(|(previous, _, _)| sequence > *previous)
        {
            activities.insert(client.to_string(), (sequence, active, Instant::now()));
        }
    }

    fn has_editing(&self) -> bool {
        let mut activities = self.activities.lock().unwrap();
        // 편집기는 입력 중에만 임대를 갱신한다. 웹뷰가 비정상 종료돼도 영구 대기하지 않는다.
        activities.retain(|_, (_, _, seen)| seen.elapsed() < Duration::from_secs(60));
        activities.values().any(|(_, active, _)| *active)
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let worker = app.state::<GitWorker>();
        let mut retry_after = Instant::now();
        let mut retry_root = std::path::PathBuf::new();
        while !worker.stopped.load(Ordering::SeqCst) {
            let state = app.state::<AppState>();
            let editing = worker.has_editing();
            let changed = {
                let mut guard = state.store.lock().unwrap();
                if let Some(store) = guard.as_mut() {
                    if store.root != retry_root {
                        retry_root = store.root.clone();
                        retry_after = Instant::now();
                    }
                    let changed = if Instant::now() >= retry_after {
                        let before = store.local_git.status();
                        if store.git_tick(false, editing).is_err() {
                            retry_after = Instant::now() + Duration::from_secs(30);
                        }
                        before != store.local_git.status()
                    } else {
                        false
                    };
                    // 모아 둔 서재 색인은 Git 기록 재시도와 상관없이 일정 간격으로 남긴다.
                    if let Err(error) = store.index.flush_due() {
                        eprintln!("서재 색인을 기록하지 못했습니다: {}", error.message);
                    }
                    changed
                } else {
                    false
                }
            };
            if changed {
                schedule_notify(&app, &state.notify_seq);
            }
            let wait = worker.wait.lock().unwrap();
            if worker.stopped.load(Ordering::SeqCst) {
                break;
            }
            let _ = worker
                .wake
                .wait_timeout(wait, Duration::from_secs(1))
                .unwrap();
        }
    });
}

pub fn stop(app: &AppHandle) {
    let worker = app.state::<GitWorker>();
    worker.stopped.store(true, Ordering::SeqCst);
    worker.wake.notify_all();
    let state = app.state::<AppState>();
    if let Some(store) = state.store.lock().unwrap().as_mut() {
        // 종료할 때는 저장된 원고만 기록한다. 미완료 이관은 다음 실행 때 이어서 진행한다.
        if let Err(error) = store.git_tick(true, false) {
            eprintln!(
                "종료 시 로컬 이력 기록을 완료하지 못했습니다: {}",
                error.message
            );
        }
    };
}

pub fn activity(app: &AppHandle, args: &Value) -> Result<Value, crate::error::LofError> {
    let client = args["client"]
        .as_str()
        .filter(|client| crate::error::valid_id(client))
        .ok_or_else(|| crate::error::fail_invalid("편집기 식별자가 올바르지 않습니다."))?;
    let sequence = args["sequence"]
        .as_u64()
        .ok_or_else(|| crate::error::fail_invalid("입력 순서가 올바르지 않습니다."))?;
    let active = args["active"]
        .as_bool()
        .ok_or_else(|| crate::error::fail_invalid("입력 상태가 올바르지 않습니다."))?;
    app.state::<GitWorker>().editing(client, sequence, active);
    Ok(serde_json::json!(true))
}
