// Atmospheric overlays drawn in the FX (ortho) layer: starfield, divine light, heat
// shimmer and window/torch lights. All deterministic in scene time.
import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp } from "@/core/clock";
import { num, str } from "@/core/effects";
import { rng } from "@/core/noise";
import { effectLevel } from "@/core/runtime";
import type { EffectComponent } from "@/core/types";
import { NOISE_GLSL, QUAD_VERT } from "../glsl";
import { useStage } from "../frame";

function useQuad(frag: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}) {
  const { canvasW, canvasH } = useStage();
  const { mesh, mat } = useMemo(() => {
    const mat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: frag, transparent: true, depthTest: false, depthWrite: false, uniforms, ...opts });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    return { mesh, mat };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  mesh.scale.set(canvasW, canvasH, 1);
  return { mesh, mat };
}

// ---------------------------------------------------------------- stars

const starsFrag = /* glsl */ `
uniform float uTime;
uniform float uDensity;
uniform float uBright;
uniform float uTwinkle;
uniform float uHorizon;   // fraction from the top where stars fade out
uniform float uRotate;    // turn rate (dream)
uniform float uStretch;   // radial streaks (dream)
uniform float uDrift;
uniform float uAspect;
uniform float uLevel;
uniform vec3 uTint;
varying vec2 vUv;
${NOISE_GLSL}
float starField(vec2 p, float cell, float thresh, float t) {
  vec2 g = p * cell;
  vec2 i = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash12(i);
  if (h < thresh) return 0.0;
  vec2 o = vec2(hash12(i + 1.7), hash12(i + 3.1)) - 0.5;
  float d = length(f - o * 0.6);
  // size is in cell units: with ~220 cells across the wall height a star is 1–3 px, never sub-pixel
  float size = 0.18 + 0.34 * hash12(i + 5.3);
  float s = smoothstep(size, size * 0.15, d) + smoothstep(size * 2.2, 0.0, d) * 0.25;
  float tw = 1.0 - uTwinkle * 0.5 * (0.5 + 0.5 * sin(t * (1.0 + 5.0 * hash12(i + 9.1)) + h * 60.0));
  return s * tw * (0.35 + 0.65 * hash12(i + 2.2));
}
void main() {
  vec2 c = vec2(0.5, 1.0 - uHorizon);
  vec2 q = (vUv - c) * vec2(uAspect, 1.0);
  float ang = uRotate * uTime * 0.12;
  float acc = 0.0;
  int taps = uStretch > 0.001 ? 7 : 1;
  for (int k = 0; k < 7; k++) {
    if (k >= taps) break;
    float a = ang + (float(k) - 3.0) * uStretch * 0.025;
    float ca = cos(a), sa = sin(a);
    vec2 r = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y) + vec2(uTime * uDrift * 0.02, 0.0);
    float thresh = mix(0.995, 0.955, uDensity);
    float s = starField(r, 220.0, thresh, uTime) * 0.9 + starField(r + 7.3, 110.0, thresh + 0.008, uTime) * 0.8 + starField(r * 0.5 + 3.0, 48.0, 0.99, uTime) * 1.5;
    acc += s;
  }
  acc /= float(taps);
  float sky = smoothstep(1.0 - uHorizon - 0.12, 1.0 - uHorizon + 0.1, vUv.y);
  vec3 col = uTint * acc * uBright * sky * uLevel;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export function StarsOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const { mesh, mat } = useQuad(
    starsFrag,
    {
      uTime: { value: 0 },
      uDensity: { value: 0.6 },
      uBright: { value: 1 },
      uTwinkle: { value: 0.5 },
      uHorizon: { value: 0.55 },
      uRotate: { value: 0 },
      uStretch: { value: 0 },
      uDrift: { value: 0 },
      uAspect: { value: 1 },
      uLevel: { value: 0 },
      uTint: { value: new THREE.Color() },
    },
    { blending: THREE.AdditiveBlending },
  );
  useFrame(() => {
    const e = getRt()?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("stars", e.active, e.changedAt, p, frame.t) : 0;
    mesh.visible = lvl > 0.001;
    const u = mat.uniforms;
    u.uTime.value = frame.ts;
    u.uDensity.value = num(p, "density", 0.6);
    u.uBright.value = num(p, "brightness", 0.9) * (1 - frame.flash * 0.5);
    u.uTwinkle.value = num(p, "twinkle", 0.5);
    u.uHorizon.value = num(p, "horizon", 0.55);
    u.uRotate.value = num(p, "rotate", 0);
    u.uStretch.value = num(p, "stretch", 0);
    u.uDrift.value = num(p, "drift", 0.02);
    u.uAspect.value = canvasW / canvasH;
    u.uLevel.value = lvl;
    u.uTint.value.set(str(p, "tint", "#dfe6ff"));
  });
  mesh.renderOrder = 4;
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- divine light

const glowFrag = /* glsl */ `
uniform float uTime;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uIntensity;
uniform float uRays;
uniform float uRaySpeed;
uniform float uPulse;
uniform float uAspect;
uniform vec3 uColor;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
  float r = length(d) / max(uRadius, 0.001);
  float core = exp(-r * r * 2.2);
  float halo = exp(-r * 0.9) * 0.35;
  float ang = atan(d.y, d.x);
  float t = uTime * uRaySpeed;
  float rays = 0.0;
  if (uRays > 0.001) {
    float a1 = sin(ang * 9.0 + t * 1.3) * 0.5 + 0.5;
    float a2 = sin(ang * 23.0 - t * 2.1 + 1.0) * 0.5 + 0.5;
    float a3 = fbm4(vec2(ang * 3.0, t * 0.4));
    rays = pow(a1 * 0.6 + a2 * 0.4, 2.0) * (0.5 + a3) * exp(-r * 1.1) * smoothstep(0.0, 0.25, r);
  }
  float pulse = 1.0 + uPulse * 0.25 * sin(uTime * 1.1) ;
  float v = (core + halo + rays * uRays * 0.7) * uIntensity * pulse;
  vec3 col = uColor * v;
  // whiten the hottest core
  col = mix(col, vec3(1.0) * v, smoothstep(0.6, 1.4, v) * 0.6);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export function GlowOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const { mesh, mat } = useQuad(
    glowFrag,
    {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uRadius: { value: 0.4 },
      uIntensity: { value: 0 },
      uRays: { value: 0.5 },
      uRaySpeed: { value: 0.2 },
      uPulse: { value: 0.1 },
      uAspect: { value: 1 },
      uColor: { value: new THREE.Color() },
    },
    { blending: THREE.AdditiveBlending },
  );
  useFrame(() => {
    const e = getRt()?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("glow", e.active, e.changedAt, p, frame.t) : 0;
    mesh.visible = lvl > 0.001;
    const u = mat.uniforms;
    u.uTime.value = frame.ts;
    u.uCenter.value.set(num(p, "x", 0.5), 1 - num(p, "y", 0.35));
    u.uRadius.value = num(p, "radius", 0.45);
    u.uIntensity.value = num(p, "intensity", 0.9) * lvl * lvl;
    u.uRays.value = num(p, "rays", 0.6);
    u.uRaySpeed.value = num(p, "raySpeed", 0.15);
    u.uPulse.value = num(p, "pulse", 0.15);
    u.uAspect.value = canvasW / canvasH;
    u.uColor.value.set(str(p, "color", "#ffe9b8"));
  });
  mesh.renderOrder = 12;
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- heat shimmer

const heatFrag = /* glsl */ `
uniform float uTime;
uniform float uAmount;
uniform float uHeight;
uniform float uSpeed;
uniform float uAspect;
uniform vec3 uTint;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float band = 1.0 - smoothstep(uHeight * 0.3, uHeight, vUv.y);
  if (band <= 0.001) discard;
  vec2 p = vec2(vUv.x * uAspect * 14.0, vUv.y * 40.0 - uTime * uSpeed * 3.0);
  float n = fbm4(p) - 0.5;
  float n2 = vnoise(p * 2.7 + uTime * uSpeed) - 0.5;
  float v = (n * 0.7 + n2 * 0.3) * uAmount * band;
  // rising bright and dark ripples: brightening uses the warm tint, darkening uses black
  vec3 col = v > 0.0 ? uTint : vec3(0.0);
  gl_FragColor = vec4(col, abs(v) * 0.55);
  #include <colorspace_fragment>
}
`;

export function HeatOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const { mesh, mat } = useQuad(heatFrag, { uTime: { value: 0 }, uAmount: { value: 0 }, uHeight: { value: 0.5 }, uSpeed: { value: 1 }, uAspect: { value: 1 }, uTint: { value: new THREE.Color() } });
  useFrame(() => {
    const e = getRt()?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("heat", e.active, e.changedAt, p, frame.t) : 0;
    mesh.visible = lvl > 0.001;
    const u = mat.uniforms;
    u.uTime.value = frame.ts;
    u.uAmount.value = num(p, "amount", 0.6) * lvl;
    u.uHeight.value = num(p, "height", 0.5);
    u.uSpeed.value = num(p, "speed", 1);
    u.uAspect.value = canvasW / canvasH;
    u.uTint.value.set(str(p, "tint", "#ffd9a0")).multiplyScalar(0.5 + frame.ambient * 0.5);
  });
  mesh.renderOrder = 9;
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- window / torch lights

const lightsVert = /* glsl */ `
attribute vec3 aSeed;   // order 0..1, size jitter, phase
uniform float uLevel;   // spread progress 0..1
uniform float uFadeFrac;
uniform float uTime;
uniform float uFlicker;
uniform float uSize;
uniform float uPx;      // canvas height in px
varying float vOn;
varying float vWarm;
void main() {
  float on = smoothstep(aSeed.x, aSeed.x + max(uFadeFrac, 0.002), uLevel);
  float fl = 1.0 - uFlicker * (0.35 * (0.5 + 0.5 * sin(uTime * (9.0 + aSeed.z * 7.0) + aSeed.z * 50.0)) + 0.25 * (0.5 + 0.5 * sin(uTime * 23.0 + aSeed.y * 40.0)));
  vOn = on * fl;
  vWarm = aSeed.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPx * 0.014 * uSize * (0.7 + 0.6 * aSeed.y) * (0.6 + 0.4 * on);
  gl_Position = projectionMatrix * mv;
}
`;
const lightsFrag = /* glsl */ `
uniform vec3 uColor;
varying float vOn;
varying float vWarm;
void main() {
  if (vOn < 0.01) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  float core = smoothstep(0.35, 0.0, r);
  float halo = exp(-r * 2.5) * 0.6;
  vec3 col = mix(uColor, vec3(1.0, 0.95, 0.85), core * 0.6 * vWarm);
  gl_FragColor = vec4(col * (core + halo) * vOn, 1.0);
  #include <colorspace_fragment>
}
`;

export function LightsOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const count = Math.max(1, Math.min(400, Math.round(num(comp.params, "count", 60))));
  const seed = Math.round(num(comp.params, "seed", 7));
  const order = Math.round(num(comp.params, "order", 0));
  const { points, mat, geo } = useMemo(() => {
    const r = rng(seed * 101 + count);
    const pos = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    const raw = Array.from({ length: count }, () => ({ u: r(), v: r(), s: r(), ph: r(), o: r() }));
    // Order: random, left→right, or from the centre outward.
    for (const p of raw) p.o = order === 1 ? p.u * 0.9 + p.o * 0.1 : order === 2 ? Math.abs(p.u - 0.5) * 1.8 + p.o * 0.1 : p.o;
    raw.forEach((p, i) => {
      pos.set([p.u, p.v, 0], i * 3);
      seeds.set([Math.min(0.999, p.o), p.s, p.ph], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: lightsVert,
      fragmentShader: lightsFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uLevel: { value: 0 }, uFadeFrac: { value: 0.1 }, uTime: { value: 0 }, uFlicker: { value: 0.5 }, uSize: { value: 1 }, uPx: { value: 1080 }, uColor: { value: new THREE.Color() } },
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 11;
    return { points, mat, geo };
  }, [count, seed, order]);
  useMemo(() => () => geo.dispose(), [geo]);

  useFrame(() => {
    const e = getRt()?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("lights", e.active, e.changedAt, p, frame.t) : 0;
    points.visible = lvl > 0.001;
    const u = mat.uniforms;
    u.uLevel.value = lvl * (1 + num(p, "fade", 1.5) / Math.max(0.5, num(p, "spread", 12)));
    u.uFadeFrac.value = num(p, "fade", 1.5) / Math.max(0.5, num(p, "spread", 12));
    u.uTime.value = frame.ts;
    u.uFlicker.value = num(p, "flicker", 0.5);
    u.uSize.value = num(p, "size", 1);
    u.uPx.value = canvasH;
    u.uColor.value.set(str(p, "color", "#ffb55c"));
    // Positions are 0..1 in the area box; map to canvas px.
    const w = num(p, "w", 0.9) * canvasW;
    const h = num(p, "h", 0.3) * canvasH;
    points.scale.set(w, -h, 1);
    points.position.set((num(p, "x", 0.5) - 0.5) * canvasW - w / 2, (0.5 - num(p, "y", 0.55)) * canvasH + h / 2, 0);
  });
  return <primitive object={points} />;
}

export { clamp };
