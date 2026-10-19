// Show timers: what one reads right now, and how the wall prints it.

import type { TimerRun } from "./types";

/** Seconds left on a timer (whole seconds, counting down; never below 0). */
export function timerLeft(run: TimerRun | undefined, fallback: number, wallNow: number): number {
  if (!run) return Math.ceil(fallback);
  const s = run.running ? (run.endsAt - wallNow) / 1000 : run.remaining;
  return Math.max(0, Math.ceil(s - 0.0001));
}

/** 4:05, 12:00, 1:02:30. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A countdown title's text: "{time}" becomes the clock (or the clock goes on its own line). */
export function countdownText(template: string, clock: string): string {
  if (template.includes("{time}")) return template.split("{time}").join(clock);
  return template.trim() ? `${template}\n${clock}` : clock;
}
