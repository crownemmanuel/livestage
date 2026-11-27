// Hold to move, from the operator's keyboard: → walks the scene's drive layers forward while held, ← back,
// ↑ / ↓ make them faster / slower. Each press and release is one timestamped command (core/drive.ts).

import { driveAt, driverLayers } from "@/core/drive";
import { sceneNow } from "@/core/clock";
import type { SceneRuntime } from "@/core/types";
import { useShow, type Target } from "@/store/show";

const runtimeOf = (target: Target): SceneRuntime | null => {
  const s = useShow.getState();
  return target === "program" ? s.program.runtime : s.preview;
};

/** The drive layers of `target`'s scene that are on screen now (the ones the keys move). */
export function activeDrivers(target: Target): string[] {
  const rt = runtimeOf(target);
  if (!rt) return [];
  return driverLayers(rt.scene)
    .filter((c) => rt.layers[c.id]?.visible)
    .map((c) => c.id);
}

/** Walk the drive layers (all on screen, or one): +1 forward, −1 back, 0 stop, at the operator's speed. */
export function drive(target: Target, dir: -1 | 0 | 1, layerId?: string): string[] {
  const rt = runtimeOf(target);
  if (!rt) return [];
  const ids = layerId ? [layerId] : activeDrivers(target);
  const v = dir * (rt.driveRate ?? 1);
  for (const id of ids) useShow.getState().dispatch(target, { type: "drive", layerId: id, v });
  return ids;
}

/** Faster (> 1) or slower (< 1) by this factor; returns the new speed. */
export function driveFaster(target: Target, factor: number): number {
  const rt = runtimeOf(target);
  if (!rt) return 1;
  useShow.getState().dispatch(target, { type: "driveRate", rate: (rt.driveRate ?? 1) * factor });
  return runtimeOf(target)?.driveRate ?? 1;
}

/** Where each drive layer of `target` is (for the agent and the status line). */
export function driveStatus(target: Target) {
  const rt = runtimeOf(target);
  if (!rt) return { rate: 1, layers: [] };
  const t = sceneNow(rt);
  return {
    rate: rt.driveRate ?? 1,
    layers: driverLayers(rt.scene).map((c) => {
      const st = driveAt(c.drive!, rt.drives?.[c.id], t);
      const dist = Math.abs(c.drive!.distance) || 1;
      return { id: c.id, name: c.name, onScreen: !!rt.layers[c.id]?.visible, moving: st.moving, progress: Math.round((Math.abs(st.off) / dist) * 1000) / 1000 };
    }),
  };
}

/**
 * Keyboard: returns true when it used the key (the scene on `target` has a drive layer on screen), so the
 * operator's other arrow keys (scene list) leave it alone. Call on keydown and keyup.
 */
export function driveKey(e: KeyboardEvent, target: Target): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const code = e.code;
  if (code !== "ArrowRight" && code !== "ArrowLeft" && code !== "ArrowUp" && code !== "ArrowDown") return false;
  if (!activeDrivers(target).length) return false;
  e.preventDefault();
  if (e.type === "keydown") {
    if (e.repeat) return true;
    if (code === "ArrowRight") held = 1;
    else if (code === "ArrowLeft") held = -1;
    else {
      driveFaster(target, code === "ArrowUp" ? 1.25 : 0.8);
      return true;
    }
    heldTarget = target;
    drive(target, held);
  } else if ((code === "ArrowRight" && held === 1) || (code === "ArrowLeft" && held === -1)) {
    held = 0;
    drive(heldTarget, 0);
  }
  return true;
}

let held: -1 | 0 | 1 = 0;
let heldTarget: Target = "preview";

/** The window lost focus with a key held: stop, or the crowd would walk on by itself. */
export function driveRelease() {
  if (held === 0) return;
  held = 0;
  drive(heldTarget, 0);
}
