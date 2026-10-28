import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clamp, now, smoothstep } from "@/core/clock";
import type { ScalingMode, SceneRuntime } from "@/core/types";
import { cn } from "@/lib/utils";
import { useShow } from "@/store/show";
import { ErrorBoundary } from "@/ui/ErrorBoundary";
import { SceneCanvas } from "./SceneCanvas";
import { usePreviewHeard } from "@/engine/previewAudio";
import { TimerOverlay } from "./TimerOverlay";
import type { SlotRole, TransitionView } from "./frame";

interface StageViewProps {
  source: "program" | "preview";
  isOutput?: boolean;
  scaling?: ScalingMode;
  /** Cap device pixel ratio (operator previews render small). */
  maxDpr?: number;
  showSafeArea?: boolean;
  audio?: boolean;
  onCapture?: (sceneId: string, dataUrl: string) => void;
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Map the logical LED canvas into the available area. */
export function displayRect(mode: ScalingMode, cw: number, ch: number, W: number, H: number, dpr: number) {
  if (mode === "stretch") return { x: 0, y: 0, w: cw, h: ch };
  let w: number;
  let h: number;
  if (mode === "native") {
    w = W / dpr;
    h = H / dpr;
  } else {
    const s = mode === "fill" ? Math.max(cw / W, ch / H) : Math.min(cw / W, ch / H);
    w = W * s;
    h = H * s;
  }
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/**
 * HTML layers (videos, standby card, timer) laid out at the wall's own proportions and squeezed
 * the same way as the 3D picture, so under Stretch they distort with it and look right on the wall.
 * `sx` is the horizontal squeeze (1 when the display shows the canvas undistorted).
 */
function WallBox({ sx, z, children }: { sx: number; z: number; children: React.ReactNode }) {
  const squeezed = Math.abs(sx - 1) > 1e-3;
  return (
    <div
      className="pointer-events-none absolute top-0 left-0 h-full"
      style={{ width: `${100 / sx}%`, zIndex: z, transform: squeezed ? `scaleX(${sx})` : undefined, transformOrigin: "0 0" }}
    >
      {children}
    </div>
  );
}

export function StageView({ source, isOutput = false, scaling = "fit", maxDpr = 2, showSafeArea = false, audio = false, onCapture }: StageViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const { w: cw, h: ch } = useSize(box);
  const output = useShow((s) => s.output);
  const W = Math.max(16, output.canvasWidth);
  const H = Math.max(16, output.canvasHeight);
  const sysDpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const rect = displayRect(scaling, cw, ch, W, H, sysDpr);
  // Render at the displayed size, never above the logical canvas resolution.
  const dpr = Math.max(0.25, Math.min(maxDpr, sysDpr, (W / Math.max(1, rect.w)) * 1.0001));
  // Horizontal squeeze of the displayed wall against its true proportions (Stretch only).
  const sx = rect.h > 0 ? rect.w / ((rect.h * W) / H) : 1;

  return (
    <div ref={box} className="relative h-full w-full overflow-hidden" style={{ background: "#000" }}>
      {cw > 0 && ch > 0 && (
        <div className="absolute overflow-hidden" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, background: output.backgroundColor }}>
          {source === "program" ? (
            <ProgramSlots W={W} H={H} dpr={dpr} sx={sx} isOutput={isOutput} audio={audio} />
          ) : (
            <PreviewSlot W={W} H={H} dpr={dpr} onCapture={onCapture} />
          )}
          {source === "program" && (
            <WallBox sx={sx} z={9}>
              <TimerOverlay h={rect.h} />
            </WallBox>
          )}
          {output.testPattern && (source === "program" || !isOutput) && <TestPattern W={W} H={H} />}
          {showSafeArea && output.safeArea.enabled && <SafeArea W={W} H={H} pct={output.safeArea.marginPct} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- preview

/** The preview runtime, cut down to one component when Build isolates it, or without the ones it hides. */
function useSoloRuntime(rt: SceneRuntime | null, solo: string | null, hidden: string[]) {
  const scene = rt?.scene;
  const filtered = useMemo(() => {
    if (scene && !solo && hidden.length) return { ...scene, components: scene.components.filter((c) => !hidden.includes(c.id)) };
    if (!scene || !solo || !scene.components.some((c) => c.id === solo)) return null;
    const comp = scene.components.find((c) => c.id === solo)!;
    // A media plate on its own shows on black; an environment look keeps its world.
    const keepWorld = comp.kind === "background" && comp.source === "environment";
    return { ...scene, components: [comp], environment: keepWorld ? scene.environment : ("none" as const) };
  }, [scene, solo, hidden]);
  // Only the scene matters to the canvas (it reads live state through getRt), so rebuild on scene changes, not every tick.
  const soloRt = useMemo(() => (rt && filtered ? { ...rt, scene: filtered } : null), [rt?.key, filtered]); // eslint-disable-line react-hooks/exhaustive-deps
  return soloRt ?? rt;
}

function PreviewSlot({ W, H, dpr, onCapture }: { W: number; H: number; dpr: number; onCapture?: (sceneId: string, d: string) => void }) {
  const fullRt = useShow((s) => s.preview);
  const solo = useShow((s) => s.solo);
  const hidden = useShow((s) => s.hidden);
  const rt = useSoloRuntime(fullRt, solo, hidden);
  const key = rt?.key;
  const assets = useShow((s) => s.assets);
  const targetFps = useShow((s) => s.output.targetFps);
  const bg = useShow((s) => s.output.backgroundColor);
  const getRt = useCallback(() => useShow.getState().preview, []);
  const getPoses = useCallback(() => {
    const s = useShow.getState();
    return { poses: s.previewPoses, at: s.previewPosesAt };
  }, []);
  const getTransition = useCallback(() => null, []);
  // No thumbnails from an isolated view: they would not show the scene. Reads the scene id at call
  // time so this callback (a SceneContent prop) keeps its identity across preview state updates.
  const capture = useCallback(
    (d: string) => {
      const cur = useShow.getState().preview;
      if (cur && !solo && !hidden.length) onCapture?.(cur.scene.id, d);
    },
    [solo, hidden, onCapture],
  );
  // Videos and clips sound in the preview only while Build's preview sound is on.
  const heard = usePreviewHeard();
  if (!rt) return <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">No scene selected</div>;
  return (
    <ErrorBoundary name="preview canvas" retryAfter={1500} fallback={null}>
    <SceneCanvas
      key={`${key}:${solo ?? ""}:${hidden.join(",")}`}
      role="preview"
      runtime={rt}
      getRt={getRt}
      getPoses={getPoses}
      getTransition={getTransition}
      assets={assets}
      canvasW={W}
      canvasH={H}
      isOutput={false}
      audio={heard}
      dpr={dpr}
      targetFps={Math.min(targetFps, 60)}
      background={bg}
      onCapture={onCapture ? capture : undefined}
    />
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------- program

interface SlotInfo {
  rt: SceneRuntime;
  role: SlotRole;
}

function transitionView(key: string): TransitionView | null {
  const tr = useShow.getState().program.transition;
  if (!tr) return null;
  const p = (now() - tr.startedAt) / Math.max(1, tr.spec.duration * 1000);
  return { spec: tr.spec, p, side: tr.from?.key === key ? "out" : "in" };
}

const ProgramSlots = memo(function ProgramSlots({ W, H, dpr, sx, isOutput, audio }: { W: number; H: number; dpr: number; sx: number; isOutput: boolean; audio: boolean }) {
  const program = useShow((s) => s.program);
  const assets = useShow((s) => s.assets);
  const output = useShow((s) => s.output);
  const slotEls = useRef(new Map<string, HTMLDivElement>());
  const blackRef = useRef<HTMLDivElement>(null);
  const blackoutRef = useRef<HTMLDivElement>(null);
  const standbyRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const slots: SlotInfo[] = [];
  const tr = program.transition;
  if (tr?.from) slots.push({ rt: tr.from, role: "outgoing" });
  if (program.runtime) slots.push({ rt: program.runtime, role: "live" });

  const videoAsset = tr?.spec.kind === "video" ? assets.find((a) => a.id === tr.spec.videoAssetId) : undefined;
  const audioAsset = tr?.spec.audioAssetId ? assets.find((a) => a.id === tr.spec.audioAssetId) : undefined;

  // Per-frame transition compositing via direct style writes (no React re-render).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = useShow.getState().program;
      const t = now();
      const tr = s.transition;
      const p = tr ? clamp((t - tr.startedAt) / Math.max(1, tr.spec.duration * 1000), 0, 1) : 1;
      const kind = tr?.spec.kind;
      let black = 0;
      for (const [key, el] of slotEls.current) {
        const isOut = !!tr && tr.from?.key === key;
        const isIn = s.runtime?.key === key;
        let o = isIn ? 1 : 0;
        if (tr) {
          if (kind === "crossfade") o = isIn ? smoothstep(0, 1, p) : 1;
          else if (kind === "fadeblack") o = isIn ? (p >= 0.5 ? 1 : 0) : p < 0.5 ? 1 : 0;
          else if (kind === "dissolve" || kind === "wipe" || kind === "burn") o = 1;
          else if (kind === "travel") o = isIn ? smoothstep(0.38, 0.62, p) : 1;
          else if (kind === "video") o = isIn ? (p > 0.85 ? 1 : 0) : p > 0.9 ? 0 : 1;
          if (isOut && tr.fromStandby) o = 0;
        }
        el.style.opacity = String(o);
        el.style.zIndex = isIn ? "2" : "1";
      }
      if (tr && kind === "fadeblack") black = p < 0.5 ? smoothstep(0, 0.5, p) : 1 - smoothstep(0.5, 1, p);
      if (blackRef.current) blackRef.current.style.opacity = String(black);
      if (blackoutRef.current) {
        const b = s.blackout;
        const k = b ? clamp((t - b.at) / Math.max(1, b.fade * 1000), 0, 1) : 1;
        blackoutRef.current.style.opacity = String(b ? (b.on ? k : 1 - k) : 0);
      }

      // Standby fades over the transition when leaving it, otherwise ~0.8 s.
      if (standbyRef.current) {
        const dur = !s.standby && tr?.fromStandby ? Math.max(400, tr.spec.duration * 1000) : 800;
        const k = clamp((t - s.standbyChangedAt) / dur, 0, 1);
        const v = s.standby ? k : 1 - k;
        standbyRef.current.style.opacity = String(s.runtime || s.standby ? v : 1);
      }

      const v = videoRef.current;
      if (v && tr && kind === "video") {
        const want = (t - tr.startedAt) / 1000;
        if (want >= 0) {
          if (Math.abs(v.currentTime - want) > 0.25 && !v.seeking) v.currentTime = want;
          if (v.paused) void v.play().catch(() => {});
        }
        const fadeIn = clamp(want / 0.15, 0, 1);
        const fadeOut = 1 - smoothstep(0.9, 1, p);
        v.style.opacity = String(fadeIn * fadeOut);
        // A travel video starts on the outgoing plate and ends on the incoming one:
        // glide its vertical framing between the two plates' framings so both ends line up.
        const a0 = tr.from ? plateAnchorY(tr.from) : 0.5;
        const a1 = s.runtime ? plateAnchorY(s.runtime) : 0.5;
        v.style.objectPosition = `50% ${((a0 + (a1 - a0) * smoothstep(0, 1, p)) * 100).toFixed(2)}%`;
      }
      const a = audioRef.current;
      if (a && tr) {
        const want = (t - tr.startedAt) / 1000;
        if (want >= 0 && a.paused && want < (a.duration || 1e9)) {
          a.currentTime = want;
          void a.play().catch(() => {});
        }
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  const st = output.standby;
  const standbyImg = st.assetId ? assets.find((a) => a.id === st.assetId) : undefined;

  return (
    <>
      {slots.map((s) => (
        <div
          key={s.rt.key}
          ref={(el) => {
            if (el) slotEls.current.set(s.rt.key, el);
            else slotEls.current.delete(s.rt.key);
          }}
          className="absolute inset-0"
          style={{ opacity: 0 }}
        >
          <ProgramCanvas rt={s.rt} role={s.role} W={W} H={H} dpr={dpr} isOutput={isOutput} audio={audio && s.role === "live"} />
        </div>
      ))}
      {/* Above the program slots (1–2); the stacking inside matches the old z-indexes 5–8. */}
      <WallBox sx={sx} z={5}>
      {videoAsset && (
        <video
          key={`${program.takeCount}`}
          ref={videoRef}
          src={videoAsset.url}
          preload="auto"
          playsInline
          muted={!audio}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ zIndex: 5, opacity: 0 }}
        />
      )}
      {audio && audioAsset && <audio key={`a${program.takeCount}`} ref={audioRef} src={audioAsset.url} preload="auto" />}
      <div ref={blackRef} className="pointer-events-none absolute inset-0" style={{ background: "#000", opacity: 0, zIndex: 6 }} />
      <div ref={blackoutRef} className="pointer-events-none absolute inset-0" style={{ background: "#000", opacity: 0, zIndex: 8 }} />
      <div
        ref={standbyRef}
        className="pointer-events-none absolute inset-0 grid place-items-center"
        style={{ background: st.color, opacity: 1, zIndex: 7, containerType: "size" }}
      >
        {standbyImg ? (
          <img src={standbyImg.url} className={cn("h-full w-full", STANDBY_FIT[output.scaling])} alt="" />
        ) : (
          <div className="text-center" style={{ color: "#d9cfb8", fontFamily: "Georgia, 'Times New Roman', serif" }}>
            <div style={{ fontSize: "9cqh", letterSpacing: "0.35em", fontWeight: 400 }}>{st.text}</div>
            {st.subtext && <div style={{ fontSize: "4cqh", letterSpacing: "0.25em", opacity: 0.65, marginTop: "2cqh" }}>{st.subtext}</div>}
          </div>
        )}
      </div>
      </WallBox>
    </>
  );
});

/** The standby picture follows the output's Scaling: Stretch fills the whole wall, Fill crops to it, Fit / Native keep its shape. */
const STANDBY_FIT: Record<ScalingMode, string> = { stretch: "object-fill", fill: "object-cover", fit: "object-contain", native: "object-contain" };

/** Vertical framing of the scene's current media plate (0 = top, 1 = bottom). */
function plateAnchorY(rt: SceneRuntime): number {
  const bg = rt.scene.components.find((c) => c.id === rt.background.current);
  return bg?.kind === "background" && bg.source === "media" ? (bg.anchorY ?? 0.5) : 0.5;
}

function ProgramCanvas({ rt, role, W, H, dpr, isOutput, audio }: { rt: SceneRuntime; role: SlotRole; W: number; H: number; dpr: number; isOutput: boolean; audio: boolean }) {
  const key = rt.key;
  const assets = useShow((s) => s.assets);
  const targetFps = useShow((s) => s.output.targetFps);
  const bg = useShow((s) => s.output.backgroundColor);
  const last = useRef(rt);
  const getRt = useCallback(() => {
    const s = useShow.getState().program;
    const r = s.runtime?.key === key ? s.runtime : s.transition?.from?.key === key ? s.transition.from : null;
    if (r) last.current = r;
    return last.current;
  }, [key]);
  const getPoses = useCallback(() => {
    const s = useShow.getState();
    if (s.program.runtime?.key === key) return { poses: s.programPoses, at: s.posesAt };
    return { poses: s.fromPoses ?? {}, at: s.posesAt };
  }, [key]);
  const getTransition = useCallback(() => transitionView(key), [key]);
  // A render error in one scene must never blank the wall: the canvas rebuilds itself.
  return (
    <ErrorBoundary name={`${role} canvas`} retryAfter={1200} fallback={null}>
    <SceneCanvas
      role={role}
      runtime={rt}
      getRt={getRt}
      getPoses={getPoses}
      getTransition={getTransition}
      assets={assets}
      canvasW={W}
      canvasH={H}
      isOutput={isOutput}
      audio={audio}
      dpr={dpr}
      targetFps={targetFps}
      background={bg}
    />
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------- overlays

function SafeArea({ W, H, pct }: { W: number; H: number; pct: number }) {
  const mx = (W * pct) / 100;
  const my = (H * pct) / 100;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ zIndex: 20 }}>
      <rect x={mx} y={my} width={W - 2 * mx} height={H - 2 * my} fill="none" stroke="rgba(255,210,80,0.7)" strokeWidth={H / 360} strokeDasharray={`${H / 60} ${H / 90}`} vectorEffect="non-scaling-stroke" />
      <line x1={W / 2} y1={H / 2 - H / 30} x2={W / 2} y2={H / 2 + H / 30} stroke="rgba(255,210,80,0.6)" vectorEffect="non-scaling-stroke" />
      <line x1={W / 2 - H / 30} y1={H / 2} x2={W / 2 + H / 30} y2={H / 2} stroke="rgba(255,210,80,0.6)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TestPattern({ W, H }: { W: number; H: number }) {
  const cols = 16;
  const rows = Math.max(2, Math.round((16 * H) / W));
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  const fs = H / 18;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ zIndex: 30 }}>
      <rect width={W} height={H} fill="#202020" />
      {bars.map((c, i) => (
        <rect key={c} x={(W * 0.2) + (i * W * 0.6) / bars.length} y={H * 0.62} width={(W * 0.6) / bars.length} height={H * 0.16} fill={c} />
      ))}
      {Array.from({ length: cols + 1 }, (_, i) => (
        <line key={`v${i}`} x1={(i * W) / cols} y1={0} x2={(i * W) / cols} y2={H} stroke="#6a6a6a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={(i * H) / rows} x2={W} y2={(i * H) / rows} stroke="#6a6a6a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      ))}
      <ellipse cx={W / 2} cy={H / 2} rx={H * 0.45} ry={H * 0.45} fill="none" stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke" />
      {[0.1, 0.9].map((fx) => (
        <circle key={fx} cx={W * fx} cy={H / 2} r={H * 0.18} fill="none" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      ))}
      <rect x={1} y={1} width={W - 2} height={H - 2} fill="none" stroke="#ff2a2a" strokeWidth={4} vectorEffect="non-scaling-stroke" />
      <text x={W / 2} y={H * 0.35} fill="#fff" fontSize={fs} textAnchor="middle" fontFamily="monospace">
        {W} × {H}
      </text>
      <text x={W / 2} y={H * 0.35 + fs * 1.3} fill="#bbb" fontSize={fs * 0.6} textAnchor="middle" fontFamily="monospace">
        {(W / H).toFixed(3)} : 1 — SALVATION LIVE STUDIO
      </text>
    </svg>
  );
}
