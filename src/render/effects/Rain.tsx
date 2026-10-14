import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { bool, num } from "@/core/effects";
import { rng } from "@/core/noise";
import { effectLevel } from "@/core/runtime";
import { terrainHeight } from "@/core/terrain";
import type { EffectComponent, EnvironmentPreset } from "@/core/types";
import { cached } from "../cache";
import { useStage } from "../frame";

/** Rain volume layers around the camera: near streaks, mid, far curtain. */
const LAYERS = [
  { count: 2200, near: 1.5, far: 6, alpha: 0.32 },
  { count: 9000, near: 6, far: 22, alpha: 0.3 },
  { count: 20000, near: 22, far: 80, alpha: 0.26 },
];

function dropGeometry(count: number, seed: number) {
  const r = rng(seed);
  const seeds = new Float32Array(count * 4 * 4);
  const corners = new Float32Array(count * 4 * 2);
  const idx = new Uint32Array(count * 6);
  const C = [
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ];
  for (let i = 0; i < count; i++) {
    const s = [r(), r(), r(), r()];
    for (let v = 0; v < 4; v++) {
      seeds.set(s, (i * 4 + v) * 4);
      corners.set(C[v], (i * 4 + v) * 2);
    }
    const o = i * 4;
    idx.set([o, o + 2, o + 1, o + 1, o + 2, o + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  g.setAttribute("aCorner", new THREE.BufferAttribute(corners, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

const vert = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aCorner;
uniform float uTime;
uniform float uSpeed;
uniform float uWind;
uniform float uFrac;
uniform float uNear;
uniform float uFar;
uniform float uYaw;
uniform vec3 uCam;
varying float vA;
varying vec2 vC;
void main() {
  float depth = mix(uNear, uFar, aSeed.z);
  float H = 7.0 + depth * 0.7;
  float sp = uSpeed * (0.85 + aSeed.w * 0.3);
  float y = mod(aSeed.y * H - uTime * sp, H) - H * 0.45;
  float x = (aSeed.x - 0.5) * 2.0 * depth * 1.8 + uWind * y * 0.3;
  vec3 vel = normalize(vec3(uWind * 0.3, -1.0, 0.0));
  float len = sp * (0.02 + 0.01 * aSeed.w) * (0.6 + 0.4 * smoothstep(1.0, 20.0, depth));
  vec3 p = vec3(x, y, -depth) + vel * len * aCorner.y;
  vec3 side = normalize(cross(vel, vec3(0.0, 0.0, 1.0)));
  p += side * aCorner.x * (0.0022 + depth * 0.0016);
  float c = cos(uYaw);
  float s = sin(uYaw);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) + uCam;
  float pick = fract(aSeed.x * 91.7 + aSeed.z * 17.3 + aSeed.y * 3.1);
  vA = pick < uFrac ? 1.0 : 0.0;
  vC = aCorner;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying vec2 vC;
void main() {
  if (vA < 0.5) discard;
  float a = (1.0 - abs(vC.x)) * sin(vC.y * 3.14159) * uOpacity;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

export function Rain({ comp, preset }: { comp: EffectComponent; preset: EnvironmentPreset }) {
  const { getRt, frame } = useStage();
  const layers = useMemo(
    () =>
      LAYERS.map((l, i) => {
        const geo = cached(`rain:${i}`, () => dropGeometry(l.count, 100 + i));
        const mat = new THREE.ShaderMaterial({
          vertexShader: vert,
          fragmentShader: frag,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          uniforms: {
            uTime: { value: 0 },
            uSpeed: { value: 16 },
            uWind: { value: 0 },
            uFrac: { value: 0 },
            uNear: { value: l.near },
            uFar: { value: l.far },
            uYaw: { value: 0 },
            uCam: { value: new THREE.Vector3() },
            uColor: { value: new THREE.Color() },
            uOpacity: { value: 0 },
          },
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 20 - i;
        return { mesh, mat, alpha: l.alpha };
      }),
    [],
  );
  const dir = useMemo(() => new THREE.Vector3(), []);
  const { splash, splashMat } = useMemo(() => {
    const geo = cached(`splash:${preset}`, () => splashGeometry(preset));
    const splashMat = new THREE.ShaderMaterial({
      vertexShader: splashVert,
      fragmentShader: splashFrag,
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uFrac: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color() }, uScale: { value: 1 } },
    });
    const splash = new THREE.Points(geo, splashMat);
    splash.frustumCulled = false;
    return { splash, splashMat };
  }, [preset]);

  useFrame(({ camera }) => {
    const rt = getRt();
    const e = rt?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("rain", e.active, e.changedAt, p, frame.t) : 0;
    camera.getWorldDirection(dir);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const intensity = num(p, "intensity", 0.7);
    const wind = num(p, "wind", 0.25) + (frame.windDir * 2 - 1) * frame.windNow * 0.4;
    // Rain catches light: brighter against dark skies, flashes with lightning.
    const lum = 0.6 + 0.4 * frame.ambient + frame.flash * 1.5;
    for (const l of layers) {
      const u = l.mat.uniforms;
      l.mesh.visible = lvl > 0.001;
      u.uTime.value = frame.ts;
      u.uSpeed.value = num(p, "speed", 16);
      u.uWind.value = wind;
      u.uFrac.value = intensity * Math.min(1, lvl * 1.5);
      u.uYaw.value = yaw;
      u.uCam.value.copy(camera.position);
      u.uColor.value.setRGB(0.62 * lum, 0.66 * lum, 0.74 * lum);
      u.uOpacity.value = num(p, "opacity", 0.75) * lvl * l.alpha;
    }
    splash.visible = preset !== "none" && bool(p, "splashes", true) && lvl > 0.01;
    const su = splashMat.uniforms;
    su.uTime.value = frame.ts;
    su.uFrac.value = intensity * lvl;
    su.uOpacity.value = num(p, "opacity", 0.75) * lvl * 0.7;
    su.uColor.value.setRGB(0.7 * lum, 0.74 * lum, 0.8 * lum);
  });


  return (
    <>
      {layers.map((l, i) => (
        <primitive key={i} object={l.mesh} />
      ))}
      <primitive object={splash} />
    </>
  );
}

function splashGeometry(preset: EnvironmentPreset) {
  const r = rng(77);
  const n = 2500;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = (r() - 0.5) * 40;
    const z = 6 - Math.pow(r(), 1.5) * 45;
    pos.set([x, terrainHeight(preset, x, z) + 0.03, z], i * 3);
    seed.set([r(), r()], i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 2));
  return g;
}

const splashVert = /* glsl */ `
attribute vec2 aSeed;
uniform float uTime;
uniform float uFrac;
varying float vLife;
varying float vOn;
void main() {
  float period = 0.35 + aSeed.x * 0.5;
  float life = fract(uTime / period + aSeed.y);
  vLife = life;
  vOn = aSeed.x < uFrac ? 1.0 : 0.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = (6.0 + life * 26.0) * (30.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const splashFrag = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
varying float vLife;
varying float vOn;
void main() {
  if (vOn < 0.5) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y *= 2.6; // ellipse: rings lie flat on the ground
  float r = length(p);
  float ring = smoothstep(0.75, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
  float a = ring * (1.0 - vLife) * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;
