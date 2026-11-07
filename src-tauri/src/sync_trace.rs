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

pub(crate) struct Span {
    id: u64,
    started: Instant,
}

impl Span {
    pub(crate) fn start(kind: &str, peer: &str, operation: &str, path: Option<&str>) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let span = Self { id: SEQUENCE.fetch_add(1, Ordering::Relaxed), started: Instant::now() };
        // 상대가 보낸 문자열이나 파일 이름·본문·페어링 정보를 로그에 넣지 않는다.
        let operation = match operation {
            "connect" | "sync" | "inventory" | "hello" | "notify" | "members" | "join"
            | "begin" | "end" | "touch" | "read" | "write" | "remove" | "exists" => operation,
            _ => "other",
        };
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
}
