import { createContext, useContext } from "react";
import * as THREE from "three";
import { clamp, lerp, sceneNow, smoothstep } from "@/core/clock";
import { num, str } from "@/core/effects";
import { effectLevel, envAt } from "@/core/runtime";
import type { ActorPoses, Asset, SceneRuntime, TransitionSpec } from "@/core/types";

export type SlotRole = "preview" | "live" | "outgoing";

export interface TransitionView {
  spec: TransitionSpec;
  /** 0..1 progress (can be <0 during pre-roll). */
  p: number;
  side: "in" | "out";
}

/** Everything a scene renderer needs, shared via context across portals. */
export interface StageCtx {
  role: SlotRole;
  getRt: () => SceneRuntime | null;
  getPoses: () => { poses: ActorPoses; at: number };
  getTransition: () => TransitionView | null;
  assets: Asset[];
  canvasW: number;
  canvasH: number;
  /** Audience output window: never draw operator-only markers. */
  isOutput: boolean;
  /** This view is allowed to play sound (program view in the audio-host window). */
  audio: boolean;
  frame: FrameState;
}

export const StageContext = createContext<StageCtx | null>(null);

export function useStage(): StageCtx {
  const c = useContext(StageContext);
  if (!c) throw new Error("useStage outside StageContext");
  return c;
}

export interface FrameState {
  wall: number;
  /** Scene time ms / seconds. */
  t: number;
  ts: number;
  tod: number;
  storm: number;
  windStrength: number;
  windDir: number;
  /** Instantaneous wind including gusts (0..~1.5). */
  windNow: number;
  flash: number;
  fogLevel: number;
  hazeLevel: number;
  sceneFogDensity: number;
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  moonIntensity: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  fogColor: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** Rough overall scene brightness for shading 2D overlays (0..1). */
  ambient: number;
  /** Multiply grade for flat media (video can't be relit, so it is graded). */
  mediaGrade: THREE.Color;
  /** Dominant key light (sun by day, moon by night) for custom shaders. */
  keyDir: THREE.Vector3;
  keyColor: THREE.Color;
  keyIntensity: number;
}

export function makeFrameState(): FrameState {
  return {
    wall: 0,
    t: 0,
    ts: 0,
    tod: 0,
    storm: 0,
    windStrength: 0.15,
    windDir: 0.5,
    windNow: 0.15,
    flash: 0,
    fogLevel: 0,
    hazeLevel: 0,
    sceneFogDensity: 0.002,
    sunDir: new THREE.Vector3(0.3, 0.6, -0.7).normalize(),
    moonDir: new THREE.Vector3(-0.4, 0.5, -0.7).normalize(),
    sunColor: new THREE.Color("#fff3e0"),
    sunIntensity: 3,
    moonIntensity: 0,
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    fogColor: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    ambient: 1,
    mediaGrade: new THREE.Color(1, 1, 1),
    keyDir: new THREE.Vector3(0, 1, 0),
    keyColor: new THREE.Color(1, 1, 1),
    keyIntensity: 1,
  };
}

// Sky palette keyed by time of day: 0 day, ~0.5 golden hour/dusk, 1 night.
const STOPS = [0, 0.42, 0.62, 1];
const ZENITH = ["#2c5c9c", "#4a6596", "#26304f", "#060a16"].map((c) => new THREE.Color(c));
const HORIZON = ["#aac3dc", "#f0b47a", "#b0614a", "#18233a"].map((c) => new THREE.Color(c));
const SUNCOL = ["#fff4e2", "#ffc788", "#ff8a4a", "#ff8a4a"].map((c) => new THREE.Color(c));
const HEMI_SKY = ["#c4d8f0", "#e8c6a0", "#7a6a8a", "#2c3c63"].map((c) => new THREE.Color(c));
const HEMI_GROUND = ["#8a7350", "#7a5a3c", "#3a2c2a", "#0f1118"].map((c) => new THREE.Color(c));
const STORM_Z = new THREE.Color("#3b4048");
const STORM_H = new THREE.Color("#6a707a");
const tmp = new THREE.Color();
const MOON = new THREE.Color("#9fb4ff");

function sampleStops(arr: THREE.Color[], tod: number, out: THREE.Color) {
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (tod <= STOPS[i + 1]) {
      const k = (tod - STOPS[i]) / (STOPS[i + 1] - STOPS[i]);
      return out.copy(arr[i]).lerp(arr[i + 1], clamp(k, 0, 1));
    }
  }
  return out.copy(arr[arr.length - 1]);
}

/** Lightning flicker: a main flash and two re-strikes, scaled to the strike duration. */
export function flashCurve(dtSec: number, duration: number): number {
  if (dtSec < 0 || dtSec > duration * 1.6) return 0;
  const k = duration / 0.55;
  const pulse = (at: number, amp: number, decay: number) => {
    const x = dtSec - at * k;
    return x < 0 ? 0 : amp * Math.exp(-x / (decay * k));
  };
  return Math.min(1.4, pulse(0, 1, 0.06) + pulse(0.11, 0.75, 0.05) + pulse(0.27, 0.9, 0.09));
}

/** Update the per-frame environment state from the runtime. */
export function updateFrame(f: FrameState, rt: SceneRuntime, wall: number) {
  const t = sceneNow(rt, wall);
  f.wall = wall;
  f.t = t;
  f.ts = t / 1000;
  const env = envAt(rt, t);
  f.tod = clamp(env.timeOfDay, 0, 1);
  f.storm = clamp(env.storm, 0, 1);

  let windS = 0.12 + f.storm * 0.35;
  let windD = 0.5;
  let gust = 0.3;
  let fog = 0;
  let haze = 0;
  let gradeColor = "#5d6f9e";
  let gradeAmount = 0.75;
  for (const c of rt.scene.components) {
    if (c.kind !== "effect") continue;
    const e = rt.effects[c.id];
    if (!e) continue;
    const lvl = effectLevel(c.effect, e.active, e.changedAt, e.params, t);
    if (c.effect === "wind" && lvl > 0) {
      windS = Math.max(windS, lerp(windS, num(e.params, "strength", 0.7), lvl));
      windD = lerp(windD, num(e.params, "direction", 0.5), lvl);
      gust = num(e.params, "gust", 0.5);
    } else if (c.effect === "fog") fog = Math.max(fog, lvl * num(e.params, "density", 0.6));
    else if (c.effect === "haze") haze = Math.max(haze, lvl * num(e.params, "density", 0.4));
    else if (c.effect === "daynight") {
      gradeColor = str(e.params, "gradeColor", gradeColor);
      gradeAmount = num(e.params, "gradeAmount", gradeAmount);
    }
  }
  f.windStrength = windS;
  f.windDir = windD;
  const s = f.ts;
  f.windNow = windS * (1 + gust * 0.6 * (Math.sin(s * 0.7) * 0.5 + Math.sin(s * 1.9 + 1.3) * 0.3 + Math.sin(s * 4.1) * 0.2));
  f.fogLevel = fog;
  f.hazeLevel = haze;

  let flash = 0;
  for (const st of rt.strikes) flash += flashCurve((t - st.at) / 1000, st.duration) * st.brightness;
  f.flash = flash;

  // Sun / moon path.
  // Day: key light from the right, slightly behind the audience so actors are lit.
  // Toward dusk the sun swings into frame so the sunset glow is visible.
  const sunElev = lerp(0.72, -0.25, smoothstep(0, 0.85, f.tod));
  const az = lerp(0.35, -0.9, smoothstep(0.15, 0.55, f.tod));
  const ce = Math.cos(sunElev);
  f.sunDir.set(ce * Math.cos(az) * 0.9, Math.sin(sunElev), ce * Math.sin(az)).normalize();
  // Photographic environments: the sun must sit where it is in the photo (low, front-left).
  if (rt.scene.environment === "shepherd-photoreal") f.sunDir.set(-0.62 * ce, Math.sin(sunElev), -0.78 * ce).normalize();
  f.moonDir.set(-0.5, 0.42, -0.8).normalize();

  sampleStops(ZENITH, f.tod, f.zenith).lerp(tmp.copy(STORM_Z).multiplyScalar(1 - f.tod * 0.85), f.storm * 0.85);
  sampleStops(HORIZON, f.tod, f.horizon).lerp(tmp.copy(STORM_H).multiplyScalar(1 - f.tod * 0.85), f.storm * 0.8);
  sampleStops(SUNCOL, f.tod, f.sunColor);
  sampleStops(HEMI_SKY, f.tod, f.hemiSky);
  sampleStops(HEMI_GROUND, f.tod, f.hemiGround);

  const day = 1 - smoothstep(0.55, 0.85, f.tod);
  f.sunIntensity = 3.2 * day * (1 - 0.82 * f.storm) * smoothstep(-0.05, 0.12, f.sunDir.y);
  f.moonIntensity = 0.5 * smoothstep(0.65, 1, f.tod) * (1 - 0.6 * f.storm);
  f.hemiIntensity = lerp(1.15, 0.32, smoothstep(0.3, 1, f.tod)) * (1 - 0.3 * f.storm) + flash * 2.2;
  f.ambient = clamp(lerp(1, 0.18, smoothstep(0.3, 1, f.tod)) * (1 - 0.35 * f.storm) + flash * 0.6, 0, 1.5);

  const total = f.sunIntensity + f.moonIntensity + 1e-4;
  const ws = f.sunIntensity / total;
  f.keyColor.copy(MOON).lerp(f.sunColor, ws);
  f.keyDir.copy(f.moonDir).lerp(f.sunDir, ws).normalize();
  f.keyIntensity = f.sunIntensity + f.moonIntensity;

  const nightK = smoothstep(0.25, 1, f.tod) * gradeAmount;
  f.mediaGrade
    .set(1, 1, 1)
    .lerp(tmp.set(gradeColor), nightK)
    .multiplyScalar((1 - 0.35 * f.storm) * (1 - 0.35 * nightK))
    .addScalar(flash * 0.5);
  f.fogColor.copy(f.horizon).lerp(tmp.set("#9aa0a8").multiplyScalar(f.ambient), 0.25 + f.storm * 0.3);
  f.sceneFogDensity = 0.0016 + haze * 0.0045 + fog * 0.012 + f.storm * 0.0035;
}
