//! Show packages: a folder holding the show file, a manifest and every media file the show uses,
//! so another computer can open the identical show. Files are copied in streams (multi-GB video is
//! never held in memory) and hashed with SHA-256 on the way, so an import can verify each one and
//! skip what it already has.
//!
//! Layout:  <name>.slshow/show.json · manifest.json · files/<key>
//! A key is a relative path ("media/prologue/p1.mp4", "assets/asset_x_take.mp4"); on the machine
//! that imports it, the file lands at <app data>/<key>.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{Emitter, Manager};

/// Hashes already computed this session, by path, size and modification time.
#[derive(Default)]
pub struct HashCache(Mutex<HashMap<PathBuf, (u64, SystemTime, String)>>);

#[derive(Deserialize)]
pub struct ExportFile {
    key: String,
    /// A file on disk (app library, or a local copy of packaged media).
    path: Option<String>,
    /// Media that ships with the app, by URL ("/media/prologue/p1.mp4").
    bundled: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    key: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: &'static str,
    done: usize,
    total: usize,
    key: String,
}

#[derive(Serialize)]
pub struct ExportResult {
    dir: String,
    files: Vec<FileEntry>,
    missing: Vec<String>,
}

#[derive(Serialize)]
pub struct PackageContents {
    show: String,
    manifest: String,
}

#[derive(Deserialize)]
pub struct ImportFile {
    key: String,
    sha256: String,
}

#[derive(Serialize, Default)]
pub struct ImportResult {
    copied: Vec<String>,
    skipped: Vec<String>,
    failed: Vec<(String, String)>,
}

/// A key may only name a file below the package / app data folder.
fn safe_key(key: &str) -> Result<PathBuf, String> {
    let p = Path::new(key);
    if key.is_empty() || key.contains('\\') || p.is_absolute() {
        return Err(format!("bad file key {key:?}"));
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => return Err(format!("bad file key {key:?}")),
        }
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Copy `src` to `dest` (through a temp file), returning size and SHA-256.
fn copy_hashed(src: &mut dyn Read, dest: &Path) -> Result<(u64, String), String> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_file_name(format!(".{}.part", dest.file_name().unwrap_or_default().to_string_lossy()));
    let mut out = File::create(&tmp).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = src.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        size += n as u64;
    }
    out.sync_all().map_err(|e| e.to_string())?;
    drop(out);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok((size, hex(&h.finalize())))
}

/// SHA-256 of a file on disk, cached by size and modification time.
pub fn hash_path(cache: &HashCache, path: &Path) -> Result<(u64, String), String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if let Some((size, t, h)) = cache.0.lock().unwrap().get(path) {
        if *size == meta.len() && *t == mtime {
            return Ok((*size, h.clone()));
        }
    }
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let hash = hex(&h.finalize());
    cache.0.lock().unwrap().insert(path.to_path_buf(), (meta.len(), mtime, hash.clone()));
    Ok((meta.len(), hash))
}

/// Where media that ships with the app lives on disk, in a development build (the repo's public/ folder).
fn dev_public_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("public");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Write a package folder. The show and manifest come from the app; this adds the file list.
#[tauri::command]
pub async fn package_export(app: tauri::AppHandle, dir: String, show: String, manifest: String, files: Vec<ExportFile>) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_blocking(&app, dir, show, manifest, files)).await.map_err(|e| e.to_string())?
}

fn export_blocking(app: &tauri::AppHandle, dir: String, show: String, manifest: String, files: Vec<ExportFile>) -> Result<ExportResult, String> {
    let dest = PathBuf::from(&dir);
    let name = dest.file_name().ok_or("no folder name")?.to_string_lossy().to_string();
    let partial = dest.with_file_name(format!("{name}.partial"));
    if partial.exists() {
        fs::remove_dir_all(&partial).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(partial.join("files")).map_err(|e| e.to_string())?;
    let public = dev_public_dir();
    let mut out: Vec<FileEntry> = Vec::new();
    let mut missing = Vec::new();
    let total = files.len();
    for (i, f) in files.into_iter().enumerate() {
        let _ = app.emit("package-progress", Progress { phase: "export", done: i, total, key: f.key.clone() });
        let rel = safe_key(&f.key)?;
        if out.iter().any(|e| e.key == f.key) {
            continue;
        }
        let target = partial.join("files").join(&rel);
        let res = if let Some(p) = f.path.as_deref().filter(|p| Path::new(p).is_file()) {
            File::open(p).map_err(|e| e.to_string()).and_then(|mut r| copy_hashed(&mut r, &target))
        } else if let Some(url) = f.bundled.as_deref() {
            let rel_url = url.trim_start_matches('/');
            match public.as_ref().map(|d| d.join(rel_url)).filter(|p| p.is_file()) {
                Some(p) => File::open(&p).map_err(|e| e.to_string()).and_then(|mut r| copy_hashed(&mut r, &target)),
                None => match app.asset_resolver().get(rel_url.to_string()) {
                    Some(asset) => copy_hashed(&mut asset.bytes.as_slice(), &target),
                    None => Err("not found".into()),
                },
            }
        } else {
            Err("not found".into())
        };
        match res {
            Ok((size, sha256)) => out.push(FileEntry { key: f.key, size, sha256 }),
            Err(_) => missing.push(f.key),
        }
    }
    let _ = app.emit("package-progress", Progress { phase: "export", done: total, total, key: String::new() });
    let mut m: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| e.to_string())?;
    m["files"] = serde_json::to_value(&out).map_err(|e| e.to_string())?;
    m["missing"] = serde_json::to_value(&missing).map_err(|e| e.to_string())?;
    fs::write(partial.join("show.json"), show).map_err(|e| e.to_string())?;
    fs::write(partial.join("manifest.json"), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Swap the finished folder in; an older package of the same name is replaced only now.
    if dest.exists() {
        let old = dest.with_file_name(format!("{name}.old"));
        let _ = fs::remove_dir_all(&old);
        fs::rename(&dest, &old).map_err(|e| e.to_string())?;
        fs::rename(&partial, &dest).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&old);
    } else {
        fs::rename(&partial, &dest).map_err(|e| e.to_string())?;
    }
    Ok(ExportResult { dir, files: out, missing })
}

/// Read a package's show file and manifest (no media is touched).
#[tauri::command]
pub fn package_read(dir: String) -> Result<PackageContents, String> {
    let d = PathBuf::from(&dir);
    let show = fs::read_to_string(d.join("show.json")).map_err(|e| format!("Not a show package (show.json): {e}"))?;
    let manifest = fs::read_to_string(d.join("manifest.json")).map_err(|e| format!("Not a show package (manifest.json): {e}"))?;
    Ok(PackageContents { show, manifest })
}

/// Copy media from a package into the app data folder, verifying each file's hash.
/// A file already there with the same hash is left alone.
#[tauri::command]
pub async fn package_import_files(app: tauri::AppHandle, dir: String, files: Vec<ImportFile>) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let cache = app.state::<HashCache>();
        let src_root = PathBuf::from(&dir).join("files");
        let mut res = ImportResult::default();
        let total = files.len();
        for (i, f) in files.into_iter().enumerate() {
            let _ = app.emit("package-progress", Progress { phase: "import", done: i, total, key: f.key.clone() });
            let rel = match safe_key(&f.key) {
                Ok(r) => r,
                Err(e) => {
                    res.failed.push((f.key, e));
                    continue;
                }
            };
            let dest = root.join(&rel);
            if dest.is_file() && hash_path(&cache, &dest).map(|(_, h)| h == f.sha256).unwrap_or(false) {
                res.skipped.push(f.key);
                continue;
            }
            let src = src_root.join(&rel);
            // Copy beside the destination first, so a bad file never replaces a good one.
            let staged = dest.with_file_name(format!(".{}.incoming", dest.file_name().unwrap_or_default().to_string_lossy()));
            let outcome = File::open(&src).map_err(|e| e.to_string()).and_then(|mut r| copy_hashed(&mut r, &staged)).and_then(|(_, h)| {
                if h != f.sha256 {
                    let _ = fs::remove_file(&staged);
                    return Err("hash mismatch (damaged copy)".to_string());
                }
                fs::rename(&staged, &dest).map_err(|e| e.to_string())
            });
            match outcome {
                Ok(()) => res.copied.push(f.key),
                Err(e) => res.failed.push((f.key, e)),
            }
        }
        let _ = app.emit("package-progress", Progress { phase: "import", done: total, total, key: String::new() });
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Size and SHA-256 of files on disk (absolute paths, or keys under the app data folder).
#[tauri::command]
pub async fn hash_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<Option<FileEntry>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let cache = app.state::<HashCache>();
        Ok(paths
            .into_iter()
            .map(|p| {
                let path = if Path::new(&p).is_absolute() { PathBuf::from(&p) } else { root.join(safe_key(&p).ok()?) };
                hash_path(&cache, &path).ok().map(|(size, sha256)| FileEntry { key: p, size, sha256 })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
