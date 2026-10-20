// Live-state persistence: what is on the wall right now, which cue is next and which
// delayed actions are still pending. Saved on every change (debounced) so a reload or
// crash of the operator window comes back exactly where the show was.

import { now } from "@/core/clock";
import { loadStateFile, saveStateFile } from "@/core/platform";
import type { ActorPoses, CueAction, ProgramState } from "@/core/types";
import { useShow } from "@/store/show";

export interface PendingRecord {
  target: "program" | "preview";
  /** Wall-clock ms the action must fire. */
  fireAt: number;
  action: CueAction;
  /** The cue that scheduled it: re-firing that cue cancels its leftovers. */
  cueId?: string;
}

export interface LiveState {
  version: 1;
  savedAt: number;
  program: ProgramState;
  poses: ActorPoses;
  pending: PendingRecord[];
}

/** Older than this and the saved state is history, not a show in progress. */
const MAX_AGE_MS = 12 * 3600 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastWritten = "";
let pendingSource: () => PendingRecord[] = () => [];
/** Nothing is written until the start-up restore has run, so a fresh window never overwrites the saved show. */
let armed = false;

export function armLiveState() {
  armed = true;
}

export function setPendingSource(fn: () => PendingRecord[]) {
  pendingSource = fn;
}

function snapshot(): LiveState {
  const s = useShow.getState();
  const program: ProgramState = { ...s.program, transition: null };
  return { version: 1, savedAt: now(), program, poses: s.programPoses, pending: pendingSource().filter((p) => p.target === "program") };
}

export function flushLiveState(): Promise<void> {
  if (!armed) return Promise.resolve();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const snap = snapshot();
  // Poses change 60×/s; only the rest decides whether a write is needed.
  const key = JSON.stringify({ ...snap, savedAt: 0, poses: null });
  if (key === lastWritten) return Promise.resolve();
  lastWritten = key;
  return saveStateFile(snap).catch((e) => console.warn("live state save failed", e));
}

function schedule() {
  if (!armed || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushLiveState();
  }, 250);
}

/** Start saving. Returns a stop function. */
export function startLiveStatePersistence(): () => void {
  const unsub = useShow.subscribe((s, prev) => {
    if (s.program !== prev.program) schedule();
  });
  const onHide = () => {
    if (document.visibilityState === "hidden") void flushLiveState();
  };
  const onUnload = () => void flushLiveState();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("beforeunload", onUnload);
  // Poses are saved on a slow tick so the lion comes back roughly where it was.
  const poseTick = setInterval(() => {
    const s = useShow.getState();
    if (s.program.runtime && Object.keys(s.programPoses).length) void saveStateFile(snapshot()).catch(() => {});
  }, 5000);
  return () => {
    unsub();
    clearInterval(poseTick);
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("beforeunload", onUnload);
  };
}

/** Load the saved live state if it is recent enough to be this show. */
export async function loadLiveState(): Promise<LiveState | null> {
  const st = await loadStateFile<LiveState>();
  if (!st || st.version !== 1 || !st.program) return null;
  if (now() - st.savedAt > MAX_AGE_MS) return null;
  return st;
}

export function clearLiveState() {
  armed = true;
  lastWritten = "";
  void saveStateFile({ version: 1, savedAt: 0, program: null, poses: {}, pending: [] });
}
