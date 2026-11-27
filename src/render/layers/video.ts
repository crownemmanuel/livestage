import { useEffect, useState } from "react";
import * as THREE from "three";
import { clamp, now } from "@/core/clock";
import { isWebKit } from "@/core/platform";
import type { Asset, MediaSettings, VideoEngine } from "@/core/types";
import { useShow } from "@/store/show";
import { addUploadTime } from "../uploadStats";
import { CodecPlayer, codecFileName, codecRefused, takeCodecStats, type VideoLike } from "../video/codecVideo";
import type { LoopSpan } from "../video/protocol";

export type { VideoLike };

export interface VideoHandle {
  /** What the layers read (readyState, currentTime, ...): the <video> itself, or the WebCodecs player's stand-in. */
  video: VideoLike;
  /** Which engine plays it: the platform's <video>, or WebCodecs in the window's decoder worker (render/video). */
  engine: "element" | "webcodecs";
  /** The <video> (element engine only). */
  el: HTMLVideoElement | null;
  /** The WebCodecs player (webcodecs engine only). */
  codec: CodecPlayer | null;
  texture: THREE.VideoTexture;
  /** The file this element plays (set as `src` only while warm). */
  url: string;
  /** Warm: the file is loaded and a decoder is held, ready to show a frame at once. Cold: no src, no decoder. */
  warm: boolean;
  lastSeek: number;
  /** The last seek was made while playing (its landing time trains `seekLead`). */
  seekPlaying: boolean;
  /** Wall time (ms) it last started playing from a parked frame: drift is not judged until it has settled. */
  startedAt: number;
  /** Its start-up lag is still to be recorded (see `startLagMs` in the sync stats). */
  startPending: boolean;
  /** currentTime of the last frame uploaded while paused. */
  shownTime: number;
  /** Drift correction in progress while playing: -1 slowing down, +1 catching up, 0 none. */
  correcting: -1 | 0 | 1;
  /** Parked (told to stay paused) since it last played: its next start lands on the clock first. */
  parked: boolean;
  /** The element has shown a frame of its current file (see useVideo): only then may it be uploaded outside three's own frame callback. */
  framed: boolean;
  /** The file is alpha-packed (colour over matte, twice the picture's height): see `Asset.alphaPacked`. */
  packed: boolean;
}

/** How `useVideo` should treat an asset's transparency. */
export function videoAlpha(a: Asset | undefined | null): { alpha: boolean; packed: boolean } {
  return { alpha: !!a?.hasAlpha && !a.alphaPacked, packed: !!a?.alphaPacked };
}

/** Is this texture an alpha-packed video (set by `useVideo`)? */
export function isPackedTexture(tex: THREE.Texture | null | undefined): boolean {
  return !!tex && tex.userData.alphaPacked === true;
}

/** Width / height of the picture a video shows: an alpha-packed file is twice as tall as its picture. */
export function videoAspect(h: VideoHandle): number {
  const v = h.video;
  return (v.videoWidth / Math.max(1, v.videoHeight)) * (h.packed ? 2 : 1);
}

// ---------------------------------------------------------------- sync diagnostics

/** What one playing video did in the last report interval (the output heartbeat reads it once a second). */
export interface VideoSyncStat {
  file: string;
  /** Which engine plays it (absent = element, from an older build). */
  engine?: "element" | "webcodecs";
  time: number;
  rate: number;
  seeks: number;
  rateChanges: number;
  driftAvgMs: number;
  driftMaxMs: number;
  dropped: number;
  frames: number;
  /** Paused (parked or held) but seeked in this interval. */
  paused?: boolean;
  /** Hard seeks made while it was playing (each one a visible jump): the ones that matter. */
  playingSeeks?: number;
  /** How far behind the clock (ms) it was once it had settled after its last start in this interval. */
  startLagMs?: number;
  /**
   * WebCodecs only. late = frames drawn showing an older frame than the clock's (the decoder behind); skipped =
   * frames that arrived after their time; stale = decoded frames closed unseen in the worker; held = most frames
   * held decoded; gopMs = slowest GOP decode (feed to flush); readMs = slowest read of a GOP's bytes.
   */
  late?: number;
  skipped?: number;
  stale?: number;
  held?: number;
  gopMs?: number;
  readMs?: number;
  /** WebCodecs only: its sound is playing through Web Audio ("on") or being decoded. */
  sound?: "on" | "decoding";
}

interface SyncCounters {
  seeks: number;
  playingSeeks: number;
  startLag: number | null;
  rateChanges: number;
  driftSum: number;
  driftMax: number;
  n: number;
  dropped: number;
  total: number;
}

const counters = new Map<VideoHandle, SyncCounters>();

function countersFor(h: VideoHandle): SyncCounters {
  let c = counters.get(h);
  if (!c) {
    c = { seeks: 0, playingSeeks: 0, startLag: null, rateChanges: 0, driftSum: 0, driftMax: 0, n: 0, dropped: 0, total: 0 };
    counters.set(h, c);
  }
  return c;
}

function setRate(h: VideoHandle, rate: number) {
  const v = h.el!;
  if (v.playbackRate === rate) return;
  v.playbackRate = rate;
  countersFor(h).rateChanges++;
}

/**
 * How long (s) a seek on a playing video takes to land and play on, learned in this window. A playing video
 * seeked to where the clock is *now* lands that much behind it, which on a slow seek is past the drift limit
 * again: seek, land behind, seek again, a freeze and a jump each time. So a playing seek aims ahead by this.
 */
let seekLead = 0.06;
const SEEK_LEAD_MAX = 0.3;

function seekTo(h: VideoHandle, time: number, wallMs: number, playing = false, rate = 1) {
  const v = h.el!;
  const end = v.duration > 0 ? v.duration - 0.05 : Infinity;
  v.currentTime = playing ? Math.min(end, time + seekLead * rate) : time;
  h.lastSeek = wallMs;
  h.seekPlaying = playing;
  const c = countersFor(h);
  c.seeks++;
  if (playing) c.playingSeeks++;
}

/** A playing seek landed: learn how long it took (called from the element's `seeked` event). */
function learnSeek(h: VideoHandle, wallMs: number) {
  if (!h.seekPlaying || h.el!.paused) return;
  h.seekPlaying = false;
  const took = (wallMs - h.lastSeek) / 1000;
  if (took > 0 && took < 2) seekLead = clamp(seekLead * 0.7 + took * 0.3, 0, SEEK_LEAD_MAX);
}

/** Sync counters of every playing video since the last call, then reset them. */
export function takeVideoSyncStats(): VideoSyncStat[] {
  const out: VideoSyncStat[] = [];
  for (const { player, c } of takeCodecStats()) {
    const w = c.worker;
    out.push({
      engine: "webcodecs",
      paused: !player.isPlaying || undefined,
      file: codecFileName(player.url),
      time: Math.round(player.video.currentTime * 100) / 100,
      rate: 1,
      // A restart of the decoder while playing is the WebCodecs player's hard seek: a visible jump.
      seeks: w?.restarts ?? 0,
      playingSeeks: w?.playingRestarts || undefined,
      rateChanges: 0,
      driftAvgMs: 0,
      driftMaxMs: Math.round(Math.max(0, c.lagMax) * 1000),
      dropped: c.skipped + (w?.stale ?? 0),
      frames: c.shown,
      late: c.late || undefined,
      skipped: c.skipped || undefined,
      stale: w?.stale || undefined,
      held: w?.held,
      gopMs: w?.gopMsMax,
      readMs: w?.readMsMax,
      sound: player.sound.state,
    });
  }
  for (const [h, c] of counters) {
    const v = h.el!;
    const q = typeof v.getVideoPlaybackQuality === "function" ? v.getVideoPlaybackQuality() : null;
    // A paused video belongs in the report only when it was seeked: parked on a frame it costs nothing,
    // and one seeked again and again while hidden is a fault that used to be invisible here.
    if (!v.paused || c.seeks > 0) {
      out.push({
        engine: "element",
        paused: v.paused || undefined,
        file: decodeURIComponent((v.currentSrc || v.src).split("/").pop() ?? ""),
        time: Math.round(v.currentTime * 100) / 100,
        rate: Math.round(v.playbackRate * 1000) / 1000,
        seeks: c.seeks,
        playingSeeks: c.playingSeeks || undefined,
        startLagMs: c.startLag ?? undefined,
        rateChanges: c.rateChanges,
        driftAvgMs: c.n ? Math.round((c.driftSum / c.n) * 1000) : 0,
        driftMaxMs: Math.round(c.driftMax * 1000),
        dropped: q ? q.droppedVideoFrames - c.dropped : 0,
        frames: q ? q.totalVideoFrames - c.total : 0,
      });
    }
    Object.assign(c, { seeks: 0, playingSeeks: 0, startLag: null, rateChanges: 0, driftSum: 0, driftMax: 0, n: 0, dropped: q?.droppedVideoFrames ?? 0, total: q?.totalVideoFrames ?? 0 });
  }
  return out;
}

/**
 * WebKit (the desktop app) decodes a seek on a paused <video> only for elements in the
 * document, so a paused scrub would keep showing the old frame. Park every video in an
 * invisible box on the page.
 */
let videoHost: HTMLDivElement | null = null;
function hostVideo(v: HTMLVideoElement) {
  if (typeof document === "undefined") return;
  if (!videoHost) {
    videoHost = document.createElement("div");
    videoHost.setAttribute("aria-hidden", "true");
    videoHost.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1";
    document.body.appendChild(videoHost);
  }
  v.style.cssText = "width:2px;height:2px";
  videoHost.appendChild(v);
}

/**
 * Load or unload a video element's file. Every warm element costs a platform decoder session and
 * holds the file's buffered data, and a webview with dozens of them (every clip of every actor in
 * the preview, the program and the output) starves the ones that are actually playing. A clip that
 * cannot come next is kept cold and warmed when it can (a local file is ready within ~200 ms).
 */
export function setWarm(h: VideoHandle, warm: boolean) {
  if (h.warm === warm) return;
  h.warm = warm;
  if (h.codec) {
    h.codec.setWarm(warm);
    return;
  }
  const v = h.el!;
  if (warm) {
    v.src = h.url;
    v.load();
  } else {
    v.pause();
    v.removeAttribute("src");
    v.load();
    h.shownTime = -1;
    h.correcting = 0;
    h.startPending = false;
  }
}

/**
 * WebKit hands an HEVC-with-alpha <video> to WebGL without its alpha: every pixel arrives opaque, so the
 * clear parts of a full-wall cut-out (a goat walking into a street) draw black over the plate. A WebCodecs
 * VideoFrame taken from the same element keeps the alpha (measured in the app: 3-4 ms for a 3072 x 768
 * frame). So on WebKit an alpha video's texture uploads a VideoFrame of the element's current picture,
 * taken whenever the texture is marked for upload. Returns the cleanup.
 */
function uploadAsVideoFrame(v: HTMLVideoElement, texture: THREE.VideoTexture): () => void {
  let frame: VideoFrame | null = null;
  const proto = Object.getPrototypeOf(THREE.VideoTexture.prototype) as object;
  const base = Object.getOwnPropertyDescriptor(proto, "needsUpdate")!;
  Object.defineProperty(texture, "needsUpdate", {
    configurable: true,
    set(value: boolean) {
      if (value && v.readyState >= 2) {
        try {
          const t0 = performance.now();
          const next = new VideoFrame(v);
          addUploadTime(performance.now() - t0);
          frame?.close();
          frame = next;
          texture.source.data = next as unknown as HTMLVideoElement; // three uploads a VideoFrame like an element
        } catch {
          // No picture to take yet (a seek in flight): keep the last frame.
        }
      }
      base.set!.call(texture, value);
    },
  });
  return () => {
    // VideoTexture.dispose cancels its frame callback on the element, so hand it back first.
    texture.source.data = v;
    frame?.close();
    frame = null;
  };
}

/** WebCodecs exists here (in the page; the worker has it wherever the page does). */
export const codecsAvailable = typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined" && typeof Worker !== "undefined";

/**
 * Does this file play with WebCodecs in this window? `engine` is the show's setting (output.videoEngine):
 * - "auto" (or unset) and "webcodecs": WebCodecs wherever the engine has it, Mac (WebKit) and Windows (WebView2).
 *   On the Mac every <video> is an AVPlayer that can hold the GPU process for seconds; on Windows it keeps both
 *   machines on the same, clock-driven path;
 * - "element": the platform player everywhere (the way back, on the night).
 * Either way only opaque MP4 / MOV files (H.264, closed GOPs, checked when opened): transparent cut-outs (HEVC-alpha
 * .mov twins, VP9-alpha WebM) and anything the worker refuses stay on the platform player.
 */
export function playsWithCodecs(engine: VideoEngine | undefined, url: string | null, opts: { alpha?: boolean; packed?: boolean } = {}): boolean {
  if (!url || engine === "element" || !codecsAvailable) return false;
  if (opts.alpha && !opts.packed) return false;
  let path = url.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as it is */
  }
  if (!/\.(mp4|m4v|mov)$/i.test(path)) return false;
  if (codecRefused(url)) return false;
  return true;
}

/**
 * One video per use, slaved to the shared scene clock: a <video>, or a WebCodecs player (see playsWithCodecs).
 * `lazy`: create it cold; the owner decides each frame whether it should be warm (`setWarm`).
 * `alpha`: the file has an alpha channel (see uploadAsVideoFrame).
 * `packed`: the file is alpha-packed (opaque H.264, colour over matte): uploaded like any opaque video,
 * never as a VideoFrame, and the media shader reads the matte from the bottom half.
 * `sound`: this use may play the file's sound (a WebCodecs player decodes it when it warms, not on its cue).
 */
export function useVideo(url: string | null, opts: { lazy?: boolean; alpha?: boolean; packed?: boolean; sound?: boolean } = {}): VideoHandle | null {
  // Created in an effect, never in render: React (StrictMode, concurrent rendering) may run a
  // render twice and keep one result, and a <video> made in the discarded render would stay in
  // the page, buffering and holding a decoder, with nothing left to remove it (seen: two decoders
  // per layer, 26 elements alive for a two-scene show).
  const [h, setH] = useState<VideoHandle | null>(null);
  // Bumped when a WebCodecs player gives up on its file: the next render picks the platform player.
  const [, setRefusals] = useState(0);
  const engine = useShow((s) => s.output.videoEngine);
  const lazy = !!opts.lazy;
  const packed = !!opts.packed;
  const alpha = !!opts.alpha && !packed && isWebKit && typeof VideoFrame !== "undefined";
  const codec = playsWithCodecs(engine, url, opts);
  const sound = !!opts.sound;
  useEffect(() => {
    if (h?.codec) h.codec.soundWanted = sound;
  }, [h, sound]);
  useEffect(() => {
    if (!url) {
      setH(null);
      return;
    }
    if (codec) {
      const player = new CodecPlayer(url, { lazy, packed });
      player.onFail = () => setRefusals((n) => n + 1);
      const handle: VideoHandle = { video: player.video, engine: "webcodecs", el: null, codec: player, texture: player.texture, url, warm: !lazy, lastSeek: 0, seekPlaying: false, startedAt: -1e12, startPending: false, shownTime: -1, correcting: 0, parked: true, framed: true, packed };
      setH(handle);
      return () => {
        player.dispose();
        setH((cur) => (cur === handle ? null : cur));
      };
    }
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    v.muted = true;
    v.loop = true;
    v.preload = "auto";
    if (!lazy) v.src = url;
    const texture = new THREE.VideoTexture(v);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.userData.alphaPacked = packed;
    const releaseFrame = alpha ? uploadAsVideoFrame(v, texture) : null;
    // Uploading an element that has no frame yet hangs WebKit: texImage2D asks the GPU process for the
    // picture over a sync IPC, and a player with none waits up to a second for it in a nested run loop that
    // serves every window's requests. At a TAKE, with new players in the operator and the output, those
    // waits nested a dozen deep and starved the output's request for seconds (sampled 2026-10-30: output
    // stuck in texImage2D -> videoFrameForCurrentTime, GPU process 12 deep in
    // waitForVideoOutputMediaDataWillChange), so the watchdog rebuilt the window and the music cut out.
    // VideoTexture uploads on requestVideoFrameCallback, which only fires once there is a frame (on
    // load, on each frame played, and after a paused seek on macOS 26). Our own extra uploads below wait
    // for the first one of each file.
    const hasFrameCallback = "requestVideoFrameCallback" in v;
    const arm = () => {
      handle.framed = !hasFrameCallback;
      if (hasFrameCallback) v.requestVideoFrameCallback(() => (handle.framed = true));
    };
    // Belt and braces for a paused frame (a seek while paused, a clip parked on its first frame).
    const refresh = () => {
      if (handle.framed) texture.needsUpdate = true;
    };
    v.addEventListener("seeked", () => {
      learnSeek(handle, now());
      refresh();
    });
    v.addEventListener("loadeddata", refresh);
    // A new file (a cold clip warmed) has no frame until it shows one.
    v.addEventListener("loadstart", arm);
    hostVideo(v);
    const handle: VideoHandle = { video: v, engine: "element", el: v, codec: null, texture, url, warm: !lazy, lastSeek: 0, seekPlaying: false, startedAt: -1e12, startPending: false, shownTime: -1, correcting: 0, parked: true, framed: false, packed };
    arm();
    setH(handle);
    return () => {
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
      releaseFrame?.();
      texture.dispose();
      counters.delete(handle);
      setH((cur) => (cur === handle ? null : cur));
    };
  }, [url, lazy, alpha, packed, codec]); // eslint-disable-line react-hooks/exhaustive-deps
  return h;
}

export function videoDuration(h: VideoHandle | null) {
  const d = h?.video.duration;
  return d && Number.isFinite(d) ? d : 0;
}

/**
 * Media time (s) for a clip that has played `mediaSeconds` of material (speed already
 * applied). Reverse clips run from the out point back to the in point.
 */
export function mediaTime(m: MediaSettings, mediaSeconds: number, duration: number): number {
  const end = m.endTime ?? (duration || 1e9);
  const len = Math.max(0.05, end - m.startTime);
  const e = Math.max(0, mediaSeconds);
  if (m.reverse) {
    const back = m.loop ? e % len : Math.min(e, len);
    return Math.max(m.startTime, end - 0.02 - back);
  }
  return m.loop ? m.startTime + (e % len) : Math.min(m.startTime + e, end - 0.02);
}

export interface SyncWant {
  play: boolean;
  time: number;
  rate: number;
  muted: boolean;
  volume: number;
  /** Sound for this computer only (the preview): stays on its default output, never the show's (engine/audioOutput.ts). */
  local?: boolean;
  /** Scrub backwards by seeking (browsers cannot play at negative rates). */
  reverse?: boolean;
  /**
   * The element loops by itself with this period (s) and the wanted time wraps with the same
   * period. Drift is then judged on the loop circle: around the wrap the two sides are never
   * exactly together, and the raw difference (almost a whole clip) used to force a hard seek
   * on every loop, each followed by seconds at catch-up speed.
   */
  loop?: number;
  /**
   * The media plays once and holds its last frame. The element must not loop natively: it would
   * wrap to the first frame at the end and show it until the next hard seek (seen: the opening's
   * first frame ghosting through its fade-out).
   */
  once?: boolean;
  /**
   * The media loops over [from, to) s of the file (an in/out-point loop; `loop` covers a whole-file one). Only the
   * WebCodecs player uses it: it decodes the loop's head ahead of the wrap, so the loop needs no seek.
   */
  segment?: LoopSpan;
}

/**
 * Keep a video element locked to the shared clock.
 *
 * WebKit's player (AVFoundation, the desktop app) stalls briefly on every seek and on every
 * playbackRate change, longer with sound. Correcting drift every frame therefore makes a
 * video fall further behind and judder (measured: 15-50 rate changes and 1-2 seeks a second,
 * ~10 of 24 frames shown). So a playing video is corrected rarely and in steps:
 * - drift within the dead band: normal speed, untouched (tighter for muted video, where a rate
 *   step is cheap and clip-actor cuts need matching frames; wider with sound);
 * - beyond it: one step of ±NUDGE until the drift is back under SETTLED (hysteresis);
 * - beyond SEEK_DRIFT, or across a loop wrap: a hard seek, at most every SEEK_GAP ms,
 *   then SEEK_GRACE ms for the player to settle before drift is judged again.
 * A video playing sound is never nudged: every playbackRate change rebuilds its audio stream, which on a
 * Bluetooth headset is a link renegotiation heard as stutter (measured on AirPods: ~8 rate changes in 6 s,
 * ~100 CoreAudio overloads in 13 s). It plays at its own rate and is re-seated with a seek past SOUND_SEEK_DRIFT.
 * Paused and reverse playback park on the wanted frame as before (that is what scrubbing needs).
 *
 * A video that starts from a parked frame (a clip on its cue, a layer shown) is left alone for START_GRACE ms:
 * a player needs a moment to get going (WebKit more than Chromium, and more with sound or with other players
 * starting at the same TAKE), and judging it during that moment read its start-up lag as drift. A clip with
 * sound past the old 0.25 s limit was hard-seeked within a few frames of its start, a freeze and a jump right
 * as it came on (the lion climbing onto the rock). A seek on a playing video aims ahead by the time seeks take
 * here (`seekLead`), so it lands on the clock and is not followed by another one.
 */
const DEAD_BAND = { sound: 0.12, muted: 0.05 };
const SETTLED = { sound: 0.04, muted: 0.02 };
const NUDGE = 0.05;
const SEEK_DRIFT = 0.6;
const SOUND_SEEK_DRIFT = 0.45;
const SEEK_GAP = 1500;
const SEEK_GRACE = 1000;
const START_GRACE = 1000;

export function syncVideo(h: VideoHandle, want: SyncWant, wallMs: number) {
  if (h.codec) {
    h.codec.sync(want, wallMs);
    return;
  }
  const v = h.el!;
  if (want.local && !v.dataset.localSound) {
    v.dataset.localSound = "1";
    void (v as { setSinkId?: (id: string) => Promise<void> }).setSinkId?.("").catch(() => {});
  }
  // Written only when they change: this runs for every video of every canvas on every frame, and each
  // write is a call into the platform player.
  if (v.muted !== want.muted) v.muted = want.muted;
  const volume = clamp(want.volume, 0, 1);
  if (v.volume !== volume) v.volume = volume;
  if (want.once !== undefined && v.loop === want.once) v.loop = !want.once;
  if (v.readyState < 1) return;
  let drift = v.currentTime - want.time;
  // Played to the end once: park on the last frame (play() on an ended element restarts it).
  const atEnd = !!want.once && v.duration > 0 && want.time >= v.duration - 0.05;
  if (!want.play || want.reverse || atEnd) {
    h.parked = true;
    if (!v.paused) v.pause();
    // Paused: park on the wanted frame (follows a scrub closely). Reverse: at most ~12 seeks a second.
    const gap = want.reverse ? 80 : 40;
    if (Math.abs(drift) > (want.reverse ? 0.02 : 0.02) && !v.seeking && wallMs - h.lastSeek > gap) {
      seekTo(h, want.time, wallMs);
    }
    // Belt and braces for a paused frame: upload it whenever the parked time changes, even if no 'seeked' event arrives.
    if (h.framed && !v.seeking && v.readyState >= 2 && v.currentTime !== h.shownTime) {
      h.shownTime = v.currentTime;
      h.texture.needsUpdate = true;
    }
    return;
  }
  const rate = Math.max(0.0625, Math.min(16, want.rate));
  const period = want.loop && want.loop > 0.1 && v.loop ? want.loop : 0;
  if (period) drift -= Math.round(drift / period) * period;
  const wrapped = !period && Math.abs(drift) > (v.duration || 1e9) / 2;
  if (!v.paused && !v.seeking) {
    const c = countersFor(h);
    c.driftSum += Math.abs(drift);
    c.driftMax = Math.max(c.driftMax, Math.abs(drift));
    c.n++;
  }
  const sinceSeek = wallMs - h.lastSeek;
  const starting = h.parked;
  h.parked = false;
  if (starting) {
    h.startedAt = wallMs;
    h.startPending = true;
  }
  if (starting && (Math.abs(drift) > DEAD_BAND.sound || wrapped)) {
    // Starting from a parked frame away from the clock (a hidden layer shown and restarted): land first, whatever
    // the grace, or the old position plays (and is heard) until the next hard seek, ~1.5 s later. Once per start:
    // a 4K seek outlasts several frames, and seeking again each frame would keep it at the first frame.
    seekTo(h, want.time, wallMs, true, rate);
    h.correcting = 0;
    setRate(h, rate);
  } else if (v.seeking || sinceSeek < SEEK_GRACE || wallMs - h.startedAt < START_GRACE) {
    // Let the player get going (or land after a seek) and settle before judging drift.
  } else if ((Math.abs(drift) > (v.muted ? SEEK_DRIFT : SOUND_SEEK_DRIFT) || wrapped) && sinceSeek > SEEK_GAP) {
    noteStart(h, drift);
    seekTo(h, want.time, wallMs, true, rate);
    h.correcting = 0;
    setRate(h, rate);
  } else if (!v.muted) {
    noteStart(h, drift);
    h.correcting = 0;
    setRate(h, rate);
  } else {
    noteStart(h, drift);
    const mode = v.muted ? "muted" : "sound";
    if (h.correcting === 0 && Math.abs(drift) > DEAD_BAND[mode]) h.correcting = drift < 0 ? 1 : -1;
    else if (h.correcting !== 0 && (Math.abs(drift) < SETTLED[mode] || Math.sign(drift) === h.correcting)) h.correcting = 0;
    setRate(h, h.correcting === 0 ? rate : rate * (1 + h.correcting * NUDGE));
  }
  if (v.paused) {
    v.play().catch(() => {
      // Autoplay with sound can be blocked; fall back to muted playback.
      v.muted = true;
      void v.play().catch(() => {});
    });
  }
}

/** Record how far behind the clock a started video still was once its start grace was over (sync stats). */
function noteStart(h: VideoHandle, drift: number) {
  if (!h.startPending) return;
  h.startPending = false;
  countersFor(h).startLag = Math.round(-drift * 1000);
}

/** How long a playing seek takes in this window (s): diagnostics. */
export function videoSeekLead(): number {
  return Math.round(seekLead * 1000) / 1000;
}

// Dev-only: read the sync counters of this window from the console / agent eval (window.__slsVideoStats()).
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __slsVideoStats?: unknown }).__slsVideoStats = takeVideoSyncStats;
