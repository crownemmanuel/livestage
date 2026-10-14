// Show-control I/O: MIDI (notes, CC, program change, MIDI Show Control) and OSC over UDP.
// In the desktop app the Rust shell owns the ports (src-tauri/src/io.rs) and relays
// messages as events; in a browser we fall back to Web MIDI (Chrome) and no OSC.

import { create } from "zustand";
import { isTauri } from "@/core/platform";
import type { IoAction, IoMatch, IoMessage, IoSettings } from "@/core/types";
import { useProject } from "@/store/project";

export type IncomingMessage =
  | { kind: "midi"; bytes: number[] }
  | { kind: "osc"; address: string; args: (number | string | boolean)[]; from?: string };

export interface IoLogEntry {
  id: number;
  at: number;
  dir: "in" | "out" | "info" | "error";
  text: string;
}

interface IoStore {
  midiInputs: string[];
  midiOutputs: string[];
  midiStatus: "off" | "open" | "error";
  midiError: string | null;
  oscStatus: "off" | "listening" | "error";
  oscError: string | null;
  log: IoLogEntry[];
  /** When set, the next incoming message is handed here instead of being acted on (Learn). */
  learn: ((m: IncomingMessage) => void) | null;
  lastIn: { msg: IncomingMessage; at: number } | null;
  available: { midi: boolean; osc: boolean };
  counters: { in: number; out: number };
}

export const useIo = create<IoStore>(() => ({
  midiInputs: [],
  midiOutputs: [],
  midiStatus: "off",
  midiError: null,
  oscStatus: "off",
  oscError: null,
  log: [],
  learn: null,
  lastIn: null,
  available: { midi: isTauri || (typeof navigator !== "undefined" && "requestMIDIAccess" in navigator), osc: isTauri },
  counters: { in: 0, out: 0 },
}));

let logId = 0;
export function ioLog(dir: IoLogEntry["dir"], text: string) {
  useIo.setState((s) => ({ log: [...s.log.slice(-199), { id: ++logId, at: Date.now(), dir, text }] }));
}

// ---------------------------------------------------------------- formatting

export function describeMessage(m: IoMessage): string {
  switch (m.type) {
    case "midi.note":
      return `MIDI note ${m.note} vel ${m.velocity} ch ${m.channel + 1}${m.hold ? ` (${m.hold} ms)` : ""}`;
    case "midi.cc":
      return `MIDI CC ${m.cc} = ${m.value} ch ${m.channel + 1}`;
    case "midi.pc":
      return `MIDI program ${m.program} ch ${m.channel + 1}`;
    case "msc":
      return `MSC ${m.command.toUpperCase()} cue ${m.cue}${m.list ? ` list ${m.list}` : ""} → device ${m.deviceId}`;
    case "osc":
      return `OSC ${m.address} ${m.args.map(String).join(" ")}`.trim();
  }
}

export function describeMatch(m: IoMatch): string {
  const ch = (c: number | null) => (c === null ? "any ch" : `ch ${c + 1}`);
  switch (m.type) {
    case "midi.note":
      return `note ${m.note} (${ch(m.channel)})`;
    case "midi.cc":
      return `CC ${m.cc}${m.value === null ? "" : ` = ${m.value}`} (${ch(m.channel)})`;
    case "midi.pc":
      return `program ${m.program} (${ch(m.channel)})`;
    case "msc":
      return `MSC GO${m.cue === null ? " (any cue)" : ` cue ${m.cue}`}${m.list ? ` list ${m.list}` : ""}`;
    case "osc":
      return `OSC ${m.address}${m.arg === null ? "" : ` ${m.arg}`}`;
  }
}

export function describeIncoming(m: IncomingMessage): string {
  if (m.kind === "osc") return `OSC ${m.address} ${m.args.map(String).join(" ")}`.trim();
  const b = m.bytes;
  const msc = parseMsc(b);
  if (msc) return `MSC ${msc.command.toUpperCase()} cue ${msc.cue}${msc.list ? ` list ${msc.list}` : ""} (device ${msc.deviceId})`;
  const st = b[0] & 0xf0;
  const ch = (b[0] & 0x0f) + 1;
  if (st === 0x90 && b[2] > 0) return `MIDI note ${b[1]} on vel ${b[2]} ch ${ch}`;
  if (st === 0x80 || (st === 0x90 && b[2] === 0)) return `MIDI note ${b[1]} off ch ${ch}`;
  if (st === 0xb0) return `MIDI CC ${b[1]} = ${b[2]} ch ${ch}`;
  if (st === 0xc0) return `MIDI program ${b[1]} ch ${ch}`;
  return `MIDI ${b.map((x) => x.toString(16).padStart(2, "0")).join(" ")}`;
}

// ---------------------------------------------------------------- MIDI Show Control

export interface MscMessage {
  deviceId: number;
  command: "go" | "stop" | "resume" | "other";
  cue: string;
  list: string;
}

/** Parse an MSC SysEx (F0 7F <dev> 02 <fmt> <cmd> cue 00 list 00 path F7). */
export function parseMsc(b: number[]): MscMessage | null {
  if (b.length < 7 || b[0] !== 0xf0 || b[1] !== 0x7f || b[3] !== 0x02) return null;
  const cmd = b[5];
  const command = cmd === 1 ? "go" : cmd === 2 ? "stop" : cmd === 3 ? "resume" : "other";
  const data = b.slice(6, b[b.length - 1] === 0xf7 ? b.length - 1 : b.length);
  const parts: string[] = [];
  let cur = "";
  for (const x of data) {
    if (x === 0) {
      parts.push(cur);
      cur = "";
    } else cur += String.fromCharCode(x);
  }
  parts.push(cur);
  return { deviceId: b[2], command, cue: parts[0] ?? "", list: parts[1] ?? "" };
}

export function buildMsc(deviceId: number, command: "go" | "stop" | "resume", cue: string, list: string): number[] {
  const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0) & 0x7f);
  const cmd = command === "go" ? 1 : command === "stop" ? 2 : 3;
  return [0xf0, 0x7f, deviceId & 0x7f, 0x02, 0x01, cmd, ...ascii(cue), ...(list ? [0x00, ...ascii(list)] : []), 0xf7];
}

// ---------------------------------------------------------------- matching

export function matches(match: IoMatch, m: IncomingMessage): boolean {
  if (m.kind === "osc") {
    if (match.type !== "osc") return false;
    const pat = match.address.trim();
    const ok = pat.endsWith("*") ? m.address.startsWith(pat.slice(0, -1)) : m.address === pat;
    if (!ok) return false;
    if (match.arg === null || match.arg === "") return true;
    const a = m.args[0];
    if (typeof match.arg === "number") return typeof a === "number" ? Math.abs(a - match.arg) < 1e-6 : typeof a === "boolean" ? Number(a) === match.arg : false;
    return String(a) === match.arg;
  }
  const b = m.bytes;
  if (match.type === "msc") {
    const msc = parseMsc(b);
    if (!msc || msc.command !== "go") return false;
    if (match.cue !== null && match.cue !== "" && msc.cue !== match.cue) return false;
    if (match.list !== null && match.list !== "" && msc.list !== match.list) return false;
    return true;
  }
  if (b[0] === undefined || b[0] >= 0xf0) return false;
  const st = b[0] & 0xf0;
  const ch = b[0] & 0x0f;
  if (match.type === "midi.note") return st === 0x90 && b[2] > 0 && b[1] === match.note && (match.channel === null || match.channel === ch);
  if (match.type === "midi.cc") return st === 0xb0 && b[1] === match.cc && (match.value === null || b[2] === match.value) && (match.channel === null || match.channel === ch);
  if (match.type === "midi.pc") return st === 0xc0 && b[1] === match.program && (match.channel === null || match.channel === ch);
  return false;
}

/** Turn an incoming message into a trigger match (Learn). */
export function matchFromIncoming(m: IncomingMessage): IoMatch | null {
  if (m.kind === "osc") {
    const a = m.args[0];
    return { type: "osc", address: m.address, arg: typeof a === "number" || typeof a === "string" ? a : null };
  }
  const b = m.bytes;
  const msc = parseMsc(b);
  if (msc) return { type: "msc", cue: msc.cue, list: msc.list || null };
  const st = b[0] & 0xf0;
  const ch = b[0] & 0x0f;
  if (st === 0x90 && b[2] > 0) return { type: "midi.note", channel: ch, note: b[1] };
  if (st === 0xb0) return { type: "midi.cc", channel: ch, cc: b[1], value: null };
  if (st === 0xc0) return { type: "midi.pc", channel: ch, program: b[1] };
  return null;
}

// ---------------------------------------------------------------- actions

let actionHandler: (a: IoAction, source: string) => void = () => {};
export function setIoActionHandler(fn: typeof actionHandler) {
  actionHandler = fn;
}

function builtInOsc(m: Extract<IncomingMessage, { kind: "osc" }>): IoAction | null {
  const a = m.address.replace(/\/+$/, "");
  const n = (i: number) => {
    const v = m.args[i];
    return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : NaN;
  };
  const flag = (i: number) => (m.args.length <= i ? "toggle" : n(i) >= 0.5 || m.args[i] === true);
  const scenes = useProject.getState().project.scenes;
  const byNumber = (k: number) => scenes.find((s) => s.number === k)?.id ?? null;
  switch (a) {
    case "/sls/go":
      return { type: "go" };
    case "/sls/back":
      return { type: "back" };
    case "/sls/next":
      return { type: "takeNext" };
    case "/sls/take": {
      const id = byNumber(n(0));
      return id ? { type: "take", sceneId: id } : null;
    }
    case "/sls/select": {
      const id = byNumber(n(0));
      return id ? { type: "select", sceneId: id } : null;
    }
    case "/sls/cue": {
      const id = byNumber(n(0));
      return id && Number.isFinite(n(1)) ? { type: "fireCue", sceneId: id, index: Math.max(0, Math.round(n(1)) - 1) } : null;
    }
    case "/sls/blackout":
      return { type: "blackout", on: flag(0) };
    case "/sls/standby":
      return { type: "standby", on: flag(0) };
    case "/sls/freeze": {
      const f = flag(0);
      return { type: "freeze", op: f === "toggle" ? "toggle" : f ? "pause" : "resume" };
    }
  }
  return null;
}

/** MSC auto-follow: cue "12" takes scene 12, "12.3" fires cue 3 of scene 12. */
function mscAutoAction(msc: MscMessage): IoAction | null {
  if (msc.command !== "go") return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(msc.cue.trim());
  if (!m) return null;
  const scenes = useProject.getState().project.scenes;
  const scene = scenes.find((s) => s.number === +m[1]);
  if (!scene) return null;
  if (m[2] === undefined) return { type: "take", sceneId: scene.id };
  return { type: "fireCue", sceneId: scene.id, index: Math.max(0, +m[2] - 1) };
}

function handleIncoming(m: IncomingMessage) {
  const io = useIo.getState();
  useIo.setState({ lastIn: { msg: m, at: Date.now() }, counters: { ...io.counters, in: io.counters.in + 1 } });
  ioLog("in", describeIncoming(m));
  if (io.learn) {
    const fn = io.learn;
    useIo.setState({ learn: null });
    fn(m);
    return;
  }
  const settings = useProject.getState().project.io;
  if (!settings) return;
  let acted = false;
  for (const tr of settings.triggers) {
    if (!tr.enabled || !matches(tr.match, m)) continue;
    acted = true;
    actionHandler(tr.action, tr.name);
  }
  if (acted) return;
  if (m.kind === "osc") {
    const a = builtInOsc(m);
    if (a) actionHandler(a, m.address);
    return;
  }
  const msc = parseMsc(m.bytes);
  if (msc && settings.midi.mscAuto && (settings.midi.mscDeviceId === 127 || msc.deviceId === settings.midi.mscDeviceId || msc.deviceId === 127)) {
    const a = mscAutoAction(msc);
    if (a) actionHandler(a, `MSC cue ${msc.cue}`);
  }
}

// ---------------------------------------------------------------- transport

type MidiOut = { send(bytes: number[]): Promise<void> | void } | null;
let midiOut: MidiOut = null;
let webAccess: MIDIAccess | null = null;
let webInput: MIDIInput | null = null;
let noteOffTimers: ReturnType<typeof setTimeout>[] = [];

async function openMidi(settings: IoSettings["midi"]) {
  noteOffTimers.forEach(clearTimeout);
  noteOffTimers = [];
  if (!settings.enabled) {
    midiOut = null;
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("midi_open", { input: null, output: null }).catch(() => {});
    } else if (webInput) {
      webInput.onmidimessage = null;
      webInput = null;
    }
    useIo.setState({ midiStatus: "off", midiError: null });
    return;
  }
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("midi_open", { input: settings.input, output: settings.output });
      midiOut = settings.output ? { send: (bytes) => invoke("midi_send", { bytes }) } : null;
    } else {
      webAccess ??= await navigator.requestMIDIAccess({ sysex: true });
      if (webInput) webInput.onmidimessage = null;
      webInput = settings.input ? ([...webAccess.inputs.values()].find((i) => i.name === settings.input) ?? null) : null;
      if (webInput) webInput.onmidimessage = (e) => e.data && handleIncoming({ kind: "midi", bytes: Array.from(e.data) });
      const out = settings.output ? [...webAccess.outputs.values()].find((o) => o.name === settings.output) : undefined;
      midiOut = out ? { send: (bytes) => out.send(bytes) } : null;
      if (settings.input && !webInput) throw new Error(`MIDI input '${settings.input}' not found`);
    }
    useIo.setState({ midiStatus: "open", midiError: null });
    ioLog("info", `MIDI open: in ${settings.input ?? "—"}, out ${settings.output ?? "—"}`);
  } catch (e) {
    midiOut = null;
    useIo.setState({ midiStatus: "error", midiError: String(e) });
    ioLog("error", `MIDI: ${String(e)}`);
  }
}

async function openOsc(settings: IoSettings["osc"]) {
  if (!isTauri) {
    useIo.setState({ oscStatus: "off", oscError: settings.enabled ? "OSC needs the desktop app" : null });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("osc_listen", { port: settings.enabled ? settings.listenPort : null });
    useIo.setState({ oscStatus: settings.enabled ? "listening" : "off", oscError: null });
    if (settings.enabled) ioLog("info", `OSC listening on UDP ${settings.listenPort}`);
  } catch (e) {
    useIo.setState({ oscStatus: "error", oscError: String(e) });
    ioLog("error", `OSC: ${String(e)}`);
  }
}

export async function refreshMidiPorts() {
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      const p = await invoke<{ inputs: string[]; outputs: string[] }>("midi_ports");
      useIo.setState({ midiInputs: p.inputs, midiOutputs: p.outputs });
    } else if ("requestMIDIAccess" in navigator) {
      webAccess ??= await navigator.requestMIDIAccess({ sysex: true });
      useIo.setState({ midiInputs: [...webAccess.inputs.values()].map((i) => i.name ?? ""), midiOutputs: [...webAccess.outputs.values()].map((o) => o.name ?? "") });
    }
  } catch (e) {
    ioLog("error", `MIDI ports: ${String(e)}`);
  }
}

function oscArgs(args: (number | string)[]) {
  return args.map((a) => (typeof a === "number" ? (Number.isInteger(a) ? { t: "i", v: a } : { t: "f", v: a }) : { t: "s", v: a }));
}

/** Send one message to the outside world. Never throws: failures go to the I/O log. */
export async function sendMessage(msg: IoMessage): Promise<void> {
  const settings = useProject.getState().project.io;
  try {
    if (msg.type === "osc") {
      if (!isTauri) throw new Error("OSC needs the desktop app");
      const targets = settings?.osc.targets ?? [];
      const target = targets.find((t) => t.id === msg.target) ?? targets[0];
      if (!target) throw new Error("No OSC target configured");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("osc_send", { host: target.host, port: target.port, address: msg.address, args: oscArgs(msg.args) });
    } else {
      if (!midiOut) throw new Error("No MIDI output open");
      const ch = msg.type === "msc" ? 0 : msg.channel & 0x0f;
      let bytes: number[];
      if (msg.type === "midi.note") {
        bytes = [0x90 | ch, msg.note & 0x7f, msg.velocity & 0x7f];
        if (msg.hold > 0) {
          const off = [0x80 | ch, msg.note & 0x7f, 0];
          noteOffTimers.push(setTimeout(() => void midiOut?.send(off), msg.hold));
        }
      } else if (msg.type === "midi.cc") bytes = [0xb0 | ch, msg.cc & 0x7f, msg.value & 0x7f];
      else if (msg.type === "midi.pc") bytes = [0xc0 | ch, msg.program & 0x7f];
      else bytes = buildMsc(msg.deviceId, msg.command, msg.cue, msg.list);
      await midiOut.send(bytes);
    }
    useIo.setState((s) => ({ counters: { ...s.counters, out: s.counters.out + 1 } }));
    ioLog("out", describeMessage(msg));
  } catch (e) {
    ioLog("error", `${describeMessage(msg)} — ${String(e)}`);
  }
}

/** Start the I/O services: follows the project's I/O settings and relays incoming messages. */
export function startIo(): () => void {
  const cleanups: (() => void)[] = [];
  let last: IoSettings | undefined;
  const apply = () => {
    const io = useProject.getState().project.io;
    if (!io || io === last) return;
    const prev = last;
    last = io;
    if (!prev || JSON.stringify(prev.midi) !== JSON.stringify(io.midi)) void openMidi(io.midi);
    if (!prev || prev.osc.enabled !== io.osc.enabled || prev.osc.listenPort !== io.osc.listenPort) void openOsc(io.osc);
  };
  // Settings are loaded asynchronously; apply once loaded and on every change.
  cleanups.push(
    useProject.subscribe((s) => {
      if (s.loaded) apply();
    }),
  );
  if (useProject.getState().loaded) apply();
  // Listing ports asks the browser for MIDI permission; only do it unprompted in the desktop app.
  if (isTauri) void refreshMidiPorts();

  if (isTauri) {
    let alive = true;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const u1 = await listen<{ bytes: number[] }>("sls://midi", (e) => handleIncoming({ kind: "midi", bytes: e.payload.bytes }));
      const u2 = await listen<{ address: string; args: { t: string; v: number | string | boolean }[]; from: string }>("sls://osc", (e) =>
        handleIncoming({ kind: "osc", address: e.payload.address, args: e.payload.args.map((a) => a.v), from: e.payload.from }),
      );
      if (!alive) {
        u1();
        u2();
      } else cleanups.push(u1, u2);
    });
    cleanups.push(() => {
      alive = false;
    });
  }
  return () => cleanups.forEach((c) => c());
}

/** Simulate an incoming message (for testing triggers without hardware). */
export function injectIncoming(m: IncomingMessage) {
  handleIncoming(m);
}
