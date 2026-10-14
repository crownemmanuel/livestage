// Tools under and on top of the preview monitor: framing (zoom + reposition the view,
// which is what TAKE LIVE starts from) and a scrubber for the videos in the scene.
import { useEffect, useRef, useState } from "react";
import { Crosshair, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sceneNow } from "@/core/clock";
import { clipStateAt } from "@/core/clipActor";
import { playableUrl } from "@/core/platform";
import { NO_FRAMING, clampFraming, evalFraming, mediaElapsed, type Command } from "@/core/runtime";
import type { Asset, Framing, SceneRuntime } from "@/core/types";
import { probeDuration } from "@/engine/operator";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";

function useTick(ms: number) {
  const [, force] = useState(0);
  useEffect(() => {
    const h = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
}

// ---------------------------------------------------------------- framing

function previewFraming(): Framing {
  const rt = useShow.getState().preview;
  return rt ? evalFraming(rt.framing, sceneNow(rt)) : NO_FRAMING;
}

function setPreviewFraming(f: Framing) {
  useShow.getState().dispatch("preview", { type: "framing", ...clampFraming(f), duration: 0, delay: 0 });
}

/** Save as the scene's starting framing: TAKE LIVE starts from it. */
export function commitFraming(f: Framing) {
  const rt = useShow.getState().preview;
  if (!rt) return;
  const c = clampFraming(f);
  setPreviewFraming(c);
  useProject.getState().updateScene(rt.scene.id, (s) => {
    if (c.zoom <= 1.0001) delete s.framing;
    else s.framing = c;
  });
}

const same = (a: Framing, b: Framing) => Math.abs(a.zoom - b.zoom) < 0.005 && Math.abs(a.x - b.x) < 0.002 && Math.abs(a.y - b.y) < 0.002;

/** Drag to reposition, scroll to zoom about the cursor, double-click to centre on a point. */
export function FramingOverlay() {
  const ref = useRef<HTMLDivElement>(null);
  const rt = useShow((s) => s.preview);
  const drag = useRef<{ x: number; y: number; f: Framing; moved: boolean } | null>(null);
  const wheelCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragging, setDragging] = useState(false);
  if (!rt) return null;
  const f = evalFraming(rt.framing, sceneNow(rt));
  const zoomed = f.zoom > 1.001;
  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { px: (e.clientX - r.left) / r.width, py: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  };

  return (
    <div
      ref={ref}
      className={cn("absolute inset-0 z-10 select-none", zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, f: previewFraming(), moved: false };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const { w, h } = local(e);
        const dx = (e.clientX - d.x) / w;
        const dy = (e.clientY - d.y) / h;
        if (Math.abs(dx) + Math.abs(dy) > 0.002) d.moved = true;
        // Drag the picture: moving it right shows more of the left.
        setPreviewFraming({ zoom: d.f.zoom, x: d.f.x - dx / d.f.zoom, y: d.f.y - dy / d.f.zoom });
      }}
      onPointerUp={() => {
        if (drag.current?.moved) commitFraming(previewFraming());
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={(e) => {
        const cur = previewFraming();
        const { px, py } = local(e);
        const zoom = cur.zoom > 1.001 ? cur.zoom : 2;
        commitFraming({ zoom, x: cur.x + (px - 0.5) / cur.zoom, y: cur.y + (py - 0.5) / cur.zoom });
      }}
      onWheel={(e) => {
        const cur = previewFraming();
        const { px, py } = local(e);
        const zoom = Math.min(6, Math.max(1, cur.zoom * Math.exp(-e.deltaY * 0.0015)));
        // Keep the point under the cursor where it is.
        const ux = cur.x + (px - 0.5) / cur.zoom;
        const uy = cur.y + (py - 0.5) / cur.zoom;
        setPreviewFraming({ zoom, x: ux - (px - 0.5) / zoom, y: uy - (py - 0.5) / zoom });
        if (wheelCommit.current) clearTimeout(wheelCommit.current);
        wheelCommit.current = setTimeout(() => commitFraming(previewFraming()), 250);
      }}
    >
      {zoomed && (
        <>
          <Crosshair className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-white/80 drop-shadow" />
          <MiniMap f={f} />
        </>
      )}
    </div>
  );
}

/** Where the zoomed view sits in the full picture. */
function MiniMap({ f }: { f: Framing }) {
  const w = 1 / f.zoom;
  return (
    <div className="pointer-events-none absolute bottom-1.5 right-1.5 h-[22%] w-[18%] rounded-sm border border-white/50 bg-black/40">
      <div className="absolute border-2 border-preview" style={{ left: `${(f.x - w / 2) * 100}%`, top: `${(f.y - w / 2) * 100}%`, width: `${w * 100}%`, height: `${w * 100}%` }} />
    </div>
  );
}

const ZOOMS = [1, 1.5, 2, 3];

/** Zoom buttons + framing read-out + apply-to-live. */
export function FramingBar() {
  const rt = useShow((s) => s.preview);
  const program = useShow((s) => s.program);
  useTick(300);
  if (!rt) return null;
  const f = evalFraming(rt.framing, sceneNow(rt));
  const isLive = !!program.runtime && !program.standby && program.runtime.scene.id === rt.scene.id;
  const liveF = isLive ? evalFraming(program.runtime!.framing, sceneNow(program.runtime!)) : null;
  const zoomTo = (z: number) => commitFraming(z === 1 ? NO_FRAMING : { zoom: z, x: f.x, y: f.y });
  return (
    <div className="flex items-center gap-1" title="Framing: drag the preview to reposition, scroll to zoom, double-click to centre. TAKE LIVE starts from this framing.">
      <span className="mr-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">Framing</span>
      {ZOOMS.map((z) => (
        <Button key={z} size="xs" variant={Math.abs(f.zoom - z) < 0.01 ? "secondary" : "ghost"} className="h-5 px-1.5 text-[10.5px]" onClick={() => zoomTo(z)}>
          {z === 1 ? "Fit" : `${z}×`}
        </Button>
      ))}
      {ZOOMS.every((z) => Math.abs(f.zoom - z) >= 0.01) && <span className="tabular text-[10.5px] text-preview">{f.zoom.toFixed(2)}×</span>}
      {liveF && !same(f, liveF) && (
        <Button
          size="xs"
          className="h-5 bg-live px-1.5 text-[10.5px] text-white hover:bg-live/85"
          title="Glide the live output to this framing (1.5 s)"
          onClick={() => useShow.getState().dispatch("program", { type: "framing", ...f, duration: 1.5, delay: 0 })}
        >
          <Send /> Apply to live
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- video scrubber

const durationCache = new Map<string, number>();
const probing = new Set<string>();

function useAssetDurations(assets: Asset[], ids: string[]) {
  const [, force] = useState(0);
  useEffect(() => {
    for (const id of ids) {
      if (durationCache.has(id) || probing.has(id)) continue;
      const a = assets.find((x) => x.id === id);
      const url = playableUrl(a);
      if (!url) continue;
      probing.add(id);
      void probeDuration(url).then((d) => {
        probing.delete(id);
        if (d) durationCache.set(id, d);
        force((n) => n + 1);
      });
    }
  }, [assets, ids.join("|")]);
}

interface Source {
  key: string;
  label: string;
  duration: number;
  pos: number;
  /** The command that puts this video at v seconds. */
  seek: (v: number) => Command;
}

function videoSources(rt: SceneRuntime, assets: Asset[]): Source[] {
  const t = sceneNow(rt);
  const out: Source[] = [];
  const isVideo = (id: string | null) => !!id && assets.find((a) => a.id === id)?.type === "video";
  for (const c of rt.scene.components) {
    if (c.kind === "clipActor") {
      // Every clip can be scrubbed, playing or not: scrubbing puts the actor on that clip.
      const st = clipStateAt(c, rt.clipActors?.[c.id], t);
      for (const k of c.clips) {
        if (!k.assetId && !k.cutoutAssetId) continue;
        const active = st.clip?.id === k.id;
        out.push({
          key: `${c.id}:${k.id}`,
          label: `${c.name} · ${k.name}${active ? "" : " (not playing)"}`,
          duration: Math.max(0.05, k.duration),
          pos: active ? st.localT : 0,
          seek: (v) => ({ type: "clip.seek", actorId: c.id, clipId: k.id, offset: v }),
        });
      }
    } else if (c.kind === "background" && c.source === "media" && rt.background.current === c.id && isVideo(c.media.assetId)) {
      const D = durationCache.get(c.media.assetId!);
      if (!D) continue;
      const startAt = rt.background.changedAt > -1e8 ? rt.background.changedAt : 0;
      const rate = c.media.playbackRate || 1;
      const el = mediaElapsed(rt, c.id, startAt, t, rate);
      const iter = c.media.loop ? Math.floor(el / D) : 0;
      out.push({ key: c.id, label: `${c.name} (background)`, duration: D, pos: c.media.loop ? el % D : Math.min(el, D), seek: (v) => ({ type: "seek", t: Math.max(0, startAt + ((iter * D + v) / rate) * 1000) }) });
    } else if (c.kind === "video" && rt.layers[c.id]?.visible && isVideo(c.media.assetId)) {
      const D = durationCache.get(c.media.assetId!);
      if (!D) continue;
      const l = rt.layers[c.id];
      const rate = c.media.playbackRate || 1;
      const el = mediaElapsed(rt, c.id, l.startAt, t, rate);
      const iter = c.media.loop ? Math.floor(el / D) : 0;
      out.push({ key: c.id, label: c.name, duration: D, pos: c.media.loop ? el % D : Math.min(el, D), seek: (v) => ({ type: "seek", t: Math.max(0, l.startAt + ((iter * D + v) / rate) * 1000) }) });
    }
  }
  return out;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Scrub through the videos playing in the preview (moves the preview's scene clock). */
export function VideoScrubber() {
  const rt = useShow((s) => s.preview);
  const assets = useShow((s) => s.assets);
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ v: number; src: Source; wasPlaying: boolean } | null>(null);
  useTick(150);
  const ids = rt ? rt.scene.components.flatMap((c) => (c.kind === "background" || c.kind === "video" ? (c.media.assetId ? [c.media.assetId] : []) : [])) : [];
  useAssetDurations(assets, ids);
  if (!rt) return null;
  const sources = videoSources(rt, assets);
  if (!sources.length && !drag) return null;
  // Default: whatever is playing (preferring a clip a cue started over an idle loop), else the first video.
  const playing = sources.filter((s) => !s.label.endsWith("(not playing)"));
  const src = drag?.src ?? sources.find((s) => s.key === sel) ?? playing.find((s) => !s.label.includes("(loop)")) ?? playing[0] ?? sources[0];
  if (!src) return null;
  const pos = drag ? drag.v : src.pos;
  const dispatch = useShow.getState().dispatch;
  const scrub = (v: number, s: Source) => dispatch("preview", s.seek(v));

  return (
    <div className="mt-1.5 text-[11px]">
      {/* Full width, so a few pixels of travel are a small step in time. */}
      <input
        type="range"
        min={0}
        max={src.duration}
        step={0.01}
        value={Math.min(pos, src.duration)}
        className="block h-2 w-full cursor-pointer accent-[var(--preview)]"
        onPointerDown={() => {
          const live = useShow.getState().preview;
          const wasPlaying = !!live && live.clock.pausedAt === null;
          if (wasPlaying) dispatch("preview", { type: "clock", op: "pause" });
          setDrag({ v: src.pos, src, wasPlaying });
        }}
        onChange={(e) => {
          const v = +e.target.value;
          if (drag) setDrag({ ...drag, v });
          scrub(v, drag?.src ?? src);
        }}
        onPointerUp={() => {
          if (drag?.wasPlaying) dispatch("preview", { type: "clock", op: "resume" });
          setDrag(null);
        }}
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Scrub</span>
        <select
          className="h-6 min-w-0 max-w-[60%] flex-1 truncate rounded-md border border-input bg-background px-1 text-[11px]"
          value={src.key}
          title="Which video the scrub bar moves through"
          onChange={(e) => {
            setSel(e.target.value);
            const n = sources.find((s) => s.key === e.target.value);
            // Picking a clip that is not playing shows its first frame.
            if (n && n.label.endsWith("(not playing)")) scrub(0, n);
          }}
        >
          {sources.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="ml-auto shrink-0 whitespace-nowrap tabular text-muted-foreground">
          {fmt(pos)} / {fmt(src.duration)}
        </span>
      </div>
    </div>
  );
}
