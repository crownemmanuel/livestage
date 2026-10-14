import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp } from "@/core/clock";
import { num, str } from "@/core/effects";
import { rng } from "@/core/noise";
import { effectLevel } from "@/core/runtime";
import type { EffectComponent, LightningStrike } from "@/core/types";
import { NOISE_GLSL, QUAD_VERT } from "../glsl";
import { flashCurve, useStage } from "../frame";
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
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float t = uTime * uSpeed;
  float n1 = fbm4(p * vec2(1.6, 4.5) + vec2(t * 0.05, 0.0));
  float n2 = fbm4(p * vec2(3.4, 8.0) + vec2(-t * 0.09, t * 0.01) + n1 * 0.8);
  float n3 = fbm4(p * vec2(0.7, 2.0) + vec2(t * 0.02, 3.0));
  float n = n1 * 0.45 + n2 * 0.35 + n3 * 0.4;
  float top = uHeight + (n3 - 0.5) * 0.12;
  float mask = 1.0 - smoothstep(top * 0.25, top + 0.08, vUv.y);
  float a = clamp(mask * (0.25 + n * 1.05) * uDensity * uLevel, 0.0, 0.96);
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
    const u = mat.uniforms;
    u.uTime.value = frame.ts;
    u.uDensity.value = num(p, "density", 0.6);
    u.uHeight.value = num(p, "height", 0.3);
    u.uSpeed.value = num(p, "speed", 0.4) * (1 + frame.windNow);
    u.uLevel.value = lvl;
    u.uAspect.value = canvasW / canvasH;
    u.uColor.value.set(str(p, "color", "#c9ccd2")).multiplyScalar(Math.min(1.2, 0.2 + frame.ambient * 0.85 + frame.flash * 0.6));
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
    mat.uniforms.uAmount.value = lvl * num(p, "density", 0.4) * num(p, "opacity", 0.5) * 0.6;
    mat.uniforms.uColor.value.set(str(p, "tint", "#d8cdb8")).multiplyScalar(0.04 + frame.ambient * 0.9).lerp(frame.horizon, 0.3);
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

/** Branching bolt as triangle ribbons in logical canvas pixels. */
function boltGeometry(st: LightningStrike, W: number, H: number) {
  const r = rng(st.seed);
  const pos: number[] = [];
  const uv: number[] = [];
  const s = H / 1080;
  const ribbon = (pts: THREE.Vector2[], width: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const d = new THREE.Vector2().subVectors(b, a).normalize();
      const n = new THREE.Vector2(-d.y, d.x).multiplyScalar(width * (1 - (i / pts.length) * 0.5));
      const quad = [a.clone().sub(n), a.clone().add(n), b.clone().sub(n), b.clone().add(n)];
      for (const k of [0, 2, 1, 1, 2, 3]) {
        pos.push(quad[k].x, quad[k].y, 0);
        uv.push(k % 2, 0);
      }
    }
  };
  const walk = (start: THREE.Vector2, angle: number, len: number, segs: number) => {
    const pts = [start.clone()];
    const p = start.clone();
    for (let i = 0; i < segs; i++) {
      const a = angle + (r() - 0.5) * 1.1;
      p.add(new THREE.Vector2(Math.sin(a), -Math.cos(a)).multiplyScalar(len / segs));
      pts.push(p.clone());
    }
    return pts;
  };
  const top = new THREE.Vector2((st.x - 0.5) * W, H / 2 + 10);
  // End around the horizon/hills rather than in the foreground.
  const trunkLen = H * (0.38 + r() * 0.18);
  const trunk = walk(top, (r() - 0.5) * 0.4, trunkLen, 26);
  ribbon(trunk, 4.5 * s);
  ribbon(trunk, 16 * s);
  const branches = 3 + Math.floor(r() * 4);
  for (let b = 0; b < branches; b++) {
    const from = trunk[4 + Math.floor(r() * (trunk.length - 10))];
    const br = walk(from, (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6), trunkLen * (0.15 + r() * 0.25), 10);
    ribbon(br, 2.2 * s);
    ribbon(br, 8 * s);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
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
  const bolts = useMemo(() => new Map<string, THREE.Mesh>(), []);
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

  useEffect(
    () => () => {
      for (const m of bolts.values()) m.geometry.dispose();
      bolts.clear();
    },
    [bolts],
  );

  useFrame(() => {
    const rt = getRt();
    const strikes = rt?.strikes ?? [];
    const live = new Set<string>();
    let latest: LightningStrike | null = null;
    for (const st of strikes) {
      const dt = (frame.t - st.at) / 1000;
      if (dt < 0 || dt > st.duration * 1.7) continue;
      live.add(st.id);
      latest = st;
      if (video) continue;
      let m = bolts.get(st.id);
      if (!m) {
        const mat = boltMat.clone();
        m = new THREE.Mesh(boltGeometry(st, canvasW, canvasH), mat);
        m.frustumCulled = false;
        bolts.set(st.id, m);
        group.add(m);
      }
      (m.material as THREE.ShaderMaterial).uniforms.uIntensity.value = clamp(flashCurve(dt, st.duration) * st.brightness * 1.4, 0, 2);
    }
    for (const [id, m] of bolts) {
      if (!live.has(id)) {
        group.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        bolts.delete(id);
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

const dissolveFrag = /* glsl */ `
uniform float uP;
uniform float uAspect;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float n = fbm4(vec2(vUv.x * uAspect, vUv.y) * 6.0) * 0.7 + hash12(vUv * 900.0) * 0.3;
  float p = uP * 1.2 - 0.1;
  float keep = 1.0 - smoothstep(p - 0.08, p + 0.08, n);
  gl_FragColor = vec4(0.0, 0.0, 0.0, keep);
}
`;

/**
 * Incoming scene during a noise dissolve: punch transparent holes so the
 * outgoing canvas underneath shows through. Multiplies the premultiplied
 * framebuffer (colour and alpha) by the mask.
 */
export function DissolveMask() {
  const { getTransition, canvasW, canvasH } = useStage();
  const { mesh, mat } = useQuad(dissolveFrag, { uP: { value: 0 }, uAspect: { value: canvasW / canvasH } }, {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.SrcAlphaFactor,
  });
  useFrame(() => {
    const tr = getTransition();
    const on = !!tr && tr.side === "in" && tr.spec.kind === "dissolve" && tr.p < 1;
    mesh.visible = on;
    if (on) mat.uniforms.uP.value = clamp(tr!.p, 0, 1);
  });
  mesh.renderOrder = 1000;
  return <primitive object={mesh} />;
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
    mat.uniforms.uColor.value.copy(frame.fogColor).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(0.5 + frame.ambient * 0.5);
  });
  mesh.renderOrder = 900;
  return <primitive object={mesh} />;
}
