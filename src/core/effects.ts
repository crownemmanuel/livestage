import type { EffectParams, EffectType } from "./types";

export type ParamSpec =
  | { key: string; label: string; type: "range"; min: number; max: number; step: number; unit?: string; live?: boolean }
  | { key: string; label: string; type: "color"; live?: boolean }
  | { key: string; label: string; type: "bool"; live?: boolean }
  | { key: string; label: string; type: "asset"; assetType: "video" | "audio" | "image" };

export interface EffectDef {
  type: EffectType;
  label: string;
  /** "toggle" effects start/stop; "trigger" effects fire one-shot events. */
  mode: "toggle" | "trigger";
  startLabel: string;
  stopLabel?: string;
  defaults: EffectParams;
  params: ParamSpec[];
}

export const EFFECT_DEFS: Record<EffectType, EffectDef> = {
  rain: {
    type: "rain",
    label: "Rain",
    mode: "toggle",
    startLabel: "Start Rain",
    stopLabel: "Stop Rain",
    defaults: { intensity: 0.7, speed: 16, wind: 0.25, opacity: 0.75, fadeIn: 4, fadeOut: 5, splashes: true },
    params: [
      { key: "intensity", label: "Intensity", type: "range", min: 0.05, max: 1, step: 0.01, live: true },
      { key: "speed", label: "Particle speed", type: "range", min: 4, max: 32, step: 0.5, unit: "m/s", live: true },
      { key: "wind", label: "Wind direction", type: "range", min: -1, max: 1, step: 0.01, live: true },
      { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "fadeIn", label: "Fade in", type: "range", min: 0, max: 20, step: 0.5, unit: "s" },
      { key: "fadeOut", label: "Fade out", type: "range", min: 0, max: 20, step: 0.5, unit: "s" },
      { key: "splashes", label: "Ground splashes", type: "bool", live: true },
    ],
  },
  snow: {
    type: "snow",
    label: "Snow",
    mode: "toggle",
    startLabel: "Start Snow",
    stopLabel: "Stop Snow",
    defaults: { intensity: 0.6, speed: 1.6, wind: 0.15, size: 1, opacity: 0.9, fadeIn: 5, fadeOut: 8 },
    params: [
      { key: "intensity", label: "Intensity", type: "range", min: 0.05, max: 1, step: 0.01, live: true },
      { key: "speed", label: "Fall speed", type: "range", min: 0.3, max: 6, step: 0.1, unit: "m/s", live: true },
      { key: "wind", label: "Wind drift", type: "range", min: -1, max: 1, step: 0.01, live: true },
      { key: "size", label: "Flake size", type: "range", min: 0.3, max: 3, step: 0.05, live: true },
      { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "fadeIn", label: "Fade in", type: "range", min: 0, max: 30, step: 0.5, unit: "s" },
      { key: "fadeOut", label: "Fade out", type: "range", min: 0, max: 30, step: 0.5, unit: "s" },
    ],
  },
  lightning: {
    type: "lightning",
    label: "Lightning",
    mode: "trigger",
    startLabel: "Strike",
    defaults: {
      brightness: 1,
      duration: 0.55,
      thunder: true,
      thunderDelay: 1.2,
      thunderVolume: 0.9,
      boltVideoAssetId: "",
      thunderAssetId: "",
    },
    params: [
      { key: "brightness", label: "Brightness", type: "range", min: 0.1, max: 2, step: 0.05 },
      { key: "duration", label: "Flash duration", type: "range", min: 0.1, max: 1.5, step: 0.05, unit: "s" },
      { key: "thunder", label: "Thunder sound", type: "bool" },
      { key: "thunderDelay", label: "Thunder delay", type: "range", min: 0, max: 6, step: 0.1, unit: "s" },
      { key: "thunderVolume", label: "Thunder volume", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "boltVideoAssetId", label: "Bolt video (optional)", type: "asset", assetType: "video" },
      { key: "thunderAssetId", label: "Thunder audio (optional)", type: "asset", assetType: "audio" },
    ],
  },
  fog: {
    type: "fog",
    label: "Fog",
    mode: "toggle",
    startLabel: "Fog In",
    stopLabel: "Fog Out",
    defaults: { density: 0.65, height: 0.35, color: "#c9ccd2", speed: 0.4, fadeIn: 6, fadeOut: 6 },
    params: [
      { key: "density", label: "Density", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "height", label: "Height", type: "range", min: 0.05, max: 1, step: 0.01, live: true },
      { key: "color", label: "Color", type: "color", live: true },
      { key: "speed", label: "Movement speed", type: "range", min: 0, max: 2, step: 0.05, live: true },
      { key: "fadeIn", label: "Fade in", type: "range", min: 0, max: 30, step: 0.5, unit: "s" },
      { key: "fadeOut", label: "Fade out", type: "range", min: 0, max: 30, step: 0.5, unit: "s" },
    ],
  },
  haze: {
    type: "haze",
    label: "Haze",
    mode: "toggle",
    startLabel: "Haze In",
    stopLabel: "Haze Out",
    defaults: { density: 0.45, tint: "#d8cdb8", opacity: 0.5, fade: 4 },
    params: [
      { key: "density", label: "Density", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "tint", label: "Tint", type: "color", live: true },
      { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "fade", label: "Fade", type: "range", min: 0, max: 20, step: 0.5, unit: "s" },
    ],
  },
  wind: {
    type: "wind",
    label: "Wind",
    mode: "toggle",
    startLabel: "Wind Up",
    stopLabel: "Calm",
    defaults: { strength: 0.7, direction: 0.6, gust: 0.5, fade: 3 },
    params: [
      { key: "strength", label: "Strength", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "direction", label: "Direction", type: "range", min: -1, max: 1, step: 0.01, live: true },
      { key: "gust", label: "Gustiness", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "fade", label: "Ramp", type: "range", min: 0, max: 15, step: 0.5, unit: "s" },
    ],
  },
  shake: {
    type: "shake",
    label: "Screen Shake",
    mode: "trigger",
    startLabel: "Shake",
    defaults: { intensity: 0.025, duration: 1.2, frequency: 14 },
    params: [
      { key: "intensity", label: "Intensity", type: "range", min: 0.002, max: 0.08, step: 0.001 },
      { key: "duration", label: "Duration", type: "range", min: 0.1, max: 6, step: 0.05, unit: "s" },
      { key: "frequency", label: "Frequency", type: "range", min: 2, max: 30, step: 0.5, unit: "Hz" },
    ],
  },
  projectile: {
    type: "projectile",
    label: "Projectile (sling stone)",
    mode: "trigger",
    startLabel: "Throw",
    defaults: { fromX: 0.05, fromY: 0.8, toX: 0.62, toY: 0.12, arc: 0.12, duration: 0.55, size: 0.028, glow: 1, flash: true },
    params: [
      { key: "fromX", label: "From X", type: "range", min: -0.2, max: 1.2, step: 0.005 },
      { key: "fromY", label: "From Y", type: "range", min: -0.2, max: 1.2, step: 0.005 },
      { key: "toX", label: "Target X", type: "range", min: -0.2, max: 1.2, step: 0.005 },
      { key: "toY", label: "Target Y", type: "range", min: -0.2, max: 1.2, step: 0.005 },
      { key: "arc", label: "Arc height", type: "range", min: -0.3, max: 0.4, step: 0.005 },
      { key: "duration", label: "Flight time", type: "range", min: 0.15, max: 3, step: 0.01, unit: "s" },
      { key: "size", label: "Stone size", type: "range", min: 0.004, max: 0.08, step: 0.001 },
      { key: "glow", label: "Glow + streak", type: "range", min: 0, max: 2, step: 0.05 },
      { key: "flash", label: "Impact flash", type: "bool" },
    ],
  },
  stars: {
    type: "stars",
    label: "Starfield",
    mode: "toggle",
    startLabel: "Stars Out",
    stopLabel: "Stars Away",
    defaults: { density: 0.6, brightness: 0.9, twinkle: 0.5, horizon: 0.55, rotate: 0, stretch: 0, drift: 0.02, tint: "#dfe6ff", fade: 4 },
    params: [
      { key: "density", label: "Density", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "brightness", label: "Brightness", type: "range", min: 0, max: 2, step: 0.01, live: true },
      { key: "twinkle", label: "Twinkle", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "horizon", label: "Horizon (from top)", type: "range", min: 0, max: 1.2, step: 0.01, live: true },
      { key: "rotate", label: "Turn (dream)", type: "range", min: -1, max: 1, step: 0.01, live: true },
      { key: "stretch", label: "Stretch (dream)", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "drift", label: "Drift", type: "range", min: 0, max: 0.3, step: 0.005, live: true },
      { key: "tint", label: "Tint", type: "color", live: true },
      { key: "fade", label: "Fade", type: "range", min: 0, max: 20, step: 0.5, unit: "s" },
    ],
  },
  glow: {
    type: "glow",
    label: "Divine Light",
    mode: "toggle",
    startLabel: "Light Up",
    stopLabel: "Light Down",
    defaults: { x: 0.5, y: 0.35, radius: 0.45, intensity: 0.9, color: "#ffe9b8", rays: 0.6, raySpeed: 0.15, pulse: 0.15, fade: 3 },
    params: [
      { key: "x", label: "Centre X", type: "range", min: -0.5, max: 1.5, step: 0.005, live: true },
      { key: "y", label: "Centre Y", type: "range", min: -0.5, max: 1.5, step: 0.005, live: true },
      { key: "radius", label: "Radius", type: "range", min: 0.05, max: 2, step: 0.01, live: true },
      { key: "intensity", label: "Intensity", type: "range", min: 0, max: 3, step: 0.01, live: true },
      { key: "color", label: "Colour", type: "color", live: true },
      { key: "rays", label: "God rays", type: "range", min: 0, max: 1.5, step: 0.01, live: true },
      { key: "raySpeed", label: "Ray movement", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "pulse", label: "Breathing", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "fade", label: "Fade", type: "range", min: 0, max: 30, step: 0.5, unit: "s" },
    ],
  },
  heat: {
    type: "heat",
    label: "Heat Shimmer",
    mode: "toggle",
    startLabel: "Shimmer On",
    stopLabel: "Shimmer Off",
    defaults: { amount: 0.6, height: 0.5, speed: 1, tint: "#ffd9a0", fade: 4 },
    params: [
      { key: "amount", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "height", label: "Height", type: "range", min: 0.05, max: 1, step: 0.01, live: true },
      { key: "speed", label: "Speed", type: "range", min: 0.1, max: 4, step: 0.05, live: true },
      { key: "tint", label: "Tint", type: "color", live: true },
      { key: "fade", label: "Fade", type: "range", min: 0, max: 20, step: 0.5, unit: "s" },
    ],
  },
  lights: {
    type: "lights",
    label: "Window Lights",
    mode: "toggle",
    startLabel: "Lights On",
    stopLabel: "Lights Out",
    defaults: { count: 60, seed: 7, x: 0.5, y: 0.55, w: 0.9, h: 0.3, size: 1, color: "#ffb55c", flicker: 0.5, spread: 12, order: 0, fade: 1.5 },
    params: [
      { key: "count", label: "Count", type: "range", min: 1, max: 400, step: 1 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 999, step: 1 },
      { key: "x", label: "Area centre X", type: "range", min: 0, max: 1, step: 0.005, live: true },
      { key: "y", label: "Area centre Y", type: "range", min: 0, max: 1, step: 0.005, live: true },
      { key: "w", label: "Area width", type: "range", min: 0.02, max: 1.2, step: 0.005, live: true },
      { key: "h", label: "Area height", type: "range", min: 0.02, max: 1.2, step: 0.005, live: true },
      { key: "size", label: "Light size", type: "range", min: 0.2, max: 4, step: 0.05, live: true },
      { key: "color", label: "Colour", type: "color", live: true },
      { key: "flicker", label: "Flicker (torches)", type: "range", min: 0, max: 1, step: 0.01, live: true },
      { key: "spread", label: "Spread time", type: "range", min: 0, max: 90, step: 0.5, unit: "s" },
      { key: "order", label: "Order (0 random, 1 left→right, 2 centre out)", type: "range", min: 0, max: 2, step: 1 },
      { key: "fade", label: "Per-light fade", type: "range", min: 0, max: 10, step: 0.1, unit: "s" },
    ],
  },
  daynight: {
    type: "daynight",
    label: "Day / Night",
    mode: "toggle",
    startLabel: "Go to Night",
    stopLabel: "Go to Day",
    defaults: { duration: 8, gradeColor: "#5d6f9e", gradeAmount: 0.75 },
    params: [
      { key: "duration", label: "Transition", type: "range", min: 0, max: 60, step: 0.5, unit: "s" },
      { key: "gradeColor", label: "Night grade (video)", type: "color" },
      { key: "gradeAmount", label: "Grade strength", type: "range", min: 0, max: 1, step: 0.01 },
    ],
  },
};

export const EFFECT_TYPES = Object.keys(EFFECT_DEFS) as EffectType[];

export const num = (p: EffectParams, k: string, d = 0) => {
  const v = p[k];
  return typeof v === "number" ? v : d;
};
export const str = (p: EffectParams, k: string, d = "") => {
  const v = p[k];
  return typeof v === "string" ? v : d;
};
export const bool = (p: EffectParams, k: string, d = false) => {
  const v = p[k];
  return typeof v === "boolean" ? v : d;
};
