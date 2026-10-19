import { useEffect, useState } from "react";
import { AlertTriangle, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listMonitors, isTauri, openOutputWindow, type MonitorInfo } from "@/core/platform";
import type { ScalingMode } from "@/core/types";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { AssetField, ColorField, Field, NumberInput, Section, SelectBox, SelectField, SliderField, SwitchField, TextField } from "./fields";

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
  useEffect(() => {
    if (open) void listMonitors().then(setMonitors);
  }, [open]);

  const g = gcd(o.canvasWidth, o.canvasHeight) || 1;
  const mon = monitors.find((m) => m.name === o.monitorName) ?? monitors.find((m) => !m.primary) ?? monitors[0];
  const exceeds = mon && (o.canvasWidth > mon.width || o.canvasHeight > mon.height);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Output settings</DialogTitle>
          <DialogDescription>The LED wall is designed in logical canvas pixels, then mapped to the output display.</DialogDescription>
        </DialogHeader>

        <Section title="LED wall canvas">
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
              { value: "stretch", label: "Stretch (distort to display)" },
              { value: "native", label: "Native size (1:1 pixels, may crop)" },
            ]}
          />
          <SliderField label="Target frame rate" value={o.targetFps} min={24} max={60} step={1} unit="fps" onChange={(targetFps) => set({ targetFps })} />
          <ColorField label="Background" value={o.backgroundColor} onChange={(backgroundColor) => set({ backgroundColor })} />
        </Section>

        <Section title="Output display">
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
          {exceeds && (
            <div className="flex gap-2 rounded-md border border-armed/40 bg-armed/10 p-2 text-[11.5px] leading-snug text-armed">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                The canvas ({o.canvasWidth}×{o.canvasHeight}) is larger than this display ({mon!.width}×{mon!.height}). Composition stays in canvas coordinates, but the
                signal leaving this computer can only be {mon!.width}×{mon!.height}; it is scaled to fit. To drive the full wall pixel-for-pixel, present the wall as a single
                display of that size (LED processor / GPU spanning) and select it here.
              </span>
            </div>
          )}
          {status && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular">
              <Monitor className="size-3.5" /> Output window: {status.width}×{status.height}px, {status.fps} fps, worst frame {status.frameMs} ms
            </p>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void openOutputWindow(useProject.getState().project.output)}>
              Apply to output window
            </Button>
          </div>
        </Section>

        <Section title="Guides & safety">
          <SwitchField label="Safe-area guides" value={o.safeArea.enabled} onChange={(enabled) => set({ safeArea: { ...o.safeArea, enabled } })} />
          <SliderField label="Safe margin" value={o.safeArea.marginPct} min={0} max={20} step={0.5} unit="%" onChange={(marginPct) => set({ safeArea: { ...o.safeArea, marginPct } })} />
          <SwitchField label="Guides on output" hint="Show the safe area on the LED wall itself (for setup only)" value={o.safeArea.showOnOutput} onChange={(showOnOutput) => set({ safeArea: { ...o.safeArea, showOnOutput } })} />
          <SwitchField label="Test pattern" hint="Replaces the program on the output with a test pattern" value={o.testPattern} onChange={(testPattern) => set({ testPattern })} />
          <SelectField
            label="Audio from"
            value={o.audioHost}
            onChange={(audioHost) => set({ audioHost })}
            options={[
              { value: "output", label: "Output window (when open)" },
              { value: "operator", label: "Operator window" },
            ]}
          />
        </Section>

        <Section title="Standby visual">
          <TextField label="Title" value={o.standby.text} onChange={(text) => set({ standby: { ...o.standby, text } })} />
          <TextField label="Subtitle" value={o.standby.subtext} onChange={(subtext) => set({ standby: { ...o.standby, subtext } })} />
          <ColorField label="Color" value={o.standby.color} onChange={(color) => set({ standby: { ...o.standby, color } })} />
          <AssetField label="Image" type="image" value={o.standby.assetId} onChange={(assetId) => set({ standby: { ...o.standby, assetId } })} />
        </Section>
      </DialogContent>
    </Dialog>
  );
}
