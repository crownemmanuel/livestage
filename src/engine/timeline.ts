// The Build timeline's layout (core/timeline.ts) with the app's own media lengths and names, for
// the timeline panel and the agent's `timeline` / `preview_time` commands.

import { sceneTimeline, type SceneTimeline, type TimelineEnv } from "@/core/timeline";
import type { Asset, Scene } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { describeMessage } from "./io";
import { audioRoleOf } from "./mixer";
import { knownDuration, probeDurations } from "./transport";

export function timelineEnv(assets: Asset[], scenes: Scene[]): TimelineEnv {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return {
    duration: (id) => knownDuration(id),
    assetName: (id) => byId.get(id)?.name ?? "missing sound",
    audioRole: (id) => audioRoleOf(byId.get(id)),
    describeMessage,
    sceneName: (id) => scenes.find((x) => x.id === id)?.name ?? "missing scene",
  };
}

/** Sounds and videos whose length the layout uses. */
export function timelineAssetIds(scene: Scene): string[] {
  const ids = new Set<string>();
  for (const cue of scene.cues)
    for (const a of cue.actions)
      if (a.type === "sound") {
        if (a.assetId) ids.add(a.assetId);
        if (a.fadeOthers && a.fadeOthers.which !== "all") for (const k of a.fadeOthers.which) if (k.startsWith("sound:")) ids.add(k.slice(6));
      }
  for (const c of scene.components) if ((c.kind === "background" || c.kind === "video") && c.media.assetId) ids.add(c.media.assetId);
  return [...ids];
}

/** Lay a scene out, measuring its media first. */
export async function layoutScene(scene: Scene): Promise<SceneTimeline> {
  const assets = useShow.getState().assets;
  await probeDurations(assets, timelineAssetIds(scene));
  return sceneTimeline(scene, timelineEnv(assets, useProject.getState().project.scenes));
}
