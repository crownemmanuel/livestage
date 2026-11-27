// Minimal MP4 (ISO BMFF) demuxer for the WebCodecs bench: reads `moov` with byte-range requests and builds
// each track's sample table (offset, size, decode and presentation time, keyframe). Progressive files only
// (no fragments), which is what the wall's finals are.

const str4 = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

function* boxes(dv, start, end) {
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
const child = (dv, b, type) => {
  for (const c of boxes(dv, b.body, b.end)) if (c.type === type) return c;
  return null;
};
const path = (dv, b, ...types) => {
  let cur = b;
  for (const t of types) {
    cur = cur && child(dv, cur, t);
    if (!cur) return null;
  }
  return cur;
};

/** Reads [start, end) through `fetch` with Range, looping over short answers (Tauri's asset protocol caps one answer). */
export function rangeReader(url) {
  let size = -1;
  const read = async (start, end) => {
    const out = new Uint8Array(end - start);
    let got = 0;
    while (got < out.length) {
      const r = await fetch(url, { headers: { Range: `bytes=${start + got}-${end - 1}` } });
      if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status} for ${url}`);
      const cr = r.headers.get("content-range");
      if (cr && size < 0) size = Number(cr.split("/")[1]);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (r.status === 200) {
        // No range support: the whole file came back.
        if (size < 0) size = buf.length;
        out.set(buf.subarray(start + got, Math.min(buf.length, end)), got);
        got = out.length;
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

function parseTrak(dv, trak, movieTimescale) {
  const mdhd = path(dv, trak, "mdia", "mdhd");
  const v = dv.getUint8(mdhd.body);
  const timescale = v === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
  const hdlr = path(dv, trak, "mdia", "hdlr");
  const handler = str4(dv, hdlr.body + 8);
  const stbl = path(dv, trak, "mdia", "minf", "stbl");
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
  const entry = [...boxes(dv, stsd.body + 8, stsd.end)][0];
  const track = { handler, timescale, codecType: entry.type };
  if (handler === "vide") {
    track.width = dv.getUint16(entry.body + 24);
    track.height = dv.getUint16(entry.body + 26);
    const kids = [...boxes(dv, entry.body + 78, entry.end)];
    const avcC = kids.find((k) => k.type === "avcC");
    if (avcC) {
      const d = new Uint8Array(dv.buffer, dv.byteOffset + avcC.body, avcC.end - avcC.body);
      track.description = d.slice();
      const hx = (n) => n.toString(16).padStart(2, "0");
      track.codec = `avc1.${hx(d[1])}${hx(d[2])}${hx(d[3])}`;
    }
  } else if (handler === "soun") {
    const ver = dv.getUint16(entry.body + 8);
    track.channels = dv.getUint16(entry.body + 16);
    track.sampleRate = dv.getUint32(entry.body + 24) >>> 16;
    const kidsAt = entry.body + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    const esds = [...boxes(dv, kidsAt, entry.end)].find((k) => k.type === "esds");
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
          track.objectType = dv.getUint8(p);
          p += 13;
        } else if (tag === 0x05) {
          track.description = new Uint8Array(dv.buffer, dv.byteOffset + p, l).slice();
          const aot = track.description[0] >> 3;
          track.codec = `mp4a.40.${aot}`;
          break;
        } else p += l;
      }
    }
  }
  // Sample table.
  const u32s = (b, at) => {
    const n = dv.getUint32(b.body + at);
    return { n, p: b.body + at + 4 };
  };
  const stts = child(dv, stbl, "stts");
  const ctts = child(dv, stbl, "ctts");
  const stss = child(dv, stbl, "stss");
  const stsc = child(dv, stbl, "stsc");
  const stsz = child(dv, stbl, "stsz");
  const stco = child(dv, stbl, "stco") || child(dv, stbl, "co64");
  const fixed = dv.getUint32(stsz.body + 4);
  const count = dv.getUint32(stsz.body + 8);
  const size = new Uint32Array(count);
  for (let i = 0; i < count; i++) size[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);
  const dts = new Float64Array(count);
  {
    const { n, p } = u32s(stts, 4);
    let i = 0, t = 0;
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(p + e * 8), d = dv.getUint32(p + e * 8 + 4);
      for (let k = 0; k < c && i < count; k++, i++) {
        dts[i] = t;
        t += d;
      }
    }
    track.mediaDuration = t;
  }
  const cto = new Int32Array(count);
  if (ctts) {
    const { n, p } = u32s(ctts, 4);
    let i = 0;
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(p + e * 8), o = dv.getInt32(p + e * 8 + 4);
      for (let k = 0; k < c && i < count; k++, i++) cto[i] = o;
    }
  }
  const key = new Uint8Array(count);
  if (stss) {
    const { n, p } = u32s(stss, 4);
    for (let e = 0; e < n; e++) key[dv.getUint32(p + e * 4) - 1] = 1;
  } else key.fill(1);
  const offset = new Float64Array(count);
  {
    const co64 = stco.type === "co64";
    const nChunks = dv.getUint32(stco.body + 4);
    const chunkOff = (c) => (co64 ? Number(dv.getBigUint64(stco.body + 8 + c * 8)) : dv.getUint32(stco.body + 8 + c * 4));
    const { n, p } = u32s(stsc, 4);
    let s = 0;
    for (let e = 0; e < n; e++) {
      const first = dv.getUint32(p + e * 12) - 1;
      const per = dv.getUint32(p + e * 12 + 4);
      const last = e + 1 < n ? dv.getUint32(p + (e + 1) * 12) - 1 : nChunks;
      for (let c = first; c < last; c++) {
        let o = chunkOff(c);
        for (let k = 0; k < per && s < count; k++, s++) {
          offset[s] = o;
          o += size[s];
        }
      }
    }
  }
  const ts = timescale;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const pts = (dts[i] + cto[i] - mediaStart) / ts + delay;
    const next = i + 1 < count ? dts[i + 1] : track.mediaDuration;
    samples.push({ i, offset: offset[i], size: size[i], dts: dts[i] / ts, pts, dur: (next - dts[i]) / ts, key: !!key[i] });
  }
  track.samples = samples;
  // Presentation order (for frame-at-time) and the duration as shown.
  const byPts = samples.slice().sort((a, b) => a.pts - b.pts);
  track.byPts = byPts;
  const lastS = byPts[byPts.length - 1];
  track.duration = lastS ? lastS.pts + lastS.dur : 0;
  return track;
}

/** Opens an MP4 at `url`: { size, video, audio, read } where `read(start, end)` reads bytes. */
export async function openMp4(url) {
  const rr = rangeReader(url);
  let head = await rr.read(0, 64 * 1024);
  const size = rr.size() > 0 ? rr.size() : head.length;
  // Find moov among the top-level boxes (it may follow mdat).
  let p = 0, moov = null;
  while (p + 8 <= size) {
    let hdr = p + 16 <= head.length ? head.subarray(p, p + 16) : await rr.read(p, Math.min(size, p + 16));
    const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    let bsize = dv.getUint32(0);
    const type = str4(dv, 4);
    if (bsize === 1) bsize = Number(dv.getBigUint64(8));
    else if (bsize === 0) bsize = size - p;
    if (type === "moov") {
      moov = p + bsize <= head.length ? head.subarray(p, p + bsize) : await rr.read(p, p + bsize);
      break;
    }
    p += bsize;
  }
  if (!moov) throw new Error("no moov");
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root = { body: 8, end: moov.byteLength };
  const mvhd = child(dv, root, "mvhd");
  const mv = dv.getUint8(mvhd.body);
  const movieTimescale = mv === 1 ? dv.getUint32(mvhd.body + 20) : dv.getUint32(mvhd.body + 12);
  let video = null, audio = null;
  for (const b of boxes(dv, root.body, root.end)) {
    if (b.type !== "trak") continue;
    const t = parseTrak(dv, b, movieTimescale);
    if (t.handler === "vide" && !video) video = t;
    if (t.handler === "soun" && !audio) audio = t;
  }
  return { size, video, audio, read: rr.read };
}

/** The audio track as an ADTS stream (AAC), which decodeAudioData reads in WebKit and Chromium. */
export async function audioAsAdts(mp4) {
  const a = mp4.audio;
  if (!a || !a.description || !a.codec?.startsWith("mp4a.40.")) return null;
  const asc = a.description;
  const aot = asc[0] >> 3;
  const sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const ch = (asc[1] >> 3) & 15;
  // Audio samples are usually interleaved with video: read the span once, then cut.
  const start = Math.min(...a.samples.map((s) => s.offset));
  const end = Math.max(...a.samples.map((s) => s.offset + s.size));
  const span = await mp4.read(start, end);
  const total = a.samples.reduce((n, s) => n + s.size + 7, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const s of a.samples) {
    const len = s.size + 7;
    out[o] = 0xff;
    out[o + 1] = 0xf1;
    out[o + 2] = ((aot - 1) << 6) | (sfi << 2) | (ch >> 2);
    out[o + 3] = ((ch & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(span.subarray(s.offset - start, s.offset - start + s.size), o + 7);
    o += len;
  }
  return { adts: out, start: a.samples[0].pts, duration: a.duration, sampleRate: a.sampleRate, channels: a.channels };
}
