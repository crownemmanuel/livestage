import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uid } from "@/core/ids";
import type { MediaMarker } from "@/core/types";
import { NumberInput } from "../fields";
import { MessageFields, defaultMessage } from "./MessageFields";

/** Time markers on a clip: at these seconds the live show sends MIDI / OSC out. */
export function MarkersEditor({ markers, onChange }: { markers: MediaMarker[] | undefined; onChange: (m: MediaMarker[]) => void }) {
  const list = markers ?? [];
  const upd = (id: string, fn: (m: MediaMarker) => MediaMarker) => onChange(list.map((m) => (m.id === id ? fn(m) : m)));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] leading-snug text-muted-foreground">Send a message when playback passes a time (live output only).</p>
        <Button size="xs" variant="outline" onClick={() => onChange([...list, { id: uid("mk"), name: `Marker ${list.length + 1}`, at: 2.5, message: defaultMessage("osc") }])}>
          <Plus /> Marker
        </Button>
      </div>
      {list.map((m) => (
        <div key={m.id} className="space-y-1 rounded-md border border-border p-1.5">
          <div className="flex items-center gap-1.5 text-[11px]">
            <input className="h-6 flex-1 rounded-md border border-transparent bg-transparent px-1.5 hover:border-input focus:border-input" defaultValue={m.name} key={m.id + m.name} onBlur={(e) => e.target.value !== m.name && upd(m.id, (x) => ({ ...x, name: e.target.value }))} />
            <span className="text-muted-foreground">at</span>
            <NumberInput className="h-6 w-16" value={m.at} min={0} step={0.1} onChange={(v) => upd(m.id, (x) => ({ ...x, at: v }))} />
            <span className="text-muted-foreground">s</span>
            <Button size="icon-xs" variant="ghost" onClick={() => onChange(list.filter((x) => x.id !== m.id))} aria-label="Remove marker">
              <Trash2 />
            </Button>
          </div>
          <MessageFields compact m={m.message} onChange={(message) => upd(m.id, (x) => ({ ...x, message }))} />
        </div>
      ))}
    </div>
  );
}
