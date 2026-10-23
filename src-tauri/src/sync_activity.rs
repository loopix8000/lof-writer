use std::{collections::HashSet, sync::{Arc, Mutex}};

pub const MAX_PEER_SYNCS: usize = 3;

#[derive(Default)]
pub struct SyncActivity {
    state: Mutex<Activity>,
}

#[derive(Default)]
struct Activity {
    exclusive: bool,
    peers: HashSet<String>,
}

// 네트워크 교환은 기기별로 진행하고 서재 이동과 기존 저장소 동기화는 단독 실행한다.
pub struct SyncPermit {
    activity: Arc<SyncActivity>,
    peer: Option<String>,
}

impl SyncActivity {
    pub fn is_busy(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.exclusive || !state.peers.is_empty()
    }

    pub fn try_exclusive(self: &Arc<Self>) -> Option<SyncPermit> {
        let mut state = self.state.lock().unwrap();
        if state.exclusive || !state.peers.is_empty() { return None; }
        state.exclusive = true;
        Some(SyncPermit { activity: self.clone(), peer: None })
    }

    pub fn try_peer(self: &Arc<Self>, peer: &str) -> Option<SyncPermit> {
        let mut state = self.state.lock().unwrap();
        if state.exclusive || state.peers.len() >= MAX_PEER_SYNCS || state.peers.contains(peer) {
            return None;
        }
        state.peers.insert(peer.into());
        Some(SyncPermit { activity: self.clone(), peer: Some(peer.into()) })
    }
}

impl Drop for SyncPermit {
    fn drop(&mut self) {
        let mut state = self.activity.state.lock().unwrap();
        match &self.peer {
            Some(peer) => { state.peers.remove(peer); }
            None => state.exclusive = false,
        }
    }
}
