// Show Mode's live mixer: one fader per audio source sounding on the wall (cue sounds, and video
// with its sound on). The faders trim the designed volume; the trims are show-wide live state.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Clapperboard, Film, Mountain, Music, RotateCcw, SlidersVertical, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { liveAudioSources, type MixSource } from "@/engine/mixer";
import { useShow } from "@/store/show";
import { InfoTip } from "../kit";
import { AudioOutputPicker } from "./AudioOutputPicker";

const ICONS: Record<MixSource["kind"], typeof Music> = { sound: Music, video: Film, background: Mountain, videoActor: Clapperboard };

export function MixerPanel() {
  const [open, setOpen] = useState(true);
  const [, tick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => tick((n) => n + 1), 400);
    return () => clearInterval(h);
  }, []);
  // Re-render on a fader move straight away, not on the next tick.
  useShow((s) => s.program.mix);
  const lastLevel = useRef(new Map<string, number>());
  const sources = liveAudioSources();
  const trimmed = Object.keys(useShow.getState().program.mix ?? {}).length > 0;
  const setMix = useShow.getState().setMix;

  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button type="button" className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          <SlidersVertical className="size-3.5 text-live" />
          <h3 className="text-[12.5px] font-semibold text-foreground/90">Live audio</h3>
          <span className="text-[12px] text-muted-foreground">{sources.length ? `${sources.length} playing` : "nothing playing"}</span>
        </button>
        <InfoTip side="left">
          Every sound on the live wall right now: cue sounds and video with its sound on. Each fader trims that source on the speakers (100% = as designed). The trims stay through takes and reloads, and come back the next time the
          same sound or video plays.
        </InfoTip>
        {trimmed && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-[12px] text-muted-foreground" title="Put every source back to its designed volume" onClick={() => {
            for (const k of Object.keys(useShow.getState().program.mix ?? {})) setMix(k, null);
          }}>
            <RotateCcw className="size-3" /> Reset
          </Button>
        )}
      </div>
      {open && <AudioOutputPicker />}
      {open && sources.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-y-auto px-3 pb-3">
          {sources.map((src) => {
            const Icon = ICONS[src.kind];
            const muted = src.level <= 0.001;
            return (
              <div key={src.key} className="grid grid-cols-[1.5rem_minmax(0,1fr)_2.6rem] items-center gap-x-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-6", muted && "text-live")}
                  title={muted ? "Unmute" : "Mute"}
                  onClick={() => {
                    if (muted) setMix(src.key, lastLevel.current.get(src.key) ?? 1);
                    else {
                      lastLevel.current.set(src.key, src.level);
                      setMix(src.key, 0);
                    }
                  }}
                >
                  {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                </Button>
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-[12px] text-foreground/85">
                    <Icon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={src.name}>{src.name}</span>
                  </div>
                  <Slider className="mt-1" value={[src.level]} min={0} max={1} step={0.01} onValueChange={(v) => setMix(src.key, v[0])} />
                </div>
                <span className={cn("text-right text-[12px] tabular", src.level < 1 ? "text-foreground" : "text-muted-foreground")}>{Math.round(src.level * 100)}%</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
