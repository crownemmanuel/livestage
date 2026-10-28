// Build mode: who is in each scene, the cue grid (rows = cues, columns = cast), and the library pages
// (characters, effect presets, desk mics, backstage sync, settings).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { castWithMics, charById, micClashes, presetById, visibleScenes } from "../../../server/logic.ts";
import { FX_AMOUNTS, type Cue, type SoundScene, type SoundShow } from "../../../server/model.ts";
import { cmd, useOp } from "../lib/store.ts";
import { Avatar, Icon, SectionLabel, cx, fmtTime, type IconName } from "../lib/ui.tsx";
import { BackstagePage, CharactersPage, DeskPage, ImportDialog, PresetsPage, SettingsPage } from "./Library.tsx";

type Page = { kind: "scene"; id: string } | { kind: "characters" | "presets" | "desk" | "backstage" | "settings" };

export function BuildMode() {
  const show = useOp((s) => s.show)!;
  const selected = useOp((s) => s.runtime!.selectedSceneId);
  const [page, setPage] = useState<Page>(() => ({ kind: "scene", id: selected ?? visibleScenes(show)[0]?.id ?? "" }));
  const [importing, setImporting] = useState(false);
  const scenes = visibleScenes(show);
  const scene = page.kind === "scene" ? scenes.find((s) => s.id === page.id) ?? scenes[0] ?? null : null;
  const lib: { kind: Page["kind"]; icon: IconName; label: string }[] = [
    { kind: "characters", icon: "people", label: "Characters" },
    { kind: "presets", icon: "sparkle", label: "Effect presets" },
    { kind: "desk", icon: "desk", label: "Desk mics" },
    { kind: "backstage", icon: "phone", label: "Backstage" },
    { kind: "settings", icon: "gear", label: "Settings" },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-wrap">
      <aside aria-label="Scenes" className="scroll-thin flex max-h-[calc(100vh-86px)] max-w-[300px] flex-[1_1_260px] flex-col gap-1.5 overflow-y-auto border-r border-line px-3.5 py-5">
        <button type="button" onClick={() => setImporting(true)} className="mb-3 inline-flex items-center gap-2 rounded-[14px] border-2 border-line bg-panel px-4 py-2.5 text-[15px] font-extrabold text-soft">
          <Icon name="sync" size={16} />
          Import scenes from LiveStage
        </button>
        <div className="px-2.5 pb-2 text-[13px] font-extrabold tracking-[1.5px] text-muted">SCENES</div>
        {scenes.map((s) => {
          const sel = page.kind === "scene" && scene?.id === s.id;
          return (
            <button key={s.id} type="button" onClick={() => setPage({ kind: "scene", id: s.id })} className="flex w-full items-center gap-3 rounded-[14px] border-2 px-3 py-2.5 text-left" style={{ borderColor: sel ? "#3A4256" : "transparent", background: sel ? "#1C2130" : "transparent", opacity: s.removed ? 0.6 : 1 }}>
              <span className="inline-flex h-8 min-w-10 items-center justify-center rounded-[10px] bg-chip px-2 text-sm font-black">{s.code}</span>
              <span className={cx("min-w-0 flex-1 truncate text-[15px] font-extrabold", s.removed && "line-through")}>{s.name}</span>
              <span className="text-[13px] font-extrabold text-muted">{s.cues.length === 1 ? "1 cue" : `${s.cues.length} cues`}</span>
            </button>
          );
        })}
        <div className="mx-1 my-3 h-px bg-line" />
        <div className="px-2.5 pb-2 text-[13px] font-extrabold tracking-[1.5px] text-muted">LIBRARY</div>
        {lib.map((l) => (
          <button key={l.kind} type="button" onClick={() => setPage({ kind: l.kind } as Page)} className={cx("flex items-center gap-3 rounded-[14px] p-3 text-left text-[15px] font-extrabold", page.kind === l.kind ? "bg-sel text-text" : "text-soft")}>
            <Icon name={l.icon} stroke={2.2} />
            {l.label}
          </button>
        ))}
      </aside>
      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-7 px-7 pt-6 pb-8">
        {page.kind === "scene" && (scene ? <SceneEditor key={scene.id} show={show} scene={scene} /> : <NoScenes onImport={() => setImporting(true)} />)}
        {page.kind === "characters" && <CharactersPage />}
        {page.kind === "presets" && <PresetsPage />}
        {page.kind === "desk" && <DeskPage />}
        {page.kind === "backstage" && <BackstagePage />}
        {page.kind === "settings" && <SettingsPage onImport={() => setImporting(true)} />}
      </main>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

function NoScenes({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-[28px] border-2 border-dashed border-line2 p-10">
      <span className="text-2xl font-black">No scenes yet</span>
      <button type="button" onClick={onImport} className="rounded-2xl bg-lime px-6 py-3.5 text-lg font-black text-ink">
        Import scenes from LiveStage
      </button>
    </div>
  );
}

/** Text that commits on Enter / leaving the field, never on every keystroke. */
export function EditText({ value, onCommit, className, placeholder, ariaLabel, maxLength = 80 }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; ariaLabel?: string; maxLength?: number }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  const commit = () => {
    focused.current = false;
    if (v.trim() !== value) onCommit(v.trim());
  };
  return (
    <input
      className={className ?? "field"}
      value={v}
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function SceneEditor({ show, scene }: { show: SoundShow; scene: SoundScene }) {
  const [adding, setAdding] = useState(false);
  const cast = castWithMics(show, scene);
  const clashes = micClashes(show, scene);
  const notIn = show.characters.filter((c) => !scene.cast.includes(c.id));
  const overrides = Object.keys(scene.mics).length;
  return (
    <>
      <section className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-[1_1_320px]">
          <div className="flex flex-wrap items-center gap-2.5 text-[15px] font-extrabold tracking-[1px] text-muted">
            SCENE {scene.code}
            {scene.source === "livestage" && !scene.removed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-cyan-bg px-2.5 py-1 text-xs font-black tracking-normal text-cyan-text">
                <Icon name="link" size={13} />
                LiveStage scene {scene.code}
              </span>
            )}
            {scene.removed && <span className="rounded-full bg-amber-bg px-2.5 py-1 text-xs font-black tracking-normal text-amber-text">Gone from LiveStage</span>}
          </div>
          <h1 className="mt-1 text-[40px] leading-[1.1] font-black">{scene.name}</h1>
        </div>
        {(scene.removed || scene.source !== "livestage") && (
          <button type="button" onClick={() => confirm(`Delete scene ${scene.code} “${scene.name}” and its cues?`) && void cmd("scene.remove", { scene: scene.id })} className="inline-flex items-center gap-2 rounded-2xl border-2 border-coral px-4 py-2.5 text-[15px] font-black text-coral-text">
            <Icon name="trash" size={18} />
            Delete scene
          </button>
        )}
      </section>

      <section aria-label="Cast" className="flex flex-col gap-3">
        <SectionLabel>Cast</SectionLabel>
        <div className="flex flex-wrap gap-3">
          {cast.map(({ char, mic }) => (
            <div key={char.id} className="group flex items-center gap-3 rounded-full bg-card py-2 pr-3 pl-2">
              <Avatar c={char} size={52} />
              <span className="flex flex-col">
                <span className="text-xl font-black">{char.name}</span>
                <span className={cx("text-[13px] font-extrabold", clashes.includes(mic ?? -1) ? "text-amber" : "text-muted")}>
                  {mic != null ? `MIC ${mic}` : "NO MIC"}
                  {scene.mics[char.id] !== undefined && " · backstage"}
                </span>
              </span>
              <button type="button" aria-label={`Take ${char.name} out of this scene`} onClick={() => void cmd("scene.cast", { scene: scene.id, cast: scene.cast.filter((x) => x !== char.id) })} className="ml-1 inline-flex size-8 items-center justify-center rounded-full text-ghost hover:bg-chip hover:text-text">
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
          <div className="relative">
            <button type="button" onClick={() => setAdding(!adding)} className="inline-flex min-h-[68px] items-center gap-2 rounded-full border-2 border-dashed border-[#3A4256] px-[22px] text-base font-black text-dim">
              <Icon name="plus" size={18} stroke={2.6} />
              Add
            </button>
            {adding && (
              <div className="absolute top-[76px] left-0 z-30 flex max-h-[360px] w-[280px] flex-col gap-1 overflow-y-auto rounded-[22px] border border-line2 bg-card p-2 shadow-2xl">
                {notIn.map((c) => (
                  <button key={c.id} type="button" onClick={() => void cmd("scene.cast", { scene: scene.id, cast: [...scene.cast, c.id] })} className="flex items-center gap-3 rounded-2xl p-2 text-left hover:bg-chip">
                    <Avatar c={c} size={36} />
                    <span className="flex-1 text-base font-black">{c.name}</span>
                    <span className="text-xs font-extrabold text-muted">{c.defaultMic ? `MIC ${c.defaultMic}` : ""}</span>
                  </button>
                ))}
                {!notIn.length && <span className="p-3 text-sm font-extrabold text-muted">Everyone is in. Add characters in Characters.</span>}
                <button type="button" onClick={() => setAdding(false)} className="mt-1 rounded-2xl bg-chip p-2 text-sm font-black">
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
        {clashes.length > 0 && (
          <div className="flex items-center gap-2 rounded-2xl bg-amber-bg px-4 py-3 text-[15px] font-black text-amber-text">
            <Icon name="warn" size={18} />
            Two people on mic {clashes.join(", ")} in this scene.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm font-extrabold text-muted">
          {scene.checked ? (
            <span className="inline-flex items-center gap-1.5 text-lime">
              <Icon name="check" size={16} stroke={3} />
              Mic check by {scene.checked.by} at {fmtTime(scene.checked.at)}
            </span>
          ) : (
            <span>Not checked backstage yet</span>
          )}
          {overrides > 0 && (
            <button type="button" onClick={() => void cmd("scene.resetMics", { scene: scene.id })} className="rounded-xl bg-chip px-3 py-1.5 text-soft">
              Undo backstage mic changes ({overrides})
            </button>
          )}
        </div>
      </section>

      <CueGrid show={show} scene={scene} />
    </>
  );
}

function CueGrid({ show, scene }: { show: SoundShow; scene: SoundScene }) {
  const [fxOpen, setFxOpen] = useState<string | null>(null);
  const cast = castWithMics(show, scene).map((c) => c.char);
  const cols = `200px repeat(${Math.max(1, cast.length)}, minmax(76px, 1fr)) 190px 200px 120px`;
  const minW = 200 + Math.max(1, cast.length) * 84 + 190 + 200 + 120 + 60;
  const upd = (q: Cue, patch: Record<string, unknown>) => void cmd("cue.update", { scene: scene.id, cue: q.id, ...patch });
  return (
    <section aria-label="Cues" className="flex flex-col gap-3">
      <SectionLabel>Cues</SectionLabel>
      <div className="scroll-thin overflow-x-auto rounded-3xl border border-line bg-panel">
        <div style={{ minWidth: minW }}>
          <div className="grid items-center gap-2 border-b border-line px-5 py-4 text-[15px] font-black text-dim" style={{ gridTemplateColumns: cols }}>
            <span>Cue</span>
            {cast.map((c) => (
              <span key={c.id} className="truncate text-center">
                {c.name}
              </span>
            ))}
            {!cast.length && <span className="text-center text-ghost">no cast</span>}
            <span>Effect</span>
            <span>Trigger</span>
            <span />
          </div>
          {scene.cues.map((q, i) => (
            <div key={q.id} className="border-b border-[#1A1E27]">
              <div className="grid items-center gap-2 px-5 py-3" style={{ gridTemplateColumns: cols }}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-chip text-[15px] font-black">Q{i + 1}</span>
                  <EditText value={q.label} onCommit={(v) => upd(q, { label: v || `Cue ${i + 1}` })} className="field h-10 w-full border-transparent bg-transparent px-2 text-[17px] hover:border-line2" ariaLabel={`Label of Q${i + 1}`} maxLength={60} />
                </span>
                {cast.map((c) => {
                  const on = q.live.includes(c.id);
                  return (
                    <span key={c.id} className="flex justify-center">
                      <button type="button" aria-label={`${c.name} ${on ? "on" : "off"} in Q${i + 1}`} onClick={() => upd(q, { live: on ? q.live.filter((x) => x !== c.id) : [...q.live, c.id] })} className="h-11 w-[72px] rounded-full border-2 text-[13px] font-black tracking-[0.5px]" style={{ background: on ? "#B8F25C" : "transparent", color: on ? "#0B0D12" : "#7C8597", borderColor: on ? "#B8F25C" : "#2A303D" }}>
                        {on ? "ON" : "OFF"}
                      </button>
                    </span>
                  );
                })}
                {!cast.length && <span />}
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {Object.entries(q.fx).map(([id, f]) => (
                    <button key={id} type="button" onClick={() => setFxOpen(fxOpen === q.id ? null : q.id)} className="inline-flex items-center gap-1.5 rounded-full bg-violet-bg px-3 py-1.5 text-[13px] font-black text-violet-text">
                      <Icon name="sparkle" size={13} />
                      {charById(show, id)?.name.split(" ")[0]} · {presetById(show, f.preset)?.name ?? "?"}
                    </button>
                  ))}
                  <button type="button" onClick={() => setFxOpen(fxOpen === q.id ? null : q.id)} className={cx("rounded-full px-3 py-1.5 text-[13px] font-black", Object.keys(q.fx).length ? "text-muted" : "text-ghost")}>
                    {Object.keys(q.fx).length ? "edit" : "—  add"}
                  </button>
                </span>
                <span className="flex items-center gap-1.5">
                  <select className="field h-10 w-[112px] px-2 text-sm" value={q.trigger.kind} onChange={(e) => upd(q, { trigger: e.target.value === "livestage" ? { kind: "livestage", at: "" } : { kind: "manual" } })} aria-label={`Trigger of Q${i + 1}`} style={{ color: q.trigger.kind === "manual" ? "#9AA3B2" : "#8FE3F5" }}>
                    <option value="manual">Manual</option>
                    <option value="livestage">LiveStage</option>
                  </select>
                  {q.trigger.kind === "livestage" && <EditText value={q.trigger.at} onCommit={(v) => upd(q, { trigger: { kind: "livestage", at: v } })} className="field h-10 w-[76px] px-2 text-sm" placeholder="1:12" ariaLabel="LiveStage time" maxLength={16} />}
                </span>
                <span className="flex justify-end gap-1">
                  <IconBtn icon="up" label="Move up" disabled={i === 0} onClick={() => void cmd("cue.move", { scene: scene.id, cue: q.id, to: i - 1 })} />
                  <IconBtn icon="down" label="Move down" disabled={i === scene.cues.length - 1} onClick={() => void cmd("cue.move", { scene: scene.id, cue: q.id, to: i + 1 })} />
                  <IconBtn icon="trash" label="Delete cue" onClick={() => confirm(`Delete Q${i + 1} “${q.label}”?`) && void cmd("cue.remove", { scene: scene.id, cue: q.id })} />
                </span>
              </div>
              {fxOpen === q.id && (
                <div className="mx-5 mb-4 flex flex-col gap-2 rounded-[20px] bg-well p-4">
                  <span className="text-[13px] font-extrabold tracking-[1.5px] text-muted">VOICE EFFECTS IN Q{i + 1}</span>
                  {cast.map((c) => {
                    const f = q.fx[c.id];
                    return (
                      <div key={c.id} className="flex flex-wrap items-center gap-3">
                        <span className="w-32 truncate text-base font-black">{c.name}</span>
                        <select className="field w-44" value={f?.preset ?? ""} onChange={(e) => upd(q, { fx: { [c.id]: e.target.value ? { preset: e.target.value, amount: f?.amount ?? "medium" } : null } })} aria-label={`Effect for ${c.name}`}>
                          <option value="">None</option>
                          {show.presets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        {f && (
                          <select className="field w-36 capitalize" value={f.amount} onChange={(e) => upd(q, { fx: { [c.id]: { preset: f.preset, amount: e.target.value } } })} aria-label={`Amount for ${c.name}`}>
                            {FX_AMOUNTS.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                  <button type="button" onClick={() => setFxOpen(null)} className="mt-1 self-start rounded-xl bg-chip px-4 py-2 text-sm font-black">
                    Done
                  </button>
                </div>
              )}
            </div>
          ))}
          <div className="px-5 py-3.5">
            <button type="button" onClick={() => void cmd("cue.add", { scene: scene.id })} className="inline-flex items-center gap-2 rounded-[14px] border-2 border-dashed border-[#3A4256] px-[18px] py-2.5 text-[15px] font-black text-dim">
              <Icon name="plus" size={16} stroke={2.6} />
              Add cue
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function IconBtn({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="inline-flex size-10 items-center justify-center rounded-xl text-muted hover:bg-chip hover:text-text disabled:opacity-25">
      <Icon name={icon} size={18} />
    </button>
  );
}

export function Card({ title, icon, right, children }: { title: ReactNode; icon?: IconName; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-panel p-[22px]">
      <div className="flex flex-wrap items-center gap-2.5">
        {icon && (
          <span className="inline-flex size-11 items-center justify-center rounded-[14px] bg-violet-bg text-[#C9B8FF]">
            <Icon name={icon} size={22} />
          </span>
        )}
        <span className="flex-1 text-2xl font-black">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}
