import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Clapperboard, Eye, EyeOff, Flame, Keyboard, Layers, Mountain, PawPrint, RotateCcw, Route, Sparkles, Video, Zap } from "lucide-react";
import { InfoTip } from "../kit";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { clamp, evalTween } from "@/core/clock";
import { EFFECT_DEFS, num } from "@/core/effects";
import { initialNames } from "@/core/runtime";
import { LION_ACTION_INFO } from "@/core/lion";
import { effectLevel, evalCamera } from "@/core/runtime";
import { sceneNow } from "@/core/clock";
import type { ActorComponent, ClipActorComponent, EffectComponent, LionAction, NamesComponent, RouteComponent, SceneComponent, SceneRuntime } from "@/core/types";
import { clipFits, clipStateAt } from "@/core/clipActor";
import { useShow, type Target } from "@/store/show";
import { useModelInfo } from "@/store/modelInfo";
import { useProject } from "@/store/project";
import { Section } from "../fields";

/** Re-render periodically so fades/levels shown in the UI stay current. */
function useTicker(ms = 250) {
  const [, setN] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
}

export function useControlTarget(): { target: Target; rt: SceneRuntime | null } {
  const selectedId = useProject((s) => s.selectedSceneId);
  const program = useShow((s) => s.program.runtime);
  const standby = useShow((s) => s.program.standby);
  const preview = useShow((s) => s.preview);
  if (program && !standby && program.scene.id === selectedId) return { target: "program", rt: program };
  return { target: "preview", rt: preview };
}

export function TargetBanner({ target }: { target: Target }) {
  const live = target === "program";
  return (
    <div className={cn("flex items-center gap-2 border-b px-3 py-2", live ? "border-live/40 bg-live/10" : "border-border bg-card/60")}>
      <span className={cn("size-2.5 rounded-full", live ? "tally-pulse bg-live" : "bg-preview")} />
      <span className={cn("font-key text-[14px] font-bold", live ? "text-live" : "text-preview")}>{live ? "Controlling the live wall" : "Rehearsing in preview"}</span>
      <InfoTip side="left">{live ? "The selected scene is on the wall: every control here changes what the audience sees." : "The selected scene is not live: these controls only change the preview. The audience is unaffected."}</InfoTip>
    </div>
  );
}

export function ControlPanel() {
  const { target, rt } = useControlTarget();
  useTicker(300);
  if (!rt) return <div className="p-4 text-muted-foreground">Select a scene.</div>;
  const comps = rt.scene.components;
  const bgs = comps.filter((c) => c.kind === "background");
  const actors = comps.filter((c): c is ActorComponent => c.kind === "actor");
  const videoActors = comps.filter((c): c is ClipActorComponent => c.kind === "clipActor");
  const elements = comps.filter((c) => c.kind === "procedural");
  const layers = comps.filter((c) => c.kind === "video" || c.kind === "image" || c.kind === "model" || c.kind === "text");
  const names = comps.filter((c): c is NamesComponent => c.kind === "names");
  const routes = comps.filter((c): c is RouteComponent => c.kind === "route");
  const effects = comps.filter((c): c is EffectComponent => c.kind === "effect");
  const dispatch = (cmd: Parameters<ReturnType<typeof useShow.getState>["dispatch"]>[1]) => useShow.getState().dispatch(target, cmd);
  const t = sceneNow(rt);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TargetBanner target={target} />
      <ScrollArea className="min-h-0 flex-1">
        {bgs.length > 0 && (
          <Section title="Backgrounds" icon={<Mountain />} info="Switch the background plate or 3D look. Changes crossfade over the background change time.">
            <div className="grid grid-cols-2 gap-1.5">
              {bgs.map((b) => {
                const active = rt.background.current === b.id;
                const k = rt.background.dur > 0 ? clamp((t - rt.background.changedAt) / rt.background.dur, 0, 1) : 1;
                return (
                  <Button key={b.id} variant={active ? "secondary" : "outline"} size="sm" className={cn("relative min-w-0 justify-start overflow-hidden", active && "border border-foreground/30")} onClick={() => dispatch({ type: "background", backgroundId: b.id, delay: 0 })}>
                    {active && k < 1 && <span className="absolute inset-y-0 left-0 bg-foreground/10" style={{ width: `${k * 100}%` }} />}
                    <span className={cn("size-1.5 rounded-full", active ? "bg-preview" : "bg-muted-foreground/40")} />
                    <span className="truncate">{b.name}</span>
                  </Button>
                );
              })}
            </div>
          </Section>
        )}

        {(names.length > 0 || routes.length > 0) && (
          <Section title="Storybook" icon={<BookOpen />} info="The family tree of names and map routes: reveal names one at a time, burn the tree, blossom it, draw a journey.">
            {names.map((n) => (
              <NamesControls key={n.id} comp={n} rt={rt} target={target} />
            ))}
            {routes.map((r) => (
              <RouteControls key={r.id} comp={r} rt={rt} target={target} />
            ))}
          </Section>
        )}

        {videoActors.length > 0 && (
          <Section title="Video actors" icon={<Clapperboard />} info="AI video characters made of clips. A clip waits for the current one to end so the cut lands on a matching frame; amber clips start on a different pose (a visible jump).">
            {videoActors.map((a) => (
              <VideoActorControls key={a.id} comp={a} rt={rt} target={target} />
            ))}
          </Section>
        )}

        {(actors.length > 0 || elements.length > 0) && (
          <Section title="Characters" icon={<PawPrint />} info="The 3D lion and built-in elements (sheep, birds, fire, town lights).">
            {actors.map((a) => (
              <LionControls key={a.id} comp={a} target={target} rt={rt} />
            ))}
            {elements.map((e) => (
              <LayerRow key={e.id} comp={e} rt={rt} onToggle={() => dispatch({ type: "layer", layerId: e.id, op: "toggle", delay: 0 })} />
            ))}
          </Section>
        )}

        {effects.length > 0 && (
          <Section title="Effects" icon={<Sparkles />} info="Weather and light over the scene. Open a row to adjust it live.">
            {effects.map((e) => (
              <EffectControl key={e.id} comp={e} rt={rt} target={target} />
            ))}
          </Section>
        )}

        {layers.length > 0 && (
          <Section title="Layers & titles" icon={<Layers />} info="Show or hide video and image layers, models and titles.">
            {layers.map((l) => (
              <LayerRow
                key={l.id}
                comp={l}
                rt={rt}
                onToggle={() => dispatch({ type: "layer", layerId: l.id, op: "toggle", delay: 0 })}
                onRestart={l.kind !== "image" ? () => dispatch({ type: "layer", layerId: l.id, op: "restart", delay: 0 }) : undefined}
              />
            ))}
          </Section>
        )}

        {rt.scene.cameraShots.length > 0 && (
          <Section title="Camera" icon={<Video />} info="Saved camera moves. A move glides from wherever the camera is, carrying its speed into the next move.">
            <div className="grid grid-cols-2 gap-1.5">
              {rt.scene.cameraShots.map((s) => {
                const cam = rt.camera;
                const moving = t < cam.at + cam.dur;
                const at = evalCamera(cam, t);
                const isHere = !moving && at.position.join() === s.pose.position.join() && at.target.join() === s.pose.target.join();
                return (
                  <Button key={s.id} size="sm" variant={isHere ? "secondary" : "outline"} className="justify-start" onClick={() => dispatch({ type: "camera", shotId: s.id, delay: 0 })}>
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground tabular">{s.duration}s</span>
                  </Button>
                );
              })}
            </div>
          </Section>
        )}
      </ScrollArea>
    </div>
  );
}

function LayerRow({ comp, rt, onToggle, onRestart }: { comp: SceneComponent; rt: SceneRuntime; onToggle: () => void; onRestart?: () => void }) {
  const l = rt.layers[comp.id];
  const on = !!l?.visible;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1">
      <span className={cn("size-1.5 rounded-full", on ? "bg-preview" : "bg-muted-foreground/40")} />
      <span className="min-w-0 flex-1 truncate text-[12px]">{comp.name}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{comp.kind === "procedural" ? comp.element : comp.kind}</span>
      {onRestart && (
        <Button variant="ghost" size="icon-xs" onClick={onRestart} aria-label="Restart">
          <RotateCcw />
        </Button>
      )}
      <Button variant={on ? "secondary" : "outline"} size="xs" className="w-16 shrink-0" onClick={onToggle}>
        {on ? <Eye /> : <EyeOff />}
        {on ? "Hide" : "Show"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- storybook

function NamesControls({ comp, rt, target }: { comp: NamesComponent; rt: SceneRuntime; target: Target }) {
  const st = rt.names?.[comp.id] ?? initialNames();
  const t = sceneNow(rt);
  const burn = evalTween(st.burn, t);
  const bloom = evalTween(st.bloom, t);
  const go = (op: "next" | "prev" | "reset" | "all" | "burn" | "restore" | "bloom", duration = 6) => useShow.getState().dispatch(target, { type: "names", layerId: comp.id, op, value: 0, duration, delay: 0 });
  const nextName = comp.names[st.shown];
  return (
    <div className="rounded-md border border-border bg-card/60">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={cn("size-1.5 rounded-full", st.shown > 0 ? "bg-preview" : "bg-muted-foreground/40")} />
        <span className="min-w-0 truncate text-[12px] font-semibold">{comp.name}</span>
        <span className="ml-auto shrink-0 text-[10.5px] tabular text-muted-foreground">
          {st.shown} / {comp.names.length}
          {burn > 0.01 && <span className="text-armed"> · burned {Math.round(burn * 100)}%</span>}
          {bloom > 0.01 && <span className="text-preview"> · bloom {Math.round(bloom * 100)}%</span>}
        </span>
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <Button size="sm" className={cn("h-8 min-w-0 flex-1 justify-between font-semibold", target === "program" ? "bg-live text-white hover:bg-live/85" : "")} disabled={st.shown >= comp.names.length} onClick={() => go("next")}>
          <span>Next name</span>
          <span className="truncate text-[10.5px] font-normal opacity-80">{nextName ?? "— all shown —"}</span>
        </Button>
        <Button size="xs" variant="outline" disabled={st.shown === 0} onClick={() => go("prev")} title="Hide the last name">
          Back
        </Button>
        <Button size="xs" variant="outline" onClick={() => go("all")} title="Reveal every name">
          All
        </Button>
        <Button size="xs" variant="ghost" onClick={() => go("reset")} title="Back to the empty root">
          <RotateCcw />
        </Button>
      </div>
      {comp.style === "tree" && (
        <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
          <Button size="xs" variant={burn > 0.5 ? "secondary" : "outline"} className="flex-1" onClick={() => go(burn > 0.5 ? "restore" : "burn", 7)} title="Babylon: the tree burns down to a stump (and back)">
            <Flame /> {burn > 0.5 ? "Un-burn" : "Burn to stump"}
          </Button>
          <Button size="xs" variant={bloom > 0.5 ? "secondary" : "outline"} className="flex-1" onClick={() => go("bloom", 8)} title="Scene 16: the whole tree blossoms, every name lit">
            <Sparkles /> Blossom
          </Button>
        </div>
      )}
    </div>
  );
}

function RouteControls({ comp, rt, target }: { comp: RouteComponent; rt: SceneRuntime; target: Target }) {
  const p = evalTween(rt.routes?.[comp.id]?.progress ?? { from: 0, to: 0, at: 0, dur: 0 }, sceneNow(rt));
  const go = (op: "play" | "reset" | "complete") => useShow.getState().dispatch(target, { type: "route", layerId: comp.id, op, delay: 0 });
  return (
    <div className="rounded-md border border-border bg-card/60">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Route className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[12px] font-semibold">{comp.name}</span>
        <div className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-armed" style={{ width: `${p * 100}%` }} />
        </div>
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <Button size="sm" className={cn("h-8 flex-1 font-semibold", target === "program" ? "bg-live text-white hover:bg-live/85" : "")} disabled={p >= 1} onClick={() => go("play")}>
          Draw the route
        </Button>
        <Button size="xs" variant="outline" onClick={() => go("complete")}>
          Jump to end
        </Button>
        <Button size="xs" variant="ghost" onClick={() => go("reset")}>
          <RotateCcw />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- effects

function EffectControl({ comp, rt, target }: { comp: EffectComponent; rt: SceneRuntime; target: Target }) {
  const def = EFFECT_DEFS[comp.effect];
  const e = rt.effects[comp.id];
  const [open, setOpen] = useState(false);
  if (!e) return null;
  const t = sceneNow(rt);
  const dispatch = useShow.getState().dispatch;
  const level =
    comp.effect === "daynight"
      ? clamp(rt.env.timeOfDay.to === rt.env.timeOfDay.from ? rt.env.timeOfDay.to : rt.env.timeOfDay.from + (rt.env.timeOfDay.to - rt.env.timeOfDay.from) * clamp((t - rt.env.timeOfDay.at) / Math.max(1, rt.env.timeOfDay.dur), 0, 1), 0, 1)
      : comp.effect === "lightning"
        ? 0
        : effectLevel(comp.effect, e.active, e.changedAt, e.params, t);
  const liveParams = def.params.filter((p) => p.type === "range" && p.live !== false && "min" in p);

  return (
    <div className={cn("rounded-md border bg-card/50", e.active && def.mode === "toggle" ? "border-armed/50" : "border-border")}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button className="text-muted-foreground" onClick={() => setOpen(!open)} aria-label="Parameters">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{comp.name}</span>
        {def.mode === "toggle" && (
          <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted" title={`${Math.round(level * 100)}%`}>
            <div className="h-full bg-armed transition-[width]" style={{ width: `${level * 100}%` }} />
          </div>
        )}
        {def.mode === "trigger" ? (
          <Button size="xs" className="w-[92px] shrink-0 bg-armed/90 text-black hover:bg-armed" onClick={() => dispatch(target, { type: "effect", effectId: comp.id, op: "trigger", delay: 0 })}>
            <Zap /> {def.startLabel}
          </Button>
        ) : (
          <Button size="xs" variant={e.active ? "secondary" : "outline"} className={cn("w-[92px] shrink-0", e.active && "border border-armed/60")} onClick={() => dispatch(target, { type: "effect", effectId: comp.id, op: "toggle", delay: 0 })}>
            {e.active ? def.stopLabel : def.startLabel}
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-1.5 border-t border-border px-2 py-2">
          {liveParams.map((p) =>
            p.type === "range" ? (
              <div key={p.key} className="grid grid-cols-[86px_1fr_42px] items-center gap-2 text-[11px]">
                <span className="truncate text-muted-foreground">{p.label}</span>
                <Slider value={[num(e.params, p.key, 0)]} min={p.min} max={p.max} step={p.step} onValueChange={(v) => dispatch(target, { type: "effect.param", effectId: comp.id, key: p.key, value: v[0] })} />
                <span className="text-right tabular text-muted-foreground">{Math.round(num(e.params, p.key, 0) * 100) / 100}</span>
              </div>
            ) : null,
          )}
          {liveParams.length === 0 && <p className="text-[11px] text-muted-foreground">Edit defaults in Scene Builder.</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- lion

const ACTION_BUTTONS: LionAction[] = ["idle", "walk", "run", "roar", "attack", "hit", "fall"];

function LionControls({ comp, target, rt }: { comp: ActorComponent; target: Target; rt: SceneRuntime }) {
  const pose = useShow((s) => (target === "program" ? s.programPoses : s.previewPoses)[comp.id]);
  const lc = useShow((s) => s.lionControl);
  const armed = lc.armed && lc.actorId === comp.id && lc.target === target;
  const info = useModelInfo((s) => (comp.assetId ? s.byAsset[comp.assetId] : undefined));
  const dispatch = (cmd: Parameters<ReturnType<typeof useShow.getState>["dispatch"]>[1]) => useShow.getState().dispatch(target, cmd);
  const markers = Object.keys(rt.scene.markers);

  // Disarm when the controlled scene changes so keys never drive the wrong lion.
  useEffect(() => {
    return () => {
      const s = useShow.getState().lionControl;
      if (s.actorId === comp.id) useShow.getState().setLionControl({ armed: false });
    };
  }, [comp.id, target]);

  return (
    <div className={cn("rounded-md border bg-card/60", armed ? "border-armed shadow-[0_0_0_1px] shadow-armed/40" : "border-border")}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", pose?.visible ? "bg-preview" : "bg-muted-foreground/40")} />
        <span className="min-w-0 truncate text-[12px] font-semibold">{comp.name}</span>
        {!comp.assetId ? (
          <span className="rounded bg-armed/15 px-1.5 text-[9.5px] font-bold tracking-wider text-armed" title="Procedural stand-in. Assign a rigged GLB lion in Scene Builder.">
            PLACEHOLDER MODEL
          </span>
        ) : info?.missing.length ? (
          <span className="rounded bg-destructive/20 px-1.5 text-[9.5px] font-bold text-destructive" title={`Missing clips: ${info.missing.join(", ")}`}>
            {info.missing.length} CLIPS MISSING
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular">{pose ? `${pose.action}${pose.target ? " →" : ""}` : "—"}</span>
        <Button size="xs" className="shrink-0" variant={pose?.visible ? "secondary" : "outline"} onClick={() => dispatch({ type: "actor.visible", actorId: comp.id, visible: !pose?.visible, delay: 0 })}>
          {pose?.visible ? "Hide" : "Show"}
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-1 px-2 pb-2">
        {ACTION_BUTTONS.map((a) => (
          <Button key={a} size="xs" variant={pose?.action === a ? "secondary" : "outline"} onClick={() => dispatch({ type: "lion", actorId: comp.id, action: a, delay: 0 })} className="justify-between">
            {LION_ACTION_INFO[a].label.replace(" reaction", "")}
            <kbd className="text-[9px] text-muted-foreground">{LION_ACTION_INFO[a].key}</kbd>
          </Button>
        ))}
        <Button size="xs" variant="outline" onClick={() => dispatch({ type: "lion", actorId: comp.id, action: "idle", delay: 0 })} className="justify-between">
          Stop <kbd className="text-[9px] text-muted-foreground">␣</kbd>
        </Button>
      </div>
      {markers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <span className="mr-1 text-[11px] text-muted-foreground">Walk to</span>
          {markers.map((m) => (
            <Button key={m} size="xs" variant="ghost" className="h-5 border border-border px-1.5 text-[10.5px]" onClick={() => dispatch({ type: "lion.moveTo", actorId: comp.id, marker: m, gait: "walk", delay: 0 })}>
              {m}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
        <Button
          size="xs"
          variant={armed ? "default" : "outline"}
          className={cn(armed && "bg-armed text-black hover:bg-armed/90")}
          onClick={() => useShow.getState().setLionControl({ armed: !armed, actorId: comp.id, target })}
        >
          <Keyboard /> {armed ? "Keyboard ARMED" : "Arm keyboard"}
        </Button>
        <span className="text-[10px] leading-tight text-muted-foreground">
          {armed ? "WASD move · Q/E turn · Shift run · 1–7 actions · Space stop" : "Keys only act while armed and this window is focused."}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- video actor

function VideoActorControls({ comp, rt, target }: { comp: ClipActorComponent; rt: SceneRuntime; target: Target }) {
  const t = sceneNow(rt);
  const state = rt.clipActors?.[comp.id];
  const st = clipStateAt(comp, state, t);
  const dispatch = (clipId: string | null) => useShow.getState().dispatch(target, { type: "clip", actorId: comp.id, clipId, delay: 0 });
  const progress = st.clip ? Math.min(1, st.localT / Math.max(0.05, st.clip.duration)) : 0;
  return (
    <div className="rounded-md border border-border bg-card/60">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", st.clip ? "bg-preview" : "bg-muted-foreground/40")} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={comp.name}>{comp.name}</span>
        <span className="shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground">
          pose <span className="font-semibold text-foreground">{st.pose}</span>
        </span>
        <Button size="xs" variant="outline" className="shrink-0" disabled={!st.clip} onClick={() => dispatch(null)} title="Remove the actor (cut back to the plate)">
          Clear
        </Button>
      </div>
      <div className="mx-2 mb-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", st.playing ? "bg-preview" : "bg-muted-foreground/50")} style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="truncate px-2 pb-1 text-[10.5px] text-muted-foreground">
        {st.clip ? `${st.playing ? "Playing" : "Holding last frame of"} “${st.clip.name}”` : "Not on stage"}
        {st.queued && <span className="text-armed"> · next: {st.queued.clip.name} in {Math.max(0, (st.queued.at - t) / 1000).toFixed(1)}s</span>}
      </div>
      <div className="grid grid-cols-2 gap-1 px-2 pb-2">
        {comp.clips.map((c) => {
          const fits = clipFits(comp, state, c, t);
          return (
            <Button
              key={c.id}
              size="xs"
              variant={st.clip?.id === c.id ? "secondary" : "outline"}
              className={cn("min-w-0 justify-between", !fits && "border-armed/50")}
              onClick={() => dispatch(c.id)}
              title={fits ? `Continues seamlessly from “${st.pose}”` : `Starts on “${c.startPose}” but the actor is in “${st.pose}”: this will be a visible jump`}
            >
              <span className="truncate">{c.name}</span>
              <span className={cn("shrink-0 text-[9px]", fits ? "text-preview" : "text-armed")}>
                {c.startPose}→{c.endPose}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
