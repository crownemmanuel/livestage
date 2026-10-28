// Operator-side services: authoritative simulation loop, cue runner, keyboard control,
// broadcasting state to the audience output window, output watchdog, live-state
// persistence and show-control I/O (incoming triggers, outgoing notifications, media markers).

import { now, sceneNow } from "@/core/clock";
import { onBus, packProgram, send } from "@/core/bus";
import { clipStateAt } from "@/core/clipActor";
import { LION_KEYMAP, LION_MOVE_KEYS } from "@/core/lion";
import { destroyOutputWindow, isOutputOpen, openOutputWindow, outputClosedByUs } from "@/core/platform";
import { applyCommand, createPoses, createRuntime, mediaElapsed, type Command } from "@/core/runtime";
import { stepActors, type ActorInput } from "@/core/sim";
import { steadyInterval } from "@/core/steadyTimer";
import type { Cue, CueAction, IoAction, MediaMarker, MediaSettings, Scene, SceneRuntime, TimerOp, TransitionSpec } from "@/core/types";
import { flowNext, sceneCodes } from "@/core/groups";
import { carriedSounds } from "@/core/music";
import { create } from "zustand";
import { layoutScene } from "./timeline";
import { useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { ioLog, sendMessage, setIoActionHandler, startIo } from "./io";
import { isSoundMicMessage, micMoveVerdict, type MicMove } from "@/core/soundControl";
// transport.ts imports this module too; only functions cross, at run time, so the cycle is safe.
import { knownDuration, probeDurations } from "./transport";
import { mirrorToStageLight } from "./stageLight";
import { chaseForCue, chaseForTake, chaseMusicOn, learnSoundLengths } from "./musicChase";
import { armLiveState, flushLiveState, loadLiveState, setPendingSource, startLiveStatePersistence, type PendingRecord } from "./persist";

// ---------------------------------------------------------------- take

export function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const done = (d: number | null) => {
      v.removeAttribute("src");
      v.load();
      resolve(d);
    };
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    v.src = url;
  });
}

/** Resolve the transition for a take, filling in video length and falling back safely. */
export async function resolveTransition(spec: TransitionSpec): Promise<TransitionSpec> {
  if (spec.kind !== "video") return spec;
  const asset = useProject.getState().project.assets.find((a) => a.id === spec.videoAssetId);
  if (!asset) return { ...spec, kind: "crossfade", duration: Math.max(spec.duration, 1) };
  const d = await probeDuration(asset.url);
  return { ...spec, duration: d ?? spec.duration };
}

let taking = false;

export async function takeScene(sceneId: string, override?: TransitionSpec | null): Promise<void> {
  const scene = useProject.getState().project.scenes.find((s) => s.id === sceneId);
  if (!scene || taking) return;
  taking = true;
  try {
    const show = useShow.getState();
    const spec = await resolveTransition(override ?? show.nextTransition ?? scene.transition);
    cancelPending("program");
    const live = show.program.standby ? null : show.program.runtime?.scene;
    const wasLive = live?.id ?? null;
    // The story goes on (carried music plays on) when the next scene in the running order is taken, or one
    // the live scene's own cues take; a retake or a jump is a fresh start.
    const scenes = useProject.getState().project.scenes;
    const order = scenes.findIndex((s) => s.id === wasLive);
    const continues =
      !!live &&
      live.id !== scene.id &&
      (scenes[order + 1]?.id === scene.id || live.cues.some((c) => c.actions.some((a) => a.type === "takeScene" && a.sceneId === scene.id)));
    const rt = show.program.runtime;
    // A run that went in sequence teaches when its scene hands over (for scenes that end on a GO or a TAKE).
    if (continues && rt && !jumpedRuns.has(rt.key)) useProject.getState().setCueTiming(rt.scene.id, "@end", sceneNow(rt) / 1000);
    // Out of running order: the music the story would have reached by now comes in where it would be.
    if (!continues && chaseMusicOn()) await learnSoundLengths();
    useShow.getState().take(scene, spec, continues, continues ? [] : chaseForTake(scene.id));
    // The operator was following the live scene (its cues on screen): follow it to the new one, so a cue
    // that takes the next scene brings that scene's cues up. A scene picked for rehearsal stays put.
    const proj = useProject.getState();
    if (wasLive && proj.selectedSceneId === wasLive) proj.selectScene(scene.id);
    notifyTake(scene);
  } finally {
    taking = false;
  }
}

export function sceneForPreview(sceneId: string): Scene | null {
  return useProject.getState().project.scenes.find((s) => s.id === sceneId) ?? null;
}

/** The scene after the live one (by running order). */
export function nextSceneId(): string | null {
  const scenes = useProject.getState().project.scenes;
  const live = useShow.getState().program.runtime?.scene.id;
  const i = scenes.findIndex((s) => s.id === live);
  return scenes[i + 1]?.id ?? (i < 0 ? scenes[0]?.id ?? null : null);
}

// ---------------------------------------------------------------- cues

interface Pending extends PendingRecord {
  handle: ReturnType<typeof setTimeout>;
}
const pending: Record<Target, Pending[]> = { program: [], preview: [] };

/** Follow cues waiting for their previous cue's delay: wall-clock ms to fire, and what to run. */
interface Follow {
  fireAt: number;
  run: () => void;
  handle: ReturnType<typeof setTimeout>;
}
const follows: Record<Target, Follow[]> = { program: [], preview: [] };

export function cancelPending(target: Target) {
  pending[target].forEach((p) => clearTimeout(p.handle));
  pending[target] = [];
  follows[target].forEach((f) => clearTimeout(f.handle));
  follows[target] = [];
  if (target === "preview") sceneWaits = null;
}

/**
 * Delayed actions and follow cues are setTimeouts, which a hidden or covered window throttles
 * (Chromium: to once a second). The 60 Hz service tick runs from a worker and is not throttled,
 * so it fires anything overdue itself instead of leaving it to the slowed timer.
 */
function fireOverdue(target: Target, wall: number) {
  const due = pending[target].filter((p) => p.fireAt <= wall);
  if (due.length) {
    for (const p of due) clearTimeout(p.handle);
    pending[target] = pending[target].filter((p) => p.fireAt > wall);
    for (const p of due) execAction(target, p.action);
  }
  const dueFollows = follows[target].filter((f) => f.fireAt <= wall);
  if (dueFollows.length) {
    for (const f of dueFollows) clearTimeout(f.handle);
    follows[target] = follows[target].filter((f) => f.fireAt > wall);
    for (const f of dueFollows) f.run();
  }
}

export function pendingCount(target: Target) {
  return pending[target].length;
}

function execAction(target: Target, a: CueAction) {
  if (a.type === "blackout") {
    // Lights-out is a live-output control; rehearsing in preview leaves the wall alone.
    if (target === "program") useShow.getState().setBlackout(a.on, a.fade);
    return;
  }
  if (a.type === "takeScene") {
    if (target === "program") void takeScene(a.sceneId, a.transition);
    else previewTake(a.sceneId);
    return;
  }
  if (a.type === "send") {
    // Messages leave the building only from the live show.
    if (target === "program") void sendMessage(a.message, { sceneId: useShow.getState().program.runtime?.scene.id ?? null });
    return;
  }
  if (a.type === "timer") {
    // Timers are show-wide; rehearsing a cue in the preview leaves them alone.
    if (target === "program") runTimer(a.timerId, a.op);
    return;
  }
  if (a.type === "announce") {
    if (target === "program") playAnnouncement(a.announcementId);
    return;
  }
  useShow.getState().dispatch(target, a);
}

function scheduleAction(target: Target, a: CueAction, fireAt: number, cueId?: string) {
  const delay = Math.max(0, fireAt - now());
  const rec: Pending = {
    target,
    fireAt,
    action: a,
    cueId,
    handle: setTimeout(() => {
      pending[target] = pending[target].filter((x) => x !== rec);
      execAction(target, a);
    }, delay),
  };
  pending[target].push(rec);
}

export function runCue(target: Target, cue: Cue) {
  const t0 = now();
  // Re-firing a cue replaces its earlier run: the delayed actions still waiting from it are dropped.
  const stale = pending[target].filter((p) => p.cueId === cue.id);
  if (stale.length) {
    stale.forEach((p) => clearTimeout(p.handle));
    pending[target] = pending[target].filter((p) => p.cueId !== cue.id);
  }
  if (target === "preview" && sceneWaits) sceneWaits.items = sceneWaits.items.filter((w) => w.cueId !== cue.id);
  for (const a of cue.actions) {
    if (a.delay > 0) scheduleAction(target, a, t0 + a.delay * 1000, cue.id);
    else execAction(target, a);
  }
}

function rtFor(target: Target) {
  const s = useShow.getState();
  return target === "program" ? s.program.runtime : s.preview;
}

/**
 * Fire cue `index` of the scene running on `target`: its actions, the GO pointer, and any
 * follow cues chained after it. Every way a cue fires (GO, scene time, follow, video marker) ends here.
 */
export function fireCue(target: Target, index: number, auto = false, rewind = false) {
  const rt = rtFor(target);
  const cue = rt?.scene.cues[index];
  if (!rt || !cue) return;
  // The operator fired a cue while a video transition is still covering the wall: end the transition so
  // the cue is seen now, instead of under the video until it finishes. Cues that fire by themselves
  // (scene time 0 and the like) leave the transition alone.
  const prog = useShow.getState().program;
  if (target === "program" && !auto && prog.transition?.spec.kind === "video") useShow.getState().finishTransition(prog.takeCount);
  if (target === "program") {
    // Fired by hand out of order (ahead of cues not run yet, or back): the music chases to where it would be.
    const jump = !auto && (index !== rt.cuePointer || rt.scene.cues.slice(0, index).some((c) => !rt.fired?.includes(c.id)));
    if (jump) {
      jumpedRuns.add(rt.key);
      if (chaseMusicOn()) {
        dropPendingSounds(cue.id);
        const events = chaseForCue(rt, index);
        if (events.length) useShow.getState().dispatch("program", { type: "sounds", events });
      }
    } else if (!jumpedRuns.has(rt.key) && cue.fire?.mode !== "time" && cue.fire?.mode !== "follow") {
      // A GO or video cue of a run in sequence: remember when it fired, for the chase's timeline.
      useProject.getState().setCueTiming(rt.scene.id, cue.id, sceneNow(rt) / 1000);
    }
  }
  useShow.getState().dispatch(target, { type: "cueFired", index, rewind });
  // A cue firing by itself while rehearsing must not swap the scene out from under the editor.
  // (A rehearsal run follows the show's takes on purpose.)
  runCue(target, auto && target === "preview" && !useRun.getState().on ? { ...cue, actions: cue.actions.filter((a) => a.type !== "takeScene") } : cue);
  if (target === "program") notifyCue(rt, index, cue);
  const next = rt.scene.cues[index + 1];
  if (next?.fire?.mode === "follow") {
    const key = rt.key;
    const run = () => {
      // Only if the same run of the scene is still up and the follow hasn't fired some other way.
      const cur = rtFor(target);
      if (cur?.key === key && !cur.fired?.includes(next.id)) fireCue(target, index + 1, true);
    };
    const delay = Math.max(0, next.fire.after) * 1000;
    const rec: Follow = {
      fireAt: now() + delay,
      run,
      handle: setTimeout(() => {
        follows[target] = follows[target].filter((x) => x !== rec);
        run();
      }, delay),
    };
    follows[target].push(rec);
  }
}

/** Live runs where the operator jumped: their cue timings are not learned (see Project.cueTimings). */
const jumpedRuns = new Set<string>();

/** A music chase replaces the sounds other cues of the live scene still had waiting to start. */
function dropPendingSounds(exceptCueId: string) {
  const drop = pending.program.filter((p) => p.action.type === "sound" && p.cueId !== exceptCueId);
  if (!drop.length) return;
  drop.forEach((p) => clearTimeout(p.handle));
  pending.program = pending.program.filter((p) => !drop.includes(p));
}

/** Scene-time cues whose moment has come. Called from the 60 Hz loop. */
function pollTimedCues(target: Target, rt: SceneRuntime, wall: number) {
  const t = sceneNow(rt, wall) / 1000;
  rt.scene.cues.forEach((c, i) => {
    // A seek counts as passing everything up to where it reached: a cue jumped over waits for GO.
    const passed = (rt.clock.reached ?? -1) / 1000;
    if (c.fire?.mode === "time" && t >= c.fire.at && c.fire.at > passed && !rt.fired?.includes(c.id)) fireCue(target, i, true);
  });
}

/** Take the next scene of a flowing group in place of a GO past the last cue. */
function goIntoNextScene(target: Target, rt: SceneRuntime): boolean {
  const next = flowNext(useProject.getState().project, rt.scene.id);
  if (!next) return false;
  if (target === "program") void takeScene(next.id);
  else {
    useProject.getState().selectScene(next.id);
    useShow.getState().setPreview(next);
  }
  return true;
}

/**
 * Show the preview as the scene looks after its first `step` cues: restart it, then apply those
 * cues at once (delays dropped, follow chains not run). Nothing is sent out.
 */
export function previewAtStep(step: number) {
  const show = useShow.getState();
  const cur = show.preview;
  if (!cur) return;
  cancelPending("preview");
  const scene = useProject.getState().project.scenes.find((s) => s.id === cur.scene.id) ?? cur.scene;
  show.setPreview(scene);
  scene.cues.slice(0, step).forEach((cue, i) => {
    for (const a of cue.actions) if (a.type !== "takeScene") execAction("preview", a);
    useShow.getState().dispatch("preview", { type: "cueFired", index: i });
  });
  useShow.getState().dispatch("preview", { type: "cuePointer", index: step });
}

// ---------------------------------------------------------------- timeline scrub (preview)

/**
 * What the cues fired by a timeline scrub still had to do, and follow cues due later. They wait on
 * the preview's scene clock (not the wall clock), so they hold while the preview is held and run
 * when it plays on. Polled with the timed cues; dropped when the preview starts another run.
 */
let sceneWaits: { key: string; items: { at: number; cueId: string; run: () => void }[] } | null = null;

/** Not rehearsed in the preview (execAction leaves them alone there too, or they would swap the scene). */
type Rehearsed = Exclude<CueAction, { type: "takeScene" | "send" | "timer" | "announce" | "blackout" }>;
const rehearsed = (a: CueAction): a is Rehearsed => !["takeScene", "send", "timer", "announce", "blackout"].includes(a.type);

/**
 * Show the preview as the scene looks `seconds` in, with cue i fired at `starts[i]` scene seconds
 * (the Build timeline's plan: GO cues at their planned holds; null = not fired). The preview is
 * rebuilt from the top with every action up to that moment applied at its own scene time, then
 * held there; Play carries on from that frame. Nothing is sent out.
 */
export function previewAtTime(seconds: number, starts: (number | null)[]) {
  const cur = useShow.getState().preview;
  if (!cur) return;
  cancelPending("preview");
  const scene = useProject.getState().project.scenes.find((s) => s.id === cur.scene.id) ?? cur.scene;
  const T = Math.max(0, seconds);
  const wall = now();
  const base = wall - T * 1000;
  // Same run key: the preview canvas (and its video decoders) stays mounted while scrubbing.
  let rt = { ...createRuntime(scene, base), key: cur.key };
  let poses = createPoses(scene);
  const steps: { t: number; i: number; j: number; cmd: Command }[] = [];
  const waits: NonNullable<typeof sceneWaits>["items"] = [];
  scene.cues.forEach((cue, i) => {
    const s = starts[i];
    if (s == null || s > T) return;
    steps.push({ t: s, i, j: -1, cmd: { type: "cueFired", index: i } });
    cue.actions.forEach((a, j) => {
      if (!rehearsed(a)) return;
      const at = s + Math.max(0, a.delay || 0);
      if (at <= T) steps.push({ t: at, i, j, cmd: a });
      else waits.push({ at: at * 1000, cueId: cue.id, run: () => execAction("preview", a) });
    });
    const next = scene.cues[i + 1];
    if (next?.fire?.mode === "follow" && s + next.fire.after > T) waits.push({ at: (s + next.fire.after) * 1000, cueId: cue.id, run: () => fireCue("preview", i + 1, true) });
  });
  steps.sort((a, b) => a.t - b.t || a.i - b.i || a.j - b.j);
  for (const st of steps) ({ rt, poses } = applyCommand(rt, poses, st.cmd, base + st.t * 1000));
  // Held on that frame; everything up to it counts as played, so it does not fire again.
  rt = { ...rt, clock: { base, pausedAt: wall, reached: T * 1000 } };
  useShow.setState({ preview: rt, previewPoses: poses, previewPosesAt: wall });
  lastPoll.preview = null;
  sceneWaits = waits.length ? { key: rt.key, items: waits.sort((a, b) => a.at - b.at) } : null;
}

function pollSceneWaits(rt: SceneRuntime, wall: number) {
  const w = sceneWaits;
  if (!w) return;
  if (w.key !== rt.key) {
    sceneWaits = null;
    return;
  }
  const t = sceneNow(rt, wall);
  const due = w.items.filter((x) => x.at <= t);
  if (!due.length) return;
  w.items = w.items.filter((x) => x.at > t);
  if (!w.items.length) sceneWaits = null;
  due.forEach((x) => x.run());
}

// ---------------------------------------------------------------- rehearsal run (Build)

/**
 * The preview takes another scene (a take-scene action, or a rehearsal run moving on): Build follows
 * it, and music that keeps playing carries on into it, as it does on the wall.
 */
function previewTake(sceneId: string) {
  const s = sceneForPreview(sceneId);
  if (!s) return;
  const old = useShow.getState().preview;
  cancelPending("preview");
  useProject.getState().selectScene(s.id);
  useShow.getState().setPreview(s);
  const nu = useShow.getState().preview;
  if (old && nu && old.clock.pausedAt === null) {
    const events = carriedSounds(old, nu.clock.base, now());
    if (events.length) useShow.getState().dispatch("preview", { type: "sounds", events });
  }
}

/**
 * A run of the show in the Build preview, as if the operator were pressing GO: each scene from its
 * TAKE, its GO cues fired at their planned holds on the timeline (core/timeline.ts), take-scene
 * actions followed into the next scene, and a scene that ends without one followed by the next in
 * running order. Nothing is sent out, as in any preview; holding the preview holds the run.
 */
export const useRun = create<{ on: boolean }>(() => ({ on: false }));
/** The timeline of the scene the run is in: when each cue starts and where the scene ends (seconds). */
let runPlan: { key: string; starts: (number | null)[]; end: number } | null = null;
let runLoading: string | null = null;

/** Start a run from the top of the scene in the preview (as TAKE does), or of `sceneId`. */
export function startRun(sceneId?: string) {
  const id = sceneId ?? useShow.getState().preview?.scene.id;
  const scene = id ? sceneForPreview(id) : null;
  if (!scene) return;
  cancelPending("preview");
  runPlan = null;
  runLoading = null;
  useProject.getState().selectScene(scene.id);
  useShow.getState().setPreview(scene);
  useRun.setState({ on: true });
}

export function stopRun() {
  runPlan = null;
  runLoading = null;
  useRun.setState({ on: false });
}

function pollRun(rt: SceneRuntime, wall: number) {
  if (!useRun.getState().on) return;
  if (runPlan?.key !== rt.key) {
    // A new scene (or run of it): lay out its timeline first.
    if (runLoading === rt.key) return;
    runLoading = rt.key;
    runPlan = null;
    const key = rt.key;
    const scene = sceneForPreview(rt.scene.id) ?? rt.scene;
    void layoutScene(scene).then((tl) => {
      if (runLoading === key) runPlan = { key, starts: tl.cues.map((c) => c.start), end: tl.end };
    });
    return;
  }
  if (rt.clock.pausedAt !== null) return;
  const t = sceneNow(rt, wall) / 1000;
  // The next cue in line is a GO whose planned hold is up: press it.
  const i = rt.cuePointer;
  const cue = rt.scene.cues[i];
  const at = runPlan.starts[i];
  if (cue && (cue.fire?.mode ?? "go") === "go" && at != null && t >= at) {
    fireCue("preview", i, true);
    return;
  }
  // The scene ran out without taking another: the next one in running order (the end of the show stops the run).
  if (t >= runPlan.end + 0.5) {
    const scenes = useProject.getState().project.scenes;
    const next = scenes[scenes.findIndex((x) => x.id === rt.scene.id) + 1];
    runPlan = null;
    runLoading = null;
    if (next) previewTake(next.id);
    else stopRun();
  }
}

export const cueControl = {
  go(target: Target) {
    const rt = rtFor(target);
    if (!rt) return;
    // A cue that fires by itself (AUTO) still goes on GO: the operator fires it early.
    if (!rt.scene.cues[rt.cuePointer]) {
      goIntoNextScene(target, rt);
      return;
    }
    fireCue(target, rt.cuePointer);
  },
  /** Fire now: fire cue `index` and rewind the list to it, so the cues after it are up again. */
  fire(target: Target, index: number) {
    fireCue(target, index, false, true);
  },
  repeat(target: Target) {
    const rt = rtFor(target);
    if (!rt || rt.cuePointer === 0) return;
    const cue = rt.scene.cues[rt.cuePointer - 1];
    if (cue) runCue(target, cue);
  },
  back(target: Target) {
    const rt = rtFor(target);
    if (rt) useShow.getState().dispatch(target, { type: "cuePointer", index: rt.cuePointer - 1 });
  },
  skip(target: Target) {
    const rt = rtFor(target);
    if (rt) useShow.getState().dispatch(target, { type: "cuePointer", index: rt.cuePointer + 1 });
  },
  set(target: Target, index: number) {
    useShow.getState().dispatch(target, { type: "cuePointer", index });
  },
};

// ---------------------------------------------------------------- timers and announcements

export function runTimer(id: string, op: TimerOp | "add", seconds?: number) {
  const def = useProject.getState().project.timers?.find((t) => t.id === id);
  if (!def) return ioLog("error", "A cue points at a timer that no longer exists");
  useShow.getState().timer(id, op, { duration: def.duration, seconds });
}

export function playAnnouncement(id: string) {
  const a = useProject.getState().project.announcements?.find((x) => x.id === id);
  if (!a?.assetId) return ioLog("error", `Announcement ${a ? `"${a.name}" has no audio` : "no longer exists"}`);
  useShow.getState().announce({ id: a.id, assetId: a.assetId, volume: a.volume });
}

export function stopAnnouncement() {
  useShow.getState().announce(null);
}

/** Timers that just reached 0:00: stop them there and play their end announcement. */
function pollTimers(wall: number) {
  const s = useShow.getState();
  const runs = s.program.timers;
  if (!runs) return;
  for (const [id, r] of Object.entries(runs)) {
    if (!r.running || r.endsAt > wall) continue;
    s.timer(id, "pause", { duration: 0 });
    const def = useProject.getState().project.timers?.find((t) => t.id === id);
    ioLog("info", `Timer "${def?.name ?? id}" reached 0:00`);
    if (def?.endAnnouncementId) playAnnouncement(def.endAnnouncementId);
  }
}

// ---------------------------------------------------------------- outgoing notifications

function notifyTarget() {
  const io = useProject.getState().project.io;
  if (!io?.osc.notify || !io.osc.enabled) return null;
  return io.osc.notifyTarget ?? io.osc.targets[0]?.id ?? null;
}

/** A scene's running-order code ("12", "1.2"), as the operator sees it. */
const codeOf = (scene: Scene) => sceneCodes(useProject.getState().project).get(scene.id) ?? String(scene.number);

function notifyTake(scene: Scene) {
  const target = notifyTarget();
  if (target) void sendMessage({ type: "osc", target, address: "/sls/scene", args: [scene.number, scene.name] });
  mirrorToStageLight({ take: codeOf(scene) }, (m) => void sendMessage(m));
}

function notifyCue(rt: SceneRuntime, index: number, cue: Cue) {
  const target = notifyTarget();
  if (target) void sendMessage({ type: "osc", target, address: "/sls/cue", args: [rt.scene.number, index + 1, cue.name] });
  mirrorToStageLight({ cue: codeOf(rt.scene), number: index + 1 }, (m) => void sendMessage(m));
}

// ---------------------------------------------------------------- incoming show-control actions

function runIoAction(a: IoAction, source: string) {
  const show = useShow.getState();
  const proj = useProject.getState();
  const scenes = proj.project.scenes;
  ioLog("info", `${source} → ${describeIoAction(a)}`);
  switch (a.type) {
    case "go":
      cueControl.go("program");
      break;
    case "back":
      cueControl.back("program");
      break;
    case "take":
      if (!show.program.transition) void takeScene(a.sceneId);
      break;
    case "takeNext": {
      const id = nextSceneId();
      if (id && !show.program.transition) void takeScene(id);
      break;
    }
    case "fireCue": {
      const live = show.program.runtime;
      if (live && live.scene.id === a.sceneId && !show.program.standby) cueControl.fire("program", a.index);
      else {
        // Not live yet: take it, then fire the cue once the take has landed.
        void takeScene(a.sceneId).then(() => {
          const rt = useShow.getState().program.runtime;
          if (rt?.scene.id === a.sceneId) cueControl.fire("program", a.index);
        });
      }
      break;
    }
    case "blackout":
      show.setBlackout(a.on === "toggle" ? !show.program.blackout?.on : a.on);
      break;
    case "standby":
      show.setStandby(a.on === "toggle" ? !show.program.standby : a.on);
      break;
    case "freeze":
      show.dispatch("program", { type: "clock", op: a.op });
      break;
    case "select":
      proj.selectScene(a.sceneId);
      break;
    case "selectNext":
    case "selectPrev": {
      const i = scenes.findIndex((s) => s.id === proj.selectedSceneId);
      const n = scenes[Math.max(0, Math.min(scenes.length - 1, i + (a.type === "selectNext" ? 1 : -1)))];
      if (n) proj.selectScene(n.id);
      break;
    }
  }
}

export function describeIoAction(a: IoAction): string {
  const scenes = useProject.getState().project.scenes;
  const name = (id: string) => {
    const s = scenes.find((x) => x.id === id);
    return s ? `${s.number}. ${s.name}` : "missing scene";
  };
  switch (a.type) {
    case "go":
      return "GO (next live cue)";
    case "back":
      return "Back one cue";
    case "take":
      return `Take ${name(a.sceneId)}`;
    case "takeNext":
      return "Take the next scene";
    case "fireCue":
      return `Fire cue ${a.index + 1} of ${name(a.sceneId)}`;
    case "blackout":
      return a.on === "toggle" ? "Toggle blackout" : a.on ? "Blackout" : "Lights up";
    case "standby":
      return a.on === "toggle" ? "Toggle standby" : a.on ? "Standby" : "Leave standby";
    case "freeze":
      return a.op === "toggle" ? "Toggle freeze" : a.op === "pause" ? "Freeze" : "Resume";
    case "select":
      return `Preview ${name(a.sceneId)}`;
    case "selectNext":
      return "Preview next scene";
    case "selectPrev":
      return "Preview previous scene";
  }
}

// ---------------------------------------------------------------- media markers
//
// Markers fire only during normal playback, for media time actually played past for the first
// time in this run of the scene. Scrubbing (seek, clip.seek) is a jump: markers in the stretch
// jumped across do not fire, and after scrubbing back, markers already passed do not fire again
// on the replay. Holding (freeze) fires nothing. The "already passed" point is stored in the
// runtime (clock.reached, a clip segment's skip), so a reload of the operator window agrees.
// Natural loops and fresh starts (new clip, layer restart, background change) fire again.

/** Scene time (ms) of the previous marker poll, per target, for the run it belongs to. */
const lastPoll: Record<Target, { key: string; t: number } | null> = { program: null, preview: null };

/** After a reload, look back this far for markers (the first frames of a fresh clip still fire). */
const CATCH_UP_MS = 500;

interface HostState {
  /** Identity of this playthrough of the media: a change means it (re)started. */
  run: string;
  /** Media time (s) for marker purposes. */
  pos: number;
  loop: boolean;
  /** Media seconds that count as passed in this playthrough. */
  skip: number;
  markers: MediaMarker[] | undefined;
  /** Media seconds where this playthrough ends by itself (null = loops or unknown). */
  end: number | null;
}

/** Where a media component is at scene time `t` (ms), or null when it is not playing then. */
function hostState(rt: SceneRuntime, c: Scene["components"][number], t: number): HostState | null {
  if (c.kind === "clipActor") {
    const st = clipStateAt(c, rt.clipActors?.[c.id], t);
    if (!st.clip || !st.segment) return null;
    return { run: `${st.clip.id}@${st.segment.at}`, pos: st.localT, loop: !!st.clip.loop, skip: st.segment.skip ?? -1, markers: st.clip.markers, end: st.clip.loop ? null : st.clip.duration || null };
  }
  if (c.kind === "background" && c.source === "media") {
    if (rt.background.current !== c.id) return null;
    const startAt = Math.max(0, rt.background.changedAt);
    if (t < startAt) return null;
    const el = mediaElapsed(rt, c.id, startAt, t, c.media.playbackRate);
    return { run: `${c.media.assetId}@${startAt}`, pos: markerTime(c.media, el), loop: c.media.loop, skip: -1, markers: c.media.markers, end: c.media.loop ? null : (c.media.endTime ?? knownDuration(c.media.assetId) ?? null) };
  }
  if (c.kind === "video") {
    const l = rt.layers[c.id];
    if (!l?.visible || t < l.startAt) return null;
    const el = mediaElapsed(rt, c.id, l.startAt, t, c.media.playbackRate);
    return { run: `${c.media.assetId}@${l.startAt}`, pos: markerTime(c.media, el), loop: c.media.loop, skip: -1, markers: c.media.markers, end: c.media.loop ? null : (c.media.endTime ?? knownDuration(c.media.assetId) ?? null) };
  }
  return null;
}

/** Markers crossed going from state `a` to state `b` by normal playback. */
function crossed(a: HostState | null, b: HostState): MediaMarker[] {
  const ms = b.markers ?? [];
  if (!ms.length) return [];
  const live = (m: MediaMarker) => m.at > b.skip;
  // Fresh playthrough: anything between its start and now (a marker at 0 fires on the first frame).
  if (!a || a.run !== b.run) return ms.filter((m) => m.at >= 0 && m.at <= b.pos && live(m));
  if (b.pos >= a.pos) return ms.filter((m) => m.at > a.pos && m.at <= b.pos && live(m));
  // Wrapped around the loop boundary: a new pass, so a clip's scrub skip no longer applies after the wrap.
  if (b.loop) return ms.filter((m) => (m.at > a.pos && live(m)) || m.at <= b.pos);
  return [];
}

function pollMarkers(target: Target, rt: SceneRuntime, wall: number) {
  const t = sceneNow(rt, wall);
  const last = lastPoll[target];
  lastPoll[target] = { key: rt.key, t };
  const prev = last?.key === rt.key ? last.t : t - CATCH_UP_MS;
  if (target === "program") watchMicMoves(rt, t, wall);
  // Only scene time played for the first time in this run counts.
  const from = Math.max(prev, rt.clock.reached ?? -Infinity);
  if (!(t > from)) return;
  const fire = (m: MediaMarker, c: Scene["components"][number], b: HostState) => {
    if (!m.cueId) {
      // Messages leave the building only from the live show.
      if (target === "program") {
        if (isSoundMicMessage(m.message)) noteMicMoved(rt, c, b, t, wall);
        void sendMessage(m.message, { sceneId: rt.scene.id });
      }
      return;
    }
    const i = rt.scene.cues.findIndex((c) => c.id === m.cueId);
    if (i >= 0) {
      if (target === "program" && rt.scene.cues[i].actions.some((a) => a.type === "send" && isSoundMicMessage(a.message))) noteMicMoved(rt, c, b, t, wall);
      fireCue(target, i, true);
    } else if (target === "program") ioLog("error", `Marker "${m.name}" points at a cue that no longer exists`);
  };
  for (const c of rt.scene.components) {
    const b = hostState(rt, c, t);
    if (!b?.markers?.length) continue;
    for (const m of crossed(hostState(rt, c, from), b)) fire(m, c, b);
  }
}

// ---------------------------------------------------------------- StageMics restore
//
// A marker that sets a mic or a voice effect through StageMics (op mic / fx) changes it outside
// StageMics' cue list: e.g. Joseph muted while his recorded vocal plays, unmuted by a later
// marker. If the media that sent it stops, restarts or jumps (a scrub either way, another scene
// taken), that later marker may never run, so LiveStage sends /sound/restore once and StageMics
// puts every mic back to its active cue. Playing to the natural end needs nothing (docs/SHOW_CONTROL.md).

/** Live media (component id) that moved a mic through StageMics, and where it was. */
const micMoves = new Map<string, MicMove & { name: string }>();

function noteMicMoved(rt: SceneRuntime, c: Scene["components"][number], b: HostState, t: number, wall: number) {
  // Learn the video's length (once), so playing to its end is not mistaken for a stop.
  if ((c.kind === "video" || c.kind === "background") && "media" in c && c.media.assetId && b.end === null && !c.media.loop) void probeDurations(useShow.getState().assets, [c.media.assetId]);
  micMoves.set(c.id, { rtKey: rt.key, run: b.run, pos: b.pos, end: b.end, name: c.name, t, wall, paused: rt.clock.pausedAt != null });
}

function watchMicMoves(rt: SceneRuntime, t: number, wall: number) {
  if (!micMoves.size) return;
  let why: string | null = null;
  const paused = rt.clock.pausedAt != null;
  for (const [id, w] of micMoves) {
    const c = rt.key === w.rtKey ? rt.scene.components.find((x) => x.id === id) : undefined;
    const b = c ? hostState(rt, c, t) : null;
    const v = micMoveVerdict(w, { rtKey: rt.key, run: b?.run ?? null, pos: b?.pos ?? 0, end: b?.end ?? null, t, wall, paused });
    if (v === "keep") Object.assign(w, { pos: b!.pos, end: b!.end, t, wall, paused });
    else {
      micMoves.delete(id);
      if (v !== "finished") why ??= `${w.name} ${v}`;
    }
  }
  if (why) {
    ioLog("info", `StageMics restore: ${why} after moving a mic`);
    void sendMessage({ type: "sound", op: "restore" }, { sceneId: rt.scene.id });
  }
}

/** Media time for marker purposes: loops only when an end time is known. */
function markerTime(m: MediaSettings, elapsed: number) {
  const end = m.endTime;
  if (m.loop && end && end > m.startTime) return m.startTime + (elapsed % (end - m.startTime));
  return m.startTime + elapsed;
}

// ---------------------------------------------------------------- keyboard

const held = new Set<string>();

function typingInField(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || el.getAttribute("role") === "slider";
}

function currentInput(): ActorInput {
  return {
    moveX: (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0),
    moveZ: (held.has("KeyS") ? 1 : 0) - (held.has("KeyW") ? 1 : 0),
    turn: (held.has("KeyQ") ? 1 : 0) - (held.has("KeyE") ? 1 : 0),
    run: held.has("ShiftLeft") || held.has("ShiftRight"),
  };
}

function onKeyDown(e: KeyboardEvent) {
  if (typingInField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const { lionControl, dispatch } = useShow.getState();
  if (!lionControl.armed || !lionControl.actorId) return;
  const actorId = lionControl.actorId;
  if (LION_MOVE_KEYS.includes(e.code) || e.code.startsWith("Shift")) {
    held.add(e.code);
    e.preventDefault();
    return;
  }
  const action = LION_KEYMAP[e.code];
  if (!action || e.repeat) return;
  e.preventDefault();
  dispatch(lionControl.target, { type: "lion", actorId, action: action === "stop" ? "idle" : action, delay: 0 });
}

function onKeyUp(e: KeyboardEvent) {
  held.delete(e.code);
}

function onBlur() {
  held.clear();
}

// ---------------------------------------------------------------- recovery

/**
 * After the project has loaded: bring back whatever was on the wall when the operator
 * window last ran, and re-arm delayed actions that were still pending.
 */
export async function restoreLiveState(): Promise<boolean> {
  const st = await loadLiveState();
  // From here on the live state may be written; before this point a write would clobber the saved show.
  armLiveState();
  // A show file from before sound levels were saved in it: adopt the mixer trims the live state still has.
  const P = useProject.getState();
  if (P.project.mix === undefined && st?.program?.mix && Object.keys(st.program.mix).length) P.setMix(st.program.mix);
  // Nothing on the wall when we went down: a fresh start is the honest state.
  if (!st?.program?.runtime) return false;
  const p = st.program;
  const scenes = useProject.getState().project.scenes;
  // The saved runtime carries its own copy of the scene, so it works even if the scene was edited since.
  if (p.runtime && !scenes.some((s) => s.id === p.runtime!.scene.id)) return false;
  // The show file's sound levels win over the copy in the live state (a show taken in since, say).
  useShow.getState().restoreProgram({ ...p, mix: { ...(useProject.getState().project.mix ?? {}) } }, st!.poses ?? {});
  const t = now();
  let rearmed = 0;
  for (const rec of st!.pending ?? []) {
    if (rec.target !== "program") continue;
    // Late by less than two seconds: still fire it (the audience is waiting for it); later than that it is stale.
    if (rec.fireAt < t - 2000) continue;
    scheduleAction("program", rec.action, Math.max(t + 50, rec.fireAt), rec.cueId);
    rearmed++;
  }
  ioLog("info", `Resumed live state: ${p.runtime ? `${p.runtime.scene.name}, next cue ${p.runtime.cuePointer + 1}` : "standby"}${rearmed ? `, ${rearmed} delayed action(s) re-armed` : ""}`);
  return true;
}

// ---------------------------------------------------------------- sound levels

const sameMix = (a: Record<string, number> = {}, b: Record<string, number> = {}) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/**
 * The live mixer's trims (ProgramState.mix) and the show file's sound levels (Project.mix) are one thing:
 * a fader move is saved with the show, and a show taken in (or edited by an agent) brings its levels to the
 * mixer. Only the operator window runs this.
 */
function startSoundLevels(): () => void {
  const toProject = useShow.subscribe((s, prev) => {
    if (s.program.mix === prev.program.mix) return;
    const P = useProject.getState();
    if (P.loaded && !sameMix(s.program.mix, P.project.mix)) P.setMix(s.program.mix ?? {});
  });
  const toMixer = () => {
    const { loaded, project } = useProject.getState();
    const program = useShow.getState().program;
    if (loaded && project.mix && !sameMix(project.mix, program.mix)) useShow.setState({ program: { ...program, mix: { ...project.mix } } });
  };
  const offProject = useProject.subscribe((s, prev) => (s.project.mix !== prev.project.mix || s.loaded !== prev.loaded) && toMixer());
  toMixer();
  return () => {
    toProject();
    offProject();
  };
}

// ---------------------------------------------------------------- services

/** No heartbeat for this long while the window still exists: its page is hung, not slow. */
const OUTPUT_HUNG_MS = 8000;
/** A reopened output gets this long to report in before the watchdog tries again. */
const REOPEN_GRACE_MS = 15000;

/** Poll `cond` every 100 ms until it holds or `timeoutMs` passes. */
async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Trailing-edge throttle: at most one call per `ms`, always ending with the latest. */
function throttle(fn: () => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    const dt = now() - last;
    if (dt >= ms && !timer) {
      last = now();
      fn();
      return;
    }
    if (!timer) {
      timer = setTimeout(
        () => {
          timer = null;
          last = now();
          fn();
        },
        Math.max(0, ms - dt),
      );
    }
  };
}

export function startOperatorServices(): () => void {
  const cleanups: (() => void)[] = [];

  // Authoritative actor simulation at 60 Hz; the same tick watches media markers and fires overdue
  // delayed actions. Driven from a worker, so a covered operator window cannot slow the show down.
  let last = now();
  const stopSim = steadyInterval(() => {
    const t = now();
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    fireOverdue("program", t);
    fireOverdue("preview", t);
    const s = useShow.getState();
    pollTimers(t);
    const input = currentInput();
    const lc = s.lionControl;
    const inputsFor = (target: Target) => (lc.armed && lc.actorId && lc.target === target ? { [lc.actorId]: input } : {});
    if (s.program.runtime) {
      const p = stepActors(s.program.runtime, s.programPoses, inputsFor("program"), dt, t);
      if (p !== s.programPoses) s.setPoses("program", p, t);
      if (!s.program.standby) {
        pollMarkers("program", s.program.runtime, t);
        pollTimedCues("program", s.program.runtime, t);
      }
    }
    if (s.preview) {
      const p = stepActors(s.preview, s.previewPoses, inputsFor("preview"), dt, t);
      if (p !== s.previewPoses) s.setPoses("preview", p, t);
      // Rehearsal: video markers and timed cues run in the preview too (nothing is sent out).
      const pv = useShow.getState().preview;
      if (pv) {
        pollMarkers("preview", pv, t);
        pollTimedCues("preview", pv, t);
        pollSceneWaits(pv, t);
        pollRun(pv, t);
      }
    }
  }, 1000 / 60);
  cleanups.push(stopSim);

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  cleanups.push(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  });

  // Mirror project assets/output settings into the show store (shared with output).
  const syncProject = () => {
    const { project } = useProject.getState();
    const s = useShow.getState();
    if (s.assets !== project.assets || s.output !== project.output) useShow.setState({ assets: project.assets, output: project.output });
  };
  syncProject();
  cleanups.push(useProject.subscribe(syncProject));
  cleanups.push(startSoundLevels());
  const syncTimers = () => useShow.getState().syncTimers(useProject.getState().project.timers ?? []);
  syncTimers();
  cleanups.push(useProject.subscribe((p, prev) => p.project.timers !== prev.project.timers && syncTimers()));

  // Broadcast program state on change (coalesced to ~30 Hz so a live slider cannot flood IPC), poses at ≤30 Hz.
  const sendProject = () => {
    const s = useShow.getState();
    void send({ type: "project", assets: s.assets, output: s.output });
  };
  // Live state goes on every change; the scene definition inside each runtime goes once per run
  // (and whenever the output asks for a full resync), see packProgram.
  const sentScenes = new Map<string, Scene>();
  const sendProgramNow = (full = false) => void send(packProgram(useShow.getState().program, sentScenes, full));
  const sendProgram = throttle(() => sendProgramNow(), 33);
  let poseTimer: ReturnType<typeof setTimeout> | null = null;
  const sendPoses = () => {
    poseTimer = null;
    const s = useShow.getState();
    void send({ type: "poses", program: s.programPoses, from: s.fromPoses });
  };
  cleanups.push(
    useShow.subscribe((s, prev) => {
      if (s.assets !== prev.assets || s.output !== prev.output) sendProject();
      if (s.program !== prev.program) {
        // A TAKE must not wait behind the throttle: the pre-roll budget is for IPC, not for us.
        if (s.program.takeCount !== prev.program.takeCount) sendProgramNow();
        else sendProgram();
      }
      if ((s.programPoses !== prev.programPoses || s.fromPoses !== prev.fromPoses) && !poseTimer) {
        poseTimer = setTimeout(sendPoses, 33);
      }
    }),
  );

  cleanups.push(
    onBus((msg) => {
      if (msg.type === "hello") {
        sendProject();
        sendProgramNow(true);
        sendPoses();
        useShow.setState({ outputSeenAt: Date.now(), outputLostAt: null });
      } else if (msg.type === "output-status") {
        useShow.setState({ outputStatus: msg.status, outputSeenAt: Date.now(), outputLostAt: null });
      } else if (msg.type === "output-bye") {
        useShow.setState({ outputStatus: null, outputSeenAt: 0, outputLostAt: null });
      }
    }),
  );

  // Belt and braces: re-send the live state every few seconds so a missed message never sticks. Not the
  // scenes: the output keeps the scene object it has, and asks (hello) for a full resync if it lacks one.
  const resend = setInterval(() => sendProgramNow(), 5000);
  cleanups.push(() => clearInterval(resend));

  // Output watchdog: a heartbeat that stops without a goodbye means the output window died, or its
  // page hung. WebKit can wait forever handing a video frame to WebGL (seen 2026-10-27: the output's
  // WebContent process stuck in a sync call to the GPU process, the window still up, the wall black),
  // and a hung page never recovers by itself, so after OUTPUT_HUNG_MS without a heartbeat the window
  // is torn down and built again even though it still exists. A window we reopened gets
  // REOPEN_GRACE_MS to report in before the next attempt.
  let reopenAt = 0;
  let recreating = false;
  const recover = async (silentMs: number) => {
    recreating = true;
    try {
      const open = await isOutputOpen();
      // Alive but slow (a cold TAKE compiles shaders for a second or two): give it a moment longer.
      if (open && silentMs < OUTPUT_HUNG_MS) return;
      if (open) {
        ioLog("error", `Output window is not responding (no heartbeat for ${Math.round(silentMs / 1000)} s): recreating it`);
        await destroyOutputWindow();
        await waitUntil(async () => !(await isOutputOpen()), 3000);
      } else ioLog("info", "Reopening the output window");
      useShow.setState({ outputStatus: null, outputSeenAt: 0 });
      await openOutputWindow(useProject.getState().project.output);
    } catch (e) {
      ioLog("error", `Reopen failed: ${String(e)}`);
    } finally {
      recreating = false;
    }
  };
  const watchdog = setInterval(() => {
    const s = useShow.getState();
    const silentMs = Date.now() - s.outputSeenAt;
    if (s.outputStatus && silentMs < 4000) return; // healthy
    if (outputClosedByUs) {
      if (s.outputStatus || s.outputLostAt) useShow.setState({ outputStatus: null, outputSeenAt: 0, outputLostAt: null });
      return;
    }
    // Never opened, or closed with a goodbye: nothing to recover.
    if (!s.outputStatus && !s.outputLostAt) return;
    if (!s.outputLostAt) {
      useShow.setState({ outputLostAt: Date.now() });
      ioLog("error", "Output window stopped responding");
    }
    if (recreating || Date.now() - reopenAt < (s.outputStatus ? 4000 : REOPEN_GRACE_MS)) return;
    reopenAt = Date.now();
    void recover(s.outputStatus ? silentMs : Infinity);
  }, 1000);
  cleanups.push(() => clearInterval(watchdog));

  // Live-state persistence (crash / reload recovery) and show-control I/O.
  setPendingSource(() => pending.program.map(({ target, fireAt, action, cueId }) => ({ target, fireAt, action, cueId })));
  cleanups.push(startLiveStatePersistence());
  setIoActionHandler(runIoAction);
  cleanups.push(startIo());

  return () => {
    void flushLiveState();
    cleanups.forEach((c) => c());
  };
}

export function useOutputConnected() {
  // Output sends a status heartbeat every second.
  return useShow((s) => s.outputSeenAt > 0 && Date.now() - s.outputSeenAt < 3500 && !!s.outputStatus);
}
