import { createContext, useContext, useState, type ReactNode } from "react";
import { BookmarkPlus, Lightbulb, Pause, Play, Square, StepForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import type { HogKind, HogOp, IoMessage, SoundAppMessage, SoundAppOp, StageLightMessage, StageLightOp } from "@/core/types";
import { defaultStageLightMessage, findCatalogPage, resolveWithCatalog, stageLightTarget, STAGELIGHT_OPS } from "@/core/stageLight";
import { HOG_KIND_LABEL, HOG_OP_LABEL, oscWantsText, type HogMessage } from "@/engine/io";
import { SOUND_OP_LABEL } from "@/core/soundControl";
import { useSoundApp } from "@/engine/soundApp";
import { useProject, NO_ITEMS } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";
import { TestSendButton } from "./TestSendDialog";

export const MESSAGE_TYPES: { value: IoMessage["type"]; label: string }[] = [
  { value: "hog", label: "Hog 4 lighting" },
  { value: "stagelight", label: "StageLight" },
  { value: "sound", label: "StageMics (dLive)" },
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
    case "sound":
      return { type, op: "sceneActivate", sceneId: null };
    case "stagelight":
      return defaultStageLightMessage("go");
  }
}

/** What a new time marker sends: a StageLight GO when this computer drives StageLight, else a Hog GO. */
export function defaultMarkerMessage(): IoMessage {
  return useProject.getState().project.io?.stagelight?.enabled ? defaultMessage("stagelight") : defaultMessage("hog");
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

/** Roomy = labels above taller fields in a grid (marker cards); otherwise one tight inline row. */
const Roomy = createContext(false);
/** A fixed width inline, the full grid cell when roomy. */
const useWidth = () => {
  const roomy = useContext(Roomy);
  return (w: string) => (roomy ? "w-full" : w);
};

/** A caption for a field, so every box says what it is. `roomyOnly` captions only show in the roomy layout. */
function Labeled({ label, children, roomyOnly = false, wide = false }: { label: string; children: ReactNode; roomyOnly?: boolean; /** Two grid columns when roomy. */ wide?: boolean }) {
  if (useContext(Roomy))
    return (
      <label className={cn("flex min-w-0 flex-col gap-1.5", wide && "col-span-full @md:col-span-2")}>
        <span className="block text-[11.5px] font-medium text-muted-foreground first-letter:uppercase">{label}</span>
        {children}
      </label>
    );
  if (roomyOnly) return <>{children}</>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

/** Editor for an outgoing MIDI / OSC message, with a test button. */
export function MessageFields({ m, onChange, compact = false, roomy = false, hideType = false }: { m: IoMessage; onChange: (m: IoMessage) => void; compact?: boolean; /** Labels above taller fields in a grid, for cards with room (time markers). */ roomy?: boolean; /** The row already says what kind it is (a cue's Lighting action). */ hideType?: boolean }) {
  return (
    <Roomy.Provider value={roomy}>
      <Fields m={m} onChange={onChange} cls={roomy ? "h-9 rounded-lg text-[13px]" : compact ? "h-6 text-[11px]" : "h-7 text-[12px]"} hideType={hideType} />
    </Roomy.Provider>
  );
}

function Fields({ m, onChange, cls, hideType }: { m: IoMessage; onChange: (m: IoMessage) => void; cls: string; hideType: boolean }) {
  const targets = useProject((s) => s.project.io?.osc.targets ?? NO_ITEMS);
  const roomy = useContext(Roomy);
  const w = useWidth();
  const num = (v: number, set: (n: number) => void, width = "w-14", min?: number, max?: number, step = 1) => <NumberInput className={`${cls} ${w(width)}`} value={v} min={min} max={max} step={step} onChange={set} />;
  return (
    <div className={roomy ? "@container" : "contents"}>
    <div className={roomy ? "grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] items-end gap-3 text-[13px]" : "flex flex-wrap items-center gap-1.5 text-[11px]"}>
      {!hideType && (
        <Labeled label="Send to" roomyOnly>
          <SelectBox className={`${cls} ${w("w-[128px]")}`} value={m.type} onChange={(t) => onChange(defaultMessage(t as IoMessage["type"]))} options={MESSAGE_TYPES} />
        </Labeled>
      )}
      {m.type === "hog" && <HogFields m={m} onChange={onChange} cls={cls} />}
      {m.type === "sound" && <SoundFields m={m} onChange={onChange} cls={cls} />}
      {m.type === "stagelight" && <StageLightFields m={m} onChange={onChange} cls={cls} />}
      {m.type === "osc" && (
        <>
          <Labeled label="Device" roomyOnly>
            <SelectBox
              className={`${cls} ${w("w-[120px]")}`}
              value={m.target ?? "__first__"}
              onChange={(v) => onChange({ ...m, target: v === "__first__" ? null : v })}
              options={[{ value: "__first__", label: targets.length ? `${targets[0].name} (first)` : "no targets" }, ...targets.map((t) => ({ value: t.id, label: t.name }))]}
            />
          </Labeled>
          <Labeled label="address">
            <TextBox className={`${cls} ${w("w-[180px]")}`} value={m.address} placeholder="/address" onChange={(address) => onChange({ ...m, address })} />
          </Labeled>
          <Labeled label="args">
            <TextBox
              className={`${cls} ${w("w-[100px]")}`}
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
          <Labeled label="Command" roomyOnly>
            <SelectBox className={`${cls} ${w("w-[90px]")}`} value={m.command} onChange={(v) => onChange({ ...m, command: v as typeof m.command })} options={[{ value: "go", label: "GO" }, { value: "stop", label: "STOP" }, { value: "resume", label: "RESUME" }]} />
          </Labeled>
          <Labeled label="cue">
            <TextBox className={`${cls} ${w("w-16")}`} value={m.cue} onChange={(cue) => onChange({ ...m, cue })} />
          </Labeled>
          <Labeled label="list">
            <TextBox className={`${cls} ${w("w-14")}`} value={m.list} placeholder="—" onChange={(list) => onChange({ ...m, list })} />
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
      {roomy ? (
        <div className="col-span-full flex justify-end border-t border-border/60 pt-3">
          <TestSendButton m={m} size="sm" variant="outline" className="h-9 rounded-lg px-3 text-[13px]" />
        </div>
      ) : (
        <TestSendButton m={m} className={cn(cls.split(" ")[0], "text-muted-foreground hover:text-foreground")} />
      )}
    </div>
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
  const w = useWidth();
  const roomy = useContext(Roomy);
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
      <Labeled label="Action" roomyOnly>
      <Select value={ops.includes(m.op) ? m.op : "go"} onValueChange={(v) => onChange({ ...m, op: v as HogOp })}>
        <SelectTrigger size="sm" className={cn(cls, w("w-[100px]"), "[&_svg]:size-3.5")}>
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
      </Labeled>
      <Labeled label="Lighting" roomyOnly wide>
      <Select
        value={item ? item.id : `${CUSTOM}${kind}`}
        onValueChange={(v) => {
          if (v.startsWith(CUSTOM)) return onChange({ ...m, item: null, kind: v.slice(CUSTOM.length) as HogKind, cue: "" });
          const it = items.find((i) => i.id === v);
          if (it) onChange({ ...m, item: it.id, kind: it.kind, number: it.number, cue: it.kind === "cuelist" ? m.cue : "" });
        }}
      >
        <SelectTrigger size="sm" className={cn(cls, w("w-[180px]"), "[&_svg]:size-3.5")}>
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
      </Labeled>
      {!item && (
        <Labeled label={`${HOG_KIND_LABEL[kind]} #`}>
          <TextBox className={`${cls} ${w("w-16")} tabular`} value={m.number} placeholder="515" onChange={(number) => onChange({ ...m, number })} />
        </Labeled>
      )}
      {m.op === "go" && kind === "cuelist" && (
        <Labeled label="cue">
          <TextBox className={`${cls} ${w("w-12")} tabular`} value={m.cue} placeholder="next" title="Jump to this cue of the list; leave empty to GO to its next cue" onChange={(cue) => onChange({ ...m, cue })} />
        </Labeled>
      )}
      {m.op === "go" && (
        <Labeled label={roomy ? "Raise master first" : "master"}>
          <TextBox
            className={`${cls} ${w("w-12")} tabular`}
            value={m.master ?? ""}
            placeholder={roomy ? "none" : "—"}
            title="If the list sits on a master, its number here: the app pushes that fader to full just before the GO, so the cue shows even with the fader down. Leave empty to leave faders alone."
            onChange={(master) => onChange({ ...m, master })}
          />
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


// ---------------------------------------------------------------- StageMics

const SOUND_OPS = (Object.keys(SOUND_OP_LABEL) as SoundAppOp[]).map((value) => ({ value, label: SOUND_OP_LABEL[value] }));
const THIS_SCENE = "__this__";

function soundWithOp(m: SoundAppMessage, op: SoundAppOp): SoundAppMessage {
  const who = "who" in m ? m.who : "";
  const sceneId = "sceneId" in m ? m.sceneId : null;
  switch (op) {
    case "sceneSelect":
    case "sceneActivate":
      return { type: "sound", op, sceneId };
    case "cueGo":
      return { type: "sound", op, sceneId, cue: 1 };
    case "mic":
      return { type: "sound", op, who, live: false };
    case "fx":
      return { type: "sound", op, who, preset: "none" };
    default:
      return { type: "sound", op };
  }
}

function SoundFields({ m, onChange, cls }: { m: SoundAppMessage; onChange: (m: IoMessage) => void; cls: string }) {
  const w = useWidth();
  const roomy = useContext(Roomy);
  const scenes = useProject((s) => s.project.scenes);
  const on = useProject((s) => !!s.project.io?.sound?.enabled);
  const mics = useSoundApp((s) => s.mics);
  const micNames = [...new Set(Object.entries(mics).flatMap(([n, x]) => [x.name, n]).filter(Boolean))];
  const who = (value: string, set: (v: string) => void) => (
    <Labeled label="Mic">
      <input className={`rounded-md border border-input bg-transparent px-2 ${cls} ${w("w-[110px]")}`} list="sound-app-mics" defaultValue={value} key={value} placeholder="Joseph or 3" title="Mic number, or the character's name as StageMics knows it" onBlur={(e) => e.target.value.trim() !== value && set(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      <datalist id="sound-app-mics">
        {micNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </Labeled>
  );
  const sceneBox = (sceneId: string | null, set: (id: string | null) => void) => (
    <Labeled label="Scene" wide>
      <SelectBox className={`${cls} ${w("w-[170px]")}`} value={sceneId ?? THIS_SCENE} onChange={(v) => set(v === THIS_SCENE ? null : v)} options={[{ value: THIS_SCENE, label: "This scene" }, ...scenes.map((x) => ({ value: x.id, label: `${x.number}. ${x.name}` }))]} />
    </Labeled>
  );
  return (
    <>
      <Labeled label="Command" roomyOnly>
        <SelectBox className={`${cls} ${w("w-[150px]")}`} value={m.op} onChange={(op) => onChange(soundWithOp(m, op))} options={SOUND_OPS} />
      </Labeled>
      {(m.op === "sceneSelect" || m.op === "sceneActivate" || m.op === "cueGo") && sceneBox(m.sceneId, (sceneId) => onChange({ ...m, sceneId }))}
      {m.op === "cueGo" && (
        <Labeled label="cue">
          <NumberInput className={`${cls} ${w("w-14")}`} value={m.cue} min={1} step={1} onChange={(v) => onChange({ ...m, cue: Math.max(1, Math.round(v)) })} />
        </Labeled>
      )}
      {m.op === "mic" && (
        <>
          {who(m.who, (v) => onChange({ ...m, who: v }))}
          <Labeled label="State" roomyOnly>
            <SelectBox className={`${cls} ${w("w-[90px]")}`} value={m.live ? "live" : "muted"} onChange={(v) => onChange({ ...m, live: v === "live" })} options={[{ value: "muted", label: "Muted" }, { value: "live", label: "Live" }]} />
          </Labeled>
        </>
      )}
      {m.op === "fx" && (
        <>
          {who(m.who, (v) => onChange({ ...m, who: v }))}
          <Labeled label="preset">
            <TextBox className={`${cls} ${w("w-[100px]")}`} value={m.preset} placeholder="none" title='StageMics preset name; "none" switches the effect off' onChange={(preset) => onChange({ ...m, preset: preset || "none" })} />
          </Labeled>
          {m.preset !== "none" && (
            <Labeled label="amount">
              <SelectBox className={`${cls} ${w("w-[90px]")}`} value={m.amount ?? "preset"} onChange={(v) => onChange(v === "preset" ? { type: "sound", op: "fx", who: m.who, preset: m.preset } : { ...m, amount: v as "light" | "medium" | "full" })} options={[{ value: "preset", label: "as set" }, { value: "light", label: "light" }, { value: "medium", label: "medium" }, { value: "full", label: "full" }]} />
            </Labeled>
          )}
        </>
      )}
      {!on && <span className={cn("text-[10.5px] text-armed", roomy && "col-span-full")}>StageMics link is off (Settings → StageMics)</span>}
      {roomy && (m.op === "mic" || m.op === "fx") && (
        <p className="col-span-full text-[11px] leading-snug text-muted-foreground">
          From a time marker: if the track stops, restarts or is scrubbed before it ends, LiveStage sends Restore once and StageMics puts every mic back to its current cue.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- StageLight

/** Seconds as text: empty = StageLight's own default fade. */
function FadeBox({ value, onChange, cls }: { value: number | null; onChange: (v: number | null) => void; cls: string }) {
  const w = useWidth();
  return (
    <Labeled label="fade s">
      <TextBox
        className={`${cls} ${w("w-14")} tabular`}
        value={value === null ? "" : String(value)}
        placeholder="default"
        title="Fade time in seconds; leave empty for StageLight's own default"
        onChange={(v) => onChange(v === "" || !Number.isFinite(+v) ? null : Math.max(0, +v))}
      />
    </Labeled>
  );
}

const TYPE = "__type__";
const EMPTY = "__empty__";

/**
 * Pick from StageLight's catalog, or type a name (StageLight resolves names and numbers too).
 * Without a catalog it is a text box. A value the catalog does not know shows with a warning.
 */
function CatalogPick({ value, options, empty, onPick, cls, width, placeholder, title }: { value: string; options: { value: string; label: string }[] | null; /** Label of the empty choice ("Next cue"), if empty is allowed. */ empty?: string; onPick: (v: string) => void; cls: string; width: string; placeholder?: string; title?: string }) {
  const w = useWidth();
  const [typing, setTyping] = useState(false);
  if (!options || typing)
    return (
      <TextBox
        className={`${cls} ${w(width)}`}
        value={value}
        placeholder={placeholder}
        title={title}
        onChange={(v) => {
          setTyping(false);
          onPick(v);
        }}
      />
    );
  const known = !value || options.some((o) => o.value === value);
  const all = [...(empty !== undefined ? [{ value: EMPTY, label: empty }] : []), ...options, ...(known ? [] : [{ value, label: `⚠ ${value} (not in StageLight)` }]), { value: TYPE, label: "Type a name…" }];
  return <SelectBox className={`${cls} ${w(width)}`} value={value || (empty !== undefined ? EMPTY : TYPE)} onChange={(v) => (v === TYPE ? setTyping(true) : onPick(v === EMPTY ? "" : v))} options={all} />;
}

/** A command to StageLight: GO a page or cue, a named trigger, stop, blackout, master… Pages, cues and triggers come from its catalog. */
function StageLightFields({ m, onChange, cls }: { m: StageLightMessage; onChange: (m: IoMessage) => void; cls: string }) {
  const w = useWidth();
  const roomy = useContext(Roomy);
  const catalog = useProject((s) => s.project.io?.stagelight?.catalog ?? null);
  const target = stageLightTarget(m, catalog);
  /** Typed or picked: point at catalog IDs where it matches one, and keep the names in label. */
  const set = (x: StageLightMessage) => onChange(resolveWithCatalog({ ...x, label: undefined }, catalog));
  /** Switching command keeps the page / cue / name already chosen where the new one has the same field. */
  const setOp = (op: StageLightOp) => {
    const next = defaultStageLightMessage(op) as Record<string, unknown>;
    for (const k of ["page", "cue", "name", "fade"]) if (k in next && k in m) next[k] = (m as Record<string, unknown>)[k];
    set(next as StageLightMessage);
  };
  const page = m.op === "go" || m.op === "goCue" ? findCatalogPage(catalog, m.page) : null;
  // GO and GO cue are one command here: the cue box decides (empty = the page's next cue).
  const ops = STAGELIGHT_OPS.filter((o) => o.op !== "goCue").map((o) => ({ value: o.op, label: o.op === "go" ? "GO" : o.label }));
  return (
    <>
      <Labeled label="Command" roomyOnly>
        <SelectBox className={`${cls} ${w("w-[150px]")}`} value={m.op === "goCue" ? "go" : m.op} onChange={(v) => v !== (m.op === "goCue" ? "go" : m.op) && setOp(v as StageLightOp)} options={ops} />
      </Labeled>
      {(m.op === "go" || m.op === "goCue") && (
        <>
          <Labeled label="page">
            <CatalogPick
              cls={cls}
              width="w-[150px]"
              value={m.page}
              options={catalog?.pages.map((p) => ({ value: p.id, label: `${p.number}. ${p.name}` })) ?? null}
              empty={roomy ? "The running page" : "running page"}
              placeholder={roomy ? "the running page" : "running"}
              title="StageLight page: its name, ID or number (1 = the first page)"
              onPick={(v) => set({ type: "stagelight", op: "go", page: v })}
            />
          </Labeled>
          {m.page.trim() !== "" && (
            <Labeled label="cue">
              <CatalogPick
                cls={cls}
                width={catalog ? "w-[170px]" : "w-16"}
                value={m.op === "goCue" ? m.cue : ""}
                options={catalog ? (page?.cues.map((e) => ({ value: e.entryId, label: `${e.number}. ${e.name}${e.follow === "auto" ? " (auto)" : ""}` })) ?? []) : null}
                empty="Next cue"
                placeholder="next"
                title="Cue of that page's cue list: its number (1 = first), name or entry ID; empty = the page's next cue"
                onPick={(v) => set(v.trim() ? { type: "stagelight", op: "goCue", page: m.page, cue: v } : { type: "stagelight", op: "go", page: m.page })}
              />
            </Labeled>
          )}
        </>
      )}
      {m.op === "trigger" && (
        <Labeled label="trigger" wide>
          <CatalogPick
            cls={cls}
            width="w-[170px]"
            value={m.name}
            options={catalog?.triggers.map((t) => ({ value: t.id, label: t.does ? `${t.name} — ${t.does}` : t.name })) ?? null}
            placeholder="lion.leap"
            title="A named trigger, mapped to a GO (or other action) in StageLight under ☰ → Network & triggers. The mapping can change there without touching this cue."
            onPick={(name) => set({ ...m, name })}
          />
        </Labeled>
      )}
      {(m.op === "stop" || m.op === "clear") && <FadeBox value={m.fade} cls={cls} onChange={(fade) => onChange({ ...m, fade })} />}
      {m.op === "blackout" && (
        <Labeled label="Blackout" roomyOnly>
          <SelectBox className={`${cls} ${w("w-[90px]")}`} value={m.on ? "on" : "off"} onChange={(v) => onChange({ ...m, on: v === "on" })} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} />
        </Labeled>
      )}
      {m.op === "master" && (
        <Labeled label="level %">
          <NumberInput className={`${cls} ${w("w-16")}`} value={Math.round(m.level * 100)} min={0} max={100} step={5} onChange={(v) => onChange({ ...m, level: Math.max(0, Math.min(100, v)) / 100 })} />
        </Labeled>
      )}
      {m.op === "play" && (
        <>
          <Labeled label="library cue">
            <CatalogPick
              cls={cls}
              width="w-[150px]"
              value={m.cue}
              options={catalog?.library.map((l) => ({ value: l.id, label: l.name })) ?? null}
              placeholder="Warm wash"
              title="A cue from StageLight's library, by name or ID, played outside any page"
              onPick={(cue) => set({ ...m, cue })}
            />
          </Labeled>
          <FadeBox value={m.fade} cls={cls} onChange={(fade) => onChange({ ...m, fade })} />
        </>
      )}
      {m.op === "ledwall" && (
        <Labeled label="media">
          <TextBox className={`${cls} ${w("w-[140px]")}`} value={m.media} placeholder="off" title="Media for StageLight's LED wall preview; off = blank" onChange={(media) => onChange({ ...m, media: media || "off" })} />
        </Labeled>
      )}
      {target.missing ? (
        <span className={cn("text-[11px] text-destructive", roomy && "col-span-full")} title="Pick it again from the list, or check StageLight">
          ⚠ {target.missing}{m.label ? ` (was ${m.label})` : ""}
        </span>
      ) : (
        !catalog &&
        m.label && <span className={cn("text-[11px] text-muted-foreground/70", roomy && "col-span-full")} title="As picked; StageLight's catalog is not loaded">{m.label}</span>
      )}
    </>
  );
}
