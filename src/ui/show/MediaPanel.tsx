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
  if (item.asset?.type === "image") return <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />;
  if (item.asset?.type === "video") return <video src={`${url}#t=0.6`} preload="metadata" muted playsInline className="absolute inset-0 h-full w-full object-cover" />;
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
    <ul className="space-y-1.5 px-3 pb-3">
      {list.map((it) => {
        const I = ICON[it.kind];
        const scrubbing = effective === it.scrubKey && !!it.scrubKey;
        return (
          <li key={it.key}>
            <button
              onClick={() => {
                if (it.backgroundId && !it.active) useShow.getState().dispatch("preview", { type: "background", backgroundId: it.backgroundId, delay: 0 });
                if (it.scrubKey) selectScrubSource(it.scrubKey);
              }}
              title={it.scrubKey ? "Scrub this video in the preview" : it.backgroundId ? "Show this plate in the preview" : it.name}
              className={cn(
                "relative flex w-full items-center gap-3 overflow-hidden rounded-lg border p-1.5 pr-3 text-left transition-colors",
                scrubbing ? "border-preview/70 bg-preview/[0.07]" : "border-border bg-card/60 hover:bg-card",
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
              {it.active && (
                <span className="flex shrink-0 items-center gap-1 rounded bg-preview px-1.5 py-0.5 text-[10.5px] font-bold text-black">
                  <Play className="size-2.5 fill-current" /> ON
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
