use crate::error::{fail, fail_invalid, LofError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

pub const CLIENT_ID: &str = match option_env!("LOF_GOOGLE_CLIENT_ID") {
    Some(id) => id,
    None => "305870018708-n8nvl8s2lds42p89gf45rrc20eeta4bp.apps.googleusercontent.com",
};
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

#[derive(Default)]
pub struct AuthState {
    pending: AtomicBool,
    cancelled: AtomicBool,
}

impl AuthState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn check_cancelled(&self) -> Result<(), LofError> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(fail("Google Drive 연결을 취소했습니다.", "CANCELLED"))
        } else {
            Ok(())
        }
    }
}

struct AuthGuard<'a>(&'a AuthState);

impl Drop for AuthGuard<'_> {
    fn drop(&mut self) {
        self.0.pending.store(false, Ordering::SeqCst);
    }
}

pub struct Authorization {
    pub refresh_token: String,
    pub email: String,
    pub account_id: String,
}

pub fn http_client() -> Result<Client, LofError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail_invalid("Google Drive 연결을 준비하지 못했습니다."))
}

pub fn network_error(_: reqwest::Error) -> LofError {
    fail(
        "Google Drive에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.",
        "GOOGLE_NETWORK",
    )
}

pub fn check_response(response: Response) -> Result<Response, LofError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status.as_u16() == 401 {
        return Err(fail(
            "Google Drive 인증이 만료되었습니다. 계정을 다시 연결해 주세요.",
            "GOOGLE_AUTH",
        ));
    }
    let body: Value = response.json().unwrap_or(Value::Null);
    let reason = body
        .pointer("/error/errors/0/reason")
        .and_then(Value::as_str);
    let message = match (status.as_u16(), reason) {
        (_, Some("storageQuotaExceeded")) => "Google Drive 저장 공간이 부족합니다.",
        (403, Some("accessNotConfigured")) => "앱의 Google Drive API 사용 설정을 확인해 주세요.",
        (403, Some("rateLimitExceeded" | "userRateLimitExceeded")) | (429, _) => {
            "Google Drive 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
        }
        (403, _) => "Google Drive 접근 권한을 확인하거나 계정을 다시 연결해 주세요.",
        (404, _) => "Google Drive 동기화 파일을 찾을 수 없습니다. 다시 동기화해 주세요.",
        _ => "Google Drive 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
    Err(fail(message, "GOOGLE_DRIVE"))
}

fn token_request(client: &Client, mut fields: Vec<(&str, &str)>) -> Result<Value, LofError> {
    // 데스크톱 클라이언트에 시크릿이 요구되는 경우 빌드 설정에서 함께 제공할 수 있다.
    if let Some(secret) = option_env!("LOF_GOOGLE_CLIENT_SECRET").filter(|s| !s.is_empty()) {
        fields.push(("client_secret", secret));
    }
    let response = client
        .post(TOKEN_URL)
        .timeout(Duration::from_secs(30))
        .form(&fields)
        .send()
        .map_err(network_error)?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| fail_invalid("Google 인증 응답을 읽지 못했습니다."))?;
    if !status.is_success() {
        return Err(match body.get("error").and_then(Value::as_str) {
            Some("invalid_grant") => fail(
                "Google Drive 인증이 만료되었거나 해제되었습니다. 계정을 다시 연결해 주세요.",
                "GOOGLE_AUTH",
            ),
            Some("invalid_client" | "unauthorized_client") => fail(
                "앱의 Google OAuth 데스크톱 클라이언트 설정을 확인해 주세요.",
                "GOOGLE_CLIENT",
            ),
            _ => fail(
                "Google 계정 인증을 완료하지 못했습니다. 다시 연결해 주세요.",
                "GOOGLE_AUTH",
            ),
        });
    }
    Ok(body)
}

fn access_token(body: &Value) -> Result<&str, LofError> {
    body.get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail_invalid("Google 인증 토큰을 받지 못했습니다."))
}

pub fn refresh_access_token(client: &Client, config: &Value) -> Result<String, LofError> {
    let refresh = config
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail("Google 계정을 다시 연결해 주세요.", "GOOGLE_AUTH"))?;
    let client_id = config
        .get("clientId")
        .and_then(Value::as_str)
        .unwrap_or(CLIENT_ID);
    let body = token_request(
        client,
        vec![
            ("client_id", client_id),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ],
    )?;
    Ok(access_token(&body)?.to_string())
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn browser_reply(stream: &mut TcpStream, status: &str, text: &str) {
    let body = format!("<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Lof Writer</title><body><h1>Lof Writer</h1><p>{text}</p><p>이 창을 닫고 Lof Writer로 돌아가세요.</p></body></html>");
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    auth: &AuthState,
) -> Result<String, LofError> {
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        auth.check_cancelled()?;
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(1)))?;
                stream.set_write_timeout(Some(Duration::from_secs(1)))?;
                let mut line = String::new();
                let mut reader = BufReader::new((&stream).take(8192));
                if reader.read_line(&mut line).is_err() || !line.ends_with("\r\n") {
                    continue;
                }
                let mut header = String::new();
                loop {
                    header.clear();
                    match reader.read_line(&mut header) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if header == "\r\n" => break,
                        _ => {}
                    }
                }
                drop(reader);
                let mut parts = line.split_whitespace();
                let method = parts.next();
                let target = parts.next().unwrap_or("");
                let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"));
                let Ok(url) = url else { continue };
                if method != Some("GET") || url.path() != "/oauth/callback" {
                    browser_reply(
                        &mut stream,
                        "404 Not Found",
                        "요청한 페이지를 찾을 수 없습니다.",
                    );
                    continue;
                }
                let params: std::collections::HashMap<_, _> =
                    url.query_pairs().into_owned().collect();
                if params.get("state").map(String::as_str) != Some(state) {
                    browser_reply(
                        &mut stream,
                        "400 Bad Request",
                        "인증 요청이 일치하지 않습니다. 앱에서 다시 연결해 주세요.",
                    );
                    continue;
                }
                if params.contains_key("error") {
                    browser_reply(&mut stream, "200 OK", "Google 계정 연결을 취소했습니다.");
                    return Err(fail("Google 계정 연결이 허용되지 않았습니다.", "CANCELLED"));
                }
                if let Some(code) = params.get("code").filter(|s| !s.is_empty()) {
                    browser_reply(
                        &mut stream,
                        "200 OK",
                        "인증 응답을 받았습니다. 앱에서 연결 결과를 확인해 주세요.",
                    );
                    return Ok(code.clone());
                }
                browser_reply(
                    &mut stream,
                    "400 Bad Request",
                    "인증 코드를 받지 못했습니다. 다시 연결해 주세요.",
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(fail(
        "Google 로그인 대기 시간이 지났습니다. 다시 연결해 주세요.",
        "GOOGLE_TIMEOUT",
    ))
}

#[cfg(windows)]
fn open_browser(url: &str) -> Result<(), LofError> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let url: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(fail_invalid("기본 브라우저를 열지 못했습니다."));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_browser(url: &str) -> Result<(), LofError> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(url).spawn()?;
    Ok(())
}

pub fn authorize(auth: &AuthState) -> Result<Authorization, LofError> {
    if auth
        .pending
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(fail_invalid("이미 Google 계정을 연결하고 있습니다."));
    }
    let _guard = AuthGuard(auth);
    auth.cancelled.store(false, Ordering::SeqCst);
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let redirect = format!(
        "http://127.0.0.1:{}/oauth/callback",
        listener.local_addr()?.port()
    );
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token();
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", CLIENT_ID),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", DRIVE_SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
    ]);
    open_browser(url.as_str())?;
    let code = wait_for_code(&listener, &state, auth)?;
    auth.check_cancelled()?;
    let client = http_client()?;
    let body = token_request(
        &client,
        vec![
            ("client_id", CLIENT_ID),
            ("code", &code),
            ("code_verifier", &verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &redirect),
        ],
    )?;
    let access = access_token(&body)?;
    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail_invalid("계정 연결 유지 권한을 받지 못했습니다. 다시 연결해 주세요."))?
        .to_string();
    let about: Value = check_response(
        client
            .get("https://www.googleapis.com/drive/v3/about")
            .timeout(Duration::from_secs(30))
            .query(&[("fields", "user(emailAddress,permissionId)")])
            .bearer_auth(access)
            .send()
            .map_err(network_error)?,
    )?
    .json()
    .map_err(|_| fail_invalid("Google 계정 정보를 읽지 못했습니다."))?;
    auth.check_cancelled()?;
    let email = about
        .pointer("/user/emailAddress")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail_invalid("Google 계정 이메일을 확인하지 못했습니다."))?
        .to_string();
    let account_id = about
        .pointer("/user/permissionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| fail_invalid("Google 계정을 확인하지 못했습니다."))?
        .to_string();
    Ok(Authorization {
        refresh_token,
        email,
        account_id,
    })
}
