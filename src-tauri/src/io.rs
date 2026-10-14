//! Show-control I/O: MIDI (midir) and OSC over UDP (rosc).
//!
//! The webview cannot open MIDI ports or UDP sockets itself (WKWebView has no Web MIDI,
//! browsers have no UDP), so the Rust shell owns them and relays messages as Tauri events:
//! `sls://midi` {bytes, ts} and `sls://osc` {address, args, from}.

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rosc::{OscMessage, OscPacket, OscType};
use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const CLIENT: &str = "Salvation Live Studio";

#[derive(Default)]
pub struct IoState {
    midi_in: Mutex<Option<MidiInputConnection<()>>>,
    midi_out: Mutex<Option<MidiOutputConnection>>,
    osc_stop: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    osc_port: Mutex<Option<u16>>,
}

#[derive(Serialize)]
pub struct MidiPorts {
    inputs: Vec<String>,
    outputs: Vec<String>,
}

#[derive(Serialize, Clone)]
struct MidiEvent {
    bytes: Vec<u8>,
    ts: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "t", content = "v")]
pub enum OscArg {
    #[serde(rename = "i")]
    Int(i32),
    #[serde(rename = "f")]
    Float(f32),
    #[serde(rename = "s")]
    Str(String),
    #[serde(rename = "b")]
    Bool(bool),
}

#[derive(Serialize, Clone)]
struct OscEvent {
    address: String,
    args: Vec<OscArg>,
    from: String,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
pub fn midi_ports() -> Result<MidiPorts, String> {
    let input = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
    let output = MidiOutput::new(CLIENT).map_err(|e| e.to_string())?;
    let inputs = input.ports().iter().filter_map(|p| input.port_name(p).ok()).collect();
    let outputs = output.ports().iter().filter_map(|p| output.port_name(p).ok()).collect();
    Ok(MidiPorts { inputs, outputs })
}

/// Open (or close, with None) the MIDI input and output by port name.
#[tauri::command]
pub fn midi_open(app: AppHandle, state: State<IoState>, input: Option<String>, output: Option<String>) -> Result<(), String> {
    // Drop existing connections first so the same port can be reopened.
    *state.midi_in.lock().unwrap() = None;
    *state.midi_out.lock().unwrap() = None;

    if let Some(name) = input {
        let midi_in = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
        let port = midi_in
            .ports()
            .into_iter()
            .find(|p| midi_in.port_name(p).map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| format!("MIDI input '{name}' not found"))?;
        let handle = app.clone();
        let conn = midi_in
            .connect(
                &port,
                "sls-in",
                move |_stamp, bytes, _| {
                    let _ = handle.emit("sls://midi", MidiEvent { bytes: bytes.to_vec(), ts: now_ms() });
                },
                (),
            )
            .map_err(|e| e.to_string())?;
        *state.midi_in.lock().unwrap() = Some(conn);
    }
    if let Some(name) = output {
        let midi_out = MidiOutput::new(CLIENT).map_err(|e| e.to_string())?;
        let port = midi_out
            .ports()
            .into_iter()
            .find(|p| midi_out.port_name(p).map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| format!("MIDI output '{name}' not found"))?;
        let conn = midi_out.connect(&port, "sls-out").map_err(|e| e.to_string())?;
        *state.midi_out.lock().unwrap() = Some(conn);
    }
    Ok(())
}

#[tauri::command]
pub fn midi_send(state: State<IoState>, bytes: Vec<u8>) -> Result<(), String> {
    let mut guard = state.midi_out.lock().unwrap();
    match guard.as_mut() {
        Some(conn) => conn.send(&bytes).map_err(|e| e.to_string()),
        None => Err("No MIDI output open".into()),
    }
}

fn to_osc_type(a: &OscArg) -> OscType {
    match a {
        OscArg::Int(i) => OscType::Int(*i),
        OscArg::Float(f) => OscType::Float(*f),
        OscArg::Str(s) => OscType::String(s.clone()),
        OscArg::Bool(b) => OscType::Bool(*b),
    }
}

fn from_osc_type(t: &OscType) -> Option<OscArg> {
    match t {
        OscType::Int(i) => Some(OscArg::Int(*i)),
        OscType::Long(i) => Some(OscArg::Int(*i as i32)),
        OscType::Float(f) => Some(OscArg::Float(*f)),
        OscType::Double(f) => Some(OscArg::Float(*f as f32)),
        OscType::String(s) => Some(OscArg::Str(s.clone())),
        OscType::Bool(b) => Some(OscArg::Bool(*b)),
        _ => None,
    }
}

fn emit_packet(app: &AppHandle, packet: OscPacket, from: &str) {
    match packet {
        OscPacket::Message(m) => {
            let args = m.args.iter().filter_map(from_osc_type).collect();
            let _ = app.emit("sls://osc", OscEvent { address: m.addr, args, from: from.to_string() });
        }
        OscPacket::Bundle(b) => {
            for p in b.content {
                emit_packet(app, p, from);
            }
        }
    }
}

/// Listen for OSC on a UDP port (None stops listening).
#[tauri::command]
pub fn osc_listen(app: AppHandle, state: State<IoState>, port: Option<u16>) -> Result<(), String> {
    if let Some(stop) = state.osc_stop.lock().unwrap().take() {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    *state.osc_port.lock().unwrap() = None;
    let Some(port) = port else { return Ok(()) };
    let socket = UdpSocket::bind(("0.0.0.0", port)).map_err(|e| format!("OSC port {port}: {e}"))?;
    socket.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *state.osc_stop.lock().unwrap() = Some(stop.clone());
    *state.osc_port.lock().unwrap() = Some(port);
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            match socket.recv_from(&mut buf) {
                Ok((n, from)) => {
                    if let Ok((_, packet)) = rosc::decoder::decode_udp(&buf[..n]) {
                        emit_packet(&app, packet, &from.to_string());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn osc_send(host: String, port: u16, address: String, args: Vec<OscArg>) -> Result<(), String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    let msg = OscPacket::Message(OscMessage { addr: address, args: args.iter().map(to_osc_type).collect() });
    let bytes = rosc::encoder::encode(&msg).map_err(|e| e.to_string())?;
    socket.send_to(&bytes, (host.as_str(), port)).map_err(|e| e.to_string())?;
    Ok(())
}
