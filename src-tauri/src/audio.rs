//! Native audio outputs: every output device the operating system knows (Dante Virtual
//! Soundcard, USB and Thunderbolt interfaces, HDMI, virtual devices), read straight from
//! CoreAudio, and routing the app's sound to one of them.
//!
//! The webview (WKWebView) plays all of the app's sound, and it cannot be pointed at a device of
//! its own: it plays on the Mac's default output. So routing sets the Mac's default output to
//! the chosen device, and puts the previous default back when the app quits.
//!
//! On Windows the webview (WebView2) lists every playback device and plays to the chosen one
//! itself (setSinkId, see engine/audioOutput.ts); this side only lets it see them.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    /// CoreAudio's persistent device UID (stable across reboots and replugs).
    pub uid: String,
    pub name: String,
    pub manufacturer: String,
    /// builtIn | usb | thunderbolt | pci | firewire | hdmi | displayPort | bluetooth | airplay | avb | virtual | aggregate | unknown
    pub transport: String,
    /// Output channels.
    pub channels: u32,
    pub sample_rate: f64,
    /// The Mac's default output now (where the app's sound goes).
    pub is_default: bool,
    /// A Dante device (Dante Virtual Soundcard, Dante Via, or Audinate hardware).
    pub dante: bool,
    /// Some process is playing through it right now.
    pub running: bool,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::AudioOutputDevice;
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;
    use std::sync::Mutex;

    type ObjectId = u32;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyDataSize(id: ObjectId, addr: *const Address, qsize: u32, qdata: *const c_void, size: *mut u32) -> i32;
        fn AudioObjectGetPropertyData(id: ObjectId, addr: *const Address, qsize: u32, qdata: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
        fn AudioObjectSetPropertyData(id: ObjectId, addr: *const Address, qsize: u32, qdata: *const c_void, size: u32, data: *const c_void) -> i32;
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
    }

    const SYSTEM: ObjectId = 1;
    const GLOBAL: u32 = fourcc(b"glob");
    const OUTPUT: u32 = fourcc(b"outp");
    const DEVICES: u32 = fourcc(b"dev#");
    const DEFAULT_OUTPUT: u32 = fourcc(b"dOut");
    const NAME: u32 = fourcc(b"lnam");
    const MANUFACTURER: u32 = fourcc(b"lmak");
    const UID: u32 = fourcc(b"uid ");
    const STREAM_CONFIG: u32 = fourcc(b"slay");
    const TRANSPORT: u32 = fourcc(b"tran");
    const SAMPLE_RATE: u32 = fourcc(b"nsrt");
    const RUNNING_SOMEWHERE: u32 = fourcc(b"gone");

    fn addr(selector: u32, scope: u32) -> Address {
        Address { selector, scope, element: 0 }
    }

    fn get_bytes(id: ObjectId, selector: u32, scope: u32) -> Option<Vec<u8>> {
        let a = addr(selector, scope);
        let mut size = 0u32;
        if unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) } != 0 || size == 0 {
            return None;
        }
        // u64 storage keeps the buffer 8-byte aligned for the structs CoreAudio writes.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        if unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, buf.as_mut_ptr() as *mut c_void) } != 0 {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, size as usize) };
        Some(bytes.to_vec())
    }

    fn get_u32(id: ObjectId, selector: u32, scope: u32) -> Option<u32> {
        let b = get_bytes(id, selector, scope)?;
        Some(u32::from_ne_bytes(b.get(..4)?.try_into().ok()?))
    }

    fn get_f64(id: ObjectId, selector: u32, scope: u32) -> Option<f64> {
        let b = get_bytes(id, selector, scope)?;
        Some(f64::from_ne_bytes(b.get(..8)?.try_into().ok()?))
    }

    fn get_string(id: ObjectId, selector: u32) -> Option<String> {
        let a = addr(selector, GLOBAL);
        let mut s: CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;
        let err = unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut s as *mut CFStringRef as *mut c_void) };
        if err != 0 || s.is_null() {
            return None;
        }
        // The property hands over a retained string (create rule).
        Some(unsafe { CFString::wrap_under_create_rule(s) }.to_string())
    }

    /// Output channels: the sum over the device's output streams (an AudioBufferList).
    fn output_channels(id: ObjectId) -> u32 {
        let Some(b) = get_bytes(id, STREAM_CONFIG, OUTPUT) else { return 0 };
        let n = b.get(..4).map(|x| u32::from_ne_bytes(x.try_into().unwrap())).unwrap_or(0) as usize;
        // AudioBufferList { u32 count; (pad); AudioBuffer[count] { u32 channels; u32 bytes; void* data } }
        let stride = 8 + std::mem::size_of::<usize>();
        (0..n)
            .filter_map(|i| b.get(8 + i * stride..8 + i * stride + 4))
            .map(|x| u32::from_ne_bytes(x.try_into().unwrap()))
            .sum()
    }

    fn transport_name(t: u32) -> &'static str {
        match &t.to_be_bytes() {
            b"bltn" => "builtIn",
            b"usb " => "usb",
            b"thun" => "thunderbolt",
            b"pci " => "pci",
            b"1394" => "firewire",
            b"hdmi" => "hdmi",
            b"dprt" => "displayPort",
            b"blue" | b"blea" => "bluetooth",
            b"airp" => "airplay",
            b"eavb" | b"eave" => "avb",
            b"virt" => "virtual",
            b"grup" | b"agrp" => "aggregate",
            _ => "unknown",
        }
    }

    fn device_ids() -> Vec<ObjectId> {
        get_bytes(SYSTEM, DEVICES, GLOBAL)
            .map(|b| b.chunks_exact(4).map(|c| u32::from_ne_bytes(c.try_into().unwrap())).collect())
            .unwrap_or_default()
    }

    fn default_output() -> Option<ObjectId> {
        get_u32(SYSTEM, DEFAULT_OUTPUT, GLOBAL).filter(|&d| d != 0)
    }

    fn set_default_output(id: ObjectId) -> Result<(), String> {
        let a = addr(DEFAULT_OUTPUT, GLOBAL);
        let err = unsafe { AudioObjectSetPropertyData(SYSTEM, &a, 0, std::ptr::null(), 4, &id as *const u32 as *const c_void) };
        if err != 0 { Err(format!("CoreAudio refused the output (error {err})")) } else { Ok(()) }
    }

    pub fn outputs() -> Vec<AudioOutputDevice> {
        let def = default_output();
        device_ids()
            .into_iter()
            .filter_map(|id| {
                let channels = output_channels(id);
                if channels == 0 {
                    return None;
                }
                let name = get_string(id, NAME).unwrap_or_else(|| format!("Device {id}"));
                let manufacturer = get_string(id, MANUFACTURER).unwrap_or_default();
                let lower = format!("{name} {manufacturer}").to_lowercase();
                Some(AudioOutputDevice {
                    uid: get_string(id, UID)?,
                    dante: lower.contains("dante") || lower.contains("audinate"),
                    transport: transport_name(get_u32(id, TRANSPORT, GLOBAL).unwrap_or(0)).into(),
                    sample_rate: get_f64(id, SAMPLE_RATE, GLOBAL).unwrap_or(0.0),
                    is_default: Some(id) == def,
                    running: get_u32(id, RUNNING_SOMEWHERE, GLOBAL).unwrap_or(0) != 0,
                    name,
                    manufacturer,
                    channels,
                })
            })
            .collect()
    }

    /// The Mac's default output before the app first changed it (put back on quit).
    static ORIGINAL: Mutex<Option<String>> = Mutex::new(None);

    fn id_for_uid(uid: &str) -> Option<ObjectId> {
        device_ids().into_iter().find(|&id| get_string(id, UID).as_deref() == Some(uid))
    }

    pub fn route(uid: &str) -> Result<(), String> {
        let id = id_for_uid(uid).ok_or_else(|| "That audio device is not connected.".to_string())?;
        let mut orig = ORIGINAL.lock().unwrap();
        if orig.is_none() {
            *orig = default_output().and_then(|d| get_string(d, UID));
        }
        set_default_output(id)
    }

    /// Put the Mac's default output back to what it was before the app routed it.
    pub fn restore() -> Result<(), String> {
        let Some(uid) = ORIGINAL.lock().unwrap().take() else { return Ok(()) };
        match id_for_uid(&uid) {
            Some(id) => set_default_output(id),
            None => Ok(()),
        }
    }
}

/// Windows: the app's own pages may use the microphone without a prompt. WebView2 names its audio
/// outputs (Dante Virtual Soundcard among them), and lets a page play to one of them, only once the
/// page may use a microphone. The app asks for it only to see and pick outputs; it never records.
#[cfg(windows)]
mod windows_mic {
    use webview2_com::{take_pwstr, Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    /// The app's pages: the bundled app, and the dev server (and test profiles) on localhost.
    fn is_app_page(uri: &str) -> bool {
        ["http://tauri.localhost/", "https://tauri.localhost/", "http://localhost:", "http://127.0.0.1:"].iter().any(|p| uri.starts_with(p))
    }

    pub fn grant<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
        let result = webview.with_webview(|pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let uri = {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    take_pwstr(uri)
                };
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && is_app_page(&uri) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
                log::warn!("audio outputs: could not watch microphone requests: {e}");
            }
        });
        if let Err(e) = result {
            log::warn!("audio outputs: no WebView2 handle: {e}");
        }
    }
}

/// Windows: the ASIO drivers installed (HKLM\SOFTWARE\ASIO), e.g. "Dante Virtual Soundcard (x64)".
/// The app cannot play to them (the webview reaches only Windows' own outputs), but knowing Dante
/// Virtual Soundcard is installed lets it say how to make it visible: run it in WDM mode.
#[cfg(windows)]
fn asio_drivers() -> Vec<String> {
    use windows::core::{w, PWSTR};
    use windows::Win32::System::Registry::*;
    let mut names = Vec::new();
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, w!("SOFTWARE\\ASIO"), None, KEY_READ, &mut key).0 != 0 {
            return names;
        }
        let mut buf = [0u16; 256];
        for i in 0.. {
            let mut len = buf.len() as u32;
            if RegEnumKeyExW(key, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None).0 != 0 {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        let _ = RegCloseKey(key);
    }
    names
}

/// The ASIO drivers installed on this computer (Windows; empty elsewhere).
#[tauri::command]
pub fn audio_asio_drivers() -> Vec<String> {
    #[cfg(windows)]
    return asio_drivers();
    #[cfg(not(windows))]
    Vec::new()
}

/// Sets up every webview to see the computer's audio outputs (Windows; nothing to do elsewhere).
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("audio-outputs")
        .on_webview_ready(|_webview| {
            #[cfg(windows)]
            windows_mic::grant(&_webview);
        })
        .build()
}

/// Every audio output device of this computer. Empty where native listing is not supported.
#[tauri::command]
pub fn audio_outputs() -> Vec<AudioOutputDevice> {
    #[cfg(target_os = "macos")]
    return mac::outputs();
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// Send the app's sound to this device (by UID).
#[tauri::command]
pub fn audio_output_route(uid: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::route(&uid);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = uid;
        Err("Native audio routing is only available on macOS; use a web engine output.".into())
    }
}

/// Give the computer back its own default output.
#[tauri::command]
pub fn audio_output_restore() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::restore();
    #[cfg(not(target_os = "macos"))]
    Ok(())
}
