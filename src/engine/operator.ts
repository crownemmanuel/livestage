// Operator-side services: authoritative simulation loop, cue runner, keyboard control,
// broadcasting state to the audience output window, output watchdog, live-state
// persistence and show-control I/O (incoming triggers, outgoing notifications, media markers).

import { now, sceneNow } from "@/core/clock";
import { onBus, send } from "@/core/bus";
import { clipStateAt } from "@/core/clipActor";
import { LION_KEYMAP, LION_MOVE_KEYS } from "@/core/lion";
import { isOutputOpen, openOutputWindow, outputClosedByUs } from "@/core/platform";
import { mediaElapsed } from "@/core/runtime";
import { stepActors, type ActorInput } from "@/core/sim";
import type { Cue, CueAction, IoAction, MediaMarker, MediaSettings, Scene, SceneRuntime, TransitionSpec } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { ioLog, sendMessage, setIoActionHandler, startIo } from "./io";
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
    useShow.getState().take(scene, spec);
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

export function cancelPending(target: Target) {
  pending[target].forEach((p) => clearTimeout(p.handle));
  pending[target] = [];
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
    else {
      const s = sceneForPreview(a.sceneId);
      if (s) useShow.getState().setPreview(s);
    }
    return;
  }
  if (a.type === "send") {
    // Messages leave the building only from the live show.
    if (target === "program") void sendMessage(a.message);
    return;
  }
  useShow.getState().dispatch(target, a);
}

function scheduleAction(target: Target, a: CueAction, fireAt: number) {
  const delay = Math.max(0, fireAt - now());
  const rec: Pending = {
    target,
    fireAt,
    action: a,
    handle: setTimeout(() => {
      pending[target] = pending[target].filter((x) => x !== rec);
      execAction(target, a);
    }, delay),
  };
  pending[target].push(rec);
}

export function runCue(target: Target, cue: Cue) {
  const t0 = now();
  for (const a of cue.actions) {
    if (a.delay > 0) scheduleAction(target, a, t0 + a.delay * 1000);
    else execAction(target, a);
  }
}

function rtFor(target: Target) {
  const s = useShow.getState();
  return target === "program" ? s.program.runtime : s.preview;
}

export const cueControl = {
  go(target: Target) {
    const rt = rtFor(target);
    if (!rt) return;
    const cue = rt.scene.cues[rt.cuePointer];
    if (!cue) return;
    useShow.getState().dispatch(target, { type: "cuePointer", index: rt.cuePointer + 1 });
    runCue(target, cue);
    if (target === "program") notifyCue(rt, rt.cuePointer, cue);
  },
  fire(target: Target, index: number) {
    const rt = rtFor(target);
    const cue = rt?.scene.cues[index];
    if (!rt || !cue) return;
    useShow.getState().dispatch(target, { type: "cuePointer", index: index + 1 });
    runCue(target, cue);
    if (target === "program") notifyCue(rt, index, cue);
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

// ---------------------------------------------------------------- outgoing notifications

function notifyTarget() {
  const io = useProject.getState().project.io;
  if (!io?.osc.notify || !io.osc.enabled) return null;
  return io.osc.notifyTarget ?? io.osc.targets[0]?.id ?? null;
}

function notifyTake(scene: Scene) {
  const target = notifyTarget();
  if (target) void sendMessage({ type: "osc", target, address: "/sls/scene", args: [scene.number, scene.name] });
}

function notifyCue(rt: SceneRuntime, index: number, cue: Cue) {
  const target = notifyTarget();
  if (target) void sendMessage({ type: "osc", target, address: "/sls/cue", args: [rt.scene.number, index + 1, cue.name] });
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

/** Remembered playback position per media component, to detect marker crossings. */
const markerPos = new Map<string, { clipId: string | null; t: number }>();

function fireMarkers(markers: MediaMarker[] | undefined, key: string, clipId: string | null, t: number, duration: number, loop: boolean) {
  if (!markers?.length) {
    markerPos.set(key, { clipId, t });
    return;
  }
  const prev = markerPos.get(key);
  markerPos.set(key, { clipId, t });
  if (!prev || prev.clipId !== clipId) {
    // Fresh clip: anything between its start and now fires (a marker at 0 fires on the first frame).
    for (const m of markers) if (m.at <= t && m.at >= 0) void sendMessage(m.message);
    return;
  }
  if (t >= prev.t) {
    for (const m of markers) if (m.at > prev.t && m.at <= t) void sendMessage(m.message);
  } else if (loop && duration > 0) {
    // Wrapped around the loop boundary.
    for (const m of markers) if (m.at > prev.t || m.at <= t) void sendMessage(m.message);
  }
}

function pollMarkers(rt: SceneRuntime, wall: number) {
  const t = sceneNow(rt, wall);
  for (const c of rt.scene.components) {
    if (c.kind === "clipActor") {
      const st = clipStateAt(c, rt.clipActors?.[c.id], t);
      fireMarkers(st.clip?.markers, `${rt.key}:${c.id}`, st.clip?.id ?? null, st.localT, st.clip?.duration ?? 0, !!st.clip?.loop);
    } else if (c.kind === "background" && c.source === "media" && c.media.markers?.length) {
      if (rt.background.current !== c.id) continue;
      const el = mediaElapsed(rt, c.id, Math.max(0, rt.background.changedAt), t, c.media.playbackRate);
      fireMarkers(c.media.markers, `${rt.key}:${c.id}`, c.media.assetId, markerTime(c.media, el), c.media.endTime ?? 0, c.media.loop);
    } else if (c.kind === "video" && c.media.markers?.length) {
      const l = rt.layers[c.id];
      if (!l?.visible) {
        markerPos.delete(`${rt.key}:${c.id}`);
        continue;
      }
      const el = mediaElapsed(rt, c.id, l.startAt, t, c.media.playbackRate);
      fireMarkers(c.media.markers, `${rt.key}:${c.id}`, c.media.assetId, markerTime(c.media, el), c.media.endTime ?? 0, c.media.loop);
    }
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
  // Nothing on the wall when we went down: a fresh start is the honest state.
  if (!st?.program?.runtime) return false;
  const p = st.program;
  const scenes = useProject.getState().project.scenes;
  // The saved runtime carries its own copy of the scene, so it works even if the scene was edited since.
  if (p.runtime && !scenes.some((s) => s.id === p.runtime!.scene.id)) return false;
  useShow.getState().restoreProgram(p, st!.poses ?? {});
  const t = now();
  let rearmed = 0;
  for (const rec of st!.pending ?? []) {
    if (rec.target !== "program") continue;
    // Late by less than two seconds: still fire it (the audience is waiting for it); later than that it is stale.
    if (rec.fireAt < t - 2000) continue;
    scheduleAction("program", rec.action, Math.max(t + 50, rec.fireAt));
    rearmed++;
  }
  ioLog("info", `Resumed live state: ${p.runtime ? `${p.runtime.scene.name}, next cue ${p.runtime.cuePointer + 1}` : "standby"}${rearmed ? `, ${rearmed} delayed action(s) re-armed` : ""}`);
  return true;
}

// ---------------------------------------------------------------- services

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

  // Authoritative actor simulation at 60 Hz; the same tick watches media markers.
  let last = now();
  const sim = setInterval(() => {
    const t = now();
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const s = useShow.getState();
    const input = currentInput();
    const lc = s.lionControl;
    const inputsFor = (target: Target) => (lc.armed && lc.actorId && lc.target === target ? { [lc.actorId]: input } : {});
    if (s.program.runtime) {
      const p = stepActors(s.program.runtime, s.programPoses, inputsFor("program"), dt, t);
      if (p !== s.programPoses) s.setPoses("program", p, t);
      if (!s.program.standby) pollMarkers(s.program.runtime, t);
    }
    if (s.preview) {
      const p = stepActors(s.preview, s.previewPoses, inputsFor("preview"), dt, t);
      if (p !== s.previewPoses) s.setPoses("preview", p, t);
    }
  }, 1000 / 60);
  cleanups.push(() => clearInterval(sim));

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

  // Broadcast program state on change (coalesced to ~30 Hz so a live slider cannot flood IPC), poses at ≤30 Hz.
  const sendProject = () => {
    const s = useShow.getState();
    void send({ type: "project", assets: s.assets, output: s.output });
  };
  const sendProgramNow = () => void send({ type: "program", program: useShow.getState().program });
  const sendProgram = throttle(sendProgramNow, 33);
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
        sendProgramNow();
        sendPoses();
        useShow.setState({ outputSeenAt: Date.now(), outputLostAt: null });
      } else if (msg.type === "output-status") {
        useShow.setState({ outputStatus: msg.status, outputSeenAt: Date.now(), outputLostAt: null });
      } else if (msg.type === "output-bye") {
        useShow.setState({ outputStatus: null, outputSeenAt: 0, outputLostAt: null });
      }
    }),
  );

  // Belt and braces: re-send the program every few seconds so a missed message never sticks.
  const resend = setInterval(sendProgramNow, 5000);
  cleanups.push(() => clearInterval(resend));

  // Output watchdog: a heartbeat that stops without a goodbye means the output window died.
  let reopenAt = 0;
  const watchdog = setInterval(() => {
    const s = useShow.getState();
    if (!s.outputStatus || Date.now() - s.outputSeenAt < 4000) return;
    if (outputClosedByUs) {
      useShow.setState({ outputStatus: null, outputSeenAt: 0, outputLostAt: null });
      return;
    }
    if (!s.outputLostAt) {
      useShow.setState({ outputLostAt: Date.now() });
      ioLog("error", "Output window stopped responding");
    }
    if (Date.now() - reopenAt < 6000) return;
    reopenAt = Date.now();
    void isOutputOpen().then((open) => {
      if (open) return; // alive but slow: leave it alone
      ioLog("info", "Reopening the output window");
      useShow.setState({ outputStatus: null, outputSeenAt: 0 });
      return openOutputWindow(useProject.getState().project.output).catch((e) => ioLog("error", `Reopen failed: ${String(e)}`));
    });
  }, 1000);
  cleanups.push(() => clearInterval(watchdog));

  // Live-state persistence (crash / reload recovery) and show-control I/O.
  setPendingSource(() => pending.program.map(({ target, fireAt, action }) => ({ target, fireAt, action })));
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
