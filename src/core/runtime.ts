import { clamp, ease, evalTween, hermite, lerp, now, retarget, sceneNow, smootherstep, tween } from "./clock";
import { EFFECT_DEFS, num } from "./effects";
import { uid } from "./ids";
import { clipStateAt, initialSegments, scheduleClip } from "./clipActor";
import { LION_ACTION_INFO } from "./lion";
import type {
  ActorComponent,
  ActorPoses,
  ActorState,
  CameraPose,
  CameraRuntime,
  CameraShot,
  CueAction,
  EffectParams,
  Framing,
  LionAction,
  NamesRuntime,
  Scene,
  SceneComponent,
  SceneRuntime,
  SoundEvent,
  SpeedRamp,
  Vec2,
  Vec3,
} from "./types";

/** Immediate operator commands. Cue actions are commands with a delay. */
export type Command =
  | Exclude<CueAction, { type: "takeScene" } | { type: "blackout" } | { type: "send" } | { type: "timer" } | { type: "announce" } | { type: "clock" } | { type: "effect.param" }>
  | { type: "effect.param"; effectId: string; key: string; value: number | string | boolean; delay?: number }
  | { type: "clock"; op: "pause" | "resume" | "toggle"; delay?: number }
  /** Jump the scene clock to scene time t (ms): scrubbing. */
  | { type: "seek"; t: number }
  /** Put a video actor on one clip, `offset` seconds in, right now (scrubbing). */
  | { type: "clip.seek"; actorId: string; clipId: string; offset: number }
  | { type: "cuePointer"; index: number }
  /** Cue `index` has fired: remember it and move the GO pointer past it (and past cues that already fired). */
  | { type: "cueFired"; index: number };

const LONG_AGO = -1e9;

/** Component kinds that have a show/hide layer runtime. */
export const LAYER_KINDS = new Set<SceneComponent["kind"]>(["video", "image", "model", "procedural", "text", "names", "route"]);

export function findComponent<K extends SceneComponent["kind"]>(
  scene: Scene,
  id: string,
  kind?: K,
): Extract<SceneComponent, { kind: K }> | undefined {
  const c = scene.components.find((x) => x.id === id);
  if (!c || (kind && c.kind !== kind)) return undefined;
  return c as Extract<SceneComponent, { kind: K }>;
}

export function defaultShot(scene: Scene): CameraShot | undefined {
  return scene.cameraShots.find((s) => s.id === scene.defaultShotId) ?? scene.cameraShots[0];
}

export const FALLBACK_POSE: CameraPose = { position: [0, 1.7, 12], target: [0, 1.4, -20], hfov: 72 };

export const NO_FRAMING: Framing = { zoom: 1, x: 0.5, y: 0.5 };

/** Keep the view inside the picture: zoom 1–6, centre never far enough out to show an edge. */
export function clampFraming(f: Framing): Framing {
  const zoom = clamp(Number.isFinite(f.zoom) ? f.zoom : 1, 1, 6);
  const h = 0.5 / zoom;
  return { zoom, x: clamp(f.x, h, 1 - h), y: clamp(f.y, h, 1 - h) };
}

export function evalFraming(fr: SceneRuntime["framing"], t: number): Framing {
  if (!fr) return NO_FRAMING;
  if (fr.dur <= 0 || t >= fr.at + fr.dur) return fr.to;
  if (t <= fr.at) return fr.from;
  const k = smootherstep((t - fr.at) / fr.dur);
  // Zoom in log space so a push-in feels constant-speed.
  const zoom = Math.exp(lerp(Math.log(fr.from.zoom), Math.log(fr.to.zoom), k));
  return { zoom, x: lerp(fr.from.x, fr.to.x, k), y: lerp(fr.from.y, fr.to.y, k) };
}

const staticFraming = (f: Framing | undefined) => {
  const c = clampFraming(f ?? NO_FRAMING);
  return { from: c, to: c, at: 0, dur: 0 };
};

export const initialNames = (): NamesRuntime => ({ shown: 0, shownAt: LONG_AGO, burn: tween(0, 0, 0, 0), bloom: tween(0, 0, 0, 0) });

/** A copy of the scene for the runtime: thumbnails are never needed to render and bloat every broadcast. */
function runtimeScene(scene: Scene): Scene {
  const s = structuredClone(scene);
  s.thumbnail = null;
  return s;
}

export function createRuntime(scene: Scene, wallNow = now()): SceneRuntime {
  const bgs = scene.components.filter((c) => c.kind === "background");
  const bg = bgs.find((b) => b.initiallyVisible) ?? bgs[0];
  const tod = bg?.kind === "background" && bg.source === "environment" ? bg.env.timeOfDay : 0;
  const storm = bg?.kind === "background" && bg.source === "environment" ? bg.env.storm : 0;
  const shot = defaultShot(scene);
  const pose = shot?.pose ?? FALLBACK_POSE;

  const rt: SceneRuntime = {
    key: uid("rt"),
    scene: runtimeScene(scene),
    clock: { base: wallNow, pausedAt: null },
    background: { current: bg?.id ?? null, previous: null, changedAt: LONG_AGO, dur: 0 },
    env: { timeOfDay: tween(tod, tod, 0, 0), storm: tween(storm, storm, 0, 0) },
    layers: {},
    effects: {},
    strikes: [],
    camera: { from: pose, to: pose, at: 0, dur: 0, ease: "inOut", follow: shot?.followActorId ? { actorId: shot.followActorId, offset: shot.followOffset } : null },
    cuePointer: 0,
    fired: [],
    clipActors: {},
    names: {},
    routes: {},
    speed: {},
    sounds: [],
    framing: staticFraming(scene.framing),
  };
  for (const c of scene.components) {
    if (LAYER_KINDS.has(c.kind)) {
      rt.layers[c.id] = { visible: c.initiallyVisible, changedAt: LONG_AGO, startAt: 0 };
      if (c.kind === "names") rt.names![c.id] = initialNames();
      if (c.kind === "route") rt.routes![c.id] = { progress: tween(0, 0, 0, 0) };
    } else if (c.kind === "clipActor") {
      rt.clipActors[c.id] = initialSegments(c);
    } else if (c.kind === "effect") {
      const active = c.effect === "daynight" ? tod > 0.5 : EFFECT_DEFS[c.effect].mode === "trigger" ? false : c.initiallyVisible;
      rt.effects[c.id] = { active, changedAt: LONG_AGO, params: { ...EFFECT_DEFS[c.effect].defaults, ...c.params } };
    }
  }
  return rt;
}

/** Keep a running runtime in step with edits to its scene without restarting it. */
export function reconcileRuntime(rt: SceneRuntime, scene: Scene): SceneRuntime {
  const layers = { ...rt.layers };
  const effects = { ...rt.effects };
  const names = { ...(rt.names ?? {}) };
  const routes = { ...(rt.routes ?? {}) };
  const ids = new Set(scene.components.map((c) => c.id));
  const before = new Map(rt.scene.components.map((c) => [c.id, c]));
  for (const c of scene.components) {
    if (LAYER_KINDS.has(c.kind) && !layers[c.id]) layers[c.id] = { visible: c.initiallyVisible, changedAt: LONG_AGO, startAt: 0 };
    // "Visible at start" toggled while the scene runs: follow it, unless a cue has shown or hidden the item since.
    else if (LAYER_KINDS.has(c.kind) && before.get(c.id)?.initiallyVisible !== c.initiallyVisible && layers[c.id].changedAt === LONG_AGO) layers[c.id] = { ...layers[c.id], visible: c.initiallyVisible };
    if (c.kind === "names" && !names[c.id]) names[c.id] = initialNames();
    if (c.kind === "route" && !routes[c.id]) routes[c.id] = { progress: tween(0, 0, 0, 0) };
    if (c.kind === "effect") {
      const params = { ...EFFECT_DEFS[c.effect].defaults, ...c.params };
      const cur = effects[c.id];
      const follow = cur && before.get(c.id)?.initiallyVisible !== c.initiallyVisible && cur.changedAt === LONG_AGO && EFFECT_DEFS[c.effect].mode !== "trigger";
      effects[c.id] = cur ? { ...cur, params, ...(follow ? { active: c.initiallyVisible } : {}) } : { active: c.initiallyVisible, changedAt: LONG_AGO, params };
    }
  }
  const clipActors = { ...(rt.clipActors ?? {}) };
  for (const c of scene.components) if (c.kind === "clipActor" && !clipActors[c.id]) clipActors[c.id] = initialSegments(c);
  for (const m of [clipActors, layers, effects, names, routes]) for (const id of Object.keys(m)) if (!ids.has(id)) delete m[id];
  const bgValid = rt.background.current && ids.has(rt.background.current);
  const background = bgValid
    ? rt.background
    : { current: scene.components.find((c) => c.kind === "background")?.id ?? null, previous: null, changedAt: LONG_AGO, dur: 0 };
  // A new starting framing (set on the preview monitor) applies at once.
  const framing = JSON.stringify(scene.framing ?? null) !== JSON.stringify(rt.scene.framing ?? null) ? staticFraming(scene.framing) : rt.framing;
  return { ...rt, scene: runtimeScene(scene), layers, effects, background, clipActors, names, routes, framing };
}

export function createPoses(scene: Scene): ActorPoses {
  const poses: ActorPoses = {};
  for (const c of scene.components) {
    if (c.kind !== "actor") continue;
    poses[c.id] = initialActor(c, scene);
  }
  return poses;
}

function initialActor(c: ActorComponent, scene: Scene): ActorState {
  const p = scene.markers[c.start.marker] ?? [0, -10];
  return {
    pos: [p[0], p[1]],
    heading: c.start.heading,
    action: "idle",
    actionAt: LONG_AGO,
    prevAction: "idle",
    prevActionAt: LONG_AGO,
    gaitPhase: 0,
    speed: 0,
    visible: c.initiallyVisible,
    visibleChangedAt: LONG_AGO,
    cruise: null,
    target: null,
    targetGait: "walk",
  };
}

// ---------------------------------------------------------------- camera

const l3 = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const h3 = (a: Vec3, b: Vec3, v: Vec3, k: number): Vec3 => [hermite(a[0], b[0], v[0], k), hermite(a[1], b[1], v[1], k), hermite(a[2], b[2], v[2], k)];

/**
 * Camera pose at scene time t. A move that starts while another is still running
 * carries that move's velocity into the new curve (Hermite), so the picture never
 * kinks; a move from rest eases exactly as before.
 */
export function evalCamera(cam: CameraRuntime, t: number, to: CameraPose = cam.to): CameraPose {
  if (cam.dur <= 0 || t >= cam.at + cam.dur) return to;
  if (t <= cam.at) return cam.from;
  const u = (t - cam.at) / cam.dur;
  const v = cam.fromVel;
  if (v && (v.position.some((x) => x !== 0) || v.target.some((x) => x !== 0) || v.hfov !== 0)) {
    // Velocity is per second; the Hermite tangent is per unit of u.
    const s = cam.dur / 1000;
    return {
      position: h3(cam.from.position, to.position, v.position.map((x) => x * s) as Vec3, u),
      target: h3(cam.from.target, to.target, v.target.map((x) => x * s) as Vec3, u),
      hfov: hermite(cam.from.hfov, to.hfov, v.hfov * s, u),
    };
  }
  const k = ease(cam.ease, u);
  return { position: l3(cam.from.position, to.position, k), target: l3(cam.from.target, to.target, k), hfov: lerp(cam.from.hfov, to.hfov, k) };
}

/** Instantaneous camera velocity (units per second) by finite difference. */
export function cameraVelocity(cam: CameraRuntime, t: number): CameraPose {
  if (cam.dur <= 0 || t >= cam.at + cam.dur || t <= cam.at) return { position: [0, 0, 0], target: [0, 0, 0], hfov: 0 };
  const h = 8;
  const a = evalCamera(cam, Math.max(cam.at, t - h));
  const b = evalCamera(cam, Math.min(cam.at + cam.dur, t + h));
  const dt = Math.max(1, Math.min(cam.at + cam.dur, t + h) - Math.max(cam.at, t - h)) / 1000;
  const d = (x: number, y: number) => (y - x) / dt;
  return {
    position: [d(a.position[0], b.position[0]), d(a.position[1], b.position[1]), d(a.position[2], b.position[2])],
    target: [d(a.target[0], b.target[0]), d(a.target[1], b.target[1]), d(a.target[2], b.target[2])],
    hfov: d(a.hfov, b.hfov),
  };
}

/** Where a follow shot frames an actor standing at (x, z). */
export function followPose(actorPos: Vec2, offset: Vec3, hfov: number): CameraPose {
  return { position: [actorPos[0] + offset[0], offset[1], actorPos[1] + offset[2]], target: [actorPos[0], 0.9, actorPos[1]], hfov };
}

// ---------------------------------------------------------------- actors

/** Begin a new action on an actor, remembering the previous one for blending. */
export function setActorAction(a: ActorState, action: LionAction, t: number): ActorState {
  if (a.action === action && LION_ACTION_INFO[action].loop) return a;
  return { ...a, prevAction: a.action, prevActionAt: a.actionAt, action, actionAt: t };
}

export function isOneShotBusy(a: ActorState, t: number): boolean {
  const info = LION_ACTION_INFO[a.action];
  if (info.loop) return false;
  if (a.action === "fall") return true; // stays down until a new explicit action
  return t - a.actionAt < info.duration * 1000;
}

function lionCommand(a: ActorState, action: LionAction, t: number): ActorState {
  switch (action) {
    case "walk":
    case "run":
      return { ...setActorAction(a, action, t), cruise: action, target: null };
    case "idle":
    case "turn":
      return { ...setActorAction(a, "idle", t), cruise: null, target: null, speed: 0 };
    default:
      // One-shots always restart, even when repeated.
      return { ...a, prevAction: a.action, prevActionAt: a.actionAt, action, actionAt: t, cruise: null, target: null, speed: 0 };
  }
}

// ---------------------------------------------------------------- media speed

/** Media-elapsed seconds for a component playing since `startAt`, honouring a speed ramp. */
export function mediaElapsed(rt: SceneRuntime, id: string, startAt: number, t: number, baseRate: number): number {
  const ramp = rt.speed?.[id];
  const raw = Math.max(0, (t - startAt) / 1000);
  if (!ramp || t < ramp.at) return raw * baseRate;
  const tau = (t - ramp.at) / 1000;
  const d = ramp.dur / 1000;
  const integral = d <= 0 || tau >= d ? (d > 0 ? ((ramp.from + ramp.to) / 2) * d : 0) + ramp.to * Math.max(0, tau - d) : ramp.from * tau + ((ramp.to - ramp.from) * tau * tau) / (2 * d);
  return ramp.elapsedAt + integral;
}

/**
 * How loud a video's sound is allowed to be at scene time t (1 = untouched, 0 = faded out) after
 * sound cues that fade other audio out (the sound action's `fadeOthers`).
 */
export function videoAudioFade(rt: SceneRuntime, componentId: string, t: number): number {
  let k = 1;
  for (const ev of rt.sounds ?? []) {
    const f = ev.fadeOthers;
    if (!f || ev.at > t || (f.which !== "all" && !f.which.includes(componentId))) continue;
    k = Math.min(k, f.fade > 0 ? 1 - clamp((t - ev.at) / (f.fade * 1000), 0, 1) : 0);
  }
  return k;
}

/** Current playback rate of a component (for the <video> element's own rate). */
export function mediaRate(rt: SceneRuntime, id: string, t: number, baseRate: number): number {
  const ramp = rt.speed?.[id];
  if (!ramp || t < ramp.at) return baseRate;
  if (ramp.dur <= 0 || t >= ramp.at + ramp.dur) return ramp.to;
  return lerp(ramp.from, ramp.to, (t - ramp.at) / ramp.dur);
}

// ---------------------------------------------------------------- reducer

export interface ApplyResult {
  rt: SceneRuntime;
  poses: ActorPoses;
}

/** Pure reducer: apply one command to a runtime and its actor poses. */
export function applyCommand(rt: SceneRuntime, poses: ActorPoses, cmd: Command, wallNow = now()): ApplyResult {
  const t = sceneNow(rt, wallNow);
  const scene = rt.scene;
  switch (cmd.type) {
    case "background": {
      const bg = findComponent(scene, cmd.backgroundId, "background");
      if (!bg) return { rt, poses };
      const next: SceneRuntime = {
        ...rt,
        background: { current: bg.id, previous: rt.background.current, changedAt: t, dur: bg.transitionDuration * 1000 },
      };
      if (bg.source === "environment") {
        const d = bg.transitionDuration * 1000;
        next.env = { timeOfDay: retarget(rt.env.timeOfDay, bg.env.timeOfDay, t, d), storm: retarget(rt.env.storm, bg.env.storm, t, d) };
        next.effects = syncDayNight(next.effects, scene, bg.env.timeOfDay, t);
      }
      // A fresh plate starts its own speed history.
      if (next.speed?.[bg.id]) {
        next.speed = { ...next.speed };
        delete next.speed[bg.id];
      }
      return { rt: next, poses };
    }
    case "timeOfDay": {
      const next = { ...rt, env: { ...rt.env, timeOfDay: retarget(rt.env.timeOfDay, cmd.value, t, cmd.duration * 1000) } };
      next.effects = syncDayNight(next.effects, scene, cmd.value, t);
      return { rt: next, poses };
    }
    case "effect": {
      const fx = findComponent(scene, cmd.effectId, "effect");
      const cur = rt.effects[cmd.effectId];
      if (!fx || !cur) return { rt, poses };
      if (fx.effect === "lightning") {
        if (cmd.op === "stop") return { rt, poses };
        return { rt: { ...rt, strikes: [...rt.strikes.slice(-7), makeStrike(cur.params, t)] }, poses };
      }
      if (EFFECT_DEFS[fx.effect].mode === "trigger") {
        if (cmd.op === "stop") return { rt, poses };
        return { rt: { ...rt, triggers: [...(rt.triggers ?? []).slice(-11), { id: uid("evt"), effectId: fx.id, at: t }] }, poses };
      }
      const active = cmd.op === "toggle" ? !cur.active : cmd.op === "start" || cmd.op === "trigger";
      if (fx.effect === "daynight") {
        const dur = num(cur.params, "duration", 8) * 1000;
        const next = { ...rt, env: { ...rt.env, timeOfDay: retarget(rt.env.timeOfDay, active ? 1 : 0, t, dur) } };
        next.effects = { ...rt.effects, [fx.id]: { ...cur, active, changedAt: t } };
        return { rt: next, poses };
      }
      if (active === cur.active) return { rt, poses };
      // Changing direction mid-fade: back-date changedAt so the fade continues from its current level.
      const level = effectLevel(fx.effect, cur.active, cur.changedAt, cur.params, t);
      const fadeMs = fadeDuration(fx.effect, cur.params, active) * 1000;
      const changedAt = active ? t - level * fadeMs : t - (1 - level) * fadeMs;
      return { rt: { ...rt, effects: { ...rt.effects, [fx.id]: { ...cur, active, changedAt } } }, poses };
    }
    case "effect.param": {
      const cur = rt.effects[cmd.effectId];
      if (!cur) return { rt, poses };
      return { rt: { ...rt, effects: { ...rt.effects, [cmd.effectId]: { ...cur, params: { ...cur.params, [cmd.key]: cmd.value } } } }, poses };
    }
    case "layer": {
      const cur = rt.layers[cmd.layerId];
      if (!cur) return { rt, poses };
      let visible = cur.visible;
      let startAt = cur.startAt;
      if (cmd.op === "show") visible = true;
      if (cmd.op === "hide") visible = false;
      if (cmd.op === "toggle") visible = !visible;
      if (cmd.op === "restart") {
        visible = true;
        startAt = t;
      } else if (visible && !cur.visible) startAt = t;
      if (visible === cur.visible && startAt === cur.startAt) return { rt, poses };
      const next: SceneRuntime = { ...rt, layers: { ...rt.layers, [cmd.layerId]: { visible, startAt, changedAt: visible === cur.visible ? cur.changedAt : t } } };
      if (startAt !== cur.startAt && next.speed?.[cmd.layerId]) {
        next.speed = { ...next.speed };
        delete next.speed[cmd.layerId];
      }
      // Re-showing a route restarts its line; a names tree keeps its progress.
      if (visible && !cur.visible && next.routes?.[cmd.layerId]) next.routes = { ...next.routes, [cmd.layerId]: { progress: tween(0, 0, 0, 0) } };
      return { rt: next, poses };
    }
    case "camera": {
      const shot = scene.cameraShots.find((s) => s.id === cmd.shotId);
      if (!shot) return { rt, poses };
      const liveTo = rt.camera.follow && poses[rt.camera.follow.actorId] ? followPose(poses[rt.camera.follow.actorId].pos, rt.camera.follow.offset, rt.camera.to.hfov) : rt.camera.to;
      const from = evalCamera(rt.camera, t, liveTo);
      const fromVel = cameraVelocity(rt.camera, t);
      let to = shot.pose;
      const follow = shot.followActorId && poses[shot.followActorId] ? { actorId: shot.followActorId, offset: shot.followOffset } : null;
      if (follow) to = followPose(poses[follow.actorId].pos, follow.offset, shot.pose.hfov);
      return { rt: { ...rt, camera: { from, to, at: t, dur: shot.duration * 1000, ease: shot.ease, fromVel, follow } }, poses };
    }
    case "actor.visible": {
      const a = poses[cmd.actorId];
      if (!a) return { rt, poses };
      return { rt, poses: { ...poses, [cmd.actorId]: { ...a, visible: cmd.visible, visibleChangedAt: t } } };
    }
    case "lion": {
      const a = poses[cmd.actorId];
      if (!a) return { rt, poses };
      return { rt, poses: { ...poses, [cmd.actorId]: lionCommand(a, cmd.action, t) } };
    }
    case "lion.moveTo": {
      const a = poses[cmd.actorId];
      const m = scene.markers[cmd.marker];
      if (!a || !m) return { rt, poses };
      const base = a.action === "fall" ? setActorAction(a, "idle", t) : a;
      return { rt, poses: { ...poses, [cmd.actorId]: { ...base, target: [m[0], m[1]] as Vec2, targetGait: cmd.gait, cruise: null } } };
    }
    case "lion.place": {
      const a = poses[cmd.actorId];
      const m = scene.markers[cmd.marker];
      if (!a || !m) return { rt, poses };
      return {
        rt,
        poses: {
          ...poses,
          [cmd.actorId]: { ...a, pos: [m[0], m[1]], heading: cmd.heading, action: "idle", actionAt: t, prevAction: "idle", prevActionAt: t, target: null, cruise: null, speed: 0 },
        },
      };
    }
    case "clock": {
      const paused = rt.clock.pausedAt !== null;
      const op = cmd.op === "toggle" ? (paused ? "resume" : "pause") : cmd.op;
      if (op === "pause" && !paused) return { rt: { ...rt, clock: { ...rt.clock, pausedAt: wallNow } }, poses };
      if (op === "resume" && paused) {
        return { rt: { ...rt, clock: { ...rt.clock, base: rt.clock.base + (wallNow - rt.clock.pausedAt!), pausedAt: null } }, poses };
      }
      return { rt, poses };
    }
    case "clip": {
      const actor = findComponent(scene, cmd.actorId, "clipActor");
      if (!actor) return { rt, poses };
      const next = scheduleClip(actor, rt.clipActors?.[actor.id], cmd.clipId, t);
      return { rt: { ...rt, clipActors: { ...rt.clipActors, [actor.id]: next } }, poses };
    }
    case "cuePointer":
      return { rt: { ...rt, cuePointer: Math.max(0, Math.min(cmd.index, scene.cues.length)) }, poses };
    case "cueFired": {
      const cue = scene.cues[cmd.index];
      if (!cue) return { rt, poses };
      const fired = rt.fired?.includes(cue.id) ? rt.fired : [...(rt.fired ?? []), cue.id];
      let ptr = Math.max(rt.cuePointer, cmd.index + 1);
      while (ptr < scene.cues.length && fired.includes(scene.cues[ptr].id)) ptr++;
      return { rt: { ...rt, fired, cuePointer: ptr }, poses };
    }
    case "seek": {
      const target = Math.max(0, cmd.t);
      const base = (rt.clock.pausedAt ?? wallNow) - target;
      // Everything up to the furthest point played, or jumped to, counts as passed: markers and
      // timed cues in the stretch scrubbed back over or jumped across do not fire.
      const reached = Math.max(rt.clock.reached ?? 0, t, target);
      return { rt: { ...rt, clock: { ...rt.clock, base, reached } }, poses };
    }
    case "clip.seek": {
      const actor = findComponent(scene, cmd.actorId, "clipActor");
      if (!actor || !actor.clips.some((k) => k.id === cmd.clipId)) return { rt, poses };
      const offset = Math.max(0, cmd.offset);
      // Same rule per clip: what this clip already played, or was scrubbed over, does not fire its markers again.
      const cur = clipStateAt(actor, rt.clipActors?.[actor.id], t);
      const passed = cur.clip?.id === cmd.clipId && cur.segment ? Math.max(cur.localT, cur.segment.skip ?? 0) : 0;
      const segment = { clipId: cmd.clipId, at: t - offset * 1000, skip: Math.max(offset, passed) };
      return { rt: { ...rt, clipActors: { ...rt.clipActors, [actor.id]: { segments: [segment] } } }, poses };
    }
    case "framing": {
      const from = evalFraming(rt.framing, t);
      const to = clampFraming({ zoom: cmd.zoom, x: cmd.x, y: cmd.y });
      return { rt: { ...rt, framing: { from, to, at: t, dur: Math.max(0, cmd.duration) * 1000 } }, poses };
    }
    case "names": {
      const comp = findComponent(scene, cmd.layerId, "names");
      const cur = rt.names?.[cmd.layerId] ?? initialNames();
      if (!comp) return { rt, poses };
      const total = comp.names.length;
      let n: NamesRuntime = cur;
      const dur = (cmd.duration > 0 ? cmd.duration : 6) * 1000;
      switch (cmd.op) {
        case "next":
          if (cur.shown < total) n = { ...cur, shown: cur.shown + 1, shownAt: t };
          break;
        case "prev":
          n = { ...cur, shown: Math.max(0, cur.shown - 1), shownAt: t - 1e6 };
          break;
        case "reset":
          n = initialNames();
          break;
        case "all":
          n = { ...cur, shown: total, shownAt: t };
          break;
        case "set":
          n = { ...cur, shown: Math.max(0, Math.min(total, Math.round(cmd.value))), shownAt: t };
          break;
        case "burn":
          n = { ...cur, burn: retarget(cur.burn, 1, t, dur) };
          break;
        case "restore":
          n = { ...cur, burn: retarget(cur.burn, 0, t, dur) };
          break;
        case "bloom":
          n = { ...cur, shown: total, shownAt: cur.shown === total ? cur.shownAt : t, burn: retarget(cur.burn, 0, t, dur * 0.5), bloom: retarget(cur.bloom, 1, t, dur) };
          break;
      }
      // Make the layer visible when driven.
      const layers = rt.layers[cmd.layerId] && !rt.layers[cmd.layerId].visible ? { ...rt.layers, [cmd.layerId]: { visible: true, changedAt: t, startAt: t } } : rt.layers;
      return { rt: { ...rt, layers, names: { ...(rt.names ?? {}), [cmd.layerId]: n } }, poses };
    }
    case "route": {
      const comp = findComponent(scene, cmd.layerId, "route");
      if (!comp) return { rt, poses };
      const cur = rt.routes?.[cmd.layerId] ?? { progress: tween(0, 0, 0, 0) };
      const progress =
        cmd.op === "reset" ? tween(0, 0, 0, 0) : cmd.op === "complete" ? tween(1, 1, 0, 0) : retarget(cur.progress, 1, t, Math.max(50, comp.duration * 1000) * (1 - evalTween(cur.progress, t)));
      const layers = rt.layers[cmd.layerId] && !rt.layers[cmd.layerId].visible && cmd.op !== "reset" ? { ...rt.layers, [cmd.layerId]: { visible: true, changedAt: t, startAt: t } } : rt.layers;
      return { rt: { ...rt, layers, routes: { ...(rt.routes ?? {}), [cmd.layerId]: { progress } } }, poses };
    }
    case "media.speed": {
      const comp = scene.components.find((c) => c.id === cmd.layerId);
      if (!comp) return { rt, poses };
      const base = comp.kind === "background" || comp.kind === "video" ? comp.media.playbackRate : 1;
      const startAt = comp.kind === "background" ? (rt.background.current === comp.id ? rt.background.changedAt : 0) : (rt.layers[comp.id]?.startAt ?? 0);
      const elapsedAt = mediaElapsed(rt, comp.id, Math.max(0, startAt), t, base);
      const from = mediaRate(rt, comp.id, t, base);
      const ramp: SpeedRamp = { from, to: cmd.rate, at: t, dur: Math.max(0, cmd.duration) * 1000, elapsedAt };
      return { rt: { ...rt, speed: { ...(rt.speed ?? {}), [comp.id]: ramp } }, poses };
    }
    case "sound": {
      if (!cmd.assetId) return { rt, poses };
      const ev: SoundEvent = { id: uid("snd"), assetId: cmd.assetId, at: t, volume: cmd.volume, keepPlaying: !!cmd.keepPlaying };
      if (cmd.fadeOthers && (cmd.fadeOthers.which === "all" || cmd.fadeOthers.which.length)) ev.fadeOthers = cmd.fadeOthers;
      return { rt: { ...rt, sounds: [...(rt.sounds ?? []).slice(-15), ev] }, poses };
    }
  }
}

function syncDayNight(effects: SceneRuntime["effects"], scene: Scene, tod: number, t: number) {
  const dn = scene.components.find((c) => c.kind === "effect" && c.effect === "daynight");
  if (!dn || !effects[dn.id]) return effects;
  const active = tod > 0.5;
  if (effects[dn.id].active === active) return effects;
  return { ...effects, [dn.id]: { ...effects[dn.id], active, changedAt: t } };
}

function makeStrike(params: EffectParams, t: number) {
  const r = Math.random();
  return {
    id: uid("strike"),
    at: t,
    seed: Math.floor(Math.random() * 1e6),
    brightness: num(params, "brightness", 1),
    duration: num(params, "duration", 0.55),
    x: 0.15 + r * 0.7,
    thunder: params.thunder !== false,
    thunderDelay: num(params, "thunderDelay", 1.2),
  };
}

export function fadeDuration(effect: string, params: EffectParams, active: boolean): number {
  if (effect === "rain" || effect === "fog" || effect === "snow") return num(params, active ? "fadeIn" : "fadeOut", 4);
  return num(params, "fade", 3);
}

/** 0..1 presence of a toggle effect at scene time t (handles fade in/out). */
export function effectLevel(effect: string, active: boolean, changedAt: number, params: EffectParams, t: number): number {
  const d = fadeDuration(effect, params, active) * 1000;
  const k = d <= 0 ? 1 : Math.min(1, Math.max(0, (t - changedAt) / d));
  return active ? k : 1 - k;
}

/** Day/night & storm values at scene time. */
export function envAt(rt: SceneRuntime, t: number) {
  return { timeOfDay: evalTween(rt.env.timeOfDay, t), storm: evalTween(rt.env.storm, t) };
}
