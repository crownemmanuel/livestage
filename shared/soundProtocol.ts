// How LiveStage (or anything else on the network) drives the Sound app, which owns the dLive.
// OSC over UDP to the Sound app's OSC port. Every argument is an OSC string or int32; commands set a
// state ("Joseph muted"), never toggle, so sending one twice is harmless (UDP can drop a packet).
//
// `who` names a mic: its number ("3"), the character's id, or the character's name (case-insensitive).
// Scene ids are LiveStage scene ids (scene_…), so scenes imported from a LiveStage show match up.
//
// No imports and only erasable TypeScript: Node loads this file directly (type stripping).

/** The Sound app's web server: operator screen at /, backstage mic check at /backstage. */
export const SOUND_HTTP_PORT = 1450;
/** The Sound app listens for OSC commands here. */
export const SOUND_OSC_PORT = 1451;

export const SOUND_PROTOCOL_VERSION = 1;

export const SOUND_OSC = {
  /** s:sceneId: show this scene on the operator screen without changing any mic. */
  sceneSelect: "/sound/scene/select",
  /** s:sceneId: select the scene and apply its first cue. */
  sceneActivate: "/sound/scene/activate",
  /** Mute every mic of the active scene and leave it. */
  sceneEnd: "/sound/scene/end",
  /** s:sceneId i:cue (1-based): apply exactly that cue's mic and effect state. */
  cueGo: "/sound/cue/go",
  /** Apply the active scene's next cue. */
  cueNext: "/sound/cue/next",
  /** s:who i:live (1 = live, 0 = muted). */
  mic: "/sound/mic",
  /** s:who s:preset ("none" clears) [s:amount light | medium | full]. */
  fx: "/sound/fx",
  /** Re-apply the active cue: what LiveStage sends when a track that moved mics stops or jumps. */
  restore: "/sound/restore",
  /** Mute every mic. */
  panic: "/sound/panic",
  /** i:version: ask the Sound app to answer with /sound/hello to the sender's address and port. */
  ping: "/sound/ping",
} as const;

/** What the Sound app sends back to whoever pinged it last (address and port of that ping). */
export const SOUND_OSC_REPLY = {
  /** i:protocolVersion s:appVersion i:deskConnected (0/1). */
  hello: "/sound/hello",
  /** i:mic s:name i:live — whenever a mic changes, from any source (cue, operator, the desk itself). */
  mic: "/sound/state/mic",
  /** s:sceneId i:cue (1-based, 0 = none active). */
  cue: "/sound/state/cue",
} as const;

export type SoundFxAmount = "light" | "medium" | "full";
