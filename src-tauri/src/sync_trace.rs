//! 동기화 대기 구간을 원고 내용 없이 기록한다. 로그 I/O는 전송 스레드에서 분리한다.
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::{atomic::{AtomicU64, Ordering}, mpsc::{self, SyncSender}, OnceLock},
    time::Instant,
};

fn record(value: Value) {
    static SENDER: OnceLock<SyncSender<Value>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Value>(256);
        let directory = crate::get_user_dir();
        let _ = std::thread::Builder::new().name("sync-trace".into()).spawn(move || {
            let path = directory.join("sync-timing.jsonl");
            let previous = directory.join("sync-timing.previous.jsonl");
            for value in receiver {
                android_log(&value);
                let write = || -> std::io::Result<()> {
                    fs::create_dir_all(&directory)?;
                    if fs::metadata(&path).is_ok_and(|meta| meta.len() >= 1_048_576) {
                        if previous.try_exists()? { fs::remove_file(&previous)?; }
                        fs::rename(&path, &previous)?;
                    }
                    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
                    writeln!(file, "{value}")
                };
                let _ = write();
            }
        });
        sender
    });
    // 로깅이 밀려도 사용자의 저장과 동기화를 기다리게 하지 않는다.
    let _ = sender.try_send(value);
}

// 배포 APK도 adb에서 병목 구간을 확인할 수 있게 개인정보 없는 동일 기록만 남긴다.
#[cfg(target_os = "android")]
fn android_log(value: &Value) {
    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(priority: std::ffi::c_int, tag: *const std::ffi::c_char,
            text: *const std::ffi::c_char) -> std::ffi::c_int;
    }
    if let Ok(message) = std::ffi::CString::new(value.to_string()) {
        unsafe { __android_log_write(4, c"LofSync".as_ptr(), message.as_ptr()); }
    }
}

#[cfg(not(target_os = "android"))]
fn android_log(_: &Value) {}

pub(crate) struct Span {
    id: u64,
    started: Instant,
}

fn operation_name(operation: &str) -> &str {
    match operation {
        "connect" | "sync" | "inventory" | "hello" | "notify" | "members" | "join"
        | "begin" | "end" | "touch" | "read" | "write" | "remove" | "exists" => operation,
        _ => "other",
    }
}

pub(crate) fn transport(peer: &str, session: &str, progress: lof_realtime::RequestProgress<'_>,
    connection: Option<&lof_realtime::Connection>) {
    record(json!({"at":chrono::Utc::now().to_rfc3339(),"pid":std::process::id(),
        "event":"transport","peer":crate::error::hash_bytes(peer.as_bytes()),
        "session":crate::error::hash_bytes(session.as_bytes()),"op":operation_name(progress.operation),
        "stage":progress.stage,"elapsedMs":progress.elapsed.as_millis() as u64,"bytes":progress.bytes,
        "network":connection.map(network)}));
}

pub(crate) fn network(connection: &lof_realtime::Connection) -> Value {
    let stats = connection.stats();
    let paths: Vec<_> = connection.paths().iter().map(|path| {
        let stats = path.stats();
        json!({"relay":path.is_relay(),"selected":path.is_selected(),
            "rttMs":stats.rtt.as_millis() as u64,"mtu":stats.current_mtu,
            "sentBytes":stats.udp_tx.bytes,"receivedBytes":stats.udp_rx.bytes,
            "lostPackets":stats.lost_packets,"blackHoles":stats.black_holes_detected})
    }).collect();
    json!({"sentBytes":stats.udp_tx.bytes,"receivedBytes":stats.udp_rx.bytes,
        "lostPackets":stats.lost_packets,
        "acks":stats.frame_rx.acks.saturating_add(stats.frame_rx.path_acks),
        "receivedStreams":stats.frame_rx.stream,"sentStreams":stats.frame_tx.stream,
        "closed":connection.close_reason().is_some(),"paths":paths})
}

impl Span {
    pub(crate) fn start(kind: &str, peer: &str, operation: &str, path: Option<&str>) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let span = Self { id: SEQUENCE.fetch_add(1, Ordering::Relaxed), started: Instant::now() };
        // 상대가 보낸 문자열이나 파일 이름·본문·페어링 정보를 로그에 넣지 않는다.
        let operation = operation_name(operation);
        record(json!({"at":chrono::Utc::now().to_rfc3339(),"pid":std::process::id(),
            "event":"start","id":span.id,"kind":kind,"op":operation,
            "peer":crate::error::hash_bytes(peer.as_bytes()),
            "file":path.map(|path| crate::error::hash_bytes(path.as_bytes()))}));
        span
    }

    pub(crate) fn finish(self, outcome: Value) {
        record(json!({"at":chrono::Utc::now().to_rfc3339(),"pid":std::process::id(),
            "event":"finish","id":self.id,"elapsedMs":self.started.elapsed().as_millis() as u64,
            "outcome":outcome}));
    }

    pub(crate) fn stage(&self, stage: &'static str, details: Value) {
        record(json!({"at":chrono::Utc::now().to_rfc3339(),"pid":std::process::id(),
            "event":"stage","id":self.id,"stage":stage,
            "elapsedMs":self.started.elapsed().as_millis() as u64,"details":details}));
    }
}
