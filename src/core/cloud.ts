// Cloud sync over Firebase (off until the operator enters a project's keys). A cloud version is a show
// package laid out in a Storage bucket, so taking one in is the same review and merge as a package
// (src/core/showMerge.ts). See docs/SHOW_PACKAGE.md.
//
//   shows/<showId>/latest.json         which version is current (written last: the commit point)
//   shows/<showId>/v<n>/show.json       the show, as in a package
//   shows/<showId>/v<n>/manifest.json   the package manifest (scene hashes, files with SHA-256)
//   media/<sha256>                      every media file once, by content
//
// Keys and the sign-in token live in cloud.json in the app data folder: never in the show file (which
// travels) or the repository. The password is never stored. HTTP goes through the native side
// (src-tauri/src/cloud.rs), which streams media between disk and network.

import { uid } from "./ids";
import { isTauri } from "./platform";
import { outgoingShow, showUnits, stampOutgoing } from "./showMerge";
import { machineName, PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION, portableAssets, type IncomingPackage, type PackageFile, type PackageManifest } from "./showPackage";
import type { Project } from "./types";

export interface CloudSettings {
  apiKey: string;
  projectId: string;
  storageBucket: string;
  email?: string;
  uid?: string;
  /** Kept after sign-in so the password is never stored (like the Firebase SDKs do). */
  refreshToken?: string;
  /** Development only: host of the local Firebase emulators ("127.0.0.1"). */
  emulator?: string;
}

/** latest.json */
export interface CloudLatest {
  format: "salvation-show-cloud";
  formatVersion: number;
  showId: string;
  showName: string;
  version: number;
  versionId?: string;
  createdAt: string;
  from: string;
}

const SETTINGS_FILE = "cloud.json";

function needDesktop() {
  if (!isTauri) throw new Error("Cloud sync runs in the desktop app");
}

export async function loadCloudSettings(): Promise<CloudSettings | null> {
  if (!isTauri) return null;
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    if (!(await fs.exists(SETTINGS_FILE, { baseDir: fs.BaseDirectory.AppData }))) return null;
    const s = JSON.parse(await fs.readTextFile(SETTINGS_FILE, { baseDir: fs.BaseDirectory.AppData })) as CloudSettings;
    return s.apiKey && s.projectId && s.storageBucket ? s : null;
  } catch {
    return null;
  }
}

/** Save (or with null, forget) the keys on this computer. */
export async function saveCloudSettings(s: CloudSettings | null): Promise<void> {
  needDesktop();
  const fs = await import("@tauri-apps/plugin-fs");
  token = null;
  if (!s) {
    if (await fs.exists(SETTINGS_FILE, { baseDir: fs.BaseDirectory.AppData })) await fs.remove(SETTINGS_FILE, { baseDir: fs.BaseDirectory.AppData });
    return;
  }
  await fs.writeTextFile(`${SETTINGS_FILE}.tmp`, JSON.stringify(s, null, 2), { baseDir: fs.BaseDirectory.AppData });
  await fs.rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE, { oldPathBaseDir: fs.BaseDirectory.AppData, newPathBaseDir: fs.BaseDirectory.AppData });
}

/** The web app config from the Firebase console, pasted as JSON or as the `const firebaseConfig = {…}` snippet. */
export function parseFirebaseConfig(text: string): Pick<CloudSettings, "apiKey" | "projectId" | "storageBucket"> | null {
  const pick = (k: string) => text.match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`))?.[1]?.trim();
  const apiKey = pick("apiKey");
  const projectId = pick("projectId");
  const storageBucket = pick("storageBucket") ?? (projectId ? `${projectId}.firebasestorage.app` : undefined);
  return apiKey && projectId && storageBucket ? { apiKey, projectId, storageBucket } : null;
}

// ---------------------------------------------------------------- HTTP

interface HttpRes {
  status: number;
  body: string;
}

async function http(method: string, url: string, headers: [string, string][] = [], body?: string): Promise<HttpRes> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<HttpRes>("cloud_http", { req: { method, url, headers, body } });
}

function endpoints(s: CloudSettings) {
  const e = s.emulator;
  return {
    signIn: `${e ? `http://${e}:9099/` : "https://"}identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(s.apiKey)}`,
    token: `${e ? `http://${e}:9099/` : "https://"}securetoken.googleapis.com/v1/token?key=${encodeURIComponent(s.apiKey)}`,
    storage: `${e ? `http://${e}:9199` : "https://firebasestorage.googleapis.com"}/v0/b/${encodeURIComponent(s.storageBucket)}/o`,
  };
}

function apiError(r: HttpRes, what: string): Error {
  let msg = r.body.slice(0, 300);
  try {
    const j = JSON.parse(r.body);
    msg = j.error?.message ?? msg;
  } catch {
    /* plain text */
  }
  if (r.status === 401 || r.status === 403) return new Error(`${what}: not allowed (${msg}). Check that you are signed in with the show's account and that the Storage rules allow it.`);
  return new Error(`${what}: HTTP ${r.status} ${msg}`);
}

// ---------------------------------------------------------------- sign-in

let token: { idToken: string; exp: number; refreshToken: string } | null = null;

/** Sign in with the show's email/password account. Returns the settings to save (token, not password). */
export async function signIn(s: CloudSettings, email: string, password: string): Promise<CloudSettings> {
  needDesktop();
  const r = await http("POST", endpoints(s).signIn, [["Content-Type", "application/json"]], JSON.stringify({ email, password, returnSecureToken: true }));
  if (r.status !== 200) throw apiError(r, "Sign-in failed");
  const j = JSON.parse(r.body);
  token = { idToken: j.idToken, exp: Date.now() + Number(j.expiresIn ?? 3600) * 1000, refreshToken: j.refreshToken };
  return { ...s, email: j.email ?? email, uid: j.localId, refreshToken: j.refreshToken };
}

async function idToken(s: CloudSettings): Promise<string> {
  if (token && token.refreshToken === s.refreshToken && token.exp - 60_000 > Date.now()) return token.idToken;
  if (!s.refreshToken) throw new Error("Not signed in to the cloud: open More → Cloud sync and sign in");
  const r = await http("POST", endpoints(s).token, [["Content-Type", "application/x-www-form-urlencoded"]], `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`);
  if (r.status !== 200) throw apiError(r, "Cloud sign-in expired; sign in again");
  const j = JSON.parse(r.body);
  token = { idToken: j.id_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000, refreshToken: s.refreshToken };
  return token.idToken;
}

async function authHeader(s: CloudSettings): Promise<[string, string]> {
  return ["Authorization", `Firebase ${await idToken(s)}`];
}

// ---------------------------------------------------------------- storage

const enc = encodeURIComponent;

async function getJson<T>(s: CloudSettings, path: string): Promise<T | null> {
  const r = await http("GET", `${endpoints(s).storage}/${enc(path)}?alt=media`, [await authHeader(s)]);
  if (r.status === 404) return null;
  if (r.status !== 200) throw apiError(r, `Reading ${path}`);
  return JSON.parse(r.body) as T;
}

async function putJson(s: CloudSettings, path: string, value: unknown): Promise<void> {
  const r = await http("POST", `${endpoints(s).storage}?name=${enc(path)}`, [await authHeader(s), ["Content-Type", "application/json"]], JSON.stringify(value));
  if (r.status !== 200) throw apiError(r, `Writing ${path}`);
}

async function exists(s: CloudSettings, path: string): Promise<boolean> {
  const r = await http("GET", `${endpoints(s).storage}/${enc(path)}`, [await authHeader(s)]);
  if (r.status === 404) return false;
  if (r.status !== 200) throw apiError(r, `Checking ${path}`);
  return true;
}

/** The shows in the bucket, newest first. */
export async function listCloudShows(s: CloudSettings): Promise<CloudLatest[]> {
  const r = await http("GET", `${endpoints(s).storage}?prefix=${enc("shows/")}&delimiter=${enc("/")}`, [await authHeader(s)]);
  if (r.status !== 200) throw apiError(r, "Listing the cloud");
  const prefixes: string[] = JSON.parse(r.body).prefixes ?? [];
  const out = await Promise.all(prefixes.map((p) => getJson<CloudLatest>(s, `${p.replace(/\/$/, "")}/latest.json`)));
  return out.filter((x): x is CloudLatest => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cloudLatest(s: CloudSettings, showId: string): Promise<CloudLatest | null> {
  return getJson<CloudLatest>(s, `shows/${showId}/latest.json`);
}

/** Retry network failures and server errors (not refusals) a few times: venue and home connections drop. */
async function withRetry<T>(what: string, fn: () => Promise<T>, retryable: (v: T) => boolean = () => false): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const v = await fn();
      if (!retryable(v)) return v;
      last = v;
    } catch (e) {
      last = e;
      if (/not allowed|HTTP 4\d\d/.test(String(e))) break;
    }
  }
  if (last instanceof Error || typeof last === "string") throw last instanceof Error ? last : new Error(`${what}: ${last}`);
  return last as T;
}

// ---------------------------------------------------------------- push

async function progress(phase: string, done: number, total: number, key: string) {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("package-progress", { phase, done, total, key });
}

/** The cloud has a version this computer has not taken in yet. */
export class CloudAheadError extends Error {
  constructor(public latest: CloudLatest) {
    super(`The cloud has v${latest.version} from a ${latest.from} (${new Date(latest.createdAt).toLocaleString()}) that this computer has not taken in. Sync first, or push anyway.`);
  }
}

export interface PushResult {
  version: number;
  uploaded: number;
  alreadyThere: number;
  megabytesUploaded: number;
  missing: string[];
  /** The show with its new version stamp, for the caller to keep. */
  project: Project;
}

/** Send this computer's show as the next cloud version, uploading only media the cloud does not have yet. */
export async function pushShow(s: CloudSettings, project: Project, opts: { force?: boolean } = {}): Promise<PushResult> {
  needDesktop();
  const { invoke } = await import("@tauri-apps/api/core");
  const { appDataDir } = await import("@tauri-apps/api/path");
  const lin = project.lineage;
  const latest = lin?.showId ? await cloudLatest(s, lin.showId) : null;
  // The cloud's current version must be part of this show's history, or pushing would hide it.
  const ahead = latest && (latest.versionId ? !lin?.history?.includes(latest.versionId) : latest.version > Math.max(lin?.sent ?? 0, lin?.received?.version ?? 0));
  if (ahead && !opts.force) throw new CloudAheadError(latest);

  const { project: stamped, version, versionId, ancestry } = stampOutgoing(project, uid, (latest?.version ?? 0) + 1);
  const showId = stamped.lineage!.showId;
  const root = (await appDataDir()).replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  const { assets, files, unpackable } = portableAssets(stamped.assets, root, (...p) => p.join(sep));
  const unique = [...new Map(files.map((f) => [f.key, f])).values()];

  const hashes = await invoke<(PackageFile | null)[]>("cloud_hash_sources", { files: unique });
  const entries: PackageFile[] = [];
  const missing = [...unpackable];
  unique.forEach((f, i) => (hashes[i] ? entries.push(hashes[i]!) : missing.push(f.key)));

  // Media the previous version already had is in the cloud; anything else is checked, then uploaded.
  const prev = latest ? await getJson<PackageManifest>(s, `shows/${showId}/v${latest.version}/manifest.json`) : null;
  const inCloud = new Set(prev?.files.map((f) => f.sha256) ?? []);
  const bySha = new Map<string, { entry: PackageFile; file: (typeof unique)[number] }>();
  entries.forEach((e) => bySha.set(e.sha256, { entry: e, file: unique.find((f) => f.key === e.key)! }));
  let uploaded = 0;
  let bytes = 0;
  let done = 0;
  for (const [sha, { entry, file }] of bySha) {
    await progress("upload", done++, bySha.size, entry.key);
    if (inCloud.has(sha) || (await exists(s, `media/${sha}`))) continue;
    const r = await withRetry(
      `Uploading ${entry.key}`,
      async () =>
        invoke<HttpRes>("cloud_upload", {
          url: `${endpoints(s).storage}?name=${enc(`media/${sha}`)}`,
          headers: [await authHeader(s), ["Content-Type", "application/octet-stream"]],
          file,
        }),
      (r) => r.status >= 500,
    );
    if (r.status !== 200) throw apiError(r, `Uploading ${entry.key}`);
    uploaded++;
    bytes += entry.size;
  }
  await progress("upload", bySha.size, bySha.size, "");

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    showId,
    showName: stamped.name,
    version,
    versionId,
    ancestry,
    createdAt: new Date().toISOString(),
    from: machineName(),
    units: showUnits(stamped),
    files: entries,
    missing,
  };
  const base = `shows/${showId}/v${version}`;
  await putJson(s, `${base}/show.json`, { ...outgoingShow(stamped), assets });
  await putJson(s, `${base}/manifest.json`, manifest);
  // Someone else may have pushed while this one uploaded: never move latest backwards or over theirs.
  const now = await cloudLatest(s, showId);
  if (now && now.versionId !== latest?.versionId) throw new Error(`Another computer pushed v${now.version} meanwhile; sync first, then push again`);
  const head: CloudLatest = { format: "salvation-show-cloud", formatVersion: 1, showId, showName: stamped.name, version, versionId, createdAt: manifest.createdAt, from: manifest.from };
  await putJson(s, `shows/${showId}/latest.json`, head);
  return { version, uploaded, alreadyThere: bySha.size - uploaded, megabytesUploaded: Math.round(bytes / 1e5) / 10, missing, project: stamped };
}

// ---------------------------------------------------------------- pull

/** Read the current cloud version of a show (default: this show, or the only show in the bucket) for review. */
export async function readCloudVersion(s: CloudSettings, showId: string | undefined, migrate: (p: Project) => Project): Promise<IncomingPackage> {
  needDesktop();
  let id = showId;
  if (!id) {
    const shows = await listCloudShows(s);
    if (!shows.length) throw new Error("There is no show in the cloud yet: push one from the build computer first");
    if (shows.length > 1) throw new Error(`The cloud has ${shows.length} shows (${shows.map((x) => `${x.showName} [${x.showId}]`).join(", ")}); choose one`);
    id = shows[0].showId;
  }
  const latest = await cloudLatest(s, id);
  if (!latest) throw new Error(`No show ${id} in the cloud`);
  const base = `shows/${id}/v${latest.version}`;
  const [manifest, show] = await Promise.all([getJson<PackageManifest>(s, `${base}/manifest.json`), getJson<Project>(s, `${base}/show.json`)]);
  if (!manifest || !show) throw new Error(`Cloud version v${latest.version} is incomplete`);
  if (manifest.formatVersion > PACKAGE_FORMAT_VERSION) throw new Error("This cloud version was made by a newer version of the app; update this computer first");
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    dir: `cloud:${s.projectId}/${base}`,
    manifest,
    show: migrate(show),
    via: "cloud",
    async copyFiles(files) {
      const out = { copied: [] as string[], skipped: [] as string[], failed: [] as [string, string][] };
      let done = 0;
      for (const f of files) {
        await progress("download", done++, files.length, f.key);
        try {
          const r = await withRetry(`Downloading ${f.key}`, async () =>
            invoke<string>("cloud_download", { url: `${endpoints(s).storage}/${enc(`media/${f.sha256}`)}?alt=media`, headers: [await authHeader(s)], key: f.key, sha256: f.sha256 }),
          );
          (r === "copied" ? out.copied : out.skipped).push(f.key);
        } catch (e) {
          out.failed.push([f.key, String(e)]);
        }
      }
      await progress("download", files.length, files.length, "");
      return out;
    },
  };
}
