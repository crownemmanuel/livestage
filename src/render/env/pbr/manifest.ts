// Files the scanned-asset valley ("shepherd-pbr") loads from /media/pbr-valley/.
// Everything here is CC0 from Poly Haven unless noted (see public/media/pbr-valley/CREDITS.md).

export interface ScatterSpec {
  /** glTF/GLB file under PBR_BASE. */
  file: string;
  /** How many instances to place. */
  count: number;
  /** Uniform scale range. */
  scale: [number, number];
  /** Area [x0, x1, z0, z1] to scatter over. */
  area: [number, number, number, number];
  /** Sink into the ground (m, before scale) so roots never float on a slope. */
  sink?: number;
  /** Instances thin out with distance from the stage when > 0 (1 = strongly near-weighted). */
  nearBias?: number;
  /** Deterministic seed. */
  seed: number;
  /** Leaves/blades sway in the wind (materials with alpha cut-out, or all when "all"). */
  wind?: "leaves" | "all";
  /** Approximate height of the model (m, before scale), for wind bending. */
  height: number;
}

export interface GroundSet {
  diffuse: string;
  normal: string;
  roughness: string;
  ao?: string;
  /** Metres per texture repeat. */
  tile: number;
}

export interface PbrManifest {
  hdri: string;
  /** Linear multiplier on the HDRI for sky and lighting (Poly Haven skies are roughly absolute). */
  hdriExposure: number;
  ground: GroundSet;
  /** Second ground set blended in on worn ground and slopes (dirt/rock). */
  groundAlt: GroundSet | null;
  trees: ScatterSpec[];
  rocks: ScatterSpec[];
  grass: ScatterSpec[];
}

const M = "models/";

export const PBR_MANIFEST: PbrManifest = {
  hdri: "sky-afternoon.hdr",
  hdriExposure: 1,
  ground: { diffuse: "ground/grass_ground/diff.jpg", normal: "ground/grass_ground/nor_gl.jpg", roughness: "ground/grass_ground/rough.jpg", ao: "ground/grass_ground/ao.jpg", tile: 3.5 },
  groundAlt: { diffuse: "ground/brown_mud_dry/diff.jpg", normal: "ground/brown_mud_dry/nor_gl.jpg", roughness: "ground/brown_mud_dry/rough.jpg", ao: "ground/brown_mud_dry/ao.jpg", tile: 2.5 },
  trees: [
    // 2.3 m scanned tree, scaled to 3-4.5 m; the valley's main tree
    { file: `${M}searsia_lucida_1k/searsia_lucida_1k.gltf`, count: 10, scale: [1.3, 2.0], area: [-120, 120, -260, -18], seed: 101, wind: "leaves", height: 2.3, sink: 0.08 },
    // 3.4 m hero tree (1 M triangles): a couple only
    { file: `${M}island_tree_02_1k/island_tree_02_1k.gltf`, count: 2, scale: [1.4, 1.8], area: [-60, 60, -120, -30], seed: 102, wind: "leaves", height: 3.4, sink: 0.08 },
    { file: `${M}wild_rooibos_bush_1k/wild_rooibos_bush_1k.gltf`, count: 16, scale: [1.2, 2.2], area: [-90, 90, -200, -30], seed: 103, wind: "leaves", height: 0.55 },
    // the same bushes, scaled up, stand in for scrub on the far slopes and the town hill
    { file: `${M}wild_rooibos_bush_1k/wild_rooibos_bush_1k.gltf`, count: 50, scale: [3.5, 6], area: [-420, 420, -560, -180], seed: 106, height: 0.55 },
    { file: `${M}shrub_02_1k/shrub_02_1k.gltf`, count: 22, scale: [0.8, 1.3], area: [-100, 100, -220, -8], seed: 104, wind: "leaves", height: 1.7, sink: 0.25 },
    { file: `${M}shrub_02_1k/shrub_02_1k.gltf`, count: 40, scale: [2.5, 4], area: [-420, 420, -560, -160], seed: 107, height: 1.7, sink: 0.4 },
    { file: `${M}dry_branches_medium_01_1k/dry_branches_medium_01_1k.gltf`, count: 6, scale: [1, 1.4], area: [-60, 60, -120, -14], seed: 105, height: 0.2 },
  ],
  rocks: [
    { file: `${M}boulder_01_2k/boulder_01_2k.gltf`, count: 6, scale: [0.8, 1.6], area: [-90, 90, -220, 8], seed: 201, height: 0.9, sink: 0.12 },
    { file: `${M}namaqualand_boulder_02_2k/namaqualand_boulder_02_2k.gltf`, count: 6, scale: [0.8, 1.5], area: [-90, 90, -220, 8], seed: 202, height: 0.8, sink: 0.12 },
    { file: `${M}namaqualand_boulder_04_2k/namaqualand_boulder_04_2k.gltf`, count: 4, scale: [0.7, 1.2], area: [-100, 100, -240, -10], seed: 203, height: 1.9, sink: 0.15 },
    // 14 cm pebble scaled to 15-60 cm stones, close in
    { file: `${M}rock_07_2k/rock_07_2k.gltf`, count: 50, scale: [1.5, 4], area: [-50, 50, -100, 8], seed: 204, height: 0.14, nearBias: 0.5, sink: 0.02 },
  ],
  grass: [
    // 40 cm clumps near the stage; the blade grass carries the mid-field
    { file: `${M}grass_medium_02_2k/grass_medium_02_2k.gltf`, count: 700, scale: [1.3, 2.2], area: [-34, 34, -50, 8], seed: 301, wind: "all", height: 0.4, nearBias: 0.8, sink: 0.01 },
  ],
};
