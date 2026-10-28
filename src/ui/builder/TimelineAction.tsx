// The timeline's pop-up for one action: double-click a block or a diamond to change its settings
// (the same editor as the run sheet), or double-click an empty moment to add an action there
// (lights, StageLight, StageMics, a sound, anything the run sheet offers).

import { ListOrdered, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CueAction, Scene } from "@/core/types";
import { useProject } from "@/store/project";
import { ACTION_INFO, ActionRow, focusCue, MENU, type MenuType } from "./CueEditor";

/** What the pop-up shows: one action to edit, or a moment to add one at. */
export type ActionTarget = { cue: number; action: number } | { at: number; where: string };

export function ActionDialog({ scene, target, onClose, onAdd }: { scene: Scene; target: ActionTarget | null; onClose: () => void; onAdd: (t: MenuType, at: number) => void }) {
  const scenes = useProject((s) => s.project.scenes);
  const editing = target && "cue" in target ? target : null;
  const cue = editing ? scene.cues[editing.cue] : undefined;
  const action = editing ? cue?.actions[editing.action] : undefined;
  const typeOf = (a: CueAction): MenuType => (a.type === "send" ? (a.message.type === "hog" ? "hog" : a.message.type === "stagelight" ? "stagelight" : a.message.type === "sound" ? "soundApp" : "send") : a.type);
  const info = action ? ACTION_INFO[typeOf(action)] : null;
  const change = (fn: (actions: CueAction[]) => void) => editing && useProject.getState().updateScene(scene.id, (s) => fn(s.cues[editing.cue].actions));

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3 p-4 sm:max-w-[720px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        {editing && cue && action && info ? (
          <>
            <DialogHeader className="gap-1">
              <DialogTitle className="flex items-center gap-1.5 text-[14px] [&_svg]:size-4">
                {info.icon} {info.label}
              </DialogTitle>
              <DialogDescription className="text-[11.5px]">
                Cue {editing.cue + 1}: {cue.name}
                {action.delay ? ` · ${action.delay} s after it fires` : " · as it fires"}. Changes save as you make them.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-border bg-muted/20 p-2">
              <ActionRow
                a={action}
                scene={scene}
                scenes={scenes}
                onChange={(a) => change((list) => void (list[editing.action] = a))}
                onRemove={() => {
                  change((list) => void list.splice(editing.action, 1));
                  onClose();
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => {
                  focusCue(cue.id, editing.action);
                  onClose();
                }}
              >
                <ListOrdered /> Open in the run sheet
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  change((list) => void list.splice(editing.action, 1));
                  onClose();
                }}
              >
                <Trash2 /> Delete
              </Button>
              <Button size="xs" className="ml-auto" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : target && "at" in target ? (
          <>
            <DialogHeader className="gap-1">
              <DialogTitle className="text-[14px]">Add at {fmtTime(target.at)}</DialogTitle>
              <DialogDescription className="text-[11.5px]">Goes into {target.where}, so it stays with that cue however late it is fired.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {MENU.map((g) => (
                <div key={g.group} className="flex flex-col gap-0.5">
                  <div className="px-1.5 text-[10.5px] font-medium text-muted-foreground">{g.group}</div>
                  {g.types.map((t) => (
                    <button key={t} type="button" className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] hover:bg-muted [&_svg]:size-3.5" onClick={() => onAdd(t, target.at)}>
                      {ACTION_INFO[t].icon} {ACTION_INFO[t].label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : (
          // The action went away (undone or removed in the run sheet).
          <DialogHeader>
            <DialogTitle className="text-[14px]">Nothing to edit</DialogTitle>
            <DialogDescription className="text-[11.5px]">That action is no longer in the cue.</DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
