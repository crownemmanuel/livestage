import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { rng, valueNoise } from "@/core/noise";
import { ENV_LOOKS, terrainHeight } from "@/core/terrain";

import { cached } from "../cache";
import { useStage } from "../frame";

type Preset = "lion-hills" | "shepherd-valley" | "shepherd-pbr";

/** One merged mesh of grass blades; wind sway happens entirely in the vertex shader. */
function buildGrass(preset: Preset) {
  const look = ENV_LOOKS[preset].grass;
  const r = rng(preset === "lion-hills" ? 1234 : preset === "shepherd-pbr" ? 2468 : 4321);
  const [x0, x1, z0, z1] = look.area;
  const blades: number[][] = [];
  for (let tries = 0; tries < look.count * 4 && blades.length < look.count; tries++) {
    // Denser near the stage, thinning with distance; clumped by noise.
    const x = x0 + r() * (x1 - x0);
    const z = z1 - Math.pow(r(), 1.6) * (z1 - z0);
    const clump = valueNoise(x * 0.18 + 3, z * 0.18);
    if (r() > clump * 1.35) continue;
    const h = look.height[0] + r() * (look.height[1] - look.height[0]) * (0.6 + clump * 0.6);
    blades.push([x, terrainHeight(preset, x, z), z, h, r() * Math.PI * 2, r(), 0.01 + r() * 0.018]);
  }
  const n = blades.length;
  const VPB = 5; // verts per blade
  const base = new Float32Array(n * VPB * 3);
  const params = new Float32Array(n * VPB * 4); // height, angle, rand, width
  const vert = new Float32Array(n * VPB * 2); // local x (-1..1), y (0..1)
  const idx = new Uint32Array(n * 9);
  const shape: [number, number][] = [
    [-1, 0],
    [1, 0],
    [-0.65, 0.5],
    [0.65, 0.5],
    [0, 1],
  ];
  blades.forEach((b, i) => {
    for (let v = 0; v < VPB; v++) {
      const o = i * VPB + v;
      base.set([b[0], b[1], b[2]], o * 3);
      params.set([b[3], b[4], b[5], b[6]], o * 4);
      vert.set(shape[v], o * 2);
    }
    const o = i * VPB;
    idx.set([o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4], i * 9);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(base, 3));
  g.setAttribute("aParams", new THREE.BufferAttribute(params, 4));
  g.setAttribute("aVert", new THREE.BufferAttribute(vert, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0));
  return g;
}

const vert = /* glsl */ `
attribute vec4 aParams;
attribute vec2 aVert;
uniform float uTime;
uniform float uWind;
uniform float uWindDir;
varying float vY;
varying float vRand;
varying vec3 vNormalW;
#include <common>
#include <fog_pars_vertex>
void main() {
  float h = aParams.x;
  float ang = aParams.y;
  float rnd = aParams.z;
  float w = aParams.w;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec3 p = position;
  float y = aVert.y;
  vec3 local = vec3(dir.x * aVert.x * w * (1.0 - y * 0.85), y * h, dir.y * aVert.x * w * (1.0 - y * 0.85));
  // Natural lean plus wind: travelling gust waves across the field.
  float wave = sin(uTime * 1.7 + position.x * 0.35 + position.z * 0.22 + rnd * 6.28);
  float gust = sin(uTime * 0.6 + position.x * 0.05 - position.z * 0.03) * 0.5 + 0.5;
  float bend = (0.12 + rnd * 0.2) + uWind * (0.35 + 0.65 * gust) * (0.8 + 0.4 * wave);
  float b = bend * y * y;
  local.x += uWindDir * b * h;
  local.z += (1.0 - abs(uWindDir)) * b * h * 0.4;
  local.y -= b * b * h * 0.25;
  p += local;
  vY = y;
  vRand = rnd;
  vNormalW = normalize(vec3(-dir.y, 0.6, dir.x));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uTip;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSun;
uniform vec3 uHemi;
uniform float uHemiI;
varying float vY;
varying float vRand;
varying vec3 vNormalW;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec3 col = mix(uBase, uTip, vY) * (0.75 + vRand * 0.5);
  float ndl = abs(dot(normalize(vNormalW), uSunDir));
  vec3 light = uHemi * uHemiI * (0.45 + 0.55 * vY) + uSunColor * uSun * (0.25 + 0.5 * ndl) * (0.4 + 0.6 * vY) * 0.32;
  // translucency when backlit
  light += uSunColor * uSun * pow(max(-uSunDir.z, 0.0), 2.0) * vY * 0.12;
  gl_FragColor = vec4(col * light, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function Grass({ preset }: { preset: Preset }) {
  const { frame } = useStage();
  const geo = cached(`grass:${preset}`, () => buildGrass(preset));
  const mat = useMemo(() => {
    const look = ENV_LOOKS[preset].grass;
    return new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.DoubleSide,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uWind: { value: 0.2 },
          uWindDir: { value: 0.6 },
          uBase: { value: new THREE.Color(look.base) },
          uTip: { value: new THREE.Color(look.tip) },
          uSunDir: { value: new THREE.Vector3() },
          uSunColor: { value: new THREE.Color() },
          uSun: { value: 1 },
          uHemi: { value: new THREE.Color() },
          uHemiI: { value: 1 },
        },
      ]),
    });
  }, [preset]);

  useFrame(() => {
    const u = mat.uniforms;
    u.uTime.value = frame.ts;
    u.uWind.value = frame.windNow;
    u.uWindDir.value = frame.windDir * 2 - 1;
    u.uSunDir.value.copy(frame.keyDir);
    u.uSunColor.value.copy(frame.keyColor);
    u.uSun.value = frame.sunIntensity + frame.moonIntensity * 0.6;
    u.uHemi.value.copy(frame.hemiSky);
    u.uHemiI.value = frame.hemiIntensity;
  });

  return <mesh geometry={geo} material={mat} frustumCulled={false} dispose={null} />;
}
