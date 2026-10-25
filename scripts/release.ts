// Cut a release: set the app version, commit it, tag it. See docs/RELEASES.md.
//
//   pnpm release 0.2.0 [--notes "What changed"] [--dry-run]
//   pnpm release patch | minor | major
//   node scripts/release.ts --check v0.2.0      (CI: fail unless every version file says 0.2.0)
//
// The version lives in package.json; src-tauri/tauri.conf.json reads it from there, and
// src-tauri/Cargo.toml (+ Cargo.lock) are kept equal by this script. Only those files are
// committed, so other uncommitted work in the checkout stays out of the release commit.
// Nothing is pushed: pushing the tag is what starts the GitHub release build.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = { pkg: "package.json", cargo: "src-tauri/Cargo.toml", lock: "src-tauri/Cargo.lock", conf: "src-tauri/tauri.conf.json" };
const read = (f: string) => readFileSync(join(root, f), "utf8");
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const CRATE = "salvation-live-studio";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const lockRe = new RegExp(`(\\[\\[package\\]\\]\\nname = "${CRATE}"\\nversion = ")([^"]+)(")`);

/** The [package] table of Cargo.toml: its text up to the next table. */
function cargoPackage(text: string): { start: number; end: number } {
  const start = text.indexOf("[package]");
  if (start < 0) die("No [package] in src-tauri/Cargo.toml");
  const next = text.indexOf("\n[", start + 1);
  return { start, end: next < 0 ? text.length : next };
}
const cargoVersion = (text: string) => {
  const { start, end } = cargoPackage(text);
  return text.slice(start, end).match(/^version = "([^"]+)"/m)?.[1];
};
const setCargoVersion = (text: string, v: string) => {
  const { start, end } = cargoPackage(text);
  return text.slice(0, start) + text.slice(start, end).replace(/^version = "[^"]+"/m, `version = "${v}"`) + text.slice(end);
};

function versions() {
  return {
    "package.json": JSON.parse(read(files.pkg)).version as string,
    "src-tauri/Cargo.toml": cargoVersion(read(files.cargo)) ?? "?",
    "src-tauri/Cargo.lock": read(files.lock).match(lockRe)?.[2] ?? "?",
    "src-tauri/tauri.conf.json": JSON.parse(read(files.conf)).version as string,
  };
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

if (args[0] === "--check") {
  const want = (args[1] ?? "").replace(/^v/, "");
  const v = versions();
  const bad = Object.entries(v).filter(([f, x]) => (f === "src-tauri/tauri.conf.json" ? x !== "../package.json" : x !== want));
  for (const [f, x] of Object.entries(v)) console.log(`${f}: ${x}`);
  if (!SEMVER.test(want)) die(`"${args[1]}" is not a version tag like v1.2.3`);
  if (bad.length) die(`Tag v${want} does not match: ${bad.map(([f, x]) => `${f} = ${x}`).join(", ")}. Cut releases with pnpm release (docs/RELEASES.md).`);
  console.log(`All version files say ${want}.`);
  process.exit(0);
}

const dry = args.includes("--dry-run");
if (dry) args.splice(args.indexOf("--dry-run"), 1);
const notesArg = flag("--notes");
const current = versions()["package.json"];
const bump = args[0];
if (!bump) die("Usage: pnpm release <version | patch | minor | major> [--notes \"...\"] [--dry-run]");

let next = bump.replace(/^v/, "");
if (["patch", "minor", "major"].includes(bump)) {
  const [ma, mi, pa] = current.split(/[.-]/).map(Number);
  next = bump === "major" ? `${ma + 1}.0.0` : bump === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}
if (!SEMVER.test(next)) die(`"${bump}" is not a version like 1.2.3`);
const tag = `v${next}`;
if (git("tag", "--list", tag)) die(`Tag ${tag} already exists.`);
if (git("status", "--porcelain", "--", files.pkg, files.cargo, files.lock, files.conf)) die(`Commit or discard the changes in ${Object.values(files).join(", ")} first.`);

// Release notes (shown in the app's update dialog): --notes, or the commit subjects since the last tag.
let notes = notesArg;
if (!notes) {
  let last = "";
  try {
    last = git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    // first release
  }
  const log = git("log", "--no-merges", "--format=- %s", "-n", "30", ...(last ? [`${last}..HEAD`] : []));
  notes = log || "Maintenance release.";
}
const message = `LiveStage ${next}\n\n${notes}\n`;

console.log(`${current} → ${next} (tag ${tag})\n\n${message}`);
if (dry) {
  console.log("Dry run: nothing changed.");
  process.exit(0);
}

const pkgText = read(files.pkg);
writeFileSync(join(root, files.pkg), pkgText.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
writeFileSync(join(root, files.cargo), setCargoVersion(read(files.cargo), next));
writeFileSync(join(root, files.lock), read(files.lock).replace(lockRe, `$1${next}$3`));
const after = versions();
if (after["package.json"] !== next || after["src-tauri/Cargo.toml"] !== next || after["src-tauri/Cargo.lock"] !== next) die(`Could not set every version: ${JSON.stringify(after)}`);

git("commit", "-m", `Release ${tag}`, "--", files.pkg, files.cargo, files.lock);
git("tag", "-a", tag, "-m", message);
console.log(`Committed and tagged ${tag}. To build and publish it on GitHub:\n\n  git push origin HEAD ${tag}\n`);
