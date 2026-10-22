import { useEffect, useState, type ReactNode } from "react";
import { Box, Clapperboard, Copy, Eye, EyeOff, Film, Focus, Timer, Image as ImageIcon, Layers, ListOrdered, Mountain, Plus, Repeat, Settings2, Sparkles, Trash2, ArrowUp, ArrowDown, CloudRain, Bird, Type, TreeDeciduous, Route, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { EFFECT_DEFS, EFFECT_TYPES } from "@/core/effects";
import { makeBackground, makeClipActor, makeEffect, makeImageLayer, makeLion, makeModel, makeNames, makeProcedural, makeRoute, makeText, makeVideoLayer } from "@/core/factories";
import type { ProceduralElement, Scene, SceneComponent } from "@/core/types";
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
import { FramingBar, FramingOverlay, PreviewHeader, SelectOverlay, selectScrubSource, StepBar, Timeline, ToolToggle, usePreviewTool } from "../PreviewTools";
import { InfoTip, Splitter, usePaneWidths } from "../kit";
import { AssetLibrary } from "./AssetLibrary";
import { assignMedia, componentFor, mediaSlot, NEW_FROM_DROP, useMediaDrop } from "../mediaDrop";

export function BuilderMode() {
  const scene = useProject(selectedScene);
  const capture = useCaptureThumb();
  const output = useShow((s) => s.output);
  const [rightTab, setRightTab] = useState("inspect");
  const [w, setW, reset] = usePaneWidths("build", [290, 400]);
  const tool = usePreviewTool((s) => s.tool);
  // V = select and move, Z = zoom and frame (as in design tools).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))) return;
      if (e.code === "KeyV") usePreviewTool.setState({ tool: "select" });
      else if (e.code === "KeyZ") usePreviewTool.setState({ tool: "frame" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
          <PreviewHeader />
          <div className="relative mx-auto w-full overflow-hidden rounded-sm ring-2 ring-preview/70" style={{ aspectRatio: `${output.canvasWidth} / ${output.canvasHeight}`, maxHeight: "44vh" }}>
            <StageView source="preview" maxDpr={1.5} showSafeArea onCapture={capture} />
            {tool === "select" ? <SelectOverlay /> : <FramingOverlay />}
          </div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <StepBar />
            </div>
            <div className="mt-1.5 flex shrink-0 items-center gap-2">
              <ToolToggle />
              <FramingBar />
            </div>
          </div>
          <Timeline />
        </div>
        {scene ? (
          <Tabs defaultValue="cues" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-3 mt-2 h-8">
              <TabsTrigger value="cues" className="gap-1.5 text-[12px] [&_svg]:size-3.5">
                <ListOrdered /> Run sheet ({scene.cues.length})
              </TabsTrigger>
              <TabsTrigger value="scene" className="gap-1.5 text-[12px] [&_svg]:size-3.5">
                <Settings2 /> Scene settings
              </TabsTrigger>
              <TabsTrigger value="camera" className="gap-1.5 text-[12px] [&_svg]:size-3.5">
                <Video /> Camera ({scene.cameraShots.length})
              </TabsTrigger>
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

/** When a component first appears: on at the start, or the first cue that brings it in. */
function entersAt(scene: Scene, id: string, initiallyVisible: boolean): { label: string; on: boolean } {
  if (initiallyVisible) return { label: "at start", on: true };
  const i = scene.cues.findIndex((c) => c.actions.some((a) => Object.values(a).includes(id)));
  return i >= 0 ? { label: `cue ${i + 1}`, on: false } : { label: "not used", on: false };
}

/** Everything in the scene, when it comes in, and hide / isolate switches for the preview. */
function ComponentList() {
  const scene = useProject(selectedScene)!;
  const selectedId = useProject((s) => s.selectedComponentId);
  const st = useProject.getState();
  // What you add in Build shows at once (a cue can still hide it); a second background doesn't replace the first.
  const add = (c: SceneComponent) => st.addComponent(scene.id, c.kind === "background" ? c : { ...c, initiallyVisible: true });
  const sel = scene.components.find((c) => c.id === selectedId);
  const solo = useShow((s) => s.solo);
  const hidden = useShow((s) => s.hidden);
  // Media dropped between rows becomes new components (a row takes it into its own media).
  const { over, dropProps } = useMediaDrop(NEW_FROM_DROP, (list) => list.forEach((a) => { const c = componentFor(a); if (c) add(c); }));

  return (
    <div className={cn("flex max-h-[42%] min-h-[180px] flex-col", over && "bg-preview/[0.06] ring-2 ring-inset ring-preview/50")} {...dropProps}>
      <div className="flex items-center gap-1 px-3 py-2">
        <h3 className="flex items-center gap-1 text-[12.5px] font-semibold">
          <Layers className="size-3.5 text-muted-foreground" />
          Components
        </h3>
        <InfoTip>Everything in this scene. Green = visible when the scene goes live; “cue 2” = the first cue that brings it in. The eye hides an item from the preview while you build (the show is unchanged); isolate (⊙) shows one item on its own, with its markers on the timeline. A video character's clips are its moves.</InfoTip>
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
              <DropdownMenuItem onClick={() => add(makeText("Countdown", { text: "THE SHOW BEGINS IN\n{time}", timerId: useProject.getState().project.timers?.[0]?.id ?? null, size: 0.12, glow: 0.5 }))}>
                <Timer /> Countdown (show timer)
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
            const enters = entersAt(scene, c.id, c.initiallyVisible);
            const isolated = solo === c.id;
            const isHidden = hidden.includes(c.id);
            return (
              <li key={c.id} className="group/row">
                <ComponentRowDrop sceneId={scene.id} c={c} className={cn("flex items-center gap-2 rounded px-2 py-1 text-[12px]", c.id === selectedId ? "bg-accent text-foreground" : "text-foreground/85 hover:bg-accent/50", isolated && "ring-1 ring-armed/70")}>
                  <button type="button" onClick={() => st.selectComponent(c.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn("flex-1 truncate", isHidden && "text-muted-foreground line-through decoration-muted-foreground/50")}>{c.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{KIND_LABEL(c)}</span>
                    <span className={cn("shrink-0 rounded px-1.5 text-[10px] tabular", enters.on ? "bg-preview/15 text-preview" : enters.label === "not used" ? "text-muted-foreground/50" : "bg-accent text-foreground/75")}>{enters.label}</span>
                  </button>
                  <button
                    type="button"
                    title={isHidden ? "Show it in the preview again" : "Hide from the preview while building (the show is unchanged)"}
                    aria-label={isHidden ? "Show" : "Hide"}
                    onClick={() => useShow.getState().toggleHidden(c.id)}
                    className={cn("grid size-5 shrink-0 place-items-center rounded", isHidden ? "text-armed" : "text-muted-foreground opacity-0 hover:text-foreground group-hover/row:opacity-100")}
                  >
                    {isHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                  <button
                    type="button"
                    title={isolated ? "Show the whole scene" : "Isolate: show only this in the preview"}
                    aria-label="Isolate"
                    onClick={() => {
                      useShow.getState().setSolo(isolated ? null : c.id);
                      st.selectComponent(c.id);
                    }}
                    className={cn("grid size-5 shrink-0 place-items-center rounded", isolated ? "bg-armed text-black" : "text-muted-foreground opacity-0 hover:text-foreground group-hover/row:opacity-100")}
                  >
                    <Focus className="size-3.5" />
                  </button>
                </ComponentRowDrop>
                {c.kind === "clipActor" && c.clips.length > 0 && (
                  <div className="flex flex-wrap gap-1 pb-1 pl-8 pt-0.5">
                    {c.clips.map((k) => (
                      <button
                        key={k.id}
                        type="button"
                        title={`Move “${k.name}” (${k.startPose} → ${k.endPose}, ${k.duration}s). Click to put it on the timeline.`}
                        onClick={() => {
                          st.selectComponent(c.id);
                          selectScrubSource(`${c.id}:${k.id}`);
                        }}
                        className="flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10.5px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                      >
                        {k.name}
                        {k.loop && <Repeat className="size-2.5" />}
                        {(k.markers?.length ?? 0) > 0 && <span className="size-1.5 rotate-45 bg-armed" />}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

/** A component row that takes dropped media into its media setting (a background plate, layer, model…). */
function ComponentRowDrop({ sceneId, c, className, children }: { sceneId: string; c: SceneComponent; className: string; children: ReactNode }) {
  const types = mediaSlot(c);
  const { over, dropProps } = useMediaDrop(types ?? [], (list) => {
    assignMedia(sceneId, c.id, list[0].id);
    useProject.getState().selectComponent(c.id);
  });
  return (
    <div className={cn(className, over && "bg-preview/15 ring-2 ring-preview/70")} {...(types ? dropProps : {})}>
      {children}
    </div>
  );
}

const KIND_LABEL = (c: SceneComponent) =>
  c.kind === "effect" ? c.effect : c.kind === "procedural" ? c.element : c.kind === "video" || c.kind === "image" ? `${c.kind} · ${c.placement}` : c.kind === "clipActor" ? "video character" : c.kind === "names" ? c.style : c.kind === "text" ? "title" : c.kind === "actor" ? "3D character" : c.kind;
