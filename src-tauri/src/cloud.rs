//! Cloud sync transport: plain HTTPS to Firebase Auth and Storage (REST), done here rather than in the
//! webview so there is no CORS to negotiate and media streams between disk and network without being
//! held in memory. What to send and when is decided by the app (src/core/cloud.ts).

use crate::package::{copy_hashed, find_source, hash_path, hash_source, safe_key, ExportFile, FileEntry, HashCache, Source};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::path::PathBuf;
use std::time::Duration;
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

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(300)))
        .build()
        .into()
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
        let a = agent();
        let req = with_headers!(a.post(&url), &headers);
        let res = match src {
            Source::File(p) => req.send(File::open(&p).map_err(|e| e.to_string())?),
            Source::Bytes(b) => req.send(b),
        };
        finish(res)
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
        let a = agent();
        let mut res = with_headers!(a.get(&url), &headers).call().map_err(|e| e.to_string())?;
        if res.status().as_u16() != 200 {
            let body = res.body_mut().read_to_string().unwrap_or_default();
            return Err(format!("HTTP {}: {}", res.status().as_u16(), body.chars().take(300).collect::<String>()));
        }
        let staged = dest.with_file_name(format!(".{}.incoming", dest.file_name().unwrap_or_default().to_string_lossy()));
        let mut reader = res.body_mut().with_config().limit(u64::MAX).reader();
        let (_, h) = copy_hashed(&mut reader, &staged)?;
        if h != sha256 {
            let _ = fs::remove_file(&staged);
            return Err("hash mismatch (damaged download)".into());
        }
        fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
        Ok("copied".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
