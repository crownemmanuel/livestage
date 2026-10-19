import { ListOrdered, Plus, Radio, Timer, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uid } from "@/core/ids";
import type { MediaMarker } from "@/core/types";
import { selectedScene, useProject, NO_ITEMS } from "@/store/project";
import { NumberInput, SelectBox } from "../fields";
import { InfoTip } from "../kit";
import { MessageFields, defaultMessage } from "./MessageFields";

const SEND = "__send__";

/** Time markers on a clip: when live playback passes a time, run a cue of the scene or send to the console. */
export function MarkersEditor({ markers, onChange }: { markers: MediaMarker[] | undefined; onChange: (m: MediaMarker[]) => void }) {
  const cues = useProject((s) => selectedScene(s)?.cues ?? NO_ITEMS);
  const list = markers ?? [];
  const upd = (id: string, fn: (m: MediaMarker) => MediaMarker) => onChange(list.map((m) => (m.id === id ? fn(m) : m)));
  const add = () => onChange([...list, { id: uid("mk"), name: `Marker ${list.length + 1}`, at: 2.5, message: defaultMessage("hog"), cueId: null }]);
  const thenOptions = [{ value: SEND, label: "Send lighting / MIDI / OSC" }, ...cues.map((c, i) => ({ value: c.id, label: `Run cue ${i + 1}: ${c.name}` }))];

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card/40 p-2">
      <div className="flex items-center gap-1.5">
        <Timer className="size-3.5 text-armed" />
        <span className="text-[12px] font-semibold">Time markers</span>
        {list.length > 0 && <span className="rounded-full bg-accent px-1.5 text-[10.5px] tabular text-muted-foreground">{list.length}</span>}
        <InfoTip>When the live video reaches a time, run one of this scene's cues or send a lighting / MIDI / OSC message. Markers fire from the live (Program) show only, once per pass; on a loop they fire every pass.</InfoTip>
        <Button size="xs" variant="outline" className="ml-auto h-6" onClick={add}>
          <Plus /> Add marker
        </Button>
      </div>
      {list.length === 0 && (
        <button type="button" onClick={add} className="w-full rounded-md border border-dashed border-border px-2 py-3 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground">
          Fire a cue or a lighting cue when this video reaches a time.
        </button>
      )}
      {list.map((m) => {
        const runsCue = !!m.cueId;
        return (
          <div key={m.id} className="group space-y-1.5 rounded-md border border-border/70 bg-black/15 p-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">at</span>
              <NumberInput className="h-6 w-16 text-[11px]" value={m.at} min={0} step={0.1} onChange={(v) => upd(m.id, (x) => ({ ...x, at: v }))} />
              <span className="text-muted-foreground">s</span>
              <input className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 hover:border-input focus:border-input" defaultValue={m.name} key={m.id + m.name} onBlur={(e) => e.target.value !== m.name && upd(m.id, (x) => ({ ...x, name: e.target.value }))} />
              <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100" onClick={() => onChange(list.filter((x) => x.id !== m.id))} aria-label="Remove marker" title="Remove marker">
                <Trash2 />
              </Button>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              {runsCue ? <ListOrdered className="size-3.5 shrink-0 text-preview" /> : <Radio className="size-3.5 shrink-0 text-muted-foreground" />}
              <SelectBox className="h-6 flex-1 text-[11px]" value={runsCue && cues.some((c) => c.id === m.cueId) ? m.cueId! : SEND} onChange={(v) => upd(m.id, (x) => ({ ...x, cueId: v === SEND ? null : v }))} options={thenOptions} />
            </div>
            {!runsCue && <MessageFields compact m={m.message} onChange={(message) => upd(m.id, (x) => ({ ...x, message }))} />}
          </div>
        );
      })}
    </div>
  );
}
