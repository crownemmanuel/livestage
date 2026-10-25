import { useEffect, useState } from "react";
import { AlertTriangle, Grid3x3, Monitor, MonitorCog, Power, RectangleHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listMonitors, isTauri, openOutputWindow, type MonitorInfo } from "@/core/platform";
import type { ScalingMode } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { AssetField, ColorField, Field, NumberInput, SelectBox, SelectField, SliderField, SwitchField, TextField } from "./fields";
import { SidebarDialog, type SidebarSection } from "./SidebarDialog";

type ScreensSection = "canvas" | "display" | "guides" | "standby";

const SECTIONS: SidebarSection<ScreensSection>[] = [
  { id: "canvas", label: "LED wall canvas", icon: <RectangleHorizontal />, blurb: "The wall is designed in these canvas pixels, then mapped to the output display." },
  { id: "display", label: "Output display", icon: <MonitorCog />, blurb: "Which screen the audience output opens on, and how it fills it." },
  { id: "guides", label: "Guides & test pattern", icon: <Grid3x3 />, blurb: "Safe-area guides and a test pattern for lining up the wall." },
  { id: "standby", label: "Standby", icon: <Power />, blurb: "The safe picture the wall shows on Standby." },
];

const PRESETS: [number, number][] = [
  [1920, 1080],
  [3072, 768],
  [3840, 2160],
  [3840, 1080],
  [4096, 1024],
  [5760, 1080],
  [7680, 2160],
];

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

export function OutputSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const o = useProject((s) => s.project.output);
  const set = useProject.getState().setOutput;
  const status = useShow((s) => s.outputStatus);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [section, setSection] = useState<ScreensSection>("canvas");
  useEffect(() => {
    if (open) void listMonitors().then(setMonitors);
  }, [open]);

  const g = gcd(o.canvasWidth, o.canvasHeight) || 1;
  const mon = monitors.find((m) => m.name === o.monitorName) ?? monitors.find((m) => !m.primary) ?? monitors[0];
  const exceeds = mon && (o.canvasWidth > mon.width || o.canvasHeight > mon.height);
  // A display whose shape differs from the wall (e.g. 1920×720 feeding a 3072×768 wall) is usually rescaled to the whole wall by the LED processor.
  const shapeDiffers = mon && Math.abs(mon.width / mon.height / (o.canvasWidth / o.canvasHeight) - 1) > 0.02;

  return (
    <SidebarDialog open={open} onOpenChange={onOpenChange} title="Screens" sections={SECTIONS} section={section} onSection={setSection}>
      <div className="space-y-4">
        {section === "canvas" && (
          <>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map(([w, h]) => (
              <Button key={`${w}x${h}`} size="xs" variant={o.canvasWidth === w && o.canvasHeight === h ? "secondary" : "outline"} onClick={() => set({ canvasWidth: w, canvasHeight: h })}>
                {w}×{h}
              </Button>
            ))}
          </div>
          <Field label="Canvas size">
            <div className="flex items-center gap-1.5">
              <NumberInput className="w-24" value={o.canvasWidth} step={1} min={16} max={16384} onChange={(v) => set({ canvasWidth: Math.round(v) })} />
              <span className="text-muted-foreground">×</span>
              <NumberInput className="w-24" value={o.canvasHeight} step={1} min={16} max={16384} onChange={(v) => set({ canvasHeight: Math.round(v) })} />
              <span className="ml-2 text-[11px] text-muted-foreground tabular">
                {(o.canvasWidth / o.canvasHeight).toFixed(3)}:1 ({o.canvasWidth / g}:{o.canvasHeight / g})
              </span>
            </div>
          </Field>
          <SelectField<ScalingMode>
            label="Scaling"
            value={o.scaling}
            onChange={(scaling) => set({ scaling })}
            options={[
              { value: "fit", label: "Fit (letterbox, whole canvas visible)" },
              { value: "fill", label: "Fill (crop to fill display)" },
              { value: "stretch", label: "Stretch (fill display; the LED processor undoes it)" },
              { value: "native", label: "Native size (1:1 pixels, may crop)" },
            ]}
          />
          {o.scaling === "stretch" && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              The whole canvas fills the output display, squeezed to its shape. Use this when the LED processor scales the display signal onto the whole wall (like vMix's
              Widescreen input setting): it looks squashed on the computer screen and correct on the wall. Check with the test pattern: its circles should be round on the wall.
            </p>
          )}
          <SliderField label="Target frame rate" value={o.targetFps} min={24} max={60} step={1} unit="fps" onChange={(targetFps) => set({ targetFps })} />
          <ColorField label="Background" value={o.backgroundColor} onChange={(backgroundColor) => set({ backgroundColor })} />
          </>
        )}

        {section === "display" && (
          <>
          <Field label="Monitor">
            <SelectBox
              value={mon?.name ?? "__auto__"}
              onChange={(v) => set({ monitorName: v === "__auto__" ? null : v })}
              options={monitors.length ? monitors.map((m) => ({ value: m.name, label: `${m.name} — ${m.width}×${m.height}${m.primary ? " (primary)" : ""}` })) : [{ value: "__auto__", label: "Detecting…" }]}
            />
          </Field>
          {!isTauri && <p className="text-[11px] text-muted-foreground">Running in a browser: monitor placement is only available in the desktop app. Double-click the output window to toggle fullscreen.</p>}
          {monitors.length === 1 && <p className="text-[11px] text-muted-foreground">One display detected. The output opens on it; the operator window stays usable underneath (Alt-Tab).</p>}
          <SwitchField label="Fullscreen" value={o.fullscreen} onChange={(fullscreen) => set({ fullscreen })} />
          {!o.fullscreen && (
            <Field label="Window size">
              <div className="flex items-center gap-1.5">
                <NumberInput className="w-24" value={o.windowWidth} step={1} min={200} onChange={(v) => set({ windowWidth: Math.round(v) })} />
                <span className="text-muted-foreground">×</span>
                <NumberInput className="w-24" value={o.windowHeight} step={1} min={100} onChange={(v) => set({ windowHeight: Math.round(v) })} />
              </div>
            </Field>
          )}
          {shapeDiffers && o.scaling !== "stretch" && (
            <div className="flex gap-2 rounded-md border border-armed/40 bg-armed/10 p-2 text-[11.5px] leading-snug text-armed">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                This display ({mon!.width}×{mon!.height}, {(mon!.width / mon!.height).toFixed(2)}:1) is a different shape from the wall ({(o.canvasWidth / o.canvasHeight).toFixed(2)}:1).
                If the LED processor scales this signal onto the whole wall, set Scaling to Stretch, or the picture will sit in a band with black above and below.
              </span>
            </div>
          )}
          {exceeds && (
            <div className="flex gap-2 rounded-md border border-armed/40 bg-armed/10 p-2 text-[11.5px] leading-snug text-armed">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                The canvas ({o.canvasWidth}×{o.canvasHeight}) is larger than this display ({mon!.width}×{mon!.height}). Composition stays in canvas coordinates, but the
                signal leaving this computer can only be {mon!.width}×{mon!.height}; it is scaled down (see Scaling). To drive the full wall pixel-for-pixel, present the wall as a single
                display of that size (LED processor / GPU spanning) and select it here.
              </span>
            </div>
          )}
          {status && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular">
              <Monitor className="size-3.5" /> Output window: {status.width}×{status.height}px, {status.fps} fps, worst frame {status.frameMs} ms
              {status.upload ? `, video frames to GPU ${status.upload.ms} ms/s` : ""}
              {status.videoElements ? `, ${status.videoElements.warm}/${status.videoElements.total} videos loaded` : ""}
            </p>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void openOutputWindow(useProject.getState().project.output)}>
              Apply to output window
            </Button>
          </div>
          </>
        )}

        {section === "guides" && (
          <>
          <SwitchField label="Safe-area guides" value={o.safeArea.enabled} onChange={(enabled) => set({ safeArea: { ...o.safeArea, enabled } })} />
          <SliderField label="Safe margin" value={o.safeArea.marginPct} min={0} max={20} step={0.5} unit="%" onChange={(marginPct) => set({ safeArea: { ...o.safeArea, marginPct } })} />
          <SwitchField label="Guides on output" hint="Show the safe area on the LED wall itself (for setup only)" value={o.safeArea.showOnOutput} onChange={(showOnOutput) => set({ safeArea: { ...o.safeArea, showOnOutput } })} />
          <SwitchField label="Test pattern" hint="Replaces the program on the output with a test pattern" value={o.testPattern} onChange={(testPattern) => set({ testPattern })} />
          </>
        )}

        {section === "standby" && (
          <>
          <TextField label="Title" value={o.standby.text} onChange={(text) => set({ standby: { ...o.standby, text } })} />
          <TextField label="Subtitle" value={o.standby.subtext} onChange={(subtext) => set({ standby: { ...o.standby, subtext } })} />
          <ColorField label="Color" value={o.standby.color} onChange={(color) => set({ standby: { ...o.standby, color } })} />
          <AssetField label="Image" type="image" value={o.standby.assetId} onChange={(assetId) => set({ standby: { ...o.standby, assetId } })} />
          <p className="text-[12px] leading-relaxed text-muted-foreground">An image replaces the title and subtitle. It follows Scaling: Stretch fills the whole wall, Fill crops to it, Fit keeps its shape.</p>
          </>
        )}
      </div>
    </SidebarDialog>
  );
}
