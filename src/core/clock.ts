import type { SceneRuntime, Tween } from "./types";

/**
 * High-resolution wall clock shared by every window on this machine.
 * performance.timeOrigin differs per window, but timeOrigin + now() is
 * wall-clock time, so all views agree on "now" to well under a frame.
 */
export const now = () => performance.timeOrigin + performance.now();

/** Current scene time (ms) for a runtime, honouring pause. */
export function sceneNow(rt: SceneRuntime, at = now()): number {
  return (rt.clock.pausedAt ?? at) - rt.clock.base;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t: number) => t * t * t;

export function ease(kind: "linear" | "inOut" | "out" | "in", t: number) {
  t = clamp(t, 0, 1);
  return kind === "inOut" ? easeInOut(t) : kind === "out" ? easeOut(t) : kind === "in" ? easeIn(t) : t;
}

export function tween(from: number, to: number, at: number, dur: number): Tween {
  return { from, to, at, dur };
}

export function evalTween(tw: Tween, t: number, kind: "linear" | "inOut" = "inOut"): number {
  if (tw.dur <= 0 || t >= tw.at + tw.dur) return tw.to;
  if (t <= tw.at) return tw.from;
  return lerp(tw.from, tw.to, ease(kind, (t - tw.at) / tw.dur));
}

/** Re-target a tween from wherever it currently is. */
export function retarget(tw: Tween, to: number, t: number, dur: number): Tween {
  return { from: evalTween(tw, t), to, at: t, dur };
}

export function angleDelta(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
