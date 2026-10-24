//! Windows 로그인 시 실행 등록과 처음 창을 표시할 방식을 관리한다.
use crate::error::{fail_invalid, LofError};
use serde_json::Value;

pub fn background_launch() -> bool {
    cfg!(windows)
        && std::env::args()
            .skip(1)
            .any(|arg| arg == "--autostart" || arg == "--tray")
}

pub fn start_in_tray(settings: &Value) -> bool {
    cfg!(windows)
        && (settings["preferences"]["startInTray"] == true
            || std::env::args().skip(1).any(|arg| arg == "--tray"))
}

pub fn validate(patch: &Value) -> Result<(), LofError> {
    for key in ["launchAtStartup", "startInTray"] {
        if let Some(value) = patch.get(key) {
            if !cfg!(windows) {
                return Err(fail_invalid("Windows 앱에서만 사용할 수 있습니다."));
            }
            if !value.is_boolean() {
                return Err(fail_invalid("앱 시작 설정을 확인해 주세요."));
            }
        }
    }
    Ok(())
}

pub struct RegistrationChange {
    #[cfg(windows)]
    previous: Option<String>,
}

impl RegistrationChange {
    pub fn rollback(&self) -> Result<(), LofError> {
        #[cfg(windows)]
        windows::set_command(self.previous.as_deref())?;
        Ok(())
    }
}

pub fn apply(patch: &Value) -> Result<Option<RegistrationChange>, LofError> {
    #[cfg(windows)]
    if let Some(enabled) = patch["launchAtStartup"].as_bool() {
        let previous = windows::command()?;
        let next = if enabled {
            Some(windows::launch_command()?)
        } else {
            None
        };
        if previous == next {
            return Ok(None);
        }
        windows::set_command(next.as_deref())?;
        let verified = windows::command();
        if !verified.as_ref().is_ok_and(|command| *command == next) {
            let error = verified.err().unwrap_or_else(|| {
                fail_invalid("Windows 시작 프로그램 등록을 확인하지 못했습니다.")
            });
            windows::set_command(previous.as_deref())?;
            return Err(error);
        }
        return Ok(Some(RegistrationChange { previous }));
    }
    #[cfg(not(windows))]
    let _ = patch;
    Ok(None)
}

pub fn load(settings: &mut Value) -> Result<(), LofError> {
    #[cfg(windows)]
    {
        // 등록을 외부에서 지웠을 때 앱을 실행하는 것만으로 다시 등록하지 않는다.
        let enabled = windows::command()?.is_some_and(|command| !command.is_empty());
        if !settings["preferences"].is_object() {
            settings["preferences"] = serde_json::json!({});
        }
        settings["preferences"]["launchAtStartup"] = serde_json::json!(enabled);
    }
    #[cfg(not(windows))]
    let _ = settings;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use crate::error::{fail, LofError};
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegOpenKeyExW,
            RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE,
            REG_SZ, RRF_RT_REG_SZ,
        },
    };

    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const NAME: &str = "Lof Writer";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn error(code: u32) -> LofError {
        fail(
            format!(
                "Windows 시작 프로그램 설정 실패: {}",
                std::io::Error::from_raw_os_error(code as i32)
            ),
            "STARTUP",
        )
    }
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    pub fn launch_command() -> Result<String, LofError> {
        let path = crate::store::strip_verbatim_prefix(&std::env::current_exe()?);
        let path = path
            .to_str()
            .ok_or_else(|| fail("앱 실행 경로를 읽지 못했습니다.", "STARTUP"))?;
        Ok(format!("\"{path}\" --autostart"))
    }

    pub fn command() -> Result<Option<String>, LofError> {
        let (key, name) = (wide(KEY), wide(NAME));
        let mut length = 0;
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut length,
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS {
            return Err(error(result));
        }
        let mut buffer = vec![0u16; (length as usize).div_ceil(2)];
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS {
            return Err(error(result));
        }
        buffer.truncate(
            buffer
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(buffer.len()),
        );
        String::from_utf16(&buffer)
            .map(Some)
            .map_err(|_| fail("시작 프로그램의 실행 경로를 읽지 못했습니다.", "STARTUP"))
    }

    pub fn set_command(command: Option<&str>) -> Result<(), LofError> {
        let (key, name) = (wide(KEY), wide(NAME));
        let mut handle = ptr::null_mut();
        let result = unsafe {
            if command.is_some() {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    0,
                    ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_SET_VALUE,
                    ptr::null(),
                    &mut handle,
                    ptr::null_mut(),
                )
            } else {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    key.as_ptr(),
                    0,
                    KEY_SET_VALUE,
                    &mut handle,
                )
            }
        };
        if result == ERROR_FILE_NOT_FOUND && command.is_none() {
            return Ok(());
        }
        if result != ERROR_SUCCESS {
            return Err(error(result));
        }
        let key = Key(handle);
        let result = unsafe {
            match command {
                Some(command) => {
                    let command = wide(command);
                    RegSetValueExW(
                        key.0,
                        name.as_ptr(),
                        0,
                        REG_SZ,
                        command.as_ptr().cast(),
                        (command.len() * 2) as u32,
                    )
                }
                None => RegDeleteValueW(key.0, name.as_ptr()),
            }
        };
        if result == ERROR_SUCCESS || (command.is_none() && result == ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err(error(result))
        }
    }
}
