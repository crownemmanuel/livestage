// Program audio: thunder for lightning strikes and one-shot sound cues. Runs only in
// the window that is the audio host so sound is never doubled between operator and output.

import { now } from "@/core/clock";
import { num, str } from "@/core/effects";
import type { LightningStrike, SoundEvent } from "@/core/types";
import { useShow } from "@/store/show";

let ctx: AudioContext | null = null;
function audio(): AudioContext {
  ctx ??= new AudioContext();
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
      void playFile(asset.url, ac.currentTime + Math.max(0, (wallAt - now()) / 1000), ev.volume).catch((e) => console.warn("sound failed", e));
    }
  };

  return useShow.subscribe((s, prev) => {
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
