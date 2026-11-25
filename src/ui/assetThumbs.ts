// Thumbnails and picture aspects for library assets: images show themselves, videos get one
// frame grabbed into a small JPEG. Generated lazily (two at a time) and kept for the session.

import { useEffect } from "react";
import { create } from "zustand";
import { playableUrl } from "@/core/platform";
import type { Asset } from "@/core/types";

interface Info {
  /** Image URL to show, or null while pending / when no frame could be had. */
  src: string | null;
  /** width / height of the picture. */
  aspect: number | null;
  duration?: number;
}

const useInfo = create<{ map: Record<string, Info & { source: string }> }>(() => ({ map: {} }));
const queued = new Set<string>();
const latestSource = new Map<string, string>();
const queue: Asset[] = [];
let running = 0;

function sourceOf(a: Asset): string {
  return JSON.stringify([a.type, playableUrl(a), !!a.alphaPacked]);
}

function done(a: Asset, info: Info) {
  const source = sourceOf(a);
  if (latestSource.get(a.id) !== source) return;
  useInfo.setState((s) => ({ map: { ...s.map, [a.id]: { ...info, source } } }));
}

function grabVideo(a: Asset): Promise<Info> {
  return new Promise((resolve) => {
    const url = playableUrl(a);
    if (!url) return resolve({ src: null, aspect: null });
    const v = document.createElement("video");
    let settled = false;
    const finish = (info: Info) => {
      if (settled) return;
      settled = true;
      v.removeAttribute("src");
      v.load();
      resolve(info);
    };
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 3);
    };
    const capture = () => {
      if (settled) return;
      const pictureHeight = v.videoHeight / (a.alphaPacked ? 2 : 1);
      const aspect = v.videoWidth && pictureHeight ? v.videoWidth / pictureHeight : null;
      try {
        const c = document.createElement("canvas");
        c.width = 240;
        c.height = Math.round(240 / (aspect ?? 16 / 9));
        c.getContext("2d")!.drawImage(v, 0, 0, v.videoWidth, pictureHeight, 0, 0, c.width, c.height);
        finish({ src: c.toDataURL("image/jpeg", 0.72), aspect, duration: Number.isFinite(v.duration) ? v.duration : undefined });
      } catch {
        finish({ src: null, aspect, duration: Number.isFinite(v.duration) ? v.duration : undefined });
      }
    };
    // WebKit can signal seeked before canvas has the decoded picture.
    v.onseeked = () => { setTimeout(capture, 100); };
    v.onerror = () => finish({ src: null, aspect: null });
    setTimeout(() => finish({ src: null, aspect: null }), 8000);
    v.src = url;
  });
}

function grabImage(a: Asset): Promise<Info> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ src: a.url, aspect: img.naturalWidth / Math.max(1, img.naturalHeight) });
    img.onerror = () => resolve({ src: null, aspect: null });
    img.src = a.url;
  });
}

function pump() {
  while (running < 2 && queue.length) {
    const a = queue.shift()!;
    running++;
    void (a.type === "video" ? grabVideo(a) : grabImage(a))
      .then((info) => done(a, info))
      .finally(() => {
        queued.delete(JSON.stringify([a.id, sourceOf(a)]));
        running--;
        pump();
      });
  }
}

/** Thumbnail + aspect for an asset (requests it on first use). Audio and models have none. */
export function useAssetInfo(a: Asset | undefined | null): Info | null {
  const info = useInfo((s) => (a ? s.map[a.id] : undefined));
  const source = a ? sourceOf(a) : null;
  useEffect(() => {
    if (!a || (a.type !== "video" && a.type !== "image")) return;
    latestSource.set(a.id, sourceOf(a));
    const key = JSON.stringify([a.id, source]);
    if (info?.source === source || queued.has(key)) return;
    queued.add(key);
    queue.push(a);
    pump();
  }, [a, source, info?.source]);
  return info?.source === source ? info : null;
}

/** Aspect of an asset if known (for on-screen boxes); requests it like useAssetInfo. */
export function assetAspect(id: string | null | undefined): number | null {
  return id ? (useInfo.getState().map[id]?.aspect ?? null) : null;
}
