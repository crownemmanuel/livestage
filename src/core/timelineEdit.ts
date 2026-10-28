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
    // Let go of whatever stopped it here.
    const release = () => {
      if (!by || !byAction) return;
      if (byAction.type === "audio.fade") {
        if (byAction.which === "all" || byAction.which.length <= 1) removeAction(s, by);
        else byAction.which = byAction.which.filter((k) => k !== key);
      } else if (byAction.type === "sound" && byAction.fadeOthers && byAction.fadeOthers.which !== "all") {
        byAction.fadeOthers.which = byAction.fadeOthers.which.filter((k) => k !== key);
        if (!byAction.fadeOthers.which.length) byAction.fadeOthers = null;
      }
    };
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

/** True when the block's end can be dragged. */
export function endDraggable(it: TimelineItem): boolean {
  if (!it.endable || it.end <= it.start) return false;
  if (it.endBy?.kind === "restart" || it.endBy?.kind === "refire") return false;
  return true;
}
