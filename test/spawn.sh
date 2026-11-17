#!/usr/bin/env bash
# Delayed spawn scenarios in a throwaway TEAMS_BRIDGE_HOME, with a fake t3. No model calls unless
# TEAMS_BRIDGE_TEST_LLM=1 (a few real calls through the configured model, as in offline.sh).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/teams-bridge-spawn.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/state" "$tmp/rules.d"
export TEAMS_BRIDGE_HOME="$tmp" TEAMS_BRIDGE_TG_DRY=1
${TEAMS_BRIDGE_NODE:-node} --no-warnings "$here/test/spawn.mjs" "$here/lib" 2>"$tmp/err.log" || { cat "$tmp/err.log"; exit 1; }
