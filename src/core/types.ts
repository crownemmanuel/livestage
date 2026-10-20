// Serializable data model for Live Studio.
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
  /** Absolute path on disk when stored in the app library (Tauri only). Derived from `file` on load. */
  path?: string;
  /**
   * Portable location: a key relative to the show's media folder (the app data folder on the desktop),
   * e.g. "assets/asset_x_take.mp4" or "media/prologue/p1.mp4". Set for library files and for media that
   * arrived in a show package or sync; when that file is there, it is played instead of `url`.
   */
  file?: string;
  /** Portable key of the HEVC-alpha twin (see `macUrl`). */
  macFile?: string;
  /** Blob URLs disappear when the app reloads. */
  ephemeral?: boolean;
  /** Video/image declares an alpha channel (WebM VP9 alpha, HEVC alpha, PNG). */
  hasAlpha?: boolean;
  /** HEVC-with-alpha twin of a transparent WebM, played on WebKit (macOS), which cannot decode VP9 alpha. */
  macUrl?: string;
  /** Ships with the app (served from /media); never deleted from disk. */
  builtIn?: boolean;
  /** What the file is (codec, size, frame rate, keyframes), read when it was imported or optimised. */
  probe?: import("./mediaCheck").MediaProbe;
  /** Why the wall may not play it well (empty or missing: fine). Recomputed from `probe` on load. */
  problems?: import("./mediaCheck").MediaProblem[];
  /** The file was re-encoded into the wall format on import (the original's name and probe are kept here). */
  optimised?: { from: string; at: number; source?: import("./mediaCheck").MediaProbe };
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
  /** How a show timer looks when it is put on screen over everything. */
  timerOverlay: TimerOverlayStyle;
}

export type OverlayPosition = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";

export interface TimerOverlayStyle {
  position: OverlayPosition;
  /** Clock height as a fraction of the wall's height. */
  size: number;
  font: TextFont;
  color: string;
  /** Box behind the clock (opacity 0 = none). */
  background: string;
  backgroundOpacity: number;
  /** Show the timer's name above the clock. */
  showLabel: boolean;
  /** Distance from the edge, fraction of the wall's height. */
  margin: number;
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
  /** Play backwards (scrubbed by seeking; a pre-reversed clip is smoother). */
  reverse?: boolean;
  /** Fire MIDI/OSC when playback passes these times. */
  markers?: MediaMarker[];
}

/** A point in a clip's timeline that sends a message to the outside world (console, sound, lights). */
export interface MediaMarker {
  id: string;
  name: string;
  /** Seconds into the clip. */
  at: number;
  message: IoMessage;
  /** When set, the marker runs this cue of the scene (all its actions) instead of sending `message`. */
  cueId?: string | null;
}

/** Slow pan/zoom over a still or plate (storybook art, maps). Offsets are canvas fractions, scale ≥ 1. */
export interface KenBurns {
  enabled: boolean;
  from: { x: number; y: number; scale: number };
  to: { x: number; y: number; scale: number };
  duration: number;
  loop: "none" | "pingpong" | "loop";
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
  /** Slow pan/zoom (Ken Burns) starting when the background is activated. */
  kenBurns?: KenBurns;
  /** 2.5D depth: how much the plate drifts with the camera sway (0 = locked). Cut-out actors drift 1.6× more. */
  parallax?: number;
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

export type EffectType =
  | "rain"
  | "snow"
  | "lightning"
  | "fog"
  | "haze"
  | "wind"
  | "daynight"
  | "shake"
  | "projectile"
  | "stars"
  | "glow"
  | "heat"
  | "lights";

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
  /**
   * Birds only: flight height band in metres [low, high] (default 25-70, for the 3D environments).
   * Over a flat media plate the camera is at eye level and a 4:1 wall sees only ~±10° vertically,
   * so birds there fly lower and further out, e.g. [4, 14] with the centre ~60 m away.
   */
  altitude?: [number, number];
  /** Birds only: silhouette colour (default #1b1a1d) and how far it blends toward the sky colour, 0-1 (default 0.35). */
  color?: string;
  haze?: number;
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
  /** Fire MIDI/OSC when this clip passes these times. */
  markers?: MediaMarker[];
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
  /** Seconds the next clip fades in over the one it replaces (0 or absent = hard cut). */
  crossfade?: number;
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

/** The show's own font stacks. */
export type BuiltInFont = "serif" | "sans" | "display" | "mono";
/** A built-in stack, or the family name of a font installed on the show computer. */
export type TextFont = BuiltInFont | (string & {});
export type TextAnim = "cut" | "fade" | "rise" | "letters" | "words" | "burn" | "typewriter";

/** Titles, captions and verses drawn on the wall ("A FEW WEEKS LATER", FOREVER, Romans 10:13). */
export interface TextComponent extends ComponentBase {
  kind: "text";
  /** Use \n for line breaks. */
  text: string;
  font: TextFont;
  weight: number;
  italic: boolean;
  uppercase: boolean;
  /** Countdown: show this show timer; "{time}" in the text is replaced by its mm:ss. */
  timerId?: string | null;
  /** Line height as a fraction of canvas height. */
  size: number;
  color: string;
  glow: number;
  glowColor: string;
  /** In em. */
  letterSpacing: number;
  lineHeight: number;
  align: "left" | "center" | "right";
  /** Normalized centre of the text block (0..1, y down). */
  x: number;
  y: number;
  /** Wrap width as a fraction of canvas width (0 = no wrapping). */
  width: number;
  shadow: number;
  blend: BlendMode;
  /** stagger: seconds between letters/words for the staggered animations. */
  anim: { enter: TextAnim; exit: TextAnim; duration: number; stagger: number };
}

export type NamesStyle = "tree" | "line" | "roll" | "fly";

/**
 * The genealogy: a list of names revealed one GO at a time. "tree" grows gold branches up
 * from a root (David → Josiah), can burn down to a stump (Babylon) and bloom again (Scene 16);
 * "line" is the thin shoot with small plain letters; "roll" shows one big name at a time;
 * "fly" lifts each name up and out like an ember.
 */
export interface NamesComponent extends ComponentBase {
  kind: "names";
  names: string[];
  style: NamesStyle;
  font: TextFont;
  color: string;
  glow: number;
  /** Text size as a fraction of canvas height. */
  size: number;
  /** Root position (normalized). */
  x: number;
  y: number;
  /** Vertical extent (fraction of canvas height) and horizontal spread (fraction of width). */
  height: number;
  spread: number;
  /** Seconds a name takes to bloom. */
  reveal: number;
  branchColor: string;
  seed: number;
  /** Crown/top ornament text for the tree (e.g. "FOREVER" or "JESUS"); empty = none. */
  crown: string;
}

/** A glowing line tracing a journey across a map (Bethlehem → Nazareth). */
export interface RouteComponent extends ComponentBase {
  kind: "route";
  /** Map image (optional: the line can be drawn over any background). */
  assetId: string | null;
  fit: FitMode;
  anchorY?: number;
  /** Normalized over the map frame (0..1, y down). */
  points: Vec2[];
  color: string;
  /** Line width as a fraction of canvas height. */
  width: number;
  glow: number;
  /** Seconds to draw the whole line. */
  duration: number;
  label: string;
  labelColor: string;
  labelSize: number;
  /** Ken Burns move on the map during the draw (or on show when there is no line). */
  zoom: KenBurns;
  opacity: number;
}

export type SceneComponent =
  | BackgroundComponent
  | TextComponent
  | NamesComponent
  | RouteComponent
  | ClipActorComponent
  | ProceduralComponent
  | VideoLayerComponent
  | ImageLayerComponent
  | ModelComponent
  | ActorComponent
  | EffectComponent;

export type ComponentKind = SceneComponent["kind"];

export type CameraEase = "linear" | "inOut" | "out" | "smooth";

/** Digital framing of the whole picture (zoom into the wall). x, y: centre of the view, 0..1 of the canvas. */
export interface Framing {
  zoom: number;
  x: number;
  y: number;
}

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
  ease: CameraEase;
  /** When set, the camera keeps following this actor (target and an offset position) after the move. */
  followActorId: string | null;
  followOffset: Vec3;
}

export type TransitionKind = "cut" | "crossfade" | "fadeblack" | "dissolve" | "video" | "travel" | "wipe" | "burn";

export interface TransitionSpec {
  kind: TransitionKind;
  duration: number;
  videoAssetId: string | null;
  audioAssetId: string | null;
  /** For travel: how far the virtual camera flies (metres). */
  travelDistance: number;
  /** For wipe: where the new picture comes from. */
  direction?: "left" | "right" | "up" | "down";
  /** For wipe/burn: edge softness (0..1). */
  softness?: number;
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
  | { type: "blackout"; on: boolean; fade: number; delay: number }
  /** Freeze / unfreeze every moving thing in the scene. */
  | { type: "clock"; op: "pause" | "resume" | "toggle"; delay: number }
  /** Play a sound once (on the audio host). */
  | {
      type: "sound";
      assetId: string | null;
      volume: number;
      delay: number;
      /** Keep playing when another scene is taken. Default: the sound fades out when the scene changes. */
      keepPlaying?: boolean;
      /** When this sound starts, fade other audio out (null/absent = leave it). See AudioFadeOut. */
      fadeOthers?: AudioFadeOut | null;
    }
  /** Send MIDI / OSC to a console or another machine. */
  | { type: "send"; message: IoMessage; delay: number }
  /** Show timers are global (the Timers tab); a cue can start, pause or reset one. */
  | { type: "timer"; timerId: string; op: TimerOp; delay: number }
  /** Play a front-of-house announcement (the Announcements tab). */
  | { type: "announce"; announcementId: string; delay: number }
  /** Drive a names component: reveal the next name, burn the tree, bloom it… */
  | { type: "names"; layerId: string; op: "next" | "prev" | "reset" | "all" | "set" | "burn" | "restore" | "bloom"; value: number; duration: number; delay: number }
  /** Draw / reset a map route. */
  | { type: "route"; layerId: string; op: "play" | "reset" | "complete"; delay: number }
  /** Ramp a video's playback speed (time-lapse stings, the rewind, the run). */
  | { type: "media.speed"; layerId: string; rate: number; duration: number; delay: number }
  /** Glide the picture's framing (zoom / reposition), e.g. a slow push-in on a video plate. */
  | { type: "framing"; zoom: number; x: number; y: number; duration: number; delay: number }
  /** Change one live parameter of an effect (stars turn red, snow gets heavier…). */
  | { type: "effect.param"; effectId: string; key: string; value: number | string | boolean; delay: number };

export type CueActionType = CueAction["type"];

/**
 * What makes a cue fire. GO always works too (it fires the next cue early); the other modes
 * also fire it on their own. "video" cues are fired by time markers on a clip or video whose
 * `cueId` points at the cue.
 */
export type CueFire = { mode: "go" } | { mode: "time"; /** scene seconds after TAKE */ at: number } | { mode: "follow"; /** seconds after the previous cue fires */ after: number } | { mode: "video" };

export interface Cue {
  id: string;
  name: string;
  notes: string;
  actions: CueAction[];
  /** Absent = on GO. */
  fire?: CueFire;
}

/** A coloured, collapsible run of scenes in the scene list (e.g. the Prologue's places). */
export interface SceneGroup {
  id: string;
  name: string;
  color: GroupColor;
  collapsed?: boolean;
  /** GO after a scene's last cue takes the next scene of the group, so the group plays as one sequence. */
  flow: boolean;
}

export type GroupColor = "amber" | "red" | "orange" | "green" | "teal" | "blue" | "violet" | "pink" | "gray";

export interface Scene {
  id: string;
  /** Running-order number (1..n over the whole show); what MSC and /sls/take address. */
  number: number;
  /** Group this scene belongs to; grouped scenes sit next to each other in `Project.scenes`. */
  groupId?: string | null;
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
  /** Subtle hand-held drift of the virtual camera (and 2.5D parallax on plates). */
  cameraMotion?: CameraMotion;
  /** Lighting for 3D objects composited over a flat plate (environment "none"). */
  plateLight?: PlateLight;
  /** Starting framing (zoom + position) the scene goes live with. Set from the preview monitor. */
  framing?: Framing;
}

export interface CameraMotion {
  /** 0 = locked off, 1 = noticeable hand-held. */
  sway: number;
  /** Cycles per second of the slowest drift. */
  speed: number;
}

export interface PlateLight {
  /** Key light direction: azimuth (degrees, 0 = from the audience, 90 = from the right) and elevation. */
  azimuth: number;
  elevation: number;
  color: string;
  intensity: number;
  ambient: string;
  ambientIntensity: number;
  /** Contact shadow strength on the invisible ground. */
  shadow: number;
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
  /** MIDI / OSC integration (lighting console, sound). */
  io?: IoSettings;
  /** Scene groups, in no particular order (their scenes' order sets the running order). */
  groups?: SceneGroup[];
  /** Show timers (pre-show, intermission …), run from the Timers tab or by cues. */
  timers?: ShowTimer[];
  /** Front-of-house announcements ("the show will begin in 5 minutes"). */
  announcements?: Announcement[];
  /** Where this copy of the show came from, so a show package or sync can tell local edits from incoming ones. */
  lineage?: ShowLineage;
}

/**
 * Version history between machines (see docs/SHOW_PACKAGE.md). Every package or cloud push is a version with
 * a unique id and the ids it descends from. Each machine keeps the content hashes of the versions it sent or
 * took in; taking a version in compares against the newest version both sides share (the merge base), so only
 * what was changed on both sides is asked about.
 */
export interface ShowLineage {
  /** The same show on every machine. */
  showId: string;
  /** Number of the last version this machine sent out (package export or cloud push). */
  sent?: number;
  /** Last version this machine took in. */
  received?: { version: number; id?: string; at: number; via: "package" | "cloud"; from: string };
  /** Ids of the versions this show's content descends from, oldest first. */
  history?: string[];
  /** Version id → unit key ("scene:<id>", "order", "output" …) → content hash, for versions sent or taken in here. */
  bases?: Record<string, Record<string, string>>;
}

export type TimerOp = "start" | "pause" | "reset" | "restart";

export interface ShowTimer {
  id: string;
  name: string;
  /** Seconds it counts down from. */
  duration: number;
  /** Announcement played when it reaches 0:00 (null = none). */
  endAnnouncementId: string | null;
}

export interface Announcement {
  id: string;
  name: string;
  /** An audio asset. */
  assetId: string | null;
  volume: number;
  /** Kept at the top of the Announce tab. */
  pinned?: boolean;
  /** Shown in red (for "technical difficulties" and other emergencies). */
  urgent?: boolean;
}

/** A timer's live state: counting toward `endsAt` (wall ms), or paused with `remaining` seconds. */
export interface TimerRun {
  running: boolean;
  endsAt: number;
  remaining: number;
}

// ---------------------------------------------------------------- show control I/O

export type IoMessage =
  | { type: "midi.note"; channel: number; note: number; velocity: number; /** ms until note-off; 0 = note-on only */ hold: number }
  | { type: "midi.cc"; channel: number; cc: number; value: number }
  | { type: "midi.pc"; channel: number; program: number }
  /** MIDI Show Control (what lighting consoles listen for). */
  | { type: "msc"; deviceId: number; command: "go" | "stop" | "resume"; cue: string; list: string }
  | { type: "osc"; target: string | null; address: string; args: (number | string)[] }
  /**
   * A Hog 4 playback command, sent over OSC to the console target. With `item` set, kind and
   * number come from the lighting library at send time (so renumbering a list updates every cue);
   * kind/number here are the fallback and what a custom command uses.
   */
  | { type: "hog"; op: HogOp; item: string | null; kind: HogKind; number: string; /** GO only, cuelists only; "" = next cue */ cue: string };

export type HogKind = "cuelist" | "scene" | "macro";
export type HogOp = "go" | "release" | "halt" | "resume";

/** A named lighting item on the Hog 4, so cues read "Rain lights" instead of "515". */
export interface HogItem {
  id: string;
  name: string;
  kind: HogKind;
  number: string;
}

export type IoMatch =
  | { type: "midi.note"; channel: number | null; note: number }
  | { type: "midi.cc"; channel: number | null; cc: number; value: number | null }
  | { type: "midi.pc"; channel: number | null; program: number }
  | { type: "msc"; cue: string | null; list: string | null }
  | { type: "osc"; address: string; arg: number | string | null };

/** What an incoming trigger does to the show. */
export type IoAction =
  | { type: "go" }
  | { type: "back" }
  | { type: "take"; sceneId: string }
  | { type: "takeNext" }
  | { type: "fireCue"; sceneId: string; index: number }
  | { type: "blackout"; on: boolean | "toggle" }
  | { type: "standby"; on: boolean | "toggle" }
  | { type: "freeze"; op: "pause" | "resume" | "toggle" }
  | { type: "select"; sceneId: string }
  | { type: "selectNext" }
  | { type: "selectPrev" };

export interface IoTrigger {
  id: string;
  name: string;
  enabled: boolean;
  match: IoMatch;
  action: IoAction;
}

export interface OscTarget {
  id: string;
  name: string;
  host: string;
  port: number;
}

export interface IoSettings {
  midi: {
    enabled: boolean;
    input: string | null;
    output: string | null;
    /** MSC device id this show answers to (0–111, 127 = all). */
    mscDeviceId: number;
    /**
     * Follow MSC GO automatically: cue "12" takes scene 12, cue "12.3" fires cue 3 of scene 12
     * (taking the scene first if needed).
     */
    mscAuto: boolean;
  };
  osc: {
    enabled: boolean;
    listenPort: number;
    targets: OscTarget[];
    /** Send /sls/scene and /sls/cue to this target on every TAKE and GO. */
    notifyTarget: string | null;
    notify: boolean;
  };
  triggers: IoTrigger[];
  /** Named Hog cuelists / scenes / macros that cues pick from. */
  hogItems: HogItem[];
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

/** Linear playback-speed ramp; media time is its integral so a ramp never jumps. */
export interface SpeedRamp {
  from: number;
  to: number;
  /** Scene time ms the ramp started and the media-elapsed seconds at that moment. */
  at: number;
  dur: number;
  elapsedAt: number;
}

export interface NamesRuntime {
  /** Names revealed so far; the last one blooms from `shownAt`. */
  shown: number;
  shownAt: number;
  /** 0 = whole, 1 = burned to the stump. */
  burn: Tween;
  /** 0 = gold branches, 1 = full blossom (Scene 16). */
  bloom: Tween;
}

export interface RouteRuntime {
  progress: Tween;
}

export interface SoundEvent {
  id: string;
  assetId: string;
  at: number;
  volume: number;
  /** Carries on when another scene is taken (see the sound action). */
  keepPlaying?: boolean;
  /** Other audio this sound fades out as it starts (see the sound action). */
  fadeOthers?: AudioFadeOut;
}

/**
 * A sound cue that clears the air as it starts: `which` = "all" fades every other cue sound and the
 * sound of every video on the wall; a list names mixer keys (`sound:<assetId>` for a cue sound, a
 * component id for a video's sound). `fade` is in seconds.
 */
export interface AudioFadeOut {
  which: "all" | string[];
  fade: number;
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
  ease: CameraEase;
  /** Velocity at the start of the move (units/s); lets a new move continue smoothly out of the old one. */
  fromVel?: CameraPose;
  /** Keep tracking this actor after the move. */
  follow?: { actorId: string; offset: Vec3 } | null;
}

/**
 * Playback state of one scene instance. Times are "scene time" in ms,
 * measured from the scene clock so a paused scene freezes everything.
 */
export interface SceneRuntime {
  key: string;
  scene: Scene;
  /**
   * Scene clock. `reached` is the furthest scene time (ms) this run had played before its last
   * seek: markers and timed cues up to it count as passed, so scrubbing back and replaying, or
   * jumping forward over them, never fires them (see docs/VIDEO_TRANSPORT.md).
   */
  clock: { base: number; pausedAt: number | null; reached?: number };
  background: { current: string | null; previous: string | null; changedAt: number; dur: number };
  env: { timeOfDay: Tween; storm: Tween };
  layers: Record<string, LayerRuntime>;
  effects: Record<string, EffectRuntime>;
  strikes: LightningStrike[];
  camera: CameraRuntime;
  cuePointer: number;
  /** Cues already fired in this run of the scene (GO, scene time, follow or a video marker). */
  fired?: string[];
  /** Video actors: the clips scheduled so far (scene time ms). */
  clipActors: Record<string, ClipActorRuntime>;
  /** One-shot effect events (shake, projectile): scene time they fired. */
  triggers?: { id: string; effectId: string; at: number }[];
  names?: Record<string, NamesRuntime>;
  routes?: Record<string, RouteRuntime>;
  /** Playback speed ramps by media component id. */
  speed?: Record<string, SpeedRamp>;
  /** One-shot sounds (scene time). */
  sounds?: SoundEvent[];
  framing?: { from: Framing; to: Framing; at: number; dur: number };
}

export interface ClipSegment {
  clipId: string;
  at: number;
  /** Clip seconds already passed or jumped over by a scrub (clip.seek): markers up to here do not fire. */
  skip?: number;
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
  /** Show timers by id (kept here so the wall shows them and they survive a reload). */
  timers?: Record<string, TimerRun>;
  /** A show timer put on screen over everything (the label travels with it for the output window). */
  timerOverlay?: { timerId: string; label: string } | null;
  /** The announcement playing (or last played); `stoppedAt` set when it was stopped early. */
  announce?: { key: string; id: string; assetId: string; volume: number; at: number; stoppedAt?: number };
  /**
   * Live mixer: the operator's volume trim per audio source, multiplied into the designed volume
   * (1 = as designed, 0 = silent). Keys: `sound:<assetId>` for cue sounds, a component id for the sound
   * of a video layer, video background or video actor. Show-wide, so it survives takes and reloads.
   */
  mix?: Record<string, number>;
}
