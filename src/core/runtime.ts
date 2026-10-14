import { ease, evalTween, lerp, now, retarget, sceneNow, tween } from "./clock";
import { EFFECT_DEFS, num } from "./effects";
import { uid } from "./ids";
import { initialSegments, scheduleClip } from "./clipActor";
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
  LionAction,
  Scene,
  SceneComponent,
  SceneRuntime,
  Vec2,
  Vec3,
} from "./types";

/** Immediate operator commands. Cue actions are commands with a delay. */
export type Command =
  | Exclude<CueAction, { type: "takeScene" } | { type: "blackout" }>
  | { type: "effect.param"; effectId: string; key: string; value: number | string | boolean }
  | { type: "clock"; op: "pause" | "resume" }
  | { type: "cuePointer"; index: number };

const LONG_AGO = -1e9;

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

export function createRuntime(scene: Scene, wallNow = now()): SceneRuntime {
  const bgs = scene.components.filter((c) => c.kind === "background");
  const bg = bgs.find((b) => b.initiallyVisible) ?? bgs[0];
  const tod = bg?.kind === "background" && bg.source === "environment" ? bg.env.timeOfDay : 0;
  const storm = bg?.kind === "background" && bg.source === "environment" ? bg.env.storm : 0;
  const pose = defaultShot(scene)?.pose ?? FALLBACK_POSE;

  const rt: SceneRuntime = {
    key: uid("rt"),
    scene: structuredClone(scene),
    clock: { base: wallNow, pausedAt: null },
    background: { current: bg?.id ?? null, previous: null, changedAt: LONG_AGO, dur: 0 },
    env: { timeOfDay: tween(tod, tod, 0, 0), storm: tween(storm, storm, 0, 0) },
    layers: {},
    effects: {},
    strikes: [],
    camera: { from: pose, to: pose, at: 0, dur: 0, ease: "inOut" },
    cuePointer: 0,
    clipActors: {},
  };
  for (const c of scene.components) {
    if (c.kind === "video" || c.kind === "image" || c.kind === "model" || c.kind === "procedural") {
      rt.layers[c.id] = { visible: c.initiallyVisible, changedAt: LONG_AGO, startAt: 0 };
    } else if (c.kind === "clipActor") {
      rt.clipActors[c.id] = initialSegments(c);
    } else if (c.kind === "effect") {
      const active = c.effect === "daynight" ? tod > 0.5 : EFFECT_DEFS[c.effect].mode === "trigger" ? false : c.initiallyVisible;
      rt.effects[c.id] = { active, changedAt: LONG_AGO, params: { ...EFFECT_DEFS[c.effect].defaults, ...c.params } };
    }
  }
  return rt;
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

export function evalCamera(cam: CameraRuntime, t: number): CameraPose {
  if (cam.dur <= 0 || t >= cam.at + cam.dur) return cam.to;
  const k = ease(cam.ease, (t - cam.at) / cam.dur);
  const l3 = (a: Vec3, b: Vec3): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  return { position: l3(cam.from.position, cam.to.position), target: l3(cam.from.target, cam.to.target), hfov: lerp(cam.from.hfov, cam.to.hfov, k) };
}

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
      return { rt: { ...rt, layers: { ...rt.layers, [cmd.layerId]: { visible, startAt, changedAt: visible === cur.visible ? cur.changedAt : t } } }, poses };
    }
    case "camera": {
      const shot = scene.cameraShots.find((s) => s.id === cmd.shotId);
      if (!shot) return { rt, poses };
      const from = evalCamera(rt.camera, t);
      let to = shot.pose;
      if (shot.followActorId && poses[shot.followActorId]) {
        const a = poses[shot.followActorId];
        const o = shot.followOffset;
        to = { position: [a.pos[0] + o[0], o[1], a.pos[1] + o[2]], target: [a.pos[0], 0.9, a.pos[1]], hfov: shot.pose.hfov };
      }
      return { rt: { ...rt, camera: { from, to, at: t, dur: shot.duration * 1000, ease: shot.ease } }, poses };
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
      if (cmd.op === "pause" && rt.clock.pausedAt === null) return { rt: { ...rt, clock: { ...rt.clock, pausedAt: wallNow } }, poses };
      if (cmd.op === "resume" && rt.clock.pausedAt !== null) {
        return { rt: { ...rt, clock: { base: rt.clock.base + (wallNow - rt.clock.pausedAt), pausedAt: null } }, poses };
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
  if (effect === "rain" || effect === "fog") return num(params, active ? "fadeIn" : "fadeOut", 4);
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
