// Show Mode's live mixer: one fader per audio source sounding on the wall (cue sounds, and video
// with its sound on). The faders trim the designed volume; the trims are the show's sound levels, saved
// in the show file (Project.mix).

import { useEffect, useRef, useState } from "react";
import { AudioLines, ChevronDown, ChevronRight, Clapperboard, Film, Mic, Mountain, Music, RotateCcw, SlidersVertical, Sparkles, Trees, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { liveAudioSources, type MixSource } from "@/engine/mixer";
import { useShow } from "@/store/show";
import { useProject } from "@/store/project";
import { InfoTip } from "../kit";

/** Icon, colour and label for each kind of source: cue sounds by what they are, video sound in amber. */
const LOOKS: Record<string, { icon: typeof Music; color: string; label: string }> = {
  music: { icon: Music, color: "text-violet-400", label: "Music" },
  voice: { icon: Mic, color: "text-sky-400", label: "Voice / narration" },
  ambience: { icon: Trees, color: "text-emerald-400", label: "Ambience" },
  sfx: { icon: Sparkles, color: "text-orange-400", label: "Sound effect" },
  sound: { icon: AudioLines, color: "text-muted-foreground", label: "Cue sound" },
  video: { icon: Film, color: "text-armed", label: "Video sound" },
  background: { icon: Mountain, color: "text-armed", label: "Background video sound" },
  videoActor: { icon: Clapperboard, color: "text-armed", label: "Video actor sound" },
};
const lookOf = (src: MixSource) => LOOKS[src.kind === "sound" ? (src.role ?? "sound") : src.kind];

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
  // Reset wipes the rehearsed sound design: it takes a second click.
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const h = setTimeout(() => setConfirmReset(false), 3000);
    return () => clearTimeout(h);
  }, [confirmReset]);
  const sources = liveAudioSources();
  const trimmed = Object.keys(useShow.getState().program.mix ?? {}).length > 0;
  const setMix = useShow.getState().setMix;
  const chase = useProject((s) => s.project.chaseMusic !== false);

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
          Every sound on the live wall right now: music (violet), voice (blue), ambience (green), effects (orange) and video with its sound on (amber). The speakers it plays on are chosen under Settings → Audio output. Each fader trims that source on the speakers (100% = as designed). The levels are saved in the show file, so they stay through takes and reloads,
          come back the next time the same sound or video plays, and travel with show packages and cloud sync (taking in a version whose levels differ from the ones set here asks which to keep).
        </InfoTip>
        <Button
          variant="ghost"
          size="sm"
          className={cn("ml-auto h-6 gap-1 px-1.5 text-[12px]", chase ? "text-violet-400" : "text-muted-foreground")}
          title={
            chase
              ? "Chase music on jumps is on: firing a cue out of order or taking a scene out of running order starts the music that would be playing there, at the second it would have reached. Click to turn off."
              : "Chase music on jumps is off: a jump leaves the music to the cues. Click to turn on."
          }
          onClick={() => useProject.getState().update((p) => void (p.chaseMusic = !chase))}
        >
          <Music className="size-3" /> Chase {chase ? "on" : "off"}
        </Button>
        {trimmed && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-6 gap-1 px-1.5 text-[12px] text-muted-foreground", confirmReset && "text-live")}
            title="Put every source back to its designed volume (clears the levels saved in the show)"
            onClick={() => {
              if (!confirmReset) return setConfirmReset(true);
              setConfirmReset(false);
              for (const k of Object.keys(useShow.getState().program.mix ?? {})) setMix(k, null);
            }}
          >
            <RotateCcw className="size-3" /> {confirmReset ? "Reset all levels?" : "Reset"}
          </Button>
        )}
      </div>
      {open && sources.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-y-auto px-3 pb-3">
          {sources.map((src) => {
            const look = lookOf(src);
            const Icon = look.icon;
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
                    <span title={look.label} className="flex shrink-0">
                      <Icon className={cn("size-3.5", look.color)} />
                    </span>
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
