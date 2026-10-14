import { ArrowDown, ArrowUp, Play, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { makeCue, defaultTransition } from "@/core/factories";
import { LION_ACTION_INFO } from "@/core/lion";
import { LION_ACTIONS } from "@/core/types";
import type { Cue, CueAction, CueActionType, Scene } from "@/core/types";
import { runCue } from "@/engine/operator";
import { useProject } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";
import { TRANSITIONS } from "../show/ShowMode";

const ACTION_TYPES: { value: CueActionType; label: string }[] = [
  { value: "lion", label: "Lion action" },
  { value: "lion.moveTo", label: "Lion walk/run to marker" },
  { value: "lion.place", label: "Lion place at marker" },
  { value: "actor.visible", label: "Lion show/hide" },
  { value: "effect", label: "Effect" },
  { value: "background", label: "Background" },
  { value: "layer", label: "Layer / element" },
  { value: "camera", label: "Camera move" },
  { value: "timeOfDay", label: "Time of day" },
  { value: "takeScene", label: "Take another scene live" },
  { value: "clip", label: "Video actor clip" },
  { value: "blackout", label: "Blackout / lights up" },
];

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
      return { type, layerId: scene.components.find((c) => c.kind === "video" || c.kind === "image" || c.kind === "model" || c.kind === "procedural")?.id ?? "", op: "show", delay: 0 };
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
  }
}

export function CueEditor({ scene }: { scene: Scene }) {
  const scenes = useProject((s) => s.project.scenes);
  const up = (fn: (s: Scene) => void) => useProject.getState().updateScene(scene.id, fn);
  const upCue = (id: string, fn: (c: Cue) => void) =>
    up((s) => {
      const c = s.cues.find((x) => x.id === id);
      if (c) fn(c);
    });

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[11px] text-muted-foreground">A cue fires one or more actions; delays let one GO run a short sequence. Cues never depend on actor timing — the operator fires each beat.</p>
        <Button size="xs" variant="outline" onClick={() => up((s) => s.cues.push(makeCue(`Cue ${s.cues.length + 1}`)))}>
          <Plus /> Add cue
        </Button>
      </div>
      {scene.cues.map((cue, i) => (
        <div key={cue.id} className="rounded-md border border-border bg-card/40">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            <span className="w-5 text-right text-[12px] font-semibold tabular text-muted-foreground">{i + 1}</span>
            <input
              className="h-7 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[12.5px] font-medium hover:border-input focus:border-input"
              defaultValue={cue.name}
              key={cue.id + cue.name}
              onBlur={(e) => e.target.value !== cue.name && upCue(cue.id, (c) => (c.name = e.target.value))}
            />
            <Button size="xs" variant="ghost" title="Test this cue in the preview" onClick={() => runCue("preview", cue)}>
              <Play /> Test
            </Button>
            <Button size="icon-xs" variant="ghost" disabled={i === 0} onClick={() => up((s) => ([s.cues[i - 1], s.cues[i]] = [s.cues[i], s.cues[i - 1]]))} aria-label="Move up">
              <ArrowUp />
            </Button>
            <Button size="icon-xs" variant="ghost" disabled={i === scene.cues.length - 1} onClick={() => up((s) => ([s.cues[i + 1], s.cues[i]] = [s.cues[i], s.cues[i + 1]]))} aria-label="Move down">
              <ArrowDown />
            </Button>
            <Button size="icon-xs" variant="ghost" onClick={() => up((s) => (s.cues = s.cues.filter((c) => c.id !== cue.id)))} aria-label="Delete cue">
              <Trash2 />
            </Button>
          </div>
          <div className="space-y-1 p-2">
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
            <SelectBox
              className="h-6 w-[200px] text-[11px]"
              value="__add__"
              onChange={(t) => t !== "__add__" && upCue(cue.id, (c) => c.actions.push(defaultAction(t as CueActionType, scene, scenes)))}
              options={[{ value: "__add__", label: "+ Add action…" }, ...ACTION_TYPES]}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionRow({ a, scene, scenes, onChange, onRemove }: { a: CueAction; scene: Scene; scenes: Scene[]; onChange: (a: CueAction) => void; onRemove: () => void }) {
  const opt = (kinds: string[]) =>
    scene.components.filter((c) => kinds.includes(c.kind)).map((c) => ({ value: c.id, label: c.name }));
  const markers = Object.keys(scene.markers).map((m) => ({ value: m, label: m }));
  const sel = (value: string, options: { value: string; label: string }[], set: (v: string) => void, w = "w-[130px]") => (
    <SelectBox className={`h-6 ${w} text-[11px]`} value={options.some((o) => o.value === value) ? value : "__missing__"} onChange={set} options={options.some((o) => o.value === value) ? options : [{ value: "__missing__", label: "— choose —" }, ...options]} />
  );
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
          <span className="text-muted-foreground">to</span>
          {sel(a.marker, markers, (v) => onChange({ ...a, marker: v }), "w-[100px]")}
        </>
      );
      break;
    case "lion.place":
      body = (
        <>
          {sel(a.actorId, opt(["actor"]), (v) => onChange({ ...a, actorId: v }))}
          <span className="text-muted-foreground">at</span>
          {sel(a.marker, markers, (v) => onChange({ ...a, marker: v }), "w-[100px]")}
          <span className="text-muted-foreground">facing°</span>
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
    case "background":
      body = sel(a.backgroundId, opt(["background"]), (v) => onChange({ ...a, backgroundId: v }), "w-[160px]");
      break;
    case "layer":
      body = (
        <>
          {sel(a.layerId, opt(["video", "image", "model", "procedural"]), (v) => onChange({ ...a, layerId: v }), "w-[150px]")}
          {sel(a.op, ["show", "hide", "toggle", "restart"].map((x) => ({ value: x, label: x })), (v) => onChange({ ...a, op: v as typeof a.op }), "w-[90px]")}
        </>
      );
      break;
    case "camera":
      body = sel(a.shotId, scene.cameraShots.map((s) => ({ value: s.id, label: s.name })), (v) => onChange({ ...a, shotId: v }), "w-[160px]");
      break;
    case "timeOfDay":
      body = (
        <>
          <span className="text-muted-foreground">to</span>
          <NumberInput className="h-6 w-14" value={a.value} min={0} max={1} step={0.05} onChange={(v) => onChange({ ...a, value: v })} />
          <span className="text-muted-foreground">over</span>
          <NumberInput className="h-6 w-14" value={a.duration} min={0} step={1} onChange={(v) => onChange({ ...a, duration: v })} />
          <span className="text-muted-foreground">s</span>
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
          <span className="text-muted-foreground">fade</span>
          <NumberInput className="h-6 w-14" value={a.fade} min={0} step={0.1} onChange={(v) => onChange({ ...a, fade: v })} />
          <span className="text-muted-foreground">s</span>
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
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="w-[86px] truncate text-muted-foreground">{ACTION_TYPES.find((t) => t.value === a.type)?.label}</span>
      {body}
      <span className="ml-auto text-muted-foreground">+</span>
      <NumberInput className="h-6 w-14" value={a.delay} min={0} step={0.5} onChange={(v) => onChange({ ...a, delay: v })} />
      <span className="text-muted-foreground">s</span>
      <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label="Remove action">
        <X />
      </Button>
    </div>
  );
}
