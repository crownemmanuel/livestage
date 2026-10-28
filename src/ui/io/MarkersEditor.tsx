import type { ReactNode } from "react";
import { Clock, ListOrdered, Plus, Radio, Timer, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { uid } from "@/core/ids";
import type { MediaMarker } from "@/core/types";
import { selectedScene, useProject, NO_ITEMS } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";
import { InfoTip } from "../kit";
import { MessageFields, defaultMarkerMessage } from "./MessageFields";


/** Time markers on a clip: when live playback passes a time, run a cue of the scene or send to the console. */
export function MarkersEditor({ markers, onChange }: { markers: MediaMarker[] | undefined; onChange: (m: MediaMarker[]) => void }) {
  const cues = useProject((s) => selectedScene(s)?.cues ?? NO_ITEMS);
  const list = markers ?? [];
  const upd = (id: string, fn: (m: MediaMarker) => MediaMarker) => onChange(list.map((m) => (m.id === id ? fn(m) : m)));
  const add = () => onChange([...list, { id: uid("mk"), name: `Marker ${list.length + 1}`, at: 2.5, message: defaultMarkerMessage(), cueId: null }]);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <Timer className="size-4 text-armed" />
        <span className="text-[13px] font-semibold">Time markers</span>
        {list.length > 0 && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] tabular text-muted-foreground">{list.length}</span>}
        <InfoTip>When the live video reaches a time, run one of this scene's cues or send a message: a Hog or StageLight lighting cue, a mic through StageMics, MIDI or OSC. Markers fire from the live (Program) show only, once per pass; on a loop they fire every pass. Scrubbing never fires the markers jumped over.</InfoTip>
        <Button size="sm" variant="outline" className="ml-auto rounded-lg" onClick={add}>
          <Plus /> Add marker
        </Button>
      </div>
      {list.length === 0 && (
        <button type="button" onClick={add} className="w-full rounded-xl border border-dashed border-border px-3 py-5 text-[12.5px] text-muted-foreground hover:border-foreground/30 hover:text-foreground">
          Fire a cue, a lighting cue (Hog or StageLight) or a mic change when this video reaches a time.
        </button>
      )}
      {list.map((m) => {
        const runsCue = !!m.cueId && cues.some((c) => c.id === m.cueId);
        return (
          <div key={m.id} className="space-y-4 rounded-xl border border-border/70 bg-black/20 p-4">
            <div className="flex items-center gap-2">
              <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent/60 pr-2.5 pl-2.5 text-[13px]" title="When the video reaches this time">
                <Clock className="size-4 text-armed" />
                <NumberInput className="h-7 w-14 border-0 bg-transparent px-1 text-[14px] font-medium shadow-none dark:bg-transparent" value={m.at} min={0} step={0.1} onChange={(v) => upd(m.id, (x) => ({ ...x, at: v }))} />
                <span className="text-muted-foreground">s</span>
              </div>
              <input
                className="h-9 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2.5 text-[14px] font-medium hover:border-input focus:border-input focus:outline-none"
                placeholder="Marker name"
                defaultValue={m.name}
                key={m.id + m.name}
                onBlur={(e) => e.target.value !== m.name && upd(m.id, (x) => ({ ...x, name: e.target.value }))}
              />
              <Button size="icon-sm" variant="ghost" className="rounded-lg text-muted-foreground hover:text-destructive" onClick={() => onChange(list.filter((x) => x.id !== m.id))} aria-label="Remove marker" title="Remove marker">
                <Trash2 />
              </Button>
            </div>
            <div className="space-y-2">
              <div className="text-[11.5px] font-medium text-muted-foreground">Then</div>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-border/60 bg-black/25 p-1">
                <Choice active={!runsCue} onClick={() => upd(m.id, (x) => ({ ...x, cueId: null }))} icon={<Radio />}>
                  Send (lighting, sound, MIDI, OSC)
                </Choice>
                <Choice active={runsCue} disabled={cues.length === 0} onClick={() => !runsCue && upd(m.id, (x) => ({ ...x, cueId: cues[0].id }))} icon={<ListOrdered />}>
                  Run a cue
                </Choice>
              </div>
            </div>
            {runsCue ? (
              <SelectBox className="h-9 rounded-lg text-[13px]" value={m.cueId!} onChange={(v) => upd(m.id, (x) => ({ ...x, cueId: v }))} options={cues.map((c, i) => ({ value: c.id, label: `${i + 1}. ${c.name}` }))} />
            ) : (
              <MessageFields roomy m={m.message} onChange={(message) => upd(m.id, (x) => ({ ...x, message }))} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One half of the "Then" switch. */
function Choice({ active, disabled, onClick, icon, children }: { active: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-9 items-center justify-center gap-2 rounded-md px-3 py-1 text-[12.5px] leading-tight transition-colors disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
        active ? "bg-accent font-medium text-foreground shadow-sm ring-1 ring-foreground/20" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {icon}
      <span className="text-left">{children}</span>
    </button>
  );
}
