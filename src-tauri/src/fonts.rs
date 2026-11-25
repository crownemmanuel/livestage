//! Font families installed on this computer, for the font pickers. Reads the name table of
//! every font file in the system and user font folders (macOS and Windows).
//!
//! Only the table directory and the `name` table of each file are read (a few KB, not the whole
//! file: the system folders hold ~800 MB of fonts), off the main thread, once per run.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

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
fn family(names: ttf_parser::name::Names) -> Option<String> {
    let mut legacy = None;
    for n in names {
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

fn read_at(f: &mut File, at: u64, len: usize) -> Option<Vec<u8>> {
    let mut b = vec![0u8; len];
    f.seek(SeekFrom::Start(at)).ok()?;
    f.read_exact(&mut b).ok()?;
    Some(b)
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// The `name` table of each face in a font file (one for .ttf/.otf, several for a collection),
/// read straight from the file's table directory. None when the file is not laid out as expected.
fn name_tables(path: &Path) -> Option<Vec<Vec<u8>>> {
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let head = read_at(&mut f, 0, 12)?;
    let faces: Vec<u64> = if &head[..4] == b"ttcf" {
        let n = be32(&head, 8)?.min(256) as usize;
        let offs = read_at(&mut f, 12, n * 4)?;
        (0..n).filter_map(|i| be32(&offs, i * 4).map(u64::from)).collect()
    } else {
        vec![0]
    };
    let mut out = Vec::new();
    for off in faces {
        let Some(dir) = read_at(&mut f, off, 12) else { continue };
        let tables = u16::from_be_bytes([dir[4], dir[5]]) as usize;
        let Some(recs) = read_at(&mut f, off + 12, tables * 16) else { continue };
        // Faces without a `head` table (bitmap-only fonts) are skipped, as a full parse would.
        if !recs.chunks_exact(16).any(|r| &r[..4] == b"head") {
            continue;
        }
        for r in recs.chunks_exact(16) {
            if &r[..4] != b"name" {
                continue;
            }
            let (at, len) = (be32(r, 8)? as u64, be32(r, 12)? as u64);
            // A name table is a few KB; anything past the file or absurdly large is a damaged file.
            if len == 0 || len > 4 * 1024 * 1024 || at.checked_add(len)? > size {
                break;
            }
            if let Some(b) = read_at(&mut f, at, len as usize) {
                out.push(b);
            }
            break;
        }
    }
    Some(out)
}

fn insert(names: &mut BTreeSet<String>, name: Option<String>) {
    if let Some(name) = name {
        // Hidden system faces start with a dot (".SF NS"); they cannot be named in CSS.
        if !name.starts_with('.') && !name.trim().is_empty() {
            names.insert(name.trim().to_string());
        }
    }
}

fn scan() -> Vec<String> {
    let mut files = Vec::new();
    for d in font_dirs() {
        walk(&d, 0, &mut files);
    }
    let mut names = BTreeSet::new();
    for f in files {
        match name_tables(&f) {
            Some(tables) if !tables.is_empty() => {
                for t in tables {
                    insert(&mut names, ttf_parser::name::Table::parse(&t).and_then(|t| family(t.names)));
                }
            }
            // Not a plain sfnt directory (or no name table found): parse the whole file as before.
            _ => {
                let Ok(data) = std::fs::read(&f) else { continue };
                let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
                for i in 0..count {
                    if let Ok(face) = ttf_parser::Face::parse(&data, i) {
                        insert(&mut names, family(face.names()));
                    }
                }
            }
        }
    }
    names.into_iter().collect()
}

static FONTS: OnceLock<Vec<String>> = OnceLock::new();

/// Installed font families, sorted. Scanned once per run on a worker thread (never the main thread,
/// which carries every window's IPC); fonts installed while the app runs show after a restart.
#[tauri::command]
pub async fn system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| FONTS.get_or_init(scan).clone()).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_installed_fonts() {
        let f = super::scan();
        println!("{} families, e.g. {:?}", f.len(), f.iter().take(8).collect::<Vec<_>>());
        assert!(!f.is_empty());
    }

    /// Reading only the name tables finds the same families as parsing every whole file.
    #[test]
    fn name_tables_match_whole_files() {
        let mut files = Vec::new();
        for d in super::font_dirs() {
            super::walk(&d, 0, &mut files);
        }
        let mut whole = std::collections::BTreeSet::new();
        for f in files {
            let Ok(data) = std::fs::read(&f) else { continue };
            for i in 0..ttf_parser::fonts_in_collection(&data).unwrap_or(1) {
                if let Ok(face) = ttf_parser::Face::parse(&data, i) {
                    super::insert(&mut whole, super::family(face.names()));
                }
            }
        }
        assert_eq!(super::scan(), whole.into_iter().collect::<Vec<_>>());
    }
}
