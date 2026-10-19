import { create } from "zustand";
import { applyPrologueFeel, defaultProject, LION_PROOF_ASSETS, PROLOGUE_ASSETS, PROLOGUE_DEMO, PROLOGUE_FEEL, prologueScenes, LION_PROOF_CUTOUTS, LION_PROOF_DEMO, lionProofIdleClip, lionProofLayout, lionProofScene, SHEPHERD_PHOTOREAL_DEMO, shepherdPhotorealScene } from "@/core/defaultProject";
import { SHOW_SCAFFOLD_DEMO, showScaffoldScenes } from "@/core/showScaffold";
import { cloneComponent, cloneScene, defaultHogItems, defaultIo, defaultOutput, defaultTimers, HOG_DEFAULT_HOST, makeGroup, makeScene } from "@/core/factories";
import { autoGroup, normalizeGroups } from "@/core/groups";
import { FOH_ASSETS, FOH_CALLS, FOH_PIN, fohAnnouncements } from "@/core/fohCalls";
import { loadProjectFile, resolveAssetUrls, saveProjectFile } from "@/core/platform";
import type { Asset, OutputSettings, Project, Scene, SceneComponent, SceneGroup } from "@/core/types";

export type AppMode = "show" | "builder";

interface ProjectStore {
  project: Project;
  loaded: boolean;
  dirty: boolean;
  savedAt: number | null;
  saveError: string | null;
  mode: AppMode;
  selectedSceneId: string | null;
  selectedComponentId: string | null;

  load(): Promise<void>;
  save(): Promise<void>;
  /** Swap in a whole show (import, package, sync): migrated, and its media pointed at this machine's files. */
  replaceProject(p: Project): Promise<void>;
  resetToDemo(): void;
  setMode(m: AppMode): void;
  selectScene(id: string | null): void;
  selectComponent(id: string | null): void;

  update(fn: (draft: Project) => void): void;
  updateScene(id: string, fn: (s: Scene) => void): void;
  addScene(): string;
  duplicateScene(id: string): string | null;
  deleteScene(id: string): void;
  moveScene(id: string, dir: -1 | 1): void;
  /** Put a scene in a group (null = take it out); a new group is made when `groupId` is "new". */
  setSceneGroup(sceneId: string, groupId: string | null | "new"): void;
  updateGroup(id: string, fn: (g: SceneGroup) => void): void;
  /** Dissolve a group; its scenes stay where they are. */
  ungroup(id: string): void;
  moveGroup(id: string, dir: -1 | 1): void;

  addComponent(sceneId: string, c: SceneComponent): void;
  updateComponent(sceneId: string, compId: string, fn: (c: SceneComponent) => void): void;
  duplicateComponent(sceneId: string, compId: string): void;
  removeComponent(sceneId: string, compId: string): void;
  moveComponent(sceneId: string, compId: string, dir: -1 | 1): void;

  addAssets(a: Asset[]): void;
  removeAsset(id: string): void;
  setOutput(partial: Partial<OutputSettings>): void;
  setThumbnail(sceneId: string, dataUrl: string): void;
}

/** Keep groups together and the running-order numbers in step. */
function renumber(p: Project) {
  normalizeGroups(p);
}

const SCENE_GROUPS = "scene-groups-1";

/** Fill fields added in later versions so old show files keep loading. */
export function migrateProject(p: Project): Project {
  const out = { ...defaultOutput(), ...p.output };
  out.safeArea = { ...defaultOutput().safeArea, ...p.output?.safeArea };
  out.standby = { ...defaultOutput().standby, ...p.output?.standby };
  out.timerOverlay = { ...defaultOutput().timerOverlay, ...p.output?.timerOverlay };
  const io = { ...defaultIo(), ...(p.io ?? {}) };
  io.midi = { ...defaultIo().midi, ...(p.io?.midi ?? {}) };
  io.osc = { ...defaultIo().osc, ...(p.io?.osc ?? {}) };
  io.triggers = p.io?.triggers ?? [];
  io.hogItems = p.io?.hogItems ?? defaultHogItems();
  // The first build shipped a placeholder console address; point it at the real HogNet default.
  io.osc.targets = io.osc.targets.map((t) => (t.id === "osc_hog" && t.host === "192.168.1.10" ? { ...t, host: HOG_DEFAULT_HOST } : t));
  const merged: Project = { ...p, output: out, io, effectPresets: p.effectPresets ?? [], assets: p.assets ?? [], demoAdditions: p.demoAdditions ?? [] };
  // Merge new built-in demo content once; if the user later deletes it, it stays deleted.
  if (!merged.demoAdditions!.includes(LION_PROOF_DEMO)) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...merged.assets, ...LION_PROOF_ASSETS.filter((a) => !have.has(a.id))];
    merged.scenes = [...merged.scenes];
    merged.scenes.splice(Math.min(1, merged.scenes.length), 0, lionProofScene(2));
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, LION_PROOF_DEMO];
  }
  // v1 of the proof scene predates vertical framing; frame it so the mane is not cropped.
  if (!merged.demoAdditions!.includes("lion-proof-anchor")) {
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        const isProofPlate = c.kind === "background" && c.media.assetId === "asset_lp_plate";
        const isProofActor = c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_lp_walk");
        if ((isProofPlate || isProofActor) && c.anchorY === undefined) c.anchorY = 0.3;
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "lion-proof-anchor"];
  }
  // Add the pacing idle loop to shows that got the proof scene before it existed.
  if (!merged.demoAdditions!.includes("lion-proof-idle")) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...merged.assets, ...LION_PROOF_ASSETS.filter((a) => !have.has(a.id))];
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        if (c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_lp_walk") && !c.clips.some((k) => k.assetId === "asset_lp_idle")) {
          c.clips.push(lionProofIdleClip());
        }
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "lion-proof-idle"];
  }
  // Pair each proof clip with its cut-out version and give the actor a layout.
  if (!merged.demoAdditions!.includes("lion-proof-cutout")) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...merged.assets, ...LION_PROOF_ASSETS.filter((a) => !have.has(a.id))];
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        if (c.kind !== "clipActor" || !c.clips.some((k) => k.assetId === "asset_lp_walk")) continue;
        for (const k of c.clips) if (k.assetId && LION_PROOF_CUTOUTS[k.assetId] && !k.cutoutAssetId) k.cutoutAssetId = LION_PROOF_CUTOUTS[k.assetId];
        c.layout ??= lionProofLayout();
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "lion-proof-cutout"];
  }
  // The photoreal Shepherd's Valley experiment, placed right after the procedural one.
  if (!merged.demoAdditions!.includes(SHEPHERD_PHOTOREAL_DEMO)) {
    const at = merged.scenes.findIndex((s) => s.environment === "shepherd-valley");
    merged.scenes = [...merged.scenes];
    merged.scenes.splice(at >= 0 ? at + 1 : merged.scenes.length, 0, shepherdPhotorealScene(0));
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, SHEPHERD_PHOTOREAL_DEMO];
  }
  // The prologue (P1–P4) opens the show, so it goes first.
  if (!merged.demoAdditions!.includes(PROLOGUE_DEMO)) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...PROLOGUE_ASSETS.filter((a) => !have.has(a.id)), ...merged.assets];
    merged.scenes = [...prologueScenes(), ...merged.scenes];
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, PROLOGUE_DEMO];
  }
  // Prologue tweaks after the first run-through: a stone the audience can see, P3 framed lower.
  if (!merged.demoAdditions!.includes("prologue-tweaks-1")) {
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        if (c.kind === "effect" && c.effect === "projectile" && c.name === "Sling stone" && c.params.size === 0.018) {
          c.params = { ...c.params, size: 0.03, glow: 1.2 };
        }
        const isP3 =
          (c.kind === "background" && c.media.assetId === "asset_pr_david_lion") ||
          (c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_pr_david_loop"));
        if (isP3 && (c.kind === "background" || c.kind === "clipActor") && c.anchorY === 0.35) c.anchorY = 0.42;
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "prologue-tweaks-1"];
  }
  // The rest of the show, scaffolded from the script's LED cues, follows the prologue.
  if (!merged.demoAdditions!.includes(SHOW_SCAFFOLD_DEMO)) {
    const after = merged.scenes.findIndex((s) => s.components.some((c) => c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_pr_goliath_fall")));
    merged.scenes = [...merged.scenes];
    merged.scenes.splice(after >= 0 ? after + 1 : merged.scenes.length, 0, ...showScaffoldScenes());
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, SHOW_SCAFFOLD_DEMO];
  }
  // Hand-held drift and parallax on P1 and P3.
  if (!merged.demoAdditions!.includes(PROLOGUE_FEEL)) {
    applyPrologueFeel(merged.scenes);
    merged.demoAdditions = [...merged.demoAdditions!, PROLOGUE_FEEL];
  }
  if (!merged.demoAdditions!.includes(SCENE_GROUPS)) {
    // Older shows were one flat list: group the Prologue's places (and "Scene 1" + "Scene 1b" runs).
    autoGroup(merged, (name, color) => makeGroup(name, color));
    merged.demoAdditions = [...merged.demoAdditions!, SCENE_GROUPS];
  }
  renumber(merged);
  merged.timers ??= defaultTimers();
  merged.announcements ??= [];
  if (!merged.demoAdditions!.includes(FOH_CALLS)) {
    // The recorded front-of-house calls: library assets plus a ready announcement button each.
    merged.assets = [...merged.assets, ...FOH_ASSETS.filter((a) => !merged.assets.some((x) => x.id === a.id))];
    merged.announcements = [...merged.announcements, ...fohAnnouncements().filter((a) => !merged.announcements!.some((x) => x.id === a.id))];
    merged.demoAdditions = [...merged.demoAdditions!, FOH_CALLS];
  }
  if (!merged.demoAdditions!.includes(FOH_PIN)) {
    merged.announcements = merged.announcements.map((a) => (a.id === "ann_foh_technical" ? { ...a, pinned: true, urgent: true } : a));
    merged.demoAdditions = [...merged.demoAdditions!, FOH_PIN];
  }
  // Built-in assets ship with the app: keep their definitions in step with the code.
  const builtIn = new Map([...PROLOGUE_ASSETS, ...LION_PROOF_ASSETS, ...FOH_ASSETS].map((a) => [a.id, a]));
  // Keep the keys of local copies (from a show package or sync); resolveAssetUrls points at them when present.
  merged.assets = merged.assets.map((a) => (a.builtIn && builtIn.has(a.id) ? { ...builtIn.get(a.id)!, file: a.file, macFile: a.macFile } : a));
  return merged;
}

export const useProject = create<ProjectStore>((set, get) => ({
  project: defaultProject(),
  loaded: false,
  dirty: false,
  savedAt: null,
  saveError: null,
  mode: "show",
  selectedSceneId: null,
  selectedComponentId: null,

  async load() {
    const saved = await loadProjectFile();
    const project = saved ? migrateProject(saved) : defaultProject();
    project.assets = await resolveAssetUrls(project.assets);
    set({ project, loaded: true, dirty: !saved, selectedSceneId: project.scenes[0]?.id ?? null });
  },

  async save() {
    try {
      await saveProjectFile(get().project);
      set({ dirty: false, savedAt: Date.now(), saveError: null });
    } catch (e) {
      set({ saveError: String(e) });
    }
  },

  async replaceProject(p) {
    const project = migrateProject(p);
    project.assets = await resolveAssetUrls(project.assets);
    set({ project, dirty: true, selectedSceneId: project.scenes[0]?.id ?? null, selectedComponentId: null });
  },

  resetToDemo() {
    const project = defaultProject();
    set({ project, dirty: true, selectedSceneId: project.scenes[0]?.id ?? null, selectedComponentId: null });
  },

  setMode: (mode) => set({ mode }),
  selectScene: (id) => set({ selectedSceneId: id, selectedComponentId: null }),
  selectComponent: (id) => set({ selectedComponentId: id }),

  update(fn) {
    const draft = structuredClone(get().project);
    fn(draft);
    set({ project: draft, dirty: true });
  },

  updateScene(id, fn) {
    get().update((p) => {
      const s = p.scenes.find((x) => x.id === id);
      if (s) fn(s);
    });
  },

  addScene() {
    const s = makeScene(get().project.scenes.length + 1, "New Scene");
    get().update((p) => p.scenes.push(s));
    set({ selectedSceneId: s.id });
    return s.id;
  },

  duplicateScene(id) {
    const src = get().project.scenes.find((s) => s.id === id);
    if (!src) return null;
    const copy = cloneScene(src, 0);
    get().update((p) => {
      p.scenes.splice(p.scenes.findIndex((s) => s.id === id) + 1, 0, copy);
      renumber(p);
    });
    set({ selectedSceneId: copy.id });
    return copy.id;
  },

  deleteScene(id) {
    const scenes = get().project.scenes;
    const idx = scenes.findIndex((s) => s.id === id);
    get().update((p) => {
      p.scenes = p.scenes.filter((s) => s.id !== id);
      renumber(p);
    });
    const next = get().project.scenes[Math.min(idx, get().project.scenes.length - 1)];
    set({ selectedSceneId: next?.id ?? null });
  },

  moveScene(id, dir) {
    get().update((p) => {
      const i = p.scenes.findIndex((s) => s.id === id);
      const s = p.scenes[i];
      const n = p.scenes[i + dir];
      if (!s || !n) return;
      if (s.groupId || !n.groupId) {
        // Inside a group a scene only moves within it; loose scenes swap with loose neighbours.
        if (s.groupId && n.groupId !== s.groupId) return;
        [p.scenes[i], p.scenes[i + dir]] = [n, s];
      } else {
        // A loose scene steps over a whole group.
        p.scenes.splice(i, 1);
        const members = p.scenes.map((x, k) => (x.groupId === n.groupId ? k : -1)).filter((k) => k >= 0);
        p.scenes.splice(dir < 0 ? members[0] : members[members.length - 1] + 1, 0, s);
      }
      renumber(p);
    });
  },

  setSceneGroup(sceneId, groupId) {
    get().update((p) => {
      const s = p.scenes.find((x) => x.id === sceneId);
      if (!s) return;
      p.groups ??= [];
      if (groupId === "new") {
        const g = makeGroup("New group", (["amber", "teal", "violet", "blue", "pink", "green"] as const)[p.groups.length % 6]);
        p.groups.push(g);
        s.groupId = g.id;
      } else if (groupId) {
        // Joining a group moves the scene to the end of it.
        p.scenes = p.scenes.filter((x) => x !== s);
        const last = p.scenes.map((x) => x.groupId).lastIndexOf(groupId);
        s.groupId = groupId;
        p.scenes.splice(last + 1, 0, s);
      } else if (s.groupId) {
        // Leaving puts it just after the group.
        const gid = s.groupId;
        s.groupId = null;
        p.scenes = p.scenes.filter((x) => x !== s);
        const last = p.scenes.map((x) => x.groupId).lastIndexOf(gid);
        p.scenes.splice(last + 1, 0, s);
      }
      renumber(p);
    });
  },

  updateGroup(id, fn) {
    get().update((p) => {
      const g = p.groups?.find((x) => x.id === id);
      if (g) fn(g);
    });
  },

  ungroup(id) {
    get().update((p) => {
      for (const s of p.scenes) if (s.groupId === id) s.groupId = null;
      renumber(p);
    });
  },

  moveGroup(id, dir) {
    get().update((p) => {
      const members = p.scenes.filter((s) => s.groupId === id);
      if (!members.length) return;
      const rest = p.scenes.filter((s) => s.groupId !== id);
      const at = rest.indexOf(dir < 0 ? p.scenes[p.scenes.indexOf(members[0]) - 1] : p.scenes[p.scenes.indexOf(members[members.length - 1]) + 1]);
      if (at < 0) return;
      // Step over the neighbouring row: a loose scene or a whole group.
      const nb = rest[at];
      let k = at;
      if (nb.groupId) {
        const idx = rest.map((s, i) => (s.groupId === nb.groupId ? i : -1)).filter((i) => i >= 0);
        k = dir < 0 ? idx[0] : idx[idx.length - 1];
      }
      rest.splice(dir < 0 ? k : k + 1, 0, ...members);
      p.scenes = rest;
      renumber(p);
    });
  },

  addComponent(sceneId, c) {
    get().updateScene(sceneId, (s) => s.components.push(c));
    set({ selectedComponentId: c.id });
  },

  updateComponent(sceneId, compId, fn) {
    get().updateScene(sceneId, (s) => {
      const c = s.components.find((x) => x.id === compId);
      if (c) fn(c);
    });
  },

  duplicateComponent(sceneId, compId) {
    let newId: string | null = null;
    get().updateScene(sceneId, (s) => {
      const i = s.components.findIndex((x) => x.id === compId);
      if (i < 0) return;
      const copy = cloneComponent(s.components[i]);
      newId = copy.id;
      s.components.splice(i + 1, 0, copy);
    });
    if (newId) set({ selectedComponentId: newId });
  },

  removeComponent(sceneId, compId) {
    get().updateScene(sceneId, (s) => {
      s.components = s.components.filter((c) => c.id !== compId);
      for (const cue of s.cues) {
        cue.actions = cue.actions.filter((a) => !Object.values(a).includes(compId));
      }
      for (const sh of s.cameraShots) if (sh.followActorId === compId) sh.followActorId = null;
    });
    if (get().selectedComponentId === compId) set({ selectedComponentId: null });
  },

  moveComponent(sceneId, compId, dir) {
    get().updateScene(sceneId, (s) => {
      const i = s.components.findIndex((c) => c.id === compId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.components.length) return;
      [s.components[i], s.components[j]] = [s.components[j], s.components[i]];
    });
  },

  addAssets(a) {
    get().update((p) => p.assets.push(...a));
  },

  removeAsset(id) {
    get().update((p) => {
      p.assets = p.assets.filter((a) => a.id !== id);
    });
  },

  setOutput(partial) {
    get().update((p) => Object.assign(p.output, partial));
  },

  setThumbnail(sceneId, dataUrl) {
    const p = get().project;
    const scenes = p.scenes.map((s) => (s.id === sceneId ? { ...s, thumbnail: dataUrl } : s));
    set({ project: { ...p, scenes }, dirty: true });
  },
}));

/** Stable empty list for selectors: a fresh `[]` each read makes React re-render forever. */
export const NO_ITEMS: never[] = Object.freeze([]) as never[];

export const selectedScene = (s: ProjectStore) => s.project.scenes.find((x) => x.id === s.selectedSceneId) ?? null;

// Autosave shortly after every edit. Show files are small; saving often is cheap insurance.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useProject.subscribe((s, prev) => {
  if (!s.loaded || s.project === prev.project || !s.dirty) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void useProject.getState().save(), 900);
});
// Never lose an edit to a reload: flush when the window hides or unloads.
if (typeof window !== "undefined") {
  const flush = () => {
    const s = useProject.getState();
    if (s.loaded && s.dirty) {
      if (saveTimer) clearTimeout(saveTimer);
      void s.save();
    }
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  window.addEventListener("beforeunload", flush);
}
