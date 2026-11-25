// Media ingestion: every video that enters the library is probed (what codec, how big, where the
// keyframes are) and checked against what the wall plays; a file the wall would not play well is
// re-encoded into the wall format ("optimised") by ffmpeg in the Rust side, with progress for the
// operator. Shared by the library's Import button, the Show-mode importers and the agent bridge.
//
// Desktop only: in the browser dev build files are blob URLs and nothing can be probed.

import { create } from "zustand";
import { isTauri } from "@/core/platform";
import { checkMedia, needsOptimise, PACKED_MAX_HEIGHT, type MediaProbe, type MediaProblem, type WallFormat } from "@/core/mediaCheck";
import type { Asset } from "@/core/types";
import { useProject } from "@/store/project";

export interface MediaJob {
  assetId: string;
  name: string;
  state: "probing" | "optimising" | "done" | "error";
  /** 0..1 while optimising. */
  fraction: number;
  error?: string;
  startedAt: number;
}

export interface MediaTools {
  ffmpeg: string | null;
  ffmpeg_version: string | null;
  encoder: string;
}

/** Live view of probe / optimise work, by asset id (the library shows it on the row). */
export const useMediaJobs = create<{ jobs: Record<string, MediaJob> }>(() => ({ jobs: {} }));

function setJob(assetId: string, patch: Partial<MediaJob> & Pick<MediaJob, "state">, name?: string) {
  useMediaJobs.setState((s) => {
    const cur = s.jobs[assetId];
    const base: MediaJob = cur ?? { assetId, name: name ?? assetId, state: patch.state, fraction: 0, startedAt: Date.now() };
    const job: MediaJob = { ...base, ...patch, name: name ?? base.name };
    return { jobs: { ...s.jobs, [assetId]: job } };
  });
}

function clearJobLater(assetId: string, ms: number) {
  setTimeout(() => {
    useMediaJobs.setState((s) => {
      const j = s.jobs[assetId];
      if (!j || (j.state !== "done" && j.state !== "error")) return s;
      const { [assetId]: _drop, ...rest } = s.jobs;
      return { jobs: rest };
    });
  }, ms);
}

let listening = false;
async function listenProgress() {
  if (listening || !isTauri) return;
  listening = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ job: string; done_s: number; total_s: number; fraction: number }>("media-progress", (e) => {
    const j = useMediaJobs.getState().jobs[e.payload.job];
    if (j && j.state === "optimising") setJob(e.payload.job, { state: "optimising", fraction: e.payload.fraction });
  });
}

/** The wall's frame, which the optimiser never exceeds. */
export function wallFormat(): WallFormat {
  const o = useProject.getState().project.output;
  return { canvasWidth: o.canvasWidth, canvasHeight: o.canvasHeight };
}

/** Problems of an asset against the current wall (recomputed from its probe so a wall-size change counts). */
export function assetProblems(a: Asset, wall: WallFormat = wallFormat()): MediaProblem[] {
  if (a.type !== "video") return [];
  if (a.probe) return checkMedia(a.probe, wall, { hasAlpha: a.hasAlpha, alphaPacked: a.alphaPacked });
  return a.problems ?? [];
}

export async function probeFile(path: string): Promise<MediaProbe> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MediaProbe>("media_probe", { path });
}

export async function mediaTools(): Promise<MediaTools> {
  if (!isTauri) return { ffmpeg: null, ffmpeg_version: null, encoder: "" };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MediaTools>("media_tools");
}

/** Where a video asset's file is on this machine, when it is a file the app may re-encode (a library copy). */
function libraryPath(a: Asset): string | null {
  if (a.type !== "video" || !a.path) return null;
  if (a.builtIn || a.url.startsWith("/media/")) return null;
  return a.path;
}

/** Probe a video asset and record what it is; returns the asset with `probe` and `problems`. */
export async function checkAsset(a: Asset): Promise<Asset> {
  const path = a.type === "video" ? a.path : null;
  if (!isTauri || !path) return a;
  try {
    const probe = await probeFile(path);
    return { ...a, probe, problems: checkMedia(probe, wallFormat(), { hasAlpha: a.hasAlpha, alphaPacked: a.alphaPacked }) };
  } catch (e) {
    return { ...a, problems: [{ severity: "warn", code: "unreadable", message: `Could not read the file: ${String(e)}`, fixable: false }] };
  }
}

function patchAsset(id: string, fn: (a: Asset) => Asset) {
  useProject.getState().update((p) => {
    const i = p.assets.findIndex((x) => x.id === id);
    if (i >= 0) p.assets[i] = fn(p.assets[i]);
  });
}

/**
 * Re-encode a library video into the wall format and point the asset at the new file. The old
 * library copy is deleted (the operator's original stays where it was imported from). Throws with
 * a plain-language reason when it cannot (no ffmpeg, alpha video, media that ships with the app).
 *
 * `pack`: turn a video with an alpha channel into an alpha-packed one (`Asset.alphaPacked`): one
 * opaque H.264 file, colour over matte, written beside the source as `<name>.packed.mp4`. The asset
 * then plays that file on every platform and drops its HEVC-alpha twin. The transparent sources are
 * left where they are (they are the masters a later re-pack needs) and returned as `kept`.
 */
export async function optimiseAsset(assetId: string, opts: { force?: boolean; pack?: boolean } = {}): Promise<{ asset: Asset; problems: MediaProblem[]; skipped?: string; kept?: string[] }> {
  const a = useProject.getState().project.assets.find((x) => x.id === assetId);
  if (!a) throw new Error("No such asset");
  if (a.type !== "video") throw new Error(`${a.name} is not a video`);
  const pack = !!opts.pack && !a.alphaPacked;
  if (opts.pack && a.alphaPacked && !opts.force) return { asset: a, problems: assetProblems(a), skipped: "already alpha-packed" };
  const transparent = !a.alphaPacked && (a.hasAlpha || !!a.probe?.video?.alpha);
  if (pack && !transparent) throw new Error(`${a.name} has no alpha channel to pack.`);
  if (!pack && transparent) throw new Error(`${a.name} has an alpha channel; re-encoding would flatten it. Pack it instead (pack: true: one H.264 file, colour over matte), or prepare transparent video as HEVC alpha (Mac) and VP9 WebM.`);
  const src = libraryPath(a);
  if (!src) throw new Error(a.builtIn || a.url.startsWith("/media/") ? `${a.name} ships with the app: re-encode it and rebuild.` : `${a.name} is not a file in the show library (browser session import?).`);
  const checked = a.probe ? a : await checkAsset(a);
  const problems = assetProblems(checked);
  if (!pack && !opts.force && !problems.some((p) => p.fixable)) {
    patchAsset(assetId, () => checked);
    return { asset: checked, problems, skipped: "already in a format the wall plays well" };
  }
  await listenProgress();
  setJob(assetId, { state: "optimising", fraction: 0 }, a.name);
  try {
    const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
    const { dirname, join } = await import("@tauri-apps/api/path");
    const fs = await import("@tauri-apps/plugin-fs");
    const dir = await dirname(src);
    const srcBase = src.split(/[\\/]/).pop() ?? "video.mp4";
    const tag = pack || a.alphaPacked ? "packed" : "wall";
    const stem = srcBase.replace(/\.[^.]+$/, "").replace(/\.(wall|packed)(-[0-9a-z]{8})?$/i, "");
    // A new name whenever the plain one is taken or is the source itself (re-optimising a .wall file):
    // ffmpeg cannot write over its input, and WebKit caches a video by its URL, so a rewritten file
    // needs a new name anyway.
    let dest = await join(dir, `${stem}.${tag}.mp4`);
    const taken = async (p: string) => p === src || (await fs.exists(p).catch(() => true));
    if (await taken(dest)) dest = await join(dir, `${stem}.${tag}-${Date.now().toString(36)}.mp4`);
    const wall = wallFormat();
    const v = checked.probe?.video;
    // An alpha-packed file is re-encoded at its own size: fitted to the wall it would lose half its height.
    const box = a.alphaPacked && v?.width && v.height ? { w: v.width, h: v.height } : { w: wall.canvasWidth, h: pack ? Math.min(wall.canvasHeight, PACKED_MAX_HEIGHT) : wall.canvasHeight };
    const probe = await invoke<MediaProbe>("media_optimise", {
      job: assetId,
      src,
      dest,
      maxWidth: box.w,
      maxHeight: box.h,
      sourceFps: v?.fps || null,
      sourceDurationS: checked.probe?.duration_s || null,
      packAlpha: pack,
    });
    const alphaPacked = pack || !!a.alphaPacked;
    const newProblems = checkMedia(probe, wall, { hasAlpha: false, alphaPacked });
    const destBase = dest.split(/[\\/]/).pop() ?? srcBase;
    // The source was the asset's workspace file (`rel`) when their names match: the new file sits beside it.
    const fromWorkspace = !!a.rel && a.rel.split("/").pop() === srcBase;
    const beside = (key: string) => key.split("/").slice(0, -1).concat(destBase).join("/");
    const next: Asset = {
      ...checked,
      path: dest,
      url: convertFileSrc(dest),
      file: fromWorkspace ? undefined : a.file ? beside(a.file) : `assets/${destBase}`,
      probe,
      problems: newProblems,
      optimised: { from: srcBase, at: Date.now(), source: checked.probe },
    };
    let kept: string[] | undefined;
    if (pack) {
      // One file for every platform from here on: the twin and its keys go, the files themselves stay.
      next.alphaPacked = true;
      next.hasAlpha = true;
      next.rel = fromWorkspace ? beside(a.rel!) : undefined;
      kept = [fromWorkspace ? a.rel! : src, a.macRel ?? a.macFile].filter((x): x is string => !!x);
      delete next.macUrl;
      delete next.macFile;
      delete next.macRel;
    } else if (fromWorkspace) {
      // A workspace final is never deleted by the app: the asset moves to the new file and the old one waits to be archived.
      next.rel = beside(a.rel!);
      kept = [a.rel!];
    }
    patchAsset(assetId, () => next);
    if (!pack && !fromWorkspace && dest !== src) await fs.remove(src).catch(() => {});
    setJob(assetId, { state: "done", fraction: 1 });
    clearJobLater(assetId, 4000);
    return { asset: next, problems: newProblems, kept };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchAsset(assetId, (x) => ({ ...checked, ...x, probe: checked.probe, problems: assetProblems(checked) }));
    setJob(assetId, { state: "error", error: msg });
    clearJobLater(assetId, 15000);
    throw new Error(msg);
  }
}

export interface IngestResult {
  asset: Asset;
  problems: MediaProblem[];
  /** The file was re-encoded on the way in. */
  optimised: boolean;
  /** Optimising was wanted but failed (the asset stays with its problems). */
  error?: string;
}

/**
 * Add imported assets to the library, probe the videos, and (unless `auto: false`) optimise the ones
 * the wall would not play well. Assets land in the library at once so the operator sees them; the
 * probe and the re-encode update them in place.
 */
export async function ingestAssets(assets: Asset[], opts: { auto?: boolean } = {}): Promise<IngestResult[]> {
  if (!assets.length) return [];
  useProject.getState().addAssets(assets);
  const out: IngestResult[] = [];
  for (const a of assets) {
    if (a.type !== "video" || !isTauri || !a.path) {
      out.push({ asset: a, problems: [], optimised: false });
      continue;
    }
    setJob(a.id, { state: "probing" }, a.name);
    const checked = await checkAsset(a);
    patchAsset(a.id, () => checked);
    const problems = assetProblems(checked);
    const auto = opts.auto ?? true;
    if (!(auto && needsOptimise(problems)) || !libraryPath(checked)) {
      useMediaJobs.setState((s) => {
        const { [a.id]: _drop, ...rest } = s.jobs;
        return { jobs: rest };
      });
      out.push({ asset: checked, problems, optimised: false });
      continue;
    }
    try {
      const r = await optimiseAsset(a.id);
      out.push({ asset: r.asset, problems: r.problems, optimised: !r.skipped });
    } catch (e) {
      out.push({ asset: checked, problems, optimised: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
