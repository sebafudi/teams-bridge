#!/usr/bin/env node
// teams-bridge command channel: show notifications on this computer's desktop.
// macOS: Notification Center (osascript). Linux: notify-send. Edits are ignored.
// config.json: { "notify": { "channels": ["command"], "command": { "argv": ["node", "/path/to/examples/notify-desktop.mjs"] } } }
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const j = JSON.parse(readFileSync(0, 'utf8'));
if (j.event !== 'send') process.exit(0);
const [title, ...rest] = j.text.split('\n');
const body = rest.join('\n').trim();
if (process.platform === 'darwin') {
  const q = s => JSON.stringify(String(s).slice(0, 400));
  execFileSync('osascript', ['-e', `display notification ${q(body)} with title ${q(title)}${j.silent ? '' : ' sound name "default"'}`]);
} else {
  execFileSync('notify-send', ['--app-name=teams-bridge', ...(j.silent ? ['--urgency=low'] : []), title, body]);
}
