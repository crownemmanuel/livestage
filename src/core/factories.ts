import { EFFECT_DEFS } from "./effects";
import { uid } from "./ids";
import type {
  ActorComponent,
  BackgroundComponent,
  CameraMotion,
  IoSettings,
  KenBurns,
  NamesComponent,
  PlateLight,
  RouteComponent,
  TextComponent,
  ClipActorComponent,
  ClipDef,
  CameraShot,
  Cue,
  EffectComponent,
  EffectType,
  ImageLayerComponent,
  MediaLayerCommon,
  MediaSettings,
  ModelComponent,
  OutputSettings,
  ProceduralComponent,
  Scene,
  SceneComponent,
  TransitionSpec,
  VideoLayerComponent,
} from "./types";

export const defaultMedia = (assetId: string | null = null): MediaSettings => ({
  assetId,
  loop: true,
  playbackRate: 1,
  startTime: 0,
  endTime: null,
  muted: true,
  volume: 1,
});

const layerCommon = (): MediaLayerCommon => ({
  placement: "front",
  screen: { x: 0.5, y: 0.6, width: 0.25, rotation: 0, flipX: false },
  world: { position: [0, 0, -10], height: 2, rotationY: 0, billboard: true },
  opacity: 1,
  crop: { left: 0, right: 0, top: 0, bottom: 0 },
  mask: { shape: "none", feather: 0.05 },
  blend: "normal",
  anim: { enter: "fade", exit: "fade", duration: 1 },
  walker: {
    enabled: false,
    direction: 1,
    speed: 0.05,
    fromX: -0.15,
    toX: 1.15,
    yJitter: 0.03,
    scaleJitter: 0.12,
    delayMin: 1,
    delayMax: 6,
    instances: 1,
    seed: Math.floor(Math.random() * 1e6),
  },
});

export function makeBackground(name: string, partial: Partial<BackgroundComponent> = {}): BackgroundComponent {
  return {
    id: uid("bg"),
    kind: "background",
    name,
    initiallyVisible: false,
    source: "environment",
    env: { timeOfDay: 0, storm: 0 },
    media: defaultMedia(),
    fit: "cover",
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    opacity: 1,
    transitionDuration: 6,
    ...partial,
  };
}

export function makeVideoLayer(name: string, assetId: string | null = null): VideoLayerComponent {
  return {
    id: uid("vid"),
    kind: "video",
    name,
    initiallyVisible: false,
    ...layerCommon(),
    media: defaultMedia(assetId),
    chroma: { enabled: false, color: "#00ff00", similarity: 0.35, smoothness: 0.08, spill: 0.3 },
  };
}

export function makeImageLayer(name: string, assetId: string | null = null): ImageLayerComponent {
  return {
    id: uid("img"),
    kind: "image",
    name,
    initiallyVisible: false,
    ...layerCommon(),
    assetId,
    motion: { type: "none", amount: 0.02, speed: 0.3 },
  };
}

export function makeModel(name: string, assetId: string | null = null): ModelComponent {
  return {
    id: uid("mdl"),
    kind: "model",
    name,
    initiallyVisible: true,
    assetId,
    position: [0, 0, -8],
    rotation: [0, 0, 0],
    scale: 1,
    clip: null,
    loop: true,
    castShadow: true,
    material: { tint: "#ffffff", roughness: null, metalness: null, emissive: 0 },
  };
}

export function makeLion(name = "Lion", partial: Partial<ActorComponent> = {}): ActorComponent {
  return {
    id: uid("lion"),
    kind: "actor",
    actorType: "lion",
    name,
    initiallyVisible: false,
    assetId: null,
    clipMap: {
      idle: "Idle",
      walk: "Walk",
      run: "Run",
      turn: "Walk",
      roar: "Roar",
      attack: "Attack",
      hit: "Hit",
      fall: "Death",
    },
    start: { marker: "distance", heading: Math.PI * 0.85 },
    scale: 1,
    modelYaw: 0,
    speeds: { walk: 1.45, run: 6.2, turnRate: 1.9 },
    stride: { walk: 1.65, run: 4.2 },
    bounds: { xMin: -14, xMax: 14, zMin: -60, zMax: 7 },
    ...partial,
  };
}

export function makeEffect(effect: EffectType, partial: Partial<EffectComponent> = {}): EffectComponent {
  return {
    id: uid("fx"),
    kind: "effect",
    name: EFFECT_DEFS[effect].label,
    initiallyVisible: false,
    effect,
    presetId: null,
    params: { ...EFFECT_DEFS[effect].defaults },
    ...partial,
  };
}

export function makeShot(name: string, partial: Partial<CameraShot> = {}): CameraShot {
  return {
    id: uid("cam"),
    name,
    pose: { position: [0, 1.7, 12], target: [0, 1.4, -20], hfov: 72 },
    duration: 4,
    ease: "inOut",
    followActorId: null,
    followOffset: [0, 1.2, 7],
    ...partial,
  };
}

export const defaultTransition = (): TransitionSpec => ({
  kind: "crossfade",
  duration: 2,
  videoAssetId: null,
  audioAssetId: null,
  travelDistance: 60,
});

export function makeScene(number: number, name: string, partial: Partial<Scene> = {}): Scene {
  const wide = makeShot("Wide");
  return {
    id: uid("scene"),
    number,
    name,
    notes: "",
    duration: null,
    environment: "none",
    components: [],
    cameraShots: [wide],
    defaultShotId: wide.id,
    markers: { center: [0, -6] },
    cues: [],
    transition: defaultTransition(),
    thumbnail: null,
    ...partial,
  };
}

export function makeCue(name: string, actions: Cue["actions"] = []): Cue {
  return { id: uid("cue"), name, notes: "", actions };
}

export function defaultOutput(): OutputSettings {
  return {
    // The show's LED wall: 3072 × 768 (4:1).
    canvasWidth: 3072,
    canvasHeight: 768,
    monitorName: null,
    fullscreen: true,
    windowWidth: 1280,
    windowHeight: 320,
    // The wall's processor takes a 1920×720 signal and spreads it over the 3072×768 wall: Stretch fills it.
    scaling: "stretch",
    targetFps: 60,
    backgroundColor: "#000000",
    safeArea: { enabled: true, marginPct: 5, showOnOutput: false },
    testPattern: false,
    standby: { text: "SALVATION 2026", subtext: "The House of David", assetId: null, color: "#000000" },
    timerOverlay: defaultTimerOverlay(),
  };
}

export const defaultTimerOverlay = (): import("./types").TimerOverlayStyle => ({
  position: "bottom-right",
  size: 0.09,
  font: "display",
  color: "#ffffff",
  background: "#000000",
  backgroundOpacity: 0.55,
  showLabel: true,
  margin: 0.05,
});

/** Deep copy a component with fresh ids (used by duplicate). */
export function cloneComponent<T extends SceneComponent>(c: T): T {
  const copy = structuredClone(c);
  copy.id = uid(c.kind);
  copy.name = `${c.name} copy`;
  return copy;
}

/** Duplicate a scene, remapping component ids inside cues and shots. */
export function cloneScene(s: Scene, number: number): Scene {
  const copy = structuredClone(s);
  const idMap = new Map<string, string>();
  copy.id = uid("scene");
  copy.number = number;
  copy.name = `${s.name} (copy)`;
  copy.thumbnail = s.thumbnail;
  for (const c of copy.components) {
    const nid = uid(c.kind);
    idMap.set(c.id, nid);
    c.id = nid;
  }
  for (const sh of copy.cameraShots) {
    const nid = uid("cam");
    idMap.set(sh.id, nid);
    sh.id = nid;
    if (sh.followActorId) sh.followActorId = idMap.get(sh.followActorId) ?? null;
  }
  if (copy.defaultShotId) copy.defaultShotId = idMap.get(copy.defaultShotId) ?? null;
  const remap = (id: string) => idMap.get(id) ?? id;
  for (const cue of copy.cues) {
    cue.id = uid("cue");
    for (const a of cue.actions) {
      if ("actorId" in a) a.actorId = remap(a.actorId);
      if ("effectId" in a) a.effectId = remap(a.effectId);
      if ("layerId" in a) a.layerId = remap(a.layerId);
      if ("backgroundId" in a) a.backgroundId = remap(a.backgroundId);
      if ("shotId" in a) a.shotId = remap(a.shotId);
    }
  }
  return copy;
}

export function makeProcedural(
  element: ProceduralComponent["element"],
  partial: Partial<ProceduralComponent> = {},
): ProceduralComponent {
  const names = { birds: "Birds", sheep: "Sheep", campfire: "Shepherds' Fire", "town-lights": "Town Lights" };
  return {
    id: uid(element.slice(0, 5)),
    kind: "procedural",
    name: names[element],
    initiallyVisible: true,
    element,
    count: element === "birds" ? 18 : element === "sheep" ? 28 : 1,
    center: [0, -40],
    radius: 20,
    fade: 2,
    ...(element === "birds" ? { altitude: [25, 70] as [number, number], color: "#1b1a1d", haze: 0.35 } : {}),
    ...partial,
  };
}

export function makeClip(name: string, partial: Partial<ClipDef> = {}): ClipDef {
  return { id: uid("clip"), name, assetId: null, startPose: "hero", endPose: "hero", duration: 5, loop: false, ...partial };
}

export function makeClipActor(name = "Video Actor", partial: Partial<ClipActorComponent> = {}): ClipActorComponent {
  return {
    id: uid("vact"),
    kind: "clipActor",
    name,
    initiallyVisible: true,
    clips: [],
    restPose: "empty",
    frameAspect: 21 / 9,
    fit: "cover",
    muted: false,
    volume: 1,
    ...partial,
  };
}

export const defaultActorLayout = (): import("./types").ActorLayout => ({
  scale: 1,
  x: 0,
  y: 0,
  mirror: false,
  pivotX: 0.5,
  pivotY: 0.75,
  depthLink: true,
  horizonY: 0.25,
  shadow: 0.5,
});

export const defaultKenBurns = (): KenBurns => ({
  enabled: false,
  from: { x: 0, y: 0, scale: 1 },
  to: { x: 0.02, y: -0.01, scale: 1.12 },
  duration: 20,
  loop: "none",
});

export const defaultCameraMotion = (): CameraMotion => ({ sway: 0, speed: 0.08 });

export const defaultPlateLight = (): PlateLight => ({
  azimuth: 35,
  elevation: 40,
  color: "#fff1dc",
  intensity: 2.6,
  ambient: "#8a9bb8",
  ambientIntensity: 0.9,
  shadow: 0.45,
});

export function makeText(name = "Title", partial: Partial<TextComponent> = {}): TextComponent {
  return {
    id: uid("txt"),
    kind: "text",
    name,
    initiallyVisible: false,
    text: "TITLE",
    font: "serif",
    weight: 500,
    italic: false,
    uppercase: true,
    size: 0.14,
    color: "#f3ead6",
    glow: 0.4,
    glowColor: "#ffd27a",
    letterSpacing: 0.18,
    lineHeight: 1.25,
    align: "center",
    x: 0.5,
    y: 0.5,
    width: 0.9,
    shadow: 0.3,
    blend: "normal",
    anim: { enter: "fade", exit: "fade", duration: 1.5, stagger: 0.08 },
    ...partial,
  };
}

/** Matthew 1 genealogy, David → Joseph, as the script splits it. */
export const GENEALOGY_GOLD = ["DAVID", "SOLOMON", "REHOBOAM", "ABIJAH", "ASA", "JEHOSHAPHAT", "JORAM", "UZZIAH", "JOTHAM", "AHAZ", "HEZEKIAH", "MANASSEH", "AMON", "JOSIAH", "JECONIAH"];
export const GENEALOGY_PLAIN = ["SHEALTIEL", "ZERUBBABEL", "ABIUD", "ELIAKIM", "AZOR", "ZADOK", "ACHIM", "ELIUD", "ELEAZAR", "MATTHAN", "JACOB"];

export function makeNames(name = "Family Tree", partial: Partial<NamesComponent> = {}): NamesComponent {
  return {
    id: uid("names"),
    kind: "names",
    name,
    initiallyVisible: true,
    names: [...GENEALOGY_GOLD],
    style: "tree",
    font: "serif",
    color: "#ffd27a",
    glow: 0.8,
    size: 0.06,
    x: 0.5,
    y: 0.97,
    height: 0.86,
    spread: 0.28,
    reveal: 1.4,
    branchColor: "#c99a3a",
    seed: 3,
    crown: "",
    ...partial,
  };
}

export function makeRoute(name = "Map Route", partial: Partial<RouteComponent> = {}): RouteComponent {
  return {
    id: uid("route"),
    kind: "route",
    name,
    initiallyVisible: true,
    assetId: null,
    fit: "cover",
    points: [
      [0.3, 0.72],
      [0.36, 0.6],
      [0.42, 0.48],
      [0.47, 0.35],
      [0.55, 0.24],
    ],
    color: "#ffd27a",
    width: 0.008,
    glow: 1,
    duration: 8,
    label: "NAZARETH",
    labelColor: "#f3ead6",
    labelSize: 0.06,
    zoom: { ...defaultKenBurns(), enabled: false, duration: 8 },
    opacity: 1,
    ...partial,
  };
}

export function defaultIo(): IoSettings {
  return {
    midi: { enabled: false, input: null, output: null, mscDeviceId: 0, mscAuto: true },
    osc: { enabled: false, listenPort: 9000, targets: [{ id: "osc_hog", name: "Hog 4", host: HOG_DEFAULT_HOST, port: 7001 }], notifyTarget: "osc_hog", notify: false },
    triggers: [],
    hogItems: defaultHogItems(),
  };
}

/** The Hog's factory HogNet address (also this venue's console). */
export const HOG_DEFAULT_HOST = "172.31.0.1";

/** Cuelists on the venue console's playback bar (2026-10-18), as a starting library. */
export function defaultHogItems(): import("./types").HogItem[] {
  const lists: [string, string][] = [
    ["House Light", "205"],
    ["Haze", "210"],
    ["Face Up", "341"],
    ["Crowd", "111"],
    ["Grid", "199"],
    ["Moving Heads", "3"],
    ["Band Red", "81"],
  ];
  return lists.map(([name, number]) => ({ id: `hog_${number}`, name, kind: "cuelist", number }));
}

export const defaultLook = (): import("./types").LookSettings => ({
  enabled: true,
  exposure: 1,
  bloom: 0.35,
  bloomThreshold: 0.85,
  contrast: 1.05,
  saturation: 1.05,
  warmth: 0.1,
  vignette: 0.25,
  grain: 0.04,
});

// ---------------------------------------------------------------- scene groups

export const GROUP_COLORS: import("./types").GroupColor[] = ["amber", "red", "orange", "green", "teal", "blue", "violet", "pink", "gray"];

/** Hex per group colour, readable on the dark operator UI. */
export const GROUP_HEX: Record<import("./types").GroupColor, string> = {
  amber: "#f2b544",
  red: "#e5483b",
  orange: "#f08a3c",
  green: "#3fbf6f",
  teal: "#2fb5a8",
  blue: "#4c8df0",
  violet: "#9b7cf0",
  pink: "#e46aa6",
  gray: "#8a8f98",
};

export function makeGroup(name: string, color: import("./types").GroupColor = "amber"): import("./types").SceneGroup {
  return { id: uid("grp"), name, color, flow: true };
}

// ---------------------------------------------------------------- timers and announcements

export function makeTimer(name: string, duration: number): import("./types").ShowTimer {
  return { id: uid("tmr"), name, duration, endAnnouncementId: null };
}

/** Every show starts with a pre-show and an intermission clock. */
export function defaultTimers(): import("./types").ShowTimer[] {
  return [
    { id: "tmr_preshow", name: "Pre-show", duration: 5 * 60, endAnnouncementId: null },
    { id: "tmr_intermission", name: "Intermission", duration: 15 * 60, endAnnouncementId: null },
  ];
}

export function makeAnnouncement(name: string, assetId: string | null): import("./types").Announcement {
  return { id: uid("ann"), name, assetId, volume: 1 };
}

/** A holding scene with a big countdown, started by its first cue. */
export function makeIntermissionScene(timerId: string): Scene {
  const title = makeText("Countdown", { text: "WE'LL BE BACK IN\n{time}", timerId, initiallyVisible: true, size: 0.12, y: 0.5, glow: 0.5 });
  const s = makeScene(0, "Intermission", { components: [title], transition: { ...defaultTransition(), kind: "crossfade", duration: 2 } });
  s.cues = [makeCue("Start the intermission clock", [{ type: "timer", timerId, op: "restart", delay: 0 }])];
  s.cues[0].notes = "GO as the house lights come up.";
  return s;
}
