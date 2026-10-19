import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { clamp } from "@/core/clock";
import type { MediaSettings } from "@/core/types";

export interface VideoHandle {
  video: HTMLVideoElement;
  texture: THREE.VideoTexture;
  lastSeek: number;
  /** currentTime of the last frame uploaded while paused. */
  shownTime: number;
  /** Drift correction in progress while playing: -1 slowing down, +1 catching up, 0 none. */
  correcting: -1 | 0 | 1;
}

// ---------------------------------------------------------------- sync diagnostics

/** What one playing video did in the last report interval (the output heartbeat reads it once a second). */
export interface VideoSyncStat {
  file: string;
  time: number;
  rate: number;
  seeks: number;
  rateChanges: number;
  driftAvgMs: number;
  driftMaxMs: number;
  dropped: number;
  frames: number;
}

interface SyncCounters {
  seeks: number;
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
    c = { seeks: 0, rateChanges: 0, driftSum: 0, driftMax: 0, n: 0, dropped: 0, total: 0 };
    counters.set(h, c);
  }
  return c;
}

function setRate(h: VideoHandle, rate: number) {
  if (h.video.playbackRate === rate) return;
  h.video.playbackRate = rate;
  countersFor(h).rateChanges++;
}

function seekTo(h: VideoHandle, time: number, wallMs: number) {
  h.video.currentTime = time;
  h.lastSeek = wallMs;
  countersFor(h).seeks++;
}

/** Sync counters of every playing video since the last call, then reset them. */
export function takeVideoSyncStats(): VideoSyncStat[] {
  const out: VideoSyncStat[] = [];
  for (const [h, c] of counters) {
    const v = h.video;
    const q = typeof v.getVideoPlaybackQuality === "function" ? v.getVideoPlaybackQuality() : null;
    if (!v.paused) {
      out.push({
        file: decodeURIComponent((v.currentSrc || v.src).split("/").pop() ?? ""),
        time: Math.round(v.currentTime * 100) / 100,
        rate: Math.round(v.playbackRate * 1000) / 1000,
        seeks: c.seeks,
        rateChanges: c.rateChanges,
        driftAvgMs: c.n ? Math.round((c.driftSum / c.n) * 1000) : 0,
        driftMaxMs: Math.round(c.driftMax * 1000),
        dropped: q ? q.droppedVideoFrames - c.dropped : 0,
        frames: q ? q.totalVideoFrames - c.total : 0,
      });
    }
    Object.assign(c, { seeks: 0, rateChanges: 0, driftSum: 0, driftMax: 0, n: 0, dropped: q?.droppedVideoFrames ?? 0, total: q?.totalVideoFrames ?? 0 });
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

/** One <video> per use; playback is slaved to the shared scene clock. */
export function useVideo(url: string | null): VideoHandle | null {
  const h = useMemo(() => {
    if (!url) return null;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    v.muted = true;
    v.loop = true;
    v.preload = "auto";
    v.src = url;
    const texture = new THREE.VideoTexture(v);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // VideoTexture refreshes on requestVideoFrameCallback, which WebKit does not fire for a
    // seek on a paused video: scrubbing or parking a paused clip would never reach the screen.
    const refresh = () => {
      texture.needsUpdate = true;
    };
    v.addEventListener("seeked", refresh);
    v.addEventListener("loadeddata", refresh);
    hostVideo(v);
    return { video: v, texture, lastSeek: 0, shownTime: -1, correcting: 0 as const };
  }, [url]);
  useEffect(
    () => () => {
      if (!h) return;
      h.video.pause();
      h.video.removeAttribute("src");
      h.video.load();
      h.video.remove();
      h.texture.dispose();
      counters.delete(h);
    },
    [h],
  );
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
  /** Scrub backwards by seeking (browsers cannot play at negative rates). */
  reverse?: boolean;
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
 * Paused and reverse playback park on the wanted frame as before (that is what scrubbing needs).
 */
const DEAD_BAND = { sound: 0.12, muted: 0.05 };
const SETTLED = { sound: 0.04, muted: 0.02 };
const NUDGE = 0.05;
const SEEK_DRIFT = 0.6;
const SEEK_GAP = 1500;
const SEEK_GRACE = 1000;

export function syncVideo(h: VideoHandle, want: SyncWant, wallMs: number) {
  const v = h.video;
  v.muted = want.muted;
  v.volume = clamp(want.volume, 0, 1);
  if (v.readyState < 1) return;
  const drift = v.currentTime - want.time;
  if (!want.play || want.reverse) {
    if (!v.paused) v.pause();
    // Paused: park on the wanted frame (follows a scrub closely). Reverse: at most ~12 seeks a second.
    const gap = want.reverse ? 80 : 40;
    if (Math.abs(drift) > (want.reverse ? 0.02 : 0.02) && !v.seeking && wallMs - h.lastSeek > gap) {
      seekTo(h, want.time, wallMs);
    }
    // Belt and braces for a paused frame: upload it whenever the parked time changes, even if no 'seeked' event arrives.
    if (!v.seeking && v.readyState >= 2 && v.currentTime !== h.shownTime) {
      h.shownTime = v.currentTime;
      h.texture.needsUpdate = true;
    }
    return;
  }
  const rate = Math.max(0.0625, Math.min(16, want.rate));
  const wrapped = Math.abs(drift) > (v.duration || 1e9) / 2;
  if (!v.paused && !v.seeking) {
    const c = countersFor(h);
    c.driftSum += Math.abs(drift);
    c.driftMax = Math.max(c.driftMax, Math.abs(drift));
    c.n++;
  }
  const sinceSeek = wallMs - h.lastSeek;
  if (v.seeking || sinceSeek < SEEK_GRACE) {
    // Let the player land and settle before judging drift again.
  } else if ((Math.abs(drift) > SEEK_DRIFT || wrapped) && sinceSeek > SEEK_GAP) {
    seekTo(h, want.time, wallMs);
    h.correcting = 0;
    setRate(h, rate);
  } else {
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
