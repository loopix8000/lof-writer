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

#[derive(Clone, Serialize, Deserialize)]
struct PinConfig {
    version: u8,
    salt: String,
    hash: String,
    #[serde(default)]
    biometric: bool,
}

struct PinInner {
    config: Option<PinConfig>,
    failures: u8,
    retry_at: Option<Instant>,
}

pub struct PinState {
    file: PathBuf,
    inner: Mutex<PinInner>,
    // PIN 해시 계산은 잠금 전환을 막지 않고, 저장 확정과 잠금 전환만 순서대로 처리한다.
    transition: Mutex<()>,
    enabled: AtomicBool,
    biometric: AtomicBool,
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
        let biometric = config.as_ref().is_some_and(|config| config.biometric);
        Ok(Self {
            file,
            inner: Mutex::new(PinInner {
                config,
                failures: 0,
                retry_at: None,
            }),
            transition: Mutex::new(()),
            enabled: AtomicBool::new(enabled),
            biometric: AtomicBool::new(biometric),
            generation: AtomicU64::new(1),
            unlocked_generation: AtomicU64::new(0),
            show_requested: AtomicBool::new(false),
        })
    }

    pub fn is_locked(&self) -> bool {
        let _transition = self.transition.lock().unwrap();
        self.locked()
    }

    // transition을 잡은 코드에서만 사용해 중간 상태를 읽지 않는다.
    fn locked(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
            && self.generation.load(Ordering::SeqCst)
                != self.unlocked_generation.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> Value {
        let _transition = self.transition.lock().unwrap();
        let generation = self.generation.load(Ordering::SeqCst);
        let enabled = self.enabled.load(Ordering::SeqCst);
        let unlocked = self.unlocked_generation.load(Ordering::SeqCst);
        json!({ "enabled": enabled, "locked": enabled && generation != unlocked,
            "generation": generation, "biometricEnabled": self.biometric.load(Ordering::SeqCst) })
    }

    pub fn lock_for_tray(&self) {
        let _transition = self.transition.lock().unwrap();
        self.show_requested.store(false, Ordering::SeqCst);
        // 첫 PIN을 저장하는 도중에도 앱을 벗어나면 이전 요청을 무효화한다.
        self.generation.fetch_add(1, Ordering::SeqCst);
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
        self.finish_unlock(generation)
    }

    fn finish_unlock(&self, generation: u64) -> Result<(), LofError> {
        let _transition = self.transition.lock().unwrap();
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
        if self.locked() {
            return Err(fail(
                "창이 다시 잠겼습니다. PIN을 다시 입력해 주세요.",
                "PIN_LOCKED",
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "android")]
    pub fn biometric_generation(&self, unlocking: bool) -> Result<u64, LofError> {
        let _transition = self.transition.lock().unwrap();
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(fail_invalid("먼저 PIN을 설정해 주세요."));
        }
        if unlocking && !self.biometric.load(Ordering::SeqCst) {
            return Err(fail_invalid("지문 잠금 해제를 사용하도록 설정해 주세요."));
        }
        if unlocking && !self.locked() {
            return Err(fail_invalid("이미 잠금이 해제되어 있습니다."));
        }
        if !unlocking && self.locked() {
            return Err(fail("먼저 PIN으로 잠금을 해제해 주세요.", "PIN_LOCKED"));
        }
        Ok(self.generation.load(Ordering::SeqCst))
    }

    #[cfg(target_os = "android")]
    pub fn unlock_biometric(&self, generation: u64) -> Result<(), LofError> {
        let inner = self.inner.lock().unwrap();
        if !inner.config.as_ref().is_some_and(|config| config.biometric) {
            return Err(fail_invalid("지문 잠금 해제를 사용할 수 없습니다."));
        }
        self.finish_unlock(generation)
    }

    #[cfg(target_os = "android")]
    pub fn set_biometric(&self, enabled: bool, generation: u64) -> Result<(), LofError> {
        let mut inner = self.inner.lock().unwrap();
        let _transition = self.transition.lock().unwrap();
        if self.locked() || self.generation.load(Ordering::SeqCst) != generation {
            return Err(fail("창이 잠겼습니다. 잠금을 해제한 뒤 다시 시도해 주세요.", "PIN_LOCKED"));
        }
        let mut config = inner.config.clone().ok_or_else(|| fail_invalid("먼저 PIN을 설정해 주세요."))?;
        config.biometric = enabled;
        let raw = serde_json::to_string(&config).map_err(|_| fail_invalid("지문 설정을 저장하지 못했습니다."))?;
        atomic_write_str(&self.file, &raw)?;
        inner.config = Some(config);
        self.biometric.store(enabled, Ordering::SeqCst);
        // 진행 중이던 인증은 이전 설정의 결과이므로 더 이상 잠금을 해제할 수 없다.
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.unlocked_generation.store(next, Ordering::SeqCst);
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
                biometric: inner.config.as_ref().is_some_and(|config| config.biometric),
            })
        } else {
            None
        };
        let _transition = self.transition.lock().unwrap();
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
        self.biometric.store(config.as_ref().is_some_and(|config| config.biometric), Ordering::SeqCst);
        inner.config = config;
        inner.failures = 0;
        inner.retry_at = None;
        Ok(())
    }
}
