// The scene's media as a list of cards (ProPresenter-style), stacked like layers: the top of the
// list is in front. The ON/OFF pill sets what the scene starts with, so what the preview shows is
// what TAKE puts on the wall. Clicking a video makes it the one the scrub bar moves through.
import { Clapperboard, EyeOff, Film, Image as ImageIcon, Music, Play, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { playableUrl } from "@/core/platform";
import type { Asset, AssetType, Scene, SceneComponent, SceneRuntime } from "@/core/types";
import { useShow } from "@/store/show";
import { useProject } from "@/store/project";
import { assignMedia, componentFor, mediaSlot, NEW_FROM_DROP, useMediaDrop } from "../mediaDrop";
import { selectScrubSource, useAssetDurations, useScrubSelection, videoSources } from "../PreviewTools";

interface Item {
  key: string;
  name: string;
  sub: string;
  asset: Asset | undefined;
  kind: "video" | "image" | "clip" | "audio";
  duration?: number;
  active: boolean;
  scrubKey: string | null;
  /** The layer pill: whether the scene starts with this on, and how to flip it (absent: no pill). */
  layer?: { on: boolean; showing: boolean; canHide: boolean; set: (on: boolean) => void };
  /** What a drop onto this card sets: the kinds it takes and where the chosen asset goes. */
  drop?: { types: AssetType[]; assign: (assetId: string) => void };
}

function items(rt: SceneRuntime, assets: Asset[]): Item[] {
  const find = (id: string | null | undefined) => (id ? assets.find((a) => a.id === id) : undefined);
  const scrubbable = new Map(videoSources(rt, assets).map((s) => [s.key, s]));
  const out: Item[] = [];
  const sceneId = rt.scene.id;
  for (const c of rt.scene.components) {
    const slot = mediaSlot(c);
    const drop = slot ? { types: slot, assign: (id: string) => assignMedia(sceneId, c.id, id) } : undefined;
    if (c.kind === "background" && c.source === "media") {
      const a = find(c.media.assetId);
      const isVid = a?.type === "video";
      const on = plateOn(rt.scene, c.id);
      const layer = { on, showing: rt.background.current === c.id, canHide: canHidePlate(rt.scene, c.id), set: (v: boolean) => setPlateOn(sceneId, c.id, v) };
      out.push({ key: c.id, name: c.name, sub: "Background", asset: a, kind: isVid ? "video" : "image", active: rt.background.current === c.id, scrubKey: isVid && scrubbable.has(c.id) ? c.id : null, layer, duration: scrubbable.get(c.id)?.duration, drop });
    } else if (c.kind === "clipActor") {
      for (const k of c.clips) {
        const key = `${c.id}:${k.id}`;
        const a = find(c.matted && k.cutoutAssetId ? k.cutoutAssetId : (k.assetId ?? k.cutoutAssetId));
        // A drop replaces the video the card shows (the cut-out, when the character plays matted).
        const assign = (id: string) =>
          useProject.getState().updateComponent(sceneId, c.id, (x) => {
            const clip = x.kind === "clipActor" ? x.clips.find((y) => y.id === k.id) : undefined;
            if (clip && x.kind === "clipActor" && x.matted && clip.cutoutAssetId) clip.cutoutAssetId = id;
            else if (clip) clip.assetId = id;
          });
        out.push({ key, name: k.name, sub: c.name, asset: a, kind: "clip", active: !!scrubbable.get(key)?.playing, scrubKey: scrubbable.has(key) ? key : null, duration: k.duration, drop: { types: ["video"], assign } });
      }
    } else if (c.kind === "video" || c.kind === "image") {
      const a = find(c.kind === "video" ? c.media.assetId : c.assetId);
      const showing = !!rt.layers[c.id]?.visible;
      const layer = { on: c.initiallyVisible, showing, canHide: true, set: (v: boolean) => setLayerOn(sceneId, c.id, v) };
      out.push({ key: c.id, name: c.name, sub: c.kind === "video" ? "Video layer" : "Image layer", asset: a, kind: c.kind, active: showing, scrubKey: scrubbable.has(c.id) ? c.id : null, layer, duration: scrubbable.get(c.id)?.duration, drop });
    }
  }
  // Sounds used by this scene's cues.
  const sounds = new Set(rt.scene.cues.flatMap((q) => q.actions.flatMap((x) => (x.type === "sound" && x.assetId ? [x.assetId] : []))));
  for (const id of sounds) {
    const a = find(id);
    if (a) out.push({ key: `snd:${id}`, name: a.name, sub: "Sound", asset: a, kind: "audio", active: false, scrubKey: null });
  }
  return out;
}

// ---------------------------------------------------------------- the plate stack

const isBg = (c: SceneComponent) => c.kind === "background";

/** Whether the scene starts with this plate on (with none marked, the first background counts as on). */
function plateOn(scene: Scene, id: string) {
  const c = scene.components.find((x) => x.id === id);
  if (!c) return false;
  return c.initiallyVisible || (!scene.components.some((x) => isBg(x) && x.initiallyVisible) && scene.components.find(isBg)?.id === id);
}

/** Write down the plate a scene with no marked plate falls back to, so switching others on or off keeps it. */
function markFallback(s: Scene) {
  const bgs = s.components.filter(isBg);
  if (bgs.length && !bgs.some((b) => b.initiallyVisible)) bgs[0].initiallyVisible = true;
}

/** A plate may go off unless the scene would then fall back to a picture plate that is off (the wall cannot show "nothing"). */
function canHidePlate(scene: Scene, id: string) {
  const left = scene.components.filter((c) => isBg(c) && c.id !== id && plateOn(scene, c.id));
  if (left.length) return true;
  const first = scene.components.find(isBg);
  return !!first && first.kind === "background" && first.source === "environment" && first.id !== id;
}

function setPlateOn(sceneId: string, id: string, on: boolean) {
  useProject.getState().updateScene(sceneId, (s) => {
    markFallback(s);
    const c = s.components.find((x) => x.id === id);
    if (c) c.initiallyVisible = on;
  });
}

function setLayerOn(sceneId: string, id: string, on: boolean) {
  useProject.getState().updateComponent(sceneId, id, (c) => {
    c.initiallyVisible = on;
  });
  // The preview follows at once, even when a cue has shown or hidden the layer since.
  if (useShow.getState().preview?.scene.id === sceneId) useShow.getState().dispatch("preview", { type: "layer", layerId: id, op: on ? "show" : "hide", delay: 0 });
}

/** A dropped picture or video goes on top of the stack, switched on; the plates under it stay as they were. */
function addOnTop(sceneId: string, c: SceneComponent) {
  useProject.getState().updateScene(sceneId, (s) => {
    if (c.kind === "background") {
      markFallback(s);
      c.initiallyVisible = true;
      const at = s.components.findIndex(isBg);
      s.components.splice(at >= 0 ? at : s.components.length, 0, c);
    } else s.components.push(c);
  });
}

const fmt = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
const ICON = { video: Film, image: ImageIcon, clip: Clapperboard, audio: Music };

function Thumb({ item }: { item: Item }) {
  const url = playableUrl(item.asset);
  if (!url) return <div className="grid h-full place-items-center bg-[repeating-conic-gradient(#ffffff0d_0_25%,transparent_0_50%)] bg-[length:16px_16px] text-[10px] text-muted-foreground">No media yet</div>;
  if (item.asset?.type === "image") return <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />;
  if (item.asset?.type === "video") return <video src={`${url}#t=0.6`} preload="metadata" muted playsInline className="absolute inset-0 h-full w-full object-cover" />;
  const I = ICON[item.kind];
  return (
    <div className="grid h-full place-items-center text-muted-foreground">
      <I className="size-6" />
    </div>
  );
}

/** The Media tab as a drop target: media dropped beside the cards joins the previewed scene as a new plate. */
export function useSceneMediaDrop() {
  return useMediaDrop(NEW_FROM_DROP, (list) => {
    const sceneId = useShow.getState().preview?.scene.id;
    if (!sceneId) return;
    // Reversed so the first of several dropped files ends up on top.
    for (const a of [...list].reverse()) {
      const c = componentFor(a);
      if (c) addOnTop(sceneId, c);
    }
  });
}

export function MediaPanel() {
  const rt = useShow((s) => s.preview);
  const assets = useShow((s) => s.assets);
  const scrubKey = useScrubSelection((s) => s.key);
  const ids = rt ? rt.scene.components.flatMap((c) => (c.kind === "background" || c.kind === "video" ? (c.media.assetId ? [c.media.assetId] : []) : [])) : [];
  useAssetDurations(assets, ids);
  if (!rt) return null;
  const list = items(rt, assets);
  const current = videoSources(rt, assets);
  const effective = scrubKey && current.some((s) => s.key === scrubKey) ? scrubKey : null;
  if (!list.length)
    return (
      <p className="flex flex-col items-center gap-1.5 px-4 py-8 text-center text-[12px] text-muted-foreground">
        <Upload className="size-4" />
        This scene has no media. Drop a video or picture here to add it.
      </p>
    );
  return (
    <ul className="space-y-1.5 px-3 pb-3">
      {list.map((it) => (
        <MediaRow key={it.key} it={it} scrubbing={effective === it.scrubKey && !!it.scrubKey} />
      ))}
    </ul>
  );
}

function MediaRow({ it, scrubbing }: { it: Item; scrubbing: boolean }) {
  const I = ICON[it.kind];
  const { over, dropProps } = useMediaDrop(it.drop?.types ?? [], (list) => it.drop?.assign(list[0].id));
  return (
    <li {...(it.drop ? dropProps : {})}>
      <button
        onClick={() => {
          if (it.scrubKey) selectScrubSource(it.scrubKey);
        }}
        title={it.scrubKey ? "Scrub this video in the preview" : it.name}
        className={cn(
          "relative flex w-full items-center gap-3 overflow-hidden rounded-lg border p-1.5 pr-3 text-left transition-colors",
          scrubbing ? "border-preview/70 bg-preview/[0.07]" : "border-border bg-card/60 hover:bg-card",
          over && "border-preview bg-preview/15 ring-2 ring-preview/60",
        )}
      >
        {scrubbing && <span className="absolute inset-y-0 left-0 w-1 bg-preview" />}
        {/* Fixed box: WebKit ignores aspect-ratio on media inside buttons. */}
        <div className="relative h-[68px] w-[120px] shrink-0 overflow-hidden rounded-md bg-black">
          <Thumb item={it} />
        </div>
        <I className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold leading-tight">{it.name}</div>
          <div className="truncate text-[12px] text-muted-foreground">{it.sub}</div>
        </div>
        {it.duration ? <span className="font-key shrink-0 text-[13px] font-semibold tabular text-muted-foreground">{fmt(it.duration)}</span> : null}
        {it.layer ? <LayerPill layer={it.layer} /> : it.active && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-preview px-1.5 py-0.5 text-[10.5px] font-bold text-black">
            <Play className="size-2.5 fill-current" /> ON
          </span>
        )}
      </button>
    </li>
  );
}

/** ON/OFF like a layer's eye. An ON plate under another ON plate is covered, and says so. */
function LayerPill({ layer }: { layer: NonNullable<Item["layer"]> }) {
  const covered = layer.on && !layer.showing;
  const locked = layer.on && !layer.canHide;
  return (
    <span
      role="switch"
      aria-checked={layer.on}
      title={locked ? "The only plate on: switch another plate on first" : covered ? "On, but covered by the plate above it. Click to switch off" : layer.on ? "Click to switch off (the scene goes live without it)" : "Click to switch on (the scene goes live with it)"}
      onClick={(e) => {
        e.stopPropagation();
        if (!locked) layer.set(!layer.on);
      }}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-bold",
        layer.on ? (covered ? "border border-preview/60 text-preview" : "bg-preview text-black") : "border border-border text-muted-foreground hover:text-foreground",
        locked && "cursor-not-allowed",
      )}
    >
      {layer.on ? <Play className="size-2.5 fill-current" /> : <EyeOff className="size-2.5" />}
      {layer.on ? (covered ? "COVERED" : "ON") : "OFF"}
    </span>
  );
}
