// Procedural animation for the placeholder lion. Each action is a pure
// function of time (and gait phase for locomotion), so every view computes
// identical poses from the shared state.

import { clamp, smoothstep } from "@/core/clock";
import type { LionAction } from "@/core/types";

export interface LegPose {
  /** Forward swing of the upper leg (radians, + = forward). */
  hip: number;
  /** Knee/hock flex (radians, + = folds). */
  knee: number;
}

export interface LionPose {
  bodyY: number;
  bodyZ: number;
  bodyPitch: number;
  bodyRoll: number;
  lie: number;
  neckPitch: number;
  neckYaw: number;
  headPitch: number;
  headYaw: number;
  jaw: number;
  breathe: number;
  tailLift: number;
  tailSwing: number;
  tailCurl: number;
  /** FL, FR, BL, BR */
  legs: [LegPose, LegPose, LegPose, LegPose];
}

export function newPose(): LionPose {
  return {
    bodyY: 0,
    bodyZ: 0,
    bodyPitch: 0,
    bodyRoll: 0,
    lie: 0,
    neckPitch: 0,
    neckYaw: 0,
    headPitch: 0,
    headYaw: 0,
    jaw: 0,
    breathe: 0,
    tailLift: 0,
    tailSwing: 0,
    tailCurl: 0,
    legs: [
      { hip: 0, knee: 0 },
      { hip: 0, knee: 0 },
      { hip: 0, knee: 0 },
      { hip: 0, knee: 0 },
    ],
  };
}

const TAU = Math.PI * 2;

/** Smooth keyframe track: [[time, value], ...]. */
function kf(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const k = smoothstep(0, 1, (t - t0) / (t1 - t0));
      return v0 + (v1 - v0) * k;
    }
  }
  return keys[keys.length - 1][1];
}

function idle(p: LionPose, t: number) {
  p.breathe = Math.sin(t * 1.7) * 0.5 + 0.5;
  p.bodyY = Math.sin(t * 1.7) * 0.006;
  p.neckPitch = 0.05 + Math.sin(t * 0.31) * 0.05;
  p.headYaw = Math.sin(t * 0.23) * 0.28 + Math.sin(t * 0.71 + 1) * 0.08;
  p.headPitch = Math.sin(t * 0.4) * 0.05;
  p.tailLift = 0.05;
  p.tailSwing = Math.sin(t * 0.8) * 0.35 + Math.max(0, Math.sin(t * 0.21) - 0.9) * Math.sin(t * 9) * 3;
  p.tailCurl = 0.4 + Math.sin(t * 0.6) * 0.15;
  for (const l of p.legs) {
    l.hip = 0;
    l.knee = 0;
  }
  p.legs[2].knee = 0.05;
  p.legs[3].knee = 0.05;
}

function gait(p: LionPose, phase: number, kind: "walk" | "run" | "turn", t: number) {
  const run = kind === "run";
  const amp = run ? 0.72 : kind === "turn" ? 0.22 : 0.4;
  const lift = run ? 1.25 : kind === "turn" ? 0.45 : 0.8;
  // Walk: lateral sequence (LH, LF, RH, RF). Run: rotary gallop.
  const offs = run ? [0.55, 0.65, 0.0, 0.1] : [0.25, 0.75, 0.0, 0.5];
  for (let i = 0; i < 4; i++) {
    const c = TAU * (phase + offs[i]);
    const swing = Math.cos(c);
    p.legs[i].hip = Math.sin(c) * amp;
    p.legs[i].knee = Math.pow(Math.max(0, swing), 1.4) * lift + (i >= 2 ? 0.08 : 0);
  }
  const ph = TAU * phase;
  if (run) {
    p.bodyY = Math.abs(Math.sin(ph)) * 0.09 - 0.05;
    p.bodyPitch = Math.sin(ph + 1.2) * 0.1;
    p.neckPitch = -0.12 + Math.sin(ph + 0.6) * 0.06;
    p.headPitch = 0.08;
    p.tailLift = -0.1 + Math.sin(ph) * 0.1;
    p.tailSwing = Math.sin(ph * 0.5) * 0.15;
    p.tailCurl = 0.1;
  } else {
    p.bodyY = Math.sin(ph * 2) * 0.018;
    p.bodyRoll = Math.sin(ph) * 0.025;
    p.bodyPitch = Math.sin(ph * 2 + 0.5) * 0.012;
    p.neckPitch = -0.04 + Math.sin(ph * 2 + 0.8) * 0.035;
    p.headYaw = Math.sin(ph) * 0.05;
    p.tailLift = 0.0;
    p.tailSwing = Math.sin(ph) * 0.3;
    p.tailCurl = 0.35;
  }
  p.breathe = Math.sin(t * (run ? 5 : 2.4)) * 0.5 + 0.5;
}

function roar(p: LionPose, t: number) {
  idle(p, t);
  p.headYaw = kf(t, [[0, p.headYaw], [0.3, 0], [2.4, 0], [2.8, p.headYaw]]);
  p.neckPitch = kf(t, [[0, 0.05], [0.35, -0.22], [0.6, 0.38], [2.1, 0.32], [2.8, 0.05]]);
  p.headPitch = kf(t, [[0, 0], [0.35, 0.15], [0.6, -0.28], [2.1, -0.22], [2.8, 0]]);
  const open = kf(t, [[0, 0], [0.38, 0.05], [0.6, 0.8], [1.9, 0.72], [2.3, 0.05], [2.8, 0]]);
  p.jaw = open + (t > 0.6 && t < 2.0 ? Math.sin(t * 38) * 0.04 : 0);
  p.headYaw += t > 0.6 && t < 2.0 ? Math.sin(t * 11) * 0.06 : 0;
  p.bodyY = kf(t, [[0, 0], [0.35, -0.06], [0.6, 0.03], [2.1, 0.02], [2.8, 0]]);
  p.bodyPitch = kf(t, [[0, 0], [0.35, 0.06], [0.6, -0.06], [2.1, -0.05], [2.8, 0]]);
  p.legs[0].hip = p.legs[1].hip = kf(t, [[0, 0], [0.6, 0.12], [2.1, 0.12], [2.8, 0]]);
  p.breathe = clamp(open * 1.2, 0, 1);
  p.tailSwing = Math.sin(t * 4) * 0.5;
}

function attack(p: LionPose, t: number) {
  idle(p, t);
  p.headYaw = kf(t, [[0, p.headYaw], [0.2, 0]]);
  p.bodyY = kf(t, [[0, 0], [0.33, -0.2], [0.6, 0.4], [0.85, 0.05], [1.05, -0.08], [1.7, 0]]);
  p.bodyPitch = kf(t, [[0, 0], [0.33, 0.1], [0.6, -0.42], [0.85, -0.1], [1.05, 0.06], [1.7, 0]]);
  p.neckPitch = kf(t, [[0, 0.05], [0.33, -0.25], [0.6, 0.15], [0.9, -0.1], [1.7, 0.05]]);
  p.headPitch = kf(t, [[0, 0], [0.33, 0.2], [0.6, -0.15], [1.7, 0]]);
  p.jaw = kf(t, [[0, 0], [0.4, 0.15], [0.62, 0.75], [0.95, 0.7], [1.02, 0.05], [1.7, 0]]);
  // front legs reach and swipe; hind legs coil then drive
  const fHip = kf(t, [[0, 0], [0.33, -0.15], [0.62, 1.15], [0.85, 0.9], [1.0, -0.15], [1.7, 0]]);
  const fKnee = kf(t, [[0, 0], [0.33, 0.35], [0.62, 0.25], [0.85, 0.6], [1.0, 0.1], [1.7, 0]]);
  const bHip = kf(t, [[0, 0], [0.33, 0.45], [0.62, -0.75], [0.9, -0.2], [1.7, 0]]);
  const bKnee = kf(t, [[0, 0.05], [0.33, 0.95], [0.62, 0.05], [0.9, 0.3], [1.7, 0.05]]);
  p.legs[0].hip = fHip;
  p.legs[1].hip = fHip * 0.9;
  p.legs[0].knee = fKnee;
  p.legs[1].knee = fKnee;
  p.legs[2].hip = p.legs[3].hip = bHip;
  p.legs[2].knee = p.legs[3].knee = bKnee;
  p.tailLift = kf(t, [[0, 0], [0.33, 0.25], [0.62, -0.25], [1.7, 0]]);
  p.tailSwing = Math.sin(t * 7) * 0.25;
}

function hit(p: LionPose, t: number) {
  idle(p, t);
  p.headYaw = kf(t, [[0, 0], [0.1, 0.55], [0.35, 0.2], [0.7, -0.1], [1.1, 0]]);
  p.neckPitch = kf(t, [[0, 0.05], [0.1, 0.35], [0.45, -0.15], [1.1, 0.05]]);
  p.headPitch = kf(t, [[0, 0], [0.1, -0.25], [0.45, 0.1], [1.1, 0]]);
  p.jaw = kf(t, [[0, 0], [0.1, 0.45], [0.4, 0.3], [0.8, 0.0]]);
  p.bodyRoll = kf(t, [[0, 0], [0.12, 0.22], [0.35, -0.12], [0.6, 0.06], [1.1, 0]]);
  p.bodyY = kf(t, [[0, 0], [0.15, -0.1], [0.5, -0.04], [1.1, 0]]);
  p.bodyPitch = kf(t, [[0, 0], [0.12, -0.12], [0.5, 0.04], [1.1, 0]]);
  p.legs[0].knee = kf(t, [[0, 0], [0.2, 0.45], [0.6, 0.15], [1.1, 0]]);
  p.legs[1].knee = kf(t, [[0, 0], [0.3, 0.3], [0.7, 0.05], [1.1, 0]]);
  p.legs[0].hip = kf(t, [[0, 0], [0.2, -0.25], [0.6, 0.1], [1.1, 0]]);
  p.tailSwing = Math.sin(t * 10) * 0.6 * (1 - t);
}

function fall(p: LionPose, t: number) {
  idle(p, Math.min(t, 0.3));
  p.headYaw = kf(t, [[0, 0], [0.3, -0.2], [1.8, 0.35]]);
  p.lie = kf(t, [[0, 0], [0.45, 0.12], [1.25, 1.38], [1.45, 1.28], [1.8, 1.35]]);
  p.bodyY = kf(t, [[0, 0], [0.45, -0.22], [1.25, -0.6], [1.45, -0.56], [1.8, -0.6]]);
  p.bodyPitch = kf(t, [[0, 0], [0.4, 0.16], [1.0, 0.05], [1.8, 0]]);
  p.neckPitch = kf(t, [[0, 0.05], [0.4, -0.3], [1.3, 0.1], [1.8, 0.15]]);
  p.headPitch = kf(t, [[0, 0], [0.4, 0.3], [1.8, 0.05]]);
  p.jaw = kf(t, [[0, 0], [0.3, 0.3], [0.9, 0.12], [1.8, 0.08]]);
  const legLimp = kf(t, [[0, 0], [0.45, 0], [1.3, 0.35], [1.8, 0.3]]);
  p.legs[0].knee = kf(t, [[0, 0], [0.45, 0.8], [1.3, 0.25], [1.8, 0.2]]);
  p.legs[1].knee = kf(t, [[0, 0], [0.45, 0.7], [1.3, 0.3], [1.8, 0.25]]);
  p.legs[2].knee = kf(t, [[0, 0.05], [0.5, 0.6], [1.3, 0.2], [1.8, 0.15]]);
  p.legs[3].knee = kf(t, [[0, 0.05], [0.5, 0.5], [1.3, 0.25], [1.8, 0.2]]);
  p.legs[0].hip = legLimp;
  p.legs[1].hip = legLimp * 0.6;
  p.legs[2].hip = -legLimp * 0.8;
  p.legs[3].hip = -legLimp * 0.5;
  // breathing fades out once down
  p.breathe = (Math.sin(t * 2.5) * 0.5 + 0.5) * (1 - smoothstep(0.8, 1.8, t)) * 0.6;
  p.tailSwing = (1 - smoothstep(0.5, 1.6, t)) * Math.sin(t * 6) * 0.4;
  p.tailLift = -0.2 * smoothstep(0.5, 1.4, t);
  p.tailCurl = 0.1;
}

export function computePose(out: LionPose, action: LionAction, t: number, phase: number) {
  const fresh = newPose();
  Object.assign(out, fresh);
  out.legs = fresh.legs;
  switch (action) {
    case "idle":
      return idle(out, t);
    case "walk":
    case "run":
    case "turn":
      return gait(out, phase, action, t);
    case "roar":
      return roar(out, Math.min(t, 2.8));
    case "attack":
      return attack(out, Math.min(t, 1.7));
    case "hit":
      return hit(out, Math.min(t, 1.1));
    case "fall":
      return fall(out, Math.min(t, 1.8));
  }
}

export function blendPose(a: LionPose, b: LionPose, k: number, out: LionPose) {
  for (const key of Object.keys(out) as (keyof LionPose)[]) {
    if (key === "legs") continue;
    (out[key] as number) = (a[key] as number) + ((b[key] as number) - (a[key] as number)) * k;
  }
  for (let i = 0; i < 4; i++) {
    out.legs[i].hip = a.legs[i].hip + (b.legs[i].hip - a.legs[i].hip) * k;
    out.legs[i].knee = a.legs[i].knee + (b.legs[i].knee - a.legs[i].knee) * k;
  }
}
