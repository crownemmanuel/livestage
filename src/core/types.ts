// Serializable data model for Salvation Live Studio.
// Everything here must survive JSON round-trips: it is saved to disk and
// broadcast between the operator and output windows.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

// ---------------------------------------------------------------- assets

export type AssetType = "image" | "video" | "model" | "audio";

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  /** URL the webview can load (asset protocol URL in Tauri, blob URL in browser dev). */
  url: string;
  /** Absolute path on disk when stored in the app library (Tauri only). */
  path?: string;
  /** Blob URLs disappear when the app reloads. */
  ephemeral?: boolean;
  /** Video/image declares an alpha channel (WebM VP9 alpha, HEVC alpha, PNG). */
  hasAlpha?: boolean;
  /** HEVC-with-alpha twin of a transparent WebM, played on WebKit (macOS), which cannot decode VP9 alpha. */
  macUrl?: string;
  /** Ships with the app (served from /media); never deleted from disk. */
  builtIn?: boolean;
}

// ---------------------------------------------------------------- output

export type ScalingMode = "fit" | "fill" | "stretch" | "native";

export interface OutputSettings {
  canvasWidth: number;
  canvasHeight: number;
  monitorName: string | null;
  fullscreen: boolean;
  windowWidth: number;
  windowHeight: number;
  scaling: ScalingMode;
  targetFps: number;
  backgroundColor: string;
  safeArea: { enabled: boolean; marginPct: number; showOnOutput: boolean };
  testPattern: boolean;
  standby: { text: string; subtext: string; assetId: string | null; color: string };
  /** Which window plays program audio (thunder, transition audio, layer audio). */
  audioHost: "output" | "operator";
}

// ---------------------------------------------------------------- scene

export type EnvironmentPreset = "lion-hills" | "shepherd-valley" | "shepherd-photoreal" | "none";

/** Camera "look": HDR render with bloom and a filmic grade, like a cinema camera. */
export interface LookSettings {
  enabled: boolean;
  exposure: number;
  bloom: number;
  bloomThreshold: number;
  contrast: number;
  saturation: number;
  /** -1 cool … +1 warm */
  warmth: number;
  vignette: number;
  grain: number;
}

export type FitMode = "cover" | "contain" | "stretch";

export interface Crop {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MediaSettings {
  assetId: string | null;
  loop: boolean;
  playbackRate: number;
  startTime: number;
  endTime: number | null;
  muted: boolean;
  volume: number;
}

/** Screen-space layers use normalized canvas coordinates (0..1, y down). */
export interface ScreenTransform {
  x: number;
  y: number;
  /** Width as a fraction of canvas width. Height follows the media aspect. */
  width: number;
  rotation: number;
  flipX: boolean;
}

/** World-space layers are billboards standing in the 3D environment. */
export interface WorldTransform {
  position: Vec3;
  /** Height in metres; width follows the media aspect. */
  height: number;
  rotationY: number;
  billboard: boolean;
}

export type LayerPlacement = "back" | "front" | "world";

export interface ChromaKey {
  enabled: boolean;
  color: string;
  similarity: number;
  smoothness: number;
  spill: number;
}

export interface LayerMask {
  shape: "none" | "rect" | "ellipse";
  feather: number;
}

export type EntranceKind = "none" | "fade" | "slide-left" | "slide-right" | "slide-up" | "scale";

export interface EntranceExit {
  enter: EntranceKind;
  exit: EntranceKind;
  duration: number;
}

/** Independent looping walkers ("people crossing the market"). */
export interface WalkerSettings {
  enabled: boolean;
  direction: 1 | -1;
  /** Fraction of canvas width per second (screen) or metres per second (world). */
  speed: number;
  fromX: number;
  toX: number;
  yJitter: number;
  scaleJitter: number;
  delayMin: number;
  delayMax: number;
  instances: number;
  seed: number;
}

export type BlendMode = "normal" | "add" | "screen" | "multiply";

interface ComponentBase {
  id: string;
  name: string;
  /** Visible/active when the scene is taken live. */
  initiallyVisible: boolean;
}

export interface BackgroundComponent extends ComponentBase {
  kind: "background";
  source: "environment" | "media";
  /** For environment backgrounds: the look this background selects. */
  env: { timeOfDay: number; storm: number };
  media: MediaSettings;
  fit: FitMode;
  crop: Crop;
  /** Vertical framing when the plate is taller than the wall: 0 shows the top, 1 the bottom. */
  anchorY?: number;
  opacity: number;
  /** Crossfade / relight duration when this background is activated. */
  transitionDuration: number;
}

export interface MediaLayerCommon {
  placement: LayerPlacement;
  screen: ScreenTransform;
  world: WorldTransform;
  opacity: number;
  crop: Crop;
  mask: LayerMask;
  blend: BlendMode;
  anim: EntranceExit;
  walker: WalkerSettings;
}

export interface VideoLayerComponent extends ComponentBase, MediaLayerCommon {
  kind: "video";
  media: MediaSettings;
  chroma: ChromaKey;
}

export interface ImageLayerComponent extends ComponentBase, MediaLayerCommon {
  kind: "image";
  assetId: string | null;
  motion: { type: "none" | "float" | "spin" | "pulse"; amount: number; speed: number };
}

export interface ModelComponent extends ComponentBase {
  kind: "model";
  assetId: string | null;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  clip: string | null;
  loop: boolean;
  castShadow: boolean;
  material: { tint: string; roughness: number | null; metalness: number | null; emissive: number };
}

export type LionAction = "idle" | "walk" | "run" | "turn" | "roar" | "attack" | "hit" | "fall";

export const LION_ACTIONS: LionAction[] = ["idle", "walk", "run", "turn", "roar", "attack", "hit", "fall"];

export interface ActorComponent extends ComponentBase {
  kind: "actor";
  actorType: "lion";
  /** GLB/glTF asset. When null, the clearly labelled procedural placeholder is used. */
  assetId: string | null;
  /** Map semantic actions to clip names inside the GLB. */
  clipMap: Partial<Record<LionAction, string>>;
  start: { marker: string; heading: number };
  scale: number;
  /** Model forward axis correction (radians) for GLBs authored facing another way. */
  modelYaw: number;
  speeds: { walk: number; run: number; turnRate: number };
  /** Distance covered by one full clip cycle — keeps feet planted. */
  stride: { walk: number; run: number };
  bounds: { xMin: number; xMax: number; zMin: number; zMax: number };
}

export type EffectType = "rain" | "lightning" | "fog" | "haze" | "wind" | "daynight" | "shake" | "projectile";

export type EffectParams = Record<string, number | string | boolean>;

export interface EffectComponent extends ComponentBase {
  kind: "effect";
  effect: EffectType;
  presetId: string | null;
  params: EffectParams;
}

/** Built-in procedural elements of the 3D environments (flocks, fires, lights). */
export type ProceduralElement = "birds" | "sheep" | "campfire" | "town-lights";

export interface ProceduralComponent extends ComponentBase {
  kind: "procedural";
  element: ProceduralElement;
  count: number;
  /** Centre of the element's area in world metres (x, z). */
  center: Vec2;
  radius: number;
  fade: number;
}

/** One AI/pre-rendered clip of a video actor, tagged with the pose it starts and ends on. */
export interface ClipDef {
  id: string;
  name: string;
  assetId: string | null;
  /** Same clip with the background removed (transparent WebM); used when the actor is in cut-out mode. */
  cutoutAssetId?: string | null;
  /** Pose names, e.g. "empty" (no lion), "hero" (standing pose). Clips chain when end pose = next start pose. */
  startPose: string;
  endPose: string;
  /** Seconds. Needed so every window agrees when a queued clip begins. */
  duration: number;
  loop: boolean;
  /** Looping clip that plays automatically whenever another clip finishes on its pose. */
  autoIdle?: boolean;
  /**
   * Start at once instead of waiting for the current clip or loop to reach its
   * end (a hard cut). Use for urgent beats out of gentle idle loops.
   */
  interrupt?: boolean;
}

/**
 * A photoreal character made of pre-rendered full-frame clips (AI video).
 * Clips are cut only where poses match, so the sequence plays as one take.
 */
export interface ClipActorComponent extends ComponentBase {
  kind: "clipActor";
  clips: ClipDef[];
  /** Pose before any clip has played ("empty" = nothing drawn, the plate shows). */
  restPose: string;
  /** Aspect of the matching background plate; clips are fitted to the same rectangle so frames line up. */
  frameAspect: number;
  fit: FitMode;
  /** Must match the plate's anchorY so clip frames line up with it. */
  anchorY?: number;
  /**
   * Clips have a transparent background (cut-out), so the actor can be scaled,
   * moved and mirrored over the plate. Layout values are in frame-normalized units.
   */
  matted?: boolean;
  layout?: ActorLayout;
  muted: boolean;
  volume: number;
}

export interface ActorLayout {
  scale: number;
  /** Offsets as a fraction of frame width / height. */
  x: number;
  y: number;
  mirror: boolean;
  /** The character's ground contact point in the source frame (0..1, y down); scaling pivots here. */
  pivotX: number;
  pivotY: number;
  /** Shrinking moves the feet toward the horizon so the actor reads as further away. */
  depthLink: boolean;
  horizonY: number;
  /** Soft contact shadow under the feet (cut-outs lose their original shadow). */
  shadow: number;
}

export type SceneComponent =
  | BackgroundComponent
  | ClipActorComponent
  | ProceduralComponent
  | VideoLayerComponent
  | ImageLayerComponent
  | ModelComponent
  | ActorComponent
  | EffectComponent;

export type ComponentKind = SceneComponent["kind"];

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  /** Horizontal field of view in degrees (works for any wall aspect). */
  hfov: number;
}

export interface CameraShot {
  id: string;
  name: string;
  pose: CameraPose;
  duration: number;
  ease: "linear" | "inOut" | "out";
  /** When set, the target (and an offset position) are taken from this actor at trigger time. */
  followActorId: string | null;
  followOffset: Vec3;
}

export type TransitionKind = "cut" | "crossfade" | "fadeblack" | "dissolve" | "video" | "travel";

export interface TransitionSpec {
  kind: TransitionKind;
  duration: number;
  videoAssetId: string | null;
  audioAssetId: string | null;
  /** For travel: how far the virtual camera flies (metres). */
  travelDistance: number;
}

export type CueAction =
  | { type: "lion"; actorId: string; action: LionAction; delay: number }
  | { type: "lion.moveTo"; actorId: string; marker: string; gait: "walk" | "run"; delay: number }
  | { type: "lion.place"; actorId: string; marker: string; heading: number; delay: number }
  | { type: "actor.visible"; actorId: string; visible: boolean; delay: number }
  | { type: "effect"; effectId: string; op: "start" | "stop" | "toggle" | "trigger"; delay: number }
  | { type: "background"; backgroundId: string; delay: number }
  | { type: "layer"; layerId: string; op: "show" | "hide" | "toggle" | "restart"; delay: number }
  | { type: "camera"; shotId: string; delay: number }
  | { type: "timeOfDay"; value: number; duration: number; delay: number }
  | { type: "takeScene"; sceneId: string; transition: TransitionSpec | null; delay: number }
  /** Play a clip on a video actor (queued to the next matching cut point); clipId null clears the actor. */
  | { type: "clip"; actorId: string; clipId: string | null; delay: number }
  /** Fade the whole wall to black (lights out) or back. Acts on the live output. */
  | { type: "blackout"; on: boolean; fade: number; delay: number };

export type CueActionType = CueAction["type"];

export interface Cue {
  id: string;
  name: string;
  notes: string;
  actions: CueAction[];
}

export interface Scene {
  id: string;
  number: number;
  name: string;
  notes: string;
  /** Planned duration in seconds (informational). */
  duration: number | null;
  environment: EnvironmentPreset;
  components: SceneComponent[];
  cameraShots: CameraShot[];
  defaultShotId: string | null;
  markers: Record<string, Vec2>;
  cues: Cue[];
  transition: TransitionSpec;
  thumbnail: string | null;
  look?: LookSettings;
}

export interface EffectPreset {
  id: string;
  name: string;
  effect: EffectType;
  params: EffectParams;
}

export interface Project {
  version: 1;
  name: string;
  scenes: Scene[];
  assets: Asset[];
  effectPresets: EffectPreset[];
  output: OutputSettings;
  /** Built-in demo content already merged into this show file (so deletions stick). */
  demoAdditions?: string[];
}

// ---------------------------------------------------------------- runtime

/** A value animated between two states, evaluated from a shared clock. */
export interface Tween {
  from: number;
  to: number;
  /** Scene time (ms) the tween started. */
  at: number;
  dur: number;
}

export interface LayerRuntime {
  visible: boolean;
  changedAt: number;
  /** Scene time media playback (re)started. */
  startAt: number;
}

export interface EffectRuntime {
  active: boolean;
  changedAt: number;
  params: EffectParams;
}

export interface LightningStrike {
  id: string;
  at: number;
  seed: number;
  brightness: number;
  duration: number;
  /** Horizontal position of the bolt, 0..1 across the canvas. */
  x: number;
  thunder: boolean;
  thunderDelay: number;
}

export interface CameraRuntime {
  from: CameraPose;
  to: CameraPose;
  at: number;
  dur: number;
  ease: CameraShot["ease"];
}

/**
 * Playback state of one scene instance. Times are "scene time" in ms,
 * measured from the scene clock so a paused scene freezes everything.
 */
export interface SceneRuntime {
  key: string;
  scene: Scene;
  clock: { base: number; pausedAt: number | null };
  background: { current: string | null; previous: string | null; changedAt: number; dur: number };
  env: { timeOfDay: Tween; storm: Tween };
  layers: Record<string, LayerRuntime>;
  effects: Record<string, EffectRuntime>;
  strikes: LightningStrike[];
  camera: CameraRuntime;
  cuePointer: number;
  /** Video actors: the clips scheduled so far (scene time ms). */
  clipActors: Record<string, ClipActorRuntime>;
  /** One-shot effect events (shake, projectile): scene time they fired. */
  triggers?: { id: string; effectId: string; at: number }[];
}

export interface ClipSegment {
  clipId: string;
  at: number;
}

export interface ClipActorRuntime {
  segments: ClipSegment[];
}

export interface ActorState {
  pos: Vec2;
  heading: number;
  action: LionAction;
  actionAt: number;
  prevAction: LionAction;
  prevActionAt: number;
  /** Monotonic stride counter; drives the gait cycle so feet do not slide. */
  gaitPhase: number;
  speed: number;
  visible: boolean;
  visibleChangedAt: number;
  /** Continuous locomotion requested by keys 2/3 (forward along heading). */
  cruise: "walk" | "run" | null;
  target: Vec2 | null;
  targetGait: "walk" | "run";
}

export type ActorPoses = Record<string, ActorState>;

export interface ProgramTransition {
  spec: TransitionSpec;
  /** Wall-clock ms. */
  startedAt: number;
  from: SceneRuntime | null;
  fromPoses: ActorPoses;
  fromStandby: boolean;
}

export interface ProgramState {
  runtime: SceneRuntime | null;
  standby: boolean;
  standbyChangedAt: number;
  transition: ProgramTransition | null;
  /** Bumped on each TAKE so views can remount cleanly. */
  takeCount: number;
  /** Lights-out: the whole wall fades to black (wall-clock ms of the change). */
  blackout?: { on: boolean; at: number; fade: number };
}
