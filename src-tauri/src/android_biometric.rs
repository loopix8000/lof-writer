use serde_json::Value;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "android")]
struct AndroidBiometric(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("android-biometric")
        .setup(|app, api| {
            app.manage(AndroidBiometric(api.register_android_plugin("local.lof.writer", "AndroidBiometricPlugin")?));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
async fn authenticate(app: &AppHandle) -> Result<bool, String> {
    let result: Value = app.state::<AndroidBiometric>().0
        .run_mobile_plugin_async("authenticate", serde_json::json!({}))
        .await.map_err(|error| error.to_string())?;
    Ok(result["authenticated"] == true)
}

#[tauri::command]
pub async fn android_biometric_status(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidBiometric>().0.run_mobile_plugin_async("status", serde_json::json!({}))
            .await.map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({"available":false,"reason":"Android 앱에서만 사용할 수 있습니다."}))
    }
}

#[tauri::command]
pub async fn android_biometric_set_enabled(app: AppHandle, enabled: bool) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let generation = app.state::<crate::pin::PinState>().biometric_generation(false).map_err(|error| error.message)?;
        if enabled && !authenticate(&app).await? { return Ok(Value::Null); }
        app.state::<crate::pin::PinState>().set_biometric(enabled, generation).map_err(|error| error.message)?;
        let status = crate::pin_status(&app);
        let _ = app.emit("lof:pin-state", &status);
        Ok(status)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Err("Android 앱에서만 사용할 수 있습니다.".into())
    }
}

#[tauri::command]
pub async fn android_biometric_unlock(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let generation = app.state::<crate::pin::PinState>().biometric_generation(true).map_err(|error| error.message)?;
        if !authenticate(&app).await? { return Ok(Value::Null); }
        app.state::<crate::pin::PinState>().unlock_biometric(generation).map_err(|error| error.message)?;
        let status = crate::pin_status(&app);
        let _ = app.emit("lof:pin-state", &status);
        Ok(status)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android 앱에서만 사용할 수 있습니다.".into())
    }
}
