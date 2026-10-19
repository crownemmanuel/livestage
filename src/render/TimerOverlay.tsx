// A show timer laid over the wall (Show Mode → Timers → Show on screen): plain DOM above the
// program picture, styled by Output → timer overlay, fading on and off.

import { useEffect, useState, type CSSProperties } from "react";
import { now } from "@/core/clock";
import { formatClock, timerLeft } from "@/core/timers";
import type { OverlayPosition, TimerOverlayStyle } from "@/core/types";
import { useShow } from "@/store/show";
import { fontFamily } from "./layers/canvasTex";

const PLACE: Record<OverlayPosition, { x: "start" | "center" | "end"; y: "start" | "center" | "end" }> = {
  "top-left": { x: "start", y: "start" },
  top: { x: "center", y: "start" },
  "top-right": { x: "end", y: "start" },
  left: { x: "start", y: "center" },
  center: { x: "center", y: "center" },
  right: { x: "end", y: "center" },
  "bottom-left": { x: "start", y: "end" },
  bottom: { x: "center", y: "end" },
  "bottom-right": { x: "end", y: "end" },
};

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** The overlay's look, at a given wall height in px (also used by the designer's preview). */
export function TimerOverlayView({ style: s, label, clock, h, visible = true }: { style: TimerOverlayStyle; label: string; clock: string; h: number; visible?: boolean }) {
  const p = PLACE[s.position];
  const fs = s.size * h;
  const box: CSSProperties = {
    position: "absolute",
    inset: s.margin * h,
    display: "flex",
    justifyContent: p.x === "start" ? "flex-start" : p.x === "end" ? "flex-end" : "center",
    alignItems: p.y === "start" ? "flex-start" : p.y === "end" ? "flex-end" : "center",
    pointerEvents: "none",
    // Above the program slots (1–2) and the standby card (7); blackout hides it instead.
    zIndex: 9,
    opacity: visible ? 1 : 0,
    transition: "opacity 600ms ease",
  };
  return (
    <div style={box}>
      <div
        style={{
          background: s.backgroundOpacity > 0 ? hexA(s.background, s.backgroundOpacity) : "transparent",
          borderRadius: fs * 0.22,
          padding: s.backgroundOpacity > 0 ? `${fs * 0.18}px ${fs * 0.4}px` : 0,
          color: s.color,
          textAlign: p.x === "start" ? "left" : p.x === "end" ? "right" : "center",
          fontFamily: fontFamily(s.font),
          lineHeight: 1,
          textShadow: `0 ${fs * 0.03}px ${fs * 0.12}px rgba(0,0,0,0.6)`,
        }}
      >
        {s.showLabel && label && <div style={{ fontSize: fs * 0.32, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85, marginBottom: fs * 0.1 }}>{label}</div>}
        <div style={{ fontSize: fs, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{clock}</div>
      </div>
    </div>
  );
}

/** The live overlay over the program picture; `h` is the displayed wall height in px. */
export function TimerOverlay({ h }: { h: number }) {
  const on = useShow((s) => s.program.timerOverlay);
  // Keep the last content while fading out.
  const [last, setLast] = useState(on ?? null);
  const shownId = (on ?? last)?.timerId;
  const run = useShow((s) => (shownId ? s.program.timers?.[shownId] : undefined));
  const blackout = useShow((s) => !!s.program.blackout?.on);
  const style = useShow((s) => s.output.timerOverlay);
  const [, force] = useState(0);
  useEffect(() => {
    if (on) setLast(on);
  }, [on]);
  useEffect(() => {
    if (!run?.running) return;
    const t = setInterval(() => force((n) => n + 1), 200);
    return () => clearInterval(t);
  }, [run?.running]);
  if (!last || !style) return null;
  const shown = on ?? last;
  return <TimerOverlayView style={style} label={shown.label} clock={formatClock(timerLeft(run, 0, now()))} h={h} visible={!!on && !blackout} />;
}
