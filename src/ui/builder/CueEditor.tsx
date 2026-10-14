import { ArrowDown, ArrowUp, Copy, Play, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { TRANSITIONS } from "../show/ShowMode";
import { MessageFields, defaultMessage } from "../io/MessageFields";

const ACTION_TYPES: { value: CueActionType; label: string }[] = [
  { value: "clip", label: "Video actor clip" },
  { value: "layer", label: "Layer / title / element" },
  { value: "background", label: "Background" },
  { value: "effect", label: "Effect" },
  { value: "effect.param", label: "Effect parameter" },
  { value: "camera", label: "Camera move" },
  { value: "framing", label: "Framing (zoom / reposition)" },
  { value: "names", label: "Family tree / names" },
  { value: "route", label: "Map route" },
  { value: "media.speed", label: "Video speed ramp" },
  { value: "timeOfDay", label: "Time of day" },
  { value: "clock", label: "Freeze / resume motion" },
  { value: "sound", label: "Play sound" },
  { value: "send", label: "Send MIDI / OSC" },
  { value: "blackout", label: "Blackout / lights up" },
  { value: "takeScene", label: "Take another scene live" },
  { value: "lion", label: "Lion action" },
  { value: "lion.moveTo", label: "Lion walk/run to marker" },
  { value: "lion.place", label: "Lion place at marker" },
  { value: "actor.visible", label: "Lion show/hide" },
];

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
        <p className="flex-1 text-[11px] text-muted-foreground">A cue fires one or more actions; delays let one GO run a short sequence. The note under a cue is shown to the operator in Show Mode (the line to GO on).</p>
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
            <Button size="icon-xs" variant="ghost" title="Duplicate cue" onClick={() => up((s) => s.cues.splice(i + 1, 0, { ...structuredClone(cue), id: uid("cue"), name: `${cue.name} copy` }))} aria-label="Duplicate cue">
              <Copy />
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
            <div className="flex items-center gap-2">
              <SelectBox
                className="h-6 w-[210px] text-[11px]"
                value="__add__"
                onChange={(t) => t !== "__add__" && upCue(cue.id, (c) => c.actions.push(defaultAction(t as CueActionType, scene, scenes)))}
                options={[{ value: "__add__", label: "+ Add action…" }, ...ACTION_TYPES]}
              />
              <input
                className="h-6 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[11px] text-amber-200/80 placeholder:text-muted-foreground/60 hover:border-input focus:border-input"
                placeholder="Operator note: the line or action to GO on…"
                defaultValue={cue.notes}
                key={cue.id + cue.notes}
                onBlur={(e) => e.target.value !== cue.notes && upCue(cue.id, (c) => (c.notes = e.target.value))}
              />
            </div>
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
      body = <MessageFields compact m={a.message} onChange={(message) => onChange({ ...a, message })} />;
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
