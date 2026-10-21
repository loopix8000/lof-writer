use serde_json::Value;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct AndroidStorage(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("android-storage")
        .setup(|app, api| {
            let handle = api.register_android_plugin("local.lof.writer", "AndroidStoragePlugin")?;
            app.manage(AndroidStorage(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn android_pick_folder(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidStorage>()
            .0
            .run_mobile_plugin_async("pickFolder", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android 앱에서만 사용할 수 있습니다.".into())
    }
}

#[tauri::command]
pub async fn android_storage_access(app: AppHandle, request: bool) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidStorage>()
            .0
            .run_mobile_plugin_async(if request { "requestAccess" } else { "accessStatus" }, serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request);
        Ok(serde_json::json!({ "granted": true }))
    }
}
