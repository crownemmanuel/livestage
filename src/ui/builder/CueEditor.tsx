import { useEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";
import { ArrowDown, ArrowRightLeft, ArrowUp, Clapperboard, Copy, CornerDownRight, Megaphone, Timer as TimerIcon, Crop, Eye, Footprints, Gauge, Image, LampCeiling, Layers, Lightbulb, ListOrdered, MapPin, MessageSquareText, PawPrint, Play, Plus, Power, Radio, Route, SlidersHorizontal, SlidersVertical, Snowflake, Sparkles, Sun, Timer, Trash2, Users, Video, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { makeCue, defaultTransition } from "@/core/factories";
import { uid } from "@/core/ids";
import { LION_ACTION_INFO } from "@/core/lion";
import { LION_ACTIONS } from "@/core/types";
import type { Cue, CueAction, CueActionType, IoMessage, Scene, SceneComponent } from "@/core/types";
import { EFFECT_DEFS } from "@/core/effects";
import { runCue } from "@/engine/operator";
import { sceneNow } from "@/core/clock";
import { evalFraming } from "@/core/runtime";
import { useShow } from "@/store/show";

function currentPreviewFraming() {
  const rt = useShow.getState().preview;
  const f = rt ? evalFraming(rt.framing, sceneNow(rt)) : { zoom: 1, x: 0.5, y: 0.5 };
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { zoom: r(f.zoom), x: r(f.x), y: r(f.y) };
}
import { useProject, NO_ITEMS } from "@/store/project";
import { Switch } from "@/components/ui/switch";
import { NumberInput, SelectBox } from "../fields";
import { InfoTip } from "../kit";
import { TRANSITIONS } from "../show/ShowMode";
import { MessageFields, defaultMessage } from "../io/MessageFields";
import { useSceneCodes } from "../SceneList";
import { AssetPickerButton } from "./AssetLibrary";
import { audioRoleOf } from "@/engine/mixer";
import { FireField } from "./FireField";
import { flowNext } from "@/core/groups";
import { formatClock } from "@/core/timers";

/**
 * "hog", "stagelight" and "soundApp" are Send actions preset to a Hog 4, StageLight or StageMics
 * message; they get their own menu entries because they are the common cases.
 */
export type MenuType = CueActionType | "hog" | "stagelight" | "soundApp";

/** Menu entries that are a Send action with a preset message, and the message type they start with. */
export const SEND_PRESETS: Partial<Record<MenuType, IoMessage["type"]>> = { hog: "hog", stagelight: "stagelight", soundApp: "sound" };

export const ACTION_INFO: Record<MenuType, { label: string; icon: ReactNode }> = {
  hog: { label: "Lighting (Hog 4)", icon: <Lightbulb className="text-armed" /> },
  stagelight: { label: "StageLight", icon: <LampCeiling className="text-armed" /> },
  soundApp: { label: "StageMics (dLive)", icon: <SlidersVertical className="text-preview" /> },
  send: { label: "MIDI / OSC", icon: <Radio /> },
  blackout: { label: "Blackout / lights up", icon: <Power /> },
  sound: { label: "Play sound", icon: <Volume2 /> },
  "audio.fade": { label: "Fade out audio", icon: <VolumeX /> },
  announce: { label: "Announcement", icon: <Megaphone /> },
  timer: { label: "Show timer", icon: <TimerIcon /> },
  clip: { label: "Video clip", icon: <Clapperboard /> },
  layer: { label: "Layer / title", icon: <Layers /> },
  background: { label: "Background", icon: <Image /> },
  effect: { label: "Effect", icon: <Sparkles /> },
  "effect.param": { label: "Effect setting", icon: <SlidersHorizontal /> },
  "media.speed": { label: "Video speed", icon: <Gauge /> },
  timeOfDay: { label: "Time of day", icon: <Sun /> },
  names: { label: "Family tree", icon: <Users /> },
  route: { label: "Map route", icon: <Route /> },
  camera: { label: "Camera move", icon: <Video /> },
  framing: { label: "Framing", icon: <Crop /> },
  takeScene: { label: "Take scene", icon: <ArrowRightLeft /> },
  clock: { label: "Freeze / resume", icon: <Snowflake /> },
  lion: { label: "Lion action", icon: <PawPrint /> },
  "lion.moveTo": { label: "Lion walk / run", icon: <Footprints /> },
  "lion.place": { label: "Lion place", icon: <MapPin /> },
  "actor.visible": { label: "Lion show / hide", icon: <Eye /> },
};

export const MENU: { group: string; types: MenuType[] }[] = [
  { group: "Lighting & sound", types: ["hog", "stagelight", "soundApp", "blackout", "sound", "audio.fade", "announce", "send"] },
  { group: "Picture", types: ["clip", "layer", "background", "effect", "effect.param", "media.speed", "timeOfDay", "names", "route"] },
  { group: "Camera", types: ["camera", "framing"] },
  { group: "Show", types: ["takeScene", "timer", "clock"] },
  { group: "Lion", types: ["lion", "lion.moveTo", "lion.place", "actor.visible"] },
];

const infoFor = (a: CueAction) => ACTION_INFO[a.type === "send" ? sendMenuType(a.message) : a.type];
const sendMenuType = (m: IoMessage): MenuType => (m.type === "hog" || m.type === "stagelight" ? m.type : m.type === "sound" ? "soundApp" : "send");

const LAYER_KINDS = ["video", "image", "model", "procedural", "text", "names", "route"];

/**
 * Audio a sound cue can fade out as it starts (mixer keys): this scene's other cue sounds, music from other
 * scenes that keeps playing into the next scene (it may still be on when this cue fires), and this scene's
 * videos with sound on.
 */
function otherAudio(scene: Scene, ownAssetId: string | null): { key: string; label: string }[] {
  const assets = useShow.getState().assets;
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (assetId: string, from?: string) => {
    seen.add(assetId);
    out.push({ key: `sound:${assetId}`, label: `♪ ${assets.find((s) => s.id === assetId)?.name ?? assetId}${from ? ` (from ${from})` : ""}` });
  };
  for (const cue of scene.cues)
    for (const x of cue.actions) if (x.type === "sound" && x.assetId && x.assetId !== ownAssetId && !seen.has(x.assetId)) add(x.assetId);
  for (const other of useProject.getState().project.scenes) {
    if (other.id === scene.id) continue;
    for (const cue of other.cues)
      for (const x of cue.actions) if (x.type === "sound" && x.keepPlaying && x.assetId && x.assetId !== ownAssetId && !seen.has(x.assetId)) add(x.assetId, other.name);
  }
  for (const c of scene.components) {
    const sound = c.kind === "clipActor" ? !c.muted : (c.kind === "video" || c.kind === "background") && "media" in c && !c.media.muted;
    if (sound) out.push({ key: c.id, label: `▶ ${c.name}` });
  }
  return out;
}

export function defaultAction(type: CueActionType, scene: Scene, scenes: Scene[]): CueAction {
  const actor = scene.components.find((c) => c.kind === "actor")?.id ?? "";
  const marker = Object.keys(scene.markers)[0] ?? "center";
  switch (type) {
    case "lion":
      return { type, actorId: actor, action: "roar", delay: 0 };
    case "lion.moveTo":
      return { type, actorId: actor, marker, gait: "walk", delay: 0 };
    case "lion.place":
      return { type, actorId: actor, marker, heading: Math.PI, delay: 0 };
    case "actor.visible":
      return { type, actorId: actor, visible: true, delay: 0 };
    case "effect":
      return { type, effectId: scene.components.find((c) => c.kind === "effect")?.id ?? "", op: "start", delay: 0 };
    case "background":
      return { type, backgroundId: scene.components.find((c) => c.kind === "background")?.id ?? "", delay: 0 };
    case "layer":
      return { type, layerId: scene.components.find((c) => LAYER_KINDS.includes(c.kind))?.id ?? "", op: "show", delay: 0 };
    case "camera":
      return { type, shotId: scene.cameraShots[0]?.id ?? "", delay: 0 };
    case "timeOfDay":
      return { type, value: 1, duration: 8, delay: 0 };
    case "takeScene":
      return { type, sceneId: scenes.find((s) => s.id !== scene.id)?.id ?? scene.id, transition: null, delay: 0 };
    case "blackout":
      return { type, on: true, fade: 0.4, delay: 0 };
    case "clip": {
      const va = scene.components.find((c) => c.kind === "clipActor");
      return { type, actorId: va?.id ?? "", clipId: va?.kind === "clipActor" ? (va.clips[0]?.id ?? null) : null, delay: 0 };
    }
    case "clock":
      return { type, op: "toggle", delay: 0 };
    case "sound":
      return { type, assetId: null, volume: 1, delay: 0, keepPlaying: false, loop: false, fadeOthers: null };
    case "audio.fade":
      return { type, which: [], fade: 2, delay: 0 };
    case "send":
      return { type, message: defaultMessage("osc"), delay: 0 };
    case "timer":
      return { type, timerId: useProject.getState().project.timers?.[0]?.id ?? "", op: "restart", delay: 0 };
    case "announce":
      return { type, announcementId: useProject.getState().project.announcements?.[0]?.id ?? "", delay: 0 };
    case "names":
      return { type, layerId: scene.components.find((c) => c.kind === "names")?.id ?? "", op: "next", value: 0, duration: 6, delay: 0 };
    case "route":
      return { type, layerId: scene.components.find((c) => c.kind === "route")?.id ?? "", op: "play", delay: 0 };
    case "media.speed":
      return { type, layerId: scene.components.find((c) => c.kind === "video" || (c.kind === "background" && c.source === "media"))?.id ?? "", rate: 4, duration: 2, delay: 0 };
    case "framing": {
      const f = currentPreviewFraming();
      return { type, ...f, duration: 4, delay: 0 };
    }
    case "effect.param": {
      const fx = scene.components.find((c): c is Extract<SceneComponent, { kind: "effect" }> => c.kind === "effect");
      const spec = fx ? EFFECT_DEFS[fx.effect].params.find((p) => p.type === "range" || p.type === "color" || p.type === "bool") : undefined;
      return { type, effectId: fx?.id ?? "", key: spec?.key ?? "", value: spec ? (EFFECT_DEFS[fx!.effect].defaults[spec.key] ?? 0) : 0, delay: 0 };
    }
  }
}

export function newAction(t: MenuType, scene: Scene, scenes: Scene[]): CueAction {
  const preset = SEND_PRESETS[t];
  return preset ? { type: "send", message: defaultMessage(preset), delay: 0 } : defaultAction(t as CueActionType, scene, scenes);
}

function AddActionMenu({ onAdd }: { onAdd: (t: MenuType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="h-6 text-muted-foreground hover:text-foreground">
          <Plus /> Add action
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-[210px] overflow-y-auto">
        {MENU.map((g, gi) => (
          <DropdownMenuGroup key={g.group}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10.5px] font-medium text-muted-foreground">{g.group}</DropdownMenuLabel>
            {g.types.map((t) => (
              <DropdownMenuItem key={t} className="text-[12px] [&_svg]:size-3.5" onSelect={() => onAdd(t)}>
                {ACTION_INFO[t].icon} {ACTION_INFO[t].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A cue (and one of its actions) to bring into view in the run sheet, e.g. clicked on the timeline. */
export const useCueFocus = create<{ cueId: string | null; action: number | null; nonce: number }>(() => ({ cueId: null, action: null, nonce: 0 }));

export function focusCue(cueId: string, action: number | null = null) {
  useCueFocus.setState((s) => ({ cueId, action, nonce: s.nonce + 1 }));
}

export function CueEditor({ scene }: { scene: Scene }) {
  const scenes = useProject((s) => s.project.scenes);
  const focus = useCueFocus();
  const root = useRef<HTMLDivElement>(null);
  // Scroll the focused cue (its action, when one is named) into view; the highlight fades by itself.
  useEffect(() => {
    if (!focus.cueId || !root.current) return;
    const card = root.current.querySelector<HTMLElement>(`[data-cue-id="${focus.cueId}"]`);
    const el = (focus.action != null && card?.querySelector<HTMLElement>(`[data-action="${focus.action}"]`)) || card;
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const h = setTimeout(() => useCueFocus.setState({ cueId: null, action: null }), 1800);
    return () => clearTimeout(h);
  }, [focus.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const up = (fn: (s: Scene) => void) => useProject.getState().updateScene(scene.id, fn);
  const upCue = (id: string, fn: (c: Cue) => void) =>
    up((s) => {
      const c = s.cues.find((x) => x.id === id);
      if (c) fn(c);
    });
  const addCue = () => up((s) => s.cues.push(makeCue(`Cue ${s.cues.length + 1}`)));

  return (
    <div ref={root} className="space-y-2.5 p-3">
      <div className="flex items-center gap-1.5">
        <ListOrdered className="size-3.5 text-muted-foreground" />
        <h3 className="text-[12.5px] font-semibold">Run sheet</h3>
        <InfoTip>The steps of this scene, in order. Each GO fires the next one; a step can also fire on its own at a scene time, a few seconds after the step before it, or when a video reaches a time. A step runs all its actions at once; an action's delay (⏱) spaces them out. The note is shown to the operator: the line to GO on.</InfoTip>
        <Button size="xs" variant="outline" className="ml-auto" onClick={addCue}>
          <Plus /> Add cue
        </Button>
      </div>
      {scene.cues.length === 0 && (
        <button type="button" onClick={addCue} className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-border py-8 text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground">
          <Plus className="size-4" />
          No cues yet. Add one to fire video, lights and sound on GO.
        </button>
      )}
      {scene.cues.map((cue, i) => (
        <div key={cue.id} data-cue-id={cue.id} className={cn("group/cue overflow-hidden rounded-lg border border-border bg-card/50 shadow-sm transition-shadow", focus.cueId === cue.id && focus.action == null && "ring-2 ring-preview/70")}>
          <div className="flex items-center gap-2 px-2.5 pt-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-[11.5px] font-semibold tabular">{i + 1}</span>
            <input
              className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium hover:border-input focus:border-input"
              defaultValue={cue.name}
              key={cue.id + cue.name}
              onBlur={(e) => e.target.value !== cue.name && upCue(cue.id, (c) => (c.name = e.target.value))}
            />
            <div className="flex items-center opacity-0 transition-opacity group-focus-within/cue:opacity-100 group-hover/cue:opacity-100">
              <Button size="icon-xs" variant="ghost" title="Duplicate cue" onClick={() => up((s) => s.cues.splice(i + 1, 0, { ...structuredClone(cue), id: uid("cue"), name: `${cue.name} copy` }))} aria-label="Duplicate cue">
                <Copy />
              </Button>
              <Button size="icon-xs" variant="ghost" title="Move up" disabled={i === 0} onClick={() => up((s) => ([s.cues[i - 1], s.cues[i]] = [s.cues[i], s.cues[i - 1]]))} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button size="icon-xs" variant="ghost" title="Move down" disabled={i === scene.cues.length - 1} onClick={() => up((s) => ([s.cues[i + 1], s.cues[i]] = [s.cues[i], s.cues[i + 1]]))} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button size="icon-xs" variant="ghost" title="Delete cue" className="hover:text-destructive" onClick={() => up((s) => (s.cues = s.cues.filter((c) => c.id !== cue.id)))} aria-label="Delete cue">
                <Trash2 />
              </Button>
            </div>
            <Button size="xs" variant="secondary" title="Run this cue in the preview (and send its lighting / MIDI / OSC)" onClick={() => runCue("preview", cue)}>
              <Play /> Test
            </Button>
          </div>
          <div className="mx-2.5 mt-1 px-1">
            <FireField scene={scene} cue={cue} index={i} />
          </div>
          <label className="mx-2.5 mt-1 flex items-center gap-1.5 rounded-md px-1 text-amber-200/80">
            <MessageSquareText className="size-3.5 shrink-0 opacity-70" />
            <input
              className="h-6 min-w-0 flex-1 bg-transparent text-[11.5px] placeholder:text-muted-foreground/50 focus:outline-none"
              placeholder="Operator note: the line or moment to GO on…"
              defaultValue={cue.notes}
              key={cue.id + cue.notes}
              onBlur={(e) => e.target.value !== cue.notes && upCue(cue.id, (c) => (c.notes = e.target.value))}
            />
          </label>
          <div className="mt-1.5 space-y-px border-t border-border/70 bg-black/10 px-1.5 py-1.5">
            {cue.actions.map((a, j) => (
              <div key={j} data-action={j} className={cn("rounded transition-shadow", focus.cueId === cue.id && focus.action === j && "ring-2 ring-preview/70")}>
                <ActionRow
                  a={a}
                  scene={scene}
                  scenes={scenes}
                  onChange={(na) => upCue(cue.id, (c) => (c.actions[j] = na))}
                  onRemove={() => upCue(cue.id, (c) => c.actions.splice(j, 1))}
                />
              </div>
            ))}
            <AddActionMenu onAdd={(t) => upCue(cue.id, (c) => c.actions.push(newAction(t, scene, scenes)))} />
          </div>
        </div>
      ))}
      {scene.cues.length > 0 && <AfterLastStep scene={scene} />}
    </div>
  );
}

/** What GO does after the last step: take the next scene of a flowing group, or nothing. */
function AfterLastStep({ scene }: { scene: Scene }) {
  const project = useProject((s) => s.project);
  const codes = useSceneCodes();
  const next = flowNext(project, scene.id);
  return (
    <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground">
      <CornerDownRight className="size-3.5" />
      {next ? (
        <>
          Then GO takes <span className="font-key font-semibold text-foreground/80">{codes.get(next.id)}</span> <span className="text-foreground/80">{next.name}</span>
        </>
      ) : (
        "End of the scene: the next scene is taken by hand (or put the scenes in a group)."
      )}
    </p>
  );
}

export function ActionRow({ a, scene, scenes, onChange, onRemove }: { a: CueAction; scene: Scene; scenes: Scene[]; onChange: (a: CueAction) => void; onRemove: () => void }) {
  const timers = useProject((s) => s.project.timers ?? NO_ITEMS);
  const announcements = useProject((s) => s.project.announcements ?? NO_ITEMS);
  const opt = (kinds: string[]) => scene.components.filter((c) => kinds.includes(c.kind)).map((c) => ({ value: c.id, label: c.name }));
  const markers = Object.keys(scene.markers).map((m) => ({ value: m, label: m }));
  const sel = (value: string, options: { value: string; label: string }[], set: (v: string) => void, w = "w-[130px]") => (
    <SelectBox className={`h-6 ${w} text-[11px]`} value={options.some((o) => o.value === value) ? value : "__missing__"} onChange={set} options={options.some((o) => o.value === value) ? options : [{ value: "__missing__", label: "— choose —" }, ...options]} />
  );
  const lbl = (s: string) => <span className="text-muted-foreground">{s}</span>;
  let body: React.ReactNode = null;
  switch (a.type) {
    case "lion":
      body = (
        <>
          {sel(a.actorId, opt(["actor"]), (v) => onChange({ ...a, actorId: v }))}
          {sel(a.action, LION_ACTIONS.filter((x) => x !== "turn").map((x) => ({ value: x, label: LION_ACTION_INFO[x].label })), (v) => onChange({ ...a, action: v as typeof a.action }), "w-[110px]")}
        </>
      );
      break;
    case "lion.moveTo":
      body = (
        <>
          {sel(a.actorId, opt(["actor"]), (v) => onChange({ ...a, actorId: v }))}
          {sel(a.gait, [{ value: "walk", label: "walk" }, { value: "run", label: "run" }], (v) => onChange({ ...a, gait: v as "walk" | "run" }), "w-[70px]")}
          {lbl("to")}
          {sel(a.marker, markers, (v) => onChange({ ...a, marker: v }), "w-[100px]")}
        </>
      );
      break;
    case "lion.place":
      body = (
        <>
          {sel(a.actorId, opt(["actor"]), (v) => onChange({ ...a, actorId: v }))}
          {lbl("at")}
          {sel(a.marker, markers, (v) => onChange({ ...a, marker: v }), "w-[100px]")}
          {lbl("facing°")}
          <NumberInput className="h-6 w-16" value={Math.round((a.heading * 180) / Math.PI)} step={5} onChange={(v) => onChange({ ...a, heading: (v * Math.PI) / 180 })} />
        </>
      );
      break;
    case "actor.visible":
      body = (
        <>
          {sel(a.actorId, opt(["actor"]), (v) => onChange({ ...a, actorId: v }))}
          {sel(a.visible ? "show" : "hide", [{ value: "show", label: "show" }, { value: "hide", label: "hide" }], (v) => onChange({ ...a, visible: v === "show" }), "w-[80px]")}
        </>
      );
      break;
    case "effect":
      body = (
        <>
          {sel(a.effectId, opt(["effect"]), (v) => onChange({ ...a, effectId: v }))}
          {sel(a.op, ["start", "stop", "toggle", "trigger"].map((x) => ({ value: x, label: x })), (v) => onChange({ ...a, op: v as typeof a.op }), "w-[90px]")}
        </>
      );
      break;
    case "effect.param": {
      const fx = scene.components.find((c): c is Extract<SceneComponent, { kind: "effect" }> => c.kind === "effect" && c.id === a.effectId);
      const specs = fx ? EFFECT_DEFS[fx.effect].params.filter((p) => p.type !== "asset") : [];
      const spec = specs.find((p) => p.key === a.key);
      body = (
        <>
          {sel(a.effectId, opt(["effect"]), (v) => {
            const nfx = scene.components.find((c): c is Extract<SceneComponent, { kind: "effect" }> => c.id === v && c.kind === "effect");
            const first = nfx ? EFFECT_DEFS[nfx.effect].params.find((p) => p.type !== "asset") : undefined;
            onChange({ ...a, effectId: v, key: first?.key ?? "", value: nfx && first ? (EFFECT_DEFS[nfx.effect].defaults[first.key] ?? 0) : 0 });
          })}
          {sel(a.key, specs.map((p) => ({ value: p.key, label: p.label })), (v) => onChange({ ...a, key: v, value: fx ? (EFFECT_DEFS[fx.effect].defaults[v] ?? 0) : 0 }), "w-[150px]")}
          {lbl("=")}
          {spec?.type === "range" && <NumberInput className="h-6 w-16" value={typeof a.value === "number" ? a.value : 0} min={spec.min} max={spec.max} step={spec.step} onChange={(v) => onChange({ ...a, value: v })} />}
          {spec?.type === "color" && <input type="color" className="h-6 w-9 rounded border border-input bg-transparent" value={typeof a.value === "string" ? a.value : "#ffffff"} onChange={(e) => onChange({ ...a, value: e.target.value })} />}
          {spec?.type === "bool" && sel(String(!!a.value), [{ value: "true", label: "on" }, { value: "false", label: "off" }], (v) => onChange({ ...a, value: v === "true" }), "w-[70px]")}
        </>
      );
      break;
    }
    case "background":
      body = sel(a.backgroundId, opt(["background"]), (v) => onChange({ ...a, backgroundId: v }), "w-[160px]");
      break;
    case "layer":
      body = (
        <>
          {sel(a.layerId, opt(LAYER_KINDS), (v) => onChange({ ...a, layerId: v }), "w-[150px]")}
          {sel(a.op, ["show", "hide", "toggle", "restart"].map((x) => ({ value: x, label: x })), (v) => onChange({ ...a, op: v as typeof a.op }), "w-[90px]")}
        </>
      );
      break;
    case "framing":
      body = (
        <>
          {lbl("zoom")}
          <NumberInput className="h-6 w-14" value={a.zoom} min={1} max={6} step={0.05} onChange={(v) => onChange({ ...a, zoom: v })} />
          {lbl("x")}
          <NumberInput className="h-6 w-14" value={a.x} min={0} max={1} step={0.01} onChange={(v) => onChange({ ...a, x: v })} />
          {lbl("y")}
          <NumberInput className="h-6 w-14" value={a.y} min={0} max={1} step={0.01} onChange={(v) => onChange({ ...a, y: v })} />
          {lbl("over")}
          <NumberInput className="h-6 w-14" value={a.duration} min={0} step={0.5} onChange={(v) => onChange({ ...a, duration: v })} />
          {lbl("s")}
          <Button size="xs" variant="outline" className="h-6" title="Copy the preview monitor's current framing" onClick={() => onChange({ ...a, ...currentPreviewFraming() })}>
            From preview
          </Button>
        </>
      );
      break;
    case "camera":
      body = sel(a.shotId, scene.cameraShots.map((s) => ({ value: s.id, label: s.name })), (v) => onChange({ ...a, shotId: v }), "w-[160px]");
      break;
    case "timeOfDay":
      body = (
        <>
          {lbl("to")}
          <NumberInput className="h-6 w-14" value={a.value} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...a, value: v })} />
          {lbl("over")}
          <NumberInput className="h-6 w-14" value={a.duration} min={0} step={1} onChange={(v) => onChange({ ...a, duration: v })} />
          {lbl("s")}
        </>
      );
      break;
    case "clip": {
      const va = scene.components.find((c) => c.id === a.actorId);
      const clips = va?.kind === "clipActor" ? va.clips : [];
      body = (
        <>
          {sel(a.actorId, opt(["clipActor"]), (v) => onChange({ ...a, actorId: v }))}
          {sel(a.clipId ?? "__clear__", [...clips.map((c) => ({ value: c.id, label: `${c.name} (${c.startPose}→${c.endPose})` })), { value: "__clear__", label: "clear (remove actor)" }], (v) => onChange({ ...a, clipId: v === "__clear__" ? null : v }), "w-[200px]")}
        </>
      );
      break;
    }
    case "blackout":
      body = (
        <>
          {sel(a.on ? "on" : "off", [{ value: "on", label: "blackout" }, { value: "off", label: "lights up" }], (v) => onChange({ ...a, on: v === "on" }), "w-[110px]")}
          {lbl("fade")}
          <NumberInput className="h-6 w-14" value={a.fade} min={0} step={0.1} onChange={(v) => onChange({ ...a, fade: v })} />
          {lbl("s")}
        </>
      );
      break;
    case "clock":
      body = sel(a.op, [{ value: "pause", label: "freeze everything" }, { value: "resume", label: "resume" }, { value: "toggle", label: "toggle" }], (v) => onChange({ ...a, op: v as typeof a.op }), "w-[150px]");
      break;
    case "sound":
      body = (
        <>
          <AssetPickerButton
            types={["audio"]}
            value={a.assetId}
            onChange={(v) => {
              inheritSoundRole(a.assetId, v);
              onChange({ ...a, assetId: v });
            }}
            placeholder="Choose a sound…" title="Choose a sound" className="h-6 w-[220px] text-[11px]" />
          {lbl("vol")}
          <NumberInput className="h-6 w-14" value={a.volume} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...a, volume: v })} />
          <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground" title="Off: the sound fades out when another scene is taken. On: it carries on into the next scene.">
            <Switch size="sm" checked={!!a.keepPlaying} onCheckedChange={(v) => onChange({ ...a, keepPlaying: v })} />
            keep playing into next scene
          </label>
          <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground" title="Start again from the top when it ends, until a cue or a scene fades it out (a music bed).">
            <Switch size="sm" checked={!!a.loop} onCheckedChange={(v) => onChange({ ...a, loop: v })} />
            loop
          </label>
          {lbl("fade in s")}
          <NumberInput className="h-6 w-12" value={a.fadeIn ?? 0} min={0} step={0.5} onChange={(v) => onChange({ ...a, fadeIn: Math.max(0, v) })} />
          {lbl("as it starts")}
          {sel(
            !a.fadeOthers ? "keep" : a.fadeOthers.which === "all" ? "all" : "chosen",
            [
              { value: "keep", label: "leave other audio" },
              { value: "all", label: "fade out all other audio" },
              { value: "chosen", label: "fade out chosen audio…" },
            ],
            (v) => onChange({ ...a, fadeOthers: v === "keep" ? null : { which: v === "all" ? "all" : Array.isArray(a.fadeOthers?.which) ? a.fadeOthers.which : [], fade: a.fadeOthers?.fade ?? 3 } }),
            "w-[170px]",
          )}
          {a.fadeOthers && (
            <>
              {lbl("over s")}
              <NumberInput className="h-6 w-12" value={a.fadeOthers.fade} min={0} step={0.5} onChange={(v) => onChange({ ...a, fadeOthers: { ...a.fadeOthers!, fade: Math.max(0, v) } })} />
              {lbl("after s")}
              <NumberInput className="h-6 w-12" value={a.fadeOthers.delay ?? 0} min={0} step={0.5} onChange={(v) => onChange({ ...a, fadeOthers: { ...a.fadeOthers!, delay: Math.max(0, v) } })} />
            </>
          )}
          {a.fadeOthers && a.fadeOthers.which !== "all" && (
            <div className="flex w-full flex-wrap items-center gap-1">
              {lbl("fade:")}
              {otherAudio(scene, a.assetId).map((o) => {
                const which = a.fadeOthers!.which as string[];
                const on = which.includes(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={cn("rounded border px-1.5 py-0.5 text-[10.5px]", on ? "border-live/60 bg-live/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                    onClick={() => onChange({ ...a, fadeOthers: { ...a.fadeOthers!, which: on ? which.filter((k) => k !== o.key) : [...which, o.key] } })}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
        </>
      );
      break;
    case "audio.fade": {
      const which = a.which;
      body = (
        <>
          {sel(which === "all" ? "all" : "chosen", [{ value: "chosen", label: "chosen audio…" }, { value: "all", label: "all audio" }], (v) => onChange({ ...a, which: v === "all" ? "all" : [] }), "w-[130px]")}
          {lbl("over s")}
          <NumberInput className="h-6 w-12" value={a.fade} min={0} step={0.5} onChange={(v) => onChange({ ...a, fade: Math.max(0, v) })} />
          {which !== "all" && (
            <div className="flex w-full flex-wrap items-center gap-1">
              {lbl("fade:")}
              {otherAudio(scene, null).map((o) => {
                const on = which.includes(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={cn("rounded border px-1.5 py-0.5 text-[10.5px]", on ? "border-live/60 bg-live/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                    onClick={() => onChange({ ...a, which: on ? which.filter((k) => k !== o.key) : [...which, o.key] })}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
        </>
      );
      break;
    }
    case "send":
      body = <MessageFields roomy hideType={sendMenuType(a.message) !== "send"} m={a.message} onChange={(message) => onChange({ ...a, message })} />;
      break;
    case "timer":
      body = (
        <>
          {sel(a.op, [{ value: "restart", label: "start from the top" }, { value: "start", label: "start / resume" }, { value: "pause", label: "pause" }, { value: "reset", label: "reset (stopped)" }], (v) => onChange({ ...a, op: v as typeof a.op }), "w-[150px]")}
          {sel(a.timerId, timers.map((t) => ({ value: t.id, label: `${t.name} (${formatClock(t.duration)})` })), (v) => onChange({ ...a, timerId: v }), "w-[170px]")}
        </>
      );
      break;
    case "announce":
      body = announcements.length ? sel(a.announcementId, announcements.map((x) => ({ value: x.id, label: x.name })), (v) => onChange({ ...a, announcementId: v }), "w-[200px]") : <span className="text-muted-foreground">Add announcements under Quick actions → Announce first.</span>;
      break;
    case "names":
      body = (
        <>
          {sel(a.layerId, opt(["names"]), (v) => onChange({ ...a, layerId: v }), "w-[150px]")}
          {sel(
            a.op,
            [
              { value: "next", label: "next name" },
              { value: "prev", label: "previous name" },
              { value: "set", label: "show first N" },
              { value: "all", label: "show all" },
              { value: "reset", label: "reset (empty)" },
              { value: "burn", label: "burn (Babylon)" },
              { value: "restore", label: "un-burn" },
              { value: "bloom", label: "bloom (blossom)" },
            ],
            (v) => onChange({ ...a, op: v as typeof a.op }),
            "w-[140px]",
          )}
          {a.op === "set" && <NumberInput className="h-6 w-14" value={a.value} min={0} step={1} onChange={(v) => onChange({ ...a, value: Math.round(v) })} />}
          {(a.op === "burn" || a.op === "restore" || a.op === "bloom") && (
            <>
              {lbl("over")}
              <NumberInput className="h-6 w-14" value={a.duration} min={0} step={0.5} onChange={(v) => onChange({ ...a, duration: v })} />
              {lbl("s")}
            </>
          )}
        </>
      );
      break;
    case "route":
      body = (
        <>
          {sel(a.layerId, opt(["route"]), (v) => onChange({ ...a, layerId: v }), "w-[150px]")}
          {sel(a.op, [{ value: "play", label: "draw the route" }, { value: "reset", label: "reset" }, { value: "complete", label: "jump to the end" }], (v) => onChange({ ...a, op: v as typeof a.op }), "w-[140px]")}
        </>
      );
      break;
    case "media.speed":
      body = (
        <>
          {sel(a.layerId, scene.components.filter((c) => c.kind === "video" || (c.kind === "background" && c.source === "media")).map((c) => ({ value: c.id, label: c.name })), (v) => onChange({ ...a, layerId: v }), "w-[160px]")}
          {lbl("to")}
          <NumberInput className="h-6 w-14" value={a.rate} min={-8} max={16} step={0.25} onChange={(v) => onChange({ ...a, rate: v })} />
          {lbl("× over")}
          <NumberInput className="h-6 w-14" value={a.duration} min={0} step={0.5} onChange={(v) => onChange({ ...a, duration: v })} />
          {lbl("s")}
        </>
      );
      break;
    case "takeScene":
      body = (
        <>
          {sel(a.sceneId, scenes.map((s) => ({ value: s.id, label: `${s.number}. ${s.name}` })), (v) => onChange({ ...a, sceneId: v }), "w-[170px]")}
          {sel(a.transition?.kind ?? "__default__", [{ value: "__default__", label: "scene default" }, ...TRANSITIONS], (v) => onChange({ ...a, transition: v === "__default__" ? null : { ...(a.transition ?? defaultTransition()), kind: v as never } }), "w-[120px]")}
          {a.transition && a.transition.kind !== "cut" && a.transition.kind !== "video" && (
            <NumberInput className="h-6 w-14" value={a.transition.duration} min={0} step={0.5} onChange={(v) => onChange({ ...a, transition: { ...a.transition!, duration: v } })} />
          )}
        </>
      );
      break;
  }
  const info = infoFor(a);
  const delay = (
    <label className={cn("flex h-6 shrink-0 items-center gap-0.5", a.delay > 0 ? "text-armed" : "text-muted-foreground/60")} title="Delay after GO (seconds)">
      <Timer className="size-3.5" />
      <NumberInput className="h-6 w-12 px-1 text-[11px]" value={a.delay} min={0} step={0.5} onChange={(v) => onChange({ ...a, delay: v })} />
      <span>s</span>
    </label>
  );
  // Lighting / MIDI / OSC has the most fields: its own roomy card, like a clip's time markers.
  if (a.type === "send")
    return (
      <div className="my-1 space-y-3 rounded-xl border border-border/70 bg-black/20 p-3">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium [&_svg]:size-4 [&_svg]:shrink-0" title={info.label}>
            {info.icon}
            <span className="truncate">{info.label}</span>
          </span>
          <span className="ml-auto" />
          {delay}
          <Button size="icon-sm" variant="ghost" className="rounded-lg text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label="Remove action" title="Remove action">
            <X />
          </Button>
        </div>
        {body}
      </div>
    );
  return (
    <div className="group/action flex items-start gap-2 rounded-md px-1 py-1 text-[11px] hover:bg-accent/40">
      <span className="flex h-6 w-[112px] shrink-0 items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0" title={info.label}>
        {info.icon}
        <span className="truncate">{info.label}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{body}</div>
      {delay}
      <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover/action:opacity-100 hover:text-destructive focus-visible:opacity-100" onClick={onRemove} aria-label="Remove action" title="Remove action">
        <X />
      </Button>
    </div>
  );
}

/**
 * A sound swapped into a cue takes the role of the one it replaces (music, voice, ambience, effect: its track on the
 * timeline and its group in the mixer), unless the new file already has a role of its own.
 */
function inheritSoundRole(from: string | null, to: string | null) {
  if (!from || !to || from === to) return;
  const st = useProject.getState();
  const role = audioRoleOf(st.project.assets.find((x) => x.id === from));
  const next = st.project.assets.find((x) => x.id === to);
  if (!role || !next || next.audioRole) return;
  st.update((p) => {
    const n = p.assets.find((x) => x.id === to);
    if (n) n.audioRole = role;
  });
}
