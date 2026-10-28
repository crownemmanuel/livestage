import "./app.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BuildMode } from "./build/BuildMode.tsx";
import { panic, useOp } from "./lib/store.ts";
import { Icon, Pill, cx } from "./lib/ui.tsx";
import { BackstageDialog } from "./show/BackstageDialog.tsx";
import { ShowMode } from "./show/ShowMode.tsx";

type Mode = "show" | "build";
const readMode = (): Mode => (location.hash.startsWith("#build") ? "build" : "show");

function App() {
  const [mode, setMode] = useState<Mode>(readMode);
  const [drawer, setDrawer] = useState(false);
  const [qr, setQr] = useState(false);
  const connected = useOp((s) => s.connected);
  const ready = useOp((s) => !!s.show && !!s.runtime && !!s.settings);
  useEffect(() => {
    const f = () => setMode(readMode());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const go = (m: Mode) => {
    location.hash = m === "build" ? "#build" : "";
    setMode(m);
  };
  return (
    <div className="flex min-h-screen flex-col bg-ink text-text">
      <TopBar mode={mode} go={go} openDrawer={() => setDrawer(true)} openQr={() => setQr(true)} />
      {!connected && (
        <div className="flex items-center gap-3 bg-coral px-6 py-3 text-[17px] font-black text-[#1A0805]">
          <Icon name="warn" /> Not connected to the Sound service: reconnecting… (MUTE ALL still tries)
        </div>
      )}
      {ready ? mode === "show" ? <ShowMode drawer={drawer} setDrawer={setDrawer} /> : <BuildMode /> : <div className="p-10 text-xl font-extrabold text-muted">Connecting…</div>}
      {qr && <BackstageDialog onClose={() => setQr(false)} />}
      <Toast />
    </div>
  );
}

function TopBar({ mode, go, openDrawer, openQr }: { mode: Mode; go: (m: Mode) => void; openDrawer: () => void; openQr: () => void }) {
  const rt = useOp((s) => s.runtime);
  const show = useOp((s) => s.show);
  const settings = useOp((s) => s.settings);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const liveCount = rt && show ? show.mics.filter((m) => rt.channels[`input:${m.channel}`]?.muted === false).length : 0;
  const desk = rt?.desk;
  const dry = settings?.desk.mode === "dry";
  const deskColor = dry ? "#A78BFA" : desk?.status === "connected" ? "#B8F25C" : desk?.status === "connecting" ? "#FFB547" : "#FF6B5E";
  const deskText = dry ? "dLive · dry run" : desk?.status === "connected" ? "dLive" : desk?.status === "connecting" ? "dLive · connecting" : "dLive · offline";
  const ls = rt?.livestage.lastAt;
  const lsAge = ls ? Date.now() - ls : Infinity;
  const lsColor = lsAge < 20000 ? "#B8F25C" : lsAge < 120000 ? "#FFB547" : "#5A6273";
  const cloud = settings?.sync.mode === "cloud";
  const syncColor = cloud ? (rt?.cloud.status === "live" ? "#B8F25C" : rt?.cloud.status === "connecting" ? "#FFB547" : "#FF6B5E") : "#B8F25C";
  return (
    <header className="flex flex-wrap items-center gap-4 border-b border-line px-6 py-4">
      <div className="mr-2 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-lime text-ink">
          <Icon name="mic" size={22} />
        </div>
        <span className="text-[22px] font-black tracking-[0.5px]">Sound</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Pill color={deskColor} title={desk?.error ?? `${desk?.host}:${desk?.port}`}>{deskText}</Pill>
        <Pill color={lsColor} title={rt?.livestage.from ? `Last from ${rt.livestage.from}: ${rt.livestage.lastCommand}` : "Nothing from LiveStage yet"}>LiveStage</Pill>
        <button type="button" onClick={openQr} className="rounded-full" title={rt?.cloud.error ?? "Backstage mic check: show the QR code"}>
          <Pill color={syncColor}>{cloud ? "Cloud sync" : "Local sync"}</Pill>
        </button>
        {rt?.meterSource && <Pill color="#B8F25C">{rt.meterSource}</Pill>}
      </div>
      <div className="flex-1" />
      {mode === "show" && (
        <button type="button" onClick={openDrawer} className="inline-flex items-center gap-2.5 rounded-2xl border-2 border-line2 bg-panel px-[18px] py-[11px] text-base font-black">
          <Icon name="grid" />
          All mics
          <span className="rounded-full px-2.5 py-0.5 text-[13px] text-ink" style={{ background: liveCount ? "#B8F25C" : "#5A6273" }}>{liveCount}</span>
        </button>
      )}
      <button type="button" onClick={openQr} aria-label="Backstage QR code" className="inline-flex size-[50px] items-center justify-center rounded-2xl border-2 border-line2 bg-panel">
        <Icon name="qr" size={22} />
      </button>
      <nav aria-label="Mode" className="flex rounded-full bg-card p-1">
        {(["show", "build"] as Mode[]).map((m) => (
          <button key={m} type="button" onClick={() => go(m)} className={cx("rounded-full px-[22px] py-2.5 text-[15px]", mode === m ? "bg-text font-black text-ink" : "font-extrabold text-dim")}>
            {m === "show" ? "Show" : "Build"}
          </button>
        ))}
      </nav>
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          panic();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") panic();
        }}
        className="inline-flex items-center gap-2.5 rounded-2xl bg-coral px-[22px] py-3 text-base font-black tracking-[0.5px] text-[#1A0805] active:scale-95"
      >
        <Icon name="micOff" />
        MUTE ALL
      </button>
    </header>
  );
}

function Toast() {
  const t = useOp((s) => s.toast);
  if (!t) return null;
  return (
    <div className={cx("fixed bottom-6 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-2xl px-6 py-4 text-[17px] font-black shadow-2xl", t.bad ? "bg-coral text-[#1A0805]" : "bg-text text-ink")} role="status">
      {t.text}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
