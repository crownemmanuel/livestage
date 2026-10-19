// Scene groups: a group's scenes sit together in the running order and are numbered 1.1, 1.2…

import type { Project, Scene, SceneGroup } from "./types";

export type SceneListRow = { kind: "group"; group: SceneGroup; code: string; scenes: Scene[] } | { kind: "scene"; scene: Scene; code: string };

/** The scene list as shown: loose scenes and groups numbered 1, 2, 3…; a group's scenes 2.1, 2.2… */
export function sceneRows(p: Pick<Project, "scenes" | "groups">): SceneListRow[] {
  const groups = new Map((p.groups ?? []).map((g) => [g.id, g]));
  const rows: SceneListRow[] = [];
  let n = 0;
  for (const s of p.scenes) {
    const g = s.groupId ? groups.get(s.groupId) : undefined;
    const last = rows[rows.length - 1];
    if (g && last?.kind === "group" && last.group.id === g.id) {
      last.scenes.push(s);
      continue;
    }
    n++;
    rows.push(g ? { kind: "group", group: g, code: String(n), scenes: [s] } : { kind: "scene", scene: s, code: String(n) });
  }
  return rows;
}

/** Display number per scene id ("3" or "2.1"). */
export function sceneCodes(p: Pick<Project, "scenes" | "groups">): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of sceneRows(p)) {
    if (r.kind === "scene") m.set(r.scene.id, r.code);
    else r.scenes.forEach((s, i) => m.set(s.id, `${r.code}.${i + 1}`));
  }
  return m;
}

/**
 * Keep every group's scenes together (at the place of its first scene), drop groups with no
 * scenes and scene links to missing groups, then renumber the running order.
 */
export function normalizeGroups(p: Project) {
  const ids = new Set((p.groups ?? []).map((g) => g.id));
  for (const s of p.scenes) if (s.groupId && !ids.has(s.groupId)) s.groupId = null;
  const out: Scene[] = [];
  const placed = new Set<string>();
  for (const s of p.scenes) {
    if (!s.groupId) out.push(s);
    else if (!placed.has(s.groupId)) {
      placed.add(s.groupId);
      out.push(...p.scenes.filter((x) => x.groupId === s.groupId));
    }
  }
  p.scenes = out;
  p.groups = (p.groups ?? []).filter((g) => placed.has(g.id));
  p.scenes.forEach((s, i) => (s.number = i + 1));
}

/** The scene GO continues into after `sceneId`'s last cue, if its group flows. */
export function flowNext(p: Pick<Project, "scenes" | "groups">, sceneId: string): Scene | null {
  const i = p.scenes.findIndex((s) => s.id === sceneId);
  const s = p.scenes[i];
  const next = p.scenes[i + 1];
  if (!s?.groupId || !next || next.groupId !== s.groupId) return null;
  const g = p.groups?.find((x) => x.id === s.groupId);
  return g?.flow ? next : null;
}

/** First-run grouping of an older show: "Prologue 1…7" and "Scene 1" + "Scene 1b" style runs. */
export function autoGroup(p: Project, make: (name: string, color: SceneGroup["color"]) => SceneGroup) {
  const key = (s: Scene) => {
    const head = s.name.split(" · ")[0].trim();
    if (/^prologue\b/i.test(head)) return "Prologue";
    const m = /^scene\s+(\d+)[a-z]?$/i.exec(head);
    return m ? `Scene ${m[1]}` : null;
  };
  const colors: SceneGroup["color"][] = ["amber", "teal", "violet", "blue", "pink", "green", "orange", "red"];
  p.groups ??= [];
  let i = 0;
  while (i < p.scenes.length) {
    const k = key(p.scenes[i]);
    let j = i + 1;
    while (k && j < p.scenes.length && key(p.scenes[j]) === k && !p.scenes[j].groupId) j++;
    if (k && j - i >= 2 && !p.scenes[i].groupId) {
      const g = make(k, colors[p.groups.length % colors.length]);
      p.groups.push(g);
      for (let x = i; x < j; x++) p.scenes[x].groupId = g.id;
    }
    i = j;
  }
}
