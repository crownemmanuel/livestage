// The scene's media as a grid of cards (ProPresenter-style). Clicking a video makes it the
// one the scrub bar moves through; clicking a background plate switches the preview to it.
import { Clapperboard, Film, Image as ImageIcon, Music, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { playableUrl } from "@/core/platform";
import type { Asset, SceneRuntime } from "@/core/types";
import { useShow } from "@/store/show";
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
  backgroundId?: string;
}

function items(rt: SceneRuntime, assets: Asset[]): Item[] {
  const find = (id: string | null | undefined) => (id ? assets.find((a) => a.id === id) : undefined);
  const scrubbable = new Map(videoSources(rt, assets).map((s) => [s.key, s]));
  const out: Item[] = [];
  for (const c of rt.scene.components) {
    if (c.kind === "background" && c.source === "media") {
      const a = find(c.media.assetId);
      const isVid = a?.type === "video";
      out.push({ key: c.id, name: c.name, sub: "Background", asset: a, kind: isVid ? "video" : "image", active: rt.background.current === c.id, scrubKey: isVid && scrubbable.has(c.id) ? c.id : null, backgroundId: c.id, duration: scrubbable.get(c.id)?.duration });
    } else if (c.kind === "clipActor") {
      for (const k of c.clips) {
        const key = `${c.id}:${k.id}`;
        const a = find(c.matted && k.cutoutAssetId ? k.cutoutAssetId : (k.assetId ?? k.cutoutAssetId));
        out.push({ key, name: k.name, sub: c.name, asset: a, kind: "clip", active: !!scrubbable.get(key)?.playing, scrubKey: scrubbable.has(key) ? key : null, duration: k.duration });
      }
    } else if (c.kind === "video" || c.kind === "image") {
      const a = find(c.kind === "video" ? c.media.assetId : c.assetId);
      out.push({ key: c.id, name: c.name, sub: c.kind === "video" ? "Video layer" : "Image layer", asset: a, kind: c.kind, active: !!rt.layers[c.id]?.visible, scrubKey: scrubbable.has(c.id) ? c.id : null, duration: scrubbable.get(c.id)?.duration });
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

const fmt = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
const ICON = { video: Film, image: ImageIcon, clip: Clapperboard, audio: Music };

function Thumb({ item }: { item: Item }) {
  const url = playableUrl(item.asset);
  if (!url) return <div className="grid h-full place-items-center bg-[repeating-conic-gradient(#ffffff0d_0_25%,transparent_0_50%)] bg-[length:16px_16px] text-[10px] text-muted-foreground">No media yet</div>;
  if (item.asset?.type === "image") return <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />;
  if (item.asset?.type === "video") return <video src={`${url}#t=0.6`} preload="metadata" muted playsInline className="h-full w-full object-cover" />;
  const I = ICON[item.kind];
  return (
    <div className="grid h-full place-items-center text-muted-foreground">
      <I className="size-6" />
    </div>
  );
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
  if (!list.length) return <p className="px-4 py-8 text-center text-[12px] text-muted-foreground">This scene has no media.</p>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2.5 px-3 pb-3">
      {list.map((it) => {
        const I = ICON[it.kind];
        const scrubbing = effective === it.scrubKey && !!it.scrubKey;
        return (
          <button
            key={it.key}
            onClick={() => {
              if (it.backgroundId && !it.active) useShow.getState().dispatch("preview", { type: "background", backgroundId: it.backgroundId, delay: 0 });
              if (it.scrubKey) selectScrubSource(it.scrubKey);
            }}
            title={it.scrubKey ? "Scrub this video in the preview" : it.backgroundId ? "Show this plate in the preview" : it.name}
            className={cn(
              "group overflow-hidden rounded-lg border bg-card text-left transition-all hover:border-foreground/30",
              scrubbing ? "border-preview ring-2 ring-preview/40" : "border-border",
            )}
          >
            <div className="relative aspect-video bg-black">
              <Thumb item={it} />
              {it.active && (
                <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-preview px-1.5 py-px text-[9px] font-bold text-black">
                  <Play className="size-2.5 fill-current" /> ON
                </span>
              )}
              {it.duration ? <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[10px] tabular text-white">{fmt(it.duration)}</span> : null}
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <I className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium leading-tight">{it.name}</div>
                <div className="truncate text-[10.5px] text-muted-foreground">{it.sub}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
