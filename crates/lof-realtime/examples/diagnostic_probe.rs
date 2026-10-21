//! stdin의 JSON 요청 한 개를 실행하고 진단 이벤트를 JSONL로 출력한다.
use iroh::{SecretKey, Watcher};
use lof_realtime::{
    group::{self, Group, Member},
    Connection, EndpointAddr, Host, Message, Node,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Mode {
    #[default]
    Connect,
    Inventory,
    Read,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AddressMode {
    #[default]
    Discover,
    Ticket,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Scope {
    Inviter,
    #[default]
    Group,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    code: String,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    address_mode: AddressMode,
    #[serde(default)]
    scope: Scope,
    #[serde(default)]
    label: String,
    #[serde(default = "default_samples")]
    samples: u8,
    #[serde(default = "default_files")]
    max_files: usize,
    #[serde(default = "default_bytes")]
    max_bytes: u64,
    #[serde(default = "default_keep_alive")]
    keep_alive: bool,
    #[serde(default)]
    control_file: Option<PathBuf>,
}
fn default_keep_alive() -> bool {
    true
}
fn default_samples() -> u8 {
    3
}
fn default_files() -> usize {
    20
}
fn default_bytes() -> u64 {
    25_000_000
}

impl Input {
    fn validate(&self) -> Result<()> {
        if !(1..=20).contains(&self.samples)
            || self.max_files > 256
            || self.max_bytes > 100_000_000
            || self.label.chars().count() > 100
        {
            return Err("진단 횟수 또는 읽기 한도가 범위를 벗어났습니다.".into());
        }
        group::parse_code(&self.code).map(|_| ())
    }
}

#[derive(Clone)]
struct Events {
    start: Instant,
    output: Arc<Mutex<()>>,
}
impl Events {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            output: Arc::new(Mutex::new(())),
        }
    }
    fn emit(&self, event: &str, data: Value) {
        let _guard = self.output.lock().unwrap();
        let mut stdout = io::stdout().lock();
        let _ = writeln!(
            stdout,
            "{}",
            json!({"event": event, "elapsedMs": self.start.elapsed().as_millis(), "data": data})
        );
        let _ = stdout.flush();
    }
}

// 서명이 확인된 그룹 장치의 알림에 응답하고 파일 쓰기·삭제 요청은 받지 않는다.
struct ProbeHost {
    target: String,
    vault: String,
    group: Mutex<Option<Group>>,
    events: Events,
}
impl Host for ProbeHost {
    fn handle(&self, peer: &str, _: &str, message: Message) -> Result<Message> {
        let op = message.meta["op"].as_str().unwrap_or("");
        self.events
            .emit("incomingRequest", json!({"op":op,"peer":peer}));
        if message.meta["target"].as_str() != Some(&self.vault) {
            return Err("진단 대상이 아닌 장치의 요청입니다.".into());
        }
        let group = self.group.lock().unwrap();
        let group = group
            .as_ref()
            .ok_or("진단 장치가 아직 가입하지 않았습니다.")?;
        if group
            .member(peer)
            .is_none_or(|m| message.meta["vault"].as_str() != Some(&m.vault))
        {
            return Err("서재 인증에 실패했습니다.".into());
        }
        match op {
            "hello" => Ok(Message::json(
                json!({"storage":false,"members":group.members}),
            )),
            "members" | "notify" => Ok(Message::json(json!(true))),
            _ => Err("진단 장치는 파일 수신·쓰기·삭제를 지원하지 않습니다.".into()),
        }
    }
}

fn snapshot(connection: &Connection) -> Value {
    let paths: Vec<_> = connection
        .paths()
        .iter()
        .map(|path| {
            let stats = path.stats();
            json!({"pathId":format!("{:?}",path.id()),"remote":format!("{:?}",path.remote_addr()),
                "local":format!("{:?}",path.local_addr()),
                "kind":if path.is_relay(){"relay"}else{"direct"}, "selected":path.is_selected(),
            "rttMs":stats.rtt.as_secs_f64()*1000.0, "sentBytes":stats.udp_tx.bytes,
            "receivedBytes":stats.udp_rx.bytes, "lostPackets":stats.lost_packets,
            "lostBytes":stats.lost_bytes, "mtu":stats.current_mtu})
        })
        .collect();
    let stats = connection.stats();
    json!({"peer":connection.remote_id().to_string(),"paths":paths,"sentBytes":stats.udp_tx.bytes,"receivedBytes":stats.udp_rx.bytes,
        "lostPackets":stats.lost_packets,"closed":connection.close_reason().map(|e| e.to_string())})
}

async fn rpc(connection: &Connection, events: &Events, meta: Value) -> Result<Message> {
    let op = meta["op"].as_str().unwrap_or("").to_owned();
    let peer = connection.remote_id().to_string();
    // 경로는 파일 내용 대신 해시로 식별한다. 초대 토큰·그룹 비밀값은 출력하지 않는다.
    let path = meta["path"]
        .as_str()
        .map(|p| lof_realtime::storage::hash(p.as_bytes()));
    let start = Instant::now();
    events.emit(
        "requestStarted",
        json!({"op":op,"pathHash":path,"peer":peer}),
    );
    let result = lof_realtime::request(connection, Message::json(meta)).await;
    match &result {
        Ok(answer) => events.emit("requestFinished", json!({"op":op,"pathHash":path,"peer":peer,
            "durationMs":start.elapsed().as_millis(),"payloadBytes":answer.data.len(),"transport":snapshot(connection)})),
        Err(error) => events.emit("requestFailed", json!({"op":op,"pathHash":path,"peer":peer,
            "durationMs":start.elapsed().as_millis(),"error":error,"transport":snapshot(connection)})),
    }
    result
}

fn leader_key(target: &str) -> Result<SecretKey> {
    // 앱의 공개키 순서 규칙에 따라 진단 장치가 비교를 시작할 수 있는 키를 고른다.
    let mut smallest: Option<SecretKey> = None;
    for _ in 0..4096 {
        let key = SecretKey::generate();
        let public = key.public().to_string();
        if public.as_str() < target
            && smallest
                .as_ref()
                .is_none_or(|old| key.public().to_string() < old.public().to_string())
        {
            smallest = Some(key);
        }
        if smallest.is_some() && public.starts_with("00") {
            break;
        }
    }
    smallest.ok_or_else(|| "진단 담당 키를 만들지 못했습니다. 다시 실행해 주세요.".into())
}

fn group_targets(group: &Group, own: &str, inviter: &str, scope: Scope) -> Vec<Member> {
    let mut peers: Vec<_> = group
        .others(own)
        .filter(|peer| scope == Scope::Group || peer.endpoint == inviter)
        .cloned()
        .collect();
    // 초대 PC의 다른 동기화가 오래 걸려도 Android 검사가 먼저 진행되게 한다.
    peers.sort_by_key(|peer| {
        (
            peer.endpoint == inviter,
            !peer.name.to_ascii_lowercase().contains("android"),
            peer.endpoint.clone(),
        )
    });
    peers
}

async fn authenticated_probe(
    node: &Node,
    input: &Input,
    ticket: &group::Ticket,
    key: &SecretKey,
    host: &ProbeHost,
    connection: &Connection,
    events: &Events,
) -> Result<()> {
    let own = key.public().to_string();
    let reply = rpc(
        connection,
        events,
        json!({"op":"join","group":ticket.group,
        "token":ticket.token,"vault":host.vault,"name":"Lof 동기화 진단","storage":false}),
    )
    .await?;
    let mut group = Group::from_secret(reply.meta["secret"].as_str().unwrap_or(""))?;
    if group.id() != ticket.group {
        return Err("초대 코드와 응답의 그룹이 다릅니다.".into());
    }
    let members: Vec<Member> =
        serde_json::from_value(reply.meta["members"].clone()).map_err(|e| e.to_string())?;
    group.merge(&members, true);
    let inviter_vault = group
        .member(&host.target)
        .ok_or("초대 장치의 서명을 확인하지 못했습니다.")?
        .vault
        .clone();
    if group.member(&own).is_none_or(|m| m.vault != host.vault) {
        return Err("진단 장치의 가입 서명을 확인하지 못했습니다.".into());
    }
    *host.group.lock().unwrap() = Some(group.clone());
    let peers = group_targets(&group, &own, &host.target, input.scope);
    events.emit("groupMembers", json!({"members":peers.iter().map(|peer|json!({"endpoint":peer.endpoint,"name":peer.name,"storage":peer.storage})).collect::<Vec<_>>()}));
    let mut connections = vec![(host.target.clone(), inviter_vault, connection.clone())];
    let mut failures = Vec::new();
    'diagnose: loop {
        failures.clear();
        for peer in peers.clone() {
            events.emit(
                "peerStarted",
                json!({"peer":peer.endpoint,"name":peer.name}),
            );
            let started = Instant::now();
            let existing = connections
                .iter()
                .find(|(id, _, conn)| id == &peer.endpoint && conn.close_reason().is_none());
            let peer_connection = if let Some((_, _, conn)) = existing {
                conn.clone()
            } else {
                let endpoint = peer
                    .endpoint
                    .parse()
                    .map_err(|_| "그룹 장치 ID 형식 오류")?;
                match node.connect(EndpointAddr::new(endpoint)).await {
                    Ok(conn) => {
                        events.emit("peerConnected", json!({"peer":peer.endpoint,"name":peer.name,"durationMs":started.elapsed().as_millis(),"transport":snapshot(&conn)}));
                        connections.push((peer.endpoint.clone(), peer.vault.clone(), conn.clone()));
                        conn
                    }
                    Err(error) => {
                        events.emit("peerFinished", json!({"peer":peer.endpoint,"name":peer.name,"ok":false,"error":error,"stage":"connect"}));
                        failures.push(format!("{}: {error}", peer.name));
                        continue;
                    }
                }
            };
            let connection = &peer_connection;
            let target = &peer.vault;
            let watch = connection.clone();
            let monitoring = events.clone();
            let monitor = tokio::spawn(async move {
                loop {
                    monitoring.emit("transport", snapshot(&watch));
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            });
            let mut begun = false;
            let result = tokio::time::timeout(Duration::from_secs(300), async {
        rpc(
            connection,
            events,
            json!({"op":"hello","vault":host.vault,"target":target,"members":group.members}),
        )
        .await?;
        if !peer.storage && own >= peer.endpoint {
            return Err("이 장치의 공개키 순서상 상대가 비교를 담당합니다. 파일 목록 검사는 시작하지 않았습니다.".into());
        }
        for attempt in 0..=45 {
            match rpc(connection, events, json!({"op":"begin","vault":host.vault,"target":target})).await {
                Ok(_) => break,
                Err(error) if error == "다른 동기화가 진행 중입니다." && attempt < 45 => {
                    events.emit("waitingForSync", json!({"peer":peer.endpoint,"attempt":attempt+1,"retryMs":2000}));
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                Err(error) => return Err(error),
            }
        }
        begun = true;
        let inventory = rpc(
            connection,
            events,
            json!({"op":"inventory","vault":host.vault,"target":target}),
        )
        .await?;
        let files = inventory
            .meta
            .as_object()
            .ok_or("파일 목록 응답 형식이 올바르지 않습니다.")?;
        let total_bytes = files
            .values()
            .filter_map(|info| info["size"].as_u64())
            .try_fold(0u64, |sum, size| sum.checked_add(size))
            .ok_or("파일 목록 크기가 범위를 벗어났습니다.")?;
        events.emit(
            "inventory",
            json!({"peer":peer.endpoint,"fileCount":files.len(),"totalBytes":total_bytes}),
        );
        if input.mode == Mode::Read {
            let (mut count, mut bytes) = (0, 0u64);
            for (path, info) in files {
                if count >= input.max_files {
                    break;
                }
                let size = info["size"].as_u64().ok_or("파일 크기 응답 형식 오류")?;
                if size > input.max_bytes.saturating_sub(bytes) {
                    continue;
                }
                let answer = rpc(
                    connection,
                    events,
                    json!({"op":"read","vault":host.vault,"target":target,"path":path}),
                )
                .await?;
                if answer.data.len() as u64 != size {
                    return Err("조회 중 파일 크기가 변경되었습니다.".into());
                }
                if let Some(hash) = info["etag"]
                    .as_str()
                    .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    if lof_realtime::storage::hash(&answer.data) != hash.to_ascii_lowercase() {
                        return Err("전송 파일의 해시가 목록과 다릅니다.".into());
                    }
                }
                bytes += answer.data.len() as u64;
                count += 1;
            }
            events.emit("readSummary", json!({"peer":peer.endpoint,"files":count,"bytes":bytes}));
        }
        Ok::<_, String>(())
    })
    .await
    .unwrap_or_else(|_| Err("진단 조회 제한 시간(5분)을 넘었습니다.".into()));
            if begun {
                // 읽기 전용 조사이므로 동기화 완료로 기록하지 않는다.
                let end = rpc(
                    connection,
                    events,
                    json!({"op":"end","vault":host.vault,"target":target,"success":false}),
                )
                .await;
                events.emit(
                    "sessionReleased",
                    json!({"peer":peer.endpoint,"ok":end.is_ok()}),
                );
            }
            monitor.abort();
            events.emit("peerFinished", json!({"peer":peer.endpoint,"name":peer.name,"ok":result.is_ok(),"error":result.as_ref().err()}));
            if let Err(error) = result {
                failures.push(format!("{}: {error}", peer.name));
            }
        }
        events.emit(
            "diagnosisCompleted",
            json!({"ok":failures.is_empty(),"errors":failures}),
        );
        if !input.keep_alive {
            break;
        }
        events.emit(
            "sessionHolding",
            json!({"until":"explicit leave","errors":failures}),
        );
        let mut last_hello = Instant::now();
        loop {
            if let Some(control) = &input.control_file {
                if control
                    .with_extension("leave")
                    .try_exists()
                    .unwrap_or(false)
                {
                    break 'diagnose;
                }
                let recheck = control.with_extension("recheck");
                if recheck.try_exists().unwrap_or(false) {
                    let _ = std::fs::remove_file(recheck);
                    continue 'diagnose;
                }
            }
            if last_hello.elapsed() >= Duration::from_secs(20) {
                for peer in &peers {
                    let current = connections
                        .iter()
                        .find(|(id, _, conn)| id == &peer.endpoint && conn.close_reason().is_none())
                        .map(|(_, _, conn)| conn.clone());
                    let live = if let Some(conn) = current {
                        Some(conn)
                    } else {
                        match peer.endpoint.parse() {
                            Ok(id) => match node.connect(EndpointAddr::new(id)).await {
                                Ok(conn) => {
                                    connections.retain(|(id, _, _)| id != &peer.endpoint);
                                    connections.push((
                                        peer.endpoint.clone(),
                                        peer.vault.clone(),
                                        conn.clone(),
                                    ));
                                    Some(conn)
                                }
                                Err(error) => {
                                    events.emit(
                                        "reconnectFailed",
                                        json!({"peer":peer.endpoint,"error":error}),
                                    );
                                    None
                                }
                            },
                            Err(_) => None,
                        }
                    };
                    if let Some(conn) = live {
                        let heartbeat = tokio::time::timeout(Duration::from_secs(10), rpc(&conn,events,json!({"op":"hello","vault":host.vault,"target":peer.vault,"members":group.members}))).await;
                        events.emit("connectionHeld",json!({"peer":peer.endpoint,"ok":matches!(heartbeat,Ok(Ok(_))),"transport":snapshot(&conn)}));
                    }
                }
                last_hello = Instant::now();
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    group.update(key, &own, &host.vault, "Lof 동기화 진단", false, true);
    for (peer, target, connection) in connections.into_iter().rev() {
        let leave = rpc(
            &connection,
            events,
            json!({"op":"members","vault":host.vault,"target":target,"members":group.members}),
        )
        .await;
        // Writer는 제거 목록을 반영한 뒤 요청자를 재인증하므로 탈퇴 성공 시에도 인증 오류를 반환할 수 있다.
        events.emit("cleanup", json!({"peer":peer,"removalSent":true,"acknowledged":leave.is_ok(),
        "note":"제거 반영 후 인증 오류가 올 수 있습니다. 그룹에서 진단 장치가 빠졌는지 확인해야 합니다."}));
        if peer != host.target {
            connection.close(0u8.into(), b"diagnostic complete");
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join(" / "))
    }
}

async fn run(input: Input, events: &Events) -> Result<()> {
    input.validate()?;
    let ticket = group::parse_code(&input.code)?;
    let target = ticket.addr.id.to_string();
    let key = leader_key(&target)?;
    let host = Arc::new(ProbeHost {
        target: target.clone(),
        vault: uuid::Uuid::new_v4().to_string(),
        group: Mutex::new(None),
        events: events.clone(),
    });
    events.emit(
        "starting",
        json!({"label":input.label,"target":target,
        "joinsGroup":input.mode != Mode::Connect,"iroh":"1.3.0"}),
    );
    let node = Node::bind(key.clone(), host.clone()).await?;
    let endpoint = node.endpoint.clone();
    let endpoint_events = events.clone();
    let endpoint_monitor = tokio::spawn(async move {
        loop {
            let relays: Vec<_> = endpoint
                .home_relay_status()
                .get()
                .iter()
                .map(|relay| {
                    json!({"url":relay.url().to_string(),"connected":relay.is_connected(),
                    "error":relay.last_error().map(|error|error.to_string())})
                })
                .collect();
            endpoint_events.emit(
                "endpoint",
                json!({"directAddressCount":endpoint.addr().ip_addrs().count(),"relays":relays}),
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    let addr = match input.address_mode {
        AddressMode::Discover => EndpointAddr::new(ticket.addr.id),
        AddressMode::Ticket => ticket.addr.clone(),
    };
    let start = Instant::now();
    events.emit("requestStarted", json!({"op":"connect"}));
    let result = async {
        let connection = node.connect(addr).await?;
        events.emit(
            "connected",
            json!({"durationMs":start.elapsed().as_millis(),"transport":snapshot(&connection)}),
        );
        let watch = connection.clone();
        let monitoring = events.clone();
        let monitor = tokio::spawn(async move {
            loop {
                monitoring.emit("transport", snapshot(&watch));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        let result = async {
            for _ in 1..input.samples {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if input.mode != Mode::Connect {
                authenticated_probe(&node, &input, &ticket, &key, &host, &connection, events)
                    .await?;
            }
            Ok::<_, String>(())
        }
        .await;
        monitor.abort();
        connection.close(0u8.into(), b"diagnostic complete");
        result
    }
    .await;
    endpoint_monitor.abort();
    node.close().await;
    result
}

#[tokio::main]
async fn main() {
    let events = Events::new();
    let mut body = String::new();
    let input = io::stdin()
        .take(32_769)
        .read_to_string(&mut body)
        .map_err(|e| e.to_string())
        .and_then(|_| {
            if body.len() > 32_768 {
                return Err("진단 요청이 너무 큽니다.".into());
            }
            serde_json::from_str::<Input>(&body).map_err(|_| "진단 요청 JSON 형식 오류".into())
        });
    let result = match input {
        Ok(input) => run(input, &events).await,
        Err(error) => Err(error),
    };
    events.emit(
        "completed",
        json!({"ok":result.is_ok(),"error":result.err()}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct TestPeer {
        key: SecretKey,
        vault: String,
        group: Mutex<Group>,
        operations: Mutex<Vec<String>>,
        warning: bool,
        busy_once: AtomicBool,
    }
    impl Host for TestPeer {
        fn handle(&self, peer: &str, _: &str, message: Message) -> Result<Message> {
            let op = message.meta["op"].as_str().unwrap_or("");
            self.operations.lock().unwrap().push(op.to_string());
            if op == "begin" && self.busy_once.swap(false, Ordering::SeqCst) {
                return Err("다른 동기화가 진행 중입니다.".into());
            }
            let mut group = self.group.lock().unwrap();
            if op == "join" {
                if message.meta["token"] != "fixture-token" {
                    return Err("초대 토큰 오류".into());
                }
                group.update(
                    &self.key,
                    peer,
                    message.meta["vault"].as_str().unwrap(),
                    "진단",
                    false,
                    false,
                );
                return Ok(Message::json(
                    json!({"group":group.id(),"secret":group.secret,"members":group.members}),
                ));
            }
            if op == "members" {
                let members: Vec<Member> =
                    serde_json::from_value(message.meta["members"].clone()).unwrap();
                group.merge(&members, false);
            }
            if group.member(peer).is_none() {
                return Err("장치가 이 서재의 동기화 그룹에 없습니다.".into());
            }
            if message.meta["target"].as_str() != Some(&self.vault) {
                return Err("서재 식별자 오류".into());
            }
            match op {
                "hello" => Ok(Message::json(
                    json!({"storage":false,"members":group.members}),
                )),
                "begin" if peer < self.key.public().to_string().as_str() => {
                    Ok(Message::json(json!(true)))
                }
                "inventory" if self.warning => {
                    Err("상대 서재 진단: warnings=[], pending_missing=true".into())
                }
                "inventory" => Ok(Message::json(
                    json!({"fixture.md":{"size":7,"etag":lof_realtime::storage::hash(b"fixture")}}),
                )),
                "read" => Ok(Message {
                    meta: Value::Null,
                    data: b"fixture".to_vec(),
                }),
                "end" => {
                    assert_eq!(message.meta["success"], false);
                    Ok(Message::json(json!(true)))
                }
                _ => Err(format!("허용하지 않은 요청: {op}")),
            }
        }
    }

    async fn probe_fixture(mode: Mode, warning: bool) -> (Result<()>, Arc<TestPeer>) {
        let key = SecretKey::generate();
        let vault = uuid::Uuid::new_v4().to_string();
        let group = Group::create(&key, &vault, "시험 피어", false);
        let peer = Arc::new(TestPeer {
            key: key.clone(),
            vault,
            group: Mutex::new(group),
            operations: Mutex::new(Vec::new()),
            warning,
            busy_once: AtomicBool::new(!warning),
        });
        let node = Node::bind(key, peer.clone()).await.unwrap();
        // 공용 중계의 준비를 기다리지 않고 로컬 인터페이스로 실제 QUIC 통신한다.
        for _ in 0..50 {
            if node.endpoint.addr().ip_addrs().next().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let code = peer
            .group
            .lock()
            .unwrap()
            .code(&node.endpoint.addr(), "fixture-token")
            .unwrap();
        let input = Input {
            code,
            mode,
            address_mode: AddressMode::Ticket,
            scope: Scope::Group,
            label: "local fixture".into(),
            samples: 1,
            max_files: 10,
            max_bytes: 1024,
            keep_alive: false,
            control_file: None,
        };
        let result = tokio::time::timeout(Duration::from_secs(40), run(input, &Events::new()))
            .await
            .expect("로컬 QUIC 진단 제한 시간");
        node.close().await;
        (result, peer)
    }

    #[tokio::test]
    async fn read_probe_uses_real_quic_and_leaves_without_writes() {
        let (result, peer) = probe_fixture(Mode::Read, false).await;
        result.unwrap();
        assert_eq!(
            *peer.operations.lock().unwrap(),
            [
                "join",
                "hello",
                "begin",
                "begin",
                "inventory",
                "read",
                "end",
                "members"
            ]
        );
        assert_eq!(peer.group.lock().unwrap().active().count(), 1);
    }

    #[tokio::test]
    async fn inventory_warning_is_preserved_and_session_is_released() {
        let (result, peer) = probe_fixture(Mode::Inventory, true).await;
        assert_eq!(
            result.unwrap_err(),
            "시험 피어: 상대 서재 진단: warnings=[], pending_missing=true"
        );
        assert_eq!(
            *peer.operations.lock().unwrap(),
            ["join", "hello", "begin", "inventory", "end", "members"]
        );
        assert_eq!(peer.group.lock().unwrap().active().count(), 1);
    }

    #[tokio::test]
    async fn connect_probe_does_not_join_or_consume_invitation() {
        let (result, peer) = probe_fixture(Mode::Connect, false).await;
        result.unwrap();
        assert!(peer.operations.lock().unwrap().is_empty());
        assert_eq!(peer.group.lock().unwrap().active().count(), 1);
    }

    #[test]
    fn pc_invitation_also_targets_android_group_members() {
        let pc = SecretKey::generate();
        let android = SecretKey::generate();
        let probe = SecretKey::generate();
        let vault = uuid::Uuid::new_v4().to_string();
        let mut group = Group::create(&pc, &vault, "PC", false);
        group.update(
            &pc,
            &android.public().to_string(),
            &vault,
            "Android 기기",
            false,
            false,
        );
        group.update(
            &pc,
            &probe.public().to_string(),
            &vault,
            "진단",
            false,
            false,
        );
        let peers = group_targets(
            &group,
            &probe.public().to_string(),
            &pc.public().to_string(),
            Scope::Group,
        );
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].endpoint, android.public().to_string());
        let inviter_only = group_targets(
            &group,
            &probe.public().to_string(),
            &pc.public().to_string(),
            Scope::Inviter,
        );
        assert_eq!(inviter_only.len(), 1);
        assert_eq!(inviter_only[0].endpoint, pc.public().to_string());
    }
}
