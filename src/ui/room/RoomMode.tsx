import { useLayoutEffect, useRef, useState } from "react";
import { Armchair, Image as ImageIcon, MonitorPlay, Move, Pause, Plus, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { playableUrl } from "@/core/platform";
import { uid } from "@/core/ids";
import { sceneCodes } from "@/core/groups";
import type { Asset, RoomView } from "@/core/types";
import { StageView } from "@/render/StageView";
import { hold } from "@/engine/transport";
import { selectedScene, useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { AssetThumb } from "../builder/AssetLibrary";
import { DEFAULT_WALL, quadMatrix, useRoom } from "./roomStore";

/**
 * Room: what the wall looks like to the audience. A photo of the room (one per lighting state) with the selected
 * scene's preview, or one image or video from the library, drawn onto the photo's LED wall. Loaded only when the
 * mode is opened (OperatorApp lazy-imports it) and it only reads the PREVIEW, so it costs the show nothing.
 */
const NO_VIEWS: RoomView[] = [];

export default function RoomMode() {
  const views = useProject((s) => s.project.roomViews) ?? NO_VIEWS;
  const assets = useProject((s) => s.project.assets);
  const { viewId, assetId, brightness } = useRoom();
  const view = views.find((v) => v.id === viewId) ?? views[0];
  const photo = view && assets.find((a) => a.id === view.assetId);
  const onWall = assetId ? assets.find((a) => a.id === assetId) : undefined;
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <RoomBar view={view} onWall={onWall} editing={editing} setEditing={setEditing} />
      <div className="relative min-h-0 flex-1">
        {view && photo ? (
          <RoomPicture view={view} photo={photo} onWall={onWall} brightness={brightness} editing={editing} />
        ) : (
          <EmptyRoom />
        )}
      </div>
      {views.length > 0 && <RoomStrip views={views} current={view?.id} />}
    </div>
  );
}

/** Top bar: what is on the wall, brightness, the wall outline editor. */
function RoomBar({ view, onWall, editing, setEditing }: { view?: RoomView; onWall?: Asset; editing: boolean; setEditing: (v: boolean) => void }) {
  const scene = useProject(selectedScene);
  const scenes = useProject((s) => s.project.scenes);
  const groups = useProject((s) => s.project.groups);
  const codes = sceneCodes({ scenes, groups });
  const assets = useProject((s) => s.project.assets);
  const brightness = useRoom((s) => s.brightness);
  const pictures = assets.filter((a) => (a.type === "image" || (a.type === "video" && !a.alphaPacked)) && !(useProject.getState().project.roomViews ?? []).some((v) => v.assetId === a.id));
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3 text-[12px]">
      <Armchair className="size-4 text-muted-foreground" />
      <span className="font-semibold">Room</span>
      <span className="text-muted-foreground">On the wall:</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" className="max-w-[420px]">
            {onWall ? <ImageIcon /> : <MonitorPlay />}
            <span className="truncate">{onWall ? onWall.name : `Preview · ${scene ? `${codes.get(scene.id) ?? ""} ${scene.name}`.trim() : "no scene"}`}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] w-[420px] overflow-y-auto">
          <DropdownMenuLabel>A scene (the preview, as it plays)</DropdownMenuLabel>
          {scenes.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onSelect={() => {
                useProject.getState().selectScene(s.id);
                useRoom.setState({ assetId: null });
              }}
            >
              <span className="w-9 shrink-0 tabular text-muted-foreground">{codes.get(s.id)}</span>
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>An image or video from the library</DropdownMenuLabel>
          {pictures.map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => useRoom.setState({ assetId: a.id })}>
              <AssetThumb asset={a} className="h-5 w-10" />
              <span className="truncate">{a.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {!onWall && (
        <Button size="xs" variant="ghost" title="Play or hold the preview (Space)" onClick={() => hold("preview", "toggle")}>
          <Pause /> Play / hold
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Sun className="size-3.5 text-muted-foreground" />
        <Slider className="w-28" min={0.3} max={1.3} step={0.05} value={[brightness]} onValueChange={([v]) => useRoom.setState({ brightness: v })} aria-label="Wall brightness in the picture" />
        {view && (
          <Button size="xs" variant={editing ? "secondary" : "ghost"} title="Drag the four corners onto the photo's LED wall" onClick={() => setEditing(!editing)}>
            <Move /> {editing ? "Done" : "Wall corners"}
          </Button>
        )}
      </div>
    </div>
  );
}

function useBox(ref: React.RefObject<HTMLDivElement | null>) {
  const [s, set] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => set({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    set({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return s;
}

/** The photo, as large as fits, with the wall content warped onto its LED wall. */
function RoomPicture({ view, photo, onWall, brightness, editing }: { view: RoomView; photo: Asset; onWall?: Asset; brightness: number; editing: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const { w: cw, h: ch } = useBox(box);
  const [nat, setNat] = useState({ w: 16, h: 9 });
  const output = useShow((s) => s.output);
  const [drag, setDrag] = useState<[number, number][] | null>(null);
  const src = playableUrl(photo) ?? photo.url;
  const s = Math.min(cw / nat.w, ch / nat.h) || 0;
  const dw = nat.w * s, dh = nat.h * s, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  const wall = drag ?? (view.wall?.length === 4 ? view.wall : DEFAULT_WALL);
  const px = wall.map(([x, y]) => [ox + x * dw, oy + y * dh] as [number, number]);
  // The wall content is laid out at the wall's own proportions, then warped onto the corners.
  const bw = Math.max(64, Math.hypot(px[1][0] - px[0][0], px[1][1] - px[0][1]));
  const bh = (bw * Math.max(16, output.canvasHeight)) / Math.max(16, output.canvasWidth);

  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = box.current!.getBoundingClientRect();
    let cur = wall.map((p) => [...p] as [number, number]);
    const move = (ev: PointerEvent) => {
      cur = cur.map((p, j) => (j === i ? [Math.min(1, Math.max(0, (ev.clientX - rect.left - ox) / dw)), Math.min(1, Math.max(0, (ev.clientY - rect.top - oy) / dh))] : p));
      setDrag(cur);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      useProject.getState().update((p) => {
        const v = p.roomViews?.find((x) => x.id === view.id);
        if (v) v.wall = cur.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
      });
      setDrag(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden">
      <img src={src} alt={view.name} draggable={false} className="absolute select-none" style={{ left: ox, top: oy, width: dw, height: dh }} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {s > 0 && (
        <div className="pointer-events-none absolute left-0 top-0 overflow-hidden" style={{ width: bw, height: bh, transformOrigin: "0 0", transform: quadMatrix(bw, bh, px), filter: brightness !== 1 ? `brightness(${brightness})` : undefined, background: "#000" }}>
          {onWall ? (
            onWall.type === "video" ? (
              <video key={onWall.id} src={playableUrl(onWall) ?? onWall.url} className="h-full w-full object-cover" autoPlay muted loop playsInline />
            ) : (
              <img src={playableUrl(onWall) ?? onWall.url} alt={onWall.name} className="h-full w-full object-cover" />
            )
          ) : (
            <StageView source="preview" maxDpr={1} />
          )}
        </div>
      )}
      {editing && s > 0 && (
        <>
          <svg className="pointer-events-none absolute inset-0" width={cw} height={ch}>
            <polygon points={px.map((p) => p.join(",")).join(" ")} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="6 4" />
          </svg>
          {px.map(([x, y], i) => (
            <div key={i} onPointerDown={startDrag(i)} className="absolute size-4 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-white bg-sky-500 shadow" style={{ left: x, top: y }} title="Drag onto the wall's corner" />
          ))}
        </>
      )}
    </div>
  );
}

/** The room photos (lighting states) along the bottom: pick one, add one from the library, remove one. */
function RoomStrip({ views, current }: { views: RoomView[]; current?: string }) {
  const assets = useProject((s) => s.project.assets);
  return (
    <div className="flex h-[92px] shrink-0 items-center gap-2 overflow-x-auto border-t border-border bg-card px-3">
      {views.map((v) => {
        const a = assets.find((x) => x.id === v.assetId);
        return (
          <div key={v.id} className="group relative shrink-0">
            <button type="button" onClick={() => useRoom.setState({ viewId: v.id })} title={v.name} className={cn("block overflow-hidden rounded-md border-2", v.id === current ? "border-preview" : "border-transparent opacity-70 hover:opacity-100")}>
              {a ? <AssetThumb asset={a} className="h-[54px] w-[108px] rounded-none" /> : <div className="grid h-[54px] w-[108px] place-items-center text-[10px] text-muted-foreground">missing photo</div>}
              <div className="max-w-[108px] truncate px-1 text-left text-[10.5px]">{v.name}</div>
            </button>
            <button
              type="button"
              className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-white group-hover:block"
              aria-label="Remove this room photo"
              title="Remove this room photo (the image stays in the library)"
              onClick={() => useProject.getState().update((p) => void (p.roomViews = (p.roomViews ?? []).filter((x) => x.id !== v.id)))}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <AddRoomPhoto />
    </div>
  );
}

function addRoomView(a: Asset) {
  const id = uid("room");
  useProject.getState().update((p) => {
    p.roomViews = [...(p.roomViews ?? []), { id, name: a.name, assetId: a.id, wall: DEFAULT_WALL.map((c) => [...c] as [number, number]) }];
  });
  useRoom.setState({ viewId: id });
}

function AddRoomPhoto({ big = false }: { big?: boolean }) {
  const images = useProject((s) => s.project.assets).filter((a) => a.type === "image");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={big ? "sm" : "xs"} variant="outline" className="shrink-0">
          <Plus /> Add a room photo
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[60vh] w-[380px] overflow-y-auto">
        <DropdownMenuLabel>Pick a photo of the room (import it into the library first)</DropdownMenuLabel>
        {images.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => addRoomView(a)}>
            <AssetThumb asset={a} className="h-6 w-12" />
            <span className="truncate">{a.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyRoom() {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-md space-y-3 text-[13px] text-muted-foreground">
        <Armchair className="mx-auto size-8" />
        <p>See a scene or an image the way the audience will: add a photo of the room (one per lighting state if you like), then drag its four corners onto the LED wall.</p>
        <AddRoomPhoto big />
      </div>
    </div>
  );
}
