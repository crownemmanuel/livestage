// Playback log: every hitch of the picture during a run, kept in the operator window so it can be read after a
// rehearsal (the output only reports its last second). Three kinds:
// - "stall": a frame of the output window that took over 40 ms (the wall stood still for that long while its
//   videos played on underneath, so it jumped when drawing resumed), with the bus message before it;
// - "seek": a hard seek of a video that was playing on the wall (a visible jump), with how far off it was;
// - "operator": the operator window's main thread was held up; cues and delayed actions fired that much late;
// - "late": a clip on the WebCodecs player showed an older frame than the clock's (its decoder fell behind).
// Each entry carries the live scene and its scene time, so a hitch can be found in the show.

import { now, sceneNow } from "@/core/clock";
import type { OutputStatus } from "@/core/bus";
import { steadyInterval } from "@/core/steadyTimer";
import { useShow } from "@/store/show";

export interface PlaybackEvent {
  /** Wall time (ms since 1970). */
  at: number;
  kind: "stall" | "seek" | "operator" | "late";
  sceneId: string | null;
  /** Live scene time (s) when it was reported. */
  sceneTime: number | null;
  /** stall / operator: how long (ms). */
  ms?: number;
  /** stall: the last bus message before it and how long before (ms). */
  bus?: string;
  sinceBusMs?: number;
  /** seek / late: the file, how many playing seeks in that second, the worst drift (ms), its start-up lag (ms). */
  file?: string;
  /** seek / late: what plays it (element = the platform's <video>; webcodecs = render/video, where a seek is a decoder restart). */
  engine?: "element" | "webcodecs";
  /** late: frames drawn late in that second, and frames that came too late to be drawn at all. */
  frames?: number;
  skipped?: number;
  seeks?: number;
  driftMaxMs?: number;
  startLagMs?: number;
  /** operator: the live scene's last fired cue when the hold ended (what was going on). */
  cue?: string;
}

const MAX = 300;
let events: PlaybackEvent[] = [];
let since = Date.now();

function push(e: Omit<PlaybackEvent, "at" | "sceneId" | "sceneTime">) {
  const rt = useShow.getState().program.runtime;
  events.push({ at: Date.now(), sceneId: rt?.scene.id ?? null, sceneTime: rt ? Math.round(sceneNow(rt, now())) / 1000 : null, ...e });
  if (events.length > MAX) events = events.slice(-MAX);
}

/** Record what an output heartbeat reports (called for every `output-status`). */
export function notePlayback(status: OutputStatus) {
  for (const s of status.stalls ?? []) push({ kind: "stall", ms: s.ms, bus: s.bus, sinceBusMs: s.sinceBusMs });
  for (const v of status.video ?? []) {
    if (v.playingSeeks) push({ kind: "seek", file: v.file, engine: v.engine, seeks: v.playingSeeks, driftMaxMs: v.driftMaxMs, startLagMs: v.startLagMs });
    if (v.late) push({ kind: "late", file: v.file, engine: v.engine, frames: v.late, skipped: v.skipped, driftMaxMs: v.driftMaxMs });
  }
}

/** The log, oldest first, and when it was last cleared. */
export function playbackLog(): { since: number; events: PlaybackEvent[] } {
  return { since, events: events.slice() };
}

export function clearPlaybackLog() {
  events = [];
  since = Date.now();
}

function lastFiredCue(): string | undefined {
  const rt = useShow.getState().program.runtime;
  const id = rt?.fired?.[rt.fired.length - 1];
  return id ? rt.scene.cues.find((c) => c.id === id)?.name : undefined;
}

/**
 * Watch this window's main thread: a 50 ms beat from a worker that arrives late means the page was busy.
 * Only while the window is visible (a hidden page's messages are held back by the browser, which is not a stall).
 */
export function watchOperatorStalls(): () => void {
  const BEAT = 50;
  let last = 0;
  let wasHidden = true;
  return steadyInterval(() => {
    const t = performance.now();
    const late = last ? t - last - BEAT : 0;
    last = t;
    const hidden = document.hidden;
    if (late > 100 && !hidden && !wasHidden) push({ kind: "operator", ms: Math.round(late), cue: lastFiredCue() });
    wasHidden = hidden;
  }, BEAT);
}
