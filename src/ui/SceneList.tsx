import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Mountain, Plus, Trash2 } from "lucide-react";
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
  const sel = scenes.find((s) => s.id === selectedId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Scenes</h2>
        <div className="flex gap-0.5">
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
          <IconBtn label={sel?.id === liveSceneId ? "Cannot delete the live scene" : "Delete scene"} disabled={!sel || sel.id === liveSceneId} onClick={() => sel && setConfirm(sel)}>
            <Trash2 />
          </IconBtn>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-1 p-2">
          {scenes.map((s) => {
            const live = s.id === liveSceneId && !standby;
            const selected = s.id === selectedId;
            return (
              <li key={s.id}>
                <button
                  onClick={() => selectScene(s.id)}
                  className={cn(
                    "group relative flex w-full gap-2.5 rounded-md border p-1.5 text-left transition-colors",
                    selected ? "border-preview bg-accent" : "border-transparent hover:bg-accent/60",
                    live && "ring-2 ring-live ring-offset-1 ring-offset-background",
                  )}
                >
                  <div className="relative aspect-video w-[92px] shrink-0 overflow-hidden rounded-sm bg-black">
                    {s.thumbnail ? (
                      <img src={s.thumbnail} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="grid h-full place-items-center text-muted-foreground">
                        <Mountain className="size-4" />
                      </div>
                    )}
                    {live && <span className="absolute left-1 top-1 rounded-[3px] bg-live px-1 text-[9px] font-bold tracking-wider text-white">LIVE</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold tracking-wider text-muted-foreground">SCENE {String(s.number).padStart(2, "0")}</div>
                    <div className="truncate text-[12.5px] font-medium leading-tight">{s.name}</div>
                    <div className="mt-1 flex gap-2 text-[10.5px] text-muted-foreground tabular">
                      <span>{s.cues.length} cues</span>
                      {fmtDur(s.duration) && <span>{fmtDur(s.duration)}</span>}
                      {selected && !live && <span className="text-preview">preview</span>}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
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
        <Button variant="ghost" size="icon-xs" onClick={onClick} disabled={disabled} aria-label={label} className={cn(active && "bg-accent text-foreground", className)}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
