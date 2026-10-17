use crate::error::{fail, fail_invalid, LofError};
use crate::store::atomic_write_str;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

const ITERATIONS: u32 = 600_000;

#[derive(Serialize, Deserialize)]
struct PinConfig {
    version: u8,
    salt: String,
    hash: String,
}

struct PinInner {
    config: Option<PinConfig>,
    failures: u8,
    retry_at: Option<Instant>,
}

pub struct PinState {
    file: PathBuf,
    inner: Mutex<PinInner>,
    enabled: AtomicBool,
    generation: AtomicU64,
    unlocked_generation: AtomicU64,
    show_requested: AtomicBool,
}

fn valid_pin(pin: &str) -> bool {
    (4..=12).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

impl PinInner {
    fn verify(&mut self, pin: &str) -> Result<(), LofError> {
        if let Some(until) = self.retry_at.filter(|until| *until > Instant::now()) {
            let seconds = until.saturating_duration_since(Instant::now()).as_secs() + 1;
            return Err(fail(
                format!("잠시 기다려 주세요. {seconds}초 후 다시 입력할 수 있습니다."),
                "PIN_RATE_LIMIT",
            ));
        }
        let Some(config) = &self.config else {
            return Ok(());
        };
        let salt = hex::decode(&config.salt)
            .map_err(|_| fail_invalid("저장된 PIN 정보를 읽지 못했습니다."))?;
        let expected = hex::decode(&config.hash)
            .map_err(|_| fail_invalid("저장된 PIN 정보를 읽지 못했습니다."))?;
        let mut hash = [0u8; 32];
        if valid_pin(pin) {
            pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, ITERATIONS, &mut hash);
        }
        if valid_pin(pin) && bool::from(hash.as_slice().ct_eq(&expected)) {
            self.failures = 0;
            self.retry_at = None;
            return Ok(());
        }
        self.failures += 1;
        if self.failures >= 5 {
            self.failures = 0;
            self.retry_at = Some(Instant::now() + Duration::from_secs(30));
            return Err(fail(
                "PIN을 5회 잘못 입력했습니다. 30초 후 다시 시도해 주세요.",
                "PIN_RATE_LIMIT",
            ));
        }
        Err(fail("PIN이 올바르지 않습니다.", "PIN_INVALID"))
    }
}

impl PinState {
    pub fn load(file: PathBuf) -> Result<Self, LofError> {
        let config = match fs::read_to_string(&file) {
            Ok(raw) => {
                let config: PinConfig = serde_json::from_str(&raw)
                    .map_err(|_| fail_invalid("저장된 PIN 설정이 올바르지 않습니다."))?;
                if config.version != 1
                    || hex::decode(&config.salt).map(|b| b.len()).ok() != Some(16)
                    || hex::decode(&config.hash).map(|b| b.len()).ok() != Some(32)
                {
                    return Err(fail_invalid("저장된 PIN 설정이 올바르지 않습니다."));
                }
                Some(config)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let enabled = config.is_some();
        Ok(Self {
            file,
            inner: Mutex::new(PinInner {
                config,
                failures: 0,
                retry_at: None,
            }),
            enabled: AtomicBool::new(enabled),
            generation: AtomicU64::new(1),
            unlocked_generation: AtomicU64::new(0),
            show_requested: AtomicBool::new(false),
        })
    }

    pub fn is_locked(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
            && self.generation.load(Ordering::SeqCst)
                != self.unlocked_generation.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> Value {
        loop {
            let generation = self.generation.load(Ordering::SeqCst);
            let enabled = self.enabled.load(Ordering::SeqCst);
            let unlocked = self.unlocked_generation.load(Ordering::SeqCst);
            if generation == self.generation.load(Ordering::SeqCst) {
                return json!({ "enabled": enabled, "locked": enabled && generation != unlocked,
                    "generation": generation });
            }
        }
    }

    pub fn lock_for_tray(&self) {
        self.show_requested.store(false, Ordering::SeqCst);
        if self.enabled.load(Ordering::SeqCst) {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
    }

    pub fn request_show(&self) {
        self.show_requested.store(true, Ordering::SeqCst);
    }

    pub fn ready_to_show(&self, generation: u64) -> bool {
        generation == self.generation.load(Ordering::SeqCst)
            && self.show_requested.swap(false, Ordering::SeqCst)
    }

    pub fn unlock(&self, pin: &str) -> Result<(), LofError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let mut inner = self.inner.lock().unwrap();
        inner.verify(pin)?;
        let next = generation + 1;
        self.generation
            .compare_exchange(generation, next, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                fail(
                    "창이 다시 잠겼습니다. PIN을 다시 입력해 주세요.",
                    "PIN_LOCKED",
                )
            })?;
        self.unlocked_generation.store(next, Ordering::SeqCst);
        if self.is_locked() {
            return Err(fail(
                "창이 다시 잠겼습니다. PIN을 다시 입력해 주세요.",
                "PIN_LOCKED",
            ));
        }
        Ok(())
    }

    pub fn save(&self, current: &str, next: Option<&str>) -> Result<(), LofError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let mut inner = self.inner.lock().unwrap();
        if self.is_locked() {
            return Err(fail("먼저 PIN으로 잠금을 해제해 주세요.", "PIN_LOCKED"));
        }
        if next.is_some_and(|pin| !valid_pin(pin)) {
            return Err(fail_invalid("PIN은 4~12자리 숫자로 입력해 주세요."));
        }
        inner.verify(current)?;
        let config = if let Some(pin) = next {
            let mut salt = [0u8; 16];
            rand::rngs::OsRng.fill_bytes(&mut salt);
            let mut hash = [0u8; 32];
            pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, ITERATIONS, &mut hash);
            Some(PinConfig {
                version: 1,
                salt: hex::encode(salt),
                hash: hex::encode(hash),
            })
        } else {
            None
        };
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(fail(
                "창이 잠겼습니다. 잠금을 해제한 뒤 다시 시도해 주세요.",
                "PIN_LOCKED",
            ));
        }
        if let Some(config) = &config {
            let raw = serde_json::to_string(config)
                .map_err(|_| fail_invalid("PIN 설정을 저장하지 못했습니다."))?;
            atomic_write_str(&self.file, &raw)?;
        } else {
            match fs::remove_file(&self.file) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.unlocked_generation.store(generation, Ordering::SeqCst);
        self.enabled.store(config.is_some(), Ordering::SeqCst);
        inner.config = config;
        inner.failures = 0;
        inner.retry_at = None;
        Ok(())
    }
}
