// Preview sound, for rehearsing in Build mode: the preview scene's cue sounds, played on this
// computer's own speakers (the system default output, never the show's audio device), so the
// timeline plays back with its music. Nothing is kept per frame: whenever the preview's clock or
// its sounds change, what should be sounding is worked out again from the sound events and the
// scene clock (core/music.ts soundLives, the rules the wall plays by), so a scrub, hold or resume
// puts every sound where the clock says it is.

import { sceneNow } from "@/core/clock";
import { filePos, soundLives, type SoundLife } from "@/core/music";
import { useSyncExternalStore } from "react";
import { useShow } from "@/store/show";

let ctx: AudioContext | null = null;
function audio(): AudioContext {
  // Not registered with the output router: it stays on the computer's default output.
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
function load(url: string): Promise<AudioBuffer | null> {
  if (!loading.has(url)) {
    const p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => audio().decodeAudioData(b))
      .then((buf) => (buffers.set(url, buf), buf))
      .catch((e) => (console.warn("preview sound failed", url, e), null));
    loading.set(url, p);
  }
  return loading.get(url)!;
}

interface Voice {
  evId: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  fadeFrom: number | null;
}
/** Playing now, one per sound file (as on the wall). */
const voices = new Map<string, Voice>();

function silence(key: string, seconds = 0.05) {
  const v = voices.get(key);
  if (!v) return;
  voices.delete(key);
  const ac = audio();
  v.gain.gain.cancelScheduledValues(ac.currentTime);
  v.gain.gain.setValueAtTime(v.gain.gain.value, ac.currentTime);
  v.gain.gain.linearRampToValueAtTime(0.0001, ac.currentTime + seconds);
  v.src.stop(ac.currentTime + seconds + 0.02);
}

function silenceAll() {
  for (const key of [...voices.keys()]) silence(key);
}

/** Ramp a voice down from its life's fade, given the scene is at `t` (ms) now. */
function scheduleFade(v: Voice, l: SoundLife, t: number) {
  if (l.fadeFrom === null || v.fadeFrom === l.fadeFrom) return;
  const ac = audio();
  const into = (t - l.fadeFrom) / 1000;
  const from = ac.currentTime + Math.max(0, -into);
  const left = Math.max(0.02, l.fadeSecs - Math.max(0, into));
  const level = into > 0 ? Math.max(0.0001, l.ev.volume * (1 - into / l.fadeSecs)) : l.ev.volume;
  v.gain.gain.cancelScheduledValues(ac.currentTime);
  v.gain.gain.setValueAtTime(level, from);
  v.gain.gain.linearRampToValueAtTime(0.0001, from + left);
  v.src.stop(from + left + 0.05);
  v.fadeFrom = l.fadeFrom;
}

let enabled = true;
/** Build mode is open (startPreviewAudio is following the preview). */
let active = false;
const heardListeners = new Set<() => void>();
const heardChanged = () => heardListeners.forEach((f) => f());

/**
 * The preview is heard: Build mode is open and its speaker is on. The preview canvas then plays its
 * videos' and clips' own sound too (Goliath's lines), on this computer's default output like the cue sounds.
 */
export function usePreviewHeard(): boolean {
  return useSyncExternalStore(
    (f) => (heardListeners.add(f), () => heardListeners.delete(f)),
    () => active && enabled,
  );
}
let last: { key: string; base: number; paused: boolean } | null = null;
let generation = 0;

function sync() {
  const rt = useShow.getState().preview;
  const gen = ++generation;
  if (!enabled || !rt || rt.clock.pausedAt !== null) {
    silenceAll();
    last = rt ? { key: rt.key, base: rt.clock.base, paused: rt.clock.pausedAt !== null } : null;
    return;
  }
  // A scrub or a resume moves the clock: every sound starts again where it now is. A new run (the
  // next scene) keeps what it carries on with: the same events, already in step (core/music.ts carriedSounds).
  const moved = !last || (last.key === rt.key && (last.base !== rt.clock.base || last.paused)) || (last.key !== rt.key && last.paused);
  last = { key: rt.key, base: rt.clock.base, paused: false };
  if (moved) silenceAll();
  const assets = useShow.getState().assets;
  const t = sceneNow(rt);
  // Each file's latest start (a later copy replaces it); a fade already over is nothing to play.
  const want = new Map<string, SoundLife>();
  for (const l of soundLives(rt.sounds ?? [])) want.set(l.ev.assetId, l);
  for (const [key, l] of [...want]) if (l.fadeFrom !== null && t >= l.fadeFrom + l.fadeSecs * 1000) want.delete(key);
  for (const [key, v] of [...voices]) if (want.get(key)?.ev.id !== v.evId) silence(key, 0.15);
  for (const [key, l] of want) {
    const have = voices.get(key);
    if (have) {
      scheduleFade(have, l, t);
      continue;
    }
    const url = assets.find((a) => a.id === key)?.url;
    if (!url) continue;
    const buf = buffers.get(url);
    if (!buf) {
      // Decode first, then work it out again (the clock has moved on by then).
      void load(url).then((b) => b && gen === generation && sync());
      continue;
    }
    const pos = filePos(l.ev, t, buf.duration);
    if (pos >= buf.duration && !l.ev.loop) continue;
    const ac = audio();
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = !!l.ev.loop;
    const gain = ac.createGain();
    const at = ac.currentTime + Math.max(0, -pos);
    // A fade-in that is still under way carries on from where it is.
    const fadeIn = l.ev.fadeIn ?? 0;
    const inLeft = fadeIn - Math.max(0, pos);
    if (fadeIn > 0 && inLeft > 0) {
      gain.gain.setValueAtTime(Math.max(0.0001, l.ev.volume * (1 - inLeft / fadeIn)), at);
      gain.gain.linearRampToValueAtTime(l.ev.volume, at + inLeft);
    } else gain.gain.value = l.ev.volume;
    src.connect(gain).connect(ac.destination);
    src.start(at, Math.max(0, pos));
    const v: Voice = { evId: l.ev.id, src, gain, fadeFrom: null };
    src.onended = () => {
      if (voices.get(key) === v) voices.delete(key);
    };
    voices.set(key, v);
    scheduleFade(v, l, t);
  }
}

/** Hear the preview's sounds or not (the timeline's speaker button). */
export function setPreviewSound(on: boolean) {
  enabled = on;
  heardChanged();
  sync();
}

/** Follow the preview while Build mode is open; returns the stop function. */
export function startPreviewAudio(): () => void {
  active = true;
  heardChanged();
  sync();
  // Coalesced: a take sets the new run and then its carried sounds, and should be heard as one change.
  let queued = false;
  const off = useShow.subscribe((s, prev) => {
    const a = s.preview;
    const b = prev.preview;
    if (a === b || queued) return;
    if (!a || !b || a.key !== b.key || a.clock !== b.clock || a.sounds !== b.sounds) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        sync();
      });
    }
  });
  return () => {
    off();
    active = false;
    heardChanged();
    generation++;
    silenceAll();
    last = null;
  };
}
