import { useMemo, useState } from "react";
import { Box, Clapperboard, Copy, Film, Image as ImageIcon, Layers, Mountain, Plus, Sparkles, Trash2, Upload, ArrowUp, ArrowDown, CloudRain, Bird, Type, TreeDeciduous, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { EFFECT_DEFS, EFFECT_TYPES } from "@/core/effects";
import { makeBackground, makeClipActor, makeEffect, makeImageLayer, makeLion, makeModel, makeNames, makeProcedural, makeRoute, makeText, makeVideoLayer } from "@/core/factories";
import { importAssets } from "@/core/platform";
import type { ProceduralElement, SceneComponent } from "@/core/types";
import { StageView } from "@/render/StageView";
import { selectedScene, useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { SceneList, IconBtn } from "../SceneList";
import { useCaptureThumb } from "../show/ShowMode";
import { ControlPanel } from "../show/ControlPanel";
import { Inspector } from "./Inspector";
import { SceneSettings } from "./SceneSettings";
import { CueEditor } from "./CueEditor";
import { CameraShots } from "./CameraShots";
import { FramingBar, FramingOverlay, VideoScrubber } from "../PreviewTools";
import { Splitter, usePaneWidths } from "../kit";

export function BuilderMode() {
  const scene = useProject(selectedScene);
  const capture = useCaptureThumb();
  const output = useShow((s) => s.output);
  const [rightTab, setRightTab] = useState("inspect");
  const [w, setW, reset] = usePaneWidths("build", [290, 400]);
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex min-h-0 shrink-0 flex-col border-r border-border" style={{ width: w[0] }}>
        <div className="min-h-0 flex-[3]">
          <SceneList />
        </div>
        <div className="min-h-0 flex-[2] border-t border-border">
          <AssetLibrary />
        </div>
      </aside>
      <Splitter value={w[0]} onChange={(v) => setW(0, v)} min={200} max={480} onReset={reset} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-border p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[11px]">
            <span className="flex items-center gap-1.5 rounded-full bg-preview/15 px-2 py-0.5 font-key text-[12.5px] font-bold text-preview"><span className="size-2 rounded-full bg-preview" />Preview</span>
            <span className="text-muted-foreground">Edits apply to the preview only. TAKE LIVE in Show Mode to put them on the wall.</span>
          </div>
          <div className="relative mx-auto w-full overflow-hidden rounded-sm ring-2 ring-preview/70" style={{ aspectRatio: `${output.canvasWidth} / ${output.canvasHeight}`, maxHeight: "44vh" }}>
            <StageView source="preview" maxDpr={1.5} showSafeArea onCapture={capture} />
            <FramingOverlay />
          </div>
          <div className="mt-1.5 flex justify-end">
            <FramingBar />
          </div>
          <VideoScrubber />
        </div>
        {scene ? (
          <Tabs defaultValue="scene" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-3 mt-2 h-8">
              <TabsTrigger value="scene" className="text-[12px]">Scene</TabsTrigger>
              <TabsTrigger value="cues" className="text-[12px]">Cues ({scene.cues.length})</TabsTrigger>
              <TabsTrigger value="camera" className="text-[12px]">Camera ({scene.cameraShots.length})</TabsTrigger>
            </TabsList>
            <ScrollArea className="min-h-0 flex-1">
              <TabsContent value="scene">
                <SceneSettings scene={scene} />
              </TabsContent>
              <TabsContent value="cues">
                <CueEditor scene={scene} />
              </TabsContent>
              <TabsContent value="camera">
                <CameraShots scene={scene} />
              </TabsContent>
            </ScrollArea>
          </Tabs>
        ) : (
          <div className="grid flex-1 place-items-center text-muted-foreground">Select or add a scene.</div>
        )}
      </main>
      <Splitter value={w[1]} onChange={(v) => setW(1, v)} min={300} max={620} dir={-1} onReset={reset} />
      <aside className="flex min-h-0 shrink-0 flex-col border-l border-border" style={{ width: w[1] }}>
        <Tabs value={rightTab} onValueChange={setRightTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-3 mt-2 h-8">
            <TabsTrigger value="inspect" className="text-[12px]">Components</TabsTrigger>
            <TabsTrigger value="test" className="text-[12px]">Test controls</TabsTrigger>
          </TabsList>
          <TabsContent value="inspect" className="flex min-h-0 flex-1 flex-col">
            {scene && <ComponentList />}
            <ScrollArea className="min-h-0 flex-1 border-t border-border">{scene && <Inspector />}</ScrollArea>
          </TabsContent>
          <TabsContent value="test" className="min-h-0 flex-1">
            <ControlPanel />
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  );
}

const KIND_ICON: Record<SceneComponent["kind"], typeof Box> = {
  background: Mountain,
  video: Film,
  image: ImageIcon,
  model: Box,
  actor: Clapperboard,
  effect: CloudRain,
  procedural: Bird,
  clipActor: Clapperboard,
  text: Type,
  names: TreeDeciduous,
  route: Route,
};

function ComponentList() {
  const scene = useProject(selectedScene)!;
  const selectedId = useProject((s) => s.selectedComponentId);
  const st = useProject.getState();
  const add = (c: SceneComponent) => st.addComponent(scene.id, c);
  const sel = scene.components.find((c) => c.id === selectedId);

  return (
    <div className="flex max-h-[42%] min-h-[180px] flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Layers className="mr-1 inline size-3" />
          Components
        </h3>
        <div className="ml-auto flex gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline">
                <Plus /> Add
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-[11px]">Backgrounds</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => add(makeBackground("Environment Look"))}>
                <Mountain /> Environment look (day/night/storm)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => add(makeBackground("Video/Image Plate", { source: "media" }))}>
                <Film /> Media background
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px]">Layers</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => add(makeVideoLayer("Video Layer"))}>
                <Film /> Video layer (alpha / chroma key)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => add(makeImageLayer("Image Layer"))}>
                <ImageIcon /> Image layer
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => add(makeModel("3D Model"))}>
                <Box /> 3D model (GLB/glTF)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px]">Titles &amp; storybook</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => add(makeText("Title"))}>
                <Type /> Title / caption / verse
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => add(makeNames("Family Tree"))}>
                <TreeDeciduous /> Family tree / names
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => add(makeRoute("Map Route"))}>
                <Route /> Map route (glowing line)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px]">Characters</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => add(makeLion("Lion"))}>
                <Clapperboard /> Interactive lion (3D)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => add(makeClipActor("Video Actor"))}>
                <Film /> Video actor (AI clips)
              </DropdownMenuItem>
              {(["birds", "sheep", "campfire", "town-lights"] as ProceduralElement[]).map((e) => (
                <DropdownMenuItem key={e} onClick={() => add(makeProcedural(e))}>
                  <Bird /> {makeProcedural(e).name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px]">Effects</DropdownMenuLabel>
              {EFFECT_TYPES.map((t) => (
                <DropdownMenuItem key={t} onClick={() => add(makeEffect(t))}>
                  <Sparkles /> {EFFECT_DEFS[t].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <IconBtn label="Duplicate" disabled={!sel} onClick={() => sel && st.duplicateComponent(scene.id, sel.id)}>
            <Copy />
          </IconBtn>
          <IconBtn label="Move up (draw earlier)" disabled={!sel} onClick={() => sel && st.moveComponent(scene.id, sel.id, -1)}>
            <ArrowUp />
          </IconBtn>
          <IconBtn label="Move down (draw later)" disabled={!sel} onClick={() => sel && st.moveComponent(scene.id, sel.id, 1)}>
            <ArrowDown />
          </IconBtn>
          <IconBtn label="Delete" disabled={!sel} onClick={() => sel && st.removeComponent(scene.id, sel.id)}>
            <Trash2 />
          </IconBtn>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-px px-2 pb-2">
          {scene.components.map((c) => {
            const Icon = KIND_ICON[c.kind];
            return (
              <li key={c.id}>
                <button
                  onClick={() => st.selectComponent(c.id)}
                  className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]", c.id === selectedId ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/50")}
                >
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground">{c.kind === "effect" ? c.effect : c.kind === "procedural" ? c.element : c.kind === "video" || c.kind === "image" ? c.placement : c.kind === "clipActor" ? "video actor" : c.kind === "names" ? c.style : c.kind === "text" ? "title" : c.kind}</span>
                  {c.initiallyVisible && <span className="size-1.5 rounded-full bg-preview" title="Active when scene goes live" />}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

function AssetLibrary() {
  const assets = useProject((s) => s.project.assets);
  const [busy, setBusy] = useState(false);
  const scenes = useProject((s) => s.project.scenes);
  const used = useMemo(() => new Set(JSON.stringify(scenes.map((s) => ({ ...s, thumbnail: null }))).match(/asset_[a-z0-9]+/g) ?? []), [scenes]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Asset library</h2>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const a = await importAssets();
              if (a.length) useProject.getState().addAssets(a);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Upload /> {busy ? "Importing…" : "Import"}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-px px-2 pb-2">
          {assets.map((a) => (
            <li key={a.id} className="group flex items-center gap-2 rounded px-2 py-1 text-[12px] hover:bg-accent/50">
              <span className="w-10 text-[9.5px] font-bold uppercase text-muted-foreground">{a.type}</span>
              <span className="flex-1 truncate" title={a.path ?? a.name}>
                {a.name}
              </span>
              {a.ephemeral && <span className="text-[9.5px] text-armed" title="Imported in the browser: available until reload">session</span>}
              {a.builtIn && <span className="text-[9.5px] text-muted-foreground">built-in</span>}
              {!used.has(a.id) && !a.builtIn && (
                <button className="hidden text-muted-foreground hover:text-destructive group-hover:block" onClick={() => useProject.getState().removeAsset(a.id)} aria-label="Remove asset">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
          {assets.length === 0 && (
            <li className="px-2 py-3 text-[11.5px] leading-snug text-muted-foreground">
              Import images, videos (MP4, WebM with alpha, HEVC alpha .mov), GLB/glTF models and audio. Files are copied into the show library.
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  );
}
