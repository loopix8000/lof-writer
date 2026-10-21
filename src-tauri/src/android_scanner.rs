use serde_json::Value;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct AndroidScanner(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("android-scanner")
        .setup(|app, api| {
            let handle = api.register_android_plugin("local.lof.writer", "AndroidScannerPlugin")?;
            app.manage(AndroidScanner(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn android_scan_qr(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidScanner>()
            .0
            .run_mobile_plugin_async("scanQr", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android 앱에서만 사용할 수 있습니다.".into())
    }
}
