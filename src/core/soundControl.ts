// StageMics messages → what goes on the wire, without touching any socket: OSC for StageMics
// (shared/soundProtocol.ts), every argument a string or int32. StageMics owns the sound desk.
// Pure and free of app imports (only erased type imports), so a Node script can check the mapping.

import type { SoundAppMessage } from "./types";
import { SOUND_OSC, SOUND_PROTOCOL_VERSION } from "../../shared/soundProtocol";

// ---------------------------------------------------------------- StageMics

export type OscWireArg = { t: "s"; v: string } | { t: "i"; v: number };

const s = (v: string): OscWireArg => ({ t: "s", v });
const i = (v: number): OscWireArg => ({ t: "i", v: Math.round(v) | 0 });

export const SOUND_OP_LABEL: Record<SoundAppMessage["op"], string> = {
  sceneSelect: "Select scene",
  sceneActivate: "Activate scene",
  sceneEnd: "End scene (mute its mics)",
  cueGo: "Go to cue",
  cueNext: "Next cue",
  mic: "Mic live / muted",
  fx: "Voice effect",
  restore: "Restore (re-apply cue)",
  panic: "Panic (mute every mic)",
};

/** Ops that change a single mic outside StageMics' cue list: a track that sent one sends /sound/restore when it stops or jumps. */
export const isSoundMicMessage = (m: { type: string; op?: string }) => m.type === "sound" && (m.op === "mic" || m.op === "fx");

/** The OSC a Sound-app message becomes. `sceneId` fills in a message whose sceneId is null (the scene it belongs to). */
export function soundOsc(m: SoundAppMessage, sceneId: string | null): { address: string; args: OscWireArg[] } {
  const scene = () => {
    const id = ("sceneId" in m && m.sceneId) || sceneId;
    if (!id) throw new Error("No scene for StageMics (pick one, or send it from a cue of a scene)");
    return s(id);
  };
  const who = () => {
    const w = "who" in m ? String(m.who ?? "").trim() : "";
    if (!w) throw new Error("No mic: give a mic number or a character name");
    return s(w);
  };
  switch (m.op) {
    case "sceneSelect":
      return { address: SOUND_OSC.sceneSelect, args: [scene()] };
    case "sceneActivate":
      return { address: SOUND_OSC.sceneActivate, args: [scene()] };
    case "sceneEnd":
      return { address: SOUND_OSC.sceneEnd, args: [] };
    case "cueGo": {
      const cue = Math.round(Number(m.cue));
      if (!(cue >= 1)) throw new Error("StageMics cue numbers start at 1");
      return { address: SOUND_OSC.cueGo, args: [scene(), i(cue)] };
    }
    case "cueNext":
      return { address: SOUND_OSC.cueNext, args: [] };
    case "mic":
      return { address: SOUND_OSC.mic, args: [who(), i(m.live ? 1 : 0)] };
    case "fx": {
      const preset = String(m.preset ?? "").trim() || "none";
      return { address: SOUND_OSC.fx, args: [who(), s(preset), ...(m.amount && preset !== "none" ? [s(m.amount)] : [])] };
    }
    case "restore":
      return { address: SOUND_OSC.restore, args: [] };
    case "panic":
      return { address: SOUND_OSC.panic, args: [] };
  }
  throw new Error(`Unknown StageMics op ${(m as { op: string }).op}`);
}

/** `/sound/mic "Joseph" 0`: strings quoted, ints bare. */
export const formatOsc = (address: string, args: OscWireArg[]) => [address, ...args.map((a) => (a.t === "s" ? `"${a.v}"` : String(a.v)))].join(" ");

export const soundPing = (): { address: string; args: OscWireArg[] } => ({ address: SOUND_OSC.ping, args: [i(SOUND_PROTOCOL_VERSION)] });

/** One line for logs and cue lists. `sceneName` turns a scene id into something readable. */
export function describeSound(m: SoundAppMessage, sceneName: (id: string | null) => string = (id) => id ?? "this scene"): string {
  switch (m.op) {
    case "sceneSelect":
      return `StageMics: select ${sceneName(m.sceneId)}`;
    case "sceneActivate":
      return `StageMics: activate ${sceneName(m.sceneId)}`;
    case "cueGo":
      return `StageMics: cue ${m.cue} of ${sceneName(m.sceneId)}`;
    case "sceneEnd":
      return "StageMics: end scene";
    case "cueNext":
      return "StageMics: next cue";
    case "mic":
      return `StageMics: ${m.who || "?"} mic ${m.live ? "live" : "muted"}`;
    case "fx":
      return `StageMics: ${m.who || "?"} voice effect ${!m.preset || m.preset === "none" ? "off" : `${m.preset}${m.amount ? ` (${m.amount})` : ""}`}`;
    case "restore":
      return "StageMics: restore";
    case "panic":
      return "StageMics: PANIC (all mics muted)";
  }
  return "StageMics: ?";
}

/** A Sound-app message in the stored shape, from looser input. */
export function normalizeSound(m: Record<string, unknown>): SoundAppMessage {
  const scene = (m.sceneId ?? null) as string | null;
  switch (m.op) {
    case "sceneSelect":
    case "sceneActivate":
      return { type: "sound", op: m.op, sceneId: scene };
    case "cueGo":
      return { type: "sound", op: "cueGo", sceneId: scene, cue: Math.round(Number(m.cue ?? 1)) };
    case "sceneEnd":
    case "cueNext":
    case "restore":
    case "panic":
      return { type: "sound", op: m.op };
    case "mic":
      return { type: "sound", op: "mic", who: String(m.who ?? ""), live: m.live === true || m.live === 1 || m.live === "1" || m.live === "live" };
    case "fx": {
      const amount = m.amount === "light" || m.amount === "medium" || m.amount === "full" ? m.amount : undefined;
      return { type: "sound", op: "fx", who: String(m.who ?? ""), preset: String(m.preset ?? "none"), ...(amount ? { amount } : {}) };
    }
  }
  throw new Error('sound op must be one of sceneSelect, sceneActivate, sceneEnd, cueGo, cueNext, mic, fx, restore, panic');
}

// ---------------------------------------------------------------- restore after a track stops or jumps

/** Where live media that moved a mic through StageMics was at the last check (engine/operator.ts). */
export interface MicMove {
  /** The live scene run (SceneRuntime.key) and this playthrough of the media (changes on restart / new clip). */
  rtKey: string;
  run: string;
  /** Media seconds, and where it ends by itself (null = loops or unknown). */
  pos: number;
  end: number | null;
  /** Scene time and wall time (ms) of the check, to tell a scrub from playback; scene clock held? */
  t: number;
  wall: number;
  paused: boolean;
}

/** A scene-clock jump bigger than this between two checks is a scrub, not playback. */
export const MIC_JUMP_MS = 250;

/**
 * What became of media that moved a mic: "keep" (still playing normally), "finished" (played to its
 * natural end: nothing to undo), or why StageMics should restore its cue ("stopped", "restarted",
 * "jumped", "another scene was taken"). `now.run` is null when the media is not playing any more.
 */
export function micMoveVerdict(w: MicMove, now: Omit<MicMove, "run"> & { run: string | null }): "keep" | "finished" | "stopped" | "restarted" | "jumped" | "another scene was taken" {
  const ended = (pos: number) => w.end !== null && w.end > 0 && pos >= w.end - 0.05;
  const dt = now.t - w.t;
  const dw = now.wall - w.wall;
  let reason: "stopped" | "restarted" | "jumped" | "another scene was taken" | null = null;
  if (now.rtKey !== w.rtKey) reason = "another scene was taken";
  else if (now.run === null) reason = "stopped";
  else if (now.run !== w.run) reason = "restarted";
  // Scrubbing moves the scene clock backwards, or forwards by more than the time that passed. Holding
  // stops it (a hold and resume between two checks only makes it lag, which is not a jump).
  else if (dt < -1 || dt > dw + MIC_JUMP_MS) reason = "jumped";
  // Played to its natural end: nothing left to undo. For a stop or restart, project the last check to now
  // (it may have been a while ago); a jump is judged from where it jumped.
  const finished = !reason || reason === "jumped" ? ended(w.pos) : ended(w.pos + Math.max(0, dt) / 1000);
  if (finished) return "finished";
  return reason ?? "keep";
}
