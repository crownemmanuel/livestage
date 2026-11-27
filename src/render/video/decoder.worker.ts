/// <reference lib="webworker" />
// The window's video decoder (docs/ARCHITECTURE.md, "Wall video"): one worker per window, any number of clips.
// The page owns the clock. For each clip it sends the wanted media time (`want`: t at wall time `at`, moving at
// `rate`), and this worker decodes the GOPs around it and sends each frame shortly before it is due. It runs on
// from the last `want` by itself, so a held page does not stop the decoding; frames whose time has passed are
// closed here, so the page only ever holds two or three.
//
// Decoding goes a whole GOP at a time: its chunks, then flush(). WebKit's decoder holds 11 frames before the
// first comes out (Chromium 2), so flushing each GOP is what makes the timing the same in both engines, and a
// seek is the same operation as playing on (~20 ms for a 12-frame 3072 x 768 GOP). It needs closed GOPs, which
// `unplayable` checks when the file is opened.

import { audioAsAdts, gopsOf, openMp4, unplayable, type Gop, type Mp4, type Track } from "./mp4";
import type { CodecStats, FromWorker, LoopSpan, ToWorker } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** A GOP is fed once its first frame is this close (s) to the wanted time. */
const AHEAD = 0.25;
/** A frame is sent to the page this long (s) before it is due. */
const LEAD = 0.09;
/** GOPs whose bytes are read ahead. In WebKit a worker's fetch goes through the page's main thread, so a held page delays reads (250 ms seen): read a second ahead. */
const READ_AHEAD = 2;
const EPS = 1e-4;

const absNow = () => performance.timeOrigin + performance.now();

interface Inflight {
  g: number;
  pass: number;
  /** Unwrapped presentation span of its frames. */
  from: number;
  to: number;
  valid: boolean;
  t0: number;
}

interface Clip {
  id: number;
  url: string;
  mp4: Mp4 | null;
  v: Track | null;
  gops: (Gop & { maxPts: number })[];
  /** Presentation times, sorted. */
  pts: number[];
  config: VideoDecoderConfig | null;
  dec: VideoDecoder | null;
  queue: { ts: number; f: VideoFrame }[];
  inflight: Inflight[];
  chain: Promise<void>;
  nextG: number;
  nextPass: number;
  bytes: Map<number, Uint8Array>;
  reading: Map<number, Promise<Uint8Array>>;
  want: { t: number; at: number; rate: number; loop: LoopSpan | null };
  /** Times of the first and last frames sent to the page since decoding last started again (the page has them, or has shown them). */
  sentLo: number;
  lastSent: number;
  /** It has played since it was warmed (a restart from now on is a visible jump). */
  started: boolean;
  failed: boolean;
  st: CodecStats & { gopSum: number };
}

const clips = new Map<number, Clip>();
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

function freshStats(): Clip["st"] {
  return { gops: 0, gopMsAvg: 0, gopMsMax: 0, gopSum: 0, restarts: 0, playingRestarts: 0, stale: 0, held: 0, readMsMax: 0 };
}

async function open(c: Clip) {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") throw new Error("no WebCodecs in this engine");
  const mp4 = await openMp4(c.url);
  const v = mp4.video;
  const why = unplayable(v);
  if (why || !v) {
    post({ op: "refused", id: c.id, reason: why ?? "no video" });
    c.failed = true;
    return;
  }
  const config: VideoDecoderConfig = { codec: v.codec!, codedWidth: v.width, codedHeight: v.height, description: v.description, hardwareAcceleration: "no-preference" };
  const sup = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!sup.supported) {
    post({ op: "refused", id: c.id, reason: `decoder refuses ${v.codec} ${v.width}x${v.height}` });
    c.failed = true;
    return;
  }
  c.mp4 = mp4;
  c.v = v;
  c.config = config;
  c.gops = gopsOf(v).map((g) => {
    let maxPts = -Infinity;
    for (let i = g.first; i < g.end; i++) maxPts = Math.max(maxPts, v.samples[i].pts);
    return { ...g, maxPts };
  });
  c.pts = v.samples.map((s) => s.pts).sort((a, b) => a - b);
  const a = mp4.audio;
  const fps = v.samples.length / Math.max(0.001, v.duration);
  post({
    op: "info",
    id: c.id,
    width: v.width ?? 0,
    height: v.height ?? 0,
    duration: v.duration,
    fps: Math.round(fps * 1000) / 1000,
    frames: v.samples.length,
    codec: v.codec!,
    gop: Math.max(...c.gops.map((g) => g.stop - g.start)),
    sound: !a ? "none" : a.codec?.startsWith("mp4a.40.") ? "aac" : "other",
  });
}

// ---------------------------------------------------------------- time

const dur = (c: Clip) => c.v!.duration;
const span = (c: Clip): LoopSpan | null => {
  const l = c.want.loop;
  if (!l) return null;
  const from = Math.max(0, Math.min(l.from, dur(c)));
  const to = Math.max(from + 0.05, Math.min(l.to, dur(c)));
  return { from, to };
};

/** The wanted time now (unwrapped), held inside the file. */
function wantNow(c: Clip): number {
  const w = c.want;
  const t = w.t + ((absNow() - w.at) / 1000) * w.rate;
  return span(c) ? Math.max(0, t) : Math.max(0, Math.min(t, dur(c) - 0.5 / 24));
}

/** Pass number and time within the file of an unwrapped time. */
function local(c: Clip, U: number): { pass: number; t: number; len: number } {
  const L = span(c);
  if (!L) return { pass: 0, t: U, len: 0 };
  const len = L.to - L.from;
  const pass = U < L.to ? 0 : Math.floor((U - L.from) / len);
  return { pass, t: U - pass * len, len };
}

/** Time (unwrapped) of the frame on screen at U: the last one shown at or before it. */
function frameAt(c: Clip, U: number): number {
  const { pass, t, len } = local(c, U);
  const p = c.pts;
  let lo = 0;
  let hi = p.length - 1;
  let k = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (p[m] <= t + EPS) {
      k = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return pass * len + p[k];
}

function gopIndexAt(c: Clip, t: number): number {
  let k = 0;
  for (let i = 0; i < c.gops.length; i++) if (c.gops[i].start <= t + EPS) k = i;
  return k;
}

/** The GOP after (g, pass) in playing order: wraps at the loop's end, or null at the end of a one-shot. */
function nextGop(c: Clip, g: number, pass: number): { g: number; pass: number } | null {
  const L = span(c);
  if (L) {
    const last = gopIndexAt(c, L.to - EPS);
    if (g >= last) return { g: gopIndexAt(c, L.from), pass: pass + 1 };
    return { g: g + 1, pass };
  }
  return g + 1 < c.gops.length ? { g: g + 1, pass } : null;
}

// ---------------------------------------------------------------- decoding

function makeDecoder(c: Clip) {
  const dec = new VideoDecoder({
    output: (f) => onFrame(c, dec, f),
    error: (e) => {
      if (c.dec !== dec) return;
      c.dec = null;
      c.failed = true;
      dropQueue(c);
      c.inflight = [];
      post({ op: "error", id: c.id, error: String(e?.message ?? e) });
    },
  });
  dec.configure(c.config!);
  return dec;
}

function dropQueue(c: Clip) {
  for (const q of c.queue) q.f.close();
  c.queue = [];
}

/** Start again from the GOP that holds U: whatever was decoded or on its way is dropped. */
function restart(c: Clip, U: number) {
  dropQueue(c);
  c.sentLo = Infinity;
  c.lastSent = -Infinity;
  for (const r of c.inflight) r.valid = false;
  const { pass, t } = local(c, U);
  c.nextPass = pass;
  c.nextG = gopIndexAt(c, t);
  c.st.restarts++;
  if (c.started && c.want.rate > 0) c.st.playingRestarts++;
}

/**
 * The loop span changed (a parked clip starting to loop, an edit). On the first pass nothing decoded so far
 * changes (pass 0 frames have the same times either way), so a clip that comes up keeps the GOP it decoded
 * ahead; only frames past the new loop's end go, and the next GOP wraps if it is past it. Anything else: restart.
 */
function loopChange(c: Clip) {
  const U = wantNow(c);
  const L = span(c);
  if (local(c, U).pass > 0 || c.nextPass > 0) {
    restart(c, U);
    return;
  }
  if (!L) return;
  const keep: Clip["queue"] = [];
  for (const q of c.queue) {
    if (q.ts < L.to - EPS && q.ts >= L.from - EPS) keep.push(q);
    else q.f.close();
  }
  c.queue = keep;
  const last = gopIndexAt(c, L.to - EPS);
  if (c.nextG > last) {
    c.nextG = gopIndexAt(c, L.from);
    c.nextPass = 1;
  }
}

function readGop(c: Clip, g: number): Promise<Uint8Array> {
  const have = c.bytes.get(g);
  if (have) return Promise.resolve(have);
  const pending = c.reading.get(g);
  if (pending) return pending;
  const G = c.gops[g];
  const t0 = performance.now();
  const p = c.mp4!.read(G.bytes0, G.bytes1).then(
    (b) => {
      c.st.readMsMax = Math.max(c.st.readMsMax, performance.now() - t0);
      c.reading.delete(g);
      if (clips.get(c.id) === c && c.dec) c.bytes.set(g, b);
      return b;
    },
    (e) => {
      c.reading.delete(g);
      throw e;
    },
  );
  c.reading.set(g, p);
  return p;
}

function feedGop(c: Clip, g: number, pass: number) {
  const G = c.gops[g];
  const L = span(c);
  const len = L ? L.to - L.from : 0;
  const rec: Inflight = { g, pass, from: pass * len + G.start, to: pass * len + G.maxPts, valid: true, t0: performance.now() };
  c.inflight.push(rec);
  const bytes = readGop(c, g);
  // Bytes of the GOPs coming next, and none of the ones behind.
  let n: { g: number; pass: number } | null = { g, pass };
  const keep = new Set([g]);
  for (let a = 0; a < READ_AHEAD && n; a++) {
    n = nextGop(c, n.g, n.pass);
    if (n) {
      keep.add(n.g);
      void readGop(c, n.g).catch(() => {});
    }
  }
  for (const k of c.bytes.keys()) if (!keep.has(k)) c.bytes.delete(k);
  // Submitted in order (the output of a GOP belongs to the oldest one in flight).
  c.chain = c.chain.then(async () => {
    let buf: Uint8Array;
    try {
      buf = await bytes;
    } catch (e) {
      c.inflight = c.inflight.filter((r) => r !== rec);
      if (!c.failed) post({ op: "error", id: c.id, error: `read: ${String(e)}` });
      c.failed = true;
      return;
    }
    const dec = c.dec;
    if (!rec.valid || !dec || dec.state !== "configured") {
      c.inflight = c.inflight.filter((r) => r !== rec);
      return;
    }
    const s = c.v!.samples;
    const off = pass * len;
    for (let i = G.first; i < G.end; i++) {
      const x = s[i];
      dec.decode(new EncodedVideoChunk({ type: x.key ? "key" : "delta", timestamp: Math.round((off + x.pts) * 1e6), duration: Math.round(x.dur * 1e6), data: buf.subarray(x.offset - G.bytes0, x.offset - G.bytes0 + x.size) }));
    }
    c.st.gops++;
    dec.flush().then(
      () => {
        const ms = performance.now() - rec.t0;
        c.st.gopSum += ms;
        c.st.gopMsMax = Math.max(c.st.gopMsMax, ms);
        c.inflight = c.inflight.filter((r) => r !== rec);
        pump(c);
      },
      () => {
        c.inflight = c.inflight.filter((r) => r !== rec);
      },
    );
  });
}

function onFrame(c: Clip, dec: VideoDecoder, f: VideoFrame) {
  const rec = c.inflight[0];
  const ts = f.timestamp / 1e6;
  const L = span(c);
  let keep = c.dec === dec && !!rec && rec.valid && clips.get(c.id) === c;
  if (keep && L) {
    // A loop's first and last GOPs hold frames outside it: never shown.
    const { t } = local(c, ts);
    if (t < L.from - EPS || t >= L.to - EPS) keep = false;
  }
  if (!keep) {
    f.close();
    return;
  }
  let i = c.queue.length;
  while (i > 0 && c.queue[i - 1].ts > ts) i--;
  c.queue.splice(i, 0, { ts, f });
  c.st.held = Math.max(c.st.held, c.queue.length);
  pump(c);
}

function pump(c: Clip) {
  if (!c.dec || !c.v || c.failed) return;
  const U = wantNow(c);
  const target = frameAt(c, U);
  // Frames whose time has passed: closed unseen.
  while (c.queue.length && c.queue[0].ts < target - EPS) {
    c.queue.shift()!.f.close();
    c.st.stale++;
  }
  const covered =
    (target >= c.sentLo - EPS && target <= c.lastSent + EPS) ||
    c.queue.some((q) => Math.abs(q.ts - target) < EPS) ||
    c.inflight.some((r) => r.valid && target >= r.from - EPS && target <= r.to + EPS);
  let fresh = false;
  if (!covered) {
    restart(c, U);
    fresh = true;
  }
  // Send what is due within LEAD.
  while (c.queue.length && c.queue[0].ts <= U + LEAD) {
    const q = c.queue.shift()!;
    post({ op: "frame", id: c.id, ts: q.ts, frame: q.f }, [q.f]);
    if (!Number.isFinite(c.sentLo)) c.sentLo = q.ts;
    c.lastSent = q.ts;
  }
  // Feed the GOPs whose first frame is near (at most two ahead in flight; a restart goes at once).
  const L = span(c);
  const len = L ? L.to - L.from : 0;
  for (let guard = 0; guard < 4; guard++) {
    if (c.nextG >= c.gops.length) break;
    const startU = c.nextPass * len + c.gops[c.nextG].start;
    if (startU > U + AHEAD) break;
    if (!fresh && c.inflight.filter((r) => r.valid).length >= 2) break;
    fresh = false;
    feedGop(c, c.nextG, c.nextPass);
    const n = nextGop(c, c.nextG, c.nextPass);
    if (n) {
      c.nextG = n.g;
      c.nextPass = n.pass;
    } else c.nextG = c.gops.length; // a one-shot's end: nothing more to feed
  }
}

// ---------------------------------------------------------------- loop

let timer: ReturnType<typeof setTimeout> | null = null;
let lastStats = 0;
function tick() {
  timer = null;
  let active = false;
  for (const c of clips.values()) {
    if (!c.dec) continue;
    active = true;
    pump(c);
  }
  const t = performance.now();
  if (active && t - lastStats > 1000) {
    lastStats = t;
    const stats: Record<number, CodecStats> = {};
    for (const c of clips.values()) {
      if (!c.dec) continue;
      const { gopSum, ...st } = c.st;
      stats[c.id] = { ...st, gopMsAvg: st.gops ? Math.round((gopSum / st.gops) * 10) / 10 : 0, gopMsMax: Math.round(st.gopMsMax * 10) / 10, readMsMax: Math.round(st.readMsMax) };
      c.st = freshStats();
    }
    post({ op: "stats", stats });
  }
  // Only while some clip is warm: an idle worker costs nothing.
  if (active) timer = setTimeout(tick, 8);
}
const wake = () => {
  if (!timer) timer = setTimeout(tick, 0);
};

function release(c: Clip) {
  if (c.dec) {
    try {
      c.dec.close();
    } catch {
      /* already closed */
    }
  }
  c.dec = null;
  dropQueue(c);
  c.inflight = [];
  c.bytes.clear();
  c.sentLo = Infinity;
  c.lastSent = -Infinity;
  c.started = false;
}

scope.onmessage = async ({ data: m }: MessageEvent<ToWorker>) => {
  let c = clips.get(m.id);
  switch (m.op) {
    case "open": {
      c = {
        id: m.id, url: m.url, mp4: null, v: null, gops: [], pts: [], config: null, dec: null, queue: [], inflight: [], chain: Promise.resolve(),
        nextG: 0, nextPass: 0, bytes: new Map(), reading: new Map(), want: { t: 0, at: absNow(), rate: 0, loop: null }, sentLo: Infinity, lastSent: -Infinity, started: false, failed: false, st: freshStats(),
      };
      clips.set(m.id, c);
      try {
        await open(c);
      } catch (e) {
        c.failed = true;
        post({ op: "refused", id: m.id, reason: String((e as Error)?.message ?? e) });
      }
      return;
    }
    case "warm":
      if (!c?.v || c.failed) return;
      c.want = { t: m.t, at: absNow(), rate: 0, loop: m.loop };
      if (!c.dec) {
        c.dec = makeDecoder(c);
        restart(c, wantNow(c));
        c.st.restarts--;
      }
      pump(c);
      wake();
      return;
    case "want": {
      if (!c?.v || c.failed) return;
      const loopChanged = JSON.stringify(c.want.loop) !== JSON.stringify(m.loop);
      c.want = { t: m.t, at: m.at, rate: m.rate, loop: m.loop };
      if (m.seek) {
        // The page dropped what it had: frames sent before count for nothing.
        c.sentLo = Infinity;
        c.lastSent = -Infinity;
      }
      if (!c.dec) {
        c.dec = makeDecoder(c);
        restart(c, wantNow(c));
        c.st.restarts--;
      } else if (loopChanged) loopChange(c);
      pump(c);
      if (m.rate > 0) c.started = true;
      wake();
      return;
    }
    case "audio": {
      if (!c?.mp4) return;
      try {
        const a = await audioAsAdts(c.mp4);
        if (a) post({ op: "audio", id: m.id, adts: a.adts.buffer as ArrayBuffer, start: a.start }, [a.adts.buffer as ArrayBuffer]);
        else post({ op: "audio", id: m.id, adts: null, start: 0 });
      } catch {
        post({ op: "audio", id: m.id, adts: null, start: 0 });
      }
      return;
    }
    case "release":
      if (c) release(c);
      return;
    case "close":
      if (c) release(c);
      clips.delete(m.id);
      return;
  }
};
