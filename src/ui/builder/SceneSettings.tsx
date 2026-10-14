import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EnvironmentPreset, Scene, TransitionKind } from "@/core/types";
import { useProject } from "@/store/project";
import { AssetField, ColorField, Field, NumberField, NumberInput, Section, SelectField, SliderField, SwitchField, TextField } from "../fields";
import { defaultCameraMotion, defaultLook, defaultPlateLight } from "@/core/factories";
import type { LookSettings } from "@/core/types";
import { TRANSITIONS } from "../show/ShowMode";

export function SceneSettings({ scene }: { scene: Scene }) {
  const up = (fn: (s: Scene) => void) => useProject.getState().updateScene(scene.id, fn);
  const markers = Object.entries(scene.markers);
  return (
    <div className="grid grid-cols-2 gap-x-2">
      <div>
        <Section title="Scene">
          <TextField label="Name" value={scene.name} onChange={(v) => up((s) => (s.name = v))} />
          <Field label="Notes">
            <textarea
              className="h-16 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 text-[12px]"
              defaultValue={scene.notes}
              key={scene.id}
              onBlur={(e) => e.target.value !== scene.notes && up((s) => (s.notes = e.target.value))}
            />
          </Field>
          <NumberField label="Duration (s)" value={scene.duration ?? 0} min={0} step={5} onChange={(v) => up((s) => (s.duration = v > 0 ? v : null))} />
          <SelectField<EnvironmentPreset>
            label="3D environment"
            value={scene.environment}
            onChange={(v) => up((s) => (s.environment = v))}
            options={[
              { value: "lion-hills", label: "Wilderness hills (lion encounter)" },
              { value: "shepherd-valley", label: "Shepherd's valley (pasture)" },
              { value: "shepherd-photoreal", label: "Shepherd's valley · photoreal (photo-based)" },
              { value: "none", label: "None — media plates only" },
            ]}
          />
        </Section>
        <Section title="Default transition into this scene">
          <SelectField<TransitionKind> label="Type" value={scene.transition.kind} onChange={(v) => up((s) => (s.transition.kind = v))} options={TRANSITIONS} />
          {scene.transition.kind !== "cut" && scene.transition.kind !== "video" && (
            <SliderField label="Duration" value={scene.transition.duration} min={0.1} max={20} step={0.1} unit="s" onChange={(v) => up((s) => (s.transition.duration = v))} />
          )}
          {scene.transition.kind === "video" && (
            <AssetField label="Travel video" type="video" value={scene.transition.videoAssetId} onChange={(v) => up((s) => (s.transition.videoAssetId = v))} />
          )}
          {scene.transition.kind === "travel" && (
            <SliderField label="Flight distance" value={scene.transition.travelDistance} min={10} max={300} step={5} unit="m" onChange={(v) => up((s) => (s.transition.travelDistance = v))} />
          )}
          {scene.transition.kind === "wipe" && (
            <SelectField
              label="Comes from"
              value={scene.transition.direction ?? "left"}
              onChange={(v) => up((s) => (s.transition.direction = v))}
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
                { value: "up", label: "Top" },
                { value: "down", label: "Bottom" },
              ]}
            />
          )}
          {(scene.transition.kind === "wipe" || scene.transition.kind === "burn") && (
            <SliderField label="Edge softness" value={scene.transition.softness ?? 0.3} min={0} max={1} step={0.01} onChange={(v) => up((s) => (s.transition.softness = v))} />
          )}
          <AssetField label="Transition audio" type="audio" value={scene.transition.audioAssetId} onChange={(v) => up((s) => (s.transition.audioAssetId = v))} />
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Video transitions play full-frame; the destination scene loads underneath and is revealed as the video ends, so there is no black frame.
          </p>
        </Section>
      </div>
      <div>
        <CameraMotionSection scene={scene} up={up} />
        {scene.environment === "none" && <PlateLightSection scene={scene} up={up} />}
        <LookSection scene={scene} up={up} />
        <Section
          title="Stage markers (x, z metres)"
          right={
            <Button size="xs" variant="ghost" onClick={() => up((s) => (s.markers[`mark${Object.keys(s.markers).length + 1}`] = [0, -10]))}>
              <Plus /> Add
            </Button>
          }
        >
          <p className="text-[10.5px] leading-snug text-muted-foreground">Named positions the lion can be placed at or walk to from cues. x: left/right, z: negative is away from the audience.</p>
          {markers.map(([name, [x, z]]) => (
            <div key={name} className="grid grid-cols-[1fr_64px_64px_24px] items-center gap-1">
              <MarkerName
                name={name}
                onRename={(n) =>
                  up((s) => {
                    if (!n || s.markers[n]) return;
                    s.markers[n] = s.markers[name];
                    delete s.markers[name];
                    for (const c of s.cues) for (const a of c.actions) if ("marker" in a && a.marker === name) a.marker = n;
                    for (const c of s.components) if (c.kind === "actor" && c.start.marker === name) c.start.marker = n;
                  })
                }
              />
              <NumberInput value={x} step={0.5} onChange={(v) => up((s) => (s.markers[name] = [v, s.markers[name][1]]))} />
              <NumberInput value={z} step={0.5} onChange={(v) => up((s) => (s.markers[name] = [s.markers[name][0], v]))} />
              <Button size="icon-xs" variant="ghost" aria-label="Delete marker" onClick={() => up((s) => delete s.markers[name])}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

function MarkerName({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  return (
    <input
      className="h-7 rounded-md border border-input bg-transparent px-2 text-[12px]"
      defaultValue={name}
      key={name}
      onBlur={(e) => e.target.value.trim() !== name && onRename(e.target.value.trim())}
    />
  );
}

function CameraMotionSection({ scene, up }: { scene: Scene; up: (fn: (s: Scene) => void) => void }) {
  const cm = scene.cameraMotion ?? defaultCameraMotion();
  const set = (fn: (c: NonNullable<Scene["cameraMotion"]>) => void) =>
    up((s) => {
      s.cameraMotion ??= defaultCameraMotion();
      fn(s.cameraMotion);
    });
  return (
    <Section title="Camera feel">
      <SliderField label="Hand-held sway" value={cm.sway} min={0} max={1} step={0.01} onChange={(v) => set((c) => (c.sway = v))} />
      <SliderField label="Sway speed" value={cm.speed} min={0.02} max={0.5} step={0.01} unit="Hz" onChange={(v) => set((c) => (c.speed = v))} />
      <p className="text-[10.5px] leading-snug text-muted-foreground">
        A little drift keeps a still plate alive. On flat plates it needs a Parallax value on the background (Inspector) to show; cut-out actors then drift more than the plate, which reads as depth.
      </p>
    </Section>
  );
}

function PlateLightSection({ scene, up }: { scene: Scene; up: (fn: (s: Scene) => void) => void }) {
  const pl = scene.plateLight ?? defaultPlateLight();
  const set = (fn: (c: NonNullable<Scene["plateLight"]>) => void) =>
    up((s) => {
      s.plateLight ??= defaultPlateLight();
      fn(s.plateLight);
    });
  return (
    <Section title="3D lighting over the plate">
      <p className="text-[10.5px] leading-snug text-muted-foreground">Match the key light to the footage so 3D models and the lion sit in the picture. Azimuth 0° lights from the audience, 90° from stage right.</p>
      <SliderField label="Key azimuth" value={pl.azimuth} min={-180} max={180} step={1} unit="°" onChange={(v) => set((c) => (c.azimuth = v))} />
      <SliderField label="Key elevation" value={pl.elevation} min={2} max={89} step={1} unit="°" onChange={(v) => set((c) => (c.elevation = v))} />
      <ColorField label="Key colour" value={pl.color} onChange={(v) => set((c) => (c.color = v))} />
      <SliderField label="Key intensity" value={pl.intensity} min={0} max={8} step={0.05} onChange={(v) => set((c) => (c.intensity = v))} />
      <ColorField label="Ambient colour" value={pl.ambient} onChange={(v) => set((c) => (c.ambient = v))} />
      <SliderField label="Ambient" value={pl.ambientIntensity} min={0} max={3} step={0.05} onChange={(v) => set((c) => (c.ambientIntensity = v))} />
      <SliderField label="Contact shadow" value={pl.shadow} min={0} max={1} step={0.01} onChange={(v) => set((c) => (c.shadow = v))} />
    </Section>
  );
}

function LookSection({ scene, up }: { scene: Scene; up: (fn: (s: Scene) => void) => void }) {
  const L = scene.look ?? { ...defaultLook(), enabled: false };
  const set = (fn: (l: LookSettings) => void) =>
    up((s) => {
      s.look ??= { ...defaultLook(), enabled: false };
      fn(s.look);
    });
  return (
    <Section title="Camera look (HDR finish)">
      <SwitchField label="Enabled" hint="Render in HDR with bloom and a filmic grade, like a cinema camera" value={L.enabled} onChange={(v) => set((l) => (l.enabled = v))} />
      {L.enabled && (
        <>
          <SliderField label="Exposure" value={L.exposure} min={0.3} max={2.5} step={0.01} onChange={(v) => set((l) => (l.exposure = v))} />
          <SliderField label="Bloom" value={L.bloom} min={0} max={1.5} step={0.01} onChange={(v) => set((l) => (l.bloom = v))} />
          <SliderField label="Bloom threshold" value={L.bloomThreshold} min={0.2} max={2} step={0.01} onChange={(v) => set((l) => (l.bloomThreshold = v))} />
          <SliderField label="Contrast" value={L.contrast} min={0.7} max={1.4} step={0.01} onChange={(v) => set((l) => (l.contrast = v))} />
          <SliderField label="Saturation" value={L.saturation} min={0.5} max={1.5} step={0.01} onChange={(v) => set((l) => (l.saturation = v))} />
          <SliderField label="Warmth" value={L.warmth} min={-1} max={1} step={0.01} onChange={(v) => set((l) => (l.warmth = v))} />
          <SliderField label="Vignette" value={L.vignette} min={0} max={1} step={0.01} onChange={(v) => set((l) => (l.vignette = v))} />
          <SliderField label="Film grain" value={L.grain} min={0} max={0.15} step={0.001} onChange={(v) => set((l) => (l.grain = v))} />
        </>
      )}
    </Section>
  );
}
