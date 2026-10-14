import {
  defaultOutput,
  defaultActorLayout,
  defaultLook,
  makeClip,
  makeClipActor,
  makeBackground,
  makeCue,
  makeEffect,
  makeImageLayer,
  makeLion,
  makeProcedural,
  makeScene,
  makeShot,
  makeVideoLayer,
} from "./factories";
import type { Asset, Cue, EffectPreset, Project, Scene } from "./types";
import { EFFECT_DEFS, num } from "./effects";
import { uid } from "./ids";

/** Scene 01: David and the Lion — interactive lion on rocky golden hills. */
function davidAndTheLion(): Scene {
  const day = makeBackground("Valley Day", { initiallyVisible: true, env: { timeOfDay: 0, storm: 0 } });
  const dusk = makeBackground("Valley Dusk", { env: { timeOfDay: 0.55, storm: 0.1 }, transitionDuration: 10 });
  const night = makeBackground("Valley Night", { env: { timeOfDay: 1, storm: 0 }, transitionDuration: 10 });
  const storm = makeBackground("Stormy Valley", { env: { timeOfDay: 0.25, storm: 1 }, transitionDuration: 8 });

  const lion = makeLion("Lion");
  const birds = makeProcedural("birds", { center: [10, -120], radius: 60, count: 14 });

  const rain = makeEffect("rain");
  const lightning = makeEffect("lightning");
  const fog = makeEffect("fog", { params: { ...EFFECT_DEFS.fog.defaults, density: 0.55, height: 0.3 } });
  const haze = makeEffect("haze", { initiallyVisible: true, params: { ...EFFECT_DEFS.haze.defaults, density: 0.35, opacity: 0.4 } });
  const wind = makeEffect("wind");
  const daynight = makeEffect("daynight");

  const wide = makeShot("Wide", { pose: { position: [0, 1.8, 12], target: [0, 1.6, -30], hfov: 74 } });
  const push = makeShot("Move Forward", { pose: { position: [0, 1.6, 2], target: [0, 1.3, -30], hfov: 70 }, duration: 8 });
  const panL = makeShot("Pan Left", { pose: { position: [0, 1.8, 12], target: [-22, 2, -26], hfov: 74 }, duration: 6 });
  const focus = makeShot("Focus on Lion", { followActorId: lion.id, followOffset: [3, 1.6, 9], duration: 3, pose: { position: [0, 1.6, 6], target: [0, 1, -10], hfov: 52 } });
  const low = makeShot("Low Heroic", { pose: { position: [1.5, 0.6, 9], target: [0, 2.6, -18], hfov: 78 }, duration: 5 });

  const sceneId = uid("scene");
  const s = makeScene(1, "David and the Lion", {
    id: sceneId,
    environment: "lion-hills",
    notes: "Young David defends his flock. Lion enters upstage left and approaches David's stage position.",
    duration: 420,
    components: [day, dusk, night, storm, lion, birds, haze, rain, lightning, fog, wind, daynight],
    cameraShots: [wide, push, panL, focus, low],
    defaultShotId: wide.id,
    markers: {
      distance: [-12, -54],
      ridge: [9, -40],
      midway: [-5, -24],
      stop: [-1.5, -10],
      david: [1.8, 3.2],
      center: [0, -8],
    },
    transition: { kind: "fadeblack", duration: 2.5, videoAssetId: null, audioAssetId: null, travelDistance: 60 },
  });

  const A = lion.id;
  s.cues = [
    makeCue("Lion appears in the distance", [
      { type: "lion.place", actorId: A, marker: "distance", heading: Math.PI * 0.85, delay: 0 },
      { type: "actor.visible", actorId: A, visible: true, delay: 0 },
      { type: "lion", actorId: A, action: "idle", delay: 0 },
    ]),
    makeCue("Lion walks toward David", [{ type: "lion.moveTo", actorId: A, marker: "stop", gait: "walk", delay: 0 }]),
    makeCue("Lion stops", [{ type: "lion", actorId: A, action: "idle", delay: 0 }]),
    makeCue("Lion roars", [{ type: "lion", actorId: A, action: "roar", delay: 0 }]),
    makeCue("Lion approaches", [{ type: "lion.moveTo", actorId: A, marker: "david", gait: "walk", delay: 0 }]),
    makeCue("Lion attacks", [{ type: "lion", actorId: A, action: "attack", delay: 0 }]),
    makeCue("David strikes", [{ type: "lion", actorId: A, action: "hit", delay: 0 }]),
    makeCue("Lion falls", [{ type: "lion", actorId: A, action: "fall", delay: 0 }]),
    makeCue("Storm rolls in", [
      { type: "background", backgroundId: storm.id, delay: 0 },
      { type: "effect", effectId: wind.id, op: "start", delay: 0 },
      { type: "effect", effectId: rain.id, op: "start", delay: 3 },
      { type: "effect", effectId: lightning.id, op: "trigger", delay: 5 },
      { type: "effect", effectId: lightning.id, op: "trigger", delay: 11 },
    ]),
    makeCue("Storm clears", [
      { type: "effect", effectId: rain.id, op: "stop", delay: 0 },
      { type: "effect", effectId: wind.id, op: "stop", delay: 2 },
      { type: "background", backgroundId: day.id, delay: 3 },
    ]),
    makeCue("Night falls", [{ type: "background", backgroundId: night.id, delay: 0 }]),
    makeCue("Travel to Shepherd's Valley", []), // takeScene target is filled in by defaultProject()
  ];
  return s;
}

/** Scene 02: The Shepherd's Valley — open pasture with sheep, olive trees and a night fire. */
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

/** Scene 03: a template showing layered video compositing; import assets to fill it. */
function marketplaceTemplate(): Scene {
  const bg = makeBackground("Marketplace Plate", { initiallyVisible: true, source: "media" });
  const walker = makeVideoLayer("Walking Villager (alpha)");
  walker.placement = "front";
  walker.initiallyVisible = true;
  walker.screen = { x: 0.5, y: 0.66, width: 0.09, rotation: 0, flipX: false };
  walker.walker = { ...walker.walker, enabled: true, instances: 3, speed: 0.035, delayMin: 1, delayMax: 9 };
  const donkey = makeVideoLayer("Donkey (alpha)");
  donkey.screen = { x: 0.3, y: 0.7, width: 0.12, rotation: 0, flipX: false };
  const dust = makeImageLayer("Dust overlay");
  dust.screen = { x: 0.5, y: 0.5, width: 1, rotation: 0, flipX: false };
  dust.blend = "screen";
  dust.opacity = 0.4;
  const haze = makeEffect("haze", { initiallyVisible: true });
  const daynight = makeEffect("daynight");
  return makeScene(3, "Nazareth Marketplace (layer template)", {
    environment: "none",
    notes: "Template: import a clean background plate plus transparent WebM/HEVC layers. The empty slots show a 'no asset' marker in previews only.",
    components: [bg, walker, donkey, dust, haze, daynight],
    transition: { kind: "crossfade", duration: 2, videoAssetId: null, audioAssetId: null, travelDistance: 60 },
  });
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

export const SHEPHERD_PHOTOREAL_DEMO = "shepherd-photoreal-v1";

/**
 * The Shepherd's Valley, photoreal: a photographic panorama far away, a
 * photo-textured 3D field, photographic trees / sheep / rocks / grass as
 * lit billboards, and a cinematic HDR camera finish.
 */
export function shepherdPhotorealScene(number: number): Scene {
  const golden = makeBackground("Golden Hour", { initiallyVisible: true, env: { timeOfDay: 0.45, storm: 0 }, transitionDuration: 8 });
  const dusk = makeBackground("Dusk", { env: { timeOfDay: 0.62, storm: 0.05 }, transitionDuration: 12 });
  const night = makeBackground("Night Watch", { env: { timeOfDay: 1, storm: 0 }, transitionDuration: 14 });
  const overcast = makeBackground("Gathering Storm", { env: { timeOfDay: 0.42, storm: 0.7 }, transitionDuration: 10 });
  const sheep = makeProcedural("sheep", { center: [-6, -34], radius: 15, count: 27 });
  const fire = makeProcedural("campfire", { center: [7, -16], radius: 1, initiallyVisible: true });
  const birds = makeProcedural("birds", { center: [-30, -160], radius: 70, count: 14 });
  const fog = makeEffect("fog", { params: { ...EFFECT_DEFS.fog.defaults, density: 0.45, height: 0.22, color: "#d9d3c4", speed: 0.2 } });
  const rain = makeEffect("rain", { params: { ...EFFECT_DEFS.rain.defaults, intensity: 0.5 } });
  const lightning = makeEffect("lightning");
  const wind = makeEffect("wind", { params: { ...EFFECT_DEFS.wind.defaults, strength: 0.5 } });
  const daynight = makeEffect("daynight", { params: { ...EFFECT_DEFS.daynight.defaults, duration: 14 } });
  const wide = makeShot("Wide Field", { pose: { position: [0, 1.7, 12], target: [0, 1.45, -60], hfov: 74 } });
  const flock = makeShot("Among the Flock", { pose: { position: [-4, 1.4, -10], target: [-6, 0.6, -36], hfov: 56 }, duration: 10 });
  const fireShot = makeShot("Shepherds' Fire", { pose: { position: [3.5, 1.5, -6], target: [7, 0.8, -16], hfov: 58 }, duration: 7 });
  const s = makeScene(number, "The Shepherd's Valley · Photoreal", {
    environment: "shepherd-photoreal",
    notes: "Photoreal experiment: photographic panorama + photo-textured 3D field + photo cut-out trees, sheep, rocks and grass, rendered in HDR with a filmic camera finish.",
    duration: 360,
    components: [golden, dusk, night, overcast, sheep, fire, birds, fog, rain, lightning, wind, daynight],
    cameraShots: [wide, flock, fireShot],
    defaultShotId: wide.id,
    markers: { center: [0, -10], flock: [-6, -34], fire: [7, -16] },
    transition: { kind: "crossfade", duration: 3, videoAssetId: null, audioAssetId: null, travelDistance: 70 },
    look: defaultLook(),
  });
  s.cues = [
    makeCue("Dusk settles", [{ type: "background", backgroundId: dusk.id, delay: 0 }]),
    makeCue("Night watch", [{ type: "background", backgroundId: night.id, delay: 0 }]),
    makeCue("Among the flock", [{ type: "camera", shotId: flock.id, delay: 0 }]),
    makeCue("Back to the wide field", [{ type: "camera", shotId: wide.id, delay: 0 }]),
  ];
  return s;
}

// ---------------------------------------------------------------- prologue

export const PROLOGUE_DEMO = "prologue-v1";

const PR = "/media/prologue/";
const pr = (id: string, name: string, file: string, type: Asset["type"], hasAlpha = false): Asset => ({
  id: `asset_pr_${id}`,
  name: `Prologue · ${name}`,
  type,
  url: PR + file,
  builtIn: true,
  // Transparent clips ship as VP9-alpha WebM plus an HEVC-alpha .mov twin for macOS.
  ...(hasAlpha ? { hasAlpha, macUrl: PR + file.replace(/\.webm$/, ".mov") } : {}),
});

/** AI-generated prologue media (480p drafts; re-render in HQ and swap the files in place). */
export const PROLOGUE_ASSETS: Asset[] = [
  pr("wide", "fields, wide (push-in start).jpg", "p1-wide-start.jpg", "image"),
  pr("pushin", "push-in.mp4", "p1-push-in.mp4", "video"),
  pr("fields_loop", "fields loop (no sheep).mp4", "p1-fields-loop.mp4", "video"),
  pr("sheep_cut", "sheep grazing + bleats (cut-out).webm", "p1-sheep-cutout.webm", "video", true),
  pr("timelapse", "time-lapse to Lion Rock.mp4", "p1-to-p2-timelapse.mp4", "video"),
  pr("rock", "Lion Rock (night plate).jpg", "p2-rock.jpg", "image"),
  pr("lion_climb", "lion climbs onto the rock.mp4", "p2-lion-climb.mp4", "video"),
  pr("lion_idle", "lion on the rock (idle loop).mp4", "p2-lion-idle.mp4", "video"),
  pr("lion_charge", "lion roars and charges.mp4", "p2-lion-charge.mp4", "video"),
  pr("david_lion", "David on the lion.jpg", "p3-david-lion.jpg", "image"),
  pr("david_loop", "David on the lion (loop).mp4", "p3-david-lion-loop.mp4", "video"),
  pr("sky_travel", "tilt to the sky and down to Elah.mp4", "p3-to-p4-sky.mp4", "video"),
  pr("battlefield", "Valley of Elah (plate).jpg", "p4-battlefield.jpg", "image"),
  pr("battle_loop", "Valley of Elah (loop).mp4", "p4-battlefield-loop.mp4", "video"),
  pr("goliath_enter", "Goliath enters (cut-out).webm", "p4-goliath-enter-cutout.webm", "video", true),
  pr("goliath_taunt", "Goliath taunts (cut-out).webm", "p4-goliath-taunt-cutout.webm", "video", true),
  pr("goliath_fall", "Goliath is struck and falls (cut-out).webm", "p4-goliath-fall-cutout.webm", "video", true),
];

/** All prologue plates are 21:9 (2912×1248 stills, 1000×428 drafts). */
const PR_ASPECT = 2912 / 1248;
const media = (assetId: string, loop = true) => ({ assetId, loop, playbackRate: 1, startTime: 0, endTime: null, muted: true, volume: 1 });
const plate = (name: string, assetId: string, anchorY: number, loop = true) =>
  makeBackground(name, { initiallyVisible: true, source: "media", media: media(assetId, loop), fit: "cover", anchorY, transitionDuration: 1 });
const lightsOut = (on: boolean, fade: number, delay = 0) => ({ type: "blackout" as const, on, fade, delay });
const withNotes = (notes: string, cue: Cue) => ({ ...cue, notes });

/** P1 "Once upon a time": push in on the Bethlehem fields, then the field breathes and the flock grazes. */
function prologueFields(): Scene {
  const anchorY = 0.35;
  const wide = plate("Fields · opening frame", "asset_pr_wide", anchorY);
  const push = makeClip("Push in", { assetId: "asset_pr_pushin", startPose: "wide", endPose: "field", duration: 8.04 });
  const breathe = makeClip("Field breathes (loop)", { assetId: "asset_pr_fields_loop", startPose: "field", endPose: "field", duration: 10.04, loop: true, autoIdle: true });
  const camera = makeClipActor("Fields (camera move + loop)", { clips: [push, breathe], restPose: "wide", frameAspect: PR_ASPECT, anchorY, muted: true });
  const graze = makeClip("Grazing + bleats (loop)", { assetId: "asset_pr_sheep_cut", cutoutAssetId: "asset_pr_sheep_cut", startPose: "flock", endPose: "flock", duration: 20.08, loop: true, autoIdle: true });
  const sheep = makeClipActor("Sheep (cut-out, stage left)", {
    clips: [graze],
    restPose: "empty",
    frameAspect: PR_ASPECT,
    anchorY,
    matted: true,
    volume: 0.8,
    layout: { ...defaultActorLayout(), pivotX: 0.8, pivotY: 0.63, horizonY: 0.42, shadow: 0.3 },
  });
  const haze = makeEffect("haze", { initiallyVisible: true, params: { ...EFFECT_DEFS.haze.defaults, density: 0.15, tint: "#e8cfa0", opacity: 0.25 } });
  const fog = makeEffect("fog", { params: { ...EFFECT_DEFS.fog.defaults, density: 0.35, height: 0.18, color: "#e3d2b4", speed: 0.15 } });
  const s = makeScene(1, "Prologue 1 · Once Upon a Time (Bethlehem fields)", {
    environment: "none",
    notes:
      "Real David sits on the hay with one real sheep. GO 1 pushes in on the fields; when the move lands, the flock (a separate cut-out layer with bleats, stage left) starts grazing over the clean field loop. Scale or move the flock in the Inspector to match the real sheep.",
    components: [wide, camera, sheep, haze, fog],
    markers: {},
    transition: { kind: "fadeblack", duration: 3, videoAssetId: null, audioAssetId: null, travelDistance: 60 },
  });
  s.cues = [
    withNotes("GO on the narrator's first words, \"Once upon a time…\" (NAR-01, 8.0 s): the move lands as he says \"…a young shepherd called David.\"", makeCue("Push in (Once upon a time)", [
      { type: "clip", actorId: camera.id, clipId: push.id, delay: 0 },
      // The flock takes over from the sheep baked into the push-in on its last frame.
      { type: "clip", actorId: sheep.id, clipId: graze.id, delay: push.duration },
    ])),
    withNotes("GO as David's song to the sheep ends: the 10 s day-to-night move should land on \"Then one day…\" (NAR-04).", makeCue("Time-lapse to the wilderness", [])), // takeScene target filled in by prologueScenes()
  ];
  return s;
}

/** P2 "The lion": it climbs onto the rock ledge, watches, then roars and charges the audience. Lights out. */
function prologueLionRock(): Scene {
  const anchorY = 0.05;
  const rock = plate("Lion Rock · night", "asset_pr_rock", anchorY);
  const climb = makeClip("Climbs onto the rock", { assetId: "asset_pr_lion_climb", startPose: "empty", endPose: "rock", duration: 6.04 });
  const watch = makeClip("Watches from the rock (loop)", { assetId: "asset_pr_lion_idle", startPose: "rock", endPose: "rock", duration: 8.04, loop: true, autoIdle: true });
  const charge = makeClip("Roars and charges", { assetId: "asset_pr_lion_charge", startPose: "rock", endPose: "charged", duration: 5.04, interrupt: true });
  const lion = makeClipActor("Lion (AI video)", { clips: [climb, watch, charge], restPose: "empty", frameAspect: PR_ASPECT, anchorY, muted: true });
  const fog = makeEffect("fog", { initiallyVisible: true, params: { ...EFFECT_DEFS.fog.defaults, density: 0.3, height: 0.2, color: "#8f9ab0", speed: 0.25 } });
  const lightning = makeEffect("lightning", { params: { ...EFFECT_DEFS.lightning.defaults, brightness: 0.6, thunderDelay: 2.5 } });
  const s = makeScene(2, "Prologue 2 · The Lion on the Rock", {
    environment: "none",
    notes:
      "Arrives by the time-lapse from the fields. The lion climbs up onto the ledge (not out of the grass) and watches. GO 'charge' cuts in at once: it roars, leaps and charges; the wall blacks out on its face as real David runs.",
    components: [rock, lion, fog, lightning],
    markers: {},
    transition: { kind: "video", duration: 10.04, videoAssetId: "asset_pr_timelapse", audioAssetId: null, travelDistance: 60 },
  });
  s.cues = [
    withNotes("GO on \"…a lion came.\" (end of NAR-04).", makeCue("Lion climbs onto the rock", [{ type: "clip", actorId: lion.id, clipId: climb.id, delay: 0 }])),
    withNotes("GO with real David's move; cuts in at once. Lights out 4.75 s later, on the lion's face.", makeCue("Lion roars and charges → lights out", [
      { type: "clip", actorId: lion.id, clipId: charge.id, delay: 0 },
      lightsOut(true, 0.12, 4.75),
    ])),
    withNotes("GO straight after the blackout; the wall stays dark.", makeCue("In the dark: David on the lion", [])), // takeScene target filled in by prologueScenes()
  ];
  return s;
}

/** P3 "Lights up": David standing on the defeated lion; holds while real David sings. */
function prologueDavidOnLion(): Scene {
  const anchorY = 0.42;
  const still = plate("David on the lion · still", "asset_pr_david_lion", anchorY);
  const breathe = makeClip("Tableau breathes (loop)", { assetId: "asset_pr_david_loop", startPose: "tableau", endPose: "tableau", duration: 10.04, loop: true, autoIdle: true });
  const tableau = makeClipActor("David on the lion (loop)", { clips: [breathe], restPose: "tableau", frameAspect: PR_ASPECT, anchorY, muted: true });
  const fog = makeEffect("fog", { initiallyVisible: true, params: { ...EFFECT_DEFS.fog.defaults, density: 0.3, height: 0.2, color: "#9aa5bb", speed: 0.15 } });
  const s = makeScene(3, "Prologue 3 · David's Song (the lion defeated)", {
    environment: "none",
    notes: "Taken while the wall is still blacked out. GO 'Lights up' reveals David standing on the lion; it holds (looping) while real David leaves the stage and sings.",
    components: [still, tableau, fog],
    markers: {},
    transition: { kind: "cut", duration: 0.1, videoAssetId: null, audioAssetId: null, travelDistance: 60 },
  });
  s.cues = [
    withNotes("GO on \"The lion lost.\" (NAR-05): lights come up on the punchline.", makeCue("Lights up (David sings)", [lightsOut(false, 2.5)])),
    withNotes("GO after the song, on \"And the boy grew.\" (NAR-07): the 14 s sky move lands for \"Years later…\" (NAR-08).", makeCue("Up to the heavens → Valley of Elah", [])),
  ];
  return s;
}

/** P4 "Goliath": a giant cut-out over the battlefield; the sling stone flies left to right and he falls. */
function prologueElah(): Scene {
  const anchorY = 0.5;
  const valley = plate("Valley of Elah · loop", "asset_pr_battle_loop", anchorY);
  const enter = makeClip("Enters", { assetId: "asset_pr_goliath_enter", cutoutAssetId: "asset_pr_goliath_enter", startPose: "empty", endPose: "stance", duration: 6.04 });
  const taunt = makeClip("Taunts (loop)", { assetId: "asset_pr_goliath_taunt", cutoutAssetId: "asset_pr_goliath_taunt", startPose: "stance", endPose: "stance", duration: 10.04, loop: true, autoIdle: true });
  const fall = makeClip("Struck: drops shield + spear, kneels, falls", { assetId: "asset_pr_goliath_fall", cutoutAssetId: "asset_pr_goliath_fall", startPose: "stance", endPose: "fallen", duration: 6.75, interrupt: true });
  const goliath = makeClipActor("Goliath (cut-out)", {
    clips: [enter, taunt, fall],
    restPose: "empty",
    frameAspect: PR_ASPECT,
    anchorY,
    matted: true,
    muted: true,
    // Feet on the bottom of a 32:9 wall, helmet at the top: he fills the frame.
    layout: { ...defaultActorLayout(), scale: 0.73, x: 0, y: -0.08, pivotX: 0.565, pivotY: 0.9, depthLink: false, horizonY: 0.4, shadow: 0.35 },
  });
  const stone = makeEffect("projectile", {
    name: "Sling stone",
    params: { ...EFFECT_DEFS.projectile.defaults, fromX: 0.02, fromY: 0.95, toX: 0.555, toY: 0.09, arc: 0.1, duration: 0.55, size: 0.03, glow: 1.2, flash: true },
  });
  const shieldShake = makeEffect("shake", { name: "Shake · shield hits the ground", params: { intensity: 0.012, duration: 0.7, frequency: 16 } });
  const quake = makeEffect("shake", { name: "Shake · Goliath hits the ground", params: { intensity: 0.06, duration: 2.8, frequency: 9 } });
  const lightning = makeEffect("lightning", { params: { ...EFFECT_DEFS.lightning.defaults, brightness: 0.7, thunderDelay: 1.8 } });
  const fog = makeEffect("fog", { initiallyVisible: true, params: { ...EFFECT_DEFS.fog.defaults, density: 0.3, height: 0.2, color: "#a3a6ad", speed: 0.3 } });
  const s = makeScene(4, "Prologue 4 · The Valley of Elah (Goliath)", {
    environment: "none",
    notes:
      "Arrives by the sky move (tilt up from David, down into the battlefield). Goliath enters huge, filling the wall, and taunts on a loop through his lines. GO 'Sling!' as real David releases: the stone flies left to right, hits, he drops shield and spear (small shake), sinks to his knees and falls face down (earthquake).",
    components: [valley, goliath, stone, shieldShake, quake, lightning, fog],
    markers: {},
    transition: { kind: "video", duration: 14, videoAssetId: "asset_pr_sky_travel", audioAssetId: null, travelDistance: 60 },
  });
  const flight = num(stone.params, "duration", 0.55);
  s.cues = [
    withNotes("GO on \"…their champion walked into the valley\" (about 6 s into NAR-08); he lands on his mark for \"His name was Goliath.\"", makeCue("Goliath enters", [{ type: "clip", actorId: goliath.id, clipId: enter.id, delay: 0 }])),
    withNotes("GO on David's release after \"The battle is the LORD'S!\" Stone 0.55 s, then shield and spear (shake), knees, face down (earthquake at +6.4 s).", makeCue("Sling! (stone → Goliath falls)", [
      { type: "effect", effectId: stone.id, op: "trigger", delay: 0 },
      { type: "clip", actorId: goliath.id, clipId: fall.id, delay: flight },
      // Measured on the fall clip: shield and spear land at 2.05 s, he hits the ground at 5.85 s.
      { type: "effect", effectId: shieldShake.id, op: "trigger", delay: +(flight + 2.05).toFixed(2) },
      { type: "effect", effectId: quake.id, op: "trigger", delay: +(flight + 5.85).toFixed(2) },
    ])),
  ];
  return s;
}

/** The prologue, P1 → P4, with each scene's last cue taking the next one. */
export function prologueScenes(): Scene[] {
  const scenes = [prologueFields(), prologueLionRock(), prologueDavidOnLion(), prologueElah()];
  for (let i = 0; i < scenes.length - 1; i++) {
    const last = scenes[i].cues[scenes[i].cues.length - 1];
    last.actions = [{ type: "takeScene", sceneId: scenes[i + 1].id, transition: null, delay: 0 }];
  }
  return scenes;
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
  const s1 = davidAndTheLion();
  const s2 = shepherdsValley();
  const s3 = marketplaceTemplate();
  const proof = lionProofScene(2);
  const photoValley = shepherdPhotorealScene(4);
  const prologue = prologueScenes();
  const travel = s1.cues.find((c) => c.name.startsWith("Travel"));
  if (travel) {
    travel.actions = [
      {
        type: "takeScene",
        sceneId: s2.id,
        transition: { kind: "travel", duration: 6, videoAssetId: null, audioAssetId: null, travelDistance: 80 },
        delay: 0,
      },
    ];
  }
  return {
    version: 1,
    name: "Salvation 2026: The House of David",
    scenes: [...prologue, s1, proof, s2, photoValley, s3].map((x, i) => ({ ...x, number: i + 1 })),
    assets: [...PROLOGUE_ASSETS, ...LION_PROOF_ASSETS],
    demoAdditions: [LION_PROOF_DEMO, SHEPHERD_PHOTOREAL_DEMO, PROLOGUE_DEMO, "prologue-tweaks-1"],
    effectPresets: defaultEffectPresets(),
    output: defaultOutput(),
  };
}
