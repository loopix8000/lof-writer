use serde_json::Value;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct AndroidUpdater(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("android-updater")
        .setup(|app, api| {
            let handle = api.register_android_plugin("local.lof.writer", "AndroidUpdaterPlugin")?;
            app.manage(AndroidUpdater(handle));
            Ok(())
        })
        .build()
}

async fn run(app: AppHandle, command: &str, args: Value) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidUpdater>()
            .0
            .run_mobile_plugin_async(command, args)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, command, args);
        Err("Android 앱에서만 사용할 수 있습니다.".into())
    }
}

#[tauri::command]
pub async fn android_update_check(app: AppHandle, channel: String) -> Result<Value, String> {
    run(app, "check", serde_json::json!({"channel":channel})).await
}

#[tauri::command]
pub async fn android_update_download(app: AppHandle, channel: String, version: String) -> Result<Value, String> {
    run(app, "download", serde_json::json!({"channel":channel,"version":version})).await
}

#[tauri::command]
pub async fn android_update_install(app: AppHandle, channel: String, version: String) -> Result<Value, String> {
    run(app, "install", serde_json::json!({"channel":channel,"version":version})).await
}
