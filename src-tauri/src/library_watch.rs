//! Lof Library 서버의 변경 알림(SSE)을 받아 다른 기기가 바꾼 원고를 주기를 기다리지 않고 동기화한다.

use crate::{auto_sync, decrypt_connection, sync::library, AppState};
use reqwest::blocking::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const CHECK_INTERVAL: Duration = Duration::from_secs(5);
const MAX_RETRY: Duration = Duration::from_secs(60);

#[derive(Clone, PartialEq)]
struct Target {
    url: String,
    token: String,
    library: String,
}

/// 설정의 서버 연결 중 서재를 고른 연결만 실시간 수신 대상으로 삼는다.
fn targets(app: &AppHandle) -> HashMap<String, Target> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    settings.get("connections").and_then(Value::as_array).into_iter().flatten()
        .filter(|conn| conn["type"].as_str() == Some("library"))
        .filter_map(|conn| {
            let id = conn["id"].as_str()?.to_string();
            let library = conn["libraryId"].as_str().filter(|id| !id.is_empty())?.to_string();
            let decrypted = decrypt_connection(conn).ok()?;
            Some((id, Target {
                url: decrypted["url"].as_str()?.to_string(),
                token: decrypted["password"].as_str()?.to_string(),
                library,
            }))
        })
        .collect()
}

pub fn start(app: &AppHandle) {
    if !auto_sync::LIBRARY_SYNC_ENABLED { return; }
    let app = app.clone();
    thread::spawn(move || {
        let mut running: HashMap<String, (Target, Arc<AtomicBool>)> = HashMap::new();
        while !auto_sync::stopped(&app) {
            let wanted = targets(&app);
            // 지워졌거나 주소·키·서재가 바뀐 연결의 수신을 멈추고 새로 시작한다.
            running.retain(|id, (target, stop)| {
                let keep = wanted.get(id) == Some(target);
                if !keep {
                    stop.store(true, Ordering::SeqCst);
                }
                keep
            });
            for (id, target) in wanted {
                if running.contains_key(&id) {
                    continue;
                }
                let stop = Arc::new(AtomicBool::new(false));
                running.insert(id.clone(), (target.clone(), stop.clone()));
                let app = app.clone();
                thread::spawn(move || listen(app, id, target, stop));
            }
            thread::sleep(CHECK_INTERVAL);
        }
        for (_, stop) in running.values() {
            stop.store(true, Ordering::SeqCst);
        }
    });
}

fn listen(app: AppHandle, connection: String, target: Target, stop: Arc<AtomicBool>) {
    let mut delay = Duration::from_secs(2);
    while !stop.load(Ordering::SeqCst) && !auto_sync::stopped(&app) {
        if stream(&app, &connection, &target, &stop).is_ok() {
            delay = Duration::from_secs(2);
        }
        let mut waited = Duration::ZERO;
        while waited < delay && !stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(500));
            waited += Duration::from_millis(500);
        }
        delay = (delay * 2).min(MAX_RETRY);
    }
}

/// 연결이 끊길 때까지 변경 알림을 읽는다. 서버는 15초마다 연결 유지 신호를 보낸다.
fn stream(app: &AppHandle, connection: &str, target: &Target, stop: &AtomicBool) -> Result<(), ()> {
    let base = library::normalize_url(&target.url).map_err(|_| ())?;
    let client = Client::builder().connect_timeout(Duration::from_secs(10)).timeout(None).build().map_err(|_| ())?;
    // 지금 위치부터 받기 위해 서버 목록의 현재 커서를 쓴다. 끊겨 있던 동안의 변경은 아래 즉시 동기화가 맞춘다.
    let listing: Value = client.get(format!("{base}/v1/libraries/{}/snapshot", target.library))
        .bearer_auth(&target.token).timeout(Duration::from_secs(30)).send().map_err(|_| ())?
        .error_for_status().map_err(|_| ())?.json().map_err(|_| ())?;
    let cursor = listing["cursor"].as_i64().unwrap_or(0);
    let response = client.get(format!("{base}/v1/libraries/{}/events?after={cursor}", target.library))
        .bearer_auth(&target.token).header("Accept", "text/event-stream").send().map_err(|_| ())?
        .error_for_status().map_err(|_| ())?;
    auto_sync::request_connection(app, connection);
    for line in BufReader::new(response).lines() {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let line = line.map_err(|_| ())?;
        let Some(data) = line.strip_prefix("data: ") else { continue };
        let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
        if !matches!(event["type"].as_str(), Some("document.updated" | "document.deleted")) {
            continue;
        }
        let id = event["data"]["id"].as_str().unwrap_or_default();
        let version = event["data"]["version"].as_i64().unwrap_or(0);
        // 이 기기가 보낸 변경은 다시 받을 필요가 없다.
        if !library::take_own(connection, id, version) {
            auto_sync::request_connection(app, connection);
        }
    }
    Ok(())
}
