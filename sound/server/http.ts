// HTTP + WebSocket on one port (1450): the operator screen at /, the backstage phone page at /backstage,
// a small JSON API (/api/…), photo uploads, and one WebSocket (/ws) carrying state and commands.
//
// The operator screen, its WebSocket role and the API answer only this computer unless the operator allows
// other computers (Settings). The backstage page and its WebSocket role answer the whole LAN, and can only
// assign mics and confirm scenes.

import { createReadStream, existsSync, statSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { renderSVG } from "uqr";
import { cloudJoinConfig, cloudReady } from "./cloud.ts";
import { UserError, type Engine, type Source } from "./engine.ts";
import { charById } from "./logic.ts";
import { SOUND_API_VERSION, SOUND_COMMANDS } from "./spec.ts";
import { PHOTO_DIR, writeAtomic } from "./store.ts";

/** Built screens: SOUND_DIST_DIR (e.g. inside an app bundle), else sound/dist next to this file. */
export const DIST_DIR = resolve(process.env.SOUND_DIST_DIR || fileURLToPath(new URL("../dist", import.meta.url)));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".ico": "image/x-icon",
};

type Role = "operator" | "backstage";

export interface LogBook {
  lines: { at: number; msg: string }[];
}

const isLoopback = (a: string | undefined) => !!a && (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1");

/** IPv4 addresses phones could reach, private ranges first. */
export function lanAddresses(): { address: string; name: string }[] {
  const out: { address: string; name: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const a = i.address;
      const rank = a.startsWith("192.168.") ? 0 : a.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : a.startsWith("169.254.") ? 9 : 5;
      out.push({ address: a, name, rank });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(({ address, name }) => ({ address, name }));
}

export function startHttp(engine: Engine, port: number, logBook: LogBook, log: (m: string) => void) {
  const operatorOk = (req: IncomingMessage) => isLoopback(req.socket.remoteAddress) || engine.settings.allowRemoteOperator;

  function links() {
    const lan = engine.rt.lan;
    const ip = engine.settings.sync.lanIp && lan.some((l) => l.address === engine.settings.sync.lanIp) ? engine.settings.sync.lanIp : lan[0]?.address ?? "localhost";
    const local = `http://${ip}:${port}/backstage`;
    const c = engine.settings.sync.cloud;
    let cloud: string | null = null;
    if (cloudReady(c)) {
      const hash = `#c=${Buffer.from(JSON.stringify(cloudJoinConfig(c, engine.show.showId))).toString("base64url")}`;
      cloud = (c.hostedUrl || local) + hash;
    }
    return { ip, local, cloud, hosted: !!c.hostedUrl, active: engine.settings.sync.mode === "cloud" ? cloud : local };
  }

  const fullState = () => ({ apiVersion: SOUND_API_VERSION, show: engine.show, runtime: engine.rt, pending: engine.pendingMics(), settings: engine.settings, links: links(), log: logBook.lines.slice(-80) });

  async function runCmd(cmd: string, args: Record<string, unknown>, source: Source) {
    try {
      const result = await engine.run(cmd, args, source);
      return { ok: true as const, result: result ?? null };
    } catch (e) {
      if (!(e instanceof UserError)) log(`${cmd} failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      log(`http ${req.method} ${req.url}: ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: "internal error" });
      else res.end();
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (path === "/api/ping") return json(res, 200, { app: "livestage-sound", apiVersion: SOUND_API_VERSION, version: engine.rt.appVersion });

    if (path.startsWith("/api/")) {
      if (!operatorOk(req)) return json(res, 403, { ok: false, error: "The Sound app's API only answers this computer" });
      // A web page elsewhere must not drive the desk through this computer's browser.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !engine.settings.allowRemoteOperator) return json(res, 403, { ok: false, error: "cross-origin request refused" });
      if (path === "/api/state" && req.method === "GET") return json(res, 200, fullState());
      if (path === "/api/status" && req.method === "GET") return json(res, 200, engine.status());
      if (path === "/api/commands" && req.method === "GET") return json(res, 200, SOUND_COMMANDS);
      if (path === "/api/qr" && req.method === "GET") {
        const text = url.searchParams.get("text") ?? "";
        if (!text || text.length > 2000) return json(res, 400, { ok: false, error: "text is required" });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        return res.end(renderSVG(text, { ecc: "M", border: 2, whiteColor: "#FFFFFF", blackColor: "#0B0D12" }));
      }
      const photo = /^\/api\/photo\/([\w-]+)$/.exec(path);
      if (photo && req.method === "POST") return uploadPhoto(req, res, photo[1]);
      if (req.method === "POST") {
        const body = (await readJson(req, 1_000_000)) as { cmd?: string; args?: Record<string, unknown> } | null;
        const cmd = path === "/api/cmd" ? body?.cmd ?? "" : decodeURIComponent(path.slice(5));
        const args = path === "/api/cmd" ? body?.args ?? {} : ((body ?? {}) as Record<string, unknown>);
        const source: Source = req.headers["x-sound-source"] === "mcp" ? "mcp" : "api";
        const r = await runCmd(cmd, args, source);
        return json(res, r.ok ? 200 : 400, r);
      }
      return json(res, 404, { ok: false, error: "not found" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, error: "method not allowed" });

    if (path.startsWith("/photos/")) {
      const file = path.slice(8);
      if (!/^[\w.-]+$/.test(file)) return notFound(res);
      return sendFile(res, join(PHOTO_DIR, file), "public, max-age=31536000, immutable");
    }
    if (path === "/backstage" || path === "/backstage/" || path === "/backstage.html") return sendFile(res, join(DIST_DIR, "backstage.html"), "no-cache");
    if (path === "/" || path === "/index.html") {
      if (!operatorOk(req)) {
        res.writeHead(302, { Location: "/backstage" });
        return res.end();
      }
      return sendFile(res, join(DIST_DIR, "index.html"), "no-cache");
    }
    const file = normalize(join(DIST_DIR, decodeURIComponent(path)));
    if (!file.startsWith(DIST_DIR + sep)) return notFound(res);
    return sendFile(res, file, path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  }

  async function uploadPhoto(req: IncomingMessage, res: ServerResponse, id: string) {
    const c = charById(engine.show, id);
    if (!c) return json(res, 404, { ok: false, error: "no such character" });
    const body = (await readJson(req, 12_000_000)) as { data?: string; thumb?: string; type?: string } | null;
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body?.data ?? "");
    if (!m) return json(res, 400, { ok: false, error: "data must be an image data URL (jpeg, png or webp)" });
    const file = `${id}-${Date.now().toString(36)}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
    writeAtomic(join(PHOTO_DIR, file), Buffer.from(m[2], "base64"));
    const old = c.photo;
    const r = await runCmd("character.photo", { id, photo: file, thumb: body?.thumb ?? null }, "api");
    if (r.ok && old && old !== file) {
      try {
        unlinkSync(join(PHOTO_DIR, old));
      } catch {
        /* already gone */
      }
    }
    return json(res, r.ok ? 200 : 400, { ...r, photo: file });
  }

  // ---------------------------------------------------------------- WebSocket

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
  const clients = new Map<WebSocket, Role>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") return socket.destroy();
    const role: Role = url.searchParams.get("role") === "operator" ? "operator" : "backstage";
    if (role === "operator" && !operatorOk(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, role);
      const alive = { ok: true };
      ws.on("pong", () => (alive.ok = true));
      const ping = setInterval(() => {
        if (!alive.ok) return ws.terminate();
        alive.ok = false;
        ws.ping();
      }, 10000);
      ws.on("close", () => {
        clients.delete(ws);
        clearInterval(ping);
      });
      ws.on("error", () => {});
      ws.on("message", async (raw) => {
        let m: { t?: string; id?: number; cmd?: string; args?: Record<string, unknown> };
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.t !== "cmd" || typeof m.cmd !== "string") return;
        const r = await runCmd(m.cmd, m.args ?? {}, role === "operator" ? "ui" : "backstage");
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "res", id: m.id, ...r }));
      });
      if (role === "operator") ws.send(JSON.stringify({ t: "state", ...fullState() }));
      else ws.send(JSON.stringify({ t: "backstage", view: engine.backstage() }));
    });
  });

  let lastBackstage = "";
  /** Engine changed: tell every screen what it needs. */
  function broadcast(what: { show: boolean; settings: boolean; runtime: boolean }) {
    const op: Record<string, unknown> = { t: "patch" };
    if (what.show) op.show = engine.show;
    if (what.settings) {
      op.settings = engine.settings;
      op.links = links();
    }
    if (what.runtime || what.show) {
      op.runtime = engine.rt;
      op.pending = engine.pendingMics();
      op.links = links();
    }
    const opMsg = JSON.stringify(op);
    let bsMsg: string | null = null;
    if (what.show || what.runtime) {
      const view = JSON.stringify(engine.backstage());
      if (view !== lastBackstage) {
        lastBackstage = view;
        bsMsg = `{"t":"backstage","view":${view}}`;
      }
    }
    for (const [ws, role] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (role === "operator") ws.send(opMsg);
      else if (bsMsg) ws.send(bsMsg);
    }
  }

  function sendLog(line: { at: number; msg: string }) {
    const msg = JSON.stringify({ t: "log", line });
    for (const [ws, role] of clients) if (role === "operator" && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }

  server.listen(port, "0.0.0.0", () => log(`http://localhost:${port} (operator) · backstage at ${links().local}`));
  server.on("error", (e: NodeJS.ErrnoException) => {
    log(`http: ${e.message}`);
    // Port taken at start: nothing can work, so say so and stop (an embedding shell sees the exit).
    if (e.code === "EADDRINUSE" && !server.listening) process.exit(2);
  });

  return {
    server,
    broadcast,
    sendLog,
    links,
    close() {
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
      server.close();
    },
  };
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

function sendFile(res: ServerResponse, file: string, cache: string) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (file.endsWith(".html")) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("The Sound app's screens are not built yet: run `pnpm sound:build` (or start it with `pnpm sound`).");
    }
    return notFound(res);
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": cache });
  createReadStream(file).pipe(res);
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new UserError("request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return ok(null);
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new UserError("body must be JSON"));
      }
    });
    req.on("error", fail);
  });
}
