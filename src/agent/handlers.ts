// What each agent command does in the operator window. `handlers` must cover every command in
// spec.ts (TypeScript enforces it), so a new command cannot ship without an implementation.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { clamp, now, sceneNow } from "@/core/clock";
import { clipStateAt } from "@/core/clipActor";
import { EFFECT_DEFS } from "@/core/effects";
import * as factories from "@/core/factories";
import { defaultTransition, makeClip, makeCue, makeScene, makeShot } from "@/core/factories";
import { normalizeGroups, sceneCodes, sceneRows } from "@/core/groups";
import { uid } from "@/core/ids";
import { assetTypeFor, closeOutputWindow, isTauri, openOutputWindow, revealAsset, saveGeneratedAsset } from "@/core/platform";
import { levelDifferences, SOUND_LEVELS, type MergeChoice } from "@/core/showMerge";
import { CloudAheadError, listCloudShows, loadCloudSettings } from "@/core/cloud";
import type { ImportPreview, IncomingPackage } from "@/core/showPackage";
import { cloudOpen, cloudPush, exportShowPackage, isLive, openShowPackage, takeInShowPackage } from "@/engine/showTransfer";
import { applyUpdate, checkForUpdate, downloadUpdate, installBlocker, useUpdater } from "@/engine/updater";
import * as runtime from "@/core/runtime";
import type { Asset, AssetType, Cue, CueAction, CueActionType, IoMessage, MediaMarker, Project, Scene, SceneComponent, SceneRuntime, TransitionSpec } from "@/core/types";
import { markerHosts, setHostMarkers, type MarkerHost } from "@/core/markers";
import { normalizeStageLight, resolveWithCatalog, STAGELIGHT_OPS } from "@/core/stageLight";
import { pingStageLight, requestStageLightCatalog, stageLightAnswer, stageLightCatalog, stageLightReach, stageLightWire, useStageLight } from "@/engine/stageLight";
import { contextScene, describeMessage, injectIncoming, sendMessage, soundWire, useIo, type IncomingMessage } from "@/engine/io";
import { soundAppReach, useSoundApp } from "@/engine/soundApp";
import { normalizeSound } from "@/core/soundControl";
import * as ops from "@/engine/operator";
import * as transport from "@/engine/transport";
import { assetProblems, checkAsset, ingestAssets, mediaTools, optimiseAsset } from "@/engine/media";
import { describeProbe } from "@/core/mediaCheck";
import { audioRoleOf, liveAudioSources } from "@/engine/mixer";
import { filePos, lifePlaying, soundLives } from "@/core/music";
import { chaseMusicOn, musicAt, soundDuration } from "@/engine/musicChase";
import { DANTE_WDM_STEPS, danteAsioOnly, getAudioRoute, nativeOutputs, setAudioRoute, webDefaultName, webOutputs, webOutputsHidden, type AudioRoute } from "@/engine/audioOutput";
import { cancelPending, cueControl, pendingCount, playAnnouncement, previewAtStep, previewAtTime, runCue, runTimer, stopAnnouncement, takeScene } from "@/engine/operator";
import { layoutScene } from "@/engine/timeline";
import { requestSnap } from "@/render/snap";
import { useProject } from "@/store/project";
import { useShow, type Target } from "@/store/show";
import { ACTION_INFO, SEND_PRESETS, defaultAction, type MenuType } from "@/ui/builder/CueEditor";
import { getErrors } from "@/ui/ErrorBoundary";
import { defaultMarkerMessage, defaultMessage } from "@/ui/io/MessageFields";
import { TRANSITIONS } from "@/ui/show/ShowMode";
import { applyOps, deepMerge, findScene, getPath, isObj, resolve, splitPath, summarize, type PatchOp } from "./paths";
import { AGENT_SPEC_VERSION, type AgentCommand } from "./spec";

type Args = Record<string, any>;
type Handler = (a: Args) => unknown;

/** A handler result that carries a picture. */
export class AgentImage {
  constructor(
    public dataUrl: string,
    public meta: unknown,
  ) {}
}

// ---------------------------------------------------------------- lookups

const P = () => useProject.getState();
const S = () => useShow.getState();

function sceneOf(ref: unknown): Scene {
  const p = P().project;
  const s = findScene(p, String(ref ?? ""));
  if (s) return s;
  const codes = sceneCodes(p);
  throw new Error(`No scene "${ref}". Scenes: ${p.scenes.map((x) => `${codes.get(x.id)} ${x.name}`).join("; ")}`);
}

function componentOf(scene: Scene, ref: unknown): SceneComponent {
  const r = String(ref ?? "");
  const c = scene.components.find((x) => x.id === r) ?? scene.components.find((x) => x.name === r) ?? scene.components.find((x) => x.name.toLowerCase() === r.toLowerCase());
  if (c) return c;
  throw new Error(`No component "${r}" in ${scene.name}. Components: ${scene.components.map((x) => `${x.name} (${x.kind}, ${x.id})`).join("; ")}`);
}

function cueIndexOf(scene: Scene, ref: unknown): number {
  const r = String(ref ?? "");
  let i = scene.cues.findIndex((c) => c.id === r);
  if (i < 0) i = scene.cues.findIndex((c) => c.name === r);
  if (i < 0 && /^#\d+$/.test(r)) i = Number(r.slice(1)) - 1;
  if (i < 0 || !scene.cues[i]) throw new Error(`No cue "${r}" in ${scene.name}. Cues: ${scene.cues.map((c, k) => `#${k + 1} ${c.name} (${c.id})`).join("; ")}`);
  return i;
}

function byIdOrName<T extends { id: string; name: string }>(list: T[] | undefined, ref: unknown, what: string): T {
  const r = String(ref ?? "");
  const x = list?.find((t) => t.id === r) ?? list?.find((t) => t.name === r) ?? list?.find((t) => t.name.toLowerCase() === r.toLowerCase());
  if (!x) throw new Error(`No ${what} "${r}". Available: ${(list ?? []).map((t) => `${t.name} (${t.id})`).join("; ") || "none"}`);
  return x;
}

const groupOf = (ref: unknown) => byIdOrName(P().project.groups, ref, "group");

function rtFor(target: Target, need = true): SceneRuntime | null {
  if (target !== "program" && target !== "preview") throw new Error('target must be "preview" or "program"');
  const rt = target === "program" ? S().program.runtime : S().preview;
  if (!rt && need) throw new Error(target === "program" ? "Nothing is live: take a scene first" : "No scene in the preview: select one first");
  return rt;
}

/** Edit one scene of the show file. */
function editScene(sceneId: string, fn: (s: Scene, p: Project) => void) {
  P().update((p) => {
    const s = p.scenes.find((x) => x.id === sceneId);
    if (!s) throw new Error("Scene vanished");
    fn(s, p);
  });
}

const brief = (s: Scene | null | undefined) => (s ? { id: s.id, code: sceneCodes(P().project).get(s.id) ?? String(s.number), name: s.name } : null);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const cueBrief = (c: Cue | undefined, i: number) => (c ? { index: i, id: c.id, name: c.name, notes: c.notes || undefined, fire: c.fire ?? { mode: "go" }, actions: c.actions.length } : null);

function transitionOf(t: unknown): TransitionSpec | undefined {
  if (!t) return undefined;
  if (!isObj(t)) throw new Error("transition must be an object");
  return { ...defaultTransition(), ...(t as Partial<TransitionSpec>) };
}

function normalizeAction(a: unknown): CueAction {
  if (!isObj(a) || typeof a.type !== "string") throw new Error("An action needs a type (see schema topic cueActions)");
  const real = (Object.keys(ACTION_INFO) as MenuType[]).filter((t) => !SEND_PRESETS[t]);
  if (!real.includes(a.type as MenuType)) throw new Error(`Unknown action type "${a.type}". Types: ${real.join(", ")} (Hog and StageLight lighting and StageMics are type "send" with a hog / stagelight / sound message)`);
  if (a.type === "send") return { delay: 0, ...a, message: normalizeMessage(a.message) } as CueAction;
  return { delay: 0, ...a } as CueAction;
}

/**
 * A message in its stored shape: StageLight messages are checked and tidied (see normalizeStageLight),
 * and names or numbers StageLight's catalog knows become its IDs; a StageMics sceneId may be any scene
 * reference. Others pass through.
 */
function normalizeMessage(m: unknown): IoMessage {
  if (!isObj(m) || typeof m.type !== "string") throw new Error("A message needs a type (see schema topic io)");
  if (m.type === "stagelight") return resolveWithCatalog(normalizeStageLight(m), stageLightCatalog());
  if (m.type === "sound") {
    const out = normalizeSound(m);
    if ("sceneId" in out && out.sceneId) out.sceneId = sceneOf(out.sceneId).id;
    return out;
  }
  return m as unknown as IoMessage;
}

function stageLightStatus() {
  const link = P().project.io?.stagelight;
  const s = useStageLight.getState();
  const ago = (at: number) => Math.round((Date.now() - at) / 1000);
  return {
    enabled: !!link?.enabled,
    host: link?.host,
    port: link?.port,
    mirror: !!link?.mirror,
    reach: stageLightReach(),
    note: link?.enabled && !P().project.io?.osc.enabled ? 'OSC listen is off, so StageLight\'s replies are not seen (reach stays "sent"). Switch it on with patch project/io/osc/enabled = true.' : undefined,
    pingError: s.pingError ?? undefined,
    hello: s.hello ? { version: s.hello.version, outputArmed: s.hello.armed, runningPage: s.hello.page, runningCue: s.hello.cue, from: s.hello.from, secondsAgo: ago(s.hello.at) } : null,
    lastGo: s.live ? { page: s.live.pageName, pageId: s.live.pageId, cueNumber: s.live.cueNumber, cueName: s.live.cueName, secondsAgo: ago(s.live.at) } : null,
    lastRefusal: s.error ? { address: s.error.address, message: s.error.message, secondsAgo: ago(s.error.at) } : null,
    catalog: {
      state: s.catalogState,
      ...(link?.catalog
        ? { revision: link.catalog.revision, from: link.catalog.from, pages: link.catalog.pages.length, cues: link.catalog.pages.reduce((n, p) => n + p.cues.length, 0), triggers: link.catalog.triggers.length, library: link.catalog.library.length }
        : {}),
    },
  };
}

/** A video in a scene that carries markers: by component id / name, plus the clip for a video actor. */
function markerHostOf(scene: Scene, media: unknown, clip: unknown): MarkerHost {
  const hosts = markerHosts(scene);
  const r = String(media ?? "");
  const exact = hosts.find((h) => h.key === r || h.label === r);
  if (exact) return exact;
  if (!r) throw new Error(`Name the video (media). Videos: ${hosts.map((h) => h.label).join("; ") || "none in this scene"}`);
  const comp = componentOf(scene, r);
  const mine = hosts.filter((h) => h.compId === comp.id);
  if (!mine.length) throw new Error(`${comp.name} carries no markers (only video layers, media backgrounds and video actors' clips do)`);
  if (mine.length === 1 && mine[0].clipId === null) return mine[0];
  if (comp.kind !== "clipActor") return mine[0];
  const c = String(clip ?? "");
  const k = comp.clips.find((x) => x.id === c) ?? comp.clips.find((x) => x.name === c) ?? comp.clips.find((x) => x.name.toLowerCase() === c.toLowerCase());
  if (!k) throw new Error(`Name the clip of ${comp.name}: ${comp.clips.map((x) => `${x.name} (${x.id})`).join("; ")}`);
  return mine.find((h) => h.clipId === k.id)!;
}

function markerBrief(scene: Scene, m: MediaMarker) {
  const i = m.cueId ? scene.cues.findIndex((c) => c.id === m.cueId) : -1;
  return { ...m, does: m.cueId ? (i >= 0 ? `runs cue #${i + 1} ${scene.cues[i].name}` : "runs a cue that no longer exists") : describeMessage(m.message) };
}

function normalizeCue(c: Args, base?: Cue): Cue {
  const cue: any = base ? deepMerge(structuredClone(base) as any, c) : { ...makeCue("Cue"), notes: "", ...structuredClone(c) };
  // Check the actions given; a cue's other actions stay as they are (a half-filled one must not block renaming it).
  if (!base || c.actions !== undefined) cue.actions = ((cue.actions ?? []) as unknown[]).map(normalizeAction);
  cue.id ||= uid("cue");
  return cue as Cue;
}

function sceneSummary(s: Scene) {
  return { ...brief(s), components: s.components.map((c) => ({ id: c.id, name: c.name, kind: c.kind })), cues: s.cues.map((c, i) => cueBrief(c, i)) };
}

function runtimeSummary(target: Target, rt: SceneRuntime) {
  const t = sceneNow(rt);
  const sc = rt.scene;
  const fired = new Set(rt.fired ?? []);
  return {
    target,
    scene: brief(sc),
    sceneTime: round(t / 1000),
    frozen: rt.clock.pausedAt !== null,
    cuePointer: rt.cuePointer,
    nextCue: cueBrief(sc.cues[rt.cuePointer], rt.cuePointer),
    nextCueAuto: runtime.nextCueIsAuto(rt, t / 1000),
    cues: sc.cues.map((c, i) => ({ index: i, id: c.id, name: c.name, fired: fired.has(c.id), fire: c.fire ?? { mode: "go" } })),
    background: rt.background.current ? { id: rt.background.current, name: sc.components.find((c) => c.id === rt.background.current)?.name } : null,
    layers: Object.entries(rt.layers).map(([id, l]) => ({ id, name: sc.components.find((c) => c.id === id)?.name, visible: l.visible })),
    effects: Object.entries(rt.effects).map(([id, e]) => {
      const c = sc.components.find((x) => x.id === id);
      return { id, name: c?.name, effect: c?.kind === "effect" ? c.effect : undefined, active: e.active, params: e.params };
    }),
    clipActors: sc.components.flatMap((c) => {
      if (c.kind !== "clipActor") return [];
      const st = clipStateAt(c, rt.clipActors?.[c.id], t);
      return [{ id: c.id, name: c.name, clip: st.clip ? { id: st.clip.id, name: st.clip.name, at: round(st.localT) } : null }];
    }),
    timeOfDay: round(runtime.envAt(rt, t).timeOfDay),
    framing: runtime.evalFraming(rt.framing, t),
    pendingActions: pendingCount(target),
  };
}

function soundAppStatus() {
  const io = P().project.io;
  if (!io?.sound?.enabled) return "off";
  const s = useSoundApp.getState();
  return {
    host: io.sound.host,
    port: io.sound.port,
    reach: soundAppReach(),
    note: io.osc.enabled ? undefined : "OSC listen is off, so StageMics' replies are not seen (status stays \"sent\").",
    hello: s.hello ? { appVersion: s.hello.appVersion, protocol: s.hello.protocol, deskConnected: s.hello.deskConnected, secondsAgo: Math.round((Date.now() - s.hello.at) / 1000) } : null,
    activeCue: s.cue,
    mics: Object.entries(s.mics).map(([n, x]) => ({ mic: Number(n), name: x.name, live: x.live })),
  };
}

// ---------------------------------------------------------------- schema reference

/** The editor's default message (a StageMics one that does something visible). */
function exampleMessage(t: IoMessage["type"]): IoMessage {
  if (t === "sound") return { type: "sound", op: "mic", who: "Joseph", live: false };
  return defaultMessage(t);
}

function schemaDoc(topic: string) {
  const strip = <T extends object>(o: T) => {
    const c: any = structuredClone(o);
    delete c.id;
    return c;
  };
  const p = P().project;
  const scene = p.scenes.find((s) => s.id === P().selectedSceneId) ?? p.scenes[0] ?? makeScene(1, "Example");
  const out: Record<string, unknown> = {};
  if (topic === "components" || topic === "all") {
    out.components = {
      note: "component_add builds these defaults; pass `props` to override. Every component also has id, name, initiallyVisible (shown when the scene is taken). Backgrounds stack like layers: the scene opens on the first one in component order with initiallyVisible (none marked: the first background).",
      background: strip(factories.makeBackground("Background")),
      video: strip(factories.makeVideoLayer("Video")),
      image: strip(factories.makeImageLayer("Image")),
      model: strip(factories.makeModel("Model")),
      actor: strip(factories.makeLion()),
      effect: { ...strip(factories.makeEffect("rain")), note: "effect: one of the effect types (schema topic effects); params default from the effect." },
      procedural: { ...strip(factories.makeProcedural("birds")), note: "element: birds | sheep | campfire | town-lights" },
      clipActor: { ...strip(factories.makeClipActor()), clipExample: strip(makeClip("Clip")) },
      text: strip(factories.makeText()),
      names: strip(factories.makeNames()),
      route: strip(factories.makeRoute()),
      cameraShot: strip(makeShot("Shot")),
      mediaMarker: { id: "auto", name: "Marker", at: 2.5, message: { type: "stagelight", op: "trigger", name: "lion.leap" }, cueId: null, note: "In media.markers (video/background) or clips[].markers; the markers tool edits them by video name. cueId fires that cue instead of sending message." },
    };
  }
  if (topic === "cueActions" || topic === "all") {
    out.cueActions = {
      note: "Examples are built for the selected scene, so ids are real where it has such components. Every action has delay (seconds after the cue fires).",
      musicChase: "Show-wide project/chaseMusic (default true): firing a cue out of order (by hand, ahead of cues not run yet, or back) or taking a scene out of running order starts the music that would be playing there at the second it would have reached (0.5 s fade-in) and fades out what would not be. project/cueTimings (scene id → cue id or \"@end\" → seconds after TAKE) is learned from runs in sequence; music_at shows the result.",
      sound: 'sound: keepPlaying = carry on into the next scene (default: fades out on the next take); a scene with stopCarriedSounds: true fades such carried sounds out when it is taken. loop = start again from the top until faded out (a music bed). fadeOthers = fade other audio out as it starts: {which: "all", fade: 3} (every other cue sound and every video\'s sound on the wall) or {which: ["sound:<assetId>", "<componentId>"], fade: seconds} (mixer keys); add delay: seconds to hold them before their fade starts; null leaves other audio alone. audio.fade = fade audio out at that moment without starting anything: {type: "audio.fade", which: ["sound:<assetId>"] | "all", fade: seconds} (where a music bed stops). fadeIn = seconds this sound fades in from silence. trimStart = seconds cut off the top of the file (it starts that far in; a loop goes back there; the Build timeline\'s left edge drags it, moving the start by as much so the rest stays in place). levels = [{at, level, fade}] level changes as it plays (at: seconds after it starts, level: share of its volume, 0.6 = 40% down, fade: seconds to glide), e.g. a duck under a live voice; they carry into the next scene with the sound. fadeOut = seconds it fades out over before its file ends (a fade that stops it earlier is an audio.fade or another sound\'s fadeOthers). A crossfade: {fadeIn: 2, fadeOthers: {which: [...], fade: 2, delay: 1}}.',
      fire: 'Cue.fire: {mode: "go"} (default) | {mode: "time", at: seconds after TAKE} | {mode: "follow", after: seconds after the previous cue} | {mode: "video"} (fired by a media marker whose cueId is this cue). A GO cue may carry hold: planned seconds after the cue before, for the Build timeline only.',
      types: (Object.keys(ACTION_INFO) as MenuType[]).map((t) => {
        const preset = SEND_PRESETS[t];
        return preset
          ? { type: "send", label: ACTION_INFO[t].label, example: { type: "send", message: preset === "stagelight" ? { type: "stagelight", op: "goCue", page: "Act 1", cue: "4" } : exampleMessage(preset), delay: 0 } }
          : { type: t, label: ACTION_INFO[t].label, example: defaultAction(t as CueActionType, scene, p.scenes) };
      }),
    };
  }
  if (topic === "effects" || topic === "all") {
    out.effects = Object.values(EFFECT_DEFS).map((d) => ({ type: d.type, label: d.label, mode: d.mode, defaults: d.defaults, params: d.params }));
  }
  if (topic === "transitions" || topic === "all") {
    out.transitions = { kinds: TRANSITIONS, default: defaultTransition(), note: "video needs videoAssetId; wipe uses direction + softness; travel uses travelDistance." };
  }
  if (topic === "io" || topic === "all") {
    out.io = {
      outgoing: (["hog", "stagelight", "sound", "osc", "msc", "midi.note", "midi.cc", "midi.pc"] as IoMessage["type"][]).map((t) => exampleMessage(t)),
      hogNote: "hog.item is a lighting-library item id (io_send also accepts its name); number/kind are the fallback. Playback numbers are strings.",
      sound: {
        note: "StageMics (OSC to io.sound host:port, 1451; switched on with io.sound.enabled). sceneId null = the LiveStage scene the cue or marker belongs to. who = mic number or character name. A time marker that sends mic/fx makes LiveStage send restore once if that media then stops, restarts or is scrubbed before its end.",
        shapes: [
          { type: "sound", op: "sceneSelect", sceneId: null },
          { type: "sound", op: "sceneActivate", sceneId: null },
          { type: "sound", op: "cueGo", sceneId: null, cue: 1 },
          { type: "sound", op: "cueNext" },
          { type: "sound", op: "sceneEnd" },
          { type: "sound", op: "mic", who: "Joseph", live: false },
          { type: "sound", op: "fx", who: "Joseph", preset: "none", amount: "medium" },
          { type: "sound", op: "restore" },
          { type: "sound", op: "panic" },
        ],
      },
      stagelight: {
        note: "StageLight, the lighting desk (OSC to io.stagelight host:port; on with io.stagelight.enabled, set up with stagelight_link). Pages and cues are StageLight's: name (case-insensitive), ID or 1-based number. A cue that is a plain number goes as an OSC int, else as text. Named triggers are mapped inside StageLight, so prefer them for anything StageLight may renumber. fade null = StageLight's default. cue_add, cue_update, run_action, io_send, upsert and markers check these and accept op aliases (\"go/cue\" = goCue) and numbers for page / cue.",
        ops: STAGELIGHT_OPS.map((o) => o.op),
        shapes: [
          { type: "stagelight", op: "go", page: "" },
          { type: "stagelight", op: "goCue", page: "Act 1", cue: "4" },
          { type: "stagelight", op: "trigger", name: "lion.leap" },
          { type: "stagelight", op: "back" },
          { type: "stagelight", op: "stop", fade: null },
          { type: "stagelight", op: "clear", fade: 2 },
          { type: "stagelight", op: "blackout", on: true },
          { type: "stagelight", op: "master", level: 0.8 },
          { type: "stagelight", op: "play", cue: "Warm wash", fade: null },
          { type: "stagelight", op: "ledwall", media: "off" },
        ],
        osc: {
          go: '/stagelight/go [s:page]',
          goCue: '/stagelight/go/cue s:page i|s:cue',
          trigger: '/stagelight/trigger s:name',
          back: "/stagelight/back",
          stop: "/stagelight/stop [f:fade]",
          clear: "/stagelight/clear [f:fade]",
          blackout: "/stagelight/blackout i:0|1",
          master: "/stagelight/master f:0..1",
          play: "/stagelight/play s:cue [f:fade]",
          ledwall: "/stagelight/ledwall s:media",
        },
        mirror: 'io.stagelight.mirror: every live TAKE also sends trigger "scene.<code>", every GO "cue.<code>.<n>" (code as in list_scenes).',
      },
      incoming: [{ kind: "osc", address: "/sls/go", args: [] }, { kind: "midi", bytes: [144, 60, 127] }],
      triggerActions: ["go", "back", "take {sceneId}", "takeNext", "fireCue {sceneId, index}", "blackout {on: true|false|\"toggle\"}", "standby {on}", "freeze {op}", "select {sceneId}", "selectNext", "selectPrev"],
      oscTargets: p.io?.osc.targets ?? [],
      hogItems: p.io?.hogItems ?? [],
    };
  }
  out.paths =
    'Paths start with project | show | io | ui. Lists are addressed by item id, then exact name, then index ("-" = append); scenes also by code ("1.2") or number. E.g. project/scenes/1.2/components/Rain/params/intensity.';
  return out;
}

// ---------------------------------------------------------------- asset import

const MIME: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", glb: "model/gltf-binary", gltf: "model/gltf+json" };

async function importAsset(a: Args): Promise<Asset> {
  const name: string = a.name || a.fileName || (a.url ? String(a.url).split(/[\\/]/).pop() : "") || "asset";
  const type = (a.type as AssetType | undefined) ?? assetTypeFor(a.fileName || a.url || name);
  if (!type) throw new Error(`Cannot tell the media type of "${name}"; pass type`);
  const hasAlpha = typeof a.hasAlpha === "boolean" ? a.hasAlpha : /\.(png|webp|webm)$|alpha/i.test(a.fileName || a.url || name);
  if (a.url) return { id: uid("asset"), name, type, url: String(a.url), hasAlpha };
  if (typeof a.data !== "string") throw new Error("Give a file or a url");
  const bin = atob(a.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = String(a.fileName ?? name).split(".").pop()?.toLowerCase() ?? "";
  if (isTauri) {
    const saved = await saveGeneratedAsset(bytes, a.fileName || name, type);
    return { ...saved, name, hasAlpha };
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" }));
  return { id: uid("asset"), name, type, url, ephemeral: true, hasAlpha };
}

// ---------------------------------------------------------------- show packages and cloud versions

/** Plan, then (unless a dry run or an unanswered conflict) take in a package or cloud version. */
async function takeInIncoming({ pkg, preview }: { pkg: IncomingPackage; preview: ImportPreview }, a: Args) {
  const mode: "merge" | "replace" = a.mode === "merge" || a.mode === "replace" ? a.mode : preview.unrelated ? "replace" : "merge";
  const choices: Record<string, MergeChoice> = { ...(isObj(a.choices) ? (a.choices as Record<string, MergeChoice>) : {}) };
  const conflicts = preview.plan.items.filter((x) => x.state === "conflict");
  for (const c of conflicts) if (!choices[c.key] && (a.resolve === "local" || a.resolve === "incoming")) choices[c.key] = a.resolve;
  const plan = {
    show: pkg.manifest.showName,
    version: pkg.manifest.version,
    from: pkg.manifest.from,
    createdAt: pkg.manifest.createdAt,
    localVersion: preview.localVersion,
    older: preview.older || undefined,
    mode,
    conflicts: conflicts.map((x) => ({ key: x.key, label: x.label, here: x.here, incoming: x.upstream, options: x.options })),
    incoming: preview.plan.items.filter((x) => x.state === "incoming").map((x) => ({ key: x.key, label: x.label, change: x.upstream })),
    keptLocal: preview.plan.items.filter((x) => x.state === "local").map((x) => ({ key: x.key, label: x.label, change: x.here })),
    unchanged: preview.plan.items.filter((x) => x.state === "same").length,
    files: pkg.manifest.files.length,
    missingInSource: pkg.manifest.missing.length ? pkg.manifest.missing : undefined,
  };
  if (a.dryRun) return { applied: false, plan };
  // Replacing the whole show still asks about this computer's sound levels.
  const open = conflicts.filter((c) => !choices[c.key] && (mode === "merge" || c.key === SOUND_LEVELS));
  if (open.length) return { applied: false, reason: `${open.length} conflict(s) need a choice (choices or resolve)`, plan };
  if (isLive() && !a.allowLive) throw new Error("A scene is live on the wall. Ask the operator, then pass allowLive: true to take it in anyway.");
  return { applied: true, plan, result: await takeInShowPackage(pkg, { mode, choices, allowLive: !!a.allowLive }) };
}

// ---------------------------------------------------------------- the handlers

function listOf(draft: Project, path: string): unknown[] {
  const { root, segs } = splitPath(path);
  if (root !== "project") throw new Error("Only lists in the show file (project/...) can be edited");
  const { value } = resolve(draft, segs);
  if (!Array.isArray(value)) throw new Error(`${path} is not a list`);
  return value;
}

function compKindDefaults(a: Args): SceneComponent {
  const name: string | undefined = a.name;
  switch (a.kind) {
    case "background":
      return factories.makeBackground(name ?? "Background");
    case "video":
      return factories.makeVideoLayer(name ?? "Video");
    case "image":
      return factories.makeImageLayer(name ?? "Image");
    case "model":
      return factories.makeModel(name ?? "Model");
    case "actor":
      return factories.makeLion(name);
    case "effect":
      if (!a.effect || !(a.effect in EFFECT_DEFS)) throw new Error(`kind effect needs effect: ${Object.keys(EFFECT_DEFS).join(", ")}`);
      return factories.makeEffect(a.effect, name ? { name } : {});
    case "procedural":
      if (!["birds", "sheep", "campfire", "town-lights"].includes(a.element)) throw new Error("kind procedural needs element: birds, sheep, campfire or town-lights");
      return factories.makeProcedural(a.element, name ? { name } : {});
    case "clipActor":
      return factories.makeClipActor(name);
    case "text":
      return factories.makeText(name);
    case "names":
      return factories.makeNames(name);
    case "route":
      return factories.makeRoute(name);
    default:
      throw new Error(`Unknown component kind "${a.kind}"`);
  }
}

/** Clips given in props arrive as plain objects: give each an id and the factory's defaults (a clip action needs the id). */
function normalizeClips(c: SceneComponent) {
  if (c.kind !== "clipActor" || !Array.isArray(c.clips)) return;
  c.clips = c.clips.map((clip) => makeClip(clip.name ?? "Clip", clip));
}

function storeOf(name: unknown): Record<string, unknown> {
  if (name === "project") return P() as unknown as Record<string, unknown>;
  if (name === "show") return S() as unknown as Record<string, unknown>;
  throw new Error('store must be "project" or "show"');
}

export const handlers: Record<AgentCommand, Handler> = {
  // ------------------------------------------------ look
  status() {
    const p = P();
    const s = S();
    const prog = s.program;
    const live = prog.runtime;
    const outputUp = !!s.outputStatus && Date.now() - s.outputSeenAt < 3500;
    const io = useIo.getState();
    return {
      app: { specVersion: AGENT_SPEC_VERSION, dev: import.meta.env.DEV, desktop: isTauri, mode: p.mode, show: p.project.name, scenes: p.project.scenes.length, unsaved: p.dirty, saveError: p.saveError },
      selected: { scene: brief(p.project.scenes.find((x) => x.id === p.selectedSceneId)), componentId: p.selectedComponentId },
      live: live ? runtimeSummary("program", live) : null,
      wall: {
        standby: prog.standby,
        blackout: !!prog.blackout?.on,
        transitionRunning: !!prog.transition,
        timerOnScreen: prog.timerOverlay?.label ?? null,
        announcement: prog.announce && !prog.announce.stoppedAt ? prog.announce.id : null,
        mixerTrims: prog.mix ?? {},
      },
      preview: s.preview ? { scene: brief(s.preview.scene), cuePointer: s.preview.cuePointer, sceneTime: round(sceneNow(s.preview) / 1000), solo: s.solo, hidden: s.hidden } : null,
      output: { open: outputUp, status: outputUp ? s.outputStatus : null, lost: !!s.outputLostAt },
      timers: (p.project.timers ?? []).map((t) => {
        const r = prog.timers?.[t.id];
        const left = r ? (r.running ? Math.max(0, (r.endsAt - now()) / 1000) : r.remaining) : t.duration;
        return { id: t.id, name: t.name, running: !!r?.running, secondsLeft: round(left, 1) };
      }),
      io: {
        midi: io.midiStatus,
        osc: io.oscStatus,
        counters: io.counters,
        available: io.available,
        soundApp: soundAppStatus(),
        stagelight: p.project.io?.stagelight?.enabled ? stageLightReach() : "off",
      },
      nextTransition: s.nextTransition,
      recentErrors: getErrors().slice(-5).map((e) => e.text),
    };
  },

  list_scenes(a) {
    const p = P().project;
    const live = S().program.runtime?.scene.id;
    const sel = P().selectedSceneId;
    const q = a.query ? String(a.query).toLowerCase() : null;
    const rows = sceneRows(p);
    const codes = sceneCodes(p);
    const scene = (s: Scene) => ({
      code: codes.get(s.id),
      id: s.id,
      name: s.name,
      environment: s.environment,
      components: s.components.length,
      cues: s.cues.length,
      selected: s.id === sel || undefined,
      live: s.id === live || undefined,
    });
    return rows.flatMap((r): unknown[] => {
      if (r.kind === "scene") return !q || r.scene.name.toLowerCase().includes(q) ? [scene(r.scene)] : [];
      const scenes = r.scenes.filter((s) => !q || s.name.toLowerCase().includes(q));
      return scenes.length ? [{ group: { id: r.group.id, code: r.code, name: r.group.name, color: r.group.color, flow: r.group.flow }, scenes: scenes.map(scene) }] : [];
    });
  },

  get_scene(a) {
    const s = sceneOf(a.scene);
    return { code: brief(s)!.code, ...(summarize(s, 20) as object) };
  },

  async timeline(a) {
    const s = a.scene != null ? sceneOf(a.scene) : P().project.scenes.find((x) => x.id === P().selectedSceneId);
    if (!s) throw new Error("No scene selected: pass scene");
    const tl = await layoutScene(s);
    return {
      scene: brief(s),
      end: tl.end,
      takeAt: tl.takeAt,
      cues: tl.cues,
      tracks: tl.tracks.map((t) => ({
        id: t.id,
        label: t.label,
        group: t.group,
        componentId: t.componentId,
        items: tl.items
          .filter((it) => it.track === t.id)
          .map(({ id: _id, track: _t, lane: _l, ...it }) => it),
      })),
    };
  },

  get_runtime(a) {
    return runtimeSummary(a.target, rtFor(a.target)!);
  },

  list_assets(a) {
    const q = a.query ? String(a.query).toLowerCase() : null;
    return P()
      .project.assets.filter((x) => (!a.type || x.type === a.type) && (!q || x.name.toLowerCase().includes(q)))
      .map((x) => {
        const problems = assetProblems(x);
        return {
          id: x.id,
          name: x.name,
          type: x.type,
          url: x.url.startsWith("blob:") || x.url.length > 200 ? undefined : x.url,
          hasAlpha: x.hasAlpha || undefined,
          audioRole: x.type === "audio" ? (audioRoleOf(x) ?? undefined) : undefined,
          builtIn: x.builtIn || undefined,
          ephemeral: x.ephemeral || undefined,
          format: x.probe ? describeProbe(x.probe) : undefined,
          optimised: x.optimised ? `from ${x.optimised.from}` : undefined,
          problems: problems.length ? problems.map((p) => `${p.severity}: ${p.message}`) : undefined,
        };
      });
  },

  async asset_check(a) {
    const all = P().project.assets.filter((x) => x.type === "video");
    const list = a.asset ? [byIdOrName(all, a.asset, "video asset")] : all;
    if (!isTauri) return { tools: null, assets: list.map((x) => ({ id: x.id, name: x.name, note: "browser session: files cannot be probed" })) };
    const tools = await mediaTools();
    const assets = [];
    for (const x of list) {
      let asset = x;
      if ((a.reprobe || !x.probe) && x.path) {
        asset = await checkAsset(x);
        P().update((p) => {
          const i = p.assets.findIndex((y) => y.id === x.id);
          if (i >= 0) p.assets[i] = asset;
        });
      }
      const problems = assetProblems(asset);
      assets.push({
        id: asset.id,
        name: asset.name,
        file: asset.file,
        format: asset.probe ? describeProbe(asset.probe) : undefined,
        probe: asset.probe ?? (asset.path ? undefined : "not a file on this machine (ships with the app or a URL): not probed"),
        optimised: asset.optimised ? { from: asset.optimised.from, at: new Date(asset.optimised.at).toISOString(), was: describeProbe(asset.optimised.source) || undefined } : undefined,
        problems,
        playsWell: !problems.some((p) => p.severity === "error"),
        canOptimise: !!asset.path && !asset.builtIn && !asset.url.startsWith("/media/") && !asset.hasAlpha,
      });
    }
    return { wall: { canvasWidth: P().project.output.canvasWidth, canvasHeight: P().project.output.canvasHeight }, tools, assets };
  },

  async asset_optimise(a) {
    const x = byIdOrName(P().project.assets, a.asset, "asset");
    const r = await optimiseAsset(x.id, { force: !!a.force });
    return { id: r.asset.id, name: r.asset.name, file: r.asset.file, skipped: r.skipped, format: describeProbe(r.asset.probe), problems: r.problems, optimised: r.asset.optimised ? { from: r.asset.optimised.from, was: describeProbe(r.asset.optimised.source) || undefined } : undefined };
  },

  async asset_reveal(a) {
    const x = byIdOrName(P().project.assets, a.asset, "asset");
    return { id: x.id, name: x.name, revealed: await revealAsset(x) };
  },

  get(a) {
    return summarize(getPath(String(a.path)), typeof a.depth === "number" ? a.depth : 6) ?? null;
  },

  schema(a) {
    return schemaDoc(a.topic ?? "all");
  },

  async screenshot(a) {
    const target: Target = a.target;
    rtFor(target);
    const width = Math.max(160, Math.min(1920, Math.round(a.width ?? 960)));
    const dataUrl = await requestSnap(target === "program" ? "live" : "preview", width);
    const s = S();
    const meta =
      target === "program"
        ? { target, scene: brief(s.program.runtime?.scene), standbyCardOnWall: s.program.standby, blackout: !!s.program.blackout?.on, timerOnScreen: s.program.timerOverlay?.label ?? null, transitionRunning: !!s.program.transition }
        : { target, scene: brief(s.preview?.scene), solo: s.solo, hidden: s.hidden };
    return new AgentImage(dataUrl, meta);
  },

  io_log(a) {
    const n = Math.max(1, Math.min(200, a.limit ?? 40));
    return useIo.getState().log.slice(-n).map((l) => ({ at: new Date(l.at).toLocaleTimeString(), dir: l.dir, text: l.text }));
  },

  list_store_actions() {
    const fns = (o: object) => Object.entries(o).filter(([, v]) => typeof v === "function").map(([k]) => k);
    return { project: fns(P()), show: fns(S()) };
  },

  // ------------------------------------------------ run the show
  select_scene(a) {
    const s = sceneOf(a.scene);
    P().selectScene(s.id);
    return { selected: brief(s) };
  },

  async take(a) {
    const s = sceneOf(a.scene);
    await takeScene(s.id, transitionOf(a.transition));
    const live = S().program.runtime;
    if (live?.scene.id !== s.id) throw new Error("The take did not happen (another take may be in progress)");
    return { live: brief(s), transition: S().program.transition?.spec.kind ?? "cut", nextCue: cueBrief(live.scene.cues[live.cuePointer], live.cuePointer) };
  },

  cue(a) {
    const target: Target = a.target;
    rtFor(target);
    const op = a.op as string;
    if ((op === "fire" || op === "set") && typeof a.index !== "number") throw new Error(`${op} needs index`);
    switch (op) {
      case "go":
        cueControl.go(target);
        break;
      case "fire":
        cueControl.fire(target, a.index);
        break;
      case "back":
        cueControl.back(target);
        break;
      case "skip":
        cueControl.skip(target);
        break;
      case "set":
        cueControl.set(target, a.index);
        break;
      case "repeat":
        cueControl.repeat(target);
        break;
      default:
        throw new Error(`Unknown op ${op}`);
    }
    const rt = rtFor(target)!;
    return { scene: brief(rt.scene), cuePointer: rt.cuePointer, nextCue: cueBrief(rt.scene.cues[rt.cuePointer], rt.cuePointer), nextCueAuto: runtime.nextCueIsAuto(rt, sceneNow(rt) / 1000), pendingActions: pendingCount(target) };
  },

  preview_step(a) {
    rtFor("preview");
    previewAtStep(Math.max(0, Math.round(a.step)));
    return runtimeSummary("preview", rtFor("preview")!);
  },

  async preview_time(a) {
    const rt = rtFor("preview")!;
    const s = P().project.scenes.find((x) => x.id === rt.scene.id) ?? rt.scene;
    const tl = await layoutScene(s);
    previewAtTime(Number(a.seconds), tl.cues.map((c) => c.start));
    return { ...runtimeSummary("preview", rtFor("preview")!), sceneTime: round(sceneNow(rtFor("preview")!) / 1000) };
  },

  preview_run(a) {
    if (a.on === false) ops.stopRun();
    else ops.startRun(a.scene != null ? sceneOf(a.scene).id : undefined);
    return { running: ops.useRun.getState().on, ...runtimeSummary("preview", rtFor("preview")!) };
  },

  run_action(a) {
    const target: Target = a.target;
    const action = normalizeAction(a.action);
    const showWide = ["blackout", "send", "timer", "announce", "takeScene"].includes(action.type);
    rtFor(target, !showWide);
    runCue(target, { id: "agent", name: "Agent action", notes: "", actions: [action] });
    return { ran: action, target, pendingActions: pendingCount(target) };
  },

  seek(a) {
    rtFor(a.target);
    if (a.target === "program" && S().program.runtime?.clock.pausedAt == null) throw new Error('The live wall scrubs only while held: freeze {target: "program", op: "pause"} (or transport hold) first');
    S().dispatch(a.target, { type: "seek", t: Math.max(0, Number(a.seconds)) * 1000 });
    return { sceneTime: round(sceneNow(rtFor(a.target)!) / 1000) };
  },

  freeze(a) {
    rtFor(a.target);
    S().dispatch(a.target, { type: "clock", op: a.op });
    return { frozen: rtFor(a.target)!.clock.pausedAt !== null };
  },

  async transport(a) {
    const target: Target = a.target;
    const rt0 = rtFor(target)!;
    if (target === "program" && S().program.standby) throw new Error("The live wall is on standby");
    await transport.probeDurations(S().assets, transport.mediaAssetIds(rt0));
    const op = a.op ?? "status";
    const pick = () => {
      const rt = rtFor(target)!;
      const all = transport.videoSources(rt, S().assets);
      if (!a.source) return transport.mainSource(all);
      const comp = rt.scene.components.find((c) => c.name === a.source);
      return all.find((v) => v.key === a.source || v.label === a.source) ?? (comp ? all.find((v) => v.key.split(":")[0] === comp.id && v.playing) ?? all.find((v) => v.key.split(":")[0] === comp.id) : undefined);
    };
    switch (op) {
      case "status":
        break;
      case "hold":
      case "resume":
      case "toggle":
        transport.hold(target, op === "hold" ? "pause" : op);
        break;
      case "seek":
      case "nudge": {
        if (typeof a.seconds !== "number" || !Number.isFinite(a.seconds)) throw new Error(`${op} needs seconds`);
        if (target === "program" && !transport.isHeld("program")) throw new Error('The live wall scrubs only while held: transport {target: "program", op: "hold"} first');
        const src = pick();
        if (!src) throw new Error(a.source ? `No video "${a.source}" in this scene (see videos in transport status)` : "No video to scrub in this scene");
        transport.seekSource(target, src, op === "seek" ? a.seconds : src.pos + a.seconds);
        break;
      }
      default:
        throw new Error(`Unknown op ${op}`);
    }
    const rt = rtFor(target)!;
    const v = pick();
    const brief = (x: transport.Source) => ({ key: x.key, label: x.label, playing: x.playing, position: round(x.pos), duration: round(x.duration) });
    return {
      target,
      held: rt.clock.pausedAt !== null,
      sceneTime: round(sceneNow(rt) / 1000),
      video: v ? brief(v) : null,
      videos: transport.videoSources(rt, S().assets).map(brief),
    };
  },

  blackout(a) {
    S().setBlackout(!!a.on, typeof a.fade === "number" ? a.fade : 0.6);
    return { blackout: !!S().program.blackout?.on };
  },

  standby(a) {
    S().setStandby(!!a.on);
    return { standby: S().program.standby };
  },

  cancel_pending(a) {
    const n = pendingCount(a.target);
    cancelPending(a.target);
    return { cancelled: n };
  },

  restart_preview() {
    rtFor("preview");
    S().restartPreview();
    return { preview: brief(S().preview?.scene) };
  },

  timer(a) {
    const t = byIdOrName(P().project.timers, a.timer, "timer");
    if (a.op === "add") runTimer(t.id, "add", Number(a.seconds ?? 60));
    else runTimer(t.id, a.op);
    const r = S().program.timers?.[t.id];
    return { timer: t.name, running: !!r?.running, secondsLeft: r ? round(r.running ? (r.endsAt - now()) / 1000 : r.remaining, 1) : t.duration };
  },

  announce(a) {
    if (a.announcement === null) {
      stopAnnouncement();
      return { stopped: true };
    }
    const x = byIdOrName(P().project.announcements, a.announcement, "announcement");
    playAnnouncement(x.id);
    return { playing: x.name };
  },

  mixer(a) {
    if (a.reset) for (const k of Object.keys(S().program.mix ?? {})) S().setMix(k, null);
    if (a.source !== undefined || a.volume !== undefined) {
      if (typeof a.source !== "string" || typeof a.volume !== "number") throw new Error("Pass both source and volume (0..1) to set a trim.");
      const want = a.source.toLowerCase();
      const playing = liveAudioSources();
      const asset = S().assets.find((x) => x.id === a.source || x.name.toLowerCase() === want);
      const comp = S().program.runtime?.scene.components.find((c) => c.id === a.source || c.name.toLowerCase() === want);
      const key =
        playing.find((x) => x.key === a.source || x.name.toLowerCase() === want)?.key ??
        (a.source.startsWith("sound:") ? a.source : asset && asset.type === "audio" ? `sound:${asset.id}` : comp?.id);
      if (!key) throw new Error(`No audio source "${a.source}". Call mixer without arguments to list what is playing.`);
      S().setMix(key, clamp(a.volume, 0, 1));
    }
    return { sources: liveAudioSources().map((x) => ({ ...x, level: round(x.level, 2) })), trims: S().program.mix ?? {} };
  },

  music_at(a) {
    const scene = sceneOf(a.scene);
    const index = a.cue === undefined || a.cue === null ? null : cueIndexOf(scene, a.cue);
    const m = musicAt(scene.id, index);
    if (!m) throw new Error(`Scene ${scene.name} is not in the running order`);
    const name = (id: string) => S().assets.find((x) => x.id === id)?.name ?? id;
    const learned = P().project.cueTimings?.[scene.id] ?? {};
    const rt = S().program.runtime;
    const t = rt ? sceneNow(rt) : 0;
    return {
      scene: brief(scene),
      cue: index === null ? null : { index: index + 1, id: scene.cues[index].id, name: scene.cues[index].name },
      chase: chaseMusicOn(),
      sceneTime: round(m.sceneTime, 2),
      showTime: round(m.showTime, 2),
      sounds: m.sounds.map((x) => ({ assetId: x.assetId, name: name(x.assetId), offset: round(x.offset, 2), length: soundDuration(x.assetId) ?? null, loop: x.loop, keepPlaying: x.keepPlaying, from: { scene: brief(P().project.scenes.find((s) => s.id === x.sceneId)), cueId: x.cueId } })),
      learned: Object.fromEntries(Object.entries(learned).map(([k, v]) => [scene.cues.find((c) => c.id === k)?.name ?? k, v])),
      live: rt
        ? soundLives(rt.sounds ?? [], soundDuration)
            .filter((l) => lifePlaying(l, t))
            .map((l) => ({ assetId: l.ev.assetId, name: name(l.ev.assetId), offset: round(filePos(l.ev, t, soundDuration(l.ev.assetId)), 2) }))
        : [],
    };
  },

  async audio_output(a) {
    const list = async () => ({ native: await nativeOutputs(), web: await webOutputs() });
    if (a.device !== undefined) {
      let route: AudioRoute = null;
      if (a.device !== null) {
        const { native, web } = await list();
        const want = String(a.device).toLowerCase();
        const n = native.find((o) => o.uid === a.device || o.name.toLowerCase() === want);
        const w = web.find((o) => o.deviceId === a.device || o.label.toLowerCase() === want);
        const pick = a.engine === "web" ? (w ? "web" : n ? "native" : null) : n ? "native" : w ? "web" : null;
        if (pick === "native") route = { engine: "native", id: n!.uid, name: n!.name };
        else if (pick === "web") route = { engine: "web", id: w!.deviceId, name: w!.label };
        else throw new Error(`No audio output "${a.device}". Call audio_output without arguments to list them.`);
      }
      await setAudioRoute(route);
    }
    const all = await list();
    const dante = await danteAsioOnly(all.web);
    return { route: getAudioRoute(), ...all, webDefault: await webDefaultName(), webNamesHidden: await webOutputsHidden(), ...(dante ? { danteNotListed: DANTE_WDM_STEPS } : {}) };
  },

  timer_overlay(a) {
    if (a.timer === null) {
      S().setTimerOverlay(null);
      return { onScreen: null };
    }
    const t = byIdOrName(P().project.timers, a.timer, "timer");
    S().setTimerOverlay({ timerId: t.id, label: t.name });
    return { onScreen: t.name };
  },

  next_transition(a) {
    S().setNextTransition(a.transition ? transitionOf(a.transition)! : null);
    return { nextTransition: S().nextTransition };
  },

  async io_send(a) {
    if (!isObj(a.message)) throw new Error("message must be an object");
    const m = normalizeMessage({ ...(a.message as Args) }) as IoMessage & Args;
    if (m.type === "hog" && m.item) {
      const items = P().project.io?.hogItems ?? [];
      const it = items.find((x) => x.id === m.item) ?? items.find((x) => x.name.toLowerCase() === String(m.item).toLowerCase());
      if (!it) throw new Error(`No lighting item "${m.item}". Items: ${items.map((x) => x.name).join(", ")}`);
      Object.assign(m, { item: it.id, kind: m.kind ?? it.kind, number: m.number ?? it.number, op: m.op ?? "go", cue: m.cue ?? "" });
    }
    const before = useIo.getState().log.length;
    await sendMessage(m);
    const lines = useIo.getState().log.slice(before);
    const err = lines.find((l) => l.dir === "error");
    if (err) throw new Error(err.text);
    if (m.type === "sound") return { sent: describeMessage(m), wire: soundWire(m, { sceneId: contextScene() }), message: m };
    if (m.type === "stagelight") return { sent: describeMessage(m), wire: stageLightWire(m) };
    return { sent: describeMessage(m) };
  },

  stagemics_status() {
    return soundAppStatus();
  },

  stagelight_status() {
    return stageLightStatus();
  },

  async stagelight_catalog(a) {
    if (a.refresh) {
      if (stageLightReach() !== "answering") throw new Error(`StageLight is not answering (reach: ${stageLightReach()}); the catalog below is the last one read`);
      const since = Date.now();
      await requestStageLightCatalog();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          unsub();
          resolve();
        };
        const unsub = useStageLight.subscribe((s) => s.catalogState !== "loading" && s.catalogAt >= since && done());
        const t = setTimeout(done, 3000);
      });
    }
    const c = stageLightCatalog();
    const state = useStageLight.getState().catalogState;
    if (!c) return { state, catalog: null, note: state === "unsupported" ? "This StageLight has no catalog (before 0.3): give pages, cues and triggers by name." : "No catalog read yet: stagelight_link {enabled: true} with OSC listen on, then refresh." };
    return { state, revision: c.revision, from: c.from, pages: c.pages, triggers: c.triggers, library: c.library };
  },

  async stagelight_link(a) {
    if (a.port !== undefined && !(Number.isInteger(a.port) && a.port > 0 && a.port < 65536)) throw new Error("port must be 1-65535");
    if (a.host !== undefined && !String(a.host).trim()) throw new Error("host must not be empty");
    P().update((p) => {
      // A fresh show has no I/O settings until something sets one.
      p.io ??= factories.defaultIo();
      p.io.stagelight ??= factories.defaultIo().stagelight;
      const l = p.io.stagelight;
      if (typeof a.enabled === "boolean") l.enabled = a.enabled;
      // StageLight's hello, refusals and catalog come back on the OSC listen port.
      if (a.enabled === true) p.io.osc.enabled = true;
      if (a.host !== undefined) l.host = String(a.host).trim();
      if (a.port !== undefined) l.port = a.port;
      if (typeof a.mirror === "boolean") l.mirror = a.mirror;
    });
    if (!P().project.io?.stagelight.enabled) return stageLightStatus();
    // Ping now and give StageLight a moment to say hello (it answers in milliseconds).
    const since = Date.now();
    await pingStageLight();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        unsub();
        resolve();
      };
      const unsub = useStageLight.subscribe((s) => (s.hello?.at ?? 0) >= since && done());
      const t = setTimeout(done, 800);
    });
    return stageLightStatus();
  },

  async stagelight_send(a) {
    if (!isObj(a.message)) throw new Error("message must be an object");
    const m = normalizeMessage({ ...(a.message as Args), type: "stagelight" }) as Extract<IoMessage, { type: "stagelight" }>;
    if (!P().project.io?.stagelight?.enabled) throw new Error("The StageLight link is off: stagelight_link {enabled: true} first");
    const before = useIo.getState().log.length;
    const since = Date.now();
    await sendMessage(m);
    const err = useIo.getState().log.slice(before).find((l) => l.dir === "error");
    if (err) throw new Error(err.text);
    const answer = stageLightReach() === "answering" ? await stageLightAnswer(since) : null;
    return {
      sent: describeMessage(m),
      wire: stageLightWire(m),
      answer: answer ?? (stageLightReach() === "answering" ? "none (accepted, or StageLight does not announce GOs to this computer)" : `none seen (StageLight reach: ${stageLightReach()})`),
      message: m,
    };
  },

  io_inject(a) {
    const m = a.message as IncomingMessage;
    if (m?.kind !== "osc" && m?.kind !== "midi") throw new Error('message.kind must be "osc" or "midi"');
    const before = useIo.getState().log.length;
    injectIncoming(m);
    return { log: useIo.getState().log.slice(before).map((l) => `${l.dir}: ${l.text}`) };
  },

  async output_window(a) {
    if (a.op === "open") await openOutputWindow(P().project.output);
    else if (a.op === "close") {
      await closeOutputWindow();
      useShow.setState({ outputStatus: null, outputSeenAt: 0 });
    }
    const s = S();
    const up = !!s.outputStatus && Date.now() - s.outputSeenAt < 3500;
    return { open: up, status: up ? s.outputStatus : null, note: a.op === "open" ? "The output reports in within a second or two; ask status again to confirm." : undefined };
  },

  ui(a) {
    if (a.mode) P().setMode(a.mode);
    const sel = P().project.scenes.find((s) => s.id === P().selectedSceneId);
    const need = (s: Scene | undefined) => {
      if (!s) throw new Error("No scene selected: select_scene first");
      return s;
    };
    if (a.component !== undefined) P().selectComponent(a.component === null ? null : componentOf(need(sel), a.component).id);
    const pv = S().preview?.scene;
    if (a.solo !== undefined) S().setSolo(a.solo === null ? null : componentOf(need(pv), a.solo).id);
    if (a.hidden !== undefined) useShow.setState({ hidden: (a.hidden as string[]).map((r) => componentOf(need(pv), r).id) });
    const s = S();
    return { mode: P().mode, selectedScene: brief(sel), selectedComponentId: P().selectedComponentId, solo: s.solo, hidden: s.hidden };
  },

  update_live_scene() {
    const live = rtFor("program")!;
    const scene = P().project.scenes.find((s) => s.id === live.scene.id);
    if (!scene) throw new Error("The live scene is no longer in the show file");
    S().refreshProgramScene(scene);
    return { updated: brief(scene) };
  },

  // ------------------------------------------------ build
  scene_create(a) {
    const p = P().project;
    const after = a.after ? sceneOf(a.after) : null;
    const s = makeScene(p.scenes.length + 1, a.name ?? "New Scene");
    if (isObj(a.props)) deepMerge(s as any, a.props);
    s.id = s.id || uid("scene");
    P().update((d) => {
      const i = after ? d.scenes.findIndex((x) => x.id === after.id) + 1 : d.scenes.length;
      s.groupId = after?.groupId ?? null;
      d.scenes.splice(i, 0, s);
      normalizeGroups(d);
    });
    if (a.group) P().setSceneGroup(s.id, groupOf(a.group).id);
    return sceneSummary(P().project.scenes.find((x) => x.id === s.id)!);
  },

  scene_update(a) {
    const s = sceneOf(a.scene);
    if (!isObj(a.patch)) throw new Error("patch must be an object");
    const patch = { ...a.patch };
    delete patch.id;
    editScene(s.id, (x) => deepMerge(x as any, patch));
    return sceneSummary(sceneOf(s.id));
  },

  scene_duplicate(a) {
    const s = sceneOf(a.scene);
    const sel = P().selectedSceneId;
    const id = P().duplicateScene(s.id);
    P().selectScene(sel);
    return id ? sceneSummary(sceneOf(id)) : null;
  },

  scene_delete(a) {
    const s = sceneOf(a.scene);
    if (S().program.runtime?.scene.id === s.id) throw new Error(`${s.name} is live on the wall; take another scene first`);
    const sel = P().selectedSceneId;
    P().deleteScene(s.id);
    if (sel !== s.id && P().project.scenes.some((x) => x.id === sel)) P().selectScene(sel);
    return { deleted: s.name, scenes: P().project.scenes.length };
  },

  scene_move(a) {
    const s = sceneOf(a.scene);
    const n = Math.round(Number(a.by));
    for (let i = 0; i < Math.abs(n); i++) P().moveScene(s.id, n < 0 ? -1 : 1);
    return { scene: brief(sceneOf(s.id)) };
  },

  scene_group(a) {
    const s = sceneOf(a.scene);
    P().setSceneGroup(s.id, a.group === null ? null : a.group === "new" ? "new" : groupOf(a.group).id);
    const after = sceneOf(s.id);
    return { scene: brief(after), group: P().project.groups?.find((g) => g.id === after.groupId) ?? null };
  },

  group_update(a) {
    const g = groupOf(a.group);
    if (isObj(a.patch)) {
      const patch = { ...a.patch };
      delete patch.id;
      P().updateGroup(g.id, (x) => deepMerge(x as any, patch));
    }
    if (typeof a.by === "number") for (let i = 0; i < Math.abs(a.by); i++) P().moveGroup(g.id, a.by < 0 ? -1 : 1);
    if (a.ungroup) {
      P().ungroup(g.id);
      return { ungrouped: g.name };
    }
    return P().project.groups?.find((x) => x.id === g.id) ?? null;
  },

  component_add(a) {
    const s = sceneOf(a.scene);
    const c = compKindDefaults(a);
    if (isObj(a.props)) {
      const props = { ...a.props };
      delete props.id;
      delete props.kind;
      deepMerge(c as any, props);
    }
    normalizeClips(c);
    editScene(s.id, (x) => {
      const i = typeof a.index === "number" ? Math.max(0, Math.min(x.components.length, a.index)) : x.components.length;
      x.components.splice(i, 0, c);
    });
    return c;
  },

  component_update(a) {
    const s = sceneOf(a.scene);
    const c = componentOf(s, a.component);
    if (!isObj(a.patch)) throw new Error("patch must be an object");
    const patch = { ...a.patch };
    delete patch.id;
    delete patch.kind;
    P().updateComponent(s.id, c.id, (x) => {
      deepMerge(x as any, patch);
      normalizeClips(x);
    });
    return componentOf(sceneOf(s.id), c.id);
  },

  component_remove(a) {
    const s = sceneOf(a.scene);
    const c = componentOf(s, a.component);
    P().removeComponent(s.id, c.id);
    return { removed: c.name };
  },

  component_arrange(a) {
    const s = sceneOf(a.scene);
    const c = componentOf(s, a.component);
    const sel = P().selectedComponentId;
    if (a.op === "duplicate") P().duplicateComponent(s.id, c.id);
    else if (a.op === "up" || a.op === "down") P().moveComponent(s.id, c.id, a.op === "up" ? 1 : -1);
    else throw new Error(`Unknown op ${a.op}`);
    const copy = a.op === "duplicate" ? P().selectedComponentId : null;
    P().selectComponent(sel);
    return { order: sceneOf(s.id).components.map((x) => x.name), copyId: copy ?? undefined };
  },

  cue_add(a) {
    const s = sceneOf(a.scene);
    if (!isObj(a.cue)) throw new Error("cue must be an object");
    const cue = normalizeCue(a.cue);
    editScene(s.id, (x) => {
      const i = typeof a.index === "number" ? Math.max(0, Math.min(x.cues.length, a.index)) : x.cues.length;
      x.cues.splice(i, 0, cue);
    });
    return cue;
  },

  cue_update(a) {
    const s = sceneOf(a.scene);
    const i = cueIndexOf(s, a.cue);
    if (!isObj(a.patch)) throw new Error("patch must be an object");
    const patch = { ...a.patch };
    delete patch.id;
    const cue = normalizeCue(patch, s.cues[i]);
    editScene(s.id, (x) => {
      x.cues[i] = cue;
    });
    return cue;
  },

  cue_remove(a) {
    const s = sceneOf(a.scene);
    const i = cueIndexOf(s, a.cue);
    editScene(s.id, (x) => {
      x.cues.splice(i, 1);
    });
    return { removed: s.cues[i].name, cues: s.cues.length - 1 };
  },

  cue_move(a) {
    const s = sceneOf(a.scene);
    const i = cueIndexOf(s, a.cue);
    editScene(s.id, (x) => {
      const [c] = x.cues.splice(i, 1);
      x.cues.splice(Math.max(0, Math.min(x.cues.length, Math.round(a.to))), 0, c);
    });
    return { order: sceneOf(s.id).cues.map((c, k) => `#${k + 1} ${c.name}`) };
  },

  markers(a) {
    const scene = sceneOf(a.scene);
    const op = a.op ?? "list";
    if (op === "list") return { scene: brief(scene), videos: markerHosts(scene).map((h) => ({ media: h.compId, clip: h.clipId, label: h.label, markers: h.markers.map((m) => markerBrief(scene, m)) })) };
    const host = markerHostOf(scene, a.media, a.clip);
    if (op === "remove") {
      const r = String(a.id ?? "");
      const m = host.markers.find((x) => x.id === r) ?? host.markers.find((x) => x.name === r);
      if (!m) throw new Error(`No marker "${r}" on ${host.label}. Markers: ${host.markers.map((x) => `${x.name} (${x.id}) at ${x.at}s`).join("; ") || "none"}`);
      editScene(scene.id, (s) => setHostMarkers(s, host.key, host.markers.filter((x) => x.id !== m.id)));
      return { removed: markerBrief(scene, m), on: host.label };
    }
    if (op !== "upsert") throw new Error('op must be "list", "upsert" or "remove"');
    if (!isObj(a.marker)) throw new Error("marker must be an object");
    const given = a.marker as Args;
    const old = given.id ? host.markers.find((x) => x.id === given.id) : undefined;
    if (given.id && !old) throw new Error(`No marker "${given.id}" on ${host.label}; leave id out to add one`);
    const at = given.at ?? old?.at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) throw new Error("marker.at must be seconds (≥ 0) into the video");
    const cueRef = given.cue ?? given.cueId;
    const cueId = cueRef === null ? null : cueRef !== undefined ? scene.cues[cueIndexOf(scene, cueRef)].id : given.message ? null : (old?.cueId ?? null);
    const m: MediaMarker = {
      id: old?.id ?? uid("mk"),
      name: String(given.name ?? old?.name ?? `Marker ${host.markers.length + 1}`),
      at,
      message: given.message !== undefined ? normalizeMessage(given.message) : (old?.message ?? defaultMarkerMessage()),
      cueId,
    };
    editScene(scene.id, (s) => setHostMarkers(s, host.key, old ? host.markers.map((x) => (x.id === m.id ? m : x)) : [...host.markers, m]));
    return { marker: markerBrief(scene, m), on: host.label, added: !old };
  },

  upsert(a) {
    if (!isObj(a.item)) throw new Error("item must be an object");
    let out: unknown;
    P().update((d) => {
      const list = listOf(d, a.path) as Record<string, unknown>[];
      const item = structuredClone(a.item) as Record<string, unknown>;
      // Media markers: StageLight messages in their stored shape (checked, stale fields dropped).
      if (isObj(item.message) && item.message.type === "stagelight") item.message = normalizeMessage(item.message);
      const at = item.id ? list.findIndex((x) => isObj(x) && x.id === item.id) : -1;
      // Media markers: StageMics messages in their stored shape (scene references resolved, stale fields dropped).
      if (isObj(item.message) && item.message.type === "sound") item.message = normalizeMessage(item.message);
      if (at >= 0) {
        out = deepMerge(list[at], item);
        if (isObj(item.message)) (out as Record<string, unknown>).message = item.message;
        return;
      }
      item.id ||= uid(String(a.path).split("/").filter(Boolean).pop()?.replace(/s$/, "").slice(0, 8) || "item");
      list.splice(typeof a.index === "number" ? Math.max(0, Math.min(list.length, a.index)) : list.length, 0, item);
      out = item;
    });
    return out;
  },

  remove(a) {
    let removed: unknown;
    P().update((d) => {
      const list = listOf(d, a.path);
      const r = String(a.item);
      let i = list.findIndex((x) => isObj(x) && x.id === r);
      if (i < 0) i = list.findIndex((x) => isObj(x) && x.name === r);
      if (i < 0 && /^\d+$/.test(r)) i = Number(r);
      if (i < 0 || i >= list.length) throw new Error(`No item "${r}" in ${a.path}`);
      [removed] = list.splice(i, 1);
    });
    return { removed: summarize(removed, 2) };
  },

  patch(a) {
    if (!Array.isArray(a.ops) || !a.ops.length) throw new Error("ops must be a non-empty list");
    let before: { path: string; before: unknown }[] = [];
    P().update((d) => {
      before = applyOps(d, a.ops as PatchOp[]);
    });
    return { applied: a.ops.length, before: summarize(before, 8) };
  },

  async asset_import(a) {
    const asset = await importAsset(a);
    const [r] = await ingestAssets([asset], { auto: a.optimise !== false });
    const final = r?.asset ?? asset;
    return {
      id: final.id,
      name: final.name,
      type: final.type,
      hasAlpha: final.hasAlpha,
      ephemeral: final.ephemeral || undefined,
      format: final.probe ? describeProbe(final.probe) : undefined,
      optimised: r?.optimised ? { from: final.optimised?.from, was: describeProbe(final.optimised?.source) || undefined } : undefined,
      problems: r?.problems.length ? r.problems : undefined,
      optimiseError: r?.error,
    };
  },

  asset_remove(a) {
    const x = byIdOrName(P().project.assets, a.asset, "asset");
    if (x.builtIn) throw new Error(`${x.name} ships with the app and is restored on load`);
    P().removeAsset(x.id);
    return { removed: x.name };
  },

  output_settings(a) {
    if (!isObj(a.patch)) throw new Error("patch must be an object");
    P().update((p) => deepMerge(p.output as any, a.patch));
    return P().project.output;
  },

  async project(a) {
    switch (a.op) {
      case "save":
        await P().save();
        if (P().saveError) throw new Error(P().saveError!);
        return { saved: true };
      case "export":
        return { json: P().project };
      case "import": {
        const proj = typeof a.json === "string" ? JSON.parse(a.json) : a.json;
        if (!isObj(proj) || !Array.isArray(proj.scenes)) throw new Error("Not a show file (no scenes)");
        const incoming = proj as unknown as Project;
        const differ = levelDifferences(P().project.mix, incoming.mix);
        if (differ && a.levels !== "local" && a.levels !== "incoming") {
          return { imported: false, reason: `${differ} sound level(s) set on this computer differ from the file's: pass levels "local" (keep this computer's) or "incoming" (the file's)` };
        }
        await P().replaceProject(differ && a.levels === "local" ? { ...incoming, mix: P().project.mix } : incoming);
        return { imported: P().project.name, scenes: P().project.scenes.length, levels: differ ? a.levels : "same" };
      }
      case "reset_demo":
        P().resetToDemo();
        return { reset: true, scenes: P().project.scenes.length };
      case "rename":
        if (!a.name) throw new Error("rename needs name");
        P().update((p) => {
          p.name = String(a.name);
        });
        return { name: P().project.name };
      default:
        throw new Error(`Unknown op ${a.op}`);
    }
  },

  async package_export(a) {
    if (!isTauri) throw new Error("Show packages are written by the desktop app");
    const dir = String(a.dir ?? "");
    if (!dir) throw new Error("dir is required");
    return exportShowPackage(/\.slshow$/i.test(dir) ? dir : `${dir}.slshow`);
  },

  async package_import(a) {
    if (!isTauri) throw new Error("Show packages are opened by the desktop app");
    return takeInIncoming(await openShowPackage(String(a.dir ?? "")), a);
  },

  async cloud_status() {
    const s = await loadCloudSettings();
    const lin = P().project.lineage;
    const local = { showId: lin?.showId ?? null, sent: lin?.sent ?? null, received: lin?.received ?? null };
    if (!s) return { configured: false, local, note: "Cloud sync is off until the operator enters the Firebase keys (More → Cloud sync)." };
    const out: Record<string, unknown> = { configured: true, project: s.projectId, bucket: s.storageBucket, emulator: s.emulator, account: s.email ?? null, signedIn: !!s.refreshToken, local };
    if (s.refreshToken) {
      try {
        out.cloud = await listCloudShows(s);
      } catch (e) {
        out.cloudError = String(e);
      }
    }
    return out;
  },

  async cloud_push(a) {
    if (!isTauri) throw new Error("Cloud sync runs in the desktop app");
    try {
      return await cloudPush({ allowLive: !!a.allowLive, force: !!a.force });
    } catch (e) {
      if (e instanceof CloudAheadError) return { pushed: false, reason: e.message, cloud: e.latest };
      throw e;
    }
  },

  async cloud_pull(a) {
    if (!isTauri) throw new Error("Cloud sync runs in the desktop app");
    return takeInIncoming(await cloudOpen(a.showId ? String(a.showId) : undefined), a);
  },

  async update_check() {
    if (!isTauri) throw new Error("Updates are for the desktop app");
    const available = await checkForUpdate();
    const s = useUpdater.getState();
    const blocker = available ? installBlocker() : null;
    return { current: s.current, developmentBuild: import.meta.env.DEV, available, downloaded: s.phase === "ready", canInstall: !!available && !blocker, ...(blocker ? { blocker } : {}) };
  },

  async update_install(a) {
    if (!isTauri) throw new Error("Updates are for the desktop app");
    if (!a.version) throw new Error("version is required: the one update_check reported");
    if (!useUpdater.getState().available) await checkForUpdate();
    await downloadUpdate(String(a.version));
    const blocker = installBlocker();
    if (blocker) return { installed: false, downloaded: true, reason: blocker };
    // Answer first: on Windows the installer closes the app, so a later reply would never arrive.
    setTimeout(() => void applyUpdate().catch(() => {}), 500);
    return { installing: a.version, note: "The app closes, installs the update and opens again. Reopen the output window afterwards (output_window)." };
  },

  async call_action(a) {
    const store = storeOf(a.store);
    const fn = store[a.action];
    if (typeof fn !== "function") throw new Error(`No action "${a.action}" in the ${a.store} store. Actions: ${Object.keys(store).filter((k) => typeof store[k] === "function").join(", ")}`);
    const result = await (fn as (...x: unknown[]) => unknown)(...(Array.isArray(a.args) ? a.args : []));
    return { result: summarize(result, 4) ?? null };
  },

  async eval(a) {
    if (!import.meta.env.DEV) throw new Error("eval is only available in development builds (pnpm dev / pnpm tauri dev)");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...x: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction("project", "show", "io", "ops", "core", String(a.code));
    const result = await fn(useProject, useShow, useIo, ops, { factories, runtime });
    return summarize(result, 6) ?? null;
  },
};
