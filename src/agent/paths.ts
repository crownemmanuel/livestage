// Path addressing for agent reads and edits: "project/scenes/<id>/components/<id>/params/intensity".
// Array elements match by id, then exact name, then index; "-" is the end of a list (append).

import { sceneCodes } from "@/core/groups";
import type { Project, Scene } from "@/core/types";
import { useIo } from "@/engine/io";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";

export type Root = "project" | "show" | "io" | "ui";

export function splitPath(path: string): { root: Root; segs: string[] } {
  const segs = path.split("/").filter(Boolean);
  const first = segs[0] as Root | undefined;
  if (first === "project" || first === "show" || first === "io" || first === "ui") return { root: first, segs: segs.slice(1) };
  // A bare path means the show file.
  return { root: "project", segs };
}

export function rootValue(root: Root): unknown {
  switch (root) {
    case "project":
      return useProject.getState().project;
    case "show":
      return useShow.getState();
    case "io":
      return useIo.getState();
    case "ui": {
      const p = useProject.getState();
      const s = useShow.getState();
      return { mode: p.mode, selectedSceneId: p.selectedSceneId, selectedComponentId: p.selectedComponentId, solo: s.solo, hidden: s.hidden, lionControl: s.lionControl, nextTransition: s.nextTransition };
    }
  }
}

/** Find a scene by id, running-order code ("1.2"), number or exact name. */
export function findScene(p: Pick<Project, "scenes" | "groups">, ref: string): Scene | undefined {
  const r = String(ref).trim();
  const byId = p.scenes.find((s) => s.id === r);
  if (byId) return byId;
  const codes = sceneCodes(p);
  const byCode = p.scenes.find((s) => codes.get(s.id) === r);
  if (byCode) return byCode;
  if (/^\d+$/.test(r)) {
    const byNum = p.scenes.find((s) => s.number === Number(r));
    if (byNum) return byNum;
  }
  const lower = r.toLowerCase();
  return p.scenes.find((s) => s.name === r) ?? p.scenes.find((s) => s.name.toLowerCase() === lower);
}

function indexIn(list: unknown[], seg: string, parentKey: string | undefined, root: unknown): number {
  if (seg === "-") return list.length;
  const i = list.findIndex((x) => isObj(x) && x.id === seg);
  if (i >= 0) return i;
  if (parentKey === "scenes" && isObj(root) && Array.isArray(root.scenes)) {
    const s = findScene(root as unknown as Project, seg);
    if (s) return list.indexOf(s);
  }
  const byName = list.findIndex((x) => isObj(x) && x.name === seg);
  if (byName >= 0) return byName;
  if (/^\d+$/.test(seg)) return Number(seg);
  return -1;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Walk `segs` from `root`. Returns the container and key of the last segment for edits. */
export function resolve(root: unknown, segs: string[]): { parent: unknown; key: string | number; value: unknown } {
  let cur: unknown = root;
  let parent: unknown = undefined;
  let key: string | number = "";
  let prevKey: string | undefined;
  segs.forEach((seg, n) => {
    parent = cur;
    if (Array.isArray(cur)) {
      const i = indexIn(cur, seg, prevKey, root);
      if (i < 0 || (i >= cur.length && seg !== "-")) throw new Error(`No "${seg}" in ${segs.slice(0, n).join("/") || "root"} (a list of ${cur.length})`);
      key = i;
      cur = cur[i];
    } else if (isObj(cur)) {
      key = seg;
      cur = cur[seg];
    } else {
      throw new Error(`Cannot go into "${seg}": ${segs.slice(0, n).join("/") || "root"} is ${cur === undefined ? "missing" : typeof cur}`);
    }
    prevKey = seg;
  });
  return { parent, key, value: cur };
}

export function getPath(path: string): unknown {
  const { root, segs } = splitPath(path);
  return resolve(rootValue(root), segs).value;
}

/** Deep merge `patch` into `target` in place: objects merge, arrays and values replace. */
export function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(target[k])) deepMerge(target[k] as Record<string, unknown>, v);
    else target[k] = v === undefined ? target[k] : structuredClone(v);
  }
  return target;
}

export type PatchOp = { op: "set" | "merge" | "insert" | "remove"; path: string; value?: unknown };

/** Apply path edits to a draft of the show file. Returns the previous values (for undo). */
export function applyOps(draft: Project, ops: PatchOp[]): { path: string; before: unknown }[] {
  const out: { path: string; before: unknown }[] = [];
  for (const o of ops) {
    const { root, segs } = splitPath(o.path);
    if (root !== "project") throw new Error(`Only the show file (project/...) can be edited; use the dedicated tools for ${root}`);
    if (!segs.length) throw new Error("Path must point inside the show file");
    const { parent, key, value } = resolve(draft, segs);
    out.push({ path: o.path, before: value === undefined ? null : structuredClone(value) });
    switch (o.op) {
      case "set":
        if (Array.isArray(parent)) parent[key as number] = structuredClone(o.value);
        else (parent as Record<string, unknown>)[key] = structuredClone(o.value);
        break;
      case "merge":
        if (!isObj(value) || !isObj(o.value)) throw new Error(`merge needs an object at ${o.path} and an object value`);
        deepMerge(value, o.value);
        break;
      case "insert":
        if (!Array.isArray(parent)) throw new Error(`insert needs a list position at ${o.path}`);
        parent.splice(key as number, 0, structuredClone(o.value));
        break;
      case "remove":
        if (Array.isArray(parent)) parent.splice(key as number, 1);
        else delete (parent as Record<string, unknown>)[key];
        break;
      default:
        throw new Error(`Unknown op ${(o as PatchOp).op}`);
    }
  }
  return out;
}

/** JSON-safe copy limited to `depth` levels; data URLs, functions and huge strings are summarised. */
export function summarize(v: unknown, depth = 6, seen = new WeakSet<object>()): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === "function") return undefined;
  if (typeof v === "string") {
    if (v.startsWith("data:")) return `[data url, ${v.length} chars]`;
    return v.length > 4000 ? `${v.slice(0, 4000)}… [${v.length} chars]` : v;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v !== "object") return v;
  if (seen.has(v)) return "[circular]";
  if (v instanceof Set) return summarize([...v], depth, seen);
  if (v instanceof Map) return summarize(Object.fromEntries(v), depth, seen);
  if (typeof (v as { nodeType?: unknown }).nodeType === "number") return "[DOM node]";
  if (depth <= 0) return Array.isArray(v) ? `[list of ${v.length}]` : `[object: ${Object.keys(v).slice(0, 12).join(", ")}${Object.keys(v).length > 12 ? ", …" : ""}]`;
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => summarize(x, depth - 1, seen) ?? null);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "thumbnail" && typeof x === "string") {
      out[k] = "[thumbnail]";
      continue;
    }
    const s = summarize(x, depth - 1, seen);
    if (s !== undefined) out[k] = s;
  }
  return out;
}
