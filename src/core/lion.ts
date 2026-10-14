import type { LionAction } from "./types";

export interface LionActionInfo {
  label: string;
  key: string;
  loop: boolean;
  /** One-shot length in seconds before the lion returns to idle (fall holds). */
  duration: number;
  /** Seconds to blend in from the previous action. */
  blendIn: number;
}

export const LION_ACTION_INFO: Record<LionAction, LionActionInfo> = {
  idle: { label: "Idle", key: "1", loop: true, duration: 0, blendIn: 0.35 },
  walk: { label: "Walk", key: "2", loop: true, duration: 0, blendIn: 0.3 },
  run: { label: "Run", key: "3", loop: true, duration: 0, blendIn: 0.3 },
  turn: { label: "Turn", key: "", loop: true, duration: 0, blendIn: 0.25 },
  roar: { label: "Roar", key: "4", loop: false, duration: 2.8, blendIn: 0.25 },
  attack: { label: "Attack", key: "5", loop: false, duration: 1.7, blendIn: 0.12 },
  hit: { label: "Hit reaction", key: "6", loop: false, duration: 1.1, blendIn: 0.08 },
  fall: { label: "Fall", key: "7", loop: false, duration: 1.8, blendIn: 0.15 },
};

/** Forward travel (metres) the attack lunge covers — applied by the simulation as root motion. */
export const ATTACK_LUNGE = { start: 0.35, end: 0.8, distance: 1.6 };
/** Backward stagger during the hit reaction. */
export const HIT_RECOIL = { start: 0.0, end: 0.35, distance: -0.5 };

export const LION_KEYMAP: Record<string, LionAction | "stop"> = {
  Digit1: "idle",
  Digit2: "walk",
  Digit3: "run",
  Digit4: "roar",
  Digit5: "attack",
  Digit6: "hit",
  Digit7: "fall",
  Space: "stop",
};

export const LION_MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"];
