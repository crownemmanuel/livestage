// Operator screen ⇄ service: one WebSocket with state snapshots / patches and commands. A command sent
// while the socket is down goes over HTTP instead, so MUTE ALL never depends on the socket.

import { useSyncExternalStore } from "react";
import type { Runtime, Settings, SoundShow } from "../../../server/model.ts";

export interface Links {
  ip: string;
  local: string;
  cloud: string | null;
  hosted: boolean;
  active: string | null;
}

export interface OpState {
  connected: boolean;
  show: SoundShow | null;
  runtime: Runtime | null;
  pending: Record<string, boolean>;
  settings: Settings | null;
  links: Links | null;
  log: { at: number; msg: string }[];
  toast: { text: string; bad: boolean; at: number } | null;
}

let state: OpState = { connected: false, show: null, runtime: null, pending: {}, settings: null, links: null, log: [], toast: null };
const subs = new Set<() => void>();
const set = (patch: Partial<OpState>) => {
  state = { ...state, ...patch };
  for (const f of subs) f();
};

export function useOp<T>(pick: (s: OpState) => T): T {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => pick(state),
  );
}
export const getOp = () => state;

let ws: WebSocket | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws?role=operator`);
  ws = sock;
  sock.onopen = () => set({ connected: true });
  sock.onclose = () => {
    if (ws === sock) ws = null;
    set({ connected: false });
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.fail(new Error("Lost the connection to the Sound service"));
      waiting.delete(id);
    }
    setTimeout(connect, 800);
  };
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "state") set({ show: m.show, runtime: m.runtime, pending: m.pending ?? {}, settings: m.settings, links: m.links, log: m.log ?? [] });
    else if (m.t === "patch") {
      const p: Partial<OpState> = {};
      if (m.show) p.show = m.show;
      if (m.runtime) p.runtime = m.runtime;
      if (m.pending) p.pending = m.pending;
      if (m.settings) p.settings = m.settings;
      if (m.links) p.links = m.links;
      set(p);
    } else if (m.t === "log") set({ log: [...state.log.slice(-150), m.line] });
    else if (m.t === "res") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.ok(m.result);
      else w.fail(new Error(m.error));
    }
  };
}
connect();

/** Run a command on the service. Errors show as a toast unless `quiet`. */
export async function cmd<T = unknown>(name: string, args: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<T> {
  try {
    return (await rawCmd(name, args)) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!opts.quiet) toast(msg, true);
    throw e;
  }
}

function rawCmd(name: string, args: Record<string, unknown>): Promise<unknown> {
  const sock = ws;
  if (sock && sock.readyState === WebSocket.OPEN) {
    const id = nextId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        fail(new Error(`${name}: no answer from the Sound service`));
      }, name === "mics.detect" || name === "import.livestage" ? 20000 : 6000);
      waiting.set(id, { ok, fail, timer });
      sock.send(JSON.stringify({ t: "cmd", id, cmd: name, args }));
    });
  }
  return http(name, args);
}

async function http(name: string, args: Record<string, unknown>) {
  const r = await fetch("/api/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: name, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}

/** MUTE ALL: straight out on whatever path is open, and over HTTP as well (muting twice is harmless). */
export function panic() {
  const sock = ws;
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "cmd", id: 0, cmd: "panic", args: {} }));
  void http("panic", {}).catch(() => toast("MUTE ALL could not reach the Sound service", true));
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, bad = false) {
  set({ toast: { text, bad, at: Date.now() } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), bad ? 5000 : 2500);
}
