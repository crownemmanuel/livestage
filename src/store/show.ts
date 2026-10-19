import { create } from "zustand";
import { now } from "@/core/clock";
import { applyCommand, createPoses, createRuntime, reconcileRuntime, type Command } from "@/core/runtime";
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
  /** Component shown on its own in the preview (Build's isolate); null = the whole scene. */
  solo: string | null;
  /** Components hidden from the preview while building (the show itself is unchanged). */
  hidden: string[];

  assets: Asset[];
  output: OutputSettings;
  outputStatus: OutputStatus | null;
  outputSeenAt: number;
  /** Wall-clock ms the output heartbeat was lost unexpectedly (null = fine or closed on purpose). */
  outputLostAt: number | null;
  /** Wall-clock ms the program state was restored after a reload (for the "resumed" notice). */
  restoredAt: number | null;

  /** Transition chosen in the operator UI for the next TAKE (null = scene default). */
  nextTransition: TransitionSpec | null;
  lionControl: { armed: boolean; actorId: string | null; target: Target };

  setPreview(scene: Scene | null, opts?: { keepState?: boolean }): void;
  setSolo(id: string | null): void;
  toggleHidden(id: string): void;
  restartPreview(): void;
  take(scene: Scene, spec: TransitionSpec): void;
  finishTransition(takeCount: number): void;
  setStandby(on: boolean): void;
  setBlackout(on: boolean, fade?: number): void;
  dispatch(target: Target, cmd: Command): void;
  setPoses(target: Target, poses: ActorPoses, at: number): void;
  setNextTransition(t: TransitionSpec | null): void;
  setLionControl(p: Partial<ShowStore["lionControl"]>): void;
  /** Bring a saved program back after a reload/crash; the scene clock keeps running from where it was. */
  restoreProgram(program: ProgramState, poses: ActorPoses): void;
  /** The live scene was edited and saved: push the new definition without restarting it. */
  refreshProgramScene(scene: Scene): void;
}

const emptyProgram = (): ProgramState => ({
  runtime: null,
  standby: true,
  standbyChangedAt: 0,
  transition: null,
  takeCount: 0,
});

export const useShow = create<ShowStore>((set, get) => ({
  program: emptyProgram(),
  programPoses: {},
  fromPoses: null,
  posesAt: 0,
  preview: null,
  previewPoses: {},
  previewPosesAt: 0,
  solo: null,
  hidden: [],
  assets: [],
  output: defaultOutput(),
  outputStatus: null,
  outputSeenAt: 0,
  outputLostAt: null,
  restoredAt: null,
  nextTransition: null,
  lionControl: { armed: false, actorId: null, target: "program" },

  setSolo: (id) => set({ solo: id }),
  toggleHidden: (id) => set({ hidden: get().hidden.includes(id) ? get().hidden.filter((x) => x !== id) : [...get().hidden, id] }),

  setPreview(scene, opts) {
    const cur = get().preview;
    // Isolating and hiding are per scene: another scene comes up whole.
    if ((get().solo || get().hidden.length) && cur?.scene.id !== scene?.id) set({ solo: null, hidden: [] });
    if (!scene) return set({ preview: null, previewPoses: {} });
    if (opts?.keepState && cur && cur.scene.id === scene.id) {
      const rt = reconcileRuntime(cur, scene);
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

  restoreProgram(program, poses) {
    // A transition that was running when we went down is over by now.
    set({ program: { ...program, transition: null }, programPoses: poses, fromPoses: null, posesAt: now(), restoredAt: now() });
  },

  refreshProgramScene(scene) {
    const { program } = get();
    if (!program.runtime || program.runtime.scene.id !== scene.id) return;
    set({ program: { ...program, runtime: reconcileRuntime(program.runtime, scene) } });
  },
}));

export const runtimeFor = (target: Target) => {
  const s = useShow.getState();
  return target === "program" ? s.program.runtime : s.preview;
};
