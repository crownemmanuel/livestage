// The QR code the crew scans for the backstage mic check, with the sync mode switch.

import { cmd, useOp } from "../lib/store.ts";
import { Icon, cx } from "../lib/ui.tsx";

export function BackstageQr({ big = false }: { big?: boolean }) {
  const links = useOp((s) => s.links);
  const settings = useOp((s) => s.settings)!;
  const rt = useOp((s) => s.runtime)!;
  const cloud = settings.sync.mode === "cloud";
  const url = links?.active ?? null;
  const size = big ? 300 : 240;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex rounded-full bg-well p-1">
        {(["local", "cloud"] as const).map((m) => (
          <button key={m} type="button" onClick={() => void cmd("settings.sync", { mode: m })} className={cx("flex-1 rounded-full px-4 py-2.5 text-[15px]", settings.sync.mode === m ? "bg-text font-black text-ink" : "font-extrabold text-dim")}>
            {m === "local" ? "Local network" : "Cloud"}
          </button>
        ))}
      </div>
      {url ? (
        <div className="flex flex-col items-center gap-3">
          <img src={`/api/qr?text=${encodeURIComponent(url)}`} alt="QR code for the backstage page" width={size} height={size} className="rounded-2xl bg-white" style={{ width: size, height: size }} />
          <a href={url} target="_blank" rel="noreferrer" className="max-w-full text-center text-sm font-extrabold break-all text-lime">
            {cloud ? url.split("#")[0] + "#…" : url}
          </a>
        </div>
      ) : (
        <div className="rounded-2xl bg-amber-bg p-4 text-[15px] font-extrabold text-amber-text">Cloud sync needs the Firebase keys: Build → Backstage.</div>
      )}
      {!cloud && rt.lan.length > 1 && (
        <label className="flex items-center gap-3 text-sm font-extrabold text-muted">
          Network
          <select className="field flex-1" value={links?.ip ?? ""} onChange={(e) => void cmd("settings.sync", { lanIp: e.target.value })}>
            {rt.lan.map((l) => (
              <option key={l.address} value={l.address}>
                {l.address} ({l.name})
              </option>
            ))}
          </select>
        </label>
      )}
      {!cloud && !rt.lan.length && <div className="rounded-2xl bg-amber-bg p-4 text-[15px] font-extrabold text-amber-text">This computer has no network address: phones cannot reach it.</div>}
      {cloud && (
        <div className="text-sm font-extrabold text-muted">
          {rt.cloud.status === "live" ? "Connected to the cloud." : rt.cloud.status === "connecting" ? "Connecting to the cloud…" : rt.cloud.error ?? "Cloud sync is off."}
          {links?.cloud && !links.hosted && " The backstage page is not hosted yet, so this link uses this computer (set the hosted URL in Build → Backstage)."}
        </div>
      )}
    </div>
  );
}

export function BackstageDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(5,7,10,0.72)] p-6" onClick={onClose}>
      <div role="dialog" aria-label="Backstage mic check" className="flex w-full max-w-[420px] flex-col gap-5 rounded-[32px] border border-line2 bg-card p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="inline-flex size-11 items-center justify-center rounded-[14px] bg-chip">
            <Icon name="phone" />
          </span>
          <span className="flex-1 text-[26px] font-black">Backstage</span>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-12 items-center justify-center rounded-2xl bg-chip">
            <Icon name="close" stroke={2.8} />
          </button>
        </div>
        <span className="text-[15px] font-extrabold text-muted">Crew scan this to check who wears which mic.</span>
        <BackstageQr big />
      </div>
    </div>
  );
}
