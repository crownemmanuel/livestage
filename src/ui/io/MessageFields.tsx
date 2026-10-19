import { useState, type ReactNode } from "react";
import { BookmarkPlus, Lightbulb, Pause, Play, Send, Square, StepForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import type { HogKind, HogOp, IoMessage } from "@/core/types";
import { HOG_KIND_LABEL, HOG_OP_LABEL, oscWantsText, sendMessage, type HogMessage } from "@/engine/io";
import { useProject, NO_ITEMS } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";

export const MESSAGE_TYPES: { value: IoMessage["type"]; label: string }[] = [
  { value: "hog", label: "Hog 4 lighting" },
  { value: "osc", label: "Custom OSC" },
  { value: "msc", label: "MIDI Show Control" },
  { value: "midi.note", label: "MIDI note" },
  { value: "midi.cc", label: "MIDI CC" },
  { value: "midi.pc", label: "MIDI program" },
];

export function defaultMessage(type: IoMessage["type"]): IoMessage {
  const io = useProject.getState().project.io;
  switch (type) {
    case "hog": {
      const first = io?.hogItems[0];
      return { type, op: "go", item: first?.id ?? null, kind: first?.kind ?? "cuelist", number: first?.number ?? "", cue: "" };
    }
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

/** A small caption in front of a field, so every box says what it is. */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

/** Compact editor for an outgoing MIDI / OSC message, with a test button. */
export function MessageFields({ m, onChange, compact = false, hideType = false }: { m: IoMessage; onChange: (m: IoMessage) => void; compact?: boolean; /** The row already says what kind it is (a cue's Lighting action). */ hideType?: boolean }) {
  const targets = useProject((s) => s.project.io?.osc.targets ?? NO_ITEMS);
  const cls = compact ? "h-6 text-[11px]" : "h-7 text-[12px]";
  const num = (v: number, set: (n: number) => void, w = "w-14", min?: number, max?: number, step = 1) => <NumberInput className={`${cls} ${w}`} value={v} min={min} max={max} step={step} onChange={set} />;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {!hideType && <SelectBox className={`${cls} w-[128px]`} value={m.type} onChange={(t) => onChange(defaultMessage(t as IoMessage["type"]))} options={MESSAGE_TYPES} />}
      {m.type === "hog" && <HogFields m={m} onChange={onChange} cls={cls} />}
      {m.type === "osc" && (
        <>
          <SelectBox
            className={`${cls} w-[120px]`}
            value={m.target ?? "__first__"}
            onChange={(v) => onChange({ ...m, target: v === "__first__" ? null : v })}
            options={[{ value: "__first__", label: targets.length ? `${targets[0].name} (first)` : "no targets" }, ...targets.map((t) => ({ value: t.id, label: t.name }))]}
          />
          <Labeled label="address">
            <TextBox className={`${cls} w-[180px]`} value={m.address} placeholder="/address" onChange={(address) => onChange({ ...m, address })} />
          </Labeled>
          <Labeled label="args">
            <TextBox
              className={`${cls} w-[100px]`}
              value={formatArgs(m.args, m.address)}
              placeholder="1 2.5 text"
              title={oscWantsText(m.address) ? "Hog playback: list or list.cue, e.g. 515 or 5.10 (sent as text, which is what the Hog accepts)" : 'Space-separated arguments: numbers are sent as numbers, anything else (or "quoted") as text'}
              onChange={(v) => onChange({ ...m, args: parseArgs(v, m.address) })}
            />
          </Labeled>
        </>
      )}
      {m.type === "msc" && (
        <>
          <SelectBox className={`${cls} w-[90px]`} value={m.command} onChange={(v) => onChange({ ...m, command: v as typeof m.command })} options={[{ value: "go", label: "GO" }, { value: "stop", label: "STOP" }, { value: "resume", label: "RESUME" }]} />
          <Labeled label="cue">
            <TextBox className={`${cls} w-16`} value={m.cue} onChange={(cue) => onChange({ ...m, cue })} />
          </Labeled>
          <Labeled label="list">
            <TextBox className={`${cls} w-14`} value={m.list} placeholder="—" onChange={(list) => onChange({ ...m, list })} />
          </Labeled>
          <Labeled label="device">{num(m.deviceId, (v) => onChange({ ...m, deviceId: Math.round(v) }), "w-12", 0, 127)}</Labeled>
        </>
      )}
      {m.type === "midi.note" && (
        <>
          <Labeled label="note">{num(m.note, (v) => onChange({ ...m, note: Math.round(v) }), "w-14", 0, 127)}</Labeled>
          <Labeled label="vel">{num(m.velocity, (v) => onChange({ ...m, velocity: Math.round(v) }), "w-14", 1, 127)}</Labeled>
          <Labeled label="ch">{num(m.channel + 1, (v) => onChange({ ...m, channel: Math.round(v) - 1 }), "w-12", 1, 16)}</Labeled>
          <Labeled label="hold ms">{num(m.hold, (v) => onChange({ ...m, hold: Math.round(v) }), "w-16", 0, 10000, 10)}</Labeled>
        </>
      )}
      {m.type === "midi.cc" && (
        <>
          <Labeled label="CC">{num(m.cc, (v) => onChange({ ...m, cc: Math.round(v) }), "w-14", 0, 127)}</Labeled>
          <Labeled label="value">{num(m.value, (v) => onChange({ ...m, value: Math.round(v) }), "w-14", 0, 127)}</Labeled>
          <Labeled label="ch">{num(m.channel + 1, (v) => onChange({ ...m, channel: Math.round(v) - 1 }), "w-12", 1, 16)}</Labeled>
        </>
      )}
      {m.type === "midi.pc" && (
        <>
          <Labeled label="program">{num(m.program, (v) => onChange({ ...m, program: Math.round(v) }), "w-14", 0, 127)}</Labeled>
          <Labeled label="ch">{num(m.channel + 1, (v) => onChange({ ...m, channel: Math.round(v) - 1 }), "w-12", 1, 16)}</Labeled>
        </>
      )}
      <Button size="xs" variant="ghost" className={cn(compact ? "h-6" : "h-7", "text-muted-foreground hover:text-foreground")} title="Send this message now" onClick={() => void sendMessage(m)}>
        <Send /> Test
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- Hog 4

export const HOG_OP_ICON: Record<HogOp, ReactNode> = {
  go: <Play className="text-preview" />,
  release: <Square className="text-live" />,
  halt: <Pause className="text-armed" />,
  resume: <StepForward className="text-preview" />,
};

const KINDS: HogKind[] = ["cuelist", "scene", "macro"];
const CUSTOM = "custom:";

/** GO / release / halt a named lighting item (or a typed-in number) on the Hog. */
function HogFields({ m, onChange, cls }: { m: HogMessage; onChange: (m: IoMessage) => void; cls: string }) {
  const items = useProject((s) => s.project.io?.hogItems ?? NO_ITEMS);
  const item = m.item ? items.find((i) => i.id === m.item) : undefined;
  const kind = item?.kind ?? m.kind;
  const [naming, setNaming] = useState(false);
  const ops: HogOp[] = kind === "cuelist" ? ["go", "release", "halt", "resume"] : ["go", "release", "halt"];

  const saveToLibrary = (name: string) => {
    const n = name.trim();
    setNaming(false);
    if (!n || !m.number.trim()) return;
    const id = uid("hog");
    useProject.getState().update((p) => p.io?.hogItems.push({ id, name: n, kind: m.kind, number: m.number.trim() }));
    onChange({ ...m, item: id });
  };

  return (
    <>
      <Select value={ops.includes(m.op) ? m.op : "go"} onValueChange={(v) => onChange({ ...m, op: v as HogOp })}>
        <SelectTrigger size="sm" className={cn(cls, "w-[100px] [&_svg]:size-3.5")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op} className="text-[12px] [&_svg]:size-3.5">
              {HOG_OP_ICON[op]} {HOG_OP_LABEL[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={item ? item.id : `${CUSTOM}${kind}`}
        onValueChange={(v) => {
          if (v.startsWith(CUSTOM)) return onChange({ ...m, item: null, kind: v.slice(CUSTOM.length) as HogKind, cue: "" });
          const it = items.find((i) => i.id === v);
          if (it) onChange({ ...m, item: it.id, kind: it.kind, number: it.number, cue: it.kind === "cuelist" ? m.cue : "" });
        }}
      >
        <SelectTrigger size="sm" className={cn(cls, "w-[180px] [&_svg]:size-3.5")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.length > 0 && (
            <SelectGroup>
              <SelectLabel className="text-[10.5px]">Lighting library</SelectLabel>
              {items.map((it) => (
                <SelectItem key={it.id} value={it.id} className="text-[12px]">
                  <Lightbulb className="text-armed" />
                  <span className="truncate">{it.name}</span>
                  <span className="text-[10.5px] tabular text-muted-foreground">
                    {HOG_KIND_LABEL[it.kind].toLowerCase()} {it.number}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {items.length > 0 && <SelectSeparator />}
          <SelectGroup>
            <SelectLabel className="text-[10.5px]">Custom number</SelectLabel>
            {KINDS.map((k) => (
              <SelectItem key={k} value={`${CUSTOM}${k}`} className="text-[12px]">
                {HOG_KIND_LABEL[k]} #…
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {!item && (
        <Labeled label={`${HOG_KIND_LABEL[kind]} #`}>
          <TextBox className={`${cls} w-16 tabular`} value={m.number} placeholder="515" onChange={(number) => onChange({ ...m, number })} />
        </Labeled>
      )}
      {m.op === "go" && kind === "cuelist" && (
        <Labeled label="cue">
          <TextBox className={`${cls} w-12 tabular`} value={m.cue} placeholder="next" title="Jump to this cue of the list; leave empty to GO to its next cue" onChange={(cue) => onChange({ ...m, cue })} />
        </Labeled>
      )}
      {!item &&
        (naming ? (
          <span className="inline-flex items-center gap-0.5">
            <input
              autoFocus
              className={`${cls} w-[120px] rounded-md border border-armed/60 bg-transparent px-2`}
              placeholder="Name, e.g. Rain lights"
              onKeyDown={(e) => {
                if (e.key === "Enter") saveToLibrary(e.currentTarget.value);
                if (e.key === "Escape") {
                  e.currentTarget.value = "";
                  setNaming(false);
                }
              }}
              onBlur={(e) => saveToLibrary(e.currentTarget.value)}
            />
            <Button size="icon-xs" variant="ghost" aria-label="Cancel" onMouseDown={(e) => {
                e.preventDefault();
                (e.currentTarget.previousSibling as HTMLInputElement).value = "";
              }} onClick={() => setNaming(false)}>
              <X />
            </Button>
          </span>
        ) : (
          <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-armed" title="Save this number to the lighting library by name" disabled={!m.number.trim()} onClick={() => setNaming(true)}>
            <BookmarkPlus />
          </Button>
        ))}
    </>
  );
}

