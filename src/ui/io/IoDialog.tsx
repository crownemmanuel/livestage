import { useEffect, useState } from "react";
import { Activity, Plus, Radio, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import { defaultIo } from "@/core/factories";
import type { IoAction, IoMatch, IoSettings, IoTrigger } from "@/core/types";
import { describeIncoming, describeMatch, injectIncoming, matchFromIncoming, refreshMidiPorts, useIo } from "@/engine/io";
import { describeIoAction } from "@/engine/operator";
import { useProject } from "@/store/project";
import { Field, NumberInput, Section, SelectBox, SwitchField } from "../fields";
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

export function IoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  useEffect(() => {
    if (open) void refreshMidiPorts();
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Show control I/O</DialogTitle>
          <DialogDescription>Talk to the lighting console (Hog 4) and sound: receive GO and scene triggers over MIDI / OSC, and send messages from cues and clip time markers.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="ports">
          <TabsList className="h-8">
            <TabsTrigger value="ports" className="text-[12px]">MIDI &amp; OSC</TabsTrigger>
            <TabsTrigger value="triggers" className="text-[12px]">Incoming triggers</TabsTrigger>
            <TabsTrigger value="log" className="text-[12px]">Monitor</TabsTrigger>
          </TabsList>
          <TabsContent value="ports">
            <PortsTab />
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

function PortsTab() {
  const [io, set] = useIoSettings();
  const st = useIo();
  return (
    <div className="grid grid-cols-2 gap-x-2">
      <div>
        <Section
          title="MIDI"
          right={
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StatusDot ok={st.midiStatus === "open"} warn={st.midiStatus === "error"} /> {st.midiStatus}
              <Button size="icon-xs" variant="ghost" onClick={() => void refreshMidiPorts()} aria-label="Refresh ports">
                <RefreshCw />
              </Button>
            </span>
          }
        >
          {!st.available.midi && <p className="text-[11px] text-armed">MIDI is not available in this browser. Use the desktop app (or Chrome for development).</p>}
          <SwitchField label="Enabled" value={io.midi.enabled} onChange={(v) => set((x) => (x.midi.enabled = v))} />
          <Field label="Input">
            <SelectBox value={io.midi.input ?? NONE} onChange={(v) => set((x) => (x.midi.input = v === NONE ? null : v))} options={[{ value: NONE, label: "— none —" }, ...uniq([...st.midiInputs, ...(io.midi.input ? [io.midi.input] : [])]).map((n) => ({ value: n, label: n }))]} />
          </Field>
          <Field label="Output">
            <SelectBox value={io.midi.output ?? NONE} onChange={(v) => set((x) => (x.midi.output = v === NONE ? null : v))} options={[{ value: NONE, label: "— none —" }, ...uniq([...st.midiOutputs, ...(io.midi.output ? [io.midi.output] : [])]).map((n) => ({ value: n, label: n }))]} />
          </Field>
          {st.midiError && <p className="text-[11px] text-destructive">{st.midiError}</p>}
          <Field label="MSC device ID" hint="MIDI Show Control device this show answers to (127 = all)">
            <NumberInput className="w-20" value={io.midi.mscDeviceId} min={0} max={127} step={1} onChange={(v) => set((x) => (x.midi.mscDeviceId = Math.round(v)))} />
          </Field>
          <SwitchField label="Follow MSC cues" hint='MSC GO cue "12" takes scene 12; cue "12.3" fires cue 3 of scene 12 (taking it first if needed)' value={io.midi.mscAuto} onChange={(v) => set((x) => (x.midi.mscAuto = v))} />
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            On the Hog 4, enable MIDI Show Control output (Setup → Network → console → MIDI) and give the cuelist's cues numbers that match the scene numbers here. Any other MIDI note / CC / program change can be mapped under Incoming triggers.
          </p>
        </Section>
      </div>
      <div>
        <Section
          title="OSC (network)"
          right={
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StatusDot ok={st.oscStatus === "listening"} warn={st.oscStatus === "error"} /> {st.oscStatus}
            </span>
          }
        >
          {!st.available.osc && <p className="text-[11px] text-armed">OSC needs the desktop app (UDP sockets).</p>}
          <SwitchField label="Enabled" value={io.osc.enabled} onChange={(v) => set((x) => (x.osc.enabled = v))} />
          <Field label="Listen port" hint="UDP port this computer receives OSC on">
            <NumberInput className="w-24" value={io.osc.listenPort} min={1024} max={65535} step={1} onChange={(v) => set((x) => (x.osc.listenPort = Math.round(v)))} />
          </Field>
          {st.oscError && <p className="text-[11px] text-destructive">{st.oscError}</p>}
          <Field label="Targets">
            <Button size="xs" variant="outline" onClick={() => set((x) => x.osc.targets.push({ id: uid("osc"), name: "Target", host: "192.168.1.20", port: 8000 }))}>
              <Plus /> Add target
            </Button>
          </Field>
          {io.osc.targets.map((t) => (
            <div key={t.id} className="grid grid-cols-[1fr_1fr_64px_24px] items-center gap-1 text-[12px]">
              <input className="h-7 rounded-md border border-input bg-transparent px-2" defaultValue={t.name} key={t.id + t.name} onBlur={(e) => set((x) => ((x.osc.targets.find((y) => y.id === t.id) ?? t).name = e.target.value))} />
              <input className="h-7 rounded-md border border-input bg-transparent px-2 font-mono" defaultValue={t.host} key={t.id + t.host} onBlur={(e) => set((x) => ((x.osc.targets.find((y) => y.id === t.id) ?? t).host = e.target.value.trim()))} />
              <NumberInput value={t.port} min={1} max={65535} step={1} onChange={(v) => set((x) => ((x.osc.targets.find((y) => y.id === t.id) ?? t).port = Math.round(v)))} />
              <Button size="icon-xs" variant="ghost" aria-label="Remove target" onClick={() => set((x) => (x.osc.targets = x.osc.targets.filter((y) => y.id !== t.id)))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <SwitchField label="Announce TAKE / GO" hint="Send /sls/scene <number> <name> on every TAKE and /sls/cue <scene> <cue> <name> on every GO" value={io.osc.notify} onChange={(v) => set((x) => (x.osc.notify = v))} />
          {io.osc.notify && (
            <Field label="Announce to">
              <SelectBox value={io.osc.notifyTarget ?? io.osc.targets[0]?.id ?? NONE} onChange={(v) => set((x) => (x.osc.notifyTarget = v === NONE ? null : v))} options={io.osc.targets.length ? io.osc.targets.map((t) => ({ value: t.id, label: t.name })) : [{ value: NONE, label: "no targets" }]} />
            </Field>
          )}
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Built-in incoming commands (no mapping needed): <code>/sls/go</code>, <code>/sls/back</code>, <code>/sls/take n</code>, <code>/sls/cue scene cue</code>, <code>/sls/next</code>, <code>/sls/select n</code>, <code>/sls/blackout 0|1</code>, <code>/sls/standby 0|1</code>, <code>/sls/freeze 0|1</code>.
          </p>
        </Section>
      </div>
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
        <p className="flex-1 text-[11px] text-muted-foreground">When a matching message arrives, the action runs on the live show. Press Learn and send the message from the console to fill the match in.</p>
        <Button size="xs" variant="outline" onClick={() => set((x) => x.triggers.push({ id: uid("trig"), name: `Trigger ${x.triggers.length + 1}`, enabled: true, match: defaultMatch("osc"), action: { type: "go" } }))}>
          <Plus /> Add trigger
        </Button>
      </div>
      {io.triggers.map((t) => (
        <div key={t.id} className={cn("space-y-1.5 rounded-md border p-2", t.enabled ? "border-border" : "border-border/50 opacity-60")}>
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
      <p className="text-[10.5px] leading-snug text-muted-foreground">Cues can send messages with the “Send MIDI / OSC” action, and clips can send at a time with Time markers (Scene Builder → the clip or video). Hog 4 (port 7001): <code>/hog/playback/go/0</code> with <code>515</code> runs cuelist 515, <code>515.3</code> jumps to its cue 3; <code>/hog/playback/release/0</code> <code>515</code> releases it. Use <code>/1</code> for scenes, <code>/2</code> for macros.</p>
    </div>
  );
}
