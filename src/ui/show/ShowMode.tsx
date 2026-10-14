import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CircleStop, Pause, Play, Power, Repeat, RotateCcw, SkipForward, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { sceneNow } from "@/core/clock";
import type { TransitionKind, TransitionSpec } from "@/core/types";
import { cancelPending, cueControl, pendingCount, takeScene } from "@/engine/operator";
import { StageView } from "@/render/StageView";
import { selectedScene, useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { NumberInput, SelectBox } from "../fields";
import { SceneList } from "../SceneList";
import { ControlPanel, useControlTarget } from "./ControlPanel";

export const TRANSITIONS: { value: TransitionKind; label: string }[] = [
  { value: "cut", label: "Cut" },
  { value: "crossfade", label: "Crossfade" },
  { value: "fadeblack", label: "Fade to black" },
  { value: "dissolve", label: "Dissolve" },
  { value: "travel", label: "Camera travel" },
  { value: "video", label: "Video transition" },
];

export function ShowMode() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[264px_1fr_372px]">
      <aside className="min-h-0 border-r border-border">
        <SceneList />
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col">
        <Monitors />
        <CueList />
      </main>
      <aside className="min-h-0 border-l border-border">
        <ControlPanel />
      </aside>
    </div>
  );
}

export function useCaptureThumb() {
  return (sceneId: string, d: string) => useProject.getState().setThumbnail(sceneId, d);
}

function MonitorLabel({ kind, children }: { kind: "preview" | "program"; children: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-2 px-1 text-[11px]">
      <span className={cn("rounded-[3px] px-1.5 py-px text-[10px] font-bold tracking-[0.14em]", kind === "program" ? "bg-live text-white" : "bg-preview text-black")}>{kind === "program" ? "PROGRAM" : "PREVIEW"}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-muted-foreground">{children}</div>
    </div>
  );
}

function Monitors() {
  const scene = useProject(selectedScene);
  const program = useShow((s) => s.program);
  const output = useShow((s) => s.output);
  const capture = useCaptureThumb();
  const [zoom, setZoom] = useState(1);
  const aspect = `${output.canvasWidth} / ${output.canvasHeight}`;
  const liveName = program.standby ? "Standby" : program.runtime ? `${String(program.runtime.scene.number).padStart(2, "0")} · ${program.runtime.scene.name}` : "—";

  return (
    <div className="border-b border-border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <MonitorLabel kind="preview">
            <span className="truncate text-foreground">{scene ? `${String(scene.number).padStart(2, "0")} · ${scene.name}` : "—"}</span>
          </MonitorLabel>
          <div className="relative w-full overflow-hidden rounded-sm ring-2 ring-preview/70" style={{ aspectRatio: aspect, maxHeight: "38vh" }}>
            <ZoomBox z={zoom}>
              <StageView source="preview" maxDpr={1.25} showSafeArea onCapture={capture} />
            </ZoomBox>
          </div>
          <PreviewTransport zoom={zoom} setZoom={setZoom} />
        </div>
        <div className="min-w-0">
          <MonitorLabel kind="program">
            <span className="truncate text-foreground">{liveName}</span>
            {program.transition && <span className="animate-pulse text-armed">transition…</span>}
          </MonitorLabel>
          <div className="relative w-full overflow-hidden rounded-sm ring-2 ring-live" style={{ aspectRatio: aspect, maxHeight: "38vh" }}>
            <StageView source="program" maxDpr={1.25} showSafeArea />
          </div>
          <LiveCueStrip />
        </div>
      </div>
      <TakeBar />
    </div>
  );
}

const ZOOMS = [1, 1.5, 2, 3];

function ZoomBox({ z, children }: { z: number; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0" style={{ transform: `scale(${z})`, transformOrigin: "50% 50%" }}>
      {children}
    </div>
  );
}

function PreviewTransport({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  const rt = useShow((s) => s.preview);
  const [, force] = useState(0);
  const paused = rt?.clock.pausedAt != null;
  const output = useShow((s) => s.output);
  const ratio = (output.canvasWidth / output.canvasHeight).toFixed(2);
  const t = rt ? sceneNow(rt) / 1000 : 0;
  useEffect(() => {
    const h = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(h);
  }, []);
  const dur = rt?.scene.duration;
  return (
    <div className="mt-1.5 flex items-center gap-1 text-[11px]">
      <Button size="icon-xs" variant="ghost" aria-label={paused ? "Play preview" : "Pause preview"} disabled={!rt} onClick={() => useShow.getState().dispatch("preview", { type: "clock", op: paused ? "resume" : "pause" })}>
        {paused ? <Play /> : <Pause />}
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Restart preview" disabled={!rt} onClick={() => useShow.getState().restartPreview()}>
        <RotateCcw />
      </Button>
      <span className="w-[78px] tabular text-muted-foreground">
        {fmt(t)}
        {dur ? ` / ${fmt(dur)}` : ""}
      </span>
      <SelectBox
        className="h-6 w-[140px]"
        value="__cam__"
        onChange={(id) => id !== "__cam__" && useShow.getState().dispatch("preview", { type: "camera", shotId: id, delay: 0 })}
        options={[{ value: "__cam__", label: "Camera position…" }, ...(rt?.scene.cameraShots.map((s) => ({ value: s.id, label: s.name })) ?? [])]}
      />
      <div className="ml-auto flex items-center gap-1">
        {ZOOMS.map((z) => (
          <Button key={z} size="xs" variant={zoom === z ? "secondary" : "ghost"} className="h-5 px-1.5 text-[10.5px]" onClick={() => setZoom(z)}>
            {z === 1 ? "Fit" : `${z}×`}
          </Button>
        ))}
        <span className="ml-1 tabular text-muted-foreground" title="Output canvas">
          {output.canvasWidth}×{output.canvasHeight} · {ratio}:1
        </span>
      </div>
    </div>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function TakeBar() {
  const scene = useProject(selectedScene);
  const assets = useProject((s) => s.project.assets);
  const next = useShow((s) => s.nextTransition);
  const program = useShow((s) => s.program);
  const spec: TransitionSpec | null = next ?? scene?.transition ?? null;
  const setSpec = (p: Partial<TransitionSpec>) => spec && useShow.getState().setNextTransition({ ...spec, ...p });
  const videos = assets.filter((a) => a.type === "video");
  const isLiveAlready = !!scene && program.runtime?.scene.id === scene.id && !program.standby;
  const busy = !!program.transition;

  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-card/60 px-2 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Transition</span>
      <SelectBox className="w-[150px]" value={spec?.kind ?? "crossfade"} onChange={(kind) => setSpec({ kind })} options={TRANSITIONS} />
      {spec && spec.kind !== "cut" && spec.kind !== "video" && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <NumberInput className="h-7 w-16" value={spec.duration} min={0} max={60} step={0.5} onChange={(duration) => setSpec({ duration })} />s
        </div>
      )}
      {spec?.kind === "video" && (
        <SelectBox
          className="w-[180px]"
          value={spec.videoAssetId ?? "__none__"}
          onChange={(v) => setSpec({ videoAssetId: v === "__none__" ? null : v })}
          options={[{ value: "__none__", label: videos.length ? "Choose video…" : "No videos imported" }, ...videos.map((v) => ({ value: v.id, label: v.name }))]}
        />
      )}
      {next && (
        <Button size="xs" variant="ghost" onClick={() => useShow.getState().setNextTransition(null)} title="Use the scene's default transition">
          reset
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Button
          variant={program.blackout?.on ? "secondary" : "outline"}
          className={cn("h-10", program.blackout?.on && "border border-armed text-armed")}
          onClick={() => useShow.getState().setBlackout(!program.blackout?.on)}
          title="Lights out: fade the whole wall to black (and back)"
        >
          {program.blackout?.on ? "LIGHTS UP" : "BLACKOUT"}
        </Button>
        <Button variant={program.standby ? "secondary" : "outline"} className={cn("h-10 gap-2", program.standby && "border border-armed text-armed")} onClick={() => useShow.getState().setStandby(!program.standby)} title="Fade the audience output to the safe standby visual">
          <Power /> {program.standby ? "IN STANDBY" : "STANDBY"}
        </Button>
        <Button
          disabled={!scene || busy}
          onClick={() => scene && void takeScene(scene.id)}
          className="h-10 min-w-[170px] bg-live text-[14px] font-bold tracking-[0.14em] text-white hover:bg-live/85 disabled:bg-muted"
          title="Ctrl/⌘ + Enter"
        >
          {busy ? "TRANSITIONING…" : isLiveAlready ? "RE-TAKE LIVE" : "TAKE LIVE"}
        </Button>
      </div>
    </div>
  );
}

function LiveCueStrip() {
  const rt = useShow((s) => s.program.runtime);
  const standby = useShow((s) => s.program.standby);
  const [, force] = useState(0);
  useEffect(() => {
    const h = setInterval(() => force((n) => n + 1), 400);
    return () => clearInterval(h);
  }, []);
  const disabled = !rt || standby;
  const cues = rt?.scene.cues ?? [];
  const nextCue = rt ? cues[rt.cuePointer] : undefined;
  const paused = rt?.clock.pausedAt != null;
  const pend = pendingCount("program");
  return (
    <div className="mt-1.5 flex items-center gap-1 text-[11px]">
      <Button size="sm" disabled={disabled || !nextCue} className="h-7 bg-live px-3 font-bold tracking-wider text-white hover:bg-live/85" onClick={() => cueControl.go("program")} title="Fire the next live cue (G)">
        GO
      </Button>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">Next live cue: </span>
        {nextCue ? (
          <span className="font-medium">
            {rt!.cuePointer + 1}. {nextCue.name}
          </span>
        ) : (
          <span className="text-muted-foreground">{rt ? "end of list" : "—"}</span>
        )}
        {pend > 0 && <span className="ml-2 text-armed">{pend} pending</span>}
      </span>
      <Button size="icon-xs" variant="ghost" disabled={disabled} onClick={() => cueControl.back("program")} aria-label="Previous cue">
        <ChevronLeft />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={disabled} onClick={() => cueControl.skip("program")} aria-label="Skip cue">
        <SkipForward />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={disabled || !rt?.cuePointer} onClick={() => cueControl.repeat("program")} aria-label="Repeat last cue">
        <Repeat />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={!pend} onClick={() => cancelPending("program")} aria-label="Cancel pending delayed actions">
        <CircleStop />
      </Button>
      <Button
        size="xs"
        variant={paused ? "secondary" : "ghost"}
        disabled={disabled}
        className={cn(paused && "text-armed")}
        onClick={() => useShow.getState().dispatch("program", { type: "clock", op: paused ? "resume" : "pause" })}
        title="Freeze/unfreeze all motion on the live output"
      >
        {paused ? <Play /> : <Square />} {paused ? "Resume" : "Freeze"}
      </Button>
    </div>
  );
}

function CueList() {
  const { target, rt } = useControlTarget();
  const [, force] = useState(0);
  useEffect(() => {
    const h = setInterval(() => force((n) => n + 1), 400);
    return () => clearInterval(h);
  }, []);
  if (!rt) return null;
  const cues = rt.scene.cues;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Cues · {rt.scene.name}</h3>
        <span className={cn("rounded-[3px] px-1.5 text-[9.5px] font-bold tracking-wider", target === "program" ? "bg-live text-white" : "bg-preview/20 text-preview")}>{target === "program" ? "LIVE" : "PREVIEW"}</span>
        <div className="ml-auto flex items-center gap-1">
          <CueButtons target={target} />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="space-y-1 px-3 pb-3">
          {cues.map((c, i) => {
            const done = i < rt.cuePointer;
            const next = i === rt.cuePointer;
            return (
              <li
                key={c.id}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-2 py-1.5",
                  next ? (target === "program" ? "border-live bg-live/10" : "border-preview bg-preview/10") : "border-border bg-card/40",
                  done && "opacity-55",
                )}
              >
                <span className="w-6 text-right text-[12px] font-semibold tabular text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium">{c.name}</div>
                  <div className="truncate text-[10.5px] text-muted-foreground">{c.actions.map(describeAction).join(" · ") || "no actions"}</div>
                  {c.notes && <div className="mt-0.5 text-[10.5px] leading-snug text-amber-200/70">{c.notes}</div>}
                </div>
                {next && <span className={cn("text-[10px] font-bold tracking-wider", target === "program" ? "text-live" : "text-preview")}>NEXT</span>}
                <Button size="xs" variant="outline" onClick={() => cueControl.set(target, i)} title="Set as next cue">
                  Standby
                </Button>
                <Button size="xs" className={target === "program" ? "bg-live text-white hover:bg-live/85" : ""} onClick={() => cueControl.fire(target, i)}>
                  Fire
                </Button>
              </li>
            );
          })}
          {cues.length === 0 && <li className="px-2 py-6 text-center text-muted-foreground">No cues. Create them in Scene Builder.</li>}
        </ol>
      </ScrollArea>
    </div>
  );
}

function CueButtons({ target }: { target: Target }) {
  return (
    <>
      <Button size="xs" className={target === "program" ? "bg-live text-white hover:bg-live/85" : "bg-preview text-black hover:bg-preview/85"} onClick={() => cueControl.go(target)}>
        GO next
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => cueControl.back(target)} aria-label="Back">
        <ChevronLeft />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => cueControl.skip(target)} aria-label="Skip">
        <ChevronRight />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => cueControl.repeat(target)} aria-label="Repeat">
        <Repeat />
      </Button>
    </>
  );
}

export function describeAction(a: import("@/core/types").CueAction): string {
  const d = a.delay ? ` +${+a.delay.toFixed(2)}s` : "";
  switch (a.type) {
    case "lion":
      return `lion ${a.action}${d}`;
    case "lion.moveTo":
      return `lion ${a.gait} → ${a.marker}${d}`;
    case "lion.place":
      return `lion at ${a.marker}${d}`;
    case "actor.visible":
      return `${a.visible ? "show" : "hide"} lion${d}`;
    case "effect":
      return `${a.op} effect${d}`;
    case "background":
      return `background${d}`;
    case "layer":
      return `${a.op} layer${d}`;
    case "camera":
      return `camera move${d}`;
    case "timeOfDay":
      return `time of day → ${a.value}${d}`;
    case "takeScene":
      return `take scene (${a.transition?.kind ?? "default"})${d}`;
    case "clip":
      return a.clipId ? `play clip${d}` : `clear video actor${d}`;
    case "blackout":
      return `${a.on ? "blackout" : "lights up"} (${a.fade}s)${d}`;
  }
}
