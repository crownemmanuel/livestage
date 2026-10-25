// Live mixer: what is making sound on the wall right now, and the operator's volume trim for each.
// The trims live in ProgramState.mix (see there); this module only lists the sources.

import { clipStateAt } from "@/core/clipActor";
import { videoAudioFade } from "@/core/runtime";
import { sceneNow } from "@/core/clock";
import type { Asset, AudioRole, SceneComponent, SceneRuntime } from "@/core/types";
import { useShow } from "@/store/show";
import { playingCueSounds, soundMixKey } from "./audio";

export interface MixSource {
  /** Mixer key (ProgramState.mix). */
  key: string;
  kind: "sound" | "video" | "background" | "videoActor";
  /** Cue sounds: music, voice, ambience or effect (the asset's `audioRole`, or guessed from its name). */
  role?: AudioRole | null;
  name: string;
  /** The operator's trim, 0..1 (1 = as designed). */
  level: number;
  /** The volume the show file gives it (before the trim). */
  designed: number;
}

/** Asset ids of the cue sounds playing in whichever window is the audio host. */
function hostSounds(): string[] {
  const s = useShow.getState();
  const outputUp = !!s.outputStatus && Date.now() - s.outputSeenAt < 3500;
  if (outputUp) return s.outputStatus?.sounds ?? [];
  return playingCueSounds();
}

/** The kind of a sound file: its `audioRole`, else a guess from the name (narration, song, ambience, sfx…), else null. */
export function audioRoleOf(asset: Asset | undefined): AudioRole | null {
  if (!asset) return null;
  if (asset.audioRole) return asset.audioRole;
  const n = asset.name;
  if (/narrat|\bnar-|voice|\bvo\b|dialogue|speech|announce|narrator/i.test(n)) return "voice";
  if (/\b(music|song|bed|track|underscore|score|hymn|psalm)\b/i.test(n)) return "music";
  if (/ambien|atmos|room tone|\bwind\b|crowd/i.test(n)) return "ambience";
  if (/\bsfx\b|\bfx\b|effect|thunder|impact|whoosh|kids|shout/i.test(n)) return "sfx";
  return null;
}

const isVideo = (assets: Asset[], id: string | null | undefined) => !!id && assets.find((a) => a.id === id)?.type === "video";

function mediaSource(c: SceneComponent, rt: SceneRuntime, assets: Asset[], t: number): Omit<MixSource, "level"> | null {
  if (c.kind === "video") {
    if (c.media.muted || c.media.volume <= 0 || !rt.layers[c.id]?.visible || !isVideo(assets, c.media.assetId)) return null;
    return { key: c.id, kind: "video", name: c.name, designed: c.media.volume };
  }
  if (c.kind === "background") {
    if (rt.background.current !== c.id || c.media.muted || c.media.volume <= 0 || !isVideo(assets, c.media.assetId)) return null;
    return { key: c.id, kind: "background", name: c.name, designed: c.media.volume };
  }
  if (c.kind === "clipActor") {
    if (c.muted || c.volume <= 0 || !clipStateAt(c, rt.clipActors?.[c.id], t).clip) return null;
    return { key: c.id, kind: "videoActor", name: c.name, designed: c.volume };
  }
  return null;
}

/** Everything sounding on the live wall now: cue sounds first, then video with its sound on. */
export function liveAudioSources(): MixSource[] {
  const s = useShow.getState();
  const mix = s.program.mix ?? {};
  const out: MixSource[] = [];
  for (const assetId of hostSounds()) {
    const key = soundMixKey(assetId);
    const asset = s.assets.find((a) => a.id === assetId);
    out.push({ key, kind: "sound", role: audioRoleOf(asset), name: asset?.name ?? assetId, level: mix[key] ?? 1, designed: 1 });
  }
  const rt = s.program.runtime;
  if (rt) {
    const t = sceneNow(rt);
    for (const c of rt.scene.components) {
      const m = mediaSource(c, rt, s.assets, t);
      if (m && videoAudioFade(rt, m.key, t) > 0) out.push({ ...m, level: mix[m.key] ?? 1 });
    }
  }
  return out;
}
