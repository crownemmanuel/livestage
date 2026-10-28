// LiveStage Sound: the data model shared by the service (Node) and the UI (browser).
// Pure: no Node or DOM APIs, only erasable TypeScript (Node loads it directly with type stripping).
//
// Two files on disk, both versioned and migrated on load:
//   show.json      the show: mics, characters, scenes with cast / mic assignments / cues, effect presets
//   settings.json  this computer: desk address, sync mode, cloud keys
// Runtime state (what is live, effects applied, what the desk reports) is not part of either.

import type { DliveChannel, DliveKind } from "../../shared/dlive.ts";

export const SHOW_VERSION = 1;
export const SETTINGS_VERSION = 1;
export const MIC_COUNT = 12;

export type Gender = "male" | "female";
export type FxAmount = "light" | "medium" | "full";
export const FX_AMOUNTS: FxAmount[] = ["light", "medium", "full"];
/** dB added to every send of a preset for each amount (the result is clamped to +10 dB). */
export const FX_AMOUNT_DB: Record<FxAmount, number> = { light: -10, medium: 0, full: 6 };

export interface Character {
  id: string;
  name: string;
  gender: Gender;
  /** Placeholder avatar colours (index into AVATAR_PALETTE). */
  palette: number;
  /** Uploaded photo, a file name in the data folder's photos/ (served at /photos/<file>). */
  photo: string | null;
  /** Tiny JPEG data URL (≤ 64 px) made by the operator screen at upload, mirrored to the cloud backstage page. */
  thumb: string | null;
  /** Mic this character wears unless a scene says otherwise. */
  defaultMic: number | null;
}

/** Mic n (1-based) is the desk input `channel`. */
export interface MicDef {
  n: number;
  channel: number;
}

export interface FxChoice {
  preset: string;
  amount: FxAmount;
}

export type CueTrigger = { kind: "manual" } | { kind: "livestage"; at: string };

export interface Cue {
  id: string;
  label: string;
  /** Cast members live in this cue; every other cast member is muted. */
  live: string[];
  /** Voice effect per character (character id → preset). A cast member not listed is dry. */
  fx: Record<string, FxChoice>;
  trigger: CueTrigger;
}

export interface SceneCheck {
  by: string;
  at: number;
  /** The mic list that was checked (micSig). A check counts only while the scene still matches it. */
  sig?: string;
}

export interface SoundScene {
  /** LiveStage's scene id for imported scenes (scene_…), so OSC from LiveStage matches up. */
  id: string;
  /** Display number from LiveStage ("7", "2.1"). */
  code: string;
  name: string;
  order: number;
  group: { id: string; name: string } | null;
  source: "livestage" | "local" | "demo";
  /** Set when a re-import no longer finds this scene in LiveStage; kept with its cues until removed. */
  removed: boolean;
  cast: string[];
  /** Per-scene mic for a character (set backstage), overriding the character's default mic. */
  mics: Record<string, number>;
  /** When `mics` last changed (ms), so the cloud backstage can tell whose change is newer. */
  micsAt: number;
  cues: Cue[];
  /** Last backstage "All good" for this scene. */
  checked: SceneCheck | null;
}

export type FxSendKind = "monoFxSend" | "stereoFxSend";
export interface FxSend {
  kind: FxSendKind;
  number: number;
  /** Send level at amount "medium". */
  db: number;
}
export type WatchKind = "fxReturn" | "dca";
export interface WatchChannel {
  kind: WatchKind;
  number: number;
}

export interface EffectPreset {
  id: string;
  name: string;
  desc: string;
  sends: FxSend[];
  /** FX returns / DCAs the effect needs open: Build mode warns when one is at −inf or muted. */
  watch: WatchChannel[];
  fadeIn: number;
  fadeOut: number;
}

export interface ShowSource {
  kind: "livestage";
  showName: string;
  via: string;
  importedAt: number;
}

export interface SoundShow {
  version: number;
  showId: string;
  name: string;
  mics: MicDef[];
  characters: Character[];
  scenes: SoundScene[];
  presets: EffectPreset[];
  /** Desk inputs that are not actors' mics but the operator needs all show long (Dante music players…). */
  extras: ExtraChannel[];
  source: ShowSource | null;
  updatedAt: number;
}

export interface ExtraChannel {
  id: string;
  /** What the operator sees ("Dante 1"); the desk's own name shows next to it. */
  name: string;
  /** Desk input 1–128. */
  channel: number;
}

export type DeskMode = "desk" | "dry";
export interface DeskSettings {
  host: string;
  port: number;
  /** Base MIDI channel as the desk shows it (1–12). */
  baseChannel: number;
  /** "dry": rehearse without a desk; nothing is sent, the screen acts as the desk. */
  mode: DeskMode;
}

export interface CloudSettings {
  /** Firebase web config (public values). */
  apiKey: string;
  projectId: string;
  databaseURL: string;
  /** "127.0.0.1" to use the local Firebase emulators (Auth 9099, Database 9000). */
  emulatorHost: string;
  /** Where the static backstage page is hosted once deployed (e.g. https://my-show.web.app/backstage.html). */
  hostedUrl: string;
  /** Secret in the backstage URL; the database rules only open a show to someone who has it. */
  joinKey: string;
  /** Anonymous Firebase account of this Sound app (kept so it stays the owner of its show). */
  refreshToken: string;
  uid: string;
}

export interface Settings {
  version: number;
  desk: DeskSettings;
  sync: {
    mode: "local" | "cloud";
    /** LAN address the QR code points at; null picks the first private address. */
    lanIp: string | null;
    cloud: CloudSettings;
  };
  /** The operator screen and its API answer other computers too (off: only this computer). */
  allowRemoteOperator: boolean;
}

// ---------------------------------------------------------------- runtime (not saved in the show)

export interface DeskChannelState {
  name?: string;
  muted?: boolean;
  /** Fader level byte (0 = −inf, 0x6B = 0 dB). */
  fader?: number;
  colour?: string;
}

export type DeskStatus = "dry" | "connecting" | "connected" | "offline";

export interface Runtime {
  selectedSceneId: string | null;
  activeSceneId: string | null;
  /** The scene backstage should check next. Follows the running order unless the operator set it. */
  nextSceneId: string | null;
  /** True when the operator chose the next scene (it then stays until that scene goes live). */
  nextPinned: boolean;
  /** 0-based cue index in the active scene, −1 when none. */
  cue: number;
  /** Effect applied per mic number. */
  fx: Record<string, FxChoice>;
  desk: { status: DeskStatus; host: string; port: number; error: string | null; since: number; queried: boolean };
  /** What the desk reports per channel, keyed by chKey(). In dry mode the app plays the desk. */
  channels: Record<string, DeskChannelState>;
  /** Send levels the desk reports, keyed by sendKey(). */
  sends: Record<string, number>;
  livestage: { lastAt: number | null; from: string | null; protocol: number | null; lastCommand: string | null };
  cloud: { status: "off" | "connecting" | "live" | "error"; error: string | null; at: number | null };
  /** Signal meters per mic (0–1). Null until a meter source (e.g. a Dante feed) is plugged in. */
  meters: Record<string, number> | null;
  meterSource: string | null;
  lan: { address: string; name: string }[];
  appVersion: string;
}

/** What the backstage page gets: no settings, no desk internals. */
export interface BackstageView {
  showName: string;
  /** `mics`: every cast member's mic in that scene (defaults filled in). */
  scenes: { id: string; code: string; name: string; cast: string[]; mics: Record<string, number>; micsAt: number; checked: SceneCheck | null }[];
  characters: { id: string; name: string; gender: Gender; palette: number; photo: string | null; thumb: string | null; defaultMic: number | null }[];
  micCount: number;
  activeSceneId: string | null;
  nextSceneId: string | null;
}

// ---------------------------------------------------------------- helpers

export const chKey = (c: DliveChannel) => `${c.kind}:${c.number}`;
export const sendKey = (from: DliveChannel, to: DliveChannel) => `${chKey(from)}>${chKey(to)}`;
export const micInput = (show: SoundShow, n: number): DliveChannel | null => {
  const m = show.mics.find((x) => x.n === n);
  return m ? { kind: "input", number: m.channel } : null;
};
export const isKind = (k: string, list: DliveKind[]) => list.includes(k as DliveKind);

export function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Placeholder avatar colours: background, robe, hair (from the approved mock-up). */
export const AVATAR_PALETTE: { bg: string; robe: string; hair: string }[] = [
  { bg: "#2F4C8F", robe: "#7FA2E8", hair: "#2A1C14" },
  { bg: "#6B4A2E", robe: "#C89B6A", hair: "#2A1C14" },
  { bg: "#5B4B9A", robe: "#EDE7DA", hair: "#3A2A1E" },
  { bg: "#8F3B4C", robe: "#E39AA8", hair: "#1E140E" },
  { bg: "#3E6B5A", robe: "#9CC9B6", hair: "#4A3628" },
  { bg: "#7A5A1F", robe: "#E6C27A", hair: "#2A1C14" },
  { bg: "#5E6B2F", robe: "#C7D08C", hair: "#33241A" },
  { bg: "#2F6F7A", robe: "#8FD0DA", hair: "#5A5048" },
  { bg: "#7A3F8F", robe: "#D3A2E6", hair: "#2A1C14" },
  { bg: "#3F5F8F", robe: "#A9C1E8", hair: "#8A8580" },
  { bg: "#8F5A2F", robe: "#E8B98A", hair: "#6B6560" },
  { bg: "#2F7A5A", robe: "#8FD9B6", hair: "#2A1C14" },
];

export function defaultMics(): MicDef[] {
  return Array.from({ length: MIC_COUNT }, (_, i) => ({ n: i + 1, channel: 77 + i }));
}

export function defaultPresets(): EffectPreset[] {
  return [
    {
      id: "fx_heaven",
      name: "Heaven",
      desc: "Delay + hall",
      sends: [
        { kind: "monoFxSend", number: 3, db: 0 },
        { kind: "monoFxSend", number: 2, db: -5 },
      ],
      watch: [
        { kind: "fxReturn", number: 3 },
        { kind: "fxReturn", number: 2 },
        { kind: "dca", number: 10 },
      ],
      fadeIn: 2,
      fadeOut: 2,
    },
    { id: "fx_echo", name: "Echo", desc: "Delay", sends: [{ kind: "monoFxSend", number: 3, db: 0 }], watch: [{ kind: "fxReturn", number: 3 }, { kind: "dca", number: 10 }], fadeIn: 1, fadeOut: 1.5 },
    { id: "fx_hall", name: "Big Hall", desc: "Reverb", sends: [{ kind: "monoFxSend", number: 2, db: 0 }], watch: [{ kind: "fxReturn", number: 2 }, { kind: "dca", number: 10 }], fadeIn: 1, fadeOut: 2 },
  ];
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    // Dry run until the operator switches to the desk: a fresh install never touches a live console by surprise.
    desk: { host: "192.168.1.70", port: 51325, baseChannel: 12, mode: "dry" },
    sync: {
      mode: "local",
      lanIp: null,
      cloud: { apiKey: "", projectId: "", databaseURL: "", emulatorHost: "", hostedUrl: "", joinKey: "", refreshToken: "", uid: "" },
    },
    allowRemoteOperator: false,
  };
}

/** A demo show (the approved mock-up's cast), so a first start is not empty. Import from LiveStage replaces it. */
export function demoShow(): SoundShow {
  const names: [string, string, Gender][] = [
    ["mary", "Mary", "female"], ["joseph", "Joseph", "male"], ["gabriel", "Gabriel", "male"], ["martha", "Martha", "female"],
    ["innkeeper", "Innkeeper", "male"], ["narrator", "Narrator", "female"], ["amos", "Amos", "male"], ["elizabeth", "Elizabeth", "female"],
    ["rachel", "Rachel", "female"], ["simeon", "Simeon", "male"], ["anna", "Anna", "female"], ["levi", "Levi", "male"],
  ];
  const characters: Character[] = names.map(([id, name, gender], i) => ({ id: `ch_${id}`, name, gender, palette: i, photo: null, thumb: null, defaultMic: i + 1 }));
  const c = (id: string) => `ch_${id}`;
  const crowd = ["joseph", "mary", "innkeeper", "martha", "rachel", "simeon", "anna", "levi", "amos", "elizabeth"];
  let qn = 0;
  const q = (label: string, live: string[], extra: { fx?: Record<string, string>; at?: string } = {}): Cue => ({
    id: `cue_demo${++qn}`,
    label,
    live: live.map(c),
    fx: Object.fromEntries(Object.entries(extra.fx ?? {}).map(([k, v]) => [c(k), { preset: v, amount: "medium" as FxAmount }])),
    trigger: extra.at ? { kind: "livestage", at: extra.at } : { kind: "manual" },
  });
  const raw: [string, string, string[], Cue[]][] = [
    ["1.1", "The Book", ["narrator"], [q("Narration", ["narrator"])]],
    ["2.1", "Joseph is back!", ["joseph", "innkeeper", "martha"], [q("Intro", ["joseph", "innkeeper"]), q("Song vocal", ["innkeeper"], { at: "0:42" }), q("Speaks", ["joseph", "innkeeper", "martha"], { at: "2:15" })]],
    ["4", "Mary's House", ["mary", "martha", "elizabeth"], [q("Evening", ["mary", "martha", "elizabeth"])]],
    ["7", "Gabriel at the Well", ["mary", "gabriel", "martha"], [
      q("At the well", ["mary", "martha"]),
      q("Gabriel appears", ["mary", "gabriel"], { fx: { gabriel: "fx_heaven" } }),
      q("Do not be afraid", ["gabriel"], { fx: { gabriel: "fx_heaven" }, at: "1:12" }),
      q("Martha returns", ["mary", "martha"]),
    ]],
    ["12", "Son of David", ["joseph", "gabriel"], [q("Asleep", []), q("The dream", ["gabriel"], { fx: { gabriel: "fx_heaven" } }), q("He wakes", ["joseph"])]],
    ["15.2", "The Road Back", ["joseph", "mary", "levi", "anna"], [
      q("Leaving", ["joseph", "mary"]), q("Levi on the road", ["joseph", "levi"]), q("Rest", ["mary"]), q("The well", ["joseph", "mary", "anna"]),
      q("Anna's blessing", ["anna"], { fx: { anna: "fx_hall" } }), q("Mary sings", [], { at: "3:05" }), q("Rain", ["joseph", "mary"], { at: "4:20" }),
      q("Joseph prays", ["joseph"], { fx: { joseph: "fx_echo" } }), q("Night", ["joseph", "mary"]), q("Wolves", []), q("Levi returns", ["joseph", "levi"]),
      q("The hill", ["joseph", "mary", "levi"]), q("First sight", ["mary"]), q("Bethlehem!", ["joseph", "mary", "levi", "anna"]),
    ]],
    ["16", "No Room in the House of David", crowd, [
      q("The street", ["innkeeper", "rachel", "simeon", "levi", "anna"]), q("Joseph knocks", ["joseph", "innkeeper"]),
      q("The crowd argues", ["innkeeper", "rachel", "simeon", "levi", "anna", "amos", "martha", "elizabeth"]), q("Mary", ["mary", "joseph"]),
      q("The stable", ["innkeeper", "mary", "joseph"]), q("Everyone", crowd),
    ]],
    ["17", "The Manger", ["mary", "joseph"], [q("Birth", ["mary", "joseph"])]],
    ["18", "Heaven Can't Keep Quiet", ["amos", "gabriel", "narrator"], [q("The fields", ["amos", "narrator"]), q("The angel", ["amos", "gabriel"], { fx: { gabriel: "fx_heaven" } })]],
  ];
  const scenes: SoundScene[] = raw.map(([code, name, cast, cues], i) => ({
    id: `demo_${code.replace(".", "_")}`, code, name, order: i + 1, group: null, source: "demo", removed: false, cast: cast.map(c), mics: {}, micsAt: 0, cues, checked: null,
  }));
  return { version: SHOW_VERSION, showId: uid("sshow"), name: "Demo show", mics: defaultMics(), characters, scenes, presets: defaultPresets(), extras: [], source: null, updatedAt: Date.now() };
}

// ---------------------------------------------------------------- migrations

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Older or hand-edited show files → the current shape. Unknown fields are dropped; missing ones get defaults. */
export function migrateShow(raw: unknown): SoundShow {
  const r = obj(raw);
  const v = num(r.version, 1);
  if (v > SHOW_VERSION) throw new Error(`This show file is from a newer LiveStage Sound (format ${v}); update the app`);
  // Version 1 is the first format. Future migrations go here: if (v < 2) { …; }
  const mics = arr(r.mics).map((m) => ({ n: num(obj(m).n, 0), channel: num(obj(m).channel, 0) })).filter((m) => m.n >= 1 && m.channel >= 1 && m.channel <= 128);
  const byN = new Map(mics.map((m) => [m.n, m]));
  const fullMics = defaultMics().map((d) => byN.get(d.n) ?? d);
  const characters: Character[] = arr(r.characters).map((x, i) => {
    const c = obj(x);
    return {
      id: str(c.id) || uid("ch"),
      name: str(c.name, "Unnamed"),
      gender: c.gender === "female" ? "female" : "male",
      palette: num(c.palette, i) % AVATAR_PALETTE.length,
      photo: typeof c.photo === "string" && c.photo ? c.photo : null,
      thumb: typeof c.thumb === "string" && c.thumb.startsWith("data:image/") ? c.thumb : null,
      defaultMic: typeof c.defaultMic === "number" ? c.defaultMic : null,
    };
  });
  const amount = (a: unknown): FxAmount => (a === "light" || a === "full" ? a : "medium");
  const scenes: SoundScene[] = arr(r.scenes).map((x, i) => {
    const s = obj(x);
    const g = obj(s.group);
    return {
      id: str(s.id) || uid("scene"),
      code: str(s.code, String(i + 1)),
      name: str(s.name, "Scene"),
      order: num(s.order, i + 1),
      group: str(g.id) ? { id: str(g.id), name: str(g.name) } : null,
      source: s.source === "livestage" || s.source === "demo" ? s.source : "local",
      removed: s.removed === true,
      cast: arr(s.cast).filter((id): id is string => typeof id === "string"),
      mics: Object.fromEntries(Object.entries(obj(s.mics)).filter((e): e is [string, number] => typeof e[1] === "number")),
      micsAt: num(s.micsAt, 0),
      cues: arr(s.cues).map((y) => {
        const q = obj(y);
        const t = obj(q.trigger);
        return {
          id: str(q.id) || uid("cue"),
          label: str(q.label, "Cue"),
          live: arr(q.live).filter((id): id is string => typeof id === "string"),
          fx: Object.fromEntries(
            Object.entries(obj(q.fx))
              .map(([k, f]): [string, FxChoice] => [k, { preset: str(obj(f).preset), amount: amount(obj(f).amount) }])
              .filter((e) => e[1].preset),
          ),
          trigger: t.kind === "livestage" ? { kind: "livestage", at: str(t.at) } : { kind: "manual" },
        } satisfies Cue;
      }),
      checked: typeof obj(s.checked).at === "number" ? { by: str(obj(s.checked).by), at: num(obj(s.checked).at, 0), ...(typeof obj(s.checked).sig === "string" ? { sig: str(obj(s.checked).sig) } : {}) } : null,
    };
  });
  const presets: EffectPreset[] = arr(r.presets).map((x) => {
    const p = obj(x);
    return {
      id: str(p.id) || uid("fx"),
      name: str(p.name, "Effect"),
      desc: str(p.desc),
      sends: arr(p.sends).map((y) => {
        const s = obj(y);
        return { kind: s.kind === "stereoFxSend" ? "stereoFxSend" : "monoFxSend", number: Math.max(1, Math.min(16, num(s.number, 1))), db: Math.max(-54, Math.min(10, num(s.db, 0))) } satisfies FxSend;
      }),
      watch: arr(p.watch).map((y) => {
        const w = obj(y);
        return { kind: w.kind === "dca" ? "dca" : "fxReturn", number: num(w.number, 1) } satisfies WatchChannel;
      }),
      fadeIn: Math.max(0, num(p.fadeIn, 1)),
      fadeOut: Math.max(0, num(p.fadeOut, 1)),
    };
  });
  const src = obj(r.source);
  return {
    version: SHOW_VERSION,
    showId: str(r.showId) || uid("sshow"),
    name: str(r.name, "Show"),
    mics: fullMics,
    characters,
    scenes,
    presets,
    extras: arr(r.extras)
      .map((x) => ({ id: str(obj(x).id) || uid("ex"), name: str(obj(x).name).slice(0, 30), channel: num(obj(x).channel, 0) }))
      .filter((x) => x.name && x.channel >= 1 && x.channel <= 128),
    source: src.kind === "livestage" ? { kind: "livestage", showName: str(src.showName), via: str(src.via), importedAt: num(src.importedAt, 0) } : null,
    updatedAt: num(r.updatedAt, Date.now()),
  };
}

export function migrateSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = obj(raw);
  const v = num(r.version, 1);
  if (v > SETTINGS_VERSION) throw new Error(`settings.json is from a newer LiveStage Sound (format ${v})`);
  const desk = obj(r.desk);
  const sync = obj(r.sync);
  const cloud = obj(sync.cloud);
  return {
    version: SETTINGS_VERSION,
    desk: {
      host: str(desk.host, d.desk.host).trim() || d.desk.host,
      port: Math.round(num(desk.port, d.desk.port)),
      baseChannel: Math.max(1, Math.min(12, Math.round(num(desk.baseChannel, d.desk.baseChannel)))),
      mode: desk.mode === "desk" ? "desk" : "dry",
    },
    sync: {
      mode: sync.mode === "cloud" ? "cloud" : "local",
      lanIp: typeof sync.lanIp === "string" && sync.lanIp ? sync.lanIp : null,
      cloud: {
        apiKey: str(cloud.apiKey),
        projectId: str(cloud.projectId),
        databaseURL: str(cloud.databaseURL),
        emulatorHost: str(cloud.emulatorHost),
        hostedUrl: str(cloud.hostedUrl),
        joinKey: str(cloud.joinKey),
        refreshToken: str(cloud.refreshToken),
        uid: str(cloud.uid),
      },
    },
    allowRemoteOperator: r.allowRemoteOperator === true,
  };
}
