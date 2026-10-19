// Show Mode's show-wide tools: front-of-house announcements and show timers. Both work over
// anything on the wall (standby, any scene) and are also reachable from cues.

import { useEffect, useState } from "react";
import { KeyRound, Loader2, Megaphone, Minus, MonitorUp, Palette, Pause, Pencil, Pin, Play, Plus, RotateCcw, Square, Timer, Trash2, TriangleAlert, Upload, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { now } from "@/core/clock";
import { makeAnnouncement, makeIntermissionScene, makeTimer } from "@/core/factories";
import { normalizeGroups } from "@/core/groups";
import { importAssets, playableUrl, saveGeneratedAsset } from "@/core/platform";
import { formatClock, timerLeft } from "@/core/timers";
import type { Announcement, Asset, OverlayPosition, ShowTimer, TimerOverlayStyle } from "@/core/types";
import { TimerOverlayView } from "@/render/TimerOverlay";
import { playAnnouncement, probeDuration, runTimer, stopAnnouncement } from "@/engine/operator";
import { accountVoices, getElevenKey, setElevenKey, speak, TRAILER_VOICES, TTS_MODELS, type Voice } from "@/engine/elevenlabs";
import { useProject, NO_ITEMS } from "@/store/project";
import { useShow } from "@/store/show";
import { NumberInput, SelectBox, SliderField, SwitchField, Field } from "../fields";
import { InfoTip } from "../kit";
import { FontPicker } from "../FontPicker";

function useTick(ms: number) {
  const [, force] = useState(0);
  useEffect(() => {
    const h = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
}

const durations = new Map<string, number>();
/** Length of an audio asset in seconds (probed once). */
function useAudioDuration(a: Asset | undefined) {
  const [, force] = useState(0);
  useEffect(() => {
    const url = playableUrl(a);
    if (!a || !url || durations.has(a.id)) return;
    durations.set(a.id, 0);
    void probeDuration(url).then((d) => {
      durations.set(a.id, d ?? 0);
      force((n) => n + 1);
    });
  }, [a]);
  return a ? durations.get(a.id) || 0 : 0;
}

const NONE = "__none__";

// ---------------------------------------------------------------- announcements

export function AnnouncementsPanel() {
  const list = useProject((s) => s.project.announcements ?? NO_ITEMS);
  const assets = useProject((s) => s.project.assets);
  const audio = assets.filter((a) => a.type === "audio");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gen, setGen] = useState(false);
  const upd = (fn: (l: Announcement[]) => void) => useProject.getState().update((p) => fn((p.announcements ??= [])));
  const importAudio = async () => {
    setBusy(true);
    try {
      const added = (await importAssets()).filter((a) => a.type === "audio");
      if (!added.length) return;
      useProject.getState().addAssets(added);
      upd((l) => l.push(...added.map((a) => makeAnnouncement(a.name.replace(/\.[a-z0-9]+$/i, ""), a.id))));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 px-3 pb-3">
      <div className="flex items-center gap-1.5">
        <Megaphone className="size-3.5 text-muted-foreground" />
        <span className="text-[12.5px] font-semibold">Announcements</span>
        <InfoTip>Pre-recorded front-of-house calls (“the show will begin in 5 minutes”). They play over anything on the wall, on the show's audio output, one at a time. A cue can play one too (Lighting &amp; sound → Announcement).</InfoTip>
        <div className="ml-auto flex items-center gap-1">
          {audio.length > 0 && (
            <SelectBox
              className="h-7 w-[170px] text-[11.5px]"
              value={NONE}
              onChange={(id) => {
                const a = audio.find((x) => x.id === id);
                if (a) upd((l) => l.push(makeAnnouncement(a.name.replace(/\.[a-z0-9]+$/i, ""), a.id)));
              }}
              options={[{ value: NONE, label: "+ Add from library…" }, ...audio.map((a) => ({ value: a.id, label: a.name }))]}
            />
          )}
          <Button size="xs" variant="outline" className="h-7" onClick={() => setGen(true)} title="Write a call and have an AI voice read it (ElevenLabs)">
            <Wand2 /> Generate
          </Button>
          <Button size="xs" variant="outline" className="h-7" disabled={busy} onClick={() => void importAudio()}>
            <Upload /> {busy ? "Importing…" : "Import audio"}
          </Button>
          {list.length > 0 && (
            <Button size="icon-xs" variant={editing ? "secondary" : "ghost"} className="size-7" title={editing ? "Done editing" : "Rename, change audio or volume"} aria-label="Edit announcements" onClick={() => setEditing(!editing)}>
              <Pencil />
            </Button>
          )}
        </div>
      </div>
      <GenerateDialog open={gen} onOpenChange={setGen} onAdd={(a) => upd((l) => l.push(a))} />
      {list.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
          No announcements yet. Import the recorded calls (MP3 / WAV): 5-minute call, phones off, intermission, show resumes.
        </p>
      )}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {[...list.filter((a) => a.pinned), ...list.filter((a) => !a.pinned)].map((a) => (
          <AnnouncementCard key={a.id} a={a} editing={editing} audio={audio} upd={upd} />
        ))}
      </div>
    </div>
  );
}

function AnnouncementCard({ a, editing, audio, upd }: { a: Announcement; editing: boolean; audio: Asset[]; upd: (fn: (l: Announcement[]) => void) => void }) {
  const asset = audio.find((x) => x.id === a.assetId);
  const dur = useAudioDuration(asset);
  const playing = useShow((s) => s.program.announce);
  useTick(250);
  const elapsed = playing && playing.id === a.id && !playing.stoppedAt ? (now() - playing.at) / 1000 : -1;
  const isOn = elapsed >= 0 && (dur === 0 || elapsed < dur + 0.5);
  const set = (fn: (x: Announcement) => void) =>
    upd((l) => {
      const x = l.find((y) => y.id === a.id);
      if (x) fn(x);
    });

  if (editing) {
    return (
      <div className="space-y-1.5 rounded-lg border border-border bg-card/60 p-2 text-[11.5px]">
        <input className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-[12.5px] font-medium" defaultValue={a.name} key={a.name} onBlur={(e) => e.target.value.trim() && set((x) => (x.name = e.target.value.trim()))} />
        <SelectBox className="h-7 text-[11.5px]" value={a.assetId ?? NONE} onChange={(v) => set((x) => (x.assetId = v === NONE ? null : v))} options={[{ value: NONE, label: "— no audio —" }, ...audio.map((x) => ({ value: x.id, label: x.name }))]} />
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Volume</span>
          <NumberInput className="h-7 w-16" value={a.volume} min={0} max={2} step={0.05} onChange={(v) => set((x) => (x.volume = v))} />
          <Button size="icon-xs" variant={a.pinned ? "secondary" : "ghost"} className="ml-auto" title={a.pinned ? "Unpin" : "Pin to the top"} aria-label="Pin" onClick={() => set((x) => (x.pinned = !x.pinned))}>
            <Pin />
          </Button>
          <Button size="icon-xs" variant={a.urgent ? "secondary" : "ghost"} className={a.urgent ? "text-live" : ""} title={a.urgent ? "Not urgent" : "Mark urgent (red)"} aria-label="Urgent" onClick={() => set((x) => (x.urgent = !x.urgent))}>
            <TriangleAlert />
          </Button>
          <Button size="icon-xs" variant="ghost" className="hover:text-destructive" aria-label="Delete announcement" onClick={() => upd((l) => l.splice(l.findIndex((y) => y.id === a.id), 1))}>
            <Trash2 />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden rounded-lg border transition-colors", isOn ? "border-armed/70 bg-armed/10" : a.urgent ? "border-live/60 bg-live/10 hover:bg-live/15" : "border-border bg-card/60 hover:bg-card")}>
      {isOn && dur > 0 && <div className="absolute inset-y-0 left-0 bg-armed/15" style={{ width: `${Math.min(100, (elapsed / dur) * 100)}%` }} />}
      <div className="relative flex items-center gap-2 p-2">
        <button
          type="button"
          disabled={!asset}
          onClick={() => playAnnouncement(a.id)}
          title={asset ? `Play “${a.name}” now` : "Pick an audio file (edit)"}
          className={cn("grid size-10 shrink-0 place-items-center rounded-lg", isOn ? "bg-armed text-black" : a.urgent ? "bg-live text-white hover:bg-live/85" : "bg-accent text-foreground hover:bg-accent/70", !asset && "opacity-40")}
        >
          {a.urgent ? <TriangleAlert className="size-4.5" /> : <Megaphone className="size-4.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className={cn("flex items-center gap-1 truncate text-[13px] font-semibold", a.urgent && "text-live")}>
            {a.pinned && <Pin className="size-3 shrink-0 opacity-70" />}
            <span className="truncate">{a.name}</span>
          </div>
          <div className="text-[11px] tabular text-muted-foreground">
            {!asset ? "no audio" : isOn ? `${formatClock(elapsed)} / ${formatClock(dur)}` : dur ? formatClock(dur) : "…"}
            {a.volume !== 1 && ` · vol ${Math.round(a.volume * 100)}%`}
          </div>
        </div>
        {isOn && (
          <Button size="sm" variant="outline" className="h-8 border-armed/60" onClick={() => stopAnnouncement()} title="Fade it out">
            <Square className="fill-current" /> Stop
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- timers

export function TimersPanel() {
  const timers = useProject((s) => s.project.timers ?? NO_ITEMS);
  const announcements = useProject((s) => s.project.announcements ?? NO_ITEMS);
  const upd = (fn: (l: ShowTimer[]) => void) => useProject.getState().update((p) => fn((p.timers ??= [])));
  const [design, setDesign] = useState(false);
  return (
    <div className="space-y-2 px-3 pb-3">
      <div className="flex items-center gap-1.5">
        <Timer className="size-3.5 text-muted-foreground" />
        <span className="text-[12.5px] font-semibold">Show timers</span>
        <InfoTip>Countdowns for the house: pre-show, intermission. They keep running whatever is on the wall. To show one on the wall, put a Countdown title in a scene (Build → Components → Add → Countdown), or press “Make a scene” below. A cue can start, pause or reset a timer.</InfoTip>
        <Button size="xs" variant="ghost" className="ml-auto h-7" onClick={() => setDesign(true)} title="How a timer looks when it is shown on screen">
          <Palette /> On-screen look
        </Button>
        <Button size="xs" variant="outline" className="h-7" onClick={() => upd((l) => l.push(makeTimer(`Timer ${l.length + 1}`, 10 * 60)))}>
          <Plus /> Add timer
        </Button>
      </div>
      <OverlayDesigner open={design} onOpenChange={setDesign} />
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {timers.map((t) => (
          <TimerCard key={t.id} t={t} announcements={announcements} upd={upd} />
        ))}
      </div>
    </div>
  );
}

function TimerCard({ t, announcements, upd }: { t: ShowTimer; announcements: Announcement[]; upd: (fn: (l: ShowTimer[]) => void) => void }) {
  const run = useShow((s) => s.program.timers?.[t.id]);
  const onScreen = useShow((s) => s.program.timerOverlay?.timerId === t.id);
  useTick(200);
  const left = timerLeft(run, t.duration, now());
  const running = !!run?.running;
  const finished = !running && left === 0;
  const set = (fn: (x: ShowTimer) => void) =>
    upd((l) => {
      const x = l.find((y) => y.id === t.id);
      if (x) fn(x);
    });
  const makeScene = () => {
    const proj = useProject.getState();
    const scene = { ...makeIntermissionScene(t.id), name: t.name };
    proj.update((p) => {
      const at = p.scenes.findIndex((s) => s.id === proj.selectedSceneId);
      const prev = p.scenes[at];
      // Next to the selected scene (inside its group if it has one), else at the end.
      if (prev) scene.groupId = prev.groupId ?? null;
      p.scenes.splice(at < 0 ? p.scenes.length : at + 1, 0, scene);
      normalizeGroups(p);
    });
    proj.selectScene(scene.id);
  };
  const mins = Math.floor(t.duration / 60);
  const secs = Math.round(t.duration % 60);

  return (
    <div className={cn("rounded-lg border p-2.5", running ? "border-preview/60 bg-preview/[0.06]" : finished ? "border-live/60 bg-live/[0.06]" : "border-border bg-card/60")}>
      <div className="flex items-center gap-2">
        <input className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-[13px] font-semibold hover:border-input focus:border-input" defaultValue={t.name} key={t.name} onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && set((x) => (x.name = e.target.value.trim()))} />
        <Button
          size="xs"
          variant={onScreen ? "default" : "outline"}
          className={cn("h-7 gap-1.5", onScreen && "bg-live text-white hover:bg-live/85")}
          title={onScreen ? "Take the clock off the wall" : "Show this clock on the wall, over whatever is playing"}
          onClick={() => useShow.getState().setTimerOverlay(onScreen ? null : { timerId: t.id, label: t.name })}
        >
          <MonitorUp /> {onScreen ? "On screen" : "Show on screen"}
        </Button>
        <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label="Delete timer" title="Delete timer" onClick={() => upd((l) => l.splice(l.findIndex((y) => y.id === t.id), 1))}>
          <Trash2 />
        </Button>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <span className={cn("font-key text-[44px] font-bold leading-none tabular", running ? (left <= 60 ? "text-armed" : "text-preview") : finished ? "text-live" : "text-foreground/80")}>{formatClock(left)}</span>
        <div className="ml-auto flex flex-col items-end gap-1">
          <Button size="sm" className={cn("h-9 min-w-[96px] gap-1.5 font-semibold", running ? "bg-accent text-foreground hover:bg-accent/70" : "bg-preview text-black hover:bg-preview/85")} onClick={() => runTimer(t.id, running ? "pause" : "start")}>
            {running ? <Pause className="fill-current" /> : <Play className="fill-current" />} {running ? "Pause" : finished ? "Start again" : run && left < t.duration ? "Resume" : "Start"}
          </Button>
          <div className="flex gap-0.5">
            <Button size="icon-xs" variant="ghost" className="size-7" title="One minute less" aria-label="One minute less" onClick={() => runTimer(t.id, "add", -60)}>
              <Minus />
            </Button>
            <Button size="icon-xs" variant="ghost" className="size-7" title="One minute more" aria-label="One minute more" onClick={() => runTimer(t.id, "add", 60)}>
              <Plus />
            </Button>
            <Button size="icon-xs" variant="ghost" className="size-7" title={`Back to ${formatClock(t.duration)}, stopped`} aria-label="Reset" onClick={() => runTimer(t.id, "reset")}>
              <RotateCcw />
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span>Length</span>
        <NumberInput className="h-6 w-12 text-[11px]" value={mins} min={0} max={600} step={1} onChange={(v) => set((x) => (x.duration = Math.max(1, Math.round(v) * 60 + secs)))} />
        <span>min</span>
        <NumberInput className="h-6 w-12 text-[11px]" value={secs} min={0} max={59} step={5} onChange={(v) => set((x) => (x.duration = Math.max(1, mins * 60 + Math.round(v))))} />
        <span>s</span>
        <span className="ml-2">At 0:00 play</span>
        <SelectBox className="h-6 w-[130px] text-[11px]" value={t.endAnnouncementId ?? NONE} onChange={(v) => set((x) => (x.endAnnouncementId = v === NONE ? null : v))} options={[{ value: NONE, label: "nothing" }, ...announcements.map((a) => ({ value: a.id, label: a.name }))]} />
        <Button size="xs" variant="ghost" className="ml-auto h-6" title="Add a holding scene with this timer's countdown after the selected scene" onClick={makeScene}>
          <Plus /> Make a scene
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- on-screen look

const POSITIONS: OverlayPosition[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
/** One look for every timer shown on screen, with a live preview at the wall's shape. */
function OverlayDesigner({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const output = useProject((s) => s.project.output);
  const st = output.timerOverlay;
  const set = (patch: Partial<TimerOverlayStyle>) => useProject.getState().setOutput({ timerOverlay: { ...st, ...patch } });
  const W = 560;
  const H = (W * output.canvasHeight) / Math.max(1, output.canvasWidth);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>On-screen timer look</DialogTitle>
          <DialogDescription>How a show timer looks when you press Show on screen. It sits over everything on the wall and hides during blackout.</DialogDescription>
        </DialogHeader>
        <div className="relative mx-auto overflow-hidden rounded-md ring-1 ring-border" style={{ width: W, height: Math.max(80, H), background: "linear-gradient(135deg,#2a2f3a,#0d0f14 60%,#3a2a1a)" }}>
          <TimerOverlayView style={st} label="Intermission" clock="12:34" h={Math.max(80, H)} />
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">Position</div>
            <div className="grid grid-cols-3 gap-1">
              {POSITIONS.map((p) => (
                <button key={p} type="button" title={p} aria-label={p} onClick={() => set({ position: p })} className={cn("size-7 rounded border", st.position === p ? "border-preview bg-preview/30" : "border-border hover:bg-accent")} />
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <SliderField label="Size" value={st.size} min={0.04} max={0.4} step={0.005} onChange={(v) => set({ size: v })} />
            <SliderField label="Edge margin" value={st.margin} min={0} max={0.2} step={0.005} onChange={(v) => set({ margin: v })} />
            <Field label="Font">
              <FontPicker value={st.font} onChange={(v) => set({ font: v })} />
            </Field>
            <Field label="Colours">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                text <input type="color" className="h-7 w-9 rounded border border-input bg-transparent" value={st.color} onChange={(e) => set({ color: e.target.value })} />
                box <input type="color" className="h-7 w-9 rounded border border-input bg-transparent" value={st.background} onChange={(e) => set({ background: e.target.value })} />
              </div>
            </Field>
            <SliderField label="Box opacity" value={st.backgroundOpacity} min={0} max={1} step={0.05} onChange={(v) => set({ backgroundOpacity: v })} />
            <SwitchField label="Timer name" value={st.showLabel} onChange={(v) => set({ showLabel: v })} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- AI voice (ElevenLabs)

/** Write a call, pick a voice, and add the spoken MP3 as a new announcement. */
function GenerateDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (a: Announcement) => void }) {
  const [key, setKey] = useState(getElevenKey);
  const [editKey, setEditKey] = useState(!getElevenKey());
  const [voices, setVoices] = useState<Voice[]>(TRAILER_VOICES);
  const [voice, setVoice] = useState(TRAILER_VOICES[0].id);
  const [model, setModel] = useState(TTS_MODELS[0].value);
  const [name, setName] = useState("");
  const [text, setText] = useState("Ladies and gentlemen... ");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });

  // With a key, offer the voices saved in the account too.
  useEffect(() => {
    if (!open || !key || editKey) return;
    void accountVoices(key)
      .then((mine) => setVoices([...TRAILER_VOICES, ...mine.filter((v) => !TRAILER_VOICES.some((t) => t.id === v.id))]))
      .catch(() => {});
  }, [open, key, editKey]);

  const generate = async () => {
    if (!key) return setState({ busy: false, error: "Add your ElevenLabs API key first.", done: null });
    if (!text.trim()) return setState({ busy: false, error: "Write what the voice should say.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const bytes = await speak(key, voice, text.trim(), model);
      const label = name.trim() || text.trim().replace(/^ladies and gentlemen[.,!…\s]*/i, "").slice(0, 40) || "Announcement";
      const asset = await saveGeneratedAsset(bytes, `Announcement · ${label}.mp3`, "audio");
      useProject.getState().addAssets([asset]);
      onAdd(makeAnnouncement(label, asset.id));
      setState({ busy: false, error: null, done: label });
      setName("");
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e), done: null });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Generate an announcement</DialogTitle>
          <DialogDescription>Write the call and an AI voice reads it (ElevenLabs). The recording is added to the library and as a new announcement button.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5 text-[12px]">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-2">
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
            {editKey ? (
              <>
                <input type="password" className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-[12px]" placeholder="ElevenLabs API key" value={key} onChange={(e) => setKey(e.target.value.trim())} />
                <Button size="xs" variant="secondary" className="h-7" disabled={!key} onClick={() => { setElevenKey(key); setEditKey(false); }}>
                  Save
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 text-muted-foreground">API key saved on this computer ({key.slice(0, 4)}…{key.slice(-4)})</span>
                <Button size="xs" variant="ghost" className="h-7" onClick={() => setEditKey(true)}>
                  Change
                </Button>
              </>
            )}
          </div>
          <Field label="Voice">
            <SelectBox value={voice} onChange={setVoice} options={voices.map((v) => ({ value: v.id, label: v.note ? `${v.name} · ${v.note}` : v.name }))} />
          </Field>
          <Field label="Model">
            <SelectBox value={model} onChange={setModel} options={TTS_MODELS} />
          </Field>
          <Field label="Button name">
            <input className="h-7 w-full rounded-md border border-input bg-transparent px-2" placeholder="Phones off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <textarea
            className="h-28 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-snug"
            placeholder="Ladies and gentlemen... please silence your phones. The show is about to begin."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-[10.5px] text-muted-foreground">Tip: “...” adds a pause. The key stays on this machine and is never saved in the show file.</p>
          {state.error && <p className="text-[12px] text-destructive">{state.error}</p>}
          {state.done && <p className="text-[12px] text-preview">Added “{state.done}”. Write another, or close.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button disabled={state.busy} onClick={() => void generate()}>
              {state.busy ? <Loader2 className="animate-spin" /> : <Wand2 />} {state.busy ? "Generating…" : "Generate and add"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
