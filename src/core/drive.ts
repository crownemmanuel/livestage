// Hold to move: a layer the operator walks across the wall by holding an arrow key.
// Where it is is a pure function of scene time: the runtime keeps only where it was at its last change and how
// fast it has gone since (DriveRuntime), so every window agrees.

import type { DriveRuntime, LayerDrive, Scene, SceneComponent, SceneRuntime } from "./types";

export interface DriveState {
  /** Wall widths moved from where the layer stands (0 .. distance). */
  off: number;
  /** Wall widths walked so far, both ways: a walk cycle's clock (seconds = trav / speed). */
  trav: number;
  /** Moving right now (a key held and the end not reached). */
  moving: boolean;
  /** Scene time (ms) it last started or stopped moving. */
  changedAt: number;
}

const STILL: DriveState = { off: 0, trav: 0, moving: false, changedAt: -1e9 };

type DrivenLayer = Extract<SceneComponent, { kind: "video" | "image" }>;

const isDrivable = (c: SceneComponent | undefined): c is DrivenLayer => !!c && (c.kind === "video" || c.kind === "image");

/** The layer whose keys move `comp` (itself, or the one it follows), with its drive settings. */
export function driverOf(scene: Scene, comp: SceneComponent): { id: string; drive: LayerDrive; x: number } | null {
  if (!isDrivable(comp) || !comp.drive) return null;
  if (!comp.drive.follow) return { id: comp.id, drive: comp.drive, x: comp.screen.x };
  const lead = scene.components.find((c) => c.id === comp.drive!.follow);
  if (!isDrivable(lead) || !lead.drive || lead.drive.follow) return null;
  return { id: lead.id, drive: lead.drive, x: lead.screen.x };
}

/** The layers of a scene the arrow keys move (those with a drive of their own). */
export function driverLayers(scene: Scene): DrivenLayer[] {
  return scene.components.filter((c): c is DrivenLayer => isDrivable(c) && !!c.drive && !c.drive.follow);
}

/** Where a drive is at scene time t (ms). */
export function driveAt(drive: LayerDrive, r: DriveRuntime | undefined, t: number): DriveState {
  if (!r) return STILL;
  const lo = Math.min(0, drive.distance);
  const hi = Math.max(0, drive.distance);
  // `off` grows towards `distance` going forward (v > 0), back towards 0 going back.
  const vel = r.v * drive.speed * (Math.sign(drive.distance) || 1);
  const end = Math.min(hi, Math.max(lo, r.to ?? (r.v > 0 ? drive.distance : 0)));
  const dt = Math.max(0, t - r.at) / 1000;
  const want = r.off + vel * dt;
  const reached = vel === 0 || (vel > 0 ? want >= end : want <= end);
  const off = vel === 0 ? r.off : reached ? end : want;
  const moving = !reached;
  const changedAt = vel !== 0 && reached ? r.at + (Math.abs(end - r.off) / Math.abs(vel)) * 1000 : r.at;
  return { off, trav: r.trav + Math.abs(off - r.off), moving, changedAt };
}

/** A new speed for a drive from scene time t: `v` × its own speed (+ forward, − back, 0 stop). */
export function setDrive(drive: LayerDrive, r: DriveRuntime | undefined, v: number, t: number): DriveRuntime {
  const st = driveAt(drive, r, t);
  return { at: t, off: st.off, trav: st.trav, v };
}

/** Walk to `to` (share of the distance, 0..1) at `rate` × its own speed from scene time t, then stop. */
export function driveTo(drive: LayerDrive, r: DriveRuntime | undefined, to: number, rate: number, t: number): DriveRuntime {
  const st = driveAt(drive, r, t);
  const target = Math.min(1, Math.max(0, to)) * drive.distance;
  const dir = Math.sign(target - st.off) * (Math.sign(drive.distance) || 1);
  return { at: t, off: st.off, trav: st.trav, v: dir * Math.abs(rate || 1), to: target };
}

/** The drive state of a layer (its own or the one it follows) in a runtime. */
export function layerDrive(rt: SceneRuntime, comp: SceneComponent, t: number): (DriveState & { drive: LayerDrive; driverX: number }) | null {
  const d = driverOf(rt.scene, comp);
  if (!d) return null;
  return { ...driveAt(d.drive, rt.drives?.[d.id], t), drive: d.drive, driverX: d.x };
}
