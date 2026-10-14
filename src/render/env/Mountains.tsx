import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { fbm, ridged } from "@/core/noise";
import { ENV_LOOKS } from "@/core/terrain";

import { cached } from "../cache";
import { useStage } from "../frame";
import { debugHidden } from "../debug";

type Preset = "lion-hills" | "shepherd-valley";

/** A curved ridge band around the stage; several stacked give aerial perspective. */
function ridgeGeometry(dist: number, height: number, rough: number, seed: number) {
  const SEG = 360;
  const ROWS = 6;
  const pos: number[] = [];
  const idx: number[] = [];
  const span = Math.PI * 1.45;
  for (let i = 0; i <= SEG; i++) {
    const a = -span / 2 + (i / SEG) * span;
    const t = a * rough * 3;
    const peak = height * (0.25 + 0.75 * (0.55 * ridged(t + seed, seed * 0.7, 5) + 0.45 * fbm(t * 0.6 + seed, 3, 3)));
    for (let r = 0; r <= ROWS; r++) {
      const k = r / ROWS;
      // Rows climb the slope and move slightly away from camera for depth shading.
      const y = -40 + (peak + 40) * Math.pow(k, 0.85);
      const rad = dist * (1.06 - 0.06 * k);
      pos.push(Math.sin(a) * rad, y, -20 - Math.cos(a) * rad);
    }
  }
  for (let i = 0; i < SEG; i++) {
    for (let r = 0; r < ROWS; r++) {
      const a = i * (ROWS + 1) + r;
      const b = a + ROWS + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const vert = /* glsl */ `
varying vec3 vN;
varying float vH;
varying vec3 vW;
void main() {
  vN = normalize(normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vH = position.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uFog;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSun;
uniform float uAmbient;
uniform float uHaze;
uniform float uTop;
varying vec3 vN;
varying float vH;
varying vec3 vW;
float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
void main() {
  float ndl = max(dot(normalize(vN), uSunDir), 0.0);
  vec3 col = uColor * (uAmbient * 0.75 + uSunColor * uSun * ndl * 0.22);
  // streaky erosion detail
  col *= 0.88 + 0.18 * h21(floor(vW.xz * 0.05));
  float baseHaze = 1.0 - smoothstep(-40.0, uTop * 0.9, vH);
  float k = clamp(uHaze + baseHaze * 0.55, 0.0, 1.0);
  gl_FragColor = vec4(mix(col, uFog, k), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function Mountains({ preset }: { preset: Preset }) {
  const { frame } = useStage();
  const layers = ENV_LOOKS[preset].mountains;
  const meshes = useMemo(
    () =>
      layers.map((l, i) => {
        const geo = cached(`ridge:${preset}:${i}`, () => ridgeGeometry(l.dist, l.height, l.rough, l.seed));
        const mat = new THREE.ShaderMaterial({
          vertexShader: vert,
          fragmentShader: frag,
          fog: false,
          uniforms: {
            uColor: { value: new THREE.Color(l.color) },
            uFog: { value: new THREE.Color() },
            uSunDir: { value: new THREE.Vector3() },
            uSunColor: { value: new THREE.Color() },
            uSun: { value: 1 },
            uAmbient: { value: 1 },
            uHaze: { value: 0.3 },
            uTop: { value: l.height },
          },
        });
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = -5 + i * -1;
        m.frustumCulled = false;
        return { m, mat, depth: i / Math.max(1, layers.length - 1) };
      }),
    [layers, preset],
  );

  useFrame(() => {
    for (const { m, mat, depth } of meshes) {
      m.visible = !debugHidden.has("mountains");
      const u = mat.uniforms;
      u.uFog.value.copy(frame.fogColor);
      u.uSunDir.value.copy(frame.keyDir);
      u.uSunColor.value.copy(frame.keyColor);
      u.uSun.value = frame.keyIntensity;
      u.uAmbient.value = frame.ambient;
      u.uHaze.value = Math.min(0.95, 0.18 + depth * 0.42 + frame.hazeLevel * 0.35 + frame.storm * 0.3 + frame.fogLevel * 0.3);
    }
  });

  return (
    <>
      {meshes.map(({ m }, i) => (
        <primitive key={i} object={m} />
      ))}
    </>
  );
}
