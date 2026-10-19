import type { ReactNode } from "react";
import { ArrowDown, ArrowRightLeft, ArrowUp, Clapperboard, Copy, Crop, Eye, Footprints, Gauge, Image, Layers, Lightbulb, ListOrdered, MapPin, MessageSquareText, PawPrint, Play, Plus, Power, Radio, Route, SlidersHorizontal, Snowflake, Sparkles, Sun, Timer, Trash2, Users, Video, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { makeCue, defaultTransition } from "@/core/factories";
import { uid } from "@/core/ids";
import { LION_ACTION_INFO } from "@/core/lion";
import { LION_ACTIONS } from "@/core/types";
import type { Cue, CueAction, CueActionType, Scene, SceneComponent } from "@/core/types";
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
import { useProject } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";
import { InfoTip } from "../kit";
import { TRANSITIONS } from "../show/ShowMode";
import { MessageFields, defaultMessage } from "../io/MessageFields";

/** "hog" is a Send action preset to a Hog 4 message; it gets its own menu entry because it is the common case. */
type MenuType = CueActionType | "hog";

const ACTION_INFO: Record<MenuType, { label: string; icon: ReactNode }> = {
  hog: { label: "Lighting (Hog 4)", icon: <Lightbulb className="text-armed" /> },
  send: { label: "MIDI / OSC", icon: <Radio /> },
  blackout: { label: "Blackout / lights up", icon: <Power /> },
  sound: { label: "Play sound", icon: <Volume2 /> },
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

const MENU: { group: string; types: MenuType[] }[] = [
  { group: "Lighting & sound", types: ["hog", "blackout", "sound", "send"] },
  { group: "Picture", types: ["clip", "layer", "background", "effect", "effect.param", "media.speed", "timeOfDay", "names", "route"] },
  { group: "Camera", types: ["camera", "framing"] },
  { group: "Show", types: ["takeScene", "clock"] },
  { group: "Lion", types: ["lion", "lion.moveTo", "lion.place", "actor.visible"] },
];

const infoFor = (a: CueAction) => ACTION_INFO[a.type === "send" && a.message.type === "hog" ? "hog" : a.type];

const LAYER_KINDS = ["video", "image", "model", "procedural", "text", "names", "route"];

function defaultAction(type: CueActionType, scene: Scene, scenes: Scene[]): CueAction {
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
      return { type, assetId: null, volume: 1, delay: 0 };
    case "send":
      return { type, message: defaultMessage("osc"), delay: 0 };
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

function newAction(t: MenuType, scene: Scene, scenes: Scene[]): CueAction {
  return t === "hog" ? { type: "send", message: defaultMessage("hog"), delay: 0 } : defaultAction(t, scene, scenes);
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

export function CueEditor({ scene }: { scene: Scene }) {
  const scenes = useProject((s) => s.project.scenes);
  const up = (fn: (s: Scene) => void) => useProject.getState().updateScene(scene.id, fn);
  const upCue = (id: string, fn: (c: Cue) => void) =>
    up((s) => {
      const c = s.cues.find((x) => x.id === id);
      if (c) fn(c);
    });
  const addCue = () => up((s) => s.cues.push(makeCue(`Cue ${s.cues.length + 1}`)));

  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center gap-1.5">
        <ListOrdered className="size-3.5 text-muted-foreground" />
        <h3 className="text-[12.5px] font-semibold">Cues</h3>
        <InfoTip>Each GO in Show Mode fires the next cue. A cue runs all its actions at once; give an action a delay (⏱) to run a short sequence from one GO. The note is shown to the operator: the line to GO on.</InfoTip>
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
        <div key={cue.id} className="group/cue overflow-hidden rounded-lg border border-border bg-card/50 shadow-sm">
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
              <ActionRow
                key={j}
                a={a}
                scene={scene}
                scenes={scenes}
                onChange={(na) => upCue(cue.id, (c) => (c.actions[j] = na))}
                onRemove={() => upCue(cue.id, (c) => c.actions.splice(j, 1))}
              />
            ))}
            <AddActionMenu onAdd={(t) => upCue(cue.id, (c) => c.actions.push(newAction(t, scene, scenes)))} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionRow({ a, scene, scenes, onChange, onRemove }: { a: CueAction; scene: Scene; scenes: Scene[]; onChange: (a: CueAction) => void; onRemove: () => void }) {
  const assets = useProject((s) => s.project.assets);
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
          {sel(a.assetId ?? "__none__", [{ value: "__none__", label: "— choose audio —" }, ...assets.filter((x) => x.type === "audio").map((x) => ({ value: x.id, label: x.name }))], (v) => onChange({ ...a, assetId: v === "__none__" ? null : v }), "w-[200px]")}
          {lbl("vol")}
          <NumberInput className="h-6 w-14" value={a.volume} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...a, volume: v })} />
        </>
      );
      break;
    case "send":
      body = <MessageFields compact hideType={a.message.type === "hog"} m={a.message} onChange={(message) => onChange({ ...a, message })} />;
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
  return (
    <div className="group/action flex items-start gap-2 rounded-md px-1 py-1 text-[11px] hover:bg-accent/40">
      <span className="flex h-6 w-[112px] shrink-0 items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0" title={info.label}>
        {info.icon}
        <span className="truncate">{info.label}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{body}</div>
      <label className={cn("flex h-6 shrink-0 items-center gap-0.5", a.delay > 0 ? "text-armed" : "text-muted-foreground/60")} title="Delay after GO (seconds)">
        <Timer className="size-3.5" />
        <NumberInput className="h-6 w-12 px-1 text-[11px]" value={a.delay} min={0} step={0.5} onChange={(v) => onChange({ ...a, delay: v })} />
        <span>s</span>
      </label>
      <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover/action:opacity-100 hover:text-destructive focus-visible:opacity-100" onClick={onRemove} aria-label="Remove action" title="Remove action">
        <X />
      </Button>
    </div>
  );
}
