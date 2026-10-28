// Will the wall play this file well? Pure rules over a media probe (src-tauri/src/media.rs), shared by
// the import flow, the asset library and the agent bridge. Kept free of app imports so it can be unit-run.
//
// What the two webviews play (measured on this project, see docs/ARCHITECTURE.md, "Media formats"):
// - macOS (WKWebView, AVFoundation): H.264 up to 4096 px wide/high in hardware; a wider H.264 frame
//   decodes but reaches WebGL as a green frame with garbage along the top. HEVC decodes up to 8K.
// - A library file reaches the player through the asset protocol, which serves at most 1000 KiB per
//   request; a frame bigger than that is not put back together and the bottom of it plays green.
// - Windows (WebView2): H.264 and VP9 everywhere; HEVC only with the paid Microsoft extension.
// - Any seek lands on the previous keyframe and decodes forward from there, so a long GOP stalls
//   every scrub and every drift correction.

export interface ProbeVideo {
  codec: string;
  fourcc: string;
  profile: number | null;
  level: number | null;
  width: number;
  height: number;
  fps: number;
  frames: number;
  keyframe_gap_s: number | null;
  keyframes: number;
  alpha: boolean;
  /** Largest compressed frame in bytes (absent in probes stored before it was measured). */
  max_frame_bytes?: number;
}

export interface ProbeAudio {
  codec: string;
  channels: number;
  sample_rate: number;
}

export interface MediaProbe {
  container: string;
  size: number;
  duration_s: number;
  bitrate_kbps: number;
  fast_start: boolean;
  fragmented: boolean;
  video: ProbeVideo | null;
  audio: ProbeAudio | null;
  note: string | null;
}

export interface MediaProblem {
  /** error: will not play or will not look right; warn: plays, but costs or stalls. */
  severity: "error" | "warn";
  code: "h264-too-wide" | "big-frame" | "codec" | "oversize" | "long-gop" | "no-faststart" | "fragmented" | "high-fps" | "high-bitrate" | "unreadable";
  message: string;
  /** Optimising (re-encoding into the wall format) fixes it. */
  fixable: boolean;
}

export interface WallFormat {
  /** The output canvas: the optimiser never makes a frame bigger than this. */
  canvasWidth: number;
  canvasHeight: number;
}

/** The hardware H.264 decoder's ceiling on Apple silicon and most Intel/AMD parts (level 5.2). */
export const H264_MAX_DIM = 4096;
/**
 * Largest frame a library video may hold. The asset protocol answers each range request with at most
 * 1000 KiB (tauri::protocol::asset MAX_LEN = 1,024,000 bytes) and the Mac's player does not reassemble a
 * bigger frame: measured on the 3072 x 768 street plate (October 2026), 1,273 KB keyframes played with a
 * green bottom from the library and clean from the dev server; capped at 797 KB they played clean from both.
 */
export const MAX_FRAME_BYTES = 1_000_000;
/** Longest keyframe gap that still scrubs and re-syncs without a visible stall. */
export const MAX_KEYFRAME_GAP_S = 2;
/** Frames larger than this many times the canvas only cost decode time. */
export const OVERSIZE_FACTOR = 1.5;

const PLAYABLE = new Set(["h264", "hevc", "vp9", "vp8", "av1", "prores", "mjpeg"]);

/** Problems with a file, worst first. Empty means it is fine as it is. */
export function checkMedia(p: MediaProbe | null | undefined, wall: WallFormat, opts: { hasAlpha?: boolean } = {}): MediaProblem[] {
  const out: MediaProblem[] = [];
  if (!p) return out;
  const v = p.video;
  if (p.container === "unknown" || (!v && p.container !== "webm")) {
    out.push({ severity: "warn", code: "unreadable", message: p.note ? `Could not read the file: ${p.note}` : "Could not read the file's video stream", fixable: false });
    return out;
  }
  if (!v) return out;
  // Alpha video is a deliberate format (HEVC alpha on macOS, VP9 WebM elsewhere): re-encoding would flatten it.
  const alpha = !!opts.hasAlpha || v.alpha;
  const px = (n: number) => n.toLocaleString();

  if (v.codec === "h264" && (v.width > H264_MAX_DIM || v.height > H264_MAX_DIM)) {
    out.push({
      severity: "error",
      code: "h264-too-wide",
      message: `H.264 at ${px(v.width)}×${px(v.height)} is wider than the ${px(H264_MAX_DIM)} px the hardware decoder handles: on a Mac the picture comes out green with garbage. Re-encode at the wall size.`,
      fixable: !alpha,
    });
  }
  if ((v.max_frame_bytes ?? 0) > MAX_FRAME_BYTES) {
    out.push({
      severity: "error",
      code: "big-frame",
      message: `Its biggest frame is ${Math.round(v.max_frame_bytes! / 1024).toLocaleString()} KB; the app serves a library file at most 1000 KB at a time, so on a Mac the bottom of that picture plays green. Optimise it (the copy keeps every frame under ~875 KB).`,
      fixable: !alpha,
    });
  }
  if (!PLAYABLE.has(v.codec)) {
    out.push({ severity: "error", code: "codec", message: `${v.codec.replace("other:", "codec ")} is not a format the output window can play. Re-encode to H.264.`, fixable: !alpha });
  } else if (v.codec === "hevc" && !alpha) {
    out.push({ severity: "warn", code: "codec", message: "HEVC plays on a Mac but not on a Windows show computer without the HEVC extension. H.264 plays everywhere.", fixable: true });
  } else if (v.codec === "av1") {
    out.push({ severity: "warn", code: "codec", message: "AV1 only decodes in hardware on the newest machines; H.264 is safer for the wall.", fixable: !alpha });
  } else if (v.codec === "prores" || v.codec === "mjpeg") {
    out.push({ severity: "warn", code: "high-bitrate", message: `${v.codec === "prores" ? "ProRes" : "Motion JPEG"} at ${Math.round(p.bitrate_kbps / 1000)} Mbit/s reads the disk hard; an H.264 copy plays lighter.`, fixable: !alpha });
  }
  if (v.width > wall.canvasWidth * OVERSIZE_FACTOR || v.height > wall.canvasHeight * OVERSIZE_FACTOR) {
    out.push({
      severity: "warn",
      code: "oversize",
      message: `${px(v.width)}×${px(v.height)} is far bigger than the ${px(wall.canvasWidth)}×${px(wall.canvasHeight)} wall: every window decodes pixels it never shows.`,
      fixable: !alpha,
    });
  }
  if (p.fragmented) {
    out.push({ severity: "warn", code: "fragmented", message: "Fragmented MP4 (streaming layout): seeking is slow and the length may read wrong.", fixable: !alpha });
  } else if (v.keyframe_gap_s !== null && v.keyframe_gap_s > MAX_KEYFRAME_GAP_S) {
    out.push({ severity: "warn", code: "long-gop", message: `A keyframe only every ${v.keyframe_gap_s.toFixed(1)} s: scrubbing and re-sync decode up to that much video before showing a frame.`, fixable: !alpha });
  }
  if (!p.fast_start && p.container !== "webm") {
    out.push({ severity: "warn", code: "no-faststart", message: "The index sits at the end of the file: playback waits until the whole file is read.", fixable: !alpha });
  }
  if (v.fps > 61) {
    out.push({ severity: "warn", code: "high-fps", message: `${Math.round(v.fps)} fps is more than the wall shows; the optimiser keeps the rate but it costs decode time.`, fixable: false });
  }
  if (v.codec === "h264" && p.bitrate_kbps > 80000 && !out.some((x) => x.code === "oversize")) {
    out.push({ severity: "warn", code: "high-bitrate", message: `${Math.round(p.bitrate_kbps / 1000)} Mbit/s is heavy for H.264; the optimiser brings it to a wall-friendly rate.`, fixable: !alpha });
  }
  const rank = { error: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Should the import optimise this file without asking? Only for faults the operator would otherwise hit on the wall. */
export function needsOptimise(problems: MediaProblem[]): boolean {
  return problems.some((p) => p.fixable && (p.severity === "error" || p.code === "oversize" || p.code === "long-gop" || p.code === "no-faststart"));
}

/** One line for a tooltip or a log. */
export function describeProbe(p: MediaProbe | null | undefined): string {
  if (!p) return "";
  const v = p.video;
  const parts: string[] = [];
  if (v) {
    const codec = v.codec === "h264" ? "H.264" : v.codec === "hevc" ? "HEVC" : v.codec.toUpperCase();
    parts.push(`${codec}${v.level && v.codec === "h264" ? ` L${(v.level / 10).toFixed(1)}` : ""}`);
    if (v.width) parts.push(`${v.width}×${v.height}`);
    if (v.fps) parts.push(`${Math.round(v.fps * 100) / 100} fps`);
    if (v.keyframe_gap_s !== null) parts.push(`key every ${v.keyframe_gap_s <= 0 ? "frame" : `${v.keyframe_gap_s.toFixed(1)} s`}`);
  }
  if (p.bitrate_kbps) parts.push(`${(p.bitrate_kbps / 1000).toFixed(1)} Mbit/s`);
  if (p.audio) parts.push(`${p.audio.codec.toUpperCase()} audio`);
  else if (v) parts.push("silent");
  return parts.join(" · ");
}
