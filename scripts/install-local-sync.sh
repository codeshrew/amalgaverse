#!/bin/zsh
# Installs a launchd job that runs scripts/local-sync.sh at 12:20, 14:00, 18:00 and 22:00 local time.
# Remove with: launchctl bootout gui/$(id -u)/ai.amalgaverse.sync && rm ~/Library/LaunchAgents/ai.amalgaverse.sync.plist
set -euo pipefail
ROOT="${0:A:h:h}"
PLIST="$HOME/Library/LaunchAgents/ai.amalgaverse.sync.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.cache"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.amalgaverse.sync</string>
  <key>ProgramArguments</key><array><string>$ROOT/scripts/local-sync.sh</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>20</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$ROOT/.cache/local-sync.log</string>
  <key>StandardErrorPath</key><string>$ROOT/.cache/local-sync.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/ai.amalgaverse.sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $PLIST"
