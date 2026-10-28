#!/usr/bin/env node
// A pretend Allen & Heath dLive for testing the Sound app (and LiveStage) without the show desk.
// Speaks MIDI over TCP like the real MixRack: keeps mutes, faders, names, colours and send levels,
// answers the "get" questions the way the desk does, logs every message, and relays every change to the
// other connected clients (so a second client can play "someone on the surface").
//
//   node scripts/fake-dlive.ts [--port 51325] [--host 127.0.0.1] [--midi 12] [--quiet]
//
// Seeded like the show desk: inputs 77–88 named Drama1…Dram12 (muted), mono FX send 2 "HALL" and 3 "DELAY",
// FX return 3 "DELAY" parked at −inf, DCA 10 "FX" muted.

import { createServer, type Socket } from "node:net";
import { dliveChannelAt, dliveChannelLabel, dliveAddress, DLIVE_COLOURS, levelToDb, midiN, type DliveChannel } from "../shared/dlive.ts";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = Number(arg("port", "51325"));
const HOST = arg("host", "127.0.0.1");
const BASE = Number(arg("midi", "12"));
const QUIET = process.argv.includes("--quiet");
const N = midiN(BASE);
const HEADER = [0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00];

interface Strip {
  muted: boolean;
  fader: number;
  name: string;
  colour: number;
}
const strips = new Map<string, Strip>();
const sends = new Map<string, number>();
const key = (off: number, ch: number) => `${off}:${ch}`;
function strip(off: number, ch: number): Strip {
  let s = strips.get(key(off, ch));
  if (!s) strips.set(key(off, ch), (s = { muted: false, fader: 0x6b, name: "", colour: 0 }));
  return s;
}
function seed(c: DliveChannel, v: Partial<Strip>) {
  const a = dliveAddress(c);
  Object.assign(strip(a.offset, a.ch), v);
}
for (let i = 0; i < 12; i++) seed({ kind: "input", number: 77 + i }, { name: i < 9 ? `Drama${i + 1}` : `Dram${i + 1}`, muted: true, colour: 3 });
seed({ kind: "monoFxSend", number: 2 }, { name: "HALL" });
seed({ kind: "monoFxSend", number: 3 }, { name: "DELAY" });
seed({ kind: "fxReturn", number: 2 }, { name: "HALL", fader: 0x6b });
seed({ kind: "fxReturn", number: 3 }, { name: "DELAY", fader: 0 });
seed({ kind: "dca", number: 10 }, { name: "FX", muted: true });
seed({ kind: "input", number: 1 }, { name: "Pastor" });

const clients = new Set<Socket>();
let nextId = 1;
const ids = new WeakMap<Socket, number>();
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
const log = (who: Socket | null, msg: string, bytes?: number[]) => {
  if (QUIET && !msg.startsWith("!")) return;
  console.log(`[fake-dlive ${new Date().toLocaleTimeString()}] ${who ? `#${ids.get(who)} ` : ""}${msg}${bytes ? `   (${hex(bytes)})` : ""}`);
};
const label = (off: number, ch: number) => {
  const c = dliveChannelAt(off, ch);
  const s = strips.get(key(off, ch));
  return c ? `${dliveChannelLabel(c)}${s?.name ? ` "${s.name}"` : ""}` : `off${off} ch${ch}`;
};
const offOf = (statusLow: number) => {
  const off = (statusLow - N + 16) % 16;
  return off <= 4 ? off : -1;
};
const db = (lv: number) => (lv === 0 ? "-inf" : `${levelToDb(lv).toFixed(1)} dB`);

const send = (to: Socket, bytes: number[]) => {
  if (!to.destroyed) to.write(Uint8Array.from(bytes));
};
const relay = (from: Socket, bytes: number[]) => {
  for (const c of clients) if (c !== from) send(c, bytes);
};

const muteMsg = (off: number, ch: number, muted: boolean) => {
  const st = 0x90 | ((N + off) & 0x0f);
  return [st, ch, muted ? 0x7f : 0x3f, st, ch, 0x00];
};
const faderMsg = (off: number, ch: number, lv: number) => {
  const st = 0xb0 | ((N + off) & 0x0f);
  return [st, 0x63, ch, st, 0x62, 0x17, st, 0x06, lv];
};
const sx = (...body: number[]) => [0xf0, ...HEADER, ...body, 0xf7];

/** One connected client: a tiny MIDI parser with running status and SysEx. */
function attach(sock: Socket) {
  ids.set(sock, nextId++);
  clients.add(sock);
  log(sock, `connected from ${sock.remoteAddress}:${sock.remotePort} (${clients.size} client${clients.size > 1 ? "s" : ""})`);
  let run = 0;
  let data: number[] = [];
  let sys: number[] | null = null;
  const nrpn = new Map<number, { ch: number; param: number }>();
  let bank = 0;

  const onChannel = (st: number, d: number[]) => {
    const kind = st & 0xf0;
    const off = offOf(st & 0x0f);
    if (off < 0) return log(sock, `ignored message on MIDI channel ${(st & 0x0f) + 1}`, [st, ...d]);
    if (kind === 0x90) {
      if (d[1] === 0) return;
      const muted = d[1] >= 0x40;
      strip(off, d[0]).muted = muted;
      log(sock, `MUTE ${label(off, d[0])} ${muted ? "ON (muted)" : "OFF (live)"}`, [st, ...d]);
      relay(sock, muteMsg(off, d[0], muted));
    } else if (kind === 0xb0) {
      const cur = nrpn.get(off) ?? { ch: -1, param: -1 };
      if (d[0] === 0x63) cur.ch = d[1];
      else if (d[0] === 0x62) cur.param = d[1];
      else if (d[0] === 0x06 && cur.param === 0x17) {
        strip(off, cur.ch).fader = d[1];
        log(sock, `FADER ${label(off, cur.ch)} → ${db(d[1])}`);
        relay(sock, faderMsg(off, cur.ch, d[1]));
      } else if (d[0] === 0x00 && off === 0) bank = d[1];
      nrpn.set(off, cur);
    } else if (kind === 0xc0 && off === 0) {
      const scene = bank * 128 + d[0] + 1;
      log(sock, `SCENE RECALL ${scene}`);
      relay(sock, [0xb0 | N, 0x00, bank, 0xc0 | N, d[0]]);
    }
  };

  const onSysex = (m: number[]) => {
    const bytes = [0xf0, ...m, 0xf7];
    if (m.length < 9 || HEADER.some((h, i) => m[i] !== h)) return log(sock, "unknown SysEx", bytes);
    const off = offOf(m[7] & 0x0f);
    if (off < 0) return log(sock, "SysEx on a MIDI channel outside N…N+4", bytes);
    const nn = m[7];
    const cmd = m[8];
    if (cmd === 0x01) {
      const s = strip(off, m[9]);
      log(sock, `get name ${label(off, m[9])}`);
      send(sock, sx(nn, 0x02, m[9], ...Array.from(s.name, (c) => c.charCodeAt(0))));
    } else if (cmd === 0x03) {
      const name = String.fromCharCode(...m.slice(10)).slice(0, 8);
      strip(off, m[9]).name = name;
      log(sock, `NAME ${label(off, m[9])}`, bytes);
      relay(sock, sx(nn, 0x02, m[9], ...Array.from(name, (c) => c.charCodeAt(0))));
    } else if (cmd === 0x04) {
      log(sock, `get colour ${label(off, m[9])}`);
      send(sock, sx(nn, 0x05, m[9], strip(off, m[9]).colour));
    } else if (cmd === 0x06) {
      strip(off, m[9]).colour = m[10] & 0x07;
      log(sock, `COLOUR ${label(off, m[9])} → ${DLIVE_COLOURS[m[10] & 7]}`, bytes);
      relay(sock, sx(nn, 0x05, m[9], m[10] & 0x07));
    } else if (cmd === 0x05 && m[9] === 0x09) {
      log(sock, `get mute ${label(off, m[10])}`);
      send(sock, muteMsg(off, m[10], strip(off, m[10]).muted));
    } else if (cmd === 0x05 && m[9] === 0x0b && m[10] === 0x17) {
      log(sock, `get fader ${label(off, m[11])}`);
      send(sock, faderMsg(off, m[11], strip(off, m[11]).fader));
    } else if (cmd === 0x05 && m[9] === 0x0f && m[10] === 0x0d) {
      const toOff = offOf(m[12] & 0x0f);
      const k = `${key(off, m[11])}>${key(toOff, m[13])}`;
      const lv = sends.get(k) ?? 0;
      log(sock, `get send ${label(off, m[11])} → ${label(toOff, m[13])}`);
      send(sock, sx(nn, 0x0d, m[11], m[12], m[13], lv));
    } else if (cmd === 0x0d) {
      const toOff = offOf(m[10] & 0x0f);
      sends.set(`${key(off, m[9])}>${key(toOff, m[11])}`, m[12]);
      log(sock, `SEND ${label(off, m[9])} → ${label(toOff, m[11])} = ${db(m[12])}`, bytes);
      relay(sock, bytes);
    } else log(sock, "unhandled SysEx", bytes);
  };

  sock.on("data", (buf: Buffer) => {
    for (const byte of buf) {
      if (sys) {
        if (byte === 0xf7) {
          onSysex(sys);
          sys = null;
        } else if (byte & 0x80) sys = null;
        else sys.push(byte);
        continue;
      }
      if (byte === 0xf0) {
        sys = [];
        continue;
      }
      if (byte & 0x80) {
        if (byte >= 0xf8) continue;
        run = byte < 0xf0 ? byte : 0;
        data = [];
        continue;
      }
      if (!run) continue;
      data.push(byte);
      const need = (run & 0xf0) === 0xc0 || (run & 0xf0) === 0xd0 ? 1 : 2;
      if (data.length < need) continue;
      onChannel(run, data);
      data = [];
    }
  });
  sock.on("close", () => {
    clients.delete(sock);
    log(sock, `disconnected (${clients.size} left)`);
  });
  sock.on("error", () => {});
}

const server = createServer(attach);
server.on("error", (e) => {
  console.error(`[fake-dlive] ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`[fake-dlive] pretend dLive on ${HOST}:${PORT}, base MIDI channel ${BASE} (inputs 77–88 = Drama1…Dram12)`));

/** State dump on SIGUSR2 (kill -USR2 <pid>) for tests. */
process.on("SIGUSR2", () => {
  const out: Record<string, unknown> = {};
  for (const [k, s] of strips) {
    const [off, ch] = k.split(":").map(Number);
    out[label(off, ch)] = { muted: s.muted, fader: db(s.fader) };
  }
  console.log(JSON.stringify({ strips: out, sends: Object.fromEntries(sends) }));
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
