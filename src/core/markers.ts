// Time markers live on the media they belong to: a video actor's clip, a video layer or a
// video background. These helpers list them per scene so the timeline and the run sheet can
// show and edit them in one place.

import type { MediaMarker, Scene } from "./types";

export interface MarkerHost {
  /** "compId" or "compId:clipId" (same keys as the preview scrubber's sources). */
  key: string;
  label: string;
  compId: string;
  clipId: string | null;
  markers: MediaMarker[];
}

/** Every clip / video in the scene that can carry markers, in component order. */
export function markerHosts(scene: Scene): MarkerHost[] {
  const out: MarkerHost[] = [];
  for (const c of scene.components) {
    if (c.kind === "clipActor") {
      for (const k of c.clips) out.push({ key: `${c.id}:${k.id}`, label: `${c.name} · ${k.name}`, compId: c.id, clipId: k.id, markers: k.markers ?? [] });
    } else if (c.kind === "video" || (c.kind === "background" && c.source === "media")) {
      out.push({ key: c.id, label: c.kind === "background" ? `${c.name} (background)` : c.name, compId: c.id, clipId: null, markers: c.media.markers ?? [] });
    }
  }
  return out;
}

/** Replace the markers of one host inside a scene draft. */
export function setHostMarkers(scene: Scene, key: string, markers: MediaMarker[]) {
  const [compId, clipId] = key.split(":");
  const c = scene.components.find((x) => x.id === compId);
  if (!c) return;
  if (c.kind === "clipActor") {
    const k = c.clips.find((x) => x.id === clipId);
    if (k) k.markers = markers;
  } else if (c.kind === "video" || c.kind === "background") {
    c.media.markers = markers;
  }
}

/** The markers (with their host) that fire a given cue. */
export function cueMarkers(scene: Scene, cueId: string): { host: MarkerHost; marker: MediaMarker }[] {
  return markerHosts(scene).flatMap((host) => host.markers.filter((m) => m.cueId === cueId).map((marker) => ({ host, marker })));
}
