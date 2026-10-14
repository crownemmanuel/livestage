import { angleDelta, clamp, sceneNow, smoothstep } from "./clock";
import { ATTACK_LUNGE, HIT_RECOIL, LION_ACTION_INFO } from "./lion";
import { findComponent, isOneShotBusy, setActorAction } from "./runtime";
import type { ActorComponent, ActorPoses, ActorState, SceneRuntime } from "./types";

/** Held keyboard state for one actor (screen-relative). */
export interface ActorInput {
  /** x: right(+)/left(-), z: toward audience(+)/away(-). */
  moveX: number;
  moveZ: number;
  turn: number;
  run: boolean;
}

export const NO_INPUT: ActorInput = { moveX: 0, moveZ: 0, turn: 0, run: false };

/**
 * Authoritative actor simulation. Runs only in the operator window; output
 * windows receive the resulting poses and interpolate between updates.
 */
export function stepActors(
  rt: SceneRuntime,
  poses: ActorPoses,
  inputs: Record<string, ActorInput>,
  dt: number,
  wallNow: number,
): ActorPoses {
  if (rt.clock.pausedAt !== null) return poses;
  const t = sceneNow(rt, wallNow);
  let out: ActorPoses | null = null;
  for (const id in poses) {
    const comp = findComponent(rt.scene, id, "actor");
    if (!comp) continue;
    const next = stepActor(comp, poses[id], inputs[id] ?? NO_INPUT, dt, t);
    if (next !== poses[id]) {
      out ??= { ...poses };
      out[id] = next;
    }
  }
  return out ?? poses;
}

function stepActor(c: ActorComponent, a: ActorState, input: ActorInput, dt: number, t: number): ActorState {
  const info = LION_ACTION_INFO[a.action];

  // One-shot actions own the body until they finish (fall holds until a new command).
  if (!info.loop) {
    if (isOneShotBusy(a, t)) return rootMotion(c, a, dt, t);
    a = { ...setActorAction(a, "idle", t), speed: 0 };
  }

  const manual = input.moveX !== 0 || input.moveZ !== 0;
  let dirX = 0;
  let dirZ = 0;
  let gait: "walk" | "run" = input.run || a.cruise === "run" ? "run" : "walk";
  let speedScale = 1;
  let target = a.target;
  let cruise = a.cruise;

  if (manual) {
    const len = Math.hypot(input.moveX, input.moveZ);
    dirX = input.moveX / len;
    dirZ = input.moveZ / len;
    target = null;
  } else if (target) {
    const dx = target[0] - a.pos[0];
    const dz = target[1] - a.pos[1];
    const dist = Math.hypot(dx, dz);
    gait = a.targetGait;
    if (dist < (gait === "run" ? 0.9 : 0.35)) {
      target = null;
    } else {
      dirX = dx / dist;
      dirZ = dz / dist;
      speedScale = clamp(dist / (gait === "run" ? 4 : 1.6), 0.35, 1);
    }
  } else if (cruise) {
    dirX = Math.sin(a.heading);
    dirZ = Math.cos(a.heading);
    gait = cruise;
  }

  let heading = a.heading;
  let speed = a.speed;
  const moving = dirX !== 0 || dirZ !== 0;
  const turnRate = c.speeds.turnRate * (gait === "run" ? 1.25 : 1);
  if (moving) {
    const desired = Math.atan2(dirX, dirZ);
    const err = angleDelta(heading, desired);
    heading += clamp(err, -turnRate * dt, turnRate * dt);
    const align = Math.cos(angleDelta(heading, desired));
    // Only advance along the facing direction; turn in place when badly misaligned so feet never skate sideways.
    const want = (gait === "run" ? c.speeds.run : c.speeds.walk) * speedScale * (align > 0.25 ? align * align : 0);
    speed += (want - speed) * Math.min(1, dt * (want > speed ? 2.5 : 5));
  } else {
    speed += (0 - speed) * Math.min(1, dt * 6);
    if (speed < 0.01) speed = 0;
    if (input.turn) heading += input.turn * turnRate * 0.8 * dt;
  }

  // Integrate and keep the lion inside the playing area.
  let x = a.pos[0] + Math.sin(heading) * speed * dt;
  let z = a.pos[1] + Math.cos(heading) * speed * dt;
  const b = c.bounds;
  if (x < b.xMin || x > b.xMax || z < b.zMin || z > b.zMax) {
    x = clamp(x, b.xMin, b.xMax);
    z = clamp(z, b.zMin, b.zMax);
    speed = 0;
    cruise = null;
    target = null;
  }

  const dHeading = Math.abs(angleDelta(a.heading, heading));
  const stride = gait === "run" ? c.stride.run : c.stride.walk;
  let gaitPhase = a.gaitPhase + (speed * dt) / stride;
  const turning = speed < 0.15 && dHeading / Math.max(dt, 1e-4) > 0.25;
  if (turning) gaitPhase += dHeading * 0.45;

  let action = a.action;
  const walking = a.action === "walk" || a.action === "run";
  if (speed > (walking ? 0.06 : 0.15)) action = gait === "run" && speed > c.speeds.walk * 1.2 ? "run" : "walk";
  else if (turning) action = "turn";
  else if (!moving) action = "idle";

  let next: ActorState = a;
  if (action !== a.action) next = setActorAction(a, action, t);
  if (
    next === a &&
    x === a.pos[0] &&
    z === a.pos[1] &&
    heading === a.heading &&
    speed === a.speed &&
    target === a.target &&
    cruise === a.cruise
  )
    return a;
  return { ...next, pos: [x, z], heading, speed, gaitPhase, target, cruise };
}

/** Attack lunges forward and hit recoils back; the sim moves the body so it stays grounded. */
function rootMotion(c: ActorComponent, a: ActorState, dt: number, t: number): ActorState {
  const spec = a.action === "attack" ? ATTACK_LUNGE : a.action === "hit" ? HIT_RECOIL : null;
  if (!spec) return a;
  const dur = LION_ACTION_INFO[a.action].duration * 1000;
  const f1 = (t - a.actionAt) / dur;
  const f0 = (t - dt * 1000 - a.actionAt) / dur;
  const d = spec.distance * (smoothstep(spec.start, spec.end, f1) - smoothstep(spec.start, spec.end, f0));
  if (d === 0) return a;
  const b = c.bounds;
  const x = clamp(a.pos[0] + Math.sin(a.heading) * d, b.xMin, b.xMax);
  const z = clamp(a.pos[1] + Math.cos(a.heading) * d, b.zMin, b.zMax);
  return { ...a, pos: [x, z] };
}
