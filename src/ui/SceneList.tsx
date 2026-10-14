import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, ListOrdered, Mountain, Plus, Search, Timer, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Scene } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";

function fmtDur(s: number | null) {
  if (!s) return null;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function SceneList() {
  const scenes = useProject((s) => s.project.scenes);
  const selectedId = useProject((s) => s.selectedSceneId);
  const { selectScene, addScene, duplicateScene, deleteScene, moveScene } = useProject.getState();
  const liveSceneId = useShow((s) => s.program.runtime?.scene.id ?? null);
  const standby = useShow((s) => s.program.standby);
  const [confirm, setConfirm] = useState<Scene | null>(null);
  const [query, setQuery] = useState("");
  const sel = scenes.find((s) => s.id === selectedId);
  const q = query.trim().toLowerCase();
  const shown = q ? scenes.filter((s) => s.name.toLowerCase().includes(q) || String(s.number) === q) : scenes;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="flex items-center gap-1 px-2.5 pb-1.5 pt-2.5">
        <h2 className="font-key text-[14px] font-bold">Scenes</h2>
        <span className="text-[12px] text-muted-foreground">{scenes.length}</span>
        <div className="ml-auto flex gap-0.5">
          <IconBtn label="Add scene" onClick={() => addScene()}>
            <Plus />
          </IconBtn>
          <IconBtn label="Duplicate scene" disabled={!sel} onClick={() => sel && duplicateScene(sel.id)}>
            <Copy />
          </IconBtn>
          <IconBtn label="Move up" disabled={!sel || sel.number === 1} onClick={() => sel && moveScene(sel.id, -1)}>
            <ArrowUp />
          </IconBtn>
          <IconBtn label="Move down" disabled={!sel || sel.number === scenes.length} onClick={() => sel && moveScene(sel.id, 1)}>
            <ArrowDown />
          </IconBtn>
          <IconBtn label={sel?.id === liveSceneId ? "The live scene can't be deleted" : "Delete scene"} disabled={!sel || sel.id === liveSceneId} onClick={() => sel && setConfirm(sel)}>
            <Trash2 />
          </IconBtn>
        </div>
      </div>
      <div className="px-2.5 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-well px-2 text-muted-foreground focus-within:border-ring">
          <Search className="size-3.5 shrink-0" />
          <input className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70" placeholder="Find a scene" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-1 px-2 pb-2">
          {shown.map((s) => {
            const live = s.id === liveSceneId && !standby;
            const selected = s.id === selectedId;
            return (
              <li key={s.id}>
                <button
                  onClick={() => selectScene(s.id)}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors",
                    selected ? "bg-accent ring-1 ring-preview/70" : "hover:bg-accent/50",
                  )}
                >
                  <div className={cn("relative aspect-video w-[104px] shrink-0 overflow-hidden rounded-md bg-black", live && "on-air-frame")}>
                    {s.thumbnail ? (
                      <img src={s.thumbnail} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="grid h-full place-items-center text-muted-foreground/60">
                        <Mountain className="size-4" />
                      </div>
                    )}
                    <span className="font-key absolute bottom-1 left-1 rounded bg-black/75 px-1 text-[11px] font-bold leading-[15px] text-white">{s.number}</span>
                    {live && <span className="font-key absolute right-1 top-1 rounded bg-live px-1 text-[10px] font-bold leading-[14px] text-white">LIVE</span>}
                    {selected && !live && <span className="absolute right-1 top-1 size-2 rounded-full bg-preview" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[13px] font-medium leading-snug">{s.name}</div>
                    <div className="mt-0.5 flex items-center gap-2.5 text-[11.5px] text-muted-foreground tabular">
                      <span className="flex items-center gap-1" title="Cues">
                        <ListOrdered className="size-3" /> {s.cues.length}
                      </span>
                      {fmtDur(s.duration) && (
                        <span className="flex items-center gap-1" title="Planned length">
                          <Timer className="size-3" /> {fmtDur(s.duration)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-2 py-6 text-center text-[12px] text-muted-foreground">No scene matches “{query}”.</li>}
        </ul>
      </ScrollArea>
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{confirm?.name}”?</DialogTitle>
            <DialogDescription>This removes the scene, its components and cues from the show file.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm) deleteScene(confirm.id);
                setConfirm(null);
              }}
            >
              Delete scene
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function IconBtn({ label, children, onClick, disabled, active, className }: { label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" onClick={onClick} disabled={disabled} aria-label={label} className={cn("size-7", active && "bg-accent text-foreground", className)}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
