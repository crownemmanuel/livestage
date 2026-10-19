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
    return { video: v, texture, lastSeek: 0, shownTime: -1 };
  }, [url]);
  useEffect(
    () => () => {
      if (!h) return;
      h.video.pause();
      h.video.removeAttribute("src");
      h.video.load();
      h.video.remove();
      h.texture.dispose();
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
 * Keep a video element locked to the shared clock: hard-seek on large drift,
 * nudge the playback rate for small drift (seeking every frame stutters).
 */
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
      v.currentTime = want.time;
      h.lastSeek = wallMs;
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
  if ((Math.abs(drift) > 0.3 || wrapped) && !v.seeking && wallMs - h.lastSeek > 400) {
    v.currentTime = want.time;
    h.lastSeek = wallMs;
    v.playbackRate = rate;
  } else if (Math.abs(drift) > 0.03) {
    v.playbackRate = Math.max(0.1, rate * (1 - clamp(drift, -0.25, 0.25) * 0.6));
  } else if (Math.abs(v.playbackRate - rate) > 0.001) {
    v.playbackRate = rate;
  }
  if (v.paused) {
    v.play().catch(() => {
      // Autoplay with sound can be blocked; fall back to muted playback.
      v.muted = true;
      void v.play().catch(() => {});
    });
  }
}
