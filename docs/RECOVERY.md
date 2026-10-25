# Keeping the show up

What the app does so a glitch during the performance does not become a visible one.

## If the operator window reloads or crashes

The live state (what is on the wall, which cue is next, blackout/standby, the lion's position, any delayed actions still pending) is saved to `state.json` in the app data folder every time it changes, and once more when the window hides or unloads. On start-up the app restores it: the live scene comes back with its clock still running from where it was, the next cue is still the next cue, pending delayed actions are re-armed (ones that were due less than two seconds ago still fire; older ones are dropped), and the operator sees a green **RESUMED** badge for a minute. The preview opens on the live scene. State older than twelve hours is ignored, so the next day starts clean. **Forget live state** in the file menu starts clean on purpose.

The audience output keeps showing the last state it received while the operator is down; when the operator is back it re-broadcasts and the output falls in step.

## If the output window dies

The output sends a heartbeat every second. If it stops without a goodbye, the top bar shows **OUTPUT LOST · reopening** and the app reopens the output window on its monitor within a few seconds, with the current program. (Closing it from the top bar is remembered and does not trigger a reopen.) The program is also re-sent every five seconds so a missed message never sticks.

## If the GPU hiccups

A lost WebGL context (driver reset, display re-plug) is caught: the canvas rebuilds itself from the same scene state and carries on; nothing else restarts. Every canvas also releases its GPU context the moment it unmounts, so hours of TAKEs do not exhaust the browser's context limit.

## If a panel throws

Each panel (top bar, show mode, builder, every preview/program canvas, the output) is wrapped in an error boundary. A broken panel shows a small "Reload panel" message instead of taking the window down; canvases rebuild automatically after about a second; the output shows black for that second rather than an error page. Errors are counted in the top bar (hover for the last few) and never fatal.

## Edits and the show file

Every edit is saved about a second later with an atomic write (temp file, then rename), and flushed on hide/unload. **Export show file** keeps a copy somewhere safe before the performance.

## Timing

Delayed cue actions are scheduled by absolute wall-clock time, so a slow frame never shifts them. Program state is broadcast to the output at most 30 times a second (a live slider cannot flood the link), except TAKE, which goes immediately. The output never runs its own logic: everything on the wall is a pure function of a shared clock, so nothing can drift.

## Before the show

- Open the output on the LED display and check **Output … fps · worst frame … ms** in the status bar.
- Run the cue list once in the preview. Watch the error counter in the top bar.
- Enable only the I/O you use; test it from Settings → Monitor.
- Keep the operator window in front and the output window on its own display; never let the machine sleep (the app disables background throttling, but the OS can still sleep the display).
