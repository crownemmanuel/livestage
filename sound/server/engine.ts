// The one command handler. Every input (operator screen, backstage phones, OSC from LiveStage, JSON API,
// MCP, the cloud) calls Engine.run(); it validates, changes state, sends the desk its bytes and tells
// everyone. The desk's own reports (DliveParser events) are the truth for what is live.
//
// Mute safety: mutes are written synchronously before anything that can wait (fades, network). Applying a
// cue mutes first, then sets effects, then opens mics. Panic and End scene never wait on anything.

import { dliveFader, dliveGetFader, dliveGetMute, dliveGetName, dliveGetSendLevel, dliveMute, dliveSendLevel, dbToLevel, levelToDb, type DliveChannel, type DliveEvent } from "../../shared/dlive.ts";
import { DeskLink } from "./desk.ts";
import {
  assignMic, backstageView, castWithMics, charById, cueTargets, detectMicsFromNames, effectiveMic, effectiveMics, micLive, micSig, nextSceneFor, sceneCheckState, presetById, presetChannels, resolvePreset, resolveScene, resolveWho, sceneById, sendDb, visibleScenes,
} from "./logic.ts";
import {
  AVATAR_PALETTE, FX_AMOUNTS, chKey, micInput, migrateShow, sendKey, uid,
  type Cue, type CueTrigger, type DeskStatus, type EffectPreset, type FxAmount, type FxChoice, type Runtime, type Settings, type SoundScene, type SoundShow,
} from "./model.ts";
import { SOUND_COMMANDS, type SoundCommand } from "./spec.ts";
import { loadLive, saveLive, saveSettings, saveShow, type LiveFile } from "./store.ts";

export type Source = "ui" | "backstage" | "osc" | "api" | "mcp" | "cloud" | "internal";

export class UserError extends Error {}

type Args = Record<string, unknown>;

export interface EngineEvents {
  /** Something changed; `show` / `settings` say which files changed too. */
  change(what: { show: boolean; settings: boolean; runtime: boolean }): void;
  /** A mic's live state changed, from any source (cue, operator, the desk itself). */
  mic(n: number, name: string, live: boolean): void;
  cue(sceneId: string, cue: number): void;
  log(msg: string): void;
}

interface Fade {
  from: DliveChannel;
  to: DliveChannel;
  start: number;
  end: number;
  t0: number;
  dur: number;
  last: number;
  mic: number;
}

const FADE_TICK_MS = 50;

// ---------------------------------------------------------------- argument checks

const s = (a: Args, k: string, required = true): string => {
  const v = a[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new UserError(`${k} is required`);
    return "";
  }
  if (typeof v !== "string" && typeof v !== "number") throw new UserError(`${k} must be text`);
  return String(v);
};
const n = (a: Args, k: string, lo: number, hi: number): number => {
  const v = typeof a[k] === "string" ? Number(a[k]) : a[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new UserError(`${k} must be a number from ${lo} to ${hi}`);
  return v;
};
const b = (a: Args, k: string): boolean => {
  const v = a[k];
  if (v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "live") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "off" || v === "muted") return false;
  throw new UserError(`${k} must be true or false`);
};

export class Engine {
  show: SoundShow;
  settings: Settings;
  rt: Runtime;
  desk: DeskLink;
  private ev: EngineEvents;
  private fades = new Map<string, Fade>();
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  /** Send levels from before an effect took a send over: mic → send key → level. */
  private bases: Record<string, Record<string, number>> = {};
  /** Mutes asked for while the desk link was down: sent as soon as it is back. */
  private pending = new Map<number, boolean>();
  private dirty = { show: false, settings: false, runtime: false };
  private flushQueued = false;
  private lastMic = new Map<number, boolean | undefined>();
  private lastCue = "";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Extra work some commands need (import, detect), plugged in by main.ts. */
  hooks: { importLiveStage?: (a: Args) => Promise<unknown>; importSources?: () => Promise<unknown>; lan?: () => { address: string; name: string }[] } = {};

  constructor(show: SoundShow, settings: Settings, ev: EngineEvents, appVersion: string, readOnlyDesk: boolean) {
    this.show = show;
    this.settings = settings;
    this.ev = ev;
    const live: LiveFile | null = loadLive();
    const keepScene = live && sceneById(show, live.activeSceneId) ? live.activeSceneId : null;
    this.rt = {
      selectedSceneId: keepScene ?? visibleScenes(show)[0]?.id ?? null,
      activeSceneId: keepScene,
      nextSceneId: live && sceneById(show, live.nextSceneId) ? live.nextSceneId! : null,
      nextPinned: !!(live && live.nextPinned && sceneById(show, live.nextSceneId)),
      cue: keepScene ? live!.cue : -1,
      fx: keepScene ? { ...live!.fx } : {},
      desk: { status: "offline", host: settings.desk.host, port: settings.desk.port, error: null, since: Date.now(), queried: false },
      channels: {},
      sends: {},
      livestage: { lastAt: null, from: null, protocol: null, lastCommand: null },
      cloud: { status: "off", error: null, at: null },
      meters: null,
      meterSource: null,
      lan: [],
      appVersion,
    };
    if (live) this.bases = live.bases;
    if (keepScene) ev.log(`restored after a restart: scene ${sceneById(show, keepScene)?.code} cue ${(live?.cue ?? -1) + 1} was active (nothing re-sent to the desk)`);
    this.desk = new DeskLink(
      {
        status: (st, err) => this.onDeskStatus(st, err),
        connected: () => this.onDeskConnected(),
        event: (e) => this.onDeskEvent(e),
        heartbeat: () => {
          const ch = micInput(this.show, this.show.mics[0]?.n ?? 1);
          return ch ? dliveGetMute(this.desk.n, ch) : null;
        },
        log: (m) => ev.log(m),
      },
      readOnlyDesk,
    );
    this.desk.configure(settings.desk);
    if (settings.desk.mode === "dry") this.seedDry();
  }

  // ---------------------------------------------------------------- the command handler

  /** Run a command. Throws UserError for bad input; returns the result (a promise for the few async ones). */
  run(cmd: string, a: Args = {}, source: Source = "api"): unknown {
    const spec = (SOUND_COMMANDS as Record<string, { backstage?: boolean; live?: boolean }>)[cmd];
    if (!spec) throw new UserError(`Unknown command "${cmd}"`);
    if (source === "backstage" && !spec.backstage) throw new UserError(`${cmd} is not allowed from the backstage page`);
    if (spec.live) this.ev.log(`${source} → ${cmd}${Object.keys(a).length ? " " + JSON.stringify(a) : ""}`);
    try {
      return this.exec(cmd as SoundCommand, a, source);
    } finally {
      this.queueFlush();
    }
  }

  private exec(cmd: SoundCommand, a: Args, source: Source): unknown {
    switch (cmd) {
      case "status":
        return this.status();
      case "scenes.list":
        return visibleScenes(this.show).map((sc) => ({
          code: sc.code, id: sc.id, name: sc.name, removed: sc.removed || undefined, active: sc.id === this.rt.activeSceneId || undefined,
          next: sc.id === nextSceneFor(this.show, this.rt) || undefined, check: sc.cast.length ? sceneCheckState(this.show, sc) : undefined, checkedBy: sc.checked?.by,
          cast: castWithMics(this.show, sc).map((c) => ({ id: c.char.id, name: c.char.name, mic: c.mic })),
          cues: sc.cues.map((q, i) => `Q${i + 1} ${q.label}${q.trigger.kind === "livestage" ? " (LiveStage)" : ""}`),
        }));

      // ---- show running
      case "scene.select": {
        const sc = this.scene(a);
        this.rt.selectedSceneId = sc.id;
        this.dirty.runtime = true;
        return { selected: sc.id };
      }
      case "scene.activate": {
        const sc = this.scene(a);
        if (!sc.cues.length) throw new UserError(`Scene ${sc.code} has no cues`);
        this.applyCue(sc, 0);
        return this.cueResult();
      }
      case "scene.end":
        return this.endScene();
      case "cue.go": {
        const sc = a.scene !== undefined && a.scene !== "" ? this.scene(a) : this.activeScene() ?? this.selectedScene();
        if (!sc) throw new UserError("No scene: pass scene, or activate one first");
        const ref = a.cue;
        let i = -1;
        if (typeof ref === "string" && !/^\d+$/.test(ref)) i = sc.cues.findIndex((q) => q.id === ref || q.label.toLowerCase() === ref.toLowerCase());
        else i = n(a, "cue", 1, 999) - 1;
        if (i < 0 || i >= sc.cues.length) throw new UserError(`Scene ${sc.code} has no cue ${String(ref)} (it has ${sc.cues.length})`);
        this.applyCue(sc, i);
        return this.cueResult();
      }
      case "cue.next": {
        const sc = this.activeScene();
        if (!sc) throw new UserError("No scene is active");
        if (this.rt.cue + 1 >= sc.cues.length) throw new UserError("That was the last cue of the scene");
        this.applyCue(sc, this.rt.cue + 1);
        return this.cueResult();
      }
      case "restore": {
        const sc = this.activeScene();
        if (!sc || this.rt.cue < 0) return { restored: false };
        this.applyCue(sc, this.rt.cue);
        return { restored: true, ...this.cueResult() };
      }
      case "mic": {
        const w = this.who(a);
        const live = b(a, "live");
        this.setMute(w.mic, !live);
        return { mic: w.mic, live };
      }
      case "extras.set": {
        if (!Array.isArray(a.extras)) throw new UserError("extras must be a list of {name, channel}");
        this.show.extras = (a.extras as Args[]).map((x) => ({ id: s(x, "id", false) || uid("ex"), name: s(x, "name").trim().slice(0, 30), channel: Math.round(n(x, "channel", 1, 128)) }));
        if (this.show.extras.some((x) => !x.name)) throw new UserError("Every extra channel needs a name");
        if (this.desk.connected) this.askMics();
        if (this.settings.desk.mode === "dry") this.seedDry();
        this.dirty.runtime = true;
        return this.touch();
      }
      case "extra": {
        const x = this.extra(a);
        const ch: DliveChannel = { kind: "input", number: x.channel };
        const st = (this.rt.channels[chKey(ch)] ??= {});
        const dry = this.settings.desk.mode === "dry";
        if (a.live !== undefined) {
          const muted = !b(a, "live");
          if (!dry && !this.desk.write(dliveMute(this.desk.n, ch, muted))) throw new UserError("The desk is not connected");
          st.muted = muted;
        }
        if (a.db !== undefined) {
          const level = dbToLevel(a.db === null || a.db === "-inf" ? -Infinity : n(a, "db", -Infinity, 10));
          if (!dry && !this.desk.write(dliveFader(this.desk.n, ch, level))) throw new UserError("The desk is not connected");
          st.fader = level;
        }
        this.dirty.runtime = true;
        this.ev.log(`${x.name} (In ${x.channel})${a.live !== undefined ? (st.muted ? " muted" : " live") : ""}${a.db !== undefined ? ` at ${st.fader ? levelToDb(st.fader).toFixed(1) + " dB" : "−∞"}` : ""}`);
        return { id: x.id, live: st.muted === undefined ? null : !st.muted, fader: st.fader ?? null };
      }
      case "level": {
        const w = this.who(a);
        const db = a.db === null || a.db === "-inf" ? -Infinity : n(a, "db", -Infinity, 10);
        const level = this.setLevel(w.mic, db);
        return { mic: w.mic, db: Number.isFinite(levelToDb(level)) ? Math.round(levelToDb(level) * 10) / 10 : null };
      }
      case "fx": {
        const w = this.who(a);
        const p = resolvePreset(this.show, s(a, "preset"));
        if (p === null) throw new UserError(`No effect preset "${s(a, "preset")}" (have: ${this.show.presets.map((x) => x.name).join(", ")})`);
        const amount = a.amount === undefined || a.amount === "" ? (this.rt.fx[w.mic]?.amount ?? "medium") : this.amount(a.amount);
        this.setFx(w.mic, p === "none" ? null : { preset: p.id, amount });
        return { mic: w.mic, fx: this.rt.fx[w.mic] ?? null };
      }
      case "panic":
        return this.panic();
      case "desk.reconnect":
        this.desk.reconnect();
        return { ok: true };
      case "desk.refresh":
        this.askDesk();
        return { ok: true };

      // ---- building
      case "show.rename":
        this.show.name = s(a, "name").slice(0, 80);
        return this.touch();
      case "character.save": {
        const id = s(a, "id", false);
        const existing = id ? charById(this.show, id) : null;
        if (id && !existing) throw new UserError(`No character ${id}`);
        const name = s(a, "name").trim().slice(0, 40);
        if (!name) throw new UserError("name is required");
        const gender = a.gender === "female" ? "female" : a.gender === "male" ? "male" : existing?.gender ?? "male";
        const defaultMic = a.defaultMic === null || a.defaultMic === "" || a.defaultMic === undefined ? (a.defaultMic === undefined ? existing?.defaultMic ?? null : null) : n(a, "defaultMic", 1, this.show.mics.length);
        const palette = a.palette !== undefined ? Math.round(n(a, "palette", 0, AVATAR_PALETTE.length - 1)) : existing?.palette ?? this.show.characters.length % AVATAR_PALETTE.length;
        if (existing) Object.assign(existing, { name, gender, defaultMic, palette });
        else this.show.characters.push({ id: uid("ch"), name, gender, palette, photo: null, thumb: null, defaultMic });
        this.touch();
        return { id: existing?.id ?? this.show.characters[this.show.characters.length - 1].id };
      }
      case "character.remove": {
        const id = s(a, "id");
        if (!charById(this.show, id)) throw new UserError(`No character ${id}`);
        this.show.characters = this.show.characters.filter((c) => c.id !== id);
        for (const sc of this.show.scenes) {
          sc.cast = sc.cast.filter((x) => x !== id);
          delete sc.mics[id];
          for (const q of sc.cues) {
            q.live = q.live.filter((x) => x !== id);
            delete q.fx[id];
          }
        }
        return this.touch();
      }
      case "character.photo": {
        const c = charById(this.show, s(a, "id"));
        if (!c) throw new UserError("No such character");
        c.photo = typeof a.photo === "string" && /^[\w.-]+$/.test(a.photo) ? a.photo : null;
        c.thumb = typeof a.thumb === "string" && a.thumb.startsWith("data:image/") && a.thumb.length < 40000 ? a.thumb : null;
        return this.touch();
      }
      case "scene.add": {
        const name = s(a, "name").trim().slice(0, 80);
        const order = Math.max(0, ...this.show.scenes.map((x) => x.order)) + 1;
        const sc: SoundScene = { id: uid("scene"), code: s(a, "code", false) || String(order), name, order, group: null, source: "local", removed: false, cast: [], mics: {}, micsAt: 0, cues: [], checked: null };
        this.show.scenes.push(sc);
        this.touch();
        return { id: sc.id };
      }
      case "scene.remove": {
        const sc = this.scene(a);
        if (sc.id === this.rt.activeSceneId) throw new UserError("End the scene before deleting it");
        this.show.scenes = this.show.scenes.filter((x) => x !== sc);
        if (this.rt.selectedSceneId === sc.id) this.rt.selectedSceneId = visibleScenes(this.show)[0]?.id ?? null;
        this.dirty.runtime = true;
        return this.touch();
      }
      case "scene.cast": {
        const sc = this.scene(a);
        const ids = Array.isArray(a.cast) ? a.cast.map(String) : null;
        if (!ids) throw new UserError("cast must be a list of character ids");
        for (const id of ids) if (!charById(this.show, id)) throw new UserError(`No character ${id}`);
        sc.cast = [...new Set(ids)];
        for (const id of Object.keys(sc.mics)) if (!sc.cast.includes(id)) delete sc.mics[id];
        for (const q of sc.cues) {
          q.live = q.live.filter((x) => sc.cast.includes(x));
          for (const id of Object.keys(q.fx)) if (!sc.cast.includes(id)) delete q.fx[id];
        }
        return this.touch();
      }
      case "scene.resetMics": {
        const sc = this.scene(a);
        const before = this.sceneMics(sc);
        sc.mics = {};
        sc.micsAt = Date.now();
        sc.checked = null;
        this.reapplyIfActive(sc, before);
        return this.touch();
      }
      case "cue.add": {
        const sc = this.scene(a);
        const at = a.at === undefined ? sc.cues.length : Math.round(n(a, "at", 0, sc.cues.length));
        const prev = sc.cues[at - 1];
        const q: Cue = { id: uid("cue"), label: s(a, "label", false).slice(0, 60) || `Cue ${sc.cues.length + 1}`, live: prev ? [...prev.live] : [...sc.cast], fx: prev ? structuredClone(prev.fx) : {}, trigger: { kind: "manual" } };
        sc.cues.splice(at, 0, q);
        if (sc.id === this.rt.activeSceneId && at <= this.rt.cue) this.rt.cue++;
        this.touch();
        return { id: q.id };
      }
      case "cue.update": {
        const sc = this.scene(a);
        const q = this.cue(sc, a);
        if (a.label !== undefined) q.label = s(a, "label").slice(0, 60);
        if (a.live !== undefined) {
          if (!Array.isArray(a.live)) throw new UserError("live must be a list of character ids");
          q.live = [...new Set(a.live.map(String))].filter((id) => sc.cast.includes(id));
        }
        if (a.fx !== undefined) {
          const fx = a.fx && typeof a.fx === "object" ? (a.fx as Record<string, unknown>) : {};
          for (const [id, v] of Object.entries(fx)) {
            if (!sc.cast.includes(id)) throw new UserError(`${id} is not in the cast`);
            if (v === null || v === "none") delete q.fx[id];
            else {
              const o = v as Args;
              const p = resolvePreset(this.show, s(o, "preset"));
              if (!p || p === "none") throw new UserError(`No effect preset ${String(o.preset)}`);
              q.fx[id] = { preset: p.id, amount: o.amount === undefined ? "medium" : this.amount(o.amount) };
            }
          }
        }
        if (a.trigger !== undefined) q.trigger = this.trigger(a.trigger);
        return this.touch();
      }
      case "cue.remove": {
        const sc = this.scene(a);
        const q = this.cue(sc, a);
        const i = sc.cues.indexOf(q);
        sc.cues.splice(i, 1);
        if (sc.id === this.rt.activeSceneId) {
          if (i < this.rt.cue) this.rt.cue--;
          else if (i === this.rt.cue) this.rt.cue = Math.min(this.rt.cue, sc.cues.length - 1);
          this.dirty.runtime = true;
        }
        return this.touch();
      }
      case "cue.move": {
        const sc = this.scene(a);
        const q = this.cue(sc, a);
        const to = Math.round(n(a, "to", 0, sc.cues.length - 1));
        const activeId = sc.id === this.rt.activeSceneId ? sc.cues[this.rt.cue]?.id : null;
        sc.cues.splice(sc.cues.indexOf(q), 1);
        sc.cues.splice(to, 0, q);
        if (activeId) this.rt.cue = sc.cues.findIndex((x) => x.id === activeId);
        return this.touch();
      }
      case "assign": {
        const sc = this.scene(a);
        const id = s(a, "character");
        if (!sc.cast.includes(id)) throw new UserError("That character is not in this scene");
        const mic = Math.round(n(a, "mic", 1, this.show.mics.length));
        if (effectiveMic(this.show, sc, id) === mic) return { unchanged: true };
        const before = this.sceneMics(sc);
        assignMic(this.show, sc, id, mic);
        sc.micsAt = typeof a.at === "number" && a.at > 0 ? a.at : Date.now();
        sc.checked = null;
        this.ev.log(`${source}: ${charById(this.show, id)?.name} on mic ${mic} in scene ${sc.code}`);
        this.reapplyIfActive(sc, before);
        return this.touch();
      }
      case "scene.confirm": {
        const sc = this.scene(a);
        // The phone sends the mic list it was looking at; the check only counts while the scene still matches it.
        const now = micSig(sc.cast, effectiveMics(this.show, sc));
        const sig = typeof a.sig === "string" ? a.sig.slice(0, 2000) : now;
        const by = s(a, "by", false).slice(0, 40) || (source === "backstage" || source === "cloud" ? "Backstage" : "Operator");
        sc.checked = { by, at: typeof a.at === "number" && a.at > 0 ? a.at : Date.now(), sig };
        this.ev.log(sig === now ? `${by} checked the mics for scene ${sc.code}` : `${by} confirmed scene ${sc.code}, but its mics changed meanwhile: not counted`);
        return this.touch();
      }
      case "scene.recheck": {
        const sc = this.scene(a);
        sc.checked = null;
        this.ev.log(`asked backstage to check scene ${sc.code} again`);
        return this.touch();
      }
      case "scene.next": {
        if (a.scene === null || a.scene === undefined || a.scene === "") {
          this.rt.nextSceneId = null;
          this.rt.nextPinned = false;
        } else {
          const sc = this.scene(a);
          if (sc.id === this.rt.activeSceneId) throw new UserError(`Scene ${sc.code} is live already`);
          this.rt.nextSceneId = sc.id;
          this.rt.nextPinned = true;
        }
        this.dirty.runtime = true;
        return { next: nextSceneFor(this.show, this.rt) };
      }
      case "preset.save": {
        const p = (a.preset && typeof a.preset === "object" ? a.preset : a) as Args;
        const clean = migrateShow({ presets: [p] }).presets[0];
        if (!clean.name.trim()) throw new UserError("A preset needs a name");
        const i = this.show.presets.findIndex((x) => x.id === clean.id);
        if (i >= 0) this.show.presets[i] = clean;
        else this.show.presets.push(clean);
        if (this.desk.connected) this.askPreset(clean);
        this.touch();
        return { id: clean.id };
      }
      case "preset.remove": {
        const id = s(a, "id");
        if (Object.values(this.rt.fx).some((f) => f.preset === id)) throw new UserError("That effect is on a mic right now; clear it first");
        this.show.presets = this.show.presets.filter((p) => p.id !== id);
        for (const sc of this.show.scenes) for (const q of sc.cues) for (const [k, f] of Object.entries(q.fx)) if (f.preset === id) delete q.fx[k];
        return this.touch();
      }
      case "mics.set": {
        if (!Array.isArray(a.mics)) throw new UserError("mics must be a list of {n, channel}");
        for (const m of a.mics as Args[]) {
          const num = Math.round(n(m, "n", 1, this.show.mics.length));
          const channel = Math.round(n(m, "channel", 1, 128));
          const def = this.show.mics.find((x) => x.n === num)!;
          def.channel = channel;
        }
        if (this.desk.connected) this.askMics();
        this.dirty.runtime = true;
        return this.touch();
      }
      case "mics.add": {
        if (this.show.mics.length >= 32) throw new UserError("32 mics is the most the app (and the cloud backstage) handles");
        const channel = Math.round(n(a, "channel", 1, 128));
        const mic = { n: this.show.mics.length + 1, channel };
        this.show.mics.push(mic);
        if (this.desk.connected) this.askMics();
        if (this.settings.desk.mode === "dry") this.seedDry();
        this.dirty.runtime = true;
        this.ev.log(`added mic ${mic.n} on desk input ${channel}`);
        this.touch();
        return { mic: mic.n, channel };
      }
      case "mics.remove": {
        // Only the last one, so the other mic numbers (printed on packs, used in cues) never shift.
        const last = this.show.mics[this.show.mics.length - 1];
        if (!last || this.show.mics.length <= 1) throw new UserError("Keep at least one mic");
        if (a.mic !== undefined && Math.round(n(a, "mic", 1, 32)) !== last.n) throw new UserError(`Only the last mic (${last.n}) can be removed`);
        const active = this.activeScene();
        if (active && castWithMics(this.show, active).some((c) => c.mic === last.n)) throw new UserError(`Mic ${last.n} is in use in the live scene`);
        for (const c of this.show.characters) if (c.defaultMic === last.n) c.defaultMic = null;
        for (const sc of this.show.scenes) for (const [id, m] of Object.entries(sc.mics)) if (m === last.n) delete sc.mics[id];
        this.show.mics.pop();
        this.pending.delete(last.n);
        delete this.rt.fx[last.n];
        this.dirty.runtime = true;
        this.ev.log(`removed mic ${last.n}`);
        return this.touch();
      }
      case "mics.detect":
        return this.detectMics();
      case "settings.desk": {
        const d = this.settings.desk;
        if (a.host !== undefined) d.host = s(a, "host").trim();
        if (a.port !== undefined) d.port = Math.round(n(a, "port", 1, 65535));
        if (a.baseChannel !== undefined) d.baseChannel = Math.round(n(a, "baseChannel", 1, 12));
        if (a.mode !== undefined) {
          if (a.mode !== "desk" && a.mode !== "dry") throw new UserError("mode must be desk or dry");
          d.mode = a.mode;
        }
        this.rt.channels = {};
        this.rt.sends = {};
        this.rt.desk.host = d.host;
        this.rt.desk.port = d.port;
        this.desk.configure(d);
        if (d.mode === "dry") this.seedDry();
        this.dirty.settings = true;
        this.dirty.runtime = true;
        return { ok: true };
      }
      case "settings.sync": {
        const sy = this.settings.sync;
        if (a.mode !== undefined) {
          if (a.mode !== "local" && a.mode !== "cloud") throw new UserError("mode must be local or cloud");
          sy.mode = a.mode;
        }
        if (a.lanIp !== undefined) sy.lanIp = a.lanIp ? s(a, "lanIp") : null;
        if (a.cloud && typeof a.cloud === "object") {
          const c = a.cloud as Args;
          for (const k of ["apiKey", "projectId", "databaseURL", "emulatorHost", "hostedUrl"] as const) if (typeof c[k] === "string") sy.cloud[k] = (c[k] as string).trim();
          if (sy.cloud.projectId && !sy.cloud.databaseURL) sy.cloud.databaseURL = `https://${sy.cloud.projectId}-default-rtdb.firebaseio.com`;
        }
        if (a.newJoinKey === true || (sy.mode === "cloud" && !sy.cloud.joinKey)) sy.cloud.joinKey = joinKey();
        this.dirty.settings = true;
        return { ok: true };
      }
      case "settings.remote":
        this.settings.allowRemoteOperator = b(a, "allow");
        this.dirty.settings = true;
        return { ok: true };
      case "import.livestage":
        if (!this.hooks.importLiveStage) throw new UserError("Import is not available");
        return this.hooks.importLiveStage(a);
      case "import.sources":
        return this.hooks.importSources ? this.hooks.importSources() : [];
    }
  }

  // ---------------------------------------------------------------- lookups

  private scene(a: Args): SoundScene {
    const ref = s(a, "scene");
    const sc = resolveScene(this.show, ref);
    if (!sc) throw new UserError(`No scene "${ref}"`);
    return sc;
  }
  private cue(sc: SoundScene, a: Args): Cue {
    const id = s(a, "cue");
    const q = sc.cues.find((x) => x.id === id) ?? (/^\d+$/.test(id) ? sc.cues[Number(id) - 1] : undefined);
    if (!q) throw new UserError(`Scene ${sc.code} has no cue ${id}`);
    return q;
  }
  private who(a: Args) {
    const w = resolveWho(this.show, this.activeScene() ?? this.selectedScene(), s(a, "who"));
    if (!w) throw new UserError(`No mic or character "${String(a.who)}"`);
    return w;
  }
  private amount(v: unknown): FxAmount {
    const x = String(v).toLowerCase();
    if (!(FX_AMOUNTS as string[]).includes(x)) throw new UserError("amount must be light, medium or full");
    return x as FxAmount;
  }
  private trigger(v: unknown): CueTrigger {
    const t = (v && typeof v === "object" ? v : {}) as Args;
    if (t.kind === "livestage") return { kind: "livestage", at: typeof t.at === "string" ? t.at.slice(0, 16) : "" };
    if (t.kind === "manual" || v === "manual") return { kind: "manual" };
    throw new UserError("trigger must be {kind: manual} or {kind: livestage, at}");
  }
  activeScene() {
    return sceneById(this.show, this.rt.activeSceneId);
  }
  /** An extra channel by id, name ("Dante 1", case-insensitive) or desk input number. */
  private extra(a: Args) {
    const ref = String(a.extra ?? "").trim().toLowerCase();
    const x = this.show.extras.find((e) => e.id === ref || e.name.toLowerCase() === ref || String(e.channel) === ref);
    if (!x) throw new UserError(`No extra channel ${String(a.extra)} (have: ${this.show.extras.map((e) => e.name).join(", ") || "none"})`);
    return x;
  }
  selectedScene() {
    return sceneById(this.show, this.rt.selectedSceneId);
  }
  private touch() {
    this.show.updatedAt = Date.now();
    this.dirty.show = true;
    return { ok: true };
  }
  private cueResult() {
    const sc = this.activeScene();
    return { scene: sc?.id ?? null, code: sc?.code, cue: this.rt.cue + 1, label: sc?.cues[this.rt.cue]?.label ?? null, next: sc?.cues[this.rt.cue + 1]?.label ?? null };
  }

  // ---------------------------------------------------------------- show running

  private applyCue(sc: SoundScene, i: number) {
    const targets = cueTargets(this.show, sc, i);
    const mine = new Set(targets.map((t) => t.mic));
    // Leaving another scene: its mics that this scene does not use are muted and lose their effects.
    const prev = this.activeScene();
    if (prev && prev.id !== sc.id) {
      for (const id of prev.cast) {
        const m = effectiveMic(this.show, prev, id);
        if (m != null && !mine.has(m)) this.setMute(m, true);
      }
      for (const m of Object.keys(this.rt.fx).map(Number)) if (!mine.has(m)) this.setFx(m, null);
    }
    for (const t of targets) if (!t.live) this.setMute(t.mic, true);
    for (const t of targets) this.setFx(t.mic, t.fx);
    for (const t of targets) if (t.live) this.setMute(t.mic, false);
    if (!prev || prev.id !== sc.id) {
      // The scene backstage was checking went live (or another did): backstage moves on to the one after it.
      if (!this.rt.nextPinned || this.rt.nextSceneId === sc.id) {
        this.rt.nextSceneId = null;
        this.rt.nextPinned = false;
      }
    }
    this.rt.activeSceneId = sc.id;
    this.rt.selectedSceneId = sc.id;
    this.rt.cue = i;
    this.dirty.runtime = true;
  }

  /**
   * The live scene's mics were swapped: the people moved, so the mics follow the cue again (mutes first).
   * Mics nobody in the scene wears any more are muted.
   */
  private reapplyIfActive(sc: SoundScene, before: Set<number>) {
    if (sc.id !== this.rt.activeSceneId || this.rt.cue < 0) return;
    this.ev.log(`mics changed in the live scene ${sc.code}: re-applying Q${this.rt.cue + 1}`);
    const now = this.sceneMics(sc);
    for (const m of before) {
      if (now.has(m)) continue;
      this.setMute(m, true);
      if (this.rt.fx[m]) this.setFx(m, null);
    }
    this.applyCue(sc, this.rt.cue);
  }

  private sceneMics(sc: SoundScene): Set<number> {
    const out = new Set<number>();
    for (const id of sc.cast) {
      const m = effectiveMic(this.show, sc, id);
      if (m != null) out.add(m);
    }
    return out;
  }

  private endScene() {
    const sc = this.activeScene();
    if (!sc) return { ended: null };
    const mics = new Set<number>();
    for (const id of sc.cast) {
      const m = effectiveMic(this.show, sc, id);
      if (m != null) mics.add(m);
    }
    for (const m of mics) this.setMute(m, true);
    for (const m of Object.keys(this.rt.fx).map(Number)) this.setFx(m, null);
    this.rt.activeSceneId = null;
    this.rt.cue = -1;
    this.dirty.runtime = true;
    return { ended: sc.id, muted: [...mics] };
  }

  /** Mute every mic, now. Works with the desk down too (the mutes go out the moment it is back). */
  panic() {
    for (const m of this.show.mics) {
      try {
        this.setMute(m.n, true);
      } catch (e) {
        this.ev.log(`panic: mic ${m.n}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.dirty.runtime = true;
    this.queueFlush();
    return { muted: this.show.mics.map((m) => m.n) };
  }

  setMute(mic: number, muted: boolean) {
    const ch = micInput(this.show, mic);
    if (!ch) throw new UserError(`No mic ${mic}`);
    const key = chKey(ch);
    const st = (this.rt.channels[key] ??= {});
    if (this.settings.desk.mode === "dry") {
      st.muted = muted;
    } else if (this.desk.write(dliveMute(this.desk.n, ch, muted))) {
      // The desk does not echo our own changes back, so take it as done.
      st.muted = muted;
      this.pending.delete(mic);
    } else {
      this.pending.set(mic, muted);
      this.ev.log(`desk not connected: mic ${mic} ${muted ? "mute" : "unmute"} waits for the desk`);
    }
    this.dirty.runtime = true;
  }

  /** Move a mic's desk fader (dB, −inf at or below −54, +10 max). Returns the level byte sent. */
  setLevel(mic: number, db: number): number {
    const ch = micInput(this.show, mic);
    if (!ch) throw new UserError(`No mic ${mic}`);
    const level = dbToLevel(db);
    const st = (this.rt.channels[chKey(ch)] ??= {});
    if (this.settings.desk.mode === "dry") st.fader = level;
    else if (this.desk.write(dliveFader(this.desk.n, ch, level))) st.fader = level;
    else throw new UserError("The desk is not connected: the level was not changed");
    this.dirty.runtime = true;
    return level;
  }

  /** Put an effect on a mic (null clears it), fading its sends. */
  setFx(mic: number, choice: FxChoice | null) {
    const from = micInput(this.show, mic);
    if (!from) return;
    const preset = choice ? presetById(this.show, choice.preset) : null;
    const old = this.rt.fx[mic] ? presetById(this.show, this.rt.fx[mic].preset) : null;
    const bases = (this.bases[mic] ??= {});
    const targets = new Map<string, { to: DliveChannel; level: number }>();
    if (preset && choice) {
      for (const snd of preset.sends) {
        const to: DliveChannel = { kind: snd.kind, number: snd.number };
        targets.set(sendKey(from, to), { to, level: dbToLevel(sendDb(snd.db, choice.amount)) });
      }
    }
    for (const [key, t] of targets) {
      if (bases[key] === undefined) bases[key] = this.fades.get(key)?.end ?? this.rt.sends[key] ?? 0;
      this.fadeSend(mic, from, t.to, t.level, preset!.fadeIn);
    }
    for (const key of Object.keys(bases)) {
      if (targets.has(key)) continue;
      const to = parseChannel(key.split(">")[1]);
      if (to) this.fadeSend(mic, from, to, bases[key], old?.fadeOut ?? preset?.fadeOut ?? 1, () => {
        // Back at the old level and nothing took the send over meanwhile: forget the base.
        if (!this.currentTargets(mic).has(key)) delete this.bases[mic]?.[key];
      });
    }
    if (choice && preset) this.rt.fx[mic] = { ...choice };
    else delete this.rt.fx[mic];
    this.dirty.runtime = true;
  }

  private currentTargets(mic: number): Set<string> {
    const from = micInput(this.show, mic);
    const f = this.rt.fx[mic];
    const p = f ? presetById(this.show, f.preset) : null;
    return new Set(from && p ? p.sends.map((x) => sendKey(from, { kind: x.kind, number: x.number })) : []);
  }

  private fadeSend(mic: number, from: DliveChannel, to: DliveChannel, level: number, seconds: number, done?: () => void) {
    const key = sendKey(from, to);
    const start = this.rt.sends[key] ?? 0;
    const dur = Math.max(0, seconds) * 1000;
    if (dur === 0 || start === level) {
      this.fades.delete(key);
      this.writeSend(from, to, level);
      done?.();
      return;
    }
    this.fades.set(key, { from, to, start, end: level, t0: Date.now(), dur, last: start, mic });
    if (done) this.fadeDone.set(key, done);
    else this.fadeDone.delete(key);
    if (!this.fadeTimer) this.fadeTimer = setInterval(() => this.tickFades(), FADE_TICK_MS);
  }
  private fadeDone = new Map<string, () => void>();

  private tickFades() {
    const now = Date.now();
    for (const [key, f] of this.fades) {
      const k = Math.min(1, (now - f.t0) / f.dur);
      const lv = Math.round(f.start + (f.end - f.start) * k);
      if (lv !== f.last || k >= 1) {
        f.last = lv;
        try {
          this.writeSend(f.from, f.to, lv);
        } catch (e) {
          this.ev.log(`fade: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (k >= 1) {
        this.fades.delete(key);
        const d = this.fadeDone.get(key);
        this.fadeDone.delete(key);
        d?.();
      }
    }
    if (!this.fades.size && this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    this.dirty.runtime = true;
    this.queueFlush();
  }

  private writeSend(from: DliveChannel, to: DliveChannel, level: number) {
    const key = sendKey(from, to);
    if (this.settings.desk.mode === "dry" || this.desk.write(dliveSendLevel(this.desk.n, from, to, level))) this.rt.sends[key] = level;
    this.dirty.runtime = true;
  }

  // ---------------------------------------------------------------- the desk

  private onDeskStatus(st: DeskStatus, err: string | null) {
    const d = this.rt.desk;
    if (d.status !== st) d.since = Date.now();
    d.status = st;
    d.error = err;
    if (st !== "connected") d.queried = false;
    this.dirty.runtime = true;
    this.queueFlush();
  }

  private onDeskConnected() {
    // What the operator asked for while the desk was away goes out first, then we ask what the desk has.
    for (const [mic, muted] of [...this.pending]) {
      this.ev.log(`desk back: sending mic ${mic} ${muted ? "mute" : "unmute"} from while it was away`);
      this.setMute(mic, muted);
    }
    for (const [mic, f] of Object.entries(this.rt.fx)) {
      const from = micInput(this.show, Number(mic));
      const p = presetById(this.show, f.preset);
      if (from && p) for (const snd of p.sends) this.desk.write(dliveSendLevel(this.desk.n, from, { kind: snd.kind, number: snd.number }, dbToLevel(sendDb(snd.db, f.amount))));
    }
    this.askDesk();
  }

  /** Ask the desk for the names and mutes of every mic channel, and what effect presets use. Read-only. */
  askDesk() {
    if (!this.desk.connected) return;
    this.askMics();
    const seen = new Set<string>();
    for (const p of this.show.presets) this.askPreset(p, seen);
    this.rt.desk.queried = true;
  }

  private askMics() {
    const q: number[][] = [];
    for (const m of this.show.mics) {
      const ch: DliveChannel = { kind: "input", number: m.channel };
      q.push(dliveGetName(this.desk.n, ch), dliveGetMute(this.desk.n, ch), dliveGetFader(this.desk.n, ch));
    }
    for (const x of this.show.extras) {
      const ch: DliveChannel = { kind: "input", number: x.channel };
      q.push(dliveGetName(this.desk.n, ch), dliveGetMute(this.desk.n, ch), dliveGetFader(this.desk.n, ch));
    }
    this.desk.askMany(q);
  }

  private askPreset(p: EffectPreset, seen = new Set<string>()) {
    const nn = this.desk.n;
    const all: number[][] = [];
    const q = { push: (...m: number[][]) => all.push(...m.filter((x) => !seen.has(x.join()) && seen.add(x.join()))) };
    for (const ch of presetChannels(p)) {
      q.push(dliveGetName(nn, ch));
      if (ch.kind !== "monoFxSend" && ch.kind !== "stereoFxSend") q.push(dliveGetMute(nn, ch), dliveGetFader(nn, ch));
    }
    for (const m of this.show.mics) for (const snd of p.sends) q.push(dliveGetSendLevel(nn, { kind: "input", number: m.channel }, { kind: snd.kind, number: snd.number }));
    this.desk.askMany(all);
  }

  private async detectMics() {
    if (this.settings.desk.mode === "dry") throw new UserError("Connect to the desk first (Desk mode, not dry run)");
    if (!this.desk.connected) throw new UserError("The desk is not connected");
    const q: number[][] = [];
    for (let i = 1; i <= 128; i++) q.push(dliveGetName(this.desk.n, { kind: "input", number: i }));
    this.desk.askMany(q);
    await new Promise((r) => setTimeout(r, 1800));
    const names: Record<number, string> = {};
    for (let i = 1; i <= 128; i++) {
      const nm = this.rt.channels[`input:${i}`]?.name;
      if (nm) names[i] = nm;
    }
    const found = detectMicsFromNames(names, this.show.mics.length);
    const changed: { mic: number; channel: number; name: string }[] = [];
    for (const [mic, channel] of Object.entries(found)) {
      const def = this.show.mics.find((m) => m.n === Number(mic));
      if (def && def.channel !== channel) {
        def.channel = channel;
        changed.push({ mic: Number(mic), channel, name: names[channel] });
      }
    }
    if (changed.length) {
      this.touch();
      this.askMics();
    }
    this.dirty.runtime = true;
    this.queueFlush();
    return { found: Object.keys(found).length, changed, namesRead: Object.keys(names).length };
  }

  private onDeskEvent(e: DliveEvent) {
    if (e.type === "scene") {
      this.ev.log(`desk recalled scene ${e.scene}`);
      return;
    }
    if (e.type === "send") {
      const key = sendKey(e.from, e.to);
      // Our own fade owns this send for now; the desk's report of an older step is not news.
      if (!this.fades.has(key)) this.rt.sends[key] = e.level;
    } else {
      const st = (this.rt.channels[chKey(e.channel)] ??= {});
      if (e.type === "mute") st.muted = e.muted;
      else if (e.type === "name") st.name = e.name;
      else if (e.type === "fader") st.fader = e.level;
      else if (e.type === "colour") st.colour = e.colour;
    }
    this.dirty.runtime = true;
    this.queueFlush();
  }

  /** Dry run: the app plays the desk, every mic starts muted and named after its channel. */
  private seedDry() {
    for (const m of this.show.mics) {
      const st = (this.rt.channels[`input:${m.channel}`] ??= {});
      st.muted ??= true;
      st.fader ??= 0x6b;
    }
    for (const x of this.show.extras) {
      const st = (this.rt.channels[`input:${x.channel}`] ??= {});
      st.muted ??= true;
      st.fader ??= 0x6b;
    }
  }

  // ---------------------------------------------------------------- outside world

  noteLiveStage(from: string, cmd: string, protocol?: number) {
    this.rt.livestage = { lastAt: Date.now(), from, protocol: protocol ?? this.rt.livestage.protocol, lastCommand: cmd };
    this.dirty.runtime = true;
    this.queueFlush();
  }

  setCloudStatus(status: Runtime["cloud"]["status"], error: string | null) {
    this.rt.cloud = { status, error, at: Date.now() };
    this.dirty.runtime = true;
    this.queueFlush();
  }

  /** A future meter source (e.g. a Dante feed) calls this with 0–1 per mic number. */
  setMeters(source: string | null, values: Record<string, number> | null) {
    this.rt.meterSource = source;
    this.rt.meters = values;
    this.dirty.runtime = true;
    this.queueFlush();
  }

  /** Whole-show replacement after an import merge. */
  replaceShow(next: SoundShow) {
    this.show = next;
    if (!sceneById(next, this.rt.selectedSceneId)) this.rt.selectedSceneId = visibleScenes(next)[0]?.id ?? null;
    if (!sceneById(next, this.rt.activeSceneId)) {
      this.rt.activeSceneId = null;
      this.rt.cue = -1;
    }
    if (this.desk.connected) this.askDesk();
    this.touch();
    this.dirty.runtime = true;
    this.queueFlush();
  }

  status() {
    const sc = this.activeScene();
    return {
      desk: { ...this.rt.desk, mode: this.settings.desk.mode, readOnly: this.desk.readOnly || undefined },
      activeScene: sc ? { id: sc.id, code: sc.code, name: sc.name } : null,
      cue: sc && this.rt.cue >= 0 ? { n: this.rt.cue + 1, label: sc.cues[this.rt.cue]?.label, next: sc.cues[this.rt.cue + 1]?.label ?? null } : null,
      selectedScene: this.rt.selectedSceneId,
      backstage: (() => {
        const nx = sceneById(this.show, nextSceneFor(this.show, this.rt));
        const chk = (x: SoundScene | null) => (x ? { id: x.id, code: x.code, name: x.name, check: sceneCheckState(this.show, x), by: x.checked?.by ?? null, at: x.checked?.at ?? null } : null);
        return { live: chk(sc), next: chk(nx), nextSetByOperator: this.rt.nextPinned };
      })(),
      mics: this.show.mics.map((m) => {
        const holder = sc ? castWithMics(this.show, sc).find((c) => c.mic === m.n)?.char : this.show.characters.find((c) => c.defaultMic === m.n);
        return { mic: m.n, input: m.channel, deskName: this.rt.channels[`input:${m.channel}`]?.name, who: holder?.name, live: micLive(this.show, this.rt, m.n), fx: this.rt.fx[m.n] ? presetById(this.show, this.rt.fx[m.n].preset)?.name : undefined, waiting: this.pending.has(m.n) || undefined };
      }),
      livestage: this.rt.livestage,
      sync: { mode: this.settings.sync.mode, cloud: this.rt.cloud },
      show: { name: this.show.name, scenes: this.show.scenes.length, characters: this.show.characters.length },
    };
  }

  backstage() {
    return backstageView(this.show, this.rt);
  }

  pendingMics(): Record<string, boolean> {
    return Object.fromEntries([...this.pending].map(([k, v]) => [String(k), !v]));
  }

  // ---------------------------------------------------------------- change fan-out

  private queueFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    setImmediate(() => this.flush());
  }

  private flush() {
    this.flushQueued = false;
    const d = this.dirty;
    this.dirty = { show: false, settings: false, runtime: false };
    if (d.settings) {
      try {
        saveSettings(this.settings);
      } catch (e) {
        this.ev.log(`could not save settings: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (d.show) this.scheduleSave();
    if (d.runtime || d.show) this.saveLiveSoon();
    // Tell LiveStage (OSC replies) about every mic that changed, whatever changed it.
    const sc = this.activeScene() ?? this.selectedScene();
    for (const m of this.show.mics) {
      const live = micLive(this.show, this.rt, m.n);
      if (this.lastMic.get(m.n) !== live) {
        const had = this.lastMic.has(m.n);
        this.lastMic.set(m.n, live);
        if (had && live !== undefined) {
          const holder = sc ? castWithMics(this.show, sc).find((c) => c.mic === m.n)?.char : undefined;
          this.ev.mic(m.n, holder?.name ?? this.show.characters.find((c) => c.defaultMic === m.n)?.name ?? `Mic ${m.n}`, live);
        }
      }
    }
    const cueKey = `${this.rt.activeSceneId}:${this.rt.cue}`;
    if (cueKey !== this.lastCue) {
      this.lastCue = cueKey;
      this.ev.cue(this.rt.activeSceneId ?? "", this.rt.cue + 1);
    }
    if (d.show || d.settings || d.runtime) this.ev.change(d);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
  }

  saveNow() {
    try {
      saveShow(this.show);
    } catch (e) {
      this.ev.log(`could not save the show: ${e instanceof Error ? e.message : e}`);
    }
  }

  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveLiveSoon() {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      try {
        saveLive({ activeSceneId: this.rt.activeSceneId, nextSceneId: this.rt.nextSceneId, nextPinned: this.rt.nextPinned, cue: this.rt.cue, fx: this.rt.fx, bases: this.bases, savedAt: Date.now() });
      } catch {
        /* next change tries again */
      }
    }, 500);
  }

  shutdown() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveNow();
    }
    try {
      saveLive({ activeSceneId: this.rt.activeSceneId, nextSceneId: this.rt.nextSceneId, nextPinned: this.rt.nextPinned, cue: this.rt.cue, fx: this.rt.fx, bases: this.bases, savedAt: Date.now() });
    } catch {
      /* best effort */
    }
    this.desk.close();
    if (this.fadeTimer) clearInterval(this.fadeTimer);
  }
}

function parseChannel(k: string | undefined): DliveChannel | null {
  if (!k) return null;
  const [kind, num] = k.split(":");
  const v = Number(num);
  return kind && Number.isInteger(v) ? ({ kind, number: v } as DliveChannel) : null;
}

function joinKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Buffer.from(a).toString("base64url");
}
