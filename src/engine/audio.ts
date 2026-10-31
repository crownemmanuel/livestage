// Program audio: thunder for lightning strikes and sound cues (a re-fired sound replaces itself). Runs only in
// the window that is the audio host so sound is never doubled between operator and output.

import { now, sceneNow } from "@/core/clock";
import { num, str } from "@/core/effects";
import { lifeAudible, scheduleLevels, soundKey, soundLives, type SoundLife } from "@/core/music";
import type { LightningStrike, SceneRuntime, SoundEvent, SoundLevel } from "@/core/types";
import { mixLevel, useShow } from "@/store/show";
import { registerAudioContext } from "./audioOutput";

let ctx: AudioContext | null = null;
function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    registerAudioContext(ctx);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function noiseBuffer(ac: AudioContext, seconds: number) {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise: integrate white noise for a low rumble
      b = (b + (Math.random() * 2 - 1) * 0.08) * 0.985;
      d[i] = b * 3 + (Math.random() * 2 - 1) * 0.15;
    }
  }
  return buf;
}

/** Synthesised thunder: a sharp crack (when close) followed by a rolling rumble. */
function synthThunder(when: number, volume: number, close: boolean) {
  const ac = audio();
  const dur = 4.5 + Math.random() * 2.5;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur);
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(close ? 1800 : 600, when);
  lp.frequency.exponentialRampToValueAtTime(120, when + dur * 0.6);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(volume * (close ? 1 : 0.7), when + (close ? 0.02 : 0.35));
  // rolling: a few swells as the sound reflects off the hills
  let t = when + 0.4;
  while (t < when + dur * 0.8) {
    g.gain.exponentialRampToValueAtTime(volume * (0.25 + Math.random() * 0.55), t);
    t += 0.3 + Math.random() * 0.7;
  }
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(lp).connect(g).connect(ac.destination);
  src.start(when);
  src.stop(when + dur + 0.1);
}

const fileCache = new Map<string, Promise<AudioBuffer>>();
function loadBuffer(url: string) {
  if (!fileCache.has(url)) {
    const p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => audio().decodeAudioData(b));
    p.catch(() => fileCache.delete(url));
    fileCache.set(url, p);
  }
  return fileCache.get(url)!;
}

/** Decode ahead of time so a cue's sound starts on the beat. */
export function preloadAudio(url: string) {
  void loadBuffer(url).catch(() => {});
}

async function playFile(url: string, when: number, volume: number) {
  const ac = audio();
  const buf = await loadBuffer(url);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  g.gain.value = volume;
  src.connect(g).connect(ac.destination);
  src.start(Math.max(ac.currentTime, when));
}

/**
 * Cue sounds playing now, one per sound file. Firing the same sound again (re-firing its cue or
 * re-taking the scene) replaces the copy already playing instead of stacking another on top.
 *
 * A cue sound follows the live scene's clock like its videos do: Hold silences it where it is,
 * resume carries on from there, and a scrub moves it with the picture. Held, it has no source
 * node; `pos` is where it will carry on from.
 */
interface CueSound {
  buf: AudioBuffer;
  volume: number;
  runKey: string;
  keepPlaying: boolean;
  /** Starts again from the top (its trimStart) when it ends (a music bed). */
  loop: boolean;
  /** Seconds cut off the top of the file: it plays from here (see the sound action). */
  trim: number;
  /** Seconds it fades out over before the file ends (0 = none). */
  fadeOut: number;
  /** Its level changes as it plays (a duck), on a gain of their own ahead of `gain`. */
  levels?: SoundLevel[];
  /** Scene time (ms) of its run when it started. */
  at: number;
  /** Seconds into the file at context time `ctx0` (less than `trim`: starts that much later). */
  pos: number;
  ctx0: number;
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
}
const cueSounds = new Map<string, CueSound>();

/** Mixer key of a cue sound (see ProgramState.mix). */
export const soundMixKey = soundKey;

/** The live mixer moved: glide each playing cue sound to its new level. */
function applyMix() {
  const ac = audio();
  for (const [key, s] of cueSounds) s.gain?.gain.setTargetAtTime(s.volume * mixLevel(soundMixKey(key)), ac.currentTime, 0.05);
}

/** A position past the end of a looping sound, wrapped back to where its loop starts. */
const wrap = (s: CueSound, pos: number) => (s.loop && pos > s.trim && s.buf.duration > s.trim ? s.trim + ((pos - s.trim) % (s.buf.duration - s.trim)) : pos);

/** Seconds into the file now. */
function soundPos(s: CueSound, ac: AudioContext) {
  return wrap(s, s.src ? s.pos + (ac.currentTime - s.ctx0) : s.pos);
}

/** Fade the playing node out over `seconds` from `delay` seconds on; the sound itself is kept. */
function stopNode(s: CueSound, seconds: number, delay = 0) {
  if (!s.src || !s.gain) return;
  const ac = audio();
  const from = ac.currentTime + delay;
  s.gain.gain.cancelScheduledValues(ac.currentTime);
  s.gain.gain.setValueAtTime(s.gain.gain.value, from);
  s.gain.gain.linearRampToValueAtTime(0.0001, from + seconds);
  s.src.stop(from + seconds + 0.05);
  s.src = s.gain = null;
}

/** Play the sound from `pos` seconds into the file (less than its trim: from the trim, after that many seconds). */
function startNode(key: string, s: CueSound, pos: number, fadeIn = 0) {
  const ac = audio();
  const src = ac.createBufferSource();
  src.buffer = s.buf;
  src.loop = s.loop;
  if (s.loop && s.trim > 0) {
    src.loopStart = s.trim;
    src.loopEnd = s.buf.duration;
  }
  // Seconds since it started (before wrapping a loop): its level changes are timed from there.
  const since = pos - s.trim;
  pos = wrap(s, pos);
  const gain = ac.createGain();
  const level = s.volume * mixLevel(soundMixKey(key));
  const at = ac.currentTime + Math.max(0, s.trim - pos);
  const from = Math.max(s.trim, pos);
  if (fadeIn > 0) {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(level, at + fadeIn);
  } else gain.gain.value = level;
  // Its own fade-out into the end of the file (a fade already under way picks up where it is).
  if (s.fadeOut > 0 && !s.loop) {
    const left = s.buf.duration - from;
    const into = s.fadeOut - left;
    const start = at + Math.max(0, -into);
    gain.gain.setValueAtTime(into > 0 ? Math.max(0.0001, level * (1 - into / s.fadeOut)) : level, Math.max(start, at + Math.max(0, fadeIn)));
    gain.gain.linearRampToValueAtTime(0.0001, at + left);
  }
  if (s.levels?.length) {
    const env = ac.createGain();
    scheduleLevels(env.gain, s.levels, since, ac.currentTime);
    src.connect(env).connect(gain).connect(ac.destination);
  } else src.connect(gain).connect(ac.destination);
  src.onended = () => {
    if (cueSounds.get(key)?.src === src) cueSounds.delete(key);
  };
  src.start(at, from);
  s.src = src;
  s.gain = gain;
  s.pos = pos;
  s.ctx0 = ac.currentTime;
}

function fadeOutCueSound(key: string, seconds: number) {
  const s = cueSounds.get(key);
  if (!s) return;
  cueSounds.delete(key);
  stopNode(s, seconds);
}

/** A sound cue with `fadeOthers` started: fade the other cue sounds it names (or all of them) from `when`. */
function fadeOthersFor(ev: SoundEvent, when: number, runKey: string) {
  const f = ev.fadeOthers;
  if (!f) return;
  const ac = audio();
  const delay = Math.max(0, when - ac.currentTime) + Math.max(0, f.delay ?? 0);
  const secs = Math.max(0.05, f.fade);
  for (const [key, s] of [...cueSounds]) {
    if (key === ev.assetId || (f.which !== "all" && !f.which.includes(soundMixKey(key)))) continue;
    // Only sound already playing when the fade begins (one queued to start after it plays on).
    if (s.runKey === runKey && s.at > ev.at + Math.max(0, f.delay ?? 0) * 1000) continue;
    cueSounds.delete(key);
    stopNode(s, secs, delay);
  }
}

/**
 * A new scene run took the wall: the previous runs' sounds fade out, unless marked to keep playing.
 * A scene set to stop carried sounds (`stopCarriedSounds`) fades those out too, over `carriedFade` seconds;
 * a TAKE that does not carry the story on (a retake or a jump, see ProgramState.continues) fades them
 * out as quickly as the rest.
 */
function stopSoundsOfOtherRuns(runKey: string | null, stopCarried = false, seconds = 0.8, carriedFade = 3) {
  for (const [key, s] of [...cueSounds]) {
    if (s.runKey === runKey) continue;
    if (!s.keepPlaying) fadeOutCueSound(key, seconds);
    else if (stopCarried) fadeOutCueSound(key, carriedFade);
  }
}

/** The live clock as last seen (it arrives over the bus, so it is compared by value). */
let lastClock: { key: string; base: number; pausedAt: number | null } | null = null;

/**
 * The live scene was held, resumed or scrubbed: hold, resume or move its sounds with it. A sound
 * of its own run sits where the scene clock says; one carried over from an earlier scene
 * (keepPlaying) holds and resumes with the wall and moves by as much as the scrub moved it.
 */
function followClock(rt: SceneRuntime | null) {
  if (!rt) {
    lastClock = null;
    return;
  }
  const c = rt.clock;
  const prev = lastClock;
  lastClock = { key: rt.key, base: c.base, pausedAt: c.pausedAt };
  const held = c.pausedAt !== null;
  const ac = audio();
  if (prev?.key !== rt.key) {
    // A new run took the wall: carried-over sounds go on with it (or stay held if it starts held).
    for (const [key, s] of cueSounds) {
      if (held && s.src) {
        s.pos = soundPos(s, ac);
        stopNode(s, 0.06);
      } else if (!held && !s.src) startNode(key, s, s.pos, 0.03);
    }
    return;
  }
  if (prev.base === c.base && prev.pausedAt === c.pausedAt) return;
  const t = now();
  // How far the scene jumped (a scrub); a hold or a resume alone moves it by nothing.
  const jump = (c.pausedAt ?? t) - c.base - ((prev.pausedAt ?? t) - prev.base);
  for (const [key, s] of [...cueSounds]) {
    const pos = s.runKey === rt.key ? (sceneNow(rt, t) - s.at) / 1000 + s.trim : soundPos(s, ac) + jump / 1000;
    stopNode(s, 0.06);
    if (pos >= s.buf.duration && !s.loop) {
      cueSounds.delete(key);
      continue;
    }
    if (held) s.pos = pos;
    else startNode(key, s, pos, 0.03);
  }
}

/** Fade-in (s) of a sound that starts part-way through: the music chase, or music brought back after a restart. */
const RESUME_FADE = 0.5;

/**
 * Start a cue sound. `resume` (a chased or carried sound, or one this host missed: it restarted, or took over):
 * start where the scene clock says it is, however late, with a short fade-in, and carry out a fade-out that is
 * already due (`resume.fadeFrom`, scene ms).
 */
async function playCueSound(key: string, url: string, ev: SoundEvent, runKey: string, wallAt: number, resume?: SoundLife) {
  const buf = await loadBuffer(url);
  const rt = useShow.getState().program.runtime;
  const own = rt?.key === runKey;
  // Its scene was replaced while the file loaded.
  if (!own && !ev.keepPlaying) return;
  const trim = Math.min(Math.max(0, ev.trimStart ?? 0), buf.duration);
  // Seconds since it started; the file is `trim` further in.
  let since = own ? (sceneNow(rt!) - ev.at) / 1000 : (now() - wallAt) / 1000;
  let at = ev.at;
  // A little late (still decoding): start from the top rather than cut its first words.
  if (!resume && since > 0 && since < 1.5) {
    at += since * 1000;
    since = 0;
  }
  const pos = since + trim;
  const old = cueSounds.get(key);
  if (old) stopNode(old, 0.15, Math.max(0, -since));
  cueSounds.delete(key);
  if (pos >= buf.duration && !ev.loop) return;
  const s: CueSound = { buf, volume: ev.volume, runKey, keepPlaying: !!ev.keepPlaying, loop: !!ev.loop, trim, fadeOut: Math.max(0, ev.fadeOut ?? 0), levels: ev.levels, at, pos, ctx0: 0, src: null, gain: null };
  cueSounds.set(key, s);
  // A fade-in already under way when the file is ready picks up where it should be.
  let fadeIn = ev.fadeIn ? Math.max(0, ev.fadeIn - Math.max(0, since)) : 0;
  if (resume && since > 0) fadeIn = Math.max(fadeIn, RESUME_FADE);
  if (rt?.clock.pausedAt == null) startNode(key, s, pos, fadeIn);
  if (resume?.fadeFrom != null && own) {
    const t = sceneNow(rt!);
    const left = resume.fadeFrom + resume.fadeSecs * 1000 - Math.max(t, resume.fadeFrom);
    cueSounds.delete(key);
    stopNode(s, Math.max(0.05, left / 1000), Math.max(0, (resume.fadeFrom - t) / 1000));
  }
}

/** Asset ids of the cue sounds playing now (diagnostics for the output heartbeat). */
export function playingCueSounds(): string[] {
  return [...cueSounds.keys()];
}

/** Seconds into each playing cue sound's file, as the speakers have it (diagnostics). */
export function cueSoundPositions(): Record<string, number> {
  const ac = audio();
  return Object.fromEntries([...cueSounds].map(([k, s]) => [k, Math.round(soundPos(s, ac) * 100) / 100]));
}

/** Of those, the ones silent while the live scene is held. */
export function heldCueSounds(): string[] {
  return [...cueSounds].filter(([, s]) => !s.src).map(([k]) => k);
}

/** The announcement on the speakers now (one at a time). */
let announcing: { key: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;

function fadeOutAnnouncement(seconds = 0.8) {
  const a = announcing;
  if (!a) return;
  announcing = null;
  const ac = audio();
  a.gain.gain.cancelScheduledValues(ac.currentTime);
  a.gain.gain.setValueAtTime(a.gain.gain.value, ac.currentTime);
  a.gain.gain.linearRampToValueAtTime(0.0001, ac.currentTime + seconds);
  a.src.stop(ac.currentTime + seconds + 0.05);
}

async function startAnnouncement(key: string, url: string, volume: number) {
  fadeOutAnnouncement(0.3);
  const ac = audio();
  const buf = await loadBuffer(url);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const gain = ac.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ac.destination);
  src.onended = () => {
    if (announcing?.src === src) announcing = null;
  };
  src.start();
  announcing = { key, src, gain };
}

export function startProgramAudio(isHost: () => boolean): () => void {
  const heard = new Set<string>();
  // Thunder that struck before this window started is history.
  const rt0 = useShow.getState().program.runtime;
  for (const s of rt0?.strikes ?? []) heard.add(s.id);

  const handleStrikes = (strikes: LightningStrike[]) => {
    const s = useShow.getState();
    const rt = s.program.runtime;
    if (!rt) return;
    for (const st of strikes) {
      if (heard.has(st.id)) continue;
      heard.add(st.id);
      if (!isHost() || !st.thunder) continue;
      const fx = rt.scene.components.find((c) => c.kind === "effect" && c.effect === "lightning");
      const params = (fx && rt.effects[fx.id]?.params) || {};
      const ac = audio();
      const wallAt = rt.clock.base + st.at + st.thunderDelay * 1000;
      const when = ac.currentTime + Math.max(0, (wallAt - now()) / 1000);
      if (now() - wallAt > 1500) continue; // too late to be believable
      const vol = num(params, "thunderVolume", 0.9) * Math.min(1.2, st.brightness);
      const file = str(params, "thunderAssetId");
      const asset = file ? s.assets.find((a) => a.id === file) : undefined;
      if (asset) void playFile(asset.url, when, vol);
      else synthThunder(when, vol, st.thunderDelay < 0.6);
    }
  };

  /**
   * Cue sounds this host has not played yet. One fired a moment ago starts as designed. One from before (this
   * window restarted, the live state was restored, or this window just became the audio host), or one the music
   * chase or a TAKE handed over part-way, comes back where it would be now if it is still sounding: music resumes
   * at the right second rather than being lost or starting over.
   */
  const handleSounds = (sounds: SoundEvent[]) => {
    const s = useShow.getState();
    const rt = s.program.runtime;
    if (!rt || !isHost()) return;
    const t = sceneNow(rt);
    let lives: Map<SoundEvent, SoundLife> | null = null;
    for (const ev of sounds) {
      if (heard.has(ev.id)) continue;
      // A window just (re)opened may have the live state before the media library: try again when it comes.
      if (ev.assetId && !s.assets.some((a) => a.id === ev.assetId)) continue;
      heard.add(ev.id);
      // Judged on the scene clock: a sound fired while the scene is held waits for the resume.
      const late = t - ev.at > 1500;
      const wallAt = rt.clock.base + ev.at;
      // Fades others as it starts (a chase's stop has no file and only does this); one from before has done so.
      if (!late && !ev.chase) fadeOthersFor(ev, audio().currentTime + Math.max(0, (wallAt - now()) / 1000), rt.key);
      const asset = ev.assetId ? s.assets.find((a) => a.id === ev.assetId) : undefined;
      if (!asset) continue;
      if (!late && !ev.chase) {
        void playCueSound(asset.id, asset.url, ev, rt.key, wallAt).catch((e) => console.warn("sound failed", e));
        continue;
      }
      lives ??= new Map(soundLives(rt.sounds ?? []).map((l) => [l.ev, l]));
      const life = lives.get(ev);
      if (!life || !lifeAudible(life, t)) continue;
      void playCueSound(asset.id, asset.url, ev, rt.key, wallAt, life).catch((e) => console.warn("sound failed", e));
    }
  };

  /** Hand over: a window that stops being the audio host lets its sounds go, so they are never doubled. */
  let wasHost = isHost();
  const checkHost = () => {
    const host = isHost();
    if (host === wasHost) return;
    wasHost = host;
    const rt = useShow.getState().program.runtime;
    if (host) {
      if (rt?.sounds) handleSounds(rt.sounds);
      return;
    }
    for (const key of [...cueSounds.keys()]) fadeOutCueSound(key, 0.5);
    for (const ev of rt?.sounds ?? []) heard.delete(ev.id);
  };
  const hostTick = setInterval(checkHost, 500);
  // Whatever is already playing when this window starts comes back now.
  if (rt0?.sounds) handleSounds(rt0.sounds);

  // An announcement already under way when this window started is not replayed.
  const ann0 = useShow.getState().program.announce;
  if (ann0) heard.add(ann0.key);

  const handleAnnounce = (a: NonNullable<ReturnType<typeof useShow.getState>["program"]["announce"]>) => {
    if (a.stoppedAt) {
      if (announcing?.key === a.key) fadeOutAnnouncement();
      return;
    }
    if (heard.has(a.key)) return;
    heard.add(a.key);
    if (!isHost() || now() - a.at > 2000) return;
    const asset = useShow.getState().assets.find((x) => x.id === a.assetId);
    if (asset) void startAnnouncement(a.key, asset.url, a.volume).catch((e) => console.warn("announcement failed", e));
  };

  const unsub = useShow.subscribe((s, prev) => {
    checkHost();
    const ann = s.program.announce;
    if (ann && ann !== prev.program.announce) handleAnnounce(ann);
    const runKey = s.program.runtime?.key ?? null;
    if (runKey !== (prev.program.runtime?.key ?? null)) {
      if (!s.program.continues) stopSoundsOfOtherRuns(runKey, true, 0.8, 0.8);
      else stopSoundsOfOtherRuns(runKey, !!s.program.runtime?.scene.stopCarriedSounds);
    }
    if (s.program.runtime !== prev.program.runtime) followClock(s.program.runtime);
    if (s.program.mix !== prev.program.mix) applyMix();
    const a = s.program.runtime?.strikes;
    if (a && a !== prev.program.runtime?.strikes) handleStrikes(a);
    const b = s.program.runtime?.sounds;
    if (b && (b !== prev.program.runtime?.sounds || s.assets !== prev.assets)) handleSounds(b);
  });
  return () => {
    unsub();
    clearInterval(hostTick);
  };
}

/** Browsers need a user gesture before audio can start. */
export function unlockAudio() {
  try {
    audio();
  } catch {
    /* ignore */
  }
}
