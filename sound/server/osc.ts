// OSC over UDP from LiveStage (shared/soundProtocol.ts): a tiny encoder/decoder (strings, int32, float32,
// bundles) and the listener that turns messages into Engine commands. Replies go to whoever sent the last
// /sound/ping, at the address and port it came from.

import { createSocket, type Socket } from "node:dgram";
import { SOUND_OSC, SOUND_OSC_REPLY, SOUND_PROTOCOL_VERSION } from "../../shared/soundProtocol.ts";
import type { Engine } from "./engine.ts";

export type OscArg = string | number | boolean;
export interface OscMessage {
  address: string;
  args: OscArg[];
}

const pad4 = (n: number) => (n + 3) & ~3;

function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  const out = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(out);
  return out;
}

/** Strings as s, integers as i (int32), other numbers as f (float32), booleans as T / F. */
export function encodeOsc(address: string, args: OscArg[] = []): Buffer {
  let tags = ",";
  const parts: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      tags += "s";
      parts.push(encodeString(a));
    } else if (typeof a === "boolean") {
      tags += a ? "T" : "F";
    } else if (Number.isInteger(a)) {
      tags += "i";
      const b = Buffer.alloc(4);
      b.writeInt32BE(a);
      parts.push(b);
    } else {
      tags += "f";
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      parts.push(b);
    }
  }
  return Buffer.concat([encodeString(address), encodeString(tags), ...parts]);
}

function readString(buf: Buffer, at: number): [string, number] {
  let end = at;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error("unterminated OSC string");
  return [buf.toString("utf8", at, end), pad4(end + 1)];
}

/** Messages in a packet (a bundle is flattened). Throws on a malformed packet. */
export function decodeOsc(buf: Buffer): OscMessage[] {
  if (buf.length >= 16 && buf.toString("ascii", 0, 8) === "#bundle\0") {
    const out: OscMessage[] = [];
    let at = 16;
    while (at + 4 <= buf.length) {
      const size = buf.readInt32BE(at);
      at += 4;
      if (size <= 0 || at + size > buf.length) throw new Error("bad OSC bundle element");
      out.push(...decodeOsc(buf.subarray(at, at + size)));
      at += size;
    }
    return out;
  }
  const [address, a1] = readString(buf, 0);
  if (!address.startsWith("/")) throw new Error("not an OSC message");
  if (a1 >= buf.length) return [{ address, args: [] }];
  const [tags, a2] = readString(buf, a1);
  if (!tags.startsWith(",")) return [{ address, args: [] }];
  const args: OscArg[] = [];
  let at = a2;
  for (const t of tags.slice(1)) {
    if (t === "s" || t === "S") {
      const [v, next] = readString(buf, at);
      args.push(v);
      at = next;
    } else if (t === "i") {
      args.push(buf.readInt32BE(at));
      at += 4;
    } else if (t === "f") {
      args.push(buf.readFloatBE(at));
      at += 4;
    } else if (t === "h") {
      args.push(Number(buf.readBigInt64BE(at)));
      at += 8;
    } else if (t === "d") {
      args.push(buf.readDoubleBE(at));
      at += 8;
    } else if (t === "T") args.push(true);
    else if (t === "F") args.push(false);
    else if (t === "N" || t === "I") continue;
    else if (t === "b") {
      const size = buf.readInt32BE(at);
      at = pad4(at + 4 + size);
    } else throw new Error(`OSC type ${t} is not supported`);
  }
  return [{ address, args }];
}

const asInt = (v: OscArg | undefined) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? Math.round(v) : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN);

/** Turn one OSC message into an engine command. Returns what to log. */
export function oscToCommand(m: OscMessage): { cmd: string; args: Record<string, unknown> } | { ping: number } | null {
  const a = m.args;
  switch (m.address) {
    case SOUND_OSC.sceneSelect:
      return { cmd: "scene.select", args: { scene: String(a[0] ?? "") } };
    case SOUND_OSC.sceneActivate:
      return { cmd: "scene.activate", args: { scene: String(a[0] ?? "") } };
    case SOUND_OSC.sceneEnd:
      return { cmd: "scene.end", args: {} };
    case SOUND_OSC.cueGo:
      return { cmd: "cue.go", args: { scene: String(a[0] ?? ""), cue: asInt(a[1]) } };
    case SOUND_OSC.cueNext:
      return { cmd: "cue.next", args: {} };
    case SOUND_OSC.mic:
      return { cmd: "mic", args: { who: String(a[0] ?? ""), live: asInt(a[1]) === 1 } };
    case SOUND_OSC.fx:
      return { cmd: "fx", args: { who: String(a[0] ?? ""), preset: String(a[1] ?? "none"), ...(a[2] !== undefined ? { amount: String(a[2]) } : {}) } };
    case SOUND_OSC.restore:
      return { cmd: "restore", args: {} };
    case SOUND_OSC.panic:
      return { cmd: "panic", args: {} };
    case SOUND_OSC.ping:
      return { ping: asInt(a[0]) };
    default:
      return null;
  }
}

export class OscServer {
  private sock: Socket;
  private engine: Engine;
  private log: (m: string) => void;
  /** Whoever pinged last gets the replies. */
  peer: { address: string; port: number } | null = null;
  /** Resolves once the port is bound; rejects if it cannot be. */
  ready: Promise<void>;

  constructor(engine: Engine, port: number, log: (m: string) => void) {
    this.engine = engine;
    this.log = log;
    this.sock = createSocket({ type: "udp4" });
    this.sock.on("message", (buf, rinfo) => this.onPacket(buf, rinfo.address, rinfo.port));
    this.ready = new Promise((ok, fail) => {
      this.sock.once("error", (e) => fail(new Error(`OSC port ${port}: ${e.message}`)));
      this.sock.bind(port, "0.0.0.0", () => {
        this.sock.removeAllListeners("error");
        this.sock.on("error", (e) => log(`OSC: ${e.message}`));
        log(`OSC listening on udp ${port}`);
        ok();
      });
    });
  }

  private onPacket(buf: Buffer, address: string, port: number) {
    let msgs: OscMessage[];
    try {
      msgs = decodeOsc(buf);
    } catch (e) {
      this.log(`OSC from ${address}:${port}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    for (const m of msgs) {
      const c = oscToCommand(m);
      if (!c) {
        if (m.address.startsWith("/sound/")) this.log(`OSC: unknown ${m.address}`);
        continue;
      }
      if ("ping" in c) {
        this.peer = { address, port };
        this.engine.noteLiveStage(`${address}:${port}`, m.address, Number.isFinite(c.ping) ? c.ping : undefined);
        if (Number.isFinite(c.ping) && c.ping !== SOUND_PROTOCOL_VERSION) this.log(`OSC: ${address} speaks sound protocol v${c.ping}, this app v${SOUND_PROTOCOL_VERSION}`);
        this.hello();
        continue;
      }
      this.engine.noteLiveStage(`${address}:${port}`, m.address);
      try {
        const r = this.engine.run(c.cmd, c.args, "osc");
        if (r instanceof Promise) r.catch((e) => this.log(`OSC ${m.address}: ${e instanceof Error ? e.message : e}`));
      } catch (e) {
        this.log(`OSC ${m.address}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  send(address: string, args: OscArg[]) {
    const p = this.peer;
    if (!p) return;
    this.sock.send(encodeOsc(address, args), p.port, p.address, (e) => {
      if (e) this.log(`OSC reply to ${p.address}:${p.port}: ${e.message}`);
    });
  }

  hello() {
    this.send(SOUND_OSC_REPLY.hello, [SOUND_PROTOCOL_VERSION, this.engine.rt.appVersion, this.engine.desk.connected ? 1 : 0]);
  }

  mic(n: number, name: string, live: boolean) {
    this.send(SOUND_OSC_REPLY.mic, [n, name, live ? 1 : 0]);
  }

  cue(sceneId: string, cue: number) {
    this.send(SOUND_OSC_REPLY.cue, [sceneId, cue]);
  }

  close() {
    this.sock.close();
  }
}
