// The rest of the show, scene by scene, from the script's [LED: …] cues.
// Every scene is built from the engine's components with the media slots left empty
// (they show a "NO ASSET" marker in operator previews only). Drop the generated plates
// and clips in, and the cues, titles, trees, maps and effects are already wired.

import { EFFECT_DEFS } from "./effects";
import {
  GENEALOGY_GOLD,
  GENEALOGY_PLAIN,
  defaultCameraMotion,
  defaultKenBurns,
  defaultPlateLight,
  makeBackground,
  makeCue,
  makeEffect,
  makeImageLayer,
  makeNames,
  makeRoute,
  makeScene,
  makeText,
  makeVideoLayer,
} from "./factories";
import type { BackgroundComponent, Cue, CueAction, EffectComponent, KenBurns, Scene, TextComponent, TransitionSpec } from "./types";

export const SHOW_SCAFFOLD_DEMO = "show-scaffold-v1";

// ---------------------------------------------------------------- helpers

const slot = (name: string, p: Partial<BackgroundComponent> = {}) =>
  makeBackground(name, { source: "media", initiallyVisible: false, fit: "cover", transitionDuration: 2, ...p });

/** Plain black: an environment look on a plate-only scene draws nothing but the canvas colour. */
const black = (name: string, p: Partial<BackgroundComponent> = {}) => makeBackground(name, { source: "environment", initiallyVisible: false, transitionDuration: 2, ...p });

const kb = (to: { x: number; y: number; scale: number }, duration: number, loop: KenBurns["loop"] = "none", from = { x: 0, y: 0, scale: 1 }): KenBurns => ({
  ...defaultKenBurns(),
  enabled: true,
  from,
  to,
  duration,
  loop,
});

const whiteLetters = (text: string, p: Partial<TextComponent> = {}) =>
  makeText(text, { text, font: "sans", weight: 500, size: 0.1, color: "#f4f4f4", glow: 0, glowColor: "#ffffff", letterSpacing: 0.22, shadow: 0.2, anim: { enter: "fade", exit: "fade", duration: 1.2, stagger: 0 }, ...p });

const goldTitle = (text: string, p: Partial<TextComponent> = {}) =>
  makeText(text, { text, font: "display", weight: 600, size: 0.2, color: "#ffe6a8", glow: 1.2, glowColor: "#ffb13b", letterSpacing: 0.35, shadow: 0.2, anim: { enter: "burn", exit: "fade", duration: 1.6, stagger: 0.55 }, ...p });

const cue = (name: string, notes: string, actions: CueAction[]): Cue => ({ ...makeCue(name, actions), notes });
const show = (layerId: string, delay = 0): CueAction => ({ type: "layer", layerId, op: "show", delay });
const hide = (layerId: string, delay = 0): CueAction => ({ type: "layer", layerId, op: "hide", delay });
const restart = (layerId: string, delay = 0): CueAction => ({ type: "layer", layerId, op: "restart", delay });
const bg = (backgroundId: string, delay = 0): CueAction => ({ type: "background", backgroundId, delay });
const fx = (effectId: string, op: "start" | "stop" | "trigger", delay = 0): CueAction => ({ type: "effect", effectId, op, delay });
const param = (effectId: string, key: string, value: number | string | boolean, delay = 0): CueAction => ({ type: "effect.param", effectId, key, value, delay });
const take = (sceneId: string, transition: TransitionSpec | null = null, delay = 0): CueAction => ({ type: "takeScene", sceneId, transition, delay });
const names = (layerId: string, op: "next" | "prev" | "reset" | "all" | "set" | "burn" | "restore" | "bloom", duration = 6, value = 0, delay = 0): CueAction => ({ type: "names", layerId, op, value, duration, delay });
const trans = (kind: TransitionSpec["kind"], duration: number, extra: Partial<TransitionSpec> = {}): TransitionSpec => ({ kind, duration, videoAssetId: null, audioAssetId: null, travelDistance: 60, ...extra });
const soft = (p: Partial<EffectComponent> = {}) => makeEffect("fog", { params: { ...EFFECT_DEFS.fog.defaults, density: 0.3, height: 0.2, speed: 0.2 }, ...p });

const act = (number: number, name: string, notes: string, partial: Partial<Scene>) =>
  makeScene(number, name, { environment: "none", markers: {}, transition: trans("crossfade", 2), plateLight: defaultPlateLight(), cameraMotion: { ...defaultCameraMotion(), sway: 0.2 }, notes, ...partial });

// ---------------------------------------------------------------- prologue, part two

/** P5: the king, the promise, FOREVER. */
function kingAndPromise(): Scene {
  const anoint = slot("Storybook · horn of oil, crown, banners", { initiallyVisible: true, kenBurns: kb({ x: 0.015, y: -0.01, scale: 1.1 }, 18), parallax: 0.01 });
  const palace = slot("Storybook · King David in the cedar palace, the tent", { kenBurns: kb({ x: -0.02, y: 0, scale: 1.12 }, 20), parallax: 0.01 });
  const nathan = slot("Storybook · the prophet Nathan before the king", { kenBurns: kb({ x: 0, y: -0.015, scale: 1.1 }, 16), parallax: 0.01 });
  const dark = black("Black (FOREVER alone)", { transitionDuration: 1.5 });
  const forever = goldTitle("F O R E V E R", { name: "FOREVER (gold fire)", text: "F O R E V E R", size: 0.26, letterSpacing: 0.1, anim: { enter: "burn", exit: "fade", duration: 1.4, stagger: 0.6 } });
  const glow = makeEffect("glow", { name: "Ember glow behind the word", params: { ...EFFECT_DEFS.glow.defaults, y: 0.5, radius: 0.7, intensity: 0.5, color: "#ffb347", rays: 0.3, fade: 3 } });
  const haze = makeEffect("haze", { initiallyVisible: true, params: { ...EFFECT_DEFS.haze.defaults, density: 0.12, opacity: 0.2, tint: "#f0d8a8" } });
  const s = act(0, "Prologue 5 · The King and the Promise", "2D storybook art (slots). GO through the three pictures with the narration; then the wall goes dark and FOREVER burns on letter by letter in gold fire as the narrator says it.", {
    components: [anoint, palace, nathan, dark, forever, glow, haze],
    cameraMotion: { sway: 0.25, speed: 0.06 },
  });
  s.cues = [
    cue("Anointing (horn of oil, crown, banners)", 'NAR: "That same shepherd boy grew up, and God chose him…"', [bg(anoint.id)]),
    cue("Palace of cedar, looking out at a tent", 'NAR: "Years went by. David built himself a palace of cedar…"', [bg(palace.id)]),
    cue("The prophet Nathan before the king", 'NAR: "But God sent the prophet Nathan with a surprise."', [bg(nathan.id)]),
    cue("FOREVER burns onto the wall", 'GO just before "…forever." The letters catch fire one by one; the ember glow comes up under them.', [bg(dark.id), show(forever.id, 0.6), fx(glow.id, "start", 0.8)]),
    cue("FOREVER dissolves → the root: DAVID", 'NAR: "Remember that word." Takes the Names scene; the word fades and the root lights at the base of the wall.', [fx(glow.id, "stop"), hide(forever.id)]),
  ];
  return s;
}

/** P6: the names. Gold tree, Babylon, the stump, the thin shoot. */
function theNames(): Scene {
  const blackBg = black("Black", { initiallyVisible: true, transitionDuration: 1 });
  const fireSlot = slot("Babylon · the walls of Jerusalem burn (video)", { transitionDuration: 1.5 });
  const tree = makeNames("Family tree (gold)", { names: [...GENEALOGY_GOLD], style: "tree", x: 0.5, y: 0.98, height: 0.9, spread: 0.26, reveal: 1.2, initiallyVisible: true });
  const shoot = makeNames("The thin shoot (plain names)", { names: [...GENEALOGY_PLAIN], style: "line", font: "sans", color: "#d9d2c0", glow: 0.25, size: 0.045, x: 0.5, y: 0.9, height: 0.75, spread: 0.12, reveal: 0.9, initiallyVisible: false });
  const embers = makeEffect("lights", { name: "Embers", params: { ...EFFECT_DEFS.lights.defaults, count: 90, x: 0.5, y: 0.45, w: 0.5, h: 0.8, size: 0.6, color: "#ff8a2a", flicker: 0.9, spread: 6, order: 0, fade: 2 } });
  const quake = makeEffect("shake", { name: "The crown shatters", params: { intensity: 0.02, duration: 1.4, frequency: 11 } });
  const flash = makeEffect("lightning", { params: { ...EFFECT_DEFS.lightning.defaults, brightness: 0.7, thunder: false } });
  const wind = makeEffect("wind");
  const s = act(0, "Prologue 6 · The Names (the family tree)", "The genealogy as a growing gold tree. One GO per name through Uzziah; the rhythm cue runs the fast names on its own (0.55 s apart). Babylon burns the tree to a stump; the thin shoot carries the plain names.", {
    components: [blackBg, fireSlot, tree, shoot, embers, quake, flash, wind],
    cameraMotion: { sway: 0.1, speed: 0.05 },
    transition: trans("crossfade", 1.5),
  });
  const T = tree.id;
  const first = GENEALOGY_GOLD.slice(0, 8);
  const lines: Record<string, string> = {
    DAVID: '"…one glowing root with a name: DAVID."',
    SOLOMON: '"David had a son. Solomon."',
    REHOBOAM: '"Solomon had a son — Rehoboam."',
    ABIJAH: '"Rehoboam had Abijah."',
    ASA: '"Abijah had Asa."',
    JEHOSHAPHAT: '"Asa had Jehoshaphat —" (SECOND VOICE: "Bless you.")',
    JORAM: '"Jehoshaphat had Joram."',
    UZZIAH: '"Joram had Uzziah —" (the percussion kicks in after this one)',
  };
  s.cues = [
    ...first.map((n) => cue(n, lines[n] ?? "", [names(T, "next")])),
    cue("Rhythm: Jotham → Jeconiah (auto, 0.55 s apart)", '"Uzziah — Jotham! Jotham — Ahaz!…" GO on "Jotham"; the remaining names bloom on the beat by themselves.', [0, 1, 2, 3, 4, 5, 6].map((i) => names(T, "next", 6, 0, i * 0.55))),
    cue("Babylon: fire, the crown falls, the tree burns to a stump", '"— and then Babylon came." Fire plate in (slot), flash, quake; the branches blacken from the top down until only the stump is left.', [
      bg(fireSlot.id),
      fx(flash.id, "trigger", 0.2),
      fx(quake.id, "trigger", 0.6),
      names(T, "burn", 9, 0, 0.4),
      fx(embers.id, "start", 1),
      fx(wind.id, "start", 2),
    ]),
    cue("Wind. Nothing else.", '"The palace, gone. The throne, gone…" The fire plate fades to black; embers die.', [bg(blackBg.id), fx(embers.id, "stop")]),
    cue("A shoot from the stump", 'ISAIAH: "There shall come forth a shoot from the stump of Jesse…" The thin line of light rises.', [show(shoot.id)]),
    ...GENEALOGY_PLAIN.map((n, i) => cue(n, i === 1 ? '"Zerubbabel — Zeru— Zerubba— the man with the long name."' : i === 0 ? '"So the names kept coming. Smaller now. Quieter." Shealtiel.' : `"${n[0]}${n.slice(1).toLowerCase()}."`, [names(shoot.id, "next")])),
    cue("THE MAP MOMENT → Bethlehem", '"Eleazar had a son called Matthan. And Matthan had a son called Jacob." Takes the map scene.', []),
  ];
  return s;
}

/** P7: the map glides down to Bethlehem; a carpenter at his bench: JACOB. */
function theMap(): Scene {
  const map = makeRoute("Storybook map · glide down to Bethlehem", {
    assetId: null,
    points: [
      [0.5, 0.45],
      [0.5, 0.45],
    ],
    duration: 1,
    label: "",
    zoom: kb({ x: -0.02, y: -0.08, scale: 2.4 }, 9, "none", { x: 0, y: 0, scale: 1 }),
    initiallyVisible: true,
  });
  const bench = slot("Storybook · a carpenter planes a board (JACOB)", { kenBurns: kb({ x: 0.01, y: 0, scale: 1.08 }, 12), parallax: 0.01 });
  const town = goldTitle("BETHLEHEM — THE CITY OF DAVID", { name: "BETHLEHEM — THE CITY OF DAVID", text: "BETHLEHEM\n— THE CITY OF DAVID —", size: 0.11, y: 0.75, letterSpacing: 0.3, anim: { enter: "rise", exit: "fade", duration: 1.6, stagger: 0 } });
  const jacob = goldTitle("JACOB", { text: "JACOB", size: 0.16, y: 0.84, anim: { enter: "burn", exit: "cut", duration: 1.2, stagger: 0.4 } });
  const s = act(0, "Prologue 7 · The Map to Bethlehem (JACOB)", "The storybook map glides and zooms down to one small hill town; the title rises. Then the carpenter at his bench, and JACOB. The last cue SNAPS to the live stage (Scene 1).", {
    components: [bench, map, town, jacob],
    cameraMotion: { sway: 0.15, speed: 0.05 },
    transition: trans("dissolve", 1.5),
  });
  s.cues = [
    cue("The map glides down to Bethlehem", 'GO as the narrator says "Jacob". The zoom lands as the title rises: BETHLEHEM — THE CITY OF DAVID.', [{ type: "route", layerId: map.id, op: "play", delay: 0 }, show(town.id, 6)]),
    cue("A carpenter at his bench: JACOB", 'NAR: "…a carpenter planes a board at his bench in the morning light: JACOB."', [hide(town.id), hide(map.id, 1.5), bg(bench.id), show(jacob.id, 1.2)]),
    cue("SNAP UP. CUT → Scene 1", '"And Jacob had a son. And they called him —" LIGHTS snap up; cut to the Bethlehem street.', []),
  ];
  return s;
}

// ---------------------------------------------------------------- Act I

function scene1(): Scene {
  const street = slot("Bethlehem street · morning (real)", { initiallyVisible: true, kenBurns: kb({ x: 0.01, y: 0, scale: 1.06 }, 60, "pingpong"), parallax: 0.012 });
  const workshop = slot("Jacob's workshop · late afternoon gold", { transitionDuration: 4, parallax: 0.012 });
  const farewell = slot("Bethlehem street · early morning (farewell)", { transitionDuration: 4, parallax: 0.012 });
  const title = goldTitle("BETHLEHEM — THE CITY OF DAVID", { text: "BETHLEHEM — THE CITY OF DAVID", size: 0.085, y: 0.14, letterSpacing: 0.3, glow: 0.6, anim: { enter: "rise", exit: "fade", duration: 1.8, stagger: 0 } });
  const haze = makeEffect("haze", { initiallyVisible: true, params: { ...EFFECT_DEFS.haze.defaults, density: 0.15, opacity: 0.25, tint: "#f0dcb8" } });
  const s = act(0, "Scene 1 · Joseph is back! (Bethlehem street)", "The storybook is gone: the same hills, now a real Bethlehem street in morning light. Text rises. Workshop (late afternoon) and the farewell (early morning) follow.", {
    components: [street, workshop, farewell, title, haze],
    transition: trans("cut", 0),
  });
  s.cues = [
    cue("Text rises: BETHLEHEM — THE CITY OF DAVID", "As the kids shout JOSEPH! The title fades away after the song begins.", [show(title.id), hide(title.id, 14)]),
    cue("The workshop · late afternoon gold", "LIGHTS shift to Jacob's workshop. Sawdust hangs in the light.", [bg(workshop.id)]),
    cue("Farewell · early morning street", "LIGHTS widen to the whole street. Early morning.", [bg(farewell.id)]),
    cue("THE MAP returns: Bethlehem → Nazareth", 'As Joseph walks. NAR: "Joseph thought he was leaving the house of David behind…" Takes the map scene.', []),
  ];
  return s;
}

function mapScene(number: number, name: string, label: string, notes: string, points: [number, number][], line: string): Scene {
  const route = makeRoute(`Map · ${label}`, { points, label, duration: 10, initiallyVisible: true, zoom: { ...defaultKenBurns(), enabled: false } });
  const s = act(number, name, notes, { components: [route], transition: trans("dissolve", 1.5), cameraMotion: { sway: 0.1, speed: 0.05 } });
  s.cues = [cue("The glowing line traces the journey", line, [{ type: "route", layerId: route.id, op: "play", delay: 0 }])];
  return s;
}

function scene2(): Scene {
  const market = slot("Nazareth · modest hill village, harsh midday", { initiallyVisible: true, parallax: 0.012, kenBurns: kb({ x: -0.01, y: 0, scale: 1.05 }, 60, "pingpong") });
  const timelapse = slot("Nazareth · the sun arcs across the sky (time-lapse video)", { transitionDuration: 1.5 });
  const marketDay = slot("Nazareth · market day (busier)", { transitionDuration: 2, parallax: 0.012 });
  const dusk = slot("Nazareth · dusk, one light on Joseph", { transitionDuration: 6 });
  const title = whiteLetters("MARKET DAY", { y: 0.18, size: 0.09 });
  const heat = makeEffect("heat", { initiallyVisible: true, params: { ...EFFECT_DEFS.heat.defaults, amount: 0.25, height: 0.35 } });
  const s = act(0, "Scene 2 · The Chair (Nazareth market)", "NAZARETH: a modest hill village, busier than Bethlehem, dustier, full of noise. A quick time-shift: the sun arcs across the sky, MARKET DAY. Ends at dusk on Joseph alone.", {
    components: [market, timelapse, marketDay, dusk, title, heat],
  });
  s.cues = [
    cue("Time-shift: the sun arcs across the sky → MARKET DAY", "Hammering sounds, a few beats of music. The time-lapse plays, the title lands, then market day.", [bg(timelapse.id), show(title.id, 3), bg(marketDay.id, 5), hide(title.id, 7)]),
    cue("Dusk · a single light on Joseph", 'LIGHTS fade to dusk. JOSEPH: "Lord. I came here because I thought You opened a door…"', [bg(dusk.id), fx(heat.id, "stop")]),
  ];
  return s;
}

function plateScene(name: string, plate: string, notes: string, extra: Partial<Scene> = {}): Scene {
  const p = slot(plate, { initiallyVisible: true, parallax: 0.01, kenBurns: kb({ x: 0.008, y: 0, scale: 1.04 }, 90, "pingpong") });
  return act(0, name, notes, { components: [p], ...extra });
}

function scene5(): Scene {
  const split = slot("Nazareth · workshop + Eli's house (day)", { initiallyVisible: true, parallax: 0.01 });
  const later = whiteLetters("A FEW WEEKS LATER", { y: 0.5, size: 0.12 });
  const sting = makeVideoLayer("Sky time-lapse · sting (full frame)");
  sting.placement = "front";
  sting.screen = { x: 0.5, y: 0.5, width: 1, rotation: 0, flipX: false };
  sting.anim = { enter: "fade", exit: "fade", duration: 0.35, stagger: 0 } as never;
  sting.media.loop = false;
  const s = act(0, "Scene 5 · Nothing is Broken (time-lapse stings)", "Comic ping-pong. Between beats the wall runs a time-lapse (sun racing across the sky, the moon, the sun again) with a bright musical sting. Five stings; the last is bigger.", {
    components: [split, later, sting],
  });
  const stingCue = (n: number, big = false) =>
    cue(`TIME-LAPSE · sting ${n}${big ? " (bigger)" : ""}`, big ? "The sting is bigger this time." : "Snap to the other side of the stage.", [restart(sting.id), hide(sting.id, big ? 3.5 : 2.4)]);
  s.cues = [cue("Title: A FEW WEEKS LATER", "In simple white letters.", [show(later.id), hide(later.id, 5)]), stingCue(1), stingCue(2), stingCue(3), stingCue(4), stingCue(5, true)];
  return s;
}

function scene7(): Scene {
  const workshop = slot("Workshop + half-built house · late afternoon", { initiallyVisible: true, parallax: 0.012 });
  const well = slot("The village well · golden hour, long shadows, sparrows (video)", { transitionDuration: 4, parallax: 0.012 });
  const later = whiteLetters("THREE MONTHS LATER", { y: 0.5, size: 0.12 });
  const glow = makeEffect("glow", { name: "The golden light glows from within", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.3, radius: 1.1, intensity: 0.7, color: "#ffd98a", rays: 0.5, raySpeed: 0.05, pulse: 0.3, fade: 5 } });
  const forever = goldTitle("FOREVER", { name: "FOREVER flickers", text: "FOREVER", size: 0.2, y: 0.3, glow: 1.4, blend: "add", anim: { enter: "fade", exit: "fade", duration: 0.5, stagger: 0 } });
  const s = act(0, "Scene 7 · \"You are not going to believe this\" (Gabriel at the well)", "The workshop dissolves into the village well at golden hour. The sparrows freeze in mid-flight, the grass stops, the light glows from within. For one instant FOREVER flickers across the sky. Then back to the workshop exactly as before.", {
    components: [workshop, well, later, glow, forever],
  });
  s.cues = [
    cue("Title: THREE MONTHS LATER", "In simple white letters.", [show(later.id), hide(later.id, 5)]),
    cue("The workshop dissolves into the village well", "Golden hour. Long shadows. Sparrows flitting across the sky.", [bg(well.id)]),
    cue("Everything freezes; the light glows from within", "The sparrows freeze in mid-flight. The grass stops moving. (Freezes the whole wall; the glow rises.)", [{ type: "clock", op: "pause", delay: 0 }, fx(glow.id, "start", 0.2)]),
    cue("FOREVER flickers across the golden sky", "For one instant, very faintly.", [show(forever.id), hide(forever.id, 1.1)]),
    cue("Back to the workshop, exactly as before", "Late afternoon. Time moves again.", [fx(glow.id, "stop"), { type: "clock", op: "resume", delay: 0 }, bg(workshop.id, 0.5)]),
  ];
  return s;
}

function scene8(): Scene {
  const sky = slot("Night sky over Nazareth (plate)", { initiallyVisible: true, parallax: 0.006 });
  const stars = makeEffect("stars", { initiallyVisible: true, params: { ...EFFECT_DEFS.stars.defaults, density: 0.7, brightness: 1, horizon: 0.7, drift: 0.01 } });
  const s = act(0, "Scene 8 · Joseph Alone (night sky)", "Night sky over Nazareth. Stars. The starfield effect twinkles over the plate (or stands alone on black).", { components: [sky, stars], transition: trans("crossfade", 4) });
  s.cues = [cue("A shooting star (optional)", "If wanted: a brief brightness swell.", [param(stars.id, "brightness", 1.6), param(stars.id, "brightness", 1, 2)])];
  return s;
}

function scene10(): Scene {
  const night = slot("Nazareth at night, animated · Martha at a window (video)", { initiallyVisible: true, parallax: 0.01 });
  const streets = slot("The torch-lit crowd pours through the night streets (video)", { transitionDuration: 2 });
  const windows = makeEffect("lights", { name: "Windows light up across the town", params: { ...EFFECT_DEFS.lights.defaults, count: 70, seed: 21, x: 0.5, y: 0.5, w: 0.95, h: 0.42, size: 1.1, color: "#ffb860", flicker: 0.25, spread: 22, order: 2, fade: 1.2 } });
  const torches = makeEffect("lights", { name: "Torches are lit", params: { ...EFFECT_DEFS.lights.defaults, count: 24, seed: 8, x: 0.5, y: 0.72, w: 0.8, h: 0.12, size: 1.6, color: "#ff9a3a", flicker: 0.9, spread: 8, order: 0, fade: 0.8 } });
  const s = act(0, "Scene 10 · The Law Stands · Part 1: The Whispers (LED only)", "The stage goes dark; all focus on the wall. Martha whispers at a window; the neighbour runs to two doors, those two to four; windows light up across the dark town like a fire spreading. Torches. The crowd pours toward Mary's house.", {
    components: [night, streets, windows, torches],
    transition: trans("fadeblack", 2),
  });
  s.cues = [
    cue("Windows light up, one after another", 'WHISPERS: "Have you heard? — Have you heard?" The spread runs about 22 s from the centre outward.', [fx(windows.id, "start")]),
    cue("Torches are lit", 'WHISPERS become rhythmic: "The law — the law —"', [fx(torches.id, "start")]),
    cue("The crowd pours through the streets", "Martha at the front. The whispering turns into marching feet; the live MOB enters from the back of the house.", [bg(streets.id), fx(windows.id, "stop", 3)]),
  ];
  return s;
}

function intermission(): Scene {
  const blackBg = black("Black", { initiallyVisible: true });
  const title = goldTitle("INTERMISSION", { text: "INTERMISSION", size: 0.12, glow: 0.7, letterSpacing: 0.45, initiallyVisible: true, anim: { enter: "fade", exit: "fade", duration: 2, stagger: 0 } });
  const stars = makeEffect("stars", { initiallyVisible: true, params: { ...EFFECT_DEFS.stars.defaults, density: 0.3, brightness: 0.5, horizon: 1.1, twinkle: 0.6 } });
  return act(0, "Intermission", "A quiet card for the break. (Or use STANDBY.)", { components: [blackBg, title, stars], transition: trans("fadeblack", 3), cameraMotion: { sway: 0, speed: 0.05 } });
}

// ---------------------------------------------------------------- Act II

function rewind(): Scene {
  const still = slot("Act I final tableau · still photograph", { initiallyVisible: true, transitionDuration: 0.5 });
  const rew = slot("The rewind (video of Act I's night, played backwards)", { transitionDuration: 0.5, media: { assetId: null, loop: false, playbackRate: 0.3, startTime: 0, endTime: null, muted: true, volume: 1, reverse: true } });
  const lamp = slot("Deep night · the camera drifts down to a lamp in the half-built house (video)", { transitionDuration: 3 });
  const torches = makeEffect("lights", { name: "Torches retreat and go out one by one", initiallyVisible: true, params: { ...EFFECT_DEFS.lights.defaults, count: 30, seed: 8, x: 0.5, y: 0.7, w: 0.8, h: 0.15, size: 1.5, color: "#ff9a3a", flicker: 0.9, spread: 14, order: 1, fade: 0.6 } });
  const windows = makeEffect("lights", { name: "Windows go dark in reverse order", initiallyVisible: true, params: { ...EFFECT_DEFS.lights.defaults, count: 70, seed: 21, x: 0.5, y: 0.5, w: 0.95, h: 0.42, size: 1.1, color: "#ffb860", flicker: 0.25, spread: 16, order: 2, fade: 1 } });
  const stars = makeEffect("stars", { params: { ...EFFECT_DEFS.stars.defaults, density: 0.6, horizon: 0.6, fade: 6 } });
  const s = act(0, "Act II Opening · REWIND", "House to full black. The exact frozen image from the end of Act I: a still photograph, held for three seconds. Then it plays BACKWARD, slowly at first, then faster; torches retreat and go out; windows go dark in reverse order. The rewind slows; the camera drifts down to a single lamp. Note: for a smooth rewind import a reversed render of the clip and turn Reverse off.", {
    components: [still, rew, lamp, torches, windows, stars],
    transition: trans("cut", 0),
    cameraMotion: { sway: 0, speed: 0.05 },
  });
  s.cues = [
    cue("Hold the still (3 s)", "SFX: a single heartbeat behind the audience.", [bg(still.id)]),
    cue("Rewind: slowly at first, then faster", "SFX: a rising rewind whine pans backward around the room. Speed ramps 0.3× → 3× over 20 s; torches and windows go out.", [bg(rew.id), { type: "media.speed", layerId: rew.id, rate: 3, duration: 20, delay: 0 }, fx(torches.id, "stop", 2), fx(windows.id, "stop", 6)]),
    cue("The rewind slows; down to the lamp", "Deep night, a few hours earlier. The camera drifts down through the dark to a single lamp in the timber frame.", [{ type: "media.speed", layerId: rew.id, rate: 0.4, duration: 4, delay: 0 }, bg(lamp.id, 4), fx(stars.id, "start", 4)]),
  ];
  return s;
}

function scene11(): Scene {
  const night = slot("Night sky over Nazareth (plate)", { initiallyVisible: true, parallax: 0.006 });
  const nightmare = slot("Slow-motion dream · torches, faces in shadow, Mary on her knees (video)", { transitionDuration: 3, media: { assetId: null, loop: true, playbackRate: 0.35, startTime: 0, endTime: null, muted: true, volume: 1 } });
  const wings = slot("Vast wings of light unfold across the wall (video)", { transitionDuration: 1.5 });
  const storm = slot("The prologue returns in fragments, swirling like a storm (video)", { transitionDuration: 1 });
  const stars = makeEffect("stars", { initiallyVisible: true, params: { ...EFFECT_DEFS.stars.defaults, density: 0.75, brightness: 1, horizon: 0.75, drift: 0.02, fade: 4 } });
  const pillar = makeEffect("glow", { name: "Pillar of pure white light", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.55, radius: 0.5, intensity: 1.6, color: "#fff5e2", rays: 1, raySpeed: 0.12, pulse: 0.1, fade: 2.5 } });
  const red = makeEffect("glow", { name: "Torchlight haze (nightmare)", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.9, radius: 1.4, intensity: 0.45, color: "#ff5a3a", rays: 0.2, fade: 4 } });
  const embers = makeNames("Names rise as embers", { names: [...GENEALOGY_PLAIN], style: "fly", color: "#ffb347", glow: 1.4, size: 0.07, x: 0.5, y: 0.95, height: 0.9, spread: 0.22, reveal: 1.4, initiallyVisible: true });
  const joseph = goldTitle("JOSEPH", { text: "JOSEPH", size: 0.3, y: 0.5, glow: 1.8, anim: { enter: "burn", exit: "fade", duration: 1.6, stagger: 0.5 } });
  const blinder = makeEffect("lightning", { name: "Blinder flash", params: { ...EFFECT_DEFS.lightning.defaults, brightness: 2, duration: 0.3, thunder: false } });
  const s = act(0, "Scene 11 · Joseph, Son of David (the dream)", "Awe first. The stars stretch and turn; the nightmare in slow motion, stars bleeding red; everything stops; heaven opens and wings of light unfold across the wall; the prologue returns in a storm of fragments; the names fly out like embers; JOSEPH alone, brightest. WAKE UP: a blinder flash and black.", {
    components: [night, nightmare, wings, storm, stars, red, pillar, embers, joseph, blinder],
    transition: trans("crossfade", 3),
  });
  const E = embers.id;
  s.cues = [
    cue("The stars begin to stretch and turn", 'WHISPERS: "Joseph… Joseph… Joseph…" (dream)', [param(stars.id, "rotate", 0.7), param(stars.id, "stretch", 0.55), param(stars.id, "drift", 0.08)]),
    cue("The nightmare: slow-motion torches, the stars bleed red", 'WHISPERS: "Stone… her… stone… her…"', [bg(nightmare.id), param(stars.id, "tint", "#ff6a55"), fx(red.id, "start")]),
    cue("EVERYTHING STOPS", "A single deep pure tone. The torches freeze. The stones freeze, hanging in the air. The stars turn white and stop.", [{ type: "clock", op: "pause", delay: 0 }, param(stars.id, "tint", "#ffffff"), param(stars.id, "rotate", 0), param(stars.id, "stretch", 0), fx(red.id, "stop")]),
    cue("Heaven opens: the pillar, wings of light unfold", "The beam lands; a pillar of pure white light. Behind Gabriel vast wings unfold across the entire wall (and beyond, on the projection).", [{ type: "clock", op: "resume", delay: 0 }, fx(pillar.id, "start"), bg(wings.id, 0.5)]),
    cue("SON OF DAVID: the prologue returns in a storm", 'GABRIEL: "Joseph. Son. Of. David." BOOM.', [bg(storm.id), fx(blinder.id, "trigger")]),
    cue("The names rise from the ashes like embers (auto, 1.3 s apart)", "SHEALTIEL… ZERUBBABEL… ABIUD… each with its own chime, flying out over the audience.", GENEALOGY_PLAIN.map((_, i) => names(E, "next", 6, 0, i * 1.3))),
    cue("Last of all: JOSEPH, alone, brightest", "In the centre of the main wall. The music peaks and drops away.", [bg(night.id), show(joseph.id, 0.5)]),
    cue("The message (everything narrows)", "Stars dim to a faint glow.", [hide(joseph.id), param(stars.id, "brightness", 0.3), fx(pillar.id, "stop")]),
    cue("WAKE UP: blinder flash → black", 'GABRIEL: "WAKE UP." Everything in the room goes black at once.', [fx(blinder.id, "trigger"), { type: "blackout", on: true, fade: 0.05, delay: 0.18 }]),
  ];
  return s;
}

function scene12(): Scene {
  const house = slot("The half-built house · cold blue night", { initiallyVisible: true });
  const run = slot("THE RUN · first-person through the night streets of Nazareth (video)", { transitionDuration: 0.3, media: { assetId: null, loop: true, playbackRate: 1, startTime: 0, endTime: null, muted: true, volume: 1 } });
  const square = slot("The town square · torchlight (tableau backdrop)", { transitionDuration: 1 });
  const shake = makeEffect("shake", { name: "Footfalls", params: { intensity: 0.006, duration: 0.3, frequency: 9 } });
  const s = act(0, "Scene 12 · STOP! (the run)", "SNAP to the cold blue of night. Joseph tears the writ and RUNS: first-person through the narrow streets, past the well, the market, his own stall, torchlight on the walls, faster and faster. The square: the Act I tableau.", {
    components: [house, run, square, shake],
    transition: trans("cut", 0),
  });
  s.cues = [
    cue("Lights up: the half-built house", "Joseph jolts awake. (Brings the wall back from the blackout.)", [{ type: "blackout", on: false, fade: 0.2, delay: 0 }]),
    cue("THE RUN", "He picks up the writ, tears it, and RUNS. Speed ramps 1× → 1.8× over 25 s.", [bg(run.id), { type: "media.speed", layerId: run.id, rate: 1.8, duration: 25, delay: 0 }]),
    cue("The square: the Act I tableau", "Full stage. Martha's stone raised high.", [bg(square.id)]),
  ];
  return s;
}

function scene13(): Scene {
  const morning = slot("A quiet Nazareth morning", { initiallyVisible: true, parallax: 0.01, kenBurns: kb({ x: 0.01, y: 0, scale: 1.05 }, 80, "pingpong") });
  const later = whiteLetters("SIX MONTHS LATER", { y: 0.5, size: 0.12 });
  const s = act(0, "Scene 13 · A Nail in the Door", "In simple white letters: SIX MONTHS LATER. A quiet Nazareth morning. Birdsong.", { components: [morning, later] });
  s.cues = [cue("Title: SIX MONTHS LATER", "", [show(later.id), hide(later.id, 5)])];
  return s;
}

function scene14(): Scene {
  const heatPlate = slot("Station 1 · a blazing sun over dry hills", { initiallyVisible: true, parallax: 0.01, transitionDuration: 4 });
  const stormPlate = slot("Station 2 · the sky darkens", { transitionDuration: 6, parallax: 0.01 });
  const coldPlate = slot("Station 3 · the landscape turns bare and cold", { transitionDuration: 6, parallax: 0.01 });
  const nightPlate = slot("Station 4 · a clear, starry night sky", { transitionDuration: 6, parallax: 0.006 });
  const gates = slot("Station 5 · the walls and gates of Bethlehem, smoke rising, every rooftop lit", { transitionDuration: 6, parallax: 0.01 });
  const heat = makeEffect("heat", { initiallyVisible: true, params: { ...EFFECT_DEFS.heat.defaults, amount: 0.8, height: 0.55, speed: 1.2 } });
  const rain = makeEffect("rain", { params: { ...EFFECT_DEFS.rain.defaults, intensity: 0.9, wind: 0.4, fadeIn: 3, fadeOut: 4 } });
  const lightning = makeEffect("lightning");
  const wind = makeEffect("wind", { params: { ...EFFECT_DEFS.wind.defaults, strength: 0.8 } });
  const snow = makeEffect("snow", { params: { ...EFFECT_DEFS.snow.defaults, intensity: 0.7, fadeIn: 6, fadeOut: 6 } });
  const stars = makeEffect("stars", { params: { ...EFFECT_DEFS.stars.defaults, density: 0.8, brightness: 1.1, horizon: 0.62 } });
  const fire = makeEffect("glow", { name: "Firelight on the rocks", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 1.05, radius: 0.5, intensity: 0.45, color: "#ff9a3a", rays: 0, pulse: 0.8, fade: 3 } });
  const rooftops = makeEffect("lights", { name: "Every rooftop lit", params: { ...EFFECT_DEFS.lights.defaults, count: 160, seed: 5, x: 0.5, y: 0.6, w: 0.7, h: 0.18, size: 0.8, color: "#ffc070", flicker: 0.35, spread: 10, order: 2, fade: 1.5 } });
  const s = act(0, "Scene 14 · The Road Back (five stations)", "Joseph, Mary and Goliath walk the apron from stage right to stage left, stopping for each station while the wall carries the environments: heat shimmer; the storm (lightning, rain, wind); bare and cold (snow); a clear starry night and the fire; over a final rise, Bethlehem's gates, smoke rising, every rooftop lit.", {
    components: [heatPlate, stormPlate, coldPlate, nightPlate, gates, heat, rain, lightning, wind, snow, stars, fire, rooftops],
    transition: trans("dissolve", 2),
  });
  s.cues = [
    cue("Station 2 · THE STORM", 'MARY: "You said that yesterday." The sky darkens; lightning; a real downpour on the apron if possible.', [bg(stormPlate.id), fx(heat.id, "stop"), fx(wind.id, "start"), fx(rain.id, "start", 2), fx(lightning.id, "trigger", 4), fx(lightning.id, "trigger", 9.5)]),
    cue("Lightning", "Extra strike on the console's cue.", [fx(lightning.id, "trigger")]),
    cue("Station 3 · THE COLD", "Rain stops. Wind continues. The landscape turns bare and cold; snow drifts down (and out over the first rows).", [bg(coldPlate.id), fx(rain.id, "stop"), fx(snow.id, "start", 2)]),
    cue("Station 4 · NIGHT", "A clear, starry night sky. One small warm pool of light; the fire.", [bg(nightPlate.id), fx(snow.id, "stop"), fx(wind.id, "stop"), fx(stars.id, "start", 2), fx(fire.id, "start", 4)]),
    cue("Station 5 · THE GATES", 'Over a final rise, Bethlehem. MARY: "Joseph. Look." JOSEPH: "Home."', [bg(gates.id), fx(stars.id, "stop"), fx(fire.id, "stop"), fx(rooftops.id, "start", 3)]),
  ];
  return s;
}

function scene15(): Scene {
  const evening = slot("Bethlehem overflowing · evening", { initiallyVisible: true, parallax: 0.01 });
  const lower = slot("TIME-LAPSE · the sun slides lower", { transitionDuration: 3, parallax: 0.01 });
  const dusk = slot("TIME-LAPSE · dusk, the first stars", { transitionDuration: 3, parallax: 0.01 });
  const night = slot("TIME-LAPSE · night, snow begins", { transitionDuration: 3, parallax: 0.01 });
  const deep = slot("TIME-LAPSE · deep night, heavy snow", { transitionDuration: 3, parallax: 0.01 });
  const inside = makeVideoLayer("Inside Aunt Zipporah's house · packed wall to wall (full frame)");
  inside.placement = "front";
  inside.screen = { x: 0.5, y: 0.5, width: 1, rotation: 0, flipX: false };
  inside.anim = { enter: "fade", exit: "fade", duration: 0.4, stagger: 0 } as never;
  const stars = makeEffect("stars", { params: { ...EFFECT_DEFS.stars.defaults, density: 0.5, horizon: 0.5, fade: 6 } });
  const snow = makeEffect("snow", { params: { ...EFFECT_DEFS.snow.defaults, intensity: 0.35, fadeIn: 8, fadeOut: 8 } });
  const rooftops = makeEffect("lights", { name: "Rooftop fires and windows", params: { ...EFFECT_DEFS.lights.defaults, count: 60, seed: 3, x: 0.5, y: 0.45, w: 0.9, h: 0.3, size: 1, color: "#ffb860", flicker: 0.4, spread: 12, order: 0, fade: 2 } });
  const s = act(0, "Scene 15 · No Room in the House of David", "Bethlehem overflowing: families embracing, banners of family names, people camping on every roof. Between doors the wall time-lapses from evening to deep, snowy night. Aunt Zipporah's door shows the inside of the house, packed shoulder to shoulder.", {
    components: [evening, lower, dusk, night, deep, inside, stars, snow, rooftops],
  });
  s.cues = [
    cue("TIME-LAPSE · the sun slides lower", "After Tobias: SLAM.", [bg(lower.id), fx(rooftops.id, "start", 3)]),
    cue("Inside the house: packed wall to wall", 'AUNT ZIPPORAH throws the door open. "A WALL OF NOISE from inside."', [show(inside.id)]),
    cue("She closes the door gently", "The noise cuts off.", [hide(inside.id)]),
    cue("TIME-LAPSE · dusk, the first stars", "After Aunt Zipporah.", [bg(dusk.id), fx(stars.id, "start", 2)]),
    cue("TIME-LAPSE · night, snow begins to fall", "After Nahum: SLAM. FX: snow.", [bg(night.id), fx(snow.id, "start")]),
    cue("TIME-LAPSE · deep night, heavy snow", "After Great-Aunt Keturah.", [bg(deep.id), param(snow.id, "intensity", 0.9), param(snow.id, "speed", 2.2)]),
  ];
  return s;
}

function scene16(): Scene {
  const dark = black("Black (the wall is dark all scene)", { initiallyVisible: true, transitionDuration: 2 });
  const all = [...GENEALOGY_GOLD, ...GENEALOGY_PLAIN, "JOSEPH"];
  const tree = makeNames("The family tree in full blossom", { names: all, style: "tree", crown: "JESUS", x: 0.5, y: 0.99, height: 0.92, spread: 0.3, reveal: 0.5, size: 0.045, initiallyVisible: false });
  const forever = goldTitle("FOREVER", { text: "FOREVER", size: 0.22, y: 0.12, glow: 1.8, anim: { enter: "burn", exit: "fade", duration: 1.2, stagger: 0.35 } });
  const glow = makeEffect("glow", { name: "Radiant light at the crown", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.08, radius: 0.5, intensity: 0.8, color: "#fff2cc", rays: 0.8, raySpeed: 0.08, pulse: 0.2, fade: 6 } });
  const s = act(0, "Scene 16 · The Manger (the tree blossoms)", "Almost no multimedia until the name. Then the wall, dark all scene, slowly comes to life: the burned stump from the Prologue. A single green shoot. The whole tree GROWS, faster and fuller than before, bursting into blossom, every name lit in gold from the root upward, and at the very crown: JESUS. On 'forever', FOREVER blazes.", {
    components: [dark, tree, forever, glow],
    transition: trans("fadeblack", 3),
    cameraMotion: { sway: 0, speed: 0.05 },
  });
  s.cues = [
    cue("The wall comes to life: the burned stump", 'JOSEPH: "Jesus." The stump from the Prologue, black and dead.', [names(tree.id, "all"), names(tree.id, "burn", 0.1), show(tree.id)]),
    cue("A single green shoot… the whole tree GROWS and blossoms", 'JOSEPH: "Because He will save His people from their sins." The names race upward; JESUS at the crown as the song builds.', [names(tree.id, "restore", 5), names(tree.id, "bloom", 26, 0, 1), fx(glow.id, "start", 18)]),
    cue("On \"forever\": FOREVER blazes", "The blossoms scatter like light and the word returns.", [show(forever.id)]),
    cue("Resolve to silence", 'NAR: "And the trough held."', [hide(forever.id, 6)]),
  ];
  return s;
}

function scene17(): Scene {
  const golden = makeBackground("Dusk over the hills", { env: { timeOfDay: 0.62, storm: 0 }, transitionDuration: 8 });
  const night = makeBackground("A vast starry sky over the hills of Bethlehem", { initiallyVisible: true, env: { timeOfDay: 1, storm: 0 }, transitionDuration: 10 });
  const sheep = { ...makeBackground("—"), kind: "procedural" as const };
  void sheep;
  const host = makeVideoLayer("The host of angels, rank upon rank (full frame, screen blend)");
  host.placement = "front";
  host.screen = { x: 0.5, y: 0.5, width: 1, rotation: 0, flipX: false };
  host.blend = "screen";
  host.anim = { enter: "fade", exit: "fade", duration: 2.5, stagger: 0 } as never;
  const pillar = makeEffect("glow", { name: "Gabriel's pillar of light", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.5, radius: 0.45, intensity: 1.3, color: "#fff5e2", rays: 1, raySpeed: 0.1, fade: 2.5 } });
  const burst = makeEffect("glow", { name: "The sky EXPLODES with light", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.3, radius: 1.6, intensity: 1.2, color: "#fff0d0", rays: 1.3, raySpeed: 0.25, pulse: 0.2, fade: 1.2 } });
  const flash = makeEffect("lightning", { params: { ...EFFECT_DEFS.lightning.defaults, brightness: 1.6, duration: 0.6, thunder: false } });
  const fog = soft({ initiallyVisible: true, params: { ...EFFECT_DEFS.fog.defaults, density: 0.25, height: 0.18, color: "#9aa5bb", speed: 0.15 } });
  const s = makeScene(0, "Scene 17 · Heaven Can't Keep Quiet (the shepherds)", {
    environment: "shepherd-photoreal",
    notes: "A hillside outside Bethlehem, a cold clear night: the same hills from the Prologue (the photoreal valley at night). Gabriel's pillar; then the sky EXPLODES with light and a vast host of angels fills the wall. At the end the host fades back to peaceful stars and the pillar dims until Gabriel is gone.",
    components: [night, golden, host, pillar, burst, flash, fog],
    markers: { center: [0, -10], flock: [-6, -34], fire: [7, -16] },
    transition: trans("crossfade", 4),
    look: { enabled: true, exposure: 0.95, bloom: 0.45, bloomThreshold: 0.8, contrast: 1.05, saturation: 1.0, warmth: -0.05, vignette: 0.3, grain: 0.04 },
    cameraMotion: { sway: 0.2, speed: 0.06 },
  });
  s.cues = [
    cue("Gabriel: the pillar of light", "A pillar of pure white light where the beam lands.", [fx(pillar.id, "start")]),
    cue("The sky EXPLODES with light: the host of angels", "Moving lights sweep the auditorium; live angels pour onto the stage and into the aisles.", [fx(flash.id, "trigger"), fx(burst.id, "start"), show(host.id, 0.4)]),
    cue("The host fades back to peaceful stars", "At the end of the hymn; the pillar dims until Gabriel is gone.", [hide(host.id), fx(burst.id, "stop"), fx(pillar.id, "stop", 4)]),
  ];
  return s;
}

function scene18(): Scene {
  const room = slot("The lower room of Old Hannah's house (living nativity backdrop)", { initiallyVisible: true, parallax: 0.008 });
  const star = makeEffect("glow", { name: "The STAR · a single brilliant beam", initiallyVisible: true, params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: -0.05, radius: 0.6, intensity: 0.6, color: "#fff6e0", rays: 1.2, raySpeed: 0.03, pulse: 0.1, fade: 4 } });
  const herod = makeImageLayer("Storybook · King Herod smiles at the departing wise men");
  herod.placement = "front";
  herod.screen = { x: 0.5, y: 0.5, width: 0.62, rotation: 0, flipX: false };
  herod.anim = { enter: "fade", exit: "fade", duration: 0.8, stagger: 0 } as never;
  const s = act(0, "Scene 18 · Adoration", "A living nativity under a single brilliant beam: the STAR. A brief 2D storybook image: King Herod on his throne, smiling at three departing wise men; the smile vanishes the moment they turn away.", { components: [room, star, herod], transition: trans("crossfade", 4) });
  s.cues = [
    cue("Storybook: King Herod", 'NAR: "They asked King Herod. That was a mistake."', [show(herod.id)]),
    cue("Back to the nativity", "DAN snorts a laugh. CALEB shushes him.", [hide(herod.id)]),
  ];
  return s;
}

function scene19(): Scene {
  const stars0 = slot("Stars over Bethlehem · still", { initiallyVisible: true, parallax: 0.004 });
  const seasons = slot("CODA · years pass: seasons turn across the hills (video)", { transitionDuration: 4 });
  const stars = makeEffect("stars", { initiallyVisible: true, params: { ...EFFECT_DEFS.stars.defaults, density: 0.6, brightness: 0.9, horizon: 0.6, twinkle: 0.3 } });
  const pillar = makeEffect("glow", { name: "Pillar of light", params: { ...EFFECT_DEFS.glow.defaults, x: 0.5, y: 0.5, radius: 0.4, intensity: 1.2, color: "#fff5e2", rays: 0.9, fade: 1.5 } });
  const map = makeRoute("Map · Egypt… and then home, to Nazareth", { points: [[0.22, 0.78], [0.3, 0.6], [0.42, 0.42], [0.52, 0.3]], label: "NAZARETH", duration: 7, initiallyVisible: false });
  const tree = makeNames("The family tree in full blossom (storybook)", { names: [...GENEALOGY_GOLD, ...GENEALOGY_PLAIN, "JOSEPH"], style: "tree", crown: "JESUS", x: 0.5, y: 0.99, height: 0.9, spread: 0.3, reveal: 0.3, size: 0.042, initiallyVisible: false });
  const forever = goldTitle("FOREVER", { text: "FOREVER", size: 0.14, y: 0.12, glow: 1, anim: { enter: "fade", exit: "fade", duration: 3, stagger: 0 } });
  const s = act(0, "Scene 19 · Arise (Egypt, the coda, the Promise Keeper)", "Stars over Bethlehem, still. A pillar of light: Gabriel's second message. Coda: years pass, seasons turn across the hills; the map, briefly: Egypt… and then home, to Nazareth. The storybook returns one last time: the tree in full blossom, JESUS at the crown; FOREVER glows softly over it.", {
    components: [stars0, seasons, stars, pillar, map, tree, forever],
    transition: trans("fadeblack", 4),
  });
  s.cues = [
    cue("A pillar of light", 'GABRIEL: "Joseph. Get up. Take the child and His mother, and flee to Egypt."', [fx(pillar.id, "start")]),
    cue("The pillar vanishes", "Joseph's eyes open. He doesn't argue.", [fx(pillar.id, "stop")]),
    cue("CODA: years pass, seasons turn", "Spring, summer, harvest, winter, again and again.", [bg(seasons.id), fx(stars.id, "stop")]),
    cue("The map: Egypt… and then home, to Nazareth", "Briefly.", [show(map.id), { type: "route", layerId: map.id, op: "play", delay: 0.5 }, hide(map.id, 10)]),
    cue("THE PROMISE KEEPER: the tree in full blossom, JESUS at the crown", 'NAR: "God told David, \\"I will build you a house.\\""', [bg(stars0.id), names(tree.id, "all"), names(tree.id, "bloom", 6), show(tree.id)]),
    cue("FOREVER glows softly over the tree", 'NAR: "He said forever. And He meant it."', [show(forever.id)]),
  ];
  return s;
}

function scene20(): Scene {
  const temple = slot("Testimony 1 · the Temple courts, morning light through the columns", { initiallyVisible: true, parallax: 0.01 });
  const galilee = slot("Testimony 2 · a crowded street by the Sea of Galilee", { transitionDuration: 4, parallax: 0.01 });
  const hill = slot("Testimony 3 · a dark stormy hill, three crosses in silhouette", { transitionDuration: 4, parallax: 0.01 });
  const blackBg = black("Black (the bridge)", { transitionDuration: 4 });
  const rays = makeEffect("glow", { name: "Morning light through the columns", initiallyVisible: true, params: { ...EFFECT_DEFS.glow.defaults, x: 0.72, y: 0.1, radius: 0.9, intensity: 0.55, color: "#ffe6b8", rays: 1.2, raySpeed: 0.02, fade: 4 } });
  const rain = makeEffect("rain", { params: { ...EFFECT_DEFS.rain.defaults, intensity: 0.5, opacity: 0.5 } });
  const lightning = makeEffect("lightning", { params: { ...EFFECT_DEFS.lightning.defaults, brightness: 0.8, thunderDelay: 2.5 } });
  const verse = makeText("Romans 10:13 (word by word)", {
    text: "“Everyone who calls on the name of the Lord\nwill be saved.”\n— Romans 10:13",
    font: "serif",
    weight: 500,
    uppercase: false,
    size: 0.11,
    color: "#f6efe0",
    glow: 0.5,
    glowColor: "#ffd27a",
    letterSpacing: 0.02,
    lineHeight: 1.35,
    anim: { enter: "words", exit: "fade", duration: 0.9, stagger: 0.42 },
  });
  const s = act(0, "Scene 20 · The Promise Keepers (testimonies and invitation)", "The stage bare; the wall provides a simple backdrop for each story: the Temple courts; a street by the Sea of Galilee; a dark stormy hill with three crosses. The bridge: the verse appears, beautifully, word by word.", {
    components: [temple, galilee, hill, blackBg, rays, rain, lightning, verse],
    transition: trans("crossfade", 4),
  });
  s.cues = [
    cue("Testimony 2 · the Sea of Galilee", "JAIRUS steps into his light.", [bg(galilee.id), fx(rays.id, "stop")]),
    cue("Testimony 3 · the stormy hill, three crosses", "THE MAN ON THE CROSS, in a harsh cold spotlight.", [bg(hill.id), fx(rain.id, "start", 1), fx(lightning.id, "trigger", 6)]),
    cue("The bridge: the verse, word by word", 'NAR: "That same name is the one God has given to you." Romans 10:13.', [bg(blackBg.id), fx(rain.id, "stop"), show(verse.id, 2)]),
    cue("The invitation", "The PASTOR walks forward. Hold the verse, then let it go gently.", [hide(verse.id, 20)]),
  ];
  return s;
}

function scene21(): Scene {
  const sky = slot("Finale backdrop (storybook sky)", { initiallyVisible: true, parallax: 0.01 });
  const tree = makeNames("The blossoming family tree", { names: [...GENEALOGY_GOLD, ...GENEALOGY_PLAIN, "JOSEPH"], style: "tree", crown: "JESUS", x: 0.5, y: 0.99, height: 0.9, spread: 0.3, reveal: 0.3, size: 0.042, initiallyVisible: true });
  const forever = goldTitle("FOREVER", { text: "FOREVER", size: 0.14, y: 0.1, glow: 1.4, initiallyVisible: true, anim: { enter: "fade", exit: "fade", duration: 2, stagger: 0 } });
  const david = makeImageLayer("Storybook · the shepherd boy David, smiling");
  david.placement = "front";
  david.screen = { x: 0.84, y: 0.62, width: 0.14, rotation: 0, flipX: false };
  david.anim = { enter: "scale", exit: "fade", duration: 1.2, stagger: 0 } as never;
  const stars = makeEffect("stars", { initiallyVisible: true, params: { ...EFFECT_DEFS.stars.defaults, density: 0.5, brightness: 0.7, horizon: 0.75 } });
  const s = act(0, "Scene 21 · Big Celebration (finale)", "The blossoming family tree returns, JESUS at the crown, FOREVER glowing above it. In the storybook art the shepherd boy David appears briefly, smiling. Confetti, full lights, big button.", {
    components: [sky, tree, forever, david, stars],
    transition: trans("crossfade", 3),
  });
  s.cues = [
    cue("The tree in full blossom, FOREVER above it", "As the company floods back.", [names(tree.id, "all"), names(tree.id, "bloom", 0.5)]),
    cue("The shepherd boy David appears, smiling", "Briefly.", [show(david.id), hide(david.id, 8)]),
  ];
  return s;
}

// ---------------------------------------------------------------- assembly

/** Scenes for the whole show after the built prologue (P1–P4), in running order. */
export function showScaffoldScenes(): Scene[] {
  const p5 = kingAndPromise();
  const p6 = theNames();
  const p7 = theMap();
  const s1 = scene1();
  const map1 = mapScene(0, "Scene 1b · The Map: Bethlehem → Nazareth", "NAZARETH", 'THE MAP returns. A glowing line traces from Bethlehem north, through the hills of Samaria, all the way to a small village in Galilee: NAZARETH.', [[0.44, 0.78], [0.47, 0.66], [0.5, 0.55], [0.52, 0.42], [0.55, 0.3]], 'NAR: "Joseph thought he was leaving the house of David behind. He was carrying it with him. Along with the figs."');
  const s2 = scene2();
  const s3 = plateScene("Scene 3 · Mary's House (evening)", "Eli's house · warm evening lamplight", "Warm evening lamplight on Eli's house, stage right. The front door hangs crooked on one leather hinge.");
  const s4 = plateScene("Scene 4 · The Footprints (early morning)", "Joseph's stall · pale, cool early morning", "Pale, cool early morning. Joseph is packing.");
  const s5 = scene5();
  const s7 = scene7();
  const s8 = scene8();
  const s10 = scene10();
  const inter = intermission();
  const rew = rewind();
  const s11 = scene11();
  const s12 = scene12();
  const s13 = scene13();
  const map14 = mapScene(0, "Scene 14a · The Map: Nazareth → Bethlehem", "BETHLEHEM", "THE MAP. The same map as Act I. The glowing line now traces from Nazareth south, through Samaria, toward Bethlehem.", [[0.55, 0.3], [0.52, 0.42], [0.5, 0.55], [0.47, 0.66], [0.44, 0.78]], "Joseph leads, holding Goliath's rope.");
  const s14 = scene14();
  const s15 = scene15();
  const s16 = scene16();
  const s17 = scene17();
  const s18 = scene18();
  const s19 = scene19();
  const s20 = scene20();
  const s21 = scene21();
  const scenes = [p5, p6, p7, s1, map1, s2, s3, s4, s5, s7, s8, s10, inter, rew, s11, s12, s13, map14, s14, s15, s16, s17, s18, s19, s20, s21];
  // Chain the hand-overs the script calls for.
  const chain = (from: Scene, to: Scene, transition: TransitionSpec | null = null) => {
    const last = from.cues[from.cues.length - 1];
    if (last && last.actions.length === 0) last.actions = [take(to.id, transition)];
  };
  chain(p5, p6, trans("crossfade", 1.5));
  chain(p6, p7, trans("dissolve", 1.5));
  chain(p7, s1, trans("cut", 0));
  chain(s1, map1, trans("dissolve", 1.5));
  return scenes;
}
