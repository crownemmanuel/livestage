//! Cloud sync transport: plain HTTPS to Firebase Auth and Storage (REST), done here rather than in the
//! webview so there is no CORS to negotiate and media streams between disk and network without being
//! held in memory. What to send and when is decided by the app (src/core/cloud.ts).

use crate::package::{copy_hashed, find_source, hash_path, hash_source, safe_key, ExportFile, FileEntry, HashCache, Source};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Deserialize)]
pub struct HttpReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<String>,
}

#[derive(Serialize)]
pub struct HttpRes {
    status: u16,
    body: String,
}

/// A file transfer that moves no bytes for this long has stalled (a dead connection, a peer that
/// stopped reading or sending). Generous: a slow but living link moves something every second.
const STALL: Duration = Duration::from_secs(120);

/// Last-resort cap on sending or receiving one body, so a transfer thread left blocked on a dead
/// socket after a stall ends some day. Far longer than any show file takes on a working link.
const BODY_BACKSTOP: Duration = Duration::from_secs(12 * 3600);

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(300)))
        .timeout_send_body(Some(BODY_BACKSTOP))
        .timeout_recv_body(Some(BODY_BACKSTOP))
        .build()
        .into()
}

/// Watches a body transfer: when the bytes have been moving, and whether it was given up.
/// (ureq's own timeouts are budgets for a whole phase, with no idle limit, so they cannot tell a
/// slow multi-gigabyte transfer from a dead one.)
#[derive(Clone)]
struct Watch {
    start: Instant,
    /// The body is being read (between the first read and the end of the data).
    active: Arc<AtomicBool>,
    /// Milliseconds since `start` of the last read that moved data (or of the first read).
    last_ms: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
}

impl Watch {
    fn new() -> Self {
        Watch { start: Instant::now(), active: Arc::default(), last_ms: Arc::default(), cancelled: Arc::default() }
    }
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
    fn stalled(&self) -> bool {
        self.active.load(Ordering::SeqCst) && self.now_ms().saturating_sub(self.last_ms.load(Ordering::SeqCst)) > STALL.as_millis() as u64
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// A reader that reports its progress to a `Watch` and fails once the transfer was given up.
struct Watched<R> {
    inner: R,
    w: Watch,
}

impl<R: Read> Read for Watched<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let stopped = || io::Error::other("transfer stalled and was stopped");
        if self.w.cancelled() {
            return Err(stopped());
        }
        if !self.w.active.swap(true, Ordering::SeqCst) {
            self.w.last_ms.store(self.w.now_ms(), Ordering::SeqCst);
        }
        let n = self.inner.read(buf)?;
        if self.w.cancelled() {
            return Err(stopped());
        }
        if n == 0 {
            // The body is all there; what follows (the server's answer) has ureq's own timeout.
            self.w.active.store(false, Ordering::SeqCst);
        } else {
            self.w.last_ms.store(self.w.now_ms(), Ordering::SeqCst);
        }
        Ok(n)
    }
}

/// Run a transfer on its own thread and give up on it when its body stops moving for `STALL`.
/// A transfer given up on fails at its next read; one blocked on a dead socket is left to end on
/// its own (BODY_BACKSTOP) and can no longer touch anything.
fn guarded<T: Send + 'static>(what: &str, watch: Watch, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(r) => return r,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(format!("{what} failed (transfer thread ended)")),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if watch.stalled() {
                    watch.cancelled.store(true, Ordering::SeqCst);
                    return Err(format!("{what} stalled: no data moved for {} s", STALL.as_secs()));
                }
            }
        }
    }
}

/// Unique name per download attempt, so a stalled attempt left behind never writes into a retry's file.
static ATTEMPT: AtomicU64 = AtomicU64::new(0);

/// Remove a staged download and the `.part` file `copy_hashed` writes on the way to it.
fn remove_staged(staged: &Path) {
    let _ = fs::remove_file(staged);
    let part = staged.with_file_name(format!(".{}.part", staged.file_name().unwrap_or_default().to_string_lossy()));
    let _ = fs::remove_file(part);
}

fn finish(res: Result<http::Response<ureq::Body>, ureq::Error>) -> Result<HttpRes, String> {
    let mut res = res.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.body_mut().with_config().limit(64 * 1024 * 1024).lossy_utf8(true).read_to_string().map_err(|e| e.to_string())?;
    Ok(HttpRes { status, body })
}

macro_rules! with_headers {
    ($b:expr, $h:expr) => {{
        let mut b = $b;
        for (k, v) in $h {
            b = b.header(k.as_str(), v.as_str());
        }
        b
    }};
}

/// A small request (auth, JSON documents, listings). The body, if any, is sent as given.
#[tauri::command]
pub async fn cloud_http(req: HttpReq) -> Result<HttpRes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let a = agent();
        let res = match req.method.as_str() {
            "GET" => with_headers!(a.get(&req.url), &req.headers).call(),
            "DELETE" => with_headers!(a.delete(&req.url), &req.headers).call(),
            "POST" => with_headers!(a.post(&req.url), &req.headers).send(req.body.unwrap_or_default()),
            "PUT" => with_headers!(a.put(&req.url), &req.headers).send(req.body.unwrap_or_default()),
            m => return Err(format!("unsupported method {m}")),
        };
        finish(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Size and SHA-256 of files to send (library files or bundled media), cached between pushes.
#[tauri::command]
pub async fn cloud_hash_sources(app: tauri::AppHandle, files: Vec<ExportFile>) -> Result<Vec<Option<FileEntry>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<HashCache>();
        Ok(files
            .into_iter()
            .map(|f| {
                let src = find_source(&app, &f)?;
                hash_source(&cache, &src).ok().map(|(size, sha256)| FileEntry { key: f.key.clone(), size, sha256 })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upload one file as the request body (streamed from disk).
#[tauri::command]
pub async fn cloud_upload(app: tauri::AppHandle, url: String, headers: Vec<(String, String)>, file: ExportFile) -> Result<HttpRes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = find_source(&app, &file).ok_or_else(|| format!("{}: file not found", file.key))?;
        let watch = Watch::new();
        let w = watch.clone();
        guarded(&format!("Upload of {}", file.key), watch, move || {
            let a = agent();
            let mut req = with_headers!(a.post(&url), &headers);
            // The body goes through a progress-watching reader, which hides its size from ureq:
            // state it, so the request stays length-delimited as before (not chunked).
            let has_len = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
            let res = match src {
                Source::File(p) => {
                    let f = File::open(&p).map_err(|e| e.to_string())?;
                    if !has_len {
                        req = req.header("Content-Length", f.metadata().map_err(|e| e.to_string())?.len().to_string());
                    }
                    req.send(ureq::SendBody::from_owned_reader(Watched { inner: f, w }))
                }
                Source::Bytes(b) => {
                    if !has_len {
                        req = req.header("Content-Length", b.len().to_string());
                    }
                    req.send(ureq::SendBody::from_owned_reader(Watched { inner: io::Cursor::new(b), w }))
                }
            };
            finish(res)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download one file into the app data folder at `key`, verifying its SHA-256. A file already there with
/// that hash is left alone; a download that does not match never replaces anything.
#[tauri::command]
pub async fn cloud_download(app: tauri::AppHandle, url: String, headers: Vec<(String, String)>, key: String, sha256: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dest: PathBuf = root.join(safe_key(&key)?);
        let cache = app.state::<HashCache>();
        if dest.is_file() && hash_path(&cache, &dest).map(|(_, h)| h == sha256).unwrap_or(false) {
            return Ok("skipped".into());
        }
        let watch = Watch::new();
        let w = watch.clone();
        guarded(&format!("Download of {key}"), watch, move || {
            let a = agent();
            let mut res = with_headers!(a.get(&url), &headers).call().map_err(|e| e.to_string())?;
            if res.status().as_u16() != 200 {
                let body = res.body_mut().read_to_string().unwrap_or_default();
                return Err(format!("HTTP {}: {}", res.status().as_u16(), body.chars().take(300).collect::<String>()));
            }
            let n = ATTEMPT.fetch_add(1, Ordering::Relaxed);
            let staged = dest.with_file_name(format!(".{}.{}-{n}.incoming", dest.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
            let mut reader = Watched { inner: res.body_mut().with_config().limit(u64::MAX).reader(), w: w.clone() };
            let h = match copy_hashed(&mut reader, &staged) {
                Ok((_, h)) => h,
                Err(e) => {
                    remove_staged(&staged);
                    return Err(e);
                }
            };
            if w.cancelled() {
                remove_staged(&staged);
                return Err("transfer stalled and was stopped".into());
            }
            if h != sha256 {
                remove_staged(&staged);
                return Err("hash mismatch (damaged download)".into());
            }
            fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
            Ok("copied".into())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
