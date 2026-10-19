import { Clock, Film, Hand, Link2, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import { cueMarkers, markerHosts, setHostMarkers } from "@/core/markers";
import type { Cue, CueFire, Scene } from "@/core/types";
import { useProject } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";
import { defaultMessage } from "../io/MessageFields";
import { selectScrubSource } from "../PreviewTools";

type Mode = CueFire["mode"];

/** One line for the cue lists: how this cue fires. */
export function fireLabel(cue: Cue, index: number, scene: Scene): string {
  const f = cue.fire;
  if (!f || f.mode === "go") return "on GO";
  if (f.mode === "time") return `at ${fmtTime(f.at)} into the scene`;
  if (f.mode === "follow") return `${f.after} s after cue ${index}`;
  const m = cueMarkers(scene, cue.id)[0];
  return m ? `when ${m.host.label} reaches ${m.marker.at.toFixed(1)} s` : "on a video time (not set)";
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(s % 1 ? 1 : 0).padStart(s % 1 ? 4 : 2, "0")}`;

export function FireIcon({ cue, className }: { cue: Cue; className?: string }) {
  const m = cue.fire?.mode ?? "go";
  const Icon = m === "time" ? Clock : m === "follow" ? Link2 : m === "video" ? Film : Hand;
  return <Icon className={cn("size-3.5 shrink-0", m === "go" ? "text-muted-foreground" : "text-armed", className)} />;
}

/** The "Fires" row of a cue: on GO, at a scene time, after the previous cue, or at a video time. */
export function FireField({ scene, cue, index }: { scene: Scene; cue: Cue; index: number }) {
  const mode: Mode = cue.fire?.mode ?? "go";
  const hosts = markerHosts(scene);
  const linked = cueMarkers(scene, cue.id);
  const upd = (fn: (s: Scene) => void) => useProject.getState().updateScene(scene.id, fn);
  const setFire = (fire: CueFire) =>
    upd((s) => {
      const c = s.cues.find((x) => x.id === cue.id);
      if (!c) return;
      c.fire = fire.mode === "go" ? undefined : fire;
      // Leaving "video": the markers that fired this cue go with it.
      if (fire.mode !== "video") for (const h of markerHosts(s)) if (h.markers.some((m) => m.cueId === cue.id)) setHostMarkers(s, h.key, h.markers.filter((m) => m.cueId !== cue.id));
    });
  const addLink = (hostKey: string, at = 0) =>
    upd((s) => {
      const h = markerHosts(s).find((x) => x.key === hostKey);
      if (h) setHostMarkers(s, hostKey, [...h.markers, { id: uid("mk"), name: cue.name, at, message: defaultMessage("hog"), cueId: cue.id }]);
    });
  const editLink = (hostKey: string, markerId: string, patch: { at?: number; host?: string }) =>
    upd((s) => {
      const h = markerHosts(s).find((x) => x.key === hostKey);
      const m = h?.markers.find((x) => x.id === markerId);
      if (!h || !m) return;
      if (patch.host && patch.host !== hostKey) {
        setHostMarkers(s, hostKey, h.markers.filter((x) => x.id !== markerId));
        const to = markerHosts(s).find((x) => x.key === patch.host);
        if (to) setHostMarkers(s, patch.host, [...to.markers, m]);
      } else setHostMarkers(s, hostKey, h.markers.map((x) => (x.id === markerId ? { ...x, at: patch.at ?? x.at } : x)));
    });
  const removeLink = (hostKey: string, markerId: string) =>
    upd((s) => {
      const h = markerHosts(s).find((x) => x.key === hostKey);
      if (h) setHostMarkers(s, hostKey, h.markers.filter((x) => x.id !== markerId));
    });

  const options: { value: Mode; label: string }[] = [
    { value: "go", label: "On GO" },
    { value: "time", label: "At a scene time" },
    ...(index > 0 ? [{ value: "follow" as const, label: `After cue ${index} fires` }] : []),
    { value: "video", label: "When a video reaches a time" },
  ];
  const hostOpts = hosts.map((h) => ({ value: h.key, label: h.label }));

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="flex items-center gap-1 text-muted-foreground">
        <Zap className="size-3.5" /> Fires
      </span>
      <SelectBox
        className="h-6 w-[190px] text-[11px]"
        value={mode}
        onChange={(m) => {
          if (m === "go") setFire({ mode: "go" });
          else if (m === "time") setFire({ mode: "time", at: 10 });
          else if (m === "follow") setFire({ mode: "follow", after: 2 });
          else {
            setFire({ mode: "video" });
            if (!linked.length && hosts[0]) addLink(hosts[0].key);
          }
        }}
        options={options}
      />
      {cue.fire?.mode === "time" && (
        <>
          <NumberInput className="h-6 w-16 text-[11px]" value={cue.fire.at} min={0} step={0.5} onChange={(at) => setFire({ mode: "time", at })} />
          <span className="text-muted-foreground">s after the scene is taken ({fmtTime(cue.fire.at)})</span>
        </>
      )}
      {cue.fire?.mode === "follow" && (
        <>
          <NumberInput className="h-6 w-14 text-[11px]" value={cue.fire.after} min={0} step={0.5} onChange={(after) => setFire({ mode: "follow", after })} />
          <span className="text-muted-foreground">s after cue {index}</span>
        </>
      )}
      {mode === "video" && (
        <div className="basis-full space-y-1 pl-5">
          {!hosts.length && <p className="text-muted-foreground">This scene has no video or video-actor clip yet.</p>}
          {linked.map(({ host, marker }) => (
            <div key={marker.id} className="flex flex-wrap items-center gap-1.5">
              <Film className="size-3.5 text-preview" />
              <SelectBox className="h-6 w-[200px] text-[11px]" value={host.key} onChange={(k) => editLink(host.key, marker.id, { host: k })} options={hostOpts} />
              <span className="text-muted-foreground">at</span>
              <NumberInput className="h-6 w-16 text-[11px]" value={marker.at} min={0} step={0.1} onChange={(at) => editLink(host.key, marker.id, { at })} />
              <span className="text-muted-foreground">s</span>
              <Button size="xs" variant="ghost" className="h-6 text-muted-foreground" title="Show this video on the timeline under the preview" onClick={() => selectScrubSource(host.key)}>
                Show on timeline
              </Button>
              <Button size="icon-xs" variant="ghost" className="hover:text-destructive" aria-label="Remove" onClick={() => removeLink(host.key, marker.id)}>
                <Trash2 />
              </Button>
            </div>
          ))}
          {hosts.length > 0 && (
            <Button size="xs" variant="ghost" className="h-6 text-muted-foreground" onClick={() => addLink(hosts[0].key)}>
              <Plus /> {linked.length ? "Another video time" : "Pick a video and time"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
