mod audio;
mod cloud;
mod dlive;
mod fonts;
mod io;
mod media;
mod package;
mod workspace;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The "quit while the wall is up?" question is on screen (a second Cmd+Q or close click waits on it).
static QUIT_ASKING: AtomicBool = AtomicBool::new(false);

/// The operator asked to quit (close button, Cmd+W, Alt+F4, Cmd+Q). With the audience output open,
/// ask first: closing the operator window takes the wall down with it. Quitting goes through
/// `exit(0)`, which the guard lets through (only user-initiated exits, `code: None`, are asked about).
fn request_quit(app: &AppHandle) {
    if app.get_webview_window("output").is_none() {
        app.exit(0);
        return;
    }
    if QUIT_ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    #[allow(unused_mut)]
    let mut dialog = app
        .dialog()
        .message("The audience output is open. Quit LiveStage and close it?")
        .title("Quit LiveStage?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()));
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.set_focus();
        // On a Mac the question is an app-wide alert rather than a sheet, so it shows even when the
        // operator window is hidden; elsewhere it belongs to the operator window so it is in front.
        #[cfg(not(target_os = "macos"))]
        {
            dialog = dialog.parent(&main);
        }
    }
    let app2 = app.clone();
    dialog.show(move |quit| {
        QUIT_ASKING.store(false, Ordering::SeqCst);
        if quit {
            app2.exit(0);
        }
    });
}

/// macOS: the default menu's Quit item calls `[NSApp terminate:]`, which ends the app without any
/// event the app could stop. Replace it with an item of our own (same label and Cmd+Q) that asks first.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let menu = Menu::default(app)?;
    if let Some(first) = menu.items()?.into_iter().next() {
        if let Some(sub) = first.as_submenu() {
            let items = sub.items()?;
            let quit_at = items.iter().position(|i| i.as_predefined_menuitem().and_then(|p| p.text().ok()).is_some_and(|t| t.starts_with("Quit")));
            if let Some(at) = quit_at {
                sub.remove_at(at)?;
                let label = format!("Quit {}", app.package_info().name);
                sub.insert(&MenuItem::with_id(app, QUIT_MENU_ID, label, true, Some("CmdOrCtrl+Q"))?, at)?;
            }
        }
    }
    Ok(menu)
}

#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "livestage-quit";

/// Both webviews must share identical WebView2 arguments on Windows, otherwise the
/// second window fails to start. Keep in sync with `additionalBrowserArgs` in tauri.conf.json.
///
/// Besides the Edge UI features and autoplay: Chromium throttles timers and rendering of a hidden
/// or occluded window (the operator window behind StageMics would run its cue loop at 1 Hz), so
/// backgrounding is switched off for both windows, and the GPU is used even on a driver Chromium
/// would otherwise blocklist (software WebGL cannot draw a 3072 x 768 wall at 60 fps anyway).
#[cfg(windows)]
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --ignore-gpu-blocklist";

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
        .title("LiveStage — Audience Output")
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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id() == QUIT_MENU_ID {
            request_quit(app);
        }
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Updates only install when the operator asks for it (src/engine/updater.ts).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(audio::plugin())
        .manage(io::IoState::default())
        .manage(dlive::DliveState::default())
        .manage(package::HashCache::default())
        .invoke_handler(tauri::generate_handler![
            ensure_output_window,
            io::midi_ports,
            io::midi_open,
            io::midi_send,
            io::osc_listen,
            io::osc_send,
            dlive::dlive_connect,
            dlive::dlive_disconnect,
            dlive::dlive_send,
            fonts::system_fonts,
            package::package_export,
            package::package_read,
            package::package_import_files,
            package::hash_files,
            package::bundled_on_disk,
            package::reveal_in_file_manager,
            workspace::workspace_dir,
            workspace::workspace_set,
            workspace::workspace_show_dir,
            workspace::workspace_resolve,
            cloud::cloud_http,
            cloud::cloud_hash_sources,
            cloud::cloud_upload,
            cloud::cloud_download,
            media::media_probe,
            media::media_tools,
            media::media_optimise,
            audio::audio_outputs,
            audio::audio_output_route,
            audio::audio_output_restore,
            audio::audio_asio_drivers
        ])
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
            // The workspace folder (per-computer setting) is served through the asset protocol too.
            workspace::allow_in_asset_scope(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the operator window ends the show: take the output window with it
            // so a borderless fullscreen window is never left stranded on the LED wall.
            // While the output is open, a close (button, Cmd+W, Alt+F4) asks first.
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } if window.app_handle().get_webview_window("output").is_some() => {
                        api.prevent_close();
                        request_quit(window.app_handle());
                    }
                    WindowEvent::Destroyed => window.app_handle().exit(0),
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running LiveStage")
        .run(|app, event| match event {
            // The last window closing (code None) is the operator's doing: ask while the output is up.
            // `exit(code)` (the operator window's own teardown, a confirmed quit, an update restart)
            // carries a code and is never stopped.
            tauri::RunEvent::ExitRequested { code: None, api, .. } if app.get_webview_window("output").is_some() => {
                api.prevent_exit();
                request_quit(app);
            }
            // Give the Mac back the sound output it had before the show routed it.
            tauri::RunEvent::Exit => {
                media::kill_encoders();
                let _ = audio::restore_default_output();
            }
            _ => {}
        });
}
