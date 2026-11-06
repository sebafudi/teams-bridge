#!/usr/bin/env bash
# Install teams-bridge from this checkout.
# - copies the code to ~/.local/lib/teams-bridge (the running copy: edits in the checkout do not
#   affect the daemon until you install again) and links the CLI to ~/.local/bin/teams-bridge;
# - copies the default rules on first install (config, rules and state are otherwise never touched);
# - installs a user service: systemd on Linux, launchd on macOS (--no-service to skip).
# Node 24 or newer is required. TEAMS_BRIDGE_NODE sets the command, e.g. "mise exec node@24 -- node".
set -euo pipefail
src=$(cd "$(dirname "$0")" && pwd)
lib="$HOME/.local/lib/teams-bridge"
bindir="$HOME/.local/bin"
conf="${TEAMS_BRIDGE_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/teams-bridge}"
state="${TEAMS_BRIDGE_HOME:+$TEAMS_BRIDGE_HOME/state}"; state="${state:-${XDG_STATE_HOME:-$HOME/.local/state}/teams-bridge}"
service=1; [ "${1:-}" = --no-service ] && service=0

is24='process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)'
node_cmd="${TEAMS_BRIDGE_NODE:-}"
if [ -z "$node_cmd" ]; then
  if command -v node >/dev/null && node -e "$is24" 2>/dev/null; then node_cmd=$(command -v node)
  elif command -v mise >/dev/null; then node_cmd="$(command -v mise) exec node@24 -- node"
  else echo "Node 24 or newer is required (built-in node:sqlite and WebSocket). Install it or set TEAMS_BRIDGE_NODE." >&2; exit 1; fi
fi
$node_cmd -e "$is24" || { echo "$node_cmd: Node 24 or newer is required" >&2; exit 1; }

mkdir -p "$lib/bin" "$bindir" "$conf/rules.d" "$state"
chmod 700 "$conf" "$state"
rsync -a --delete "$src/lib/" "$lib/lib/"
install -m 755 "$src/bin/teams-bridge" "$lib/bin/teams-bridge"
{
  printf ': "${TEAMS_BRIDGE_NODE:=%s}"\n' "$node_cmd"
  printf 'export PATH="${PATH:+$PATH:}%s"\n' "$PATH"
  [ -n "${TEAMS_BRIDGE_HOME:-}" ] && printf ': "${TEAMS_BRIDGE_HOME:=%s}"; export TEAMS_BRIDGE_HOME\n' "$TEAMS_BRIDGE_HOME"
  true
} > "$lib/env"
ln -sfn "$lib/bin/teams-bridge" "$bindir/teams-bridge"
if ! ls "$conf/rules.d"/*.json >/dev/null 2>&1; then cp "$src"/rules.example/*.json "$conf/rules.d/"; echo "installed default rules in $conf/rules.d"; fi
case ":$PATH:" in *":$bindir:"*) ;; *) echo "note: add $bindir to your PATH" ;; esac

has_token=0; [ -f "$state/token.json" ] && has_token=1
if [ $service = 1 ] && [ "$(uname)" = Darwin ]; then
  label=io.github.sebafudi.teams-bridge plist="$HOME/Library/LaunchAgents/io.github.sebafudi.teams-bridge.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$lib/bin/teams-bridge</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$state/daemon.log</string>
  <key>StandardErrorPath</key><string>$state/daemon.log</string>
</dict></plist>
PLIST
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then launchctl kickstart -k "gui/$(id -u)/$label"; echo "restarted the launchd agent"
  elif [ $has_token = 1 ]; then launchctl bootstrap "gui/$(id -u)" "$plist"; echo "started the launchd agent (log: $state/daemon.log)"
  else echo "next: teams-bridge login, then: launchctl bootstrap gui/\$(id -u) $plist"; fi
elif [ $service = 1 ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/teams-bridge.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=teams-bridge: Microsoft Teams messages to rules, notifications and agents
After=network-online.target

[Service]
ExecStart=$lib/bin/teams-bridge daemon
Restart=always
RestartSec=30
MemoryMax=1500M

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  if systemctl --user is-active -q teams-bridge; then systemctl --user restart teams-bridge; echo "restarted teams-bridge.service"
  elif [ $has_token = 1 ]; then systemctl --user enable --now teams-bridge; echo "started teams-bridge.service"
  else echo "next: teams-bridge login, then: systemctl --user enable --now teams-bridge"; fi
elif [ $service = 1 ]; then
  echo "no systemd user session or launchd here: run 'teams-bridge daemon' under your own supervisor"
fi
echo "installed $lib"
