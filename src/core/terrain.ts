import { smoothstep } from "./clock";
import { fbm, ridged } from "./noise";
import type { EnvironmentPreset } from "./types";

/**
 * Analytic terrain height (metres). The same function builds the terrain
 * mesh and grounds actors, props and grass, so feet always meet the ground.
 */
export function terrainHeight(preset: EnvironmentPreset, x: number, z: number): number {
  if (preset === "lion-hills") return lionHills(x, z);
  if (preset === "shepherd-valley") return shepherdValley(x, z);
  if (preset === "shepherd-photoreal") return shepherdPhotoreal(x, z);
  return 0;
}

/** Open, gently rolling pasture: the photographic backdrop supplies the distant hills. */
function shepherdPhotoreal(x: number, z: number): number {
  const d = Math.hypot(x * 0.6, (z + 20) * 0.5);
  let h = (fbm(x * 0.018 + 5, z * 0.018 + 3, 3) - 0.5) * 2.2 * smoothstep(6, 45, d);
  h += (fbm(x * 0.11 + 9, z * 0.11, 2) - 0.5) * 0.14;
  // A hilltop pasture: gentle near field, then the ground falls away into the valley
  // seen in the photograph beyond the edge (~220 m out).
  h *= 1 - smoothstep(120, 220, -z);
  h -= smoothstep(200, 420, Math.hypot(x * 0.55, z + 10)) * 90;
  h += Math.max(0, z - 16) * 0.2;
  return h;
}

function lionHills(x: number, z: number): number {
  // Flat-ish arena where the lion performs, enclosed by rocky valley walls.
  const d = Math.hypot(x * 0.8, (z + 22) * 0.6);
  const far = smoothstep(18, 75, d);
  let h = (fbm(x * 0.011 + 3.1, z * 0.011 + 7.3, 5) - 0.42) * 34 * far;
  h += ridged(x * 0.018 + 11, z * 0.018 - 4, 4) * 22 * smoothstep(28, 95, Math.abs(x)) * smoothstep(-10, -60, z);
  h += (fbm(x * 0.07 + 1.7, z * 0.07 + 9.2, 3) - 0.5) * 0.9;
  h += Math.max(0, -z - 70) * 0.07;
  // Gentle rise behind the camera so the frame edge never shows the world's end.
  h += Math.max(0, z - 18) * 0.25;
  return h;
}

function shepherdValley(x: number, z: number): number {
  const d = Math.hypot(x * 0.7, (z + 10) * 0.5);
  let h = (fbm(x * 0.005 + 21, z * 0.005 + 5, 4) - 0.45) * 26 * smoothstep(25, 140, d);
  h += (fbm(x * 0.028 + 2, z * 0.028 + 13, 3) - 0.5) * 2.2 * smoothstep(4, 35, d);
  h += (fbm(x * 0.11, z * 0.11, 2) - 0.5) * 0.35;
  // Distant town hill (Bethlehem) and a long ridge across the back.
  h += 42 * Math.exp(-((x - 60) ** 2 + (z + 420) ** 2) / (2 * 95 ** 2));
  h += smoothstep(-160, -520, z) * (18 + 30 * fbm(x * 0.004 + 40, 3, 3));
  h += Math.max(0, z - 20) * 0.2;
  return h;
}

export interface EnvLook {
  ground: { grass: string; grassDry: string; dirt: string; rock: string };
  grass: {
    count: number;
    area: [number, number, number, number];
    base: string;
    tip: string;
    height: [number, number];
  };
  rocks: { count: number; area: [number, number, number, number]; size: [number, number]; color: string };
  boulders: [number, number, number][];
  trees: { count: number; area: [number, number, number, number] } | null;
  mountains: { dist: number; height: number; rough: number; color: string; seed: number }[];
}

export const ENV_LOOKS: Record<"lion-hills" | "shepherd-valley", EnvLook> = {
  "lion-hills": {
    ground: { grass: "#8f7a45", grassDry: "#b39a5e", dirt: "#8a6d4a", rock: "#7d7268" },
    grass: { count: 150000, area: [-60, 60, -120, 5], base: "#5a4824", tip: "#c4a866", height: [0.14, 0.5] },
    rocks: { count: 420, area: [-90, 90, -220, 14], size: [0.15, 1.1], color: "#8b8076" },
    boulders: [
      [-9, -6, 1.9],
      [-11.5, -9, 1.2],
      [10.5, -13, 2.4],
      [13, -9.5, 1.3],
      [-16, -30, 3.2],
      [17, -36, 2.8],
      [6, -46, 1.6],
      [-4.5, 9, 0.9],
      [8, 7.5, 1.1],
    ],
    trees: { count: 14, area: [-80, 80, -200, -40] },
    mountains: [
      { dist: 650, height: 120, rough: 1.3, color: "#8d8277", seed: 3 },
      { dist: 1100, height: 230, rough: 1.0, color: "#9a98a0", seed: 7 },
      { dist: 1900, height: 380, rough: 0.8, color: "#a7adbb", seed: 11 },
    ],
  },
  "shepherd-valley": {
    ground: { grass: "#5d7238", grassDry: "#8d8a4c", dirt: "#7a6448", rock: "#7a756c" },
    grass: { count: 160000, area: [-70, 70, -130, 6], base: "#34491f", tip: "#9bae5c", height: [0.12, 0.42] },
    rocks: { count: 160, area: [-110, 110, -260, 16], size: [0.12, 0.7], color: "#8a857b" },
    boulders: [
      [-14, -12, 1.4],
      [12, -24, 1.1],
      [9.4, -15.2, 0.6],
    ],
    trees: { count: 46, area: [-120, 120, -300, -18] },
    mountains: [
      { dist: 800, height: 90, rough: 0.9, color: "#6f7c74", seed: 21 },
      { dist: 1400, height: 170, rough: 0.8, color: "#8693a0", seed: 23 },
      { dist: 2200, height: 300, rough: 0.7, color: "#a1adc0", seed: 29 },
    ],
  },
};
