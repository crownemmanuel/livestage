import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp, easeOut, evalTween, smoothstep } from "@/core/clock";
import { hash1, hash2 } from "@/core/noise";
import { initialNames } from "@/core/runtime";
import type { NamesComponent, NamesRuntime } from "@/core/types";
import { useStage } from "../frame";
import { fontString, hexToRgba, makeCanvasTex, makeOverlayMaterial, overlayTexWidth, resizeCanvasTex } from "./canvasTex";

/*
 * The genealogy. Drawn with Canvas 2D into a full-wall texture; redrawn only while
 * something moves (a name blooming, the tree burning, blossoms opening, names flying).
 */

interface Node {
  i: number;
  /** Trunk attachment and leaf position in texture px. */
  tx: number;
  ty: number;
  x: number;
  y: number;
  side: number;
}

function treeNodes(c: NamesComponent, W: number, H: number): Node[] {
  const n = Math.max(1, c.names.length);
  const rootX = c.x * W;
  const rootY = c.y * H;
  const top = rootY - c.height * H;
  return c.names.map((_, i) => {
    const f = (i + 0.5) / n;
    const ty = rootY - (rootY - top) * (0.06 + 0.94 * f);
    const side = i === 0 ? 0 : i % 2 === 1 ? -1 : 1;
    const reach = c.spread * W * (0.45 + 0.55 * hash2(c.seed + i, 1.7)) * (1 - 0.35 * f);
    return { i, tx: rootX + (hash2(c.seed, i) - 0.5) * W * 0.004, ty, x: rootX + side * reach, y: ty - H * 0.012 * (0.5 + hash2(i, c.seed)), side };
  });
}

export function NamesLayer({ comp }: { comp: NamesComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const tex = useMemo(() => makeCanvasTex(16, 16), []);
  const mat = useMemo(() => makeOverlayMaterial(tex.texture, "normal"), [tex]);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.frustumCulled = false;
    m.renderOrder = 48;
    return m;
  }, [mat]);
  const last = useRef<{ key: string; animating: boolean }>({ key: "", animating: true });
  useEffect(() => () => {
    tex.texture.dispose();
    mat.dispose();
  }, [tex, mat]);

  useFrame(() => {
    const rt = getRt();
    const lr = rt?.layers[comp.id];
    if (!rt || !lr) {
      mesh.visible = false;
      return;
    }
    const st: NamesRuntime = rt.names?.[comp.id] ?? initialNames();
    const t = frame.t;
    const fadeK = clamp((t - lr.changedAt) / 1500, 0, 1);
    const presence = lr.visible ? fadeK : 1 - fadeK;
    mesh.visible = presence > 0.001;
    if (!mesh.visible) return;
    mat.opacity = presence;

    const texW = overlayTexWidth(canvasW);
    const texH = Math.round((texW * canvasH) / canvasW);
    resizeCanvasTex(tex, texW, texH);
    const burn = evalTween(st.burn, t);
    const bloom = evalTween(st.bloom, t);
    const sinceShown = (t - st.shownAt) / 1000;
    const revealing = st.shown > 0 && sinceShown < comp.reveal + 0.8;
    const tweening = (st.burn.dur > 0 && t < st.burn.at + st.burn.dur + 3000) || (st.bloom.dur > 0 && t < st.bloom.at + st.bloom.dur + 500);
    const animating = revealing || tweening || (comp.style === "fly" && sinceShown < comp.reveal * 2.5) || (burn > 0.02 && burn < 0.999) || (bloom > 0.02 && bloom < 1);
    const key = `${st.shown}|${texW}|${burn.toFixed(3)}|${bloom.toFixed(3)}|${comp.names.join("|")}|${comp.style}|${comp.color}|${comp.size}|${comp.x}|${comp.y}|${comp.height}|${comp.spread}|${comp.crown}`;
    if (key === last.current.key && !animating && !last.current.animating) return;
    last.current = { key, animating };

    const ctx = tex.ctx;
    const W = tex.w;
    const H = tex.h;
    ctx.clearRect(0, 0, W, H);
    const px = comp.size * H;
    ctx.textBaseline = "middle";
    const font = fontString(comp.font, comp.style === "line" ? 400 : 600, px);
    ctx.font = font;
    const gold = comp.color;
    const branch = comp.branchColor;
    const total = comp.names.length;
    const progressOf = (i: number) => (i < st.shown - 1 ? 1 : i === st.shown - 1 ? clamp(sinceShown / Math.max(0.05, comp.reveal), 0, 1) : 0);

    if (comp.style === "tree" || comp.style === "line") {
      const nodes = treeNodes(comp, W, H);
      const line = comp.style === "line";
      const rootX = comp.x * W;
      const rootY = comp.y * H;
      // How much of the trunk is alive: burning eats it from the top down to a stump.
      const shownTop = st.shown > 0 ? nodes[Math.min(total, st.shown) - 1].ty - H * 0.02 * progressOf(st.shown - 1) : rootY;
      const stumpY = rootY - comp.height * H * 0.1;
      const trunkTop = rootY - (rootY - shownTop) * (1 - burn) - (burn > 0 ? 0 : 0);
      const aliveTop = Math.max(trunkTop, burn > 0 ? stumpY - (stumpY - shownTop) * (1 - burn) : -1e9);
      const charCol = `rgba(28,22,18,1)`;
      const blossom = bloom;
      // Trunk.
      const trunkW = line ? px * 0.06 : px * (0.22 + 0.1 * blossom);
      const grad = ctx.createLinearGradient(0, rootY, 0, Math.min(aliveTop, rootY - 1));
      grad.addColorStop(0, hexToRgba(branch, 1));
      grad.addColorStop(1, hexToRgba(gold, 1));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (st.shown > 0 || burn > 0) {
        ctx.shadowColor = hexToRgba(gold, 0.6 * comp.glow);
        ctx.shadowBlur = px * (line ? 0.3 : 0.7) * comp.glow;
        ctx.strokeStyle = burn > 0 ? mixColor(branch, charCol, smoothstep(0.1, 0.6, burn)) : grad;
        ctx.lineWidth = trunkW;
        ctx.beginPath();
        ctx.moveTo(rootX, rootY);
        const top = Math.min(aliveTop, rootY - 1);
        // a slight lean so it reads as a living tree, not a ruler
        ctx.quadraticCurveTo(rootX + (line ? 0 : W * 0.006), (rootY + top) / 2, rootX + (line ? 0 : W * 0.003), top);
        ctx.stroke();
        // Charred remainder above the burn line.
        if (burn > 0 && burn < 1 && shownTop < aliveTop) {
          ctx.shadowBlur = 0;
          ctx.strokeStyle = `rgba(20,16,14,${0.9 * (1 - burn)})`;
          ctx.lineWidth = trunkW * 0.8;
          ctx.beginPath();
          ctx.moveTo(rootX + W * 0.003, aliveTop);
          ctx.lineTo(rootX + W * 0.003, shownTop);
          ctx.stroke();
          // Embers at the burn front.
          for (let e = 0; e < 26; e++) {
            const hx = hash1(e * 7.3 + comp.seed);
            const hy = hash1(e * 3.1 + 11);
            const life = (frame.ts * (0.6 + hx) + hy * 5) % 1;
            const ex = rootX + (hx - 0.5) * W * 0.08 + Math.sin(frame.ts * 2 + e) * W * 0.004;
            const ey = aliveTop - life * H * 0.12;
            ctx.fillStyle = `rgba(255,${Math.round(120 + 100 * hy)},40,${(1 - life) * 0.9})`;
            ctx.beginPath();
            ctx.arc(ex, ey, px * 0.05 * (1 - life * 0.6), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      for (const nd of nodes) {
        const p = progressOf(nd.i);
        if (p <= 0) continue;
        // Burn consumes names from the top of the tree downward.
        const burnAt = ((total - 1 - nd.i) / Math.max(1, total)) * 0.85;
        const b = burn <= 0 ? 0 : clamp((burn - burnAt) / 0.15, 0, 1);
        const alpha = (1 - b) * (line ? 0.95 : 1);
        if (alpha <= 0.01) continue;
        const grow = easeOut(clamp(p * 1.6, 0, 1));
        const appear = clamp((p - 0.35) / 0.65, 0, 1);
        const col = mixColor(gold, charCol, b);
        // Branch from the trunk to the name.
        if (!line && nd.side !== 0) {
          ctx.shadowColor = hexToRgba(gold, 0.7 * comp.glow * (1 - b));
          ctx.shadowBlur = px * 0.5 * comp.glow;
          ctx.strokeStyle = mixColor(branch, charCol, b);
          ctx.lineWidth = px * 0.11;
          ctx.beginPath();
          ctx.moveTo(nd.tx, nd.ty);
          const ex = nd.tx + (nd.x - nd.tx) * grow;
          const ey = nd.ty + (nd.y - nd.ty) * grow;
          ctx.quadraticCurveTo(nd.tx + (nd.x - nd.tx) * 0.45 * grow, nd.ty - H * 0.03 * grow, ex, ey);
          ctx.stroke();
          // Blossoms along the branch (Scene 16).
          if (blossom > 0.01) {
            const count = 7 + Math.round(blossom * 9);
            for (let k = 0; k < count; k++) {
              const u = (k + 0.5) / count;
              const show = clamp((blossom - u * 0.8) / 0.2, 0, 1);
              if (show <= 0) continue;
              const bx = nd.tx + (nd.x - nd.tx) * u + (hash2(k, nd.i) - 0.5) * px * 0.4;
              const by = nd.ty + (nd.y - nd.ty) * u - H * 0.03 * 4 * u * (1 - u) + (hash2(nd.i, k) - 0.5) * px * 0.5;
              ctx.fillStyle = `rgba(255,${Math.round(225 + 30 * hash2(k, 3))},${Math.round(200 + 50 * hash2(k, 5))},${0.9 * show})`;
              ctx.shadowColor = "rgba(255,240,220,0.8)";
              ctx.shadowBlur = px * 0.3;
              ctx.beginPath();
              ctx.arc(bx, by, px * 0.09 * show * (0.6 + 0.4 * hash2(k, nd.i * 2)), 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        // Node glow + name.
        const bloomPulse = nd.i === st.shown - 1 ? 1 + 0.35 * Math.sin(Math.min(p, 1) * Math.PI) : 1;
        const tx = nd.side === 0 ? nd.tx : nd.x + nd.side * px * 0.35;
        const ty = nd.side === 0 ? nd.ty - px * 0.9 : nd.y;
        ctx.textAlign = nd.side === 0 ? "center" : nd.side < 0 ? "right" : "left";
        ctx.font = fontString(comp.font, line ? 400 : 600, px * (nd.i === 0 && !line ? 1.15 : 1));
        if (!line && b < 1) {
          ctx.shadowColor = hexToRgba(gold, (0.9 + 0.3 * blossom) * comp.glow * appear * (1 - b));
          ctx.shadowBlur = px * (0.9 + 0.5 * blossom) * comp.glow * bloomPulse;
          ctx.fillStyle = hexToRgba(gold, 0.5 * appear * (1 - b));
          ctx.fillText(comp.names[nd.i], tx, ty);
        }
        ctx.shadowBlur = line ? px * 0.15 * comp.glow : px * 0.25;
        ctx.shadowColor = line ? hexToRgba(gold, 0.5) : hexToRgba(gold, 0.5 * (1 - b));
        ctx.fillStyle = col.replace(/,1\)$/, `,${appear * alpha})`);
        ctx.fillText(comp.names[nd.i], tx, ty);
      }
      // Crown ornament (FOREVER / JESUS) above the finished tree.
      if (comp.crown && st.shown >= total && burn < 1) {
        const k = clamp((sinceShown - comp.reveal) / 1.5, 0, 1) * (1 - clamp(burn * 1.5, 0, 1));
        if (k > 0) {
          const topNode = nodes[total - 1];
          ctx.textAlign = "center";
          ctx.font = fontString(comp.font, 600, px * 1.6);
          ctx.shadowColor = hexToRgba(gold, 0.9 * k * comp.glow);
          ctx.shadowBlur = px * 1.4;
          ctx.fillStyle = hexToRgba("#fff4d6", k);
          ctx.fillText(comp.crown, rootX, topNode.ty - px * 2.4);
          ctx.fillText(comp.crown, rootX, topNode.ty - px * 2.4);
        }
      }
    } else if (comp.style === "roll") {
      // One big name at a time; the previous one lifts away.
      ctx.textAlign = "center";
      const cx = comp.x * W;
      const cy = comp.y * H;
      const draw = (i: number, a: number, dy: number, scale: number) => {
        if (i < 0 || i >= total || a <= 0) return;
        ctx.font = fontString(comp.font, 600, px * scale);
        ctx.shadowColor = hexToRgba(gold, 0.8 * a * comp.glow);
        ctx.shadowBlur = px * 0.9 * comp.glow;
        ctx.fillStyle = hexToRgba(gold, a);
        ctx.fillText(comp.names[i], cx, cy + dy);
        ctx.fillText(comp.names[i], cx, cy + dy);
      };
      const p = progressOf(st.shown - 1);
      draw(st.shown - 1, easeOut(p), (1 - easeOut(p)) * px * 0.6, 0.9 + 0.1 * easeOut(p));
      draw(st.shown - 2, 1 - clamp(p * 1.4, 0, 1), -easeOut(clamp(p * 1.4, 0, 1)) * px * 1.4, 1);
    } else {
      // fly: each name rises from the root and fades like an ember.
      ctx.textAlign = "center";
      const cx = comp.x * W;
      const cy = comp.y * H;
      for (let i = Math.max(0, st.shown - 4); i < st.shown; i++) {
        const age = i === st.shown - 1 ? sinceShown : sinceShown + (st.shown - 1 - i) * comp.reveal;
        const life = clamp(age / Math.max(0.1, comp.reveal * 2.2), 0, 1);
        if (life >= 1) continue;
        const rise = easeOut(life);
        const a = life < 0.15 ? life / 0.15 : 1 - smoothstep(0.55, 1, life);
        const dx = (hash1(i * 3.7 + comp.seed) - 0.5) * comp.spread * W * 2 * rise;
        ctx.font = fontString(comp.font, 600, px * (0.8 + 0.7 * rise));
        ctx.shadowColor = hexToRgba(gold, 0.9 * a * comp.glow);
        ctx.shadowBlur = px * 1.1 * comp.glow;
        ctx.fillStyle = hexToRgba(gold, a);
        ctx.fillText(comp.names[i], cx + dx, cy - rise * comp.height * H);
        ctx.fillText(comp.names[i], cx + dx, cy - rise * comp.height * H);
      }
    }
    ctx.shadowBlur = 0;
    tex.texture.needsUpdate = true;
    mesh.scale.set(canvasW, canvasH, 1);
    mesh.position.set(0, 0, 0);
  });

  return <primitive object={mesh} />;
}

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
function mixColor(a: string, b: string, k: number) {
  tmpA.set(a);
  tmpB.set(b);
  tmpA.lerp(tmpB, clamp(k, 0, 1));
  return `rgba(${Math.round(tmpA.r * 255)},${Math.round(tmpA.g * 255)},${Math.round(tmpA.b * 255)},1)`;
}
