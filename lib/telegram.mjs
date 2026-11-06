// Telegram channel: a bot you own. Only sendMessage/editMessageText, so another program polling the
// same bot (for example an assistant bot) is unaffected. Credentials are read at call time and never
// logged: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or TELEGRAM_HOME_CHANNEL) from the environment or
// from notify.telegram.envFile (default <config>/telegram.env).
// TEAMS_BRIDGE_TG_DRY=1 prints instead of calling Telegram (tests); fake ids count up from 900000.
import { readFileSync, existsSync } from 'node:fs';
import { P, loadConfig, expandHome } from './core.mjs';

const DRY = !!process.env.TEAMS_BRIDGE_TG_DRY;
let dryId = 900000;
export const dryLog = [];

function env() {
  const out = { ...process.env }, cfg = loadConfig();
  const file = expandHome(cfg.notify?.telegram?.envFile || cfg.telegram?.envFile) || `${P.config}/telegram.env`;
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const chat = out.TELEGRAM_CHAT_ID || out.TELEGRAM_HOME_CHANNEL;
  return out.TELEGRAM_BOT_TOKEN && chat ? { token: out.TELEGRAM_BOT_TOKEN, chat } : null;
}
export const configured = () => DRY || !!env();

async function call(method, body) {
  const { token } = env();
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

// buttons: rows of URL buttons. Callback buttons are not used, so the bot's update stream stays free.
// Returns the reference needed to edit the message later: { chat, id }.
export async function send(html, { silent = false, buttons = null, replyTo = null } = {}) {
  if (DRY) { const id = ++dryId; dryLog.push({ op: 'send', messageId: id, html, silent, replyTo }); console.error(`[tg send ${id}${replyTo ? ` reply to ${replyTo}` : ''}]\n${html}\n`); return { chat: 'dry', id }; }
  const e = env();
  if (!e) throw new Error('telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  const body = { chat_id: e.chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) };
  let m;
  try { m = await call('sendMessage', { ...body, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) }); }
  catch (err) {
    // Telegram refuses URL buttons for some hosts (localhost); then the links go in the text.
    if (!buttons) throw err;
    m = await call('sendMessage', { ...body, text: `${html}\n${buttons.flat().map(b => b.url).join('\n')}` });
  }
  return { chat: String(e.chat), id: m.message_id };
}

export async function edit(ref, html) {
  if (DRY) { dryLog.push({ op: 'edit', messageId: ref.id, html }); console.error(`[tg edit ${ref.id}]\n${html}\n`); return; }
  if (!ref?.chat || !ref?.id || !env()) return;
  try { await call('editMessageText', { chat_id: ref.chat, message_id: ref.id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { if (!/not modified/.test(e.message)) throw e; }
}
