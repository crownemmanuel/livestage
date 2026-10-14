import { create } from "zustand";
import { now } from "@/core/clock";
import { EFFECT_DEFS } from "@/core/effects";
import { applyCommand, createPoses, createRuntime, type Command } from "@/core/runtime";
import { initialSegments } from "@/core/clipActor";
import type { OutputStatus } from "@/core/bus";
import { defaultOutput } from "@/core/factories";
import type {
  ActorPoses,
  Asset,
  OutputSettings,
  ProgramState,
  Scene,
  SceneRuntime,
  TransitionSpec,
} from "@/core/types";

export type Target = "program" | "preview";

/** Lead time so every window receives a TAKE before its transition begins. */
export const TAKE_PREROLL_MS = 120;

interface ShowStore {
  program: ProgramState;
  programPoses: ActorPoses;
  fromPoses: ActorPoses | null;
  /** Wall-clock time the poses were simulated (for extrapolation in views). */
  posesAt: number;

  preview: SceneRuntime | null;
  previewPoses: ActorPoses;
  previewPosesAt: number;

  assets: Asset[];
  output: OutputSettings;
  outputStatus: OutputStatus | null;
  outputSeenAt: number;

  /** Transition chosen in the operator UI for the next TAKE (null = scene default). */
  nextTransition: TransitionSpec | null;
  lionControl: { armed: boolean; actorId: string | null; target: Target };

  setPreview(scene: Scene | null, opts?: { keepState?: boolean }): void;
  restartPreview(): void;
  take(scene: Scene, spec: TransitionSpec): void;
  finishTransition(takeCount: number): void;
  setStandby(on: boolean): void;
  setBlackout(on: boolean, fade?: number): void;
  dispatch(target: Target, cmd: Command): void;
  setPoses(target: Target, poses: ActorPoses, at: number): void;
  setNextTransition(t: TransitionSpec | null): void;
  setLionControl(p: Partial<ShowStore["lionControl"]>): void;
}

const emptyProgram = (): ProgramState => ({
  runtime: null,
  standby: true,
  standbyChangedAt: 0,
  transition: null,
  takeCount: 0,
});

/** Keep a running preview in sync with edits to its scene without restarting it. */
function reconcile(rt: SceneRuntime, scene: Scene): SceneRuntime {
  const layers = { ...rt.layers };
  const effects = { ...rt.effects };
  const ids = new Set(scene.components.map((c) => c.id));
  for (const c of scene.components) {
    if ((c.kind === "video" || c.kind === "image" || c.kind === "model" || c.kind === "procedural") && !layers[c.id]) {
      layers[c.id] = { visible: c.initiallyVisible, changedAt: -1e9, startAt: 0 };
    }
    if (c.kind === "effect") {
      const params = { ...EFFECT_DEFS[c.effect].defaults, ...c.params };
      effects[c.id] = effects[c.id] ? { ...effects[c.id], params } : { active: c.initiallyVisible, changedAt: -1e9, params };
    }
  }
  const clipActors = { ...(rt.clipActors ?? {}) };
  for (const c of scene.components) if (c.kind === "clipActor" && !clipActors[c.id]) clipActors[c.id] = initialSegments(c);
  for (const id of Object.keys(clipActors)) if (!ids.has(id)) delete clipActors[id];
  for (const id of Object.keys(layers)) if (!ids.has(id)) delete layers[id];
  for (const id of Object.keys(effects)) if (!ids.has(id)) delete effects[id];
  const bgValid = rt.background.current && ids.has(rt.background.current);
  const background = bgValid
    ? rt.background
    : { current: scene.components.find((c) => c.kind === "background")?.id ?? null, previous: null, changedAt: -1e9, dur: 0 };
  return { ...rt, scene: structuredClone(scene), layers, effects, background, clipActors };
}

export const useShow = create<ShowStore>((set, get) => ({
  program: emptyProgram(),
  programPoses: {},
  fromPoses: null,
  posesAt: 0,
  preview: null,
  previewPoses: {},
  previewPosesAt: 0,
  assets: [],
  output: defaultOutput(),
  outputStatus: null,
  outputSeenAt: 0,
  nextTransition: null,
  lionControl: { armed: false, actorId: null, target: "program" },

  setPreview(scene, opts) {
    const cur = get().preview;
    if (!scene) return set({ preview: null, previewPoses: {} });
    if (opts?.keepState && cur && cur.scene.id === scene.id) {
      const rt = reconcile(cur, scene);
      const poses = { ...get().previewPoses };
      const fresh = createPoses(scene);
      for (const id of Object.keys(fresh)) if (!poses[id]) poses[id] = fresh[id];
      for (const id of Object.keys(poses)) if (!fresh[id]) delete poses[id];
      return set({ preview: rt, previewPoses: poses });
    }
    set({ preview: createRuntime(scene), previewPoses: createPoses(scene), previewPosesAt: now() });
  },

  restartPreview() {
    const cur = get().preview;
    if (cur) set({ preview: createRuntime(cur.scene), previewPoses: createPoses(cur.scene), previewPosesAt: now() });
  },

  take(scene, spec) {
    const { program, programPoses } = get();
    const startedAt = now() + TAKE_PREROLL_MS;
    const runtime = createRuntime(scene, startedAt);
    const instant = spec.kind === "cut" || spec.duration <= 0;
    set({
      program: {
        runtime,
        standby: false,
        standbyChangedAt: program.standby ? startedAt : program.standbyChangedAt,
        transition: instant
          ? null
          : { spec, startedAt, from: program.runtime, fromPoses: programPoses, fromStandby: program.standby },
        takeCount: program.takeCount + 1,
        // a TAKE in the dark stays dark until the operator brings the lights up
        blackout: program.blackout,
      },
      programPoses: createPoses(scene),
      fromPoses: instant ? null : programPoses,
      posesAt: now(),
      nextTransition: null,
    });
    if (!instant) {
      const takeCount = get().program.takeCount;
      setTimeout(() => get().finishTransition(takeCount), TAKE_PREROLL_MS + spec.duration * 1000 + 50);
    }
  },

  finishTransition(takeCount) {
    const { program } = get();
    if (program.takeCount !== takeCount || !program.transition) return;
    set({ program: { ...program, transition: null }, fromPoses: null });
  },

  setBlackout(on, fade = 0.6) {
    const { program } = get();
    if (!!program.blackout?.on === on) return;
    set({ program: { ...program, blackout: { on, at: now(), fade } } });
  },

  setStandby(on) {
    const { program } = get();
    if (program.standby === on) return;
    set({ program: { ...program, standby: on, standbyChangedAt: now() } });
  },

  dispatch(target, cmd) {
    const s = get();
    if (target === "program") {
      const rt = s.program.runtime;
      if (!rt) return;
      const r = applyCommand(rt, s.programPoses, cmd);
      set({
        program: r.rt === rt ? s.program : { ...s.program, runtime: r.rt },
        programPoses: r.poses,
        posesAt: r.poses === s.programPoses ? s.posesAt : now(),
      });
    } else {
      const rt = s.preview;
      if (!rt) return;
      const r = applyCommand(rt, s.previewPoses, cmd);
      set({ preview: r.rt, previewPoses: r.poses, previewPosesAt: r.poses === s.previewPoses ? s.previewPosesAt : now() });
    }
  },

  setPoses(target, poses, at) {
    if (target === "program") set({ programPoses: poses, posesAt: at });
    else set({ previewPoses: poses, previewPosesAt: at });
  },

  setNextTransition: (t) => set({ nextTransition: t }),
  setLionControl: (p) => set({ lionControl: { ...get().lionControl, ...p } }),
}));

export const runtimeFor = (target: Target) => {
  const s = useShow.getState();
  return target === "program" ? s.program.runtime : s.preview;
};
