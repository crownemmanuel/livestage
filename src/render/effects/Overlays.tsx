import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp } from "@/core/clock";
import { num, str } from "@/core/effects";
import { rng } from "@/core/noise";
import { effectLevel } from "@/core/runtime";
import type { EffectComponent, LightningStrike } from "@/core/types";
import { NOISE_GLSL, QUAD_VERT } from "../glsl";
import { flashCurve, parsedColor, useStage } from "../frame";
import { syncVideo, useVideo } from "../layers/video";

/** Full-canvas quad in the overlay (ortho, logical px) scenes. */
function useQuad(frag: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}) {
  const { canvasW, canvasH } = useStage();
  const { mesh, mat } = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms,
      ...opts,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    return { mesh, mat };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  mesh.scale.set(canvasW, canvasH, 1);
  return { mesh, mat };
}

// ---------------------------------------------------------------- fog (layered, low-lying)

const fogFrag = /* glsl */ `
uniform float uTime;
uniform float uDensity;
uniform float uHeight;
uniform float uSpeed;
uniform float uLevel;
uniform float uAspect;
uniform vec3 uColor;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float a = 0.0;
  // fbm4 < 0.94, so the fog top never passes uHeight + 0.053 and the mask is 0 from
  // uHeight + 0.133 up: most of the wall skips the noise (same picture).
  if (uHeight < 0.0 || vUv.y < uHeight + 0.14) {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    float t = uTime * uSpeed;
    float n1 = fbm4(p * vec2(1.6, 4.5) + vec2(t * 0.05, 0.0));
    float n2 = fbm4(p * vec2(3.4, 8.0) + vec2(-t * 0.09, t * 0.01) + n1 * 0.8);
    float n3 = fbm4(p * vec2(0.7, 2.0) + vec2(t * 0.02, 3.0));
    float n = n1 * 0.45 + n2 * 0.35 + n3 * 0.4;
    float top = uHeight + (n3 - 0.5) * 0.12;
    float mask = 1.0 - smoothstep(top * 0.25, top + 0.08, vUv.y);
    a = clamp(mask * (0.25 + n * 1.05) * uDensity * uLevel, 0.0, 0.96);
  }
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

export function FogOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const { mesh, mat } = useQuad(fogFrag, {
    uTime: { value: 0 },
    uDensity: { value: 0.6 },
    uHeight: { value: 0.3 },
    uSpeed: { value: 0.4 },
    uLevel: { value: 0 },
    uAspect: { value: canvasW / canvasH },
    uColor: { value: new THREE.Color() },
  });
  useFrame(() => {
    const e = getRt()?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("fog", e.active, e.changedAt, p, frame.t) : 0;
    mesh.visible = lvl > 0.001;
    if (!mesh.visible) return;
    const u = mat.uniforms;
    u.uTime.value = frame.ts;
    u.uDensity.value = num(p, "density", 0.6);
    u.uHeight.value = num(p, "height", 0.3);
    // Drift = time x speed, so the speed must not carry the per-frame gust (windNow): that made the
    // layers slosh by an amount growing with scene time. The steady wind strength sets the rate.
    u.uSpeed.value = num(p, "speed", 0.4) * (1 + frame.windStrength);
    u.uLevel.value = lvl;
    u.uAspect.value = canvasW / canvasH;
    u.uColor.value.copy(parsedColor(str(p, "color", "#c9ccd2"))).multiplyScalar(Math.min(1.2, 0.2 + frame.ambient * 0.85 + frame.flash * 0.6));
  });
  mesh.renderOrder = 10;
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- haze

const hazeFrag = /* glsl */ `
uniform float uAmount;
uniform float uHorizon;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float band = exp(-pow((vUv.y - uHorizon) / 0.32, 2.0));
  float a = (0.25 + 0.75 * band) * uAmount;
  gl_FragColor = vec4(uColor, clamp(a, 0.0, 0.85));
  #include <colorspace_fragment>
}
`;

export function HazeOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame } = useStage();
  const { mesh, mat } = useQuad(hazeFrag, { uAmount: { value: 0 }, uHorizon: { value: 0.55 }, uColor: { value: new THREE.Color() } });
  useFrame(() => {
    const e = getRt()?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const lvl = e ? effectLevel("haze", e.active, e.changedAt, p, frame.t) : 0;
    mesh.visible = lvl > 0.001;
    if (!mesh.visible) return;
    mat.uniforms.uAmount.value = lvl * num(p, "density", 0.4) * num(p, "opacity", 0.5) * 0.6;
    mat.uniforms.uColor.value.copy(parsedColor(str(p, "tint", "#d8cdb8"))).multiplyScalar(0.04 + frame.ambient * 0.9).lerp(frame.horizon, 0.3);
  });
  mesh.renderOrder = 5;
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- lightning

const boltFrag = /* glsl */ `
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float e = abs(vUv.x * 2.0 - 1.0);
  float core = smoothstep(0.35, 0.0, e);
  float glow = pow(1.0 - e, 2.5) * 0.55;
  vec3 col = vec3(0.92, 0.95, 1.0) * core + vec3(0.55, 0.62, 1.0) * glow;
  gl_FragColor = vec4(col * uIntensity, 1.0);
  #include <colorspace_fragment>
}
`;

// Bolt geometry is written into a fixed buffer per pool slot: no allocation on the flash frame.
const TRUNK_SEGS = 26;
const BRANCH_SEGS = 10;
const MAX_BRANCHES = 6;
/** Two ribbons each for the trunk and up to six branches, 6 vertices per segment quad. */
const BOLT_MAX_VERTS = (TRUNK_SEGS * 2 + MAX_BRANCHES * BRANCH_SEGS * 2) * 6;
const QUAD_ORDER = [0, 2, 1, 1, 2, 3];
const trunkPts = new Float64Array((TRUNK_SEGS + 1) * 2);
const branchPts = new Float64Array((BRANCH_SEGS + 1) * 2);
const quadX = new Float64Array(4);
const quadY = new Float64Array(4);

function makeBoltGeometry() {
  const g = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(BOLT_MAX_VERTS * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  const uv = new Float32Array(BOLT_MAX_VERTS * 2);
  for (let v = 0; v < BOLT_MAX_VERTS; v++) uv[v * 2] = QUAD_ORDER[v % 6] % 2;
  g.setAttribute("position", pos);
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setDrawRange(0, 0);
  return g;
}

/**
 * Branching bolt as triangle ribbons in logical canvas pixels, written into `g` (from
 * makeBoltGeometry). The shape is a pure function of the strike seed (every window draws the
 * same bolt): same random sequence and arithmetic as the original Vector2 version.
 */
function writeBoltGeometry(g: THREE.BufferGeometry, st: LightningStrike, W: number, H: number) {
  const r = rng(st.seed);
  const posAttr = g.getAttribute("position") as THREE.BufferAttribute;
  const pos = posAttr.array as Float32Array;
  let v = 0;
  const s = H / 1080;
  const ribbon = (pts: Float64Array, count: number, width: number) => {
    for (let i = 0; i < count - 1; i++) {
      const ax = pts[i * 2];
      const ay = pts[i * 2 + 1];
      const bx = pts[i * 2 + 2];
      const by = pts[i * 2 + 3];
      // d = normalize(b - a) (Vector2.normalize divides by the length, or 1 when zero)
      let dx = bx - ax;
      let dy = by - ay;
      const inv = 1 / (Math.sqrt(dx * dx + dy * dy) || 1);
      dx *= inv;
      dy *= inv;
      const w = width * (1 - (i / count) * 0.5);
      const nx = -dy * w;
      const ny = dx * w;
      quadX[0] = ax - nx;
      quadY[0] = ay - ny;
      quadX[1] = ax + nx;
      quadY[1] = ay + ny;
      quadX[2] = bx - nx;
      quadY[2] = by - ny;
      quadX[3] = bx + nx;
      quadY[3] = by + ny;
      for (let q = 0; q < 6; q++) {
        const k = QUAD_ORDER[q];
        pos[v * 3] = quadX[k];
        pos[v * 3 + 1] = quadY[k];
        pos[v * 3 + 2] = 0;
        v++;
      }
    }
  };
  /** Random walk of `segs` steps from (sx, sy) into `out`; returns the point count. */
  const walk = (out: Float64Array, sx: number, sy: number, angle: number, len: number, segs: number) => {
    out[0] = sx;
    out[1] = sy;
    let px = sx;
    let py = sy;
    const step = len / segs;
    for (let i = 0; i < segs; i++) {
      const a = angle + (r() - 0.5) * 1.1;
      px += Math.sin(a) * step;
      py += -Math.cos(a) * step;
      out[(i + 1) * 2] = px;
      out[(i + 1) * 2 + 1] = py;
    }
    return segs + 1;
  };
  const topX = (st.x - 0.5) * W;
  const topY = H / 2 + 10;
  // End around the horizon/hills rather than in the foreground.
  const trunkLen = H * (0.38 + r() * 0.18);
  const trunkN = walk(trunkPts, topX, topY, (r() - 0.5) * 0.4, trunkLen, TRUNK_SEGS);
  ribbon(trunkPts, trunkN, 4.5 * s);
  ribbon(trunkPts, trunkN, 16 * s);
  const branches = 3 + Math.floor(r() * 4);
  for (let b = 0; b < branches; b++) {
    const from = 4 + Math.floor(r() * (trunkN - 10));
    const sign = r() < 0.5 ? -1 : 1;
    const angle = sign * (0.5 + r() * 0.6);
    const n = walk(branchPts, trunkPts[from * 2], trunkPts[from * 2 + 1], angle, trunkLen * (0.15 + r() * 0.25), BRANCH_SEGS);
    ribbon(branchPts, n, 2.2 * s);
    ribbon(branchPts, n, 8 * s);
  }
  posAttr.needsUpdate = true;
  g.setDrawRange(0, v);
}

interface BoltSlot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Strike drawn by this slot, null when free. */
  id: string | null;
  /** Frame stamp of the last frame the strike was live. */
  seen: number;
}

const flashFrag = /* glsl */ `
uniform float uFlash;
varying vec2 vUv;
void main() {
  float a = uFlash * (0.65 + 0.35 * vUv.y);
  gl_FragColor = vec4(vec3(0.72, 0.78, 1.0) * a, 1.0);
  #include <colorspace_fragment>
}
`;

export function LightningOverlay({ comp, flat }: { comp: EffectComponent; flat: boolean }) {
  const { getRt, frame, canvasW, canvasH, assets } = useStage();
  const flash = useQuad(flashFrag, { uFlash: { value: 0 } }, { blending: THREE.AdditiveBlending });
  const group = useMemo(() => new THREE.Group(), []);
  const boltMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: boltFrag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uIntensity: { value: 0 } },
      }),
    [],
  );
  const videoAsset = assets.find((a) => a.id === str(comp.params, "boltVideoAssetId"));
  const video = useVideo(videoAsset?.url ?? null);
  const vidMesh = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthTest: false, toneMapped: false }),
    );
    m.visible = false;
    return m;
  }, []);
  useEffect(() => {
    (vidMesh.material as THREE.MeshBasicMaterial).map = video?.texture ?? null;
    (vidMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }, [video, vidMesh]);

  /*
   * Bolt pool: meshes, materials and geometry buffers are kept until unmount, so a strike never
   * builds or compiles anything on its flash frame. An idle slot stays in the scene drawing
   * nothing (draw range 0), which keeps the bolt shader compiled from the first frame on.
   */
  const pool = useMemo(() => {
    const slots: BoltSlot[] = [];
    const add = () => {
      const mat = boltMat.clone();
      const mesh = new THREE.Mesh(makeBoltGeometry(), mat);
      mesh.frustumCulled = false;
      const slot: BoltSlot = { mesh, mat, id: null, seen: 0 };
      slots.push(slot);
      group.add(mesh);
      return slot;
    };
    return { slots, add };
  }, [group, boltMat]);
  const tick = useRef(0);

  useEffect(() => {
    if (pool.slots.length === 0) pool.add();
    return () => {
      for (const sl of pool.slots) {
        group.remove(sl.mesh);
        sl.mesh.geometry.dispose();
        sl.mat.dispose();
      }
      pool.slots.length = 0;
    };
  }, [pool, group]);

  useFrame(() => {
    const rt = getRt();
    const strikes = rt?.strikes;
    const stamp = ++tick.current;
    let latest: LightningStrike | null = null;
    if (strikes) {
      for (const st of strikes) {
        const dt = (frame.t - st.at) / 1000;
        if (dt < 0 || dt > st.duration * 1.7) continue;
        latest = st;
        if (video) continue;
        let slot: BoltSlot | null = null;
        let free: BoltSlot | null = null;
        for (const sl of pool.slots) {
          if (sl.id === st.id) slot = sl;
          else if (sl.id === null && !free) free = sl;
        }
        if (!slot) {
          slot = free ?? pool.add();
          slot.id = st.id;
          writeBoltGeometry(slot.mesh.geometry, st, canvasW, canvasH);
        }
        slot.seen = stamp;
        slot.mat.uniforms.uIntensity.value = clamp(flashCurve(dt, st.duration) * st.brightness * 1.4, 0, 2);
      }
    }
    // Release the slots whose strike ended (or that are taken by the bolt video).
    for (const sl of pool.slots) {
      if (sl.id !== null && sl.seen !== stamp) {
        sl.id = null;
        sl.mesh.geometry.setDrawRange(0, 0);
      }
    }
    // Flat media cannot be relit, so the flash overlay does more work there.
    flash.mat.uniforms.uFlash.value = frame.flash * (flat ? 0.38 : 0.14);
    flash.mesh.visible = frame.flash > 0.002;

    if (video) {
      vidMesh.visible = !!latest;
      if (latest) {
        const v = video.video;
        const aspect = v.videoWidth ? v.videoWidth / v.videoHeight : 9 / 16;
        vidMesh.scale.set(canvasH * aspect, canvasH, 1);
        vidMesh.position.set((latest.x - 0.5) * canvasW, 0, 0);
        syncVideo(video, { play: true, time: (frame.t - latest.at) / 1000, rate: 1, muted: true, volume: 0 }, frame.wall);
      } else video.video.pause();
    }
  });

  group.renderOrder = 30;
  flash.mesh.renderOrder = 31;
  return (
    <>
      <primitive object={group} />
      <primitive object={vidMesh} />
      <primitive object={flash.mesh} />
    </>
  );
}

// ---------------------------------------------------------------- transitions

const maskFrag = /* glsl */ `
uniform float uP;
uniform float uAspect;
uniform float uKind;   // 0 dissolve, 1 wipe, 2 burn
uniform vec2 uDir;
uniform float uSoft;
varying vec2 vUv;
${NOISE_GLSL}
float field(vec2 uv) {
  if (uKind > 0.5 && uKind < 1.5) {
    // directional wipe with a ragged, soft edge
    float m = dot(uv - 0.5, uDir) + 0.5;
    return m + (fbm4(vec2(uv.x * uAspect, uv.y) * 5.0) - 0.5) * uSoft * 0.5;
  }
  return fbm4(vec2(uv.x * uAspect, uv.y) * 6.0) * 0.7 + hash12(uv * 900.0) * 0.3;
}
void main() {
  float n = field(vUv);
  float soft = uKind > 0.5 && uKind < 1.5 ? 0.02 + uSoft * 0.2 : 0.08;
  float p = uP * (1.0 + soft * 2.0) - soft;
  float keep = 1.0 - smoothstep(p - soft, p + soft, n);
  gl_FragColor = vec4(0.0, 0.0, 0.0, keep);
}
`;

const burnEdgeFrag = /* glsl */ `
uniform float uP;
uniform float uAspect;
uniform float uTime;
uniform float uSoft;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float n = fbm4(vec2(vUv.x * uAspect, vUv.y) * 6.0) * 0.7 + hash12(vUv * 900.0) * 0.3;
  float soft = 0.08;
  float p = uP * (1.0 + soft * 2.0) - soft;
  // glowing rim just ahead of the burn front, flickering
  float edge = smoothstep(p - 0.09 - uSoft * 0.1, p, n) * (1.0 - smoothstep(p, p + 0.02, n));
  float flick = 0.75 + 0.25 * sin(uTime * 37.0 + n * 90.0);
  vec3 col = mix(vec3(1.0, 0.25, 0.02), vec3(1.0, 0.85, 0.4), edge) * edge * 2.4 * flick;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const DIRS: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] };

/**
 * Incoming scene during a dissolve, wipe or burn: punch transparent holes so the
 * outgoing canvas underneath shows through. Multiplies the premultiplied framebuffer
 * (colour and alpha) by the mask; the burn adds a glowing edge on top.
 */
export function DissolveMask() {
  const { getTransition, canvasW, canvasH, frame } = useStage();
  const { mesh, mat } = useQuad(maskFrag, { uP: { value: 0 }, uAspect: { value: canvasW / canvasH }, uKind: { value: 0 }, uDir: { value: new THREE.Vector2(1, 0) }, uSoft: { value: 0.3 } }, {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.SrcAlphaFactor,
  });
  const edge = useQuad(burnEdgeFrag, { uP: { value: 0 }, uAspect: { value: canvasW / canvasH }, uTime: { value: 0 }, uSoft: { value: 0.3 } }, { blending: THREE.AdditiveBlending });
  useFrame(() => {
    const tr = getTransition();
    const kind = tr?.spec.kind;
    const on = !!tr && tr.side === "in" && (kind === "dissolve" || kind === "wipe" || kind === "burn") && tr.p < 1;
    mesh.visible = on;
    edge.mesh.visible = on && kind === "burn";
    if (!on) return;
    const p = clamp(tr!.p, 0, 1);
    mat.uniforms.uP.value = p;
    mat.uniforms.uKind.value = kind === "wipe" ? 1 : kind === "burn" ? 2 : 0;
    const d = DIRS[tr!.spec.direction ?? "left"] ?? DIRS.left; // an unknown direction must not throw in the frame loop
    mat.uniforms.uDir.value.set(d[0], d[1]);
    mat.uniforms.uSoft.value = tr!.spec.softness ?? 0.3;
    edge.mat.uniforms.uP.value = p;
    edge.mat.uniforms.uTime.value = frame.ts;
    edge.mat.uniforms.uSoft.value = tr!.spec.softness ?? 0.3;
  });
  mesh.renderOrder = 1000;
  edge.mesh.renderOrder = 1001;
  return (
    <>
      <primitive object={mesh} />
      <primitive object={edge.mesh} />
    </>
  );
}

const travelFrag = /* glsl */ `
uniform float uA;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float v = 0.75 + 0.25 * (1.0 - abs(vUv.y - 0.5) * 2.0);
  gl_FragColor = vec4(uColor, uA * v);
  #include <colorspace_fragment>
}
`;

const WHITE = new THREE.Color(1, 1, 1);

/** Atmospheric bloom while the virtual camera flies between locations. */
export function TravelHaze() {
  const { getTransition, frame } = useStage();
  const { mesh, mat } = useQuad(travelFrag, { uA: { value: 0 }, uColor: { value: new THREE.Color() } });
  useFrame(() => {
    const tr = getTransition();
    const on = !!tr && tr.spec.kind === "travel";
    mesh.visible = on;
    if (!on) return;
    const p = clamp(tr!.p, 0, 1);
    mat.uniforms.uA.value = Math.pow(Math.sin(p * Math.PI), 1.6) * 0.7;
    mat.uniforms.uColor.value.copy(frame.fogColor).lerp(WHITE, 0.35).multiplyScalar(0.5 + frame.ambient * 0.5);
  });
  mesh.renderOrder = 900;
  return <primitive object={mesh} />;
}
