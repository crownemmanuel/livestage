# Show packages: moving the show to another computer

The show is built on one computer and run on another. A **show package** carries everything across: the show file, a versioned manifest and every media file the show uses. Taking a package in on the other computer gives the identical show. A later package only asks about scenes that were changed on both computers.

## Using it

On the build computer: **More → Export show package (with media)…** and choose a name and place. The app writes a folder `<name>.slshow`. Copy the whole folder to the show computer (USB drive, network share, or zip it yourself).

On the show computer: **More → Import show package…** and choose the `.slshow` folder. Nothing changes until you have reviewed it:

- The versions: "v7, made on a Mac at 14:02; this computer has v6".
- **Replace the whole show** (the default when this computer has never taken in this show, for example a fresh install): every scene, cue and setting comes from the package.
- **Merge (keep what changed here)** (the default when it has): scenes and settings changed only in the package are updated, ones changed only here are kept, and ones changed on both sides are listed for you to decide:
  - **Take incoming**: the package's version replaces this computer's.
  - **Keep mine**: this computer's version stays; the package's version of that scene and the media only it uses are left out.
  - **Keep mine + add its media**: this computer's version stays, and the media the package's version uses is added to the library, ready to use.
  - **Keep both**: this computer's version stays, and the package's version is added right after it as "<name> (incoming v7)".
  - A scene removed on one side and changed on the other is asked about the same way ("Remove it" / "Keep it", "Restore it" / "Leave it removed").
- If a scene is live on the wall, the import button stays disabled until you tick "Take in the package anyway". Media that is playing may be replaced.

Unless you pick otherwise, a conflict keeps this computer's version. Taking a package in never changes this computer's own settings: the output display, its fullscreen/window size, MIDI ports and whether MIDI/OSC are switched on.

The media is copied into the app's data folder (`%APPDATA%\org.salvation.livestudio\` on Windows, `~/Library/Application Support/org.salvation.livestudio/` on a Mac). Each file is checked against its SHA-256 hash, and a file that is already there with the same hash is skipped, so the second package copies only what changed. A damaged copy is reported and never replaces a good file.

## What is in a package

```
House of David 2026-10-19.slshow/
  show.json       the show file, with portable media references (no paths from the build computer)
  manifest.json   format, show id, version, who made it and when, a hash per scene/setting, a hash per file
  files/
    media/prologue/p1-push-in.mp4      media that ships with the app (public/media/…)
    assets/asset_x8k2_take.mp4         media imported into the app's library
```

`manifest.json`:

```json
{
  "format": "salvation-show-package",
  "formatVersion": 1,
  "showId": "show_temesz1xyzu",
  "showName": "Salvation 2026: The House of David",
  "version": 7,
  "createdAt": "2026-10-19T05:59:27.639Z",
  "from": "Mac",
  "units": { "scene:scene_3cz04nfpl9m": { "label": "1. Prologue 1 · …", "hash": "9f0c…" }, "order": { … }, "output": { … } },
  "files": [{ "key": "media/prologue/p1-push-in.mp4", "size": 10403589, "sha256": "0d5b…" }],
  "missing": []
}
```

An app that is older than the package's `formatVersion` refuses it and asks to be updated.

## How media is referenced

An asset (`src/core/types.ts`) can carry a portable `file` key (and `macFile` for its HEVC-alpha twin): a path relative to the show's media folder, which is the app data folder on the desktop. Library imports get `assets/<id>_<name>`; media that ships with the app keeps its `/media/…` URL and gets the matching key `media/…` when it arrives in a package. On load (`resolveAssetUrls` in `src/core/platform.ts`) the desktop app plays the local copy when it has one, and otherwise the URL (the bundled file). Absolute paths are never needed. Show files from before keys existed are migrated on load: an absolute library path from this computer, another Mac or a Windows PC becomes `assets/<file name>`.

New media that the build computer adds to `public/media/<scene>/` (for example re-rendered high-quality clips swapped in place) is picked up by the next package automatically, because export reads every asset the show references.

## Versions and conflicts

Every package, and later every cloud push, gets the next version number. The show file remembers its history in `project.lineage`:

- `showId`: the same show on every computer (made at the first export).
- `sent`: the last version this computer sent out.
- `received`: the last version taken in, when, and from what kind of computer.
- `base`: a content hash of every unit (each scene, the running order and groups, the wall/output settings, show control, timers, announcements, effect presets, the show name) as last exchanged.

Taking a version in compares three hashes per unit: here, incoming and the base. Here equals base: only the other side changed it, so it is taken. Incoming equals base: only this side changed it, so it is kept. Neither: a conflict. After the merge the base becomes the incoming hashes, so a choice is asked once and not again for the same version. The asset library merges by adding: incoming asset definitions are added or updated, and nothing is deleted. The merge code is `src/core/showMerge.ts` and is shared with cloud sync.

A scene's hash covers its content (components, cues, camera, look, notes). Its thumbnail, running-order number and group are not part of it; order and groups are their own unit.

## For agents (MCP)

- `package_export {dir}`: write a package; returns version, file count, size and anything missing.
- `package_import {dir, dryRun: true}`: the plan (versions, conflicts with their keys and options, incoming and kept changes).
- `package_import {dir, choices: {"scene:scene_ab12": "both"}}` or `{resolve: "local"}`: apply. Without a choice for every conflict, nothing changes and the plan comes back. A live scene needs `allowLive: true` (ask the operator first).

## Code

- `src-tauri/src/package.rs`: streaming copy with SHA-256, export into `<name>.slshow.partial` and then swapped in, verified import, `hash_files` with a cache.
- `src/core/showPackage.ts`: building the file list and the manifest, reading, planning and importing.
- `src/core/showMerge.ts`: units, hashes, the three-way plan and applying the choices.
- `src/engine/showTransfer.ts`: the operations the UI and the agent call (live guard, save, version stamp).
- `src/ui/ShowPackage.tsx`: the menu actions and the review dialog.

## Limits

- Packages are written and taken in by the desktop app. The browser development build cannot copy media files.
- The package holds every asset in the library, used or not.
- Media referenced by a plain web URL stays a URL and needs the network on the show computer.
- Exporting from an installed (release) build reads bundled media from inside the app. This was not tested on a release build yet; exporting from the build computer's development app is the tested path.
