// Build mode library pages: characters, effect presets, desk mics + connection, backstage sync, settings,
// and the LiveStage import dialog.

import { useEffect, useRef, useState } from "react";
import { levelToDb, type DliveKind } from "../../../../shared/dlive.ts";
import { holderOf, micLive, presetWarnings } from "../../../server/logic.ts";
import { AVATAR_PALETTE, type Character, type EffectPreset, type FxSend, type WatchChannel } from "../../../server/model.ts";
import { BackstageQr } from "../show/BackstageDialog.tsx";
import { cmd, toast, useOp } from "../lib/store.ts";
import { Avatar, Dot, Icon, SectionLabel, cx, fmtTime } from "../lib/ui.tsx";
import { Card, EditText, IconBtn } from "./BuildMode.tsx";

// ---------------------------------------------------------------- characters

/** Centre-crop to a square JPEG data URL. */
async function squareJpeg(file: File, size: number, quality: number): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  bmp.close();
  return c.toDataURL("image/jpeg", quality);
}

async function uploadPhoto(id: string, file: File) {
  try {
    const [data, thumb] = await Promise.all([squareJpeg(file, 512, 0.85), squareJpeg(file, 64, 0.7)]);
    const r = await fetch(`/api/photo/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, thumb }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
  } catch (e) {
    toast(`Photo: ${e instanceof Error ? e.message : e}`, true);
  }
}

export function CharactersPage() {
  const show = useOp((s) => s.show)!;
  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="flex-1 text-[40px] leading-[1.1] font-black">Characters</h1>
        <button type="button" onClick={() => void cmd("character.save", { name: "New character" })} className="inline-flex items-center gap-2 rounded-2xl bg-lime px-5 py-3 text-base font-black text-ink">
          <Icon name="plus" size={18} stroke={2.6} />
          Add character
        </button>
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))" }}>
        {show.characters.map((c) => (
          <CharacterCard key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

function CharacterCard({ c }: { c: Character }) {
  const show = useOp((s) => s.show)!;
  const file = useRef<HTMLInputElement>(null);
  const save = (patch: Record<string, unknown>) => void cmd("character.save", { id: c.id, name: c.name, ...patch });
  const scenes = show.scenes.filter((s) => s.cast.includes(c.id)).length;
  return (
    <div className="flex flex-col gap-4 rounded-[28px] border-2 border-line bg-panel p-5">
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => file.current?.click()} aria-label={`Photo of ${c.name}`} className="relative">
          <Avatar c={c} size={88} />
          <span className="absolute -right-1 -bottom-1 inline-flex size-8 items-center justify-center rounded-full border-[3px] border-panel bg-chip">
            <Icon name="camera" size={15} />
          </span>
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPhoto(c.id, f);
            e.target.value = "";
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <EditText value={c.name} onCommit={(v) => v && save({ name: v })} ariaLabel="Name" className="field h-12 text-[22px] font-black" maxLength={40} />
          <span className="text-[13px] font-extrabold text-muted">{scenes === 1 ? "In 1 scene" : `In ${scenes} scenes`}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full bg-well p-1">
          {(["male", "female"] as const).map((g) => (
            <button key={g} type="button" onClick={() => save({ gender: g })} className={cx("rounded-full px-4 py-2 text-sm capitalize", c.gender === g ? "bg-text font-black text-ink" : "font-extrabold text-dim")}>
              {g}
            </button>
          ))}
        </div>
        <select className="field h-10 flex-1" value={c.defaultMic ?? ""} onChange={(e) => save({ defaultMic: e.target.value ? Number(e.target.value) : null })} aria-label="Default mic">
          <option value="">No mic</option>
          {show.mics.map((m) => {
            const other = show.characters.find((x) => x.id !== c.id && x.defaultMic === m.n);
            return (
              <option key={m.n} value={m.n}>
                Mic {m.n}
                {other ? ` (also ${other.name})` : ""}
              </option>
            );
          })}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {AVATAR_PALETTE.map((p, i) => (
          <button key={i} type="button" aria-label={`Colour ${i + 1}`} onClick={() => save({ palette: i })} className="size-7 rounded-full" style={{ background: p.bg, boxShadow: c.palette === i ? "0 0 0 3px #F4F6FA" : undefined }} />
        ))}
        <span className="flex-1" />
        {c.photo && (
          <button type="button" onClick={() => void cmd("character.photo", { id: c.id, photo: null })} className="rounded-xl px-2.5 py-1.5 text-xs font-black text-muted hover:bg-chip">
            Remove photo
          </button>
        )}
        <IconBtn icon="trash" label={`Delete ${c.name}`} onClick={() => confirm(`Delete ${c.name}? They leave every scene and cue.`) && void cmd("character.remove", { id: c.id })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- effect presets

const FX_SEND_KINDS: { kind: FxSend["kind"]; label: string }[] = [
  { kind: "monoFxSend", label: "Mono FX send" },
  { kind: "stereoFxSend", label: "Stereo FX send" },
];
const WATCH_KINDS: { kind: WatchChannel["kind"]; label: string }[] = [
  { kind: "fxReturn", label: "FX return" },
  { kind: "dca", label: "DCA" },
];

export function PresetsPage() {
  const show = useOp((s) => s.show)!;
  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="flex-1 text-[40px] leading-[1.1] font-black">Effect presets</h1>
        <button type="button" onClick={() => void cmd("preset.save", { preset: { name: "New effect", desc: "", sends: [{ kind: "monoFxSend", number: 1, db: 0 }], watch: [], fadeIn: 1, fadeOut: 1 } })} className="inline-flex items-center gap-2 rounded-2xl bg-lime px-5 py-3 text-base font-black text-ink">
          <Icon name="plus" size={18} stroke={2.6} />
          Add effect
        </button>
      </div>
      <p className="-mt-3 max-w-[760px] text-[15px] font-extrabold text-muted">
        An effect sends the mic's channel into the desk's FX sends at these levels (at amount Medium; Light is 10 dB less, Full 6 dB more). Clearing it puts the sends back where they were.
      </p>
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
        {show.presets.map((p) => (
          <PresetCard key={p.id} p={p} />
        ))}
      </div>
    </>
  );
}

function PresetCard({ p }: { p: EffectPreset }) {
  const rt = useOp((s) => s.runtime)!;
  const save = (patch: Partial<EffectPreset>) => void cmd("preset.save", { preset: { ...p, ...patch } });
  const warnings = presetWarnings(p, rt);
  const name = (kind: DliveKind, n: number) => rt.channels[`${kind}:${n}`]?.name;
  return (
    <Card
      icon="sparkle"
      title={<EditText value={p.name} onCommit={(v) => v && save({ name: v })} ariaLabel="Effect name" className="field h-12 w-full border-transparent bg-transparent px-2 text-2xl font-black hover:border-line2" maxLength={30} />}
      right={<IconBtn icon="trash" label={`Delete ${p.name}`} onClick={() => confirm(`Delete the effect ${p.name}? Cues that use it lose it.`) && void cmd("preset.remove", { id: p.id })} />}
    >
      <EditText value={p.desc} onCommit={(v) => save({ desc: v })} placeholder="Short description (Delay + hall)" ariaLabel="Description" maxLength={40} />
      {warnings.map((w) => (
        <div key={w} className="flex items-center gap-2 rounded-2xl bg-amber-bg px-4 py-3 text-[15px] font-black text-amber-text">
          <Icon name="warn" size={18} />
          {w}: this effect is silent
        </div>
      ))}
      <SectionLabel>Sends</SectionLabel>
      {p.sends.map((s, i) => {
        const setS = (patch: Partial<FxSend>) => save({ sends: p.sends.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        const pct = Math.max(0, Math.min(100, ((s.db + 54) / 64) * 100));
        return (
          <div key={i} className="flex flex-wrap items-center gap-2.5">
            <select className="field h-10 w-[150px] text-sm" value={s.kind} onChange={(e) => setS({ kind: e.target.value as FxSend["kind"] })} aria-label="Send type">
              {FX_SEND_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <select className="field h-10 w-[150px] text-sm" value={s.number} onChange={(e) => setS({ number: Number(e.target.value) })} aria-label="Send number">
              {Array.from({ length: 16 }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                  {name(s.kind, n) ? ` ${name(s.kind, n)}` : ""}
                </option>
              ))}
            </select>
            <div className="h-2.5 min-w-[60px] flex-1 overflow-hidden rounded-full bg-ink">
              <div className="h-full rounded-full bg-violet" style={{ width: `${pct}%` }} />
            </div>
            <NumberField value={s.db} min={-54} max={10} step={0.5} suffix="dB" onCommit={(v) => setS({ db: v })} label="Level" />
            <IconBtn icon="close" label="Remove send" onClick={() => save({ sends: p.sends.filter((_, j) => j !== i) })} />
          </div>
        );
      })}
      <button type="button" onClick={() => save({ sends: [...p.sends, { kind: "monoFxSend", number: 1, db: 0 }] })} className="self-start rounded-xl border-2 border-dashed border-[#3A4256] px-3.5 py-2 text-sm font-black text-dim">
        + Send
      </button>
      <SectionLabel>Needs open on the desk</SectionLabel>
      {p.watch.map((w, i) => {
        const st = rt.channels[`${w.kind}:${w.number}`];
        const setW = (patch: Partial<WatchChannel>) => save({ watch: p.watch.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div key={i} className="flex flex-wrap items-center gap-2.5">
            <select className="field h-10 w-[150px] text-sm" value={w.kind} onChange={(e) => setW({ kind: e.target.value as WatchChannel["kind"] })} aria-label="Channel type">
              {WATCH_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <select className="field h-10 w-[150px] text-sm" value={w.number} onChange={(e) => setW({ number: Number(e.target.value) })} aria-label="Number">
              {Array.from({ length: w.kind === "dca" ? 24 : 16 }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                  {name(w.kind, n) ? ` ${name(w.kind, n)}` : ""}
                </option>
              ))}
            </select>
            <span className="flex-1 text-sm font-extrabold text-muted">
              {st ? (
                <>
                  {st.muted ? <span className="text-coral-text">muted</span> : st.muted === false ? <span className="text-lime">on</span> : "?"}
                  {st.fader !== undefined && ` · ${st.fader === 0 ? "−∞" : `${levelToDb(st.fader).toFixed(1)} dB`}`}
                </>
              ) : (
                "not read from the desk"
              )}
            </span>
            <IconBtn icon="close" label="Remove" onClick={() => save({ watch: p.watch.filter((_, j) => j !== i) })} />
          </div>
        );
      })}
      <button type="button" onClick={() => save({ watch: [...p.watch, { kind: "fxReturn", number: 1 }] })} className="self-start rounded-xl border-2 border-dashed border-[#3A4256] px-3.5 py-2 text-sm font-black text-dim">
        + Return or DCA
      </button>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-[15px] font-extrabold text-dim">
          Fade in <NumberField value={p.fadeIn} min={0} max={20} step={0.5} suffix="s" onCommit={(v) => save({ fadeIn: v })} label="Fade in" />
        </label>
        <label className="flex items-center gap-2 text-[15px] font-extrabold text-dim">
          Fade out <NumberField value={p.fadeOut} min={0} max={20} step={0.5} suffix="s" onCommit={(v) => save({ fadeOut: v })} label="Fade out" />
        </label>
      </div>
    </Card>
  );
}

function NumberField({ value, min, max, step, suffix, onCommit, label }: { value: number; min: number; max: number; step: number; suffix: string; onCommit: (v: number) => void; label: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.max(min, Math.min(max, Number(v)));
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setV(String(value));
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input className="field h-10 w-[78px] px-2 text-right text-[15px]" type="number" min={min} max={max} step={step} value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      <span className="text-sm font-extrabold text-muted">{suffix}</span>
    </span>
  );
}

// ---------------------------------------------------------------- desk

export function DeskPage() {
  const show = useOp((s) => s.show)!;
  const rt = useOp((s) => s.runtime)!;
  const settings = useOp((s) => s.settings)!;
  const pending = useOp((s) => s.pending);
  const [busy, setBusy] = useState(false);
  const d = settings.desk;
  const dry = d.mode === "dry";
  const status = dry ? "Dry run: nothing is sent, this screen plays the desk" : rt.desk.status === "connected" ? `Connected to ${d.host}:${d.port}` : rt.desk.status === "connecting" ? `Connecting to ${d.host}:${d.port}…` : `Offline${rt.desk.error ? `: ${rt.desk.error}` : ""} (retrying)`;
  const color = dry ? "#A78BFA" : rt.desk.status === "connected" ? "#B8F25C" : rt.desk.status === "connecting" ? "#FFB547" : "#FF6B5E";
  const detect = async () => {
    setBusy(true);
    try {
      const r = await cmd<{ found: number; changed: { mic: number; channel: number; name: string }[]; namesRead: number }>("mics.detect");
      toast(r.changed.length ? `Mapped ${r.changed.map((c) => `mic ${c.mic} → In ${c.channel} ${c.name}`).join(", ")}` : `Found ${r.found} mics by name; nothing to change`);
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1 className="text-[40px] leading-[1.1] font-black">Desk</h1>
      <Card title="Connection" right={<span className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-[13px] font-black"><Dot color={color} size={9} />{dry ? "dry run" : rt.desk.status}</span>}>
        <div className="flex rounded-full bg-well p-1 self-start">
          {(["desk", "dry"] as const).map((m) => (
            <button key={m} type="button" onClick={() => (m === "desk" && !confirm(`Connect to the dLive at ${d.host}? From now on cues and buttons mute and unmute its channels.`) ? null : void cmd("settings.desk", { mode: m }))} className={cx("rounded-full px-5 py-2.5 text-[15px]", d.mode === m ? "bg-text font-black text-ink" : "font-extrabold text-dim")}>
              {m === "desk" ? "dLive desk" : "Dry run (no desk)"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] font-extrabold text-muted">
            Address
            <EditText value={d.host} onCommit={(v) => v && void cmd("settings.desk", { host: v })} className="field w-[200px]" ariaLabel="Desk address" />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-extrabold text-muted">
            Port
            <EditText value={String(d.port)} onCommit={(v) => void cmd("settings.desk", { port: Number(v) })} className="field w-[110px]" ariaLabel="Desk port" />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-extrabold text-muted">
            Base MIDI channel
            <select className="field w-[120px]" value={d.baseChannel} onChange={(e) => void cmd("settings.desk", { baseChannel: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {!dry && (
            <button type="button" onClick={() => void cmd("desk.reconnect")} className="h-11 rounded-[14px] bg-chip px-4 text-[15px] font-black">
              Reconnect
            </button>
          )}
        </div>
        <span className="text-[15px] font-extrabold" style={{ color }}>
          {status}
        </span>
        <span className="text-[13px] font-extrabold text-ghost">The desk's own setting: Utility → Control → MIDI (MIDI over TCP, port 51325). Cues and buttons only ever touch the mic channels below and the effect sends.</span>
      </Card>
      <Card
        title="Desk mics"
        right={
          <button type="button" disabled={busy || dry || rt.desk.status !== "connected"} onClick={() => void detect()} className="inline-flex items-center gap-2 rounded-[14px] bg-chip px-4 py-2.5 text-[15px] font-black disabled:opacity-40">
            <Icon name="sync" size={16} />
            {busy ? "Reading names…" : "Detect from desk"}
          </button>
        }
      >
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))" }}>
          {show.mics.map((m) => {
            const h = holderOf(show, null, m.n);
            const deskName = rt.channels[`input:${m.channel}`]?.name;
            const live = micLive(show, rt, m.n);
            return (
              <div key={m.n} className="flex items-center gap-2.5 rounded-[14px] bg-raise px-3 py-2.5">
                <span className="inline-flex h-[30px] min-w-[34px] items-center justify-center rounded-[9px] bg-chip text-sm font-black">{m.n}</span>
                <span className="min-w-0 flex-1 truncate text-[15px] font-extrabold">{h?.char.name ?? <span className="text-ghost">nobody</span>}</span>
                <span className="text-xs font-extrabold text-muted">In</span>
                <EditText value={String(m.channel)} onCommit={(v) => void cmd("mics.set", { mics: [{ n: m.n, channel: Number(v) }] })} className="field h-9 w-[58px] px-2 text-center text-sm" ariaLabel={`Desk input for mic ${m.n}`} />
                <span className="w-[70px] truncate text-xs font-extrabold text-muted" title={deskName}>
                  {deskName ?? "—"}
                </span>
                <Dot color={pending[m.n] !== undefined ? "#FFB547" : live === undefined ? "#2A303D" : live ? "#B8F25C" : "#FF6B5E"} />
              </div>
            );
          })}
        </div>
        <AddMic />
      </Card>
    </>
  );
}

/** Add another mic on any desk input (shows the desk's name for it), or drop the last one. */
function AddMic() {
  const show = useOp((s) => s.show)!;
  const rt = useOp((s) => s.runtime)!;
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ch = Number(input);
  const valid = ch >= 1 && ch <= 128;
  const deskName = valid ? rt.channels[`input:${ch}`]?.name : undefined;
  const usedBy = valid ? show.mics.find((m) => m.channel === ch)?.n : undefined;
  const last = show.mics[show.mics.length - 1];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-4">
      <form
        className="flex flex-wrap items-center gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setErr(null);
          void cmd("mics.add", { channel: ch }).then(() => setInput(""), (x: unknown) => setErr(x instanceof Error ? x.message : String(x)));
        }}
      >
        <span className="text-[15px] font-black">Add mic {show.mics.length + 1} on desk input</span>
        <input value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" placeholder="1–128" aria-label="Desk input for the new mic" className="field h-10 w-[76px] px-2 text-center text-base" />
        {valid && <span className="text-[13px] font-extrabold text-muted">{deskName ? `“${deskName}”` : "name unknown"}{usedBy ? ` · already mic ${usedBy}` : ""}</span>}
        <button type="submit" disabled={!valid} className="inline-flex items-center gap-2 rounded-[14px] bg-lime px-4 py-2 text-[15px] font-black text-ink disabled:opacity-40">
          <Icon name="plus" size={16} stroke={2.6} />
          Add mic
        </button>
      </form>
      <div className="flex-1" />
      {last && show.mics.length > 1 && (
        <button
          type="button"
          onClick={() => confirm(`Remove mic ${last.n} (desk input ${last.channel})? Anyone on mic ${last.n} loses it.`) && void cmd("mics.remove", { mic: last.n }).catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))}
          className="inline-flex items-center gap-2 rounded-[14px] border-2 border-line2 px-4 py-2 text-[15px] font-black text-soft"
        >
          <Icon name="trash" size={16} />
          Remove mic {last.n}
        </button>
      )}
      {err && <span className="w-full text-sm font-black text-coral-text">{err}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- backstage sync

function parseFirebaseConfig(text: string) {
  const pick = (k: string) => text.match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`))?.[1]?.trim();
  return { apiKey: pick("apiKey"), projectId: pick("projectId"), databaseURL: pick("databaseURL") };
}

export function BackstagePage() {
  const settings = useOp((s) => s.settings)!;
  const rt = useOp((s) => s.runtime)!;
  const c = settings.sync.cloud;
  const [paste, setPaste] = useState("");
  const setCloud = (patch: Record<string, string>) => void cmd("settings.sync", { cloud: patch });
  return (
    <>
      <h1 className="text-[40px] leading-[1.1] font-black">Backstage</h1>
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
        <Card title="Mic check QR code">
          <BackstageQr />
        </Card>
        <Card title="Cloud (Firebase)" right={<span className="text-sm font-extrabold text-muted">{rt.cloud.status}</span>}>
          <p className="text-sm font-extrabold text-muted">For when the Wi-Fi is down: phones on mobile data use the hosted backstage page, and the database carries the changes. See docs/SOUND_APP.md to set up the Firebase project.</p>
          <textarea className="field h-24 py-2 text-sm" placeholder="Paste the Firebase web config (const firebaseConfig = {…})" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button
            type="button"
            disabled={!paste.trim()}
            onClick={() => {
              const p = parseFirebaseConfig(paste);
              if (!p.apiKey || !p.projectId) return toast("That does not look like a Firebase config (needs apiKey and projectId)", true);
              setCloud({ apiKey: p.apiKey, projectId: p.projectId, databaseURL: p.databaseURL ?? "" });
              setPaste("");
            }}
            className="self-start rounded-[14px] bg-chip px-4 py-2.5 text-[15px] font-black disabled:opacity-40"
          >
            Use these keys
          </button>
          <Field label="Project" value={c.projectId} onCommit={(v) => setCloud({ projectId: v })} />
          <Field label="Database URL" value={c.databaseURL} onCommit={(v) => setCloud({ databaseURL: v })} placeholder="https://<project>-default-rtdb.firebaseio.com" />
          <Field label="Hosted page" value={c.hostedUrl} onCommit={(v) => setCloud({ hostedUrl: v })} placeholder="https://<project>.web.app/backstage.html (after deploying)" />
          <Field label="Emulator host" value={c.emulatorHost} onCommit={(v) => setCloud({ emulatorHost: v })} placeholder="empty = the real Firebase; 127.0.0.1 = local emulators" />
          <div className="flex flex-wrap items-center gap-3 text-sm font-extrabold text-muted">
            <span>Join key: {c.joinKey ? `${c.joinKey.slice(0, 4)}…` : "made when cloud sync is switched on"}</span>
            {c.joinKey && (
              <button type="button" onClick={() => confirm("Make a new join key? Phones with the old QR code lose access.") && void cmd("settings.sync", { newJoinKey: true })} className="rounded-xl bg-chip px-3 py-1.5 text-soft">
                New key
              </button>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function Field({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-extrabold text-muted">
      {label}
      <EditText value={value} onCommit={onCommit} placeholder={placeholder} className="field text-sm" ariaLabel={label} maxLength={300} />
    </label>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsPage({ onImport }: { onImport: () => void }) {
  const show = useOp((s) => s.show)!;
  const settings = useOp((s) => s.settings)!;
  const log = useOp((s) => s.log);
  return (
    <>
      <h1 className="text-[40px] leading-[1.1] font-black">Settings</h1>
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
        <Card title="Show">
          <Field label="Name" value={show.name} onCommit={(v) => v && void cmd("show.rename", { name: v })} />
          <span className="text-sm font-extrabold text-muted">{show.source ? `Scenes from “${show.source.showName}” (${show.source.via}), ${new Date(show.source.importedAt).toLocaleString()}` : "Demo scenes: import the real ones from LiveStage."}</span>
          <button type="button" onClick={onImport} className="self-start rounded-[14px] bg-lime px-4 py-2.5 text-[15px] font-black text-ink">
            Import scenes from LiveStage
          </button>
        </Card>
        <Card title="This computer">
          <label className="flex items-center gap-3 text-[15px] font-extrabold">
            <input type="checkbox" className="size-5 accent-[#B8F25C]" checked={settings.allowRemoteOperator} onChange={(e) => void cmd("settings.remote", { allow: e.target.checked })} />
            Allow the operator screen from other computers on the network
          </label>
          <span className="text-sm font-extrabold text-muted">Off: only this computer can run the mics. The backstage page always works from phones.</span>
        </Card>
      </div>
      <Card title="Log">
        <div className="scroll-thin max-h-[320px] overflow-y-auto rounded-2xl bg-well p-3 font-mono text-xs leading-5 text-dim">
          {[...log].reverse().map((l, i) => (
            <div key={i}>
              <span className="text-ghost">{fmtTime(l.at)}</span> {l.msg}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- import

interface Sources {
  local: { path: string; modified: number } | null;
  bridge: boolean;
}
interface Report {
  added: string[];
  updated: string[];
  removed: string[];
  kept: number;
  showName: string;
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [src, setSrc] = useState<Sources | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [path, setPath] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void cmd<Sources>("import.sources").then(setSrc, () => {});
  }, []);
  const run = async (args: Record<string, unknown>) => {
    setBusy(true);
    try {
      setReport(await cmd<Report>("import.livestage", args));
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(5,7,10,0.72)] p-6" onClick={onClose}>
      <div role="dialog" aria-label="Import scenes from LiveStage" className="flex w-full max-w-[560px] flex-col gap-4 rounded-[32px] border border-line2 bg-card p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[26px] font-black">Import from LiveStage</span>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-12 items-center justify-center rounded-2xl bg-chip">
            <Icon name="close" stroke={2.8} />
          </button>
        </div>
        <span className="text-[15px] font-extrabold text-muted">Scenes keep their cast and cues; new scenes are added; scenes LiveStage no longer has are marked, not deleted.</span>
        {report ? (
          <div className="flex flex-col gap-2 rounded-[20px] bg-well p-5 text-base font-extrabold">
            <span className="text-xl font-black">“{report.showName}”</span>
            <span className="text-lime">{report.added.length} new scenes{report.added.length ? `: ${report.added.join(", ")}` : ""}</span>
            <span className="text-soft">
              {report.kept} kept{report.updated.length ? `, ${report.updated.length} renamed or renumbered` : ""}
            </span>
            {report.removed.length > 0 && <span className="text-amber-text">Gone from LiveStage: {report.removed.join(", ")}</span>}
            <button type="button" onClick={onClose} className="mt-2 h-14 rounded-[18px] bg-text text-lg font-black text-ink">
              Done
            </button>
          </div>
        ) : (
          <>
            <SourceBtn disabled={busy || !src?.local} onClick={() => void run({ from: "local" })} title="This computer's LiveStage show" sub={src?.local ? `Saved ${new Date(src.local.modified).toLocaleString()}` : "No LiveStage show found on this computer"} />
            <SourceBtn disabled={busy || !src?.bridge} onClick={() => void run({ from: "bridge" })} title="LiveStage while it runs" sub={src?.bridge ? "Asks the open app for its running order (read-only)" : "LiveStage's agent bridge is not running"} />
            <SourceBtn disabled={busy} onClick={() => file.current?.click()} title="A show file…" sub="project.json, or show.json from a .slshow package" />
            <input
              ref={file}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void run({ from: "json", json: await f.text(), name: f.name });
              }}
            />
            <div className="flex gap-2">
              <input className="field flex-1 text-sm" placeholder="…or a path: /Volumes/USB/House of David.slshow" value={path} onChange={(e) => setPath(e.target.value)} />
              <button type="button" disabled={busy || !path.trim()} onClick={() => void run({ from: "file", path: path.trim() })} className="rounded-[14px] bg-chip px-4 text-[15px] font-black disabled:opacity-40">
                Import
              </button>
            </div>
            {busy && <span className="text-[15px] font-extrabold text-muted">Importing…</span>}
          </>
        )}
      </div>
    </div>
  );
}

function SourceBtn({ title, sub, onClick, disabled }: { title: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="flex items-center gap-4 rounded-[22px] border-2 border-line2 bg-well px-5 py-4 text-left disabled:opacity-45">
      <span className="inline-flex size-11 items-center justify-center rounded-[14px] bg-chip">
        <Icon name="import" />
      </span>
      <span className="flex flex-col">
        <span className="text-lg font-black">{title}</span>
        <span className="text-[13px] font-extrabold text-muted">{sub}</span>
      </span>
    </button>
  );
}
