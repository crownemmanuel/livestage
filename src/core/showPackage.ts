// Show packages: the show file plus every media file it uses, in one folder another computer can open.
// Layout and the version / conflict rules are in docs/SHOW_PACKAGE.md. The file copying and hashing
// happen natively (src-tauri/src/package.rs), so the desktop app is needed to write or take in media.

import { uid } from "./ids";
import { bundledOnDisk, isTauri } from "./platform";
import { applyMerge, outgoingShow, planMerge, replaceWithIncoming, showUnits, stampOutgoing, type MergeChoice, type MergePlan, type MergeResult, type ReceiveInfo, type UnitInfo } from "./showMerge";
import type { Asset, Project } from "./types";

export const PACKAGE_FORMAT = "salvation-show-package";
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_EXT = "slshow";

export interface PackageFile {
  key: string;
  size: number;
  sha256: string;
}

/** manifest.json: what the package is, which version, and a hash of every unit and file. */
export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  showId: string;
  showName: string;
  /** Counts up each time the show is sent out (package or cloud push). */
  version: number;
  /** Unique id of this version, and the ids it descends from (its own last). Absent in the first packages. */
  versionId?: string;
  ancestry?: string[];
  createdAt: string;
  /** The kind of computer it was made on ("Mac", "Windows PC"). */
  from: string;
  /** Unit key → label and content hash (scenes, running order, settings). */
  units: Record<string, UnitInfo>;
  files: PackageFile[];
  /** Media the show uses that could not be found when the package was written. */
  missing: string[];
}

export function machineName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows/.test(ua) ? "Windows PC" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux PC" : "computer";
}

// ---------------------------------------------------------------- export

interface ExportFile {
  key: string;
  path?: string;
  bundled?: string;
}

const isBundled = (url: string | undefined): url is string => !!url && url.startsWith("/media/");
const keyOfUrl = (url: string) => decodeURI(url.split(/[?#]/)[0].slice(1));

/** The show's assets with machine-independent references, and where each file comes from here. */
export function portableAssets(assets: Asset[], root: string, join: (...p: string[]) => string): { assets: Asset[]; files: ExportFile[]; unpackable: string[] } {
  const files: ExportFile[] = [];
  const unpackable: string[] = [];
  const source = (file: string | undefined, url: string | undefined, path: string | undefined): string | undefined => {
    if (file) {
      files.push({ key: file, path: join(root, ...file.split("/")), bundled: isBundled(url) ? url : undefined });
      return file;
    }
    if (isBundled(url)) {
      const key = keyOfUrl(url);
      files.push({ key, bundled: url });
      return key;
    }
    if (path) {
      const key = `assets/${path.replace(/\\/g, "/").split("/").pop()}`;
      files.push({ key, path });
      return key;
    }
    return undefined;
  };
  const out = assets.map((a) => {
    const file = source(a.file, a.url, a.path);
    const macFile = a.macUrl || a.macFile ? source(a.macFile, a.macUrl, undefined) : undefined;
    if (!file && (a.ephemeral || a.url.startsWith("blob:"))) unpackable.push(a.name);
    const p: Asset = { ...a, path: undefined, ephemeral: undefined };
    if (file) {
      p.file = file;
      // Bundled media keeps its URL (it also works where the app ships it); library files are found by key.
      if (!isBundled(a.url)) p.url = "";
    }
    if (macFile) {
      p.macFile = macFile;
      if (!isBundled(a.macUrl)) p.macUrl = undefined;
    }
    return JSON.parse(JSON.stringify(p)) as Asset;
  });
  return { assets: out, files, unpackable };
}

export interface ExportResult {
  dir: string;
  version: number;
  files: number;
  bytes: number;
  missing: string[];
  /** The show with its new version stamp, for the caller to keep. */
  project: Project;
}

/** Write `project` as a package folder at `dir` (replacing an older package there once the new one is complete). */
export async function exportPackage(project: Project, dir: string): Promise<ExportResult> {
  if (!isTauri) throw new Error("Show packages are written by the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  const { appDataDir } = await import("@tauri-apps/api/path");
  const root = await appDataDir();
  const sep = root.includes("\\") ? "\\" : "/";
  const { project: stamped, version, versionId, ancestry } = stampOutgoing(project, uid);
  const { assets, files, unpackable } = portableAssets(stamped.assets, root.replace(/[\\/]+$/, ""), (...p) => p.join(sep));
  const show: Project = { ...outgoingShow(stamped), assets };
  const manifest: Omit<PackageManifest, "files" | "missing"> = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    showId: stamped.lineage!.showId,
    showName: stamped.name,
    version,
    versionId,
    ancestry,
    createdAt: new Date().toISOString(),
    from: machineName(),
    units: showUnits(stamped),
  };
  const res = await invoke<{ dir: string; files: PackageFile[]; missing: string[] }>("package_export", {
    dir,
    show: JSON.stringify(show),
    manifest: JSON.stringify(manifest),
    files,
  });
  return { dir: res.dir, version, files: res.files.length, bytes: res.files.reduce((n, f) => n + f.size, 0), missing: [...res.missing, ...unpackable], project: stamped };
}

// ---------------------------------------------------------------- import

export interface IncomingPackage {
  /** The package folder (or a description of where a cloud version lives). */
  dir: string;
  manifest: PackageManifest;
  /** The packaged show, migrated to this app's format. */
  show: Project;
  via?: "package" | "cloud";
  /** How the media gets here (default: copied from the package folder). */
  copyFiles?: (files: { key: string; sha256: string }[]) => Promise<{ copied: string[]; skipped: string[]; failed: [string, string][] }>;
}

export async function readPackage(dir: string, migrate: (p: Project) => Project): Promise<IncomingPackage> {
  if (!isTauri) throw new Error("Show packages are opened by the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<{ show: string; manifest: string }>("package_read", { dir });
  const manifest = JSON.parse(raw.manifest) as PackageManifest;
  if (manifest.format !== PACKAGE_FORMAT) throw new Error("This folder is not a LiveStage show package");
  if (manifest.formatVersion > PACKAGE_FORMAT_VERSION) throw new Error("This package was made by a newer version of the app; update this computer first");
  const show = JSON.parse(raw.show) as Project;
  if (!Array.isArray(show.scenes)) throw new Error("The package's show.json has no scenes");
  return { dir, manifest, show: migrate(show) };
}

export interface ImportPreview {
  plan: MergePlan;
  /** This machine's show is another show, or has never exchanged versions with this one: replacing is the sensible default. */
  unrelated: boolean;
  /** The package is older than (or the same as) the version this machine last took in. */
  older: boolean;
  localVersion: number | null;
  incomingVersion: number;
}

export function previewImport(local: Project, pkg: IncomingPackage): ImportPreview {
  const plan = planMerge(local, pkg.show, pkg.manifest.ancestry);
  const sameShow = local.lineage?.showId === pkg.manifest.showId;
  const localVersion = sameShow ? Math.max(local.lineage?.received?.version ?? 0, local.lineage?.sent ?? 0) || null : null;
  // Already part of this show's history (sent from here, or taken in before).
  const older = sameShow && (pkg.manifest.versionId ? !!local.lineage?.history?.includes(pkg.manifest.versionId) : localVersion !== null && pkg.manifest.version <= localVersion);
  return { plan, unrelated: plan.unrelated, older, localVersion, incomingVersion: pkg.manifest.version };
}

export interface ImportOptions {
  /** replace: take the whole incoming show (machine settings stay). merge: per unit, with `choices` for conflicts. */
  mode: "replace" | "merge";
  /** Conflict key → choice. Conflicts without a choice keep this machine's version. */
  choices?: Record<string, MergeChoice>;
}

export interface ImportResult {
  project: Project;
  copied: number;
  skipped: number;
  failed: { key: string; error: string }[];
  /** Assets whose file is not in the package. */
  missing: string[];
  /** Development build: bundled media in this computer's public/ folder that differs from the incoming file (kept). */
  keptOwnDiffering: string[];
}

export function mergeIncoming(local: Project, incoming: Project, plan: MergePlan, opts: ImportOptions, info: ReceiveInfo): MergeResult {
  if (opts.mode === "replace") return replaceWithIncoming(local, incoming, info);
  const items = plan.items.map((it) => {
    const c = opts.choices?.[it.key];
    return it.state === "conflict" && c && it.options.includes(c) ? { ...it, choice: c } : it;
  });
  return applyMerge(local, incoming, { ...plan, items }, info);
}

/** Merge (or replace) and copy the media the result needs into this machine's show media folder. */
export async function importPackage(local: Project, pkg: IncomingPackage, opts: ImportOptions): Promise<ImportResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const plan = planMerge(local, pkg.show, pkg.manifest.ancestry);
  const merged = mergeIncoming(local, pkg.show, plan, opts, { version: pkg.manifest.version, via: pkg.via ?? "package", from: pkg.manifest.from, versionId: pkg.manifest.versionId, ancestry: pkg.manifest.ancestry });
  const inPackage = new Map(pkg.manifest.files.map((f) => [f.key, f]));
  // The build computer's own media (public/ in a development build) is never replaced by a copy.
  const own = await bundledOnDisk(merged.assets.flatMap((a) => [a.url, a.macUrl]));
  const keys = new Set<string>();
  const kept = new Set<string>();
  const missing: string[] = [];
  for (const a of merged.assets) {
    for (const [k, url] of [[a.file, a.url], [a.macFile, a.macUrl]] as const) {
      if (!k) continue;
      if (url && own.has(url)) kept.add(k);
      else if (inPackage.has(k)) keys.add(k);
      else if (!isBundled(url)) missing.push(a.name);
    }
  }
  // Say so when this computer's own copy differs from the incoming one (it is kept either way).
  const differ: string[] = [];
  const check = [...kept].filter((k) => inPackage.has(k));
  if (check.length) {
    const own = await invoke<(PackageFile | null)[]>("cloud_hash_sources", { files: check.map((k) => ({ key: k, bundled: `/${k}` })) });
    check.forEach((k, i) => own[i] && own[i]!.sha256 !== inPackage.get(k)!.sha256 && differ.push(k));
  }
  const files = [...keys].map((k) => ({ key: k, sha256: inPackage.get(k)!.sha256 }));
  const res = !files.length
    ? { copied: [], skipped: [], failed: [] }
    : pkg.copyFiles
      ? await pkg.copyFiles(files)
      : await invoke<{ copied: string[]; skipped: string[]; failed: [string, string][] }>("package_import_files", { dir: pkg.dir, files });
  return { project: merged.project, copied: res.copied.length, skipped: res.skipped.length + kept.size, failed: res.failed.map(([key, error]) => ({ key, error })), missing, keptOwnDiffering: differ };
}

/** Progress of a package copy (export or import), from the native side. */
export async function onPackageProgress(fn: (p: { phase: string; done: number; total: number; key: string }) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ phase: string; done: number; total: number; key: string }>("package-progress", (e) => fn(e.payload));
}

export function defaultPackageName(p: Project): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${p.name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Show"} ${stamp}.${PACKAGE_EXT}`;
}
