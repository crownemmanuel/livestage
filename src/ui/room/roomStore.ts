import { create } from "zustand";

/**
 * What the Room view shows (operator window only, not the show file): which room photo, and what is on its
 * wall: the preview monitor (the selected scene, as it plays) or one image or video from the library.
 */
export interface RoomState {
  /** RoomView id; null = the show's first. */
  viewId: string | null;
  /** Asset on the wall; null = the preview monitor. */
  assetId: string | null;
  /** Wall brightness in the picture (1 = as rendered). */
  brightness: number;
}

const KEY = "sls.room";
function load(): RoomState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { viewId: typeof v.viewId === "string" ? v.viewId : null, assetId: null, brightness: typeof v.brightness === "number" ? v.brightness : 1 };
  } catch {
    return { viewId: null, assetId: null, brightness: 1 };
  }
}

export const useRoom = create<RoomState>(() => load());

useRoom.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ viewId: s.viewId, brightness: s.brightness }));
  } catch {
    /* storage unavailable */
  }
});

/** The default wall outline for a new photo: a 4:1 band in the middle. */
export const DEFAULT_WALL: [number, number][] = [
  [0.3, 0.33],
  [0.7, 0.33],
  [0.7, 0.53],
  [0.3, 0.53],
];

/**
 * CSS matrix3d that maps a w x h box (transform-origin 0 0) onto the quad p (TL, TR, BR, BL, in px):
 * the projective map of the unit square (Heckbert), scaled to the box.
 */
export function quadMatrix(w: number, h: number, p: [number, number][]): string {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, k = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    k = (dx1 * dy3 - dx3 * dy1) / det;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + k * y3, f = y0;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, c, f, 0, 1];
  return `matrix3d(${m.map((v) => +v.toFixed(9)).join(",")})`;
}
