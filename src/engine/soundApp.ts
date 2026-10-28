// StageMics link: OSC commands to StageMics (it owns the mics and the desk), and its
// replies. Pings leave from LiveStage's OSC listen port (when listening), so StageMics'
// /sound/hello and mic/cue state come back to that port and show here.

import { create } from "zustand";
import { isTauri } from "@/core/platform";
import { formatOsc, soundOsc, soundPing, type OscWireArg } from "@/core/soundControl";
import type { IoSettings, SoundAppMessage } from "@/core/types";
import { useProject } from "@/store/project";
import { SOUND_OSC_REPLY } from "../../shared/soundProtocol";

interface SoundAppStore {
  /** Last ping sent (ms), or 0. */
  pingedAt: number;
  pingError: string | null;
  /** Last /sound/hello. */
  hello: { at: number; protocol: number; appVersion: string; deskConnected: boolean; from: string } | null;
  /** Mic states StageMics reported (/sound/state/mic), by mic number. */
  mics: Record<number, { name: string; live: boolean }>;
  /** Its active scene and cue (/sound/state/cue). */
  cue: { sceneId: string; cue: number } | null;
}

export const useSoundApp = create<SoundAppStore>(() => ({ pingedAt: 0, pingError: null, hello: null, mics: {}, cue: null }));

type Log = (dir: "in" | "out" | "info" | "error", text: string) => void;
let log: Log = () => {};

const PING_EVERY_MS = 5000;
/** StageMics counts as answering when its hello is younger than this. */
export const SOUND_ALIVE_MS = 12_000;

const settings = () => useProject.getState().project.io;

async function oscSend(s: IoSettings["sound"], address: string, args: OscWireArg[], fromListener = false) {
  if (!isTauri) throw new Error("OSC needs the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("osc_send", { host: s.host, port: s.port, address, args, fromListener });
}

/** Ask StageMics to say hello (quietly: pings are not logged). */
export async function pingSoundApp(): Promise<void> {
  const io = settings();
  if (!io?.sound?.enabled) return;
  const { address, args } = soundPing();
  try {
    await oscSend(io.sound, address, args, io.osc.enabled);
    useSoundApp.setState({ pingedAt: Date.now(), pingError: null });
  } catch (e) {
    if (useSoundApp.getState().pingError !== String(e)) log("error", `StageMics ping: ${String(e)}`);
    useSoundApp.setState({ pingError: String(e) });
  }
}

/** Whether StageMics answered recently: "answering", "sent" (no reply seen; OSC listen may be off), "off". */
export function soundAppReach(): "off" | "answering" | "sent" | "error" {
  const io = settings();
  if (!io?.sound?.enabled) return "off";
  const s = useSoundApp.getState();
  if (s.hello && Date.now() - s.hello.at < SOUND_ALIVE_MS) return "answering";
  if (s.pingError) return "error";
  return "sent";
}

/** Send a command to StageMics. `sceneId` is the scene the cue or marker belongs to. Returns what went out. */
export async function sendSoundApp(m: SoundAppMessage, sceneId: string | null): Promise<string> {
  const io = settings();
  if (!io?.sound?.enabled) throw new Error("StageMics link is off (Settings → StageMics)");
  const { address, args } = soundOsc(m, sceneId);
  await oscSend(io.sound, address, args, io.osc.enabled);
  return `${formatOsc(address, args)} → ${io.sound.host}:${io.sound.port}`;
}

/** Handle an incoming OSC message if it is one of StageMics' replies. */
export function handleSoundReply(address: string, args: (number | string | boolean)[], from?: string): boolean {
  if (!address.startsWith("/sound/")) return false;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : Number(v ?? NaN));
  if (address === SOUND_OSC_REPLY.hello) {
    const first = !useSoundApp.getState().hello || Date.now() - useSoundApp.getState().hello!.at > SOUND_ALIVE_MS;
    useSoundApp.setState({ hello: { at: Date.now(), protocol: num(args[0]), appVersion: String(args[1] ?? ""), deskConnected: num(args[2]) === 1, from: from ?? "" } });
    if (first) log("info", `StageMics answered (v${String(args[1] ?? "?")}, desk ${num(args[2]) === 1 ? "connected" : "not connected"})`);
    return true;
  }
  if (address === SOUND_OSC_REPLY.mic) {
    const mic = num(args[0]);
    if (Number.isFinite(mic)) useSoundApp.setState((s) => ({ mics: { ...s.mics, [mic]: { name: String(args[1] ?? ""), live: num(args[2]) === 1 } } }));
    return true;
  }
  if (address === SOUND_OSC_REPLY.cue) {
    const cue = num(args[1]);
    useSoundApp.setState({ cue: cue > 0 ? { sceneId: String(args[0] ?? ""), cue } : null });
    return true;
  }
  return false;
}

/** Ping StageMics while it is switched on. Returns a cleanup. */
export function startSoundApp(logger: Log): () => void {
  log = logger;
  let lastKey = "";
  const follow = () => {
    const st = useProject.getState();
    if (!st.loaded) return;
    const io = st.project.io;
    const key = io?.sound?.enabled ? `${io.sound.host}:${io.sound.port}:${io.osc.enabled}` : "";
    if (key === lastKey) return;
    lastKey = key;
    useSoundApp.setState({ hello: null, pingError: null, mics: {}, cue: null });
    if (key) void pingSoundApp();
  };
  const unsub = useProject.subscribe(follow);
  follow();
  const timer = setInterval(() => void pingSoundApp(), PING_EVERY_MS);
  return () => {
    unsub();
    clearInterval(timer);
  };
}
