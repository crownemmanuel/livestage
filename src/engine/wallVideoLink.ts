// The wall video link's switch: streams the operator's PROGRAM monitor (what the wall shows; or the
// PREVIEW monitor) to StageLight's virtual LED wall while rehearsing (docs/WALL_VIDEO_LINK.md). This file is all that exists while the link is off: a setting,
// a status store and the switch. The sender itself (engine/wallVideo.ts: render hook, worker, socket)
// is loaded with import() when the link goes on, and removes everything it registered when it goes off.
// "On" is never remembered: the link is off at every start of the app.

import { create } from "zustand";
import { STAGELIGHT_ALIVE_MS, useStageLight } from "./stageLight";

/** StageLight's wall video ingest port (LIGHTS_WALL_PORT there). */
export const WALL_VIDEO_PORT = 1455;
export const WALL_VIDEO_WIDTHS = [768, 1024, 1536] as const;
export const WALL_VIDEO_FPS = [15, 20, 25, 30] as const;

export type WallVideoSource = "program" | "preview";

export interface WallVideoSettings {
  /** Which operator monitor to stream: PROGRAM (what the wall shows) or PREVIEW (the rehearsal monitor). */
  source: WallVideoSource;
  /** Stream width in pixels; the height follows the wall's aspect. */
  width: number;
  fps: number;
  /** JPEG quality 0.3..0.95. */
  quality: number;
  /** StageLight's ingest port; the host is the StageLight link's (Settings → StageLight). */
  port: number;
}

export interface WallVideoStatus {
  state: "off" | "starting" | "connecting" | "connected" | "error";
  error?: string;
  /** Why nothing is captured although StageLight is watching (the monitor is not on screen). */
  waiting?: string;
  /** ws:// address being used. */
  url?: string;
  /** StageLight's hello on the video socket. */
  stagelight?: { version: string; armed: boolean | null };
  /** StageLight windows showing the stream (information only: the stream runs until switched off). */
  viewers: number;
  /** Since the link went on. */
  sent: number;
  dropped: number;
  /** Over the last 2 s. */
  fps: number;
  kbps: number;
  frameBytes: number;
  width: number;
  height: number;
  /** Main-thread cost of taking a frame (ms): mean and max over the last 2 s. */
  captureMs: number;
  captureMaxMs: number;
  /** Worker: scale + encode (ms), mean over the last 2 s. */
  encodeMs: number;
  /** What StageLight measures (latency = drawn there minus the frame's stamp, ms). */
  remote?: { fps: number; latency: number; jitter: number; delay: number; offset: number; at: number };
  /** Preview StageLight cues sent / held back (StageLight armed or not answering) while the link is on. */
  previewLights: { sent: number; held: number; lastHeld?: string };
}

const KEY = "sls.wallVideo";
const DEFAULTS: WallVideoSettings = { source: "program", width: 1024, fps: 25, quality: 0.7, port: WALL_VIDEO_PORT };

function readSettings(): WallVideoSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<WallVideoSettings>;
    return clean({ ...DEFAULTS, ...v });
  } catch {
    return { ...DEFAULTS };
  }
}

function clean(s: WallVideoSettings): WallVideoSettings {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    source: s.source === "preview" ? "preview" : "program",
    width: Math.round(Math.min(2048, Math.max(256, num(s.width, DEFAULTS.width)))),
    fps: Math.round(Math.min(30, Math.max(5, num(s.fps, DEFAULTS.fps)))),
    quality: Math.min(0.95, Math.max(0.3, num(s.quality, DEFAULTS.quality))),
    port: Math.round(Math.min(65535, Math.max(1, num(s.port, DEFAULTS.port)))),
  };
}

export const offStatus = (): WallVideoStatus => ({
  state: "off",
  viewers: 0,
  sent: 0,
  dropped: 0,
  fps: 0,
  kbps: 0,
  frameBytes: 0,
  width: 0,
  height: 0,
  captureMs: 0,
  captureMaxMs: 0,
  encodeMs: 0,
  previewLights: { sent: 0, held: 0 },
});

interface WallVideoStore {
  on: boolean;
  settings: WallVideoSettings;
  status: WallVideoStatus;
}

export const useWallVideo = create<WallVideoStore>(() => ({ on: false, settings: readSettings(), status: offStatus() }));

/** The running sender's controls (set while it runs). */
interface Sender {
  stop(): void;
  reconfigure(s: WallVideoSettings): void;
}
let sender: Sender | null = null;
let switching: Promise<void> = Promise.resolve();

/** Switch the link and/or change its settings. Resolves once the sender is up (or gone). */
export function setWallVideo(patch: Partial<WallVideoSettings> & { on?: boolean }): Promise<void> {
  const { on, ...rest } = patch;
  if (Object.keys(rest).length) {
    const settings = clean({ ...useWallVideo.getState().settings, ...rest });
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* private mode: kept for this run only */
    }
    useWallVideo.setState({ settings });
  }
  switching = switching.then(async () => {
    const want = on ?? useWallVideo.getState().on;
    const settings = useWallVideo.getState().settings;
    if (!want) {
      sender?.stop();
      sender = null;
      useWallVideo.setState({ on: false, status: offStatus() });
      return;
    }
    if (sender) {
      sender.reconfigure(settings);
      return;
    }
    useWallVideo.setState({ on: true, status: { ...offStatus(), state: "starting" } });
    try {
      const m = await import("./wallVideo");
      // Switched off while it loaded.
      if (!useWallVideo.getState().on) return;
      sender = m.startWallVideo(settings);
    } catch (e) {
      useWallVideo.setState({ on: false, status: { ...offStatus(), state: "error", error: String(e instanceof Error ? e.message : e) } });
    }
  });
  return switching;
}

/**
 * Whether a StageLight message from a PREVIEW cue may go out: only while the wall video link streams the preview and
 * StageLight said (≤ 12 s ago) that its output is not armed, so rehearsing never moves real lights.
 * Called only for preview cues that carry a StageLight message; live cues never come here.
 */
export function previewLightsAllowed(): boolean {
  const { on, settings } = useWallVideo.getState();
  if (!on || settings.source !== "preview") return false;
  const hello = useStageLight.getState().hello;
  const ok = !!hello && Date.now() - hello.at < STAGELIGHT_ALIVE_MS && hello.armed === false;
  useWallVideo.setState((s) => {
    const p = s.status.previewLights;
    const lastHeld = ok ? p.lastHeld : !hello || Date.now() - hello.at >= STAGELIGHT_ALIVE_MS ? "StageLight is not answering" : "StageLight's output is armed";
    return { status: { ...s.status, previewLights: { sent: p.sent + (ok ? 1 : 0), held: p.held + (ok ? 0 : 1), lastHeld } } };
  });
  return ok;
}
