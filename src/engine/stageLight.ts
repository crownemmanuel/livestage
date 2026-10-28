// The StageLight link: OSC commands to StageLight (the lighting desk), and its replies.
// Messages leave from LiveStage's OSC listen port while it listens, so StageLight's answers
// (/stagelight/hello, /stagelight/error) and its GO announcements come back to that port.
// Sends are fire-and-forget UDP: nothing here waits on StageLight during the show.

import { create } from "zustand";
import { isTauri } from "@/core/platform";
import {
  catalogStep,
  formatOsc,
  mirrorCueName,
  mirrorTakeName,
  parseStageLightReply,
  stageLightCatalogRequest,
  stageLightOsc,
  stageLightPing,
  type CatalogAssembly,
  type OscWireArg,
  type StageLightCatalog,
  type StageLightReply,
} from "@/core/stageLight";
import type { IoSettings, StageLightMessage } from "@/core/types";
import { useProject } from "@/store/project";

type Hello = Extract<StageLightReply, { kind: "hello" }>;
type Live = Extract<StageLightReply, { kind: "live" }>;

interface StageLightStore {
  /** Last ping sent (ms), or 0. */
  pingedAt: number;
  pingError: string | null;
  /** Last /stagelight/hello, with when it came and from where. */
  hello: (Hello & { at: number; from: string }) | null;
  /** Last /stagelight/cue/live announcement (StageLight GOed a cue, from anywhere). */
  live: (Live & { at: number }) | null;
  /** Last /stagelight/error: StageLight refused a message. */
  error: { at: number; address: string; message: string } | null;
  /**
   * The catalog (pages, cues, triggers, library cues): "loading" while it arrives, "unsupported" for a
   * StageLight older than 0.3 (pick by typing), "failed" after retries came back incomplete.
   */
  catalogState: "none" | "loading" | "ok" | "unsupported" | "failed";
  catalogAt: number;
}

export const useStageLight = create<StageLightStore>(() => ({ pingedAt: 0, pingError: null, hello: null, live: null, error: null, catalogState: "none", catalogAt: 0 }));

/** The catalog cues pick from: the one last read from StageLight, kept in the show file. */
export const stageLightCatalog = (): StageLightCatalog | null => useProject.getState().project.io?.stagelight?.catalog ?? null;

type Log = (dir: "in" | "out" | "info" | "error", text: string) => void;
let log: Log = () => {};

const PING_EVERY_MS = 5000;
/** StageLight counts as answering when its hello is younger than this. */
export const STAGELIGHT_ALIVE_MS = 12_000;

const settings = () => useProject.getState().project.io;
const linkKey = () => `${settings()?.stagelight?.host}:${settings()?.stagelight?.port}`;

async function oscSend(io: IoSettings, address: string, args: OscWireArg[]) {
  if (!isTauri) throw new Error("OSC needs the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("osc_send", { host: io.stagelight.host, port: io.stagelight.port, address, args, fromListener: io.osc.enabled });
}

/** Ask StageLight to say hello (quietly: pings are not logged). */
export async function pingStageLight(): Promise<void> {
  const io = settings();
  if (!io?.stagelight?.enabled) return;
  const { address, args } = stageLightPing(io.osc.enabled ? io.osc.listenPort : null);
  try {
    await oscSend(io, address, args);
    useStageLight.setState({ pingedAt: Date.now(), pingError: null });
  } catch (e) {
    if (useStageLight.getState().pingError !== String(e)) log("error", `StageLight ping: ${String(e)}`);
    useStageLight.setState({ pingError: String(e) });
  }
}

// ---------------------------------------------------------------- catalog

let assembly: CatalogAssembly | null = null;
/** Retries for the revision being fetched (a lost UDP packet makes a catalog incomplete). */
let attempts = { revision: -1, n: 0 };
const CATALOG_RETRIES = 3;
const CATALOG_TIMEOUT_MS = 3000;

/** Ask StageLight for its catalog (quietly). Answers come back to the OSC listen port. */
export async function requestStageLightCatalog(): Promise<void> {
  const io = settings();
  if (!io?.stagelight?.enabled) return;
  const { address, args } = stageLightCatalogRequest(io.osc.enabled ? io.osc.listenPort : null);
  assembly = null;
  useStageLight.setState({ catalogState: "loading", catalogAt: Date.now() });
  try {
    await oscSend(io, address, args);
  } catch (e) {
    useStageLight.setState({ catalogState: "failed" });
    log("error", `StageLight catalog: ${String(e)}`);
  }
}

/** On every hello: fetch the catalog when StageLight's revision is not the one held (or a fetch stalled). */
function followCatalog(revision: number | null) {
  const s = useStageLight.getState();
  if (revision === null) {
    if (s.catalogState !== "unsupported") useStageLight.setState({ catalogState: "unsupported" });
    return;
  }
  const held = stageLightCatalog();
  if (held?.revision === revision && held.from === linkKey()) {
    if (s.catalogState !== "ok") useStageLight.setState({ catalogState: "ok" });
    return;
  }
  if (s.catalogState === "loading" && Date.now() - s.catalogAt < CATALOG_TIMEOUT_MS) return;
  if (attempts.revision !== revision) attempts = { revision, n: 0 };
  if (attempts.n >= CATALOG_RETRIES) {
    if (s.catalogState !== "failed") useStageLight.setState({ catalogState: "failed" });
    return;
  }
  attempts.n++;
  void requestStageLightCatalog();
}

function catalogReply(r: StageLightReply) {
  const step = catalogStep(assembly, r);
  assembly = step.assembly;
  if (step.incomplete) {
    log("info", `StageLight catalog came back incomplete (${step.incomplete}); asking again`);
    useStageLight.setState({ catalogState: "none" });
    if (attempts.n < CATALOG_RETRIES) {
      attempts.n++;
      void requestStageLightCatalog();
    } else useStageLight.setState({ catalogState: "failed" });
    return;
  }
  if (!step.done) return;
  const c = { ...step.done, from: linkKey() };
  // Kept in the show file so cues can be picked while StageLight is off; written only when it changed.
  const changed = JSON.stringify(stageLightCatalog()) !== JSON.stringify(c);
  if (changed)
    useProject.getState().update((p) => {
      if (p.io?.stagelight) p.io.stagelight.catalog = c;
    });
  attempts = { revision: c.revision, n: 0 };
  useStageLight.setState({ catalogState: "ok", catalogAt: Date.now() });
  if (changed) log("info", `StageLight catalog: ${c.pages.length} pages, ${c.pages.reduce((n, p) => n + p.cues.length, 0)} cues, ${c.triggers.length} triggers, ${c.library.length} library cues (revision ${c.revision})`);
}

/** "answering", "sent" (no reply seen; OSC listen may be off), "error" (cannot send) or "off". */
export function stageLightReach(): "off" | "answering" | "sent" | "error" {
  const io = settings();
  if (!io?.stagelight?.enabled) return "off";
  const s = useStageLight.getState();
  if (s.hello && Date.now() - s.hello.at < STAGELIGHT_ALIVE_MS) return "answering";
  if (s.pingError) return "error";
  return "sent";
}

/** The exact OSC a message becomes, for the Test dialog and agents (the error when it cannot be built). */
export function stageLightWire(m: StageLightMessage): string[] {
  const link = settings()?.stagelight;
  try {
    const { address, args } = stageLightOsc(m);
    return [`${formatOsc(address, args)}${link ? ` → ${link.host}:${link.port}` : " (StageLight not set up: Settings → StageLight)"}`];
  } catch (e) {
    return [String(e instanceof Error ? e.message : e)];
  }
}

/** Send a command to StageLight. Returns what went out. */
export async function sendStageLight(m: StageLightMessage): Promise<string> {
  const io = settings();
  if (!io?.stagelight?.enabled) throw new Error("StageLight link is off (Settings → StageLight)");
  const { address, args } = stageLightOsc(m);
  await oscSend(io, address, args);
  return `${formatOsc(address, args)} → ${io.stagelight.host}:${io.stagelight.port}`;
}

/**
 * Mirror a live TAKE / GO as a named trigger (scene.<code> / cue.<code>.<n>) when switched on.
 * Never throws and never waits: the TAKE or GO does not depend on it.
 */
export function mirrorToStageLight(what: { take: string } | { cue: string; number: number }, send: (m: StageLightMessage) => void) {
  const io = settings();
  if (!io?.stagelight?.enabled || !io.stagelight.mirror) return;
  send({ type: "stagelight", op: "trigger", name: "take" in what ? mirrorTakeName(what.take) : mirrorCueName(what.cue, what.number) });
}

/**
 * Handle an incoming OSC message from StageLight. Returns true when it is consumed (hello, error);
 * GO announcements (/stagelight/cue/live) are recorded and still go on to the log and the
 * incoming triggers, so a light cue can drive the wall too.
 */
export function handleStageLightReply(address: string, args: (number | string | boolean)[], from?: string): boolean {
  const r = parseStageLightReply(address, args);
  if (!r) return false;
  if (r.kind === "hello") {
    const prev = useStageLight.getState().hello;
    const first = !prev || Date.now() - prev.at > STAGELIGHT_ALIVE_MS;
    useStageLight.setState({ hello: { ...r, at: Date.now(), from: from ?? "" } });
    if (first) log("info", `StageLight answered (v${r.version || "?"}${r.armed === null ? "" : r.armed ? ", output armed" : ", preview only"}${r.page ? `, running ${r.page}${r.cue ? ` · ${r.cue}` : ""}` : ""})`);
    // A target test sends a short hello (no armed state): not a real answer to our ping.
    if (r.armed !== null) followCatalog(r.catalogRevision);
    return true;
  }
  if (r.kind.startsWith("catalog")) {
    catalogReply(r);
    return true;
  }
  if (r.kind === "error") {
    useStageLight.setState({ error: { at: Date.now(), address: r.address, message: r.message } });
    // A mirrored TAKE / GO that StageLight has no trigger for is expected, not a fault.
    log(r.unmappedMirror ? "info" : "error", `StageLight refused ${r.address}: ${r.message}`);
    return true;
  }
  if (r.kind === "live") {
    useStageLight.setState({ live: { ...r, at: Date.now() } });
    // Keep the "running" line current between pings.
    useStageLight.setState((s) => (s.hello ? { hello: { ...s.hello, page: r.pageName, cue: r.cueName } } : {}));
  }
  return false;
}

/**
 * For Test and agents: what StageLight said about a message sent at `since` (ms), waiting up to
 * `ms`. StageLight answers only refusals, and announces GOs when a target with announce points here.
 */
export function stageLightAnswer(since: number, ms = 400): Promise<{ error: string } | { live: string } | null> {
  const pick = (s: StageLightStore) =>
    s.error && s.error.at >= since ? { error: `${s.error.address}: ${s.error.message}` } : s.live && s.live.at >= since ? { live: `${s.live.pageName} · cue ${s.live.cueNumber} ${s.live.cueName}`.trim() } : null;
  const now = pick(useStageLight.getState());
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const unsub = useStageLight.subscribe((s) => {
      const got = pick(s);
      if (got) {
        clearTimeout(timer);
        unsub();
        resolve(got);
      }
    });
    const timer = setTimeout(() => {
      unsub();
      resolve(null);
    }, ms);
  });
}

/** Ping StageLight while the link is on. Returns a cleanup. */
export function startStageLight(logger: Log): () => void {
  log = logger;
  let lastKey = "";
  const follow = () => {
    const st = useProject.getState();
    if (!st.loaded) return;
    const io = st.project.io;
    const key = io?.stagelight?.enabled ? `${io.stagelight.host}:${io.stagelight.port}:${io.osc.enabled}:${io.osc.listenPort}` : "";
    if (key === lastKey) return;
    lastKey = key;
    useStageLight.setState({ hello: null, pingError: null, live: null, error: null, catalogState: "none", catalogAt: 0 });
    assembly = null;
    attempts = { revision: -1, n: 0 };
    if (key) void pingStageLight();
  };
  const unsub = useProject.subscribe(follow);
  follow();
  const timer = setInterval(() => void pingStageLight(), PING_EVERY_MS);
  return () => {
    unsub();
    clearInterval(timer);
  };
}
