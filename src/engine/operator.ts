// Operator-side services: authoritative simulation loop, cue runner,
// keyboard control and broadcasting state to the audience output window.

import { now } from "@/core/clock";
import { onBus, send } from "@/core/bus";
import { LION_KEYMAP, LION_MOVE_KEYS } from "@/core/lion";
import { stepActors, type ActorInput } from "@/core/sim";
import type { Cue, CueAction, Scene, TransitionSpec } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";

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

export async function takeScene(sceneId: string, override?: TransitionSpec | null): Promise<void> {
  const scene = useProject.getState().project.scenes.find((s) => s.id === sceneId);
  if (!scene) return;
  const show = useShow.getState();
  const spec = await resolveTransition(override ?? show.nextTransition ?? scene.transition);
  cancelPending("program");
  useShow.getState().take(scene, spec);
}

/** Push the latest saved version of the live scene to the output without retaking it. */
export function sceneForPreview(sceneId: string): Scene | null {
  return useProject.getState().project.scenes.find((s) => s.id === sceneId) ?? null;
}

// ---------------------------------------------------------------- cues

const pending: Record<Target, ReturnType<typeof setTimeout>[]> = { program: [], preview: [] };

export function cancelPending(target: Target) {
  pending[target].forEach(clearTimeout);
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
  useShow.getState().dispatch(target, a);
}

export function runCue(target: Target, cue: Cue) {
  for (const a of cue.actions) {
    if (a.delay > 0) {
      const h = setTimeout(() => {
        pending[target] = pending[target].filter((x) => x !== h);
        execAction(target, a);
      }, a.delay * 1000);
      pending[target].push(h);
    } else execAction(target, a);
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
  },
  fire(target: Target, index: number) {
    const rt = rtFor(target);
    const cue = rt?.scene.cues[index];
    if (!cue) return;
    useShow.getState().dispatch(target, { type: "cuePointer", index: index + 1 });
    runCue(target, cue);
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

// ---------------------------------------------------------------- services

export function startOperatorServices(): () => void {
  const cleanups: (() => void)[] = [];

  // Authoritative actor simulation at 60 Hz.
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

  // Broadcast program state on change, poses at ≤30 Hz.
  const sendProject = () => {
    const s = useShow.getState();
    void send({ type: "project", assets: s.assets, output: s.output });
  };
  const sendProgram = () => void send({ type: "program", program: useShow.getState().program });
  let poseTimer: ReturnType<typeof setTimeout> | null = null;
  const sendPoses = () => {
    poseTimer = null;
    const s = useShow.getState();
    void send({ type: "poses", program: s.programPoses, from: s.fromPoses });
  };
  cleanups.push(
    useShow.subscribe((s, prev) => {
      if (s.assets !== prev.assets || s.output !== prev.output) sendProject();
      if (s.program !== prev.program) sendProgram();
      if ((s.programPoses !== prev.programPoses || s.fromPoses !== prev.fromPoses) && !poseTimer) {
        poseTimer = setTimeout(sendPoses, 33);
      }
    }),
  );

  cleanups.push(
    onBus((msg) => {
      if (msg.type === "hello") {
        sendProject();
        sendProgram();
        sendPoses();
        useShow.setState({ outputSeenAt: Date.now() });
      } else if (msg.type === "output-status") {
        useShow.setState({ outputStatus: msg.status, outputSeenAt: Date.now() });
      } else if (msg.type === "output-bye") {
        useShow.setState({ outputStatus: null, outputSeenAt: 0 });
      }
    }),
  );

  return () => cleanups.forEach((c) => c());
}

export function useOutputConnected() {
  // Output sends a status heartbeat every second.
  return useShow((s) => s.outputSeenAt > 0 && Date.now() - s.outputSeenAt < 3500 && !!s.outputStatus);
}
