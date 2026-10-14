import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clamp, smoothstep } from "@/core/clock";
import { fbm, rng } from "@/core/noise";
import { terrainHeight } from "@/core/terrain";
import type { EnvironmentPreset, ProceduralComponent } from "@/core/types";
import { cached } from "../cache";
import { NOISE_GLSL } from "../glsl";
import { useStage } from "../frame";
import { useLayerPresence } from "../layers/presence";

interface Props {
  comp: ProceduralComponent;
  preset: EnvironmentPreset;
}

export function ProceduralElement({ comp, preset }: Props) {
  switch (comp.element) {
    case "birds":
      return <Birds comp={comp} />;
    case "sheep":
      return <Sheep comp={comp} preset={preset} />;
    case "campfire":
      return <Campfire comp={comp} preset={preset} />;
    case "town-lights":
      return <TownLights comp={comp} preset={preset} />;
  }
}

// ---------------------------------------------------------------- birds

const birdVert = /* glsl */ `
attribute float aWing;
uniform float uTime;
uniform float uScale;
varying float vFade;
void main() {
  float phase = float(gl_InstanceID) * 1.731;
  float flap = sin(uTime * (7.0 + mod(phase, 3.0)) + phase * 4.0);
  float glide = smoothstep(0.2, 0.8, sin(uTime * 0.35 + phase) * 0.5 + 0.5);
  vec3 p = position * uScale;
  p.y += abs(aWing) * flap * 0.45 * uScale * (1.0 - glide * 0.85);
  p.y -= abs(aWing) * 0.1 * uScale * glide;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;
const birdFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}
`;

function Birds({ comp }: { comp: ProceduralComponent }) {
  const { frame } = useStage();
  const presence = useLayerPresence(comp.id, comp.fade);
  const { mesh, mat, seeds } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    // body + two wings (wing tips carry aWing = ±1 for flapping)
    const pos = [0, 0, 0.5, -1.4, 0, -0.1, 0, 0, -0.3, 0, 0, 0.5, 0, 0, -0.3, 1.4, 0, -0.1];
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aWing", new THREE.Float32BufferAttribute([0, -1, 0, 0, 0, 1], 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: birdVert,
      fragmentShader: birdFrag,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: { uTime: { value: 0 }, uScale: { value: 0.55 }, uColor: { value: new THREE.Color("#1b1a1d") }, uOpacity: { value: 1 } },
    });
    const mesh = new THREE.InstancedMesh(g, mat, Math.max(1, comp.count));
    mesh.frustumCulled = false;
    const r = rng(comp.count * 13 + 7);
    const seeds = Array.from({ length: comp.count }, () => ({
      rad: comp.radius * (0.4 + r() * 0.6),
      h: 25 + r() * 45,
      speed: (6 + r() * 5) * (r() < 0.5 ? 1 : -1),
      ph: r() * Math.PI * 2,
      wob: r() * 10,
    }));
    return { mesh, mat, seeds };
  }, [comp.count, comp.radius]);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const s = useMemo(() => new THREE.Vector3(1, 1, 1), []);

  useFrame(() => {
    const t = frame.ts;
    const vis = presence() * (1 - smoothstep(0.6, 0.9, frame.tod)) * (1 - frame.storm * 0.7);
    mesh.visible = vis > 0.01;
    mat.uniforms.uTime.value = t;
    mat.uniforms.uOpacity.value = vis;
    mat.uniforms.uColor.value.set("#1b1a1d").lerp(frame.horizon, 0.35);
    const [cx, cz] = comp.center;
    seeds.forEach((b, i) => {
      const a = b.ph + (t * b.speed) / b.rad;
      const x = cx + Math.cos(a) * b.rad + Math.sin(t * 0.13 + b.wob) * 6;
      const z = cz + Math.sin(a) * b.rad * 0.6;
      const y = b.h + Math.sin(t * 0.4 + b.wob) * 3;
      const yaw = Math.atan2(-Math.sin(a) * Math.sign(b.speed), Math.cos(a) * 0.6 * Math.sign(b.speed));
      e.set(0, yaw, Math.sin(t * 0.5 + b.wob) * 0.25);
      q.setFromEuler(e);
      m4.compose(v.set(x, y, z), q, s);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- sheep

function sheepGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, hex: string, vary = 0.1) => {
    const g2 = g.index ? g.toNonIndexed() : g;
    g2.deleteAttribute("uv");
    const c = new THREE.Color(hex);
    const n = g2.attributes.position.count;
    const arr = new Float32Array(n * 3);
    const r = rng(n);
    for (let i = 0; i < n; i++) {
      const k = 1 - vary / 2 + r() * vary;
      arr.set([c.r * k, c.g * k, c.b * k], i * 3);
    }
    g2.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    return g2;
  };
  const body = new THREE.IcosahedronGeometry(0.5, 2);
  const p = body.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = 0.9 + fbm(p.getX(i) * 6, p.getY(i) * 6 + p.getZ(i) * 4, 3) * 0.25;
    p.setXYZ(i, p.getX(i) * k * 0.95, p.getY(i) * k * 0.78, p.getZ(i) * k * 1.45);
  }
  body.translate(0, 0.68, 0);
  parts.push(paint(body, "#e4dccb", 0.18));
  const head = new THREE.SphereGeometry(0.16, 10, 8);
  head.scale(0.8, 0.9, 1.35);
  head.translate(0, 0.72, 0.78);
  parts.push(paint(head, "#2b2420"));
  for (const [x, z] of [
    [-0.2, 0.42],
    [0.2, 0.42],
    [-0.2, -0.42],
    [0.2, -0.42],
  ]) {
    const leg = new THREE.CylinderGeometry(0.045, 0.04, 0.5, 6);
    leg.translate(x, 0.25, z);
    parts.push(paint(leg, "#2b2420"));
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

function Sheep({ comp, preset }: Props) {
  const { frame } = useStage();
  const presence = useLayerPresence(comp.id, comp.fade);
  const { mesh, flock } = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, transparent: false });
    const mesh = new THREE.InstancedMesh(cached("sheep-geo", sheepGeometry), mat, Math.max(1, comp.count));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const r = rng(comp.count * 31 + 3);
    const flock = Array.from({ length: comp.count }, () => {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * comp.radius;
      return { x: comp.center[0] + Math.cos(a) * d, z: comp.center[1] + Math.sin(a) * d * 0.7, ph: r() * 100, s: 0.85 + r() * 0.3, yaw: r() * Math.PI * 2 };
    });
    return { mesh, flock };
  }, [comp.count, comp.radius, comp.center]);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const sc = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const t = frame.ts;
    const vis = presence();
    mesh.visible = vis > 0.02;
    flock.forEach((sh, i) => {
      // Slow grazing drift: amble, pause, nibble.
      const wander = t * 0.035 + sh.ph;
      const dx = Math.sin(wander) * 1.6 + Math.sin(wander * 0.37) * 1.1;
      const dz = Math.cos(wander * 0.8) * 1.2;
      const x = sh.x + dx;
      const z = sh.z + dz;
      const vx = Math.cos(wander) * 1.6;
      const vz = -Math.sin(wander * 0.8) * 0.96;
      const yaw = Math.atan2(vx, vz);
      const nib = Math.max(0, Math.sin(t * 0.9 + sh.ph * 3)) * 0.18;
      e.set(nib * 0.5, yaw, 0);
      q.setFromEuler(e);
      const k = sh.s * clamp(vis, 0.001, 1);
      m4.compose(v.set(x, terrainHeight(preset, x, z), z), q, sc.set(k, k, k));
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- campfire

const flameVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // camera-facing billboard
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mv.xy += position.xy * scale;
  gl_Position = projectionMatrix * mv;
}
`;
const flameFrag = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  float n = fbm4(vec2(uv.x * 3.0, uv.y * 2.0 - uTime * 2.4));
  float shape = smoothstep(0.5, 0.0, abs(uv.x - 0.5 + (n - 0.5) * 0.35 * uv.y)) * (1.0 - uv.y);
  float f = smoothstep(0.15, 0.6, shape * (0.7 + n * 0.8));
  vec3 col = mix(vec3(1.0, 0.25, 0.02), vec3(1.0, 0.85, 0.45), f);
  gl_FragColor = vec4(col * f * 2.2 * uIntensity, f * uIntensity);
  #include <colorspace_fragment>
}
`;

function Campfire({ comp, preset }: Props) {
  const { frame } = useStage();
  const presence = useLayerPresence(comp.id, comp.fade);
  const [cx, cz] = comp.center;
  const y = terrainHeight(preset, cx, cz);
  const { light, flameMat, glowMat, logs } = useMemo(() => {
    const light = new THREE.PointLight("#ff8a3a", 0, 26, 1.6);
    light.position.set(cx, y + 1.1, cz);
    const flameMat = new THREE.ShaderMaterial({
      vertexShader: flameVert,
      fragmentShader: flameFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 } },
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: "#ff7a2a", transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
    const logGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.9, 6);
    const logMat = new THREE.MeshStandardMaterial({ color: "#2a1c12", roughness: 1, emissive: "#ff4a10", emissiveIntensity: 0.2 });
    const logs = [0, 1, 2, 3].map((i) => {
      const m = new THREE.Mesh(logGeo, logMat);
      m.position.set(cx, y + 0.1, cz);
      m.rotation.set(Math.PI / 2 - 0.35, (i / 4) * Math.PI * 2, 0, "YXZ");
      return m;
    });
    return { light, flameMat, glowMat, logs };
  }, [cx, cz, y]);

  useFrame(() => {
    const t = frame.ts;
    const vis = presence();
    const flick = 0.75 + 0.15 * Math.sin(t * 13.1) + 0.1 * Math.sin(t * 23.7 + 1.3) + 0.08 * Math.sin(t * 5.3);
    // The fire is always lit; it simply reads much brighter as the light falls.
    const night = 0.35 + 0.65 * smoothstep(0.35, 0.9, frame.tod);
    light.intensity = 9 * flick * night * vis;
    flameMat.uniforms.uTime.value = t;
    flameMat.uniforms.uIntensity.value = vis * (0.6 + 0.4 * night);
    glowMat.opacity = 0.25 * night * vis * flick;
  });

  return (
    <group>
      <primitive object={light} />
      {logs.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
      <mesh position={[cx, y + 0.55, cz]} scale={[0.9, 1.25, 1]} material={flameMat} renderOrder={5}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh position={[cx, y + 0.02, cz]} rotation={[-Math.PI / 2, 0, 0]} material={glowMat}>
        <circleGeometry args={[2.4, 24]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- town lights

function TownLights({ comp, preset }: Props) {
  const { frame } = useStage();
  const presence = useLayerPresence(comp.id, comp.fade);
  const { points, mat } = useMemo(() => {
    const r = rng(comp.count * 7 + 1);
    const pos: number[] = [];
    for (let i = 0; i < comp.count; i++) {
      const x = comp.center[0] + (r() - 0.5) * comp.radius * 2;
      const z = comp.center[1] + (r() - 0.5) * comp.radius;
      pos.push(x, terrainHeight(preset, x, z) + 2 + r() * 4, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: "#ffb35c", size: 3, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const points = new THREE.Points(g, mat);
    return { points, mat };
  }, [comp.count, comp.center, comp.radius, preset]);
  useFrame(() => {
    mat.opacity = presence() * smoothstep(0.45, 0.85, frame.tod) * (0.85 + 0.15 * Math.sin(frame.ts * 3));
  });
  return <primitive object={points} />;
}
