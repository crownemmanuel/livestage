// Edits made by dragging on the Build timeline, as changes to a scene draft. Every edge on the
// timeline belongs to one cue (its start plus the action's delay), never to an absolute time
// across a GO, which has no time until it is pressed. So a block dropped at scene time t goes to
// the cue whose stretch t falls in (the last cue starting at or before t), with the rest as its
// delay: a sound placed after GO 5 follows GO 5 however late the actor is. Pure: no stores.

import type { SceneTimeline, TimelineItem } from "./timeline";
import type { Cue, CueAction, Scene } from "./types";

/** Where a moved or new action lands: a cue and the delay after it. */
export interface Anchor {
  cue: number;
  delay: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The cue whose stretch scene time `t` falls in, and the delay from its start (never before the first placed cue). */
export function anchorAt(tl: SceneTimeline, t: number): Anchor | null {
  let best: { cue: number; start: number } | null = null;
  for (const c of tl.cues) {
    if (c.start == null) continue;
    if (c.start <= t + 1e-6 && (!best || c.start >= best.start)) best = { cue: c.index, start: c.start };
  }
  if (!best) {
    // Before every cue: the earliest one, at no delay.
    for (const c of tl.cues) if (c.start != null && (!best || c.start < best.start)) best = { cue: c.index, start: c.start };
    if (!best) return null;
    return { cue: best.cue, delay: 0 };
  }
  return { cue: best.cue, delay: Math.max(0, r1(t - best.start)) };
}

/**
 * Move action `from` (or copy it) so it fires at scene time `t`. Returns where it ended up.
 * Moving within its own cue's stretch only changes the delay.
 */
export function placeAction(s: Scene, tl: SceneTimeline, from: { cue: number; action: number }, t: number, copy = false): Anchor & { action: number } | null {
  const src = s.cues[from.cue]?.actions[from.action];
  const to = anchorAt(tl, t);
  if (!src || !to) return null;
  const a = { ...structuredClone(src), delay: to.delay } as CueAction;
  if (!copy && to.cue === from.cue) {
    s.cues[from.cue].actions[from.action] = a;
    return { ...to, action: from.action };
  }
  if (!copy) s.cues[from.cue].actions.splice(from.action, 1);
  const actions = s.cues[to.cue].actions;
  actions.push(a);
  return { ...to, action: actions.length - 1 };
}

/** Add a new action at scene time `t`. */
export function addActionAt(s: Scene, tl: SceneTimeline, a: CueAction, t: number) {
  const to = anchorAt(tl, t);
  if (!to) return;
  s.cues[to.cue].actions.push({ ...a, delay: to.delay } as CueAction);
}

export function removeAction(s: Scene, ref: { cue: number; action: number }) {
  s.cues[ref.cue]?.actions.splice(ref.action, 1);
}

/**
 * Move a cue's own start to scene time `t`: a scene time, the seconds after the cue before
 * (follow), or the planned hold before a GO. A cue fired by a video marker cannot move here.
 */
export function moveCue(s: Scene, tl: SceneTimeline, index: number, t: number) {
  const c: Cue | undefined = s.cues[index];
  const tc = tl.cues[index];
  if (!c || !tc) return;
  const mode = c.fire?.mode ?? "go";
  if (mode === "time") c.fire = { mode: "time", at: Math.max(0, r1(t)) };
  else if (mode === "follow") {
    const prev = index > 0 ? tl.cues[index - 1].start : 0;
    if (prev != null) c.fire = { mode: "follow", after: Math.max(0, r1(t - prev)) };
  } else if (mode === "go") c.hold = Math.max(0, r1(t - (tc.holdFrom ?? 0)));
}

/** Seconds a sound takes to fade when its end is dragged and nothing sets the fade yet. */
export const DRAG_FADE = 2;

/** How long the block's fade-out is when its end is dragged: its own fade, else a new sound fade's. */
export function endFade(it: TimelineItem): number {
  if (it.endBy && it.fadeFrom != null) return r1(Math.max(0, it.end - it.fadeFrom));
  return it.endable === "sound" ? DRAG_FADE : 0;
}

/**
 * Drag where a block ends to scene time `t` (the end of its fade, when it fades).
 * - A sound: its fade-out action moves (or one is made). Past the take it keeps playing into the
 *   next scene; a sound that does not loop cannot run past its file.
 * - A layer: its hide moves (or a hide is made). An effect: its stop.
 * Past the end of the timeline, the action that ended it is removed (it runs on).
 */
export function setItemEnd(s: Scene, tl: SceneTimeline, it: TimelineItem, t: number) {
  const by = it.endBy;
  const byAction = by ? s.cues[by.cue]?.actions[by.action] : undefined;
  const fade = endFade(it);
  if (it.endable === "sound" && it.key) {
    const key = it.key;
    const source = it.cue != null && it.action != null ? s.cues[it.cue]?.actions[it.action] : undefined;
    if (it.naturalEnd != null) t = Math.min(t, it.naturalEnd + fade);
    const runsOn = tl.takeAt != null ? t >= tl.takeAt + 0.5 : t >= tl.end - 0.05;
    const release = () => releaseEnd(s, it);
    if (runsOn) {
      release();
      if (tl.takeAt != null && source?.type === "sound") source.keepPlaying = true;
      return;
    }
    const at = Math.max(it.start, t - fade);
    if (source?.type === "sound" && source.keepPlaying && tl.takeAt != null) source.keepPlaying = false;
    // Its own fade, fading only it: move that.
    if (by?.kind === "fade" && byAction?.type === "audio.fade" && byAction.which !== "all" && byAction.which.length === 1) {
      placeAction(s, tl, by, at);
      return;
    }
    // Ended by something shared (another sound starting, a fade of several): take it out of that one and fade it on its own.
    if (by?.kind === "fade" || by?.kind === "fadeOthers") release();
    addActionAt(s, tl, { type: "audio.fade", which: [key], fade: fade || DRAG_FADE, delay: 0 }, at);
    return;
  }
  if ((it.endable === "layer" || it.endable === "effect") && it.key) {
    if (by?.kind === "restart") return;
    const at = Math.max(it.start, t - fade);
    if (t >= tl.end - 0.05) {
      if (by && byAction) removeAction(s, by);
      return;
    }
    if (by && byAction && (by.kind === "hide" || by.kind === "stop")) {
      placeAction(s, tl, by, at);
      return;
    }
    addActionAt(s, tl, it.endable === "layer" ? { type: "layer", layerId: it.key, op: "hide", delay: 0 } : { type: "effect", effectId: it.key, op: "stop", delay: 0 }, at);
  }
}

/** Let go of whatever fades or stops sound `it` (a fade naming others too keeps fading them). */
function releaseEnd(s: Scene, it: TimelineItem) {
  const by = it.endBy;
  const byAction = by ? s.cues[by.cue]?.actions[by.action] : undefined;
  if (!by || !byAction || !it.key) return;
  const key = it.key;
  if (byAction.type === "audio.fade") {
    if (byAction.which === "all" || byAction.which.length <= 1) removeAction(s, by);
    else byAction.which = byAction.which.filter((k) => k !== key);
  } else if (byAction.type === "sound" && byAction.fadeOthers && byAction.fadeOthers.which !== "all") {
    byAction.fadeOthers.which = byAction.fadeOthers.which.filter((k) => k !== key);
    if (!byAction.fadeOthers.which.length) byAction.fadeOthers = null;
  }
}

/** True when a sound's fade-in can be dragged: one a cue in this scene starts. */
export const fadeInDraggable = (it: TimelineItem) => startDraggable(it);

/** Drag a sound's fade-in handle to scene time `t`: it fades in from its start to there. */
export function setFadeIn(s: Scene, it: TimelineItem, t: number) {
  if (!fadeInDraggable(it)) return;
  const a = s.cues[it.cue!]?.actions[it.action!];
  if (a?.type !== "sound") return;
  const fade = r1(Math.max(0, Math.min(t, it.fadeFrom ?? it.end) - it.start));
  if (fade > 0) a.fadeIn = fade;
  else delete a.fadeIn;
}

/**
 * True when a sound's fade-out can be dragged: a fade ends it, or it ends with its file (its own
 * fadeOut). Not the take's fade, nor a sound that runs on into the next scene.
 */
export function fadeOutDraggable(it: TimelineItem): boolean {
  if (it.endable !== "sound" || !it.key || it.end <= it.start || it.carriesOut) return false;
  if (it.endBy) return it.endBy.kind === "fade" || it.endBy.kind === "fadeOthers";
  return it.cue != null && it.action != null && it.naturalEnd != null && Math.abs(it.end - it.naturalEnd) < 0.05;
}

/** Where a fade-out dragged to scene time `t` begins: after the fade-in, before the end. */
export function fadeOutFrom(it: TimelineItem, t: number): number {
  return r1(Math.max(it.start + (it.fadeIn ?? 0), Math.min(t, it.end)));
}

/** Drag a sound's fade-out handle to scene time `t`: it fades from there and still ends where it did. */
export function setFadeOut(s: Scene, tl: SceneTimeline, it: TimelineItem, t: number) {
  if (!fadeOutDraggable(it)) return;
  const from = fadeOutFrom(it, t);
  const fade = r1(it.end - from);
  const by = it.endBy;
  if (!by) {
    const a = s.cues[it.cue!]?.actions[it.action!];
    if (a?.type !== "sound") return;
    if (fade > 0) a.fadeOut = fade;
    else delete a.fadeOut;
    return;
  }
  const byAction = s.cues[by.cue]?.actions[by.action];
  // Its own fade, fading only it: lengthen it and start it earlier.
  if (by.kind === "fade" && byAction?.type === "audio.fade" && byAction.which !== "all" && byAction.which.length === 1) {
    byAction.fade = Math.max(0.1, fade);
    placeAction(s, tl, by, from);
    return;
  }
  // A shared fade: take it out of that one and fade it on its own.
  releaseEnd(s, it);
  addActionAt(s, tl, { type: "audio.fade", which: [it.key!], fade: Math.max(0.1, fade), delay: 0 }, from);
}

/** True when the block's end can be dragged. */
export function endDraggable(it: TimelineItem): boolean {
  if (!it.endable || it.end <= it.start) return false;
  if (it.endBy?.kind === "restart" || it.endBy?.kind === "refire") return false;
  return true;
}

/** True when the block's start can be dragged to cut the top off its file (a sound a cue in this scene starts). */
export function startDraggable(it: TimelineItem): boolean {
  return it.endable === "sound" && it.cue != null && it.action != null && !it.carriedIn && it.end > it.start;
}

/** Shortest a sound can be trimmed down to by its left edge (seconds). */
const MIN_TRIMMED = 0.5;

/**
 * The trim a drag of a sound's left edge to scene time `t` gives: the start moves and the same seconds come
 * off (or back onto) the top of its file, so what plays after the edge stays where it was. Never before the
 * top of the file, never past its end.
 */
export function trimAt(it: TimelineItem, t: number): { start: number; trim: number } {
  const trim0 = it.trim ?? 0;
  const last = (it.naturalEnd ?? it.end) - MIN_TRIMMED;
  const start = Math.max(it.start - trim0, Math.min(t, last));
  return { start: r1(start), trim: Math.max(0, r1(trim0 + start - it.start)) };
}

/** Drag a sound's left edge to scene time `t` (see trimAt). Its fade-in stays the same length from the new start. */
export function setItemStart(s: Scene, tl: SceneTimeline, it: TimelineItem, t: number) {
  if (!startDraggable(it)) return;
  const { start, trim } = trimAt(it, t);
  const to = placeAction(s, tl, { cue: it.cue!, action: it.action! }, start);
  const a = to && s.cues[to.cue]?.actions[to.action];
  if (a?.type !== "sound") return;
  if (trim > 0) a.trimStart = trim;
  else delete a.trimStart;
}
