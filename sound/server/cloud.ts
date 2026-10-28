// Cloud backstage (Firebase Realtime Database over REST + server-sent events, no SDK). For when the
// building's Wi-Fi is down and the crew's phones are on mobile data.
//
//   /sound/<showId>/<joinKey>/owner      uid of this Sound app's anonymous account (written once)
//   /sound/<showId>/<joinKey>/show       what the backstage page shows (written by the owner only)
//   /sound/<showId>/<joinKey>/backstage  assign/<scene>/<character> = mic, stamp/<scene> = ms, checked/<scene> = {by, at, sig}
//
// The join key is the secret: the rules (firebase/database.rules.json) only open a show to someone who
// knows its path, and nobody can list /sound. Newer change wins per scene (stamp vs. the scene's micsAt).

import type { Engine } from "./engine.ts";
import { backstageView, effectiveMics, sceneById } from "./logic.ts";
import type { CloudSettings } from "./model.ts";
import { saveSettings } from "./store.ts";

interface Remote {
  assign?: Record<string, Record<string, number>>;
  stamp?: Record<string, number>;
  checked?: Record<string, { by: string; at: number; sig?: string }>;
}

export function cloudReady(c: CloudSettings) {
  return !!(c.apiKey && c.projectId && (c.databaseURL || c.emulatorHost) && c.joinKey);
}

/** Database base URL and the query suffix the emulator needs (?ns=…). */
export function dbEndpoint(c: CloudSettings): { base: string; ns: string } {
  const ns = c.databaseURL ? new URL(c.databaseURL).hostname.split(".")[0] : `${c.projectId}-default-rtdb`;
  if (c.emulatorHost) return { base: `http://${c.emulatorHost}:9000`, ns: `&ns=${encodeURIComponent(ns)}` };
  return { base: c.databaseURL.replace(/\/$/, ""), ns: "" };
}

export function authEndpoints(c: CloudSettings) {
  const pre = c.emulatorHost ? `http://${c.emulatorHost}:9099/` : "https://";
  return { signUp: `${pre}identitytoolkit.googleapis.com/v1/accounts:signUp?key=${c.apiKey}`, refresh: `${pre}securetoken.googleapis.com/v1/token?key=${c.apiKey}` };
}

/** What the QR code / link carries for the hosted backstage page (in the #hash, never sent to a web server). */
export function cloudJoinConfig(c: CloudSettings, showId: string) {
  const ep = dbEndpoint(c);
  return { v: 1, db: ep.base, ns: ep.ns ? ep.ns.slice(4) : "", key: c.apiKey, emu: c.emulatorHost || undefined, show: showId, join: c.joinKey };
}

export class CloudSync {
  private engine: Engine;
  private log: (m: string) => void;
  private idToken = "";
  private tokenAt = 0;
  private abort: AbortController | null = null;
  private gen = 0;
  private remote: Remote = {};
  private lastShowJson = "";
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private running = false;
  private cfgKey = "";

  constructor(engine: Engine, log: (m: string) => void) {
    this.engine = engine;
    this.log = log;
  }

  private get cfg() {
    return this.engine.settings.sync.cloud;
  }
  private get base() {
    return `sound/${this.engine.show.showId}/${this.cfg.joinKey}`;
  }

  /** Call after settings change: starts, stops or restarts as needed. */
  reconfigure() {
    const on = this.engine.settings.sync.mode === "cloud" && cloudReady(this.cfg);
    const key = on ? JSON.stringify([this.cfg.apiKey, this.cfg.projectId, this.cfg.databaseURL, this.cfg.emulatorHost, this.cfg.joinKey, this.engine.show.showId]) : "";
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this.stop();
    if (on) void this.start();
    else this.engine.setCloudStatus(this.engine.settings.sync.mode === "cloud" ? "error" : "off", this.engine.settings.sync.mode === "cloud" ? "Enter the Firebase keys in Build → Backstage" : null);
  }

  stop() {
    this.gen++;
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.lastShowJson = "";
    this.remote = {};
  }

  private async start() {
    const g = ++this.gen;
    this.running = true;
    this.engine.setCloudStatus("connecting", null);
    try {
      await this.token();
      if (g !== this.gen) return;
      // Claim the show path (the rules let only the first account write `show`).
      await this.req("PUT", `${this.base}/owner`, this.cfg.uid);
      await this.publishShow(true);
      this.retry = 0;
      void this.listen(g);
    } catch (e) {
      if (g !== this.gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.engine.setCloudStatus("error", /permission|401|403/i.test(msg) ? "The database refused this show (another Sound app owns this join key, or the rules are not published)" : msg);
      this.retryLater(g);
    }
  }

  private retryLater(g: number) {
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    setTimeout(() => {
      if (g === this.gen && this.running) void this.start();
    }, delay);
  }

  /** A fresh ID token from the anonymous account (signed up once, then refreshed). */
  private async token(): Promise<string> {
    if (this.idToken && Date.now() - this.tokenAt < 50 * 60 * 1000) return this.idToken;
    const c = this.cfg;
    const ep = authEndpoints(c);
    if (c.refreshToken) {
      const r = await fetch(ep.refresh, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(c.refreshToken)}` });
      if (r.ok) {
        const j = (await r.json()) as { id_token: string; refresh_token: string; user_id: string };
        this.idToken = j.id_token;
        this.tokenAt = Date.now();
        if (j.refresh_token !== c.refreshToken || j.user_id !== c.uid) {
          c.refreshToken = j.refresh_token;
          c.uid = j.user_id;
          saveSettings(this.engine.settings);
        }
        return this.idToken;
      }
      this.log(`cloud: token refresh failed (${r.status}); signing in again`);
    }
    const r = await fetch(ep.signUp, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error(`Anonymous sign-in failed (${r.status}): enable Anonymous sign-in in Firebase Authentication. ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { idToken: string; refreshToken: string; localId: string };
    this.idToken = j.idToken;
    this.tokenAt = Date.now();
    c.refreshToken = j.refreshToken;
    c.uid = j.localId;
    saveSettings(this.engine.settings);
    return this.idToken;
  }

  private url(path: string, token: string) {
    const ep = dbEndpoint(this.cfg);
    return `${ep.base}/${path}.json?auth=${encodeURIComponent(token)}${ep.ns}`;
  }

  private async req(method: "PUT" | "PATCH" | "GET", path: string, body?: unknown): Promise<unknown> {
    const t = await this.token();
    const r = await fetch(this.url(path, t), { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path.split("/").slice(3).join("/") || "show"}: ${r.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Called on every engine change: re-publish what the backstage page shows (debounced). */
  changed() {
    if (!this.running || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.publishShow(false).catch((e) => this.log(`cloud publish: ${e instanceof Error ? e.message : e}`));
      void this.reconcile().catch((e) => this.log(`cloud sync: ${e instanceof Error ? e.message : e}`));
    }, 400);
  }

  private async publishShow(force: boolean) {
    const v = backstageView(this.engine.show, this.engine.rt);
    const show = {
      name: v.showName,
      micCount: v.micCount,
      activeSceneId: v.activeSceneId ?? "",
      nextSceneId: v.nextSceneId ?? "",
      scenes: v.scenes.map((s) => ({ id: s.id, code: s.code, name: s.name, cast: s.cast })),
      characters: Object.fromEntries(v.characters.map((c) => [c.id, { name: c.name, gender: c.gender, palette: c.palette, defaultMic: c.defaultMic ?? 0, thumb: c.thumb ?? "" }])),
    };
    const json = JSON.stringify(show);
    if (!force && json === this.lastShowJson) return;
    await this.req("PUT", `${this.base}/show`, { ...show, updatedAt: Date.now() });
    this.lastShowJson = json;
  }

  /** Newer side wins per scene: phones' changes come in, the operator's go out. */
  private async reconcile() {
    if (!this.running) return;
    const show = this.engine.show;
    const out: Record<string, unknown> = {};
    for (const sc of show.scenes) {
      if (sc.removed || !sc.cast.length) continue;
      const mine = effectiveMics(show, sc);
      const theirs = this.remote.assign?.[sc.id] ?? {};
      const theirAt = this.remote.stamp?.[sc.id] ?? 0;
      const same = Object.keys(mine).length === Object.keys(theirs).length && Object.entries(mine).every(([k, v]) => theirs[k] === v);
      if (!same && theirAt > sc.micsAt) {
        for (const [charId, mic] of Object.entries(theirs)) {
          if (!sc.cast.includes(charId) || typeof mic !== "number") continue;
          try {
            this.engine.run("assign", { scene: sc.id, character: charId, mic, at: theirAt }, "cloud");
          } catch (e) {
            this.log(`cloud assign: ${e instanceof Error ? e.message : e}`);
          }
        }
      } else if (!same || (sc.micsAt > theirAt && sc.micsAt > 0)) {
        out[`assign/${sc.id}`] = mine;
        out[`stamp/${sc.id}`] = Math.max(sc.micsAt, 1);
      }
      const rc = this.remote.checked?.[sc.id];
      // A check counts only if it is newer than the last mic change (a change clears it).
      if (rc && typeof rc.at === "number" && rc.at > Math.max(sc.checked?.at ?? 0, sc.micsAt)) this.engine.run("scene.confirm", { scene: sc.id, by: rc.by, at: rc.at, ...(typeof rc.sig === "string" ? { sig: rc.sig } : {}) }, "cloud");
      else if (sc.checked && sc.checked.at > (rc?.at ?? 0)) out[`checked/${sc.id}`] = sc.checked;
      else if (!sc.checked && rc && sc.micsAt > rc.at) out[`checked/${sc.id}`] = null;
    }
    if (Object.keys(out).length) {
      await this.req("PATCH", `${this.base}/backstage`, out);
      // Keep our mirror in step so the echo does not look like news.
      for (const [k, v] of Object.entries(out)) setPath(this.remote as Record<string, unknown>, k.split("/"), v);
    }
  }

  /** Stream the backstage subtree (server-sent events) and fold every put / patch into the mirror. */
  private async listen(g: number) {
    while (g === this.gen) {
      const ctl = new AbortController();
      this.abort = ctl;
      try {
        const t = await this.token();
        const r = await fetch(this.url(`${this.base}/backstage`, t), { headers: { Accept: "text/event-stream" }, signal: ctl.signal });
        if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
        this.engine.setCloudStatus("live", null);
        this.retry = 0;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: ?(.*)$/m.exec(block)?.[1]?.trim();
            const data = /^data: ?(.*)$/m.exec(block)?.[1] ?? "null";
            if (ev === "put" || ev === "patch") this.onEvent(ev, JSON.parse(data) as { path: string; data: unknown });
            else if (ev === "auth_revoked") {
              this.idToken = "";
              throw new Error("token expired");
            } else if (ev === "cancel") throw new Error("the database closed the stream (rules?)");
          }
          // ID tokens last an hour: reconnect with a fresh one before that.
          if (Date.now() - this.tokenAt > 55 * 60 * 1000) {
            this.idToken = "";
            break;
          }
        }
      } catch (e) {
        if (g !== this.gen) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "token expired") this.engine.setCloudStatus("error", `Stream lost: ${msg}`);
      }
      if (g !== this.gen) return;
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** this.retry++)));
    }
  }

  private onEvent(kind: "put" | "patch", m: { path: string; data: unknown }) {
    const parts = m.path.split("/").filter(Boolean);
    if (kind === "put") {
      if (!parts.length) this.remote = (m.data as Remote) ?? {};
      else setPath(this.remote as Record<string, unknown>, parts, m.data);
    } else {
      for (const [k, v] of Object.entries((m.data as Record<string, unknown>) ?? {})) setPath(this.remote as Record<string, unknown>, [...parts, ...k.split("/").filter(Boolean)], v);
    }
    void this.reconcile().catch((e) => this.log(`cloud sync: ${e instanceof Error ? e.message : e}`));
  }

  /** For tests and the status line: is this scene in step with the cloud? */
  inStep(sceneId: string) {
    const sc = sceneById(this.engine.show, sceneId);
    if (!sc) return false;
    const mine = effectiveMics(this.engine.show, sc);
    const theirs = this.remote.assign?.[sceneId] ?? {};
    return Object.entries(mine).every(([k, v]) => theirs[k] === v);
  }
}

function setPath(root: Record<string, unknown>, parts: string[], value: unknown) {
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === null) delete o[last];
  else o[last] = value;
}
