#!/bin/bash
# Optional: keep the Sound service running in the background from login (restarted if it ever stops),
# so LiveStage's OSC and the backstage phones always find it. The operator window is opened separately
# (the LiveStage Sound app from make-app.sh, or http://localhost:1450).
#
#   bash sound/macos/install-launchagent.sh            install and start
#   bash sound/macos/install-launchagent.sh --remove   stop and remove
set -euo pipefail

LABEL="org.salvation.livestage-sound"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOGDIR="$HOME/Library/Logs/LiveStage Sound"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node is not on PATH: install Node 26 first" >&2; exit 1; fi
if [ ! -f "$REPO/sound/dist/index.html" ]; then
  echo "Building the screens first…"
  (cd "$REPO" && "$NODE" node_modules/vite/bin/vite.js build --config sound/ui/vite.config.ts --logLevel warn)
fi
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$REPO/sound/server/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGDIR/service.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/service.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: the Sound service now starts at login ($PLIST)"
echo "Logs: $LOGDIR/service.log"
