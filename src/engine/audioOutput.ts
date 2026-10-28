// Where the app's sound goes: one audio output for the whole app, chosen per computer.
//
// Two engines can route it:
//  - native: the operating system's own device list (CoreAudio on macOS), which shows every
//    output, Dante Virtual Soundcard included. The desktop app's webview always plays on the
//    Mac's default output, so routing sets that (and the app puts the old one back on quit).
//  - web: the webview's own device list and setSinkId, where the webview offers them (Chrome and
//    WebView2 on Windows do; the macOS webview lists no outputs). Chromium hides the list (one
//    nameless entry) until the page may use a microphone, and refuses setSinkId to a named device
//    until then too, so the desktop app on Windows asks once (the Rust side grants it without a
//    prompt, see lib.rs) and never records anything.
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
  /** Dante Virtual Soundcard in WDM mode: Windows lists each stereo pair as a playback device ("DVS Transmit 1-2"). */
  dante: boolean;
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

/** The desktop app outside macOS (WebView2): the web engine is how sound is routed, and the app grants itself the microphone. */
const webRouting = isTauri && !nativeRouting && webSinkSupported;

// Chromium's own entries for "whatever Windows uses": the computer default, not devices to pick.
const ALIASES = new Set(["default", "communications"]);

async function rawOutputs(): Promise<MediaDeviceInfo[]> {
  if (!webSinkSupported || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  } catch {
    return [];
  }
}

/** The webview hides its outputs: one entry with no id or no name. */
const hidden = (all: MediaDeviceInfo[]) => all.some((d) => !d.deviceId || !d.label);

let unlocking: Promise<void> | null = null;
/** Browsers hide device names until the page may use a microphone: ask once to show them. */
export function revealWebOutputNames(): Promise<void> {
  unlocking ??= navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((s) => s.getTracks().forEach((t) => t.stop()))
    .catch((e) => {
      unlocking = null; // let a later look (or the button) try again, e.g. once Dante is running
      throw e;
    });
  return unlocking;
}

/** In the desktop app on Windows, unlock the list on its own (no prompt there); elsewhere it waits for the button. */
async function autoUnlock(all: MediaDeviceInfo[]): Promise<MediaDeviceInfo[]> {
  if (!webRouting || !hidden(all)) return all;
  try {
    await revealWebOutputNames();
    return await rawOutputs();
  } catch {
    return all;
  }
}

export async function webOutputs(): Promise<WebOutput[]> {
  const all = await autoUnlock(await rawOutputs());
  return all
    .filter((d) => d.deviceId && !ALIASES.has(d.deviceId))
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}`, dante: isDante(d.label) }));
}

const isDante = (name: string) => /dante|\bDVS\b/i.test(name);

/**
 * Windows: Dante Virtual Soundcard is installed (its ASIO driver is) but Windows lists none of its
 * outputs. It runs either ASIO or WDM, never both, and only WDM reaches Windows' own outputs, so it
 * is stopped or in ASIO mode (the mode vMix and other ASIO apps use). Returns the driver's name.
 */
export async function danteAsioOnly(web?: WebOutput[]): Promise<string | null> {
  if (!webRouting || (await webOutputsHidden())) return null; // a hidden list says nothing yet
  let drivers: string[] = [];
  try {
    drivers = await invoke<string[]>("audio_asio_drivers");
  } catch {
    return null;
  }
  const dvs = drivers.find(isDante);
  if (!dvs) return null;
  return (web ?? (await webOutputs())).some((o) => o.dante) ? null : dvs;
}

/** What to do about danteAsioOnly, in words for the operator (and the MCP). */
export const DANTE_WDM_STEPS =
  "Dante Virtual Soundcard is installed but Windows lists none of its outputs: it is stopped, or set to ASIO, which only ASIO apps such as vMix can use. " +
  "In the Dante Virtual Soundcard window: Stop, Settings → Audio Interface → WDM, Start. Its 8 stereo pairs then show here as DVS Transmit 1-2, 3-4 … (1-2 = Dante channels 1 and 2). " +
  "In WDM mode ASIO apps on this computer no longer see it: point them at the DVS Transmit outputs too.";

/** What the webview's default output is called ("Speakers (Realtek(R) Audio)"), when it says. */
export async function webDefaultName(): Promise<string | null> {
  const d = (await rawOutputs()).find((o) => o.deviceId === "default");
  return d?.label ? d.label.replace(/^Default\s*-\s*/i, "") : null;
}

/** Whether the webview still hides its output names (the "Show all outputs" button is needed). */
export async function webOutputsHidden(): Promise<boolean> {
  return hidden(await rawOutputs());
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
  // Preview media is heard on this computer's own speakers, never the show output (render/layers/video.ts `local`).
  if ((el as { dataset?: DOMStringMap }).dataset?.localSound) return;
  const id = webSink();
  void el.setSinkId(id).catch(async (e) => {
    // A named device needs the microphone permission (this window may not have it yet): ask, try once more.
    if (id && webRouting && e?.name === "NotAllowedError") {
      try {
        await revealWebOutputNames();
        return await el.setSinkId!(id);
      } catch (e2) {
        e = e2;
      }
    }
    console.warn("audio output not available", e);
  });
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
  // A chosen Windows output needs the permission in this window before the first setSinkId.
  if (webRouting && webSink()) void revealWebOutputNames().catch(() => {}).finally(applyWebSinks);
  else applyWebSinks();
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
  // A chosen web output that went away (Dante Virtual Soundcard restarting): point everything at it again when it is back.
  let webPresent = true;
  const onDeviceChange = async () => {
    const id = webSink();
    if (!id) return;
    const back = (await rawOutputs()).some((d) => d.deviceId === id);
    if (back && !webPresent) applyWebSinks();
    webPresent = back;
  };
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

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
    navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    clearInterval(poll);
  };
}
