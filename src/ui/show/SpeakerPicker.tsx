// Surround speakers in the UI: the per-computer setup (Settings → Audio: which sound card and channel each
// speaker is) and the chooser a sound, an announcement or thunder uses to pick its speakers. See engine/speakers.ts.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SpeakerId } from "@/core/types";
import { cn } from "@/lib/utils";
import { getAudioRoute, nativeOutputs, onAudioRouteChange, webOutputs, type WebOutput } from "@/engine/audioOutput";
import { getSpeakerSetup, onSpeakerSetupChange, otherDevicesSupported, setSpeakerSetup, SPEAKERS, speakerLabel, testSpeaker, type SpeakerMap, type SpeakerSetup } from "@/engine/speakers";
import { SelectBox } from "../fields";
import { InfoTip } from "../kit";

/** Which speakers a sound plays on: Main (none chosen) or any of Left, Right, Back 1, Back 2. */
export function SpeakerChooser({ value, onChange, className }: { value: SpeakerId[] | undefined; onChange: (v: SpeakerId[] | undefined) => void; className?: string }) {
  const on = new Set(value ?? []);
  const toggle = (id: SpeakerId) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const list = SPEAKERS.map((s) => s.id).filter((x) => next.has(x));
    onChange(list.length ? list : undefined);
  };
  const chip = (active: boolean) =>
    cn("h-6 min-w-6 rounded border px-1.5 text-[10.5px] font-medium transition-colors", active ? "border-preview bg-preview/20 text-foreground" : "border-border text-muted-foreground hover:text-foreground");
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} title="Where it plays: the main output, or any of the surround speakers (set up in Settings → Audio). Left + Right (or Back 1 + Back 2) together play it in stereo; one alone plays it in mono.">
      <button type="button" className={chip(!on.size)} onClick={() => onChange(undefined)}>
        Main
      </button>
      {SPEAKERS.map((s) => (
        <button key={s.id} type="button" className={chip(on.has(s.id))} onClick={() => toggle(s.id)} aria-pressed={on.has(s.id)} aria-label={s.label}>
          {s.short}
        </button>
      ))}
    </span>
  );
}

/** "left,right" form of a speaker list, for an effect param. */
export const speakersToParam = (v: SpeakerId[] | undefined) => (v ?? []).join(",");

const NONE = "__none__";
const MAIN = "__main__";

/** Channels a device offers, as far as the app can tell (a Dante Virtual Soundcard pair is two). */
function channelsOf(device: string, web: WebOutput[], mainChannels: number | null): number {
  if (!device) return mainChannels ?? 8;
  const w = web.find((o) => o.deviceId === device);
  if (w && /\b\d+\s*-\s*\d+\b/.test(w.label) && w.dante) return 2;
  return 8;
}

/** Settings → Audio: which sound card and channel each surround speaker is, on this computer. */
export function SpeakerSetupPanel() {
  const [setup, setSetup] = useState<SpeakerMap>(getSpeakerSetup);
  const [web, setWeb] = useState<WebOutput[]>([]);
  const [mainName, setMainName] = useState<string | null>(null);
  const [mainChannels, setMainChannels] = useState<number | null>(null);
  const [testing, setTesting] = useState<SpeakerId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [n, w] = await Promise.all([nativeOutputs(), otherDevicesSupported ? webOutputs() : Promise.resolve([])]);
    setWeb(w);
    const route = getAudioRoute();
    const mac = n.find((o) => o.isDefault);
    setMainName(route?.name ?? mac?.name ?? null);
    setMainChannels(mac?.channels ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    const h = setInterval(() => void refresh(), 5000);
    const off1 = onSpeakerSetupChange(() => setSetup(getSpeakerSetup()));
    const off2 = onAudioRouteChange(() => void refresh());
    return () => {
      clearInterval(h);
      off1();
      off2();
    };
  }, [refresh]);

  const save = (id: SpeakerId, s: SpeakerSetup | undefined) => {
    const next = { ...setup };
    if (s) next[id] = s;
    else delete next[id];
    setSetup(next);
    setSpeakerSetup(next);
  };

  const test = async (id: SpeakerId) => {
    setError(null);
    setTesting(id);
    try {
      await testSpeaker(id, setup[id]);
    } catch (e) {
      setError(`${speakerLabel(id)}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] font-semibold">Surround speakers</span>
        <InfoTip>
          Up to four speakers a sound can be sent to instead of the main output: in a sound cue, an announcement or the lightning&apos;s thunder, pick Main or any of L, R, B1, B2. Each speaker is one channel of a sound card.
          {otherDevicesSupported
            ? " Choose the main output (its channels 3 and 4 on a 4-channel interface) or any other playback device, such as a second Dante Virtual Soundcard pair (DVS Transmit 3-4). A speaker on another device plays a few tens of milliseconds after the main output."
            : " On the Mac the app can only play to the main output, so each speaker is one of its channels: choose a device with enough channels as the main output (Dante Virtual Soundcard, a 4-channel interface, or an aggregate device from Audio MIDI Setup)."}{" "}
          A speaker that is not set up, or whose card is missing, plays on the main output so nothing goes silent. Test plays a short burst on that speaker alone. The setup belongs to this computer, not the show file.
        </InfoTip>
      </div>
      {SPEAKERS.map(({ id, label }) => {
        const s = setup[id];
        const deviceValue = !s ? NONE : s.device ? s.device : MAIN;
        const missing = !!s?.device && otherDevicesSupported && !web.some((o) => o.deviceId === s.device);
        const options = [
          { value: NONE, label: "Not set up (main output)" },
          { value: MAIN, label: `Main output${mainName ? ` (${mainName})` : ""}` },
          ...web.map((o) => ({ value: o.deviceId, label: o.label })),
          ...(missing && s ? [{ value: s.device, label: `${s.deviceName ?? "Sound card"} (not connected)` }] : []),
          // A setup made on Windows read on the Mac: keep it visible.
          ...(!otherDevicesSupported && s?.device ? [{ value: s.device, label: `${s.deviceName ?? "Sound card"} (not reachable here)` }] : []),
        ];
        const n = s ? Math.max(channelsOf(s.device, web, mainChannels), s.channel + 1) : 0;
        return (
          <div key={id} className="grid grid-cols-[56px_1fr_110px_auto] items-center gap-2">
            <span className="text-[12px] text-muted-foreground">{label}</span>
            <SelectBox
              value={deviceValue}
              className={cn(missing && "border-armed/60 text-armed")}
              options={options}
              onChange={(v) => {
                if (v === NONE) return save(id, undefined);
                const device = v === MAIN ? "" : v;
                const name = web.find((o) => o.deviceId === device)?.label;
                const max = channelsOf(device, web, mainChannels);
                save(id, { device, ...(name ? { deviceName: name } : {}), channel: Math.min(s?.channel ?? 0, max - 1) });
              }}
            />
            {s ? (
              <SelectBox
                value={String(s.channel)}
                options={Array.from({ length: n }, (_, i) => ({ value: String(i), label: n === 2 ? `Ch ${i + 1} (${i ? "right" : "left"})` : `Ch ${i + 1}` }))}
                onChange={(v) => save(id, { ...s, channel: Number(v) })}
              />
            ) : (
              <span />
            )}
            <Button size="xs" variant="outline" className="h-7" disabled={!s || testing !== null} onClick={() => void test(id)} title={`Play a short burst on ${label} alone`}>
              <Volume2 className="size-3" />
              {testing === id ? "…" : "Test"}
            </Button>
          </div>
        );
      })}
      {error && (
        <div className="flex items-start gap-1.5 rounded-md border border-armed/40 bg-armed/10 px-2 py-1 text-[11.5px] leading-snug text-armed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
