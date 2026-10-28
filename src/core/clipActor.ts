// Video actors: photoreal characters built from pre-rendered clips.
// Scheduling is a pure function of scene time so every window agrees which
// clip is on screen and at which frame.

import type { ClipActorComponent, ClipActorRuntime, ClipDef, ClipSegment } from "./types";

export interface ClipState {
  /** Clip on screen (playing, or holding its last frame), or null when the actor is clear. */
  clip: ClipDef | null;
  segment: ClipSegment | null;
  /** Seconds into the clip (clamped to its length unless it loops). */
  localT: number;
  playing: boolean;
  /** Pose the actor is in (or heading to while a clip plays). */
  pose: string;
  /** Next scheduled clip, if one is waiting for a cut point. */
  queued: { clip: ClipDef; at: number } | null;
}

const clipById = (c: ClipActorComponent, id: string) => c.clips.find((x) => x.id === id) ?? null;

/** The looping idles of `pose`, in list order. Several take turns: each plays once, then the next. */
export function idlesFor(c: ClipActorComponent, pose: string): ClipDef[] {
  return c.clips.filter((k) => k.autoIdle && k.loop && k.startPose === pose && k.endPose === pose && (k.assetId || k.cutoutAssetId));
}

/** The looping idle that takes over when a clip finishes on `pose` (if one is set up). */
export function idleFor(c: ClipActorComponent, pose: string): ClipDef | null {
  return idlesFor(c, pose)[0] ?? null;
}

/**
 * Where a rotation of idles is at time `t`, when `seg` started `clip` (one of them): the idle on
 * screen and the moment its own turn began, so cut points fall at the end of each idle.
 */
function idleTurn(c: ClipActorComponent, clip: ClipDef, seg: ClipSegment, t: number): { clip: ClipDef; segment: ClipSegment } | null {
  const turns = idlesFor(c, clip.startPose);
  const first = turns.indexOf(clip);
  if (turns.length < 2 || first < 0) return null;
  const len = (k: ClipDef) => Math.max(0.05, k.duration) * 1000;
  const total = turns.reduce((s, k) => s + len(k), 0);
  let off = (t - seg.at) % total;
  let at = t - off;
  for (let n = 0; n < turns.length; n++) {
    const k = turns[(first + n) % turns.length];
    if (off < len(k)) return { clip: k, segment: at === seg.at && k === clip ? seg : { clipId: k.id, at } };
    off -= len(k);
    at += len(k);
  }
  return null;
}

export function clipStateAt(c: ClipActorComponent, rt: ClipActorRuntime | undefined, t: number): ClipState {
  const segs = rt?.segments ?? [];
  let active: ClipSegment | null = null;
  let next: ClipSegment | null = null;
  for (const s of segs) {
    if (s.at <= t) active = s;
    else if (!next || s.at < next.at) next = s;
  }
  const nextClip = next ? clipById(c, next.clipId) : null;
  const queued = next && nextClip ? { clip: nextClip, at: next.at } : null;
  let clip = active ? clipById(c, active.clipId) : null;
  if (!active || !clip) return { clip: null, segment: null, localT: 0, playing: false, pose: c.restPose, queued };
  // A finished clip hands over to its pose's idle loop, starting exactly when it ended.
  if (!clip.loop) {
    const endAt = active.at + Math.max(0.05, clip.duration) * 1000;
    const idle = t >= endAt ? idleFor(c, clip.endPose) : null;
    if (idle) {
      active = { clipId: idle.id, at: endAt };
      clip = idle;
    }
  }
  if (clip.loop && clip.autoIdle) {
    const turn = idleTurn(c, clip, active, t);
    if (turn) ({ clip, segment: active } = turn);
  }
  const dur = Math.max(0.05, clip.duration);
  const el = (t - active.at) / 1000;
  if (clip.loop) return { clip, segment: active, localT: el % dur, playing: true, pose: clip.endPose, queued };
  const ended = el >= dur;
  return { clip, segment: active, localT: Math.min(el, dur), playing: !ended, pose: clip.endPose, queued };
}

/**
 * Request a clip. It starts at the next clean cut point: immediately if the
 * actor is idle, when the current clip ends, or at the next loop boundary.
 * A new request replaces anything still waiting. `clipId: null` clears the actor.
 */
export function scheduleClip(c: ClipActorComponent, rt: ClipActorRuntime | undefined, clipId: string | null, t: number): ClipActorRuntime {
  const past = (rt?.segments ?? []).filter((s) => s.at <= t);
  if (clipId === null) {
    // Back to rest: the rest pose's idle loop (if any) restarts now.
    const rest = idleFor(c, c.restPose);
    return { segments: rest ? [{ clipId: rest.id, at: t }] : [] };
  }
  const clip = clipById(c, clipId);
  if (!clip) return rt ?? { segments: [] };
  const st = clipStateAt(c, { segments: past }, t);
  let at = t;
  if (st.clip && st.segment && !clip.interrupt) {
    const dur = Math.max(0.05, st.clip.duration) * 1000;
    if (st.clip.loop) at = st.segment.at + Math.ceil((t - st.segment.at) / dur) * dur;
    else if (st.playing) at = st.segment.at + dur;
  }
  return { segments: [...past.slice(-4), { clipId, at }] };
}

/** Segments an actor starts a scene with: its rest pose's idle loop, if it has one, runs from the first frame. */
export function initialSegments(c: ClipActorComponent): ClipActorRuntime {
  const idle = idleFor(c, c.restPose);
  return { segments: idle ? [{ clipId: idle.id, at: 0 }] : [] };
}

/** True when the clip continues seamlessly from the actor's pose at the time it will start. */
/** Short text for a clip's show-mode button: its label, else its name up to the first comma, colon, bracket or dash. */
export function clipLabel(c: ClipDef): string {
  if (c.label?.trim()) return c.label.trim();
  const first = c.name.split(/[,:(\u2014]| - /)[0].trim();
  return first || c.name;
}

export function clipFits(c: ClipActorComponent, rt: ClipActorRuntime | undefined, clip: ClipDef, t: number): boolean {
  return clipStateAt(c, rt, t).pose === clip.startPose;
}
