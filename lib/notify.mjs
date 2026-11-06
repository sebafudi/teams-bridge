// Where notifications go. Messages are written once in simple HTML (b, i, s, code, blockquote) and
// delivered to every channel in notify.channels:
//   telegram  a bot you own (lib/telegram.mjs); edits the message in place (read, replies)
//   ntfy      push to the ntfy app (ntfy.sh or self-hosted); no edits
//   webhook   POST JSON to a URL (Slack/Discord/Home Assistant bridges, your own server)
//   command   run a program with the JSON on stdin (desktop notifications, anything else)
// Without notify.channels: telegram if it is configured, else none (notifications become events).
// webhook and command receive {event: "send"|"edit", ref, reply_to, text, html, silent, buttons};
// they may answer with JSON {"id": "..."}, which comes back as ref on later edits of that message.
import { spawn } from 'node:child_process';
import { loadConfig, log, htmlToText, expandHome } from './core.mjs';
import * as telegram from './telegram.mjs';

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const dryLog = telegram.dryLog;

const cfg = () => loadConfig().notify || {};
export function channels() {
  const c = cfg().channels;
  if (Array.isArray(c)) return c;
  return telegram.configured() ? ['telegram'] : [];
}
export const configured = () => channels().length > 0;

const plain = html => htmlToText(String(html).replace(/<blockquote>/g, '“').replace(/<\/blockquote>/g, '”'));
const withLinks = (text, buttons) => buttons ? `${text}\n${buttons.flat().map(b => `${b.text}: ${b.url}`).join('\n')}` : text;

function payload(event, html, { silent = false, buttons = null, ref = null, replyTo = null } = {}) {
  return { event, ref: ref?.id ?? null, reply_to: replyTo?.id ?? null, text: withLinks(plain(html), buttons), html, silent, buttons: buttons ? buttons.flat() : [] };
}

async function webhook(body) {
  const w = cfg().webhook || {};
  if (!w.url) throw new Error('webhook: notify.webhook.url not set');
  const r = await fetch(w.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(w.headers || {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`webhook ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return { id: j?.id ?? null };
}

function command(body) {
  const argv = cfg().command?.argv;
  if (!Array.isArray(argv) || !argv.length) return Promise.reject(new Error('command: notify.command.argv not set'));
  return new Promise((resolve, reject) => {
    const p = spawn(expandHome(argv[0]), argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 30e3);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`command exit ${code}: ${err.slice(0, 200)}`));
      let id = null; try { id = JSON.parse(out.trim().split('\n').pop() || '{}').id ?? null; } catch { }
      resolve({ id });
    });
    p.stdin.on('error', () => { }); p.stdin.end(JSON.stringify(body));
  });
}

async function ntfy(html, { silent, buttons }) {
  const n = cfg().ntfy || {};
  if (!n.topic) throw new Error('ntfy: notify.ntfy.topic not set');
  // JSON publishing keeps UTF-8 titles intact (HTTP headers would not).
  const [title, ...rest] = plain(html).split('\n');
  const body = { topic: n.topic, title: title.trim() || 'Teams', message: rest.join('\n').trim() || title, priority: silent ? 2 : (n.priority || 3), tags: ['speech_balloon'] };
  if (buttons?.[0]?.[0]) { body.click = buttons[0][0].url; body.actions = buttons.flat().slice(0, 3).map(b => ({ action: 'view', label: b.text, url: b.url })); }
  const r = await fetch((n.url || 'https://ntfy.sh').replace(/\/$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(n.token ? { Authorization: `Bearer ${n.token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
  return { id: (await r.json().catch(() => ({})))?.id ?? null };
}

// A handle is what the notifications table keeps (tg_chat, tg_message_id): tg_chat holds JSON with
// one reference per channel. Older rows hold a Telegram chat id and message id.
function refsOf(h) {
  if (!h?.chat) return {};
  try { const j = JSON.parse(h.chat); if (j && typeof j === 'object') return j; } catch { }
  return { telegram: { chat: h.chat, id: h.messageId } };
}

// Sends to every channel. Returns { chat, messageId } (store both; pass them back to edit/replyTo),
// or nulls when no channel is configured. Throws only when every configured channel failed.
export async function send(html, { silent = false, buttons = null, replyTo = null } = {}) {
  const chans = channels();
  if (!chans.length) return { chat: null, messageId: null };
  const parent = refsOf(replyTo), refs = {}, errors = [];
  for (const ch of chans) {
    try {
      if (ch === 'telegram') refs.telegram = await telegram.send(html, { silent, buttons, replyTo: parent.telegram?.id });
      else if (ch === 'ntfy') refs.ntfy = await ntfy(html, { silent, buttons });
      else if (ch === 'webhook') refs.webhook = await webhook(payload('send', html, { silent, buttons, replyTo: parent.webhook }));
      else if (ch === 'command') refs.command = await command(payload('send', html, { silent, buttons, replyTo: parent.command }));
      else throw new Error(`unknown channel ${ch} (telegram, ntfy, webhook, command)`);
    } catch (e) { errors.push(`${ch}: ${e.message}`); log('ERROR notify', ch, e.message); }
  }
  if (!Object.keys(refs).length) throw new Error(errors.join('; '));
  return { chat: JSON.stringify(refs), messageId: 1 };
}

// Updates an earlier message where the channel can (telegram, webhook, command; ntfy cannot).
export async function edit(chat, messageId, html) {
  const refs = refsOf({ chat, messageId });
  for (const [ch, ref] of Object.entries(refs)) {
    try {
      if (ch === 'telegram') await telegram.edit(ref, html);
      else if (ch === 'webhook') await webhook(payload('edit', html, { ref }));
      else if (ch === 'command') await command(payload('edit', html, { ref }));
    } catch (e) { log('ERROR notify edit', ch, e.message); }
  }
}
