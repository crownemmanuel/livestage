// Settings → StageLight → Wall video: the switch, size, rate and port of the rehearsal stream to
// StageLight's virtual LED wall, and what it is doing (docs/WALL_VIDEO_LINK.md).

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { setWallVideo, useWallVideo, WALL_VIDEO_FPS, WALL_VIDEO_PORT, WALL_VIDEO_WIDTHS } from "@/engine/wallVideoLink";
import { NumberInput, SelectBox } from "../fields";

export function WallVideoPanel() {
  const { on, settings, status: s } = useWallVideo();
  const ok = s.state === "connected";
  const line =
    s.state === "off"
      ? "Off"
      : s.state === "starting"
        ? "Starting…"
        : s.state === "error"
          ? (s.error ?? "Error")
          : !ok
            ? `Connecting to ${s.url ?? "StageLight"}…`
            : s.waiting
              ? s.waiting
              : `Streaming ${s.width}×${s.height} · ${s.fps.toFixed(1)} fps · ${s.kbps} kbit/s · ${s.viewers ? `${s.viewers} StageLight window${s.viewers === 1 ? "" : "s"} showing it` : "no StageLight window showing it"}`;
  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-card/40 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Wall video to StageLight</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            The same picture the LED wall shows (or the preview) plays on StageLight's virtual LED wall, so you can see how the lights meet each clip. Taken from this window's monitor, never the output window. With Preview, preview cues also send their StageLight messages while StageLight's output is not armed. Off at every start.
          </div>
        </div>
        <Switch checked={on} onCheckedChange={(v) => void setWallVideo({ on: v })} />
      </div>
      <div className="grid grid-cols-4 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">Picture</span>
          <SelectBox
            className="h-9 rounded-lg text-[13px]"
            value={settings.source}
            onChange={(v) => void setWallVideo({ source: v })}
            options={[
              { value: "program", label: "Program (the wall)" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">Width</span>
          <SelectBox
            className="h-9 rounded-lg text-[13px]"
            value={String(settings.width)}
            onChange={(v) => void setWallVideo({ width: Number(v) })}
            options={WALL_VIDEO_WIDTHS.map((w) => ({ value: String(w), label: `${w} px` }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">Frame rate</span>
          <SelectBox
            className="h-9 rounded-lg text-[13px]"
            value={String(settings.fps)}
            onChange={(v) => void setWallVideo({ fps: Number(v) })}
            options={WALL_VIDEO_FPS.map((f) => ({ value: String(f), label: `${f} fps` }))}
          />
        </label>
        <label className="flex flex-col gap-1.5" title={`StageLight's wall video port (${WALL_VIDEO_PORT})`}>
          <span className="text-[12px] font-medium text-muted-foreground">Port</span>
          <NumberInput className="h-9 rounded-lg text-[13px]" value={settings.port} min={1} max={65535} step={1} onChange={(v) => void setWallVideo({ port: Math.round(v) })} />
        </label>
      </div>
      {on && (
        <div className="space-y-0.5 font-mono text-[11.5px] text-muted-foreground">
          <div className={cn(ok ? "text-preview" : s.state === "error" && "text-destructive")}>{line}</div>
          {ok && (
            <div>
              sent {s.sent} · dropped {s.dropped} · capture {s.captureMs} ms (max {s.captureMaxMs}) · encode {s.encodeMs} ms
            </div>
          )}
          {s.remote && (
            <div>
              StageLight: latency {Math.round(s.remote.latency)} ms ±{Math.round(s.remote.jitter)} · lights delayed {Math.round(s.remote.delay)} ms
            </div>
          )}
          {(s.previewLights.sent > 0 || s.previewLights.held > 0) && (
            <div className={cn(s.previewLights.held > 0 && "text-armed")}>
              preview light cues: {s.previewLights.sent} sent
              {s.previewLights.held > 0 && ` · ${s.previewLights.held} held (${s.previewLights.lastHeld})`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
