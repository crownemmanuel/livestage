// Drag and drop of media: library items (dragged from the asset library) and files from the
// desktop (copied into the library first) dropped onto a component, a media field or a list.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { importFiles } from "@/core/platform";
import { makeBackground, makeModel } from "@/core/factories";
import type { Asset, AssetType, SceneComponent } from "@/core/types";
import { ingestAssets } from "@/engine/media";
import { useProject } from "@/store/project";

const ASSET_MIME = "application/x-sls-asset";
// The kind travels in the type name too: drag-over handlers may read the types but not the data.
const KIND_MIME = `${ASSET_MIME}-`;

/** Make a library item draggable. */
export function startAssetDrag(e: DragEvent, asset: Asset) {
  e.dataTransfer.setData(ASSET_MIME, asset.id);
  e.dataTransfer.setData(KIND_MIME + asset.type, "");
  e.dataTransfer.setData("text/plain", asset.name);
  e.dataTransfer.effectAllowed = "copy";
}

/** Whether a drag carries media that may fit (files are checked once dropped). */
function carries(dt: DataTransfer, types: AssetType[] | null) {
  if (dt.types.includes("Files")) return true;
  const kind = dt.types.find((t) => t.startsWith(KIND_MIME))?.slice(KIND_MIME.length);
  return !!kind && (!types || types.includes(kind as AssetType));
}

/** The assets a drop brings: the library item, or the dropped files once they are in the library. */
async function droppedAssets(dt: DataTransfer): Promise<Asset[]> {
  // Read everything before the first await: the browser empties the drop data after the event.
  const id = dt.getData(ASSET_MIME);
  const files = Array.from(dt.files);
  if (id) {
    const a = useProject.getState().project.assets.find((x) => x.id === id);
    return a ? [a] : [];
  }
  const imported = await importFiles(files);
  // In the library at once; videos are then checked (and re-encoded if the wall needs it) in the background.
  if (imported.length) void ingestAssets(imported).catch((e) => console.error("Checking dropped media failed", e));
  return imported;
}

/**
 * Drop target for media. `types` limits what it takes (null = anything); `onAssets` gets the
 * fitting dropped assets. Nested targets win: the innermost one under the pointer takes the drop.
 */
export function useMediaDrop(types: AssetType[] | null, onAssets: (assets: Asset[]) => void) {
  const [over, setOver] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Drag-over repeats while the pointer stays, so the highlight simply lapses once it stops arriving.
  const hover = (e: DragEvent) => {
    if (!carries(e.dataTransfer, types)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOver(false), 150);
  };
  return {
    over,
    dropProps: {
      onDragEnter: hover,
      onDragOver: hover,
      onDrop: (e: DragEvent) => {
        if (!carries(e.dataTransfer, types)) return;
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(timer.current);
        setOver(false);
        void droppedAssets(e.dataTransfer)
          .then((list) => {
            const fit = types ? list.filter((a) => types.includes(a.type)) : list;
            if (fit.length) onAssets(fit);
          })
          .catch((err) => console.error("Media drop failed", err));
      },
    },
  };
}

/** A file dropped where nothing takes it must not navigate the operator window away from the show. */
export function guardWindowDrops() {
  const stop = (e: globalThis.DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  };
  window.addEventListener("dragover", stop);
  window.addEventListener("drop", stop);
  return () => {
    window.removeEventListener("dragover", stop);
    window.removeEventListener("drop", stop);
  };
}

/** The media setting a component takes from a drop, if it has one. */
export function mediaSlot(c: SceneComponent): AssetType[] | null {
  switch (c.kind) {
    case "background":
      return c.source === "media" ? ["video", "image"] : null;
    case "video":
      return ["video"];
    case "image":
    case "route":
      return ["image"];
    case "model":
    case "actor":
      return ["model"];
    default:
      return null;
  }
}

/** Put a dropped asset into a component's media setting (see `mediaSlot`). */
export function assignMedia(sceneId: string, compId: string, assetId: string) {
  useProject.getState().updateComponent(sceneId, compId, (c) => {
    if (c.kind === "background" || c.kind === "video") c.media.assetId = assetId;
    else if (c.kind === "image" || c.kind === "route" || c.kind === "model" || c.kind === "actor") c.assetId = assetId;
  });
}

/** A new component showing a dropped asset: a picture or video becomes a background plate. */
export function componentFor(a: Asset): SceneComponent | null {
  const name = a.name.replace(/\.[^.]+$/, "");
  if (a.type === "video" || a.type === "image") {
    const bg = makeBackground(name, { source: "media" });
    bg.media.assetId = a.id;
    return bg;
  }
  if (a.type === "model") return makeModel(name, a.id);
  return null;
}

/** What a drop onto a scene's media adds as new components. */
export const NEW_FROM_DROP: AssetType[] = ["video", "image", "model"];
