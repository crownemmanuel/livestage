// Music over time, worked out from the cues alone (pure: no audio, no store).
//
// - soundLives: of a run's sound events, which are still sounding at a moment and when each fades out. The audio
//   host uses it to bring music back after a restart; the reducer to keep the live ones when it trims the list.
// - nominalMusic: the music that would be playing at a scene (and cue) had the show run in sequence from the top,
//   and how far into each file. The music chase uses it when the operator jumps; nothing per song is stored.
//
// Cue times on the nominal timeline: a time cue at its `at`, a follow cue `after` seconds after the cue before it,
// a video cue when its marker is reached on the media that carries it, a GO cue when it last fired in a run of the
// scene in sequence (Project.cueTimings), or as soon as the cue before it fired when it never has. Actions add their
// delay. A scene ends at its first takeScene action (or when the next scene was last taken, or after its last
// action) and the next scene in the running order follows: music marked keep playing carries on into it (unless it
// stops carried sounds), the rest fades out, as on the wall.

import { sceneNow } from "./clock";
import { initialSegments, scheduleClip } from "./clipActor";
import { cueMarkers } from "./markers";
import type { Cue, CueAction, Project, Scene, SceneRuntime, SoundEvent, SoundLevel } from "./types";

/** Mixer key of a cue sound (see ProgramState.mix). */
export const soundKey = (assetId: string) => `sound:${assetId}`;

/** How long (s) a sound replaced by a new copy of itself takes to go (engine/audio.ts). */
const REPLACE_FADE = 0.15;
/** How the wall fades out sounds left behind by a TAKE (engine/audio.ts stopSoundsOfOtherRuns). */
const LEFT_BEHIND_FADE = 0.8;
const CARRIED_STOP_FADE = 3;

export interface SoundLife {
  ev: SoundEvent;
  /** Time (ms, the events' clock) its fade-out starts; null = nothing stops it (it may still end by itself). */
  fadeFrom: number | null;
  /** Seconds that fade takes. */
  fadeSecs: number;
  /** Time (ms) it ends by itself (a sound that does not loop, length known); null = loops or unknown. */
  endsAt: number | null;
}

/**
 * When each sound event stops: replaced by a later copy of the same file, faded by a later sound's fadeOthers
 * (or a chase's stop) when it was already playing as that fade began, or at the end of its file. Events are in the order they were fired. Stop-only events
 * (no assetId) are left out of the result.
 */
export function soundLives(events: SoundEvent[], duration?: (assetId: string) => number | undefined): SoundLife[] {
  const out: SoundLife[] = [];
  events.forEach((ev, i) => {
    if (!ev.assetId) return;
    let fadeFrom: number | null = null;
    let fadeSecs = 0;
    const kill = (from: number, secs: number) => {
      if (fadeFrom === null || from < fadeFrom) {
        fadeFrom = from;
        fadeSecs = secs;
      }
    };
    for (const k of events.slice(i + 1)) {
      if (k.assetId === ev.assetId) kill(k.at, REPLACE_FADE);
      else if (k.fadeOthers && (k.fadeOthers.which === "all" || k.fadeOthers.which.includes(soundKey(ev.assetId)))) {
        // A fade stops sound already playing when it begins, never one that starts afterwards.
        const from = k.at + Math.max(0, k.fadeOthers.delay ?? 0) * 1000;
        if (ev.at <= from) kill(from, Math.max(0.05, k.fadeOthers.fade));
      }
    }
    const d = ev.loop ? undefined : duration?.(ev.assetId);
    const endsAt = d ? ev.at + Math.max(0, d - (ev.trimStart ?? 0)) * 1000 : null;
    // Its own fade-out before the file ends.
    if (endsAt !== null && ev.fadeOut && ev.fadeOut > 0) kill(Math.max(ev.at, endsAt - ev.fadeOut * 1000), ev.fadeOut);
    out.push({ ev, fadeFrom, fadeSecs, endsAt });
  });
  return out;
}

/** Still heard at time t (ms), a fade-out under way included. */
export function lifeAudible(l: SoundLife, t: number): boolean {
  return l.ev.at <= t && (l.fadeFrom === null || l.fadeFrom + l.fadeSecs * 1000 > t) && (l.endsAt === null || l.endsAt > t);
}

/** Playing at time t (ms) and not being faded out. */
export function lifePlaying(l: SoundLife, t: number): boolean {
  return lifeAudible(l, t) && (l.fadeFrom === null || l.fadeFrom > t);
}

/** A sound's level (share of its volume) `since` seconds after it started, from its level changes. */
export function levelAt(levels: SoundLevel[] | undefined, since: number): number {
  let level = 1;
  for (const p of [...(levels ?? [])].sort((a, b) => a.at - b.at)) {
    if (since <= p.at) break;
    const fade = Math.max(0, p.fade ?? 0);
    level = fade > 0 && since < p.at + fade ? level + (p.level - level) * ((since - p.at) / fade) : p.level;
  }
  return level;
}

/**
 * Glide a gain node through a sound's level changes: `since` seconds after it started is now (context
 * time `ctxNow`); a change already under way picks up where it is.
 */
export function scheduleLevels(param: AudioParam, levels: SoundLevel[] | undefined, since: number, ctxNow: number) {
  param.cancelScheduledValues(ctxNow);
  param.setValueAtTime(Math.max(0.0001, levelAt(levels, since)), ctxNow);
  for (const p of [...(levels ?? [])].sort((a, b) => a.at - b.at)) {
    const end = p.at + Math.max(0, p.fade ?? 0);
    if (end <= since) continue;
    const from = Math.max(since, p.at);
    param.setValueAtTime(Math.max(0.0001, levelAt(levels, from)), ctxNow + (from - since));
    param.linearRampToValueAtTime(Math.max(0.0001, p.level), ctxNow + (end - since));
  }
}

/**
 * Seconds into its file at time t (ms), wrapped for a loop when the length is known. A trimmed sound starts at
 * its trimStart (and loops back to it); less than that means it has not started yet.
 */
export function filePos(ev: SoundEvent, t: number, duration?: number): number {
  const trim = ev.trimStart ?? 0;
  const pos = (t - ev.at) / 1000 + trim;
  return ev.loop && duration && duration > trim && pos > trim ? trim + ((pos - trim) % (duration - trim)) : pos;
}

/**
 * A TAKE that carries the story on: the sounds of the run going off that keep playing, as events of the new run
 * (scene clock starting at `startedAt`, wall ms), so the new run's list says what is playing and a restarted
 * audio host can bring them back. Same ids (the audio host already plays them); their fades of other audio
 * are done and are left behind.
 */
export function carriedSounds(rt: SceneRuntime, startedAt: number, wall: number): SoundEvent[] {
  const t = sceneNow(rt, wall);
  // The file keeps playing between the TAKE and the new run's scene time 0.
  const shift = t + (startedAt - wall);
  return soundLives(rt.sounds ?? [])
    .filter((l) => l.ev.keepPlaying && l.ev.at <= t && l.fadeFrom === null)
    .map(({ ev }) => {
      const { fadeOthers: _f, ...rest } = ev;
      return { ...rest, at: ev.at - shift, chase: true };
    });
}

// ---------------------------------------------------------------- nominal timeline

/** Learned seconds after TAKE for a scene's cue (or "@end"). */
type Timings = Record<string, number> | undefined;

interface SceneTimeline {
  /** Scene seconds each cue fires at. */
  cueAt: number[];
  /** Scene seconds the next scene takes over. */
  end: number;
}

const actionAt = (cueAt: number, a: CueAction) => cueAt + Math.max(0, a.delay ?? 0);

/** When media carrying markers starts, from the actions that start it (initially visible / first background: 0). */
function mediaStart(scene: Scene, cues: Cue[], cueAt: number[], compId: string, clipId: string | null): number | null {
  const c = scene.components.find((x) => x.id === compId);
  if (!c) return null;
  const acts = cues.flatMap((cue, i) => cue.actions.map((a) => ({ a, t: actionAt(cueAt[i], a) }))).sort((x, y) => x.t - y.t);
  if (c.kind === "clipActor") {
    // Clips wait for the actor's next cut point: play the actor's clip actions through its own scheduler.
    let rt = initialSegments(c);
    for (const { a, t } of acts) if (a.type === "clip" && a.actorId === c.id) rt = scheduleClip(c, rt, a.clipId, t * 1000);
    const seg = rt.segments.find((g) => g.clipId === clipId);
    return seg ? seg.at / 1000 : null;
  }
  if (c.kind === "video" && c.initiallyVisible) return 0;
  if (c.kind === "background") {
    const first = scene.components.find((x) => x.kind === "background" && x.initiallyVisible) ?? scene.components.find((x) => x.kind === "background");
    if (first?.id === c.id) return 0;
  }
  const start = acts.find(({ a }) => (a.type === "layer" && a.layerId === compId && a.op !== "hide") || (a.type === "background" && a.backgroundId === compId));
  return start ? start.t : null;
}

/** Media seconds → scene seconds after the media started. */
function markerDelay(scene: Scene, compId: string, at: number): number {
  const c = scene.components.find((x) => x.id === compId);
  if (c && (c.kind === "video" || c.kind === "background") && "media" in c) {
    const rate = c.media.playbackRate > 0 ? c.media.playbackRate : 1;
    return Math.max(0, at - (c.media.startTime ?? 0)) / rate;
  }
  return Math.max(0, at);
}

/** Nominal cue times and end of one scene. */
export function sceneTimeline(scene: Scene, timings: Timings): SceneTimeline {
  const cues = scene.cues;
  const cueAt: number[] = [];
  cues.forEach((cue, i) => {
    const prev = i > 0 ? cueAt[i - 1] : 0;
    const f = cue.fire;
    const learned = timings?.[cue.id];
    let at: number | undefined;
    if (f?.mode === "time") at = f.at;
    else if (f?.mode === "follow") at = prev + Math.max(0, f.after);
    else if (f?.mode === "video") {
      for (const { host, marker } of cueMarkers(scene, cue.id)) {
        const start = mediaStart(scene, cues.slice(0, i), cueAt, host.compId, host.clipId);
        if (start === null) continue;
        const t = start + markerDelay(scene, host.compId, marker.at);
        at = at === undefined ? t : Math.min(at, t);
      }
      // A run in sequence knows best (clips can wait for a cut point the scheduler cannot see coming).
      if (learned !== undefined) at = learned;
    } else at = learned;
    cueAt.push(at ?? prev);
  });
  let end: number | null = null;
  let last = 0;
  cues.forEach((cue, i) => {
    for (const a of cue.actions) {
      const t = actionAt(cueAt[i], a);
      if (a.type === "takeScene") end = end === null ? t : Math.min(end, t);
      else last = Math.max(last, t);
    }
    last = Math.max(last, cueAt[i]);
  });
  return { cueAt, end: end ?? timings?.["@end"] ?? last };
}

export interface NominalSound {
  assetId: string;
  /** Seconds into the file at that point. */
  offset: number;
  volume: number;
  loop: boolean;
  keepPlaying: boolean;
  /** Fades out over this many seconds before its file ends (see the sound action). */
  fadeOut?: number;
  /** Where a loop goes back to (see the sound action's trimStart). */
  trimStart?: number;
  /** Its level changes, timed from when it started (see the sound action). */
  levels?: SoundLevel[];
  /** Seconds since it started at that point. */
  since?: number;
  /** The scene and cue whose sound action started it. */
  sceneId: string;
  cueId: string;
}

export interface NominalMusic {
  /** Seconds from the top of the show (running order) to that point. */
  showTime: number;
  /** Seconds into the scene of that point. */
  sceneTime: number;
  sounds: NominalSound[];
}

type TimedEvent = SoundEvent & { sceneId: string; cueId: string };

/**
 * The cue sounds that would be playing just before cue `cueIndex` of `sceneId` fires (null: as the scene is taken),
 * had the show run in sequence from the first scene, and how far into each file. Sounds fading out at that moment
 * are left out; so are sounds past the end of their file when its length is known.
 */
export function nominalMusic(project: Pick<Project, "scenes" | "cueTimings">, sceneId: string, cueIndex: number | null, duration: (assetId: string) => number | undefined): NominalMusic | null {
  const scenes = project.scenes;
  if (!scenes.some((s) => s.id === sceneId)) return null;
  const events: TimedEvent[] = [];
  const byTime = () => events.slice().sort((a, b) => a.at - b.at);
  let T = 0;
  let n = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const tl = sceneTimeline(scene, project.cueTimings?.[scene.id]);
    const isTarget = scene.id === sceneId;
    const cut = isTarget ? (cueIndex === null ? 0 : (tl.cueAt[Math.max(0, Math.min(cueIndex, tl.cueAt.length - 1))] ?? 0)) : tl.end;
    scene.cues.forEach((cue, ci) => {
      if (isTarget && (cueIndex === null || ci >= cueIndex)) return;
      for (const a of cue.actions) {
        if (a.type !== "sound" || !a.assetId) continue;
        const t = actionAt(tl.cueAt[ci], a);
        if (t > cut) continue;
        const ev: TimedEvent = { id: `n${n++}`, assetId: a.assetId, at: (T + t) * 1000, volume: a.volume, keepPlaying: !!a.keepPlaying, sceneId: scene.id, cueId: cue.id };
        if (a.loop) ev.loop = true;
        if (a.trimStart && a.trimStart > 0) ev.trimStart = a.trimStart;
        if (a.fadeOut && a.fadeOut > 0) ev.fadeOut = a.fadeOut;
        if (a.levels?.length) ev.levels = a.levels;
        if (a.fadeOthers && (a.fadeOthers.which === "all" || a.fadeOthers.which.length)) ev.fadeOthers = a.fadeOthers;
        events.push(ev);
      }
    });
    if (isTarget) {
      const at = (T + cut) * 1000;
      const sorted = byTime();
      const sounds = soundLives(sorted, duration)
        .filter((l) => lifePlaying(l, at))
        .map((l) => {
          const e = l.ev as TimedEvent;
          return { assetId: e.assetId, offset: filePos(e, at, duration(e.assetId)), volume: e.volume, loop: !!e.loop, keepPlaying: !!e.keepPlaying, fadeOut: e.fadeOut, trimStart: e.trimStart, levels: e.levels, since: (at - e.at) / 1000, sceneId: e.sceneId, cueId: e.cueId };
        });
      return { showTime: T + cut, sceneTime: cut, sounds };
    }
    // The next scene takes the wall: what keeps playing carries on, the rest fades out.
    const Te = T + tl.end;
    const next = scenes[i + 1];
    if (next) {
      const at = Te * 1000;
      const sorted = byTime();
      const playing = soundLives(sorted, duration).filter((l) => lifePlaying(l, at));
      const left = playing.filter((l) => !l.ev.keepPlaying).map((l) => soundKey(l.ev.assetId));
      const stopped = next.stopCarriedSounds ? playing.filter((l) => l.ev.keepPlaying).map((l) => soundKey(l.ev.assetId)) : [];
      const stop = (which: string[], fade: number) => events.push({ id: `n${n++}`, assetId: "", at, volume: 0, fadeOthers: { which, fade }, sceneId: scene.id, cueId: "" });
      if (left.length) stop(left, LEFT_BEHIND_FADE);
      if (stopped.length) stop(stopped, CARRIED_STOP_FADE);
    }
    T = Te;
  }
  return null;
}
