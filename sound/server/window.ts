// Open the operator screen as a chromeless app window: Chrome / Edge / Brave with --app when one is
// installed (its own profile, so it never mixes with the user's browsing), else the default browser.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./store.ts";

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const WIN = [
  `${process.env["ProgramFiles"]}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
];
const LINUX = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];

export function findAppBrowser(): string | null {
  const list = platform() === "darwin" ? MAC : platform() === "win32" ? WIN : LINUX;
  return list.find((p) => existsSync(p)) ?? null;
}

export function openAppWindow(url: string, log: (m: string) => void) {
  const browser = findAppBrowser();
  if (browser) {
    const profile = join(DATA_DIR, "window-profile");
    mkdirSync(profile, { recursive: true });
    const child = spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"], { detached: true, stdio: "ignore" });
    child.on("error", (e) => log(`could not open the app window: ${e.message}`));
    child.unref();
    log(`opened the operator screen (${browser.split(/[\\/]/).pop()})`);
    return;
  }
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", (e) => log(`could not open a browser: ${e.message}`));
  child.unref();
  log(`opened the operator screen in the default browser: ${url}`);
}
