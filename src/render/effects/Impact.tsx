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

interface ShakeSum {
  dx: number;
  dy: number;
  /** Strongest running intensity (> 0 while any shake runs). */
  peak: number;
  /** Summed current amplitude (follows the decay envelope): the most the frame can be displaced. */
  reach: number;
}

const NO_TRIGGERS: NonNullable<SceneRuntime["triggers"]> = [];

/** Adds the running shakes of `comps` into `out` (cut-out-only shakes skipped when `skipCutOuts`). */
function sumShake(out: ShakeSum, comps: EffectComponent[], rt: SceneRuntime | null | undefined, t: number, skipCutOuts: boolean) {
  out.dx = out.dy = out.peak = out.reach = 0;
  const triggers = rt?.triggers ?? NO_TRIGGERS;
  for (const c of comps) {
    if (skipCutOuts && isCutOutShake(c, rt)) continue;
    const e = rt?.effects[c.id];
    const p = e?.params ?? c.params;
    const dur = num(p, "duration", 1.2);
    if (!(dur > 0)) continue; // a zero duration would divide 0 by 0 below
    const inten = num(p, "intensity", 0.025);
    const f = num(p, "frequency", 14) * Math.PI * 2;
    for (const ev of triggers) {
      if (ev.effectId !== c.id) continue;
      const dt = (t - ev.at) / 1000;
      if (dt < 0 || dt > dur) continue;
      const a = inten * Math.pow(1 - dt / dur, 2);
      const s = hash1(ev.at) * 10;
      out.dx += a * (0.6 * Math.sin(dt * f + s) + 0.4 * Math.sin(dt * f * 1.73 + s * 2.1));
      out.dy += a * (0.6 * Math.sin(dt * f * 1.21 + s * 0.7) + 0.4 * Math.sin(dt * f * 2.07 + s * 1.3));
      out.peak = Math.max(out.peak, inten);
      out.reach += Math.abs(a);
    }
  }
  return out;
}

/** Summed shake offset at time `t` (fractions of the frame height, +y down) and the strongest running intensity. */
export function shakeOffset(comps: EffectComponent[], rt: SceneRuntime | null | undefined, t: number) {
  const o = sumShake({ dx: 0, dy: 0, peak: 0, reach: 0 }, comps, rt, t, false);
  return { dx: o.dx, dy: o.dy, peak: o.peak };
}

/**
 * Screen shake: moves the whole rendered frame (3D, video and overlays alike),
 * slightly overscanned so the edges of the wall never show. "Cut-outs only" shakes
 * are left to the cut-out actors (ClipActor).
 */
export function ShakeDriver({ comps }: { comps: EffectComponent[] }) {
  const { getRt, frame } = useStage();
  const gl = useThree((s) => s.gl);
  const sum = useMemo<ShakeSum>(() => ({ dx: 0, dy: 0, peak: 0, reach: 0 }), []);
  useFrame(() => {
    const rt = getRt();
    const el = gl.domElement;
    const { dx, dy, peak, reach } = sumShake(sum, comps, rt, frame.t, true);
    if (peak === 0) {
      if (el.style.transform) el.style.transform = "";
      return;
    }
    const h = el.clientHeight;
    // The overscan follows the decaying amplitude (|offset| <= reach, and the scale hides
    // 1.1 * reach of edge each side), so it eases out with the shake instead of popping off.
    el.style.transform = `translate3d(${(dx * h).toFixed(2)}px, ${(dy * h).toFixed(2)}px, 0) scale(${(1 + reach * 2.2).toFixed(4)})`;
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

/** The stone's flight: a quadratic arc in 0..1 frame units (y down). */
interface Arc {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
}
const arcPt = { x: 0, y: 0 };
/** Point at `k` along the arc, in logical canvas px (y up), written to `arcPt`. */
function arcAt(a: Arc, k: number, W: number, H: number) {
  const u = 1 - k;
  const x = u * u * a.fx + 2 * u * k * a.cx + k * k * a.tx;
  const y = u * u * a.fy + 2 * u * k * a.cy + k * k * a.ty;
  arcPt.x = (x - 0.5) * W;
  arcPt.y = (0.5 - y) * H;
  return arcPt;
}

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
    const arc: Arc = { fx: 0, fy: 0, cx: 0, cy: 0, tx: 0, ty: 0 };
    return { group, stone, halo, trail, flash, arc };
  }, []);

  useFrame(() => {
    const rt = getRt();
    const e = rt?.effects[comp.id];
    const p = e?.params ?? comp.params;
    const dur = num(p, "duration", 0.55);
    const size = num(p, "size", 0.02) * canvasH;
    // Latest trigger of this effect (newest last), without copying the list.
    const triggers = rt?.triggers;
    let dt = -1;
    if (triggers) {
      for (let i = triggers.length - 1; i >= 0; i--) {
        if (triggers[i].effectId === comp.id) {
          dt = (frame.t - triggers[i].at) / 1000;
          break;
        }
      }
    }
    const flying = dt >= 0 && dt <= dur;
    const fdt = dt - dur;
    const flashOn = bool(p, "flash", true) && fdt >= 0 && fdt < 0.35;
    parts.flash.visible = flashOn;
    if (!flying) {
      parts.stone.visible = parts.halo.visible = false;
      for (const m of parts.trail) m.visible = false;
      if (!flashOn) return;
    }
    const arc = parts.arc;
    arc.fx = num(p, "fromX", 0.05);
    arc.fy = num(p, "fromY", 0.8);
    arc.tx = num(p, "toX", 0.62);
    arc.ty = num(p, "toY", 0.12);
    arc.cx = (arc.fx + arc.tx) * 0.5;
    arc.cy = (arc.fy + arc.ty) * 0.5 - num(p, "arc", 0.12);
    const glow = num(p, "glow", 1);
    parts.stone.visible = flying;
    parts.halo.visible = flying && glow > 0;
    if (flying) {
      const k = dur > 0 ? dt / dur : 1; // dur 0: dt is 0 here, and 0 / 0 would be NaN
      const { x, y } = arcAt(arc, k, canvasW, canvasH);
      parts.stone.position.set(x, y, 0);
      // grows slightly as it comes toward the target (toward camera)
      parts.stone.scale.setScalar(size * (0.8 + 0.4 * k));
      parts.stone.rotation.z = dt * 25;
      parts.halo.position.set(x, y, 0);
      parts.halo.scale.setScalar(size * 3.2 * (0.8 + 0.4 * k));
      (parts.halo.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.55 * glow);
    }
    // Motion streak: samples along the path just behind the stone.
    for (let i = 0; i < TRAIL; i++) {
      const m = parts.trail[i];
      const tk = dur > 0 ? (dt - i * 0.009) / dur : -1;
      m.visible = flying && glow > 0 && tk >= 0;
      if (!m.visible) continue;
      const { x, y } = arcAt(arc, Math.min(1, tk), canvasW, canvasH);
      m.position.set(x, y, 0);
      const fall = 1 - i / TRAIL;
      m.scale.setScalar(size * 1.5 * (0.35 + 0.65 * fall));
      (m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.7 * glow * fall * fall);
    }
    if (flashOn) {
      const { x, y } = arcAt(arc, 1, canvasW, canvasH);
      parts.flash.position.set(x, y, 0);
      parts.flash.scale.setScalar(size * (3 + fdt * 40));
      (parts.flash.material as THREE.MeshBasicMaterial).opacity = 1 - fdt / 0.35;
    }
  });
  return <primitive object={parts.group} />;
}
