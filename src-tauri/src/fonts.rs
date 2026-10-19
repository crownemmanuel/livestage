//! Font families installed on this computer, for the font pickers. Reads the name table of
//! every font file in the system and user font folders (macOS and Windows).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Library/Fonts"));
        }
    } else if cfg!(target_os = "windows") {
        let windir = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        dirs.push(windir.join("Fonts"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Microsoft\\Windows\\Fonts"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/share/fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/share/fonts"));
        }
    }
    dirs
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < 4 {
                walk(&p, depth + 1, out);
            }
        } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            if matches!(ext.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc" | "otc") {
                out.push(p);
            }
        }
    }
}

/// Typographic family (name id 16) if present, else the legacy family (id 1).
fn family(face: &ttf_parser::Face) -> Option<String> {
    let mut legacy = None;
    for n in face.names() {
        if !n.is_unicode() {
            continue;
        }
        match n.name_id {
            ttf_parser::name_id::TYPOGRAPHIC_FAMILY => return n.to_string(),
            ttf_parser::name_id::FAMILY if legacy.is_none() => legacy = n.to_string(),
            _ => {}
        }
    }
    legacy
}

#[tauri::command]
pub fn system_fonts() -> Vec<String> {
    let mut files = Vec::new();
    for d in font_dirs() {
        walk(&d, 0, &mut files);
    }
    let mut names = BTreeSet::new();
    for f in files {
        let Ok(data) = std::fs::read(&f) else { continue };
        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        for i in 0..count {
            if let Ok(face) = ttf_parser::Face::parse(&data, i) {
                if let Some(name) = family(&face) {
                    // Hidden system faces start with a dot (".SF NS"); they cannot be named in CSS.
                    if !name.starts_with('.') && !name.trim().is_empty() {
                        names.insert(name.trim().to_string());
                    }
                }
            }
        }
    }
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_installed_fonts() {
        let f = super::system_fonts();
        println!("{} families, e.g. {:?}", f.len(), f.iter().take(8).collect::<Vec<_>>());
        assert!(!f.is_empty());
    }
}
