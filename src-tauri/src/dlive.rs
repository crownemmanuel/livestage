//! TCP link to an Allen & Heath dLive (MIDI over TCP, port 51325, no login).
//!
//! A dumb byte pipe: the protocol (what to send, how to read the desk's replies) lives in
//! TypeScript (shared/dlive.ts, src/engine/dlive.ts). This side opens the socket, keeps it open
//! (reconnecting with backoff after a drop) and relays what the desk sends as Tauri events:
//! `sls://dlive` {bytes} and `sls://dlive-status` {state, error}.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct DliveState {
    link: Mutex<Option<Link>>,
}

struct Link {
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Option<TcpStream>>>,
}

#[derive(Serialize, Clone)]
struct DataEvent {
    generation: u64,
    bytes: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct StatusEvent {
    /// Which `dlive_connect` call this link belongs to (events of a replaced link are stale).
    generation: u64,
    /// "connecting" | "connected" | "disconnected" | "off"
    state: &'static str,
    error: Option<String>,
    host: String,
    port: u16,
}

fn status(app: &AppHandle, generation: u64, state: &'static str, error: Option<String>, host: &str, port: u16) {
    let _ = app.emit("sls://dlive-status", StatusEvent { generation, state, error, host: host.to_string(), port });
}

fn stop_link(state: &DliveState) {
    if let Some(link) = state.link.lock().unwrap().take() {
        link.stop.store(true, Ordering::Relaxed);
        if let Some(s) = link.writer.lock().unwrap().take() {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

/// Sleep up to `ms`, waking early when asked to stop. Returns false when stopped.
fn wait(stop: &AtomicBool, ms: u64) -> bool {
    let mut left = ms;
    while left > 0 {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let step = left.min(100);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;
    }
    !stop.load(Ordering::Relaxed)
}

/// Connect to the desk and keep the link up until `dlive_disconnect` (or another connect).
/// Returns the link's generation, carried by its events.
#[tauri::command]
pub fn dlive_connect(app: AppHandle, state: State<DliveState>, host: String, port: u16) -> Result<u64, String> {
    stop_link(&state);
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("No desk address".into());
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    let writer: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));
    *state.link.lock().unwrap() = Some(Link { stop: stop.clone(), writer: writer.clone() });

    std::thread::spawn(move || {
        let mut backoff_ms: u64 = 500;
        while !stop.load(Ordering::Relaxed) {
            status(&app, generation, "connecting", None, &host, port);
            let addr = (host.as_str(), port).to_socket_addrs().ok().and_then(|mut a| a.next());
            let result = match addr {
                Some(addr) => TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| e.to_string()),
                None => Err(format!("Cannot resolve {host}")),
            };
            match result {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
                    match stream.try_clone() {
                        Ok(w) => *writer.lock().unwrap() = Some(w),
                        Err(e) => {
                            status(&app, generation, "disconnected", Some(e.to_string()), &host, port);
                            if !wait(&stop, backoff_ms) {
                                break;
                            }
                            continue;
                        }
                    }
                    if stop.load(Ordering::Relaxed) {
                        let _ = stream.shutdown(Shutdown::Both);
                        break;
                    }
                    status(&app, generation, "connected", None, &host, port);
                    backoff_ms = 500;
                    let mut reader = stream;
                    let mut buf = [0u8; 4096];
                    let error = loop {
                        if stop.load(Ordering::Relaxed) {
                            break None;
                        }
                        match reader.read(&mut buf) {
                            Ok(0) => break Some("The desk closed the connection".to_string()),
                            Ok(n) => {
                                let _ = app.emit("sls://dlive", DataEvent { generation, bytes: buf[..n].to_vec() });
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                            Err(e) => break Some(e.to_string()),
                        }
                    };
                    if let Some(w) = writer.lock().unwrap().take() {
                        let _ = w.shutdown(Shutdown::Both);
                    }
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    status(&app, generation, "disconnected", error, &host, port);
                }
                Err(e) => status(&app, generation, "disconnected", Some(e), &host, port),
            }
            if !wait(&stop, backoff_ms) {
                break;
            }
            backoff_ms = (backoff_ms * 2).min(10_000);
        }
        status(&app, generation, "off", None, &host, port);
    });
    Ok(generation)
}

#[tauri::command]
pub fn dlive_disconnect(state: State<DliveState>) {
    stop_link(&state);
}

/// Send raw bytes to the desk. Fails when the link is down (nothing is queued).
#[tauri::command]
pub fn dlive_send(state: State<DliveState>, bytes: Vec<u8>) -> Result<(), String> {
    let guard = state.link.lock().unwrap();
    let Some(link) = guard.as_ref() else { return Err("Sound desk not connected (Settings → Sound desk)".into()) };
    let mut w = link.writer.lock().unwrap();
    let Some(stream) = w.as_mut() else { return Err("Sound desk not connected (reconnecting)".into()) };
    if let Err(e) = stream.write_all(&bytes).and_then(|_| stream.flush()) {
        // Wake the reader so it reconnects.
        let _ = stream.shutdown(Shutdown::Both);
        *w = None;
        return Err(format!("Sound desk: {e}"));
    }
    Ok(())
}
