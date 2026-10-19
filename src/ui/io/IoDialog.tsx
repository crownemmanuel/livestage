import { useEffect, useState, type ReactNode } from "react";
import { Activity, Cable, ChevronRight, Lightbulb, Play, Plug, Plus, Radio, RefreshCw, Square, Trash2, Wand2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import { defaultIo, HOG_DEFAULT_HOST } from "@/core/factories";
import type { HogItem, HogKind, IoAction, IoMatch, IoSettings, IoTrigger } from "@/core/types";
import { describeIncoming, describeMatch, HOG_KIND_LABEL, hogTarget, injectIncoming, matchFromIncoming, refreshMidiPorts, sendMessage, useIo } from "@/engine/io";
import { describeIoAction } from "@/engine/operator";
import { useProject } from "@/store/project";
import { Field, NumberInput, Section, SelectBox } from "../fields";
import { InfoTip } from "../kit";
import { MessageFields, defaultMessage } from "./MessageFields";

const NONE = "__none__";

function useIoSettings(): [IoSettings, (fn: (io: IoSettings) => void) => void] {
  const io = useProject((s) => s.project.io) ?? defaultIo();
  const set = (fn: (io: IoSettings) => void) =>
    useProject.getState().update((p) => {
      p.io ??= defaultIo();
      fn(p.io);
    });
  return [io, set];
}

const TAB = "gap-1.5 text-[12px] [&_svg]:size-3.5";

export function IoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  useEffect(() => {
    if (open) void refreshMidiPorts();
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle>Show control</DialogTitle>
          <DialogDescription>Connect the lighting console, name the lighting cues you fire from the show, and watch what goes in and out.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="connection">
          <TabsList className="h-9">
            <TabsTrigger value="connection" className={TAB}>
              <Plug /> Connection
            </TabsTrigger>
            <TabsTrigger value="library" className={TAB}>
              <Lightbulb /> Lighting library
            </TabsTrigger>
            <TabsTrigger value="triggers" className={TAB}>
              <Zap /> Incoming triggers
            </TabsTrigger>
            <TabsTrigger value="log" className={TAB}>
              <Activity /> Monitor
            </TabsTrigger>
          </TabsList>
          <TabsContent value="connection">
            <ConnectionTab />
          </TabsContent>
          <TabsContent value="library">
            <LibraryTab />
          </TabsContent>
          <TabsContent value="triggers">
            <TriggersTab />
          </TabsContent>
          <TabsContent value="log">
            <LogTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={cn("inline-block size-2 rounded-full", ok ? "bg-preview" : warn ? "bg-destructive" : "bg-muted-foreground/40")} />;
}

/** A rounded panel with an icon title; the building block of the I/O tabs. */
function Card({ icon, title, info, right, children, className }: { icon: ReactNode; title: string; info?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-card/50 p-3", className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-foreground/80 [&_svg]:size-3.5">{icon}</span>
        <h3 className="text-[12.5px] font-semibold">{title}</h3>
        {info && <InfoTip>{info}</InfoTip>}
        <div className="ml-auto">{right}</div>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Pill({ ok, warn, children }: { ok: boolean; warn?: boolean; children: ReactNode }) {
  return (
    <span className={cn("flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium", ok ? "bg-preview/15 text-preview" : warn ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>
      <StatusDot ok={ok} warn={warn} /> {children}
    </span>
  );
}

function ConnectionTab() {
  const [io, set] = useIoSettings();
  const st = useIo();
  const hog = hogTarget(io);
  const others = io.osc.targets.filter((t) => t.id !== hog?.id);
  const lastHog = [...st.log].reverse().find((e) => e.text.startsWith("Hog ") || e.text.includes("/hog/"));
  const setHog = (fn: (t: IoSettings["osc"]["targets"][number]) => void) =>
    set((x) => {
      let t = hogTarget(x);
      if (!t) x.osc.targets.unshift((t = { id: "osc_hog", name: "Hog 4", host: HOG_DEFAULT_HOST, port: 7001 }));
      fn(t);
    });
  const input = "h-8 rounded-md border border-input bg-transparent px-2.5 font-mono text-[12.5px]";

  return (
    <div className="space-y-3 pt-1">
      <div className="grid gap-3 md:grid-cols-[1.15fr_1fr]">
        <Card
          icon={<Lightbulb />}
          title="Lighting console (Hog 4)"
          info="Cues and clip markers send GO / release / halt to the console over the network. On the Hog: Setup → Network → console Settings → Open Sound Control → tick OSC In (port 7001). This computer needs an address on HogNet, e.g. 172.31.0.3 / 255.255.0.0."
          right={lastHog ? <Pill ok={lastHog.dir === "out"} warn={lastHog.dir === "error"}>{lastHog.dir === "error" ? "last send failed" : "sending"}</Pill> : <Pill ok={false}>nothing sent yet</Pill>}
        >
          <div className="grid grid-cols-[1fr_88px] gap-2">
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">Console IP address</span>
              <input className={cn(input, "w-full")} defaultValue={hog?.host ?? HOG_DEFAULT_HOST} key={hog?.host} placeholder={HOG_DEFAULT_HOST} onBlur={(e) => setHog((t) => (t.host = e.target.value.trim()))} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">OSC In port</span>
              <NumberInput className="h-8 text-[12.5px]" value={hog?.port ?? 7001} min={1} max={65535} step={1} onChange={(v) => setHog((t) => (t.port = Math.round(v)))} />
            </label>
          </div>
          {lastHog && (
            <p className={cn("truncate rounded-md bg-black/20 px-2 py-1.5 font-mono text-[11px]", lastHog.dir === "error" ? "text-destructive" : "text-muted-foreground")} title={lastHog.text}>
              {new Date(lastHog.at).toLocaleTimeString([], { hour12: false })} · {lastHog.text}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">Name your cuelists under <span className="text-foreground/80">Lighting library</span>, then add a <span className="text-armed">Lighting</span> action to any cue.</p>
        </Card>

        <Card
          icon={<Radio />}
          title="Receive from the console"
          info={
            <>
              Lets the console (or any OSC device) drive the show. Built-in commands, no mapping needed: /sls/go, /sls/back, /sls/take n, /sls/cue scene cue, /sls/next, /sls/select n, /sls/blackout 0|1, /sls/standby 0|1, /sls/freeze 0|1. Map anything else under Incoming triggers.
            </>
          }
          right={<Pill ok={st.oscStatus === "listening"} warn={st.oscStatus === "error"}>{st.oscStatus}</Pill>}
        >
          {!st.available.osc && <p className="text-[11px] text-armed">Needs the desktop app.</p>}
          <label className="flex items-center justify-between gap-2 text-[12px]">
            <span>Listen for OSC</span>
            <Switch checked={io.osc.enabled} onCheckedChange={(v) => set((x) => (x.osc.enabled = v))} />
          </label>
          <Field label="Listen port" hint="UDP port this computer receives OSC on (set the Hog's OSC Out to this)">
            <NumberInput className="w-24" value={io.osc.listenPort} min={1024} max={65535} step={1} onChange={(v) => set((x) => (x.osc.listenPort = Math.round(v)))} />
          </Field>
          {st.oscError && <p className="text-[11px] text-destructive">{st.oscError}</p>}
        </Card>
      </div>

      <Card
        icon={<Cable />}
        title="MIDI"
        info="For MIDI Show Control from the console (Hog: Setup → Network → console → MIDI, enable MSC out) or MIDI notes from sound. With Follow MSC cues on, MSC GO cue 12 takes scene 12 and cue 12.3 fires cue 3 of scene 12."
        right={
          <span className="flex items-center gap-1">
            <Pill ok={st.midiStatus === "open"} warn={st.midiStatus === "error"}>{st.midiStatus}</Pill>
            <Button size="icon-xs" variant="ghost" onClick={() => void refreshMidiPorts()} aria-label="Refresh ports" title="Refresh ports">
              <RefreshCw />
            </Button>
          </span>
        }
      >
        {!st.available.midi && <p className="text-[11px] text-armed">MIDI needs the desktop app (or Chrome for development).</p>}
        <div className="grid items-end gap-2 sm:grid-cols-[auto_1fr_1fr_auto_auto]">
          <label className="flex h-8 items-center gap-2 text-[12px]">
            <Switch checked={io.midi.enabled} onCheckedChange={(v) => set((x) => (x.midi.enabled = v))} /> On
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Input</span>
            <SelectBox className="h-8" value={io.midi.input ?? NONE} onChange={(v) => set((x) => (x.midi.input = v === NONE ? null : v))} options={[{ value: NONE, label: "— none —" }, ...uniq([...st.midiInputs, ...(io.midi.input ? [io.midi.input] : [])]).map((n) => ({ value: n, label: n }))]} />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Output</span>
            <SelectBox className="h-8" value={io.midi.output ?? NONE} onChange={(v) => set((x) => (x.midi.output = v === NONE ? null : v))} options={[{ value: NONE, label: "— none —" }, ...uniq([...st.midiOutputs, ...(io.midi.output ? [io.midi.output] : [])]).map((n) => ({ value: n, label: n }))]} />
          </label>
          <label className="space-y-1" title="MIDI Show Control device this show answers to (127 = all)">
            <span className="text-[11px] text-muted-foreground">MSC device</span>
            <NumberInput className="h-8 w-16" value={io.midi.mscDeviceId} min={0} max={127} step={1} onChange={(v) => set((x) => (x.midi.mscDeviceId = Math.round(v)))} />
          </label>
          <label className="flex h-8 items-center gap-2 text-[12px]" title='MSC GO cue "12" takes scene 12; cue "12.3" fires cue 3 of scene 12'>
            <Switch checked={io.midi.mscAuto} onCheckedChange={(v) => set((x) => (x.midi.mscAuto = v))} /> Follow MSC cues
          </label>
        </div>
        {st.midiError && <p className="text-[11px] text-destructive">{st.midiError}</p>}
      </Card>

      <details className="group rounded-lg border border-border bg-card/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12px] text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Other OSC devices and announcements
          <span className="ml-auto text-[11px]">{others.length ? `${others.length} more target${others.length > 1 ? "s" : ""}` : ""}</span>
        </summary>
        <div className="space-y-2 border-t border-border px-3 py-3">
          {others.map((t) => (
            <div key={t.id} className="grid grid-cols-[1fr_1fr_80px_24px] items-center gap-1.5 text-[12px]">
              <input className="h-7 rounded-md border border-input bg-transparent px-2" defaultValue={t.name} key={t.id + t.name} onBlur={(e) => set((x) => ((x.osc.targets.find((y) => y.id === t.id) ?? t).name = e.target.value))} />
              <input className="h-7 rounded-md border border-input bg-transparent px-2 font-mono" defaultValue={t.host} key={t.id + t.host} onBlur={(e) => set((x) => ((x.osc.targets.find((y) => y.id === t.id) ?? t).host = e.target.value.trim()))} />
              <NumberInput value={t.port} min={1} max={65535} step={1} onChange={(v) => set((x) => ((x.osc.targets.find((y) => y.id === t.id) ?? t).port = Math.round(v)))} />
              <Button size="icon-xs" variant="ghost" aria-label="Remove target" onClick={() => set((x) => (x.osc.targets = x.osc.targets.filter((y) => y.id !== t.id)))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button size="xs" variant="outline" onClick={() => set((x) => x.osc.targets.push({ id: uid("osc"), name: "Sound / other", host: "172.31.0.20", port: 8000 }))}>
            <Plus /> Add OSC device
          </Button>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-[12px]">
            <Switch checked={io.osc.notify} onCheckedChange={(v) => set((x) => (x.osc.notify = v))} />
            <span>Announce every TAKE and GO</span>
            <InfoTip>Sends /sls/scene &lt;number&gt; &lt;name&gt; on every TAKE and /sls/cue &lt;scene&gt; &lt;cue&gt; &lt;name&gt; on every GO, so another system always knows where the wall is.</InfoTip>
            {io.osc.notify && (
              <SelectBox className="ml-auto w-[160px]" value={io.osc.notifyTarget ?? io.osc.targets[0]?.id ?? NONE} onChange={(v) => set((x) => (x.osc.notifyTarget = v === NONE ? null : v))} options={io.osc.targets.length ? io.osc.targets.map((t) => ({ value: t.id, label: t.name })) : [{ value: NONE, label: "no targets" }]} />
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

const KIND_OPTIONS = (["cuelist", "scene", "macro"] as HogKind[]).map((k) => ({ value: k, label: HOG_KIND_LABEL[k] }));

/** Named Hog cuelists / scenes / macros. Cues point at these by id, so renumbering here updates every cue. */
function LibraryTab() {
  const [io, set] = useIoSettings();
  const scenes = useProject((s) => s.project.scenes);
  const uses = (id: string) => JSON.stringify(scenes).split(`"item":"${id}"`).length - 1;
  const upd = (id: string, fn: (h: HogItem) => void) =>
    set((x) => {
      const h = x.hogItems.find((y) => y.id === id);
      if (h) fn(h);
    });
  const fire = (h: HogItem, op: "go" | "release") => void sendMessage({ type: "hog", op, item: h.id, kind: h.kind, number: h.number, cue: "" });

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[11.5px] text-muted-foreground">Give each Hog cuelist, scene or macro a name. Cues then read “GO Rain lights” instead of “515”, and if a number changes on the console you fix it once here.</p>
        <Button size="xs" variant="outline" onClick={() => set((x) => x.hogItems.push({ id: uid("hog"), name: "New lighting cue", kind: "cuelist", number: "" }))}>
          <Plus /> Add
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-[1fr_110px_80px_56px_96px] items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>Name</span>
          <span>Type</span>
          <span>Number</span>
          <span className="text-center">Used</span>
          <span className="text-right">Test on console</span>
        </div>
        {io.hogItems.map((h) => {
          const n = uses(h.id);
          return (
            <div key={h.id} className="group grid grid-cols-[1fr_110px_80px_56px_96px] items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0 hover:bg-accent/30">
              <span className="flex min-w-0 items-center gap-2">
                <Lightbulb className="size-3.5 shrink-0 text-armed" />
                <input className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[12.5px] font-medium hover:border-input focus:border-input" defaultValue={h.name} key={h.id + h.name} onBlur={(e) => e.target.value.trim() && e.target.value !== h.name && upd(h.id, (x) => (x.name = e.target.value.trim()))} />
              </span>
              <SelectBox className="h-7" value={h.kind} onChange={(v) => upd(h.id, (x) => (x.kind = v))} options={KIND_OPTIONS} />
              <input className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-[12.5px] tabular" defaultValue={h.number} key={h.id + h.number} placeholder="#" onBlur={(e) => e.target.value.trim() !== h.number && upd(h.id, (x) => (x.number = e.target.value.trim()))} />
              <span className={cn("text-center text-[11px] tabular", n ? "text-foreground/80" : "text-muted-foreground/50")} title={n ? `Used by ${n} cue action${n > 1 ? "s" : ""} / marker${n > 1 ? "s" : ""}` : "Not used yet"}>
                {n || "—"}
              </span>
              <span className="flex items-center justify-end gap-0.5">
                <Button size="icon-xs" variant="ghost" className="text-preview" title="GO on the console" disabled={!h.number} onClick={() => fire(h, "go")}>
                  <Play />
                </Button>
                <Button size="icon-xs" variant="ghost" className="text-live" title="Release on the console" disabled={!h.number} onClick={() => fire(h, "release")}>
                  <Square />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                  title={n ? "Delete (cues using it keep the number they had)" : "Delete"}
                  aria-label="Delete"
                  onClick={() => set((x) => (x.hogItems = x.hogItems.filter((y) => y.id !== h.id)))}
                >
                  <Trash2 />
                </Button>
              </span>
            </div>
          );
        })}
        {io.hogItems.length === 0 && <p className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">No lighting cues yet. Add the cuelists you fire from the show.</p>}
      </div>
      <p className="text-[10.5px] text-muted-foreground">Tip: in a cue’s Lighting action, choose “Cuelist #…”, type a number and press the bookmark to save it here by name.</p>
    </div>
  );
}

function uniq(a: string[]) {
  return [...new Set(a)];
}

const ACTIONS: { value: IoAction["type"]; label: string }[] = [
  { value: "go", label: "GO (next live cue)" },
  { value: "back", label: "Back one cue" },
  { value: "take", label: "Take scene…" },
  { value: "takeNext", label: "Take next scene" },
  { value: "fireCue", label: "Fire cue… of scene…" },
  { value: "blackout", label: "Blackout" },
  { value: "standby", label: "Standby" },
  { value: "freeze", label: "Freeze / resume" },
  { value: "select", label: "Preview scene…" },
  { value: "selectNext", label: "Preview next scene" },
  { value: "selectPrev", label: "Preview previous scene" },
];

function defaultAction(type: IoAction["type"], firstScene: string): IoAction {
  switch (type) {
    case "take":
    case "select":
      return { type, sceneId: firstScene };
    case "fireCue":
      return { type, sceneId: firstScene, index: 0 };
    case "blackout":
    case "standby":
      return { type, on: "toggle" };
    case "freeze":
      return { type, op: "toggle" };
    default:
      return { type } as IoAction;
  }
}

const MATCHES: { value: IoMatch["type"]; label: string }[] = [
  { value: "osc", label: "OSC address" },
  { value: "msc", label: "MSC GO" },
  { value: "midi.note", label: "MIDI note" },
  { value: "midi.cc", label: "MIDI CC" },
  { value: "midi.pc", label: "MIDI program" },
];

function defaultMatch(type: IoMatch["type"]): IoMatch {
  switch (type) {
    case "osc":
      return { type, address: "/hog/status/led/go/1", arg: 1 };
    case "msc":
      return { type, cue: "1", list: null };
    case "midi.note":
      return { type, channel: null, note: 60 };
    case "midi.cc":
      return { type, channel: null, cc: 1, value: null };
    case "midi.pc":
      return { type, channel: null, program: 0 };
  }
}

function TriggersTab() {
  const [io, set] = useIoSettings();
  const scenes = useProject((s) => s.project.scenes);
  const learn = useIo((s) => s.learn);
  const [learning, setLearning] = useState<string | null>(null);
  const upd = (id: string, fn: (t: IoTrigger) => void) =>
    set((x) => {
      const t = x.triggers.find((y) => y.id === id);
      if (t) fn(t);
    });
  const sceneOpts = scenes.map((s) => ({ value: s.id, label: `${s.number}. ${s.name}` }));
  const startLearn = (id: string) => {
    setLearning(id);
    useIo.setState({
      learn: (m) => {
        const match = matchFromIncoming(m);
        if (match) upd(id, (t) => (t.match = match));
        setLearning(null);
      },
    });
  };
  useEffect(() => {
    if (!learn) setLearning(null);
  }, [learn]);

  return (
    <div className="space-y-2 p-1">
      <div className="flex items-center gap-2">
        <p className="flex flex-1 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          Let the console drive the show.
          <InfoTip>When a matching message arrives, the action runs on the live show. Press Learn, then press the button on the console to fill the match in.</InfoTip>
        </p>
        <Button size="xs" variant="outline" onClick={() => set((x) => x.triggers.push({ id: uid("trig"), name: `Trigger ${x.triggers.length + 1}`, enabled: true, match: defaultMatch("osc"), action: { type: "go" } }))}>
          <Plus /> Add trigger
        </Button>
      </div>
      {io.triggers.map((t) => (
        <div key={t.id} className={cn("space-y-1.5 rounded-lg border bg-card/50 p-2.5", t.enabled ? "border-border" : "border-border/50 opacity-60")}>
          <div className="flex items-center gap-1.5">
            <input className="h-7 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[12.5px] font-medium hover:border-input focus:border-input" defaultValue={t.name} key={t.id + t.name} onBlur={(e) => e.target.value !== t.name && upd(t.id, (x) => (x.name = e.target.value))} />
            <Button size="xs" variant={learning === t.id ? "default" : "outline"} className={cn(learning === t.id && "animate-pulse bg-armed text-black")} onClick={() => (learning === t.id ? useIo.setState({ learn: null }) : startLearn(t.id))}>
              <Wand2 /> {learning === t.id ? "Waiting…" : "Learn"}
            </Button>
            <Button size="xs" variant={t.enabled ? "secondary" : "outline"} onClick={() => upd(t.id, (x) => (x.enabled = !x.enabled))}>
              {t.enabled ? "On" : "Off"}
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Delete trigger" onClick={() => set((x) => (x.triggers = x.triggers.filter((y) => y.id !== t.id)))}>
              <Trash2 />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="w-10 text-muted-foreground">When</span>
            <SelectBox className="h-6 w-[130px] text-[11px]" value={t.match.type} onChange={(v) => upd(t.id, (x) => (x.match = defaultMatch(v as IoMatch["type"])))} options={MATCHES} />
            <MatchFields m={t.match} onChange={(m) => upd(t.id, (x) => (x.match = m))} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="w-10 text-muted-foreground">Do</span>
            <SelectBox className="h-6 w-[190px] text-[11px]" value={t.action.type} onChange={(v) => upd(t.id, (x) => (x.action = defaultAction(v as IoAction["type"], scenes[0]?.id ?? "")))} options={ACTIONS} />
            {(t.action.type === "take" || t.action.type === "select" || t.action.type === "fireCue") && (
              <SelectBox className="h-6 w-[200px] text-[11px]" value={t.action.sceneId} onChange={(v) => upd(t.id, (x) => ((x.action as { sceneId: string }).sceneId = v))} options={sceneOpts} />
            )}
            {t.action.type === "fireCue" && (
              <>
                <span className="text-muted-foreground">cue #</span>
                <NumberInput className="h-6 w-14" value={t.action.index + 1} min={1} step={1} onChange={(v) => upd(t.id, (x) => ((x.action as { index: number }).index = Math.max(0, Math.round(v) - 1)))} />
              </>
            )}
            {(t.action.type === "blackout" || t.action.type === "standby") && (
              <SelectBox className="h-6 w-[100px] text-[11px]" value={String(t.action.on)} onChange={(v) => upd(t.id, (x) => ((x.action as { on: boolean | "toggle" }).on = v === "toggle" ? "toggle" : v === "true"))} options={[{ value: "toggle", label: "toggle" }, { value: "true", label: "on" }, { value: "false", label: "off" }]} />
            )}
            {t.action.type === "freeze" && (
              <SelectBox className="h-6 w-[100px] text-[11px]" value={t.action.op} onChange={(v) => upd(t.id, (x) => ((x.action as { op: string }).op = v))} options={[{ value: "toggle", label: "toggle" }, { value: "pause", label: "freeze" }, { value: "resume", label: "resume" }]} />
            )}
            <span className="ml-auto text-muted-foreground">{describeMatch(t.match)} → {describeIoAction(t.action)}</span>
          </div>
        </div>
      ))}
      {io.triggers.length === 0 && <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">No custom triggers. MSC cue-following and the built-in /sls OSC commands work without any.</p>}
      <Section title="Test without hardware">
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => injectIncoming({ kind: "osc", address: "/sls/go", args: [] })}>Simulate /sls/go</Button>
          <Button size="xs" variant="outline" onClick={() => injectIncoming({ kind: "midi", bytes: [0x90, 60, 100] })}>Simulate note 60</Button>
          <Button size="xs" variant="outline" onClick={() => injectIncoming({ kind: "midi", bytes: [0xf0, 0x7f, io.midi.mscDeviceId, 0x02, 0x01, 0x01, 0x31, 0xf7] })}>Simulate MSC GO cue 1</Button>
        </div>
      </Section>
    </div>
  );
}

function MatchFields({ m, onChange }: { m: IoMatch; onChange: (m: IoMatch) => void }) {
  const lbl = (s: string) => <span className="text-muted-foreground">{s}</span>;
  const ch = (channel: number | null, set: (c: number | null) => void) => (
    <>
      {lbl("ch")}
      <SelectBox className="h-6 w-[70px] text-[11px]" value={channel === null ? "any" : String(channel)} onChange={(v) => set(v === "any" ? null : +v)} options={[{ value: "any", label: "any" }, ...Array.from({ length: 16 }, (_, i) => ({ value: String(i), label: String(i + 1) }))]} />
    </>
  );
  switch (m.type) {
    case "osc":
      return (
        <>
          <input className="h-6 w-[200px] rounded-md border border-input bg-transparent px-2 font-mono text-[11px]" defaultValue={m.address} key={m.address} onBlur={(e) => e.target.value.trim() !== m.address && onChange({ ...m, address: e.target.value.trim() })} />
          {lbl("arg")}
          <input
            className="h-6 w-16 rounded-md border border-input bg-transparent px-2 font-mono text-[11px]"
            defaultValue={m.arg === null ? "" : String(m.arg)}
            key={String(m.arg)}
            placeholder="any"
            onBlur={(e) => {
              const v = e.target.value.trim();
              onChange({ ...m, arg: v === "" ? null : Number.isFinite(+v) ? +v : v });
            }}
          />
        </>
      );
    case "msc":
      return (
        <>
          {lbl("cue")}
          <input className="h-6 w-16 rounded-md border border-input bg-transparent px-2 font-mono text-[11px]" defaultValue={m.cue ?? ""} key={m.cue ?? ""} placeholder="any" onBlur={(e) => onChange({ ...m, cue: e.target.value.trim() || null })} />
          {lbl("list")}
          <input className="h-6 w-14 rounded-md border border-input bg-transparent px-2 font-mono text-[11px]" defaultValue={m.list ?? ""} key={m.list ?? ""} placeholder="any" onBlur={(e) => onChange({ ...m, list: e.target.value.trim() || null })} />
        </>
      );
    case "midi.note":
      return (
        <>
          {lbl("note")}
          <NumberInput className="h-6 w-14" value={m.note} min={0} max={127} step={1} onChange={(v) => onChange({ ...m, note: Math.round(v) })} />
          {ch(m.channel, (c) => onChange({ ...m, channel: c }))}
        </>
      );
    case "midi.cc":
      return (
        <>
          {lbl("CC")}
          <NumberInput className="h-6 w-14" value={m.cc} min={0} max={127} step={1} onChange={(v) => onChange({ ...m, cc: Math.round(v) })} />
          {lbl("value")}
          <input className="h-6 w-14 rounded-md border border-input bg-transparent px-2 font-mono text-[11px]" defaultValue={m.value === null ? "" : String(m.value)} key={String(m.value)} placeholder="any" onBlur={(e) => onChange({ ...m, value: e.target.value.trim() === "" ? null : Math.round(+e.target.value) })} />
          {ch(m.channel, (c) => onChange({ ...m, channel: c }))}
        </>
      );
    case "midi.pc":
      return (
        <>
          {lbl("program")}
          <NumberInput className="h-6 w-14" value={m.program} min={0} max={127} step={1} onChange={(v) => onChange({ ...m, program: Math.round(v) })} />
          {ch(m.channel, (c) => onChange({ ...m, channel: c }))}
        </>
      );
  }
}

function LogTab() {
  const log = useIo((s) => s.log);
  const counters = useIo((s) => s.counters);
  const lastIn = useIo((s) => s.lastIn);
  const [msg, setMsg] = useState(() => defaultMessage("osc"));
  return (
    <div className="space-y-2 p-1">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <Activity className="size-3.5" /> in {counters.in} · out {counters.out}
        {lastIn && (
          <span className="ml-auto flex items-center gap-1.5">
            <Radio className="size-3.5 text-preview" /> last: {describeIncoming(lastIn.msg)}
          </span>
        )}
        <Button size="xs" variant="ghost" onClick={() => useIo.setState({ log: [] })}>
          Clear
        </Button>
      </div>
      <div className="h-[240px] overflow-y-auto rounded-md border border-border bg-black/30 p-1.5 font-mono text-[11px]">
        {log.length === 0 && <p className="p-2 text-muted-foreground">Nothing yet. Incoming and outgoing messages, port changes and errors appear here.</p>}
        {[...log].reverse().map((e) => (
          <div key={e.id} className={cn("flex gap-2 px-1 py-px", e.dir === "error" && "text-destructive", e.dir === "in" && "text-preview", e.dir === "out" && "text-armed", e.dir === "info" && "text-muted-foreground")}>
            <span className="w-[72px] shrink-0 tabular text-muted-foreground">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
            <span className="w-8 shrink-0 uppercase">{e.dir === "in" ? "←" : e.dir === "out" ? "→" : e.dir === "error" ? "!" : "·"}</span>
            <span className="break-all">{e.text}</span>
          </div>
        ))}
      </div>
      <Section title="Send a test message">
        <MessageFields m={msg} onChange={setMsg} />
      </Section>
      <p className="text-[10.5px] leading-snug text-muted-foreground">Cues send with a Lighting or MIDI / OSC action; clips send at a time with Time markers (Build → select the clip or video).</p>
    </div>
  );
}
