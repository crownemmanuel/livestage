// Every command the Sound app understands, in one table: the operator screen, the backstage page,
// OSC from LiveStage, the JSON API and the MCP server all go through Engine.run() with these names.
// No imports and only erasable TypeScript (Node loads it directly).

export interface SoundCommandSpec {
  description: string;
  /** Reaches the desk (mics, effects): audible in the room. */
  live?: boolean;
  destructive?: boolean;
  readOnly?: boolean;
  /** Who may call it: operator (local screen, API, MCP, OSC) or backstage (phones) too. */
  backstage?: boolean;
}

export const SOUND_API_VERSION = 1;

export const SOUND_COMMANDS = {
  status: { readOnly: true, description: "Desk link, active scene and cue, every mic's live state as the desk reports it, effects, LiveStage and sync status." },
  "scenes.list": { readOnly: true, description: "Scenes in running order with code, id, name, cast (with mics) and cue labels." },
  "scene.select": { description: "Show a scene on the operator screen without changing any mic. {scene}" },
  "scene.activate": { live: true, description: "Make a scene active and apply its first cue (mutes the previous scene's mics that are not in it). {scene}" },
  "scene.end": { live: true, description: "Mute every mic of the active scene, clear its effects and leave it." },
  "cue.go": { live: true, description: "Apply exactly one cue's mic and effect state. {scene?, cue: 1-based number or cue id}" },
  "cue.next": { live: true, description: "Apply the active scene's next cue." },
  restore: { live: true, description: "Re-apply the active cue (after a track that moved mics stops or jumps)." },
  mic: { live: true, description: "Set one mic live or muted. {who: mic number | character id | name, live: boolean}" },
  fx: { live: true, description: "Set a voice effect on one mic. {who, preset: name | id | 'none', amount?: light | medium | full}" },
  panic: { live: true, destructive: true, description: "Mute every mic at once." },
  extra: { live: true, description: "Mute / unmute or set the level of a show-wide extra channel (e.g. Dante 1 music). {extra: name | id | desk input, live?: boolean, db?: number | null}" },
  "extras.set": { description: "The show-wide extra channels (not actors' mics). {extras: [{id?, name, channel: desk input}]}" },
  level: { live: true, description: "Move one mic's fader on the desk. {who: mic number | character id | name, db: −54…+10 (or null / '-inf' for off)}" },
  "desk.reconnect": { description: "Drop the desk link and dial again." },
  "desk.refresh": { readOnly: true, description: "Ask the desk again for names, mutes and send levels." },
  "show.rename": { description: "{name}" },
  "character.save": { description: "Add or change a character. {id?, name, gender, defaultMic, palette?}" },
  "character.remove": { destructive: true, description: "Delete a character (also from every cast and cue). {id}" },
  "character.photo": { description: "Set or clear a character's photo (the upload itself is POST /api/photo/<id>). {id, photo: null}" },
  "scene.add": { description: "A scene that is not in LiveStage. {name, code?}" },
  "scene.remove": { destructive: true, description: "Delete a scene with its cues. {scene}" },
  "scene.cast": { description: "Set a scene's cast. {scene, cast: character ids}" },
  "scene.resetMics": { description: "Drop a scene's backstage mic changes (everyone back on their default mic). {scene}" },
  "cue.add": { description: "Add a cue (copies the previous cue's live set). {scene, label?, at?: 0-based index}" },
  "cue.update": { description: "{scene, cue: id, label?, live?: ids, fx?: {charId: {preset, amount} | null}, trigger?: {kind: manual} | {kind: livestage, at}}" },
  "cue.remove": { destructive: true, description: "{scene, cue: id}" },
  "cue.move": { description: "{scene, cue: id, to: 0-based index}" },
  assign: { backstage: true, description: "Backstage: put a cast member on a mic for one scene (swaps with whoever had it). {scene, character, mic}" },
  "scene.confirm": { backstage: true, description: "Backstage: mic check done for a scene. {scene, by?, sig?: the mic list the phone showed (micSig)}; it only counts while the scene's mics still match." },
  "scene.recheck": { description: "Clear a scene's mic check so backstage does it again. {scene}" },
  "scene.next": { description: "Tell backstage which scene to check next (their phones follow it). {scene} or {scene: null} to follow the running order again." },
  "preset.save": { description: "Add or change an effect preset. {preset}" },
  "preset.remove": { destructive: true, description: "{id}" },
  "mics.set": { description: "Mic → desk input table. {mics: [{n, channel}]}" },
  "mics.add": { description: "Add a mic (the next number) on a desk input. {channel: 1–128}" },
  "mics.remove": { destructive: true, description: "Remove the last mic (people on it lose it). {mic?: must be the last number}" },
  "mics.detect": { description: "Read input names 1–128 from the desk and map mics by names like Drama3 / Dram12." },
  "settings.desk": { description: "{host?, port?, baseChannel?, mode?: desk | dry}" },
  "settings.sync": { description: "{mode?: local | cloud, lanIp?, cloud?: {apiKey, projectId, databaseURL, emulatorHost, hostedUrl}, newJoinKey?: true}" },
  "settings.remote": { description: "Allow the operator screen from other computers. {allow: boolean}" },
  "import.livestage": { description: "Import or re-import scenes from LiveStage (merges). {from: local | bridge | file | json, path?, json?}" },
  "import.sources": { readOnly: true, description: "Where a LiveStage show can be imported from on this computer." },
} as const satisfies Record<string, SoundCommandSpec>;

export type SoundCommand = keyof typeof SOUND_COMMANDS;
