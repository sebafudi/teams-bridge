#!/usr/bin/env bash
# Scenario tests in a throwaway TEAMS_BRIDGE_HOME with a fake token, the default rules and Telegram in
# dry-run mode. Nothing is sent to Teams or Telegram. A few real model calls are made through the
# Claude Code CLI.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/teams-bridge-test.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/state" "$tmp/rules.d"
cp "$here"/rules.example/*.json "$tmp/rules.d/"
echo '{ "owner": { "name": "Test Owner", "about": "backend developer" } }' > "$tmp/config.json"
export TEAMS_BRIDGE_HOME="$tmp" TEAMS_BRIDGE_TG_DRY=1
${TEAMS_BRIDGE_NODE:-node} --no-warnings "$here/test/offline.mjs" "$here/lib" 2>"$tmp/tg.log" || { cat "$tmp/tg.log"; exit 1; }
