# Agent notes

Guidance for AI coding agents working in this repository (Claude Code reads it through `CLAUDE.md`).

Salvation Live Studio is a Tauri 2 + React + Three.js show-control app for an LED wall. Start with [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The app runs a real show: stability matters more than new visuals.

## The MCP must stay compatible with the app

The app ships an MCP server ([docs/AGENT_CONTROL.md](docs/AGENT_CONTROL.md)) that lets an agent control every part of the running app. **Whenever you add or change a feature, update the MCP in the same change so an agent can still drive all of it.** A feature an agent cannot reach, or a tool that sends data the app no longer understands, is a bug.

Checklist for every feature change:

1. **New user-facing action or setting?** Make sure an agent can reach it:
   - A new component kind, cue action type, effect, transition, I/O message or show-wide setting usually needs no new tool, because the generic tools (`component_add`, `run_action`, `cue_add`, `patch`, `upsert`, `schema`) read the app's own factories and registries. Check that `schema` shows it (`src/agent/handlers.ts` → `schemaDoc`) and that `component_add` can build it (`compKindDefaults`).
   - A new operation that is not just data (something the operator clicks that runs engine code, like TAKE, GO, timers, announcements) needs a command: add it to `AGENT_COMMANDS` in [src/agent/spec.ts](src/agent/spec.ts) and its handler in [src/agent/handlers.ts](src/agent/handlers.ts). TypeScript refuses to build if a command has no handler.
2. **Renamed or reshaped data** (types in `src/core/types.ts`, store actions, engine exports)? Update the handlers and any descriptions or examples in `spec.ts` that mention the old shape. Keep old show files loading (migrate in `store/project.ts`), and keep the tools accepting what agents already send where you can.
3. **Changed what a command does or takes?** Bump `AGENT_SPEC_VERSION` in `spec.ts`. The MCP server warns when the running app speaks a different version.
4. **Mark reach honestly** in `spec.ts`: `live: true` for anything that reaches the audience, the lighting console or another machine; `destructive: true` for deletes and whole-show replacement; `readOnly: true` for pure reads.
5. **Verify:** `pnpm typecheck` (checks the app and `mcp/`), then with the app running `pnpm mcp:check` (read-only) or `node mcp/check.ts --build` (builds and deletes a scratch scene in the preview). Add a line to `mcp/check.ts` when you add a command worth smoke-testing.
6. **Docs:** update the tool table in [docs/AGENT_CONTROL.md](docs/AGENT_CONTROL.md).

`src/agent/spec.ts` is loaded by Node directly (type stripping): keep it free of imports and of non-erasable TypeScript (enums, namespaces, parameter properties).

## Other house rules

- Every animated value is a pure function of the shared clock; store timestamped events, never per-frame values (see ARCHITECTURE.md).
- Only the operator window is authoritative; the output window is a view.
- Dev server port is 1430 (another project uses 1420). The agent bridge uses 1431.
- Ask before spending generation credits (Runway, ElevenLabs) and before firing cues on the real lighting console.
