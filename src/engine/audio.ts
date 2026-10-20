// Program audio: thunder for lightning strikes and sound cues (a re-fired sound replaces itself). Runs only in
// the window that is the audio host so sound is never doubled between operator and output.

import { now } from "@/core/clock";
import { num, str } from "@/core/effects";
import type { LightningStrike, SoundEvent } from "@/core/types";
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
 */
const cueSounds = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; volume: number; runKey: string; keepPlaying: boolean }>();

/** Mixer key of a cue sound (see ProgramState.mix). */
export const soundMixKey = (assetId: string) => `sound:${assetId}`;

/** The live mixer moved: glide each playing cue sound to its new level. */
function applyMix() {
  const ac = audio();
  for (const [key, s] of cueSounds) s.gain.gain.setTargetAtTime(s.volume * mixLevel(soundMixKey(key)), ac.currentTime, 0.05);
}

function fadeOutCueSound(key: string, seconds: number) {
  const s = cueSounds.get(key);
  if (!s) return;
  cueSounds.delete(key);
  const ac = audio();
  s.gain.gain.cancelScheduledValues(ac.currentTime);
  s.gain.gain.setValueAtTime(s.gain.gain.value, ac.currentTime);
  s.gain.gain.linearRampToValueAtTime(0.0001, ac.currentTime + seconds);
  s.src.stop(ac.currentTime + seconds + 0.05);
}

/** A sound cue with `fadeOthers` started: fade the other cue sounds it names (or all of them) from `when`. */
function fadeOthersFor(ev: SoundEvent, when: number) {
  const f = ev.fadeOthers;
  if (!f) return;
  const ac = audio();
  const start = Math.max(ac.currentTime, when);
  const secs = Math.max(0.05, f.fade);
  for (const [key, s] of [...cueSounds]) {
    if (key === ev.assetId || (f.which !== "all" && !f.which.includes(soundMixKey(key)))) continue;
    cueSounds.delete(key);
    s.gain.gain.cancelScheduledValues(ac.currentTime);
    s.gain.gain.setValueAtTime(s.gain.gain.value, start);
    s.gain.gain.linearRampToValueAtTime(0.0001, start + secs);
    s.src.stop(start + secs + 0.05);
  }
}

/** A new scene run took the wall: the previous runs' sounds fade out, unless marked to keep playing. */
function stopSoundsOfOtherRuns(runKey: string | null, seconds = 0.8) {
  for (const [key, s] of [...cueSounds]) if (s.runKey !== runKey && !s.keepPlaying) fadeOutCueSound(key, seconds);
}

async function playCueSound(key: string, url: string, when: number, volume: number, runKey: string, keepPlaying: boolean) {
  const ac = audio();
  const buf = await loadBuffer(url);
  const start = Math.max(ac.currentTime, when);
  const old = cueSounds.get(key);
  if (old) {
    old.gain.gain.cancelScheduledValues(ac.currentTime);
    old.gain.gain.setValueAtTime(old.gain.gain.value, start);
    old.gain.gain.linearRampToValueAtTime(0.0001, start + 0.15);
    old.src.stop(start + 0.2);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const gain = ac.createGain();
  gain.gain.value = volume * mixLevel(soundMixKey(key));
  src.connect(gain).connect(ac.destination);
  src.onended = () => {
    if (cueSounds.get(key)?.src === src) cueSounds.delete(key);
  };
  src.start(start);
  cueSounds.set(key, { src, gain, volume, runKey, keepPlaying });
}

/** Asset ids of the cue sounds playing now (diagnostics for the output heartbeat). */
export function playingCueSounds(): string[] {
  return [...cueSounds.keys()];
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
  // Events that existed before this window started are history, not new sounds.
  const rt0 = useShow.getState().program.runtime;
  for (const s of rt0?.strikes ?? []) heard.add(s.id);
  for (const s of rt0?.sounds ?? []) heard.add(s.id);

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

  const handleSounds = (sounds: SoundEvent[]) => {
    const s = useShow.getState();
    const rt = s.program.runtime;
    if (!rt) return;
    for (const ev of sounds) {
      if (heard.has(ev.id)) continue;
      heard.add(ev.id);
      if (!isHost()) continue;
      const wallAt = rt.clock.base + ev.at;
      if (now() - wallAt > 1500) continue;
      const asset = s.assets.find((a) => a.id === ev.assetId);
      if (!asset) continue;
      const ac = audio();
      fadeOthersFor(ev, ac.currentTime + Math.max(0, (wallAt - now()) / 1000));
      void playCueSound(asset.id, asset.url, ac.currentTime + Math.max(0, (wallAt - now()) / 1000), ev.volume, rt.key, !!ev.keepPlaying).catch((e) => console.warn("sound failed", e));
    }
  };

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

  return useShow.subscribe((s, prev) => {
    const ann = s.program.announce;
    if (ann && ann !== prev.program.announce) handleAnnounce(ann);
    const runKey = s.program.runtime?.key ?? null;
    if (runKey !== (prev.program.runtime?.key ?? null)) stopSoundsOfOtherRuns(runKey);
    if (s.program.mix !== prev.program.mix) applyMix();
    const a = s.program.runtime?.strikes;
    if (a && a !== prev.program.runtime?.strikes) handleStrikes(a);
    const b = s.program.runtime?.sounds;
    if (b && b !== prev.program.runtime?.sounds) handleSounds(b);
  });
}

/** Browsers need a user gesture before audio can start. */
export function unlockAudio() {
  try {
    audio();
  } catch {
    /* ignore */
  }
}
