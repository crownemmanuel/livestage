// The wall video sender (docs/WALL_VIDEO_LINK.md). Loaded only when the link goes on
// (engine/wallVideoLink.ts); everything it registers (one R3F after-render hook, a worker, a timer)
// goes again in stop(). It reads the operator window's own monitors only, never the audience output
// window: the PROGRAM monitor (what the wall shows, the default) or the PREVIEW monitor.
//
// Per frame, on the main thread: after R3F has drawn, if the monitor's scene canvas was drawn this tick
// and a frame is due, take each visible canvas with `new VideoFrame(canvas)` (a GPU-side snapshot; no
// pixel readback, no WebGL state touched), read the opacity of the program monitor's HTML layers
// (transition video, fade to black, standby, blackout), and transfer it all to the worker, which
// composites, scales, encodes JPEG and sends. One frame in flight at a time: while the worker is busy,
// or the socket has data queued, frames are dropped, so latency stays flat.

import { _roots, addAfterEffect } from "@react-three/fiber";
import type { WebGLRenderer } from "three";
import { now } from "@/core/clock";
import { isTauri } from "@/core/platform";
import { sceneCodes } from "@/core/groups";
import { useShow } from "@/store/show";
import { useProject } from "@/store/project";
import { offStatus, useWallVideo, type WallVideoSettings, type WallVideoStatus } from "./wallVideoLink";

const STATS_MS = 500;
const WINDOW_MS = 2000;
const VISIBLE = 0.002;

type Img = VideoFrame | ImageBitmap;
/** One drawing step for the worker, bottom to top. */
export type WallOp =
  | { k: "img"; img: Img; a: number; fit: "fill" | "cover"; posY?: number }
  | { k: "fill"; color: string; a: number }
  | { k: "standby"; a: number; color: string; text: string; sub: string; img: string | null; fit: "fill" | "cover" | "contain" };

type FromWorker =
  | { t: "sent"; bytes: number; encodeMs: number }
  | { t: "skip" }
  | { t: "badSource" }
  | { t: "needAsset"; key: string }
  | { t: "state"; state: "connecting" | "connected"; error?: string }
  | { t: "stagelight"; version: string; armed: boolean | null }
  | { t: "viewers"; n: number }
  | { t: "stats"; fps: number; latency: number; jitter: number; delay: number; offset: number };

let version = "";
if (isTauri)
  void import("@tauri-apps/api/app")
    .then((m) => m.getVersion())
    .then((v) => (version = v), () => {});

const STANDBY_FIT = { stretch: "fill", fill: "cover", fit: "contain", native: "contain" } as const;
const opacityOf = (el: HTMLElement | null) => (el ? parseFloat(el.style.opacity || "0") || 0 : 0);

export function startWallVideo(initial: WallVideoSettings): { stop(): void; reconfigure(s: WallVideoSettings): void } {
  let settings = initial;
  const worker = new Worker(new URL("./wallVideoWorker.ts", import.meta.url), { type: "module" });
  let stopped = false;
  let inFlight = false;
  /** StageLight windows showing the stream, as StageLight reports it (shown in the status only: nothing pauses the stream but the switch). */
  let viewers: number | null = null;
  let connected = false;
  let useBitmap = typeof VideoFrame === "undefined";
  let lastFrameNo = -1;
  let lastCanvas: HTMLCanvasElement | null = null;
  let lastAt = 0;
  let w = 0;
  let h = 0;
  let helloKey = "";
  let waiting: string | undefined;

  // Rolling measurements (last WINDOW_MS).
  const sentLog: { at: number; bytes: number; encodeMs: number }[] = [];
  const captureLog: { at: number; ms: number }[] = [];
  let sent = 0;
  let dropped = 0;
  let lastBytes = 0;
  let remote: WallVideoStatus["remote"];
  let stagelight: WallVideoStatus["stagelight"];
  let state: WallVideoStatus["state"] = "connecting";
  let error: string | undefined;

  const runtime = () => (settings.source === "program" ? useShow.getState().program.runtime : useShow.getState().preview);
  const sceneLabel = () => {
    const rt = runtime();
    if (!rt) return "";
    const code = sceneCodes(useProject.getState().project).get(rt.scene.id) ?? String(rt.scene.number);
    return `${code} ${rt.scene.name}`.trim();
  };
  const url = () => `ws://${useProject.getState().project.io?.stagelight?.host?.trim() || "127.0.0.1"}:${settings.port}/wall/in`;
  const size = () => {
    const out = useShow.getState().output;
    const W = Math.max(16, out.canvasWidth);
    const H = Math.max(16, out.canvasHeight);
    w = Math.round(settings.width / 2) * 2;
    h = Math.max(2, Math.round((w * H) / W / 2) * 2);
  };
  const hello = () => {
    const out = useShow.getState().output;
    return { t: "hello", app: "LiveStage", version, protocol: 1, source: settings.source, width: w, height: h, fps: settings.fps, scene: sceneLabel(), wall: [out.canvasWidth, out.canvasHeight] };
  };
  const configure = () => {
    size();
    const hl = hello();
    helloKey = JSON.stringify(hl);
    worker.postMessage({ t: "config", url: url(), hello: hl });
  };

  /** The standby picture, sent to the worker once per picture. */
  const sendAsset = (key: string) => {
    const img = document.querySelector<HTMLImageElement>('[data-stage-source="program"] [data-wall-layer="standby"] img');
    if (!img || img.src !== key || !img.complete) return;
    createImageBitmap(img).then(
      (bmp) => (stopped ? bmp.close() : worker.postMessage({ t: "asset", key, img: bmp }, [bmp])),
      () => {},
    );
  };

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    switch (m.t) {
      case "sent":
        inFlight = false;
        sent++;
        lastBytes = m.bytes;
        sentLog.push({ at: now(), bytes: m.bytes, encodeMs: m.encodeMs });
        break;
      case "skip":
        inFlight = false;
        dropped++;
        break;
      case "badSource":
        // This engine cannot draw a VideoFrame into a 2D canvas: take ImageBitmaps instead.
        inFlight = false;
        useBitmap = true;
        break;
      case "needAsset":
        sendAsset(m.key);
        break;
      case "state":
        connected = m.state === "connected";
        state = m.state;
        error = m.error;
        if (!connected) {
          viewers = null;
          stagelight = undefined;
          remote = undefined;
        }
        break;
      case "stagelight":
        stagelight = { version: m.version, armed: m.armed };
        break;
      case "viewers":
        viewers = m.n;
        break;
      case "stats":
        remote = { fps: m.fps, latency: m.latency, jitter: m.jitter, delay: m.delay, offset: m.offset, at: Date.now() };
        break;
    }
  };
  worker.onerror = (e) => {
    state = "error";
    error = `Wall video worker: ${e.message}`;
  };

  /** A snapshot of a canvas or video element (null when this engine cannot take it). */
  const grab = (src: HTMLCanvasElement | HTMLVideoElement): Img | Promise<ImageBitmap> => (useBitmap ? createImageBitmap(src) : new VideoFrame(src, { timestamp: 0 }));

  /** Was this canvas drawn in this tick? Only then does it still hold its picture (no preserveDrawingBuffer). */
  const drawnNow = (canvas: HTMLCanvasElement) => {
    const gl = _roots.get(canvas)?.store.getState().gl as WebGLRenderer | undefined;
    if (!gl) return false;
    const n = gl.info.render.frame;
    if (canvas === lastCanvas && n === lastFrameNo) return false;
    lastCanvas = canvas;
    lastFrameNo = n;
    return true;
  };

  /** The layers of the chosen monitor, bottom to top, or null when there is nothing new to send. */
  const collect = (): (WallOp | Promise<WallOp>)[] | null => {
    const out = useShow.getState().output;
    const base: WallOp = { k: "fill", color: out.backgroundColor || "#000000", a: 1 };
    if (settings.source === "preview") {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-stage-source="preview"] [data-stage-role="preview"] canvas');
      waiting = canvas ? undefined : "The preview monitor is not on screen";
      if (!canvas || !drawnNow(canvas)) return null;
      return [base, wrap(grab(canvas), (img) => ({ k: "img", img, a: 1, fit: "fill" }))];
    }
    const root = document.querySelector<HTMLElement>('[data-stage-source="program"]');
    waiting = root ? undefined : "The program monitor is not on screen (Show mode shows it)";
    if (!root) return null;
    const slots = [...root.querySelectorAll<HTMLElement>("[data-wall-slot]")].sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
    const top = slots.length ? slots[slots.length - 1].querySelector("canvas") : null;
    // Paced by the live scene's canvas; on standby with no scene, by the frame rate alone.
    if (top && !drawnNow(top)) return null;
    const ops: (WallOp | Promise<WallOp>)[] = [base];
    for (const slot of slots) {
      const a = opacityOf(slot);
      const canvas = slot.querySelector("canvas");
      if (a > VISIBLE && canvas) ops.push(wrap(grab(canvas), (img) => ({ k: "img", img, a, fit: "fill" })));
    }
    // A <video>, or on the WebCodecs player a canvas it draws its frames into (render/StageView.tsx).
    const video = root.querySelector<HTMLVideoElement | HTMLCanvasElement>('[data-wall-layer="video"]');
    const va = opacityOf(video);
    if (video && va > VISIBLE && (video instanceof HTMLCanvasElement ? video.dataset.ready === "1" : video.readyState >= 2)) {
      const posY = parseFloat(video.style.objectPosition.split(" ")[1] ?? "50") / 100;
      ops.push(wrap(grab(video), (img) => ({ k: "img", img, a: va, fit: "cover", posY: Number.isFinite(posY) ? posY : 0.5 })));
    }
    const fade = opacityOf(root.querySelector('[data-wall-layer="fade"]'));
    if (fade > VISIBLE) ops.push({ k: "fill", color: "#000000", a: fade });
    const standby = root.querySelector<HTMLElement>('[data-wall-layer="standby"]');
    const sa = opacityOf(standby);
    if (standby && sa > VISIBLE) {
      const img = standby.querySelector("img");
      const lines = standby.querySelectorAll(".text-center > div");
      ops.push({
        k: "standby",
        a: sa,
        color: standby.style.background || "#000000",
        text: lines[0]?.textContent ?? "",
        sub: lines[1]?.textContent ?? "",
        img: img?.src ?? null,
        fit: STANDBY_FIT[out.scaling] ?? "contain",
      });
    }
    const blackout = opacityOf(root.querySelector('[data-wall-layer="blackout"]'));
    if (blackout > VISIBLE) ops.push({ k: "fill", color: "#000000", a: blackout });
    return ops;
  };

  // After every R3F frame (all canvases of this window have drawn).
  const unhook = addAfterEffect(() => {
    if (stopped || inFlight || !connected) return;
    const t = now();
    if (t - lastAt < 1000 / settings.fps - 4) return;
    const c0 = performance.now();
    let ops: (WallOp | Promise<WallOp>)[] | null;
    try {
      ops = collect();
    } catch {
      // VideoFrame refused a source (an engine without it for WebGL / video): fall back once.
      if (!useBitmap) useBitmap = true;
      else dropped++;
      return;
    }
    if (!ops) return;
    lastAt = t;
    captureLog.push({ at: t, ms: performance.now() - c0 });
    inFlight = true;
    const rt = runtime();
    const flags = (rt?.clock.pausedAt != null ? 1 : 0) | (rt ? 0 : 2);
    const post = (list: WallOp[]) => {
      if (stopped) return list.forEach((o) => o.k === "img" && o.img.close());
      worker.postMessage({ t: "frame", ops: list, stamp: t, flags, width: w, height: h, quality: settings.quality }, list.flatMap((o) => (o.k === "img" ? [o.img] : [])));
    };
    if (ops.some((o) => o instanceof Promise))
      Promise.all(ops).then(post, () => {
        inFlight = false;
        dropped++;
      });
    else post(ops as WallOp[]);
  });

  const report = () => {
    const t = now();
    while (sentLog.length && sentLog[0].at < t - WINDOW_MS) sentLog.shift();
    while (captureLog.length && captureLog[0].at < t - WINDOW_MS) captureLog.shift();
    const span = WINDOW_MS / 1000;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const prev = useWallVideo.getState().status;
    useWallVideo.setState({
      status: {
        ...offStatus(),
        state,
        error,
        waiting: connected ? waiting : undefined,
        url: url(),
        stagelight,
        viewers: viewers ?? 0,
        sent,
        dropped,
        fps: r2(sentLog.length / span),
        kbps: Math.round((sentLog.reduce((a, s) => a + s.bytes, 0) / span / 1024) * 8),
        frameBytes: lastBytes,
        width: w,
        height: h,
        captureMs: r2(mean(captureLog.map((c) => c.ms))),
        captureMaxMs: r2(Math.max(0, ...captureLog.map((c) => c.ms))),
        encodeMs: r2(mean(sentLog.map((s) => s.encodeMs))),
        remote: remote && Date.now() - remote.at < 3000 ? remote : undefined,
        previewLights: prev.previewLights,
      },
    });
    // Tell StageLight when the scene, the source or the size changes.
    const hl = hello();
    if (JSON.stringify(hl) !== helloKey) {
      helloKey = JSON.stringify(hl);
      worker.postMessage({ t: "hello", hello: hl });
    }
  };
  const timer = setInterval(report, STATS_MS);

  configure();
  report();

  return {
    stop() {
      stopped = true;
      unhook();
      clearInterval(timer);
      worker.postMessage({ t: "close" });
      // Let it send the close frame, then end it regardless.
      setTimeout(() => worker.terminate(), 300);
    },
    reconfigure(s) {
      settings = s;
      lastCanvas = null;
      configure();
    },
  };
}

/** Map a snapshot (taken now, or arriving as an ImageBitmap) to its drawing step. */
function wrap(img: Img | Promise<ImageBitmap>, op: (img: Img) => WallOp): WallOp | Promise<WallOp> {
  return img instanceof Promise ? img.then(op) : op(img);
}
