import { useEffect, useState } from "react";
import { AlertTriangle, Cable, Clapperboard, FileDown, FileUp, Menu, MonitorPlay, MonitorX, RotateCcw, Save, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { closeOutputWindow, exportProject, importProject, openOutputWindow } from "@/core/platform";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { OutputSettingsDialog } from "./OutputSettings";
import { IoDialog } from "./io/IoDialog";
import { useIo } from "@/engine/io";
import { getErrors, onErrors } from "./ErrorBoundary";
import { clearLiveState } from "@/engine/persist";

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
  const [settings, setSettings] = useState(false);
  const [io, setIo] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const outputLostAt = useShow((s) => s.outputLostAt);
  const restoredAt = useShow((s) => s.restoredAt);
  const midiStatus = useIo((s) => s.midiStatus);
  const oscStatus = useIo((s) => s.oscStatus);
  const ioErr = useIo((s) => s.midiStatus === "error" || s.oscStatus === "error");
  const [errCount, setErrCount] = useState(() => getErrors().length);
  useEffect(() => onErrors(() => setErrCount(getErrors().length)), []);
  const ioOn = midiStatus === "open" || oscStatus === "listening";
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(h);
  }, []);
  const connected = !!status && Date.now() - seenAt < 3500;
  const live = program.standby ? null : program.runtime?.scene;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <div className="flex items-center gap-2">
        <Clapperboard className="size-4 text-armed" />
        <div className="leading-none">
          <div className="text-[11px] font-bold tracking-[0.2em]">SALVATION LIVE STUDIO</div>
          <div className="mt-0.5 max-w-[220px] truncate text-[10.5px] text-muted-foreground">{name}</div>
        </div>
      </div>

      <div className="ml-2 flex rounded-md border border-border p-0.5">
        {(["show", "builder"] as const).map((m) => (
          <button
            key={m}
            onClick={() => useProject.getState().setMode(m)}
            className={cn("rounded-[5px] px-3 py-1 text-[11px] font-semibold tracking-wider", mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
          >
            {m === "show" ? "SHOW MODE" : "SCENE BUILDER"}
          </button>
        ))}
      </div>

      <div className="mx-auto flex min-w-0 items-center gap-2 text-[12px]">
        <span className={cn("rounded-[3px] px-1.5 py-px text-[10px] font-bold tracking-[0.14em]", live ? "bg-live text-white" : "bg-muted text-muted-foreground")}>{live ? "ON AIR" : "STANDBY"}</span>
        <span className="truncate">{live ? `${String(live.number).padStart(2, "0")} · ${live.name}` : "Audience sees the standby visual"}</span>
        {program.blackout?.on && <span className="rounded-[3px] bg-armed px-1.5 py-px text-[10px] font-bold tracking-[0.14em] text-black">BLACKOUT</span>}
        {restoredAt && Date.now() - restoredAt < 60000 && (
          <span className="rounded-[3px] border border-preview/50 px-1.5 py-px text-[10px] font-semibold tracking-wider text-preview" title="The operator window restarted and picked the show up where it was">
            RESUMED
          </span>
        )}
        {outputLostAt && (
          <span className="flex items-center gap-1 rounded-[3px] bg-destructive px-1.5 py-px text-[10px] font-bold tracking-[0.14em] text-white">
            <AlertTriangle className="size-3" /> OUTPUT LOST · reopening
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] tabular", connected ? "border-preview/40 text-preview" : "border-border text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full", connected ? "bg-preview" : "bg-muted-foreground/50")} />
          {connected ? `Output ${status!.width}×${status!.height} · ${status!.fps} fps` : "Output closed"}
        </div>
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await closeOutputWindow();
              // A closed webview may not get to send its goodbye; clear status right away.
              useShow.setState({ outputStatus: null, outputSeenAt: 0 });
            }}
          >
            <MonitorX /> Close output
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void openOutputWindow(output)}>
            <MonitorPlay /> Open output
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setSettings(true)}>
          <Settings2 /> Output
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setIo(true)} title="MIDI / OSC show control" className={cn(ioErr && "text-destructive")}>
          <Cable className={cn(ioOn && "text-preview")} /> I/O
        </Button>
        {errCount > 0 && (
          <span className="flex items-center gap-1 text-[10.5px] text-armed" title={getErrors().slice(-5).map((e) => e.text).join("\n")}>
            <AlertTriangle className="size-3.5" /> {errCount}
          </span>
        )}
        <span className={cn("w-16 text-right text-[10.5px]", saveError ? "text-destructive" : "text-muted-foreground")} title={saveError ?? (savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : "")}>
          {saveError ? "save failed" : dirty ? "saving…" : "saved"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Show file menu">
              <Menu />
            </Button>
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
                if (p) useProject.getState().replaceProject(p);
              }}
            >
              <FileUp /> Import show file…
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
        <span className="w-[62px] text-right font-mono text-[12px] tabular text-muted-foreground">{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
      </div>
      <OutputSettingsDialog open={settings} onOpenChange={setSettings} />
      <IoDialog open={io} onOpenChange={setIo} />
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace the show with the demo?</DialogTitle>
            <DialogDescription>All current scenes and cues are replaced by the two prototype scenes. Export the show file first if you want to keep it.</DialogDescription>
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
