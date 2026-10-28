// Import scenes from LiveStage: its show file on this computer, a show file or .slshow package anywhere,
// an uploaded show file, or the running app over its agent bridge (read-only list_scenes / status only).
// Re-importing merges: scenes that still exist keep their cast and cues, new ones are added, ones that
// are gone are flagged "removed" (kept with their cues until the operator deletes them).

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { liveStageCodes } from "./logic.ts";
import type { SoundScene, SoundShow } from "./model.ts";

export interface IncomingScene {
  id: string;
  code: string;
  name: string;
  order: number;
  group: { id: string; name: string } | null;
}
export interface Incoming {
  showName: string;
  via: string;
  scenes: IncomingScene[];
}

const BRIDGE_PORT = Number(process.env.SLS_AGENT_PORT) || 1431;

export function liveStageDataDir() {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "org.salvation.livestudio");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "org.salvation.livestudio");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "org.salvation.livestudio");
}
const tokenFile = () => join(homedir(), ".salvation-live", `agent-${BRIDGE_PORT}.token`);

/** A LiveStage show file (project.json, show.json in a package, an exported show) → scenes. */
export function parseLiveStageShow(raw: unknown, via: string): Incoming {
  const p = raw as { name?: unknown; scenes?: unknown; groups?: unknown };
  if (!p || typeof p !== "object" || !Array.isArray(p.scenes)) throw new Error("That is not a LiveStage show file (no scenes)");
  const scenes = (p.scenes as { id?: unknown; name?: unknown; groupId?: unknown; number?: unknown }[]).filter((s) => typeof s?.id === "string");
  const groups = new Map(((Array.isArray(p.groups) ? p.groups : []) as { id: string; name: string }[]).filter((g) => typeof g?.id === "string").map((g) => [g.id, g]));
  const codes = liveStageCodes(scenes.map((s) => ({ id: s.id as string, groupId: typeof s.groupId === "string" ? s.groupId : null })), new Set(groups.keys()));
  return {
    showName: typeof p.name === "string" ? p.name : "LiveStage show",
    via,
    scenes: scenes.map((s, i) => {
      const g = typeof s.groupId === "string" ? groups.get(s.groupId) : undefined;
      return { id: s.id as string, code: codes.get(s.id as string) ?? String(i + 1), name: typeof s.name === "string" ? s.name : "Scene", order: i + 1, group: g ? { id: g.id, name: g.name } : null };
    }),
  };
}

export function readShowPath(path: string): Incoming {
  if (!existsSync(path)) throw new Error(`Nothing at ${path}`);
  let file = path;
  if (statSync(path).isDirectory()) {
    // A show package (<name>.slshow/show.json) or LiveStage's data folder (project.json).
    file = existsSync(join(path, "show.json")) ? join(path, "show.json") : join(path, "project.json");
    if (!existsSync(file)) throw new Error("That folder has no show.json (show package) or project.json (LiveStage data folder)");
  }
  return parseLiveStageShow(JSON.parse(readFileSync(file, "utf8")), file);
}

/** Ask the running LiveStage for its running order, through the agent bridge (read-only commands only). */
export async function fromBridge(): Promise<Incoming> {
  let token = "";
  try {
    token = readFileSync(tokenFile(), "utf8").trim();
  } catch {
    throw new Error("LiveStage's agent bridge is not running (start LiveStage's MCP server, or import its show file instead)");
  }
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/relay?token=${token}`);
  const replies = new Map<number, (r: { result?: unknown; error?: string }) => void>();
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(String(raw)) as { id: number; result?: unknown; error?: string };
      replies.get(m.id)?.(m);
    } catch {
      /* not for us */
    }
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("LiveStage's agent bridge did not answer")), 4000);
    ws.once("open", () => {
      clearTimeout(t);
      res();
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      rej(new Error(`LiveStage's agent bridge is not reachable on port ${BRIDGE_PORT} (${e.message})`));
    });
    ws.once("close", (code) => {
      clearTimeout(t);
      rej(new Error(code === 4003 ? "LiveStage's agent bridge refused the connection (stale token)" : "LiveStage's agent bridge closed the connection"));
    });
  });
  let next = 1;
  // Only ever read-only commands here.
  const call = (method: "list_scenes" | "status") =>
    new Promise<unknown>((res, rej) => {
      const id = next++;
      const t = setTimeout(() => rej(new Error(`LiveStage did not answer ${method} (is the app open?)`)), 9000);
      replies.set(id, (r) => {
        clearTimeout(t);
        if (r.error) rej(new Error(r.error));
        else res(r.result);
      });
      ws.send(JSON.stringify({ id, method, params: {} }));
    });
  try {
    const rows = (await call("list_scenes")) as ({ id: string; code?: string; name: string } | { group: { id: string; name: string }; scenes: { id: string; code?: string; name: string }[] })[];
    let showName = "LiveStage show";
    try {
      const st = (await call("status")) as { app?: { show?: string } };
      if (st?.app?.show) showName = st.app.show;
    } catch {
      /* the name is a nicety */
    }
    const scenes: IncomingScene[] = [];
    for (const r of rows) {
      if ("group" in r) for (const s of r.scenes) scenes.push({ id: s.id, code: s.code ?? String(scenes.length + 1), name: s.name, order: scenes.length + 1, group: { id: r.group.id, name: r.group.name } });
      else scenes.push({ id: r.id, code: r.code ?? String(scenes.length + 1), name: r.name, order: scenes.length + 1, group: null });
    }
    return { showName, via: "LiveStage (running)", scenes };
  } finally {
    ws.close();
  }
}

/** Where a show can come from on this computer, for the import dialog. */
export async function importSources() {
  const local = join(liveStageDataDir(), "project.json");
  let bridge = false;
  try {
    readFileSync(tokenFile());
    bridge = true;
  } catch {
    /* no bridge */
  }
  return {
    local: existsSync(local) ? { path: local, modified: statSync(local).mtimeMs } : null,
    bridge,
  };
}

export interface MergeReport {
  added: string[];
  updated: string[];
  removed: string[];
  kept: number;
  showName: string;
}

/** Merge an import into a show (a new object; the caller swaps it in). */
export function mergeImport(show: SoundShow, inc: Incoming): { show: SoundShow; report: MergeReport } {
  const next: SoundShow = structuredClone(show);
  const report: MergeReport = { added: [], updated: [], removed: [], kept: 0, showName: inc.showName };
  const firstImport = !next.scenes.some((s) => s.source === "livestage");
  // The demo scenes make way for the real show; characters stay (they may well be the real cast).
  if (firstImport) next.scenes = next.scenes.filter((s) => s.source !== "demo");
  const byId = new Map(next.scenes.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: SoundScene[] = [];
  for (const s of inc.scenes) {
    seen.add(s.id);
    const cur = byId.get(s.id);
    if (cur) {
      if (cur.name !== s.name || cur.code !== s.code || cur.removed) report.updated.push(s.code);
      Object.assign(cur, { code: s.code, name: s.name, group: s.group, source: "livestage", removed: false });
      report.kept++;
      out.push(cur);
    } else {
      const sc: SoundScene = { id: s.id, code: s.code, name: s.name, order: 0, group: s.group, source: "livestage", removed: false, cast: [], mics: {}, micsAt: 0, cues: [], checked: null };
      report.added.push(s.code);
      out.push(sc);
    }
  }
  // Scenes LiveStage no longer has, and scenes made here: kept after the scene they followed.
  const old = [...next.scenes].sort((a, b) => a.order - b.order);
  for (let i = 0; i < old.length; i++) {
    const s = old[i];
    if (seen.has(s.id)) continue;
    if (s.source === "livestage" && !s.removed) {
      s.removed = true;
      report.removed.push(s.code);
    }
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(old[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, s);
  }
  out.forEach((s, i) => (s.order = i + 1));
  next.scenes = out;
  if (!next.source || next.name === "Demo show") next.name = inc.showName;
  next.source = { kind: "livestage", showName: inc.showName, via: inc.via, importedAt: Date.now() };
  next.updatedAt = Date.now();
  return { show: next, report };
}
