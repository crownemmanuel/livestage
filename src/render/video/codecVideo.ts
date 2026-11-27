// The WebCodecs video player (docs/ARCHITECTURE.md, "Wall video"): a clip decoded by the window's decoder worker
// instead of a platform <video>. On the Mac every <video> is an AVPlayer in the WebKit GPU process that both
// windows share, and loading, switching or releasing one held that process for 3-5 s (docs/PERFORMANCE.md,
// "Freeze, then jump"). Here nothing goes near AVFoundation: the worker demuxes the file and decodes it with
// VideoDecoder (VideoToolbox / Media Foundation), the page picks the frame for the shared clock and hands it to
// three as the texture's picture, and the clip's sound is its AAC track decoded once and played through the
// window's Web Audio graph (the show's outputs and speakers), locked to the same clock.
//
// The player looks like a <video> to the layers (`video`: readyState, currentTime, seeking, ...), so ClipActor
// and MediaLayers drive both engines the same way (render/layers/video.ts picks one per file).
//
// Nothing here runs until a first player is made: the worker is created then.

import * as THREE from "three";
import { programAudioContext } from "@/engine/audio";
import { previewAudioContext } from "@/engine/previewAudio";
import { soundOut } from "@/engine/speakers";
import type { CodecInfo, CodecStats, FromWorker, LoopSpan, ToWorker } from "./protocol";

/** What a layer reads from its video, the same for a <video> and a WebCodecs player. */
export interface VideoLike {
  readonly readyState: number;
  readonly currentTime: number;
  readonly duration: number;
  readonly seeking: boolean;
  readonly paused: boolean;
  loop: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  pause(): void;
}

/** What a layer wants from its video this frame (see syncVideo in render/layers/video.ts). */
export interface CodecWant {
  play: boolean;
  time: number;
  rate: number;
  muted: boolean;
  volume: number;
  local?: boolean;
  reverse?: boolean;
  loop?: number;
  segment?: LoopSpan;
  once?: boolean;
}

// ---------------------------------------------------------------- the worker

let worker: Worker | null = null;
const players = new Map<number, CodecPlayer>();
let nextId = 1;

/** Files this window will not play with WebCodecs, and why (they play on the platform player). */
const refusedUrls = new Map<string, string>();
export function codecRefused(url: string): string | null {
  return refusedUrls.get(url) ?? null;
}
/** Every refusal in this window (diagnostics): file name -> reason. */
export function codecRefusals(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [url, why] of refusedUrls) out[fileName(url)] = why;
  return out;
}

const fileName = (url: string) => {
  let u = url.split("?")[0];
  try {
    u = decodeURIComponent(u); // asset://localhost/%2FUsers%2F… : the path is one encoded segment
  } catch {
    /* keep it */
  }
  return u.split("/").pop() || url;
};

function send(m: ToWorker) {
  getWorker().postMessage(m);
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => route(data);
    worker.onerror = (e) => {
      // The worker itself failed (it could not load): every player falls back.
      console.warn("video decoder worker failed", e.message);
      for (const p of players.values()) p.fail(`worker: ${e.message || "failed"}`);
    };
  }
  return worker;
}

function route(m: FromWorker) {
  if (m.op === "stats") {
    for (const [id, st] of Object.entries(m.stats)) {
      const p = players.get(Number(id));
      if (p) p.addStats(st);
    }
    return;
  }
  const p = players.get(m.id);
  if (m.op === "frame") {
    if (p) p.receive(m.ts, m.frame);
    else m.frame.close();
    return;
  }
  if (!p) return;
  if (m.op === "info") p.opened(m);
  else if (m.op === "refused") p.fail(m.reason, true);
  else if (m.op === "error") p.fail(m.error);
  else if (m.op === "audio") p.sound.received(m.adts, m.start);
}

// ---------------------------------------------------------------- sound

let decodeCtx: OfflineAudioContext | null = null;

/**
 * A clip's sound: its AAC track decoded once (decodeAudioData runs off the main thread) and played from an
 * AudioBufferSourceNode at the clip's media time, one node per pass of a loop, scheduled ahead of the wrap so the
 * loop is seamless. It is re-seated only when it is more than 80 ms off the clock (a seek, a scrub, a hold).
 * Through the program audio context and its speaker graph (the show's outputs), or for the preview the
 * computer's own default output, as the <video> path does.
 */
class ClipSound {
  buffer: AudioBuffer | null = null;
  private requested = false;
  private priming = 0;
  private ctx: AudioContext | null = null;
  private local = false;
  private voices: { src: AudioBufferSourceNode; gain: GainNode; pass: number; ctxStart: number; mediaStart: number; rate: number; volume: number }[] = [];
  constructor(private readonly player: CodecPlayer) {}

  /** For diagnostics: the sound is playing, being decoded, or not in use. */
  get state(): "on" | "decoding" | undefined {
    if (this.voices.length) return "on";
    if (this.requested && !this.buffer) return "decoding";
    return undefined;
  }

  request() {
    if (this.requested || !this.player.info || this.player.info.sound !== "aac") return;
    this.requested = true;
    send({ op: "audio", id: this.player.id });
  }

  async received(adts: ArrayBuffer | null, start: number) {
    if (!adts || this.player.disposed) return;
    try {
      decodeCtx ??= new OfflineAudioContext(2, 1, 48000);
      this.buffer = await decodeCtx.decodeAudioData(adts);
      // The decoded buffer still holds the encoder's priming, before the edit list's zero.
      this.priming = Math.max(0, -start);
    } catch (e) {
      console.warn("clip sound could not be decoded", fileName(this.player.url), e);
    }
  }

  /** Let the samples go (the player is going). */
  drop() {
    this.stop(0.03);
    this.buffer = null;
    this.requested = false;
  }

  stop(fade = 0.03) {
    for (const v of this.voices) this.fadeOut(v, fade);
    this.voices = [];
  }

  private fadeOut(v: ClipSound["voices"][number], fade: number) {
    const ac = this.ctx;
    if (!ac) return;
    const t = ac.currentTime;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + fade);
      v.src.stop(t + fade + 0.01);
    } catch {
      /* already stopped */
    }
  }

  /** `T`: unwrapped media time now. */
  sync(play: boolean, T: number, rate: number, muted: boolean, volume: number, local: boolean, L: LoopSpan | null) {
    if (!play || muted || volume < 1e-4 || this.player.info?.sound !== "aac") {
      if (this.voices.length) this.stop();
      return;
    }
    if (!this.buffer) {
      this.request();
      return;
    }
    const ac = local ? previewAudioContext() : programAudioContext();
    if (ac !== this.ctx || local !== this.local) {
      this.stop(0.01);
      this.ctx = ac;
      this.local = local;
    }
    if (ac.state !== "running") return;
    const len = L ? L.to - L.from : 0;
    const pass = L && T >= L.to ? Math.floor((T - L.from) / len) : 0;
    const t = T - pass * len;
    const now = ac.currentTime;
    // Passes behind this one have ended (or end at the wrap): forget them.
    this.voices = this.voices.filter((v) => {
      if (v.pass >= pass) return true;
      if (v.ctxStart + (L ? (L.to - v.mediaStart) / v.rate : Infinity) > now + 0.05) this.fadeOut(v, 0.01);
      return false;
    });
    const cur = this.voices.find((v) => v.pass === pass && v.ctxStart <= now + 0.001);
    const expected = cur ? cur.mediaStart + (now - cur.ctxStart) * cur.rate : NaN;
    if (!cur || Math.abs(expected - t) > 0.08 || Math.abs(cur.rate - rate) > 1e-3) {
      for (const v of this.voices.filter((v) => v.pass >= pass)) this.fadeOut(v, 0.015);
      this.voices = this.voices.filter((v) => v.pass < pass);
      this.start(pass, t, now, rate, volume, L);
    }
    // The next pass of a loop, scheduled on the sample where this one ends.
    if (L && rate > 0) {
      const toEnd = (L.to - t) / rate;
      if (toEnd < 0.5 && !this.voices.some((v) => v.pass === pass + 1)) this.start(pass + 1, L.from, now + toEnd, rate, volume, L);
    }
    for (const v of this.voices) {
      if (Math.abs(v.volume - volume) > 0.002) {
        v.volume = volume;
        v.gain.gain.setTargetAtTime(volume, Math.max(now, v.ctxStart), 0.02);
      }
    }
  }

  private start(pass: number, mediaT: number, when: number, rate: number, volume: number, L: LoopSpan | null) {
    const ac = this.ctx!;
    const buf = this.buffer!;
    const offset = mediaT + this.priming;
    if (offset >= buf.duration - 0.01) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(volume, when + 0.01);
    src.connect(gain).connect(this.local ? ac.destination : soundOut(ac));
    src.start(when, offset);
    if (L) src.stop(when + (L.to - mediaT) / rate + 0.004);
    const v = { src, gain, pass, ctxStart: when, mediaStart: mediaT, rate, volume };
    src.onended = () => {
      this.voices = this.voices.filter((x) => x !== v);
      gain.disconnect();
    };
    this.voices.push(v);
  }
}

// ---------------------------------------------------------------- the player

/** Counters since the last report (the output heartbeat reads them once a second). */
interface Counters {
  shown: number;
  late: number;
  skipped: number;
  /** Most the frame on screen was behind the clock (s), while playing. */
  lagMax: number;
  worker: CodecStats | null;
}

export class CodecPlayer {
  readonly id = nextId++;
  readonly texture: THREE.VideoTexture;
  readonly sound: ClipSound;
  readonly video: VideoLike;
  info: CodecInfo | null = null;
  /** Why it cannot play (the layer falls back to the platform player). */
  failure: string | null = null;
  onFail: ((reason: string) => void) | null = null;
  disposed = false;
  private wantsSound = false;
  private warm: boolean;
  private frames: { ts: number; f: VideoFrame }[] = [];
  private cur: { ts: number; f: VideoFrame } | null = null;
  private curUploaded = true;
  private coldTimer: ReturnType<typeof setTimeout> | null = null;
  private sent: { t: number; at: number; rate: number; loop: string } | null = null;
  private pass = 0;
  private prevTime: number | null = null;
  private loopKey = "";
  private span: LoopSpan | null = null;
  private playing = false;
  private T = 0;
  private waiting = true;
  private loopFlag = false;
  private counters: Counters = { shown: 0, late: 0, skipped: 0, lagMax: 0, worker: null };
  /** Development only: recent events (window.__slsCodec). */
  trace: string[] = [];
  private note(s: string) {
    if (!import.meta.env.DEV) return;
    this.trace.push(`${(performance.now() / 1000).toFixed(3)} ${s}`);
    if (this.trace.length > 60) this.trace.shift();
  }

  constructor(
    readonly url: string,
    opts: { lazy?: boolean; packed?: boolean } = {},
  ) {
    this.warm = !opts.lazy;
    // A VideoTexture so three uploads it with texImage2D every time and the media shader decodes its sRGB
    // (mediaMaterial.ts setMap), exactly as for a <video>. Its picture is the current VideoFrame.
    const placeholder = {} as HTMLVideoElement;
    this.texture = new THREE.VideoTexture(placeholder);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.userData.alphaPacked = !!opts.packed;
    this.texture.onUpdate = () => {
      this.curUploaded = true;
    };
    this.sound = new ClipSound(this);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const p = this;
    this.video = {
      get readyState() {
        return p.cur ? 2 : p.info ? 1 : 0;
      },
      get currentTime() {
        return p.cur ? p.wrapped(p.cur.ts) : 0;
      },
      get duration() {
        return p.info?.duration ?? NaN;
      },
      get seeking() {
        return !!p.cur && p.waiting;
      },
      get paused() {
        return !p.playing;
      },
      get loop() {
        return p.loopFlag;
      },
      set loop(v: boolean) {
        p.loopFlag = v;
      },
      get videoWidth() {
        return p.info?.width ?? 0;
      },
      get videoHeight() {
        return p.info?.height ?? 0;
      },
      pause() {
        p.pause();
      },
    };
    players.set(this.id, this);
    send({ op: "open", id: this.id, url });
  }

  /**
   * The layer may play this clip's sound. It is then decoded as soon as the file is open (not when the clip warms,
   * which is just before its cue: a voice clip would lose its first words to the decode) and kept until the player goes.
   */
  get soundWanted() {
    return this.wantsSound;
  }
  set soundWanted(v: boolean) {
    this.wantsSound = v;
    if (v && this.info) this.sound.request();
  }

  /** The decoded frame on screen now (the transition layer draws it itself). */
  get frame(): VideoFrame | null {
    return this.cur?.f ?? null;
  }

  get isWarm() {
    return this.warm;
  }

  opened(info: CodecInfo) {
    if (import.meta.env.DEV) this.note(`opened warm=${this.warm}`);
    this.info = info;
    if (this.wantsSound) this.sound.request();
    if (this.warm) this.startWarm();
  }

  fail(reason: string, refused = false) {
    if (this.failure || this.disposed) return;
    this.failure = reason;
    // A file the decoder refuses, or one whose decoding broke: this window plays it on the platform player from now on.
    refusedUrls.set(this.url, refused ? reason : `failed: ${reason}`);
    console.warn(`video: ${fileName(this.url)} on the platform player (${reason})`);
    this.onFail?.(reason);
  }

  addStats(st: CodecStats) {
    const w = this.counters.worker;
    this.counters.worker = w
      ? { gops: w.gops + st.gops, gopMsAvg: st.gopMsAvg || w.gopMsAvg, gopMsMax: Math.max(w.gopMsMax, st.gopMsMax), restarts: w.restarts + st.restarts, playingRestarts: w.playingRestarts + st.playingRestarts, stale: w.stale + st.stale, held: Math.max(w.held, st.held), readMsMax: Math.max(w.readMsMax, st.readMsMax) }
      : st;
  }

  /** Counters since the last call, then reset. */
  takeCounters(): Counters {
    const c = this.counters;
    this.counters = { shown: 0, late: 0, skipped: 0, lagMax: 0, worker: null };
    return c;
  }

  get isPlaying() {
    return this.playing;
  }

  get time(): number {
    return this.T;
  }

  private wrapped(ts: number): number {
    const L = this.span;
    if (!L) return ts;
    const len = L.to - L.from;
    return ts >= L.to ? ts - Math.floor((ts - L.from) / len) * len : ts;
  }

  private startWarm() {
    if (!this.info || this.failure) return;
    if (this.coldTimer) {
      clearTimeout(this.coldTimer);
      this.coldTimer = null;
    }
    send({ op: "warm", id: this.id, t: this.T, loop: this.span });
    this.sent = { t: this.T, at: performance.timeOrigin + performance.now(), rate: 0, loop: this.loopKey };
  }

  setWarm(warm: boolean) {
    if (this.warm === warm || this.disposed) return;
    this.warm = warm;
    if (import.meta.env.DEV) this.note(`setWarm ${warm} T=${this.T.toFixed(3)}`);
    if (warm) {
      this.startWarm();
      return;
    }
    send({ op: "release", id: this.id });
    this.sent = null;
    this.playing = false;
    this.prevTime = null;
    for (const x of this.frames) x.f.close();
    this.frames = [];
    this.sound.stop();
    // The last picture stays a while (a clip that held its end can still be shown while the next one starts),
    // then goes: a cold clip holds no frame.
    this.coldTimer = setTimeout(() => {
      this.coldTimer = null;
      if (!this.warm && this.cur && this.curUploaded) {
        this.cur.f.close();
        this.cur = null;
        this.texture.image = {} as HTMLVideoElement;
      }
    }, 3000);
  }

  receive(ts: number, f: VideoFrame) {
    if (this.disposed || !this.warm) {
      f.close();
      return;
    }
    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1].ts > ts) i--;
    this.frames.splice(i, 0, { ts, f });
    // Never more than a few: a page that is not syncing this clip must not pile frames up.
    while (this.frames.length > 8) {
      this.frames.shift()!.f.close();
      this.counters.skipped++;
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.sound.stop();
    this.post(this.T, 0, performance.timeOrigin + performance.now());
  }

  private post(t: number, rate: number, at: number, seek = false) {
    if (!this.info || this.failure) return;
    send({ op: "want", id: this.id, t, at, rate, loop: this.span, seek });
    this.sent = { t, at, rate, loop: this.loopKey };
  }

  /** Follow what the layer wants this frame (wallMs = the frame's wall time, the clock's now()). */
  sync(want: CodecWant, wallMs: number) {
    if (this.disposed || this.failure) return;
    const info = this.info;
    if (!info) return;
    if (!this.warm) return;
    const fps = info.fps || 24;
    const L: LoopSpan | null = !want.reverse && want.segment ? want.segment : !want.reverse && want.loop && want.loop > 0.1 ? { from: 0, to: want.loop } : null;
    const key = L ? `${L.from.toFixed(4)}:${L.to.toFixed(4)}` : "";
    if (key !== this.loopKey) {
      this.loopKey = key;
      this.span = L;
      this.prevTime = null;
    }
    const atEnd = !!want.once && want.time >= info.duration - 0.05;
    const play = want.play && !want.reverse && !atEnd;
    // Unwrapped time: a loop's second pass is len + t, so the decoder runs straight on across the wrap.
    let T = Math.max(0, want.time);
    if (L && play) {
      const len = L.to - L.from;
      if (this.prevTime !== null) {
        if (want.time < this.prevTime - len / 2) this.pass++;
        else if (want.time > this.prevTime + len / 2) this.pass = Math.max(0, this.pass - 1);
      } else this.pass = 0;
      this.prevTime = want.time;
      T = this.pass * len + want.time;
    } else {
      this.pass = 0;
      this.prevTime = null;
    }
    this.T = T;
    const rate = play ? Math.max(0.0625, Math.min(16, want.rate)) : 0;
    const s = this.sent;
    const predicted = s ? s.t + ((wallMs - s.at) / 1000) * s.rate : NaN;
    const jumped = !s || Math.abs(predicted - T) > 1.5 / fps;
    if (!s || s.loop !== key || s.rate !== rate || jumped || (rate > 0 && wallMs - s.at > 500)) {
      // A seek: the time went back, or far ahead. A small step ahead (a clip that comes up a little after its
      // stamped start, a page that was held) keeps what it has: those frames are still the ones coming next.
      const seek = jumped && !!s && (T < predicted - 1.5 / fps || T > predicted + 0.5);
      if (import.meta.env.DEV && (seek || !s || s.rate !== rate)) this.note(`want t=${T.toFixed(3)} rate=${rate} seek=${seek} predicted=${predicted.toFixed(3)} frames=${this.frames.map((x) => x.ts.toFixed(2)).join(",")} cur=${this.cur?.ts.toFixed(3)}`);
      if (seek) {
        // A seek or a scrub: frames sent for the old time are no use.
        for (const x of this.frames) x.f.close();
        this.frames = [];
      }
      this.post(T, rate, wallMs, seek);
    }
    this.playing = play;
    // The frame for now: the last one at or before T.
    let k = -1;
    for (let i = 0; i < this.frames.length; i++) if (this.frames[i].ts <= T + 0.002) k = i;
    if (k >= 0) {
      const pick = this.frames[k];
      for (let i = 0; i < k; i++) {
        this.frames[i].f.close();
        this.counters.skipped++;
      }
      this.frames.splice(0, k + 1);
      if (this.cur) this.cur.f.close();
      this.cur = pick;
      this.texture.image = pick.f as unknown as HTMLVideoElement;
      this.texture.needsUpdate = true;
      this.curUploaded = false;
      this.counters.shown++;
    }
    const off = this.cur ? T - this.cur.ts : Infinity;
    this.waiting = !this.cur || Math.abs(off) > 1.5 / fps;
    // Late: a frame on screen older than the clock's (before the first frame of a clip arrives, nothing is late yet).
    if (play && this.cur && off > 1.5 / fps) this.counters.late++;
    if (play && this.cur) this.counters.lagMax = Math.max(this.counters.lagMax, off);
    if (import.meta.env.DEV && play && off > 0.2 && this.cur) this.note(`lag ${off.toFixed(3)} T=${T.toFixed(3)} cur=${this.cur?.ts.toFixed(3)} frames=${this.frames.map((x) => x.ts.toFixed(2)).join(",")}`);
    this.sound.sync(play, T, rate, want.muted, want.volume, !!want.local, L);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.coldTimer) clearTimeout(this.coldTimer);
    players.delete(this.id);
    send({ op: "close", id: this.id });
    for (const x of this.frames) x.f.close();
    this.frames = [];
    this.cur?.f.close();
    this.cur = null;
    this.sound.drop();
    this.texture.image = {} as HTMLVideoElement;
    this.texture.dispose();
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __slsCodec?: unknown }).__slsCodec = { players };

/** WebCodecs players in this window, and how many are warm (diagnostics). */
export function codecPlayerCount(): { total: number; warm: number } {
  let warm = 0;
  for (const p of players.values()) if (p.isWarm) warm++;
  return { total: players.size, warm };
}

/** Per playing (or restarted) player since the last call: what the heartbeat reports. */
export function takeCodecStats(): { player: CodecPlayer; c: Counters }[] {
  const out: { player: CodecPlayer; c: Counters }[] = [];
  for (const p of players.values()) {
    const c = p.takeCounters();
    if (p.isPlaying || c.shown || c.worker?.playingRestarts) out.push({ player: p, c });
  }
  return out;
}

export { fileName as codecFileName };
