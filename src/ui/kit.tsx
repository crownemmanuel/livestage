// Small shared pieces for the operator UI: info tips, icon keys with tooltips, resizable panes.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A quiet ⓘ that explains a control on hover, so the panel itself can stay short. */
export function InfoTip({ children, className, side = "top" }: { children: ReactNode; className?: string; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" tabIndex={0} aria-label="More info" className={cn("inline-grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground", className)}>
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[300px] text-[12px] leading-snug">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/** Wrap anything in a tooltip. */
export function Tip({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[300px] text-[12px] leading-snug">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** ProPresenter-style toolbar button: icon over a short label. */
export function ToolbarButton({ icon, label, onClick, active, tone, tip, disabled }: { icon: ReactNode; label: string; onClick?: () => void; active?: boolean; tone?: "live" | "armed" | "preview"; tip?: ReactNode; disabled?: boolean }) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-12 min-w-[58px] flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 [&_svg]:size-[18px]",
        active && "bg-accent text-foreground",
        active && tone === "live" && "bg-live/15 text-live",
        active && tone === "armed" && "bg-armed/15 text-armed",
        active && tone === "preview" && "bg-preview/15 text-preview",
      )}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </button>
  );
  return tip ? <Tip label={tip} side="bottom">{btn}</Tip> : btn;
}

/** Round on/off toggle (ProPresenter's Audience / Stage keys). */
export function RoundToggle({ on, label, tone, onClick, tip, icon }: { on: boolean; label: string; tone: "live" | "armed" | "preview"; onClick: () => void; tip: ReactNode; icon: ReactNode }) {
  const ring = tone === "live" ? "border-live text-live" : tone === "armed" ? "border-armed text-armed" : "border-preview text-preview";
  const fill = tone === "live" ? "bg-live text-white" : tone === "armed" ? "bg-armed text-black" : "bg-preview text-black";
  return (
    <Tip label={tip} side="bottom">
      <button type="button" onClick={onClick} className="flex flex-col items-center gap-0.5 px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <span className={cn("grid size-8 place-items-center rounded-full border-2 transition-colors [&_svg]:size-4", on ? cn(fill, "border-transparent") : ring)}>{icon}</span>
        <span className="leading-none">{label}</span>
      </button>
    </Tip>
  );
}

// ---------------------------------------------------------------- resizable panes

function readWidths(key: string, defaults: number[]): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(`sls.panes.${key}`) ?? "null");
    if (Array.isArray(v) && v.length === defaults.length && v.every((n) => typeof n === "number")) return v;
  } catch {
    /* storage unavailable */
  }
  return defaults;
}

/** Column widths that survive a reload (per layout key). */
export function usePaneWidths(key: string, defaults: number[]) {
  const [widths, setWidths] = useState(() => readWidths(key, defaults));
  useEffect(() => {
    try {
      localStorage.setItem(`sls.panes.${key}`, JSON.stringify(widths));
    } catch {
      /* storage unavailable */
    }
  }, [key, widths]);
  const setOne = useCallback((i: number, w: number) => setWidths((ws) => ws.map((x, j) => (j === i ? w : x))), []);
  return [widths, setOne, () => setWidths(defaults)] as const;
}

/** Vertical drag handle. `dir` 1 grows the pane on its left, -1 the pane on its right. */
export function Splitter({ value, onChange, min, max, dir = 1, onReset }: { value: number; onChange: (v: number) => void; min: number; max: number; dir?: 1 | -1; onReset?: () => void }) {
  const start = useRef<{ x: number; v: number } | null>(null);
  const [active, setActive] = useState(false);
  return (
    <div
      className="splitter"
      data-active={active}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* synthetic or already-released pointer */
        }
        start.current = { x: e.clientX, v: value };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onChange(Math.max(min, Math.min(max, start.current.v + dir * (e.clientX - start.current.x))));
      }}
      onPointerUp={() => {
        start.current = null;
        setActive(false);
      }}
    />
  );
}
