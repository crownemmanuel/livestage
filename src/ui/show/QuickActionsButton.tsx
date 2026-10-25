import { useRef, useState } from "react";
import { Popover } from "radix-ui";
import { LayoutGrid, Megaphone, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShow } from "@/store/show";
import { RoundToggle } from "../kit";
import { AnnouncementsPanel, TimersPanel } from "./ShowTools";

/**
 * Announcements and show timers in the top bar: they belong to the whole show, not to the scene
 * on the wall, so they sit next to Blackout and Standby instead of under a scene's cues.
 */
export function QuickActionsButton() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"announce" | "timers">("announce");
  const anchor = useRef<HTMLDivElement>(null);
  const timersRunning = useShow((s) => Object.values(s.program.timers ?? {}).some((r) => r.running));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div ref={anchor}>
          <RoundToggle on={open} tone="preview" label="Quick actions" icon={<LayoutGrid />} tip="Announcements and show timers (show-wide, not tied to a scene)" onClick={() => setOpen(!open)} />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          // A click on the button itself toggles it; don't let it count as "outside" too.
          onInteractOutside={(e) => anchor.current?.contains(e.target as Node) && e.preventDefault()}
          className="z-50 flex max-h-[75vh] w-[min(520px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <div className="flex items-center gap-2 border-b border-border p-2">
            <div className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-black/25 p-1">
              {(["announce", "timers"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={cn(
                    "flex h-9 items-center justify-center gap-2 rounded-md text-[13px] font-semibold transition-colors [&_svg]:size-4",
                    tab === k ? "bg-accent text-foreground ring-1 ring-foreground/20" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  {k === "announce" ? <Megaphone /> : <Timer />}
                  {k === "announce" ? "Announce" : "Timers"}
                  {k === "timers" && timersRunning && <span className="size-2 rounded-full bg-preview" />}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pt-3">{tab === "announce" ? <AnnouncementsPanel /> : <TimersPanel />}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
