import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRightLeft,
  ChevronRight,
  CircleDot,
  Clapperboard,
  Crosshair,
  Eye,
  Footprints,
  Gauge,
  Images,
  Keyboard,
  Layers,
  ListOrdered,
  Loader2,
  MapPin,
  Moon,
  Mountain,
  Pause,
  PawPrint,
  Play,
  RotateCcw,
  Route,
  Scan,
  Send,
  SlidersHorizontal,
  Snowflake,
  Sparkles,
  SunMoon,
  TreeDeciduous,
  Video,
  Volume2,
  X,
  Megaphone,
  Timer,
  Zap,
  Cable,
  Check,
  MonitorPlay,
  AlertTriangle,
  VolumeX,
  CircleHelp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { sceneNow } from "@/core/clock";
import { nextCueIsAuto } from "@/core/runtime";
import type { CueAction, TransitionKind, TransitionSpec } from "@/core/types";
import { describeMessage, useIo } from "@/engine/io";
import { cancelPending, cueControl, pendingCount, takeScene } from "@/engine/operator";
import { StageView } from "@/render/StageView";
import { selectedScene, useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { NumberInput, SelectBox } from "../fields";
import { FramingBar, FramingOverlay, Timeline } from "../PreviewTools";
import { SceneList, useSceneCodes } from "../SceneList";
import { FireIcon, fireLabel } from "../builder/FireField";
import { InfoTip, Splitter, Tip, usePaneWidths } from "../kit";
import { ControlPanel, useControlTarget } from "./ControlPanel";
import { MediaPanel, useSceneMediaDrop } from "./MediaPanel";
import { MixerPanel } from "./MixerPanel";

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

const PANE_DEFAULTS = [290, 360];

export function ShowMode() {
  const [w, setW, reset] = usePaneWidths("show", PANE_DEFAULTS);
  return (
    // minmax(0,1fr): the column is the window's width, not its widest row, so the side panels never get pushed off-screen.
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto]">
      <div className="flex min-h-0 min-w-0">
        <aside className="min-h-0 shrink-0 border-r border-border" style={{ width: w[0] }}>
          <SceneList />
        </aside>
        <Splitter value={w[0]} onChange={(v) => setW(0, v)} min={200} max={480} onReset={reset} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip">
          <Monitors />
          <CueList />
        </main>
        <Splitter value={w[1]} onChange={(v) => setW(1, v)} min={280} max={560} dir={-1} onReset={reset} />
        <aside className="flex min-h-0 shrink-0 flex-col border-l border-border" style={{ width: w[1] }}>
          <MixerPanel />
          <div className="min-h-0 flex-1">
            <ControlPanel />
          </div>
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

/** Tally chip over a monitor: a coloured dot, the bus name, then what is on it. */
function MonitorHeader({ kind, children, info }: { kind: "preview" | "program"; children: ReactNode; info: ReactNode }) {
  const live = kind === "program";
  return (
    <div className="flex h-8 items-center gap-2 px-0.5">
      <span className={cn("flex items-center gap-1.5 rounded-full px-2 py-0.5 font-key text-[12.5px] font-bold", live ? "bg-live text-white" : "bg-preview/15 text-preview")}>
        <span className={cn("size-2 rounded-full", live ? "bg-white" : "bg-preview")} />
        {live ? "Program" : "Preview"}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">{children}</div>
      <InfoTip side="bottom">{info}</InfoTip>
    </div>
  );
}

function SceneTitle({ scene }: { scene: { id: string; number: number; name: string } | null | undefined }) {
  const codes = useSceneCodes();
  if (!scene) return <span className="text-muted-foreground">Nothing selected</span>;
  // Just the code: the name is in the scene list, and on hover here.
  return (
    <Tip label={scene.name}>
      <span className="font-key font-semibold text-muted-foreground">{codes.get(scene.id) ?? String(scene.number).padStart(2, "0")}</span>
    </Tip>
  );
}

function Monitors() {
  const scene = useProject(selectedScene);
  const program = useShow((s) => s.program);
  const output = useShow((s) => s.output);
  const operatorAudio = useOperatorIsAudioHost();
  const capture = useCaptureThumb();
  const aspect = `${output.canvasWidth} / ${output.canvasHeight}`;

  return (
    <div className="border-b border-border px-3 pb-3 pt-2">
      <div className="grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <MonitorHeader kind="preview" info="Rehearse here: selecting a scene, firing its cues, zooming and scrubbing never reach the audience until you take it live.">
            <SceneTitle scene={scene} />
          </MonitorHeader>
          <div className="relative w-full overflow-hidden rounded-md ring-1 ring-preview/60" style={{ aspectRatio: aspect, maxHeight: "36vh" }}>
            <StageView source="preview" maxDpr={1.25} showSafeArea onCapture={capture} />
            <FramingOverlay />
          </div>
          <PreviewTransport />
          <Timeline editable={false} />
        </div>
        <div className="min-w-0">
          <MonitorHeader kind="program" info="Exactly what the LED wall shows right now.">
            {program.standby ? <span className="text-muted-foreground">Standby picture</span> : <SceneTitle scene={program.runtime?.scene} />}
            {program.transition && (
              <span className="flex items-center gap-1 text-[12px] text-armed">
                <Loader2 className="size-3.5 animate-spin" /> Transition
              </span>
            )}
            {program.blackout?.on && (
              <span className="flex items-center gap-1 text-[12px] font-semibold text-armed">
                <Moon className="size-3.5" /> Blackout
              </span>
            )}
          </MonitorHeader>
          <div className="on-air-frame relative w-full overflow-hidden rounded-md" style={{ aspectRatio: aspect, maxHeight: "36vh" }}>
            <StageView source="program" maxDpr={1.25} showSafeArea audio={operatorAudio} />
            <HeldBadge />
          </div>
          <Timeline target="program" editable={false} />
          <LiveNextCue />
        </div>
      </div>
      <TakeBar />
    </div>
  );
}

/** Over the PROGRAM monitor while the live scene is held, so a hold is never forgotten. */
function HeldBadge() {
  const held = useShow((s) => !s.program.standby && s.program.runtime?.clock.pausedAt != null);
  if (!held) return null;
  return (
    <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded bg-armed px-1.5 py-0.5 font-key text-[12px] font-bold text-black shadow">
      <Pause className="size-3 fill-current" /> HELD
    </span>
  );
}

/** Delayed actions still waiting on the live wall, with a cancel; nothing when there are none. */
function LiveNextCue() {
  const standby = useShow((s) => s.program.standby);
  const pend = pendingCount("program");
  useTick(500);
  if (standby || pend === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-2 text-[12.5px]">
      {pend > 0 && (
        <Tip label="Delayed actions still waiting to fire. Click (or Esc) to cancel them.">
          <button className="flex items-center gap-1 rounded-full bg-armed/15 px-2 py-0.5 text-[11.5px] font-semibold text-armed" onClick={() => cancelPending("program")}>
            <Loader2 className="size-3 animate-spin" /> {pend} <X className="size-3" />
          </button>
        </Tip>
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
  const shots = rt?.scene.cameraShots ?? [];
  return (
    <div className="mt-2 flex items-center gap-1 text-[12px]">
      <Tip label={paused ? "Play the preview" : "Pause the preview"}>
        <Button size="icon-sm" variant="ghost" className="size-8" disabled={!rt} onClick={() => useShow.getState().dispatch("preview", { type: "clock", op: paused ? "resume" : "pause" })}>
          {paused ? <Play /> : <Pause />}
        </Button>
      </Tip>
      <Tip label="Restart the preview from the top">
        <Button size="icon-sm" variant="ghost" className="size-8" disabled={!rt} onClick={() => useShow.getState().restartPreview()}>
          <RotateCcw />
        </Button>
      </Tip>
      <span className="font-key w-[72px] text-[13px] font-semibold tabular text-muted-foreground">
        {fmt(t)}
        {dur ? <span className="font-normal"> / {fmt(dur)}</span> : ""}
      </span>
      {shots.length > 1 && (
        <Tip label="Move the preview's 3D camera to a saved shot">
          <span className="flex items-center gap-1">
            <Video className="size-3.5 text-muted-foreground" />
            <SelectBox
              className="h-7 w-[132px]"
              value="__cam__"
              onChange={(id) => id !== "__cam__" && useShow.getState().dispatch("preview", { type: "camera", shotId: id, delay: 0 })}
              options={[{ value: "__cam__", label: "Camera shot" }, ...shots.map((s) => ({ value: s.id, label: s.name }))]}
            />
          </span>
        </Tip>
      )}
      <div className="ml-auto">
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
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-well p-2">
      <Tip label="How the wall changes to the preview scene when you take it live">
        <ArrowRightLeft className="ml-1 size-4 shrink-0 text-muted-foreground" />
      </Tip>
      <SelectBox className="h-9 w-[150px]" value={spec?.kind ?? "crossfade"} onChange={(kind) => setSpec({ kind })} options={TRANSITIONS} />
      {spec && spec.kind !== "cut" && spec.kind !== "video" && (
        <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
          <NumberInput className="h-9 w-16" value={spec.duration} min={0} max={60} step={0.5} onChange={(duration) => setSpec({ duration })} />s
        </div>
      )}
      {spec?.kind === "wipe" && (
        <SelectBox className="h-9 w-[100px]" value={spec.direction ?? "left"} onChange={(direction) => setSpec({ direction })} options={[{ value: "left", label: "From left" }, { value: "right", label: "From right" }, { value: "up", label: "From top" }, { value: "down", label: "From bottom" }]} />
      )}
      {spec?.kind === "video" && (
        <SelectBox
          className="h-9 w-[180px]"
          value={spec.videoAssetId ?? "__none__"}
          onChange={(v) => setSpec({ videoAssetId: v === "__none__" ? null : v })}
          options={[{ value: "__none__", label: videos.length ? "Choose video" : "No videos imported" }, ...videos.map((v) => ({ value: v.id, label: v.name }))]}
        />
      )}
      {next && (
        <Tip label="Back to the scene's own transition">
          <Button size="icon-sm" variant="ghost" className="size-8" onClick={() => useShow.getState().setNextTransition(null)}>
            <RotateCcw />
          </Button>
        </Tip>
      )}
      <Button
        disabled={!scene || busy}
        onClick={() => scene && void takeScene(scene.id)}
        className="ml-auto h-11 min-w-[200px] gap-2 rounded-lg bg-live font-key text-[17px] font-bold tracking-wide text-white shadow-[0_0_20px_-6px] shadow-live hover:bg-live/85 disabled:bg-muted disabled:shadow-none"
        title="Ctrl/⌘ + Enter"
      >
        {busy ? <Loader2 className="size-5 animate-spin" /> : <CircleDot className="size-5" />}
        {busy ? "Transitioning" : isLiveAlready ? "Re-take live" : "Take live"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- cues

const ACTION_ICON: Record<CueAction["type"], typeof Play> = {
  lion: PawPrint,
  "lion.moveTo": Footprints,
  "lion.place": MapPin,
  "actor.visible": Eye,
  effect: Sparkles,
  "effect.param": SlidersHorizontal,
  background: Mountain,
  layer: Layers,
  camera: Video,
  framing: Scan,
  timeOfDay: SunMoon,
  takeScene: ArrowRightLeft,
  clip: Clapperboard,
  blackout: Moon,
  clock: Snowflake,
  sound: Volume2,
  "audio.fade": VolumeX,
  send: Send,
  timer: Timer,
  announce: Megaphone,
  names: TreeDeciduous,
  route: Route,
  "media.speed": Gauge,
};

/** One small icon per action, each explaining itself on hover. */
function ActionIcons({ actions }: { actions: CueAction[] }) {
  if (!actions.length) return <span className="text-[11.5px] text-muted-foreground">No actions</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {actions.map((a, i) => {
        // An action type this build does not know (a newer show file, a hand edit) gets a ? instead of breaking the list.
        const I = ACTION_ICON[a.type] ?? CircleHelp;
        return (
          <Tip key={i} label={describeAction(a)}>
            <span className="relative grid size-6 place-items-center rounded bg-accent/70 text-muted-foreground">
              <I className="size-3.5" />
              {a.delay > 0 && <span className="absolute -right-1 -top-1 rounded-sm bg-armed px-0.5 font-key text-[9px] font-bold leading-[11px] text-black">+{+a.delay.toFixed(1)}</span>}
            </span>
          </Tip>
        );
      })}
    </span>
  );
}

function CueList() {
  const { target, rt } = useControlTarget();
  const [tab, setTab] = useState<"cues" | "media">("cues");
  const mediaDrop = useSceneMediaDrop();
  useTick(400);
  if (!rt) return null;
  const cues = rt.scene.cues;
  const live = target === "program";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
        <div className="flex rounded-lg bg-well p-0.5">
          {(["cues", "media"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              // Dragging media over the Media tab opens it, so the drop can land on a card.
              onDragEnter={k === "media" ? () => setTab("media") : undefined}
              className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold", tab === k ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {k === "cues" ? <ListOrdered className="size-3.5" /> : <Images className="size-3.5" />}
              {k === "cues" ? "Cues" : "Media"}
              {k === "cues" && <span className="text-muted-foreground">{cues.length}</span>}
            </button>
          ))}
        </div>
        <Tip label={live ? "These cues fire on the live wall" : "These cues fire in the preview only"}>
          <span className={cn("size-2.5 shrink-0 rounded-full", live ? "bg-live" : "bg-preview")} />
        </Tip>
        <div className="ml-auto flex items-center gap-1">
          <CueButtons target={target} />
        </div>
      </div>
      <ScrollArea className={cn("min-h-0 flex-1", tab === "media" && mediaDrop.over && "bg-preview/[0.05] ring-2 ring-inset ring-preview/50")} {...(tab === "media" ? mediaDrop.dropProps : {})}>
        {tab === "media" ? (
          <MediaPanel />
        ) : (
          <ol className="space-y-1.5 px-3 pb-3">
            {cues.map((c, i) => {
              const done = i < rt.cuePointer || !!rt.fired?.includes(c.id);
              const next = i === rt.cuePointer;
              return (
                <li
                  key={c.id}
                  className={cn(
                    "group relative flex items-center gap-3 overflow-hidden rounded-lg border py-2 pl-3 pr-2 transition-colors",
                    next ? (live ? "border-live/60 bg-live/[0.08]" : "border-preview/60 bg-preview/[0.07]") : "border-border bg-card/60 hover:bg-card",
                    done && "opacity-45",
                  )}
                  onDoubleClick={() => cueControl.set(target, i)}
                >
                  {next && <span className={cn("absolute inset-y-0 left-0 w-1", live ? "bg-live" : "bg-preview")} />}
                  <span className={cn("w-7 shrink-0 text-right font-key text-[20px] font-bold leading-none tabular", next ? (live ? "text-live" : "text-preview") : "text-muted-foreground/70")}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {c.fire && c.fire.mode !== "go" && (
                        <Tip label="Fires by itself (GO fires it early)">
                          <span className="shrink-0 rounded border border-armed/50 bg-armed/15 px-1.5 py-px font-key text-[10.5px] font-bold tracking-wider text-armed">AUTO</span>
                        </Tip>
                      )}
                      <span className="truncate text-[14px] font-semibold leading-tight">{c.name}</span>
                      {next &&<ChevronRight className={cn("size-4 shrink-0", live ? "text-live" : "text-preview")} />}
                    </div>
                    {c.fire && c.fire.mode !== "go" && (
                      <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-armed">
                        <FireIcon cue={c} /> fires {fireLabel(c, i, rt.scene)}
                      </div>
                    )}
                    {c.notes && <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-armed/85">{c.notes}</div>}
                    <div className="mt-1">
                      <ActionIcons actions={c.actions} />
                    </div>
                  </div>
                  <Tip label="Make this the next cue (without firing it)">
                    <Button size="icon-sm" variant="ghost" className={cn("size-9 text-muted-foreground", next && "invisible")} onClick={() => cueControl.set(target, i)}>
                      <Crosshair />
                    </Button>
                  </Tip>
                  {c.fire && c.fire.mode !== "go" ? (
                    <Tip label={live ? "This cue fires by itself. Trigger it by hand now, on the live wall" : "This cue fires by itself. Trigger it by hand now, in the preview"}>
                      <Button size="sm" variant="outline" className={cn("h-9 rounded-lg px-2.5 text-[12px] font-semibold", live ? "border-live/60 text-live hover:text-live" : "text-foreground")} onClick={() => cueControl.fire(target, i)}>
                        Fire now
                      </Button>
                    </Tip>
                  ) : (
                    <Tip label={live ? "Fire this cue on the live wall" : "Fire this cue in the preview"}>
                      <Button size="icon-sm" className={cn("size-9 rounded-lg", live ? "bg-live text-white hover:bg-live/85" : "bg-accent text-foreground hover:bg-accent/70")} onClick={() => cueControl.fire(target, i)}>
                        <Zap />
                      </Button>
                    </Tip>
                  )}
                </li>
              );
            })}
            {cues.length === 0 && <li className="px-2 py-8 text-center text-[13px] text-muted-foreground">No cues yet. Add them in Build.</li>}
          </ol>
        )}
      </ScrollArea>
    </div>
  );
}

function CueButtons({ target }: { target: Target }) {
  const live = useShow((s) => (s.program.standby ? null : s.program.runtime));
  const rt = useShow((s) => (target === "program" ? s.program.runtime : s.preview));
  useTick(250);
  // The next cue fires by itself: GO still fires it, early.
  const auto = !!rt && nextCueIsAuto(rt, sceneNow(rt) / 1000);
  return (
    <>
      {target === "preview" && live && (
        <Tip label={`Show the live scene's cues (${live.scene.name})`}>
          <Button size="sm" variant="outline" className="h-9 gap-1.5 border-live/50 text-live hover:text-live" onClick={() => useProject.getState().selectScene(live.scene.id)}>
            <span className="size-2 shrink-0 rounded-full bg-live" />
            Live
          </Button>
        </Tip>
      )}
      <Tip label={`${target === "program" ? "Fire the next cue on the live wall (G)" : "Fire the next cue in the preview (G)"}${auto ? ". It would fire by itself; GO fires it now." : ""}`}>
        <Button
          className={cn(
            "h-10 min-w-[120px] gap-2 rounded-lg font-key text-[17px] font-bold tracking-wide",
            target === "program" ? "bg-live text-white shadow-[0_0_18px_-6px] shadow-live hover:bg-live/85" : "bg-preview text-black hover:bg-preview/85",
          )}
          onClick={() => cueControl.go(target)}
        >
          <Play className="size-4 fill-current" /> GO
        </Button>
      </Tip>
    </>
  );
}

/** One line of health across the bottom. */
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
  const ioOn = midi === "open" || osc === "listening";
  return (
    <div className="flex h-7 items-center gap-4 border-t border-border bg-card px-3 text-[11.5px] text-muted-foreground">
      <Tip label={connected ? `Audience output ${status!.width}×${status!.height}. Slowest frame in the last second: ${status!.frameMs} ms.` : "The audience output window is closed"}>
        <span className={cn("flex items-center gap-1.5", lost ? "text-destructive" : connected ? (slow ? "text-armed" : "text-preview") : "")}>
          {lost ? <AlertTriangle className="size-3.5" /> : <MonitorPlay className="size-3.5" />}
          {lost ? "Output lost" : connected ? `${status!.fps} fps` : "Output closed"}
        </span>
      </Tip>
      <span className={cn("flex items-center gap-1.5", saveError && "text-destructive")}>
        {saveError ? <AlertTriangle className="size-3.5" /> : dirty ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        {saveError ? "Save failed" : dirty ? "Saving" : "Saved"}
      </span>
      <Tip label="MIDI / OSC messages received and sent">
        <span className={cn("flex items-center gap-1.5", ioOn && "text-foreground/80")}>
          <Cable className="size-3.5" />
          {ioOn ? `↓${counters.in} ↑${counters.out}` : "Off"}
        </span>
      </Tip>
      {lastLog && <span className="min-w-0 truncate">{lastLog.text}</span>}
      <Tip
        side="top"
        label={
          <span className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <b>G</b> <span>GO next cue</span>
            <b>⌘ ↵</b> <span>Take the preview live</span>
            <b>⇧ B</b> <span>Blackout on / off</span>
            <b>P</b> <span>Hold / resume the selected scene (the live wall when it is live)</span>
            <b>Esc</b> <span>Cancel waiting delayed actions</span>
            <b>↑ ↓</b> <span>Previous / next scene in the preview</span>
          </span>
        }
      >
        <span className="ml-auto flex items-center gap-1.5">
          <Keyboard className="size-3.5" /> Shortcuts
        </span>
      </Tip>
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
    case "audio.fade":
      return `fade out ${a.which === "all" ? "all audio" : `${a.which.length} sound${a.which.length === 1 ? "" : "s"}`} (${a.fade}s)${d}`;
    case "send":
      return `send ${describeMessage(a.message)}${d}`;
    case "timer": {
      const t = useProject.getState().project.timers?.find((x) => x.id === a.timerId);
      return `${a.op} timer ${t ? `“${t.name}”` : "(missing)"}${d}`;
    }
    case "announce": {
      const x = useProject.getState().project.announcements?.find((y) => y.id === a.announcementId);
      return `announce ${x ? `“${x.name}”` : "(missing)"}${d}`;
    }
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
    default:
      return `unknown action "${(a as { type: string }).type}"${d}`;
  }
}

/** The operator plays the live wall's video sound only while no output window is up (same rule as cue sounds). */
function useOperatorIsAudioHost(): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);
  const s = useShow.getState();
  const outputUp = !!s.outputStatus && Date.now() - s.outputSeenAt < 3500;
  return !outputUp;
}
