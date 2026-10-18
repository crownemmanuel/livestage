import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { IoMessage } from "@/core/types";
import { oscWantsText, sendMessage } from "@/engine/io";
import { useProject } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";

export const MESSAGE_TYPES: { value: IoMessage["type"]; label: string }[] = [
  { value: "osc", label: "OSC" },
  { value: "msc", label: "MIDI Show Control" },
  { value: "midi.note", label: "MIDI note" },
  { value: "midi.cc", label: "MIDI CC" },
  { value: "midi.pc", label: "MIDI program" },
];

export function defaultMessage(type: IoMessage["type"]): IoMessage {
  const io = useProject.getState().project.io;
  switch (type) {
    case "osc":
      return { type, target: io?.osc.targets[0]?.id ?? null, address: "/hog/playback/go/0", args: ["1"] };
    case "msc":
      return { type, deviceId: io?.midi.mscDeviceId ?? 0, command: "go", cue: "1", list: "" };
    case "midi.note":
      return { type, channel: 0, note: 60, velocity: 127, hold: 100 };
    case "midi.cc":
      return { type, channel: 0, cc: 1, value: 127 };
    case "midi.pc":
      return { type, channel: 0, program: 0 };
  }
}

const looksNumeric = (x: string) => x !== "" && Number.isFinite(+x);

/** Space-separated OSC args. "quoted" words stay text; Hog playback numbers stay text so "5.10" keeps cue 10. */
function parseArgs(text: string, address: string): (number | string)[] {
  const keepText = oscWantsText(address);
  return (text.match(/"[^"]*"|\S+/g) ?? []).map((x) => (x.startsWith('"') ? x.slice(1, -1) : !keepText && looksNumeric(x) ? +x : x));
}

function formatArgs(args: (number | string)[], address: string): string {
  const keepText = oscWantsText(address);
  return args.map((a) => (typeof a === "string" && (/\s/.test(a) || (!keepText && looksNumeric(a))) ? `"${a}"` : String(a))).join(" ");
}

function TextBox({ value, onChange, className, placeholder, title }: { value: string; onChange: (v: string) => void; className: string; placeholder?: string; title?: string }) {
  return <input className={`rounded-md border border-input bg-transparent px-2 font-mono ${className}`} defaultValue={value} key={value} placeholder={placeholder} title={title} onBlur={(e) => e.target.value.trim() !== value && onChange(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

/** Compact editor for an outgoing MIDI / OSC message, with a test button. */
export function MessageFields({ m, onChange, compact = false }: { m: IoMessage; onChange: (m: IoMessage) => void; compact?: boolean }) {
  const targets = useProject((s) => s.project.io?.osc.targets ?? []);
  const cls = compact ? "h-6 text-[11px]" : "h-7 text-[12px]";
  const num = (v: number, set: (n: number) => void, w = "w-14", min?: number, max?: number, step = 1) => <NumberInput className={`${cls} ${w}`} value={v} min={min} max={max} step={step} onChange={set} />;
  const lbl = (s: string) => <span className="text-muted-foreground">{s}</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <SelectBox className={`${cls} w-[150px]`} value={m.type} onChange={(t) => onChange(defaultMessage(t as IoMessage["type"]))} options={MESSAGE_TYPES} />
      {m.type === "osc" && (
        <>
          <SelectBox
            className={`${cls} w-[120px]`}
            value={m.target ?? "__first__"}
            onChange={(v) => onChange({ ...m, target: v === "__first__" ? null : v })}
            options={[{ value: "__first__", label: targets.length ? `${targets[0].name} (first)` : "no targets" }, ...targets.map((t) => ({ value: t.id, label: t.name }))]}
          />
          <TextBox className={`${cls} w-[190px]`} value={m.address} placeholder="/address" onChange={(address) => onChange({ ...m, address })} />
          <TextBox
            className={`${cls} w-[120px]`}
            value={formatArgs(m.args, m.address)}
            placeholder="args (1 2.5 text)"
            title={oscWantsText(m.address) ? "Hog playback: list or list.cue, e.g. 515 or 5.10 (sent as text, which is what the Hog accepts)" : 'Space-separated arguments: numbers are sent as numbers, anything else (or "quoted") as text'}
            onChange={(v) => onChange({ ...m, args: parseArgs(v, m.address) })}
          />
        </>
      )}
      {m.type === "msc" && (
        <>
          <SelectBox className={`${cls} w-[90px]`} value={m.command} onChange={(v) => onChange({ ...m, command: v as typeof m.command })} options={[{ value: "go", label: "GO" }, { value: "stop", label: "STOP" }, { value: "resume", label: "RESUME" }]} />
          {lbl("cue")}
          <TextBox className={`${cls} w-16`} value={m.cue} onChange={(cue) => onChange({ ...m, cue })} />
          {lbl("list")}
          <TextBox className={`${cls} w-14`} value={m.list} placeholder="—" onChange={(list) => onChange({ ...m, list })} />
          {lbl("device")}
          {num(m.deviceId, (v) => onChange({ ...m, deviceId: Math.round(v) }), "w-12", 0, 127)}
        </>
      )}
      {m.type === "midi.note" && (
        <>
          {lbl("note")}
          {num(m.note, (v) => onChange({ ...m, note: Math.round(v) }), "w-14", 0, 127)}
          {lbl("vel")}
          {num(m.velocity, (v) => onChange({ ...m, velocity: Math.round(v) }), "w-14", 1, 127)}
          {lbl("ch")}
          {num(m.channel + 1, (v) => onChange({ ...m, channel: Math.round(v) - 1 }), "w-12", 1, 16)}
          {lbl("off after")}
          {num(m.hold, (v) => onChange({ ...m, hold: Math.round(v) }), "w-16", 0, 60000, 10)}
          {lbl("ms")}
        </>
      )}
      {m.type === "midi.cc" && (
        <>
          {lbl("CC")}
          {num(m.cc, (v) => onChange({ ...m, cc: Math.round(v) }), "w-14", 0, 127)}
          {lbl("value")}
          {num(m.value, (v) => onChange({ ...m, value: Math.round(v) }), "w-14", 0, 127)}
          {lbl("ch")}
          {num(m.channel + 1, (v) => onChange({ ...m, channel: Math.round(v) - 1 }), "w-12", 1, 16)}
        </>
      )}
      {m.type === "midi.pc" && (
        <>
          {lbl("program")}
          {num(m.program, (v) => onChange({ ...m, program: Math.round(v) }), "w-14", 0, 127)}
          {lbl("ch")}
          {num(m.channel + 1, (v) => onChange({ ...m, channel: Math.round(v) - 1 }), "w-12", 1, 16)}
        </>
      )}
      <Button size="xs" variant="ghost" className="h-6" title="Send this message now" onClick={() => void sendMessage(m)}>
        <Send /> Test
      </Button>
    </div>
  );
}
