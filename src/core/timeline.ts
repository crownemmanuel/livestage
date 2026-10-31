// The scene as a multi-track timeline: when each cue fires and what plays when, for the Build
// timeline and the agent's `timeline` command.
//
// Timed cues (scene time, follow, video marker) sit at their real times. A GO cue has no time
// until the operator presses GO, so it is drawn at its planned hold after the cue before it
// (`Cue.hold`, or a guess from how long that cue's content runs). Everything else follows from
// the cue starts with the engine's own rules: clips land on their next clean cut point and hand
// over to their pose's idle loop, one copy of a sound plays at a time, a sound can fade others as
// it starts, and a scene's sounds fade at the take unless they keep playing. Pure: no stores.

import { idleFor, initialSegments, scheduleClip } from "./clipActor";
import { EFFECT_DEFS } from "./effects";
import { LAYER_KINDS } from "./runtime";
import type { AudioRole, ClipActorComponent, ClipSegment, Cue, CueAction, CueFire, IoMessage, MediaMarker, Scene, SceneComponent, SoundLevel } from "./types";

export type TrackGroup = "picture" | "effects" | "camera" | "sound" | "outputs";
export type ItemTone = "picture" | "loop" | "held" | "effect" | "music" | "voice" | "ambience" | "sfx" | "sound" | "camera" | "light" | "show";

export interface TimelineCue {
  index: number;
  id: string;
  name: string;
  mode: CueFire["mode"];
  /** Scene seconds it fires at (planned for GO). Null when it cannot be placed (a video cue whose marker never plays). */
  start: number | null;
  /** GO only: planned seconds after the cue before, and whether the show file sets it (false = guessed). */
  hold?: number;
  holdSet?: boolean;
  /** GO only: the scene time the hold counts from (the cue before's start). */
  holdFrom?: number;
}

export interface TimelineItem {
  id: string;
  track: string;
  /** Row inside the track, when items overlap. */
  lane: number;
  start: number;
  /** Equal to start for a point (a trigger). */
  end: number;
  label: string;
  tone: ItemTone;
  /** The cue and action that put it there; null for what the scene starts with. */
  cue: number | null;
  action: number | null;
  componentId?: string;
  /** A media marker's point: the video it is on (a component id, or "component:clip" for a clip). */
  markerHost?: string;
  /** A clip that waited for a cut point: when it was asked for. */
  requested?: number;
  loop?: boolean;
  /** A sound whose length is not known yet. */
  open?: boolean;
  /** Playing when the scene was taken (from an earlier scene). */
  carriedIn?: boolean;
  /** Keeps playing into the next scene. */
  carriesOut?: boolean;
  /** It fades out from here to `end`. */
  fadeFrom?: number;
  /** A sound: seconds it fades in over from `start`. */
  fadeIn?: number;
  /** A sound: seconds cut off the top of its file (its left edge drags this). */
  trim?: number;
  /** A sound: its level changes, timed from `start`. */
  levels?: SoundLevel[];
  /** Scene times of markers inside it (lights, MIDI/OSC). */
  marks?: number[];
  /** The action that ends it, when one does (moving its end moves that action). */
  endBy?: EndRef;
  /** What dragging its end makes when no action ends it yet: a fade, a hide, a stop. */
  endable?: "sound" | "layer" | "effect";
  /** The mixer key of a sound (`sound:<assetId>`) or the component a layer / effect span belongs to. */
  key?: string;
  /** A sound that does not loop cannot run past its file. */
  naturalEnd?: number;
}

export interface EndRef {
  cue: number;
  action: number;
  /** fade: an audio.fade; fadeOthers: another sound starting; refire: the same sound fired again; hide / stop: a layer or effect action; restart: a layer restart. */
  kind: "fade" | "fadeOthers" | "refire" | "hide" | "stop" | "restart";
}

export interface TimelineTrack {
  id: string;
  label: string;
  group: TrackGroup;
  componentId?: string;
  lanes: number;
}

export interface SceneTimeline {
  cues: TimelineCue[];
  tracks: TimelineTrack[];
  items: TimelineItem[];
  /** Scene seconds the timeline runs to. */
  end: number;
  /** Scene seconds a take of another scene starts, if a cue takes one. */
  takeAt: number | null;
}

/** What the layout needs from outside: media lengths and names. */
export interface TimelineEnv {
  /** Seconds, once known. */
  duration(assetId: string | null | undefined): number | undefined;
  assetName(assetId: string): string;
  audioRole(assetId: string): AudioRole | null;
  describeMessage?(m: IoMessage): string;
  sceneName?(sceneId: string): string;
}

/** Shortest planned GO hold, when the cue before has nothing that runs on. */
export const MIN_HOLD = 3;
/** Drawn length of a sound whose file has not been measured yet. */
const OPEN_SOUND = 4;
/** A scene's own sounds fade out this long after another scene is taken (engine/audio.ts). */
const TAKE_FADE = 0.8;

const round = (n: number) => Math.round(n * 100) / 100;
const fireMode = (c: Cue): CueFire["mode"] => c.fire?.mode ?? "go";

/** Lay the scene out. */
export function sceneTimeline(scene: Scene, env: TimelineEnv): SceneTimeline {
  const starts: (number | null)[] = [];
  const cues: TimelineCue[] = [];
  const lastStart = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (starts[k] != null) return { k, at: starts[k]! };
    return null;
  };
  scene.cues.forEach((cue, i) => {
    const f = cue.fire;
    const tc: TimelineCue = { index: i, id: cue.id, name: cue.name, mode: fireMode(cue), start: null };
    if (f?.mode === "time") tc.start = Math.max(0, f.at);
    else if (f?.mode === "follow") {
      const prev = i > 0 ? starts[i - 1] : 0;
      tc.start = prev == null ? null : prev + Math.max(0, f.after);
    } else if (f?.mode === "video") {
      tc.start = markerStart(scene, cue.id, build(scene, starts, env));
    } else {
      const prev = lastStart(i);
      const from = prev?.at ?? 0;
      // Guess: until the cue before has run its course (the first GO: until the transition in has played).
      const intro = scene.transition.kind !== "cut" ? Math.max(0, scene.transition.duration) : 0;
      const ran = () => (prev ? cueExtent(build(scene, starts, env), prev.k, from) : intro);
      const guess = () => Math.max(MIN_HOLD, Math.ceil(ran() * 2) / 2);
      const set = typeof cue.hold === "number" && cue.hold >= 0;
      tc.hold = set ? cue.hold! : guess();
      tc.holdSet = set;
      tc.holdFrom = from;
      tc.start = from + tc.hold;
    }
    starts[i] = tc.start;
    cues.push(tc);
  });
  return { ...build(scene, starts, env), cues };
}

/** How long the content of cue `k` runs, from its start: not loops, and not music (a song runs under the action). */
function cueExtent(b: Built, k: number, from: number): number {
  let e = 0;
  for (const it of b.items) if (it.cue === k && !it.loop && it.tone !== "held" && it.tone !== "music") e = Math.max(e, it.end - from);
  return e;
}

/** When the marker that fires this cue is first played past, if it ever is. */
function markerStart(scene: Scene, cueId: string, b: Built): number | null {
  let best: number | null = null;
  const consider = (t: number) => (best = best == null ? t : Math.min(best, t));
  for (const c of scene.components) {
    if (c.kind === "clipActor") {
      for (const k of c.clips)
        for (const m of k.markers ?? []) {
          if (m.cueId !== cueId) continue;
          for (const it of b.items) if (it.componentId === c.id && it.clipId === k.id && it.start + m.at <= it.end) consider(it.start + m.at);
        }
    } else if (c.kind === "background" || c.kind === "video") {
      for (const m of c.media.markers ?? []) {
        if (m.cueId !== cueId) continue;
        const rate = c.media.playbackRate || 1;
        for (const it of b.items) if (it.componentId === c.id && it.end > it.start && it.start + m.at / rate <= it.end) consider(it.start + m.at / rate);
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- the build

interface Built {
  tracks: TimelineTrack[];
  items: (TimelineItem & { clipId?: string })[];
  end: number;
  takeAt: number | null;
}

interface Ev {
  t: number;
  cue: number;
  action: number;
  a: CueAction;
}

interface Seg extends ClipSegment {
  /** null = the actor was cleared. */
  clipId: string;
  cleared?: boolean;
  cue: number | null;
  action: number | null;
  requested?: number;
}

interface Span {
  start: number;
  end: number | null;
  cue: number | null;
  action: number | null;
  fadeFrom?: number;
  endBy?: EndRef;
}

interface Snd {
  assetId: string;
  start: number;
  end: number | null;
  fadeFrom?: number;
  loop: boolean;
  keep: boolean;
  cue: number | null;
  action: number | null;
  carried?: boolean;
  endBy?: EndRef;
  /** Seconds cut off the top of its file, its fade-in and its fade-out into the file's end (the sound action's). */
  trim?: number;
  fadeIn?: number;
  fadeOut?: number;
  levels?: SoundLevel[];
}

const SOUND_TRACK: Record<AudioRole | "none", { id: string; label: string; tone: ItemTone }> = {
  voice: { id: "sound:voice", label: "Voice", tone: "voice" },
  music: { id: "sound:music", label: "Music", tone: "music" },
  ambience: { id: "sound:ambience", label: "Ambience", tone: "ambience" },
  sfx: { id: "sound:sfx", label: "Sound effects", tone: "sfx" },
  none: { id: "sound:other", label: "Sound", tone: "sound" },
};

/** Run the cues that have a start through the engine's rules and lay out what they do. */
function build(scene: Scene, starts: (number | null)[], env: TimelineEnv): Built {
  const comp = new Map(scene.components.map((c) => [c.id, c]));
  const evs: Ev[] = [];
  scene.cues.forEach((cue, i) => {
    const s = starts[i];
    if (s == null) return;
    cue.actions.forEach((a, j) => evs.push({ t: s + Math.max(0, a.delay || 0), cue: i, action: j, a }));
  });
  evs.sort((x, y) => x.t - y.t || x.cue - y.cue || x.action - y.action);

  const items: Built["items"] = [];
  const point = (track: string, t: number, label: string, tone: ItemTone, e: Ev | null, componentId?: string) =>
    items.push({ id: "", track, lane: 0, start: t, end: t, label, tone, cue: e?.cue ?? null, action: e?.action ?? null, componentId });

  // State as the events play.
  const clips = new Map<string, Seg[]>();
  for (const c of scene.components) if (c.kind === "clipActor") clips.set(c.id, initialSegments(c).segments.map((s) => ({ ...s, cue: null, action: null })));
  const layers = new Map<string, { spans: Span[]; marks: number[] }>();
  for (const c of scene.components) if (LAYER_KINDS.has(c.kind)) layers.set(c.id, { spans: c.initiallyVisible ? [{ start: 0, end: null, cue: null, action: null }] : [], marks: [] });
  const bgs = scene.components.filter((c) => c.kind === "background");
  const bg0 = bgs.find((b) => b.initiallyVisible) ?? bgs[0];
  const bgSpans: (Span & { id: string })[] = bg0 ? [{ id: bg0.id, start: 0, end: null, cue: null, action: null }] : [];
  const effects = new Map<string, Span[]>();
  for (const c of scene.components)
    if (c.kind === "effect" && EFFECT_DEFS[c.effect]?.mode !== "trigger") effects.set(c.id, c.initiallyVisible && c.effect !== "daynight" ? [{ start: 0, end: null, cue: null, action: null }] : []);
  const sounds: Snd[] = [];
  let takeAt: number | null = null;
  let takeDur = 1;

  const openSpan = (spans: Span[]) => spans.length > 0 && spans[spans.length - 1].end == null;
  const fadeOf = (c: SceneComponent | undefined) => {
    if (c?.kind !== "effect") return 0;
    const p = { ...EFFECT_DEFS[c.effect]?.defaults, ...c.params };
    return Number(p.fadeOut ?? p.fade ?? 0) || 0;
  };

  for (const e of evs) {
    if (takeAt != null && e.t > takeAt) break;
    const a = e.a;
    const t = e.t;
    switch (a.type) {
      case "clip": {
        const c = comp.get(a.actorId);
        if (c?.kind !== "clipActor") break;
        const h = clips.get(c.id) ?? [];
        const past = h.filter((s) => s.at <= t * 1000);
        if (a.clipId === null) {
          const r = scheduleClip(c, undefined, null, t * 1000);
          clips.set(c.id, [...past, ...(r.segments.length ? r.segments.map((s) => ({ ...s, cue: e.cue, action: e.action })) : [{ clipId: "", cleared: true, at: t * 1000, cue: e.cue, action: e.action }])]);
          break;
        }
        if (!c.clips.some((k) => k.id === a.clipId)) break;
        let from = 0;
        past.forEach((s, k) => s.cleared && (from = k + 1));
        const r = scheduleClip(c, { segments: past.slice(from) }, a.clipId, t * 1000);
        const ns = r.segments[r.segments.length - 1];
        if (ns?.clipId === a.clipId) clips.set(c.id, [...past, { clipId: ns.clipId, at: ns.at, cue: e.cue, action: e.action, requested: t * 1000 }]);
        break;
      }
      case "layer": {
        const l = layers.get(a.layerId);
        if (!l) break;
        const on = openSpan(l.spans);
        const show = a.op === "show" || (a.op === "toggle" && !on) || (a.op === "restart" && !on);
        const hide = a.op === "hide" || (a.op === "toggle" && on);
        const ref = (kind: EndRef["kind"]): EndRef => ({ cue: e.cue, action: e.action, kind });
        if (a.op === "restart" && on) {
          Object.assign(l.spans[l.spans.length - 1], { end: t, endBy: ref("restart") });
          l.spans.push({ start: t, end: null, cue: e.cue, action: e.action });
        } else if (show && !on) l.spans.push({ start: t, end: null, cue: e.cue, action: e.action });
        else if (hide && on) Object.assign(l.spans[l.spans.length - 1], { end: t, endBy: ref("hide") });
        break;
      }
      case "background": {
        if (!comp.has(a.backgroundId)) break;
        const cur = bgSpans[bgSpans.length - 1];
        if (cur && cur.id === a.backgroundId) break;
        if (cur) cur.end = t;
        bgSpans.push({ id: a.backgroundId, start: t, end: null, cue: e.cue, action: e.action });
        break;
      }
      case "effect": {
        const c = comp.get(a.effectId);
        if (c?.kind !== "effect") break;
        const spans = effects.get(c.id);
        if (!spans) {
          point("fx:triggers", t, c.name, "effect", e, c.id);
          break;
        }
        const on = openSpan(spans);
        if (a.op === "trigger") point(`c:${c.id}`, t, "trigger", "effect", e, c.id);
        else if ((a.op === "start" || a.op === "toggle") && !on) spans.push({ start: t, end: null, cue: e.cue, action: e.action });
        else if ((a.op === "stop" || a.op === "toggle") && on) {
          const s = spans[spans.length - 1];
          s.fadeFrom = t;
          s.end = t + fadeOf(c);
          s.endBy = { cue: e.cue, action: e.action, kind: "stop" };
        }
        break;
      }
      case "effect.param": {
        const c = comp.get(a.effectId);
        if (c?.kind !== "effect") break;
        point(effects.has(c.id) ? `c:${c.id}` : "fx:triggers", t, `${c.name}: ${a.key} → ${String(a.value)}`, "effect", e, c.id);
        break;
      }
      case "names":
      case "route":
        if (layers.has(a.layerId)) point(`c:${a.layerId}`, t, a.op, "picture", e, a.layerId);
        break;
      case "media.speed":
        if (comp.has(a.layerId)) point(comp.get(a.layerId)!.kind === "background" ? "bg" : `c:${a.layerId}`, t, `speed ${a.rate}×`, "picture", e, a.layerId);
        break;
      case "camera": {
        const shot = scene.cameraShots.find((s) => s.id === a.shotId);
        if (shot) items.push({ id: "", track: "camera", lane: 0, start: t, end: t + Math.max(0, shot.duration), label: shot.name, tone: "camera", cue: e.cue, action: e.action });
        break;
      }
      case "timeOfDay":
        items.push({ id: "", track: "camera", lane: 0, start: t, end: t + Math.max(0, a.duration), label: `Time of day → ${a.value}`, tone: "camera", cue: e.cue, action: e.action });
        break;
      case "framing":
        items.push({ id: "", track: "camera", lane: 0, start: t, end: t + Math.max(0, a.duration), label: `Framing ${round(a.zoom)}×`, tone: "camera", cue: e.cue, action: e.action });
        break;
      case "clock":
        point("show", t, a.op === "pause" ? "Freeze" : a.op === "resume" ? "Resume" : "Freeze / resume", "show", e);
        break;
      case "lion":
      case "lion.moveTo":
      case "lion.place":
      case "actor.visible": {
        const label = a.type === "lion" ? a.action : a.type === "lion.moveTo" ? `${a.gait} to ${a.marker}` : a.type === "lion.place" ? `place at ${a.marker}` : a.visible ? "show" : "hide";
        if (comp.has(a.actorId)) point(`c:${a.actorId}`, t, label, "picture", e, a.actorId);
        break;
      }
      case "audio.fade":
      case "sound": {
        if (a.type === "sound" && !a.assetId) break;
        const own = a.type === "sound" ? a.assetId : null;
        const f = a.type === "sound" ? a.fadeOthers : { which: a.which, fade: a.fade };
        let hit = false;
        if (f && (f.which === "all" || f.which.length)) {
          const fade = Math.max(0.05, f.fade);
          // A fade may hold what it names a while first; it only stops what is already playing as it begins.
          const from = t + Math.max(0, ("delay" in f ? f.delay : 0) ?? 0);
          const endBy: EndRef = { cue: e.cue, action: e.action, kind: a.type === "sound" ? "fadeOthers" : "fade" };
          const hits = (id: string) => f.which === "all" || f.which.includes(`sound:${id}`);
          for (const s of sounds)
            if (s.end == null && s.assetId !== own && hits(s.assetId) && s.start <= from) {
              Object.assign(s, { fadeFrom: from, end: from + fade, endBy });
              hit = true;
            }
          // Music named here that this scene never started was carried in from an earlier scene.
          if (f.which !== "all")
            for (const key of f.which) {
              const id = key.startsWith("sound:") ? key.slice(6) : null;
              if (id && id !== own && !sounds.some((s) => s.assetId === id && s.start <= t)) {
                sounds.push({ assetId: id, start: 0, end: from + fade, fadeFrom: from, loop: true, keep: false, cue: null, action: null, carried: true, endBy });
                hit = true;
              }
            }
        }
        if (a.type === "audio.fade") {
          // A fade with nothing (left) to fade still shows, so it can be found and moved.
          if (!hit) point(SOUND_TRACK.none.id, t, "Fade out audio", "sound", e);
          break;
        }
        // One copy per sound file: firing it again replaces the playing one.
        for (const s of sounds) if (s.end == null && s.assetId === a.assetId) Object.assign(s, { end: t, endBy: { cue: e.cue, action: e.action, kind: "refire" } });
        sounds.push({ assetId: a.assetId!, start: t, end: null, loop: !!a.loop, keep: !!a.keepPlaying, cue: e.cue, action: e.action, trim: a.trimStart || undefined, fadeIn: a.fadeIn || undefined, fadeOut: a.fadeOut || undefined, levels: a.levels?.length ? a.levels : undefined });
        break;
      }
      case "send":
        point("show", t, env.describeMessage?.(a.message) ?? a.message.type, "light", e);
        break;
      case "timer":
        point("show", t, `Timer ${a.op}`, "show", e);
        break;
      case "announce":
        point("show", t, "Announcement", "show", e);
        break;
      case "blackout":
        point("show", t, a.on ? "Blackout" : "Lights up", "show", e);
        break;
      case "takeScene":
        point("show", t, `Take → ${env.sceneName?.(a.sceneId) ?? "scene"}`, "show", e);
        if (takeAt == null) {
          takeAt = t;
          takeDur = Math.max(0.5, a.transition?.duration ?? 1);
        }
        break;
    }
  }

  // Where the timeline ends: the take of the next scene, else just past the last thing that ends.
  let end = 0;
  const known = (n: number | null | undefined) => n != null && Number.isFinite(n) && (end = Math.max(end, n));
  for (const s of starts) known(s != null ? s + MIN_HOLD : null);
  for (const it of items) known(it.end);
  for (const s of sounds) {
    const file = env.duration(s.assetId);
    // How long it plays: the file less what is cut off its top.
    const d = file != null ? Math.max(0, file - (s.trim ?? 0)) : undefined;
    if (!s.loop) known(d != null ? s.start + d : s.start + OPEN_SOUND);
    known(s.end);
  }
  for (const [id, h] of clips) {
    const c = comp.get(id) as ClipActorComponent;
    for (const s of h) {
      const k = c.clips.find((x) => x.id === s.clipId);
      if (k && !k.loop) known(s.at / 1000 + k.duration);
    }
  }
  known(scene.duration);
  end = takeAt != null ? takeAt + takeDur : Math.ceil(end + 2);

  // Clips: each segment until the next, a finished clip handing over to its pose's idle loop.
  for (const c of scene.components) {
    if (c.kind !== "clipActor") continue;
    const h = [...(clips.get(c.id) ?? [])].sort((x, y) => x.at - y.at);
    h.forEach((s, k) => {
      if (s.cleared) return;
      const clip = c.clips.find((x) => x.id === s.clipId);
      if (!clip) return;
      const at = s.at / 1000;
      const next = Math.min(end, k + 1 < h.length ? h[k + 1].at / 1000 : end);
      if (at >= next) return;
      const base = { track: `c:${c.id}`, lane: 0, componentId: c.id, cue: s.cue, action: s.action };
      const add = (clipDef: typeof clip, from: number, to: number, extra: Partial<TimelineItem> = {}) => {
        const marks = clipMarks(clipDef.markers, from, to, clipDef.loop ? clipDef.duration : 0, 1);
        items.push({ id: "", ...base, start: from, end: to, label: clipDef.name, tone: clipDef.loop ? "loop" : "picture", loop: clipDef.loop, clipId: clipDef.id, marks: marks.length ? marks : undefined, ...extra });
        markerPoints(clipDef.markers, from, to, clipDef.loop ? clipDef.duration : 0, 1, c.id, clipDef.name, `${c.id}:${clipDef.id}`);
      };
      const requested = s.requested != null && s.at - s.requested > 50 ? s.requested / 1000 : undefined;
      if (clip.loop) return add(clip, at, next, { requested });
      const endAt = at + Math.max(0.05, clip.duration);
      add(clip, at, Math.min(endAt, next), { requested });
      if (endAt >= next) return;
      const idle = idleFor(c, clip.endPose);
      if (idle) add(idle, endAt, next, { cue: null, action: null });
      else if (clip.endPose !== c.restPose) items.push({ id: "", ...base, cue: null, action: null, start: endAt, end: next, label: "holds last frame", tone: "held" });
    });
  }

  // Markers that send lights / MIDI / OSC (the ones that fire a cue are the cue starts).
  function markerPoints(ms: MediaMarker[] | undefined, from: number, to: number, loopLen: number, rate: number, componentId: string, host: string, hostKey = componentId) {
    for (const m of ms ?? [])
      if (!m.cueId)
        for (const t of passes(m.at / rate, from, to, loopLen / rate)) {
          point("show", t, `${m.name} (${host})`, "light", null, componentId);
          items[items.length - 1].markerHost = hostKey;
        }
  }
  function clipMarks(ms: MediaMarker[] | undefined, from: number, to: number, loopLen: number, rate: number) {
    return (ms ?? []).flatMap((m) => passes(m.at / rate, from, to, loopLen / rate));
  }

  // Backgrounds.
  for (const s of bgSpans) {
    const c = comp.get(s.id);
    if (c?.kind !== "background") continue;
    const to = Math.min(end, s.end ?? end);
    if (to <= s.start) continue;
    const rate = c.media.playbackRate || 1;
    const len = c.source === "media" && c.media.loop ? (env.duration(c.media.assetId) ?? 0) : 0;
    const marks = c.source === "media" ? clipMarks(c.media.markers, s.start, to, len, rate) : [];
    items.push({ id: "", track: "bg", lane: 0, start: s.start, end: to, label: c.name, tone: c.source === "media" && c.media.loop ? "loop" : "picture", loop: c.source === "media" && c.media.loop, cue: s.cue, action: s.action, componentId: c.id, marks: marks.length ? marks : undefined });
    if (c.source === "media") markerPoints(c.media.markers, s.start, to, len, rate, c.id, c.name);
  }

  // Layers.
  for (const [id, l] of layers) {
    const c = comp.get(id)!;
    const media = c.kind === "video" ? c.media : null;
    for (const s of l.spans) {
      const to = Math.min(end, s.end ?? end);
      if (to <= s.start) continue;
      const rate = media?.playbackRate || 1;
      const len = media?.loop ? (env.duration(media.assetId) ?? 0) : 0;
      const marks = media ? clipMarks(media.markers, s.start, to, len, rate) : [];
      items.push({ id: "", track: `c:${id}`, lane: 0, start: s.start, end: to, label: c.name, tone: media?.loop ? "loop" : "picture", loop: !!media?.loop, cue: s.cue, action: s.action, componentId: id, marks: marks.length ? marks : undefined, endBy: s.endBy, endable: "layer", key: id });
      if (media) markerPoints(media.markers, s.start, to, len, rate, id, c.name);
    }
  }

  // Effects that run (rain, fog…): on until stopped, then their fade.
  for (const [id, spans] of effects) {
    const c = comp.get(id)!;
    for (const s of spans) {
      const to = Math.min(end, s.end ?? end);
      if (to > s.start) items.push({ id: "", track: `c:${id}`, lane: 0, start: s.start, end: to, label: c.name, tone: "effect", loop: s.end == null, fadeFrom: s.fadeFrom, cue: s.cue, action: s.action, componentId: id, endBy: s.endBy, endable: "effect", key: id });
    }
  }

  // Sounds: their file's length, or until something stops them; the take fades the rest.
  for (const s of sounds) {
    const file = env.duration(s.assetId);
    // How long it plays: the file less what is cut off its top.
    const d = file != null ? Math.max(0, file - (s.trim ?? 0)) : undefined;
    let to = s.end ?? Infinity;
    let fadeFrom = s.fadeFrom;
    let endBy = s.endBy;
    let open = false;
    if (!s.loop && !s.carried) {
      if (d != null && s.start + d < to) {
        to = s.start + d;
        fadeFrom = s.fadeOut ? Math.max(s.start, to - s.fadeOut) : undefined;
        endBy = undefined;
      }
      else if (s.end == null) {
        to = s.start + OPEN_SOUND;
        open = true;
      }
    }
    let carriesOut = false;
    const sceneOut = takeAt ?? end;
    if (to > sceneOut) {
      endBy = undefined;
      if (s.keep) {
        to = end;
        carriesOut = true;
      } else if (takeAt != null) {
        fadeFrom = takeAt;
        to = Math.min(to, takeAt + TAKE_FADE);
      } else to = end;
    }
    to = Math.min(to, end);
    if (to <= s.start) continue;
    const role = SOUND_TRACK[env.audioRole(s.assetId) ?? "none"];
    items.push({
      id: "",
      track: role.id,
      lane: 0,
      start: s.start,
      end: to,
      label: env.assetName(s.assetId) + (s.carried ? " (from an earlier scene)" : ""),
      tone: role.tone,
      loop: s.loop,
      open: open || undefined,
      carriedIn: s.carried || undefined,
      carriesOut: carriesOut || undefined,
      fadeFrom,
      fadeIn: s.fadeIn,
      trim: s.trim,
      levels: s.levels,
      cue: s.cue,
      action: s.action,
      endBy,
      endable: "sound",
      key: `sound:${s.assetId}`,
      naturalEnd: !s.loop && !s.carried && d != null ? s.start + d : undefined,
    });
  }

  // The transition into the scene plays over its first seconds.
  if (scene.transition.kind !== "cut" && scene.transition.duration > 0)
    items.push({ id: "", track: "show", lane: 0, start: 0, end: Math.min(end, scene.transition.duration), label: `Transition in (${scene.transition.kind})`, tone: "show", cue: null, action: null });

  // Tracks, in a fixed order: picture (in draw order), effects, camera, sound, lights and show.
  const tracks: TimelineTrack[] = [];
  const add = (id: string, label: string, group: TrackGroup, componentId?: string) => {
    if (items.some((it) => it.track === id)) tracks.push({ id, label, group, componentId, lanes: 1 });
  };
  if (bgs.length) add("bg", bgs.length > 1 ? "Background" : bgs[0].name, "picture", bgs.length > 1 ? undefined : bgs[0].id);
  for (const c of scene.components) if (c.kind !== "background" && c.kind !== "effect") add(`c:${c.id}`, c.name, "picture", c.id);
  for (const c of scene.components) if (c.kind === "effect") add(`c:${c.id}`, c.name, "effects", c.id);
  add("fx:triggers", "Effect triggers", "effects");
  add("camera", "Camera and look", "camera");
  for (const r of Object.values(SOUND_TRACK)) add(r.id, r.label, "sound");
  add("show", "Lights and show", "outputs");

  // Overlapping spans in one track get rows of their own.
  for (const tr of tracks) {
    const mine = items.filter((it) => it.track === tr.id).sort((x, y) => x.start - y.start);
    const rows: number[] = [];
    let n = 0;
    for (const it of mine) {
      it.id = `${tr.id}#${n++}`;
      if (it.end === it.start) continue;
      let lane = rows.findIndex((e) => e <= it.start + 1e-3);
      if (lane < 0) lane = rows.push(0) - 1;
      rows[lane] = it.end;
      it.lane = lane;
    }
    tr.lanes = Math.max(1, rows.length);
  }
  for (const it of items) {
    it.start = round(it.start);
    it.end = round(it.end);
    if (it.fadeFrom != null) it.fadeFrom = round(it.fadeFrom);
    if (it.requested != null) it.requested = round(it.requested);
    if (it.naturalEnd != null) it.naturalEnd = round(it.naturalEnd);
    if (it.marks) it.marks = it.marks.map(round);
  }
  return { tracks, items: items.filter((it) => tracks.some((t) => t.id === it.track)), end: round(end), takeAt };
}

/** Scene times a marker at `at` seconds into media playing from `from` to `to` is passed (each loop when it loops). */
function passes(at: number, from: number, to: number, loopLen: number): number[] {
  if (at < 0) return [];
  const out: number[] = [];
  if (loopLen > 0.05) for (let t = from + at; t <= to && out.length < 24; t += loopLen) out.push(t);
  else if (from + at <= to) out.push(from + at);
  return out;
}
