// Where the app's sound goes: one audio output for the whole app, chosen per computer.
//
// Two engines can route it:
//  - native: the operating system's own device list (CoreAudio on macOS), which shows every
//    output, Dante Virtual Soundcard included. The desktop app's webview always plays on the
//    Mac's default output, so routing sets that (and the app puts the old one back on quit).
//  - web: the webview's own device list and setSinkId, where the webview offers them (Chrome and
//    WebView2 on Windows do; the macOS webview lists no outputs).
// The choice is machine-local (a Dante card on one Mac is not on another), kept in localStorage,
// and every window follows it (the storage event reaches the output window).

import { isTauri, windowRole } from "@/core/platform";

export interface NativeOutput {
  uid: string;
  name: string;
  manufacturer: string;
  transport: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
  dante: boolean;
  running: boolean;
}

export interface WebOutput {
  deviceId: string;
  label: string;
}

/** The chosen output; null = the computer's default, untouched. */
export type AudioRoute = { engine: "native" | "web"; id: string; name: string } | null;

const KEY = "sls.audioOutput";

export function getAudioRoute(): AudioRoute {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return r && (r.engine === "native" || r.engine === "web") && typeof r.id === "string" ? r : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
export function onAudioRouteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Native routing exists only in the desktop app on macOS. */
export const nativeRouting = isTauri && /Mac/.test(navigator.platform || navigator.userAgent);

export async function nativeOutputs(): Promise<NativeOutput[]> {
  if (!isTauri) return [];
  try {
    return await invoke<NativeOutput[]>("audio_outputs");
  } catch {
    return [];
  }
}

/** Whether this webview can send media to a chosen device at all. */
export const webSinkSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

export async function webOutputs(): Promise<WebOutput[]> {
  if (!webSinkSupported || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audiooutput" && d.deviceId).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
  } catch {
    return [];
  }
}

/** Browsers hide device names until the page may use a microphone: ask once to show them. */
export async function revealWebOutputNames(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------- web engine sinks

type Sinkable = { setSinkId?: (id: string) => Promise<void> };
const contexts = new Set<AudioContext>();

const webSink = () => {
  const r = getAudioRoute();
  return r?.engine === "web" ? r.id : "";
};

function sink(el: Sinkable) {
  if (!el.setSinkId) return;
  void el.setSinkId(webSink()).catch((e) => console.warn("audio output not available", e));
}

/** The program audio context: send it to the chosen web output too. */
export function registerAudioContext(ctx: AudioContext) {
  contexts.add(ctx);
  if (webSink()) sink(ctx as unknown as Sinkable);
}

function applyWebSinks() {
  for (const el of document.querySelectorAll("video, audio")) sink(el as unknown as Sinkable);
  for (const c of contexts) sink(c as unknown as Sinkable);
}

// ---------------------------------------------------------------- routing

/** Choose where the app's sound goes (null = leave the computer's default alone). */
export async function setAudioRoute(route: AudioRoute): Promise<void> {
  const prev = getAudioRoute();
  if (route?.engine === "native") await invoke("audio_output_route", { uid: route.id });
  else if (prev?.engine === "native" && nativeRouting) await invoke("audio_output_restore").catch(() => {});
  try {
    if (route) localStorage.setItem(KEY, JSON.stringify(route));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  if (route?.engine === "web" || prev?.engine === "web") applyWebSinks();
  listeners.forEach((f) => f());
}

/** The chosen native device is connected but the Mac's sound goes elsewhere. */
export function routeMismatch(route: AudioRoute, outputs: NativeOutput[]): { chosen?: NativeOutput; actual?: NativeOutput } | null {
  if (route?.engine !== "native") return null;
  const chosen = outputs.find((o) => o.uid === route.id);
  const actual = outputs.find((o) => o.isDefault);
  if (chosen?.isDefault) return null;
  return { chosen, actual };
}

/**
 * Start following the chosen output in this window: web sinks on every media element (new ones
 * included), and in the operator window the native route, re-applied when its device comes back
 * (Dante Virtual Soundcard restarting sends the Mac to another output and never back).
 */
export function startAudioRouting(): () => void {
  applyWebSinks();
  // Elements made later start on the default output: point each one at the chosen output.
  const mo = new MutationObserver((muts) => {
    if (!webSink()) return;
    for (const m of muts)
      for (const n of m.addedNodes) {
        if (n instanceof HTMLMediaElement) sink(n as unknown as Sinkable);
        else if (n instanceof Element) for (const el of n.querySelectorAll("video, audio")) sink(el as unknown as Sinkable);
      }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    applyWebSinks();
    listeners.forEach((f) => f());
  };
  window.addEventListener("storage", onStorage);

  let poll: ReturnType<typeof setInterval> | undefined;
  if (nativeRouting && windowRole === "operator") {
    let present = false;
    const check = async () => {
      const r = getAudioRoute();
      if (r?.engine !== "native") return;
      const dev = (await nativeOutputs()).find((o) => o.uid === r.id);
      if (dev && !present && !dev.isDefault) await invoke("audio_output_route", { uid: r.id }).catch((e) => console.warn("audio route failed", e));
      present = !!dev;
    };
    void check();
    poll = setInterval(() => void check(), 3000);
  }
  return () => {
    mo.disconnect();
    window.removeEventListener("storage", onStorage);
    clearInterval(poll);
  };
}
