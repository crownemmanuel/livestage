//! Show-control I/O: MIDI (midir) and OSC over UDP (rosc).
//!
//! The webview cannot open MIDI ports or UDP sockets itself (WKWebView has no Web MIDI,
//! browsers have no UDP), so the Rust shell owns them and relays messages as Tauri events:
//! `sls://midi` {bytes, ts} and `sls://osc` {address, args, from}.
//!
//! Sync commands run on the main thread, which also carries all IPC to both windows, so nothing
//! here may block: OSC goes out through one sender thread (see `OscSender`), which resolves host
//! names off the main thread and reports a failure it finds later as `sls://osc-error`.

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rosc::{OscMessage, OscPacket, OscType};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const CLIENT: &str = "Live Studio";

/// Host name → address: re-resolved in the background after this long (the old address keeps being used meanwhile).
const RESOLVE_TTL: Duration = Duration::from_secs(60);
/// After a name fails to resolve, sends to it fail at once for this long instead of trying again.
const RESOLVE_FAIL_HOLD: Duration = Duration::from_secs(10);
/// A message waiting for its host's first address is dropped (and reported) after this long: a late cue is worse than none.
const RESOLVE_WAIT: Duration = Duration::from_millis(1000);

type FailedHosts = Arc<Mutex<HashMap<String, (String, Instant)>>>;

#[derive(Default)]
pub struct IoState {
    /// Each open MIDI connection with the port name it was opened on.
    midi_in: Mutex<Option<(String, MidiInputConnection<()>)>>,
    midi_out: Mutex<Option<(String, MidiOutputConnection)>>,
    osc_stop: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,
    osc_port: Mutex<Option<u16>>,
    /// The listening socket, so a message can be sent from the listen port and its reply comes back to it.
    osc_socket: Arc<Mutex<Option<UdpSocket>>>,
    /// The OSC sender thread's queue, started on the first send.
    osc_tx: Mutex<Option<mpsc::Sender<SendCmd>>>,
    /// Host names that last failed to resolve (with the error), written by the sender thread.
    osc_failed: FailedHosts,
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

/// MIDI real-time bytes that would cost an event into the page each (clock, MTC quarter frame, active sensing).
fn is_noise(bytes: &[u8]) -> bool {
    matches!(bytes.first(), Some(0xF8) | Some(0xF1) | Some(0xFE))
}

fn open_input(app: &AppHandle, name: &str) -> Result<MidiInputConnection<()>, String> {
    let mut midi_in = MidiInput::new(CLIENT).map_err(|e| format!("MIDI input '{name}': {e}"))?;
    // SysEx stays on: MIDI Show Control arrives as SysEx.
    midi_in.ignore(Ignore::TimeAndActiveSense);
    let port = midi_in
        .ports()
        .into_iter()
        .find(|p| midi_in.port_name(p).map(|n| n == name).unwrap_or(false))
        .ok_or_else(|| format!("MIDI input '{name}' not found"))?;
    let handle = app.clone();
    midi_in
        .connect(
            &port,
            "sls-in",
            move |_stamp, bytes, _| {
                if is_noise(bytes) {
                    return;
                }
                let _ = handle.emit("sls://midi", MidiEvent { bytes: bytes.to_vec(), ts: now_ms() });
            },
            (),
        )
        .map_err(|e| format!("MIDI input '{name}': {e}"))
}

fn open_output(name: &str) -> Result<MidiOutputConnection, String> {
    let midi_out = MidiOutput::new(CLIENT).map_err(|e| format!("MIDI output '{name}': {e}"))?;
    let port = midi_out
        .ports()
        .into_iter()
        .find(|p| midi_out.port_name(p).map(|n| n == name).unwrap_or(false))
        .ok_or_else(|| format!("MIDI output '{name}' not found"))?;
    midi_out.connect(&port, "sls-out").map_err(|e| format!("MIDI output '{name}': {e}"))
}

/// Open (or close, with None) the MIDI input and output by port name. Each side is handled on its
/// own: a missing input does not stop the output from opening. A side already open on the same
/// port name is kept as it is (close it with None first to force a fresh connection). Errors of
/// both sides come back joined with "; ", each starting "MIDI input" or "MIDI output".
#[tauri::command]
pub fn midi_open(app: AppHandle, state: State<IoState>, input: Option<String>, output: Option<String>) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    {
        let mut slot = state.midi_in.lock().unwrap();
        let keep = matches!((slot.as_ref(), input.as_ref()), (Some((open, _)), Some(want)) if open == want);
        if !keep {
            // Drop the old connection first so the same port can be reopened.
            *slot = None;
            if let Some(name) = input {
                match open_input(&app, &name) {
                    Ok(conn) => *slot = Some((name, conn)),
                    Err(e) => errors.push(e),
                }
            }
        }
    }
    {
        let mut slot = state.midi_out.lock().unwrap();
        let keep = matches!((slot.as_ref(), output.as_ref()), (Some((open, _)), Some(want)) if open == want);
        if !keep {
            *slot = None;
            if let Some(name) = output {
                match open_output(&name) {
                    Ok(conn) => *slot = Some((name, conn)),
                    Err(e) => errors.push(e),
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub fn midi_send(state: State<IoState>, bytes: Vec<u8>) -> Result<(), String> {
    let mut guard = state.midi_out.lock().unwrap();
    match guard.as_mut() {
        Some((_, conn)) => conn.send(&bytes).map_err(|e| e.to_string()),
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
    *state.osc_socket.lock().unwrap() = None;
    let Some(port) = port else { return Ok(()) };
    let socket = UdpSocket::bind(("0.0.0.0", port)).map_err(|e| format!("OSC port {port}: {e}"))?;
    socket.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *state.osc_stop.lock().unwrap() = Some(stop.clone());
    *state.osc_port.lock().unwrap() = Some(port);
    *state.osc_socket.lock().unwrap() = socket.try_clone().ok();
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
                // Windows reports a peer's "port unreachable" (an app that was closed) as a reset on the
                // next read. Nothing is wrong with the socket: keep reading without a pause.
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    });
    Ok(())
}

#[derive(Serialize, Clone)]
struct OscSendError {
    host: String,
    port: u16,
    address: String,
    error: String,
}

pub struct OscJob {
    host: String,
    port: u16,
    address: String,
    bytes: Vec<u8>,
    from_listener: bool,
    queued: Instant,
}

pub enum SendCmd {
    Send(OscJob),
    Resolved(String, Result<IpAddr, String>),
}

#[derive(Default)]
struct HostEntry {
    ip: Option<IpAddr>,
    resolved_at: Option<Instant>,
    resolving: bool,
    /// Messages waiting for this host's first address, oldest first.
    waiting: VecDeque<OscJob>,
}

/// An address that needs no lookup: an IP literal, or `localhost` (always IPv4: the listeners bind 0.0.0.0).
fn literal_ip(host: &str) -> Option<IpAddr> {
    if host.eq_ignore_ascii_case("localhost") {
        return Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    host.trim_start_matches('[').trim_end_matches(']').parse().ok()
}

/// Look a name up (blocking: only ever on a resolver thread), preferring IPv4.
fn resolve(host: &str) -> Result<IpAddr, String> {
    let addrs: Vec<SocketAddr> = (host, 0).to_socket_addrs().map_err(|e| format!("cannot resolve {host}: {e}"))?.collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .map(|a| a.ip())
        .ok_or_else(|| format!("cannot resolve {host}: no address"))
}

/// Send, retrying once on a connection reset: on Windows a reused UDP socket can report an
/// earlier "port unreachable" on its next call, and the retry is the real send.
fn send_retry(socket: &UdpSocket, bytes: &[u8], addr: SocketAddr) -> std::io::Result<usize> {
    match socket.send_to(bytes, addr) {
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => socket.send_to(bytes, addr),
        r => r,
    }
}

/// Owns the outgoing sockets and the host cache; runs on its own thread and sends in queue order.
/// Order is kept per host always, and across hosts except while a host waits for its first address
/// (then the others go ahead rather than stall behind a slow lookup).
struct OscSender {
    app: AppHandle,
    tx: mpsc::Sender<SendCmd>,
    listener: Arc<Mutex<Option<UdpSocket>>>,
    failed: FailedHosts,
    v4: Option<UdpSocket>,
    v6: Option<UdpSocket>,
    hosts: HashMap<String, HostEntry>,
}

impl OscSender {
    fn run(mut self, rx: mpsc::Receiver<SendCmd>) {
        loop {
            let waiting = self.hosts.values().any(|h| !h.waiting.is_empty());
            let cmd = if waiting {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(c) => Some(c),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            } else {
                match rx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => return,
                }
            };
            match cmd {
                Some(SendCmd::Send(job)) => self.send(job),
                Some(SendCmd::Resolved(host, result)) => self.resolved(host, result),
                None => {}
            }
            self.expire_waiting();
        }
    }

    fn send(&mut self, job: OscJob) {
        if let Some(ip) = literal_ip(&job.host) {
            self.deliver(&job, ip);
            return;
        }
        let entry = self.hosts.entry(job.host.clone()).or_default();
        if !entry.waiting.is_empty() {
            entry.waiting.push_back(job);
            return;
        }
        let Some(ip) = entry.ip else {
            let host = job.host.clone();
            entry.waiting.push_back(job);
            self.start_resolve(host);
            return;
        };
        let stale = entry.resolved_at.map_or(true, |t| t.elapsed() > RESOLVE_TTL);
        let ok = self.deliver(&job, ip);
        if stale || !ok {
            self.start_resolve(job.host);
        }
    }

    fn start_resolve(&mut self, host: String) {
        let entry = self.hosts.entry(host.clone()).or_default();
        if entry.resolving {
            return;
        }
        entry.resolving = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let result = resolve(&host);
            let _ = tx.send(SendCmd::Resolved(host, result));
        });
    }

    fn resolved(&mut self, host: String, result: Result<IpAddr, String>) {
        let entry = self.hosts.entry(host.clone()).or_default();
        entry.resolving = false;
        entry.resolved_at = Some(Instant::now());
        let error = match result {
            Ok(ip) => {
                entry.ip = Some(ip);
                self.failed.lock().unwrap().remove(&host);
                None
            }
            Err(e) => {
                // A known (older) address keeps being used: a name that stops answering for a moment
                // should not cut the link. Only a host with no address at all counts as failed.
                if entry.ip.is_none() {
                    self.failed.lock().unwrap().insert(host.clone(), (e.clone(), Instant::now()));
                }
                Some(e)
            }
        };
        let ip = entry.ip;
        let jobs = std::mem::take(&mut entry.waiting);
        for job in jobs {
            match (ip, &error) {
                (Some(ip), _) => {
                    self.deliver(&job, ip);
                }
                (None, Some(e)) => self.report(&job, e.clone()),
                (None, None) => {}
            }
        }
    }

    fn expire_waiting(&mut self) {
        let mut expired = Vec::new();
        for entry in self.hosts.values_mut() {
            while entry.waiting.front().is_some_and(|j| j.queued.elapsed() > RESOLVE_WAIT) {
                expired.extend(entry.waiting.pop_front());
            }
        }
        for job in expired {
            let error = format!("{} did not resolve within {} ms; message not sent", job.host, RESOLVE_WAIT.as_millis());
            self.report(&job, error);
        }
    }

    fn plain(&mut self, v6: bool) -> std::io::Result<&UdpSocket> {
        let slot = if v6 { &mut self.v6 } else { &mut self.v4 };
        if slot.is_none() {
            *slot = Some(UdpSocket::bind(if v6 { "[::]:0" } else { "0.0.0.0:0" })?);
        }
        Ok(slot.as_ref().unwrap())
    }

    /// Send one message now; a failure goes to the page as `sls://osc-error`. Returns whether it went out.
    fn deliver(&mut self, job: &OscJob, ip: IpAddr) -> bool {
        let addr = SocketAddr::new(ip, job.port);
        // The listener is bound to 0.0.0.0, so it can only reach IPv4 addresses.
        let from_listener = if job.from_listener && ip.is_ipv4() {
            self.listener.lock().unwrap().as_ref().map(|socket| send_retry(socket, &job.bytes, addr))
        } else {
            None
        };
        let result = match from_listener {
            Some(r) => r,
            None => self.plain(ip.is_ipv6()).and_then(|s| send_retry(s, &job.bytes, addr)),
        };
        match result {
            Ok(_) => true,
            Err(e) => {
                self.report(job, e.to_string());
                false
            }
        }
    }

    fn report(&self, job: &OscJob, error: String) {
        let _ = self.app.emit(
            "sls://osc-error",
            OscSendError { host: job.host.clone(), port: job.port, address: job.address.clone(), error },
        );
    }
}

fn start_sender(app: AppHandle, listener: Arc<Mutex<Option<UdpSocket>>>, failed: FailedHosts) -> mpsc::Sender<SendCmd> {
    let (tx, rx) = mpsc::channel();
    let sender = OscSender { app, tx: tx.clone(), listener, failed, v4: None, v6: None, hosts: HashMap::new() };
    std::thread::Builder::new()
        .name("osc-send".into())
        .spawn(move || sender.run(rx))
        .expect("spawn OSC sender thread");
    tx
}

/// Send one OSC message. With `from_listener` (and OSC listening on), it leaves from the listen
/// port, so a device that answers the sender (the Sound app's /sound/ping) answers to the app.
///
/// Returns at once: the message is queued for the sender thread, which sends in order. Errors known
/// now (encoding, a host whose name failed to resolve in the last few seconds) come back here; a
/// failure found later (the send itself, a slow or failed lookup) arrives as `sls://osc-error`.
#[tauri::command]
pub fn osc_send(app: AppHandle, state: State<IoState>, host: String, port: u16, address: String, args: Vec<OscArg>, from_listener: Option<bool>) -> Result<(), String> {
    let msg = OscPacket::Message(OscMessage { addr: address.clone(), args: args.iter().map(to_osc_type).collect() });
    let bytes = rosc::encoder::encode(&msg).map_err(|e| e.to_string())?;
    let host = host.trim().to_string();
    if let Some((error, at)) = state.osc_failed.lock().unwrap().get(&host) {
        if at.elapsed() < RESOLVE_FAIL_HOLD {
            return Err(error.clone());
        }
    }
    let job = OscJob { host, port, address, bytes, from_listener: from_listener.unwrap_or(false), queued: Instant::now() };
    let mut tx = state.osc_tx.lock().unwrap();
    let tx = tx.get_or_insert_with(|| start_sender(app, state.osc_socket.clone(), state.osc_failed.clone()));
    tx.send(SendCmd::Send(job)).map_err(|_| "OSC sender stopped".to_string())
}
