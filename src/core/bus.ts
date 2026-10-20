// Message bus between the operator window (authoritative) and the audience
// output window (a pure view). Uses Tauri events in the desktop app and
// BroadcastChannel when running in a plain browser.

import { isTauri, windowRole } from "./platform";
import type { ActorPoses, Asset, OutputSettings, ProgramState } from "./types";
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
  /** Time spent handing video frames to WebGL in the last second, and how many frames. */
  upload?: { ms: number; count: number };
  /** <video> elements in the window, and how many hold a loaded file (a decoder each). */
  videoElements?: { total: number; warm: number };
  /** Frames that took over 40 ms in the last second: how long, and what bus message arrived how long before. */
  stalls?: { ms: number; sinceBusMs: number; bus: string }[];
}

export type BusMessage =
  | { type: "hello" }
  | { type: "project"; assets: Asset[]; output: OutputSettings }
  | { type: "program"; program: ProgramState }
  | { type: "poses"; program: ActorPoses; from: ActorPoses | null }
  | { type: "output-status"; status: OutputStatus }
  | { type: "output-bye" };

type Envelope = { from: "operator" | "output"; msg: BusMessage };
type Handler = (msg: BusMessage) => void;

const EVENT = "sls://bus";
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

let tauriEmit: ((event: string, payload: unknown) => Promise<void>) | null = null;

export async function send(msg: BusMessage): Promise<void> {
  await init();
  const env: Envelope = { from: windowRole, msg };
  if (isTauri) {
    if (!tauriEmit) tauriEmit = (await import("@tauri-apps/api/event")).emit;
    await tauriEmit(EVENT, env);
  } else {
    channel?.postMessage(env);
  }
}
