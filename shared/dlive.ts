// Allen & Heath dLive control over MIDI-over-TCP (firmware V1.9+), shared by LiveStage and the Sound app.
// Pure: builds the bytes to send and parses what the desk sends back. Opening the socket is the caller's
// job (TCP to the MixRack or Surface, port 51325, no login; 51327 is TLS and needs a user profile).
//
// The desk spreads channel types over five MIDI channels from a base channel N (Utility / Control / MIDI):
// inputs on N, groups on N+1, auxes on N+2, matrixes on N+3, FX, mains, DCAs and mute groups on N+4.
// Values below follow "dLive MIDI Over TCP/IP Protocol V1.9". Tested against the show desk on 2026-10-25
// (base channel 12, i.e. N = 11).
//
// No imports and only erasable TypeScript: Node loads this file directly (type stripping).

export const DLIVE_PORT = 51325;

/** Base MIDI channel as the desk shows it (1–12) → N used in status bytes (0–11). */
export const midiN = (channel: number) => Math.max(0, Math.min(11, Math.round(channel) - 1));

export type DliveKind =
  | "input" // 1–128
  | "monoGroup" | "stereoGroup" // 1–62 / 1–31
  | "monoAux" | "stereoAux"
  | "monoMatrix" | "stereoMatrix"
  | "monoFxSend" | "stereoFxSend" // 1–16
  | "fxReturn" // 1–16
  | "main" // 1–6
  | "dca" // 1–24
  | "muteGroup"; // 1–8

interface KindInfo { offset: number; base: number; count: number }

const KINDS: Record<DliveKind, KindInfo> = {
  input: { offset: 0, base: 0x00, count: 128 },
  monoGroup: { offset: 1, base: 0x00, count: 62 },
  stereoGroup: { offset: 1, base: 0x40, count: 31 },
  monoAux: { offset: 2, base: 0x00, count: 62 },
  stereoAux: { offset: 2, base: 0x40, count: 31 },
  monoMatrix: { offset: 3, base: 0x00, count: 62 },
  stereoMatrix: { offset: 3, base: 0x40, count: 31 },
  monoFxSend: { offset: 4, base: 0x00, count: 16 },
  stereoFxSend: { offset: 4, base: 0x10, count: 16 },
  fxReturn: { offset: 4, base: 0x20, count: 16 },
  main: { offset: 4, base: 0x30, count: 6 },
  dca: { offset: 4, base: 0x36, count: 24 },
  muteGroup: { offset: 4, base: 0x4e, count: 8 },
};

export const DLIVE_KINDS = Object.keys(KINDS) as DliveKind[];
export const dliveKindCount = (kind: DliveKind) => KINDS[kind].count;

/** A channel on the desk, e.g. { kind: "input", number: 77 } (numbers are 1-based, as on the surface). */
export interface DliveChannel { kind: DliveKind; number: number }

/** MIDI channel offset from N and note number (CH) for a desk channel. */
export function dliveAddress(c: DliveChannel): { offset: number; ch: number } {
  const k = KINDS[c.kind];
  if (!k) throw new Error(`Unknown dLive channel type: ${c.kind}`);
  if (!Number.isInteger(c.number) || c.number < 1 || c.number > k.count) throw new Error(`${c.kind} ${c.number} is out of range (1–${k.count})`);
  return { offset: k.offset, ch: k.base + c.number - 1 };
}

/** The desk channel at a MIDI channel offset and note number, or null. */
export function dliveChannelAt(offset: number, ch: number): DliveChannel | null {
  for (const kind of DLIVE_KINDS) {
    const k = KINDS[kind];
    if (k.offset === offset && ch >= k.base && ch < k.base + k.count) return { kind, number: ch - k.base + 1 };
  }
  return null;
}

// ---------------------------------------------------------------- levels

/** Fader and send level byte (00 = −inf, 6B = 0 dB, 7F = +10 dB). Anything at or below −54 dB is off. */
export function dbToLevel(db: number): number {
  if (!Number.isFinite(db) || db <= -54) return 0;
  return Math.max(0, Math.min(0x7f, Math.round(((db + 54) / 64) * 0x7f)));
}

export function levelToDb(lv: number): number {
  return lv <= 0 ? -Infinity : (lv / 0x7f) * 64 - 54;
}

// ---------------------------------------------------------------- messages to the desk

const SYSEX = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00];
const status = (hi: number, n: number, offset: number) => hi | ((n + offset) & 0x0f);

/** Mute on/off: Note On with velocity 7F (on) or 3F (off), then the note off (velocity 0). */
export function dliveMute(n: number, c: DliveChannel, muted: boolean): number[] {
  const a = dliveAddress(c);
  const s = status(0x90, n, a.offset);
  return [s, a.ch, muted ? 0x7f : 0x3f, s, a.ch, 0x00];
}

/** Fader level (NRPN 17). */
export function dliveFader(n: number, c: DliveChannel, level: number): number[] {
  const a = dliveAddress(c);
  const s = status(0xb0, n, a.offset);
  return [s, 0x63, a.ch, s, 0x62, 0x17, s, 0x06, clamp7(level)];
}

/** Send level from a channel into an aux, FX send or matrix (SysEx 0D). */
export function dliveSendLevel(n: number, from: DliveChannel, to: DliveChannel, level: number): number[] {
  const a = dliveAddress(from), b = dliveAddress(to);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x0d, a.ch, (n + b.offset) & 0x0f, b.ch, clamp7(level), 0xf7];
}

/** Recall a desk scene, 1–500 (bank select + program change on N). */
export function dliveSceneRecall(n: number, scene: number): number[] {
  if (!Number.isInteger(scene) || scene < 1 || scene > 500) throw new Error(`Scene ${scene} is out of range (1–500)`);
  const i = scene - 1;
  return [0xb0 | n, 0x00, Math.floor(i / 128), 0xc0 | n, i % 128];
}

/** Rename a channel (the desk shows up to 8 characters). */
export function dliveSetName(n: number, c: DliveChannel, name: string): number[] {
  const a = dliveAddress(c);
  const ascii = Array.from(name.slice(0, 8), (ch) => { const code = ch.charCodeAt(0); return code >= 0x20 && code < 0x7f ? code : 0x3f; });
  return [...SYSEX, (n + a.offset) & 0x0f, 0x03, a.ch, ...ascii, 0xf7];
}

/** Desk strip colours, in the desk's order. */
export const DLIVE_COLOURS = ["off", "red", "green", "yellow", "blue", "purple", "lightBlue", "white"] as const;
export type DliveColour = (typeof DLIVE_COLOURS)[number];

export function dliveSetColour(n: number, c: DliveChannel, colour: DliveColour): number[] {
  const a = dliveAddress(c);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x06, a.ch, Math.max(0, DLIVE_COLOURS.indexOf(colour)), 0xf7];
}

// Read-only questions. The desk answers with the same message it would send for a change.
export function dliveGetMute(n: number, c: DliveChannel): number[] {
  const a = dliveAddress(c);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x05, 0x09, a.ch, 0xf7];
}
export function dliveGetFader(n: number, c: DliveChannel): number[] {
  const a = dliveAddress(c);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x05, 0x0b, 0x17, a.ch, 0xf7];
}
export function dliveGetName(n: number, c: DliveChannel): number[] {
  const a = dliveAddress(c);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x01, a.ch, 0xf7];
}
export function dliveGetColour(n: number, c: DliveChannel): number[] {
  const a = dliveAddress(c);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x04, a.ch, 0xf7];
}
export function dliveGetSendLevel(n: number, from: DliveChannel, to: DliveChannel): number[] {
  const a = dliveAddress(from), b = dliveAddress(to);
  return [...SYSEX, (n + a.offset) & 0x0f, 0x05, 0x0f, 0x0d, a.ch, (n + b.offset) & 0x0f, b.ch, 0xf7];
}

const clamp7 = (v: number) => Math.max(0, Math.min(0x7f, Math.round(v)));

// ---------------------------------------------------------------- messages from the desk

export type DliveEvent =
  | { type: "mute"; channel: DliveChannel; muted: boolean }
  | { type: "fader"; channel: DliveChannel; level: number }
  | { type: "name"; channel: DliveChannel; name: string }
  | { type: "colour"; channel: DliveChannel; colour: DliveColour }
  | { type: "send"; from: DliveChannel; to: DliveChannel; level: number }
  | { type: "scene"; scene: number };

/**
 * Parses the desk's byte stream (it uses MIDI running status and may split messages across TCP reads).
 * Feed every chunk to `push`; it returns the complete events found so far. Messages on MIDI channels
 * outside N…N+4, our own questions echoed back, and anything not listed in DliveEvent are skipped.
 */
export class DliveParser {
  private n: number;
  private run = 0;
  private data: number[] = [];
  private sysex: number[] | null = null;
  private nrpn = new Map<number, { ch: number; param: number }>();
  private bank = new Map<number, number>();

  constructor(baseChannel: number) { this.n = midiN(baseChannel); }

  push(bytes: ArrayLike<number>): DliveEvent[] {
    const out: DliveEvent[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xff;
      if (this.sysex) {
        if (b === 0xf7) { this.onSysex(this.sysex, out); this.sysex = null; }
        else if (b & 0x80) this.sysex = null;
        else this.sysex.push(b);
        continue;
      }
      if (b === 0xf0) { this.sysex = []; continue; }
      if (b & 0x80) {
        if (b >= 0xf8) continue; // realtime bytes never cancel running status
        this.run = b < 0xf0 ? b : 0;
        this.data = [];
        continue;
      }
      if (!this.run) continue;
      this.data.push(b);
      const kind = this.run & 0xf0;
      const need = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      if (this.data.length < need) continue;
      this.onChannel(this.run, this.data, out);
      this.data = [];
    }
    return out;
  }

  private offset(statusByte: number): number {
    const off = ((statusByte & 0x0f) - this.n + 16) % 16;
    return off <= 4 ? off : -1;
  }

  private onChannel(st: number, d: number[], out: DliveEvent[]) {
    const kind = st & 0xf0, off = this.offset(st);
    if (off < 0) return;
    if (kind === 0x90) {
      if (d[1] === 0) return; // the note-off half of a mute message
      const channel = dliveChannelAt(off, d[0]);
      if (channel) out.push({ type: "mute", channel, muted: d[1] >= 0x40 });
    } else if (kind === 0xb0) {
      const cur = this.nrpn.get(off) ?? { ch: -1, param: -1 };
      if (d[0] === 0x63) cur.ch = d[1];
      else if (d[0] === 0x62) cur.param = d[1];
      else if (d[0] === 0x06 && cur.param === 0x17) {
        const channel = dliveChannelAt(off, cur.ch);
        if (channel) out.push({ type: "fader", channel, level: d[1] });
      } else if (d[0] === 0x00 && off === 0) this.bank.set(off, d[1]);
      this.nrpn.set(off, cur);
    } else if (kind === 0xc0 && off === 0) {
      out.push({ type: "scene", scene: (this.bank.get(0) ?? 0) * 128 + d[0] + 1 });
    }
  }

  private onSysex(m: number[], out: DliveEvent[]) {
    // m excludes F0 / F7: 00 00 1A 50 10 01 00 0N <cmd> …
    if (m.length < 9 || m[0] !== 0x00 || m[1] !== 0x00 || m[2] !== 0x1a || m[3] !== 0x50 || m[4] !== 0x10) return;
    const off = ((m[7] & 0x0f) - this.n + 16) % 16;
    if (off > 4) return;
    const cmd = m[8];
    if (cmd === 0x02 && m.length >= 10) {
      const channel = dliveChannelAt(off, m[9]);
      const name = String.fromCharCode(...m.slice(10).filter((c) => c >= 0x20 && c < 0x7f)).trimEnd();
      if (channel) out.push({ type: "name", channel, name });
    } else if (cmd === 0x05 && m.length === 11 && m[9] !== 0x09 && m[10] <= 7) {
      // Colour reply (0N 05 CH Col). The desk also relays other clients' "get mute" questions
      // (0N 05 09 CH), which look the same, so a colour for CH 09 is skipped.
      const channel = dliveChannelAt(off, m[9]);
      if (channel) out.push({ type: "colour", channel, colour: DLIVE_COLOURS[m[10]] });
    } else if (cmd === 0x0d && m.length >= 13) {
      const from = dliveChannelAt(off, m[9]);
      const toOff = ((m[10] & 0x0f) - this.n + 16) % 16;
      const to = toOff <= 4 ? dliveChannelAt(toOff, m[11]) : null;
      if (from && to) out.push({ type: "send", from, to, level: m[12] });
    }
  }
}

export const dliveChannelLabel = (c: DliveChannel) => {
  const names: Record<DliveKind, string> = {
    input: "In", monoGroup: "Grp", stereoGroup: "St Grp", monoAux: "Aux", stereoAux: "St Aux", monoMatrix: "Mtx", stereoMatrix: "St Mtx",
    monoFxSend: "FX send", stereoFxSend: "St FX send", fxReturn: "FX ret", main: "Main", dca: "DCA", muteGroup: "Mute grp",
  };
  return `${names[c.kind]} ${c.number}`;
};
