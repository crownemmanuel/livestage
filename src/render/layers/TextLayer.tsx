import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp, easeOut, now } from "@/core/clock";
import { countdownText, formatClock, timerLeft } from "@/core/timers";
import { useShow } from "@/store/show";
import type { TextComponent } from "@/core/types";
import { NOISE_GLSL, QUAD_VERT } from "../glsl";
import { useStage } from "../frame";
import { fontString, hexToRgba, makeCanvasTex, overlayTexWidth, resizeCanvasTex } from "./canvasTex";

/*
 * Titles are laid out glyph by glyph into two canvases: the coloured text (with glow)
 * and an "order map" where every pixel of a glyph holds that glyph's (or word's) reveal
 * order. The shader then animates letter-by-letter, word-by-word, typewriter and burn-in
 * reveals without redrawing the canvas each frame.
 */

const frag = /* glsl */ `
uniform sampler2D map;
uniform sampler2D orderMap;
uniform float progress;   // 0..1 reveal progress (includes the stagger tail)
uniform float mode;       // 0 whole, 1 staggered fade, 2 typewriter, 3 burn
uniform float fadeW;      // width of the per-glyph fade in order units
uniform float opacity;
uniform vec3 grade;
uniform vec3 burnColor;
uniform float time;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.002) discard;
  float a = c.a * opacity;
  vec3 rgb = c.rgb;
  if (mode > 0.5) {
    float o = texture2D(orderMap, vUv).r;
    if (mode > 2.5) {
      float n = (fbm4(vUv * vec2(40.0, 12.0) + time * 0.3) - 0.5) * 0.08;
      float k = smoothstep(o + n - fadeW, o + n, progress);
      float edge = k * (1.0 - k) * 4.0;
      rgb = mix(rgb, burnColor * 2.2, edge * 0.9);
      rgb += burnColor * edge * 1.5;
      a *= k;
    } else if (mode > 1.5) {
      a *= step(o, progress + 0.0005);
    } else {
      a *= smoothstep(o - fadeW, o, progress);
    }
  }
  gl_FragColor = vec4(rgb * grade, a);
  #include <colorspace_fragment>
}
`;

interface Layout {
  lines: { glyphs: { ch: string; x: number; w: number; word: number; idx: number }[]; width: number }[];
  total: number;
  words: number;
  px: number;
  lineH: number;
}

function layout(ctx: CanvasRenderingContext2D, comp: TextComponent, texW: number, res: number): Layout {
  const px = comp.size * res; // size is a fraction of canvas height; res = texture px per canvas px * canvasH
  ctx.font = fontString(comp.font, comp.weight, px, comp.italic);
  const text = comp.uppercase ? comp.text.toUpperCase() : comp.text;
  const spacing = comp.letterSpacing * px;
  const maxW = comp.width > 0 ? comp.width * texW : Infinity;
  const measure = (s: string) => {
    let w = 0;
    for (const ch of s) w += ctx.measureText(ch).width + spacing;
    return w - spacing;
  };
  // Wrap on words.
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && measure(next) > maxW) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    lines.push(cur);
  }
  let idx = 0;
  let word = 0;
  const out: Layout["lines"] = lines.map((ln) => {
    const glyphs: Layout["lines"][number]["glyphs"] = [];
    let x = 0;
    for (const ch of ln) {
      const w = ctx.measureText(ch).width;
      if (ch === " ") {
        word++;
        x += w + spacing;
        continue;
      }
      glyphs.push({ ch, x, w, word, idx: idx++ });
      x += w + spacing;
    }
    word++;
    return { glyphs, width: Math.max(0, x - spacing) };
  });
  return { lines: out, total: idx, words: word, px, lineH: px * comp.lineHeight };
}

export function TextLayer({ comp }: { comp: TextComponent }) {
  const { getRt, frame, canvasW, canvasH } = useStage();
  const tex = useMemo(() => makeCanvasTex(16, 16), []);
  const order = useMemo(() => makeCanvasTex(16, 16), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: frag,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          map: { value: tex.texture },
          orderMap: { value: order.texture },
          progress: { value: 1 },
          mode: { value: 0 },
          fadeW: { value: 0.1 },
          opacity: { value: 1 },
          grade: { value: new THREE.Color(1, 1, 1) },
          burnColor: { value: new THREE.Color("#ff9a2a") },
          time: { value: 0 },
        },
      }),
    [tex, order],
  );
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.frustumCulled = false;
    m.renderOrder = 50;
    return m;
  }, [mat]);
  const block = useRef({ h: 1, count: 1 });

  useEffect(() => {
    mat.blending = comp.blend === "add" || comp.blend === "screen" ? THREE.AdditiveBlending : comp.blend === "multiply" ? THREE.MultiplyBlending : THREE.NormalBlending;
    mat.needsUpdate = true;
  }, [mat, comp.blend]);

  // Re-render the canvases when the text or its style changes.
  useEffect(() => {
    const texW = overlayTexWidth(canvasW);
    const res = (texW / canvasW) * canvasH;
    const ctx = tex.ctx;
    const L = layout(ctx, comp, texW, res);
    const pad = L.px * (0.6 + comp.glow * 0.8 + comp.shadow * 0.3);
    const blockH = L.lines.length * L.lineH + pad * 2;
    resizeCanvasTex(tex, texW, blockH);
    resizeCanvasTex(order, texW, blockH);
    // Block height back in canvas px (the quad is sized in canvas units).
    block.current = { h: blockH / (texW / canvasW), count: comp.anim.enter === "words" || comp.anim.exit === "words" ? L.words : L.total };
    const octx = order.ctx;
    ctx.clearRect(0, 0, tex.w, tex.h);
    octx.clearRect(0, 0, order.w, order.h);
    const font = fontString(comp.font, comp.weight, L.px, comp.italic);
    ctx.font = font;
    octx.font = font;
    ctx.textBaseline = "alphabetic";
    octx.textBaseline = "alphabetic";
    const anchorX = comp.x * texW;
    const total = Math.max(1, block.current.count);
    const useWords = comp.anim.enter === "words" || comp.anim.exit === "words";
    const glowBlur = comp.glow * L.px * 0.45;
    L.lines.forEach((ln, li) => {
      const left = comp.align === "center" ? anchorX - ln.width / 2 : comp.align === "left" ? anchorX - (comp.width > 0 ? (comp.width * texW) / 2 : 0) : anchorX + (comp.width > 0 ? (comp.width * texW) / 2 : 0) - ln.width;
      const baseline = pad + li * L.lineH + L.px * 0.95;
      for (const g of ln.glyphs) {
        const x = left + g.x;
        const k = ((useWords ? g.word : g.idx) + 0.5) / total;
        // Order map: the glyph plus a halo as wide as its glow, so the glow reveals with it.
        const gray = Math.round(k * 255);
        octx.fillStyle = `rgb(${gray},${gray},${gray})`;
        octx.shadowColor = `rgb(${gray},${gray},${gray})`;
        octx.shadowBlur = glowBlur + L.px * 0.12;
        octx.fillText(g.ch, x, baseline);
        octx.fillText(g.ch, x, baseline);
        // Drop shadow, glow passes, then the crisp glyph.
        if (comp.shadow > 0) {
          ctx.shadowColor = `rgba(0,0,0,${Math.min(1, comp.shadow)})`;
          ctx.shadowBlur = L.px * 0.12;
          ctx.shadowOffsetX = L.px * 0.03;
          ctx.shadowOffsetY = L.px * 0.05;
          ctx.fillStyle = comp.color;
          ctx.fillText(g.ch, x, baseline);
          ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
        }
        if (comp.glow > 0) {
          ctx.shadowColor = hexToRgba(comp.glowColor, Math.min(1, 0.55 * comp.glow));
          ctx.shadowBlur = glowBlur;
          ctx.fillStyle = comp.glowColor;
          const passes = Math.min(4, 1 + Math.round(comp.glow * 2));
          for (let i = 0; i < passes; i++) ctx.fillText(g.ch, x, baseline);
        }
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fillStyle = comp.color;
        ctx.fillText(g.ch, x, baseline);
      }
    });
    tex.texture.needsUpdate = true;
    order.texture.needsUpdate = true;
  }, [comp, canvasW, canvasH, tex, order]);

  useEffect(() => () => {
    tex.texture.dispose();
    order.texture.dispose();
    mat.dispose();
  }, [tex, order, mat]);

  useFrame(() => {
    const rt = getRt();
    const lr = rt?.layers[comp.id];
    if (!rt || !lr) {
      mesh.visible = false;
      return;
    }
    const a = comp.anim;
    const kind = lr.visible ? a.enter : a.exit;
    const staggered = kind === "letters" || kind === "words" || kind === "typewriter" || kind === "burn";
    const total = Math.max(0.05, a.duration + (staggered ? a.stagger * Math.max(0, block.current.count - 1) : 0));
    let k = clamp((frame.t - lr.changedAt) / 1000 / total, 0, 1);
    if (!lr.visible) k = 1 - k;
    mesh.visible = k > 0.001;
    if (!mesh.visible) return;
    const u = mat.uniforms;
    u.time.value = frame.ts;
    u.grade.value.copy(frame.mediaGrade);
    const fadeW = staggered ? Math.max(0.02, a.duration / total) : 0.1;
    u.fadeW.value = fadeW;
    let opacity = 1;
    let dy = 0;
    if (kind === "cut") {
      u.mode.value = 0;
      opacity = k > 0 ? 1 : 0;
    } else if (kind === "fade") {
      u.mode.value = 0;
      opacity = k;
    } else if (kind === "rise") {
      u.mode.value = 0;
      opacity = clamp(k * 1.5, 0, 1);
      dy = (1 - easeOut(k)) * 0.08 * canvasH;
    } else {
      u.mode.value = kind === "typewriter" ? 2 : kind === "burn" ? 3 : 1;
      // progress runs from 0 to 1 + fadeW so the last glyph fully arrives
      u.progress.value = k * (1 + fadeW) ;
    }
    u.opacity.value = opacity;
    const w = canvasW;
    const h = block.current.h;
    mesh.scale.set(w, h, 1);
    mesh.position.set(0, (0.5 - comp.y) * canvasH - dy, 0);
  });

  return <primitive object={mesh} />;
}

/** A title linked to a show timer: redrawn once a second with "{time}" filled in. */
export function CountdownLayer({ comp }: { comp: TextComponent }) {
  const run = useShow((s) => (comp.timerId ? s.program.timers?.[comp.timerId] : undefined));
  const [clock, setClock] = useState(() => formatClock(timerLeft(run, 0, now())));
  useEffect(() => {
    const tick = () => setClock(formatClock(timerLeft(run, 0, now())));
    tick();
    if (!run?.running) return;
    const h = setInterval(tick, 200);
    return () => clearInterval(h);
  }, [run]);
  const shown = useMemo(() => ({ ...comp, text: countdownText(comp.text, clock) }), [comp, clock]);
  return <TextLayer comp={shown} />;
}
