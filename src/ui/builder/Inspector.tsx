import { AlertTriangle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EFFECT_DEFS, bool, num, str } from "@/core/effects";
import { uid } from "@/core/ids";
import { LION_ACTION_INFO } from "@/core/lion";
import { LION_ACTIONS } from "@/core/types";
import { defaultActorLayout, defaultKenBurns, makeClip } from "@/core/factories";
import { MarkersEditor } from "../io/MarkersEditor";
import { probeDuration } from "@/engine/operator";
import type {
  ClipActorComponent,
  ActorComponent,
  BackgroundComponent,
  BlendMode,
  Crop,
  EffectComponent,
  EntranceKind,
  FitMode,
  ImageLayerComponent,
  KenBurns,
  LayerPlacement,
  MediaSettings,
  ModelComponent,
  NamesComponent,
  ProceduralComponent,
  RouteComponent,
  SceneComponent,
  TextAnim,
  TextComponent,
  VideoLayerComponent,
} from "@/core/types";
import { useModelInfo } from "@/store/modelInfo";
import { selectedScene, useProject, NO_ITEMS } from "@/store/project";
import { FontPicker } from "../FontPicker";
import { AssetField, ColorField, Field, NumberField, NumberInput, Section, SelectBox, SelectField, SliderField, SwitchField, TextField, Vec3Field } from "../fields";

type Updater<T> = (fn: (c: T) => void) => void;

export function Inspector() {
  const scene = useProject(selectedScene);
  const id = useProject((s) => s.selectedComponentId);
  const comp = scene?.components.find((c) => c.id === id);
  if (!scene || !comp) return <p className="p-4 text-[12px] text-muted-foreground">Select a component to edit it.</p>;
  const up = <T extends SceneComponent>(fn: (c: T) => void) => useProject.getState().updateComponent(scene.id, comp.id, (c) => fn(c as T));

  return (
    <div>
      <Section title={`${comp.kind} · properties`}>
        <TextField label="Name" value={comp.name} onChange={(v) => up((c) => (c.name = v))} />
        {comp.kind !== "background" && (
          <SwitchField
            label={comp.kind === "effect" ? "On at start" : "Visible at start"}
            hint="State when the scene is taken live"
            value={comp.initiallyVisible}
            onChange={(v) => up((c) => (c.initiallyVisible = v))}
          />
        )}
        {comp.kind === "background" && (
          <SwitchField label="Default background" value={comp.initiallyVisible} onChange={(v) => useProject.getState().updateScene(scene.id, (s) => s.components.forEach((c) => c.kind === "background" && (c.initiallyVisible = v ? c.id === comp.id : false)))} />
        )}
      </Section>
      {comp.kind === "background" && <BackgroundForm c={comp} up={up as Updater<BackgroundComponent>} />}
      {(comp.kind === "video" || comp.kind === "image") && <LayerForm c={comp} up={up as Updater<VideoLayerComponent | ImageLayerComponent>} />}
      {comp.kind === "model" && <ModelForm c={comp} up={up as Updater<ModelComponent>} />}
      {comp.kind === "actor" && <LionForm c={comp} up={up as Updater<ActorComponent>} markers={Object.keys(scene.markers)} />}
      {comp.kind === "effect" && <EffectForm c={comp} up={up as Updater<EffectComponent>} />}
      {comp.kind === "procedural" && <ProceduralForm c={comp} up={up as Updater<ProceduralComponent>} />}
      {comp.kind === "clipActor" && <ClipActorForm c={comp} up={up as Updater<ClipActorComponent>} />}
      {comp.kind === "text" && <TextForm c={comp} up={up as Updater<TextComponent>} />}
      {comp.kind === "names" && <NamesForm c={comp} up={up as Updater<NamesComponent>} />}
      {comp.kind === "route" && <RouteForm c={comp} up={up as Updater<RouteComponent>} />}
    </div>
  );
}

const TEXT_ANIMS: { value: TextAnim; label: string }[] = [
  { value: "fade", label: "Fade" },
  { value: "rise", label: "Rise" },
  { value: "letters", label: "Letter by letter" },
  { value: "words", label: "Word by word" },
  { value: "typewriter", label: "Typewriter" },
  { value: "burn", label: "Burn in (gold fire)" },
  { value: "cut", label: "Cut" },
];

function TextForm({ c, up }: { c: TextComponent; up: Updater<TextComponent> }) {
  const timers = useProject((s) => s.project.timers ?? NO_ITEMS);
  return (
    <>
      <Section title="Text">
        <SelectField
          label="Countdown"
          value={c.timerId ?? "__none__"}
          onChange={(v) => up((x) => (x.timerId = v === "__none__" ? null : v))}
          options={[{ value: "__none__", label: "— plain text —" }, ...timers.map((t) => ({ value: t.id, label: `Show timer: ${t.name}` }))]}
        />
        {c.timerId && <p className="text-[10.5px] leading-snug text-muted-foreground">Write {"{time}"} where the clock goes, e.g. “WE'LL BE BACK IN {"{time}"}”. Run the timer from Show Mode → Timers or a cue.</p>}
        <Field label="Text">
          <textarea
            className="h-16 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 text-[12px]"
            defaultValue={c.text}
            key={c.id}
            onBlur={(e) => e.target.value !== c.text && up((x) => (x.text = e.target.value))}
          />
        </Field>
        <Field label="Font">
          <FontPicker value={c.font} onChange={(v) => up((x) => (x.font = v))} />
        </Field>
        <SliderField label="Weight" value={c.weight} min={300} max={900} step={100} onChange={(v) => up((x) => (x.weight = v))} />
        <SwitchField label="Capitals" value={c.uppercase} onChange={(v) => up((x) => (x.uppercase = v))} />
        <SwitchField label="Italic" value={c.italic} onChange={(v) => up((x) => (x.italic = v))} />
        <SliderField label="Size" value={c.size} min={0.02} max={0.6} step={0.005} onChange={(v) => up((x) => (x.size = v))} />
        <SliderField label="Letter spacing" value={c.letterSpacing} min={-0.05} max={0.6} step={0.005} unit="em" onChange={(v) => up((x) => (x.letterSpacing = v))} />
        <SliderField label="Line height" value={c.lineHeight} min={0.8} max={2} step={0.05} onChange={(v) => up((x) => (x.lineHeight = v))} />
        <ColorField label="Colour" value={c.color} onChange={(v) => up((x) => (x.color = v))} />
        <SliderField label="Glow" value={c.glow} min={0} max={2} step={0.01} onChange={(v) => up((x) => (x.glow = v))} />
        <ColorField label="Glow colour" value={c.glowColor} onChange={(v) => up((x) => (x.glowColor = v))} />
        <SliderField label="Drop shadow" value={c.shadow} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.shadow = v))} />
        <SelectField<BlendMode> label="Blend" value={c.blend} onChange={(v) => up((x) => (x.blend = v))} options={[{ value: "normal", label: "Normal" }, { value: "add", label: "Add (light)" }, { value: "screen", label: "Screen" }, { value: "multiply", label: "Multiply" }]} />
      </Section>
      <Section title="Placement">
        <SliderField label="X (centre)" value={c.x} min={0} max={1} step={0.005} onChange={(v) => up((x) => (x.x = v))} />
        <SliderField label="Y (centre)" value={c.y} min={0} max={1} step={0.005} onChange={(v) => up((x) => (x.y = v))} />
        <SelectField label="Align" value={c.align} onChange={(v) => up((x) => (x.align = v))} options={[{ value: "center", label: "Centre" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }]} />
        <SliderField label="Wrap width" value={c.width} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.width = v))} />
      </Section>
      <Section title="Animation">
        <SelectField<TextAnim> label="Entrance" value={c.anim.enter} onChange={(v) => up((x) => (x.anim.enter = v))} options={TEXT_ANIMS} />
        <SelectField<TextAnim> label="Exit" value={c.anim.exit} onChange={(v) => up((x) => (x.anim.exit = v))} options={TEXT_ANIMS} />
        <SliderField label="Duration" value={c.anim.duration} min={0} max={10} step={0.1} unit="s" onChange={(v) => up((x) => (x.anim.duration = v))} />
        <SliderField label="Stagger" value={c.anim.stagger} min={0} max={1.5} step={0.01} unit="s" onChange={(v) => up((x) => (x.anim.stagger = v))} />
        <p className="text-[10.5px] leading-snug text-muted-foreground">Stagger is the delay between letters or words. Show and hide the title with a Layer cue action (or from the Layers list in Show Mode).</p>
      </Section>
    </>
  );
}

function NamesForm({ c, up }: { c: NamesComponent; up: Updater<NamesComponent> }) {
  return (
    <>
      <Section title="Names">
        <Field label="Names">
          <textarea
            className="h-28 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[11.5px]"
            defaultValue={c.names.join("\n")}
            key={c.id + c.names.length}
            onBlur={(e) => {
              const names = e.target.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
              if (names.join("|") !== c.names.join("|")) up((x) => (x.names = names));
            }}
          />
        </Field>
        <p className="-mt-1 text-[10.5px] text-muted-foreground">One per line, in order. Cues reveal the next name (“Family tree / names” action), burn the tree down or make it blossom.</p>
        <SelectField
          label="Style"
          value={c.style}
          onChange={(v) => up((x) => (x.style = v))}
          options={[
            { value: "tree", label: "Tree: gold branches growing up" },
            { value: "line", label: "Thin shoot, small plain letters" },
            { value: "roll", label: "One big name at a time" },
            { value: "fly", label: "Names rise and fly like embers" },
          ]}
        />
        <TextField label="Crown text" value={c.crown} onChange={(v) => up((x) => (x.crown = v))} placeholder="e.g. FOREVER or JESUS" />
        <Field label="Font">
          <FontPicker value={c.font} onChange={(v) => up((x) => (x.font = v))} />
        </Field>
        <SliderField label="Size" value={c.size} min={0.02} max={0.2} step={0.002} onChange={(v) => up((x) => (x.size = v))} />
        <ColorField label="Gold" value={c.color} onChange={(v) => up((x) => (x.color = v))} />
        <ColorField label="Branches" value={c.branchColor} onChange={(v) => up((x) => (x.branchColor = v))} />
        <SliderField label="Glow" value={c.glow} min={0} max={2} step={0.01} onChange={(v) => up((x) => (x.glow = v))} />
        <SliderField label="Bloom time" value={c.reveal} min={0.2} max={5} step={0.1} unit="s" onChange={(v) => up((x) => (x.reveal = v))} />
      </Section>
      <Section title="Layout">
        <SliderField label="Root X" value={c.x} min={0} max={1} step={0.005} onChange={(v) => up((x) => (x.x = v))} />
        <SliderField label="Root Y" value={c.y} min={0} max={1.1} step={0.005} onChange={(v) => up((x) => (x.y = v))} />
        <SliderField label="Height" value={c.height} min={0.1} max={1.2} step={0.01} onChange={(v) => up((x) => (x.height = v))} />
        <SliderField label="Spread" value={c.spread} min={0} max={0.5} step={0.005} onChange={(v) => up((x) => (x.spread = v))} />
        <NumberField label="Seed" value={c.seed} step={1} onChange={(v) => up((x) => (x.seed = Math.round(v)))} />
      </Section>
    </>
  );
}

function RouteForm({ c, up }: { c: RouteComponent; up: Updater<RouteComponent> }) {
  return (
    <>
      <Section title="Map route">
        <AssetField label="Map image" type="image" value={c.assetId} onChange={(v) => up((x) => (x.assetId = v))} />
        <SelectField<FitMode> label="Fit" value={c.fit} onChange={(v) => up((x) => (x.fit = v))} options={[{ value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }, { value: "stretch", label: "Stretch" }]} />
        <SliderField label="Vertical framing" value={c.anchorY ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.anchorY = v))} />
        <Field label="Points (x y)">
          <textarea
            className="h-24 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[11.5px]"
            defaultValue={c.points.map((p) => `${p[0]} ${p[1]}`).join("\n")}
            key={c.id + c.points.length}
            onBlur={(e) => {
              const pts = e.target.value
                .split("\n")
                .map((l) => l.trim().split(/[\s,]+/).map(Number))
                .filter((p) => p.length >= 2 && p.every((n) => Number.isFinite(n)))
                .map((p) => [p[0], p[1]] as [number, number]);
              if (JSON.stringify(pts) !== JSON.stringify(c.points)) up((x) => (x.points = pts));
            }}
          />
        </Field>
        <p className="-mt-1 text-[10.5px] text-muted-foreground">One point per line as fractions of the map image (0 0 top-left, 1 1 bottom-right). The line is smoothed through them.</p>
        <ColorField label="Line colour" value={c.color} onChange={(v) => up((x) => (x.color = v))} />
        <SliderField label="Line width" value={c.width} min={0.002} max={0.03} step={0.0005} onChange={(v) => up((x) => (x.width = v))} />
        <SliderField label="Glow" value={c.glow} min={0} max={2} step={0.01} onChange={(v) => up((x) => (x.glow = v))} />
        <SliderField label="Draw time" value={c.duration} min={0.5} max={60} step={0.5} unit="s" onChange={(v) => up((x) => (x.duration = v))} />
        <TextField label="End label" value={c.label} onChange={(v) => up((x) => (x.label = v))} />
        <ColorField label="Label colour" value={c.labelColor} onChange={(v) => up((x) => (x.labelColor = v))} />
        <SliderField label="Label size" value={c.labelSize} min={0.02} max={0.2} step={0.002} onChange={(v) => up((x) => (x.labelSize = v))} />
        <SliderField label="Opacity" value={c.opacity} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.opacity = v))} />
      </Section>
      <Section title="Map move while drawing">
        <KenBurnsFields kb={c.zoom} set={(fn) => up((x) => fn(x.zoom))} />
      </Section>
    </>
  );
}

function KenBurnsFields({ kb, set }: { kb: KenBurns; set: (fn: (k: KenBurns) => void) => void }) {
  return (
    <>
      <SwitchField label="Pan / zoom" hint="Slow Ken Burns move over the picture" value={kb.enabled} onChange={(v) => set((k) => (k.enabled = v))} />
      {kb.enabled && (
        <>
          <Field label="From (x y scale)">
            <div className="grid grid-cols-3 gap-1">
              <NumberInput value={kb.from.x} step={0.01} onChange={(v) => set((k) => (k.from.x = v))} />
              <NumberInput value={kb.from.y} step={0.01} onChange={(v) => set((k) => (k.from.y = v))} />
              <NumberInput value={kb.from.scale} min={1} step={0.01} onChange={(v) => set((k) => (k.from.scale = v))} />
            </div>
          </Field>
          <Field label="To (x y scale)">
            <div className="grid grid-cols-3 gap-1">
              <NumberInput value={kb.to.x} step={0.01} onChange={(v) => set((k) => (k.to.x = v))} />
              <NumberInput value={kb.to.y} step={0.01} onChange={(v) => set((k) => (k.to.y = v))} />
              <NumberInput value={kb.to.scale} min={1} step={0.01} onChange={(v) => set((k) => (k.to.scale = v))} />
            </div>
          </Field>
          <SliderField label="Duration" value={kb.duration} min={1} max={180} step={1} unit="s" onChange={(v) => set((k) => (k.duration = v))} />
          <SelectField label="Then" value={kb.loop} onChange={(v) => set((k) => (k.loop = v))} options={[{ value: "none", label: "Hold the end" }, { value: "pingpong", label: "Drift back and forth" }, { value: "loop", label: "Jump back and repeat" }]} />
          <p className="text-[10.5px] leading-snug text-muted-foreground">x/y pan in canvas fractions (0.02 = 2% of the wall), scale ≥ 1 zooms in. Starts when the background is activated.</p>
        </>
      )}
    </>
  );
}

function CropFields({ crop, set }: { crop: Crop; set: (c: Crop) => void }) {
  return (
    <Field label="Crop L/R/T/B">
      <div className="grid grid-cols-4 gap-1">
        {(["left", "right", "top", "bottom"] as const).map((k) => (
          <NumberInput key={k} value={crop[k]} step={0.01} min={0} max={0.9} onChange={(v) => set({ ...crop, [k]: v })} />
        ))}
      </div>
    </Field>
  );
}

function MediaFields({ m, set }: { m: MediaSettings; set: (fn: (m: MediaSettings) => void) => void }) {
  return (
    <>
      <SwitchField label="Loop" value={m.loop} onChange={(v) => set((x) => (x.loop = v))} />
      <SliderField label="Speed" value={m.playbackRate} min={0.1} max={3} step={0.05} unit="×" onChange={(v) => set((x) => (x.playbackRate = v))} />
      <Field label="In / out (s)">
        <div className="grid grid-cols-2 gap-1">
          <NumberInput value={m.startTime} min={0} step={0.1} onChange={(v) => set((x) => (x.startTime = v))} />
          <NumberInput value={m.endTime ?? 0} min={0} step={0.1} onChange={(v) => set((x) => (x.endTime = v > 0 ? v : null))} />
        </div>
      </Field>
      <SwitchField label="Reverse" hint="Plays backwards by scrubbing (about 12 steps a second). For a smooth rewind, import a reversed render of the clip instead." value={!!m.reverse} onChange={(v) => set((x) => (x.reverse = v))} />
      <SwitchField label="Muted" value={m.muted} onChange={(v) => set((x) => (x.muted = v))} />
      {!m.muted && <SliderField label="Volume" value={m.volume} min={0} max={1} step={0.01} onChange={(v) => set((x) => (x.volume = v))} />}
      <MarkersEditor markers={m.markers} onChange={(markers) => set((x) => (x.markers = markers))} />
    </>
  );
}

function BackgroundForm({ c, up }: { c: BackgroundComponent; up: Updater<BackgroundComponent> }) {
  return (
    <Section title="Background">
      <SelectField
        label="Source"
        value={c.source}
        onChange={(v) => up((x) => (x.source = v))}
        options={[
          { value: "environment", label: "3D environment look" },
          { value: "media", label: "Video / image plate" },
        ]}
      />
      {c.source === "environment" ? (
        <>
          <SliderField label="Time of day" value={c.env.timeOfDay} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.env.timeOfDay = v))} />
          <p className="-mt-1 pl-[104px] text-[10.5px] text-muted-foreground">0 day · 0.45 golden hour · 0.6 dusk · 1 night</p>
          <SliderField label="Storm" value={c.env.storm} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.env.storm = v))} />
        </>
      ) : (
        <>
          <AssetField label="Media" type={["video", "image"]} value={c.media.assetId} onChange={(v) => up((x) => (x.media.assetId = v))} />
          <SelectField<FitMode>
            label="Fit"
            value={c.fit}
            onChange={(v) => up((x) => (x.fit = v))}
            options={[
              { value: "cover", label: "Cover (fill canvas)" },
              { value: "contain", label: "Contain" },
              { value: "stretch", label: "Stretch" },
            ]}
          />
          <CropFields crop={c.crop} set={(crop) => up((x) => (x.crop = crop))} />
          <SliderField label="Vertical framing" value={c.anchorY ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.anchorY = v))} />
          <SliderField label="Opacity" value={c.opacity} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.opacity = v))} />
          <SliderField label="Parallax" value={c.parallax ?? 0} min={0} max={0.08} step={0.001} onChange={(v) => up((x) => (x.parallax = v))} />
          <p className="-mt-1 pl-[104px] text-[10.5px] text-muted-foreground">2.5D depth with the scene's camera sway: the plate drifts a little, cut-out actors more.</p>
          <MediaFields m={c.media} set={(fn) => up((x) => fn(x.media))} />
          <KenBurnsFields
            kb={c.kenBurns ?? defaultKenBurns()}
            set={(fn) =>
              up((x) => {
                x.kenBurns ??= defaultKenBurns();
                fn(x.kenBurns);
              })
            }
          />
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Video can't be relit. For night, add a matching night plate as another background (crossfades), or rely on the Day/Night effect's colour grade.
          </p>
        </>
      )}
      <SliderField label="Change time" value={c.transitionDuration} min={0} max={30} step={0.5} unit="s" onChange={(v) => up((x) => (x.transitionDuration = v))} />
    </Section>
  );
}

const ENTRANCES: { value: EntranceKind; label: string }[] = [
  { value: "none", label: "Cut" },
  { value: "fade", label: "Fade" },
  { value: "slide-left", label: "Slide from right" },
  { value: "slide-right", label: "Slide from left" },
  { value: "slide-up", label: "Rise" },
  { value: "scale", label: "Scale" },
];

function LayerForm({ c, up }: { c: VideoLayerComponent | ImageLayerComponent; up: Updater<VideoLayerComponent | ImageLayerComponent> }) {
  const isVideo = c.kind === "video";
  return (
    <>
      <Section title={isVideo ? "Video layer" : "Image layer"}>
        {isVideo ? (
          <AssetField label="Video" type="video" value={c.media.assetId} onChange={(v) => up((x) => ((x as VideoLayerComponent).media.assetId = v))} />
        ) : (
          <AssetField label="Image" type="image" value={c.assetId} onChange={(v) => up((x) => ((x as ImageLayerComponent).assetId = v))} />
        )}
        <SelectField<LayerPlacement>
          label="Placement"
          value={c.placement}
          onChange={(v) => up((x) => (x.placement = v))}
          options={[
            { value: "back", label: "Behind 3D (screen space)" },
            { value: "front", label: "In front of 3D (screen space)" },
            { value: "world", label: "In the 3D world (billboard)" },
          ]}
        />
        {c.placement === "world" ? (
          <>
            <Vec3Field label="Position (m)" value={c.world.position} onChange={(v) => up((x) => (x.world.position = v))} />
            <NumberField label="Height (m)" value={c.world.height} step={0.1} min={0.05} onChange={(v) => up((x) => (x.world.height = v))} />
            <SwitchField label="Face camera" value={c.world.billboard} onChange={(v) => up((x) => (x.world.billboard = v))} />
          </>
        ) : (
          <>
            <SliderField label="X (centre)" value={c.screen.x} min={-0.5} max={1.5} step={0.005} onChange={(v) => up((x) => (x.screen.x = v))} />
            <SliderField label="Y (centre)" value={c.screen.y} min={-0.5} max={1.5} step={0.005} onChange={(v) => up((x) => (x.screen.y = v))} />
            <SliderField label="Width" value={c.screen.width} min={0.01} max={2} step={0.005} onChange={(v) => up((x) => (x.screen.width = v))} />
            <SliderField label="Rotation" value={c.screen.rotation} min={-180} max={180} step={1} unit="°" onChange={(v) => up((x) => (x.screen.rotation = v))} />
            <SwitchField label="Flip horizontal" value={c.screen.flipX} onChange={(v) => up((x) => (x.screen.flipX = v))} />
          </>
        )}
        <SliderField label="Opacity" value={c.opacity} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.opacity = v))} />
        <SelectField<BlendMode>
          label="Blend"
          value={c.blend}
          onChange={(v) => up((x) => (x.blend = v))}
          options={[
            { value: "normal", label: "Normal (alpha)" },
            { value: "add", label: "Add (glows, fire, lightning)" },
            { value: "screen", label: "Screen (smoke, dust on black)" },
            { value: "multiply", label: "Multiply (shadows)" },
          ]}
        />
        <CropFields crop={c.crop} set={(crop) => up((x) => (x.crop = crop))} />
        <SelectField label="Mask" value={c.mask.shape} onChange={(v) => up((x) => (x.mask.shape = v))} options={[{ value: "none", label: "None" }, { value: "rect", label: "Soft rectangle" }, { value: "ellipse", label: "Soft ellipse" }]} />
        {c.mask.shape !== "none" && <SliderField label="Feather" value={c.mask.feather} min={0} max={0.5} step={0.005} onChange={(v) => up((x) => (x.mask.feather = v))} />}
      </Section>
      {isVideo && (
        <Section title="Keying & playback">
          <SwitchField label="Chroma key" value={c.chroma.enabled} onChange={(v) => up((x) => ((x as VideoLayerComponent).chroma.enabled = v))} />
          {c.chroma.enabled && (
            <>
              <ColorField label="Key colour" value={c.chroma.color} onChange={(v) => up((x) => ((x as VideoLayerComponent).chroma.color = v))} />
              <SliderField label="Similarity" value={c.chroma.similarity} min={0} max={0.8} step={0.005} onChange={(v) => up((x) => ((x as VideoLayerComponent).chroma.similarity = v))} />
              <SliderField label="Smoothness" value={c.chroma.smoothness} min={0} max={0.4} step={0.005} onChange={(v) => up((x) => ((x as VideoLayerComponent).chroma.smoothness = v))} />
              <SliderField label="Spill" value={c.chroma.spill} min={0} max={1} step={0.01} onChange={(v) => up((x) => ((x as VideoLayerComponent).chroma.spill = v))} />
            </>
          )}
          <p className="text-[10.5px] leading-snug text-muted-foreground">Transparent video: WebM (VP9 alpha) on Windows; HEVC-with-alpha .mov on macOS.</p>
          <MediaFields m={c.media} set={(fn) => up((x) => fn((x as VideoLayerComponent).media))} />
        </Section>
      )}
      {!isVideo && (
        <Section title="Motion">
          <SelectField label="Idle motion" value={c.motion.type} onChange={(v) => up((x) => ((x as ImageLayerComponent).motion.type = v))} options={[{ value: "none", label: "None" }, { value: "float", label: "Float" }, { value: "spin", label: "Spin" }, { value: "pulse", label: "Pulse" }]} />
          {c.motion.type !== "none" && (
            <>
              <SliderField label="Amount" value={c.motion.amount} min={0} max={0.2} step={0.002} onChange={(v) => up((x) => ((x as ImageLayerComponent).motion.amount = v))} />
              <SliderField label="Speed" value={c.motion.speed} min={0.01} max={2} step={0.01} onChange={(v) => up((x) => ((x as ImageLayerComponent).motion.speed = v))} />
            </>
          )}
        </Section>
      )}
      <Section title="Entrance / exit">
        <SelectField label="Entrance" value={c.anim.enter} onChange={(v) => up((x) => (x.anim.enter = v))} options={ENTRANCES} />
        <SelectField label="Exit" value={c.anim.exit} onChange={(v) => up((x) => (x.anim.exit = v))} options={ENTRANCES} />
        <SliderField label="Duration" value={c.anim.duration} min={0} max={10} step={0.1} unit="s" onChange={(v) => up((x) => (x.anim.duration = v))} />
      </Section>
      <Section title="Looping walkers">
        <SwitchField label="Walk across" hint="Repeat the layer moving across the frame (people, animals)" value={c.walker.enabled} onChange={(v) => up((x) => (x.walker.enabled = v))} />
        {c.walker.enabled && (
          <>
            <SelectField label="Direction" value={String(c.walker.direction) as "1" | "-1"} onChange={(v) => up((x) => (x.walker.direction = v === "1" ? 1 : -1))} options={[{ value: "1", label: "Left → right" }, { value: "-1", label: "Right → left (mirrored)" }]} />
            <SliderField label="Instances" value={c.walker.instances} min={1} max={12} step={1} onChange={(v) => up((x) => (x.walker.instances = v))} />
            <SliderField label="Speed" value={c.walker.speed} min={0.005} max={c.placement === "world" ? 6 : 0.4} step={0.001} unit={c.placement === "world" ? "m/s" : "w/s"} onChange={(v) => up((x) => (x.walker.speed = v))} />
            <Field label="From / to X">
              <div className="grid grid-cols-2 gap-1">
                <NumberInput value={c.walker.fromX} step={0.05} onChange={(v) => up((x) => (x.walker.fromX = v))} />
                <NumberInput value={c.walker.toX} step={0.05} onChange={(v) => up((x) => (x.walker.toX = v))} />
              </div>
            </Field>
            <Field label="Delay min/max (s)">
              <div className="grid grid-cols-2 gap-1">
                <NumberInput value={c.walker.delayMin} min={0} step={0.5} onChange={(v) => up((x) => (x.walker.delayMin = v))} />
                <NumberInput value={c.walker.delayMax} min={0} step={0.5} onChange={(v) => up((x) => (x.walker.delayMax = v))} />
              </div>
            </Field>
            <SliderField label="Y variation" value={c.walker.yJitter} min={0} max={0.2} step={0.001} onChange={(v) => up((x) => (x.walker.yJitter = v))} />
            <SliderField label="Scale variation" value={c.walker.scaleJitter} min={0} max={0.5} step={0.01} onChange={(v) => up((x) => (x.walker.scaleJitter = v))} />
            <Field label="Random seed">
              <div className="flex gap-1">
                <NumberInput value={c.walker.seed} step={1} onChange={(v) => up((x) => (x.walker.seed = Math.round(v)))} />
                <Button size="xs" variant="outline" onClick={() => up((x) => (x.walker.seed = Math.floor(Math.random() * 1e6)))}>
                  Shuffle
                </Button>
              </div>
            </Field>
          </>
        )}
      </Section>
    </>
  );
}

function ModelForm({ c, up }: { c: ModelComponent; up: Updater<ModelComponent> }) {
  const info = useModelInfo((s) => (c.assetId ? s.byAsset[c.assetId] : undefined));
  return (
    <Section title="3D model">
      <AssetField label="GLB / glTF" type="model" value={c.assetId} onChange={(v) => up((x) => (x.assetId = v))} />
      {info?.error && <p className="text-[11px] text-destructive">Failed to load: {info.error}</p>}
      <Vec3Field label="Position (m)" value={c.position} onChange={(v) => up((x) => (x.position = v))} />
      <Vec3Field label="Rotation (°)" value={c.rotation} step={1} onChange={(v) => up((x) => (x.rotation = v))} />
      <NumberField label="Scale" value={c.scale} step={0.05} min={0.001} onChange={(v) => up((x) => (x.scale = v))} />
      <Field label="Animation clip">
        <SelectBox
          value={c.clip ?? "__first__"}
          onChange={(v) => up((x) => (x.clip = v === "__first__" ? null : v))}
          options={[{ value: "__first__", label: "First clip" }, ...(info?.clips ?? []).map((n) => ({ value: n, label: n }))]}
        />
      </Field>
      <SwitchField label="Loop clip" value={c.loop} onChange={(v) => up((x) => (x.loop = v))} />
      <SwitchField label="Cast shadows" value={c.castShadow} onChange={(v) => up((x) => (x.castShadow = v))} />
      <ColorField label="Tint" value={c.material.tint} onChange={(v) => up((x) => (x.material.tint = v))} />
      <SliderField label="Roughness" value={c.material.roughness ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.material.roughness = v))} />
      <SliderField label="Metalness" value={c.material.metalness ?? 0} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.material.metalness = v))} />
      <SliderField label="Self-glow" value={c.material.emissive} min={0} max={2} step={0.01} onChange={(v) => up((x) => (x.material.emissive = v))} />
    </Section>
  );
}

function LionForm({ c, up, markers }: { c: ActorComponent; up: Updater<ActorComponent>; markers: string[] }) {
  const info = useModelInfo((s) => (c.assetId ? s.byAsset[c.assetId] : undefined));
  return (
    <>
      <Section title="Lion model">
        <AssetField label="Rigged GLB" type="model" value={c.assetId} onChange={(v) => up((x) => (x.assetId = v))} />
        {!c.assetId && (
          <div className="flex gap-2 rounded-md border border-armed/40 bg-armed/10 p-2 text-[11px] leading-snug text-armed">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Using the procedural PLACEHOLDER lion. It exercises every control and cue but is not photoreal. Import a rigged, animated lion GLB (see docs/LION_ASSET.md) and assign it here —
              no other changes are needed.
            </span>
          </div>
        )}
        {info?.error && <p className="text-[11px] text-destructive">Failed to load: {info.error} — showing placeholder.</p>}
        {info && !info.error && info.missing.length > 0 && (
          <p className="text-[11px] text-destructive">Unmapped/missing clips: {info.missing.join(", ")}. Those actions fall back to idle.</p>
        )}
        <NumberField label="Scale" value={c.scale} step={0.05} min={0.01} onChange={(v) => up((x) => (x.scale = v))} />
        <SliderField label="Model yaw fix" value={(c.modelYaw * 180) / Math.PI} min={-180} max={180} step={1} unit="°" onChange={(v) => up((x) => (x.modelYaw = (v * Math.PI) / 180))} />
      </Section>
      {c.assetId && (
        <Section title="Clip mapping">
          {LION_ACTIONS.map((a) => (
            <Field key={a} label={LION_ACTION_INFO[a].label}>
              <SelectBox
                value={c.clipMap[a] && info?.clips.includes(c.clipMap[a]!) ? c.clipMap[a]! : "__none__"}
                onChange={(v) => up((x) => (x.clipMap[a] = v === "__none__" ? undefined : v))}
                options={[{ value: "__none__", label: c.clipMap[a] ? `“${c.clipMap[a]}” not found` : "— unmapped —" }, ...(info?.clips ?? []).map((n) => ({ value: n, label: n }))]}
              />
            </Field>
          ))}
        </Section>
      )}
      <Section title="Movement">
        <Field label="Start marker">
          <SelectBox value={markers.includes(c.start.marker) ? c.start.marker : (markers[0] ?? "center")} onChange={(v) => up((x) => (x.start.marker = v))} options={(markers.length ? markers : ["center"]).map((m) => ({ value: m, label: m }))} />
        </Field>
        <SliderField label="Start heading" value={(c.start.heading * 180) / Math.PI} min={-180} max={180} step={1} unit="°" onChange={(v) => up((x) => (x.start.heading = (v * Math.PI) / 180))} />
        <SliderField label="Walk speed" value={c.speeds.walk} min={0.3} max={4} step={0.05} unit="m/s" onChange={(v) => up((x) => (x.speeds.walk = v))} />
        <SliderField label="Run speed" value={c.speeds.run} min={1} max={14} step={0.1} unit="m/s" onChange={(v) => up((x) => (x.speeds.run = v))} />
        <SliderField label="Turn rate" value={c.speeds.turnRate} min={0.3} max={5} step={0.05} unit="rad/s" onChange={(v) => up((x) => (x.speeds.turnRate = v))} />
        <Field label="Stride walk/run" hint="Metres covered by one full walk/run clip cycle. Tune until the paws stop sliding.">
          <div className="grid grid-cols-2 gap-1">
            <NumberInput value={c.stride.walk} min={0.1} step={0.05} onChange={(v) => up((x) => (x.stride.walk = v))} />
            <NumberInput value={c.stride.run} min={0.1} step={0.05} onChange={(v) => up((x) => (x.stride.run = v))} />
          </div>
        </Field>
        <Field label="Bounds X" hint="Playing area — the lion stops at these limits">
          <div className="grid grid-cols-2 gap-1">
            <NumberInput value={c.bounds.xMin} step={0.5} onChange={(v) => up((x) => (x.bounds.xMin = v))} />
            <NumberInput value={c.bounds.xMax} step={0.5} onChange={(v) => up((x) => (x.bounds.xMax = v))} />
          </div>
        </Field>
        <Field label="Bounds Z">
          <div className="grid grid-cols-2 gap-1">
            <NumberInput value={c.bounds.zMin} step={0.5} onChange={(v) => up((x) => (x.bounds.zMin = v))} />
            <NumberInput value={c.bounds.zMax} step={0.5} onChange={(v) => up((x) => (x.bounds.zMax = v))} />
          </div>
        </Field>
      </Section>
    </>
  );
}

function EffectForm({ c, up }: { c: EffectComponent; up: Updater<EffectComponent> }) {
  const def = EFFECT_DEFS[c.effect];
  const presets = useProject((s) => s.project.effectPresets).filter((p) => p.effect === c.effect);
  return (
    <Section
      title={`${def.label} defaults`}
      right={
        <Button
          size="xs"
          variant="ghost"
          title="Save these settings as a reusable preset for any scene"
          onClick={() => useProject.getState().update((p) => p.effectPresets.push({ id: uid("pre"), name: `${c.name} preset`, effect: c.effect, params: { ...c.params } }))}
        >
          <Save /> Save preset
        </Button>
      }
    >
      {presets.length > 0 && (
        <Field label="Apply preset">
          <SelectBox
            value={c.presetId && presets.some((p) => p.id === c.presetId) ? c.presetId : "__none__"}
            onChange={(v) => {
              const p = presets.find((x) => x.id === v);
              if (p) up((x) => {
                x.params = { ...def.defaults, ...p.params };
                x.presetId = p.id;
              });
            }}
            options={[{ value: "__none__", label: "Custom" }, ...presets.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Field>
      )}
      {def.params.map((p) => {
        const set = (v: number | string | boolean) =>
          up((x) => {
            x.params[p.key] = v;
            x.presetId = null;
          });
        if (p.type === "range") return <SliderField key={p.key} label={p.label} value={num(c.params, p.key, num(def.defaults, p.key))} min={p.min} max={p.max} step={p.step} unit={p.unit} onChange={set} />;
        if (p.type === "color") return <ColorField key={p.key} label={p.label} value={str(c.params, p.key, str(def.defaults, p.key, "#ffffff"))} onChange={set} />;
        if (p.type === "bool") return <SwitchField key={p.key} label={p.label} value={bool(c.params, p.key, bool(def.defaults, p.key))} onChange={set} />;
        return <AssetField key={p.key} label={p.label} type={p.assetType} value={str(c.params, p.key) || null} onChange={(v) => set(v ?? "")} />;
      })}
      <p className="text-[10.5px] text-muted-foreground">These are the values used when the scene goes live; most can also be adjusted live from Show Mode.</p>
    </Section>
  );
}

function ProceduralForm({ c, up }: { c: ProceduralComponent; up: Updater<ProceduralComponent> }) {
  return (
    <Section title={c.element}>
      {c.element !== "campfire" && <SliderField label="Count" value={c.count} min={1} max={c.element === "town-lights" ? 200 : 80} step={1} onChange={(v) => up((x) => (x.count = v))} />}
      <Field label="Centre X / Z (m)">
        <div className="grid grid-cols-2 gap-1">
          <NumberInput value={c.center[0]} step={1} onChange={(v) => up((x) => (x.center = [v, x.center[1]]))} />
          <NumberInput value={c.center[1]} step={1} onChange={(v) => up((x) => (x.center = [x.center[0], v]))} />
        </div>
      </Field>
      {c.element !== "campfire" && <NumberField label="Radius (m)" value={c.radius} min={1} step={1} onChange={(v) => up((x) => (x.radius = v))} />}
      <SliderField label="Fade" value={c.fade} min={0} max={10} step={0.1} unit="s" onChange={(v) => up((x) => (x.fade = v))} />
    </Section>
  );
}

function ClipActorForm({ c, up }: { c: ClipActorComponent; up: Updater<ClipActorComponent> }) {
  const assets = useProject((s) => s.project.assets);
  const upClip = (id: string, fn: (x: ClipActorComponent["clips"][number]) => void) =>
    up((x) => {
      const clip = x.clips.find((k) => k.id === id);
      if (clip) fn(clip);
    });
  return (
    <>
      <Section title="Video actor">
        <p className="text-[10.5px] leading-snug text-muted-foreground">
          Pre-rendered full-frame clips, each tagged with the pose it starts and ends on. A requested clip waits for the current one to finish, so cuts land on matching frames.
        </p>
        <TextField label="Rest pose" value={c.restPose} onChange={(v) => up((x) => (x.restPose = v))} />
        <NumberField label="Frame aspect" value={c.frameAspect} step={0.01} min={0.2} onChange={(v) => up((x) => (x.frameAspect = v))} />
        <p className="-mt-1 pl-[104px] text-[10.5px] text-muted-foreground">Match the background plate (width ÷ height) so frames line up.</p>
        <SelectField<FitMode>
          label="Fit"
          value={c.fit}
          onChange={(v) => up((x) => (x.fit = v))}
          options={[
            { value: "cover", label: "Cover (fill canvas)" },
            { value: "contain", label: "Contain" },
            { value: "stretch", label: "Stretch" },
          ]}
        />
        <SliderField label="Vertical framing" value={c.anchorY ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => up((x) => (x.anchorY = v))} />
        <p className="-mt-1 pl-[104px] text-[10.5px] text-muted-foreground">Keep equal to the plate's vertical framing.</p>
        <SwitchField label="Muted" value={c.muted} onChange={(v) => up((x) => (x.muted = v))} />
      </Section>
      <Section title="Layout (cut-out clips)">
        <SwitchField
          label="Cut-out clips"
          hint="Clips have a transparent background (background removed), so the actor can be scaled, moved and mirrored over the plate"
          value={!!c.matted}
          onChange={(v) =>
            up((x) => {
              x.matted = v;
              x.layout ??= defaultActorLayout();
            })
          }
        />
        {c.matted && (
          <LayoutFields
            layout={c.layout ?? defaultActorLayout()}
            set={(fn) =>
              up((x) => {
                x.layout ??= defaultActorLayout();
                fn(x.layout);
              })
            }
          />
        )}
        {!c.matted && <p className="text-[10.5px] leading-snug text-muted-foreground">Full-frame clips can't be resized independently of their background. Use cut-out clips to scale and place the actor.</p>}
      </Section>
      <Section
        title={`Clips (${c.clips.length})`}
        right={
          <Button size="xs" variant="ghost" onClick={() => up((x) => x.clips.push(makeClip(`Clip ${x.clips.length + 1}`)))}>
            + Add clip
          </Button>
        }
      >
        {c.clips.map((k) => (
          <div key={k.id} className="space-y-1.5 rounded-md border border-border p-2">
            <div className="flex items-center gap-1">
              <div className="flex-1">
                <TextField label="Name" value={k.name} onChange={(v) => upClip(k.id, (x) => (x.name = v))} />
              </div>
              <Button size="xs" variant="ghost" onClick={() => up((x) => (x.clips = x.clips.filter((z) => z.id !== k.id)))}>
                Remove
              </Button>
            </div>
            <AssetField
              label="Video"
              type="video"
              value={k.assetId}
              onChange={async (v) => {
                upClip(k.id, (x) => (x.assetId = v));
                const a = assets.find((z) => z.id === v);
                const d = a ? await probeDuration(a.url) : null;
                if (d) upClip(k.id, (x) => (x.duration = Math.round(d * 100) / 100));
              }}
            />
            <AssetField label="Cut-out video" type="video" value={k.cutoutAssetId ?? null} onChange={(v) => upClip(k.id, (x) => (x.cutoutAssetId = v))} />
            <Field label="Pose start → end">
              <div className="grid grid-cols-2 gap-1">
                <PoseInput value={k.startPose} onChange={(v) => upClip(k.id, (x) => (x.startPose = v))} />
                <PoseInput value={k.endPose} onChange={(v) => upClip(k.id, (x) => (x.endPose = v))} />
              </div>
            </Field>
            <NumberField label="Duration (s)" value={k.duration} min={0.1} step={0.01} onChange={(v) => upClip(k.id, (x) => (x.duration = v))} />
            <SwitchField label="Loop" value={k.loop} onChange={(v) => upClip(k.id, (x) => (x.loop = v))} />
            {k.loop && k.startPose === k.endPose && (
              <SwitchField
                label="Auto idle"
                hint={`Plays automatically whenever another clip finishes on "${k.startPose}", so the actor never freezes`}
                value={!!k.autoIdle}
                onChange={(v) => upClip(k.id, (x) => (x.autoIdle = v))}
              />
            )}
            <SwitchField
              label="Interrupt"
              hint="Cuts in the moment it is cued instead of waiting for the current clip or loop to finish"
              value={!!k.interrupt}
              onChange={(v) => upClip(k.id, (x) => (x.interrupt = v))}
            />
            <MarkersEditor markers={k.markers} onChange={(markers) => upClip(k.id, (x) => (x.markers = markers))} />
          </div>
        ))}
      </Section>
    </>
  );
}

function PoseInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="h-7 rounded-md border border-input bg-transparent px-2 text-[12px]"
      defaultValue={value}
      key={value}
      onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== value && onChange(e.target.value.trim())}
    />
  );
}

function LayoutFields({ layout: L, set }: { layout: import("@/core/types").ActorLayout; set: (fn: (l: import("@/core/types").ActorLayout) => void) => void }) {
  return (
    <>
      <SliderField label="Scale" value={L.scale} min={0.2} max={2} step={0.01} unit="×" onChange={(v) => set((l) => (l.scale = v))} />
      <SliderField label="Move X" value={L.x} min={-0.8} max={0.8} step={0.005} onChange={(v) => set((l) => (l.x = v))} />
      <SliderField label="Move Y" value={L.y} min={-0.5} max={0.5} step={0.005} onChange={(v) => set((l) => (l.y = v))} />
      <SwitchField label="Mirror" value={L.mirror} onChange={(v) => set((l) => (l.mirror = v))} />
      <SwitchField label="Depth-linked size" hint="Smaller also moves the feet toward the horizon, so it reads as further away" value={L.depthLink} onChange={(v) => set((l) => (l.depthLink = v))} />
      <SliderField label="Contact shadow" value={L.shadow} min={0} max={1} step={0.01} onChange={(v) => set((l) => (l.shadow = v))} />
      <Field label="Feet point X/Y" hint="Where the actor touches the ground in the source frame (0–1). Scaling pivots here.">
        <div className="grid grid-cols-2 gap-1">
          <NumberInput value={L.pivotX} min={0} max={1} step={0.01} onChange={(v) => set((l) => (l.pivotX = v))} />
          <NumberInput value={L.pivotY} min={0} max={1} step={0.01} onChange={(v) => set((l) => (l.pivotY = v))} />
        </div>
      </Field>
      <NumberField label="Horizon Y" value={L.horizonY} min={0} max={1} step={0.01} onChange={(v) => set((l) => (l.horizonY = v))} />
    </>
  );
}
