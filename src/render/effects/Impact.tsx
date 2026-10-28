import { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { bool, num } from "@/core/effects";
import { hash1 } from "@/core/noise";
import type { EffectComponent, SceneRuntime } from "@/core/types";
import { cached } from "../cache";
import { useStage } from "../frame";

/** Shake effects of a scene that move only the cut-out actors (the video under them shakes by itself). */
export const isCutOutShake = (c: EffectComponent, rt: SceneRuntime | null | undefined) => bool(rt?.effects[c.id]?.params ?? c.params, "cutOutsOnly");

/** Summed shake offset at time `t` (fractions of the frame height, +y down) and the strongest running intensity. */
export function shakeOffset(comps: EffectComponent[], rt: SceneRuntime | null | undefined, t: number) {
  let dx = 0;
  let dy = 0;
  let peak = 0;
  for (const c of comps) {
    const e = rt?.effects[c.id];
    const p = e?.params ?? c.params;
    const dur = num(p, "duration", 1.2);
    const inten = num(p, "intensity", 0.025);
    const f = num(p, "frequency", 14) * Math.PI * 2;
    for (const ev of rt?.triggers ?? []) {
      if (ev.effectId !== c.id) continue;
      const dt = (t - ev.at) / 1000;
      if (dt < 0 || dt > dur) continue;
      const a = inten * Math.pow(1 - dt / dur, 2);
      const s = hash1(ev.at) * 10;
      dx += a * (0.6 * Math.sin(dt * f + s) + 0.4 * Math.sin(dt * f * 1.73 + s * 2.1));
      dy += a * (0.6 * Math.sin(dt * f * 1.21 + s * 0.7) + 0.4 * Math.sin(dt * f * 2.07 + s * 1.3));
      peak = Math.max(peak, inten);
    }
  }
  return { dx, dy, peak };
}

/**
 * Screen shake: moves the whole rendered frame (3D, video and overlays alike),
 * slightly overscanned so the edges of the wall never show. "Cut-outs only" shakes
 * are left to the cut-out actors (ClipActor).
 */
export function ShakeDriver({ comps }: { comps: EffectComponent[] }) {
  const { getRt, frame } = useStage();
  const gl = useThree((s) => s.gl);
  useFrame(() => {
    const rt = getRt();
    const el = gl.domElement;
    const { dx, dy, peak } = shakeOffset(comps.filter((c) => !isCutOutShake(c, rt)), rt, frame.t);
    if (peak === 0) {
      if (el.style.transform) el.style.transform = "";
      return;
    }
    const h = el.clientHeight;
    el.style.transform = `translate3d(${(dx * h).toFixed(2)}px, ${(dy * h).toFixed(2)}px, 0) scale(${(1 + peak * 2.2).toFixed(4)})`;
  }, 2);
  return null;
}

function spriteTexture(kind: "stone" | "glow") {
  return cached(`impact-${kind}`, () => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    if (kind === "stone") {
      // Lit from above-left so it reads as a solid stone, with a bright rim against dark skies.
      const lit = g.createRadialGradient(48, 44, 4, 64, 64, 60);
      lit.addColorStop(0, "rgba(245,236,220,1)");
      lit.addColorStop(0.45, "rgba(176,164,146,1)");
      lit.addColorStop(0.78, "rgba(104,94,82,1)");
      lit.addColorStop(0.9, "rgba(255,240,215,0.9)");
      lit.addColorStop(1, "rgba(255,240,215,0)");
      g.fillStyle = lit;
      g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    } else {
      grd.addColorStop(0, "rgba(255,248,230,1)");
      grd.addColorStop(0.3, "rgba(255,220,170,0.6)");
      grd.addColorStop(1, "rgba(255,200,140,0)");
    }
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

const TRAIL = 22;

/** A thrown stone (sling): flies along an arc with a light streak, flashes on impact. */
export function ProjectileOverlay({ comp }: { comp: EffectComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const parts = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const stoneMat = new THREE.MeshBasicMaterial({ map: spriteTexture("stone"), transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const stone = new THREE.Mesh(geo, stoneMat);
    stone.renderOrder = 41;
    const trail = Array.from({ length: TRAIL }, () => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: spriteTexture("glow"), transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      m.renderOrder = 40;
      return m;
    });
    const flash = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: spriteTexture("glow"), transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    flash.renderOrder = 42;
    // Soft halo behind the stone so it stays visible on dark, busy plates.
    const halo = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: spriteTexture("glow"), transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    halo.renderOrder = 40.5;
    const group = new THREE.Group();
    group.add(halo, stone, flash, ...trail);
    return { group, stone, halo, trail, flash };
  }, []);

  useFrame(() => {
    const rt = getRt();
    const e = rt?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const dur = num(p, "duration", 0.55);
    const size = num(p, "size", 0.02) * canvasH;
    const from = new THREE.Vector2(num(p, "fromX", 0.05), num(p, "fromY", 0.8));
    const to = new THREE.Vector2(num(p, "toX", 0.62), num(p, "toY", 0.12));
    const arc = num(p, "arc", 0.12);
    const ctrl = from.clone().add(to).multiplyScalar(0.5).add(new THREE.Vector2(0, -arc));
    const at = (k: number) => {
      const u = 1 - k;
      const x = u * u * from.x + 2 * u * k * ctrl.x + k * k * to.x;
      const y = u * u * from.y + 2 * u * k * ctrl.y + k * k * to.y;
      return [(x - 0.5) * canvasW, (0.5 - y) * canvasH] as const;
    };
    const glow = num(p, "glow", 1);
    const ev = [...(rt?.triggers ?? [])].reverse().find((x) => x.effectId === comp.id);
    const dt = ev ? (frame.t - ev.at) / 1000 : -1;
    const flying = dt >= 0 && dt <= dur;
    parts.stone.visible = flying;
    parts.halo.visible = flying && glow > 0;
    if (flying) {
      const k = dt / dur;
      const [x, y] = at(k);
      parts.stone.position.set(x, y, 0);
      // grows slightly as it comes toward the target (toward camera)
      parts.stone.scale.setScalar(size * (0.8 + 0.4 * k));
      parts.stone.rotation.z = dt * 25;
      parts.halo.position.set(x, y, 0);
      parts.halo.scale.setScalar(size * 3.2 * (0.8 + 0.4 * k));
      (parts.halo.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.55 * glow);
    }
    // Motion streak: samples along the path just behind the stone.
    parts.trail.forEach((m, i) => {
      const tk = (dt - i * 0.009) / dur;
      m.visible = flying && glow > 0 && tk >= 0;
      if (!m.visible) return;
      const [x, y] = at(Math.min(1, tk));
      m.position.set(x, y, 0);
      const fall = 1 - i / TRAIL;
      m.scale.setScalar(size * 1.5 * (0.35 + 0.65 * fall));
      (m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.7 * glow * fall * fall);
    });
    const fdt = dt - dur;
    parts.flash.visible = bool(p, "flash", true) && fdt >= 0 && fdt < 0.35;
    if (parts.flash.visible) {
      const [x, y] = at(1);
      parts.flash.position.set(x, y, 0);
      parts.flash.scale.setScalar(size * (3 + fdt * 40));
      (parts.flash.material as THREE.MeshBasicMaterial).opacity = 1 - fdt / 0.35;
    }
  });
  return <primitive object={parts.group} />;
}
