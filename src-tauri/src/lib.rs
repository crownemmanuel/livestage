use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Both webviews must share identical WebView2 arguments on Windows, otherwise the
/// second window fails to start. Keep in sync with `additionalBrowserArgs` in tauri.conf.json.
#[cfg(windows)]
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Create the borderless audience output window if it does not exist yet, already at
/// its target position (logical px). It is created visible: on macOS a webview that
/// starts hidden keeps reporting `document.hidden` after show(), which stops rendering.
#[tauri::command]
async fn ensure_output_window(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if app.get_webview_window("output").is_some() {
        return Ok(());
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, "output", WebviewUrl::App("output.html".into()))
        .title("Salvation Live Studio — Audience Output")
        .decorations(false)
        .resizable(true)
        .focused(false)
        .visible(true)
        .position(x, y)
        .inner_size(width, height)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(BROWSER_ARGS);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![ensure_output_window])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Asset library lives in the app data folder.
            let dir = app.path().app_data_dir()?.join("assets");
            std::fs::create_dir_all(dir)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the operator window ends the show: take the output window with it
            // so a borderless fullscreen window is never left stranded on the LED wall.
            if window.label() == "main" {
                if let WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Salvation Live Studio");
}
