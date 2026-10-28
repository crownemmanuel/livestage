// The TCP link to the Allen & Heath dLive (MIDI over TCP, port 51325). Reconnects on its own with backoff,
// parses what the desk sends with DliveParser, and notices a dead link (no bytes for a while) by asking a
// harmless question every few seconds. Building the bytes is shared/dlive.ts's job; deciding what to send
// is the engine's.

import { Socket } from "node:net";
import { DliveParser, midiN, type DliveEvent } from "../../shared/dlive.ts";
import type { DeskSettings, DeskStatus } from "./model.ts";

export interface DeskHandlers {
  status(status: DeskStatus, error: string | null): void;
  /** The link is up: ask the desk for everything worth knowing. */
  connected(): void;
  event(e: DliveEvent): void;
  /** A read-only question to keep the link honest (e.g. a mic's mute). */
  heartbeat(): number[] | null;
  log(msg: string): void;
}

const HEARTBEAT_MS = 4000;
const SILENT_MS = 13000;
const CONNECT_TIMEOUT_MS = 4000;

export class DeskLink {
  private h: DeskHandlers;
  private cfg: DeskSettings | null = null;
  private sock: Socket | null = null;
  private parser: DliveParser | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastRx = 0;
  private gen = 0;
  /** SOUND_DESK_READONLY=1: only questions go out (for looking at a live desk without touching it). */
  readonly readOnly: boolean;
  status: DeskStatus = "offline";
  n = 11;

  constructor(h: DeskHandlers, readOnly: boolean) {
    this.h = h;
    this.readOnly = readOnly;
  }

  get connected() {
    return this.status === "connected";
  }

  configure(cfg: DeskSettings) {
    const same = this.cfg && this.cfg.host === cfg.host && this.cfg.port === cfg.port && this.cfg.baseChannel === cfg.baseChannel && this.cfg.mode === cfg.mode;
    this.cfg = { ...cfg };
    this.n = midiN(cfg.baseChannel);
    if (same) return;
    this.teardown();
    if (cfg.mode === "dry") {
      this.setStatus("dry", null);
      return;
    }
    this.retry = 0;
    this.open();
  }

  /** Drop the link and dial again now (operator's "Reconnect"). */
  reconnect() {
    if (!this.cfg || this.cfg.mode === "dry") return;
    this.teardown();
    this.retry = 0;
    this.open();
  }

  /** Change something on the desk. False when the link is down (the caller keeps what it wanted for a resync). */
  write(bytes: number[]): boolean {
    if (this.readOnly) {
      this.h.log(`read-only: not sending ${hex(bytes)}`);
      return false;
    }
    return this.raw(bytes);
  }

  /** Ask the desk something (read-only). */
  ask(bytes: number[]): boolean {
    return this.raw(bytes);
  }

  /** Ask many questions without flooding the desk: a few per tick. */
  askMany(list: number[][]) {
    const g = this.gen;
    let i = 0;
    const step = () => {
      if (g !== this.gen || !this.connected) return;
      const chunk = list.slice(i, i + 12);
      i += chunk.length;
      if (chunk.length) this.raw(chunk.flat());
      if (i < list.length) setTimeout(step, 25);
    };
    step();
  }

  close() {
    this.cfg = null;
    this.teardown();
  }

  private raw(bytes: number[]): boolean {
    const s = this.sock;
    if (!s || !this.connected || s.destroyed) return false;
    s.write(Uint8Array.from(bytes));
    return true;
  }

  private setStatus(st: DeskStatus, err: string | null) {
    this.status = st;
    this.h.status(st, err);
  }

  private teardown() {
    this.gen++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.on("error", () => {});
      this.sock.destroy();
    }
    this.sock = null;
    if (this.status !== "dry") this.setStatus("offline", null);
  }

  private open() {
    const cfg = this.cfg;
    if (!cfg || cfg.mode === "dry") return;
    const g = ++this.gen;
    this.setStatus("connecting", null);
    const sock = new Socket();
    this.sock = sock;
    this.parser = new DliveParser(cfg.baseChannel);
    sock.setNoDelay(true);
    sock.setTimeout(CONNECT_TIMEOUT_MS);
    sock.on("timeout", () => {
      if (this.status === "connecting") sock.destroy(new Error(`no answer from ${cfg.host}:${cfg.port}`));
    });
    sock.on("connect", () => {
      if (g !== this.gen) return;
      sock.setTimeout(0);
      sock.setKeepAlive(true, 3000);
      this.retry = 0;
      this.lastRx = Date.now();
      this.setStatus("connected", null);
      this.h.log(`desk connected: ${cfg.host}:${cfg.port} (MIDI base channel ${cfg.baseChannel})`);
      this.h.connected();
      this.beat = setInterval(() => {
        if (g !== this.gen) return;
        if (Date.now() - this.lastRx > SILENT_MS) {
          this.h.log("desk went quiet; reconnecting");
          sock.destroy(new Error("the desk stopped answering"));
          return;
        }
        const q = this.h.heartbeat();
        if (q) this.raw(q);
      }, HEARTBEAT_MS);
    });
    sock.on("data", (buf: Buffer) => {
      if (g !== this.gen || !this.parser) return;
      this.lastRx = Date.now();
      for (const e of this.parser.push(buf)) this.h.event(e);
    });
    sock.on("error", (e) => {
      if (g !== this.gen) return;
      this.h.log(`desk: ${e.message}`);
      this.lastError = e.message;
    });
    sock.on("close", () => {
      if (g !== this.gen) return;
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      this.sock = null;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this.setStatus("offline", this.lastError ?? "connection closed");
      this.lastError = null;
      this.retryTimer = setTimeout(() => {
        if (g === this.gen) this.open();
      }, delay);
    });
    sock.connect(cfg.port, cfg.host);
  }

  private lastError: string | null = null;
}

export const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
