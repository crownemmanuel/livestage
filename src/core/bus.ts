// Message bus between the operator window (authoritative) and the audience
// output window (a pure view). Uses Tauri events in the desktop app and
// BroadcastChannel when running in a plain browser.
//
// The program message carries the live state (clocks, cue pointer, effects, layers…) on
// every change, up to 30 times a second, but the scene definition inside each runtime
// (components, cues, text styles) only when the output has not seen that run's scene yet
// (see packProgram / unpackProgram). The output keeps the scene object it already has, so
// the React tree under its canvases, and everything keyed on component identity (a text
// layer's canvas redraw, a media material's settings), is untouched by a live-state update.
// Before this split every broadcast carried the whole scene (tens of KB, re-serialised through
// IPC into both windows) and arrived as new objects, which redrew every text texture.

import { isTauri, windowRole } from "./platform";
import type { ActorPoses, Asset, OutputSettings, ProgramState, ProgramTransition, Scene, SceneRuntime } from "./types";
import type { VideoSyncStat } from "@/render/layers/video";

export interface OutputStatus {
  fps: number;
  width: number;
  height: number;
  dpr: number;
  fullscreen: boolean;
  frameMs: number;
  /** Sync diagnostics of each playing video in the last second (seeks, rate changes, drift). */
  video?: VideoSyncStat[];
  /** Asset ids of the cue sounds playing in this window (one entry per sound; a re-fired sound replaces itself). */
  sounds?: string[];
  /** Of `sounds`, the ones silent while the live scene is held. */
  heldSounds?: string[];
  /** Time spent handing video frames to WebGL in the last second, and how many frames. */
  upload?: { ms: number; count: number };
  /** <video> elements in the window, and how many hold a loaded file (a decoder each). */
  videoElements?: { total: number; warm: number };
  /** Frames that took over 40 ms in the last second: how long, and what bus message arrived how long before. */
  stalls?: { ms: number; sinceBusMs: number; bus: string }[];
}

/** A scene runtime on the wire: its scene travels separately, once per run (keyed by `key`). */
export type WireRuntime = Omit<SceneRuntime, "scene">;

export interface WireProgram extends Omit<ProgramState, "runtime" | "transition"> {
  runtime: WireRuntime | null;
  transition: (Omit<ProgramTransition, "from"> & { from: WireRuntime | null }) | null;
}

export type BusMessage =
  | { type: "hello" }
  | { type: "project"; assets: Asset[]; output: OutputSettings }
  | { type: "program"; program: WireProgram; scenes: Record<string, Scene> }
  | { type: "poses"; program: ActorPoses; from: ActorPoses | null }
  | { type: "output-status"; status: OutputStatus }
  | { type: "output-bye" };

// ---------------------------------------------------------------- program packing

/**
 * Operator side: strip the scene out of each runtime, attaching it only when this run's scene has
 * not been sent yet (or has been replaced by a live edit), or when `full` is asked for (a resync).
 * `sent` remembers, per runtime key, the scene object last sent; runs that are over are forgotten.
 */
export function packProgram(p: ProgramState, sent: Map<string, Scene>, full: boolean): Extract<BusMessage, { type: "program" }> {
  const scenes: Record<string, Scene> = {};
  const strip = (rt: SceneRuntime | null): WireRuntime | null => {
    if (!rt) return null;
    const { scene, ...rest } = rt;
    if (full || sent.get(rt.key) !== scene) {
      scenes[rt.key] = scene;
      sent.set(rt.key, scene);
    }
    return rest;
  };
  const runtime = strip(p.runtime);
  const transition = p.transition ? { ...p.transition, from: strip(p.transition.from) } : null;
  const live = new Set([p.runtime?.key, p.transition?.from?.key]);
  for (const key of sent.keys()) if (!live.has(key)) sent.delete(key);
  return { type: "program", program: { ...p, runtime, transition }, scenes };
}

/**
 * Output side: put the scenes back, from the message or from `cache` (the scene object of a run the
 * output already has, so its identity is stable across live-state updates). Returns null when a run's
 * scene is unknown: the message was received out of order or the output started late, and the caller
 * asks the operator for a full resync ("hello") instead of showing a scene with no definition.
 */
export function unpackProgram(msg: Extract<BusMessage, { type: "program" }>, cache: Map<string, Scene>): ProgramState | null {
  for (const [key, scene] of Object.entries(msg.scenes)) cache.set(key, scene);
  const hydrate = (rt: WireRuntime | null): SceneRuntime | null | undefined => {
    if (!rt) return null;
    const scene = cache.get(rt.key);
    return scene ? { ...rt, scene } : undefined;
  };
  const runtime = hydrate(msg.program.runtime);
  const from = msg.program.transition ? hydrate(msg.program.transition.from) : null;
  if (runtime === undefined || from === undefined) return null;
  const live = new Set([runtime?.key, from?.key]);
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  return { ...msg.program, runtime, transition: msg.program.transition ? { ...msg.program.transition, from } : null };
}

// ---------------------------------------------------------------- transport

type Envelope = { from: "operator" | "output"; msg: BusMessage };
type Handler = (msg: BusMessage) => void;

const EVENT = "sls://bus";
/** Window label of the other side (see tauri.conf.json and lib.rs). */
const PEER = windowRole === "operator" ? "output" : "main";
const handlers = new Set<Handler>();
let channel: BroadcastChannel | null = null;
let ready: Promise<void> | null = null;

function deliver(env: Envelope) {
  if (env.from === windowRole) return;
  for (const h of handlers) h(env.msg);
}

function init(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (isTauri) {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<Envelope>(EVENT, (e) => deliver(e.payload));
    } else {
      channel = new BroadcastChannel("salvation-live-studio");
      channel.onmessage = (e) => deliver(e.data as Envelope);
    }
  })();
  return ready;
}

export function onBus(h: Handler): () => void {
  handlers.add(h);
  void init();
  return () => handlers.delete(h);
}

let tauriEmitTo: ((target: string, event: string, payload: unknown) => Promise<void>) | null = null;

export async function send(msg: BusMessage): Promise<void> {
  await init();
  const env: Envelope = { from: windowRole, msg };
  if (isTauri) {
    // Addressed to the other window only: a plain emit would also serialise every message back
    // into the sender, where deliver() dropped it, doubling the IPC work for nothing.
    if (!tauriEmitTo) tauriEmitTo = (await import("@tauri-apps/api/event")).emitTo;
    await tauriEmitTo(PEER, EVENT, env);
  } else {
    channel?.postMessage(env);
  }
}
