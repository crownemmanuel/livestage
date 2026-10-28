// StageLight, the lighting desk, as a show-control partner: the OSC it understands (see its
// docs/SISTER-APPS.md), built from the messages cues and time markers store, and its replies.
// Pure and import-free, so Node runs it directly (scripts/stagelight-check.ts).

/** StageLight's OSC listen port on a show computer. Dev desks use other ports (1471, 1481). */
export const STAGELIGHT_DEFAULT_PORT = 1461;

/**
 * A command to StageLight (OSC, settings under io.stagelight). Pages and cues are StageLight's own:
 * an ID, a name (case-insensitive) or a 1-based number. Picked from StageLight's catalog they are IDs,
 * and `label` keeps the names as they were then, for when StageLight is not answering.
 */
export type StageLightMessage = StageLightCommand & { label?: string };

type StageLightCommand =
  /** GO the next cue of a page's cue list ("" = the page that is running). Auto-follow continues in StageLight. */
  | { type: "stagelight"; op: "go"; page: string }
  /** GO one cue of a page (entry ID, number or name). */
  | { type: "stagelight"; op: "goCue"; page: string; cue: string }
  /** Previous cue on the running page. */
  | { type: "stagelight"; op: "back" }
  /** stop = fade to dark; clear = release manual changes back to the cue. fade in seconds, null = StageLight's default. */
  | { type: "stagelight"; op: "stop" | "clear"; fade: number | null }
  | { type: "stagelight"; op: "blackout"; on: boolean }
  /** Master level 0..1. */
  | { type: "stagelight"; op: "master"; level: number }
  /** Play a library cue outside any page. */
  | { type: "stagelight"; op: "play"; cue: string; fade: number | null }
  /** LED wall preview media in StageLight ("off" = blank). */
  | { type: "stagelight"; op: "ledwall"; media: string }
  /** A named trigger: StageLight maps the name to an action, so the cue numbers can change there. */
  | { type: "stagelight"; op: "trigger"; name: string };
export type StageLightOp = StageLightMessage["op"];

export interface StageLightSettings {
  /** Send to StageLight (this computer only: a show file from another machine never switches it on). */
  enabled: boolean;
  host: string;
  /** StageLight's OSC port (1461). */
  port: number;
  /** Also send every live TAKE and GO as a named trigger: scene.<code>, cue.<code>.<n>. */
  mirror: boolean;
  /** StageLight's pages, cues, triggers and library cues as last read from it, so cues can be built while it is off. */
  catalog?: StageLightCatalog | null;
}

/** What StageLight has, read with /stagelight/catalog (StageLight 0.3+). */
export interface StageLightCatalog {
  /** StageLight's show revision; its hello carries the current one. */
  revision: number;
  /** host:port it was read from (another desk may have the same revision number). */
  from?: string;
  pages: { id: string; name: string; number: number; color: string; cues: { number: number; entryId: string; name: string; follow: "manual" | "auto"; fade: number }[] }[];
  triggers: { id: string; name: string; does: string }[];
  library: { id: string; name: string }[];
}

export const STAGELIGHT_OPS: { op: StageLightOp; label: string }[] = [
  { op: "go", label: "GO (next cue)" },
  { op: "goCue", label: "GO cue" },
  { op: "trigger", label: "Named trigger" },
  { op: "back", label: "Back" },
  { op: "stop", label: "Stop (fade out)" },
  { op: "clear", label: "Clear" },
  { op: "blackout", label: "Blackout" },
  { op: "master", label: "Master level" },
  { op: "play", label: "Play library cue" },
  { op: "ledwall", label: "LED wall media" },
];

export function defaultStageLightMessage(op: StageLightOp = "go"): StageLightMessage {
  switch (op) {
    case "go":
      return { type: "stagelight", op, page: "" };
    case "goCue":
      return { type: "stagelight", op, page: "", cue: "1" };
    case "back":
      return { type: "stagelight", op };
    case "stop":
    case "clear":
      return { type: "stagelight", op, fade: null };
    case "blackout":
      return { type: "stagelight", op, on: true };
    case "master":
      return { type: "stagelight", op, level: 1 };
    case "play":
      return { type: "stagelight", op, cue: "", fade: null };
    case "ledwall":
      return { type: "stagelight", op, media: "off" };
    case "trigger":
      return { type: "stagelight", op, name: "" };
  }
}

// ---------------------------------------------------------------- wire

/** One OSC argument as the Rust shell sends it (src-tauri/src/io.rs). */
export type OscWireArg = { t: "i"; v: number } | { t: "f"; v: number } | { t: "s"; v: string };

const s = (v: string): OscWireArg => ({ t: "s", v });
const f = (v: number): OscWireArg => ({ t: "f", v });
const i = (v: number): OscWireArg => ({ t: "i", v });
const fade = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? [f(Math.max(0, x))] : []);
const need = (v: string | undefined, what: string) => {
  const t = (v ?? "").trim();
  if (!t) throw new Error(`StageLight: no ${what}`);
  return t;
};

/** A cue given as a plain number goes as int32 (StageLight takes both); anything else as text. */
function cueArg(cue: string): OscWireArg {
  return /^\d+$/.test(cue) && +cue > 0 && +cue < 2 ** 31 ? i(+cue) : s(cue);
}

/** The OSC a message becomes. Throws when a required field is empty. */
export function stageLightOsc(m: StageLightMessage): { address: string; args: OscWireArg[] } {
  switch (m.op) {
    case "go":
      return { address: "/stagelight/go", args: m.page.trim() ? [s(m.page.trim())] : [] };
    case "goCue":
      return { address: "/stagelight/go/cue", args: [s(need(m.page, "page")), cueArg(need(m.cue, "cue"))] };
    case "back":
      return { address: "/stagelight/back", args: [] };
    case "stop":
    case "clear":
      return { address: `/stagelight/${m.op}`, args: fade(m.fade) };
    case "blackout":
      return { address: "/stagelight/blackout", args: [i(m.on ? 1 : 0)] };
    case "master":
      return { address: "/stagelight/master", args: [f(Math.max(0, Math.min(1, Number.isFinite(m.level) ? m.level : 0)))] };
    case "play":
      return { address: "/stagelight/play", args: [s(need(m.cue, "library cue")), ...fade(m.fade)] };
    case "ledwall":
      return { address: "/stagelight/ledwall", args: [s(m.media.trim() || "off")] };
    case "trigger":
      return { address: "/stagelight/trigger", args: [s(need(m.name, "trigger name"))] };
  }
}

/** Ask StageLight for /stagelight/hello, sent to `replyPort` (LiveStage's OSC listen port) when given. */
export function stageLightPing(replyPort: number | null): { address: string; args: OscWireArg[] } {
  return { address: "/stagelight/ping", args: replyPort ? [i(replyPort)] : [] };
}

/** `/stagelight/go/cue "Act 1" 4`: strings quoted, as in the I/O monitor and the Test dialog. */
export function formatOsc(address: string, args: OscWireArg[]): string {
  return [address, ...args.map((a) => (a.t === "s" ? JSON.stringify(a.v) : a.t === "f" ? String(Math.round(a.v * 1000) / 1000) : String(a.v)))].join(" ");
}

/** "StageLight GO Scene 1 · 3 First light": names from the catalog when given, else the label kept when picked. */
export function describeStageLight(m: StageLightMessage, c?: StageLightCatalog | null): string {
  const q = (x: string) => `"${x}"`;
  const fd = (x: number | null) => (typeof x === "number" ? ` (${x} s)` : "");
  const named = stageLightTarget(m, c).text;
  switch (m.op) {
    case "go":
      return named && m.page.trim() ? `StageLight GO ${named}` : `StageLight GO ${m.page.trim() ? q(m.page.trim()) : "running page"} (next cue)`;
    case "goCue":
      return named ? `StageLight GO ${named}` : `StageLight GO ${q(m.page.trim())} cue ${m.cue.trim()}`;
    case "back":
      return "StageLight Back";
    case "stop":
      return `StageLight Stop${fd(m.fade)}`;
    case "clear":
      return `StageLight Clear${fd(m.fade)}`;
    case "blackout":
      return `StageLight blackout ${m.on ? "on" : "off"}`;
    case "master":
      return `StageLight master ${Math.round(m.level * 100)}%`;
    case "play":
      return `StageLight play ${q(named ?? m.cue.trim())}${fd(m.fade)}`;
    case "ledwall":
      return `StageLight LED wall ${q(m.media.trim() || "off")}`;
    case "trigger":
      return `StageLight trigger ${q(named ?? m.name.trim())}`;
  }
}

// ---------------------------------------------------------------- mirroring TAKE / GO

/** Trigger names for mirroring: a TAKE of scene 1.2 → "scene.1.2", GO of its cue 3 → "cue.1.2.3". */
export const mirrorTakeName = (code: string) => `scene.${code}`;
export const mirrorCueName = (code: string, cueNumber: number) => `cue.${code}.${cueNumber}`;
const MIRROR_NAME = /^(scene|cue)\.[\d.]+$/;

// ---------------------------------------------------------------- replies

export type StageLightReply =
  | { kind: "hello"; app: string; version: string; armed: boolean | null; page: string; cue: string; /** null = a StageLight without the catalog (before 0.3). */ catalogRevision: number | null }
  | { kind: "catalogBegin"; revision: number; pages: number; triggers: number; library: number }
  | { kind: "catalogPage"; id: string; name: string; number: number; cues: number; color: string }
  | { kind: "catalogCue"; pageId: string; number: number; entryId: string; name: string; follow: "manual" | "auto"; fade: number }
  | { kind: "catalogTrigger"; id: string; name: string; does: string }
  | { kind: "catalogLibrary"; id: string; name: string }
  | { kind: "catalogEnd"; revision: number }
  | { kind: "live"; pageId: string; pageName: string; cueNumber: number; cueName: string; entryId: string }
  | { kind: "error"; address: string; message: string; /** The refusal was a mirrored TAKE / GO name StageLight has no trigger for. */ unmappedMirror: boolean }
  | { kind: "look"; page: string; cue: string; kelvin: number; level: number; color: string }
  | { kind: "other" };

/** Read a /stagelight/... message StageLight sent us (null = not StageLight's). */
export function parseStageLightReply(address: string, args: (number | string | boolean)[]): StageLightReply | null {
  if (!address.startsWith("/stagelight/")) return null;
  const t = (k: number) => (args[k] === undefined ? "" : String(args[k]));
  const n = (k: number) => (typeof args[k] === "number" ? (args[k] as number) : typeof args[k] === "boolean" ? Number(args[k]) : Number(args[k] ?? NaN));
  switch (address) {
    case "/stagelight/hello":
      // A target test sends just "StageLight" "test".
      return { kind: "hello", app: t(0), version: t(1), armed: args.length > 2 ? n(2) === 1 : null, page: t(3), cue: t(4), catalogRevision: args.length > 5 && Number.isFinite(n(5)) ? n(5) : null };
    case "/stagelight/catalog/begin":
      return { kind: "catalogBegin", revision: n(0), pages: n(1), triggers: n(2), library: n(3) };
    case "/stagelight/catalog/page":
      return { kind: "catalogPage", id: t(0), name: t(1), number: n(2), cues: n(3), color: t(4) };
    case "/stagelight/catalog/cue":
      return { kind: "catalogCue", pageId: t(0), number: n(1), entryId: t(2), name: t(3), follow: t(4) === "auto" ? "auto" : "manual", fade: Number.isFinite(n(5)) ? n(5) : 0 };
    case "/stagelight/catalog/trigger":
      return { kind: "catalogTrigger", id: t(0), name: t(1), does: t(2) };
    case "/stagelight/catalog/library":
      return { kind: "catalogLibrary", id: t(0), name: t(1) };
    case "/stagelight/catalog/end":
      return { kind: "catalogEnd", revision: n(0) };
    case "/stagelight/cue/live":
      return { kind: "live", pageId: t(0), pageName: t(1), cueNumber: n(2), cueName: t(3), entryId: t(4) };
    case "/stagelight/error": {
      const message = t(1);
      const name = /^Unknown trigger (.*)$/.exec(message)?.[1] ?? "";
      return { kind: "error", address: t(0), message, unmappedMirror: t(0) === "/stagelight/trigger" && MIRROR_NAME.test(name) };
    }
    case "/stagelight/look":
      return { kind: "look", page: t(0), cue: t(1), kelvin: n(2), level: n(3), color: t(4) };
  }
  return { kind: "other" };
}

// ---------------------------------------------------------------- catalog

/** Ask StageLight for its catalog, answered to `replyPort` (LiveStage's OSC listen port) when given. */
export function stageLightCatalogRequest(replyPort: number | null): { address: string; args: OscWireArg[] } {
  return { address: "/stagelight/catalog", args: replyPort ? [i(replyPort)] : [] };
}

/** A catalog being received: one UDP message per item, between begin and end. */
export interface CatalogAssembly {
  expect: { revision: number; pages: number; triggers: number; library: number; cues: Record<string, number> };
  catalog: StageLightCatalog;
}

/**
 * Feed one catalog reply. Returns the assembly so far, and `done` with the catalog when `end` arrives
 * and everything announced came (`incomplete` says what is missing otherwise: a UDP packet was lost
 * or StageLight changed in between, so ask again).
 */
export function catalogStep(
  a: CatalogAssembly | null,
  r: StageLightReply,
): { assembly: CatalogAssembly | null; done?: StageLightCatalog; incomplete?: string } {
  if (r.kind === "catalogBegin")
    return { assembly: { expect: { revision: r.revision, pages: r.pages, triggers: r.triggers, library: r.library, cues: {} }, catalog: { revision: r.revision, pages: [], triggers: [], library: [] } } };
  if (!a) return { assembly: null };
  const c = a.catalog;
  switch (r.kind) {
    case "catalogPage":
      if (!c.pages.some((p) => p.id === r.id)) c.pages.push({ id: r.id, name: r.name, number: r.number, color: r.color, cues: [] });
      a.expect.cues[r.id] = r.cues;
      break;
    case "catalogCue": {
      const p = c.pages.find((x) => x.id === r.pageId);
      if (p && !p.cues.some((x) => x.entryId === r.entryId)) p.cues.push({ number: r.number, entryId: r.entryId, name: r.name, follow: r.follow, fade: r.fade });
      break;
    }
    case "catalogTrigger":
      if (!c.triggers.some((x) => x.id === r.id)) c.triggers.push({ id: r.id, name: r.name, does: r.does });
      break;
    case "catalogLibrary":
      if (!c.library.some((x) => x.id === r.id)) c.library.push({ id: r.id, name: r.name });
      break;
    case "catalogEnd": {
      const e = a.expect;
      const short: string[] = [];
      if (r.revision !== e.revision) short.push(`revision changed (${e.revision} → ${r.revision})`);
      if (c.pages.length !== e.pages) short.push(`${c.pages.length}/${e.pages} pages`);
      for (const p of c.pages) if (p.cues.length !== (e.cues[p.id] ?? 0)) short.push(`${p.cues.length}/${e.cues[p.id] ?? 0} cues of ${p.name}`);
      if (c.triggers.length !== e.triggers) short.push(`${c.triggers.length}/${e.triggers} triggers`);
      if (c.library.length !== e.library) short.push(`${c.library.length}/${e.library} library cues`);
      if (short.length) return { assembly: null, incomplete: short.join(", ") };
      c.pages.sort((x, y) => x.number - y.number);
      for (const p of c.pages) p.cues.sort((x, y) => x.number - y.number);
      return { assembly: null, done: c };
    }
  }
  return { assembly: a };
}

type Page = StageLightCatalog["pages"][number];
const low = (x: string) => x.trim().toLowerCase();

/** A page by ID, name (case-insensitive) or 1-based number, as StageLight itself resolves it. */
export function findCatalogPage(c: StageLightCatalog | null | undefined, ref: string): Page | null {
  const r = ref.trim();
  if (!c || !r) return null;
  return c.pages.find((p) => p.id === r) ?? c.pages.find((p) => low(p.name) === low(r)) ?? (/^\d+$/.test(r) ? (c.pages.find((p) => p.number === +r) ?? null) : null);
}

/** A cue of a page by entry ID, 1-based number or name. */
export function findCatalogCue(page: Page | null, ref: string) {
  const r = ref.trim();
  if (!page || !r) return null;
  return page.cues.find((e) => e.entryId === r) ?? (/^\d+$/.test(r) ? page.cues.find((e) => e.number === +r) : undefined) ?? page.cues.find((e) => low(e.name) === low(r)) ?? null;
}

export const findCatalogTrigger = (c: StageLightCatalog | null | undefined, ref: string) => c?.triggers.find((t) => t.id === ref.trim()) ?? c?.triggers.find((t) => low(t.name) === low(ref)) ?? null;
export const findCatalogLibrary = (c: StageLightCatalog | null | undefined, ref: string) => c?.library.find((t) => t.id === ref.trim()) ?? c?.library.find((t) => low(t.name) === low(ref)) ?? null;

/**
 * What a message points at, in StageLight's current words ("Scene 1 · 3 First light"), and what is
 * missing from the catalog. Without a catalog, the label kept when it was picked (if any).
 */
export function stageLightTarget(m: StageLightMessage, c: StageLightCatalog | null | undefined): { text: string | null; missing: string | null } {
  if (!c) return { text: m.label ?? null, missing: null };
  switch (m.op) {
    case "go":
    case "goCue": {
      if (!m.page.trim()) return { text: null, missing: null };
      const p = findCatalogPage(c, m.page);
      if (!p) return { text: m.label ?? null, missing: `page "${m.page}" is not in StageLight` };
      if (m.op === "go") return { text: `${p.name} · next cue`, missing: null };
      const e = findCatalogCue(p, m.cue);
      return e ? { text: `${p.name} · ${e.number} ${e.name}`.trim(), missing: null } : { text: m.label ?? null, missing: `cue "${m.cue}" is not on ${p.name}` };
    }
    case "trigger": {
      if (!m.name.trim()) return { text: null, missing: null };
      const t = findCatalogTrigger(c, m.name);
      return t ? { text: t.name, missing: null } : { text: m.label ?? null, missing: `trigger "${m.name}" is not in StageLight` };
    }
    case "play": {
      if (!m.cue.trim()) return { text: null, missing: null };
      const l = findCatalogLibrary(c, m.cue);
      return l ? { text: l.name, missing: null } : { text: m.label ?? null, missing: `library cue "${m.cue}" is not in StageLight` };
    }
  }
  return { text: null, missing: null };
}

/**
 * Point a message at catalog IDs where its page / cue / trigger / library cue matches one (by ID,
 * name or number), and record the names in `label`. References the catalog does not know stay as
 * they are: StageLight may still resolve them, and the editor flags them.
 */
export function resolveWithCatalog(m: StageLightMessage, c: StageLightCatalog | null | undefined): StageLightMessage {
  if (!c) return m;
  switch (m.op) {
    case "go":
    case "goCue": {
      const p = findCatalogPage(c, m.page);
      if (!p) return m;
      if (m.op === "go") return { ...m, page: p.id, label: p.name };
      const e = findCatalogCue(p, m.cue);
      return e ? { ...m, page: p.id, cue: e.entryId, label: `${p.name} · ${e.number} ${e.name}`.trim() } : { ...m, page: p.id };
    }
    case "trigger": {
      const t = findCatalogTrigger(c, m.name);
      return t ? { ...m, name: t.id, label: t.name } : m;
    }
    case "play": {
      const l = findCatalogLibrary(c, m.cue);
      return l ? { ...m, cue: l.id, label: l.name } : m;
    }
  }
  return m;
}

// ---------------------------------------------------------------- agents

const OP_ALIASES: Record<string, StageLightOp> = { "go/cue": "goCue", "go.cue": "goCue", gocue: "goCue", cue: "goCue", next: "go" };
const text = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "");
const optFade = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);

/**
 * A StageLight message in its stored shape, from what an agent sent: numbers for page / cue become
 * text, a master level over 1 is read as a percentage, unknown fields are dropped. Throws with the
 * valid shapes when it cannot be made sense of.
 */
export function normalizeStageLight(raw: Record<string, unknown>): StageLightMessage {
  const op = (OP_ALIASES[String(raw.op ?? "").toLowerCase()] ?? raw.op) as StageLightOp;
  const shapes =
    'Shapes: {type:"stagelight", op:"go", page:""} | {op:"goCue", page, cue} | {op:"trigger", name} | {op:"back"} | {op:"stop"|"clear", fade?} | {op:"blackout", on} | {op:"master", level 0..1} | {op:"play", cue, fade?} | {op:"ledwall", media}';
  if (!STAGELIGHT_OPS.some((o) => o.op === op)) throw new Error(`Unknown StageLight op "${String(raw.op)}". ${shapes}`);
  let m: StageLightMessage;
  switch (op) {
    case "go":
      m = { type: "stagelight", op, page: text(raw.page) };
      break;
    case "goCue":
      m = { type: "stagelight", op, page: text(raw.page), cue: text(raw.cue) };
      break;
    case "back":
      m = { type: "stagelight", op };
      break;
    case "stop":
    case "clear":
      m = { type: "stagelight", op, fade: optFade(raw.fade) };
      break;
    case "blackout":
      m = { type: "stagelight", op, on: !(raw.on === false || raw.on === 0 || raw.on === "0" || raw.on === "off" || raw.on === "false") };
      break;
    case "master": {
      const v = Number(raw.level ?? raw.value);
      if (!Number.isFinite(v)) throw new Error("StageLight master needs level 0..1");
      m = { type: "stagelight", op, level: Math.max(0, Math.min(1, v > 1 ? v / 100 : v)) };
      break;
    }
    case "play":
      m = { type: "stagelight", op, cue: text(raw.cue), fade: optFade(raw.fade) };
      break;
    case "ledwall":
      m = { type: "stagelight", op, media: text(raw.media) || "off" };
      break;
    case "trigger":
      m = { type: "stagelight", op, name: text(raw.name ?? raw.trigger) };
      break;
  }
  if (typeof raw.label === "string" && raw.label.trim()) m.label = raw.label.trim();
  stageLightOsc(m); // throws on a missing page / cue / name
  return m;
}
