//! Writer와 상시 보관 피어가 함께 사용하는 인증된 원본 파일 전송 계층.
use iroh::{endpoint::presets, Endpoint, SecretKey};
pub use iroh::{endpoint::Connection, EndpointAddr, EndpointId};
use iroh_gossip::{net::GOSSIP_ALPN, Gossip};
use serde_json::{json, Value};
use std::{sync::Arc, time::{Duration, Instant}};
use tokio::sync::Semaphore;
pub mod group;
pub mod document_version;
pub mod file_index;
pub mod replica;
pub mod scope;
pub mod storage;

pub const ALPN: &[u8] = b"lof/realtime-files/1";
pub const MAX_FILE: usize = 50_000_000;
const MAX_HEADER: usize = 8_000_000;
const INVENTORY_IDLE_TIMEOUT: Duration = Duration::from_secs(8);
pub type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct Message {
    pub meta: Value,
    pub data: Vec<u8>,
}
impl Message {
    pub fn json(meta: Value) -> Self {
        Self {
            meta,
            data: Vec::new(),
        }
    }
}
pub trait Host: Send + Sync + 'static {
    /// peer는 QUIC에서 검증한 공개키이며 요청 본문의 값으로 대체하지 않는다.
    fn handle(&self, peer: &str, session: &str, message: Message) -> Result<Message>;
    /// 응답 바이트를 전송한 뒤 화면의 진행 상태를 갱신한다.
    fn response_sent(&self, _session: &str) {}
    fn disconnected(&self, _session: &str) {}
    fn connected(&self, _peer: &str, _session: &str, _connection: Connection) {}
    /// 요청 수신, 처리, 응답 전송의 대기를 구분한다. 본문은 전달하지 않는다.
    fn request_progress(&self, _peer: &str, _session: &str, _progress: RequestProgress<'_>) {}
}

pub struct RequestProgress<'a> {
    pub operation: &'a str,
    pub stage: &'static str,
    pub elapsed: Duration,
    pub bytes: usize,
}

#[derive(Clone)]
pub struct Node {
    pub endpoint: Endpoint,
    /// 그룹 구성원 목록과 변경 알림을 퍼뜨린다. 원고 파일은 전송하지 않는다.
    pub gossip: Gossip,
    host: Arc<dyn Host>,
    slots: Arc<Semaphore>,
}
impl Node {
    pub async fn bind(secret: SecretKey, host: Arc<dyn Host>) -> Result<Self> {
        let builder = Endpoint::builder(presets::N0);
        // 일부 Android 네트워크 드라이버는 묶음 UDP 송신을 누락시켜 큰 응답만 멈춘다.
        #[cfg(target_os = "android")]
        let builder = builder.transport_config(iroh::endpoint::QuicTransportConfig::builder()
            .enable_segmentation_offload(false).build());
        let endpoint = builder
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec(), GOSSIP_ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| e.to_string())?;
        let gossip = Gossip::builder()
            .max_message_size(group::MAX_ANNOUNCEMENT)
            .spawn(endpoint.clone());
        let node = Self {
            endpoint,
            gossip,
            host,
            slots: Arc::new(Semaphore::new(24)),
        };
        let acceptor = node.clone();
        tokio::spawn(async move {
            while let Some(incoming) = acceptor.endpoint.accept().await {
                let node = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(Ok(connection)) =
                        tokio::time::timeout(Duration::from_secs(20), incoming).await
                    else {
                        return;
                    };
                    if connection.alpn() == GOSSIP_ALPN {
                        let _ = node.gossip.handle_connection(connection).await;
                        return;
                    }
                    let Ok(_permit) = node.slots.clone().try_acquire_owned() else {
                        connection.close(2u8.into(), b"busy");
                        return;
                    };
                    node.serve(connection).await;
                });
            }
        });
        Ok(node)
    }
    pub async fn close(&self) {
        let _ = self.gossip.shutdown().await;
        self.endpoint.close().await;
    }
    pub async fn connect(&self, addr: EndpointAddr) -> Result<Connection> {
        let connection =
            tokio::time::timeout(Duration::from_secs(25), self.endpoint.connect(addr, ALPN))
                .await
                .map_err(|_| "피어 연결 시간이 초과되었습니다.".to_string())?
                .map_err(|e| e.to_string())?;
        let node = self.clone();
        let serving = connection.clone();
        tokio::spawn(async move {
            node.serve(serving).await;
        });
        Ok(connection)
    }
    async fn serve(&self, connection: Connection) {
        let peer = connection.remote_id().to_string();
        let session = uuid::Uuid::new_v4().to_string();
        self.host.connected(&peer, &session, connection.clone());
        while let Ok((mut send, mut recv)) = connection.accept_bi().await {
            let started = Instant::now();
            let mut operation = String::new();
            let progress = |operation: &str, stage, bytes| self.host.request_progress(&peer, &session,
                RequestProgress { operation, stage, elapsed: started.elapsed(), bytes });
            progress("", "receiving", 0);
            let handling = tokio::time::timeout(Duration::from_secs(90), async {
                let request = decode(
                    recv.read_to_end(MAX_FILE + MAX_HEADER + 4)
                        .await
                        .map_err(|e| e.to_string())?,
                )?;
                operation = request.meta["op"].as_str().unwrap_or("").to_string();
                progress(&operation, "handling", request.data.len());
                let host = self.host.clone();
                let request_peer = peer.clone();
                let request_session = session.clone();
                let answer =
                    tokio::task::spawn_blocking(move || host.handle(&request_peer, &request_session, request))
                        .await
                        .map_err(|_| "피어 요청 처리에 실패했습니다.".to_string())?;
                let message = answer.unwrap_or_else(|error| Message::json(json!({"error":error})));
                let bytes = encode(message)?;
                progress(&operation, "sending", bytes.len());
                send.write_all(&bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                send.finish().map_err(|e| e.to_string())?;
                progress(&operation, "sent", bytes.len());
                if operation == "inventory" {
                    // finish는 송신 버퍼에 넣은 상태다. 실제 전달이 멈춰도 다음 요청 처리를 막지 않는다.
                    let stopped = send.stopped();
                    let connection = connection.clone();
                    let host = self.host.clone();
                    let peer = connection.remote_id().to_string();
                    let session = session.clone();
                    let response_size = bytes.len();
                    tokio::spawn(async move {
                        tokio::pin!(stopped);
                        let mut acks = received_acknowledgements(&connection);
                        loop {
                            let result = tokio::time::timeout(INVENTORY_IDLE_TIMEOUT, &mut stopped).await;
                            let stage = match result {
                                Ok(Ok(None)) => "delivered",
                                Ok(_) => "delivery_failed",
                                Err(_) if received_acknowledgements(&connection) != acks
                                    && started.elapsed() < Duration::from_secs(90) => "delivery_wait",
                                Err(_) => "delivery_stalled",
                            };
                            host.request_progress(&peer, &session, RequestProgress {
                                operation: "inventory", stage, elapsed: started.elapsed(), bytes: response_size,
                            });
                            if stage == "delivery_wait" {
                                acks = received_acknowledgements(&connection);
                                continue;
                            }
                            if stage != "delivered" {
                                connection.close(1u8.into(), b"inventory delivery failed");
                            }
                            break;
                        }
                    });
                }
                Ok::<_, String>(())
            });
            // 끊긴 연결의 처리 완료를 기다리며 세션을 붙잡지 않는다.
            // 이미 시작한 파일 쓰기는 Host가 보유한 실행 권한 안에서 마무리한다.
            let result = tokio::select! {
                result = handling => matches!(result, Ok(Ok(()))),
                _ = connection.closed() => false,
            };
            if !result {
                progress(&operation, "failed", 0);
                break;
            }
            self.host.response_sent(&session);
        }
        self.host.disconnected(&session);
        connection.close(0u8.into(), b"closed");
    }
}
fn received_acknowledgements(connection: &Connection) -> u64 {
    let frames = connection.stats().frame_rx;
    // 다중 경로의 확인 응답은 일반 ACK와 별도로 집계된다.
    frames.acks.saturating_add(frames.path_acks)
}

pub async fn request(connection: &Connection, message: Message) -> Result<Message> {
    let inventory = message.meta["op"] == "inventory";
    let result = tokio::time::timeout(Duration::from_secs(90), async {
        let (mut send, mut recv) = connection.open_bi().await.map_err(|e| e.to_string())?;
        send.write_all(&encode(message)?)
            .await
            .map_err(|e| e.to_string())?;
        send.finish().map_err(|e| e.to_string())?;
        let bytes = if inventory {
            read_inventory(&mut recv).await?
        } else {
            recv.read_to_end(MAX_FILE + MAX_HEADER + 4)
                .await
                .map_err(|e| e.to_string())?
        };
        decode(bytes)
    })
    .await
    .unwrap_or_else(|_| Err("피어 응답 시간이 초과되었습니다.".to_string()));
    // 전송 실패 뒤 같은 연결에 end를 보내 또 90초 기다리지 않도록 바로 재연결한다.
    if result.is_err() {
        connection.close(1u8.into(), b"request failed");
    }
    let answer = result?;
    if let Some(error) = answer.meta["error"].as_str() {
        return Err(error.to_string());
    }
    Ok(answer)
}

async fn read_inventory(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        // 목록이 조금씩이라도 도착하면 대기를 갱신한다. 응답이 멈춘 연결만 빠르게 재시도한다.
        let chunk = tokio::time::timeout(INVENTORY_IDLE_TIMEOUT, recv.read_chunk(64 * 1024))
            .await.map_err(|_| "피어 목록 응답이 멈춰 다시 연결합니다.".to_string())?
            .map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { return Ok(bytes); };
        if bytes.len() + chunk.len() > MAX_FILE + MAX_HEADER + 4 {
            return Err("전송 응답 크기 오류".into());
        }
        bytes.extend_from_slice(&chunk);
    }
}
fn encode(message: Message) -> Result<Vec<u8>> {
    if message.data.len() > MAX_FILE {
        return Err("전송 파일은 50MB 이하여야 합니다.".into());
    }
    let header = serde_json::to_vec(&json!({"meta":message.meta,"length":message.data.len()}))
        .map_err(|e| e.to_string())?;
    if header.len() > MAX_HEADER {
        return Err("파일 목록이 너무 큽니다.".into());
    }
    let mut bytes = Vec::with_capacity(4 + header.len() + message.data.len());
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend(header);
    bytes.extend(message.data);
    Ok(bytes)
}
fn decode(bytes: Vec<u8>) -> Result<Message> {
    let size = u32::from_be_bytes(
        bytes
            .get(..4)
            .ok_or("전송 헤더 오류")?
            .try_into()
            .map_err(|_| "전송 헤더 오류")?,
    ) as usize;
    if size > MAX_HEADER || size + 4 > bytes.len() {
        return Err("전송 헤더 크기 오류".into());
    }
    let header: Value =
        serde_json::from_slice(&bytes[4..size + 4]).map_err(|_| "전송 헤더 형식 오류")?;
    let data = &bytes[size + 4..];
    if data.len() > MAX_FILE || header["length"].as_u64() != Some(data.len() as u64) {
        return Err("전송 파일 크기 오류".into());
    }
    Ok(Message {
        meta: header["meta"].clone(),
        data: data.to_vec(),
    })
}
