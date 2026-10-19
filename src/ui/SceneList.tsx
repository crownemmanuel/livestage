import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Copy, CornerDownRight, Ellipsis, FolderOutput, FolderPlus, ListOrdered, Mountain, Plus, Search, Timer, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { GROUP_COLORS, GROUP_HEX } from "@/core/factories";
import { sceneCodes, sceneRows } from "@/core/groups";
import type { Scene, SceneGroup } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";

function fmtDur(s: number | null) {
  if (!s) return null;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Display numbers ("3", "2.1") for every scene, recomputed only when the list changes. */
export function useSceneCodes() {
  const scenes = useProject((s) => s.project.scenes);
  const groups = useProject((s) => s.project.groups);
  return useMemo(() => sceneCodes({ scenes, groups }), [scenes, groups]);
}

export function SceneList() {
  const scenes = useProject((s) => s.project.scenes);
  const groups = useProject((s) => s.project.groups);
  const selectedId = useProject((s) => s.selectedSceneId);
  const { addScene, duplicateScene, deleteScene, moveScene, setSceneGroup } = useProject.getState();
  const liveSceneId = useShow((s) => s.program.runtime?.scene.id ?? null);
  const standby = useShow((s) => s.program.standby);
  const [confirm, setConfirm] = useState<Scene | null>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => sceneRows({ scenes, groups }), [scenes, groups]);
  const codes = useSceneCodes();
  const sel = scenes.find((s) => s.id === selectedId);
  const q = query.trim().toLowerCase();
  const live = liveSceneId && !standby ? liveSceneId : null;
  const selIdx = sel ? scenes.indexOf(sel) : -1;
  const canUp = !!sel && selIdx > 0 && (!sel.groupId || scenes[selIdx - 1].groupId === sel.groupId);
  const canDown = !!sel && selIdx < scenes.length - 1 && (!sel.groupId || scenes[selIdx + 1].groupId === sel.groupId);

  const item = (s: Scene, group?: SceneGroup) => <SceneItem key={s.id} scene={s} code={codes.get(s.id) ?? String(s.number)} group={group} live={s.id === live} selected={s.id === selectedId} groups={groups ?? []} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="flex items-center gap-1 px-2.5 pb-1.5 pt-2.5">
        <h2 className="font-key text-[14px] font-bold">Scenes</h2>
        <span className="text-[12px] text-muted-foreground">{scenes.length}</span>
        <div className="ml-auto flex gap-0.5">
          <IconBtn label="Add scene" onClick={() => addScene()}>
            <Plus />
          </IconBtn>
          <IconBtn label={sel?.groupId ? "Already in a group" : "Start a group with this scene"} disabled={!sel || !!sel.groupId} onClick={() => sel && setSceneGroup(sel.id, "new")}>
            <FolderPlus />
          </IconBtn>
          <IconBtn label="Duplicate scene" disabled={!sel} onClick={() => sel && duplicateScene(sel.id)}>
            <Copy />
          </IconBtn>
          <IconBtn label="Move up" disabled={!canUp} onClick={() => sel && moveScene(sel.id, -1)}>
            <ArrowUp />
          </IconBtn>
          <IconBtn label="Move down" disabled={!canDown} onClick={() => sel && moveScene(sel.id, 1)}>
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
          {q
            ? scenes.filter((s) => s.name.toLowerCase().includes(q) || codes.get(s.id) === q).map((s) => item(s, groups?.find((g) => g.id === s.groupId)))
            : rows.map((r) =>
                r.kind === "scene" ? (
                  item(r.scene)
                ) : (
                  <li key={r.group.id}>
                    <GroupHeader group={r.group} code={r.code} count={r.scenes.length} hasLive={r.scenes.some((s) => s.id === live)} hasSelected={r.scenes.some((s) => s.id === selectedId)} />
                    {!r.group.collapsed && <ul className="mt-1 space-y-1 border-l-2 pl-1.5" style={{ borderColor: GROUP_HEX[r.group.color] }}>{r.scenes.map((s) => item(s, r.group))}</ul>}
                  </li>
                ),
              )}
          {q && !scenes.some((s) => s.name.toLowerCase().includes(q) || codes.get(s.id) === q) && <li className="px-2 py-6 text-center text-[12px] text-muted-foreground">No scene matches “{query}”.</li>}
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

function GroupHeader({ group: g, code, count, hasLive, hasSelected }: { group: SceneGroup; code: string; count: number; hasLive: boolean; hasSelected: boolean }) {
  const { updateGroup, ungroup, moveGroup } = useProject.getState();
  const [editing, setEditing] = useState(false);
  const hex = GROUP_HEX[g.color];
  return (
    <div className="group/gh flex items-center gap-1.5 rounded-md py-1 pl-1 pr-0.5" style={{ background: `color-mix(in oklab, ${hex} 13%, transparent)` }}>
      <button type="button" className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground" onClick={() => updateGroup(g.id, (x) => (x.collapsed = !x.collapsed))} aria-label={g.collapsed ? "Expand group" : "Collapse group"}>
        <ChevronRight className={cn("size-4 transition-transform", !g.collapsed && "rotate-90")} />
      </button>
      <span className="font-key grid h-5 min-w-5 place-items-center rounded px-1 text-[11.5px] font-bold text-black" style={{ background: hex }}>
        {code}
      </span>
      {editing ? (
        <input
          autoFocus
          className="h-6 min-w-0 flex-1 rounded border border-input bg-transparent px-1.5 text-[13px] font-semibold"
          defaultValue={g.name}
          onBlur={(e) => {
            if (e.target.value.trim()) updateGroup(g.id, (x) => (x.name = e.target.value.trim()));
            setEditing(false);
          }}
          onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <button type="button" className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {g.name}
        </button>
      )}
      {hasLive && g.collapsed && <span className="font-key rounded bg-live px-1 text-[10px] font-bold leading-[14px] text-white">LIVE</span>}
      {hasSelected && g.collapsed && !hasLive && <span className="size-2 rounded-full bg-preview" />}
      <span className="shrink-0 text-[11px] tabular text-muted-foreground">{count}</span>
      {g.flow && (
        <Tip label="GO runs straight through this group: after a scene's last cue, GO takes the next scene">
          <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
        </Tip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" className="opacity-60 group-hover/gh:opacity-100" aria-label="Group options">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem className="text-[12px]" onSelect={() => setEditing(true)}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuLabel className="text-[10.5px] text-muted-foreground">Colour</DropdownMenuLabel>
          <div className="flex flex-wrap gap-1.5 px-2 pb-2">
            {GROUP_COLORS.map((c) => (
              <button key={c} type="button" aria-label={c} className={cn("size-5 rounded-full ring-offset-2 ring-offset-popover", g.color === c && "ring-2 ring-foreground")} style={{ background: GROUP_HEX[c] }} onClick={() => updateGroup(g.id, (x) => (x.color = c))} />
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem className="text-[12px]" checked={g.flow} onCheckedChange={(v) => updateGroup(g.id, (x) => (x.flow = !!v))}>
            GO continues into the next scene
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-[12px]" onSelect={() => moveGroup(g.id, -1)}>
            <ArrowUp /> Move group up
          </DropdownMenuItem>
          <DropdownMenuItem className="text-[12px]" onSelect={() => moveGroup(g.id, 1)}>
            <ArrowDown /> Move group down
          </DropdownMenuItem>
          <DropdownMenuItem className="text-[12px]" onSelect={() => ungroup(g.id)}>
            <FolderOutput /> Ungroup (keep the scenes)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SceneItem({ scene: s, code, group, live, selected, groups }: { scene: Scene; code: string; group?: SceneGroup; live: boolean; selected: boolean; groups: SceneGroup[] }) {
  const { selectScene, setSceneGroup } = useProject.getState();
  const hex = group ? GROUP_HEX[group.color] : null;
  return (
    <li className="group/scene relative">
      <button
        onClick={() => selectScene(s.id)}
        className={cn("flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors", selected ? "bg-accent ring-1 ring-preview/70" : "hover:bg-accent/50")}
      >
        <div className={cn("relative aspect-video shrink-0 overflow-hidden rounded-md bg-black", group ? "w-[92px]" : "w-[104px]", live && "on-air-frame")}>
          {s.thumbnail ? (
            <img src={s.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground/60">
              <Mountain className="size-4" />
            </div>
          )}
          <span className="font-key absolute bottom-1 left-1 rounded px-1 text-[11px] font-bold leading-[15px]" style={hex ? { background: hex, color: "#000" } : { background: "rgba(0,0,0,.75)", color: "#fff" }} title={`Running order ${s.number} (what MSC and /sls/take use)`}>
            {code}
          </span>
          {live && <span className="font-key absolute right-1 top-1 rounded bg-live px-1 text-[10px] font-bold leading-[14px] text-white">LIVE</span>}
          {selected && !live && <span className="absolute right-1 top-1 size-2 rounded-full bg-preview" />}
        </div>
        <div className="min-w-0 flex-1 pr-5">
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" className="absolute right-1 top-1.5 opacity-0 group-hover/scene:opacity-100 data-[state=open]:opacity-100" aria-label="Scene options">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-[12px]">
              <FolderPlus /> Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {groups.map((g) => (
                <DropdownMenuItem key={g.id} className="text-[12px]" disabled={g.id === s.groupId} onSelect={() => setSceneGroup(s.id, g.id)}>
                  <span className="size-2.5 rounded-full" style={{ background: GROUP_HEX[g.color] }} /> {g.name}
                </DropdownMenuItem>
              ))}
              {groups.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem className="text-[12px]" onSelect={() => setSceneGroup(s.id, "new")}>
                <Plus /> New group
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {s.groupId && (
            <DropdownMenuItem className="text-[12px]" onSelect={() => setSceneGroup(s.id, null)}>
              <FolderOutput /> Take out of the group
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
