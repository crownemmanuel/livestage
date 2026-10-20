// The app-wide audio output: native devices (CoreAudio, Dante included) and the web engine's own
// outputs, in one list. See engine/audioOutput.ts for how each engine routes.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Speaker } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  getAudioRoute,
  nativeOutputs,
  nativeRouting,
  onAudioRouteChange,
  revealWebOutputNames,
  routeMismatch,
  setAudioRoute,
  webOutputs,
  webSinkSupported,
  type AudioRoute,
  type NativeOutput,
  type WebOutput,
} from "@/engine/audioOutput";
import { InfoTip } from "../kit";

const TRANSPORT: Record<string, string> = {
  builtIn: "Built-in",
  usb: "USB",
  thunderbolt: "Thunderbolt",
  pci: "PCI",
  firewire: "FireWire",
  hdmi: "HDMI",
  displayPort: "DisplayPort",
  bluetooth: "Bluetooth",
  airplay: "AirPlay",
  avb: "AVB",
  virtual: "Virtual",
  aggregate: "Aggregate",
};

const SYSTEM = "system";
const valueOf = (r: AudioRoute) => (r ? `${r.engine}:${r.id}` : SYSTEM);

function describe(o: NativeOutput) {
  const kind = o.dante ? "Dante" : (TRANSPORT[o.transport] ?? "");
  return [kind, `${o.channels} ch`, o.sampleRate ? `${Math.round(o.sampleRate / 100) / 10} kHz` : ""].filter(Boolean).join(" · ");
}

/** `inCard`: drawn inside a titled card (Show control → Connection), so no label or side padding of its own. */
export function AudioOutputPicker({ inCard = false }: { inCard?: boolean }) {
  const [route, setRoute] = useState<AudioRoute>(getAudioRoute);
  const [native, setNative] = useState<NativeOutput[]>([]);
  const [web, setWeb] = useState<WebOutput[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [n, w] = await Promise.all([nativeOutputs(), webOutputs()]);
    setNative(n);
    setWeb(w);
  }, []);

  useEffect(() => {
    void refresh();
    // Devices come and go (Dante Virtual Soundcard restarting, an interface unplugged).
    const h = setInterval(() => void refresh(), 3000);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    const off = onAudioRouteChange(() => {
      setRoute(getAudioRoute());
      void refresh();
    });
    return () => {
      clearInterval(h);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
      off();
    };
  }, [refresh]);

  const choose = async (v: string) => {
    setError(null);
    let next: AudioRoute = null;
    if (v !== SYSTEM) {
      const [engine, ...rest] = v.split(":");
      const id = rest.join(":");
      const name = engine === "native" ? (native.find((o) => o.uid === id)?.name ?? id) : (web.find((o) => o.deviceId === id)?.label ?? id);
      next = { engine: engine as "native" | "web", id, name };
    }
    try {
      await setAudioRoute(next);
    } catch (e) {
      setError(String(e));
    }
  };

  const chosenMissing = route && (route.engine === "native" ? !native.some((o) => o.uid === route.id) : webSinkSupported && !web.some((o) => o.deviceId === route.id));
  const mismatch = !chosenMissing ? routeMismatch(route, native) : null;
  const macDefault = native.find((o) => o.isDefault);
  const dante = native.filter((o) => o.dante);
  const others = native.filter((o) => !o.dante);

  return (
    <div className={cn("space-y-1.5", !inCard && "px-3 pb-2")}>
      <div className="flex items-center gap-1.5">
        {!inCard && (
          <>
            <Speaker className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-[12px] text-muted-foreground">Output</span>
          </>
        )}
        <Select value={valueOf(route)} onValueChange={(v) => void choose(v)}>
          <SelectTrigger size="sm" className={cn("min-w-0 flex-1 text-[12px]", inCard ? "h-8" : "h-7", (chosenMissing || mismatch) && "border-armed/60 text-armed")}>
            <SelectValue placeholder="Computer default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SYSTEM} className="text-[12px]">
              Computer default{macDefault ? ` (${macDefault.name})` : ""}
            </SelectItem>
            {dante.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="text-[11px]">Dante · native</SelectLabel>
                  {dante.map((o) => (
                    <NativeItem key={o.uid} o={o} />
                  ))}
                </SelectGroup>
              </>
            )}
            {others.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="text-[11px]">Native devices</SelectLabel>
                  {others.map((o) => (
                    <NativeItem key={o.uid} o={o} />
                  ))}
                </SelectGroup>
              </>
            )}
            {web.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="text-[11px]">Web engine</SelectLabel>
                  {web.map((o) => (
                    <SelectItem key={o.deviceId} value={`web:${o.deviceId}`} className="text-[12px]">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
            {/* Keep a saved choice selectable while its device is away. */}
            {chosenMissing && route && (
              <SelectItem value={valueOf(route)} className="text-[12px]">
                {route.name} (not connected)
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" title="Look for audio devices again" onClick={() => void refresh()}>
          <RefreshCw className="size-3" />
        </Button>
        <InfoTip side="left">
          Where all of the app&apos;s sound goes: cue sounds, thunder, announcements and video sound. Native devices come from the computer itself and include Dante Virtual Soundcard and Dante Via;
          on the Mac, choosing one makes it the Mac&apos;s sound output while the app runs (other apps follow it too) and the previous output comes back when the app quits. Web engine
          outputs come from the webview and only change this app. Stereo plays on the device&apos;s first two channels; pick others in Audio MIDI Setup → Configure Speakers. The choice
          belongs to this computer, not the show file.
          {!nativeRouting && " Native devices are listed in the desktop app on macOS."}
          {!webSinkSupported && " This webview cannot pick an output of its own, so only native devices are offered."}
        </InfoTip>
      </div>
      {chosenMissing && route && (
        <Warn>
          {route.name} is not connected{macDefault ? `: sound is going to ${macDefault.name}` : ""}. It is routed again as soon as it comes back.
        </Warn>
      )}
      {mismatch?.chosen && (
        <Warn>
          The computer&apos;s output was changed to {mismatch.actual?.name ?? "another device"}.
          <Button size="xs" variant="outline" className="ml-2 h-5" onClick={() => void choose(valueOf(route))}>
            Route to {mismatch.chosen.name}
          </Button>
        </Warn>
      )}
      {webSinkSupported && web.length > 0 && web.every((o) => /^Output \d+$/.test(o.label)) && (
        <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => void revealWebOutputNames().then(refresh).catch(() => {})}>
          Show web output names
        </button>
      )}
      {error && <Warn>{error}</Warn>}
    </div>
  );
}

function NativeItem({ o }: { o: NativeOutput }) {
  return (
    <SelectItem value={`native:${o.uid}`} className="text-[12px]">
      <span className="truncate">{o.name}</span>
      <span className="ml-1.5 text-[11px] text-muted-foreground">{describe(o)}</span>
    </SelectItem>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-armed/40 bg-armed/10 px-2 py-1 text-[11.5px] leading-snug text-armed">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
