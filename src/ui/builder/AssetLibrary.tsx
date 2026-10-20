import { useMemo, useState } from "react";
import { AudioLines, Box, Check, ChevronDown, Film, Image as ImageIcon, Maximize2, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { importAssets, playableUrl } from "@/core/platform";
import type { Asset, AssetType } from "@/core/types";
import { useProject } from "@/store/project";
import { useAssetInfo } from "../assetThumbs";
import { MediaBadge } from "./MediaBadge";
import { ingestAssets } from "@/engine/media";

const TYPE_ICON: Record<AssetType, typeof Film> = { video: Film, image: ImageIcon, audio: AudioLines, model: Box };

const fmtDur = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/** Asset ids referenced anywhere in the show. */
function useUsedAssets() {
  const scenes = useProject((s) => s.project.scenes);
  const assets = useProject((s) => s.project.assets);
  return useMemo(() => {
    // Ids come in more than one shape (imported vs built-in), so look each one up as a quoted value.
    const json = JSON.stringify(scenes.map((s) => ({ ...s, thumbnail: null })));
    return new Set(assets.filter((a) => json.includes(`"${a.id}"`)).map((a) => a.id));
  }, [scenes, assets]);
}

function useImport() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const a = await importAssets();
      // Lands in the library at once; videos are probed and, when the wall would not play them well, re-encoded.
      if (a.length) await ingestAssets(a);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** Small picture of an asset: its frame / image, or a type icon. Videos play while hovered (large only). */
export function AssetThumb({ asset, className, playOnHover = false }: { asset: Asset; className?: string; playOnHover?: boolean }) {
  const info = useAssetInfo(asset);
  const [hover, setHover] = useState(false);
  const Icon = TYPE_ICON[asset.type];
  return (
    <div className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded bg-black/60 text-muted-foreground", className)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {playOnHover && hover && asset.type === "video" ? (
        <video src={playableUrl(asset) ?? undefined} className="h-full w-full object-contain" autoPlay muted loop playsInline />
      ) : info?.src ? (
        <img src={info.src} alt="" className="h-full w-full object-contain" draggable={false} />
      ) : (
        <Icon className="size-4 opacity-60" />
      )}
      {asset.type === "video" && info?.duration ? <span className="absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 text-[9.5px] tabular text-white">{fmtDur(info.duration)}</span> : null}
    </div>
  );
}

/** Sidebar library: thumbnails, import, and a button that opens the big browser. */
export function AssetLibrary() {
  const assets = useProject((s) => s.project.assets);
  const used = useUsedAssets();
  const [busy, doImport] = useImport();
  const [big, setBig] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Asset library</h2>
        <span className="text-[10.5px] text-muted-foreground">{assets.length}</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" title="Open the library large" aria-label="Expand library" onClick={() => setBig(true)}>
          <Maximize2 />
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void doImport()}>
          <Upload /> {busy ? "Importing…" : "Import"}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-px px-2 pb-2">
          {assets.map((a) => (
            <li key={a.id} className="group flex items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-accent/50">
              <AssetThumb asset={a} className="h-7 w-12" />
              <span className="min-w-0 flex-1 truncate" title={a.path ?? a.name}>
                {a.name}
              </span>
              {a.ephemeral && <span className="text-[9.5px] text-armed" title="Imported in the browser: available until reload">session</span>}
              <MediaBadge asset={a} />
              {!used.has(a.id) && !a.builtIn && (
                <button className="hidden text-muted-foreground hover:text-destructive group-hover:block" onClick={() => useProject.getState().removeAsset(a.id)} aria-label="Remove asset">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
          {assets.length === 0 && (
            <li className="px-2 py-3 text-[11.5px] leading-snug text-muted-foreground">
              Import images, videos (MP4, WebM with alpha, HEVC alpha .mov), GLB/glTF models and audio. Files are copied into the show library; a video the wall would not play well is re-encoded for it.
            </li>
          )}
        </ul>
      </ScrollArea>
      <AssetBrowser open={big} onOpenChange={setBig} />
    </div>
  );
}

const FILTERS: { value: AssetType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Videos" },
  { value: "image", label: "Images" },
  { value: "audio", label: "Audio" },
  { value: "model", label: "3D models" },
];

/** Choosing media for a field: which kinds fit, what is chosen now, and where the choice goes. */
export interface AssetPick {
  types: AssetType[];
  value: string | null;
  onPick: (id: string | null) => void;
  title?: string;
}

/**
 * The library large: a searchable grid of thumbnails; videos play while hovered. With `pick`
 * it is a chooser: only fitting kinds show, a click picks and closes, "None" clears.
 */
export function AssetBrowser({ open, onOpenChange, pick }: { open: boolean; onOpenChange: (o: boolean) => void; pick?: AssetPick }) {
  const assets = useProject((s) => s.project.assets);
  const used = useUsedAssets();
  const [busy, doImport] = useImport();
  const [q, setQ] = useState("");
  const [type, setType] = useState<AssetType | "all">("all");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const query = q.trim().toLowerCase();
  const allowed = (a: Asset) => !pick || pick.types.includes(a.type);
  const shown = assets.filter((a) => allowed(a) && (type === "all" || a.type === type) && (!query || a.name.toLowerCase().includes(query)) && (!unusedOnly || !used.has(a.id)));
  const filters = pick ? FILTERS.filter((f) => f.value === "all" || pick.types.includes(f.value)) : FILTERS;
  const choose = (id: string | null) => {
    pick?.onPick(id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[84vh] flex-col sm:max-w-[min(1200px,94vw)]">
        <DialogHeader>
          <DialogTitle>{pick ? (pick.title ?? "Choose media") : "Asset library"}</DialogTitle>
          <DialogDescription>{pick ? "Click to choose. Hover a video to play it." : "Every picture, video, sound and model in the show. Hover a video to play it."}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-8 w-[260px] items-center gap-2 rounded-md border border-border bg-well px-2 text-muted-foreground focus-within:border-ring">
            <Search className="size-3.5 shrink-0" />
            <input className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70" placeholder="Find an asset" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label="Clear search">
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <div className="flex gap-1">
            {filters.length > 2 && filters.map((f) => (
              <Button key={f.value} size="xs" variant={type === f.value ? "secondary" : "ghost"} className="h-7" onClick={() => setType(f.value)}>
                {f.label}
              </Button>
            ))}
          </div>
          <Button size="xs" variant={unusedOnly ? "secondary" : "ghost"} className="h-7" onClick={() => setUnusedOnly(!unusedOnly)}>
            Not used yet
          </Button>
          <span className="text-[11.5px] text-muted-foreground">{shown.length} shown</span>
          {pick && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => choose(null)}>
              <X /> None
            </Button>
          )}
          <Button size="sm" variant="outline" className={pick ? "" : "ml-auto"} disabled={busy} onClick={() => void doImport()}>
            <Upload /> {busy ? "Importing…" : "Import"}
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-3 pb-2 pr-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {shown.map((a) => {
              const Icon = TYPE_ICON[a.type];
              const isUsed = used.has(a.id);
              return (
                <div
                  key={a.id}
                  className={cn("group overflow-hidden rounded-lg border bg-card/50", pick ? "cursor-pointer hover:border-preview/70" : "", pick?.value === a.id ? "border-preview ring-2 ring-preview/60" : "border-border")}
                  onClick={pick ? () => choose(a.id) : undefined}
                >
                  <AssetThumb asset={a} className="aspect-video w-full rounded-none" playOnHover />
                  <div className="flex items-start gap-1.5 p-2">
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[12px] font-medium leading-snug" title={a.path ?? a.name}>
                        {a.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                        <span className={isUsed ? "text-preview" : ""}>{isUsed ? "in the show" : "not used"}</span>
                        {a.builtIn && <span>· built-in</span>}
                        {a.ephemeral && <span className="text-armed">· until reload</span>}
                        <MediaBadge asset={a} detail />
                      </div>
                    </div>
                    {pick?.value === a.id && <Check className="mt-0.5 size-4 shrink-0 text-preview" />}
                    {!pick && !isUsed && !a.builtIn && (
                      <Button size="icon-xs" variant="ghost" className="opacity-0 hover:text-destructive group-hover:opacity-100" aria-label="Remove asset" title="Remove from the library" onClick={() => useProject.getState().removeAsset(a.id)}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && <p className="col-span-full py-10 text-center text-[12px] text-muted-foreground">Nothing matches.</p>}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** A media field: shows the chosen asset's thumbnail and name; click opens the library to choose. */
export function AssetPickerButton({ types, value, onChange, placeholder = "Choose media…", className, title }: { types: AssetType[]; value: string | null; onChange: (id: string | null) => void; placeholder?: string; className?: string; title?: string }) {
  const asset = useProject((s) => (value ? s.project.assets.find((a) => a.id === value) : undefined));
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-1.5 text-left text-[12px] hover:bg-accent/40", className)}
      >
        {asset ? <AssetThumb asset={asset} className="h-6 w-10" /> : <span className="grid h-6 w-10 place-items-center rounded bg-black/40 text-muted-foreground">{types.length === 1 ? (() => { const I = TYPE_ICON[types[0]]; return <I className="size-3.5" />; })() : <Film className="size-3.5" />}</span>}
        <span className={cn("min-w-0 flex-1 truncate", !asset && "text-muted-foreground")}>{asset ? asset.name : value ? "missing asset" : placeholder}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </button>
      <AssetBrowser open={open} onOpenChange={setOpen} pick={{ types, value, onPick: onChange, title }} />
    </>
  );
}
