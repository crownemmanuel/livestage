// Where the backstage page gets its data: the Sound app over the LAN (WebSocket), or Firebase's Realtime
// Database over REST + EventSource when it is hosted (cloud mode, config in the URL's #c=…).

import type { BackstageView } from "../../../server/model.ts";

export interface SourceState {
  view: BackstageView | null;
  status: "connecting" | "synced" | "offline";
  error: string | null;
}

export interface Source {
  state: SourceState;
  subscribe(f: (s: SourceState) => void): () => void;
  assign(sceneId: string, charId: string, mic: number): Promise<void>;
  /** `sig`: micSig of the mics the phone showed, so the check only counts for exactly those. */
  confirm(sceneId: string, by: string, sig: string): Promise<void>;
}

function base(): Pick<Source, "state" | "subscribe"> & { set(p: Partial<SourceState>): void } {
  const subs = new Set<(s: SourceState) => void>();
  const o = {
    state: { view: null, status: "connecting", error: null } as SourceState,
    subscribe(f: (s: SourceState) => void) {
      subs.add(f);
      f(o.state);
      return () => void subs.delete(f);
    },
    set(p: Partial<SourceState>) {
      o.state = { ...o.state, ...p };
      for (const f of subs) f(o.state);
    },
  };
  return o;
}

// ---------------------------------------------------------------- local network

export function localSource(): Source {
  const b = base();
  let ws: WebSocket | null = null;
  let id = 1;
  const waiting = new Map<number, (r: { ok: boolean; error?: string }) => void>();
  const connect = () => {
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?role=backstage`);
    ws = sock;
    sock.onopen = () => b.set({ status: "synced", error: null });
    sock.onclose = () => {
      ws = null;
      b.set({ status: "offline", error: "Lost the sound desk: reconnecting…" });
      setTimeout(connect, 1000);
    };
    sock.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === "backstage") b.set({ view: m.view });
      else if (m.t === "res") {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      }
    };
  };
  connect();
  const send = (cmd: string, args: Record<string, unknown>) =>
    new Promise<void>((ok, fail) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        b.set({ error: "Not connected to the sound desk; try again in a moment" });
        return fail(new Error("offline"));
      }
      const n = id++;
      waiting.set(n, (r) => {
        if (r.ok) ok();
        else {
          b.set({ error: r.error ?? "Refused" });
          fail(new Error(r.error));
        }
      });
      ws.send(JSON.stringify({ t: "cmd", id: n, cmd, args }));
    });
  return {
    get state() {
      return b.state;
    },
    subscribe: b.subscribe,
    assign: (scene, character, mic) => send("assign", { scene, character, mic }),
    confirm: (scene, by, sig) => send("scene.confirm", { scene, by, sig }),
  };
}

// ---------------------------------------------------------------- cloud (Firebase Realtime Database)

export interface CloudConfig {
  v: number;
  /** Database base URL (https://<db>.firebaseio.com, or http://127.0.0.1:9000 for the emulator). */
  db: string;
  /** Namespace for the emulator (?ns=…), empty for the real database. */
  ns: string;
  /** Firebase web API key (public). */
  key: string;
  /** Emulator host for anonymous sign-in (development only). */
  emu?: string;
  show: string;
  join: string;
}

export function readCloudConfig(hash: string): CloudConfig | null {
  const m = /^#c=([\w-]+)/.exec(hash);
  if (!m) return null;
  try {
    const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const c = JSON.parse(json) as CloudConfig;
    return c.db && c.key && c.show && c.join ? c : null;
  } catch {
    return null;
  }
}

interface Mirror {
  show?: {
    name?: string;
    micCount?: number;
    activeSceneId?: string;
    nextSceneId?: string;
    scenes?: { id: string; code: string; name: string; cast?: string[] }[];
    characters?: Record<string, { name: string; gender: "male" | "female"; palette: number; defaultMic: number; thumb?: string }>;
  };
  backstage?: {
    assign?: Record<string, Record<string, number>>;
    stamp?: Record<string, number>;
    checked?: Record<string, { by: string; at: number; sig?: string }>;
  };
}

function setPath(root: Record<string, unknown>, parts: string[], value: unknown) {
  if (!parts.length) return;
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]] as Record<string, unknown>;
  }
  if (value === null) delete o[parts[parts.length - 1]];
  else o[parts[parts.length - 1]] = value;
}

function viewOf(m: Mirror): BackstageView | null {
  const s = m.show;
  if (!s?.scenes) return null;
  const chars = s.characters ?? {};
  const bs = m.backstage ?? {};
  return {
    showName: s.name ?? "",
    micCount: s.micCount ?? 12,
    activeSceneId: s.activeSceneId || null,
    nextSceneId: s.nextSceneId || null,
    characters: Object.entries(chars).map(([id, c]) => ({ id, name: c.name, gender: c.gender, palette: c.palette ?? 0, photo: null, thumb: c.thumb || null, defaultMic: c.defaultMic || null })),
    scenes: s.scenes.map((sc) => {
      const cast = sc.cast ?? [];
      const assigned = bs.assign?.[sc.id];
      const mics: Record<string, number> = {};
      for (const id of cast) {
        const v = assigned?.[id] ?? chars[id]?.defaultMic;
        if (v) mics[id] = v;
      }
      return { id: sc.id, code: sc.code, name: sc.name, cast, mics, micsAt: bs.stamp?.[sc.id] ?? 0, checked: bs.checked?.[sc.id] ?? null };
    }),
  };
}

export function cloudSource(c: CloudConfig): Source {
  const b = base();
  const tokenKey = `sound.cloud.${c.show}`;
  let idToken = "";
  let tokenAt = 0;
  let mirror: Mirror = {};
  let es: EventSource | null = null;
  const authBase = c.emu ? `http://${c.emu}:9099/` : "https://";
  const path = `sound/${c.show}/${c.join}`;
  const url = (p: string) => `${c.db}/${p}.json?auth=${encodeURIComponent(idToken)}${c.ns ? `&ns=${encodeURIComponent(c.ns)}` : ""}`;

  async function token() {
    if (idToken && Date.now() - tokenAt < 50 * 60 * 1000) return idToken;
    let refresh = "";
    try {
      refresh = localStorage.getItem(tokenKey) ?? "";
    } catch {
      /* private mode */
    }
    if (refresh) {
      const r = await fetch(`${authBase}securetoken.googleapis.com/v1/token?key=${c.key}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}` });
      if (r.ok) {
        const j = await r.json();
        idToken = j.id_token;
        tokenAt = Date.now();
        return idToken;
      }
    }
    const r = await fetch(`${authBase}identitytoolkit.googleapis.com/v1/accounts:signUp?key=${c.key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error(`Sign-in failed (${r.status})`);
    const j = await r.json();
    idToken = j.idToken;
    tokenAt = Date.now();
    try {
      localStorage.setItem(tokenKey, j.refreshToken);
    } catch {
      /* fine */
    }
    return idToken;
  }

  async function open() {
    es?.close();
    try {
      await token();
    } catch (e) {
      b.set({ status: "offline", error: e instanceof Error ? e.message : String(e) });
      setTimeout(open, 4000);
      return;
    }
    const src = new EventSource(url(path));
    es = src;
    const onData = (kind: "put" | "patch") => (e: MessageEvent) => {
      const m = JSON.parse(e.data) as { path: string; data: unknown };
      const parts = m.path.split("/").filter(Boolean);
      if (kind === "put") {
        if (!parts.length) mirror = (m.data as Mirror) ?? {};
        else setPath(mirror as Record<string, unknown>, parts, m.data);
      } else for (const [k, v] of Object.entries((m.data as Record<string, unknown>) ?? {})) setPath(mirror as Record<string, unknown>, [...parts, ...k.split("/").filter(Boolean)], v);
      const view = viewOf(mirror);
      b.set({ view, status: "synced", error: view ? null : "The sound desk has not shared this show yet" });
    };
    src.addEventListener("put", onData("put"));
    src.addEventListener("patch", onData("patch"));
    src.addEventListener("auth_revoked", () => {
      idToken = "";
      void open();
    });
    src.addEventListener("cancel", () => {
      b.set({ status: "offline", error: "This link is no longer valid (ask the sound desk for the new QR code)" });
      src.close();
    });
    src.onerror = () => b.set({ status: "connecting", error: "Reconnecting…" });
    src.onopen = () => b.set({ status: "synced", error: null });
  }
  void open();
  // Fresh token before the hour is up.
  setInterval(() => {
    if (Date.now() - tokenAt > 55 * 60 * 1000) {
      idToken = "";
      void open();
    }
  }, 60000);

  async function patch(body: Record<string, unknown>) {
    await token();
    const r = await fetch(url(`${path}/backstage`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      const msg = `Could not save (${r.status})`;
      b.set({ error: msg });
      throw new Error(msg);
    }
  }

  return {
    get state() {
      return b.state;
    },
    subscribe: b.subscribe,
    async assign(sceneId, charId, mic) {
      const sc = b.state.view?.scenes.find((s) => s.id === sceneId);
      if (!sc) return;
      const mics = { ...sc.mics };
      const old = mics[charId];
      for (const [id, m] of Object.entries(mics)) if (id !== charId && m === mic && old !== undefined) mics[id] = old;
      mics[charId] = mic;
      await patch({ [`assign/${sceneId}`]: mics, [`stamp/${sceneId}`]: Date.now(), [`checked/${sceneId}`]: null });
    },
    async confirm(sceneId, by, sig) {
      await patch({ [`checked/${sceneId}`]: { by, at: Date.now(), sig } });
    },
  };
}
