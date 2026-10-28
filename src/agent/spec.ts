// The agent control catalogue: every command an AI agent can send to the running app.
//
// One list, two readers:
//  - mcp/server.ts (Node) turns each entry into an MCP tool, with this description and schema;
//  - src/agent/handlers.ts (operator window) must implement every entry, which TypeScript checks.
//
// Keep this file free of imports and non-erasable TypeScript (enums, namespaces): Node loads it
// directly with type stripping. When a feature is added to the app, add or extend a command here
// and its handler, then bump AGENT_SPEC_VERSION (see AGENTS.md).

export const AGENT_SPEC_VERSION = 24;

/** Default local port of the bridge between the MCP server and the operator window. */
export const AGENT_PORT = 1431;

type Schema = Record<string, unknown>;

export interface CommandSpec {
  description: string;
  /** JSON Schema of the arguments (an object). */
  params: Schema;
  /** Reaches the audience, the lighting console or another machine. */
  live?: boolean;
  /** Changes nothing. */
  readOnly?: boolean;
  /** Changes or deletes show data that is hard to get back. */
  destructive?: boolean;
}

// ---------------------------------------------------------------- schema helpers

const str = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });
const num = (description: string, extra: Schema = {}): Schema => ({ type: "number", description, ...extra });
const int = (description: string, extra: Schema = {}): Schema => ({ type: "integer", description, ...extra });
const bool = (description: string): Schema => ({ type: "boolean", description });
const oneOf = (values: readonly (string | number | boolean | null)[], description: string): Schema => ({ enum: values, description });
const obj = (description: string): Schema => ({ type: "object", description, additionalProperties: true });
const anyValue = (description: string): Schema => ({ description });
const args = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const target = oneOf(
  ["preview", "program"],
  "preview = the rehearsal monitor (never reaches the audience); program = the LIVE wall.",
);
const sceneRef = str('A scene: its id, running-order code ("1.2"), number ("7") or exact name.');
const componentRef = str("A component of the scene: its id or exact name.");
const cueRef = str('A cue of the scene: its id, exact name, or 1-based position like "#3".');
const transition = obj(
  'A TransitionSpec: {kind: "cut"|"crossfade"|"fadeblack"|"dissolve"|"video"|"travel"|"wipe"|"burn", duration (s), videoAssetId, audioAssetId, travelDistance, direction?, softness?}. Missing fields take defaults.',
);
const path = str(
  'Slash path into app state. Roots: project (the show file), show (live/preview runtime), io (MIDI/OSC status and log), ui (mode, selection). Array elements are addressed by id, then by index; "-" appends. E.g. "project/scenes/scene_ab12/components/rain_x9/params/intensity", "project/output/canvasWidth", "show/program/runtime/cuePointer".',
);

// ---------------------------------------------------------------- the catalogue

export const AGENT_COMMANDS = {
  // ------------------------------------------------ look
  status: {
    readOnly: true,
    description:
      "Overview of the running app: mode, selected scene, what is on the LIVE wall (scene, next cue, standby, blackout, freeze, transition), the preview, output window health, show timers, MIDI/OSC status, StageMics reach, StageLight link, save state. Start here.",
    params: args({}),
  },
  list_scenes: {
    readOnly: true,
    description: "Running order: every scene with its code (1.2), id, name, group, environment, component/cue counts and whether it is selected or live. Groups are listed too.",
    params: args({ query: str("Only scenes whose name contains this (case-insensitive).") }),
  },
  get_scene: {
    readOnly: true,
    description: "One scene as stored (components, cues, camera shots, stage markers, transition, look). Thumbnails are left out.",
    params: args({ scene: sceneRef }, ["scene"]),
  },
  timeline: {
    readOnly: true,
    description:
      "A scene as the Build timeline lays it out, in scene seconds: when each cue fires (`start`; a GO cue sits at its planned `hold` after the cue before, guessed from how long that cue runs when `holdSet` is false; set it with cue_update {patch: {hold}}), and per track what plays when: clips (with the idle loops that fill the waits and when a clip waited for its cut point), backgrounds, layers, effects, camera moves, sounds (their length, fades, carried in from or into other scenes) and lights / MIDI / OSC. Each item names the cue and action that put it there.",
    params: args({ scene: sceneRef }),
  },
  get_runtime: {
    readOnly: true,
    description:
      "Playback state of the preview or live scene: scene time, frozen?, GO pointer and next cue, nextCueAuto (the next cue would fire by itself; go fires it early), cues fired, visible layers, active effects, current background, video-actor clips, pending delayed actions.",
    params: args({ target }, ["target"]),
  },
  list_assets: {
    readOnly: true,
    description: "The media library (images, videos, 3D models, audio) with ids to use in components and cues. Videos carry a one-line `format` and `problems` when the wall may not play them well (see asset_check). Audio carries `audioRole` (music, voice, ambience, sfx: its icon and colour on the live mixer), set with patch project/assets/<id>/audioRole or guessed from the name.",
    params: args({ type: oneOf(["image", "video", "model", "audio"], "Only this type."), query: str("Name contains (case-insensitive).") }),
  },
  get: {
    readOnly: true,
    description: "Read any value in the app by path (see `path`). Use for anything the other tools do not show. Big values are summarised at `depth`.",
    params: args({ path, depth: int("How many levels to expand before summarising (default 6).") }, ["path"]),
  },
  schema: {
    readOnly: true,
    description:
      "Reference for building show content, generated from the running app so it is always current: component kinds with their default fields, cue action types with defaults, effect types with parameter ranges, transition kinds, I/O message shapes, path syntax.",
    params: args({ topic: oneOf(["components", "cueActions", "effects", "transitions", "io", "all"], "What to describe (default all).") }),
  },
  screenshot: {
    readOnly: true,
    description:
      "A picture of the preview or program monitor as rendered in the operator window (the 3D/media canvas; DOM overlays such as standby, blackout and the timer clock are reported in text). The monitor must be on screen (Show mode shows both).",
    params: args({ target, width: int("Image width in pixels (default 960, max 1920).") }, ["target"]),
  },
  io_log: {
    readOnly: true,
    description: "Recent MIDI/OSC/show-control log lines (in, out, info, errors), newest last.",
    params: args({ limit: int("How many lines (default 40).") }),
  },
  stagelight_status: {
    readOnly: true,
    description:
      "The StageLight lighting-desk link: on/off, address and port, mirror on/off, reach (answering / sent / error / off), StageLight's last hello (version, output armed or preview only, running page and cue), its last GO announcement and its last refusal, and the catalog's state and size. Sends nothing.",
    params: args({}),
  },
  stagelight_catalog: {
    description:
      "What StageLight has, to pick from: pages with their cue lists (number, entryId, name, auto-follow), named triggers (id, name, what each does) and library cues, as last read from StageLight (StageLight 0.3+; kept in the show file, so it also works while StageLight is off). StageLight messages given to cue_add, cue_update, markers, run_action, io_send and stagelight_send may name pages, cues, triggers and library cues by name or number: they are stored as these IDs, with the names in `label`. refresh = ask StageLight again first (it only asks; nothing changes on the desk).",
    params: args({ refresh: bool("Re-read the catalog from StageLight before answering.") }),
  },
  list_store_actions: {
    readOnly: true,
    description: "Names of the raw store actions `call_action` can invoke (project store and show store), for features without a dedicated tool.",
    params: args({}),
  },

  // ------------------------------------------------ run the show
  select_scene: {
    description: "Select a scene: it loads in the PREVIEW (never the wall) and becomes the one the builder edits.",
    params: args({ scene: sceneRef }, ["scene"]),
  },
  take: {
    live: true,
    description: "TAKE a scene LIVE onto the wall with its own transition, or the one given. Pending delayed actions of the old scene are cancelled.",
    params: args({ scene: sceneRef, transition }, ["scene"]),
  },
  cue: {
    description:
      "Cue list control. go = fire the next cue (past the last cue a flowing group takes its next scene), including one that would fire by itself (nextCueAuto: true), which then fires early; fire = fire cue `index` and rewind the list to it (the cues after it are un-fired, GO points at the next one, the cues before it count as passed; time cues already behind the clock wait for GO; on program, a fire out of order chases the music, see music_at); back/skip = move the GO pointer; set = put the pointer on `index`; repeat = re-run the last fired cue. On program, go/fire during a video transition end the transition at once so the cue is seen.",
    params: args({ target, op: oneOf(["go", "fire", "back", "skip", "set", "repeat"], "What to do."), index: int("0-based cue index for fire/set.") }, ["target", "op"]),
  },
  preview_step: {
    description: "Show the preview as the scene looks after its first `step` cues (0 = as taken). Nothing is sent out.",
    params: args({ step: int("Number of cues applied.") }, ["step"]),
  },
  preview_time: {
    description:
      "Show the PREVIEW as the selected scene looks `seconds` into its Build timeline (see timeline): every cue fired at its timeline time (GO cues at their planned hold), every action up to that moment applied at its own time, then held on that frame. Resume (freeze or transport) plays on from there, with the rest of those cues still to come. Nothing is sent out.",
    params: args({ seconds: num("Scene seconds on the timeline.") }, ["seconds"]),
  },
  preview_run: {
    description:
      "Run the show in the PREVIEW, as Build's Run show button does: the scene (default: the one in the preview) starts from its TAKE, GO cues fire by themselves at their planned holds on the timeline, take-scene actions go on to the next scene (carrying music that keeps playing), and a scene that ends without one goes on to the next in running order. Nothing is sent out. on: false stops the run and leaves the preview where it is.",
    params: args({ on: bool("true = start a run, false = stop it."), scene: sceneRef }, ["on"]),
  },
  run_action: {
    description:
      "Run one cue action right now (its delay still applies), without adding it to a cue: show a layer, start rain, play a clip, move the camera, play a sound, ramp video speed... See schema topic cueActions. On program it reaches the wall; blackout/send/timer/announce only act on program.",
    params: args({ target, action: obj("A CueAction, e.g. {type: \"effect\", effectId, op: \"start\", delay: 0}. `delay` defaults to 0.") }, ["target", "action"]),
  },
  seek: {
    live: true,
    description:
      "Jump the scene clock to `seconds` after the TAKE (scrub). Video, effects and tweens follow. On program it only works while the scene is held (freeze/transport hold). Markers and time cues in the stretch jumped over or replayed do not fire. To scrub in a video's own time, use transport.",
    params: args({ target, seconds: num("Scene time in seconds.") }, ["target", "seconds"]),
  },
  freeze: {
    live: true,
    description: "Freeze every moving thing in the scene, or resume exactly where it stopped. Same as transport hold/resume.",
    params: args({ target, op: oneOf(["pause", "resume", "toggle"], "pause = freeze.") }, ["target", "op"]),
  },
  transport: {
    live: true,
    description:
      "Video transport for the scene on `target`: status, hold (freeze on this frame: video, its sound and effects), resume, toggle, seek to `seconds` into a video, or nudge by `seconds` (negative = back). Times are the video's own seconds, not scene time. On program, seek/nudge only work while held, so the live wall never jumps by accident. Markers and time cues fire only on normal playback past a point for the first time: never for the stretch jumped over, never again on a replay after scrubbing back. Returns held, the video's position and length, and every scrubbable video.",
    params: args(
      {
        target,
        op: oneOf(["status", "hold", "resume", "toggle", "seek", "nudge"], "What to do. Default status."),
        seconds: num("seek: video seconds to go to. nudge: seconds to move (negative = back)."),
        source: str('Which video: a key from `videos` ("componentId" or "actorId:clipId"), or a component name. Default: the scene\'s main playing video.'),
      },
      ["target"],
    ),
  },
  blackout: {
    live: true,
    description: "Fade the whole LIVE wall to black, or bring it back.",
    params: args({ on: bool("true = black."), fade: num("Fade seconds (default 0.6).") }, ["on"]),
  },
  standby: {
    live: true,
    description: "Put the LIVE wall on the standby title card (or take it off).",
    params: args({ on: bool("true = standby.") }, ["on"]),
  },
  cancel_pending: {
    description: "Cancel delayed actions and follow cues still waiting to fire.",
    params: args({ target }, ["target"]),
  },
  restart_preview: {
    description: "Restart the preview scene from its beginning (as if just taken).",
    params: args({}),
  },
  timer: {
    live: true,
    description: "Run a show timer (pre-show, intermission...): start, pause, reset, restart, or add `seconds` (negative to take away).",
    params: args(
      { timer: str("Timer id or exact name."), op: oneOf(["start", "pause", "reset", "restart", "add"], "What to do."), seconds: num("For add.") },
      ["timer", "op"],
    ),
  },
  announce: {
    live: true,
    description: "Play a front-of-house announcement through the program audio, or stop the one playing (announcement = null).",
    params: args({ announcement: { type: ["string", "null"], description: "Announcement id or exact name; null stops." } }, ["announcement"]),
  },
  mixer: {
    live: true,
    description:
      "Live mixer: list every audio source sounding on the LIVE wall (cue sounds, video with its sound on) with its volume trim, or set one. The trim multiplies the designed volume (1 = as designed, 0 = silent), stays through takes and is saved in the show file as its sound levels (project/mix: the same keys), so it travels with packages and cloud sync and comes back the next time that source plays; reset = true puts every source back (and clears the saved levels). Without source/volume it only reads. `trims` is every saved level, playing or not.",
    params: args({
      source: str('Mixer key from the list ("sound:<assetId>" or a component id), a sound or component name, or an asset id.'),
      volume: num("Trim 0..1 for that source (1 = as designed)."),
      reset: bool("Put every source back to its designed volume."),
    }),
  },
  music_at: {
    readOnly: true,
    description:
      "The cue sounds that would be playing just before a cue fires (no cue: as the scene is taken), had the show run in sequence from the top, and how far into each file (`offset`, s) — what the music chase starts when the operator fires a cue out of order or takes a scene out of running order (project/chaseMusic, default on). Worked out from the cues: time cues at their time, follow cues after the cue before, video cues at their marker, GO cues when they last fired in a run in sequence (`learned`, project/cueTimings: scene id → cue id → seconds after TAKE; never learned = right after the cue before). `live` = what the live wall plays now.",
    params: args({ scene: sceneRef, cue: cueRef }, ["scene"]),
  },
  audio_output: {
    live: true,
    description:
      "Where the whole app's sound goes (cue sounds, thunder, announcements, video sound), for this computer. Lists the native devices (CoreAudio on macOS, Dante Virtual Soundcard / Dante Via included; on the Mac choosing one makes it the Mac's default output while the app runs) and the web engine's outputs (setSinkId; on Windows every playback device, Dante Virtual Soundcard included when it runs in WDM mode as 'DVS Transmit 1-2' … one per stereo pair, each with dante: true/false), plus the current choice, the computer's default output (webDefault) and webNamesHidden (true = the webview still hides its outputs: on Windows that means no microphone-capable input exists to unlock them, e.g. Dante Virtual Soundcard is not running). danteNotListed appears when Dante Virtual Soundcard is installed but Windows lists none of its outputs (stopped or in ASIO mode): it says what the operator must change in Dante Virtual Soundcard; the app cannot play to ASIO. Pass device to route: a native UID, a web deviceId or an exact device name; null goes back to the computer's default. Without device it only reads.",
    params: args({
      device: { type: ["string", "null"], description: "Device UID / deviceId / exact name to route to; null = computer default. Omit to read." },
      engine: oneOf(["native", "web"], "Which engine's device to pick when a name exists in both (default: native)."),
    }),
  },
  timer_overlay: {
    live: true,
    description: "Put a show timer's clock on the LIVE wall over everything, or take it off (timer = null).",
    params: args({ timer: { type: ["string", "null"], description: "Timer id or exact name; null removes." } }, ["timer"]),
  },
  next_transition: {
    description: "Choose the transition for the next TAKE (null = each scene's own).",
    params: args({ transition: { type: ["object", "null"], description: "A TransitionSpec or null." } }, ["transition"]),
  },
  io_send: {
    live: true,
    description:
      "Send a message to the outside world now: Hog 4 lighting, StageLight (the lighting desk; stagelight_send also reports StageLight's answer), StageMics (mics, voice effects, its scenes and cues; StageMics owns the dLive sound desk), Custom OSC, MIDI Show Control or MIDI. See schema topic io for shapes. Hog playback numbers go as strings. A StageMics sceneId null means the LIVE scene. Returns the exact OSC sent for StageMics and StageLight messages.",
    params: args({ message: obj("An IoMessage, e.g. {type: \"hog\", op: \"go\", item: \"House Light\", kind: \"cuelist\", number: \"205\", cue: \"\", master: \"\"}, {type: \"stagelight\", op: \"trigger\", name: \"lion.leap\"}, {type: \"sound\", op: \"mic\", who: \"Joseph\", live: false}. master (GO only) = a master number whose fader goes to full first, for a list parked on a lowered fader.") }, ["message"]),
  },
  stagemics_status: {
    readOnly: true,
    description:
      "StageMics (the mic app that owns the dLive sound desk): whether LiveStage's link to it is on, its address, whether it answered recently, its version and desk connection, its active cue and mic states. Nothing is sent.",
    params: args({}),
  },
  stagelight_link: {
    description:
      "Set up the link to StageLight, the lighting desk (OSC; Settings → StageLight). Only the fields given change. enabled is this computer's own switch (never taken from another machine's show file). StageLight's show port is 1461; dev desks use others (1471). mirror = also send every live TAKE as trigger \"scene.<code>\" and every GO as \"cue.<code>.<n>\". Switching it on also switches on OSC listening (project/io/osc/enabled), which StageLight's replies need. Pings StageLight and returns stagelight_status.",
    params: args({
      enabled: bool("Send to StageLight from this computer."),
      host: str("StageLight's IP address (127.0.0.1 on this computer)."),
      port: int("StageLight's OSC listen port."),
      mirror: bool("Mirror live TAKE / GO as named triggers."),
    }),
  },
  stagelight_send: {
    live: true,
    description:
      "Send one command to StageLight now (it may change the real lights when StageLight's output is armed) and report what went out and what StageLight answered: a refusal (/stagelight/error, e.g. unknown page or trigger) or its GO announcement, within a fraction of a second. No answer is normal for accepted commands unless StageLight announces to this computer. Needs the link on (stagelight_link).",
    params: args(
      {
        message: obj(
          'A StageLight message (type "stagelight" optional): {op: "go", page: ""} next cue ("" = running page) | {op: "goCue", page: "Act 1", cue: "4"} | {op: "trigger", name: "lion.leap"} | {op: "back"} | {op: "stop"|"clear", fade: null} | {op: "blackout", on: true} | {op: "master", level: 0.8} | {op: "play", cue: "Warm wash", fade: null} | {op: "ledwall", media: "off"}. Pages and cues by StageLight name, ID or 1-based number.',
        ),
      },
      ["message"],
    ),
  },
  io_inject: {
    description: "Pretend a MIDI or OSC message arrived (tests triggers without hardware). The matching trigger acts on the show as if it were real.",
    params: args(
      { message: obj('{kind: "osc", address: "/sls/go", args: []} or {kind: "midi", bytes: [144, 60, 127]}.') },
      ["message"],
    ),
  },
  output_window: {
    live: true,
    description: "Open, close or check the audience output window.",
    params: args({ op: oneOf(["open", "close", "status"], "What to do.") }, ["op"]),
  },
  ui: {
    description:
      "Operator UI state: switch between Show and Build mode, select a component in the builder, isolate (solo) one component in the preview, or hide components from the preview while building.",
    params: args({
      mode: oneOf(["show", "builder"], "App mode."),
      component: { type: ["string", "null"], description: "Select this component of the selected scene (id or name; null = none)." },
      solo: { type: ["string", "null"], description: "Show only this component in the preview (null = whole scene)." },
      hidden: { type: "array", items: { type: "string" }, description: "Components hidden from the preview (replaces the list)." },
    }),
  },
  update_live_scene: {
    live: true,
    description: "Push edits of the scene that is LIVE onto the wall without restarting it (the live scene otherwise keeps the copy taken at TAKE).",
    params: args({}),
  },

  // ------------------------------------------------ build
  scene_create: {
    description: "Add a new scene (environment none = flat media plates; or a 3D environment). Returns it. It is not selected or taken: use select_scene to see it in the preview.",
    params: args({
      name: str("Scene name."),
      after: str("Put it right after this scene (ref); default: end of the show."),
      group: str("Group id or name to put it in."),
      props: obj("Scene fields to set on top of the defaults (environment, notes, transition, look...)."),
    }),
  },
  scene_update: {
    description: "Change scene fields by deep merge (objects merge, arrays and values replace): name, notes, environment, transition, stopCarriedSounds (true: taking it fades out music still playing from earlier scenes), look, cameraMotion, plateLight, framing, markers, cameraShots, defaultShotId...",
    params: args({ scene: sceneRef, patch: obj("Fields to merge.") }, ["scene", "patch"]),
  },
  scene_duplicate: {
    description: "Copy a scene (new ids for everything). Returns the copy's id.",
    params: args({ scene: sceneRef }, ["scene"]),
  },
  scene_delete: {
    destructive: true,
    description: "Delete a scene from the show.",
    params: args({ scene: sceneRef }, ["scene"]),
  },
  scene_move: {
    description: "Move a scene up or down the running order (inside its group, or over a whole group when loose).",
    params: args({ scene: sceneRef, by: int("Steps: negative = earlier, positive = later.") }, ["scene", "by"]),
  },
  scene_group: {
    description: 'Put a scene in a group, take it out (group = null), or start a new group with it (group = "new").',
    params: args({ scene: sceneRef, group: { type: ["string", "null"], description: 'Group id or name, "new", or null.' } }, ["scene", "group"]),
  },
  group_update: {
    description: "Change a scene group: rename/recolour/flow/collapse (patch), move it (by), or dissolve it (ungroup: its scenes stay).",
    params: args(
      {
        group: str("Group id or name."),
        patch: obj("Fields: name, color (amber|red|orange|green|teal|blue|violet|pink|gray), flow, collapsed."),
        by: int("Move the group by this many rows."),
        ungroup: bool("Dissolve the group."),
      },
      ["group"],
    ),
  },
  component_add: {
    description:
      "Add a component to a scene, built from the app's defaults for its kind, then `props` merged on top. Kinds: background, video, image, model, actor (lion), effect (needs `effect`), procedural (needs `element`), clipActor, text, names, route. See schema topic components.",
    params: args(
      {
        scene: sceneRef,
        kind: oneOf(["background", "video", "image", "model", "actor", "effect", "procedural", "clipActor", "text", "names", "route"], "Component kind."),
        effect: oneOf(["rain", "snow", "lightning", "fog", "haze", "wind", "daynight", "shake", "projectile", "stars", "glow", "heat", "lights"], "For kind effect."),
        element: oneOf(["birds", "sheep", "campfire", "town-lights"], "For kind procedural."),
        name: str("Display name."),
        props: obj("Fields merged over the defaults (e.g. media: {assetId}, text, params...)."),
        index: int("Position in the component stack (default: top)."),
      },
      ["scene", "kind"],
    ),
  },
  component_update: {
    description: "Change a component by deep merge (objects merge, arrays and values replace). E.g. {params: {intensity: 0.9}}, {media: {assetId, loop: true}}, {screen: {x: 0.3}}, {initiallyVisible: false}.",
    params: args({ scene: sceneRef, component: componentRef, patch: obj("Fields to merge.") }, ["scene", "component", "patch"]),
  },
  component_remove: {
    destructive: true,
    description: "Remove a component (cue actions pointing at it are removed too).",
    params: args({ scene: sceneRef, component: componentRef }, ["scene", "component"]),
  },
  component_arrange: {
    description: "Duplicate a component, or move it up/down the stack (later = drawn on top).",
    params: args({ scene: sceneRef, component: componentRef, op: oneOf(["duplicate", "up", "down"], "What to do.") }, ["scene", "component", "op"]),
  },
  cue_add: {
    description:
      'Add a cue to a scene. A cue is {name, notes, actions: CueAction[], fire?}; fire = {mode: "go"} (default) | {mode: "time", at} | {mode: "follow", after} | {mode: "video"} (fired by a media marker with cueId). Action types: schema topic cueActions. Lighting is type "send" with a message: {type: "send", message: {type: "stagelight", op: "goCue", page: "Act 1", cue: "4"}, delay: 0} or a Hog message.',
    params: args(
      {
        scene: sceneRef,
        cue: obj("The cue (id optional)."),
        index: int("0-based position (default: end)."),
      },
      ["scene", "cue"],
    ),
  },
  cue_update: {
    description: "Change a cue by deep merge (actions are replaced as a whole when given: to edit or remove one action, get_scene, change the list, send it back).",
    params: args({ scene: sceneRef, cue: cueRef, patch: obj("Fields to merge: name, notes, actions, fire, hold (GO cues: planned seconds after the cue before, for the timeline).") }, ["scene", "cue", "patch"]),
  },
  cue_remove: {
    destructive: true,
    description: "Delete a cue from a scene.",
    params: args({ scene: sceneRef, cue: cueRef }, ["scene", "cue"]),
  },
  cue_move: {
    description: "Move a cue to a new 0-based position in its scene.",
    params: args({ scene: sceneRef, cue: cueRef, to: int("New index.") }, ["scene", "cue", "to"]),
  },
  markers: {
    description:
      "Time markers on a scene's videos (a video layer, a video background, or a clip of a video actor): when the LIVE video reaches `at` seconds, the marker sends its message (Hog, StageLight, MIDI, OSC) or runs one of the scene's cues. Markers fire from PROGRAM only, once per pass, never while scrubbing. list = every video with its markers; upsert = add, or change by id (message replaced as a whole); remove = by id or name.",
    params: args(
      {
        scene: sceneRef,
        op: oneOf(["list", "upsert", "remove"], "What to do (default list)."),
        media: str("upsert/remove: the video: component id or name (a video layer, a media background or a video actor)."),
        clip: str("For a video actor: the clip's id or name."),
        marker: obj('upsert: {id?, name?, at: seconds, message?: IoMessage, cue?: cue ref (id, name or "#2") to run instead of sending}. E.g. {name: "Leap", at: 1.8, message: {type: "stagelight", op: "trigger", name: "lion.leap"}}. A new marker without message or cue sends a StageLight GO when the StageLight link is on, else a Hog GO.'),
        id: str("remove: the marker's id or name."),
      },
      ["scene"],
    ),
  },
  upsert: {
    description:
      "Insert or replace an item (matched by its `id`) in any list in the show file: camera shots, media markers, clips of a video actor, timers, announcements, effect presets, I/O triggers, OSC targets, Hog lighting items... A missing id is generated.",
    params: args(
      {
        path: str('Path of the list, e.g. "project/timers", "project/io/hogItems", "project/scenes/<scene>/cameraShots", "project/scenes/<scene>/components/<comp>/media/markers".'),
        item: obj("The item. Replacing merges onto the existing item."),
        index: int("Position for a new item (default: end)."),
      },
      ["path", "item"],
    ),
  },
  remove: {
    destructive: true,
    description: "Remove an item (by id or index) from any list in the show file.",
    params: args({ path: str("Path of the list."), item: str("Item id, or index.") }, ["path", "item"]),
  },
  patch: {
    description:
      "Edit anything in the show file with path operations, applied together as one change: set (replace value), merge (deep merge object), insert (into a list at the index in the path, or \"-\" to append), remove. Returns the previous values so a change can be undone.",
    params: args(
      {
        ops: {
          type: "array",
          description: "Operations in order.",
          items: {
            type: "object",
            properties: { op: oneOf(["set", "merge", "insert", "remove"], "Operation."), path, value: anyValue("New value (set/merge/insert).") },
            required: ["op", "path"],
          },
        },
      },
      ["ops"],
    ),
  },
  asset_import: {
    description:
      "Add media to the library: a local file (copied into the show's library; files under the project's public/ folder are linked instead) or a URL the app can load. Videos are probed (codec, size, keyframes) and checked against what the wall plays; one the wall would not play well (H.264 wider than 4096 px, far bigger than the wall, long keyframe gaps, no fast start) is re-encoded into the wall format on the way in (desktop app, needs ffmpeg). Returns the asset id, the probe and any remaining problems.",
    params: args({
      file: str("Absolute path of a local file (read by the MCP server)."),
      url: str("Or a URL / app path (e.g. /media/lion-proof/clean-plate.jpg)."),
      name: str("Display name (default: the file name)."),
      type: oneOf(["image", "video", "model", "audio"], "Default: from the extension."),
      hasAlpha: bool("Video/image has transparency (never re-encoded)."),
      optimise: bool("Re-encode a video that the wall would not play well (default true). false: only probe and report."),
    }),
  },
  asset_check: {
    readOnly: true,
    description:
      "What a video file is (codec, profile/level, size, frame rate, keyframe gap, bit rate, audio, fast start) and whether the wall will play it well: problems with severity error (will not play or will not look right) or warn (plays, but costs or stalls), each saying whether optimising fixes it. One asset, or every video in the library. Also reports the encoder tools on this machine (ffmpeg, hardware encoder). Desktop app only.",
    params: args({ asset: str("Asset id or exact name; omit for all videos."), reprobe: bool("Read the file again even when a probe is stored.") }),
  },
  asset_optimise: {
    description:
      "Re-encode a library video into the wall format: H.264 High, scaled to fit the wall canvas (never upscaled), a keyframe every half second, stereo AAC, fast start. The asset then points at the new file and the old library copy is deleted. Skipped when the file already plays well unless force. Refuses alpha video and media that ships with the app. Reports progress to the operator; takes seconds to minutes.",
    params: args({ asset: str("Asset id or exact name."), force: bool("Re-encode even when no problem was found.") }, ["asset"]),
  },
  asset_reveal: {
    description:
      "Open the operator's file manager (Finder, Explorer) with an asset's file selected, the same as the folder button on a media field in Scene Builder. Useful when the operator asks where a file lives. Desktop app only; media embedded in a release build has no file to show.",
    params: args({ asset: str("Asset id or exact name.") }, ["asset"]),
  },
  asset_remove: {
    destructive: true,
    description: "Remove an asset from the library (components using it lose their media).",
    params: args({ asset: str("Asset id or exact name.") }, ["asset"]),
  },
  output_settings: {
    description: "Change output settings by deep merge: canvasWidth/Height (LED canvas pixels), scaling (fit | fill | stretch | native; stretch fills a display of another shape, e.g. 1920×720 that the LED processor rescales onto a 3072×768 wall), targetFps, backgroundColor, safeArea, testPattern, standby card, timerOverlay style, monitorName, fullscreen.",
    params: args({ patch: obj("Fields to merge.") }, ["patch"]),
  },
  project: {
    description:
      "Whole-show operations: save now; export the show file to `file`; import a show file from `file` (replaces the whole show); reset to the built-in demo show (replaces everything); rename. When the file's sound levels differ from this computer's, import changes nothing until `levels` says which to keep (ask the operator).",
    destructive: true,
    params: args(
      {
        op: oneOf(["save", "export", "import", "reset_demo", "rename"], "What to do."),
        file: str("Absolute path for export/import (handled by the MCP server)."),
        name: str("For rename."),
        levels: oneOf(["local", "incoming"], "For import when the sound levels differ: keep this computer's (local) or take the file's (incoming)."),
      },
      ["op"],
    ),
  },
  package_export: {
    description:
      "Write a show package: a folder (<name>.slshow) with the show file, a versioned manifest (per-scene hashes) and every media file the show uses, so another computer gets the identical show. Each export gets the next version number. Desktop app only.",
    params: args({ dir: str('Absolute path of the package folder to write; ".slshow" is added if missing. An older package at that path is replaced once the new one is complete.') }, ["dir"]),
  },
  package_import: {
    destructive: true,
    description:
      "Take in a show package from another computer. Scenes and settings changed only in the package are taken, ones changed only here are kept; ones changed on both sides are conflicts. Without choices for every conflict (or `resolve`), nothing changes and the plan is returned. Refuses while a scene is live unless allowLive. Desktop app only.",
    params: args(
      {
        dir: str("Absolute path of the .slshow package folder."),
        mode: oneOf(["merge", "replace"], "merge (default when this show has taken in this show before) or replace the whole show (default otherwise). Machine settings (output display, MIDI ports) are always kept."),
        choices: obj('Conflict key → "incoming" | "local" | "media" (keep this scene, add the incoming media) | "both" (keep this scene, add the incoming one as a copy). Keys come from the plan, e.g. "scene:scene_ab12", "order", "output". "mix" is the sound levels: levels changed on this computer that differ from the package\'s are always a conflict, also in replace mode ("local" keeps this computer\'s levels, "incoming" takes the package\'s).'),
        resolve: oneOf(["local", "incoming"], "Choice for conflicts not listed in choices."),
        dryRun: bool("Only return the plan (versions, conflicts, what would change)."),
        allowLive: bool("Take it in even though a scene is live on the wall (the operator confirmed)."),
      },
      ["dir"],
    ),
  },
  cloud_status: {
    readOnly: true,
    description:
      "Cloud sync (Firebase, off until the operator enters keys and signs in under More → Cloud sync): whether it is set up, the signed-in account, this show's sent/received versions and the cloud's latest version. Sign-in is only done by the operator in the app.",
    params: args({}),
  },
  cloud_push: {
    live: true,
    description:
      "Send this show to the cloud as the next version (uploads only media the cloud does not have, by SHA-256). Refuses if the cloud has a version this computer has not taken in (pull first, or force), and while a scene is live unless allowLive. Desktop app only.",
    params: args({
      force: bool("Push even though the cloud has a newer version this computer has not taken in (the other computer will merge it)."),
      allowLive: bool("Push even though a scene is live (the operator confirmed)."),
    }),
  },
  cloud_pull: {
    destructive: true,
    description:
      "Take in the cloud's latest version: same plan, conflict choices and rules as package_import (dryRun for the plan; choices or resolve for conflicts; nothing changes while a conflict has no choice; allowLive when a scene is live). Downloads only media that is missing or different here. Desktop app only.",
    params: args({
      showId: str("Which show in the cloud (default: this show, or the only one there)."),
      mode: oneOf(["merge", "replace"], "As for package_import."),
      choices: obj('Conflict key → "incoming" | "local" | "media" | "both".'),
      resolve: oneOf(["local", "incoming"], "Choice for conflicts not listed in choices."),
      dryRun: bool("Only return the plan."),
      allowLive: bool("Take it in even though a scene is live on the wall (the operator confirmed)."),
    }),
  },
  update_check: {
    readOnly: true,
    description:
      "App updates from the project's GitHub releases: this app's version and whether a newer one is published (with its release notes). Downloads and installs nothing. Desktop app only.",
    params: args({}),
  },
  update_install: {
    live: true,
    destructive: true,
    description:
      "Only when the operator asked: download the update update_check found, install it and restart the app. The audience output window closes with the app and has to be reopened (output_window). Refused while a scene is live on the wall, and in development builds. The app answers before it restarts; call status again after a minute or two.",
    params: args({ version: str("The version update_check reported; refused if the available update is a different one.") }, ["version"]),
  },
  call_action: {
    description:
      "Escape hatch: call a raw store action by name with JSON arguments (see list_store_actions), e.g. store show, action setLionControl, args [{armed: true}]. Actions that take a function cannot be called this way.",
    params: args(
      { store: oneOf(["project", "show"], "Which store."), action: str("Action name."), args: { type: "array", description: "Positional arguments.", items: {} } },
      ["store", "action"],
    ),
  },
  eval: {
    destructive: true,
    description:
      "Development builds only: run JavaScript in the operator window (async function body; `return` a JSON value). In scope: project, show, io (stores), ops (operator engine), core (factories, runtime). Last resort for debugging.",
    params: args({ code: str("Function body.") }, ["code"]),
  },
} satisfies Record<string, CommandSpec>;

export type AgentCommand = keyof typeof AGENT_COMMANDS;

// ---------------------------------------------------------------- wire protocol (WebSocket, JSON)

/** MCP server → app. */
export interface AgentRequest {
  id: number;
  method: AgentCommand | "hello";
  params: Record<string, unknown>;
}

/** App → MCP server. `content` carries images; `result` is JSON. */
export interface AgentResponse {
  id: number;
  result?: unknown;
  image?: { data: string; mimeType: string };
  error?: string;
}

/** First message the app sends after connecting. */
export interface AgentHello {
  hello: "app";
  specVersion: number;
  dev: boolean;
  tauri: boolean;
  project: string;
}
