// Tests for the StageLight protocol (src/core/stageLight.ts): the OSC each cue / marker message
// becomes, replies, and what agents may send. No app needed.
//
//   node scripts/stagelight-check.ts                 the protocol, offline
//   node scripts/stagelight-check.ts --port 1471     also sends the same packets over UDP to a
//                                                     StageLight desk on 127.0.0.1 and prints its answers
//                                                     (never 1461, the show desk, unless --production)
//   … --page "Act 1" --trigger test                  page and trigger to GO / fire (default page 1, trigger test)

import { createSocket } from "node:dgram";
import {
  catalogStep,
  defaultStageLightMessage,
  describeStageLight,
  resolveWithCatalog,
  stageLightCatalogRequest,
  stageLightTarget,
  type CatalogAssembly,
  type StageLightCatalog,
  formatOsc,
  mirrorCueName,
  mirrorTakeName,
  normalizeStageLight,
  parseStageLightReply,
  stageLightOsc,
  stageLightPing,
  STAGELIGHT_OPS,
  type OscWireArg,
  type StageLightMessage,
} from "../src/core/stageLight.ts";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};
const wire = (m: StageLightMessage) => {
  const { address, args } = stageLightOsc(m);
  return formatOsc(address, args);
};
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ---------------------------------------------------------------- messages → OSC

const sl = <T extends Omit<StageLightMessage, "type">>(m: T) => ({ type: "stagelight", ...m }) as StageLightMessage;
ok("GO running page", wire(sl({ op: "go", page: "" })) === "/stagelight/go");
ok("GO named page", wire(sl({ op: "go", page: " Act 1 " })) === '/stagelight/go "Act 1"');
ok("GO cue by number sends an int", JSON.stringify(stageLightOsc(sl({ op: "goCue", page: "Act 1", cue: "4" })).args) === JSON.stringify([{ t: "s", v: "Act 1" }, { t: "i", v: 4 }]));
ok("GO cue by name sends text", wire(sl({ op: "goCue", page: "2", cue: "Sunrise" })) === '/stagelight/go/cue "2" "Sunrise"');
ok("GO cue 4.5 stays text", stageLightOsc(sl({ op: "goCue", page: "Act 1", cue: "4.5" })).args[1].t === "s");
ok("GO cue needs a page", throws(() => stageLightOsc(sl({ op: "goCue", page: "", cue: "4" }))));
ok("trigger", wire(sl({ op: "trigger", name: "lion.leap" })) === '/stagelight/trigger "lion.leap"');
ok("trigger needs a name", throws(() => stageLightOsc(sl({ op: "trigger", name: "  " }))));
ok("back", wire(sl({ op: "back" })) === "/stagelight/back");
ok("stop with StageLight's fade", wire(sl({ op: "stop", fade: null })) === "/stagelight/stop");
ok("clear with a fade (float)", JSON.stringify(stageLightOsc(sl({ op: "clear", fade: 2 })).args) === JSON.stringify([{ t: "f", v: 2 }]));
ok("blackout on is int 1", JSON.stringify(stageLightOsc(sl({ op: "blackout", on: true })).args) === JSON.stringify([{ t: "i", v: 1 }]));
ok("blackout off is int 0", wire(sl({ op: "blackout", on: false })) === "/stagelight/blackout 0");
ok("master clamps to 0..1", wire(sl({ op: "master", level: 1.7 })) === "/stagelight/master 1");
ok("play a library cue with a fade", wire(sl({ op: "play", cue: "Warm wash", fade: 3 })) === '/stagelight/play "Warm wash" 3');
ok("LED wall empty = off", wire(sl({ op: "ledwall", media: "" })) === '/stagelight/ledwall "off"');
ok("ping with a reply port", JSON.stringify(stageLightPing(9000)) === JSON.stringify({ address: "/stagelight/ping", args: [{ t: "i", v: 9000 }] }));
ok("ping without", stageLightPing(null).args.length === 0);
ok("every op has a default the editor can start from", STAGELIGHT_OPS.every((o) => defaultStageLightMessage(o.op).op === o.op));

// ---------------------------------------------------------------- mirroring

ok("mirror names", mirrorTakeName("1.2") === "scene.1.2" && mirrorCueName("12", 3) === "cue.12.3");

// ---------------------------------------------------------------- replies

const hello = parseStageLightReply("/stagelight/hello", ["StageLight", "0.2.0", 0, "Act 1", "Sunrise"]);
ok("hello", hello?.kind === "hello" && hello.version === "0.2.0" && hello.armed === false && hello.page === "Act 1" && hello.cue === "Sunrise");
const test = parseStageLightReply("/stagelight/hello", ["StageLight", "test"]);
ok("target test hello (2 args)", test?.kind === "hello" && test.armed === null);
const live = parseStageLightReply("/stagelight/cue/live", ["pg1", "Act 1", 4, "Sunrise", "e9"]);
ok("cue/live", live?.kind === "live" && live.cueNumber === 4 && live.pageName === "Act 1" && live.entryId === "e9");
const err = parseStageLightReply("/stagelight/error", ["/stagelight/go/cue", "No cue 9 on Act 1"]);
ok("error", err?.kind === "error" && err.address === "/stagelight/go/cue" && !err.unmappedMirror);
const mirr = parseStageLightReply("/stagelight/error", ["/stagelight/trigger", "Unknown trigger cue.12.3"]);
ok("unmapped mirror trigger is not a fault", mirr?.kind === "error" && mirr.unmappedMirror);
const real = parseStageLightReply("/stagelight/error", ["/stagelight/trigger", "Unknown trigger lion.leap"]);
ok("an unknown named trigger is a fault", real?.kind === "error" && !real.unmappedMirror);
const hello6 = parseStageLightReply("/stagelight/hello", ["StageLight", "0.3.0", 1, "Act 1", "Sunrise", 42]);
ok("hello with a catalog revision", hello6?.kind === "hello" && hello6.catalogRevision === 42 && hello6.armed === true);
ok("hello from before the catalog", hello?.kind === "hello" && hello.catalogRevision === null);
ok("other apps' messages are not StageLight's", parseStageLightReply("/sls/go", []) === null && parseStageLightReply("/hog/status/led", []) === null);

// ---------------------------------------------------------------- catalog

/** Feed a list of replies as StageLight would send them. */
function assemble(msgs: [string, (string | number)[]][]) {
  let a: CatalogAssembly | null = null;
  let out: { done?: StageLightCatalog; incomplete?: string } = {};
  for (const [address, args] of msgs) {
    const r = parseStageLightReply(address, args);
    if (!r) continue;
    const step = catalogStep(a, r);
    a = step.assembly;
    if (step.done || step.incomplete) out = step;
  }
  return out;
}
const CATALOG: [string, (string | number)[]][] = [
  ["/stagelight/catalog/begin", [7, 2, 1, 1]],
  ["/stagelight/catalog/page", ["scene-1", "Scene 1", 1, 2, "#ffaa00"]],
  ["/stagelight/catalog/cue", ["scene-1", 2, "e2", "Sunrise", "auto", 3]],
  ["/stagelight/catalog/cue", ["scene-1", 1, "e1", "First light", "manual", 1.5]],
  ["/stagelight/catalog/page", ["act-2", "Act 2", 2, 1, ""]],
  ["/stagelight/catalog/cue", ["act-2", 1, "e9", "Storm", "manual", 0]],
  ["/stagelight/catalog/trigger", ["t-leap", "lion.leap", "GO Act 2 · cue 1"]],
  ["/stagelight/catalog/library", ["lib-warm", "Warm wash"]],
  ["/stagelight/catalog/end", [7]],
];
const full = assemble(CATALOG);
const cat = full.done!;
ok("catalog assembles, cues in order", !!cat && cat.revision === 7 && cat.pages[0].cues.map((e) => e.entryId).join() === "e1,e2" && cat.pages[0].cues[1].follow === "auto");
ok("catalog with a lost packet is incomplete", !!assemble(CATALOG.filter((x) => x[1][2] !== "e9")).incomplete);
ok("catalog whose revision changed midway is incomplete", /revision/.test(assemble([...CATALOG.slice(0, -1), ["/stagelight/catalog/end", [8]]]).incomplete ?? ""));
ok("catalog request with a reply port", JSON.stringify(stageLightCatalogRequest(9000)) === JSON.stringify({ address: "/stagelight/catalog", args: [{ t: "i", v: 9000 }] }));

const byName = resolveWithCatalog(sl({ op: "goCue", page: "scene 1", cue: "Sunrise" }), cat);
ok("names resolve to IDs, with a label", JSON.stringify(byName) === JSON.stringify({ type: "stagelight", op: "goCue", page: "scene-1", cue: "e2", label: "Scene 1 · 2 Sunrise" }));
ok("numbers resolve too", JSON.stringify(resolveWithCatalog(sl({ op: "goCue", page: "2", cue: "1" }), cat)) === JSON.stringify({ type: "stagelight", op: "goCue", page: "act-2", cue: "e9", label: "Act 2 · 1 Storm" }));
ok("a trigger by name becomes its ID", (resolveWithCatalog(sl({ op: "trigger", name: "LION.LEAP" }), cat) as { name: string }).name === "t-leap");
ok("a library cue by name becomes its ID", (resolveWithCatalog(sl({ op: "play", cue: "warm wash", fade: null }), cat) as { cue: string }).cue === "lib-warm");
ok("unknown references stay as typed", JSON.stringify(resolveWithCatalog(sl({ op: "trigger", name: "chorus" }), cat)) === JSON.stringify({ type: "stagelight", op: "trigger", name: "chorus" }));
ok("GO by ID sends the IDs", wire(byName) === '/stagelight/go/cue "scene-1" "e2"');
ok("describe uses current names", describeStageLight(byName, cat) === "StageLight GO Scene 1 · 2 Sunrise" && describeStageLight(sl({ op: "trigger", name: "t-leap" }), cat) === 'StageLight trigger "lion.leap"');
ok("describe falls back to the label offline", describeStageLight(byName, null) === "StageLight GO Scene 1 · 2 Sunrise");
const gone = stageLightTarget(sl({ op: "goCue", page: "scene-1", cue: "e5", label: "Scene 1 · 5 Old" }), cat);
ok("a deleted cue is flagged", gone.missing === 'cue "e5" is not on Scene 1' && gone.text === "Scene 1 · 5 Old");
ok("a deleted trigger is flagged", !!stageLightTarget(sl({ op: "trigger", name: "t-old" }), cat).missing);

// ---------------------------------------------------------------- what agents send

const n1 = normalizeStageLight({ type: "stagelight", op: "go/cue", page: 2, cue: 4, extra: true });
ok("agent: alias, numbers to text, stray fields dropped", JSON.stringify(n1) === JSON.stringify({ type: "stagelight", op: "goCue", page: "2", cue: "4" }));
ok("agent: master 80 means 80%", (normalizeStageLight({ op: "master", level: 80 }) as { level: number }).level === 0.8);
ok("agent: blackout without on means on", (normalizeStageLight({ op: "blackout" }) as { on: boolean }).on === true);
ok("agent: blackout off", (normalizeStageLight({ op: "blackout", on: 0 }) as { on: boolean }).on === false);
ok("agent: stop fade", JSON.stringify(normalizeStageLight({ op: "stop", fade: "1.5" })) === JSON.stringify({ type: "stagelight", op: "stop", fade: 1.5 }));
ok("agent: unknown op explains", throws(() => normalizeStageLight({ op: "fire" })));
ok("agent: trigger without a name is refused", throws(() => normalizeStageLight({ op: "trigger" })));

// ---------------------------------------------------------------- optional: a real desk

const argOf = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = argOf("--port") ? Number(argOf("--port")) : null;
if (port === 1461 && !process.argv.includes("--production")) {
  console.error("Refusing UDP 1461: that is the show's StageLight desk. Use a dev desk (1471) or add --production.");
  process.exit(2);
}

/** Minimal OSC 1.0 encoding (what rosc sends from the desktop app). */
function encode(address: string, args: OscWireArg[]): Buffer {
  const str = (x: string) => {
    const b = Buffer.from(x + "\0");
    return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  };
  const parts = [str(address), str("," + args.map((a) => a.t).join(""))];
  for (const a of args) {
    if (a.t === "s") parts.push(str(a.v));
    else {
      const b = Buffer.alloc(4);
      if (a.t === "i") b.writeInt32BE(a.v);
      else b.writeFloatBE(a.v);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}

function decode(b: Buffer): { address: string; args: (string | number | boolean)[] } {
  let o = 0;
  const str = () => {
    const end = b.indexOf(0, o);
    const v = b.toString("utf8", o, end);
    o = end + 1 + ((4 - ((end + 1) % 4)) % 4);
    return v;
  };
  const address = str();
  const tags = str().slice(1);
  const args: (string | number | boolean)[] = [];
  for (const t of tags) {
    if (t === "s") args.push(str());
    else if (t === "i") (args.push(b.readInt32BE(o)), (o += 4));
    else if (t === "f") (args.push(b.readFloatBE(o)), (o += 4));
    else if (t === "T" || t === "F") args.push(t === "T");
  }
  return { address, args };
}

if (port) {
  const sock = createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  const replyPort = sock.address().port;
  const inbox: { address: string; args: (string | number | boolean)[]; at: number }[] = [];
  sock.on("message", (b) => inbox.push({ ...decode(b), at: performance.now() }));
  /** Send one packet and collect what comes back within `ms`. */
  const exchange = async (address: string, args: OscWireArg[], ms = 300) => {
    const from = inbox.length;
    const t0 = performance.now();
    await new Promise<void>((r, j) => sock.send(encode(address, args), port, "127.0.0.1", (e) => (e ? j(e) : r())));
    await new Promise((r) => setTimeout(r, ms));
    const got = inbox.slice(from);
    console.log(`  → ${formatOsc(address, args)}`);
    for (const g of got) console.log(`  ← ${g.address} ${g.args.map((a) => JSON.stringify(a)).join(" ")}  (${(g.at - t0).toFixed(1)} ms)`);
    return got.map((g) => parseStageLightReply(g.address, g.args));
  };
  console.log(`\nStageLight desk on 127.0.0.1:${port} (replies to :${replyPort})`);
  const ping = stageLightPing(replyPort);
  const h = await exchange(ping.address, ping.args);
  const hi = h.find((r) => r?.kind === "hello");
  ok("desk: ping → hello", !!hi);
  if (hi?.kind === "hello" && hi.catalogRevision !== null) {
    const req = stageLightCatalogRequest(replyPort);
    const from = inbox.length;
    const t0 = performance.now();
    await new Promise<void>((r, j) => sock.send(encode(req.address, req.args), port, "127.0.0.1", (e) => (e ? j(e) : r())));
    await new Promise((r) => setTimeout(r, 500));
    const got = inbox.slice(from);
    console.log(`  → ${formatOsc(req.address, req.args)}`);
    console.log(`  ← ${got.length} messages, last after ${got.length ? (got[got.length - 1].at - t0).toFixed(1) : "-"} ms: ${got.slice(0, 3).map((g) => g.address).join(", ")} …`);
    let a: CatalogAssembly | null = null;
    let res: { done?: StageLightCatalog; incomplete?: string } = {};
    for (const g of got) {
      const r = parseStageLightReply(g.address, g.args);
      if (!r) continue;
      const step = catalogStep(a, r);
      a = step.assembly;
      if (step.done || step.incomplete) res = step;
    }
    ok("desk: catalog complete", !!res.done, res.incomplete ?? (res.done ? `revision ${res.done.revision}: ${res.done.pages.map((p) => `${p.name} (${p.cues.length})`).join(", ")}; triggers ${res.done.triggers.map((t) => t.name).join(", ")}; ${res.done.library.length} library cues` : "no end"));
  } else console.log("  (this StageLight has no catalog: hello has 5 arguments)");
  const go = stageLightOsc({ type: "stagelight", op: "go", page: argOf("--page") ?? "1" });
  ok("desk: GO accepted", !(await exchange(go.address, go.args)).some((r) => r?.kind === "error"));
  const tr = stageLightOsc({ type: "stagelight", op: "trigger", name: argOf("--trigger") ?? "test" });
  ok("desk: trigger accepted", !(await exchange(tr.address, tr.args)).some((r) => r?.kind === "error"));
  const bad = stageLightOsc({ type: "stagelight", op: "trigger", name: "no.such.trigger.check" });
  ok("desk: unknown trigger refused", (await exchange(bad.address, bad.args)).some((r) => r?.kind === "error"));
  sock.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
