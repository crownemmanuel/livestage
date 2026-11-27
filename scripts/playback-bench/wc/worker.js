// WebCodecs clip decoder for the bench: one worker, any number of clips. The page owns the clock: it sends
// each clip's wanted time (`want`: t at absolute time `at`, advancing at `rate`) and the worker decodes the
// GOPs around it, sending each frame shortly before it is due. Frames that fall behind are closed here, so
// the page only ever holds two or three.
//
// Decoding goes a whole GOP at a time: its chunks, then flush(). WebKit's decoder holds 11 frames before the
// first comes out (Chromium 2), so flushing each GOP is what makes the output timing the same in both, and a
// seek is the same operation as playing on (~20 ms for a 12-frame 3072x768 GOP). Needs closed GOPs.
import { openMp4, audioAsAdts } from "./mp4.js";

const AHEAD = 0.25; // seconds: a GOP is fed once its start is this close to the wanted time
const LEAD = 0.09; // seconds a frame is sent before it is due
const READ_AHEAD = 2; // GOPs whose bytes are read ahead
const absNow = () => performance.timeOrigin + performance.now();
const clips = new Map();
const post = (m, t) => self.postMessage(m, t || []);

function stats(c) {
  return { id: c.id, gopsFed: c.st.gops, out: c.st.out, stale: c.st.stale, sent: c.st.sent, seeks: c.st.seeks, maxHeld: c.st.maxHeld, gopMsAvg: c.st.gopN ? +(c.st.gopSum / c.st.gopN).toFixed(1) : 0, gopMsMax: +c.st.gopMax.toFixed(1), readMsMax: +c.st.readMax.toFixed(1), firstFrameMs: c.st.firstFrameMs, errors: c.st.errors };
}

function gopsOf(v) {
  const s = v.samples, g = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i].key || !g.length) g.push({ first: i, end: i + 1, start: s[i].pts, stop: s[i].pts + s[i].dur, bytes0: s[i].offset, bytes1: s[i].offset + s[i].size });
    const cur = g[g.length - 1];
    cur.end = i + 1;
    cur.start = Math.min(cur.start, s[i].pts);
    cur.stop = Math.max(cur.stop, s[i].pts + s[i].dur);
    cur.bytes0 = Math.min(cur.bytes0, s[i].offset);
    cur.bytes1 = Math.max(cur.bytes1, s[i].offset + s[i].size);
  }
  return g;
}

async function open(m) {
  const t0 = performance.now();
  const mp4 = await openMp4(m.url);
  const v = mp4.video;
  const config = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, description: v.description, hardwareAcceleration: m.hw || "no-preference" };
  const sup = await VideoDecoder.isConfigSupported(config);
  const gops = gopsOf(v);
  const c = {
    id: m.id, mp4, v, gops, loop: !!m.loop, config,
    dec: null, queue: [], accept: [], nextG: 0, nextPass: 0, inFlight: 0, bytes: new Map(), reading: new Map(),
    want: { t: 0, at: absNow(), rate: 0 }, warmAt: 0,
    st: { gops: 0, out: 0, stale: 0, sent: 0, seeks: 0, maxHeld: 0, gopSum: 0, gopN: 0, gopMax: 0, readMax: 0, firstFrameMs: -1, errors: [] },
  };
  clips.set(m.id, c);
  const audio = m.audio && mp4.audio ? await audioAsAdts(mp4) : null;
  post({ op: "info", id: m.id, ms: +(performance.now() - t0).toFixed(1), codec: v.codec, width: v.width, height: v.height, frames: v.samples.length, gops: gops.length, maxGop: Math.max(...gops.map((g) => g.end - g.first)), duration: v.duration, supported: sup.supported, audio }, audio ? [audio.adts.buffer] : []);
}

const wantNow = (c) => c.want.t + ((absNow() - c.want.at) / 1000) * c.want.rate;
const D = (c) => c.v.duration;
/** Wanted time as the clip shows it: a looping clip runs on (pass n is n * duration + t), a one-shot holds its last frame. */
const shownT = (c, T) => (c.loop ? T : Math.min(T, D(c) - 0.5 / 24));
const gopAt = (c, t) => {
  let k = 0;
  for (let i = 0; i < c.gops.length; i++) if (c.gops[i].start <= t + 1e-6) k = i;
  return k;
};
const gopStartU = (c, g, pass) => pass * D(c) + c.gops[g].start;

function restartAt(c, T) {
  // Drop everything and decode from the GOP holding T.
  for (const q of c.queue) q.f.close();
  c.queue = [];
  c.accept = [];
  const pass = c.loop ? Math.max(0, Math.floor(T / D(c))) : 0;
  c.nextPass = pass;
  c.nextG = gopAt(c, T - pass * D(c));
  if (!c.dec || c.dec.state === "closed") {
    c.dec = new VideoDecoder({
      output: (f) => onFrame(c, f),
      error: (e) => { c.st.errors.push(String(e)); post({ op: "error", id: c.id, error: String(e) }); },
    });
    c.dec.configure(c.config);
  }
}

function readGop(c, g) {
  if (c.bytes.has(g)) return Promise.resolve(c.bytes.get(g));
  if (c.reading.has(g)) return c.reading.get(g);
  const G = c.gops[g];
  const t0 = performance.now();
  const p = c.mp4.read(G.bytes0, G.bytes1).then((b) => {
    c.st.readMax = Math.max(c.st.readMax, performance.now() - t0);
    c.reading.delete(g);
    c.bytes.set(g, b);
    return b;
  });
  c.reading.set(g, p);
  return p;
}

async function feedGop(c, g, pass) {
  const G = c.gops[g], s = c.v.samples;
  const off = pass * D(c);
  const range = { from: off + G.start - 1e-4, to: off + G.stop + 1e-4 };
  c.accept.push(range);
  c.inFlight++;
  const t0 = performance.now();
  const buf = await readGop(c, g);
  // Keep the bytes of the GOPs coming up; forget the rest.
  for (const k of c.bytes.keys()) if (!(k === g || (k - g + c.gops.length) % c.gops.length <= READ_AHEAD)) c.bytes.delete(k);
  for (let a = 1; a <= READ_AHEAD; a++) {
    const n = g + a;
    if (n < c.gops.length) readGop(c, n);
    else if (c.loop) readGop(c, n - c.gops.length);
  }
  if (!c.accept.includes(range) || !c.dec || c.dec.state !== "configured") { c.inFlight--; return; }
  for (let i = G.first; i < G.end; i++) {
    const x = s[i];
    c.dec.decode(new EncodedVideoChunk({ type: x.key ? "key" : "delta", timestamp: Math.round((off + x.pts) * 1e6), duration: Math.round(x.dur * 1e6), data: buf.subarray(x.offset - G.bytes0, x.offset - G.bytes0 + x.size) }));
  }
  c.st.gops++;
  try {
    await c.dec.flush();
    const ms = performance.now() - t0;
    c.st.gopSum += ms; c.st.gopN++; c.st.gopMax = Math.max(c.st.gopMax, ms);
  } catch {}
  c.inFlight--;
  pump(c);
}

function onFrame(c, f) {
  c.st.out++;
  const ts = f.timestamp / 1e6;
  if (c.st.firstFrameMs < 0) c.st.firstFrameMs = +(performance.now() - c.warmAt).toFixed(1);
  const T = shownT(c, wantNow(c));
  if (!c.accept.some((r) => ts >= r.from && ts <= r.to) || (c.want.rate > 0 && ts < T - 1.5 / 24 && c.queue.some((q) => q.ts > ts))) {
    f.close();
    c.st.stale++;
    return;
  }
  c.queue.push({ ts, f });
  c.queue.sort((a, b) => a.ts - b.ts);
  c.st.maxHeld = Math.max(c.st.maxHeld, c.queue.length);
}

function pump(c) {
  if (!c.dec) return;
  const T = shownT(c, wantNow(c));
  const dur = D(c);
  // Is T somewhere we are decoding? If not (a seek, a jump back, a long hold), start again from its GOP.
  const covered = c.accept.some((r) => T >= r.from - 0.5 / 24 && T <= r.to) || (c.nextPass * dur + c.gops[Math.min(c.nextG, c.gops.length - 1)].start <= T + AHEAD && T < gopStartU(c, Math.min(c.nextG, c.gops.length - 1), c.nextPass) + 0.6);
  if (!covered && c.want.rate > 0) {
    c.st.seeks++;
    restartAt(c, T);
  }
  // Frames behind T: keep only the last one at or before it.
  while (c.queue.length >= 2 && c.queue[1].ts <= T + 1e-6) {
    c.queue.shift().f.close();
    c.st.stale++;
  }
  // Send what is due within LEAD.
  while (c.queue.length && c.queue[0].ts <= T + LEAD) {
    const q = c.queue.shift();
    post({ op: "frame", id: c.id, ts: q.ts, frame: q.f }, [q.f]);
    c.st.sent++;
  }
  // Forget decoded ranges that are behind.
  c.accept = c.accept.filter((r) => r.to >= T - 0.5);
  // Feed the next GOP once its start comes within AHEAD (at most two in flight).
  while (c.inFlight < 2) {
    if (c.nextG >= c.gops.length) {
      if (!c.loop) break;
      c.nextG = 0;
      c.nextPass++;
    }
    const start = gopStartU(c, c.nextG, c.nextPass);
    if (start > T + AHEAD && c.inFlight + c.queue.length > 0) break;
    feedGop(c, c.nextG, c.nextPass);
    c.nextG++;
    if (c.want.rate === 0) break; // warming: the first GOP only
  }
}

let timer = null;
function tick() {
  for (const c of clips.values()) pump(c);
  timer = setTimeout(tick, 8);
}

self.onmessage = async ({ data: m }) => {
  const c = clips.get(m.id);
  switch (m.op) {
    case "open":
      try { await open(m); } catch (e) { post({ op: "error", id: m.id, error: String(e) }); }
      break;
    case "warm": // decode the first GOP from t, not advancing
      if (!c) return;
      c.warmAt = performance.now();
      c.want = { t: m.t || 0, at: absNow(), rate: 0 };
      restartAt(c, m.t || 0);
      pump(c);
      break;
    case "want": // t at absolute time `at`, advancing at `rate`
      if (!c) return;
      c.want = { t: m.t, at: m.at, rate: m.rate };
      if (!c.dec) restartAt(c, m.t);
      pump(c);
      break;
    case "release":
      if (!c) return;
      try { c.dec?.close(); } catch {}
      c.dec = null;
      for (const q of c.queue) q.f.close();
      c.queue = [];
      c.bytes.clear();
      post({ op: "stats", ...stats(c) });
      clips.delete(m.id);
      break;
    case "stats":
      post({ op: "allStats", clips: [...clips.values()].map(stats) });
      break;
  }
  if (!timer) tick();
};
