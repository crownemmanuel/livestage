// Messages between a window's WebCodecs players (codecVideo.ts) and its decoder worker (decoder.worker.ts).
// Times are seconds of media. A looping clip's times run on across its loop ("unwrapped"): its second pass
// over [from, to) is (to - from) + t, so a frame's time never repeats and the loop needs no seek.

export interface LoopSpan {
  from: number;
  to: number;
}

export type ToWorker =
  /** Read the file's index (no decoding yet). `audio`: also extract its sound for decodeAudioData. */
  | { op: "open"; id: number; url: string }
  /** Decode the GOP around `t` and hold it, ready to start at once (a warm clip). */
  | { op: "warm"; id: number; t: number; loop: LoopSpan | null }
  /**
   * The clock: media time `t` at wall time `at` (ms, timeOrigin + now), moving at `rate` (0 = parked on `t`).
   * The worker runs on from it by itself, so it keeps decoding through a hold of the page. `seek`: the time
   * jumped and the page dropped the frames it had (a scrub, a seek): what was sent before is gone.
   */
  | { op: "want"; id: number; t: number; at: number; rate: number; loop: LoopSpan | null; seek?: boolean }
  /** Send the sound as ADTS (once per open). */
  | { op: "audio"; id: number }
  /** Let the decoder and its frames go; keep the index (a cold clip). */
  | { op: "release"; id: number }
  /** Forget the clip. */
  | { op: "close"; id: number };

export interface CodecInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  frames: number;
  codec: string;
  /** Longest GOP (s). */
  gop: number;
  /** The file has a sound track we can play (AAC), one we cannot, or none. */
  sound: "aac" | "other" | "none";
}

export interface CodecStats {
  /** GOPs decoded, and how long one took (feed to flush) on average and at worst (ms). */
  gops: number;
  gopMsAvg: number;
  gopMsMax: number;
  /** Decoding started again from a keyframe because the clock was somewhere not decoded (a seek, a jump). */
  restarts: number;
  /** ...while playing: each one a visible jump. */
  playingRestarts: number;
  /** Frames decoded but closed unseen because their time had passed. */
  stale: number;
  /** Most frames held decoded at once. */
  held: number;
  /** Slowest read of a GOP's bytes (ms). */
  readMsMax: number;
}

export type FromWorker =
  | ({ op: "info"; id: number } & CodecInfo)
  /** The file cannot be played this way (the player falls back to the platform's). */
  | { op: "refused"; id: number; reason: string }
  | { op: "frame"; id: number; ts: number; frame: VideoFrame }
  | { op: "audio"; id: number; adts: ArrayBuffer | null; start: number }
  /** A decoder error while playing (the player falls back). */
  | { op: "error"; id: number; error: string }
  | { op: "stats"; stats: Record<number, CodecStats> };
