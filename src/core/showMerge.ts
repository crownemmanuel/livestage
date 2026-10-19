// Taking in another machine's version of the show (a show package or a cloud sync) without silently
// losing what was changed here. The show is split into units: each scene, the running order, and each
// show-wide setting. Every unit has a content hash. Each version carries the ids of the versions it descends
// from, and each machine keeps the hashes of the versions it sent or took in (`lineage.bases`); the newest
// version both sides share is the merge base. A unit changed only upstream is taken, one changed only here
// is kept, and one changed on both sides is a conflict the operator decides. The asset library merges by adding.
// See docs/SHOW_PACKAGE.md.

import { cloneScene } from "./factories";
import { normalizeGroups } from "./groups";
import type { Asset, IoSettings, OutputSettings, Project, Scene, ShowLineage } from "./types";

// ---------------------------------------------------------------- hashing

/** JSON with sorted keys, so equal content always gives equal text. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** 64-bit content hash (two independent 32-bit FNV-1a lanes), as 16 hex digits. */
export function contentHash(v: unknown): string {
  const s = stableStringify(v);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- units

/** Settings that belong to the machine, not the show: never sent, never overwritten. */
function sharedOutput(o: OutputSettings) {
  const { monitorName: _m, fullscreen: _f, windowWidth: _w, windowHeight: _h, ...rest } = o;
  return rest;
}
function sharedIo(io: IoSettings | undefined) {
  if (!io) return null;
  const { enabled: _e, input: _i, output: _o, ...midi } = io.midi;
  const { enabled: _oe, ...osc } = io.osc;
  return { ...io, midi, osc };
}

/** A scene's content: what the operator edits (not its place in the running order or its thumbnail). */
function sceneContent(s: Scene) {
  const { thumbnail: _t, number: _n, groupId: _g, ...rest } = s;
  return rest;
}

const SETTINGS: { key: string; label: string; value: (p: Project) => unknown }[] = [
  { key: "name", label: "Show name", value: (p) => p.name },
  { key: "order", label: "Running order and groups", value: (p) => ({ scenes: p.scenes.map((s) => [s.id, s.groupId ?? null]), groups: (p.groups ?? []).map(({ collapsed: _c, ...g }) => g) }) },
  { key: "output", label: "Wall and output settings", value: (p) => sharedOutput(p.output) },
  { key: "io", label: "Show control (MIDI / OSC)", value: (p) => sharedIo(p.io) },
  { key: "timers", label: "Show timers", value: (p) => p.timers ?? [] },
  { key: "announcements", label: "Announcements", value: (p) => p.announcements ?? [] },
  { key: "effectPresets", label: "Effect presets", value: (p) => p.effectPresets ?? [] },
];

export interface UnitInfo {
  label: string;
  hash: string;
}

/** Every unit of a show with its hash. Scene keys are "scene:<id>". */
export function showUnits(p: Project): Record<string, UnitInfo> {
  const out: Record<string, UnitInfo> = {};
  p.scenes.forEach((s, i) => (out[`scene:${s.id}`] = { label: `${i + 1}. ${s.name}`, hash: contentHash(sceneContent(s)) }));
  for (const u of SETTINGS) out[u.key] = { label: u.label, hash: contentHash(u.value(p)) };
  return out;
}

export function unitHashes(p: Project): Record<string, string> {
  return Object.fromEntries(Object.entries(showUnits(p)).map(([k, v]) => [k, v.hash]));
}

// ---------------------------------------------------------------- planning

/**
 * - same: identical on both sides
 * - incoming: changed (or added, or removed) upstream only: taken
 * - local: changed (or added, or removed) here only: kept
 * - conflict: changed on both sides (or changed on one, removed on the other): the operator decides
 */
export type UnitState = "same" | "incoming" | "local" | "conflict";

/**
 * incoming: take the incoming version · local: keep this machine's version · media: keep this machine's
 * scene but add the incoming scene's media to the library · both: keep this scene and add the incoming one
 * as a copy next to it. media and both are for scenes that exist on both sides.
 */
export type MergeChoice = "incoming" | "local" | "media" | "both";

export interface MergeItem {
  key: string;
  label: string;
  kind: "scene" | "setting";
  state: UnitState;
  /** What each side did since the base: changed, added, removed or nothing. */
  here: "unchanged" | "changed" | "added" | "removed";
  upstream: "unchanged" | "changed" | "added" | "removed";
  /** The choices that make sense for this item (conflicts only). */
  options: MergeChoice[];
  /** What happens unless the operator chooses otherwise. Conflicts default to keeping this machine's version. */
  choice: MergeChoice;
}

export interface MergePlan {
  items: MergeItem[];
  conflicts: number;
  /** This machine's copy has never exchanged versions with the incoming show (or is another show). */
  unrelated: boolean;
}

function side(now: string | undefined, base: string | undefined) {
  if (now === base) return "unchanged" as const;
  if (now === undefined) return "removed" as const;
  return base === undefined ? ("added" as const) : ("changed" as const);
}

/** The newest version in the incoming version's ancestry that this machine also has: its unit hashes. */
export function mergeBase(local: Project, incoming: Project, ancestry: string[] | undefined): Record<string, string> | null {
  const lin = local.lineage;
  if (!lin?.showId || lin.showId !== incoming.lineage?.showId || !lin.bases || !ancestry) return null;
  for (let i = ancestry.length - 1; i >= 0; i--) if (lin.bases[ancestry[i]]) return lin.bases[ancestry[i]];
  return null;
}

/** `ancestry`: the incoming version's history (its own id last), from its manifest. */
export function planMerge(local: Project, incoming: Project, ancestry?: string[]): MergePlan {
  const L = showUnits(local);
  const I = showUnits(incoming);
  const B = mergeBase(local, incoming, ancestry) ?? {};
  const hasBase = Object.keys(B).length > 0;
  const keys = [...new Set([...Object.keys(I), ...Object.keys(L)])];
  const items: MergeItem[] = [];
  for (const key of keys) {
    const l = L[key]?.hash;
    const i = I[key]?.hash;
    const b = B[key];
    const kind = key.startsWith("scene:") ? "scene" : "setting";
    const label = I[key]?.label ?? L[key]?.label ?? key;
    const here = side(l, b);
    const upstream = side(i, b);
    let state: UnitState;
    if (l === i) state = "same";
    else if (l === b) state = "incoming";
    else if (i === b) state = "local";
    else state = "conflict";
    const bothExist = l !== undefined && i !== undefined;
    const options: MergeChoice[] = state !== "conflict" ? [] : kind === "scene" && bothExist ? ["incoming", "local", "media", "both"] : ["incoming", "local"];
    items.push({ key, label, kind, state, here, upstream, options, choice: state === "incoming" ? "incoming" : "local" });
  }
  // Running order first, then scenes in show order, then the other settings.
  const rank = (it: MergeItem) => (it.key === "order" ? 0 : it.kind === "scene" ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b));
  return { items, conflicts: items.filter((x) => x.state === "conflict").length, unrelated: !hasBase };
}

// ---------------------------------------------------------------- applying

/** Asset ids mentioned anywhere in a value (scenes, announcements, standby…). */
export function assetRefs(v: unknown, ids: Set<string>, out = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    if (ids.has(v)) out.add(v);
  } else if (Array.isArray(v)) for (const x of v) assetRefs(x, ids, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) assetRefs(x, ids, out);
  return out;
}

export interface ReceiveInfo {
  version: number;
  via: "package" | "cloud";
  from: string;
  /** The incoming version's id and history (absent in packages made before version ids). */
  versionId?: string;
  ancestry?: string[];
}

const MAX_HISTORY = 200;
const MAX_BASES = 40;

/** Keep the newest bases (object keys keep insertion order). */
function trimBases(b: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const keys = Object.keys(b);
  return keys.length <= MAX_BASES ? b : Object.fromEntries(keys.slice(-MAX_BASES).map((k) => [k, b[k]]));
}

export interface MergeResult {
  project: Project;
  /** Incoming assets that are now in the show (their files need to be on this machine). */
  assets: Asset[];
}

/** The whole incoming show, keeping only this machine's own settings (output display, MIDI ports). */
export function replaceWithIncoming(local: Project | null, incoming: Project, info: ReceiveInfo): MergeResult {
  const p = structuredClone(incoming);
  if (local) {
    p.output = { ...p.output, monitorName: local.output.monitorName, fullscreen: local.output.fullscreen, windowWidth: local.output.windowWidth, windowHeight: local.output.windowHeight };
    if (p.io && local.io) {
      p.io.midi = { ...p.io.midi, enabled: local.io.midi.enabled, input: local.io.midi.input, output: local.io.midi.output };
      p.io.osc = { ...p.io.osc, enabled: local.io.osc.enabled };
    }
  }
  p.lineage = received(local, incoming, info);
  return { project: p, assets: p.assets };
}

function received(local: Project | null, incoming: Project, info: ReceiveInfo): ShowLineage {
  const showId = incoming.lineage?.showId ?? local?.lineage?.showId ?? "";
  const mine = local?.lineage?.showId === showId ? local.lineage : undefined;
  const history = [...new Set([...(mine?.history ?? []), ...(info.ancestry ?? [])])].slice(-MAX_HISTORY);
  const bases = { ...(mine?.bases ?? {}) };
  if (info.versionId) {
    delete bases[info.versionId];
    bases[info.versionId] = unitHashes(incoming);
  }
  return {
    showId,
    sent: mine?.sent,
    received: { version: info.version, id: info.versionId, at: Date.now(), via: info.via, from: info.from },
    history,
    bases: trimBases(bases),
  };
}

/** Merge per the plan's choices. `local` and `incoming` are not modified. */
export function applyMerge(local: Project, incoming: Project, plan: MergePlan, info: ReceiveInfo): MergeResult {
  const out = structuredClone(local);
  const inc = structuredClone(incoming);
  const choice = new Map(plan.items.map((it) => [it.key, it]));
  const takes = (key: string) => {
    const it = choice.get(key);
    return !!it && it.state !== "same" && (it.state === "incoming" || (it.state === "conflict" && it.choice === "incoming"));
  };

  // Show-wide settings.
  if (takes("name")) out.name = inc.name;
  if (takes("output")) out.output = { ...inc.output, monitorName: out.output.monitorName, fullscreen: out.output.fullscreen, windowWidth: out.output.windowWidth, windowHeight: out.output.windowHeight };
  if (takes("io") && inc.io) {
    const mine = out.io;
    out.io = structuredClone(inc.io);
    if (mine) {
      out.io.midi = { ...out.io.midi, enabled: mine.midi.enabled, input: mine.midi.input, output: mine.midi.output };
      out.io.osc = { ...out.io.osc, enabled: mine.osc.enabled };
    }
  }
  if (takes("timers")) out.timers = inc.timers;
  if (takes("announcements")) out.announcements = inc.announcements;
  if (takes("effectPresets")) out.effectPresets = inc.effectPresets;

  // Scenes: decide each one's content.
  const localById = new Map(out.scenes.map((s) => [s.id, s]));
  const incById = new Map(inc.scenes.map((s) => [s.id, s]));
  const final = new Map<string, Scene>();
  const copies = new Map<string, Scene>(); // local id → incoming copy placed after it
  const declined = new Set<string>(); // incoming scenes whose media is not wanted
  for (const id of new Set([...localById.keys(), ...incById.keys()])) {
    const it = choice.get(`scene:${id}`);
    const l = localById.get(id);
    const i = incById.get(id);
    if (!it || it.state === "same" || it.state === "local") {
      if (l) final.set(id, l);
      if (i && it?.state === "local") declined.add(id);
      continue;
    }
    if (it.state === "incoming") {
      if (i) final.set(id, i);
      continue;
    }
    // Conflict.
    if (it.choice === "incoming") {
      if (i) final.set(id, i);
    } else if (l) {
      final.set(id, l);
      if (it.choice === "both" && i) {
        const copy = cloneScene(i, 0);
        copy.name = `${i.name} (incoming v${info.version})`;
        copy.groupId = l.groupId ?? null;
        copies.set(id, copy);
      } else if (it.choice === "local") declined.add(id);
    } else if (i) declined.add(id);
  }

  // Running order: follow one side, and slot in the scenes only the other side has.
  const orderFrom = takes("order") ? inc : out;
  const other = orderFrom === inc ? out : inc;
  const seq = orderFrom.scenes.map((s) => s.id).filter((id) => final.has(id));
  const otherIds = other.scenes.map((s) => s.id);
  for (let k = 0; k < otherIds.length; k++) {
    const id = otherIds[k];
    if (!final.has(id) || seq.includes(id)) continue;
    // After the nearest preceding scene that is already placed.
    let at = 0;
    for (let j = k - 1; j >= 0; j--) {
      const pos = seq.indexOf(otherIds[j]);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    seq.splice(at, 0, id);
  }
  const groups = structuredClone(orderFrom.groups ?? []);
  const groupOf = new Map(orderFrom.scenes.map((s) => [s.id, s.groupId ?? null]));
  const otherGroupOf = new Map(other.scenes.map((s) => [s.id, s.groupId ?? null]));
  for (const g of other.groups ?? []) {
    // A group only the other side has, used by a scene that only it has: bring it along.
    const needed = seq.some((id) => !groupOf.has(id) && otherGroupOf.get(id) === g.id);
    if (needed && !groups.some((x) => x.id === g.id)) groups.push(structuredClone(g));
  }
  out.groups = groups;
  out.scenes = [];
  for (const id of seq) {
    const s = { ...final.get(id)!, groupId: groupOf.has(id) ? groupOf.get(id) : (otherGroupOf.get(id) ?? null) };
    out.scenes.push(s);
    const copy = copies.get(id);
    if (copy) out.scenes.push({ ...copy, groupId: s.groupId });
  }
  normalizeGroups(out);

  // Assets: incoming definitions win (new files, re-renders); media only wanted by declined scenes stays out.
  const incIds = new Set(inc.assets.map((a) => a.id));
  const wanted = new Set<string>();
  const unwanted = new Set<string>();
  for (const s of inc.scenes) assetRefs(s, incIds, declined.has(s.id) ? unwanted : wanted);
  assetRefs({ ...inc, scenes: [] }, incIds, wanted);
  assetRefs({ ...out, assets: [] }, incIds, wanted);
  const taken = inc.assets.filter((a) => wanted.has(a.id) || !unwanted.has(a.id));
  const byId = new Map(out.assets.map((a) => [a.id, a]));
  for (const a of taken) byId.set(a.id, a);
  out.assets = [...byId.values()];

  out.demoAdditions = [...new Set([...(out.demoAdditions ?? []), ...(inc.demoAdditions ?? [])])];
  out.lineage = received(local, incoming, info);
  return { project: out, assets: taken };
}

/**
 * Before sending a version out: a show id, a new version id and the next version number (at least `atLeast`);
 * this content is remembered as a base, so whatever comes back from it merges against it.
 */
export function stampOutgoing(p: Project, newId: (prefix: string) => string, atLeast = 0): { project: Project; version: number; versionId: string; ancestry: string[] } {
  const lin = p.lineage;
  const version = Math.max(lin?.sent ?? 0, lin?.received?.version ?? 0, atLeast - 1) + 1;
  const versionId = newId("ver");
  const ancestry = [...(lin?.history ?? []), versionId].slice(-MAX_HISTORY);
  const project: Project = {
    ...p,
    lineage: { ...lin, showId: lin?.showId || newId("show"), sent: version, history: ancestry, bases: trimBases({ ...(lin?.bases ?? {}), [versionId]: unitHashes(p) }) },
  };
  return { project, version, versionId, ancestry };
}

/** The show as it travels: without this machine's merge bases (the receiver keeps its own). */
export function outgoingShow(p: Project): Project {
  return p.lineage ? { ...p, lineage: { showId: p.lineage.showId, sent: p.lineage.sent, history: p.lineage.history } } : p;
}
