import { useState, type ReactNode } from "react";
import { CircleCheck, CircleX, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { IoMessage } from "@/core/types";
import { describeMessage, hogMaster, hogOsc, hogTarget, resolveHog, sendMessage, soundWire, useIo, type SendContext } from "@/engine/io";
import { stageLightAnswer, stageLightReach, stageLightWire } from "@/engine/stageLight";
import { useProject } from "@/store/project";

/**
 * What a Test press did: UDP and MIDI get no reply, so the app cannot know whether the console
 * reacted. The operator says so, and a "no" opens the checklist for that kind of message.
 */
type Result = { lines: string[]; error: string | null; /** What StageLight said back, if anything (it answers refusals, and announces GOs). */ answer?: { error: string } | { live: string } | null };

/** The exact packets a message becomes, so the operator can compare them with the console's own log. */
function wireLines(m: IoMessage, ctx: SendContext): string[] {
  const io = useProject.getState().project.io;
  if (m.type === "sound") return soundWire(m, ctx);
  if (m.type === "stagelight") return stageLightWire(m);
  if (m.type === "hog") {
    const t = hogTarget(io);
    const to = t ? ` → ${t.host}:${t.port}` : "";
    const master = hogMaster(m);
    try {
      const { address, arg } = hogOsc(m);
      return [...(master ? [`/hog/hardware/fader/${master} 255${to}`] : []), `${address} "${arg}"${to}`];
    } catch {
      return [];
    }
  }
  if (m.type === "osc") {
    const t = io?.osc.targets.find((x) => x.id === m.target) ?? io?.osc.targets[0];
    return [`${m.address} ${m.args.map((a) => (typeof a === "string" ? `"${a}"` : a)).join(" ")}${t ? ` → ${t.host}:${t.port}` : ""}`];
  }
  return [];
}

function Check({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="rounded-md border border-border/60 px-3 py-2">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-0.5 text-muted-foreground">{children}</div>
    </li>
  );
}

/** Things to look at when the console did not react, most likely first. */
function Troubleshooting({ m }: { m: IoMessage }) {
  const io = useProject((s) => s.project.io);
  const mono = (s: string) => <span className="font-mono text-foreground">{s}</span>;
  if (m.type === "hog") {
    const t = hogTarget(io);
    const r = resolveHog(m);
    return (
      <ol className="grid gap-1.5 text-[12px]">
        {m.op === "go" && r.kind === "cuelist" && !hogMaster(m) && (
          <Check title="Is the list on a master with its fader down?">
            A list on a master plays at that fader's level, so the GO runs with no light. Put the master number in the {mono("master")} box (the app pushes the fader to full first), raise the fader, or take the list off the master.
          </Check>
        )}
        <Check title="Is OSC In switched on at the console?">
          On the Hog: Setup → Network → select the console → Settings → OSC. Tick {mono("OSC In")} (not just OSC Out) and set its port to {mono(String(t?.port ?? 7001))}. It is per console, so set it on the one running the show.
        </Check>
        <Check title={`Does ${r.kind} ${r.number || "?"} exist${m.cue.trim() ? `, with cue ${m.cue.trim()}` : ""}?`}>
          Check the number in the console's {r.kind === "cuelist" ? "Cuelist" : r.kind === "scene" ? "Scene" : "Macro"} directory. A missing list or cue is silently ignored.{m.cue.trim() ? " Try once with the cue box empty: GO then just advances the list." : ""}
        </Check>
        <Check title="Can this computer reach the console?">
          Settings → Lighting console must be the console's HogNet address ({mono(t ? `${t.host}:${t.port}` : "not set")}). The computer needs a cable on HogNet with a fixed IP in the same range (e.g. 172.31.0.3, mask 255.255.0.0, router blank). Pinging the console's address from Terminal should answer.
        </Check>
      </ol>
    );
  }
  if (m.type === "sound") {
    const so = io?.sound;
    return (
      <ol className="grid gap-1.5 text-[12px]">
        <Check title="Is StageMics running, at that address?">
          Settings → StageMics: {mono(so ? `${so.host}:${so.port}` : "not set")} (its OSC port is 1451). The status there says whether it answers; switch on Receive from console → Listen for OSC to see its replies.
        </Check>
        <Check title="Does StageMics know that mic or scene?">A mic is its number or the character's name as StageMics has it. Scenes match by LiveStage scene id, so StageMics' scenes must come from this show.</Check>
      </ol>
    );
  }
  if (m.type === "stagelight") {
    const sl = io?.stagelight;
    return (
      <ol className="grid gap-1.5 text-[12px]">
        <Check title="Is StageLight running, at that address and port?">
          Settings → StageLight: {mono(sl ? `${sl.host}:${sl.port}` : "not set")}. The show desk listens on {mono("1461")}; dev desks on other ports (1471). The status there says whether StageLight answers its pings; switch on Receive from console → Listen for OSC to see its replies.
        </Check>
        <Check title="Does StageLight know that page, cue or trigger?">
          In StageLight, ☰ → Network & triggers lists every message it received with its result. A page or cue is its name, ID or number (1 = the first); a named trigger must be set up there first.
        </Check>
        <Check title="Is StageLight on another computer?">StageLight listens on This Mac only unless it is switched to Show network, and then only hears the addresses on its allowlist.</Check>
        <Check title="Did the lights not change, though StageLight GOed?">StageLight's physical output may not be armed (it then runs in preview only), or the master or blackout may be holding the look down.</Check>
      </ol>
    );
  }
  if (m.type === "osc") {
    return (
      <ol className="grid gap-1.5 text-[12px]">
        <Check title="Is the receiver listening on that address and port?">The target under Settings → Other OSC devices must match the device's OSC input. On the receiving device, OSC input must be switched on.</Check>
        <Check title="Is the address spelled the way the device expects?">OSC addresses are case-sensitive. Some devices only accept text arguments (the Hog wants list numbers as text) or only numbers.</Check>
        <Check title="Can this computer reach it?">Both machines need to be on the same network range; pinging the device's address from Terminal should answer.</Check>
      </ol>
    );
  }
  return (
    <ol className="grid gap-1.5 text-[12px]">
      <Check title="Is a MIDI output chosen?">Settings → MIDI must be on, with the right output port (interface or network session) picked.</Check>
      {m.type === "msc" ? (
        <Check title="Does the console listen for MIDI Show Control?">MSC In must be on at the console, with device ID {mono(String(m.deviceId))} (or "all"). The cue{m.list ? " and list" : ""} must exist there.</Check>
      ) : (
        <Check title="Is the receiver on the same channel and mapped?">The device must listen on that MIDI channel and have this note / CC / program mapped to something.</Check>
      )}
    </ol>
  );
}

/** The Test button for an outgoing message: sends it, then asks whether it worked. */
export function TestSendButton({ m, className, size = "xs", variant = "ghost" }: { m: IoMessage; className?: string; size?: "xs" | "sm"; variant?: "ghost" | "outline" }) {
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);

  // A message being edited belongs to the scene in the builder (a Sound-app "this scene").
  const sceneId = useProject((s) => s.selectedSceneId);
  const send = async () => {
    const before = useIo.getState().log.length;
    const at = Date.now();
    await sendMessage(m, { sceneId });
    const err = useIo.getState().log.slice(before).find((l) => l.dir === "error");
    // StageLight answers a refusal within milliseconds; wait a moment for it (only while it answers pings).
    const answer = m.type === "stagelight" && !err && stageLightReach() === "answering" ? await stageLightAnswer(at) : undefined;
    setResult({ lines: wireLines(m, { sceneId }), error: err ? err.text : null, answer });
    setFailed(!!err || (!!answer && "error" in answer));
  };

  return (
    <>
      <Button size={size} variant={variant} className={className} title="Send this message now, then confirm it worked" onClick={() => void send()}>
        <Send /> Test
      </Button>
      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{result?.error ? "Couldn't send" : "Did it work?"}</DialogTitle>
            <DialogDescription>
              {result?.error
                ? "The message never left this computer."
                : m.type === "sound"
                  ? "Sent to StageMics. Check its screen to see whether it changed."
                : m.type === "stagelight"
                  ? result?.answer && "error" in result.answer
                    ? "StageLight received it and refused it."
                    : result?.answer
                      ? "StageLight received it and GOed."
                      : "Sent to StageLight. It answers only when it refuses a message (or announces a GO), so check its screen to see whether it reacted."
                  : "Sent. The console doesn't reply to these messages, so only you can see whether it reacted."}
            </DialogDescription>
          </DialogHeader>
          {result && (
            <div className="grid gap-3 text-[12px]">
              <div className="rounded-md bg-muted/50 px-3 py-2">
                <div className="text-foreground">{describeMessage(m)}</div>
                {result.lines.map((l) => (
                  <div key={l} className="font-mono text-[11px] text-muted-foreground">
                    {l}
                  </div>
                ))}
                {result.error && <div className="mt-1 text-destructive">{result.error}</div>}
                {result.answer && "error" in result.answer && <div className="mt-1 text-destructive">StageLight: {result.answer.error}</div>}
                {result.answer && "live" in result.answer && <div className="mt-1 text-preview">StageLight GO: {result.answer.live}</div>}
              </div>
              {result.error ? (
                <p className="text-muted-foreground">Check Settings: the lighting console's, StageLight's or StageMics' address and port (and switch), the MIDI output, and that this is the desktop app (a browser tab cannot send OSC or MIDI).</p>
              ) : (
                failed && (
                  <>
                    <div className="font-medium">Things to check, most likely first</div>
                    <Troubleshooting m={m} />
                  </>
                )
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => void send()}>
              <RotateCcw /> Send again
            </Button>
            {!failed && (
              <Button variant="outline" onClick={() => setFailed(true)}>
                <CircleX /> No, nothing happened
              </Button>
            )}
            <Button onClick={() => setResult(null)}>
              <CircleCheck /> {failed ? "Close" : "Yes, it worked"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
