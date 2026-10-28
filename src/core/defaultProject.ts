import {
  defaultOutput,
  defaultActorLayout,
  makeClip,
  makeClipActor,
  makeBackground,
  makeCue,
  makeEffect,
  makeProcedural,
  makeScene,
  makeShot,
  defaultTimers,
} from "./factories";
import type { Asset, EffectPreset, Project, Scene } from "./types";
import { FOH_ASSETS, FOH_CALLS, FOH_PIN, fohAnnouncements } from "./fohCalls";
import { SFX_ASSETS } from "./sfxLibrary";
import { EFFECT_DEFS } from "./effects";
import { uid } from "./ids";

/** The Shepherd's Valley — open pasture with sheep, olive trees and a night fire. */
function shepherdsValley(): Scene {
  const day = makeBackground("Pasture Day", { initiallyVisible: true, env: { timeOfDay: 0.05, storm: 0 } });
  const golden = makeBackground("Golden Hour", { env: { timeOfDay: 0.45, storm: 0 }, transitionDuration: 10 });
  const night = makeBackground("Starry Night", { env: { timeOfDay: 1, storm: 0 }, transitionDuration: 12 });
  const overcast = makeBackground("Overcast", { env: { timeOfDay: 0.15, storm: 0.6 }, transitionDuration: 8 });

  const sheep = makeProcedural("sheep", { center: [-4, -30], radius: 16, count: 30 });
  const birds = makeProcedural("birds", { center: [-20, -150], radius: 70, count: 22 });
  const fire = makeProcedural("campfire", { center: [7, -16], radius: 1, initiallyVisible: true });
  const town = makeProcedural("town-lights", { center: [60, -420], radius: 50, count: 40 });

  const haze = makeEffect("haze", { initiallyVisible: true, params: { ...EFFECT_DEFS.haze.defaults, density: 0.3, tint: "#dfe6ee", opacity: 0.35 } });
  const fog = makeEffect("fog", { params: { ...EFFECT_DEFS.fog.defaults, density: 0.5, height: 0.25, color: "#cfd6e2", speed: 0.25 } });
  const rain = makeEffect("rain", { params: { ...EFFECT_DEFS.rain.defaults, intensity: 0.45 } });
  const lightning = makeEffect("lightning");
  const wind = makeEffect("wind", { params: { ...EFFECT_DEFS.wind.defaults, strength: 0.45 } });
  const daynight = makeEffect("daynight", { params: { ...EFFECT_DEFS.daynight.defaults, duration: 14 } });

  const wide = makeShot("Wide Pasture", { pose: { position: [0, 2.2, 14], target: [0, 1.2, -40], hfov: 76 } });
  const flock = makeShot("Toward the Flock", { pose: { position: [-3, 1.8, -2], target: [-5, 0.6, -32], hfov: 64 }, duration: 9 });
  const sky = makeShot("Tilt to Sky", { pose: { position: [0, 2.2, 14], target: [0, 26, -40], hfov: 80 }, duration: 7 });
  const fireShot = makeShot("Shepherds' Fire", { pose: { position: [4, 1.4, -4], target: [7, 0.7, -16], hfov: 60 }, duration: 6 });

  const s = makeScene(2, "The Shepherd's Valley", {
    environment: "shepherd-valley",
    notes: "\"There were shepherds abiding in the field, keeping watch over their flock by night.\"",
    duration: 360,
    components: [day, golden, night, overcast, sheep, birds, fire, town, haze, fog, rain, lightning, wind, daynight],
    cameraShots: [wide, flock, sky, fireShot],
    defaultShotId: wide.id,
    markers: { center: [0, -10], flock: [-4, -30], fire: [7, -16] },
    transition: { kind: "travel", duration: 6, videoAssetId: null, audioAssetId: null, travelDistance: 70 },
  });
  s.cues = [
    makeCue("Evening settles", [{ type: "background", backgroundId: golden.id, delay: 0 }]),
    makeCue("Night watch", [
      { type: "background", backgroundId: night.id, delay: 0 },
      { type: "effect", effectId: fog.id, op: "start", delay: 4 },
    ]),
    makeCue("Glory of the Lord (sky)", [
      { type: "camera", shotId: sky.id, delay: 0 },
      { type: "effect", effectId: fog.id, op: "stop", delay: 0 },
    ]),
    makeCue("Back to the flock", [{ type: "camera", shotId: flock.id, delay: 0 }]),
  ];
  return s;
}

/** Assets generated for the photoreal proof (served from public/media/lion-proof). */
export const LION_PROOF_ASSETS: Asset[] = [
  { id: "asset_lp_plate", name: "Lion proof · clean plate.jpg", type: "image", url: "/media/lion-proof/clean-plate.jpg", builtIn: true },
  { id: "asset_lp_hero", name: "Lion proof · hero frame.jpg", type: "image", url: "/media/lion-proof/hero-frame.jpg", builtIn: true },
  { id: "asset_lp_walk", name: "Lion proof · walk-in.mp4", type: "video", url: "/media/lion-proof/lion-walk-in.mp4", builtIn: true },
  { id: "asset_lp_roar", name: "Lion proof · roar.mp4", type: "video", url: "/media/lion-proof/lion-roar.mp4", builtIn: true },
  { id: "asset_lp_idle", name: "Lion proof · idle pacing.mp4", type: "video", url: "/media/lion-proof/lion-idle-pace.mp4", builtIn: true },
  { id: "asset_lp_walk_cut", name: "Lion proof · walk-in (cut-out).webm", type: "video", url: "/media/lion-proof/lion-walk-in-cutout.webm", macUrl: "/media/lion-proof/lion-walk-in-cutout.mov", builtIn: true, hasAlpha: true },
  { id: "asset_lp_roar_cut", name: "Lion proof · roar (cut-out).webm", type: "video", url: "/media/lion-proof/lion-roar-cutout.webm", macUrl: "/media/lion-proof/lion-roar-cutout.mov", builtIn: true, hasAlpha: true },
  { id: "asset_lp_idle_cut", name: "Lion proof · idle pacing (cut-out).webm", type: "video", url: "/media/lion-proof/lion-idle-pace-cutout.webm", macUrl: "/media/lion-proof/lion-idle-pace-cutout.mov", builtIn: true, hasAlpha: true },
];

/** Full-frame clip asset → its background-removed twin. */
export const LION_PROOF_CUTOUTS: Record<string, string> = {
  asset_lp_walk: "asset_lp_walk_cut",
  asset_lp_roar: "asset_lp_roar_cut",
  asset_lp_idle: "asset_lp_idle_cut",
};

/** Layout for the proof lion: feet point and horizon measured on the hero frame. */
export const lionProofLayout = () => ({ ...defaultActorLayout(), pivotX: 0.67, pivotY: 0.74, horizonY: 0.22, shadow: 0.55 });

/** The pacing idle: loops on the hero pose and takes over whenever another clip ends there. */
export function lionProofIdleClip() {
  return makeClip("Paces (idle)", { assetId: "asset_lp_idle", cutoutAssetId: "asset_lp_idle_cut", startPose: "hero", endPose: "hero", duration: 10.04, loop: true, autoIdle: true });
}

export const LION_PROOF_DEMO = "lion-proof-v1";

/**
 * Photoreal proof of Scene 01: an AI-generated clean plate with an AI-video
 * lion whose clips chain on a shared "hero" frame, plus the live effects.
 */
export function lionProofScene(number: number): Scene {
  const plate = makeBackground("Golden Hour Valley (plate)", {
    initiallyVisible: true,
    source: "media",
    media: { assetId: "asset_lp_plate", loop: true, playbackRate: 1, startTime: 0, endTime: null, muted: true, volume: 1 },
    fit: "cover",
    anchorY: 0.3,
    transitionDuration: 2,
  });
  const walk = makeClip("Walks in", { assetId: "asset_lp_walk", cutoutAssetId: "asset_lp_walk_cut", startPose: "empty", endPose: "hero", duration: 10.08 });
  const roar = makeClip("Roars", { assetId: "asset_lp_roar", cutoutAssetId: "asset_lp_roar_cut", startPose: "hero", endPose: "hero", duration: 6.08 });
  const lion = makeClipActor("Lion (AI video)", { clips: [walk, roar, lionProofIdleClip()], restPose: "empty", frameAspect: 2912 / 1248, anchorY: 0.3, matted: false, layout: lionProofLayout() });
  const haze = makeEffect("haze", { initiallyVisible: true, params: { ...EFFECT_DEFS.haze.defaults, density: 0.2, opacity: 0.3 } });
  const rain = makeEffect("rain");
  const lightning = makeEffect("lightning");
  const fog = makeEffect("fog", { params: { ...EFFECT_DEFS.fog.defaults, density: 0.5, height: 0.22, color: "#d9c9ad" } });
  const wind = makeEffect("wind");
  const daynight = makeEffect("daynight");
  const s = makeScene(number, "David and the Lion · Photoreal (AI proof)", {
    environment: "none",
    notes: "Proof of the AI-video pipeline: clean plate + chained lion clips (walk-in ends on the hero pose, roar starts and ends on it). Drafts are 480p; final renders will be 4K.",
    components: [plate, lion, haze, fog, rain, lightning, wind, daynight],
    markers: {},
    transition: { kind: "fadeblack", duration: 2, videoAssetId: null, audioAssetId: null, travelDistance: 60 },
  });
  s.cues = [
    makeCue("Lion walks in", [{ type: "clip", actorId: lion.id, clipId: walk.id, delay: 0 }]),
    makeCue("Lion roars", [{ type: "clip", actorId: lion.id, clipId: roar.id, delay: 0 }]),
    makeCue("Storm rolls in", [
      { type: "effect", effectId: wind.id, op: "start", delay: 0 },
      { type: "effect", effectId: rain.id, op: "start", delay: 2 },
      { type: "effect", effectId: lightning.id, op: "trigger", delay: 4 },
    ]),
    makeCue("Lightning strike", [{ type: "effect", effectId: lightning.id, op: "trigger", delay: 0 }]),
    makeCue("Storm clears", [
      { type: "effect", effectId: rain.id, op: "stop", delay: 0 },
      { type: "effect", effectId: wind.id, op: "stop", delay: 2 },
    ]),
    makeCue("Clear the lion", [{ type: "clip", actorId: lion.id, clipId: null, delay: 0 }]),
  ];
  return s;
}

export function defaultEffectPresets(): EffectPreset[] {
  return [
    { id: uid("pre"), name: "Light Drizzle", effect: "rain", params: { ...EFFECT_DEFS.rain.defaults, intensity: 0.3, speed: 11, opacity: 0.55 } },
    { id: uid("pre"), name: "Heavy Downpour", effect: "rain", params: { ...EFFECT_DEFS.rain.defaults, intensity: 1, speed: 24, wind: 0.45, opacity: 0.85 } },
    { id: uid("pre"), name: "Low Valley Mist", effect: "fog", params: { ...EFFECT_DEFS.fog.defaults, density: 0.5, height: 0.22, speed: 0.2 } },
    { id: uid("pre"), name: "Thick Night Fog", effect: "fog", params: { ...EFFECT_DEFS.fog.defaults, density: 0.9, height: 0.6, color: "#8d95a6" } },
    { id: uid("pre"), name: "Distant Lightning", effect: "lightning", params: { ...EFFECT_DEFS.lightning.defaults, brightness: 0.5, thunderDelay: 3.5 } },
    { id: uid("pre"), name: "Close Strike", effect: "lightning", params: { ...EFFECT_DEFS.lightning.defaults, brightness: 1.8, thunderDelay: 0.2, duration: 0.8 } },
  ];
}

export function defaultProject(): Project {
  const scenes = [lionProofScene(1), shepherdsValley()];
  return {
    version: 1,
    name: "LiveStage demo",
    scenes: scenes.map((x, i) => ({ ...x, number: i + 1 })),
    assets: [...LION_PROOF_ASSETS, ...FOH_ASSETS, ...SFX_ASSETS],
    demoAdditions: [LION_PROOF_DEMO, "lion-proof-anchor", "lion-proof-idle", "lion-proof-cutout", FOH_CALLS, FOH_PIN],
    effectPresets: defaultEffectPresets(),
    output: defaultOutput(),
    timers: defaultTimers(),
    announcements: fohAnnouncements(),
  };
}
