# Releases and app updates

The show computer runs the installed app, and it updates itself from the GitHub releases of [crownemmanuel/livestage](https://github.com/crownemmanuel/livestage/releases), but only when the operator says so.

```
build computer                 GitHub Actions                       show computer (installed app)
pnpm release 0.2.0     →      Release workflow                     More → Update to version 0.2.0…
git push origin HEAD v0.2.0   builds Windows + macOS,              → Install 0.2.0 and restart
                              signs the update files,                (only while the wall is on Standby)
                              publishes the release + latest.json
```

## On the show computer

- A few seconds after the installed app starts, and every six hours after, it asks GitHub whether a newer version is published. That is all it does by itself: it never downloads, installs or restarts on its own.
- When there is one, the **More** button gets a green dot and the menu reads **Update to version 0.2.0…**. Otherwise the same item is **Check for updates…**.
- The dialog shows this computer's version, the new version and its release notes. **Install 0.2.0 and restart** downloads the update (with progress), installs it and opens the new version. On Windows an installer window shows its progress for a moment.
- **It refuses while a scene is live.** Put the wall on Standby first. If a scene goes live while the update downloads, or you close the dialog, nothing is installed: the update waits, downloaded, for another press of Install.
- The audience output window closes with the app. Open it again with **Output** after the restart.
- The show file, the media library and every setting live in the app data folder (identifier `org.salvation.livestudio`), which an update does not touch. Never change the identifier in `tauri.conf.json`: the app would start with an empty data folder.
- Update on a rehearsal day, not in the hour before the doors open, and run the cue list once in the preview afterwards ([RECOVERY.md](RECOVERY.md), Before the show).

A development build (`pnpm tauri dev` on the build computer) can check for updates but never installs them: update it with git. An AI agent can do the same through `update_check` and, when the operator asks, `update_install` ([AGENT_CONTROL.md](AGENT_CONTROL.md)).

## Cutting a release

The version is kept in one place, `package.json`. `src-tauri/tauri.conf.json` reads it from there (`"version": "../package.json"`), and the release script keeps `src-tauri/Cargo.toml` and `Cargo.lock` equal to it. The release workflow refuses a tag that does not match.

1. Commit the work that goes into the release (on `main`).
2. Set the version, commit it and tag it:

   ```bash
   pnpm release 0.2.0
   ```

   `patch`, `minor` or `major` count up from the current version instead. The release notes the operator sees in the update dialog are the tag message: by default the commit subjects since the last release, or your own with `--notes "Fixes the lion's idle loop"`. `--dry-run` shows what would happen. The script only commits the three version files, so other uncommitted work in the checkout stays out of it. It pushes nothing.
3. Push the commit and the tag. This starts the build:

   ```bash
   git push origin HEAD v0.2.0
   ```

4. Watch it under **Actions → Release** on GitHub (about 20 to 40 minutes). The release stays a hidden draft until both builds have succeeded and `latest.json` lists Windows and macOS; then it is published, and installed apps see it at their next check (or straight away with **Check again**).

A version with a suffix, like `pnpm release 0.2.0-beta.1`, is published as a **pre-release**: apps never offer it, so it is the way to try an installer on the show computer by hand before everyone gets it.

If a build fails, the release stays a draft and no app sees it. Fix the problem and either re-run the failed job (Actions → the run → Re-run failed jobs), or cut a new patch version. **Actions → Release → Run workflow** rebuilds an existing tag whose release is still a draft. A published release is never rebuilt: cut a new version instead.

What a release contains:

| File | For |
| --- | --- |
| `Salvation.Live.Studio_<version>_x64-setup.exe` (+ `.sig`) | Windows installer, and the file the Windows app updates from |
| `Salvation.Live.Studio_<version>_aarch64.dmg` | macOS (Apple silicon) installer |
| `Salvation.Live.Studio_<version>_aarch64.app.tar.gz` (+ `.sig`) | The file the Mac app updates from |
| `latest.json` | What installed apps read: version, notes, download links and signatures |

Each installer is big (over 150 MB today, and growing with the media) because the release build carries `public/media` inside the app.

## One-time setup on GitHub

1. Create the repository **crownemmanuel/livestage** on GitHub. It must be **public**: installed apps download `latest.json` and the updates without signing in, and a private repository's releases are not reachable that way.
2. Push `main` to it.
3. Add the update signing key as two repository secrets (**Settings → Secrets and variables → Actions → New repository secret**):
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/salvation-live-studio.key` on the build computer (`pbcopy < ~/.tauri/salvation-live-studio.key` copies it).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the contents of `~/.tauri/salvation-live-studio.key.password` (`pbcopy < ~/.tauri/salvation-live-studio.key.password`).
4. Cut the first release (above), then install it on the show computer from the release page by hand. Copies installed before this version have no updater; from then on, updates come through the app.

GitHub Actions is free for public repositories; the workflow gives itself the permission to create releases (`contents: write`).

## The signing key

Every update is signed, and the app installs only files signed with the key whose public half is built into it (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). So nobody can push a fake update to the show computer, even through a hijacked download.

- The private key and its password are on the build computer in `~/.tauri/` (owner-only files) and in the two GitHub secrets. **Never commit them.** Keep a copy in a password manager: if the key is lost, installed apps can no longer take updates and have to be reinstalled by hand from a release made with a new key.
- To change keys: generate a new pair (`pnpm tauri signer generate -w ~/.tauri/new.key`), put the new public key in `tauri.conf.json`, release that version while the secrets still hold the old key, then switch the secrets to the new key for the releases after it.

## Building on this computer

- `pnpm build:installer`: an installer for this computer (`src-tauri/target/release/bundle/`), without update files, so no key is needed.
- `pnpm tauri build` makes the update files too, so it needs the key:

  ```bash
  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/salvation-live-studio.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/salvation-live-studio.key.password)" pnpm tauri build
  ```

## Unsigned installers

The installers are not code-signed with a Windows certificate or an Apple Developer ID yet (the update signature above is separate and always there):

- **Windows**: the first install may show "Windows protected your PC": **More info → Run anyway**. Updates installed from inside the app do not show it.
- **macOS**: after dragging the app to Applications, run once: `xattr -cr "/Applications/Salvation Live Studio.app"`.

Code signing can be added later without changing anything above: a Windows signing certificate (or Azure Trusted Signing) and an Apple Developer ID with notarization, each as more secrets for the workflow ([Tauri distribution guides](https://v2.tauri.app/distribute/)).

## How it fits together

- [.github/workflows/release.yml](../.github/workflows/release.yml): on a `v*` tag, checks the versions, creates a draft release with the tag message as notes, builds Windows x64 (NSIS) and macOS Apple silicon with `tauri-apps/tauri-action`, checks `latest.json`, publishes.
- [scripts/release.ts](../scripts/release.ts): `pnpm release` (set the version, commit, tag) and `--check` (CI).
- `src-tauri/tauri.conf.json`: `bundle.createUpdaterArtifacts`, `plugins.updater` (public key, the endpoint `https://github.com/crownemmanuel/livestage/releases/latest/download/latest.json`, Windows `installMode: passive`). `src-tauri/tauri.unsigned.conf.json` turns the update files off for `pnpm build:installer`.
- `src-tauri/capabilities/updater.json`: only the operator window may check, install and restart.
- [src/engine/updater.ts](../src/engine/updater.ts): the check, download, install and restart, and the live-scene guard. [src/ui/Updates.tsx](../src/ui/Updates.tsx): the dialog. The More menu item and the dot are in [src/ui/TopBar.tsx](../src/ui/TopBar.tsx).
