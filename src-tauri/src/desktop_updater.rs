use serde_json::Value;
#[cfg(not(target_os = "android"))]
use tauri::Manager;

#[tauri::command]
pub async fn desktop_update_check(webview: tauri::Webview, channel: String) -> Result<Option<Value>, String> {
    if !matches!(channel.as_str(), "stable" | "rc" | "beta") {
        return Err("업데이트 채널을 확인해 주세요.".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_updater::UpdaterExt;
        let endpoint = format!("https://github.com/loopix8000/lof-writer/releases/download/{channel}/latest.json");
        let updater = webview.updater_builder()
            .endpoints(vec![tauri::Url::parse(&endpoint).map_err(|error| error.to_string())?])
            .map_err(|error| error.to_string())?
            .timeout(std::time::Duration::from_secs(15))
            .version_comparator(move |current, release| {
                let kind = release.version.pre.as_str().split('.').next().unwrap_or("");
                release.version > current && match channel.as_str() {
                    "stable" => kind.is_empty(),
                    "rc" => kind.is_empty() || kind == "rc",
                    _ => true,
                }
            })
            .build().map_err(|error| error.to_string())?;
        let update = match updater.check().await {
            Ok(update) => update,
            Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
                // 미게시 채널의 404만 업데이트 없음으로 보고 서버 오류는 감추지 않는다.
                let response = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15))
                    .build().map_err(|error| error.to_string())?
                    .get(&endpoint).send().await.map_err(|error| error.to_string())?;
                if matches!(response.status().as_u16(), 404 | 204) { return Ok(None); }
                return Err(format!("업데이트 정보를 확인하지 못했습니다. 응답 코드 {}", response.status()));
            }
            Err(error) => return Err(error.to_string()),
        };
        Ok(update.map(|update| {
            let mut metadata = serde_json::json!({
                "currentVersion": update.current_version,
                "version": update.version,
                "date": update.raw_json["pub_date"],
                "body": update.body,
                "rawJson": update.raw_json,
            });
            metadata["rid"] = serde_json::json!(webview.resources_table().add(update));
            metadata
        }))
    }
    #[cfg(target_os = "android")]
    {
        let _ = webview;
        Err("PC 앱에서만 사용할 수 있습니다.".into())
    }
}
