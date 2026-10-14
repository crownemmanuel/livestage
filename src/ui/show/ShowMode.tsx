import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, Power, Repeat, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { sceneNow } from "@/core/clock";
import type { TransitionKind, TransitionSpec } from "@/core/types";
import { describeMessage, useIo } from "@/engine/io";
import { cancelPending, cueControl, pendingCount, takeScene } from "@/engine/operator";
import { StageView } from "@/render/StageView";
import { selectedScene, useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { NumberInput, SelectBox } from "../fields";
import { FramingBar, FramingOverlay, VideoScrubber } from "../PreviewTools";
import { SceneList } from "../SceneList";
import { ControlPanel, useControlTarget } from "./ControlPanel";
import { MediaPanel } from "./MediaPanel";

export const TRANSITIONS: { value: TransitionKind; label: string }[] = [
  { value: "cut", label: "Cut" },
  { value: "crossfade", label: "Crossfade" },
  { value: "fadeblack", label: "Fade to black" },
  { value: "dissolve", label: "Dissolve" },
  { value: "wipe", label: "Soft wipe" },
  { value: "burn", label: "Burn away" },
  { value: "travel", label: "Camera travel" },
  { value: "video", label: "Video transition" },
];

export function ShowMode() {
  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr_auto]">
      <div className="grid min-h-0 grid-cols-[264px_1fr_372px]">
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
      <StatusBar />
    </div>
  );
}

export function useCaptureThumb() {
  return (sceneId: string, d: string) => useProject.getState().setThumbnail(sceneId, d);
}

/** Re-render on a slow tick so clocks and fade levels stay current. */
function useTick(ms: number) {
  const [, force] = useState(0);
  useEffect(() => {
    const h = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
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
  const aspect = `${output.canvasWidth} / ${output.canvasHeight}`;
  const liveName = program.standby ? "Standby" : program.runtime ? `${String(program.runtime.scene.number).padStart(2, "0")} · ${program.runtime.scene.name}` : "—";

  return (
    <div className="border-b border-border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <MonitorLabel kind="preview">
            <span className="truncate text-foreground">{scene ? `${String(scene.number).padStart(2, "0")} · ${scene.name}` : "—"}</span>
          </MonitorLabel>
          <div className="relative w-full overflow-hidden rounded-sm ring-2 ring-preview/70" style={{ aspectRatio: aspect, maxHeight: "34vh" }}>
            <StageView source="preview" maxDpr={1.25} showSafeArea onCapture={capture} />
            <FramingOverlay />
          </div>
          <PreviewTransport />
          <VideoScrubber />
        </div>
        <div className="min-w-0">
          <MonitorLabel kind="program">
            <span className="truncate text-foreground">{liveName}</span>
            {program.transition && <span className="animate-pulse text-armed">transition…</span>}
            {program.blackout?.on && <span className="font-bold text-armed">BLACKOUT</span>}
          </MonitorLabel>
          <div className="relative w-full overflow-hidden rounded-sm ring-2 ring-live" style={{ aspectRatio: aspect, maxHeight: "34vh" }}>
            <StageView source="program" maxDpr={1.25} showSafeArea />
          </div>
          <LiveNextCue />
        </div>
      </div>
      <TakeBar />
    </div>
  );
}

/** Read-only: what the live scene's next cue is, even while another scene is in the preview. */
function LiveNextCue() {
  const rt = useShow((s) => s.program.runtime);
  const standby = useShow((s) => s.program.standby);
  const pend = pendingCount("program");
  useTick(500);
  if (!rt || standby) return <div className="mt-1.5 text-[11px] text-muted-foreground">Nothing live</div>;
  const next = rt.scene.cues[rt.cuePointer];
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px]">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Live next</span>
      <span className="min-w-0 flex-1 truncate">{next ? `${rt.cuePointer + 1}. ${next.name}` : <span className="text-muted-foreground">end of cue list</span>}</span>
      {pend > 0 && (
        <button className="text-armed hover:underline" onClick={() => cancelPending("program")} title="Cancel delayed actions still waiting (Esc)">
          {pend} pending · cancel
        </button>
      )}
    </div>
  );
}

function PreviewTransport() {
  const rt = useShow((s) => s.preview);
  useTick(500);
  const paused = rt?.clock.pausedAt != null;
  const t = rt ? sceneNow(rt) / 1000 : 0;
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
        <FramingBar />

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
      <SelectBox className="w-[140px]" value={spec?.kind ?? "crossfade"} onChange={(kind) => setSpec({ kind })} options={TRANSITIONS} />
      {spec && spec.kind !== "cut" && spec.kind !== "video" && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <NumberInput className="h-7 w-16" value={spec.duration} min={0} max={60} step={0.5} onChange={(duration) => setSpec({ duration })} />s
        </div>
      )}
      {spec?.kind === "wipe" && (
        <SelectBox className="w-[90px]" value={spec.direction ?? "left"} onChange={(direction) => setSpec({ direction })} options={[{ value: "left", label: "from L" }, { value: "right", label: "from R" }, { value: "up", label: "from top" }, { value: "down", label: "from bottom" }]} />
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
          className={cn("h-11 min-w-[112px] font-semibold", program.blackout?.on && "border border-armed bg-armed/20 text-armed")}
          onClick={() => useShow.getState().setBlackout(!program.blackout?.on)}
          title="Shift+B · Lights out: fade the whole wall to black (and back)"
        >
          {program.blackout?.on ? "LIGHTS UP" : "BLACKOUT"}
        </Button>
        <Button variant={program.standby ? "secondary" : "outline"} className={cn("h-11 gap-2 font-semibold", program.standby && "border border-armed text-armed")} onClick={() => useShow.getState().setStandby(!program.standby)} title="Fade the audience output to the safe standby visual">
          <Power /> {program.standby ? "IN STANDBY" : "STANDBY"}
        </Button>
        <Button
          disabled={!scene || busy}
          onClick={() => scene && void takeScene(scene.id)}
          className="h-11 min-w-[190px] bg-live text-[15px] font-bold tracking-[0.14em] text-white shadow-[0_0_0_1px] shadow-live/40 hover:bg-live/85 disabled:bg-muted"
          title="Ctrl/⌘ + Enter"
        >
          {busy ? "TRANSITIONING…" : isLiveAlready ? "RE-TAKE LIVE" : "TAKE LIVE"}
        </Button>
      </div>
    </div>
  );
}

function CueList() {
  const { target, rt } = useControlTarget();
  const [tab, setTab] = useState<"cues" | "media">("cues");
  useTick(400);
  if (!rt) return null;
  const cues = rt.scene.cues;
  const live = target === "program";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex rounded-md border border-border p-0.5">
          {(["cues", "media"] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)} className={cn("rounded-[5px] px-3 py-1 text-[11px] font-semibold tracking-wider", tab === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
              {k === "cues" ? `CUES (${cues.length})` : "MEDIA"}
            </button>
          ))}
        </div>
        <span className="truncate text-[11px] text-muted-foreground">{rt.scene.name}</span>
        <span className={cn("rounded-[3px] px-1.5 text-[9.5px] font-bold tracking-wider", live ? "bg-live text-white" : "bg-preview/20 text-preview")}>{live ? "LIVE" : "PREVIEW"}</span>
        <div className="ml-auto flex items-center gap-1">
          <CueButtons target={target} />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "media" ? <MediaPanel /> : <ol className="space-y-1 px-3 pb-3">
          {cues.map((c, i) => {
            const done = i < rt.cuePointer;
            const next = i === rt.cuePointer;
            return (
              <li
                key={c.id}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-2.5 py-2",
                  next ? (live ? "border-live bg-live/10 shadow-[inset_3px_0_0] shadow-live" : "border-preview bg-preview/10 shadow-[inset_3px_0_0] shadow-preview") : "border-border bg-card/40",
                  done && "opacity-50",
                )}
                onDoubleClick={() => cueControl.set(target, i)}
                title="Double-click: make this the next cue"
              >
                <span className={cn("w-7 text-right text-[14px] font-bold tabular", next ? (live ? "text-live" : "text-preview") : "text-muted-foreground")}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium leading-tight">{c.name}</div>
                  <div className="truncate text-[10.5px] text-muted-foreground">{c.actions.map(describeAction).join(" · ") || "no actions"}</div>
                  {c.notes && <div className="mt-0.5 text-[11.5px] leading-snug text-amber-200/80">{c.notes}</div>}
                </div>
                {next && <span className={cn("text-[10px] font-bold tracking-wider", live ? "text-live" : "text-preview")}>NEXT</span>}
                <Button size="xs" variant="outline" className="h-7" onClick={() => cueControl.set(target, i)} title="Make this the next cue (without firing it)">
                  Standby
                </Button>
                <Button size="xs" className={cn("h-7 min-w-[52px] font-semibold", live ? "bg-live text-white hover:bg-live/85" : "")} onClick={() => cueControl.fire(target, i)}>
                  Fire
                </Button>
              </li>
            );
          })}
          {cues.length === 0 && <li className="px-2 py-6 text-center text-muted-foreground">No cues. Create them in Scene Builder.</li>}
        </ol>}
      </ScrollArea>
    </div>
  );
}

function CueButtons({ target }: { target: Target }) {
  const live = useShow((s) => (s.program.standby ? null : s.program.runtime));
  return (
    <>
      {target === "preview" && live && (
        <Button size="xs" variant="outline" className="border-live/50 text-live" onClick={() => useProject.getState().selectScene(live.scene.id)} title="Show the live scene's cues">
          Live: {live.scene.name.slice(0, 22)}
        </Button>
      )}
      <Button size="sm" className={cn("h-9 min-w-[110px] text-[13px] font-bold tracking-wider", target === "program" ? "bg-live text-white hover:bg-live/85" : "bg-preview text-black hover:bg-preview/85")} onClick={() => cueControl.go(target)} title="Fire the next cue (G)">
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

/** One line of health across the bottom: output, saving, I/O, keys. */
function StatusBar() {
  const status = useShow((s) => s.outputStatus);
  const seenAt = useShow((s) => s.outputSeenAt);
  const lost = useShow((s) => s.outputLostAt);
  const dirty = useProject((s) => s.dirty);
  const saveError = useProject((s) => s.saveError);
  const counters = useIo((s) => s.counters);
  const midi = useIo((s) => s.midiStatus);
  const osc = useIo((s) => s.oscStatus);
  const lastLog = useIo((s) => s.log[s.log.length - 1]);
  useTick(1000);
  const connected = !!status && Date.now() - seenAt < 3500;
  const slow = connected && status!.frameMs > 60;
  return (
    <div className="flex h-7 items-center gap-4 border-t border-border bg-card px-3 text-[10.5px] text-muted-foreground">
      <span className={cn("flex items-center gap-1.5", lost ? "text-destructive" : connected ? (slow ? "text-armed" : "text-preview") : "")}>
        <span className={cn("size-1.5 rounded-full", lost ? "bg-destructive" : connected ? (slow ? "bg-armed" : "bg-preview") : "bg-muted-foreground/50")} />
        {lost ? "Output lost — reopening" : connected ? `Output ${status!.fps} fps · worst frame ${status!.frameMs} ms` : "Output closed"}
      </span>
      <span className={cn(saveError && "text-destructive")}>{saveError ? "Save failed" : dirty ? "Saving…" : "Show file saved"}</span>
      <span className={cn((midi === "open" || osc === "listening") && "text-foreground/80")}>
        I/O {midi === "open" ? "MIDI" : ""}
        {midi === "open" && osc === "listening" ? " + " : ""}
        {osc === "listening" ? "OSC" : ""}
        {midi !== "open" && osc !== "listening" ? "off" : ""} · in {counters.in} · out {counters.out}
      </span>
      {lastLog && <span className="min-w-0 truncate">{lastLog.text}</span>}
      <span className="ml-auto flex gap-3 tabular">
        <span>
          <kbd className="rounded border border-border px-1">G</kbd> GO
        </span>
        <span>
          <kbd className="rounded border border-border px-1">⌘↵</kbd> TAKE
        </span>
        <span>
          <kbd className="rounded border border-border px-1">⇧B</kbd> blackout
        </span>
        <span>
          <kbd className="rounded border border-border px-1">Esc</kbd> cancel pending
        </span>
        <span>
          <kbd className="rounded border border-border px-1">↑↓</kbd> preview scene
        </span>
      </span>
    </div>
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
    case "clock":
      return `${a.op === "pause" ? "freeze" : a.op === "resume" ? "resume" : "freeze/resume"}${d}`;
    case "sound":
      return `sound${d}`;
    case "send":
      return `send ${describeMessage(a.message)}${d}`;
    case "names":
      return `names: ${a.op}${a.op === "set" ? ` ${a.value}` : ""}${d}`;
    case "route":
      return `route: ${a.op}${d}`;
    case "media.speed":
      return `speed → ${a.rate}× over ${a.duration}s${d}`;
    case "effect.param":
      return `${a.key} = ${String(a.value)}${d}`;
    case "framing":
      return `framing ${a.zoom.toFixed(2)}× over ${a.duration}s${d}`;
  }
}
