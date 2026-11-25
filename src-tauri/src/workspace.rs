//! The workspace: one folder per computer that holds the shows' media finals as
//! `<root>/<show slug>/<scene folder>/images|audio|video|other/<file>`. The root is a per-computer
//! setting (`workspace.json` in the app data folder), never stored in the show file, because it
//! differs from computer to computer. Phase 1 only resolves and serves files from here; nothing is
//! moved into it (see docs/SHOW_PACKAGE.md).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

const FILE: &str = "workspace.json";

#[derive(Serialize, Deserialize, Default)]
struct Config {
    root: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    root: String,
    default_root: String,
    is_default: bool,
    exists: bool,
}

/// `~/Documents/LiveStage` (`Documents\LiveStage` on Windows).
fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().document_dir().map_err(|e| e.to_string())?.join("LiveStage"))
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(FILE))
}

/// The workspace root in force on this computer (the setting, else the default). Not created here.
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cfg: Config = config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    match cfg.root.filter(|r| !r.trim().is_empty()) {
        Some(r) => Ok(PathBuf::from(r)),
        None => default_root(app),
    }
}

/// Let the asset protocol serve files under the workspace root (the static scope covers only the app data folder).
pub fn allow_in_asset_scope(app: &tauri::AppHandle) {
    if let Ok(r) = root(app) {
        // The scope matches real paths, so allow the folder even before it exists by creating it empty.
        let _ = fs::create_dir_all(&r);
        let _ = app.asset_protocol_scope().allow_directory(&r, true);
    }
}

fn info(app: &tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let r = root(app)?;
    let d = default_root(app)?;
    Ok(WorkspaceInfo { root: r.display().to_string(), is_default: r == d, default_root: d.display().to_string(), exists: r.is_dir() })
}

#[tauri::command]
pub fn workspace_dir(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    info(&app)
}

/// Set the workspace root (an absolute path; `None` or empty = back to the default). The folder is
/// created when missing. Moves nothing: files already in another workspace stay where they are.
#[tauri::command]
pub fn workspace_set(app: tauri::AppHandle, path: Option<String>) -> Result<WorkspaceInfo, String> {
    let chosen = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &chosen {
        let pb = Path::new(p);
        if !pb.is_absolute() {
            return Err("The workspace folder must be an absolute path.".into());
        }
        fs::create_dir_all(pb).map_err(|e| format!("Cannot use that folder: {e}"))?;
    }
    let cfg = config_path(&app)?;
    if let Some(dir) = cfg.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = cfg.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&Config { root: chosen }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &cfg).map_err(|e| e.to_string())?;
    allow_in_asset_scope(&app);
    info(&app)
}

/// The folder name for a show: its name, safe on Mac and Windows.
pub fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Untitled show".into() } else { s }
}

/// A relative path made only of normal components (no `..`, no drive, no leading slash).
fn safe_rel(rel: &str) -> Option<PathBuf> {
    let p = PathBuf::from(rel.replace('\\', "/"));
    if p.as_os_str().is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(p)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowMarker {
    show_id: String,
    name: String,
}

/// Find or name the folder for a show. A folder whose `.show.json` carries this `showId` wins (so a
/// renamed show keeps its folder); else `<root>/<slug>/` is used and marked. Creates nothing but the
/// marker when the folder is new or unmarked. Returns the folder's path.
#[tauri::command]
pub fn workspace_show_dir(app: tauri::AppHandle, show_id: String, name: String) -> Result<String, String> {
    let r = root(&app)?;
    fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    // A folder already marked with this show's id.
    if let Ok(rd) = fs::read_dir(&r) {
        for e in rd.flatten() {
            let m = e.path().join(".show.json");
            if let Some(mk) = fs::read_to_string(&m).ok().and_then(|t| serde_json::from_str::<ShowMarker>(&t).ok()) {
                if mk.show_id == show_id {
                    return Ok(e.path().display().to_string());
                }
            }
        }
    }
    let base = slug(&name);
    let mut dir = r.join(&base);
    let mut n = 2;
    // Another show's folder (marked with a different id) is never reused.
    while dir.join(".show.json").is_file() {
        dir = r.join(format!("{base} {n}"));
        n += 1;
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mk = ShowMarker { show_id, name };
    fs::write(dir.join(".show.json"), serde_json::to_string_pretty(&mk).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// Resolve an asset's `rel` against a show folder; `Some` only when the file is there and stays inside it.
#[tauri::command]
pub fn workspace_resolve(show_dir: String, rels: Vec<String>) -> Vec<Option<String>> {
    let base = PathBuf::from(show_dir);
    rels.iter()
        .map(|r| safe_rel(r).map(|p| base.join(p)).filter(|p| p.is_file()).map(|p| p.display().to_string()))
        .collect()
}
