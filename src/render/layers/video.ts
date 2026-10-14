import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { clamp } from "@/core/clock";
import type { MediaSettings } from "@/core/types";

export interface VideoHandle {
  video: HTMLVideoElement;
  texture: THREE.VideoTexture;
  lastSeek: number;
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
    return { video: v, texture, lastSeek: 0 };
  }, [url]);
  useEffect(
    () => () => {
      if (!h) return;
      h.video.pause();
      h.video.removeAttribute("src");
      h.video.load();
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

/** Media time (s) for a clip that has been playing for `elapsed` seconds. */
export function mediaTime(m: MediaSettings, elapsed: number, duration: number): number {
  const end = m.endTime ?? (duration || 1e9);
  const len = Math.max(0.05, end - m.startTime);
  const e = Math.max(0, elapsed) * m.playbackRate;
  return m.loop ? m.startTime + (e % len) : Math.min(m.startTime + e, end - 0.02);
}

export interface SyncWant {
  play: boolean;
  time: number;
  rate: number;
  muted: boolean;
  volume: number;
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
  if (!want.play) {
    if (!v.paused) v.pause();
    if (Math.abs(drift) > 0.05 && !v.seeking && wallMs - h.lastSeek > 120) {
      v.currentTime = want.time;
      h.lastSeek = wallMs;
    }
    return;
  }
  const wrapped = Math.abs(drift) > (v.duration || 1e9) / 2;
  if ((Math.abs(drift) > 0.3 || wrapped) && !v.seeking && wallMs - h.lastSeek > 400) {
    v.currentTime = want.time;
    h.lastSeek = wallMs;
    v.playbackRate = want.rate;
  } else if (Math.abs(drift) > 0.03) {
    v.playbackRate = Math.max(0.1, want.rate * (1 - clamp(drift, -0.25, 0.25) * 0.6));
  } else {
    v.playbackRate = want.rate;
  }
  if (v.paused) {
    v.play().catch(() => {
      // Autoplay with sound can be blocked; fall back to muted playback.
      v.muted = true;
      void v.play().catch(() => {});
    });
  }
}
