//! Media files the wall can play.
//!
//! `media_probe` reads what a video file is (container, codec, profile/level, size, frame rate,
//! keyframe spacing, audio, fast-start) with a small ISO BMFF / QuickTime box walker: no external
//! tool, a few kilobytes read, so every import is checked. The app decides from it whether the
//! webview will play the file well (see `src/core/mediaCheck.ts`).
//!
//! `media_optimise` re-encodes a file into the wall's playback format with ffmpeg: bundled next to
//! the app when the build ships one, otherwise the one installed on the machine. Progress is
//! emitted as `media-progress` events so the operator sees it. With `pack_alpha` it turns a video
//! that has an alpha channel into an alpha-packed one: ordinary opaque H.264 at twice the height,
//! the colour (premultiplied) in the top half and the matte in the bottom half, which the media
//! shader puts back together (`Asset.alphaPacked`, docs/ARCHITECTURE.md "Media formats").

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

#[derive(Serialize, Default, Clone, Debug)]
pub struct VideoInfo {
    /// Normalised codec name: h264, hevc, av1, vp9, vp8, prores, mjpeg, mpeg4, or other:<fourcc>.
    pub codec: String,
    pub fourcc: String,
    /// H.264 / HEVC profile_idc.
    pub profile: Option<u8>,
    /// H.264 level_idc (e.g. 51 = 5.1) / HEVC general_level_idc (e.g. 153 = 5.1).
    pub level: Option<u8>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frames: u64,
    /// Largest gap between two keyframes, in seconds (0 when every frame is a keyframe).
    pub keyframe_gap_s: Option<f64>,
    pub keyframes: u64,
    /// The file declares an alpha channel (HEVC with alpha, ProRes 4444, WebM AlphaMode).
    pub alpha: bool,
    /// Largest compressed frame, in bytes. The asset protocol serves at most 1000 KiB per range request
    /// (tauri::protocol::asset MAX_LEN), and the Mac's player does not put a bigger frame back together:
    /// the bottom of that picture plays green.
    pub max_frame_bytes: u64,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct AudioInfo {
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct MediaProbe {
    /// mp4, mov, webm, or unknown.
    pub container: String,
    pub size: u64,
    pub duration_s: f64,
    pub bitrate_kbps: u64,
    /// The index (moov) comes before the media data: playback can start before the whole file is read.
    pub fast_start: bool,
    /// Fragmented MP4 (moof): sample tables are not in the moov.
    pub fragmented: bool,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
    /// Why the probe could not read the file fully (the rest of the fields are best effort).
    pub note: Option<String>,
}

// ---------------------------------------------------------------- box reading

fn be32(b: &[u8], at: usize) -> u32 {
    if at + 4 > b.len() {
        return 0;
    }
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn be16(b: &[u8], at: usize) -> u16 {
    if at + 2 > b.len() {
        return 0;
    }
    u16::from_be_bytes([b[at], b[at + 1]])
}

fn be64(b: &[u8], at: usize) -> u64 {
    if at + 8 > b.len() {
        return 0;
    }
    u64::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3], b[at + 4], b[at + 5], b[at + 6], b[at + 7]])
}

fn fourcc(b: &[u8], at: usize) -> String {
    if at + 4 > b.len() {
        return String::new();
    }
    b[at..at + 4].iter().map(|&c| if c.is_ascii_graphic() || c == b' ' { c as char } else { '?' }).collect()
}

/// Child boxes of an in-memory box body: (type, body slice).
fn children(body: &[u8]) -> Vec<(String, &[u8])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= body.len() {
        let mut size = be32(body, at) as u64;
        let typ = fourcc(body, at + 4);
        let mut head = 8usize;
        if size == 1 {
            size = be64(body, at + 8);
            head = 16;
        } else if size == 0 {
            size = (body.len() - at) as u64;
        }
        if size < head as u64 || at + head > body.len() {
            break;
        }
        let end = (at as u64).saturating_add(size).min(body.len() as u64) as usize;
        out.push((typ, &body[at + head..end]));
        at = end;
    }
    out
}

fn find<'a>(body: &'a [u8], typ: &str) -> Option<&'a [u8]> {
    children(body).into_iter().find(|(t, _)| t == typ).map(|(_, b)| b)
}

/// Full-box body: version, flags, and the payload after them.
fn full(body: &[u8]) -> (u8, &[u8]) {
    if body.len() < 4 {
        return (0, &[]);
    }
    (body[0], &body[4..])
}

fn codec_name(fourcc: &str) -> String {
    match fourcc {
        "avc1" | "avc2" | "avc3" | "avc4" => "h264",
        "hvc1" | "hev1" | "dvh1" | "dvhe" => "hevc",
        "av01" => "av1",
        "vp09" => "vp9",
        "vp08" => "vp8",
        "apch" | "apcn" | "apcs" | "apco" | "ap4h" | "ap4x" => "prores",
        "mjpa" | "mjpb" | "jpeg" | "dmb1" => "mjpeg",
        "mp4v" => "mpeg4",
        other => return format!("other:{other}"),
    }
    .to_string()
}

fn audio_name(fourcc: &str) -> String {
    match fourcc {
        "mp4a" => "aac",
        ".mp3" | "mp3 " => "mp3",
        "ac-3" => "ac3",
        "ec-3" => "eac3",
        "Opus" => "opus",
        "fLaC" => "flac",
        "alac" => "alac",
        "lpcm" | "sowt" | "twos" | "in24" | "in32" | "fl32" | "fl64" => "pcm",
        other => return format!("other:{other}"),
    }
    .to_string()
}

struct TrackTables {
    handler: String,
    timescale: u32,
    duration: u64,
    entry: Option<(String, Vec<u8>)>,
    samples: u64,
    /// Sum of sample deltas (media timescale units).
    sample_time: u64,
    sync: Option<Vec<u32>>,
    /// Largest sample (stsz), in bytes.
    max_sample: u32,
}

fn parse_trak(trak: &[u8]) -> Option<TrackTables> {
    let mdia = find(trak, "mdia")?;
    let (v, mdhd) = full(find(mdia, "mdhd")?);
    let (timescale, duration) = if v == 1 { (be32(mdhd, 16), be64(mdhd, 20)) } else { (be32(mdhd, 8), be32(mdhd, 12) as u64) };
    let (_, hdlr) = full(find(mdia, "hdlr")?);
    let handler = fourcc(hdlr, 4);
    let stbl = find(find(mdia, "minf")?, "stbl")?;
    let mut t = TrackTables { handler, timescale, duration, entry: None, samples: 0, sample_time: 0, sync: None, max_sample: 0 };
    if let Some(stsd) = find(stbl, "stsd") {
        let (_, body) = full(stsd);
        if let Some((typ, b)) = children(&body[4.min(body.len())..]).into_iter().next() {
            t.entry = Some((typ, b.to_vec()));
        }
    }
    if let Some(stts) = find(stbl, "stts") {
        let (_, b) = full(stts);
        // Entry counts come from the file: never trust one past what the box can hold.
        let n = (be32(b, 0) as usize).min(b.len().saturating_sub(4) / 8);
        for i in 0..n {
            let count = be32(b, 4 + i * 8) as u64;
            let delta = be32(b, 8 + i * 8) as u64;
            t.samples = t.samples.saturating_add(count);
            t.sample_time = t.sample_time.saturating_add(count * delta);
        }
    }
    if let Some(stss) = find(stbl, "stss") {
        let (_, b) = full(stss);
        let n = (be32(b, 0) as usize).min(b.len().saturating_sub(4) / 4);
        t.sync = Some((0..n).map(|i| be32(b, 4 + i * 4)).collect());
    }
    if let Some(stsz) = find(stbl, "stsz") {
        let (_, b) = full(stsz);
        let (fixed, n) = (be32(b, 0), (be32(b, 4) as usize).min(b.len().saturating_sub(8) / 4));
        t.max_sample = if fixed != 0 { fixed } else { (0..n).map(|i| be32(b, 8 + i * 4)).max().unwrap_or(0) };
    }
    Some(t)
}

/// Video sample entry (ISO 14496-12 § 12.1.3): fixed fields, then child boxes (avcC, hvcC, …).
fn video_info(typ: &str, entry: &[u8]) -> VideoInfo {
    let mut info = VideoInfo { codec: codec_name(typ), fourcc: typ.to_string(), ..Default::default() };
    if entry.len() >= 78 {
        info.width = be16(entry, 24) as u32;
        info.height = be16(entry, 26) as u32;
        for (ct, cb) in children(&entry[78..]) {
            match ct.as_str() {
                "avcC" if cb.len() >= 4 => {
                    info.profile = Some(cb[1]);
                    info.level = Some(cb[3]);
                }
                "hvcC" if cb.len() >= 13 => {
                    info.profile = Some(cb[1] & 0x1f);
                    info.level = Some(cb[12]);
                }
                // Apple HEVC with alpha carries an auxiliary-layer description.
                "lhvC" => info.alpha = true,
                _ => {}
            }
        }
        // QuickTime depth field 32 = has alpha (ProRes 4444, Animation).
        let depth = be16(entry, 74);
        if depth == 32 && matches!(info.codec.as_str(), "prores" | "mjpeg") {
            info.alpha = true;
        }
    }
    info
}

fn audio_info(typ: &str, entry: &[u8]) -> AudioInfo {
    let mut a = AudioInfo { codec: audio_name(typ), ..Default::default() };
    if entry.len() >= 28 {
        let version = be16(entry, 8);
        a.channels = be16(entry, 16) as u32;
        a.sample_rate = be16(entry, 24) as u32;
        // Version 2 (QuickTime) stores the real values further in; 48 kHz still shows up above.
        if version == 2 && entry.len() >= 52 {
            a.channels = be32(entry, 44);
        }
    }
    a
}

fn probe_isobmff(path: &Path, size: u64) -> MediaProbe {
    let mut p = MediaProbe { container: "mp4".into(), size, fast_start: false, ..Default::default() };
    let mut f = match File::open(path) {
        Ok(f) => BufReader::new(f),
        Err(e) => {
            p.note = Some(e.to_string());
            return p;
        }
    };
    let mut head = [0u8; 16];
    let mut at: u64 = 0;
    let mut moov: Option<Vec<u8>> = None;
    let mut seen_mdat = false;
    while at + 8 <= size {
        if f.seek(SeekFrom::Start(at)).is_err() || f.read_exact(&mut head[..8]).is_err() {
            break;
        }
        let mut bsize = be32(&head, 0) as u64;
        let typ = fourcc(&head, 4);
        let mut hlen = 8u64;
        if bsize == 1 {
            if f.read_exact(&mut head[8..16]).is_err() {
                break;
            }
            bsize = be64(&head, 8);
            hlen = 16;
        } else if bsize == 0 {
            bsize = size - at;
        }
        if bsize < hlen {
            p.note = Some(format!("bad box size at {at}"));
            break;
        }
        match typ.as_str() {
            "ftyp" => {
                let n = (bsize - hlen).min(64) as usize;
                let mut b = vec![0u8; n];
                if f.read_exact(&mut b).is_ok() && (fourcc(&b, 0) == "qt  " || b.windows(4).any(|w| w == b"qt  ")) {
                    p.container = "mov".into();
                }
            }
            "moov" => {
                if bsize - hlen > 256 * 1024 * 1024 {
                    p.note = Some("index too large to read".into());
                    break;
                }
                let mut b = vec![0u8; (bsize - hlen) as usize];
                if f.read_exact(&mut b).is_err() {
                    p.note = Some("truncated index".into());
                    break;
                }
                p.fast_start = !seen_mdat;
                moov = Some(b);
            }
            "mdat" => seen_mdat = true,
            "moof" => p.fragmented = true,
            _ => {}
        }
        if moov.is_some() && (seen_mdat || p.fragmented) {
            break;
        }
        let Some(next) = at.checked_add(bsize) else {
            p.note = Some(format!("bad box size at {at}"));
            break;
        };
        at = next;
    }
    let Some(moov) = moov else {
        if p.note.is_none() {
            p.note = Some("no index (moov) found".into());
        }
        return p;
    };
    if find(&moov, "mvex").is_some() {
        p.fragmented = true;
    }
    if let Some(mvhd) = find(&moov, "mvhd") {
        let (v, b) = full(mvhd);
        let (ts, dur) = if v == 1 { (be32(b, 16), be64(b, 20)) } else { (be32(b, 8), be32(b, 12) as u64) };
        if ts > 0 {
            p.duration_s = dur as f64 / ts as f64;
        }
    }
    for (t, trak) in children(&moov).into_iter().filter(|(t, _)| t == "trak") {
        let _ = t;
        let Some(tt) = parse_trak(trak) else { continue };
        let Some((typ, entry)) = tt.entry.as_ref() else { continue };
        let secs = if tt.timescale > 0 { tt.duration as f64 / tt.timescale as f64 } else { 0.0 };
        match tt.handler.as_str() {
            "vide" if p.video.is_none() => {
                let mut v = video_info(typ, entry);
                v.frames = tt.samples;
                v.max_frame_bytes = tt.max_sample as u64;
                let sample_secs = if tt.timescale > 0 { tt.sample_time as f64 / tt.timescale as f64 } else { secs };
                if sample_secs > 0.0 && tt.samples > 0 {
                    v.fps = (tt.samples as f64 / sample_secs * 1000.0).round() / 1000.0;
                }
                match &tt.sync {
                    Some(sync) => {
                        v.keyframes = sync.len() as u64;
                        let mut gap_max = 0u32;
                        let mut prev = 1u32;
                        for &s in sync {
                            gap_max = gap_max.max(s.saturating_sub(prev));
                            prev = s;
                        }
                        if tt.samples > 0 {
                            gap_max = gap_max.max((tt.samples.min(u32::MAX as u64) as u32).saturating_sub(prev).saturating_add(1));
                        }
                        v.keyframe_gap_s = if v.fps > 0.0 { Some((gap_max as f64 / v.fps * 100.0).round() / 100.0) } else { None };
                    }
                    None => {
                        // No sync table: every sample is a keyframe (intra-only codecs), unless fragmented.
                        v.keyframes = if p.fragmented { 0 } else { tt.samples };
                        v.keyframe_gap_s = if p.fragmented { None } else { Some(0.0) };
                    }
                }
                if p.duration_s == 0.0 {
                    p.duration_s = secs;
                }
                p.video = Some(v);
            }
            "soun" if p.audio.is_none() => p.audio = Some(audio_info(typ, entry)),
            _ => {}
        }
    }
    if p.duration_s > 0.0 {
        p.bitrate_kbps = (size as f64 * 8.0 / p.duration_s / 1000.0) as u64;
    }
    p
}

/// WebM / Matroska: only the codec id strings are read (the first 256 KB), enough to tell VP9 from AV1.
fn probe_webm(path: &Path, size: u64) -> MediaProbe {
    let mut p = MediaProbe { container: "webm".into(), size, fast_start: true, ..Default::default() };
    let mut buf = vec![0u8; 256 * 1024];
    let n = File::open(path).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    let b = &buf[..n];
    let has = |s: &[u8]| b.windows(s.len()).any(|w| w == s);
    let vcodec = if has(b"V_VP9") {
        Some("vp9")
    } else if has(b"V_AV1") {
        Some("av1")
    } else if has(b"V_VP8") {
        Some("vp8")
    } else if has(b"V_MPEG4/ISO/AVC") {
        Some("h264")
    } else if has(b"V_MPEGH/ISO/HEVC") {
        Some("hevc")
    } else {
        None
    };
    if let Some(c) = vcodec {
        // AlphaMode (EBML id 53C0, one byte, value 1) in the track header: VP8 / VP9 with an alpha plane.
        let head = &b[..b.len().min(16 * 1024)];
        let alpha = head.windows(4).any(|w| w == [0x53, 0xc0, 0x81, 0x01]);
        p.video = Some(VideoInfo { codec: c.into(), fourcc: c.into(), alpha, ..Default::default() });
    }
    let acodec = if has(b"A_OPUS") {
        Some("opus")
    } else if has(b"A_VORBIS") {
        Some("vorbis")
    } else if has(b"A_AAC") {
        Some("aac")
    } else {
        None
    };
    if let Some(c) = acodec {
        p.audio = Some(AudioInfo { codec: c.into(), ..Default::default() });
    }
    p.note = Some("WebM: only codec ids are read".into());
    p
}

/// What a media file is. Never fails on a strange file: unknown parts stay empty and `note` says why.
#[tauri::command]
pub async fn media_probe(path: String) -> Result<MediaProbe, String> {
    probe_file(&path)
}

fn probe_file(path: &str) -> Result<MediaProbe, String> {
    let path = PathBuf::from(path);
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = meta.len();
    let mut magic = [0u8; 12];
    let n = File::open(&path).and_then(|mut f| f.read(&mut magic)).map_err(|e| e.to_string())?;
    let probe = if n >= 4 && magic[..4] == [0x1a, 0x45, 0xdf, 0xa3] {
        probe_webm(&path, size)
    } else if n >= 8 && matches!(&magic[4..8], b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip") {
        probe_isobmff(&path, size)
    } else {
        MediaProbe { container: "unknown".into(), size, note: Some("not an MP4/MOV/WebM file".into()), ..Default::default() }
    };
    Ok(probe)
}

// ---------------------------------------------------------------- ffmpeg

/// ffmpeg to use: bundled next to the executable (a Tauri sidecar), `SLS_FFMPEG`, then the machine's own.
pub fn find_ffmpeg() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Ok(me) = std::env::current_exe() {
        if let Some(dir) = me.parent() {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if let Ok(p) = std::env::var("SLS_FFMPEG") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

#[derive(Serialize)]
pub struct MediaTools {
    pub ffmpeg: Option<String>,
    pub ffmpeg_version: Option<String>,
    /// Hardware H.264 encoder the optimiser will use.
    pub encoder: String,
}

fn encoder_for(ffmpeg: &Path) -> String {
    let out = Command::new(ffmpeg).args(["-hide_banner", "-encoders"]).output().ok();
    let list = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    // Not VideoToolbox first on a Mac: it cannot cap a frame's size, and a wall-size keyframe at 30-60 fps
    // passes the 1000 KiB the asset protocol serves at once (the bottom of that picture then plays green).
    // libx264's VBV buffer keeps every frame under ~875 KB and runs ~5x real time at 3072 x 768.
    if cfg!(target_os = "macos") && list.contains("libx264") {
        "libx264".into()
    } else if cfg!(target_os = "macos") && list.contains("h264_videotoolbox") {
        "h264_videotoolbox".into()
    } else if list.contains("h264_nvenc") {
        "h264_nvenc".into()
    } else if list.contains("h264_qsv") {
        "h264_qsv".into()
    } else {
        "libx264".into()
    }
}

/// Which encoder tools this machine has.
#[tauri::command]
pub async fn media_tools() -> MediaTools {
    match find_ffmpeg() {
        Some(p) => {
            let ver = Command::new(&p)
                .arg("-version")
                .output()
                .ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| l.to_string()));
            MediaTools { encoder: encoder_for(&p), ffmpeg: Some(p.display().to_string()), ffmpeg_version: ver }
        }
        None => MediaTools { ffmpeg: None, ffmpeg_version: None, encoder: String::new() },
    }
}

#[derive(Serialize, Clone)]
struct Progress {
    job: String,
    /// Seconds of output written so far.
    done_s: f64,
    total_s: f64,
    /// 0..1
    fraction: f64,
}

/// H.264 bitrate for a frame size and rate: about 0.3 bits per pixel per frame (visually clean on
/// an LED wall), between 8 and 60 Mbit/s.
fn bitrate_kbps(w: u32, h: u32, fps: f64) -> u64 {
    let px = w as f64 * h as f64 * fps.max(24.0);
    ((px * 0.3 / 1000.0) as u64).clamp(8000, 60000)
}

/// Running encodes (the ffmpeg child and the temporary file it writes), so quitting the app stops them.
static ENCODERS: Mutex<Vec<(Arc<Mutex<Child>>, PathBuf)>> = Mutex::new(Vec::new());

/// Stop every running encode and remove its unfinished file (called when the app exits).
pub fn kill_encoders() {
    let jobs = std::mem::take(&mut *ENCODERS.lock().unwrap_or_else(|e| e.into_inner()));
    for (child, partial) in jobs {
        let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = c.kill();
        let _ = c.wait();
        let _ = std::fs::remove_file(&partial);
    }
}

/// A path's canonical form; for a file that does not exist yet, its folder's canonical form plus its name.
fn canonical(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(dir), Some(name)) => dir.canonicalize().map(|d| d.join(name)).unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

// ---------------------------------------------------------------- alpha packing

/// The tallest picture an alpha-packed file can hold: two of them stacked must stay inside the
/// hardware H.264 decoder's 4096 px.
const PACKED_MAX_HEIGHT: u32 = 2048;

/// The decoder ffmpeg must be told to use so a source's alpha is read: its own VP8 / VP9 decoders
/// drop the alpha plane, libvpx keeps it.
fn alpha_decoder(probe: &MediaProbe) -> Option<&'static str> {
    match probe.video.as_ref().map(|v| v.codec.as_str()) {
        Some("vp9") => Some("libvpx-vp9"),
        Some("vp8") => Some("libvpx"),
        _ => None,
    }
}

/// How ffmpeg reads a file's first video stream: pixel format, colour tags, size, rate and length
/// (the box walker above measures none of these for WebM).
#[derive(Debug, PartialEq, Default)]
struct StreamFormat {
    pix_fmt: String,
    /// (matrix, primaries, transfer) when the stream carries a matrix this code passes through.
    colour: Option<(String, String, String)>,
    width: u32,
    height: u32,
    fps: f64,
    duration_s: f64,
}

impl StreamFormat {
    fn has_alpha(&self) -> bool {
        ["yuva", "gbrap", "rgba", "bgra", "argb", "abgr", "ayuv", "vuya", "ya8", "ya16"].iter().any(|p| self.pix_fmt.starts_with(p))
    }
    fn is_rgb(&self) -> bool {
        ["gbr", "rgb", "bgr", "argb", "abgr", "ya", "gray", "pal8"].iter().any(|p| self.pix_fmt.starts_with(p))
    }
}

/// Read the pixel format out of ffmpeg's stream list, e.g.
/// `Stream #0:0: Video: vp9 (libvpx-vp9) (Profile 0), yuva420p(tv, bt709, progressive), 992x432, ...`.
fn parse_stream_format(text: &str) -> Option<StreamFormat> {
    let line = text.lines().find(|l| l.contains("Stream #") && l.contains("Video:"))?;
    let rest = &line[line.find("Video:")? + 6..];
    // Top-level comma-separated items (brackets may hold commas): codec, pixel format, size, ...
    let mut items: Vec<String> = Vec::new();
    let (mut depth, mut cur) = (0i32, String::new());
    for ch in rest.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            ',' if depth <= 0 => {
                items.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(ch);
    }
    items.push(cur);
    let item = items.get(1)?.trim();
    let (name, tags) = match item.find('(') {
        Some(i) => (&item[..i], item[i + 1..].trim_end_matches(')')),
        None => (item, ""),
    };
    let colour = tags.split(',').map(str::trim).find_map(|t| {
        let parts: Vec<&str> = t.split('/').collect();
        if !matches!(parts[0], "bt709" | "smpte170m" | "bt470bg") {
            return None;
        }
        let at = |i: usize| parts.get(i).filter(|x| **x != "unknown").unwrap_or(&parts[0]).to_string();
        Some((at(0), at(1), at(2)))
    });
    let mut f = StreamFormat { pix_fmt: name.trim().to_string(), colour, ..Default::default() };
    for it in items.iter().skip(2).map(|i| i.trim()) {
        let first = it.split_whitespace().next().unwrap_or("");
        if let Some((w, h)) = first.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                (f.width, f.height) = (w, h);
            }
        }
        if let Some(n) = it.strip_suffix(" fps") {
            f.fps = n.trim().parse().unwrap_or(0.0);
        }
    }
    // "  Duration: 00:00:10.04, start: ..." (N/A for a stream without one).
    if let Some(d) = text.lines().find_map(|l| l.trim_start().strip_prefix("Duration: ")) {
        let hms: Vec<f64> = d.split(',').next().unwrap_or("").split(':').filter_map(|x| x.trim().parse().ok()).collect();
        if hms.len() == 3 {
            f.duration_s = hms[0] * 3600.0 + hms[1] * 60.0 + hms[2];
        }
    }
    Some(f)
}

fn stream_format(ffmpeg: &Path, decoder: Option<&str>, src: &str) -> Option<StreamFormat> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin"]);
    if let Some(d) = decoder {
        cmd.args(["-c:v", d]);
    }
    // No output file: ffmpeg lists the streams on stderr and exits with an error, which is all that is wanted.
    let out = cmd.args(["-i", src]).stdin(Stdio::null()).output().ok()?;
    parse_stream_format(&String::from_utf8_lossy(&out.stderr))
}

/// The filter graph that turns a decoded frame with alpha into the packed frame, `w` x `2h`.
///
/// The colour is multiplied by the alpha first (so scaling, chroma subsampling and the codec blend an
/// edge towards nothing instead of towards whatever lay under the clear pixels), then scaled; the top
/// half is that colour, the bottom half the alpha as limited-range grey. The YUV values of a YUV
/// source are passed through (same matrix in and out), so the packed file decodes to the colours the
/// source did; an RGB source is written as BT.709. Pixels are declared square: a player sizes the frame
/// by its pixel aspect, and a frame it reads one row taller no longer splits into two equal halves.
fn pack_filter(w: u32, h: u32, colour: Option<&(String, String, String)>) -> String {
    let bt709 = ("bt709".to_string(), "bt709".to_string(), "bt709".to_string());
    let matrices = match colour {
        Some((m, _, _)) => format!("in_color_matrix={m}:out_color_matrix={m}"),
        None => "out_color_matrix=bt709".to_string(),
    };
    // The tags travel with the frames: the encoder writes what the filter graph hands it.
    let (m, p, t) = colour.unwrap_or(&bt709);
    format!(
        "[0:v:0]premultiply=inplace=1,scale={w}:{h}:flags=lanczos:{matrices}:out_range=tv,setsar=1,format=yuva444p,split[c][a];\
         [c]format=yuv420p[top];\
         [a]alphaextract,scale=in_range=pc:out_range=tv,format=yuv420p[bot];\
         [top][bot]vstack=inputs=2,setparams=colorspace={m}:color_primaries={p}:color_trc={t}:range=tv[v]"
    )
}

struct EncodePlan {
    args: Vec<String>,
    total_s: f64,
}

/// The ffmpeg arguments that write `out` from `src` in the wall's format (see `media_optimise`).
fn plan_encode(ffmpeg: &Path, src: &str, out: &Path, max_width: u32, max_height: u32, source_fps: Option<f64>, source_duration_s: Option<f64>, pack_alpha: bool) -> Result<EncodePlan, String> {
    let encoder = encoder_for(ffmpeg);
    let probe_src = probe_file(src).unwrap_or_default();
    let decoder = if pack_alpha { alpha_decoder(&probe_src) } else { None };
    let format = if pack_alpha { stream_format(ffmpeg, decoder, src) } else { None };
    let fps = source_fps.filter(|f| *f > 0.0).or(format.as_ref().map(|f| f.fps).filter(|f| *f > 0.0)).unwrap_or(30.0);
    let keyint = (fps / 2.0).round().max(1.0) as u32;
    if pack_alpha {
        match &format {
            Some(f) if f.has_alpha() => {}
            Some(f) if probe_src.video.as_ref().is_some_and(|v| v.alpha) => {
                return Err(format!(
                    "this ffmpeg cannot read the file's alpha channel (it decodes {} as {}): pack from the WebM (VP9 alpha) or ProRes 4444 version of the clip instead",
                    probe_src.video.as_ref().map(|v| v.codec.as_str()).unwrap_or("it"),
                    f.pix_fmt
                ))
            }
            Some(f) => return Err(format!("the file has no alpha channel to pack (ffmpeg reads it as {})", f.pix_fmt)),
            None => return Err("ffmpeg could not read the file's video stream".into()),
        }
    }
    let box_h = if pack_alpha { max_height.min(PACKED_MAX_HEIGHT) } else { max_height };
    // The box walker does not measure WebM: there the size comes from ffmpeg's stream list.
    let (sw, sh) = probe_src
        .video
        .as_ref()
        .filter(|v| v.width > 0 && v.height > 0)
        .map(|v| (v.width, v.height))
        .or(format.as_ref().filter(|f| f.width > 0 && f.height > 0).map(|f| (f.width, f.height)))
        .unwrap_or((max_width, box_h));
    // Fit inside the box, never upscale, keep the aspect, even dimensions.
    let scale = {
        let k = (max_width as f64 / sw.max(1) as f64).min(box_h as f64 / sh.max(1) as f64).min(1.0);
        let w = ((sw as f64 * k) as u32).max(2) & !1;
        let h = ((sh as f64 * k) as u32).max(2) & !1;
        (w, h)
    };
    let frame_h = if pack_alpha { scale.1 * 2 } else { scale.1 };
    let kbps = bitrate_kbps(scale.0, frame_h, fps);
    let has_audio = probe_src.audio.is_some();
    let total_s = source_duration_s.filter(|d| *d > 0.0).or(Some(probe_src.duration_s).filter(|d| *d > 0.0)).or(format.as_ref().map(|f| f.duration_s)).unwrap_or(0.0);

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-nostats".into(), "-y".into()];
    if let Some(d) = decoder {
        args.extend(["-c:v".into(), d.into()]);
    }
    args.extend(["-i".into(), src.to_string()]);
    let mut colour: Option<(String, String, String)> = None;
    if pack_alpha {
        let f = format.as_ref().expect("checked above");
        // An untagged YUV source is read by every player as BT.601 below 720 lines and BT.709 from there
        // up; the packed frame is twice as tall, so it carries that reading as a tag instead of leaving
        // it to be guessed again from the new height.
        let c = if f.is_rgb() {
            None
        } else {
            Some(f.colour.clone().unwrap_or_else(|| {
                let m = if sh >= 720 { "bt709" } else { "smpte170m" };
                (m.into(), m.into(), m.into())
            }))
        };
        args.extend(["-filter_complex".into(), pack_filter(scale.0, scale.1, c.as_ref()), "-map".into(), "[v]".into()]);
        colour = Some(c.unwrap_or_else(|| ("bt709".into(), "bt709".into(), "bt709".into())));
    } else {
        args.extend(["-map".into(), "0:v:0".into()]);
    }
    if has_audio {
        args.extend(["-map".into(), "0:a:0?".into()]);
    } else {
        args.push("-an".into());
    }
    if !pack_alpha {
        args.extend(["-vf".into(), format!("scale={}:{}:flags=lanczos,format=yuv420p", scale.0, scale.1)]);
    }
    args.extend(["-c:v".into(), encoder.clone(), "-profile:v".into(), "high".into(), "-g".into(), keyint.to_string()]);
    match encoder.as_str() {
        "libx264" => args.extend(["-preset".into(), "fast".into(), "-crf".into(), "18".into(), "-maxrate".into(), format!("{kbps}k"), "-bufsize".into(), format!("{}k", (kbps * 2).min(7000)), "-x264-params".into(), format!("keyint={keyint}:min-keyint={keyint}:scenecut=0")]),
        "h264_videotoolbox" => args.extend(["-b:v".into(), format!("{kbps}k"), "-allow_sw".into(), "1".into(), "-realtime".into(), "0".into()]),
        _ => args.extend(["-b:v".into(), format!("{kbps}k")]),
    }
    if let Some((matrix, primaries, transfer)) = colour {
        args.extend(["-colorspace".into(), matrix, "-color_primaries".into(), primaries, "-color_trc".into(), transfer, "-color_range".into(), "tv".into()]);
    }
    if has_audio {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-ac".into(), "2".into()]);
    }
    args.extend(["-movflags".into(), "+faststart".into(), "-progress".into(), "pipe:1".into(), out.to_string_lossy().to_string()]);
    Ok(EncodePlan { args, total_s })
}

/// Re-encode `src` to `dest` in the wall's format: H.264 High (hardware encoder where there is one),
/// scaled to fit `max_width` × `max_height` (never upscaled), a keyframe every half second, yuv420p,
/// stereo AAC, fast start. Returns the probe of the new file.
///
/// `pack_alpha`: `src` has an alpha channel (VP9 / VP8 alpha WebM, ProRes 4444, any format this ffmpeg
/// decodes with alpha) and `dest` becomes its alpha-packed form: the picture fitted to the same box
/// (at most 2048 high), the frame twice that height with the matte in the bottom half.
///
/// ffmpeg writes a temporary file beside `dest`, renamed to `dest` only once the encode succeeded:
/// a failed or stopped encode leaves `dest` as it was and removes only the temporary file.
/// `dest` must not be `src` (ffmpeg cannot write over its input).
#[tauri::command]
pub async fn media_optimise(app: tauri::AppHandle, job: String, src: String, dest: String, max_width: u32, max_height: u32, source_fps: Option<f64>, source_duration_s: Option<f64>, pack_alpha: Option<bool>) -> Result<MediaProbe, String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "ffmpeg is not installed on this computer (the app looks next to itself, in $SLS_FFMPEG and on the PATH). Install it, e.g. `brew install ffmpeg` on a Mac, or re-encode the file yourself.".to_string())?;
    let (src_path, dest_path) = (PathBuf::from(&src), PathBuf::from(&dest));
    if canonical(&src_path) == canonical(&dest_path) {
        return Err("the optimised file needs a new name: the destination is the source file itself".into());
    }
    let dest_name = dest_path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("destination has no file name")?;
    // Same extension as the destination, so ffmpeg picks the same container.
    let ext = dest_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".into());
    let partial = dest_path.with_file_name(format!(".{dest_name}.encoding.{ext}"));
    let EncodePlan { args, total_s } = plan_encode(&ffmpeg, &src, &partial, max_width, max_height, source_fps, source_duration_s, pack_alpha.unwrap_or(false))?;

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
    let stderr = child.stderr.take().ok_or("no ffmpeg stderr")?;
    let err_task = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    let app2 = app.clone();
    let job2 = job.clone();
    let progress_task = std::thread::spawn(move || {
        let mut last = -1.0f64;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let done = if let Some(v) = line.strip_prefix("out_time_us=") {
                v.trim().parse::<f64>().ok().map(|us| us / 1e6)
            } else if let Some(v) = line.strip_prefix("out_time_ms=") {
                // Despite the name, ffmpeg writes microseconds here.
                v.trim().parse::<f64>().ok().map(|us| us / 1e6)
            } else {
                None
            };
            if let Some(d) = done {
                if d - last >= 0.25 {
                    last = d;
                    let fraction = if total_s > 0.0 { (d / total_s).clamp(0.0, 0.999) } else { 0.0 };
                    let _ = app2.emit("media-progress", Progress { job: job2.clone(), done_s: d, total_s, fraction });
                }
            }
        }
    });
    let child = Arc::new(Mutex::new(child));
    ENCODERS.lock().unwrap_or_else(|e| e.into_inner()).push((child.clone(), partial.clone()));
    let waiter = child.clone();
    // Polled rather than a blocking wait(), so kill_encoders can take the child's lock to stop it.
    let status = tauri::async_runtime::spawn_blocking(move || loop {
        match waiter.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) => {}
            Err(e) => break Err(e),
        }
        std::thread::sleep(Duration::from_millis(100));
    })
    .await;
    ENCODERS.lock().unwrap_or_else(|e| e.into_inner()).retain(|(c, _)| !Arc::ptr_eq(c, &child));
    let status = match status.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())) {
        Ok(st) => st,
        Err(e) => {
            let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = c.kill();
            let _ = c.wait();
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
    };
    let _ = progress_task.join();
    let err = err_task.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        let tail: String = err.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg failed ({status}): {}", if tail.is_empty() { "no message".into() } else { tail }));
    }
    if let Err(e) = std::fs::rename(&partial, &dest_path) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("could not move the optimised file into place: {e}"));
    }
    let _ = app.emit("media-progress", Progress { job, done_s: total_s, total_s, fraction: 1.0 });
    media_probe(dest).await
}

/// Keep the tool-path lookup usable from tests and other modules without a Tauri handle.
#[allow(dead_code)]
pub fn tool_paths() -> HashMap<&'static str, Option<PathBuf>> {
    HashMap::from([("ffmpeg", find_ffmpeg())])
}

#[cfg(test)]
mod tests {
    /// ffmpeg's stream line gives the pixel format (alpha or not) and the colour tags worth keeping.
    #[test]
    fn stream_lines_are_read() {
        let f = super::parse_stream_format("  Stream #0:0: Video: vp9 (libvpx-vp9) (Profile 0), yuva420p(tv, progressive), 992x432, SAR 1:1 DAR 62:27, 24 fps").unwrap();
        assert_eq!(f.pix_fmt, "yuva420p");
        assert!(f.has_alpha() && !f.is_rgb());
        assert_eq!(f.colour, None);
        assert_eq!((f.width, f.height, f.fps), (992, 432, 24.0));
        let f = super::parse_stream_format("  Duration: 00:01:10.50, start: 0.000000, bitrate: 846 kb/s\n  Stream #0:0: Video: vp8, yuva420p(progressive), 640x360, SAR 1:1 DAR 16:9, 29.97 fps, 29.97 tbr").unwrap();
        assert_eq!((f.width, f.height, f.fps, f.duration_s), (640, 360, 29.97, 70.5));
        let f = super::parse_stream_format("  Stream #0:0[0x1](eng): Video: prores (4444) (ap4h / 0x68347061), yuva444p12le(bt709, progressive), 3072x768, 24 fps").unwrap();
        assert_eq!(f.pix_fmt, "yuva444p12le");
        assert_eq!(f.colour, Some(("bt709".into(), "bt709".into(), "bt709".into())));
        let f = super::parse_stream_format("  Stream #0:0[0x1]: Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, smpte170m/bt470bg/unknown, progressive), 992x432 [SAR 1:1 DAR 62:27]").unwrap();
        assert!(!f.has_alpha());
        assert_eq!(f.colour, Some(("smpte170m".into(), "bt470bg".into(), "smpte170m".into())));
        let f = super::parse_stream_format("  Stream #0:0: Video: png (png  / 0x20676E70), rgba(pc, gbr/bt709/iec61966-2-1), 640x360").unwrap();
        assert!(f.has_alpha() && f.is_rgb());
        assert!(super::parse_stream_format("  Stream #0:1: Audio: aac (LC), 48000 Hz").is_none());
    }

    /// Pack a real file with the optimiser's own arguments (needs ffmpeg), for checking the format by eye:
    /// `SLS_PACK_SRC=in.webm SLS_PACK_DEST=out.mp4 [SLS_PACK_BOX=3072x768] cargo test pack_a_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn pack_a_file() {
        let (src, dest) = (std::env::var("SLS_PACK_SRC").expect("SLS_PACK_SRC"), std::env::var("SLS_PACK_DEST").expect("SLS_PACK_DEST"));
        let bx = std::env::var("SLS_PACK_BOX").unwrap_or_else(|_| "3072x768".into());
        let (w, h) = bx.split_once('x').map(|(w, h)| (w.parse::<u32>().unwrap(), h.parse::<u32>().unwrap())).expect("SLS_PACK_BOX=WxH");
        let ffmpeg = super::find_ffmpeg().expect("ffmpeg");
        let before = super::probe_file(&src).unwrap();
        let plan = super::plan_encode(&ffmpeg, &src, std::path::Path::new(&dest), w, h, None, None, true).expect("plan");
        println!("ffmpeg {}", plan.args.join(" "));
        let out = std::process::Command::new(&ffmpeg).args(&plan.args).output().expect("run ffmpeg");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let after = super::probe_file(&dest).unwrap();
        let v = after.video.expect("video");
        println!("{:?} -> {}x{} h264, biggest frame {} bytes, keyframe gap {:?} s, fast start {}", before.video.map(|v| v.codec), v.width, v.height, v.max_frame_bytes, v.keyframe_gap_s, after.fast_start);
        assert_eq!(v.codec, "h264");
        assert!(v.height % 4 == 0 && v.height <= 4096 && v.max_frame_bytes < 1_000_000 && after.fast_start);
    }
    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(typ);
        b.extend_from_slice(body);
        b
    }

    /// A damaged index claiming four billion samples is read as what its boxes hold, not trusted.
    #[test]
    fn damaged_sample_tables_are_bounded() {
        let huge = u32::MAX.to_be_bytes();
        let full = |payload: &[u8]| [&[0u8; 4][..], payload].concat();
        let stts = bx(b"stts", &full(&[&huge[..], &[0, 0, 0, 5, 0, 0, 0, 1]].concat()));
        let stss = bx(b"stss", &full(&[&huge[..], &[0, 0, 0, 1]].concat()));
        let stsz = bx(b"stsz", &full(&[&[0u8; 4][..], &huge[..], &[0, 0, 1, 0]].concat()));
        let stbl = bx(b"stbl", &[stts, stss, stsz].concat());
        let minf = bx(b"minf", &stbl);
        let mdhd = bx(b"mdhd", &full(&[&[0u8; 8][..], &1000u32.to_be_bytes(), &5000u32.to_be_bytes()].concat()));
        let hdlr = bx(b"hdlr", &full(&[&[0u8; 4][..], b"vide"].concat()));
        let mdia = bx(b"mdia", &[mdhd, hdlr, minf].concat());
        let trak = bx(b"trak", &bx(b"mdia", &mdia[8..]));
        let t = super::parse_trak(&trak[8..]).expect("track");
        assert_eq!(t.samples, 5);
        assert_eq!(t.sync.as_ref().map(|s| s.len()), Some(1));
        assert_eq!(t.max_sample, 256);
        // A child box whose 64-bit size runs past everything, and one cut off inside its header.
        let mut odd = vec![0, 0, 0, 1];
        odd.extend_from_slice(b"free");
        odd.extend_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(super::children(&odd).len(), 1);
        assert!(super::children(&odd[..12]).is_empty());
    }
}
