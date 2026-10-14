import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { angleDelta, clamp } from "@/core/clock";
import { LION_ACTION_INFO } from "@/core/lion";
import { terrainHeight } from "@/core/terrain";
import type { ActorComponent, EnvironmentPreset, LionAction } from "@/core/types";
import { useStage } from "../frame";

/** Smoothed, render-ready actor state for one frame. */
export interface ActorFrame {
  ready: boolean;
  x: number;
  z: number;
  y: number;
  pitch: number;
  heading: number;
  gaitPhase: number;
  speed: number;
  action: LionAction;
  /** Seconds since the current action began. */
  actionT: number;
  prev: LionAction;
  prevT: number;
  /** Weight of the current action vs the previous one (0..1). */
  blend: number;
  visible: number;
}

/**
 * Follows the authoritative actor pose, extrapolating between network
 * updates so the output window moves as smoothly as the operator preview.
 */
export function useActorMotion(comp: ActorComponent, preset: EnvironmentPreset): ActorFrame {
  const { getPoses, frame } = useStage();
  const st = useMemo<ActorFrame>(
    () => ({ ready: false, x: 0, z: 0, y: 0, pitch: 0, heading: 0, gaitPhase: 0, speed: 0, action: "idle", actionT: 0, prev: "idle", prevT: 0, blend: 1, visible: 0 }),
    [],
  );

  useFrame((_, dt) => {
    const { poses, at } = getPoses();
    const a = poses[comp.id];
    if (!a) {
      st.visible = 0;
      return;
    }
    const moving = a.action === "walk" || a.action === "run" || a.action === "turn";
    const ext = moving ? clamp((frame.wall - at) / 1000, 0, 0.12) : 0;
    const tx = a.pos[0] + Math.sin(a.heading) * a.speed * ext;
    const tz = a.pos[1] + Math.cos(a.heading) * a.speed * ext;
    const stride = a.action === "run" ? comp.stride.run : comp.stride.walk;
    const tPhase = a.gaitPhase + (a.speed * ext) / stride;
    const jump = Math.hypot(tx - st.x, tz - st.z) > 2.5;
    if (!st.ready || jump) {
      st.x = tx;
      st.z = tz;
      st.heading = a.heading;
      st.gaitPhase = tPhase;
      st.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 16);
      st.x += (tx - st.x) * k;
      st.z += (tz - st.z) * k;
      st.heading += angleDelta(st.heading, a.heading) * k;
      // gait phase only moves forward, keeping footfalls locked to distance travelled
      st.gaitPhase = Math.max(st.gaitPhase, st.gaitPhase + (tPhase - st.gaitPhase) * k);
    }
    st.speed = a.speed;

    const fx = Math.sin(st.heading) * 0.75;
    const fz = Math.cos(st.heading) * 0.75;
    const hF = terrainHeight(preset, st.x + fx, st.z + fz);
    const hB = terrainHeight(preset, st.x - fx, st.z - fz);
    st.y = (hF + hB) / 2;
    st.pitch = Math.atan2(hB - hF, 1.5);

    st.action = a.action;
    st.prev = a.prevAction;
    st.actionT = Math.max(0, (frame.t - a.actionAt) / 1000);
    st.prevT = Math.max(0, (a.actionAt - a.prevActionAt) / 1000 + st.actionT);
    // Getting up after a fall takes longer than an ordinary blend.
    const blendIn = a.prevAction === "fall" ? 1.3 : LION_ACTION_INFO[a.action].blendIn;
    st.blend = clamp(st.actionT / blendIn, 0, 1);
    const vk = clamp((frame.t - a.visibleChangedAt) / 700, 0, 1);
    st.visible = a.visible ? vk : 1 - vk;
  }, -5);

  return st;
}
