#!/usr/bin/env node
// Salvation Live Studio MCP server: lets an AI agent (Claude Code, Claude Desktop, any MCP client)
// control the running app. Tools come from src/agent/spec.ts; the operator window runs them.
//
//   agent ⇄ (stdio, MCP) ⇄ this server ⇄ (WebSocket 127.0.0.1:1431) ⇄ operator window
//
// The first server on the machine hosts the WebSocket; any further server (a second agent session)
// relays through it, and takes over hosting if the first one exits. Run: node mcp/server.ts

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket, WebSocketServer } from "ws";
import { AGENT_COMMANDS, AGENT_PORT, AGENT_SPEC_VERSION, type AgentHello, type AgentResponse, type CommandSpec } from "../src/agent/spec.ts";

const PORT = Number(process.env.SLS_AGENT_PORT) || AGENT_PORT;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(REPO, "public");
// Not tmpdir(): MCP clients may start servers with a trimmed environment, which moves TMPDIR.
const TOKEN_FILE = join(homedir(), ".salvation-live", `agent-${PORT}.token`);
const MAX_FILE = 512 * 1024 * 1024;

const log = (...a: unknown[]) => console.error("[sls-mcp]", ...a);

/** Pages allowed to connect as the app: the dev server and the desktop shell. */
const APP_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

const NOT_CONNECTED =
  "The Salvation Live Studio app is not connected. Start it (`pnpm dev` then open http://localhost:1430, or `pnpm tauri dev`) and check that the Agent badge in the top bar is not switched off. It connects within a few seconds.";

// ---------------------------------------------------------------- hub (host or relay)

type Pending = { resolve: (r: AgentResponse) => void; timer: ReturnType<typeof setTimeout> };
/** Which app instance this agent drives when several are connected (desktop app and a browser tab). */
type Prefer = "auto" | "desktop" | "browser";
interface Envelope {
  id: number;
  method: string;
  params: Record<string, unknown>;
  prefer?: Prefer;
}

let mode: "host" | "relay" | "starting" = "starting";
let wss: WebSocketServer | null = null;
let upstream: WebSocket | null = null;
let prefer: Prefer = (process.env.SLS_AGENT_APP as Prefer) || "auto";
const apps: { ws: WebSocket; hello: AgentHello | null; at: number }[] = [];
const pending = new Map<number, Pending>();
let nextId = 1;
let relayRejected = false;

/** Relay requests waiting for the app: our id → the relay and its own id. */
const routed = new Map<number, { ws: WebSocket; id: number }>();

/** The app to talk to: the preferred kind if connected, else the desktop app, else the newest. */
function activeApp(want: Prefer = "auto") {
  const open = apps.filter((a) => a.ws.readyState === WebSocket.OPEN && a.hello).sort((a, b) => b.at - a.at);
  const kind = (k: "desktop" | "browser") => open.find((a) => a.hello!.tauri === (k === "desktop"));
  // An explicit choice is strict: never drive the other window by surprise.
  if (want !== "auto") return kind(want) ?? null;
  return kind("desktop") ?? open[0] ?? null;
}

function listApps(want: Prefer) {
  const active = activeApp(want);
  return apps
    .filter((a) => a.hello && a.ws.readyState === WebSocket.OPEN)
    .map((a) => ({ kind: a.hello!.tauri ? "desktop" : "browser", dev: a.hello!.dev, show: a.hello!.project, specVersion: a.hello!.specVersion, connectedAt: new Date(a.at).toLocaleTimeString(), active: a === active }));
}

function startHub() {
  mode = "starting";
  const server = new WebSocketServer({ host: "127.0.0.1", port: PORT, maxPayload: MAX_FILE * 2 });
  let token = "";
  server.on("listening", () => {
    mode = "host";
    wss = server;
    token = randomBytes(24).toString("hex");
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    log(`hosting the agent bridge on ws://127.0.0.1:${PORT}`);
  });
  let failed = false;
  server.on("error", (e: NodeJS.ErrnoException) => {
    // ws reports a failed listen more than once; act on the first.
    if (failed) return;
    failed = true;
    server.close();
    if (e.code === "EADDRINUSE") connectRelay();
    else {
      log("bridge error:", e.message);
      setTimeout(startHub, 3000);
    }
  });
  server.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://x");
    const origin = req.headers.origin;
    if (url.pathname === "/relay") {
      // Other MCP servers prove they run as this user by reading the token file; web pages cannot.
      if (origin || !token || url.searchParams.get("token") !== token) return ws.close(4003, "forbidden");
      ws.on("message", (raw) => {
        let msg: Envelope;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        void forward(msg, ws);
      });
      return;
    }
    if (url.pathname !== "/app" || !origin || !APP_ORIGIN.test(origin)) return ws.close(4003, "forbidden");
    const entry = { ws, hello: null as AgentHello | null, at: Date.now() };
    apps.push(entry);
    ws.on("message", (raw) => {
      let msg: AgentResponse & Partial<AgentHello>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.hello === "app") {
        entry.hello = msg as AgentHello;
        log(`app connected: "${entry.hello.project}" (${entry.hello.tauri ? "desktop" : "browser"}${entry.hello.dev ? ", dev" : ""})`);
        if (entry.hello.specVersion !== AGENT_SPEC_VERSION) log(`app speaks agent spec v${entry.hello.specVersion}, server v${AGENT_SPEC_VERSION}: reload the app`);
        return;
      }
      settle(msg);
    });
    ws.on("close", () => {
      apps.splice(apps.indexOf(entry), 1);
      if (entry.hello) log("app disconnected");
    });
  });
}

function settle(msg: AgentResponse) {
  const r = routed.get(msg.id);
  if (r) {
    routed.delete(msg.id);
    if (r.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify({ ...msg, id: r.id }));
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  p.resolve(msg);
}

/** Host: hand a relay's request to the app (or answer bridge questions itself). */
async function forward(msg: Envelope, relay: WebSocket) {
  if (msg.method === "__apps") {
    await waitForApp(msg.prefer, 3000);
    return relay.send(JSON.stringify({ id: msg.id, result: listApps(msg.prefer ?? "auto") }));
  }
  const app = await waitForApp(msg.prefer);
  if (!app) return relay.send(JSON.stringify({ id: msg.id, error: !msg.prefer || msg.prefer === "auto" ? NOT_CONNECTED : `No ${msg.prefer} app window is connected (connections tool: use auto to take any).` }));
  const id = nextId++;
  routed.set(id, { ws: relay, id: msg.id });
  app.ws.send(JSON.stringify({ id, method: msg.method, params: msg.params }));
}

function connectRelay() {
  mode = "relay";
  let token = "";
  try {
    token = readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    /* host is still starting */
  }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay?token=${token}`);
  ws.on("open", () => {
    upstream = ws;
    relayRejected = false;
    log(`relaying through the agent bridge already running on port ${PORT}`);
  });
  ws.on("message", (raw) => {
    try {
      settle(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  ws.on("close", (code) => {
    if (upstream === ws) upstream = null;
    if (code === 4003 && !relayRejected) {
      relayRejected = true;
      log(`port ${PORT} is held by a bridge that refused this server (stale token in ${TOKEN_FILE}?); retrying`);
    }
    // The host went away: become the host, or relay through whoever did.
    setTimeout(startHub, (relayRejected ? 2000 : 300) + Math.random() * 700);
  });
  ws.on("error", () => {
    /* close follows */
  });
}

async function waitForApp(want: Prefer = "auto", ms = 6000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const a = activeApp(want);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 200));
  }
  return activeApp(want);
}

async function call(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<AgentResponse> {
  const id = nextId++;
  let send: ((s: string) => void) | null = null;
  if (mode === "host") {
    if (method === "__apps") {
      await waitForApp(prefer, 3000);
      return { id, result: listApps(prefer) };
    }
    const app = await waitForApp(prefer);
    if (!app) return { id, error: prefer === "auto" ? NOT_CONNECTED : `No ${prefer} app window is connected (connections tool: use auto to take any).` };
    send = (s) => app.ws.send(s);
  } else {
    const until = Date.now() + 3000;
    while (!upstream && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const up = upstream;
    if (!up) return { id, error: `${NOT_CONNECTED} (The agent bridge on port ${PORT} is not reachable.)` };
    send = (s) => up.send(s);
  }
  return new Promise((done) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      done({ id, error: `The app did not answer "${method}" within ${Math.round(timeoutMs / 1000)} s (is the operator window busy or hidden?)` });
    }, timeoutMs);
    pending.set(id, { resolve: done, timer });
    const env: Envelope = { id, method, params, prefer };
    send!(JSON.stringify(env));
  });
}

const appInfo = () => activeApp(prefer)?.hello ?? null;

// ---------------------------------------------------------------- tools

const commands = AGENT_COMMANDS as Record<string, CommandSpec>;

const TIMEOUTS: Record<string, number> = { asset_import: 180000, take: 20000, project: 60000, screenshot: 8000, package_export: 1800000, package_import: 1800000, cloud_push: 3600000, cloud_pull: 3600000, cloud_status: 30000, update_check: 45000, update_install: 1800000 };

/** Work that needs the local file system happens here, before / after the app runs the command. */
async function prepare(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === "asset_import" && typeof args.file === "string") {
    const file = args.file;
    if (!isAbsolute(file)) throw new Error("file must be an absolute path");
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
    const size = statSync(file).size;
    const rel = relative(PUBLIC_DIR, file);
    const inPublic = !rel.startsWith("..") && !isAbsolute(rel);
    const { file: _drop, ...rest } = args;
    if (inPublic && appInfo()?.dev) return { ...rest, url: "/" + rel.split(sep).join("/"), fileName: basename(file), name: args.name ?? basename(file) };
    if (size > MAX_FILE) throw new Error(`File is ${Math.round(size / 1e6)} MB; the limit is ${MAX_FILE / 1e6} MB`);
    return { ...rest, data: readFileSync(file).toString("base64"), fileName: basename(file) };
  }
  if (name === "project" && args.op === "import") {
    const file = String(args.file ?? "");
    if (!isAbsolute(file) || !existsSync(file)) throw new Error("import needs file: an absolute path to a show file (.json)");
    return { op: "import", json: readFileSync(file, "utf8") };
  }
  return args;
}

async function finish(name: string, args: Record<string, unknown>, result: unknown): Promise<unknown> {
  if (name === "project" && args.op === "export") {
    const json = (result as { json: unknown }).json;
    if (typeof args.file !== "string") return json;
    if (!isAbsolute(args.file)) throw new Error("file must be an absolute path");
    mkdirSync(dirname(args.file), { recursive: true });
    writeFileSync(args.file, JSON.stringify(json, null, 2));
    return { exported: args.file };
  }
  if (name === "status") {
    const apps = ((await call("__apps", {})).result ?? []) as { kind: string; specVersion: number; active: boolean }[];
    const active = apps.find((a) => a.active);
    return {
      bridge: {
        mode,
        port: PORT,
        specVersion: AGENT_SPEC_VERSION,
        app: active?.kind,
        otherApps: apps.length > 1 ? `${apps.length - 1} more app window(s) connected; see the connections tool` : undefined,
        warning: active && active.specVersion !== AGENT_SPEC_VERSION ? "The app and the MCP server were built from different versions; reload the app and restart the MCP server." : undefined,
      },
      ...(result as object),
    };
  }
  return result;
}

function text(v: unknown): string {
  const s = JSON.stringify(v, null, 1);
  return s && s.length > 60000 ? JSON.stringify(v) : (s ?? "null");
}

const mcp = new Server(
  { name: "salvation-live-studio", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "Controls Salvation Live Studio, the LED-wall show-control app, while it runs.",
      "Call `status` first. The PREVIEW is the rehearsal monitor; PROGRAM is the live wall the audience sees. Tools marked [LIVE] reach the audience or the lighting console: during a show, only use them when the operator asked.",
      "Build with scene_*/component_*/cue_* tools; `schema` shows the shapes and defaults; `get`/`patch`/`upsert`/`remove` reach any field. Edits change the show file and the preview at once; the live wall keeps its copy until `update_live_scene` or the next take.",
      "Check visual changes with `screenshot`.",
    ].join("\n"),
  },
);

/** Tools about the bridge itself, answered here rather than by the app. */
const LOCAL_TOOLS = {
  connections: {
    description:
      "App windows connected to the bridge (the desktop app and/or a browser tab on the dev server) and which one this agent controls. Pass `use` to choose: desktop, browser, or auto (desktop when it is connected, else the newest).",
    params: { type: "object", properties: { use: { enum: ["auto", "desktop", "browser"], description: "Which app to control from now on." } }, additionalProperties: false },
    readOnly: false,
  },
} satisfies Record<string, CommandSpec>;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries({ ...commands, ...LOCAL_TOOLS } as Record<string, CommandSpec>).map(([name, spec]) => ({
    name,
    description: `${spec.live ? "[LIVE] " : ""}${spec.description}`,
    inputSchema: spec.params as { type: "object"; properties?: Record<string, unknown> },
    annotations: { readOnlyHint: !!spec.readOnly, destructiveHint: !!spec.destructive, openWorldHint: !!spec.live },
  })),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (name === "connections") {
    if (args.use === "auto" || args.use === "desktop" || args.use === "browser") prefer = args.use;
    const res = await call("__apps", {});
    return { content: [{ type: "text", text: text({ controlling: prefer, bridge: mode, apps: res.result ?? [], error: res.error }) }] };
  }
  if (!commands[name]) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  try {
    const params = await prepare(name, args);
    const res = await call(name, params, TIMEOUTS[name]);
    if (res.error) return { content: [{ type: "text", text: res.error }], isError: true };
    const out = await finish(name, args, res.result);
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
    if (res.image) content.push({ type: "image", data: res.image.data, mimeType: res.image.mimeType });
    content.push({ type: "text", text: text(out) });
    return { content };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
});

startHub();
await mcp.connect(new StdioServerTransport());
log(`ready: ${Object.keys(commands).length + Object.keys(LOCAL_TOOLS).length} tools`);

const shutdown = () => {
  wss?.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
