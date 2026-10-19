import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Cable,
  Check,
  Clapperboard,
  FileDown,
  FileUp,
  History,
  Loader2,
  MonitorCog,
  MonitorPlay,
  MonitorX,
  Moon,
  MoreHorizontal,
  PackageOpen,
  PackagePlus,
  PencilRuler,
  Power,
  RotateCcw,
  Save,
  TvMinimalPlay,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { closeOutputWindow, exportProject, importProject, openOutputWindow } from "@/core/platform";
import { useProject, NO_ITEMS } from "@/store/project";
import { useShow } from "@/store/show";
import { useIo } from "@/engine/io";
import { clearLiveState } from "@/engine/persist";
import { OutputSettingsDialog } from "./OutputSettings";
import { IoDialog } from "./io/IoDialog";
import { ShowPackageDialog, startPackageExport, startPackageImport } from "./ShowPackage";
import { getErrors, onErrors } from "./ErrorBoundary";
import { RoundToggle, Tip, ToolbarButton } from "./kit";
import { useSceneCodes } from "./SceneList";
import { now } from "@/core/clock";
import { formatClock, timerLeft } from "@/core/timers";
import { useAgent } from "@/agent/bridge";

export function TopBar() {
  const mode = useProject((s) => s.mode);
  const name = useProject((s) => s.project.name);
  const dirty = useProject((s) => s.dirty);
  const savedAt = useProject((s) => s.savedAt);
  const saveError = useProject((s) => s.saveError);
  const output = useProject((s) => s.project.output);
  const program = useShow((s) => s.program);
  const status = useShow((s) => s.outputStatus);
  const seenAt = useShow((s) => s.outputSeenAt);
  const outputLostAt = useShow((s) => s.outputLostAt);
  const restoredAt = useShow((s) => s.restoredAt);
  const midiStatus = useIo((s) => s.midiStatus);
  const oscStatus = useIo((s) => s.oscStatus);
  const ioErr = useIo((s) => s.midiStatus === "error" || s.oscStatus === "error");
  const [settings, setSettings] = useState(false);
  const [io, setIo] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [errCount, setErrCount] = useState(() => getErrors().length);
  useEffect(() => onErrors(() => setErrCount(getErrors().length)), []);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(h);
  }, []);
  const connected = !!status && Date.now() - seenAt < 3500;
  const live = program.standby ? null : program.runtime?.scene;
  const codes = useSceneCodes();
  const ioOn = midiStatus === "open" || oscStatus === "listening";
  const blackout = !!program.blackout?.on;

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-border bg-card px-2">
      <div className="flex items-center gap-2 pl-1 pr-2">
        <span className="grid size-8 place-items-center rounded-md bg-armed/15 text-armed">
          <Clapperboard className="size-4" />
        </span>
        <div className="hidden leading-tight xl:block">
          <div className="font-key text-[14px] font-bold">Salvation Live</div>
          <div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{name}</div>
        </div>
      </div>

      <div className="flex items-center gap-0.5 border-l border-border pl-2">
        <ToolbarButton icon={<TvMinimalPlay />} label="Show" active={mode === "show"} onClick={() => useProject.getState().setMode("show")} tip="Run the show: preview, take live, fire cues" />
        <ToolbarButton icon={<PencilRuler />} label="Build" active={mode === "builder"} onClick={() => useProject.getState().setMode("builder")} tip="Build scenes: components, cues, camera. Edits only touch the preview." />
      </div>

      {/* On-air tally: what the audience is looking at right now. */}
      <div className="mx-auto flex min-w-0 items-center gap-2">
        <div className={cn("flex min-w-0 items-center gap-2 rounded-full border px-3 py-1.5", live ? "border-live/50 bg-live/10" : "border-border bg-well")}>
          <span className={cn("size-2.5 shrink-0 rounded-full", live ? "tally-pulse bg-live" : "bg-muted-foreground/50")} />
          <span className={cn("font-key text-[13px] font-bold", live ? "text-live" : "text-muted-foreground")}>{live ? "On air" : "Standby"}</span>
          {live && (
            <span className="min-w-0 truncate text-[13px]">
              <span className="font-key font-semibold text-muted-foreground">{codes.get(live.id) ?? live.number}</span> {live.name}
            </span>
          )}
        </div>
        {blackout && (
          <Tip label="The wall is blacked out" side="bottom">
            <span className="grid size-7 place-items-center rounded-full bg-armed text-black">
              <Moon className="size-3.5" />
            </span>
          </Tip>
        )}
        {restoredAt && Date.now() - restoredAt < 60000 && (
          <Tip label="The app restarted and picked the show up where it was" side="bottom">
            <span className="grid size-7 place-items-center rounded-full border border-preview/50 text-preview">
              <History className="size-3.5" />
            </span>
          </Tip>
        )}
        {outputLostAt && (
          <span className="flex items-center gap-1.5 rounded-full bg-destructive px-2.5 py-1 text-[12px] font-semibold text-white">
            <AlertTriangle className="size-3.5" /> Output lost, reopening
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <ToolbarButton icon={<MonitorCog />} label="Screens" onClick={() => setSettings(true)} tip="Wall size, output display, standby picture, safe area" />
        <ToolbarButton
          icon={<Cable className={cn(ioErr ? "text-destructive" : ioOn && "text-preview")} />}
          label="Control"
          onClick={() => setIo(true)}
          tip={`MIDI / OSC show control (lighting console, sound)${ioOn ? `: ${[midiStatus === "open" && "MIDI", oscStatus === "listening" && "OSC"].filter(Boolean).join(" + ")} on` : ""}`}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex h-12 min-w-[50px] flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-[18px]">
              <MoreHorizontal />
              <span className="leading-none">More</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void useProject.getState().save()}>
              <Save /> Save now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportProject(useProject.getState().project)}>
              <FileDown /> Export show file…
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                const p = await importProject();
                if (p) await useProject.getState().replaceProject(p);
              }}
            >
              <FileUp /> Import show file…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void startPackageExport()}>
              <PackagePlus /> Export show package (with media)…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void startPackageImport()}>
              <PackageOpen /> Import show package…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                useShow.getState().setStandby(true);
                clearLiveState();
              }}
            >
              <MonitorX /> Forget live state (fresh start)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirmReset(true)}>
              <RotateCcw /> Reset to demo show…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-1.5 border-l border-border pl-2.5">
        <RoundToggle
          on={connected}
          tone="preview"
          label="Output"
          icon={<MonitorPlay />}
          tip={connected ? `Audience output open: ${status!.width}×${status!.height}, ${status!.fps} fps. Click to close it.` : "Open the audience output on the LED wall's display"}
          onClick={async () => {
            if (connected) {
              await closeOutputWindow();
              useShow.setState({ outputStatus: null, outputSeenAt: 0 });
            } else void openOutputWindow(output);
          }}
        />
        <RoundToggle on={blackout} tone="armed" label="Blackout" icon={<Moon />} tip="Fade the whole wall to black, and back (Shift+B)" onClick={() => useShow.getState().setBlackout(!blackout)} />
        <RoundToggle on={program.standby} tone="armed" label="Standby" icon={<Power />} tip="Fade the wall to the safe standby picture, and back" onClick={() => useShow.getState().setStandby(!program.standby)} />
      </div>

      <div className="flex items-center gap-2 border-l border-border pl-2.5 pr-1">
        {errCount > 0 && (
          <Tip label={getErrors().slice(-5).map((e) => e.text).join("\n") || "Errors"} side="bottom">
            <span className="flex items-center gap-1 text-[12px] text-armed">
              <AlertTriangle className="size-4" /> {errCount}
            </span>
          </Tip>
        )}
        <AgentBadge />
        <Tip label={saveError ? `Save failed: ${saveError}` : dirty ? "Saving…" : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : "Saved"} side="bottom">
          <span className={cn("grid size-6 place-items-center", saveError ? "text-destructive" : "text-muted-foreground")}>
            {saveError ? <AlertTriangle className="size-4" /> : dirty ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          </span>
        </Tip>
        <RunningTimers />
        <span className="font-key w-[70px] text-right text-[15px] font-semibold tabular text-foreground/80">{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
      </div>

      <OutputSettingsDialog open={settings} onOpenChange={setSettings} />
      <IoDialog open={io} onOpenChange={setIo} />
      <ShowPackageDialog />
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace the show with the demo?</DialogTitle>
            <DialogDescription>All current scenes and cues are replaced by the built-in show. Export the show file first if you want to keep it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                useProject.getState().resetToDemo();
                setConfirmReset(false);
              }}
            >
              Replace show
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

/** An AI agent (MCP) is connected, or agent control is switched off. Click to switch it on/off. */
function AgentBadge() {
  const { enabled, connected, last, commands } = useAgent();
  if (enabled && !connected) return null;
  const tip = !enabled
    ? "Agent control is off: AI agents cannot connect. Click to allow."
    : `An AI agent is connected and can control the app (${commands} change${commands === 1 ? "" : "s"}${last ? `, last: ${last.method}${last.ok ? "" : " (failed)"}` : ""}). Click to disconnect it and switch agent control off.`;
  return (
    <Tip label={tip} side="bottom">
      <button
        type="button"
        onClick={() => useAgent.getState().setEnabled(!enabled)}
        className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-semibold", enabled ? "border-preview/60 text-preview" : "border-border text-muted-foreground line-through")}
      >
        <Bot className="size-3.5" /> Agent
      </button>
    </Tip>
  );
}

/** Running show timers, readable from anywhere in the app. */
function RunningTimers() {
  const runs = useShow((s) => s.program.timers);
  const defs = useProject((s) => s.project.timers ?? NO_ITEMS);
  const [, force] = useState(0);
  const running = defs.filter((d) => runs?.[d.id]?.running);
  useEffect(() => {
    if (!running.length) return;
    const h = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(h);
  }, [running.length]);
  if (!running.length) return null;
  return (
    <>
      {running.map((d) => {
        const left = timerLeft(runs?.[d.id], d.duration, now());
        return (
          <Tip key={d.id} label={`${d.name} timer (Show Mode → Timers)`} side="bottom">
            <span className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px]", left <= 60 ? "border-armed/60 text-armed" : "border-preview/50 text-preview")}>
              <Timer className="size-3.5" />
              <span className="max-w-[90px] truncate">{d.name}</span>
              <span className="font-key font-bold tabular">{formatClock(left)}</span>
            </span>
          </Tip>
        );
      })}
    </>
  );
}
