import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng } from "@/core/noise";
import { terrainHeight } from "@/core/terrain";
import type { ProceduralComponent } from "@/core/types";
import { cached } from "../../cache";
import { useStage } from "../../frame";
import { useLayerPresence } from "../../layers/presence";
import { BACKDROP_GLSL, backdropUniforms, photoGrade, photoTexture } from "./shared";

const PRESET = "shepherd-photoreal" as const;

/** Trimmed photo cut-outs: width / height of each image. */
const SPRITES = {
  tree1: 0.9531,
  tree2: 1.1204,
  tree3: 1.0723,
  sheep1: 1.2724,
  sheep2: 1.2237,
  sheep3: 1.2524,
  rock1: 1.3974,
  rock2: 1.044,
  grass1: 1.0261,
  grass2: 0.9277,
  grass3: 1.0964,
} as const;
type SpriteName = keyof typeof SPRITES;

const spriteVert = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uSway;
varying vec2 vUv;
varying vec3 vWPos;
void main() {
  vUv = uv;
  vec3 p = position;
  vec4 base = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  // wind: tops sway, bases stay planted; phase travels across the field as gusts
  float bend = uv.y * uv.y * uSway;
  float ph = base.x * 0.31 + base.z * 0.17;
  float gust = 0.6 + 0.4 * sin(uTime * 0.55 + base.x * 0.04);
  p.x += bend * uWind * gust * (0.6 * sin(uTime * 1.9 + ph) + 0.4);
  p.z += bend * uWind * gust * 0.3 * sin(uTime * 1.3 + ph * 1.7);
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const spriteFrag = /* glsl */ `
uniform sampler2D map;
uniform vec3 uLight;
uniform float uHaze;
uniform float uHazeNear;
uniform float uHazeFar;
uniform float uFootDark;
uniform vec3 uTint;
uniform float uTintMix;
varying vec2 vUv;
varying vec3 vWPos;
${BACKDROP_GLSL}
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.42) discard;
  vec3 c = mix(t.rgb, t.rgb * uTint, uTintMix) * uLight;
  // occlusion where the object meets the ground
  c *= mix(1.0 - uFootDark, 1.0, smoothstep(0.0, 0.18, vUv.y));
  vec3 d = vWPos - cameraPosition;
  float k = smoothstep(uHazeNear, uHazeFar, length(d)) * uHaze;
  c = mix(c, backdropAt(normalize(d)), k);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

function spriteMaterial(file: string, opts: { sway?: number; footDark?: number; haze?: number; hazeNear?: number; hazeFar?: number } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: spriteVert,
    fragmentShader: spriteFrag,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    uniforms: {
      ...backdropUniforms(),
      map: { value: photoTexture(file, { aniso: 8 }) },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uTime: { value: 0 },
      uWind: { value: 0.2 },
      uSway: { value: opts.sway ?? 0 },
      uHaze: { value: opts.haze ?? 0.85 },
      uHazeNear: { value: opts.hazeNear ?? 60 },
      uHazeFar: { value: opts.hazeFar ?? 700 },
      uFootDark: { value: opts.footDark ?? 0.35 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTintMix: { value: 0 },
    },
  });
}

/** Unit quad standing on its bottom edge. */
const quadGeo = () => cached("sprite-quad", () => new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0));

interface Placement {
  x: number;
  z: number;
  h: number;
  sink: number;
  mirror?: boolean;
}

/** One instanced batch of a photo sprite, turned to face the camera every frame. */
function SpriteBatch({ name, items, castShadow = true, sway = 0, footDark, haze, gain = 1, visible }: { name: SpriteName; items: Placement[]; castShadow?: boolean; sway?: number; footDark?: number; haze?: number; gain?: number; visible?: () => number }) {
  const { frame } = useStage();
  const aspect = SPRITES[name];
  const { mesh, mat } = useMemo(() => {
    const mat = spriteMaterial(`${name}.png`, { sway, footDark, haze });
    const mesh = new THREE.InstancedMesh(quadGeo(), mat, Math.max(1, items.length));
    mesh.count = items.length;
    mesh.castShadow = castShadow;
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: mat.uniforms.map.value, alphaTest: 0.5, side: THREE.DoubleSide });
    mesh.frustumCulled = false;
    return { mesh, mat };
  }, [name, items, castShadow, sway, footDark, haze]);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const s = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera }) => {
    const v = visible ? visible() : 1;
    mesh.visible = v > 0.01;
    if (!mesh.visible) return;
    items.forEach((it, i) => {
      // cylindrical billboard: face the camera around the vertical axis
      q.setFromAxisAngle(up, Math.atan2(camera.position.x - it.x, camera.position.z - it.z));
      const k = v;
      p.set(it.x, terrainHeight(PRESET, it.x, it.z) - it.sink * it.h, it.z);
      s.set(it.h * aspect * k * (it.mirror ? -1 : 1), it.h * k, 1);
      mesh.setMatrixAt(i, m4.compose(p, q, s));
    });
    mesh.instanceMatrix.needsUpdate = true;
    photoGrade(frame, mat.uniforms.uLight.value).multiplyScalar(gain);
    photoGrade(frame, mat.uniforms.uBackdropGrade.value);
    mat.uniforms.uTime.value = frame.ts;
    mat.uniforms.uWind.value = frame.windNow;
  });
  return <primitive object={mesh} />;
}

function scatter(seed: number, n: number, place: (r: () => number) => Placement | null): Placement[] {
  const r = rng(seed);
  const out: Placement[] = [];
  for (let tries = 0; out.length < n && tries < n * 30; tries++) {
    const p = place(r);
    if (p) out.push(p);
  }
  return out;
}

const keepClear = (x: number, z: number) => Math.abs(x - 7) < 3 && Math.abs(z + 16) < 3; // the shepherds' fire

export function PhotoSprites({ sheep }: { sheep: ProceduralComponent | null }) {
  const sheepPresence = useLayerPresence(sheep?.id ?? "__none__", sheep?.fade ?? 1);
  const layout = useMemo(() => {
    // Olive trees: groves on both flanks, thinning into the distance (haze takes them into the photo).
    const trees = scatter(41, 34, (r) => {
      const side = r() < 0.5 ? -1 : 1;
      const z = -18 - Math.pow(r(), 1.4) * 170;
      const x = side * (14 + r() * (34 + -z * 0.3));
      if (keepClear(x, z)) return null;
      return { x, z, h: 5.5 + r() * 3, sink: 0.02 };
    });
    const rocks = scatter(43, 22, (r) => {
      const x = (r() - 0.5) * 70;
      const z = 4 - Math.pow(r(), 1.2) * 90;
      if (keepClear(x, z) || Math.abs(x) < 3) return null;
      return { x, z, h: 0.35 + Math.pow(r(), 2) * 1.2, sink: 0.12 };
    });
    const c = sheep?.center ?? [-4, -30];
    const rad = sheep?.radius ?? 16;
    const flock = scatter(47, sheep?.count ?? 26, (r) => {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * rad;
      const x = c[0] + Math.cos(a) * d;
      const z = c[1] + Math.sin(a) * d * 0.6;
      if (keepClear(x, z)) return null;
      return { x, z, h: 0.92 + r() * 0.16, sink: 0.03, mirror: r() < 0.4 };
    });
    const split = <T,>(arr: T[], k: number) => Array.from({ length: k }, (_, i) => arr.filter((_, j) => j % k === i));
    return { trees: split(trees, 3), rocks: split(rocks, 2), sheep: split(flock, 3) };
  }, [sheep?.center, sheep?.radius, sheep?.count]);

  return (
    <>
      {(["tree1", "tree2", "tree3"] as const).map((n, i) => (
        <SpriteBatch key={n} name={n} items={layout.trees[i]} sway={0.04} footDark={0.25} />
      ))}
      {(["rock1", "rock2"] as const).map((n, i) => (
        <SpriteBatch key={n} name={n} items={layout.rocks[i]} footDark={0.4} />
      ))}
      {sheep &&
        (["sheep1", "sheep2", "sheep3"] as const).map((n, i) => (
          <SpriteBatch key={n} name={n} items={layout.sheep[i]} footDark={0.3} gain={0.82} visible={sheepPresence} />
        ))}
    </>
  );
}

// ---------------------------------------------------------------- grass cards

/** Two crossed quads standing on their base: reads as a 3D tuft from any angle. */
function crossGeo() {
  return cached("grass-cross", () => {
    const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const b = a.clone().rotateY(Math.PI / 2);
    return mergeGeometries([a, b])!;
  });
}

function grassBatch(seed: number, n: number, aspect: number) {
  return cached(`grass-batch:${seed}`, () => {
    const r = rng(seed);
    const mats: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let tries = 0; mats.length < n && tries < n * 4; tries++) {
      const x = (r() - 0.5) * 70;
      const z = 7.5 - Math.pow(r(), 1.5) * 32;
      if (keepClear(x, z)) continue;
      // clumping: sparser in worn patches
      // tufts gather in clumps with open short-grass between them
      const clump = 0.5 + 0.5 * Math.sin(x * 0.21 + Math.cos(z * 0.17) * 2.3) * Math.cos(z * 0.13 - x * 0.05);
      if (r() > clump * clump) continue;
      const h = 0.14 + Math.pow(r(), 2.4) * 0.34;
      q.setFromAxisAngle(up, r() * Math.PI * 2);
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(PRESET, x, z) - 0.03, z), q, new THREE.Vector3(h * aspect * (r() < 0.5 ? -1 : 1), h, h * aspect)));
    }
    return mats;
  });
}

export function PhotoGrass() {
  const { frame } = useStage();
  const batches = useMemo(
    () =>
      (["grass1", "grass2", "grass3"] as const).map((name, i) => {
        const mat = spriteMaterial(`${name}.png`, { sway: 0.22, footDark: 0.55, haze: 0.6, hazeNear: 40, hazeFar: 120 });
        // backlit tufts photograph brighter than the lit field; bring them down to sit in it
        mat.uniforms.uGain = { value: 0.5 };
        // pull the backlit tufts toward the field's olive-gold so they sit in it
        mat.uniforms.uTint.value.setRGB(0.62, 0.7, 0.32);
        mat.uniforms.uTintMix.value = 0.75;
        const mats = grassBatch(900 + i, 1500, SPRITES[name]);
        const mesh = new THREE.InstancedMesh(crossGeo(), mat, mats.length);
        mats.forEach((m, j) => mesh.setMatrixAt(j, m));
        mesh.frustumCulled = false;
        return { mesh, mat };
      }),
    [],
  );
  useFrame(() => {
    for (const { mat } of batches) {
      photoGrade(frame, mat.uniforms.uLight.value).multiplyScalar(mat.uniforms.uGain.value);
      photoGrade(frame, mat.uniforms.uBackdropGrade.value);
      mat.uniforms.uTime.value = frame.ts;
      mat.uniforms.uWind.value = 0.25 + frame.windNow;
    }
  });
  return (
    <>
      {batches.map((b, i) => (
        <primitive key={i} object={b.mesh} />
      ))}
    </>
  );
}
