// Video transport: hold, scrub and resume the media of a running scene, on the preview or the
// live wall. It is built on the scene clock (the same one Freeze uses), so it stays a pure
// function of timestamped events: hold = clock.pausedAt, scrub = a new clock.base (or a clip
// actor's segment), resume = the base shifted by the time held. Every window, and a reload,
// computes the same frame. Rules for markers and timed cues: see pollMarkers in operator.ts
// and docs/VIDEO_TRANSPORT.md.

import { sceneNow } from "@/core/clock";
import { clipStateAt } from "@/core/clipActor";
import { playableUrl } from "@/core/platform";
import { mediaElapsed, type Command } from "@/core/runtime";
import type { Asset, SceneRuntime } from "@/core/types";
import { useShow, type Target } from "@/store/show";
import { probeDuration } from "./operator";

// ---------------------------------------------------------------- durations

const durationCache = new Map<string, number>();
const probing = new Map<string, Promise<number | null>>();

/** Length (s) of a video asset, if it has been probed. */
export function knownDuration(assetId: string | null | undefined): number | undefined {
  return assetId ? durationCache.get(assetId) : undefined;
}

/** Probe the lengths of these video assets (once each); resolves when all are known or failed. */
export function probeDurations(assets: Asset[], ids: string[]): Promise<void> {
  const jobs = ids.map((id) => {
    if (durationCache.has(id)) return Promise.resolve();
    let job = probing.get(id);
    if (!job) {
      const url = playableUrl(assets.find((x) => x.id === id));
      if (!url) return Promise.resolve();
      job = probeDuration(url).then((d) => {
        probing.delete(id);
        if (d) durationCache.set(id, d);
        return d;
      });
      probing.set(id, job);
    }
    return job.then(() => {});
  });
  return Promise.all(jobs).then(() => {});
}

/** Video assets a scene's backgrounds and video layers play (clip lengths are stored on the clips). */
export function mediaAssetIds(rt: SceneRuntime): string[] {
  return rt.scene.components.flatMap((c) => (c.kind === "background" || c.kind === "video" ? (c.media.assetId ? [c.media.assetId] : []) : []));
}

// ---------------------------------------------------------------- sources

export interface Source {
  /** "compId" or "actorId:clipId" (same keys as the marker hosts). */
  key: string;
  label: string;
  playing: boolean;
  duration: number;
  /** Media seconds now. */
  pos: number;
  /** The command that puts this video at v seconds. */
  seek: (v: number) => Command;
}

/** Every video of the running scene that can be scrubbed, with where it is now. */
export function videoSources(rt: SceneRuntime, assets: Asset[]): Source[] {
  const t = sceneNow(rt);
  const out: Source[] = [];
  const isVideo = (id: string | null) => !!id && assets.find((a) => a.id === id)?.type === "video";
  for (const c of rt.scene.components) {
    if (c.kind === "clipActor") {
      // Every clip can be scrubbed, playing or not: scrubbing puts the actor on that clip.
      const st = clipStateAt(c, rt.clipActors?.[c.id], t);
      for (const k of c.clips) {
        if (!k.assetId && !k.cutoutAssetId) continue;
        const active = st.clip?.id === k.id;
        out.push({
          key: `${c.id}:${k.id}`,
          label: `${c.name} · ${k.name}`,
          playing: active,
          duration: Math.max(0.05, k.duration),
          pos: active ? st.localT : 0,
          seek: (v) => ({ type: "clip.seek", actorId: c.id, clipId: k.id, offset: v }),
        });
      }
    } else if (c.kind === "background" && c.source === "media" && rt.background.current === c.id && isVideo(c.media.assetId)) {
      const D = durationCache.get(c.media.assetId!);
      if (!D) continue;
      const startAt = rt.background.changedAt > -1e8 ? rt.background.changedAt : 0;
      const rate = c.media.playbackRate || 1;
      const el = mediaElapsed(rt, c.id, startAt, t, rate);
      const iter = c.media.loop ? Math.floor(el / D) : 0;
      out.push({ key: c.id, label: `${c.name} (background)`, playing: true, duration: D, pos: c.media.loop ? el % D : Math.min(el, D), seek: (v) => ({ type: "seek", t: Math.max(0, startAt + ((iter * D + v) / rate) * 1000) }) });
    } else if (c.kind === "video" && rt.layers[c.id]?.visible && isVideo(c.media.assetId)) {
      const D = durationCache.get(c.media.assetId!);
      if (!D) continue;
      const l = rt.layers[c.id];
      const rate = c.media.playbackRate || 1;
      const el = mediaElapsed(rt, c.id, l.startAt, t, rate);
      const iter = c.media.loop ? Math.floor(el / D) : 0;
      out.push({ key: c.id, label: c.name, playing: true, duration: D, pos: c.media.loop ? el % D : Math.min(el, D), seek: (v) => ({ type: "seek", t: Math.max(0, l.startAt + ((iter * D + v) / rate) * 1000) }) });
    }
  }
  return out;
}

/** The video the transport follows by default: the one picked, else the first playing one that is not a loop. */
export function mainSource(sources: Source[], picked?: string | null): Source | undefined {
  const playing = sources.filter((s) => s.playing);
  return sources.find((s) => s.key === picked) ?? playing.find((s) => !s.label.includes("(loop)")) ?? playing[0] ?? sources[0];
}

// ---------------------------------------------------------------- operations

function rtOf(target: Target) {
  const s = useShow.getState();
  return target === "program" ? (s.program.standby ? null : s.program.runtime) : s.preview;
}

export const isHeld = (target: Target) => rtOf(target)?.clock.pausedAt != null;

/** Hold (freeze the scene on this frame), resume, or toggle. */
export function hold(target: Target, op: "pause" | "resume" | "toggle") {
  if (rtOf(target)) useShow.getState().dispatch(target, { type: "clock", op });
}

/**
 * Put a video at `seconds`. The live wall only scrubs while it is held: an accidental drag
 * must never jump what the audience sees. Returns false when refused.
 */
export function seekSource(target: Target, src: Source, seconds: number): boolean {
  if (target === "program" && !isHeld("program")) return false;
  useShow.getState().dispatch(target, src.seek(Math.max(0, Math.min(src.duration, seconds))));
  return true;
}

/** Keyboard: P holds / resumes the live scene when it is the selected one, otherwise the preview (the same rule as G). */
export function toggleHoldFor(selectedSceneId: string | null) {
  const s = useShow.getState();
  const live = s.program.runtime;
  hold(live && !s.program.standby && live.scene.id === selectedSceneId ? "program" : "preview", "toggle");
}
