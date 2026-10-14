import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp, evalTween } from "@/core/clock";
import type { RouteComponent } from "@/core/types";
import { useStage } from "../frame";
import { fontString, hexToRgba, loadImage, makeCanvasTex, makeOverlayMaterial, overlayTexWidth, resizeCanvasTex } from "./canvasTex";
import { fitFrame, kenBurnsAt } from "./MediaLayers";

/** The map and its glowing route, drawn in one canvas so the Ken Burns move carries the line with it. */
export function RouteLayer({ comp }: { comp: RouteComponent }) {
  const { getRt, frame, canvasW, canvasH, assets, isOutput } = useStage();
  const asset = comp.assetId ? assets.find((a) => a.id === comp.assetId) : undefined;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let alive = true;
    setImg(null);
    if (asset?.url) loadImage(asset.url).then((i) => alive && setImg(i)).catch((e) => console.warn(e));
    return () => {
      alive = false;
    };
  }, [asset?.url]);
  const tex = useMemo(() => makeCanvasTex(16, 16), []);
  const mat = useMemo(() => makeOverlayMaterial(tex.texture, "normal"), [tex]);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.frustumCulled = false;
    m.renderOrder = 47;
    return m;
  }, [mat]);
  const last = useRef("");
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
    const t = frame.t;
    const fadeK = clamp((t - lr.changedAt) / 1500, 0, 1);
    const presence = (lr.visible ? fadeK : 1 - fadeK) * comp.opacity;
    mesh.visible = presence > 0.001;
    if (!mesh.visible) return;
    mat.opacity = presence;
    const p = evalTween(rt.routes?.[comp.id]?.progress ?? { from: 0, to: 0, at: 0, dur: 0 }, t);
    const sinceStart = (t - Math.max(0, lr.startAt)) / 1000;
    const kb = kenBurnsAt(comp.zoom, comp.zoom.enabled ? (rt.routes?.[comp.id]?.progress.dur ? ((p * comp.zoom.duration) as number) : sinceStart) : 0);
    const labelK = clamp((p - 0.97) / 0.03, 0, 1);
    const pulse = frame.ts;
    const key = `${p.toFixed(4)}|${kb.x.toFixed(4)}|${kb.y.toFixed(4)}|${kb.scale.toFixed(4)}|${!!img}|${comp.points.length}|${comp.color}|${comp.width}|${comp.label}|${labelK.toFixed(2)}|${p > 0 && p < 1 ? pulse.toFixed(1) : ""}`;
    const texW = overlayTexWidth(canvasW);
    const texH = Math.round((texW * canvasH) / canvasW);
    const resized = resizeCanvasTex(tex, texW, texH);
    if (key === last.current && !resized) return;
    last.current = key;

    const ctx = tex.ctx;
    const W = tex.w;
    const H = tex.h;
    ctx.clearRect(0, 0, W, H);
    // Map frame in texture px (same fitting rules as a media plate), then Ken Burns.
    const aspect = img ? img.width / img.height : 16 / 9;
    const f = fitFrame(comp.fit, aspect, W, H, comp.anchorY ?? 0.5);
    const s = kb.scale;
    const fw = f.w * s;
    const fh = f.h * s;
    const fx = W / 2 - fw / 2 + kb.x * W;
    const fy = H / 2 - fh / 2 - f.cy + kb.y * H;
    if (img) ctx.drawImage(img, fx, fy, fw, fh);
    else if (!isOutput && comp.assetId) {
      ctx.fillStyle = "rgba(255,0,170,0.12)";
      ctx.fillRect(fx, fy, fw, fh);
    }
    const pts = comp.points.map(([u, v]) => [fx + u * fw, fy + v * fh] as const);
    if (pts.length >= 2 && p > 0) {
      // Walk the polyline by length up to progress p.
      const segs: number[] = [];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        segs.push(d);
        total += d;
      }
      let remain = total * clamp(p, 0, 1);
      const path: (readonly [number, number])[] = [pts[0]];
      let head = pts[0];
      for (let i = 1; i < pts.length && remain > 0; i++) {
        const d = segs[i - 1];
        if (remain >= d) {
          path.push(pts[i]);
          head = pts[i];
          remain -= d;
        } else {
          const k = remain / d;
          head = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
          path.push(head);
          remain = 0;
        }
      }
      const lw = comp.width * H;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const draw = (width: number, color: string, blur: number) => {
        ctx.shadowColor = color;
        ctx.shadowBlur = blur;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(path[0][0], path[0][1]);
        // smooth through the points
        for (let i = 1; i < path.length - 1; i++) {
          const mx = (path[i][0] + path[i + 1][0]) / 2;
          const my = (path[i][1] + path[i + 1][1]) / 2;
          ctx.quadraticCurveTo(path[i][0], path[i][1], mx, my);
        }
        ctx.lineTo(path[path.length - 1][0], path[path.length - 1][1]);
        ctx.stroke();
      };
      if (comp.glow > 0) draw(lw * 3.2, hexToRgba(comp.color, 0.22 * comp.glow), lw * 4 * comp.glow);
      draw(lw * 1.6, hexToRgba(comp.color, 0.55), lw * 1.5 * comp.glow);
      draw(lw, "#fff7e6", lw * 0.6);
      // Head: a pulsing beacon while drawing, a settled dot at the end.
      const beat = p < 1 ? 1 + 0.35 * Math.sin(pulse * 6) : 1;
      ctx.shadowColor = hexToRgba(comp.color, 0.9 * comp.glow);
      ctx.shadowBlur = lw * 5 * comp.glow * beat;
      ctx.fillStyle = "#fffaf0";
      ctx.beginPath();
      ctx.arc(head[0], head[1], lw * 1.3 * beat, 0, Math.PI * 2);
      ctx.fill();
      ctx.fill();
      // Start marker.
      ctx.shadowBlur = lw * 2;
      ctx.fillStyle = hexToRgba(comp.color, 0.9);
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], lw * 1.1, 0, Math.PI * 2);
      ctx.fill();
      if (comp.label && labelK > 0) {
        const px = comp.labelSize * H;
        ctx.font = fontString("display", 600, px);
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.shadowColor = hexToRgba(comp.color, 0.8 * labelK * comp.glow);
        ctx.shadowBlur = px * 0.7;
        ctx.fillStyle = hexToRgba(comp.labelColor, labelK);
        const end = pts[pts.length - 1];
        const right = end[0] < W * 0.78;
        ctx.textAlign = right ? "left" : "right";
        ctx.fillText(comp.label, end[0] + (right ? 1 : -1) * lw * 3.5, end[1]);
        ctx.fillText(comp.label, end[0] + (right ? 1 : -1) * lw * 3.5, end[1]);
      }
    }
    ctx.shadowBlur = 0;
    tex.texture.needsUpdate = true;
    mesh.scale.set(canvasW, canvasH, 1);
  });

  return <primitive object={mesh} />;
}
