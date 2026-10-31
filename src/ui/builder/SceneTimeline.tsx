// The scene as tracks under the Build preview: what plays when, cue by cue (core/timeline.ts lays
// it out), and editable by dragging (core/timelineEdit.ts). Click or drag in the ruler or an empty
// stretch of a track to see the preview at that moment. Drag a block to move it: it belongs to the
// cue whose stretch it lands in, with the rest as that action's delay (Alt: copy). Drag a block's
// right edge to move where it stops (a sound's fade, a layer's hide, an effect's stop). Drag the dot in
// a sound's top-left or top-right corner to set how long it fades in or out. Drag a cue
// flag to move a timed cue, or a GO line to plan the wait before it. Click a block to open its cue
// in the run sheet; Delete removes it; ⌘Z / ⇧⌘Z undo and redo timeline edits.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Clapperboard, Clock, CloudRain, Film, ChartGantt, FoldVertical, Hand, Lightbulb, Link2, Minus, Music, Pause, Play, Plus, Redo2, Square, Undo2, UnfoldVertical, Video, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sceneNow } from "@/core/clock";
import { addActionAt, anchorAt, endDraggable, endFade, fadeInDraggable, fadeOutDraggable, fadeOutFrom, moveCue, placeAction, removeAction, setFadeIn, setFadeOut, setItemEnd, setItemStart, startDraggable, trimAt } from "@/core/timelineEdit";
import { sceneTimeline, type ItemTone, type SceneTimeline as Layout, type TimelineCue, type TimelineItem, type TimelineTrack, type TrackGroup } from "@/core/timeline";
import type { Asset, Cue, Scene } from "@/core/types";
import { previewAtTime, startRun, stopRun, useRun } from "@/engine/operator";
import { setPreviewSound } from "@/engine/previewAudio";
import { timelineAssetIds, timelineEnv } from "@/engine/timeline";
import { hold, knownDuration, probeDurations } from "@/engine/transport";
import { selectedScene, useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { InfoTip } from "../kit";
import { focusCue, newAction, type MenuType } from "./CueEditor";
import { ActionDialog, type ActionTarget } from "./TimelineAction";
import { openMarkers } from "../PreviewTools";

const LABEL_W = 148;

type ScrubProps = Pick<React.HTMLAttributes<HTMLDivElement>, "onPointerDown" | "onPointerMove" | "onDoubleClick">;
/** Lane height: compact fits many tracks, wide (the default) leaves room to grab and read blocks. */
const ROW_H = { compact: 20, wide: 52 } as const;
type RowSize = keyof typeof ROW_H;
const RULER_H = 18;
const CUE_H = 24;

/** Keep getting this pointer's moves while dragging (a synthetic or already-released pointer cannot be captured). */
function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    /* synthetic or already-released pointer */
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** The asset lengths the layout needs, probed once each; `ver` changes when more are known. */
function useDurations(scene: Scene | null | undefined, assets: Asset[]) {
  const [ver, setVer] = useState(0);
  useEffect(() => {
    if (!scene) return;
    const missing = timelineAssetIds(scene).filter((id) => knownDuration(id) == null && assets.some((a) => a.id === id));
    if (missing.length) void probeDurations(assets, missing).then(() => setVer((v) => v + 1));
  }, [scene, assets]);
  return ver;
}

function useLayout(scene: Scene | null | undefined): Layout | null {
  const assets = useShow((s) => s.assets);
  const scenes = useProject((s) => s.project.scenes);
  const ver = useDurations(scene, assets);
  return useMemo(() => (scene ? sceneTimeline(scene, timelineEnv(assets, scenes)) : null), [scene, assets, scenes, ver]); // eslint-disable-line react-hooks/exhaustive-deps
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(`sls.timeline.${key}`) ?? "null");
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}
function writeStored(key: string, v: unknown) {
  try {
    localStorage.setItem(`sls.timeline.${key}`, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- editing

/** A change to the scene, worked out against the layout as it was when the drag began. */
type Op = (s: Scene, base: Layout) => void;

interface Editor {
  /** The layout edits are measured against (not the draft being dragged). */
  base: Layout;
  /** Show what an edit would do while dragging (the scene is not changed). */
  preview(op: Op, label: string): void;
  /** Make the edit (undoable). */
  commit(op: Op): void;
  cancel(): void;
  selected: ItemRef | null;
  select(r: ItemRef | null): void;
  /** Open the pop-up: an action's settings, or a moment to add an action at. */
  open(t: ActionTarget): void;
}

/** A block, found again after an edit renumbers the layout: its track and the action that made it. */
interface ItemRef {
  track: string;
  cue: number;
  action: number;
}

const EditorCtx = createContext<Editor | null>(null);
const useEditor = () => useContext(EditorCtx)!;

interface UndoEntry {
  sceneId: string;
  before: Cue[];
  after: string;
}

/** Timeline edits made in this session, per scene (snapshots of the cues). */
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

function restore(sceneId: string, from: UndoEntry[], to: UndoEntry[]): string | null {
  const scene = useProject.getState().project.scenes.find((x) => x.id === sceneId);
  let i = -1;
  for (let k = from.length - 1; k >= 0; k--) if (from[k].sceneId === sceneId) { i = k; break; }
  if (!scene || i < 0) return "Nothing to undo";
  const e = from[i];
  // Edited in the run sheet since: undoing here would throw that work away.
  if (JSON.stringify(scene.cues) !== e.after) {
    from.length = 0;
    return "The cues were changed in the run sheet since; timeline undo cleared";
  }
  from.splice(i, 1);
  const now = structuredClone(scene.cues);
  useProject.getState().updateScene(sceneId, (s) => {
    s.cues = structuredClone(e.before);
  });
  const after = useProject.getState().project.scenes.find((x) => x.id === sceneId)!;
  to.push({ sceneId, before: now, after: JSON.stringify(after.cues) });
  return null;
}

export function SceneTimeline() {
  const scene = useProject(selectedScene);
  const [sound, setSound] = useState(() => readStored("sound", true));
  const [zoom, setZoom] = useState(1);
  const [rows, setRows] = useState<RowSize>(() => (readStored<string>("rows", "wide") === "compact" ? "compact" : "wide"));
  const [draft, setDraft] = useState<{ scene: Scene; label: string } | null>(null);
  const [selected, setSelected] = useState<ItemRef | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ActionTarget | null>(null);
  const base = useLayout(scene);
  const shown = useLayout(draft?.scene ?? null);
  const tl = draft ? shown : base;
  // A state ref: the scroller mounts again whenever the panel is collapsed or the scene changes.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const raf = useRef(0);
  useEffect(() => {
    writeStored("sound", sound);
    setPreviewSound(sound);
  }, [sound]);
  useEffect(() => {
    setSelected(null);
    setDialog(null);
  }, [scene?.id]);
  useEffect(() => {
    if (!note) return;
    const h = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(h);
  }, [note]);
  useLayoutEffect(() => {
    const el = scroller;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [scroller]);

  const editor = useMemo<Editor | null>(() => {
    if (!scene || !base) return null;
    return {
      base,
      selected,
      select: setSelected,
      open(t) {
        setDialog("at" in t ? { at: t.at, where: landing(base, scene, t.at) } : t);
      },
      preview(op, label) {
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(() => {
          const d = structuredClone(scene);
          op(d, base);
          setDraft({ scene: d, label });
        });
      },
      commit(op) {
        cancelAnimationFrame(raf.current);
        setDraft(null);
        const before = structuredClone(scene.cues);
        useProject.getState().updateScene(scene.id, (s) => op(s, base));
        const after = useProject.getState().project.scenes.find((x) => x.id === scene.id);
        if (!after || JSON.stringify(after.cues) === JSON.stringify(before)) return;
        undoStack.push({ sceneId: scene.id, before, after: JSON.stringify(after.cues) });
        if (undoStack.length > 100) undoStack.shift();
        redoStack.length = 0;
      },
      cancel() {
        cancelAnimationFrame(raf.current);
        setDraft(null);
      },
    };
  }, [scene, base, selected]);

  const undo = useCallback(() => scene && setNote(restore(scene.id, undoStack, redoStack)), [scene]);
  const redo = useCallback(() => scene && setNote(restore(scene.id, redoStack, undoStack)), [scene]);
  // Add the picked action at that moment (undoable), then show its settings.
  const add = (type: MenuType, at: number) => {
    if (!scene || !editor) return;
    const to = anchorAt(editor.base, at);
    if (!to) return;
    const a = newAction(type, scene, useProject.getState().project.scenes);
    editor.commit((s, base) => addActionAt(s, base, a, at));
    const n = useProject.getState().project.scenes.find((x) => x.id === scene.id)?.cues[to.cue]?.actions.length ?? 0;
    setDialog({ cue: to.cue, action: n - 1 });
  };

  if (!scene || !tl || !editor) return null;

  const fit = Math.max(4, (width - LABEL_W - 16) / Math.max(1, base!.end));
  const pps = fit * zoom;
  const unplaced = tl.cues.filter((c) => c.start == null);
  const canUndo = undoStack.some((e) => e.sceneId === scene.id);
  const canRedo = redoStack.some((e) => e.sceneId === scene.id);

  const header = (
    <div className="flex h-8 items-center gap-1.5 px-3">
      <span className="flex items-center gap-1 text-[12.5px] font-semibold">
        <ChartGantt className="size-3.5 text-muted-foreground" />
        Timeline
      </span>
      <InfoTip>
        The scene as tracks: what plays when, cue by cue. Every block belongs to a cue: dragging it to another stretch moves it into the cue that starts that stretch (with the rest as its delay), so it stays with that cue however late its GO comes. Alt while dropping: copy. Drag a block's right edge to set where it stops (a sound fades out there; past the take it keeps playing into the next scene). Drag a cue's flag to move a timed cue; a GO cue has no time until it is pressed, so drag its dashed line to plan the wait before it (double-click: back to the guess). Snaps to cues, other blocks and the playhead (Shift: no snap). Click or drag in the ruler or an empty part of a track to see the preview at that moment. Click a block to select it, double-click it to change its settings; double-click an empty moment to add an action there (lights, StageLight, StageMics, sound…); Delete removes it; ⌘Z undoes. The speaker plays the scene's sounds on this computer's own speakers while you rehearse (never the show output). Space plays and holds. Striped blocks are loops that fill the wait.
      </InfoTip>
      <RunButton sceneId={scene.id} />
      <PlayButton sceneId={scene.id} />
      <Button size="icon-xs" variant="ghost" aria-label={sound ? "Mute the preview" : "Hear the preview"} title={sound ? "Preview sound on (this computer's own speakers, not the show output). Click to mute." : "Preview sound off. Click to hear the scene's sounds as it plays."} onClick={() => setSound(!sound)}>
        {sound ? <Volume2 /> : <VolumeX className="text-muted-foreground" />}
      </Button>
      <TimeReadout sceneId={scene.id} end={tl.end} />
      <AddAtPlayhead sceneId={scene.id} end={tl.end} onAdd={(at) => editor.open({ at, where: "" })} />
      {draft ? (
        <span className="truncate text-[11px] font-medium text-armed">{draft.label}</span>
      ) : note ? (
        <span className="truncate text-[11px] text-muted-foreground">{note}</span>
      ) : (
        unplaced.length > 0 && (
          <span className="truncate text-[11px] text-muted-foreground" title={unplaced.map((c) => `Cue ${c.index + 1}: ${c.name}`).join("\n")}>
            · {unplaced.length} cue{unplaced.length > 1 ? "s" : ""} not on the timeline (video time never reached)
          </span>
        )
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button size="icon-xs" variant="ghost" aria-label="Undo timeline edit" title="Undo the last timeline edit (⌘Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Redo timeline edit" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
          <Redo2 />
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={rows === "wide" ? "Compact tracks" : "Wide tracks"}
          title={rows === "wide" ? "Compact tracks: fit more on screen" : "Wide tracks: taller, easier to edit"}
          onClick={() => {
            const next = rows === "wide" ? "compact" : "wide";
            setRows(next);
            writeStored("rows", next);
          }}
        >
          {rows === "wide" ? <FoldVertical /> : <UnfoldVertical />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
          <Minus />
        </Button>
        <Button size="xs" variant="ghost" className="h-6 px-1.5 text-[11px] tabular" title="Fit the whole scene" onClick={() => setZoom(1)}>
          {zoom <= 1.001 ? "Fit" : `${zoom.toFixed(1)}×`}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 24} onClick={() => setZoom((z) => Math.min(24, z * 1.5))}>
          <Plus />
        </Button>
      </div>
    </div>
  );

  return (
    <EditorCtx.Provider value={editor}>
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div
          ref={setScroller}
          tabIndex={0}
          className="relative min-h-0 flex-1 overflow-auto outline-none"
          onWheel={(e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            setZoom((z) => Math.min(24, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
          }}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key.toLowerCase() === "z") {
              e.preventDefault();
              if (e.shiftKey) redo();
              else undo();
            } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
              e.preventDefault();
              const sel = selected;
              setSelected(null);
              editor.commit((s) => removeAction(s, sel));
            } else if (e.key === "Escape") {
              editor.cancel();
              setSelected(null);
            }
          }}
        >
          <Body scene={scene} tl={tl} pps={pps} rowH={ROW_H[rows]} />
        </div>
        <ActionDialog scene={scene} target={dialog} onClose={() => setDialog(null)} onAdd={add} />
      </div>
    </EditorCtx.Provider>
  );
}

function usePreviewOf(sceneId: string) {
  return useShow((s) => (s.preview?.scene.id === sceneId ? s.preview : null));
}

function useTicking(on: boolean, ms = 100) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [on, ms]);
}

/** Run the show from this scene's TAKE in the preview: GOs press themselves at their planned holds, takes go on to the next scene. */
function RunButton({ sceneId }: { sceneId: string }) {
  const on = useRun((s) => s.on);
  return on ? (
    <Button size="xs" variant="outline" className="h-6 gap-1 border-preview/60 px-2 text-[11px] text-preview" title="Stop the run (the preview stays where it is)" onClick={stopRun}>
      <Square className="size-3 fill-current" /> Stop run
    </Button>
  ) : (
    <Button
      size="xs"
      variant="outline"
      className="h-6 gap-1 px-2 text-[11px]"
      title="Run the show from this scene, as if taken: the scene starts from the top, GO cues fire at their planned holds on the timeline, and a take-scene action (or the end of the scene) goes on to the next scene, with music that keeps playing carried over. Preview only: nothing reaches the wall, the lights or the sound desk. Space holds and resumes."
      onClick={() => startRun(sceneId)}
    >
      <Clapperboard className="size-3" /> Run show
    </Button>
  );
}

function PlayButton({ sceneId }: { sceneId: string }) {
  const rt = usePreviewOf(sceneId);
  if (!rt) return null;
  const paused = rt.clock.pausedAt !== null;
  return (
    <Button size="icon-xs" variant="ghost" aria-label={paused ? "Play the preview" : "Hold the preview"} title={paused ? "Play the preview from here (Space)" : "Hold the preview on this frame (Space)"} onClick={() => hold("preview", paused ? "resume" : "pause")}>
      {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
    </Button>
  );
}

/** Add an action where the playhead is (the same as double-clicking that moment). */
function AddAtPlayhead({ sceneId, end, onAdd }: { sceneId: string; end: number; onAdd: (at: number) => void }) {
  const rt = usePreviewOf(sceneId);
  const at = rt ? Math.min(end, Math.max(0, sceneNow(rt) / 1000)) : 0;
  return (
    <Button size="xs" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" title="Add an action at the playhead: lights, StageLight, StageMics, a sound… (or double-click a moment on the timeline)" onClick={() => onAdd(Math.round(at * 10) / 10)}>
      <Plus /> Add
    </Button>
  );
}

function TimeReadout({ sceneId, end }: { sceneId: string; end: number }) {
  const rt = usePreviewOf(sceneId);
  useTicking(!!rt && rt.clock.pausedAt === null);
  if (!rt) return null;
  return (
    <span className="text-[11px] tabular text-muted-foreground">
      {fmt(Math.max(0, sceneNow(rt) / 1000))} / {fmt(end)}
    </span>
  );
}

// ---------------------------------------------------------------- body

const GROUP_ICON: Record<TrackGroup, typeof Film> = { picture: Film, effects: CloudRain, camera: Video, sound: Music, outputs: Lightbulb };

/** Where to snap a dragged time: cue starts, block edges, the take and the playhead, within a few pixels. */
function snapper(base: Layout, pps: number, sceneId: string, skip?: TimelineItem) {
  const targets: number[] = [0];
  for (const c of base.cues) if (c.start != null) targets.push(c.start);
  for (const it of base.items) {
    if (skip && it.track === skip.track && it.start === skip.start && it.end === skip.end) continue;
    targets.push(it.start);
    if (it.end > it.start) targets.push(it.end);
  }
  if (base.takeAt != null) targets.push(base.takeAt);
  const rt = useShow.getState().preview;
  if (rt?.scene.id === sceneId) targets.push(sceneNow(rt) / 1000);
  return (t: number, free: boolean) => {
    t = Math.max(0, t);
    if (!free) {
      let best: number | null = null;
      for (const x of targets) if (Math.abs(x - t) * pps <= 6 && (best == null || Math.abs(x - t) < Math.abs(best - t))) best = x;
      if (best != null) return best;
    }
    return Math.round(t * 10) / 10;
  };
}

/**
 * Follow one pointer drag on the window. Nothing changes until it moves a few pixels; then each
 * move previews the edit and the release makes it. A press that never moved is a click.
 */
function startDrag(e: React.PointerEvent, o: { t0: number; pps: number; snap: (t: number, free: boolean) => number; edit: Editor; op: (t: number, ev: PointerEvent) => { op: Op; label: string }; click?: () => void }) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  (e.currentTarget as HTMLElement).closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });
  const x0 = e.clientX;
  let moved = false;
  let last: { op: Op; label: string } | null = null;
  const at = (ev: PointerEvent) => o.snap(o.t0 + (ev.clientX - x0) / o.pps, ev.shiftKey);
  const move = (ev: PointerEvent) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    last = o.op(at(ev), ev);
    o.edit.preview(last.op, last.label);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", esc);
    if (!moved) return o.click?.();
    o.edit.commit(o.op(at(ev), ev).op);
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", esc);
    o.edit.cancel();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", esc);
}

/** "cue 5 (GO) + 2.3 s" for where a time lands. */
function landing(base: Layout, scene: Scene, t: number): string {
  const a = anchorAt(base, t);
  if (!a) return "";
  const c = base.cues[a.cue];
  const kind = c.mode === "go" ? "GO" : c.mode === "time" ? "timed" : c.mode === "follow" ? "follow" : "video";
  return `cue ${a.cue + 1} (${kind}: ${scene.cues[a.cue]?.name.slice(0, 28) ?? ""}) + ${a.delay.toFixed(1)} s`;
}

const Body = memo(function Body({ scene, tl, pps, rowH }: { scene: Scene; tl: Layout; pps: number; rowH: number }) {
  const edit = useEditor();
  const width = Math.ceil(Math.max(tl.end, edit.base.end) * pps) + 16;
  const starts = edit.base.cues.map((c) => c.start);
  const seekRef = useRef<{ raf: number; t: number } | null>(null);
  const seek = (t: number) => {
    const s = seekRef.current ?? { raf: 0, t };
    s.t = Math.max(0, Math.min(edit.base.end, t));
    if (!seekRef.current) {
      seekRef.current = s;
      s.raf = requestAnimationFrame(() => {
        seekRef.current = null;
        // The preview may be showing another scene (e.g. after a take-scene cue ran in it).
        if (useShow.getState().preview?.scene.id !== scene.id) useShow.getState().setPreview(scene);
        previewAtTime(s.t, starts);
      });
    }
  };
  // Click or drag on the ruler or an empty stretch of a track: scrub the preview.
  const scrubProps: ScrubProps = {
    // Double-click an empty moment: add an action there.
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      const r = e.currentTarget.getBoundingClientRect();
      edit.open({ at: Math.max(0, Math.round(((e.clientX - r.left) / pps) * 10) / 10), where: "" });
    },
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      capture(e);
      edit.select(null);
      const r = e.currentTarget.getBoundingClientRect();
      seek((e.clientX - r.left) / pps);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!(e.buttons & 1) || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
      const r = e.currentTarget.getBoundingClientRect();
      seek((e.clientX - r.left) / pps);
    },
  };
  const goLines = tl.cues.filter((c) => c.mode === "go" && c.start != null);
  const rows: { track: TimelineTrack; items: TimelineItem[] }[] = tl.tracks.map((track) => ({ track, items: tl.items.filter((it) => it.track === track.id) }));
  const totalH = RULER_H + CUE_H + rows.reduce((n, r) => n + r.track.lanes * rowH + 4, 0);

  return (
    <div className="relative" style={{ width: LABEL_W + width, minHeight: totalH }}>
      {/* ruler */}
      <div className="sticky top-0 z-[28] flex bg-background" style={{ height: RULER_H }}>
        <div className="sticky left-0 z-10 shrink-0 bg-background" style={{ width: LABEL_W }} />
        <div className="relative cursor-text border-b border-border" style={{ width }} {...scrubProps}>
          <Ruler end={tl.end} pps={pps} />
          <PlayheadMark sceneId={scene.id} pps={pps} end={tl.end} />
        </div>
      </div>
      {/* cues */}
      <div className="sticky z-[27] flex bg-background" style={{ top: RULER_H, height: CUE_H }}>
        <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-b border-r border-border bg-background px-3 text-[11px] text-muted-foreground" style={{ width: LABEL_W }}>
          Cues
        </div>
        <div className="relative border-b border-border" style={{ width }} {...scrubProps}>
          {tl.cues.map((c) => (c.start == null ? null : <CueFlag key={c.id} cue={c} next={nextStart(tl.cues, c)} pps={pps} end={tl.end} scene={scene} />))}
          {goLines.map((c) => (
            <HoldHandle key={c.id} cue={c} scene={scene} pps={pps} />
          ))}
        </div>
      </div>
      {/* tracks */}
      {rows.map(({ track, items }) => (
        <TrackRow key={track.id} track={track} items={items} width={width} pps={pps} rowH={rowH} scene={scene} scrubProps={scrubProps} onSeek={seek} />
      ))}
      {/* GO lines over every track */}
      <div className="pointer-events-none absolute bottom-0 z-10" style={{ left: LABEL_W, top: RULER_H, width }}>
        {goLines.map((c) => (
          <div key={c.id} className={cn("absolute bottom-0 top-0 border-l border-dashed", c.holdSet ? "border-foreground/45" : "border-foreground/25")} style={{ left: c.start! * pps }} />
        ))}
        {tl.takeAt != null && <div className="absolute bottom-0 top-0 border-l-2 border-live/60" style={{ left: tl.takeAt * pps }} title="The next scene is taken here" />}
      </div>
      <Playhead sceneId={scene.id} pps={pps} end={tl.end} />
    </div>
  );
});

function nextStart(cues: TimelineCue[], c: TimelineCue): number | null {
  let best: number | null = null;
  for (const o of cues) if (o !== c && o.start != null && o.start > c.start! && (best == null || o.start < best)) best = o.start;
  return best;
}

function Ruler({ end, pps }: { end: number; pps: number }) {
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 64) ?? 600;
  const minor = step / (step >= 10 ? 5 : 2);
  const ticks: ReactNode[] = [];
  for (let t = 0; t <= end + 1e-6; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ticks.push(
      <div key={t.toFixed(2)} className={cn("pointer-events-none absolute bottom-0 border-l", major ? "h-2.5 border-foreground/40" : "h-1 border-foreground/20")} style={{ left: t * pps }}>
        {major && <span className="absolute -top-[3px] left-1 text-[10px] tabular text-muted-foreground">{t >= 60 ? fmt(t).replace(/\.0$/, "") : `${t}s`}</span>}
      </div>,
    );
  }
  return <>{ticks}</>;
}

const MODE_ICON = { go: Hand, time: Clock, follow: Link2, video: Film } as const;

/** A cue's flag: click to open it; drag a timed or follow cue to move it (a GO moves by its line). */
function CueFlag({ cue, next, pps, end, scene }: { cue: TimelineCue; next: number | null; pps: number; end: number; scene: Scene }) {
  const edit = useEditor();
  const Icon = MODE_ICON[cue.mode];
  const w = Math.max(18, ((next ?? end) - cue.start!) * pps - 2);
  const movable = cue.mode === "time" || cue.mode === "follow";
  const how = cue.mode === "go" ? `on GO, planned ${cue.hold!.toFixed(1)} s after the cue before${cue.holdSet ? "" : " (guessed)"}` : cue.mode === "time" ? `at ${fmt(cue.start!)} into the scene` : cue.mode === "follow" ? "after the cue before" : "at a video time";
  return (
    <button
      type="button"
      className={cn("absolute top-[3px] flex h-[18px] items-center gap-1 overflow-hidden rounded-sm px-1 text-left text-[10.5px] hover:bg-accent", cue.mode === "go" ? "text-foreground" : "text-armed", movable && "cursor-grab active:cursor-grabbing")}
      style={{ left: cue.start! * pps + 1, width: w }}
      title={`Cue ${cue.index + 1}: ${cue.name}\nFires ${how} (${fmt(cue.start!)})${movable ? "\nDrag to move it" : ""}`}
      onPointerDown={(e) => {
        if (!movable) return e.stopPropagation();
        const snap = snapper(edit.base, pps, scene.id);
        startDrag(e, {
          t0: edit.base.cues[cue.index]?.start ?? cue.start!,
          pps,
          snap,
          edit,
          click: () => focusCue(cue.id),
          op: (t) => ({ op: (s, base) => moveCue(s, base, cue.index, t), label: `Cue ${cue.index + 1} fires at ${fmt(t)}` }),
        });
      }}
      onClick={(e) => (!movable || e.detail === 0) && focusCue(cue.id)}
    >
      <span className="font-key font-bold tabular">{cue.index + 1}</span>
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{cue.name}</span>
    </button>
  );
}

/** The grip on a GO line: drag to plan how long the wait before this GO is. */
function HoldHandle({ cue, scene, pps }: { cue: TimelineCue; scene: Scene; pps: number }) {
  const edit = useEditor();
  return (
    <div
      role="slider"
      aria-label={`Planned wait before GO ${cue.index + 1}`}
      aria-valuenow={cue.hold}
      title={`GO ${cue.index + 1}: planned ${cue.hold!.toFixed(1)} s after the cue before${cue.holdSet ? "" : " (guessed from how long that cue runs, music aside)"}.\nDrag to plan the wait · double-click to go back to the guess`}
      className={cn("absolute top-0 z-10 h-full w-2.5 -translate-x-1/2 cursor-ew-resize rounded-sm", cue.holdSet ? "bg-foreground/45 hover:bg-foreground/70" : "bg-foreground/20 hover:bg-foreground/45")}
      style={{ left: cue.start! * pps }}
      onPointerDown={(e) => {
        const base = edit.base.cues[cue.index];
        const snap = snapper(edit.base, pps, scene.id);
        startDrag(e, {
          t0: base?.start ?? cue.start!,
          pps,
          snap,
          edit,
          op: (t) => ({ op: (s, b) => moveCue(s, b, cue.index, t), label: `GO ${cue.index + 1}: ${Math.max(0, t - (base?.holdFrom ?? 0)).toFixed(1)} s after the cue before` }),
        });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        edit.commit((s) => {
          delete s.cues[cue.index].hold;
        });
      }}
    />
  );
}

function TrackRow({ track, items, width, pps, rowH, scene, scrubProps, onSeek }: { track: TimelineTrack; items: TimelineItem[]; width: number; pps: number; rowH: number; scene: Scene; scrubProps: ScrubProps; onSeek: (t: number) => void }) {
  const Icon = track.componentId && scene.components.find((c) => c.id === track.componentId)?.kind === "clipActor" ? Clapperboard : GROUP_ICON[track.group];
  const h = track.lanes * rowH + 4;
  return (
    <div className="flex" style={{ height: h }}>
      <button
        type="button"
        className="sticky left-0 z-[26] flex shrink-0 items-center gap-1.5 border-b border-r border-border/70 bg-background px-3 text-left text-[11px] text-muted-foreground hover:text-foreground"
        style={{ width: LABEL_W }}
        title={track.label}
        onClick={() => track.componentId && useProject.getState().selectComponent(track.componentId)}
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{track.label}</span>
      </button>
      <div className="relative border-b border-border/50" style={{ width }} {...scrubProps}>
        {items.map((it) => (
          <Block key={it.id} it={it} pps={pps} rowH={rowH} scene={scene} onSeek={onSeek} />
        ))}
      </div>
    </div>
  );
}

const TONE: Record<ItemTone, string> = {
  picture: "border-sky-400/60 bg-sky-500/25 text-sky-100",
  loop: "border-dashed border-sky-400/45 bg-sky-500/10 text-sky-200/80",
  held: "border-white/10 bg-white/[0.04] text-muted-foreground",
  effect: "border-rose-400/55 bg-rose-500/20 text-rose-100",
  music: "border-violet-400/60 bg-violet-500/25 text-violet-100",
  voice: "border-sky-300/60 bg-sky-400/25 text-sky-50",
  ambience: "border-emerald-400/60 bg-emerald-500/20 text-emerald-100",
  sfx: "border-orange-400/60 bg-orange-500/20 text-orange-100",
  sound: "border-zinc-400/50 bg-zinc-500/20 text-zinc-100",
  camera: "border-fuchsia-400/55 bg-fuchsia-500/20 text-fuchsia-100",
  light: "border-armed bg-armed/70",
  show: "border-zinc-300/50 bg-zinc-400/15 text-zinc-100",
};

const POINT: Partial<Record<ItemTone, string>> = { effect: "border-rose-300 bg-rose-400/80", picture: "border-sky-300 bg-sky-400/80", show: "border-zinc-200 bg-zinc-300/80", camera: "border-fuchsia-300 bg-fuchsia-400/80", sound: "border-zinc-200 bg-zinc-300/80" };

const STRIPES: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,255,255,0.07) 5px 7px)" };

function describe(it: TimelineItem, scene: Scene): string {
  const lines = [it.label];
  lines.push(it.end > it.start ? `${fmt(it.start)} → ${fmt(it.end)} (${(it.end - it.start).toFixed(1)} s)` : fmt(it.start));
  if (it.cue != null) {
    const cue = scene.cues[it.cue];
    const delay = it.action != null ? cue?.actions[it.action]?.delay : 0;
    lines.push(`Cue ${it.cue + 1}: ${cue?.name ?? ""}${delay ? ` · +${delay} s` : ""}`);
  } else lines.push(it.carriedIn ? "Carried in from an earlier scene" : "As the scene starts (or a loop filling the wait)");
  if (it.requested != null) lines.push(`Asked for at ${fmt(it.requested)}; waits for the clip before to reach a clean cut`);
  if (it.loop) lines.push("Loops until something replaces or stops it");
  if (it.open) lines.push("Length not known yet");
  if (it.trim) lines.push(`Starts ${it.trim.toFixed(1)} s into its file`);
  if (it.fadeIn) lines.push(`Fades in over ${it.fadeIn} s`);
  for (const l of it.levels ?? []) lines.push(`To ${Math.round(l.level * 100)}% at ${fmt(it.start + l.at)}${l.fade ? ` over ${l.fade} s` : ""}`);
  if (it.fadeFrom != null) lines.push(`Fades out from ${fmt(it.fadeFrom)}`);
  if (it.carriesOut) lines.push("Keeps playing into the next scene");
  const how = [it.cue != null && it.action != null ? "drag: move (Alt: copy)" : null, startDraggable(it) ? "drag the left edge: trim its start" : null, fadeInDraggable(it) || fadeOutDraggable(it) ? "drag a top corner dot: fade length" : null, endDraggable(it) ? "drag the right edge: where it stops" : null, "click: select", it.action != null || it.markerHost ? "double-click: settings" : it.cue != null ? "double-click: open the cue" : "double-click: preview here"].filter(Boolean);
  lines.push(how.join(" · "));
  return lines.join("\n");
}

const isSelected = (it: TimelineItem, r: ItemRef | null) => !!r && it.cue === r.cue && it.action === r.action && it.track === r.track;

function Block({ it, pps, rowH, scene, onSeek }: { it: TimelineItem; pps: number; rowH: number; scene: Scene; onSeek: (t: number) => void }) {
  const edit = useEditor();
  // Click selects (and selects its component, if it has one); double-click opens its cue in the run sheet.
  const open = () => {
    if (it.cue != null && it.action != null) edit.select({ track: it.track, cue: it.cue, action: it.action });
    else edit.select(null);
    // Its component, or none (a cue sound has no component: the panel must not keep showing the last one).
    useProject.getState().selectComponent(it.componentId ?? null);
  };
  const openCue = () => {
    if (it.markerHost) openMarkers(it.markerHost);
    else if (it.cue != null && it.action != null && scene.cues[it.cue]?.actions[it.action]) edit.open({ cue: it.cue, action: it.action, endBy: it.endable === "sound" ? it.endBy : undefined });
    else if (it.cue != null && scene.cues[it.cue]) focusCue(scene.cues[it.cue].id);
    else onSeek(it.start);
  };
  const movable = it.cue != null && it.action != null;
  const sel = isSelected(it, edit.selected);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!movable) {
      e.stopPropagation();
      return;
    }
    // Blocks of a draft re-render while dragging: measure against the layout as the drag began.
    const from = { cue: it.cue!, action: it.action! };
    const t0 = it.requested ?? it.start;
    startDrag(e, {
      t0,
      pps,
      snap: snapper(edit.base, pps, scene.id, it),
      edit,
      click: open,
      op: (t, ev) => ({
        op: (s, base) => void placeAction(s, base, from, t, ev.altKey),
        label: `${ev.altKey ? "Copy" : "Move"} “${it.label.slice(0, 32)}” to ${fmt(t)} → ${landing(edit.base, scene, t)}`,
      }),
    });
  };
  const common = {
    title: describe(it, scene),
    onPointerDown,
    onClick: (e: React.MouseEvent) => e.detail === 0 && open(),
    onDoubleClick: openCue,
  };
  const top = 2 + it.lane * rowH;
  if (it.end <= it.start)
    return (
      <button
        type="button"
        aria-label={it.label}
        {...common}
        className={cn("absolute z-[1] size-[9px] -translate-x-1/2 rotate-45 rounded-[1px] border hover:scale-125", POINT[it.tone] ?? TONE[it.tone], movable && "cursor-grab", sel && "ring-2 ring-white")}
        style={{ left: it.start * pps, top: top + (rowH - 3) / 2 - 4.5 }}
      />
    );
  const left = it.start * pps;
  const w = Math.max(3, (it.end - it.start) * pps);
  const endable = endDraggable(it);
  const startable = startDraggable(it);
  const fadeInable = fadeInDraggable(it);
  const fadeOutable = fadeOutDraggable(it);
  const fadeHandle = "absolute top-0 z-[3] size-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-black/40 bg-white/70 opacity-0 group-hover:opacity-100 hover:scale-125 hover:bg-white";
  return (
    <button
      type="button"
      {...common}
      className={cn("group absolute overflow-hidden rounded-[3px] border px-1 text-left text-[10.5px] leading-[14px] hover:brightness-125", TONE[it.tone], it.carriedIn && "rounded-l-none border-l-2", it.carriesOut && "rounded-r-none", movable && "cursor-grab active:cursor-grabbing", sel && "ring-2 ring-white")}
      style={{ left, width: w, top, height: rowH - 3, ...(it.carriedIn ? { borderLeftStyle: "dashed" } : {}), ...(it.loop ? STRIPES : {}), ...(it.open ? { maskImage: "linear-gradient(to right, black 60%, transparent)" } : {}) }}
    >
      {it.requested != null && <span className="pointer-events-none absolute inset-y-0 left-0 w-px bg-white/40" />}
      <span className="pointer-events-none relative z-[1] block truncate">
        {it.carriedIn && "◂ "}
        {it.label}
        {it.carriesOut && " ▸ next scene"}
      </span>
      {it.levels?.map((l, i) => (
        <span key={`lv${i}`} className="pointer-events-none absolute top-0 h-1.5 w-px bg-white/80" style={{ left: l.at * pps }} />
      ))}
      {it.marks?.map((m, i) => (
        <span key={i} className="pointer-events-none absolute bottom-0 h-1.5 w-px bg-armed" style={{ left: (m - it.start) * pps }} />
      ))}
      {!!it.fadeIn && (
        <span
          className="pointer-events-none absolute inset-y-0 left-0"
          style={{ width: Math.max(2, Math.min(it.fadeIn, it.end - it.start) * pps), background: "linear-gradient(to bottom left, transparent 49%, rgba(0,0,0,0.5) 51%)" }}
        />
      )}
      {it.fadeFrom != null && it.fadeFrom < it.end && (
        <span
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{ width: Math.max(2, (it.end - Math.max(it.start, it.fadeFrom)) * pps), background: "linear-gradient(to bottom right, transparent 49%, rgba(0,0,0,0.5) 51%)" }}
        />
      )}
      {startable && (
        <span
          role="slider"
          aria-label={`Trim the start of “${it.label}”`}
          aria-valuenow={it.trim ?? 0}
          className="absolute inset-y-0 left-0 z-[2] w-1.5 cursor-ew-resize hover:bg-white/50"
          onPointerDown={(e) => {
            startDrag(e, {
              t0: it.start,
              pps,
              snap: snapper(edit.base, pps, scene.id, it),
              edit,
              op: (t) => ({ op: (s, base) => setItemStart(s, base, it, t), label: startLabel(it, t, edit.base, scene) }),
            });
          }}
        />
      )}
      {fadeInable && (
        <span
          role="slider"
          aria-label={`Fade-in of “${it.label}”`}
          aria-valuenow={it.fadeIn ?? 0}
          className={cn(fadeHandle, it.fadeIn && "opacity-80")}
          style={{ left: Math.max(5, (it.fadeIn ?? 0) * pps) }}
          onPointerDown={(e) => {
            startDrag(e, {
              t0: it.start + (it.fadeIn ?? 0),
              pps,
              snap: snapper(edit.base, pps, scene.id, it),
              edit,
              op: (t) => ({ op: (s) => setFadeIn(s, it, t), label: `“${it.label.slice(0, 32)}” fades in over ${Math.max(0, Math.min(t, it.fadeFrom ?? it.end) - it.start).toFixed(1)} s` }),
            });
          }}
        />
      )}
      {fadeOutable && (
        <span
          role="slider"
          aria-label={`Fade-out of “${it.label}”`}
          aria-valuenow={it.fadeFrom != null ? it.end - it.fadeFrom : 0}
          className={cn(fadeHandle, it.fadeFrom != null && "opacity-80")}
          style={{ left: Math.min(w - 5, ((it.fadeFrom ?? it.end) - it.start) * pps) }}
          onPointerDown={(e) => {
            startDrag(e, {
              t0: it.fadeFrom ?? it.end,
              pps,
              snap: snapper(edit.base, pps, scene.id, it),
              edit,
              op: (t) => ({ op: (s, base) => setFadeOut(s, base, it, t), label: `“${it.label.slice(0, 32)}” fades out over ${(it.end - fadeOutFrom(it, t)).toFixed(1)} s, ending at ${fmt(it.end)}` }),
            });
          }}
        />
      )}
      {endable && (
        <span
          role="slider"
          aria-label={`Where “${it.label}” stops`}
          aria-valuenow={it.end}
          className="absolute inset-y-0 right-0 z-[2] w-1.5 cursor-ew-resize hover:bg-white/50"
          onPointerDown={(e) => {
            startDrag(e, {
              t0: it.end,
              pps,
              snap: snapper(edit.base, pps, scene.id, it),
              edit,
              op: (t) => ({ op: (s, base) => setItemEnd(s, base, it, t), label: endLabel(it, t, edit.base, scene) }),
            });
          }}
        />
      )}
    </button>
  );
}

function startLabel(it: TimelineItem, t: number, base: Layout, scene: Scene): string {
  const { start, trim } = trimAt(it, t);
  const cut = trim > 0 ? `${trim.toFixed(1)} s cut off its top` : "from the top of its file";
  return `“${it.label.slice(0, 32)}” starts at ${fmt(start)}, ${cut} → ${landing(base, scene, start)}`;
}

function endLabel(it: TimelineItem, t: number, base: Layout, scene: Scene): string {
  const what = it.endable === "sound" ? "fades out" : it.endable === "layer" ? "hides" : "stops";
  if (it.endable === "sound") {
    if (base.takeAt != null && t >= base.takeAt + 0.5) return `“${it.label.slice(0, 32)}” keeps playing into the next scene`;
    if (it.naturalEnd != null && t > it.naturalEnd) return `“${it.label.slice(0, 32)}” ends with its file at ${fmt(it.naturalEnd)}`;
  } else if (t >= base.end - 0.05) return `“${it.label.slice(0, 32)}” runs to the end`;
  const at = Math.max(it.start, t - endFade(it));
  return `“${it.label.slice(0, 32)}” ${what} at ${fmt(at)} → ${landing(base, scene, at)}`;
}

/** The preview's scene time, kept on the timeline (a preview that plays on past the end stays at the end). */
function usePlayheadTime(sceneId: string, end: number) {
  const rt = usePreviewOf(sceneId);
  const playing = !!rt && rt.clock.pausedAt === null;
  useTicking(playing, 50);
  return { t: rt ? Math.min(end, Math.max(0, sceneNow(rt) / 1000)) : null, playing };
}

/** The preview's scene time as a line over the tracks (ticks while the preview plays). */
function Playhead({ sceneId, pps, end }: { sceneId: string; pps: number; end: number }) {
  const { t, playing } = usePlayheadTime(sceneId, end);
  const ref = useRef<HTMLDivElement>(null);
  // Keep it in view while the preview plays.
  useEffect(() => {
    const el = ref.current;
    const sc = el?.closest(".overflow-auto") as HTMLElement | null;
    if (!el || !sc || !playing || t == null || sc.scrollWidth <= sc.clientWidth) return;
    const x = LABEL_W + t * pps;
    if (x > sc.scrollLeft + sc.clientWidth - 24 || x < sc.scrollLeft + LABEL_W) sc.scrollLeft = Math.max(0, x - LABEL_W - 40);
  });
  if (t == null) return null;
  return <div ref={ref} className="pointer-events-none absolute bottom-0 z-[25] w-0 border-l-[1.5px] border-live" style={{ left: LABEL_W + t * pps, top: RULER_H }} />;
}

/** Its head in the ruler. */
function PlayheadMark({ sceneId, pps, end }: { sceneId: string; pps: number; end: number }) {
  const { t } = usePlayheadTime(sceneId, end);
  if (t == null) return null;
  return (
    <div className="pointer-events-none absolute inset-y-0 w-0 border-l-[1.5px] border-live" style={{ left: t * pps }}>
      <div className="absolute -left-[5px] bottom-0 size-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-live" />
    </div>
  );
}
