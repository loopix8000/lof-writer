use std::io;
use std::path::Path;
use tauri::AppHandle;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
use std::sync::Arc;

pub struct SingleInstance {
    #[cfg(windows)]
    _mutex: OwnedHandle,
    #[cfg(windows)]
    restore_event: Arc<OwnedHandle>,
}

impl SingleInstance {
    #[cfg(windows)]
    pub fn acquire(user_dir: &Path, restore_existing: bool) -> io::Result<Option<Self>> {
        use crate::error::hash_str;
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::{CreateEventW, CreateMutexW, SetEvent};
        use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

        let dir_hash = &hash_str(&user_dir.to_string_lossy().to_lowercase())[..16];
        let mutex_name: Vec<u16> = format!("Local\\LofWriterSingleInstance_{dir_hash}\0")
            .encode_utf16()
            .collect();
        let event_name: Vec<u16> = format!("Local\\LofWriterRestore_{dir_hash}\0")
            .encode_utf16()
            .collect();
        unsafe {
            // 뮤텍스보다 먼저 만들어 시작 중에 들어온 복원 요청도 보관한다.
            let event = CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr());
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            let restore_event = OwnedHandle::from_raw_handle(event);
            let mutex = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
            if mutex.is_null() {
                return Err(io::Error::last_os_error());
            }
            let already_running = GetLastError() == ERROR_ALREADY_EXISTS;
            let mutex = OwnedHandle::from_raw_handle(mutex);
            if already_running {
                if !restore_existing { return Ok(None); }
                // 기존 앱이 자신의 창 상태와 PIN 잠금을 유지하며 앞으로 나오게 한다.
                AllowSetForegroundWindow(ASFW_ANY);
                if SetEvent(restore_event.as_raw_handle()) == 0 {
                    return Err(io::Error::last_os_error());
                }
                return Ok(None);
            }
            Ok(Some(Self {
                _mutex: mutex,
                restore_event: Arc::new(restore_event),
            }))
        }
    }

    #[cfg(not(windows))]
    pub fn acquire(_user_dir: &Path, _restore_existing: bool) -> io::Result<Option<Self>> {
        Ok(Some(Self {}))
    }

    #[cfg(windows)]
    pub fn listen(&self, app: &AppHandle) {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};

        let event = Arc::clone(&self.restore_event);
        let app = app.clone();
        std::thread::spawn(move || {
            while unsafe { WaitForSingleObject(event.as_raw_handle(), INFINITE) } == WAIT_OBJECT_0 {
                let handle = app.clone();
                // 트레이 메뉴와 같은 복원 경로를 메인 스레드에서 실행한다.
                if app
                    .run_on_main_thread(move || super::restore_main_window(&handle))
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    #[cfg(not(windows))]
    pub fn listen(&self, _app: &AppHandle) {}
}
