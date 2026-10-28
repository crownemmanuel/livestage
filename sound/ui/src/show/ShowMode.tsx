// Show mode: run the scene. Scenes on the left; the scene header with Activate / Next cue / End scene;
// the cue strip; one card per cast member with a big LIVE / MUTED toggle. What a card shows is what the
// desk reports, so a mute pressed on the surface shows here too.

import { useRef, useState } from "react";
import { castWithMics, holderOf, micLive, nextSceneFor, presetById, sceneById, sceneCheckState, strayMics, visibleScenes, type CheckState } from "../../../server/logic.ts";
import { AVATAR_PALETTE, FX_AMOUNTS, type Character, type FxAmount, type Runtime, type SoundScene, type SoundShow } from "../../../server/model.ts";
import { cmd, useOp } from "../lib/store.ts";
import { Avatar, Icon, cx } from "../lib/ui.tsx";

const WINDOW = 5;

export function ShowMode({ drawer, setDrawer }: { drawer: boolean; setDrawer: (v: boolean) => void }) {
  const show = useOp((s) => s.show)!;
  const rt = useOp((s) => s.runtime)!;
  const pending = useOp((s) => s.pending);
  const deskMode = useOp((s) => s.settings!.desk.mode);
  const [fxFor, setFxFor] = useState<{ char: Character; mic: number } | null>(null);
  const [music, setMusic] = useState(false);
  const scene = sceneById(show, rt.selectedSceneId) ?? visibleScenes(show)[0] ?? null;
  const active = sceneById(show, rt.activeSceneId);
  const deskDown = deskMode === "desk" && rt.desk.status !== "connected";
  const strays = strayMics(show, rt, active);
  return (
    <div className="relative flex min-h-0 flex-1 flex-wrap">
      <SceneList show={show} rt={rt} selected={scene?.id ?? null} />
      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-5 px-7 pt-[22px] pb-7">
        {deskDown && (
          <div className="flex items-center gap-3 rounded-[18px] bg-coral-bg px-[18px] py-3 text-[17px] font-black text-coral-text">
            <Icon name="warn" />
            <span className="flex-1">
              Desk {rt.desk.status === "connecting" ? "connecting" : "offline"}{rt.desk.error ? ` (${rt.desk.error})` : ""}: mic states may be out of date. Changes go out when it is back.
            </span>
            <button type="button" className="rounded-[14px] bg-coral px-5 py-2.5 text-base font-black text-[#1A0805]" onClick={() => void cmd("desk.reconnect")}>
              Reconnect
            </button>
          </div>
        )}
        {scene ? <SceneRun show={show} rt={rt} scene={scene} active={active?.id === scene.id} pending={pending} strays={strays} openFx={setFxFor} openMusic={() => setMusic(true)} /> : <EmptyShow />}
      </main>
      {fxFor && <FxPanel show={show} rt={rt} who={fxFor} onClose={() => setFxFor(null)} />}
      {music && <MusicPanel show={show} rt={rt} onClose={() => setMusic(false)} />}
      {drawer && <AllMics show={show} rt={rt} scene={active ?? scene} pending={pending} onClose={() => setDrawer(false)} />}
    </div>
  );
}

function EmptyShow() {
  return (
    <div className="rounded-[28px] border-2 border-dashed border-line2 p-10 text-xl font-extrabold text-muted">
      No scenes yet. Go to <b className="text-text">Build</b> and import the scenes from LiveStage.
    </div>
  );
}

function SceneList({ show, rt, selected }: { show: SoundShow; rt: Runtime; selected: string | null }) {
  const scenes = visibleScenes(show).filter((s) => !s.removed || s.id === rt.activeSceneId);
  const nextId = nextSceneFor(show, rt);
  return (
    <aside aria-label="Scenes" className="scroll-thin flex max-h-[calc(100vh-86px)] max-w-[310px] flex-[1_1_260px] flex-col gap-1.5 overflow-y-auto border-r border-line px-3.5 py-5">
      <div className="px-2.5 pb-2 text-[13px] font-extrabold tracking-[1.5px] text-muted">SCENES</div>
      {scenes.map((s) => {
        const sel = s.id === selected;
        const cast = castWithMics(show, s);
        return (
          <button key={s.id} type="button" onClick={() => void cmd("scene.select", { scene: s.id })} className="flex w-full items-center gap-3 rounded-2xl border-2 px-3 py-2.5 text-left" style={{ borderColor: sel ? "#3A4256" : "transparent", background: sel ? "#1C2130" : "transparent" }}>
            <span className="inline-flex h-[34px] min-w-11 items-center justify-center rounded-[10px] bg-chip px-2 text-sm font-black">{s.code}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
              <span className="truncate text-[15px] font-extrabold">{s.name}</span>
              <span className="flex items-center gap-[3px]">
                {cast.slice(0, 5).map(({ char }) => (
                  <span key={char.id} className="inline-flex size-5 items-center justify-center rounded-full text-[10px] font-black text-white" style={{ background: AVATAR_PALETTE[char.palette % 12].bg }}>
                    {char.name[0]}
                  </span>
                ))}
                {cast.length > 5 && <span className="ml-[3px] text-xs font-black text-muted">+{cast.length - 5}</span>}
                {!cast.length && <span className="text-xs font-extrabold text-ghost">no cast</span>}
              </span>
            </span>
            {s.id === rt.activeSceneId && <span className="rounded-full bg-lime px-2.5 py-1 text-xs font-black text-ink">LIVE</span>}
            {s.id === nextId && <span className="rounded-full bg-[#10303A] px-2.5 py-1 text-xs font-black text-[#8FE3F5]">NEXT</span>}
            {cast.length > 0 && <CheckBadge state={sceneCheckState(show, s)} />}
          </button>
        );
      })}
    </aside>
  );
}

/** Small mark in the scene list: lime tick = backstage checked these mics; amber = changed since. */
function CheckBadge({ state }: { state: CheckState }) {
  if (state === "ok")
    return (
      <span aria-label="Backstage checked" title="Backstage checked the mics" className="inline-flex size-6 flex-none items-center justify-center rounded-full bg-lime text-ink">
        <Icon name="check" size={14} stroke={3.2} />
      </span>
    );
  if (state === "stale") return <span aria-label="Mics changed since the check" title="Mics changed since the check" className="size-3 flex-none rounded-full bg-amber" />;
  return null;
}

/** Under the scene title: has backstage checked this scene's mics, plus "next for backstage" and "check again". */
function BackstageStatus({ show, rt, scene, active }: { show: SoundShow; rt: Runtime; scene: SoundScene; active: boolean }) {
  const state = sceneCheckState(show, scene);
  const isNext = nextSceneFor(show, rt) === scene.id;
  const at = scene.checked ? new Date(scene.checked.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2.5">
      {state === "ok" && (
        <span className="inline-flex items-center gap-2 rounded-full bg-lime px-3.5 py-1.5 text-[15px] font-black text-ink">
          <Icon name="check" size={16} stroke={3.2} />
          Backstage checked · {scene.checked!.by} · {at}
        </span>
      )}
      {state === "stale" && <span className="rounded-full bg-amber-bg px-3.5 py-1.5 text-[15px] font-black text-amber-text">Mics changed since {scene.checked!.by}'s check</span>}
      {state === "none" && <span className="rounded-full bg-chip px-3.5 py-1.5 text-[15px] font-black text-muted">Not checked backstage</span>}
      {!active &&
        (isNext ? (
          <span className="rounded-full bg-[#10303A] px-3.5 py-1.5 text-[15px] font-black text-[#8FE3F5]">Next for backstage{rt.nextPinned ? "" : " (running order)"}</span>
        ) : (
          <button type="button" onClick={() => void cmd("scene.next", { scene: scene.id })} className="rounded-full border-2 border-[#8FE3F5] px-3.5 py-1 text-[15px] font-black text-[#8FE3F5]">
            Send to backstage as next
          </button>
        ))}
      {state !== "none" && (
        <button type="button" onClick={() => void cmd("scene.recheck", { scene: scene.id })} className="rounded-full border-2 border-line2 px-3.5 py-1 text-[15px] font-black text-soft">
          Ask to check again
        </button>
      )}
    </div>
  );
}

function SceneRun({ show, rt, scene, active, pending, strays, openFx, openMusic }: { show: SoundShow; rt: Runtime; scene: SoundScene; active: boolean; pending: Record<string, boolean>; strays: number[]; openFx: (w: { char: Character; mic: number }) => void; openMusic: () => void }) {
  const [cuesOpen, setCuesOpen] = useState(false);
  const cast = castWithMics(show, scene);
  const crowded = cast.length > 6;
  const cueIdx = active ? rt.cue : -1;
  const total = scene.cues.length;
  let start = 0;
  let end = total;
  if (total > WINDOW + 2 && !cuesOpen) {
    start = Math.max(0, Math.min(cueIdx - 1, total - WINDOW));
    end = start + WINDOW;
  }
  const next = active ? scene.cues[cueIdx + 1] : null;
  const activeScene = sceneById(show, rt.activeSceneId);
  return (
    <>
      <section className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-[1_1_320px]">
          <div className="text-[15px] font-extrabold tracking-[1px] text-muted">
            SCENE {scene.code} · {cast.length} MIC{cast.length === 1 ? "" : "S"}
            {scene.removed && <span className="ml-3 rounded-full bg-amber-bg px-2.5 py-1 text-xs text-amber-text">GONE FROM LIVESTAGE</span>}
          </div>
          <h1 className="mt-1 text-[38px] leading-[1.1] font-black">{scene.name}</h1>
          {cast.length > 0 && <BackstageStatus show={show} rt={rt} scene={scene} active={active} />}
        </div>
        <div className="flex flex-wrap gap-3">
          <MusicButton show={show} rt={rt} onClick={openMusic} />
          {!active && (
            <button type="button" disabled={!total} onClick={() => void cmd("scene.activate", { scene: scene.id })} className="inline-flex items-center gap-2.5 rounded-[20px] bg-lime px-7 py-[18px] text-xl font-black text-ink disabled:opacity-40">
              <Icon name="play" size={22} stroke={2.6} />
              Activate scene
            </button>
          )}
          {active && (
            <>
              <button type="button" disabled={!next} onClick={() => void cmd("cue.next")} className="inline-flex items-center gap-3 rounded-[20px] px-6 py-3 text-left text-ink" style={{ background: next ? "#F4F6FA" : "#5A6273" }}>
                <span className="flex flex-col">
                  <span className="text-xl font-black">Next cue</span>
                  <span className="text-sm font-extrabold opacity-75">{next ? `Q${cueIdx + 2} · ${next.label}` : "Last cue"}</span>
                </span>
                <Icon name="next" size={26} stroke={2.6} />
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  void cmd("scene.end");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") void cmd("scene.end");
                }}
                className="inline-flex items-center gap-2.5 rounded-[20px] border-2 border-coral px-6 py-[18px] text-lg font-black text-coral-text"
              >
                <Icon name="stop" stroke={2.6} />
                End scene
              </button>
            </>
          )}
        </div>
      </section>

      {!active && activeScene && (
        <div className="-mt-2 text-[15px] font-extrabold text-muted">
          Live now: scene {activeScene.code} · {activeScene.name}. Activating this one mutes its mics that are not in this scene.
        </div>
      )}

      <section aria-label="Cues" className="flex flex-wrap items-center gap-2.5">
        {start > 0 && (
          <button type="button" onClick={() => setCuesOpen(true)} className="rounded-2xl border-2 border-line bg-panel px-4 py-3 text-[15px] font-black text-muted">
            {start} earlier
          </button>
        )}
        {scene.cues.slice(start, end).map((q, k) => {
          const i = start + k;
          const cur = i === cueIdx;
          const done = i < cueIdx;
          return (
            <button key={q.id} type="button" onClick={() => void cmd("cue.go", { scene: scene.id, cue: i + 1 })} className="flex items-center gap-2.5 rounded-2xl border-2 py-2 pr-4 pl-2 text-left" style={{ borderColor: cur ? "#F4F6FA" : "#1E232D", background: cur ? "#F4F6FA" : "#12151C", color: cur ? "#0B0D12" : done ? "#7C8597" : "#DDE3EC" }}>
              <span className="inline-flex size-9 items-center justify-center rounded-[11px] text-sm font-black" style={{ background: cur ? "#0B0D12" : "#222837", color: cur ? "#F4F6FA" : "#C9D0DC" }}>
                Q{i + 1}
              </span>
              <span className="text-base font-extrabold">{q.label}</span>
              {Object.keys(q.fx).length > 0 && (
                <span aria-label="Has an effect" className="inline-flex size-6 items-center justify-center rounded-full bg-violet-bg text-[#C9B8FF]">
                  <Icon name="sparkle" size={13} />
                </span>
              )}
              {q.trigger.kind === "livestage" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-cyan-bg px-[9px] py-1 text-xs font-black text-cyan-text">
                  <Icon name="link" size={13} />
                  LiveStage{q.trigger.at ? ` ${q.trigger.at}` : ""}
                </span>
              )}
            </button>
          );
        })}
        {(end < total || (cuesOpen && total > WINDOW + 2)) && (
          <button type="button" onClick={() => setCuesOpen(!cuesOpen)} className="rounded-2xl border-2 border-line bg-panel px-4 py-3 text-[15px] font-black text-soft">
            {cuesOpen ? "Show less" : `+${total - end} more`}
          </button>
        )}
        {!total && <span className="text-base font-extrabold text-ghost">No cues yet: add them in Build.</span>}
      </section>

      {strays.map((n) => {
        const who = holderOf(show, activeScene, n)?.char.name ?? `Mic ${n}`;
        return (
          <div key={n} className="flex items-center gap-3.5 rounded-[18px] bg-amber-bg py-3 pr-3 pl-[18px] text-amber-text">
            <Icon name="warn" size={22} />
            <span className="flex-1 text-[17px] font-black">
              {who} is live — {activeScene ? "not in this scene" : "no scene is active"}
            </span>
            <button type="button" onClick={() => void cmd("mic", { who: n, live: false })} className="rounded-[14px] bg-amber px-5 py-2.5 text-base font-black text-[#1F1404]">
              Mute
            </button>
          </div>
        );
      })}

      <section aria-label="Mics in this scene" className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${crowded ? 200 : 270}px, 1fr))`, gap: crowded ? 12 : 18 }}>
        {cast.map(({ char, mic }) => (
          <MicCard key={char.id} show={show} rt={rt} char={char} mic={mic} crowded={crowded} pending={mic != null ? pending[mic] : undefined} openFx={openFx} />
        ))}
        {!cast.length && <div className="text-lg font-extrabold text-ghost">Nobody in this scene has a mic. Set the cast in Build.</div>}
      </section>
    </>
  );
}

function MicCard({ show, rt, char, mic, crowded, pending, openFx }: { show: SoundShow; rt: Runtime; char: Character; mic: number | null; crowded: boolean; pending: boolean | undefined; openFx: (w: { char: Character; mic: number }) => void }) {
  const live = mic != null ? micLive(show, rt, mic) : undefined;
  const fx = mic != null ? rt.fx[mic] : undefined;
  const preset = fx ? presetById(show, fx.preset) : null;
  const meter = mic != null && rt.meters ? rt.meters[mic] ?? 0 : null;
  let flag = "";
  if (mic == null) flag = "No mic: assign one backstage";
  else if (pending !== undefined) flag = `Waiting for the desk: ${pending ? "live" : "mute"}`;
  else if (meter !== null && live && meter < 0.02) flag = "No signal — check pack";
  else if (meter !== null && live === false && meter > 0.3) flag = "Talking while muted";
  const on = live === true;
  const sz = crowded ? { av: 60, name: 22, pad: 14, radius: 22, gap: 10, btnPad: 11, btn: 17 } : { av: 88, name: 30, pad: 22, radius: 28, gap: 16, btnPad: 16, btn: 22 };
  const cardBg = on ? "#182016" : "#14171E";
  const fader = mic != null ? rt.channels[`input:${show.mics.find((m) => m.n === mic)?.channel}`]?.fader : undefined;
  return (
    <div className="flex border-2" style={{ borderRadius: sz.radius, padding: sz.pad, gap: crowded ? 10 : 14, background: cardBg, borderColor: on ? "#4C6A22" : flag ? "#7A5A1F" : "#1E232D" }}>
    <div className="flex min-w-0 flex-1 flex-col" style={{ gap: sz.gap }}>
      <button type="button" disabled={mic == null} onClick={() => mic != null && openFx({ char, mic })} aria-label={`Effects for ${char.name}`} className="flex items-center gap-3.5 border-0 bg-transparent p-0 text-left text-text">
        <span className="relative flex-none" style={{ width: sz.av, height: sz.av }}>
          <Avatar c={char} size={sz.av} ring={on ? "#B8F25C" : "#2A303D"} />
          <span className="absolute -right-1.5 -bottom-1.5 inline-flex size-[30px] items-center justify-center rounded-full border-[3px]" style={{ background: fx ? "#A78BFA" : "#222837", color: fx ? "#14102A" : "#7C8597", borderColor: cardBg }}>
            <Icon name="sparkle" size={14} stroke={2.6} />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="truncate leading-[1.05] font-black" style={{ fontSize: sz.name }}>
            {char.name}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <span className="inline-flex items-center rounded-full bg-chip px-2.5 py-1 text-[13px] font-black text-soft">{mic != null ? `MIC ${mic}` : "NO MIC"}</span>
            {preset && fx && (
              <span className="inline-flex items-center rounded-full bg-violet-bg px-2.5 py-1 text-[13px] font-black text-violet-text">
                {preset.name}
                {fx.amount !== "medium" ? ` · ${fx.amount[0].toUpperCase()}${fx.amount.slice(1)}` : ""}
              </span>
            )}
          </span>
        </span>
      </button>
      {meter !== null && (
        <div className="h-2.5 overflow-hidden rounded-full bg-ink">
          <div className="h-full rounded-full" style={{ width: `${Math.round(meter * 100)}%`, background: on ? "#B8F25C" : "#5A6273" }} />
        </div>
      )}
      {flag && (
        <div className="flex items-center gap-2 rounded-[14px] bg-amber-bg px-3 py-[9px] text-sm font-black text-[#FFC970]">
          <Icon name="warn" size={17} />
          {flag}
        </div>
      )}
      {mic != null && <LiveToggle live={live} mic={mic} name={char.name} pad={sz.btnPad} size={sz.btn} />}
    </div>
      {mic != null && <Fader name={char.name} level={fader} live={on} narrow={crowded} onSend={(db) => void cmd("level", { who: mic, db })} />}
    </div>
  );
}

const UNITY = 0x6b;
const faderDb = (lv: number) => (lv <= 0 ? "−∞" : `${Math.round((lv / 127) * 64 - 54)}`);

/**
 * The mic's desk fader, upright beside the card. Shows what the desk reports; dragging sends the new level
 * (about 15 times a second, then the final one on release). Double-click / double-tap: back to 0 dB.
 */
function Fader({ name, level, live, narrow, onSend }: { name: string; level: number | undefined; live: boolean; narrow: boolean; onSend: (db: number | null) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);
  const shown = drag ?? level;
  const known = shown !== undefined;
  const send = (lv: number, final: boolean) => {
    const now = Date.now();
    if (!final && now - lastSent.current < 66) return;
    lastSent.current = now;
    onSend(lv <= 0 ? null : (lv / 127) * 64 - 54);
  };
  const at = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = 1 - (clientY - r.top) / r.height;
    let lv = Math.round(Math.max(0, Math.min(1, f)) * 127);
    if (Math.abs(lv - UNITY) <= 2) lv = UNITY; // a light detent at 0 dB
    return lv;
  };
  const pct = known ? (shown! / 127) * 100 : 0;
  const w = narrow ? 40 : 48;
  return (
    <div className="flex flex-none flex-col items-center gap-1.5" style={{ width: w }}>
      <span className="text-[13px] font-black tabular-nums" style={{ color: known ? "#DDE3EC" : "#5A6273" }}>
        {known ? faderDb(shown!) : "–"}
      </span>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={`${name} level`}
        aria-valuemin={-54}
        aria-valuemax={10}
        aria-valuenow={known ? Math.round((shown! / 127) * 64 - 54) : undefined}
        aria-valuetext={known ? `${faderDb(shown!)} dB` : "unknown"}
        aria-disabled={!known}
        className="relative w-full flex-1 cursor-ns-resize touch-none rounded-[14px] bg-ink outline-none focus-visible:ring-2 focus-visible:ring-soft"
        style={{ minHeight: narrow ? 120 : 150, opacity: known ? 1 : 0.4 }}
        onPointerDown={(e) => {
          if (!known) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const lv = at(e.clientY);
          setDrag(lv);
          send(lv, false);
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const lv = at(e.clientY);
          setDrag(lv);
          send(lv, false);
        }}
        onPointerUp={(e) => {
          if (drag === null) return;
          const lv = at(e.clientY);
          send(lv, true);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={() => known && send(UNITY, true)}
        onKeyDown={(e) => {
          if (!known) return;
          const step = e.shiftKey ? 10 : 2;
          if (e.key === "ArrowUp") send(Math.min(127, level! + step), true);
          else if (e.key === "ArrowDown") send(Math.max(0, level! - step), true);
          else return;
          e.preventDefault();
        }}
      >
        <div className="absolute inset-x-0 bottom-0 rounded-[14px]" style={{ height: `${pct}%`, background: live ? "#3E5A1A" : "#2A303D" }} />
        <div className="absolute inset-x-1.5 h-0.5 rounded-full bg-[#5A6273]" style={{ bottom: `${(UNITY / 127) * 100}%` }} aria-hidden="true" />
        {known && <div className="absolute inset-x-0 h-3 -translate-y-1/2 rounded-full" style={{ top: `${100 - pct}%`, background: live ? "#B8F25C" : "#C9D0DC" }} aria-hidden="true" />}
      </div>
    </div>
  );
}

export function LiveToggle({ live, mic, name, pad, size }: { live: boolean | undefined; mic: number; name: string; pad: number; size: number }) {
  if (live === undefined)
    return (
      <button type="button" onClick={() => void cmd("mic", { who: mic, live: false })} aria-label={`Mute ${name} (state unknown)`} className="flex items-center justify-center gap-2.5 rounded-[18px] border-2 border-line2 bg-card font-black tracking-[1px] text-muted" style={{ padding: pad, fontSize: size }}>
        UNKNOWN
      </button>
    );
  return live ? (
    <button type="button" onClick={() => void cmd("mic", { who: mic, live: false })} aria-label={`Mute ${name}`} className="flex items-center justify-center gap-2.5 rounded-[18px] border-2 border-lime bg-lime font-black tracking-[1px] text-ink active:scale-[0.98]" style={{ padding: pad, fontSize: size }}>
      <Icon name="mic" size={22} stroke={2.6} />
      LIVE
    </button>
  ) : (
    <button type="button" onClick={() => void cmd("mic", { who: mic, live: true })} aria-label={`Unmute ${name}`} className="flex items-center justify-center gap-2.5 rounded-[18px] border-2 border-coral bg-coral-bg font-black tracking-[1px] text-coral-text active:scale-[0.98]" style={{ padding: pad, fontSize: size }}>
      <Icon name="micOff" size={22} stroke={2.6} />
      MUTED
    </button>
  );
}

function FxPanel({ show, rt, who, onClose }: { show: SoundShow; rt: Runtime; who: { char: Character; mic: number }; onClose: () => void }) {
  const cur = rt.fx[who.mic];
  const curPreset = cur ? presetById(show, cur.preset) : null;
  const amount: FxAmount = cur?.amount ?? "medium";
  const set = (preset: string, a: FxAmount) => void cmd("fx", { who: who.mic, preset, amount: a });
  const tiles = [{ id: "none", name: "None", desc: "Dry voice" }, ...show.presets.map((p) => ({ id: p.id, name: p.name, desc: p.desc }))];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(5,7,10,0.72)] p-6" onClick={onClose}>
      <div role="dialog" aria-label={`Effects for ${who.char.name}`} className="flex w-full max-w-[560px] flex-col gap-[22px] rounded-[32px] border border-line2 bg-card p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4">
          <Avatar c={who.char} size={76} />
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-[30px] font-black">{who.char.name}</span>
            <span className="text-[15px] font-extrabold text-muted">Voice effect · mic {who.mic}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-12 items-center justify-center rounded-2xl bg-chip">
            <Icon name="close" stroke={2.8} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {tiles.map((t) => {
            const sel = t.id === "none" ? !curPreset : curPreset?.id === t.id;
            return (
              <button key={t.id} type="button" onClick={() => set(t.id, amount)} className="flex flex-col items-start gap-1 rounded-[22px] border-2 px-5 py-[18px] text-left" style={{ background: sel ? "#2A2347" : "#0F1218", borderColor: sel ? "#A78BFA" : "#2A303D", color: sel ? "#F1EBFF" : "#DDE3EC" }}>
                <span className="text-[22px] font-black">{t.name}</span>
                <span className="text-sm font-extrabold opacity-75">{t.desc || " "}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-2.5">
          <span className="text-[13px] font-extrabold tracking-[1.5px] text-muted">AMOUNT</span>
          <div className="grid grid-cols-3 gap-2 rounded-[20px] bg-well p-1.5">
            {FX_AMOUNTS.map((a) => {
              const sel = !!curPreset && a === amount;
              return (
                <button key={a} type="button" disabled={!curPreset} onClick={() => curPreset && set(curPreset.id, a)} className="rounded-[15px] p-3.5 text-[17px] font-black capitalize" style={{ background: sel ? "#A78BFA" : "transparent", color: sel ? "#14102A" : !curPreset ? "#5A6273" : "#DDE3EC" }}>
                  {a}
                </button>
              );
            })}
          </div>
        </div>
        <button type="button" onClick={onClose} className="h-[60px] rounded-[20px] bg-text text-xl font-black text-ink">
          Done
        </button>
      </div>
    </div>
  );
}

function AllMics({ show, rt, scene, pending, onClose }: { show: SoundShow; rt: Runtime; scene: SoundScene | null; pending: Record<string, boolean>; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[rgba(5,7,10,0.55)]" onClick={onClose}>
      <div role="dialog" aria-label="All mics" className="scroll-thin flex w-full max-w-[420px] flex-col gap-2.5 overflow-y-auto border-l border-line2 bg-panel px-[18px] py-[22px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-1 pb-1.5">
          <span className="flex-1 text-[26px] font-black">All mics</span>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-[46px] items-center justify-center rounded-[15px] bg-chip">
            <Icon name="close" stroke={2.8} />
          </button>
        </div>
        {show.mics.map((m) => {
          const h = holderOf(show, scene, m.n);
          const inScene = !!h?.inCast;
          const live = micLive(show, rt, m.n);
          const on = live === true;
          const deskName = rt.channels[`input:${m.channel}`]?.name;
          const fx = rt.fx[m.n];
          return (
            <div key={m.n} className="flex items-center gap-3 rounded-[18px] py-2 pr-2 pl-2.5" style={{ background: inScene ? "#181C25" : "transparent" }}>
              <span className="min-w-[30px] text-center text-base font-black text-muted">{m.n}</span>
              {h ? <Avatar c={h.char} size={40} /> : <span className="inline-flex size-10 items-center justify-center rounded-full bg-chip text-base font-black text-muted">?</span>}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cx("truncate text-lg font-black", !h && "text-muted")}>{h?.char.name ?? "Nobody"}</span>
                <span className="truncate text-xs font-black">
                  {inScene && <span className="text-lime">IN THIS SCENE </span>}
                  <span className="text-ghost">In {m.channel}{deskName ? ` · ${deskName}` : ""}</span>
                  {fx && <span className="text-violet"> · {presetById(show, fx.preset)?.name}</span>}
                  {pending[m.n] !== undefined && <span className="text-amber"> · waiting for desk</span>}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void cmd("mic", { who: m.n, live: live === undefined ? false : !on })}
                aria-label={(on ? "Mute " : "Unmute ") + (h?.char.name ?? `mic ${m.n}`)}
                className="h-11 w-[104px] rounded-[14px] border-2 text-[15px] font-black tracking-[0.5px]"
                style={live === undefined ? { borderColor: "#2A303D", background: "#151922", color: "#9AA3B2" } : { borderColor: on ? "#B8F25C" : "#FF6B5E", background: on ? "#B8F25C" : "#22141A", color: on ? "#0B0D12" : "#FF8E84" }}
              >
                {live === undefined ? "?" : on ? "LIVE" : "MUTED"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The show-wide extras (Dante music players…): a button that is always there, lime while any of them is live. */
function MusicButton({ show, rt, onClick }: { show: SoundShow; rt: Runtime; onClick: () => void }) {
  const live = show.extras.filter((x) => rt.channels[`input:${x.channel}`]?.muted === false).length;
  return (
    <button type="button" onClick={onClick} aria-label={`Music: ${live} of ${show.extras.length} live`} className="inline-flex items-center gap-2.5 rounded-[20px] border-2 px-5 py-[18px] text-lg font-black" style={{ borderColor: live ? "#B8F25C" : "#2A303D", color: live ? "#B8F25C" : "#DDE3EC", background: "#12151C" }}>
      <Icon name="music" stroke={2.6} />
      Music
      {show.extras.length > 0 && <span className="rounded-full px-2 py-0.5 text-[13px] text-ink" style={{ background: live ? "#B8F25C" : "#5A6273" }}>{live}</span>}
    </button>
  );
}

function MusicPanel({ show, rt, onClose }: { show: SoundShow; rt: Runtime; onClose: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const save = (extras: { id?: string; name: string; channel: number }[]) => void cmd("extras.set", { extras });
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(5,7,10,0.72)] p-6" onClick={onClose}>
      <div role="dialog" aria-label="Music and extra channels" className="flex w-full max-w-[640px] flex-col gap-5 rounded-[32px] border border-line2 bg-card p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-chip text-lime">
            <Icon name="music" size={24} stroke={2.6} />
          </span>
          <span className="flex-1 text-[30px] font-black">Music</span>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-12 items-center justify-center rounded-2xl bg-chip">
            <Icon name="close" stroke={2.8} />
          </button>
        </div>
        {show.extras.length === 0 && <div className="rounded-2xl border-2 border-dashed border-line2 p-6 text-lg font-extrabold text-muted">No channels yet. Add the desk inputs you play music from.</div>}
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {show.extras.map((x) => {
            const st = rt.channels[`input:${x.channel}`];
            const live = st?.muted === undefined ? undefined : !st.muted;
            const on = live === true;
            return (
              <div key={x.id} className="flex gap-3.5 rounded-[26px] border-2 p-5" style={{ background: on ? "#182016" : "#14171E", borderColor: on ? "#4C6A22" : "#1E232D" }}>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex items-start gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[28px] leading-[1.05] font-black">{x.name}</span>
                      <span className="truncate text-[13px] font-black text-ghost">In {x.channel}{st?.name ? ` · ${st.name}` : ""}</span>
                    </span>
                    <button type="button" onClick={() => confirm(`Remove ${x.name} from the music panel? (The desk is not changed.)`) && save(show.extras.filter((e) => e.id !== x.id))} aria-label={`Remove ${x.name}`} className="inline-flex size-9 items-center justify-center rounded-xl text-ghost">
                      <Icon name="trash" size={18} />
                    </button>
                  </div>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void cmd("extra", { extra: x.id, live: live === undefined ? false : !on })}
                    aria-label={(on ? "Mute " : "Unmute ") + x.name}
                    className="flex items-center justify-center gap-2.5 rounded-[18px] border-2 py-4 text-[22px] font-black tracking-[1px]"
                    style={live === undefined ? { borderColor: "#2A303D", background: "#151922", color: "#9AA3B2" } : { borderColor: on ? "#B8F25C" : "#FF6B5E", background: on ? "#B8F25C" : "#22141A", color: on ? "#0B0D12" : "#FF8E84" }}
                  >
                    <Icon name={on ? "mic" : "micOff"} size={22} stroke={2.6} />
                    {live === undefined ? "UNKNOWN" : on ? "LIVE" : "MUTED"}
                  </button>
                </div>
                <Fader name={x.name} level={st?.fader} live={on} narrow={false} onSend={(db) => void cmd("extra", { extra: x.id, db })} />
              </div>
            );
          })}
        </div>
        {adding ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const ch = Number(input);
              if (!name.trim() || !(ch >= 1 && ch <= 128)) return;
              save([...show.extras, { name: name.trim(), channel: ch }]);
              setName("");
              setInput("");
              setAdding(false);
            }}
          >
            <label className="flex flex-[1_1_200px] flex-col gap-1 text-[13px] font-black text-muted">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dante 3" className="rounded-2xl border-2 border-line2 bg-ink px-4 py-3 text-lg font-black text-text" />
            </label>
            <label className="flex w-[130px] flex-col gap-1 text-[13px] font-black text-muted">
              Desk input
              <input value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="1–128" className="rounded-2xl border-2 border-line2 bg-ink px-4 py-3 text-lg font-black text-text" />
            </label>
            <button type="submit" className="rounded-2xl bg-lime px-5 py-3.5 text-lg font-black text-ink">Add</button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-2xl px-4 py-3.5 text-lg font-black text-muted">Cancel</button>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-2 self-start rounded-2xl border-2 border-dashed border-line2 px-4 py-2.5 text-[15px] font-black text-soft">
            <Icon name="plus" size={16} stroke={2.6} />
            Add a channel
          </button>
        )}
      </div>
    </div>
  );
}
