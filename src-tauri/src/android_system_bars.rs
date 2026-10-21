use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct AndroidSystemBars(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("android-system-bars")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("local.lof.writer", "AndroidSystemBarsPlugin")?;
            app.manage(AndroidSystemBars(handle));
            Ok(())
        })
        .build()
}

/// 앱 테마 색과 밝기를 상태 표시줄·내비게이션 바에 반영한다. 다른 플랫폼에서는 아무것도 하지 않는다.
#[tauri::command]
pub async fn android_set_system_bars(app: AppHandle, color: String, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidSystemBars>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "setSystemBars",
                serde_json::json!({ "color": color, "dark": dark }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, color, dark);
        Ok(())
    }
}
