// Surround speakers: Left, Right, Back 1 and Back 2, each one channel of a sound card, chosen per computer
// (Settings → Audio). A sound, an announcement or thunder can be sent to any of them instead of the main output.
//
// Everything is still mixed in the one program AudioContext (engine/audio.ts), so fades, ducks, holds and scrubs
// work as before. Each speaker is a mono input there:
//  - on the main output (the device the app's sound already goes to): a channel of that context's own
//    destination, opened up to as many channels as the device has (a 4-channel interface, Dante's 64 on the Mac);
//  - on another sound card (Windows, where the webview can play to any device, e.g. a second Dante Virtual
//    Soundcard pair "DVS Transmit 3-4"): sent as a mono stream to a small AudioContext of that card's own
//    (setSinkId), into the chosen channel. That hop adds a few tens of milliseconds next to the main output.
// A speaker not set up, or whose card is missing, plays on the main output (both channels) so nothing goes silent.
// The macOS webview only plays to the Mac's default output, so there every speaker is a channel of the main output.
//
// The setup is machine-local (a Dante card on one computer is not on another): localStorage, followed by every
// window through the storage event, like the main output (audioOutput.ts).

import type { SpeakerId } from "@/core/types";
import { getAudioRoute, nativeRouting, onAudioRouteChange, revealWebOutputNames } from "./audioOutput";

export const SPEAKERS: { id: SpeakerId; label: string; short: string }[] = [
  { id: "left", label: "Left", short: "L" },
  { id: "right", label: "Right", short: "R" },
  { id: "back1", label: "Back 1", short: "B1" },
  { id: "back2", label: "Back 2", short: "B2" },
];
export const SPEAKER_IDS = SPEAKERS.map((s) => s.id);
export const isSpeakerId = (v: unknown): v is SpeakerId => typeof v === "string" && (SPEAKER_IDS as string[]).includes(v);
export const speakerLabel = (id: SpeakerId) => SPEAKERS.find((s) => s.id === id)?.label ?? id;

/** Sent to both of a pair, the first plays the sound's left channel and the second its right. */
const PAIR: Record<SpeakerId, SpeakerId> = { left: "right", right: "left", back1: "back2", back2: "back1" };
const SIDE: Record<SpeakerId, 0 | 1> = { left: 0, right: 1, back1: 0, back2: 1 };

/** Where one speaker plays: `device` "" = the main output, else a web output's deviceId; `channel` 0-based. */
export interface SpeakerSetup {
  device: string;
  /** The device's name when chosen (shown while it is away). */
  deviceName?: string;
  channel: number;
}
export type SpeakerMap = Partial<Record<SpeakerId, SpeakerSetup>>;

const KEY = "sls.speakers";

/** Nothing chosen yet: Left and Right are the main output's two channels, the backs are not set up. */
const DEFAULT_SETUP: SpeakerMap = { left: { device: "", channel: 0 }, right: { device: "", channel: 1 } };

export function getSpeakerSetup(): SpeakerMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return { ...DEFAULT_SETUP };
    const r = JSON.parse(raw) as Record<string, unknown>;
    const out: SpeakerMap = {};
    for (const id of SPEAKER_IDS) {
      const s = r?.[id] as SpeakerSetup | undefined;
      if (s && typeof s.device === "string" && Number.isInteger(s.channel) && s.channel >= 0) out[id] = { device: s.device, channel: s.channel, ...(s.deviceName ? { deviceName: s.deviceName } : {}) };
    }
    return out;
  } catch {
    return { ...DEFAULT_SETUP };
  }
}

const listeners = new Set<() => void>();
export function onSpeakerSetupChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSpeakerSetup(map: SpeakerMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  changed();
}

function changed() {
  listeners.forEach((f) => f());
  void rebuild();
}

/** Whether a speaker can be on a sound card other than the main output (the webview can play to a chosen device). */
export const otherDevicesSupported = !nativeRouting && typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

type SinkableCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** Point a context at a web output; a named device needs the microphone permission first (see audioOutput.ts). */
async function sinkTo(ctx: AudioContext, id: string) {
  const c = ctx as SinkableCtx;
  if (!c.setSinkId) throw new Error("This webview cannot play to a chosen sound card.");
  try {
    await c.setSinkId(id);
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotAllowedError") throw e;
    await revealWebOutputNames();
    await c.setSinkId(id);
  }
}

/** The device a main-output context should play on: the chosen web output, or the default. */
const mainWebSink = () => {
  const r = getAudioRoute();
  return r?.engine === "web" ? r.id : "";
};

// ---------------------------------------------------------------- the graph in the program context

interface Bus {
  device: string;
  ctx: AudioContext;
  merger: ChannelMergerNode;
  streams: MediaStreamAudioDestinationNode[];
}

interface Graph {
  ac: AudioContext;
  /** What a sound for the main output connects to (stereo). */
  mainIn: GainNode;
  mainSplit: ChannelSplitterNode;
  mainMerger: ChannelMergerNode | null;
  speakerIn: Record<SpeakerId, GainNode>;
  buses: Bus[];
  /** How each speaker is reached now (diagnostics and the MCP). */
  state: Partial<Record<SpeakerId, SpeakerState>>;
}

export type SpeakerState = "main output" | "fallback: not set up" | "fallback: channel missing" | "fallback: device missing" | "fallback: unsupported" | "fallback: not the audio host" | "ok";

let graph: Graph | null = null;
let isHost: () => boolean = () => false;
let building: Promise<void> = Promise.resolve();

function mono(ac: AudioContext) {
  const g = ac.createGain();
  g.channelCount = 1;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

function stereo(ac: AudioContext) {
  const g = ac.createGain();
  g.channelCount = 2;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

/** Build the speaker graph in the program context (once). `host`: whether this window plays the show's sound. */
export function attachSpeakers(ac: AudioContext, host: () => boolean) {
  isHost = host;
  if (graph?.ac === ac) return;
  const mainIn = stereo(ac);
  const mainSplit = ac.createChannelSplitter(2);
  mainIn.connect(mainSplit);
  const speakerIn = Object.fromEntries(SPEAKER_IDS.map((id) => [id, mono(ac)])) as Record<SpeakerId, GainNode>;
  graph = { ac, mainIn, mainSplit, mainMerger: null, speakerIn, buses: [], state: {} };
  // Before the first rebuild (it waits on devices), everything plays on the main output.
  mainIn.connect(ac.destination);
  for (const id of SPEAKER_IDS) speakerIn[id].connect(mainIn);
  void rebuild();
}

/** The node a sound's output connects to, for the speakers it is sent to (none: the main output). */
export function soundOut(ac: AudioContext, speakers?: SpeakerId[]): AudioNode {
  const g = graph?.ac === ac ? graph : null;
  const set = new Set((speakers ?? []).filter(isSpeakerId));
  if (!g) return ac.destination;
  if (!set.size) return g.mainIn;
  const router = stereo(ac);
  let split: ChannelSplitterNode | null = null;
  for (const id of set) {
    if (set.has(PAIR[id])) {
      if (!split) {
        split = ac.createChannelSplitter(2);
        router.connect(split);
      }
      split.connect(g.speakerIn[id], SIDE[id]);
    } else router.connect(g.speakerIn[id]);
  }
  return router;
}

/** How each speaker is reached in this window now. */
export function speakerStates(): Partial<Record<SpeakerId, SpeakerState>> {
  return { ...(graph?.state ?? {}) };
}

/** Re-plan the graph: called when the setup, the main output, the audio host or the devices change. */
export function refreshSpeakers() {
  void rebuild();
}

function rebuild(): Promise<void> {
  building = building.then(build, build);
  return building;
}

function safeDisconnect(n: AudioNode) {
  try {
    n.disconnect();
  } catch {
    /* ignore */
  }
}

async function build() {
  const g = graph;
  if (!g) return;
  const { ac } = g;
  const setup = getSpeakerSetup();
  const host = isHost();
  const state: Graph["state"] = {};

  // Sound cards other than the main output: one small context each, opened before anything is reconnected.
  const wanted = new Map<string, number>();
  for (const id of SPEAKER_IDS) {
    const s = setup[id];
    if (s?.device && otherDevicesSupported && host) wanted.set(s.device, Math.max(wanted.get(s.device) ?? 0, s.channel + 1));
  }
  const buses: Bus[] = [];
  const missing = new Set<string>();
  for (const [device, need] of wanted) {
    try {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      await sinkTo(ctx, device);
      const n = Math.max(1, Math.min(need, ctx.destination.maxChannelCount || 2));
      ctx.destination.channelCount = n;
      ctx.destination.channelCountMode = "explicit";
      ctx.destination.channelInterpretation = "discrete";
      const merger = ctx.createChannelMerger(n);
      merger.connect(ctx.destination);
      if (ctx.state === "suspended") void ctx.resume();
      buses.push({ device, ctx, merger, streams: [] });
    } catch (e) {
      console.warn("speaker device not available", device, e);
      missing.add(device);
    }
  }

  // The main output: as many channels as its speakers need (its own two at least).
  let need = 2;
  for (const id of SPEAKER_IDS) {
    const s = setup[id];
    if (s && !s.device) need = Math.max(need, s.channel + 1);
  }
  const max = Math.max(2, ac.destination.maxChannelCount || 2);
  const n = Math.min(need, max);

  // Rewire (the speaker inputs and the main input stay, so sounds already playing follow the new setup).
  for (const id of SPEAKER_IDS) safeDisconnect(g.speakerIn[id]);
  safeDisconnect(g.mainIn);
  safeDisconnect(g.mainSplit);
  if (g.mainMerger) safeDisconnect(g.mainMerger);
  for (const b of g.buses) {
    for (const s of b.streams) safeDisconnect(s);
    void b.ctx.close().catch(() => {});
  }
  g.mainIn.connect(g.mainSplit);

  try {
    ac.destination.channelCount = n;
    ac.destination.channelCountMode = "explicit";
    ac.destination.channelInterpretation = n > 2 ? "discrete" : "speakers";
  } catch (e) {
    console.warn("main output channels", e);
  }
  const merger = ac.createChannelMerger(Math.max(2, ac.destination.channelCount));
  merger.connect(ac.destination);
  g.mainSplit.connect(merger, 0, 0);
  g.mainSplit.connect(merger, 1, 1);
  g.mainMerger = merger;

  for (const id of SPEAKER_IDS) {
    const s = setup[id];
    const toMain = (why: SpeakerState) => {
      g.speakerIn[id].connect(g.mainIn);
      state[id] = why;
    };
    if (!s) toMain("fallback: not set up");
    else if (!s.device) {
      if (s.channel < merger.numberOfInputs) {
        g.speakerIn[id].connect(merger, 0, s.channel);
        state[id] = "main output";
      } else toMain("fallback: channel missing");
    } else if (!otherDevicesSupported) toMain("fallback: unsupported");
    else if (!host) toMain("fallback: not the audio host");
    else {
      const bus = buses.find((b) => b.device === s.device);
      if (!bus || missing.has(s.device)) toMain("fallback: device missing");
      else if (s.channel >= bus.merger.numberOfInputs) toMain("fallback: channel missing");
      else {
        const out = ac.createMediaStreamDestination();
        out.channelCount = 1;
        out.channelCountMode = "explicit";
        g.speakerIn[id].connect(out);
        bus.ctx.createMediaStreamSource(out.stream).connect(bus.merger, 0, s.channel);
        bus.streams.push(out);
        state[id] = "ok";
      }
    }
  }
  g.buses = buses;
  g.state = state;
}

/** Follow setup changes made in another window, the main output and device changes, in this window. */
export function startSpeakers(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) changed();
  };
  window.addEventListener("storage", onStorage);
  // The main output moved (its channel count may differ): give the webview a moment to switch, then re-plan.
  const offRoute = onAudioRouteChange(() => setTimeout(refreshSpeakers, 300));
  // A speaker's card came back (Dante Virtual Soundcard restarting) or went away.
  const onDevices = () => {
    if (!graph) return;
    if (graph.buses.length || Object.values(graph.state).includes("fallback: device missing")) refreshSpeakers();
  };
  navigator.mediaDevices?.addEventListener?.("devicechange", onDevices);
  return () => {
    window.removeEventListener("storage", onStorage);
    offRoute();
    navigator.mediaDevices?.removeEventListener?.("devicechange", onDevices);
  };
}

// ---------------------------------------------------------------- test

/**
 * Play a short burst of noise on one speaker, on a context of its own (the show's sound is not touched), so the
 * operator can walk the room and check each speaker. Throws with words for the operator when it cannot.
 */
export async function testSpeaker(id: SpeakerId, setup: SpeakerSetup | undefined = getSpeakerSetup()[id]): Promise<void> {
  if (!setup) throw new Error(`${speakerLabel(id)} is not set up: it plays on the main output.`);
  const ctx = new AudioContext();
  try {
    const sink = setup.device || mainWebSink();
    if (sink) await sinkTo(ctx, sink);
    const max = ctx.destination.maxChannelCount || 2;
    if (setup.channel >= max) throw new Error(`${setup.device ? (setup.deviceName ?? "That sound card") : "The main output"} has ${max} channel${max === 1 ? "" : "s"}: there is no channel ${setup.channel + 1}.`);
    const n = Math.max(2, setup.channel + 1);
    ctx.destination.channelCount = n;
    ctx.destination.channelCountMode = "explicit";
    ctx.destination.channelInterpretation = "discrete";
    const merger = ctx.createChannelMerger(n);
    merger.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = 0.97 * b + (Math.random() * 2 - 1) * 0.3; // soft pink-ish noise
      d[i] = b;
    }
    const t = ctx.currentTime + 0.05;
    for (let k = 0; k < 2; k++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const at = t + k * 0.6;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.5, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
      src.connect(gain).connect(merger, 0, setup.channel);
      src.start(at);
    }
    await new Promise((r) => setTimeout(r, 1400));
  } finally {
    void ctx.close().catch(() => {});
  }
}
