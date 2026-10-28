# Moving the show to another computer: packages and cloud sync

The show is built on one computer and run on another. Two ways carry it across, with the same versions and the same conflict handling:

- A **show package**: a folder with the show file, a versioned manifest and every media file the show uses. Copy it by drive or network.
- **Cloud sync** (optional, off until you enter your own Firebase keys): the build computer pushes versions to your Firebase project; the show computer presses Sync.

Taking a version in on the other computer gives the identical show. A later version only asks about scenes that were changed on both computers.

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

**Sound levels** (the live mixer's trims, saved in the show file as `mix`) are one unit, asked about more eagerly: whenever the levels were changed on this computer and differ from the incoming version's, the review asks *Keep this computer's levels* or *Use the incoming levels*, even when the incoming version did not change its levels, and also when replacing the whole show. Importing a plain show file (More → Import show file…) asks the same question. Levels changed only in the incoming version are taken without asking.

Unless you pick otherwise, a conflict keeps this computer's version. Taking a package in never changes this computer's own settings: the output display, its fullscreen/window size, MIDI ports and whether MIDI/OSC are switched on.

The media is copied into the app's data folder (`%APPDATA%\org.salvation.livestudio\` on Windows, `~/Library/Application Support/org.salvation.livestudio/` on a Mac). Each file is checked against its SHA-256 hash, and a file that is already there with the same hash is skipped, so the second package copies only what changed. A damaged copy is reported and never replaces a good file.

## Cloud sync (Firebase)

Off by default: nothing is sent or fetched until the operator presses a button in **More → Cloud sync**.

### Setting up your Firebase project (once)

1. Create a Firebase project and switch it to the **Blaze** (pay-as-you-go) plan, which new Cloud Storage buckets need. Check Firebase's pricing page against the size of the show's media.
2. **Storage**: create the default bucket.
3. **Authentication → Sign-in method**: enable **Email/Password**. **Users → Add user**: one account for the show (for example `show@yourdomain`). Copy its **User UID**.
4. **Storage → Rules**: paste [firebase/storage.rules](../firebase/storage.rules) with `SHOW_ACCOUNT_UID` replaced by that UID, and publish. Only that account can then read or write; anyone else (even another signed-in account) is refused.
5. **Project settings → General → Your apps**: add a Web app and copy its config (`const firebaseConfig = {…}`).

### On each computer

More → Cloud sync: paste the config and press **Save keys**, then sign in with the show account. The app keeps the API key, project id, bucket and a sign-in token in `cloud.json` in its data folder (never in the show file, a package or the repository). The password is not stored. **Sign out** drops the token; **Forget keys** removes the file.

- **Push this version** (build computer): sends the show as the next version. Media goes up once per content (SHA-256), so a push after a small change uploads only the new or changed files. If the cloud has a version this computer has not taken in (the show computer pushed changes), the push is refused; sync first, or **Push anyway**.
- **Sync from cloud** (show computer): reads the cloud's latest version and opens the same review as a package (versions, conflicts, Merge or Replace). Media is downloaded only when missing or different, and every download is checked against its hash.
- While a scene is live, both buttons stay disabled until you tick "A scene is live on the wall. Sync or push anyway".

### What is in the bucket

```
shows/<showId>/latest.json         the current version (written last, so a half-finished push is never current)
shows/<showId>/v<n>/show.json      the show, as in a package
shows/<showId>/v<n>/manifest.json  the package manifest
media/<sha256>                     each media file once, by content
```

Firebase Storage alone holds everything (no Firestore): one service and one set of rules, and no document size limit for large show files. The app talks to the Firebase REST APIs from its native side (`src-tauri/src/cloud.rs`), streaming media between disk and network.

### Trying it without a project

`pnpm cloud:emulator` starts the Firebase Auth and Storage emulators with the rules above (Java 11+). In a development build, tick "Use the local Firebase emulators" when saving keys. Create the emulator account with the UID from the rules file:

```bash
curl -X POST "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-sls/accounts" -H "Authorization: Bearer owner" -H "Content-Type: application/json" -d '{"localId":"SHOW_ACCOUNT_UID","email":"show@test.local","password":"test-password"}'
```

## Build computer and show computer

- **The build computer runs a development build** (`pnpm tauri dev`) from this repository. Media in `public/media/…` is where it is made, so it always wins there: a package or sync never replaces or shadows it, and pushes and packages read it from `public/`. When an incoming file differs from the one in `public/`, the import says so and keeps `public/`.
- **The show computer runs the installed app** (a release build). Media from packages and the cloud is copied into its data folder and played from there; media that shipped inside the app is used only when there is no copy.

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
  "versionId": "ver_13ow5181lhu",
  "ancestry": ["ver_dtfztv1ykuh", "ver_15x94c2maf4", "ver_13ow5181lhu"],
  "createdAt": "2026-10-19T05:59:27.639Z",
  "from": "Mac",
  "units": { "scene:scene_3cz04nfpl9m": { "label": "1. Prologue 1 · …", "hash": "9f0c…" }, "order": { … }, "output": { … } },
  "files": [{ "key": "media/prologue/p1-push-in.mp4", "size": 10403589, "sha256": "0d5b…" }],
  "missing": []
}
```

An app that is older than the package's `formatVersion` refuses it and asks to be updated.

## How media is referenced

An asset (`src/core/types.ts`) can carry a portable `file` key (and `macFile` for its HEVC-alpha twin): a path relative to the show's media folder, which is the app data folder on the desktop. Library imports get `assets/<id>_<name>`; media that ships with the app keeps its `/media/…` URL and gets the matching key `media/…` when it arrives in a package. On load (`resolveAssetUrls` in `src/core/platform.ts`) the desktop app plays the local copy when it has one, and otherwise the URL (the bundled file); a development build plays `public/` first (see above). Absolute paths are never needed. Show files from before keys existed are migrated on load: an absolute library path from this computer, another Mac or a Windows PC becomes `assets/<file name>`.

New media that the build computer adds to `public/media/scenes/<Group>/` (for example re-rendered high-quality clips swapped in place) is picked up by the next package automatically, because export reads every asset the show references.

## Versions and conflicts

Every package and every cloud push is a **version**: a number for people ("v7", counted per computer) and a unique id. A version also lists the ids of the versions its content descends from (`ancestry`). The show file remembers in `project.lineage`:

- `showId`: the same show on every computer (made at the first export or push).
- `sent` / `received`: the last version this computer sent out and the last one it took in.
- `history`: the ids of the versions this computer's show descends from.
- `bases`: for each version this computer sent or took in, a content hash of every unit (each scene, the running order and groups, the wall/output settings, show control, timers, announcements, effect presets, sound levels, the show name).

Taking a version in finds the **merge base**: the newest version in its ancestry that this computer also has in `bases`. Then each unit compares three hashes: here, incoming and base. Here equals base: only the other side changed it, so it is taken. Incoming equals base: only this side changed it, so it is kept. Neither: a conflict. Without a shared version (a fresh install, another show) everything that differs is a conflict and **Replace** is the default.

Because the base is a version both sides really share, sending a version from the show computer (a package or a push) never hides its own edits from the next version that comes from the build computer, and the build computer merges the show computer's changes the same way. A version already in this computer's history is flagged ("This computer already has this version"). The asset library merges by adding: incoming asset definitions are added or updated, and nothing is deleted. The merge code is `src/core/showMerge.ts`.

A scene's hash covers its content (components, cues, camera, look, notes). Its thumbnail, running-order number and group are not part of it; order and groups are their own unit.

## For agents (MCP)

- `package_export {dir}`: write a package; returns version, file count, size and anything missing.
- `package_import {dir, dryRun: true}`: the plan (versions, conflicts with their keys and options, incoming and kept changes).
- `package_import {dir, choices: {"scene:scene_ab12": "both"}}` or `{resolve: "local"}`: apply. Without a choice for every conflict, nothing changes and the plan comes back. A live scene needs `allowLive: true` (ask the operator first).
- `cloud_status`: set up or not, the signed-in account, local versions, the cloud's shows and versions.
- `cloud_push {force?, allowLive?}`: push this show (refused, with the reason, when the cloud is ahead).
- `cloud_pull {dryRun | choices | resolve, mode?, showId?, allowLive?}`: the same as `package_import`, from the cloud.
- Keys and sign-in are only entered by the operator in the app.

## Code

- `src-tauri/src/package.rs`: streaming copy with SHA-256, export into `<name>.slshow.partial` and then swapped in, verified import, `hash_files` with a cache.
- `src-tauri/src/cloud.rs`: HTTPS to Firebase (ureq, rustls), streamed uploads and hash-checked downloads.
- `src/core/cloud.ts`: keys, sign-in and token refresh, push and pull.
- `src/ui/CloudSync.tsx`: the Cloud sync dialog. `firebase/`: the Storage rules and the emulator config.
- `src/core/showPackage.ts`: building the file list and the manifest, reading, planning and importing.
- `src/core/showMerge.ts`: units, hashes, the three-way plan and applying the choices.
- `src/engine/showTransfer.ts`: the operations the UI and the agent call (live guard, save, version stamp).
- `src/ui/ShowPackage.tsx`: the menu actions and the review dialog.

## Limits

- Packages and cloud sync run in the desktop app. The browser development build cannot copy media files.
- A package or push holds every asset in the library, used or not.
- Media referenced by a plain web URL stays a URL and needs the network on the show computer.
- Version numbers count per computer, so a package and a push from different computers can both be "v4"; the ids keep them apart.
