# Agent notes

Guidance for AI coding agents working in this repository (Claude Code reads it through `CLAUDE.md`).

LiveStage is a Tauri 2 + React + Three.js show-control app for an LED wall. Start with [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The app runs a real show: stability matters more than new visuals.

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

## The repository holds the app, never a show

LiveStage is open source. The show we are building (Salvation) shapes the app, but the show itself stays out of git:

- **Commit only code and its docs**: the app, the MCP, build tooling, docs about how the app works. A feature the show needs goes in as a general app feature.
- **Never commit show content**: the show file (it lives in the app's data folder), show media (`public/media/scenes/`, audio, images, video, cut-outs), generation drafts, prompts and logs, per-show build scripts (`media-src/`), the archive, script or cast material. Do not stage them, even when a change made them; in a "commit everything" request, leave them out and say so.
- **Shows move by the app's own export**: More → Export show package / Import show package, or cloud sync ([docs/SHOW_PACKAGE.md](docs/SHOW_PACKAGE.md)). If a show cannot be fully rebuilt on another computer from a package, fix the export, not the repo.

## Other house rules

- Every animated value is a pure function of the shared clock; store timestamped events, never per-frame values (see ARCHITECTURE.md).
- Only the operator window is authoritative; the output window is a view.
- Dev server port is 1430 (another project uses 1420). The agent bridge uses 1431.
- Ask before spending money on generation (KreatorFlow, Kie.ai, Runway, ElevenLabs) and before firing cues on the real lighting console. Video goes through `media-src/tools/gen.py` (Seedance 2.0 Fast 720p by default, then Topaz 2x), see [docs/MEDIA_GENERATION.md](docs/MEDIA_GENERATION.md).
- The LED wall is part of the set, kept at life-size scale next to the actors (no push-ins that blow things past life size): read `docs/SCENE_BACKDROPS.md` (local show notes, not in the repo) before designing any backdrop or camera move.
- Making AI video for the wall (Runway pipeline, 4:1 crops, no music, lip-sync to a recorded voice with the black-video trick): read [docs/MEDIA_GENERATION.md](docs/MEDIA_GENERATION.md).
- Show media layout: finals go in `public/media/scenes/<Group>/images|videos|audio/` (one folder per running-order group, or per ungrouped scene), named `<scene code>-<description>.<ext>` in lowercase-hyphenated words (a webm and its `.mov` twin share the name). Drafts and sources stay in `media-src/`. Superseded or unused media moves to `media-src/archive/` (never deleted). When replacing a final, archive the old file and repoint the asset (`patch project/assets/<id>/url`, and `macUrl` for a cut-out's `.mov` twin: a stale one makes the Mac app skip the clip). See [docs/MEDIA_GENERATION.md](docs/MEDIA_GENERATION.md#where-media-lives).
- Log every generation (prompt, model, sources, task id, which scene and asset it feeds) with `media-src/tools/genlog.py add`, and look there first when asked to regenerate something: `python3 media-src/tools/genlog.py find <scene code or asset id>`.
- Names and notes the operator reads in the show (cues, scenes, components, assets) stay short: one line, only what the operator needs, e.g. "Auto, 2 s after the painting turns real." Reasons and history go in docs or the generation log, not the cue.
