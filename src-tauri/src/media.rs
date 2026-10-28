//! Media files the wall can play.
//!
//! `media_probe` reads what a video file is (container, codec, profile/level, size, frame rate,
//! keyframe spacing, audio, fast-start) with a small ISO BMFF / QuickTime box walker: no external
//! tool, a few kilobytes read, so every import is checked. The app decides from it whether the
//! webview will play the file well (see `src/core/mediaCheck.ts`).
//!
//! `media_optimise` re-encodes a file into the wall's playback format with ffmpeg: bundled next to
//! the app when the build ships one, otherwise the one installed on the machine. Progress is
//! emitted as `media-progress` events so the operator sees it.

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    /// Sample entry declares an alpha channel (HEVC with alpha).
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
        if size < head as u64 {
            break;
        }
        let end = (at as u64 + size).min(body.len() as u64) as usize;
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
        let n = be32(b, 0) as usize;
        for i in 0..n {
            let count = be32(b, 4 + i * 8) as u64;
            let delta = be32(b, 8 + i * 8) as u64;
            t.samples += count;
            t.sample_time += count * delta;
        }
    }
    if let Some(stss) = find(stbl, "stss") {
        let (_, b) = full(stss);
        let n = be32(b, 0) as usize;
        t.sync = Some((0..n).map(|i| be32(b, 4 + i * 4)).collect());
    }
    if let Some(stsz) = find(stbl, "stsz") {
        let (_, b) = full(stsz);
        let (fixed, n) = (be32(b, 0), be32(b, 4) as usize);
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
        at += bsize;
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
                            gap_max = gap_max.max((tt.samples as u32).saturating_sub(prev) + 1);
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
        p.video = Some(VideoInfo { codec: c.into(), fourcc: c.into(), ..Default::default() });
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

/// Re-encode `src` to `dest` in the wall's format: H.264 High (hardware encoder where there is one),
/// scaled to fit `max_width` × `max_height` (never upscaled), a keyframe every half second, yuv420p,
/// stereo AAC, fast start. Returns the probe of the new file.
#[tauri::command]
pub async fn media_optimise(app: tauri::AppHandle, job: String, src: String, dest: String, max_width: u32, max_height: u32, source_fps: Option<f64>, source_duration_s: Option<f64>) -> Result<MediaProbe, String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "ffmpeg is not installed on this computer (the app looks next to itself, in $SLS_FFMPEG and on the PATH). Install it, e.g. `brew install ffmpeg` on a Mac, or re-encode the file yourself.".to_string())?;
    let encoder = encoder_for(&ffmpeg);
    let fps = source_fps.filter(|f| *f > 0.0).unwrap_or(30.0);
    let keyint = (fps / 2.0).round().max(1.0) as u32;
    let probe_src = media_probe(src.clone()).await.unwrap_or_default();
    let (sw, sh) = probe_src.video.as_ref().map(|v| (v.width, v.height)).unwrap_or((max_width, max_height));
    // Fit inside the box, never upscale, keep the aspect, even dimensions.
    let scale = {
        let k = (max_width as f64 / sw.max(1) as f64).min(max_height as f64 / sh.max(1) as f64).min(1.0);
        let w = ((sw as f64 * k) as u32).max(2) & !1;
        let h = ((sh as f64 * k) as u32).max(2) & !1;
        (w, h)
    };
    let kbps = bitrate_kbps(scale.0, scale.1, fps);
    let has_audio = probe_src.audio.is_some();
    let total_s = source_duration_s.filter(|d| *d > 0.0).unwrap_or(probe_src.duration_s);

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-nostats".into(), "-y".into(), "-i".into(), src.clone()];
    args.extend(["-map".into(), "0:v:0".into()]);
    if has_audio {
        args.extend(["-map".into(), "0:a:0?".into()]);
    } else {
        args.push("-an".into());
    }
    args.extend(["-vf".into(), format!("scale={}:{}:flags=lanczos,format=yuv420p", scale.0, scale.1)]);
    args.extend(["-c:v".into(), encoder.clone(), "-profile:v".into(), "high".into(), "-g".into(), keyint.to_string()]);
    match encoder.as_str() {
        "libx264" => args.extend(["-preset".into(), "fast".into(), "-crf".into(), "18".into(), "-maxrate".into(), format!("{kbps}k"), "-bufsize".into(), format!("{}k", (kbps * 2).min(7000)), "-x264-params".into(), format!("keyint={keyint}:min-keyint={keyint}:scenecut=0")]),
        "h264_videotoolbox" => args.extend(["-b:v".into(), format!("{kbps}k"), "-allow_sw".into(), "1".into(), "-realtime".into(), "0".into()]),
        _ => args.extend(["-b:v".into(), format!("{kbps}k")]),
    }
    if has_audio {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-ac".into(), "2".into()]);
    }
    args.extend(["-movflags".into(), "+faststart".into(), "-progress".into(), "pipe:1".into(), dest.clone()]);

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
    let status = tauri::async_runtime::spawn_blocking(move || child.wait()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let _ = progress_task.join();
    let err = err_task.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&dest);
        let tail: String = err.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg failed ({status}): {}", if tail.is_empty() { "no message".into() } else { tail }));
    }
    let _ = app.emit("media-progress", Progress { job, done_s: total_s, total_s, fraction: 1.0 });
    media_probe(dest).await
}

/// Keep the tool-path lookup usable from tests and other modules without a Tauri handle.
#[allow(dead_code)]
pub fn tool_paths() -> HashMap<&'static str, Option<PathBuf>> {
    HashMap::from([("ffmpeg", find_ffmpeg())])
}
