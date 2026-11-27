// A small MP4 (ISO BMFF / QuickTime) demuxer for the WebCodecs video player (docs/ARCHITECTURE.md, "Wall
// video"): reads `moov` with byte-range requests and builds each track's sample table (where every frame's
// bytes are, its decode and presentation time, whether it is a keyframe). Progressive files only, which is
// what the import optimiser writes (`+faststart`); `moov` may also sit after the media data.
// Runs in the decoder worker, and on the main thread to read a file's length without a player.

export interface Sample {
  /** Index in decode order. */
  i: number;
  offset: number;
  size: number;
  /** Presentation time (s), edit list applied: the first frame shown is at 0. */
  pts: number;
  /** Duration (s). */
  dur: number;
  key: boolean;
}

export interface Track {
  handler: string;
  timescale: number;
  /** Sample entry type: avc1, avc3, hvc1, mp4a… */
  entry: string;
  /** WebCodecs codec string when this demuxer knows how to make one (H.264, AAC). */
  codec?: string;
  /** avcC (video) or AudioSpecificConfig (audio). */
  description?: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  samples: Sample[];
  /** Length as shown (s): the last frame's end. */
  duration: number;
}

export interface Mp4 {
  /** File size, or -1 when the server did not say. */
  size: number;
  video: Track | null;
  audio: Track | null;
  read: (start: number, end: number) => Promise<Uint8Array>;
}

const str4 = (dv: DataView, p: number) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function* boxes(dv: DataView, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = str4(dv, p + 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr) return;
    yield { type, start: p, body: p + hdr, end: Math.min(p + size, end) };
    p += size;
  }
}

function child(dv: DataView, b: Box, type: string): Box | null {
  for (const c of boxes(dv, b.body, b.end)) if (c.type === type) return c;
  return null;
}

function path(dv: DataView, b: Box, ...types: string[]): Box | null {
  let cur: Box | null = b;
  for (const t of types) {
    cur = cur && child(dv, cur, t);
    if (!cur) return null;
  }
  return cur;
}

/**
 * Reads [start, end) of `url` with Range requests, looping over short answers (Tauri's asset protocol answers
 * at most 1000 KiB at a time). `size()` is the file's size once a first answer has said it.
 */
export function rangeReader(url: string) {
  let size = -1;
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const out = new Uint8Array(Math.max(0, end - start));
    let got = 0;
    while (got < out.length) {
      const r = await fetch(url, { headers: { Range: `bytes=${start + got}-${end - 1}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cr = r.headers.get("content-range");
      if (cr && size < 0) size = Number(cr.split("/")[1]);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (r.status === 200) {
        // No range support: the whole file came back.
        if (size < 0) size = buf.length;
        out.set(buf.subarray(start + got, Math.min(buf.length, end)), got);
        break;
      }
      if (!buf.length) throw new Error("empty range answer");
      out.set(buf.subarray(0, out.length - got), got);
      got += buf.length;
    }
    return out;
  };
  return { read, size: () => size };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function parseTrak(dv: DataView, trak: Box, movieTimescale: number): Track | null {
  const mdhd = path(dv, trak, "mdia", "mdhd");
  const hdlr = path(dv, trak, "mdia", "hdlr");
  const stbl = path(dv, trak, "mdia", "minf", "stbl");
  if (!mdhd || !hdlr || !stbl) return null;
  const v = dv.getUint8(mdhd.body);
  const timescale = v === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
  const handler = str4(dv, hdlr.body + 8);
  // Edit list: the first non-empty edit's media time is presentation zero; empty edits delay the track.
  let mediaStart = 0;
  let delay = 0;
  const elst = path(dv, trak, "edts", "elst");
  if (elst) {
    const ev = dv.getUint8(elst.body);
    const n = dv.getUint32(elst.body + 4);
    let p = elst.body + 8;
    for (let i = 0; i < n; i++) {
      const dur = ev === 1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
      const mt = ev === 1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
      p += ev === 1 ? 20 : 12;
      if (mt === -1) delay += dur / movieTimescale;
      else {
        mediaStart = mt;
        break;
      }
    }
  }
  const stsd = child(dv, stbl, "stsd");
  const entry = stsd ? [...boxes(dv, stsd.body + 8, stsd.end)][0] : undefined;
  if (!entry) return null;
  const track: Track = { handler, timescale, entry: entry.type, samples: [], duration: 0 };
  if (handler === "vide") {
    track.width = dv.getUint16(entry.body + 24);
    track.height = dv.getUint16(entry.body + 26);
    const avcC = [...boxes(dv, entry.body + 78, entry.end)].find((k) => k.type === "avcC");
    if (avcC && (entry.type === "avc1" || entry.type === "avc3")) {
      const d = new Uint8Array(dv.buffer, dv.byteOffset + avcC.body, avcC.end - avcC.body).slice();
      track.description = d;
      track.codec = `avc1.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`;
    }
  } else if (handler === "soun") {
    const ver = dv.getUint16(entry.body + 8);
    track.channels = dv.getUint16(entry.body + 16);
    track.sampleRate = dv.getUint32(entry.body + 24) >>> 16;
    const kidsAt = entry.body + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    const esds = entry.type === "mp4a" ? [...boxes(dv, kidsAt, entry.end)].find((k) => k.type === "esds") : undefined;
    if (esds) {
      // ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo (the AudioSpecificConfig).
      let p = esds.body + 4;
      const len = () => {
        let n = 0;
        for (let i = 0; i < 4; i++) {
          const b = dv.getUint8(p++);
          n = (n << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        return n;
      };
      let objectType = 0;
      while (p < esds.end) {
        const tag = dv.getUint8(p++);
        const l = len();
        if (tag === 0x03) {
          p += 2;
          const f = dv.getUint8(p++);
          if (f & 0x80) p += 2;
          if (f & 0x40) p += dv.getUint8(p) + 1;
          if (f & 0x20) p += 2;
        } else if (tag === 0x04) {
          objectType = dv.getUint8(p);
          p += 13;
        } else if (tag === 0x05) {
          // 0x40 = MPEG-4 audio (AAC); anything else (MP3 in MP4) is not AAC.
          if (objectType === 0x40) {
            track.description = new Uint8Array(dv.buffer, dv.byteOffset + p, l).slice();
            track.codec = `mp4a.40.${track.description[0] >> 3}`;
          }
          break;
        } else p += l;
      }
    }
  }
  // Sample table.
  const stts = child(dv, stbl, "stts");
  const ctts = child(dv, stbl, "ctts");
  const stss = child(dv, stbl, "stss");
  const stsc = child(dv, stbl, "stsc");
  const stsz = child(dv, stbl, "stsz");
  const stco = child(dv, stbl, "stco") ?? child(dv, stbl, "co64");
  if (!stts || !stsc || !stsz || !stco) return null;
  const fixed = dv.getUint32(stsz.body + 4);
  const count = dv.getUint32(stsz.body + 8);
  const size = new Uint32Array(count);
  for (let i = 0; i < count; i++) size[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);
  const dts = new Float64Array(count);
  let mediaDuration = 0;
  {
    const n = dv.getUint32(stts.body + 4);
    let i = 0;
    let t = 0;
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(stts.body + 8 + e * 8);
      const d = dv.getUint32(stts.body + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) {
        dts[i] = t;
        t += d;
      }
    }
    mediaDuration = t;
  }
  const cto = new Int32Array(count);
  if (ctts) {
    const n = dv.getUint32(ctts.body + 4);
    let i = 0;
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(ctts.body + 8 + e * 8);
      const o = dv.getInt32(ctts.body + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) cto[i] = o;
    }
  }
  const key = new Uint8Array(count);
  if (stss) {
    const n = dv.getUint32(stss.body + 4);
    for (let e = 0; e < n; e++) {
      const s = dv.getUint32(stss.body + 8 + e * 4) - 1;
      if (s >= 0 && s < count) key[s] = 1;
    }
  } else key.fill(1);
  const offset = new Float64Array(count);
  {
    const co64 = stco.type === "co64";
    const nChunks = dv.getUint32(stco.body + 4);
    const chunkOff = (c: number) => (co64 ? Number(dv.getBigUint64(stco.body + 8 + c * 8)) : dv.getUint32(stco.body + 8 + c * 4));
    const n = dv.getUint32(stsc.body + 4);
    let s = 0;
    for (let e = 0; e < n; e++) {
      const first = dv.getUint32(stsc.body + 8 + e * 12) - 1;
      const per = dv.getUint32(stsc.body + 12 + e * 12);
      const last = e + 1 < n ? dv.getUint32(stsc.body + 8 + (e + 1) * 12) - 1 : nChunks;
      for (let c = first; c < last; c++) {
        let o = chunkOff(c);
        for (let k = 0; k < per && s < count; k++, s++) {
          offset[s] = o;
          o += size[s];
        }
      }
    }
  }
  for (let i = 0; i < count; i++) {
    const next = i + 1 < count ? dts[i + 1] : mediaDuration;
    track.samples.push({ i, offset: offset[i], size: size[i], pts: (dts[i] + cto[i] - mediaStart) / timescale + delay, dur: (next - dts[i]) / timescale, key: !!key[i] });
  }
  let end = 0;
  for (const s of track.samples) end = Math.max(end, s.pts + s.dur);
  track.duration = end;
  return track;
}

/** Opens the MP4 at `url`: its video and audio tracks' sample tables, and a reader for the bytes. */
export async function openMp4(url: string): Promise<Mp4> {
  const rr = rangeReader(url);
  let head = await rr.read(0, 64 * 1024);
  // The size comes from Content-Range, which a server may not expose to a page of another origin: then it is
  // unknown, and the box walk below stops at the first header it cannot read.
  const size = rr.size() > 0 ? rr.size() : Infinity;
  if (head.length > size) head = head.subarray(0, size);
  // Find moov among the top-level boxes (it may follow mdat).
  let p = 0;
  let moov: Uint8Array | null = null;
  while (p + 8 <= size) {
    let hdr: Uint8Array;
    if (p + 16 <= head.length) hdr = head.subarray(p, p + 16);
    else {
      try {
        hdr = await rr.read(p, Math.min(size, p + 16));
      } catch {
        break;
      }
      if (hdr.length < 8) break;
    }
    const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    let bsize = dv.getUint32(0);
    const type = str4(dv, 4);
    if (bsize === 1) bsize = hdr.length >= 16 ? Number(dv.getBigUint64(8)) : 0;
    else if (bsize === 0) bsize = Number.isFinite(size) ? size - p : 0;
    if (bsize < 8) break;
    if (type === "moov") {
      moov = p + bsize <= head.length ? head.subarray(p, p + bsize) : await rr.read(p, p + bsize);
      break;
    }
    if (type === "moof") throw new Error("fragmented MP4");
    p += bsize;
  }
  if (!moov) throw new Error("no moov box");
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root: Box = { type: "moov", start: 0, body: 8, end: moov.byteLength };
  const mvhd = child(dv, root, "mvhd");
  const mv = mvhd ? dv.getUint8(mvhd.body) : 0;
  const movieTimescale = mvhd ? (mv === 1 ? dv.getUint32(mvhd.body + 20) : dv.getUint32(mvhd.body + 12)) : 1000;
  let video: Track | null = null;
  let audio: Track | null = null;
  for (const b of boxes(dv, root.body, root.end)) {
    if (b.type !== "trak") continue;
    const t = parseTrak(dv, b, movieTimescale);
    if (t?.handler === "vide" && !video) video = t;
    if (t?.handler === "soun" && !audio) audio = t;
  }
  return { size: Number.isFinite(size) ? size : -1, video, audio, read: rr.read };
}

export interface Gop {
  /** First sample (decode order; its keyframe) and one past the last. */
  first: number;
  end: number;
  /** Presentation span (s). */
  start: number;
  stop: number;
  bytes0: number;
  bytes1: number;
}

/** The video track's GOPs (keyframe to keyframe, decode order). */
export function gopsOf(t: Track): Gop[] {
  const s = t.samples;
  const g: Gop[] = [];
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

/**
 * Why the WebCodecs player cannot play this video track, or null when it can: H.264 only (this demuxer makes
 * no other codec string), closed GOPs (each GOP is decoded on its own: no picture shown before its keyframe),
 * and keyframes no more than `maxGop` seconds apart (a GOP is held decoded whole).
 */
export function unplayable(t: Track | null, maxGop = 2.1): string | null {
  if (!t) return "no video track";
  if (!t.codec || !t.description) return `codec ${t.entry} (H.264 only)`;
  if (!t.samples.length) return "no frames";
  for (const g of gopsOf(t)) {
    const keyPts = t.samples[g.first].pts;
    for (let i = g.first + 1; i < g.end; i++) if (t.samples[i].pts < keyPts - 1e-6) return "open GOPs";
    if (g.stop - g.start > maxGop + 1e-6) return `keyframes ${(g.stop - g.start).toFixed(1)} s apart`;
  }
  return null;
}

/** Length (s) of the video at `url` read from its moov, or null (not an MP4 we can read). */
export async function mp4Duration(url: string): Promise<number | null> {
  try {
    const m = await openMp4(url);
    const d = m.video?.duration ?? m.audio?.duration ?? 0;
    return d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * The audio track as an ADTS stream (AAC), which decodeAudioData reads in WebKit and Chromium. `start` is the
 * first sample's presentation time (negative by the encoder's priming, which the decoded buffer still holds).
 */
export async function audioAsAdts(mp4: Mp4): Promise<{ adts: Uint8Array; start: number; duration: number } | null> {
  const a = mp4.audio;
  if (!a || !a.description || !a.codec?.startsWith("mp4a.40.") || !a.samples.length) return null;
  const asc = a.description;
  const aot = asc[0] >> 3;
  const sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const ch = (asc[1] >> 3) & 15;
  if (aot < 1 || aot > 4 || sfi > 12) return null;
  // Read the audio in runs of adjacent chunks (it is interleaved with the video): small requests, no video bytes.
  const runs: { start: number; end: number; samples: Sample[] }[] = [];
  for (const s of a.samples) {
    const last = runs[runs.length - 1];
    if (last && s.offset === last.end) {
      last.end += s.size;
      last.samples.push(s);
    } else runs.push({ start: s.offset, end: s.offset + s.size, samples: [s] });
  }
  const total = a.samples.reduce((n, s) => n + s.size + 7, 0);
  const out = new Uint8Array(total);
  // Four reads at a time (a long film has a run per second of sound), written out in order.
  const spans: Promise<Uint8Array>[] = [];
  const ahead = (k: number) => {
    while (spans.length < runs.length && spans.length < k + 4) {
      const r = runs[spans.length];
      spans.push(mp4.read(r.start, r.end));
    }
  };
  let o = 0;
  for (let k = 0; k < runs.length; k++) {
    ahead(k);
    const run = runs[k];
    const span = await spans[k];
    for (const s of run.samples) {
      const len = s.size + 7;
      out[o] = 0xff;
      out[o + 1] = 0xf1;
      out[o + 2] = ((aot - 1) << 6) | (sfi << 2) | (ch >> 2);
      out[o + 3] = ((ch & 3) << 6) | (len >> 11);
      out[o + 4] = (len >> 3) & 0xff;
      out[o + 5] = ((len & 7) << 5) | 0x1f;
      out[o + 6] = 0xfc;
      out.set(span.subarray(s.offset - run.start, s.offset - run.start + s.size), o + 7);
      o += len;
    }
  }
  return { adts: out, start: a.samples[0].pts, duration: a.duration };
}
