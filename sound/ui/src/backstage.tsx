// Backstage mic check (phone). Pick the scene with the arrows, tap someone's big mic number to give them
// another one (swaps with whoever had it), then "All good". Works two ways with the same page:
//   local  served by the Sound app on the LAN, talks to it over a WebSocket
//   cloud  #c=… in the URL (from the QR code): talks straight to Firebase's Realtime Database

import "./app.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { checkState, micSig } from "../../server/logic.ts";
import type { BackstageView } from "../../server/model.ts";
import { cloudSource, localSource, readCloudConfig, type Source, type SourceState } from "./backstage/sources.ts";
import { Avatar, Dot, Icon } from "./lib/ui.tsx";

const NAME_KEY = "sound.backstage.name";
const SCENE_KEY = "sound.backstage.scene";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function useSource(src: Source): SourceState {
  const [s, setS] = useState<SourceState>(src.state);
  useEffect(() => src.subscribe(setS), [src]);
  return s;
}

type Follow = "next" | "live" | "manual";
const FOLLOW_KEY = "sound.backstage.follow";

function App({ src }: { src: Source }) {
  const st = useSource(src);
  const view = st.view;
  const [sceneId, setSceneId] = useState<string | null>(() => store.get(SCENE_KEY));
  // By default the phone follows the scene to check next; the arrows switch to browsing on your own.
  const [follow, setFollowState] = useState<Follow>(() => (store.get(FOLLOW_KEY) as Follow) || "next");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(() => store.get(NAME_KEY) ?? "");
  const [flash, setFlash] = useState<string | null>(null);
  const scenes = view?.scenes ?? [];
  const liveId = view?.activeSceneId ?? null;
  const nextId = view?.nextSceneId ?? null;
  const setFollow = (f: Follow) => {
    setFollowState(f);
    store.set(FOLLOW_KEY, f);
    setEditing(null);
  };
  const idx = useMemo(() => {
    const at = (id: string | null) => (id ? scenes.findIndex((s) => s.id === id) : -1);
    const want = follow === "next" ? at(nextId) : follow === "live" ? at(liveId) : at(sceneId);
    if (want >= 0) return want;
    const fallback = [at(nextId), at(liveId), at(sceneId)].find((i) => i >= 0);
    return fallback ?? 0;
  }, [scenes, sceneId, follow, nextId, liveId]);
  const scene = scenes[idx] ?? null;

  // The sound desk moved "next" on: tell whoever is following it.
  const lastNext = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!view) return;
    const prev = lastNext.current;
    lastNext.current = nextId;
    if (prev === undefined || prev === nextId || !nextId || follow !== "next") return;
    const sc = scenes.find((s) => s.id === nextId);
    if (!sc) return;
    setEditing(null);
    setFlash(`Next up: scene ${sc.code}. Check the mics.`);
    try {
      navigator.vibrate?.([120, 80, 120]);
    } catch {
      /* not supported */
    }
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [nextId, view, follow, scenes]);

  const go = (d: number) => {
    if (!scenes.length) return;
    const next = scenes[(idx + d + scenes.length) % scenes.length];
    setSceneId(next.id);
    store.set(SCENE_KEY, next.id);
    setFollow("manual");
  };
  const statusColor = st.status === "synced" ? "#B8F25C" : st.status === "connecting" ? "#FFB547" : "#FF6B5E";
  const statusText = st.status === "synced" ? "Synced" : st.status === "connecting" ? "Connecting" : "Offline";
  const askName = () => {
    const n = prompt("Your name (shown to the sound desk)", name)?.trim();
    if (n !== undefined && n !== null) {
      setName(n.slice(0, 40));
      store.set(NAME_KEY, n.slice(0, 40));
    }
  };
  const byId = (id: string | null) => (id ? scenes.find((s) => s.id === id) ?? null : null);
  const check = scene ? checkState(scene) : "none";

  return (
    <div className="mx-auto flex h-dvh max-w-[520px] flex-col bg-ink text-text">
      <header className="flex flex-col gap-3 px-[18px] pt-[22px] pb-3">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-sm font-black tracking-[1.5px] text-muted">MIC CHECK</span>
          <button type="button" onClick={askName} className="rounded-full bg-card px-3 py-1 text-[13px] font-extrabold text-muted">
            {name || "Your name"}
          </button>
          <span className="inline-flex items-center gap-1.5 text-[13px] font-extrabold text-muted" title={st.error ?? ""}>
            <Dot color={statusColor} size={8} />
            {statusText}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PointerChip label="LIVE" scene={byId(liveId)} on={follow === "live"} color="#B8F25C" onClick={() => setFollow("live")} />
          <PointerChip label="NEXT" scene={byId(nextId)} on={follow === "next"} color="#8FE3F5" onClick={() => setFollow("next")} />
        </div>
        <div className="flex items-center gap-2.5">
          <button type="button" onClick={() => go(-1)} aria-label="Previous scene" className="inline-flex size-12 items-center justify-center rounded-2xl bg-card">
            <Icon name="left" stroke={2.8} />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <div className="flex items-center justify-center gap-2 text-sm font-black text-muted">
              {scene ? `SCENE ${scene.code}` : "NO SCENES"}
              {scene && scene.id === liveId && <span className="rounded-full bg-lime px-2 py-0.5 text-[11px] text-ink">LIVE</span>}
              {scene && scene.id === nextId && <span className="rounded-full bg-[#8FE3F5] px-2 py-0.5 text-[11px] text-ink">NEXT</span>}
            </div>
            <div className="truncate text-[22px] leading-[1.15] font-black">{scene?.name ?? (view ? "Nothing to check" : "Loading…")}</div>
          </div>
          <button type="button" onClick={() => go(1)} aria-label="Next scene" className="inline-flex size-12 items-center justify-center rounded-2xl bg-card">
            <Icon name="right" stroke={2.8} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 pt-1 pb-3.5">
        {flash && <div className="rounded-2xl bg-[#10303A] px-4 py-3 text-[17px] font-black text-[#8FE3F5]">{flash}</div>}
        {st.error && st.status !== "synced" && <div className="rounded-2xl bg-coral-bg px-4 py-3 text-sm font-extrabold text-coral-text">{st.error}</div>}
        {scene && view && <People view={view} scene={scene} editing={editing} setEditing={setEditing} assign={(c, m) => void src.assign(scene.id, c, m)} />}
      </div>

      {scene && (
        <footer className="flex flex-col gap-2 border-t border-line px-3.5 pt-3 pb-[max(22px,env(safe-area-inset-bottom))]">
          {check === "stale" && <span className="text-center text-[14px] font-black text-[#FFC970]">Mics changed since the last check: check again</span>}
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              void src.confirm(scene.id, name || "Backstage", micSig(scene.cast, scene.mics));
            }}
            className="flex h-16 items-center justify-center gap-2.5 rounded-[22px] text-[22px] font-black text-ink active:scale-[0.98]"
            style={{ background: check === "ok" ? "#5A6273" : "#B8F25C" }}
          >
            <Icon name="check" size={24} stroke={3} />
            {check === "ok" ? "Checked" : "All good"}
          </button>
          <span className="text-center text-[13px] font-extrabold text-muted">
            {check === "ok" && scene.checked ? `Checked by ${scene.checked.by} · ${new Date(scene.checked.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · the sound desk can see it` : "Tap a mic number to change it"}
          </span>
        </footer>
      )}
    </div>
  );
}

/** LIVE / NEXT shortcut: tap to follow that scene (the phone then moves with it). */
function PointerChip({ label, scene, on, color, onClick }: { label: string; scene: BackstageView["scenes"][number] | null; on: boolean; color: string; onClick: () => void }) {
  const state = scene ? checkState(scene) : "none";
  return (
    <button type="button" onClick={onClick} disabled={!scene} aria-pressed={on} className="flex min-w-0 items-center gap-2 rounded-2xl border-2 px-3 py-2 text-left disabled:opacity-40" style={{ borderColor: on ? color : "#1E232D", background: on ? "#151922" : "#0F1218" }}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] font-black tracking-[1px]" style={{ color }}>
          {label}
        </span>
        <span className="truncate text-[15px] font-black">{scene ? `${scene.code} · ${scene.name}` : "—"}</span>
      </span>
      {scene && <CheckMark state={state} />}
    </button>
  );
}

function CheckMark({ state }: { state: "ok" | "stale" | "none" }) {
  if (state === "ok")
    return (
      <span aria-label="Checked" className="inline-flex size-7 flex-none items-center justify-center rounded-full bg-lime text-ink">
        <Icon name="check" size={16} stroke={3.2} />
      </span>
    );
  return <span aria-label={state === "stale" ? "Changed since check" : "Not checked"} className="size-3 flex-none rounded-full" style={{ background: state === "stale" ? "#FFB547" : "#3A4256" }} />;
}

function People({ view, scene, editing, setEditing, assign }: { view: BackstageView; scene: BackstageView["scenes"][number]; editing: string | null; setEditing: (id: string | null) => void; assign: (charId: string, mic: number) => void }) {
  const chars = new Map(view.characters.map((c) => [c.id, c]));
  const owner = new Map<number, string>();
  for (const id of scene.cast) if (scene.mics[id] !== undefined) owner.set(scene.mics[id], id);
  const cast = scene.cast.map((id) => chars.get(id)).filter((c): c is NonNullable<typeof c> => !!c)
    // Stable order (by usual mic), so a card does not jump away when its number changes.
    .sort((a, b) => (a.defaultMic ?? 99) - (b.defaultMic ?? 99) || a.name.localeCompare(b.name));
  if (!cast.length) return <div className="p-6 text-center text-lg font-extrabold text-muted">Nobody in this scene wears a mic.</div>;
  return (
    <>
      {cast.map((c) => {
        const mic = scene.mics[c.id];
        const isEditing = editing === c.id;
        const changed = mic !== undefined && mic !== c.defaultMic;
        return (
          <div key={c.id} className="flex flex-col gap-3.5 rounded-[26px] border-2 bg-card p-3.5" style={{ borderColor: isEditing ? "#B8F25C" : changed ? "#7A5A1F" : "#151922" }}>
            <button type="button" onClick={() => setEditing(isEditing ? null : c.id)} aria-label={`Change mic for ${c.name}`} className="flex items-center gap-3.5 text-left text-text">
              <Avatar c={c} size={68} photoBase={location.hash.startsWith("#c=") ? null : "/photos/"} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[26px] leading-[1.05] font-black">{c.name}</span>
                {changed && <span className="self-start rounded-full bg-amber-bg px-2.5 py-0.5 text-xs font-black text-[#FFC970]">CHANGED</span>}
              </span>
              <span className="flex flex-col items-center gap-0.5">
                <span className="text-[11px] font-black tracking-[1px] text-muted">MIC</span>
                <span className="inline-flex size-16 items-center justify-center rounded-[20px] text-[32px] font-black" style={{ background: isEditing ? "#B8F25C" : "#222837", color: isEditing ? "#0B0D12" : "#F4F6FA" }}>
                  {mic ?? "–"}
                </span>
              </span>
            </button>
            {isEditing && (
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: view.micCount }, (_, i) => i + 1).map((num) => {
                  const who = owner.get(num);
                  const mine = who === c.id;
                  const other = who && !mine ? chars.get(who)?.name ?? "" : "";
                  const offstage = !who ? view.characters.find((x) => x.defaultMic === num && !scene.cast.includes(x.id))?.name : undefined;
                  return (
                    <button
                      key={num}
                      type="button"
                      onClick={() => {
                        setEditing(null);
                        if (!mine) assign(c.id, num);
                      }}
                      aria-label={`Mic ${num}${other ? `, ${other} has it` : ""}`}
                      className="flex h-14 flex-col items-center justify-center rounded-2xl border-2"
                      style={{ background: mine ? "#B8F25C" : "#0F1218", borderColor: mine ? "#B8F25C" : "#2A303D", color: mine ? "#0B0D12" : who ? "#7C8597" : "#F4F6FA" }}
                    >
                      <span className="text-[22px] leading-none font-black">{num}</span>
                      <span className="max-w-full truncate px-1 text-[10px] font-extrabold opacity-80">{other || (offstage ? <span className="opacity-60">{offstage}</span> : "")}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

const cfg = readCloudConfig(location.hash);
const src = cfg ? cloudSource(cfg) : localSource();
createRoot(document.getElementById("root")!).render(<App src={src} />);
