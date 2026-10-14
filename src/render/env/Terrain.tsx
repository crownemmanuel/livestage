import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { fbm, rng, valueNoise } from "@/core/noise";
import { ENV_LOOKS, terrainHeight, type EnvLook } from "@/core/terrain";

import { NOISE_GLSL } from "../glsl";
import { cached } from "../cache";

type Preset = "lion-hills" | "shepherd-valley";

/** sinh-warped grid: sub-metre detail near the stage, coarse cells at the horizon. */
function buildTerrain(preset: Preset, look: EnvLook) {
  const SEG_X = 300;
  const SEG_Z = 320;
  const A = 5;
  const sA = Math.sinh(A);
  const warp = (u: number, neg: number, pos: number) => (u < 0 ? -neg : pos) * (Math.sinh(A * Math.abs(u)) / sA);
  const xc = 0;
  const zc = -20;
  const verts = (SEG_X + 1) * (SEG_Z + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const cGrass = new THREE.Color(look.ground.grass);
  const cDry = new THREE.Color(look.ground.grassDry);
  const cDirt = new THREE.Color(look.ground.dirt);
  const cRock = new THREE.Color(look.ground.rock);
  const c = new THREE.Color();
  let i = 0;
  for (let iz = 0; iz <= SEG_Z; iz++) {
    const v = (iz / SEG_Z) * 2 - 1;
    const z = zc + warp(v, 2200, 160);
    for (let ix = 0; ix <= SEG_X; ix++) {
      const u = (ix / SEG_X) * 2 - 1;
      const x = xc + warp(u, 2000, 2000);
      const h = terrainHeight(preset, x, z);
      const e = 0.35;
      const hx = terrainHeight(preset, x + e, z) - terrainHeight(preset, x - e, z);
      const hz = terrainHeight(preset, x, z + e) - terrainHeight(preset, x, z - e);
      const n = new THREE.Vector3(-hx, 2 * e, -hz).normalize();
      pos.set([x, h, z], i * 3);
      nrm.set([n.x, n.y, n.z], i * 3);
      // Ground colour: grass/dry patches, dirt, rock on slopes.
      c.copy(cGrass).lerp(cDry, Math.min(1, Math.max(0, fbm(x * 0.018 + 4, z * 0.018, 3) * 1.6 - 0.4)));
      const dirt = Math.max(0, valueNoise(x * 0.06 + 10, z * 0.06) - 0.62) * 2.6;
      c.lerp(cDirt, Math.min(1, dirt));
      const slope = 1 - n.y;
      c.lerp(cRock, Math.min(1, Math.max(0, (slope - 0.12) * 4)));
      const shade = 0.88 + 0.24 * valueNoise(x * 0.25, z * 0.25);
      col.set([c.r * shade, c.g * shade, c.b * shade], i * 3);
      i++;
    }
  }
  const idx = new Uint32Array(SEG_X * SEG_Z * 6);
  let k = 0;
  for (let iz = 0; iz < SEG_Z; iz++) {
    for (let ix = 0; ix < SEG_X; ix++) {
      const a = iz * (SEG_X + 1) + ix;
      const b = a + 1;
      const d = a + SEG_X + 1;
      const e = d + 1;
      idx.set([a, d, b, b, d, e], k);
      k += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function terrainMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWPos;\n${NOISE_GLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float dist = length(vWPos.xz - cameraPosition.xz);
        float fine = fbm4(vWPos.xz * 1.7) - 0.5;
        float mid = fbm4(vWPos.xz * 0.21 + 7.0) - 0.5;
        float detail = mix(fine * 0.45, 0.0, smoothstep(30.0, 140.0, dist)) + mid * 0.35;
        diffuseColor.rgb *= 1.0 + detail;
        float pebble = step(0.82, vnoise(vWPos.xz * 9.0)) * (1.0 - smoothstep(10.0, 40.0, dist));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7, pebble * 0.6);`,
      );
  };
  return m;
}

function rockGeometry(seed: number, detail: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm(v.x * 1.3 + seed, v.y * 1.3 + v.z * 0.7, 4);
    const r = 0.72 + n * 0.62;
    v.multiplyScalar(r);
    v.y *= 0.62;
    if (v.y < -0.15) v.y = -0.15 + (v.y + 0.15) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function scatter(look: EnvLook, preset: Preset) {
  const r = rng(preset === "lion-hills" ? 11 : 37);
  const rocks: THREE.Matrix4[] = [];
  const rockColors: THREE.Color[] = [];
  const base = new THREE.Color(look.rocks.color);
  const [x0, x1, z0, z1] = look.rocks.area;
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let n = 0; n < look.rocks.count * 3 && rocks.length < look.rocks.count; n++) {
    const x = x0 + r() * (x1 - x0);
    const z = z0 + r() * (z1 - z0);
    // Keep the lion's walking lane clear of trip hazards.
    if (Math.abs(x) < 7 && z > -60 && z < 9) continue;
    if (valueNoise(x * 0.05, z * 0.05) < 0.45 && r() < 0.6) continue;
    const s = look.rocks.size[0] + Math.pow(r(), 2.2) * (look.rocks.size[1] - look.rocks.size[0]);
    const y = terrainHeight(preset, x, z) - s * 0.18;
    e.set(r() * 0.4, r() * Math.PI * 2, r() * 0.4);
    q.setFromEuler(e);
    rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s * (0.8 + r() * 0.6), s, s * (0.8 + r() * 0.6))));
    rockColors.push(base.clone().multiplyScalar(0.75 + r() * 0.45));
  }
  const boulders = look.boulders.map(([x, z, s]) => {
    e.set(0, r() * Math.PI * 2, 0);
    q.setFromEuler(e);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, terrainHeight(preset, x, z) - s * 0.2, z),
      q,
      new THREE.Vector3(s * 1.2, s, s),
    );
  });
  return { rocks, rockColors, boulders };
}

function treeGeometry(seed: number) {
  const r = rng(seed);
  const trunk = new THREE.CylinderGeometry(0.16, 0.34, 2.8, 7, 4).toNonIndexed();
  trunk.translate(0, 1.4, 0);
  const tp = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    tp.setX(i, tp.getX(i) + (y * y) * 0.05);
  }
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, color: THREE.Color, vary: number) => {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = 1 - vary / 2 + r() * vary;
      arr.set([color.r * k, color.g * k, color.b * k], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    g.deleteAttribute("uv");
    return g;
  };
  parts.push(paint(trunk, new THREE.Color("#4a3a2a"), 0.2));
  const leaf = new THREE.Color("#5b6741");
  for (let i = 0; i < 7; i++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let j = 0; j < p.count; j++) {
      const k = 0.8 + fbm(p.getX(j) * 2 + i, p.getY(j) * 2 + p.getZ(j), 3) * 0.5;
      p.setXYZ(j, p.getX(j) * k, p.getY(j) * k * 0.62, p.getZ(j) * k);
    }
    const a = (i / 7) * Math.PI * 2 + r();
    const rad = i === 0 ? 0 : 0.9 + r() * 0.6;
    const s = 0.9 + r() * 0.5;
    g.scale(s, s, s);
    g.translate(Math.cos(a) * rad + 0.25, 3.0 + r() * 0.8, Math.sin(a) * rad);
    parts.push(paint(g, leaf, 0.35));
  }
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  return merged;
}

export function Terrain({ preset }: { preset: Preset }) {
  const look = ENV_LOOKS[preset];
  const geo = cached(`terrain:${preset}`, () => buildTerrain(preset, look));
  const mat = cached("terrain-mat", terrainMaterial);
  return <mesh geometry={geo} material={mat} receiveShadow dispose={null} />;
}

export function Rocks({ preset }: { preset: Preset }) {
  const look = ENV_LOOKS[preset];
  const data = useMemo(() => {
    const s = cached(`scatter:${preset}`, () => scatter(look, preset));
    const small = new THREE.InstancedMesh(cached("rock-geo", () => rockGeometry(3, 2)), new THREE.MeshStandardMaterial({ roughness: 0.93, color: "#ffffff" }), s.rocks.length);
    s.rocks.forEach((m, i) => {
      small.setMatrixAt(i, m);
      small.setColorAt(i, s.rockColors[i]);
    });
    small.castShadow = true;
    small.receiveShadow = true;
    const bmat = new THREE.MeshStandardMaterial({ roughness: 0.9, color: look.rocks.color });
    bmat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLPos;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLPos = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vLPos;\n${NOISE_GLSL}`)
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float n = fbm4(vLPos.xz * 3.0 + vLPos.y * 2.0);
          float strata = fbm4(vec2(vLPos.y * 9.0, vLPos.x * 0.5));
          diffuseColor.rgb *= 0.7 + n * 0.45 + strata * 0.15;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.36, 0.22), smoothstep(0.55, 0.75, fbm4(vLPos.xz * 2.0 + 5.0)) * smoothstep(0.1, 0.5, vLPos.y) * 0.4);`,
        );
    };
    const big = new THREE.InstancedMesh(cached("boulder-geo", () => rockGeometry(9, 4)), bmat, Math.max(1, s.boulders.length));
    s.boulders.forEach((m, i) => big.setMatrixAt(i, m));
    big.count = s.boulders.length;
    big.castShadow = true;
    big.receiveShadow = true;
    return { small, big };
  }, [preset, look]);
  return (
    <>
      <primitive object={data.small} />
      <primitive object={data.big} />
    </>
  );
}

export function Trees({ preset }: { preset: Preset }) {
  const look = ENV_LOOKS[preset];
  const mesh = useMemo(() => {
    if (!look.trees) return null;
    const geo = cached(`tree:${preset}`, () => treeGeometry(preset === "lion-hills" ? 5 : 8));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
    const m = new THREE.InstancedMesh(geo, mat, look.trees.count);
    const r = rng(preset === "lion-hills" ? 77 : 99);
    const [x0, x1, z0, z1] = look.trees.area;
    const q = new THREE.Quaternion();
    let n = 0;
    for (let tries = 0; tries < look.trees.count * 10 && n < look.trees.count; tries++) {
      const x = x0 + r() * (x1 - x0);
      const z = z0 + r() * (z1 - z0);
      if (Math.abs(x) < 9 && z > -70) continue;
      if (preset === "shepherd-valley" && Math.hypot(x + 4, z + 30) < 18) continue;
      const s = 0.8 + r() * 0.7;
      q.setFromEuler(new THREE.Euler(0, r() * Math.PI * 2, 0));
      m.setMatrixAt(n++, new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(preset, x, z) - 0.1, z), q, new THREE.Vector3(s, s * (0.85 + r() * 0.3), s)));
    }
    m.count = n;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }, [preset, look]);
  return mesh ? <primitive object={mesh} /> : null;
}
