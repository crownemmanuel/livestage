import { Eye, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { makeShot } from "@/core/factories";
import { evalCamera } from "@/core/runtime";
import { sceneNow } from "@/core/clock";
import type { CameraShot, Scene } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { Field, NumberField, SelectBox, SelectField, SliderField, TextField, Vec3Field } from "../fields";

export function CameraShots({ scene }: { scene: Scene }) {
  const up = (fn: (s: Scene) => void) => useProject.getState().updateScene(scene.id, fn);
  const upShot = (id: string, fn: (s: CameraShot) => void) =>
    up((s) => {
      const sh = s.cameraShots.find((x) => x.id === id);
      if (sh) fn(sh);
    });
  const actors = scene.components.filter((c) => c.kind === "actor");

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[11px] text-muted-foreground">Saved camera moves. Triggering one glides the virtual camera from wherever it is (carrying its current speed, so moves chain without a kink) to this framing. A shot that follows the lion keeps tracking it after the move.</p>
        <Button
          size="xs"
          variant="outline"
          title="New shot from the preview's current camera"
          onClick={() => {
            const rt = useShow.getState().preview;
            const pose = rt ? evalCamera(rt.camera, sceneNow(rt)) : undefined;
            up((s) => s.cameraShots.push(makeShot(`Shot ${s.cameraShots.length + 1}`, pose ? { pose: structuredClone(pose) } : {})));
          }}
        >
          <Plus /> Add shot
        </Button>
      </div>
      {scene.cameraShots.map((sh) => (
        <div key={sh.id} className={cn("rounded-md border bg-card/40 p-2", scene.defaultShotId === sh.id ? "border-preview/50" : "border-border")}>
          <div className="mb-2 flex items-center gap-1">
            <div className="flex-1">
              <TextField label="Name" value={sh.name} onChange={(v) => upShot(sh.id, (x) => (x.name = v))} />
            </div>
            <Button size="icon-xs" variant="ghost" title="Preview this move" onClick={() => useShow.getState().dispatch("preview", { type: "camera", shotId: sh.id, delay: 0 })}>
              <Eye />
            </Button>
            <Button size="icon-xs" variant="ghost" title="Starting framing for the scene" className={scene.defaultShotId === sh.id ? "text-preview" : ""} onClick={() => up((s) => (s.defaultShotId = sh.id))}>
              <Star />
            </Button>
            <Button size="icon-xs" variant="ghost" title="Delete" disabled={scene.cameraShots.length <= 1} onClick={() => up((s) => {
              s.cameraShots = s.cameraShots.filter((x) => x.id !== sh.id);
              if (s.defaultShotId === sh.id) s.defaultShotId = s.cameraShots[0]?.id ?? null;
            })}>
              <Trash2 />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Vec3Field label="Position" value={sh.pose.position} onChange={(v) => upShot(sh.id, (x) => (x.pose.position = v))} />
            <Vec3Field label="Look at" value={sh.pose.target} onChange={(v) => upShot(sh.id, (x) => (x.pose.target = v))} />
            <SliderField label="Field of view" value={sh.pose.hfov} min={15} max={120} step={1} unit="°" onChange={(v) => upShot(sh.id, (x) => (x.pose.hfov = v))} />
            <NumberField label="Move time (s)" value={sh.duration} min={0} step={0.5} onChange={(v) => upShot(sh.id, (x) => (x.duration = v))} />
            <SelectField label="Easing" value={sh.ease} onChange={(v) => upShot(sh.id, (x) => (x.ease = v))} options={[{ value: "smooth", label: "Smooth (cinematic)" }, { value: "inOut", label: "Ease in-out" }, { value: "out", label: "Ease out" }, { value: "linear", label: "Linear" }]} />
            <Field label="Follow actor">
              <SelectBox
                value={sh.followActorId ?? "__none__"}
                onChange={(v) => upShot(sh.id, (x) => (x.followActorId = v === "__none__" ? null : v))}
                options={[{ value: "__none__", label: "— fixed framing —" }, ...actors.map((a) => ({ value: a.id, label: a.name }))]}
              />
            </Field>
            {sh.followActorId && <Vec3Field label="Offset" value={sh.followOffset} onChange={(v) => upShot(sh.id, (x) => (x.followOffset = v))} />}
          </div>
        </div>
      ))}
    </div>
  );
}
