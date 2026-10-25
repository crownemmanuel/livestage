// Tools under and on top of the preview monitor: framing (zoom + reposition the view,
// which is what TAKE LIVE starts from) and a scrubber for the videos in the scene.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { ChevronRight, Clock, Crosshair, Eye, Film, Flag, Focus, MousePointer2, Pause, Play, Plus, Scan, Send, X, Zap, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { sceneNow } from "@/core/clock";
import { NO_FRAMING, clampFraming, evalFraming } from "@/core/runtime";
import { uid } from "@/core/ids";
import { markerHosts, setHostMarkers } from "@/core/markers";
import { defaultActorLayout } from "@/core/factories";
import type { Asset, Framing, MediaMarker, Scene, SceneComponent, SceneRuntime } from "@/core/types";
import { fitFrame } from "@/render/layers/MediaLayers";
import { describeMessage } from "@/engine/io";
import { previewAtStep } from "@/engine/operator";
import { hold, knownDuration, mainSource, mediaAssetIds, probeDurations, seekSource, videoSources, type Source } from "@/engine/transport";
import { useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { SelectBox } from "./fields";
import { defaultMessage } from "./io/MessageFields";
import { MarkersEditor } from "./io/MarkersEditor";
import { useSceneCodes } from "./SceneList";
import { assetAspect } from "./assetThumbs";

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
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* synthetic or already-released pointer */
        }
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
      <Scan className="mr-0.5 size-3.5 text-muted-foreground" />
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

/** Which video the scrub bar moves through (picked in the Media tab). */
export const useScrubSelection = create<{ key: string | null }>(() => ({ key: null }));

/** Pick a video to scrub; a clip that is not playing is put on its first frame. */
export function selectScrubSource(key: string) {
  useScrubSelection.setState({ key });
  const rt = useShow.getState().preview;
  if (!rt) return;
  const src = videoSources(rt, useShow.getState().assets).find((s) => s.key === key);
  if (src && !src.playing) useShow.getState().dispatch("preview", src.seek(0));
}

export function useAssetDurations(assets: Asset[], ids: string[]) {
  const [, force] = useState(0);
  useEffect(() => {
    if (ids.every((id) => knownDuration(id) !== undefined)) return;
    let alive = true;
    void probeDurations(assets, ids).then(() => alive && force((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [assets, ids.join("|")]);
}

export { videoSources, type Source };

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// ---------------------------------------------------------------- Build: what the preview shows

/** Says whether the preview is the whole scene or one isolated component, and at which step. */
export function PreviewHeader() {
  const rt = useShow((s) => s.preview);
  const solo = useShow((s) => s.solo);
  const hidden = useShow((s) => s.hidden);
  const codes = useSceneCodes();
  if (!rt) return null;
  const comp = solo ? rt.scene.components.find((c) => c.id === solo) : null;
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[11.5px]">
      <span className="flex items-center gap-1.5 rounded-full bg-preview/15 px-2 py-0.5 font-key text-[12.5px] font-bold text-preview">
        <span className="size-2 rounded-full bg-preview" />
        Preview
      </span>
      {comp ? (
        <>
          <span className="flex items-center gap-1 rounded-full bg-armed/15 px-2 py-0.5 font-medium text-armed">
            <Focus className="size-3.5" /> Isolated: {comp.name}
          </span>
          <Button size="xs" variant="ghost" className="h-6" onClick={() => useShow.getState().setSolo(null)}>
            <X /> Show whole scene
          </Button>
        </>
      ) : hidden.length ? (
        <>
          <span className="min-w-0 truncate text-muted-foreground">
            Scene <span className="font-key font-semibold">{codes.get(rt.scene.id)}</span> with {hidden.length} hidden
          </span>
          <Button size="xs" variant="ghost" className="h-6" onClick={() => useShow.setState({ hidden: [] })}>
            <Eye /> Show all
          </Button>
        </>
      ) : (
        <span className="min-w-0 truncate text-muted-foreground">
          Whole scene · <span className="font-key font-semibold">{codes.get(rt.scene.id)}</span> <span className="text-foreground/85">{rt.scene.name}</span>
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground" title="Edits here never reach the wall until the scene is taken live in Show Mode">
        not on the wall
      </span>
    </div>
  );
}

/** Start · 1 · 2 …: click a step to see the scene as it looks after that cue. */
export function StepBar() {
  const rt = useShow((s) => s.preview);
  if (!rt) return null;
  const cues = rt.scene.cues;
  const at = rt.cuePointer;
  const pill = (i: number, label: string, title: string, auto?: boolean) => (
    <button
      key={i}
      type="button"
      title={title}
      onClick={() => previewAtStep(i)}
      className={cn(
        "flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors",
        i === at ? "border-preview bg-preview/15 text-foreground" : i < at ? "border-border bg-accent/40 text-muted-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {i === 0 ? <Flag className="size-3 shrink-0" /> : <span className="font-key font-bold tabular">{i}</span>}
      <span className="truncate">{label}</span>
      {auto && <Zap className="size-3 shrink-0 text-armed" />}
    </button>
  );
  return (
    <div className="mt-1.5 flex items-center gap-1 overflow-x-auto pb-0.5">
      <span className="mr-1 shrink-0 text-[10.5px] text-muted-foreground">Show at</span>
      {pill(0, "Start", "The scene as it goes live, before any cue")}
      {cues.map((c, i) => [<ChevronRight key={`a${i}`} className="size-3 shrink-0 text-muted-foreground/50" />, pill(i + 1, c.name, `After cue ${i + 1}: ${c.name}`, !!c.fire && c.fire.mode !== "go")])}
    </div>
  );
}

/**
 * Timeline for one video of a running scene: drag to scrub, see its markers as ticks, add a
 * marker at the playhead (Build). Follows the isolated component when there is one.
 * `editable` off (Show Mode): scrub and jump to markers only.
 *
 * `target="program"` is the live wall's transport: Hold / Resume, and scrubbing only while held.
 * A live scrub moves a ghost playhead and lands once, on release, so the audience sees one cut
 * to the chosen frame rather than the whole scrub.
 */
/** Show Mode's clip picker: just a film icon (the clip's name on hover), a menu only when there is a choice. */
function ClipPicker({ value, sources, onChange }: { value: string; sources: { key: string; label: string; playing: boolean }[]; onChange: (k: string) => void }) {
  const cur = sources.find((s) => s.key === value);
  const icon = <Film className="size-3.5" />;
  if (sources.length < 2)
    return (
      <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground" title={cur?.label}>
        {icon}
      </span>
    );
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-6 w-auto shrink-0 gap-0.5 border-transparent bg-transparent px-1 text-muted-foreground hover:border-input [&_svg]:size-3.5" title={`${cur?.label ?? "Clip"} (${sources.length} clips: pick which one the bar scrubs)`} aria-label="Clip to scrub">
        {icon}
      </SelectTrigger>
      <SelectContent>
        {sources.map((s) => (
          <SelectItem key={s.key} value={s.key} className="text-[12px]">
            {s.label + (s.playing ? "" : " (not playing)")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Timeline({ editable = true, target = "preview" }: { editable?: boolean; target?: Target }) {
  const live = target === "program";
  const rt = useShow((s) => (live ? (s.program.standby ? null : s.program.runtime) : s.preview));
  const assets = useShow((s) => s.assets);
  const soloPreview = useShow((s) => s.solo);
  const solo = live ? null : soloPreview;
  const pickedPreview = useScrubSelection((s) => s.key);
  const [pickedLive, setPickedLive] = useState<string | null>(null);
  const sel = live ? pickedLive : pickedPreview;
  const projectScene = useProject((s) => (rt && !live ? s.project.scenes.find((x) => x.id === rt.scene.id) : undefined));
  // The live wall plays its own snapshot of the scene (markers as taken).
  const sceneDef = live ? rt?.scene : projectScene;
  const [drag, setDrag] = useState<{ v: number; src: Source } | null>(null);
  // The ref is current within one event burst (state lags a render), so a fast scrub never loses its start.
  const dragRef = useRef<{ v: number; src: Source } | null>(null);
  const [open, setOpen] = useState(false);
  // A marker tick being dragged: where it would land (seconds), and whether it has moved yet.
  const [mDrag, setMDrag] = useState<{ id: string; at: number; x0: number; moved: boolean } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  useTick(120);
  const ids = rt ? mediaAssetIds(rt) : [];
  useAssetDurations(assets, ids);
  if (!rt || !sceneDef) return null;
  const all = videoSources(rt, assets);
  const sources = solo && all.some((s) => s.key.split(":")[0] === solo) ? all.filter((s) => s.key.split(":")[0] === solo) : all;
  const clock = sceneNow(rt) / 1000;
  const dispatch = useShow.getState().dispatch;
  const paused = rt.clock.pausedAt !== null;
  const holdButton = live && (
    <Button
      size="xs"
      className={cn("h-7 shrink-0 gap-1 px-2 font-key text-[12.5px] font-bold", paused ? "bg-live text-white hover:bg-live/85" : "bg-armed/90 text-black hover:bg-armed")}
      title={paused ? "Resume the live wall from this frame (P)" : "Hold the live wall on this frame: video, its sound and effects (P)"}
      aria-label={paused ? "Resume live" : "Hold live"}
      onClick={() => {
        endScrub(false);
        hold("program", paused ? "resume" : "pause");
      }}
    >
      {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
      {paused ? "Resume" : "Hold"}
    </Button>
  );
  if (!sources.length && !drag) {
    if (live)
      return (
        <div className="mt-2 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          {holdButton}
          <Clock className="size-3.5" /> scene {fmt(Math.max(0, clock))} · no video to scrub
          {paused && <span className="font-semibold text-armed">HELD</span>}
        </div>
      );
    if (!editable) return null;
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
        <Clock className="size-3.5" /> Scene clock {fmt(Math.max(0, clock))} · no video playing to put markers on
      </div>
    );
  }
  const src = drag?.src ?? mainSource(sources, sel)!;
  const pos = drag ? drag.v : src.pos;
  // The live wall scrubs only while held; the preview pauses itself when you scrub.
  const canScrub = !live || paused;
  // Scrubbing, jumping to a marker or adding one stops the preview, and it stays stopped until Play.
  function pause() {
    if (!live) hold("preview", "pause");
  }
  function startScrub() {
    if (dragRef.current) return dragRef.current;
    pause();
    dragRef.current = { v: src.pos, src };
    setDrag(dragRef.current);
    return dragRef.current;
  }
  function endScrub(commit = true) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    // Live: one jump, on release.
    if (commit && live && d) seekSource("program", d.src, d.v);
  }
  const jump = (v: number) => {
    pause();
    seekSource(target, src, v);
  };
  const host = markerHosts(sceneDef).find((h) => h.key === src.key);
  const markers = host?.markers ?? [];
  const cues = sceneDef.cues;
  const setMarkers = (m: MediaMarker[]) => useProject.getState().updateScene(sceneDef.id, (s) => setHostMarkers(s, src.key, m));
  const addMarker = () => {
    pause();
    const at = Math.round(pos * 10) / 10;
    setMarkers([...markers, { id: uid("mk"), name: `Marker ${markers.length + 1}`, at, message: defaultMessage("hog"), cueId: null }]);
    setOpen(true);
  };
  const describe = (m: MediaMarker) => {
    const i = m.cueId ? cues.findIndex((c) => c.id === m.cueId) : -1;
    return `${m.name} · ${m.at.toFixed(1)} s → ${i >= 0 ? `cue ${i + 1}: ${cues[i].name}` : m.cueId ? "missing cue" : describeMessage(m.message)}`;
  };
  const pct = (v: number) => `${(Math.min(v, src.duration) / src.duration) * 100}%`;

  return (
    <div className={cn("mt-2 rounded-md border bg-black/20 px-2 pb-1.5 pt-1", live && paused ? "border-armed/70" : "border-border")}>
      <div className="flex items-center gap-2 text-[11px]">
        {holdButton}
        {editable && (
        <Button size="icon-xs" variant="ghost" className="size-6 shrink-0" title={paused ? "Play the preview" : "Pause the preview"} aria-label={paused ? "Play" : "Pause"} onClick={() => {
            endScrub(false);
            dispatch("preview", { type: "clock", op: paused ? "resume" : "pause" });
          }}>
          {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
        </Button>
        )}
        {editable ? (
          <>
            <Film className="size-3.5 shrink-0 text-muted-foreground" />
            <SelectBox
              className="h-6 w-auto max-w-[260px] min-w-0 border-transparent bg-transparent px-1 text-[11.5px] font-medium hover:border-input"
              value={src.key}
              onChange={(k) => (live ? setPickedLive(k) : selectScrubSource(k))}
              options={sources.map((s) => ({ value: s.key, label: s.label + (s.playing ? "" : " (not playing)") }))}
            />
          </>
        ) : (
          <ClipPicker value={src.key} sources={sources} onChange={(k) => (live ? setPickedLive(k) : selectScrubSource(k))} />
        )}
        <span className={cn("shrink-0 tabular", drag && live ? "font-semibold text-armed" : "text-muted-foreground")}>
          {fmt(pos)} / {fmt(src.duration)}
        </span>
        {live && paused && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5" title="Step the held wall back or forward">
            {[-5, -1, 1, 5].map((d) => (
              <Button key={d} size="xs" variant="ghost" className="h-6 px-1.5 text-[10.5px] tabular" onClick={() => jump(src.pos + d)}>
                {d > 0 ? `+${d}` : d}s
              </Button>
            ))}
          </span>
        )}
        {live && !paused && <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">Hold to scrub the wall</span>}
        {editable && (
          <>
            <span className="ml-auto flex items-center gap-1 tabular text-muted-foreground" title="Time since the scene started in the preview">
              <Clock className="size-3" /> scene {fmt(Math.max(0, clock))}
            </span>
            <Button size="xs" variant="outline" className="h-6 border-armed/50 text-armed hover:text-armed" onClick={addMarker} title="Add a marker at the playhead">
              <Plus /> Marker at {pos.toFixed(1)} s
            </Button>
          </>
        )}
      </div>
      <div ref={track} className={cn("relative mt-1 h-6", !canScrub && "opacity-70")} title={canScrub ? undefined : "Hold the wall first (P), then scrub"}>
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <div className={cn("absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full", live ? "bg-live/70" : "bg-preview/70")} style={{ width: pct(live && drag ? src.pos : pos) }} />
        {markers.map((m) => {
          const dragging = mDrag?.id === m.id;
          const at = dragging ? mDrag.at : m.at;
          const timeAt = (clientX: number) => {
            const r = track.current!.getBoundingClientRect();
            return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * src.duration * 10) / 10;
          };
          return (
            <button
              key={m.id}
              type="button"
              title={editable ? `${describe(m)} · drag to move` : canScrub ? `${describe(m)} · click to jump here` : describe(m)}
              className={cn("absolute top-0 z-10 -translate-x-1/2 touch-none", editable && (dragging ? "cursor-grabbing" : "cursor-grab"), !canScrub && "pointer-events-none")}
              style={{ left: pct(at) }}
              onPointerDown={(e) => {
                if (!editable || e.button !== 0) return;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* synthetic or already-released pointer */
                }
                pause();
                setMDrag({ id: m.id, at: m.at, x0: e.clientX, moved: false });
              }}
              onPointerMove={(e) => {
                if (!dragging) return;
                if (!mDrag.moved && Math.abs(e.clientX - mDrag.x0) < 3) return;
                const t = timeAt(e.clientX);
                setMDrag({ ...mDrag, at: t, moved: true });
                // Show the frame the marker is landing on.
                dispatch("preview", src.seek(t));
              }}
              onPointerUp={() => {
                if (!dragging) return;
                if (mDrag.moved) setMarkers(markers.map((x) => (x.id === m.id ? { ...x, at: mDrag.at } : x)));
                else dispatch("preview", src.seek(m.at));
                setMDrag(null);
                setOpen(true);
              }}
              onPointerCancel={() => setMDrag(null)}
              onClick={() => {
                // Show Mode (not editable): a click jumps to the marker.
                if (!editable) jump(m.at);
              }}
            >
              <span className={cn("block size-2.5 rotate-45 rounded-[2px] border border-black/60", m.cueId ? "bg-preview" : "bg-armed", dragging && mDrag.moved && "scale-125 ring-2 ring-foreground/70")} />
              <span className="mx-auto mt-0.5 block h-2.5 w-px bg-armed/70" />
              {dragging && mDrag.moved && <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1 text-[10px] tabular text-white">{mDrag.at.toFixed(1)} s</span>}
            </button>
          );
        })}
        <input
          type="range"
          min={0}
          max={src.duration}
          step={0.01}
          value={Math.min(pos, src.duration)}
          aria-label={live ? "Scrub the live wall" : "Scrub"}
          disabled={!canScrub}
          className={cn("absolute inset-0 h-6 w-full opacity-0", canScrub ? "cursor-pointer" : "cursor-not-allowed")}
          // Pointer, mouse and touch all start a scrub: WebKit's range input does not always send pointer events.
          onPointerDown={startScrub}
          onMouseDown={startScrub}
          onTouchStart={startScrub}
          onChange={(e) => {
            const d = startScrub();
            d.v = +e.target.value;
            setDrag({ ...d });
            if (!live) dispatch("preview", d.src.seek(d.v));
          }}
          onPointerUp={() => endScrub()}
          onMouseUp={() => endScrub()}
          onTouchEnd={() => endScrub()}
          onBlur={() => endScrub()}
          onKeyUp={() => live && endScrub()}
        />
        {live && drag && <span className="pointer-events-none absolute top-0 h-6 w-0.5 -translate-x-1/2 rounded bg-foreground/40" style={{ left: pct(src.pos) }} />}
        <span className={cn("pointer-events-none absolute top-0 h-6 w-0.5 -translate-x-1/2 rounded", live && drag ? "bg-armed" : "bg-foreground")} style={{ left: pct(pos) }} />
      </div>
      {editable && (
      <button type="button" className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {markers.length ? `${markers.length} marker${markers.length > 1 ? "s" : ""} on this video` : "No markers on this video yet"}
        <span className="ml-1 flex items-center gap-1 text-[10.5px]">
          <span className="size-2 rotate-45 bg-preview" /> runs a cue <span className="ml-1 size-2 rotate-45 bg-armed" /> sends lighting / MIDI / OSC
        </span>
      </button>
      )}
      {editable && open && (
        <div className="mt-1.5">
          <MarkersEditor markers={markers} onChange={setMarkers} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Build: select and move

/** Build's preview tool: select-and-move components, or zoom / frame the view. */
export const usePreviewTool = create<{ tool: "select" | "frame" }>(() => ({ tool: "select" }));

export function ToolToggle() {
  const tool = usePreviewTool((s) => s.tool);
  const btn = (t: "select" | "frame", icon: React.ReactNode, title: string) => (
    <Button size="icon-xs" variant={tool === t ? "secondary" : "ghost"} className="size-6" title={title} aria-label={title} aria-pressed={tool === t} onClick={() => usePreviewTool.setState({ tool: t })}>
      {icon}
    </Button>
  );
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {btn("select", <MousePointer2 />, "Select and move (V): click an item in the preview, drag to move it")}
      {btn("frame", <ZoomIn />, "Zoom and frame (Z): drag to reposition the view, scroll to zoom")}
    </div>
  );
}

/** A movable item's box in picture coordinates (0..1, y down). */
interface Box {
  id: string;
  name: string;
  rank: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

function itemBoxes(scene: Scene, rt: SceneRuntime, W: number, H: number, skip: (id: string) => boolean): Box[] {
  const out: Box[] = [];
  scene.components.forEach((c, i) => {
    if (skip(c.id)) return;
    if ((c.kind === "video" || c.kind === "image") && c.placement !== "world") {
      if (!rt.layers[c.id]?.visible) return;
      const cw = 1 - c.crop.left - c.crop.right;
      const ch = 1 - c.crop.top - c.crop.bottom;
      const aspect = ((assetAspect(c.kind === "image" ? c.assetId : c.media.assetId) ?? 16 / 9) * Math.max(0.01, cw)) / Math.max(0.01, ch);
      const w = c.screen.width;
      out.push({ id: c.id, name: c.name, rank: (c.placement === "front" ? 20 : 0) + i / 1000, cx: c.screen.x, cy: c.screen.y, w, h: (w * W) / aspect / H });
    } else if (c.kind === "text") {
      if (!rt.layers[c.id]?.visible) return;
      const lines = c.text.split("\n");
      const longest = Math.max(1, ...lines.map((l) => l.length));
      const w = c.width > 0 ? c.width : Math.min(1, (longest * c.size * H * 0.55) / W);
      out.push({ id: c.id, name: c.name, rank: 30 + i / 1000, cx: c.x, cy: c.y, w, h: lines.length * c.size * Math.max(1, c.lineHeight) });
    } else if (c.kind === "clipActor" && c.matted) {
      const { w, h, cy } = fitFrame(c.fit, c.frameAspect, W, H, c.anchorY ?? 0.5);
      const L = c.layout ?? defaultActorLayout();
      const s = Math.max(0.05, L.scale);
      const tv = (L.depthLink ? L.horizonY + (L.pivotY - L.horizonY) * s : L.pivotY) + L.y;
      const tu = L.pivotX + L.x;
      const offU = (L.mirror ? 0.5 - L.pivotX : L.pivotX - 0.5) * w * s;
      const X = (tu - 0.5) * w - offU;
      const Y = cy + (0.5 - tv) * h - (0.5 - L.pivotY) * h * s;
      out.push({ id: c.id, name: c.name, rank: 10 + i / 1000, cx: 0.5 + X / W, cy: 0.5 - Y / H, w: (w * s) / W, h: (h * s) / H });
    }
  });
  return out;
}

/** Move one component by (du, dv) in picture units, from its value when the drag began. */
function moveComponent(start: SceneComponent, du: number, dv: number, W: number, H: number): (c: SceneComponent) => void {
  return (c) => {
    if ((c.kind === "video" || c.kind === "image") && (start.kind === "video" || start.kind === "image")) {
      c.screen.x = start.screen.x + du;
      c.screen.y = start.screen.y + dv;
    } else if (c.kind === "text" && start.kind === "text") {
      c.x = start.x + du;
      c.y = start.y + dv;
    } else if (c.kind === "clipActor" && start.kind === "clipActor") {
      const { w, h } = fitFrame(start.fit, start.frameAspect, W, H, start.anchorY ?? 0.5);
      const L = start.layout ?? defaultActorLayout();
      c.layout = { ...L, x: L.x + (du * W) / w, y: L.y + (dv * H) / h };
    }
  };
}

/** Select tool over the Build preview: hover outlines movable items, click selects, drag moves. */
export function SelectOverlay() {
  const ref = useRef<HTMLDivElement>(null);
  const rt = useShow((s) => s.preview);
  const solo = useShow((s) => s.solo);
  const hidden = useShow((s) => s.hidden);
  const output = useShow((s) => s.output);
  const selectedId = useProject((s) => s.selectedComponentId);
  const scene = useProject((s) => (rt ? s.project.scenes.find((x) => x.id === rt.scene.id) : undefined));
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ id: string; u0: number; v0: number; start: SceneComponent; moved: boolean; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useTick(250);
  if (!rt || !scene) return null;
  const W = Math.max(16, output.canvasWidth);
  const H = Math.max(16, output.canvasHeight);
  const f = evalFraming(rt.framing, sceneNow(rt));
  const boxes = itemBoxes(scene, rt, W, H, (id) => hidden.includes(id) || (!!solo && id !== solo));
  // Picture coords of a pointer (undoing the preview's zoom).
  const pic = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    return { u: f.x + (px - 0.5) / f.zoom, v: f.y + (py - 0.5) / f.zoom };
  };
  const hit = (u: number, v: number) =>
    boxes.filter((b) => Math.abs(u - b.cx) <= b.w / 2 && Math.abs(v - b.cy) <= b.h / 2).sort((a, b) => b.rank - a.rank)[0] ?? null;
  const toScreen = (b: Box) => ({
    left: `${((b.cx - b.w / 2 - f.x) * f.zoom + 0.5) * 100}%`,
    top: `${((b.cy - b.h / 2 - f.y) * f.zoom + 0.5) * 100}%`,
    width: `${b.w * f.zoom * 100}%`,
    height: `${b.h * f.zoom * 100}%`,
  });
  const commit = (id: string, start: SceneComponent, du: number, dv: number) => useProject.getState().updateComponent(scene.id, id, moveComponent(start, du, dv, W, H));
  const shown = boxes.filter((b) => b.id === selectedId || b.id === hover);

  return (
    <div
      ref={ref}
      className={cn("absolute inset-0 z-10 select-none overflow-hidden", dragging ? "cursor-grabbing" : hover ? "cursor-move" : "cursor-default")}
      onPointerMove={(e) => {
        const { u, v } = pic(e);
        const d = drag.current;
        if (!d) return setHover(hit(u, v)?.id ?? null);
        const du = u - d.u0;
        const dv = v - d.v0;
        if (!d.moved && Math.hypot(du, dv) < 0.004) return;
        d.moved = true;
        // Every move clones the show; ~25 updates a second is smooth enough and cheap.
        if (performance.now() - d.last > 40) {
          d.last = performance.now();
          commit(d.id, d.start, du, dv);
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const { u, v } = pic(e);
        const b = hit(u, v);
        useProject.getState().selectComponent(b?.id ?? null);
        if (!b) return;
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* synthetic or already-released pointer */
        }
        const start = structuredClone(scene.components.find((c) => c.id === b.id)!);
        drag.current = { id: b.id, u0: u, v0: v, start, moved: false, last: 0 };
        setDragging(true);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (d?.moved) {
          const { u, v } = pic(e);
          commit(d.id, d.start, u - d.u0, v - d.v0);
        }
        drag.current = null;
        setDragging(false);
      }}
      onPointerLeave={() => !drag.current && setHover(null)}
      onWheel={(e) => {
        // Scroll still zooms, as with the frame tool.
        const r = ref.current!.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        const zoom = Math.min(6, Math.max(1, f.zoom * Math.exp(-e.deltaY * 0.0015)));
        const ux = f.x + (px - 0.5) / f.zoom;
        const uy = f.y + (py - 0.5) / f.zoom;
        commitFraming({ zoom, x: ux - (px - 0.5) / zoom, y: uy - (py - 0.5) / zoom });
      }}
    >
      {shown.map((b) => (
        <div key={b.id} className={cn("pointer-events-none absolute rounded-[2px] border", b.id === selectedId ? "border-2 border-sky-400" : "border-dashed border-sky-300/70")} style={toScreen(b)}>
          <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-sky-500 px-1 text-[10px] font-medium text-white">{b.name}</span>
        </div>
      ))}
    </div>
  );
}
