#!/usr/bin/env node
// Prepare VP9 WebM transparency for the cross-platform packed-alpha renderer.
// This is local encoding, not AI generation. Never replaces the source or an existing output.
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const input = arg("--input");
const output = arg("--output");
if (!input || !output) throw new Error("Usage: node scripts/pack-alpha.ts --input transparent.webm --output new-packed.mp4");
const src = resolve(input);
const dest = resolve(output);
if (!src.toLowerCase().endsWith(".webm")) throw new Error("Input must be a transparent VP9 WebM (decoded with libvpx-vp9 to keep alpha).");
if (!dest.toLowerCase().endsWith(".mp4")) throw new Error("Output must have a new .mp4 filename.");
if (!existsSync(src)) throw new Error(`Input does not exist: ${src}`);
if (existsSync(dest)) throw new Error(`Refusing to replace an existing output: ${dest}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.platform === "darwin" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
  : process.platform === "win32" ? "x86_64-pc-windows-msvc.exe" : "";
const bundled = resolve(root, "src-tauri/binaries", `ffmpeg-${target}`);
const ffmpeg = process.env.SLS_FFMPEG_PATH || (target && existsSync(bundled) ? bundled : "ffmpeg");
mkdirSync(dirname(dest), { recursive: true });
const partial = `${dest}.partial-${process.pid}.mp4`;
const args = [
  "-hide_banner", "-loglevel", "error", "-n", "-threads", "2", "-c:v", "libvpx-vp9", "-i", src,
  "-filter_complex_threads", "1", "-filter_complex",
  "[0:v]split=2[c][a];[c]format=yuv420p[colour];[a]alphaextract,format=yuv420p[mask];[colour][mask]vstack=inputs=2[packed]",
  "-map", "[packed]", "-map", "0:a?", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "18",
  "-pix_fmt", "yuv420p", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0",
  "-x264-params", "vbv-maxrate=40000:vbv-bufsize=7000",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-fps_mode", "passthrough",
  "-metadata", "comment=LiveStage alphaPacked: colour top, grayscale alpha bottom", partial,
];
await new Promise<void>((ok, fail) => {
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
  let error = "";
  child.stderr.on("data", (data: Buffer) => { error = (error + data.toString()).slice(-8000); });
  child.on("error", fail);
  child.on("exit", (code) => code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}: ${error}\nPartial output, if any: ${partial}`)));
});
// Linking within the same directory creates the destination exclusively, even
// when another encoder finishes at the same time. Keep the partial on failure.
linkSync(partial, dest);
unlinkSync(partial);
console.log(JSON.stringify({ file: dest, alphaPacked: true, hasAlpha: true }));
