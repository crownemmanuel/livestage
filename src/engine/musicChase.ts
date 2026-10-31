// The music chase: when the operator jumps (fires a cue out of order, or takes a scene out of running order),
// the music that would be playing there had the show run in sequence starts at the second it would have
// reached, with a short fade-in, and music that would not be playing there fades out. The timeline is worked out
// from the cues (core/music.ts); GO cues use the timings learned from runs in sequence (Project.cueTimings).

import { sceneNow } from "@/core/clock";
import { uid } from "@/core/ids";
import { lifePlaying, nominalMusic, soundKey, soundLives, type NominalSound } from "@/core/music";
import type { SceneRuntime, SoundEvent } from "@/core/types";
import { useProject } from "@/store/project";
import { ioLog } from "./io";
import { knownDuration, probeDurations } from "./transport";

/** Seconds a chased sound fades out over when it would not be playing at the point jumped to. */
const STOP_FADE = 1;

export const chaseMusicOn = () => useProject.getState().project.chaseMusic !== false;

/** Length (s) of a sound file, when known. */
export function soundDuration(assetId: string): number | undefined {
  const a = useProject.getState().project.assets.find((x) => x.id === assetId);
  return a?.probe?.duration_s || knownDuration(assetId);
}

/** Learn the lengths of the show's cue sounds (once each), waiting at most `waitMs`. */
export function learnSoundLengths(waitMs = 1500): Promise<void> {
  const p = useProject.getState().project;
  const ids = new Set<string>();
  for (const s of p.scenes) for (const c of s.cues) for (const a of c.actions) if (a.type === "sound" && a.assetId && !soundDuration(a.assetId)) ids.add(a.assetId);
  if (!ids.size) return Promise.resolve();
  return Promise.race([probeDurations(p.assets, [...ids]), new Promise<void>((r) => setTimeout(r, waitMs))]);
}

const assetName = (id: string) => useProject.getState().project.assets.find((a) => a.id === id)?.name ?? id;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function note(started: NominalSound[], stopped: string[]) {
  const parts = started.map((s) => `${assetName(s.assetId)} → ${clock(s.offset)}`);
  if (stopped.length) parts.push(`${stopped.length} faded`);
  if (parts.length) ioLog("info", `Music chased: ${parts.join(", ")}`);
}

const toEvent = (s: NominalSound, at: number): SoundEvent => {
  // `at` stays where the file's (trimmed) start would have been, so it is at `offset` now.
  const trim = s.trimStart ?? 0;
  // Level changes are timed from its start: keep that start where it was (a loop has wrapped its offset).
  const since = s.levels?.length && s.since != null ? s.since : s.offset - trim;
  const ev: SoundEvent = { id: uid("snd"), assetId: s.assetId, at: at - since * 1000, volume: s.volume, keepPlaying: s.keepPlaying, chase: true };
  if (s.loop) ev.loop = true;
  if (trim > 0) ev.trimStart = trim;
  if (s.fadeOut) ev.fadeOut = s.fadeOut;
  if (s.levels?.length) ev.levels = s.levels;
  return ev;
};

/** What would be playing just before cue `cueIndex` of a scene fires (null: as it is taken), for reports. */
export function musicAt(sceneId: string, cueIndex: number | null) {
  return nominalMusic(useProject.getState().project, sceneId, cueIndex, soundDuration);
}

/** Sound events a scene taken out of running order starts with (scene time 0 = the TAKE). */
export function chaseForTake(sceneId: string): SoundEvent[] {
  if (!chaseMusicOn()) return [];
  const m = musicAt(sceneId, null);
  if (!m) return [];
  note(m.sounds, []);
  return m.sounds.map((s) => toEvent(s, 0));
}

/**
 * The live run jumps to cue `index`: sound events that start the music missing there and fade out the music
 * that would not be playing there. Music already playing that should be keeps playing where it is.
 */
export function chaseForCue(rt: SceneRuntime, index: number): SoundEvent[] {
  if (!chaseMusicOn()) return [];
  const m = musicAt(rt.scene.id, index);
  if (!m) return [];
  const t = sceneNow(rt);
  const playing = soundLives(rt.sounds ?? [], soundDuration).filter((l) => lifePlaying(l, t));
  const want = new Set(m.sounds.map((s) => s.assetId));
  const have = new Set(playing.map((l) => l.ev.assetId));
  const start = m.sounds.filter((s) => !have.has(s.assetId));
  const stop = [...new Set(playing.filter((l) => !want.has(l.ev.assetId)).map((l) => l.ev.assetId))];
  note(start, stop);
  const out = start.map((s) => toEvent(s, t));
  if (stop.length) out.push({ id: uid("snd"), assetId: "", at: t, volume: 0, fadeOthers: { which: stop.map(soundKey), fade: STOP_FADE } });
  return out;
}
