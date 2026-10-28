// Pure rules about who wears which mic and what a cue means, shared by the service and the UI.
// No Node or DOM APIs; erasable TypeScript only.

import type { DliveChannel } from "../../shared/dlive.ts";
import { FX_AMOUNT_DB, chKey, micInput, type BackstageView, type Character, type EffectPreset, type FxAmount, type FxChoice, type Runtime, type SceneCheck, type SoundScene, type SoundShow } from "./model.ts";

export const charById = (show: SoundShow, id: string) => show.characters.find((c) => c.id === id) ?? null;
export const sceneById = (show: SoundShow, id: string | null | undefined) => (id ? show.scenes.find((s) => s.id === id) ?? null : null);
export const presetById = (show: SoundShow, id: string) => show.presets.find((p) => p.id === id) ?? null;

/** The mic a character wears in a scene (the scene's backstage assignment, else their default). */
export function effectiveMic(show: SoundShow, scene: SoundScene | null, charId: string): number | null {
  const m = scene?.mics[charId];
  if (typeof m === "number") return m;
  return charById(show, charId)?.defaultMic ?? null;
}

/** Every cast member's mic in a scene (character id → mic), defaults included. */
export function effectiveMics(show: SoundShow, scene: SoundScene): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of scene.cast) {
    const m = effectiveMic(show, scene, id);
    if (m != null) out[id] = m;
  }
  return out;
}

/** Cast of a scene with their mics, in mic order (no mic last). */
export function castWithMics(show: SoundShow, scene: SoundScene): { char: Character; mic: number | null }[] {
  return scene.cast
    .map((id) => charById(show, id))
    .filter((c): c is Character => !!c)
    .map((char) => ({ char, mic: effectiveMic(show, scene, char.id) }))
    .sort((a, b) => (a.mic ?? 999) - (b.mic ?? 999) || a.char.name.localeCompare(b.char.name));
}

/** Who holds mic n in a scene: a cast member, else (when nobody in the cast has it) whoever has it by default. */
export function holderOf(show: SoundShow, scene: SoundScene | null, n: number): { char: Character; inCast: boolean } | null {
  if (scene) {
    for (const id of scene.cast) {
      if (effectiveMic(show, scene, id) === n) {
        const char = charById(show, id);
        if (char) return { char, inCast: true };
      }
    }
  }
  const def = show.characters.find((c) => c.defaultMic === n && !(scene && scene.cast.includes(c.id)));
  return def ? { char: def, inCast: false } : null;
}

/** Two cast members on the same mic in a scene (a backstage mix-up). */
export function micClashes(show: SoundShow, scene: SoundScene): number[] {
  const seen = new Map<number, number>();
  for (const id of scene.cast) {
    const m = effectiveMic(show, scene, id);
    if (m != null) seen.set(m, (seen.get(m) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([m]) => m);
}

export interface MicTarget {
  mic: number;
  charId: string;
  live: boolean;
  fx: FxChoice | null;
}

/** What a cue asks of every cast member's mic. */
export function cueTargets(show: SoundShow, scene: SoundScene, cueIndex: number): MicTarget[] {
  const cue = scene.cues[cueIndex];
  if (!cue) return [];
  const out: MicTarget[] = [];
  for (const id of scene.cast) {
    const mic = effectiveMic(show, scene, id);
    if (mic == null) continue;
    const fx = cue.fx[id];
    out.push({ mic, charId: id, live: cue.live.includes(id), fx: fx && presetById(show, fx.preset) ? fx : null });
  }
  return out;
}

/** Live state of a mic as the desk reports it (undefined: not known yet). */
export function micLive(show: SoundShow, rt: Runtime, n: number): boolean | undefined {
  const ch = micInput(show, n);
  if (!ch) return undefined;
  const muted = rt.channels[chKey(ch)]?.muted;
  return muted === undefined ? undefined : !muted;
}

/** Name the desk shows for a mic's channel. */
export function micDeskName(show: SoundShow, rt: Runtime, n: number): string | undefined {
  const ch = micInput(show, n);
  return ch ? rt.channels[chKey(ch)]?.name : undefined;
}

/**
 * Resolve `who` (OSC / MCP / API): a mic number ("3"), a character id, or a character name (case-insensitive).
 * A character resolves to their mic in `scene` (the active or selected scene), else their default mic.
 */
export function resolveWho(show: SoundShow, scene: SoundScene | null, who: string | number): { mic: number; charId: string | null } | null {
  const w = String(who).trim();
  if (/^\d+$/.test(w)) {
    const n = Number(w);
    if (!show.mics.some((m) => m.n === n)) return null;
    return { mic: n, charId: holderOf(show, scene, n)?.char.id ?? null };
  }
  const lw = w.toLowerCase();
  const char = show.characters.find((c) => c.id === w) ?? show.characters.find((c) => c.name.toLowerCase() === lw);
  if (!char) return null;
  const mic = effectiveMic(show, scene, char.id);
  return mic == null ? null : { mic, charId: char.id };
}

export function resolvePreset(show: SoundShow, p: string): EffectPreset | null | "none" {
  const v = p.trim().toLowerCase();
  if (!v || v === "none" || v === "off" || v === "dry") return "none";
  return show.presets.find((x) => x.id === p) ?? show.presets.find((x) => x.name.toLowerCase() === v) ?? null;
}

/** Send level in dB for a preset send at an amount (clamped to +10 dB). */
export function sendDb(db: number, amount: FxAmount): number {
  return Math.min(10, db + FX_AMOUNT_DB[amount]);
}

/** Resolve a scene reference: id, code ("7", "2.1"), or name (case-insensitive). */
export function resolveScene(show: SoundShow, ref: string): SoundScene | null {
  const r = String(ref).trim();
  const lr = r.toLowerCase();
  return show.scenes.find((s) => s.id === r) ?? show.scenes.find((s) => s.code === r) ?? show.scenes.find((s) => s.name.toLowerCase() === lr) ?? null;
}

export const visibleScenes = (show: SoundShow) => [...show.scenes].sort((a, b) => a.order - b.order);

/** Mic numbers live but not in the cast of the given scene (the operator's "stray mic" warning). */
export function strayMics(show: SoundShow, rt: Runtime, scene: SoundScene | null): number[] {
  const inScene = new Set(scene ? scene.cast.map((id) => effectiveMic(show, scene, id)).filter((m): m is number => m != null) : []);
  return show.mics.map((m) => m.n).filter((n) => !inScene.has(n) && micLive(show, rt, n) === true);
}

/** Channels a preset needs: FX sends and the watched returns / DCAs. */
export function presetChannels(p: EffectPreset): DliveChannel[] {
  return [...p.sends.map((s) => ({ kind: s.kind, number: s.number }) as DliveChannel), ...p.watch.map((w) => ({ kind: w.kind, number: w.number }) as DliveChannel)];
}

/** Why a preset would be silent: a watched FX return at −inf or muted, a DCA muted. */
export function presetWarnings(p: EffectPreset, rt: Runtime): string[] {
  const out: string[] = [];
  for (const w of p.watch) {
    const st = rt.channels[chKey(w)];
    if (!st) continue;
    const label = `${w.kind === "dca" ? "DCA" : "FX return"} ${w.number}${st.name ? ` “${st.name}”` : ""}`;
    if (st.muted) out.push(`${label} is muted`);
    if (w.kind === "fxReturn" && st.fader === 0) out.push(`${label} is at −∞`);
  }
  return out;
}

/** Mics the desk names "Drama 3", "Drama3", "Dram12", "Radio 4", "RF5", "Mic 6" → mic number → input channel. */
export function detectMicsFromNames(names: Record<number, string>, micCount: number): Record<number, number> {
  const found: Record<number, number> = {};
  const re = /^(?:drama?|dram|radio|rf|mic|wl|wireless)\s*0*(\d{1,2})\b/i;
  for (const [ch, name] of Object.entries(names)) {
    const m = re.exec(name.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= micCount && found[n] === undefined) found[n] = Number(ch);
  }
  return found;
}

/** A scene's mic list as one string ("joseph=2,mary=1"), so a check can tell if anything moved since. */
export function micSig(cast: string[], mics: Record<string, number>): string {
  return [...cast].sort().map((id) => `${id}=${mics[id] ?? ""}`).join(",");
}

export type CheckState = "ok" | "stale" | "none";

/** "ok": backstage checked these exact mics; "stale": checked, but people or mics changed since. */
export function checkState(scene: { cast: string[]; mics: Record<string, number>; micsAt: number; checked: SceneCheck | null }): CheckState {
  const c = scene.checked;
  if (!c) return "none";
  if (c.sig !== undefined) return c.sig === micSig(scene.cast, scene.mics) ? "ok" : "stale";
  return c.at >= scene.micsAt ? "ok" : "stale";
}

export const sceneCheckState = (show: SoundShow, sc: SoundScene) => checkState({ cast: sc.cast, mics: effectiveMics(show, sc), micsAt: sc.micsAt, checked: sc.checked });

/** The scene after `id` in running order that has people with mics (the first one when `id` is null). */
export function followingScene(show: SoundShow, id: string | null): SoundScene | null {
  const list = visibleScenes(show).filter((s) => !s.removed && s.cast.length);
  if (!id) return list[0] ?? null;
  const all = visibleScenes(show);
  const at = all.findIndex((s) => s.id === id);
  if (at < 0) return list[0] ?? null;
  return all.slice(at + 1).find((s) => !s.removed && s.cast.length) ?? null;
}

/** Where backstage should be looking next: what the operator set, else the scene after the live one. */
export function nextSceneFor(show: SoundShow, rt: Runtime | null): string | null {
  if (!rt) return followingScene(show, null)?.id ?? null;
  const pinned = sceneById(show, rt.nextSceneId);
  if (pinned && pinned.id !== rt.activeSceneId) return pinned.id;
  return followingScene(show, rt.activeSceneId)?.id ?? null;
}

/** The slice of the show the backstage page needs. */
export function backstageView(show: SoundShow, rt: Runtime | null): BackstageView {
  return {
    showName: show.name,
    scenes: visibleScenes(show)
      .filter((s) => !s.removed && s.cast.length)
      .map((s) => ({ id: s.id, code: s.code, name: s.name, cast: s.cast, mics: effectiveMics(show, s), micsAt: s.micsAt, checked: s.checked })),
    characters: show.characters.map((c) => ({ id: c.id, name: c.name, gender: c.gender, palette: c.palette, photo: c.photo, thumb: c.thumb, defaultMic: c.defaultMic })),
    micCount: show.mics.length,
    activeSceneId: rt?.activeSceneId ?? null,
    nextSceneId: nextSceneFor(show, rt),
  };
}

/** Assign a mic to a cast member for one scene; whoever in the cast held it gets the old mic (a swap). */
export function assignMic(show: SoundShow, scene: SoundScene, charId: string, mic: number): void {
  const old = effectiveMic(show, scene, charId);
  for (const id of scene.cast) {
    if (id !== charId && effectiveMic(show, scene, id) === mic) {
      if (old != null) scene.mics[id] = old;
      else delete scene.mics[id];
    }
  }
  scene.mics[charId] = mic;
  // Keep the file tidy: an assignment equal to the default is not an override.
  for (const id of Object.keys(scene.mics)) if (charById(show, id)?.defaultMic === scene.mics[id]) delete scene.mics[id];
}

/** LiveStage's display numbers ("3", "2.1"): grouped scenes share a number, the same as src/core/groups.ts. */
export function liveStageCodes(scenes: { id: string; groupId?: string | null }[], groupIds: Set<string>): Map<string, string> {
  const codes = new Map<string, string>();
  let n = 0;
  let curGroup: string | null = null;
  let inGroup = 0;
  for (const s of scenes) {
    const g = s.groupId && groupIds.has(s.groupId) ? s.groupId : null;
    if (g && g === curGroup) {
      inGroup++;
      codes.set(s.id, `${n}.${inGroup}`);
      continue;
    }
    n++;
    curGroup = g;
    inGroup = 1;
    codes.set(s.id, g ? `${n}.1` : String(n));
  }
  return codes;
}
