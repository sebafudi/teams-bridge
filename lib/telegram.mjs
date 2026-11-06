// Telegram notifications through a bot you own. Only sendMessage/editMessageText, so another program
// polling the same bot (for example an assistant bot) is unaffected. Credentials are read at call
// time and never logged: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or TELEGRAM_HOME_CHANNEL) from the
// environment, or from telegram.envFile (default <config>/telegram.env).
import { readFileSync, existsSync } from 'node:fs';
import { P, loadConfig, log, expandHome } from './core.mjs';

function env() {
  const out = { ...process.env };
  const file = expandHome(loadConfig().telegram?.envFile) || `${P.config}/telegram.env`;
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

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// buttons: rows of URL buttons, e.g. [[{ text, url }]]. Callback buttons are not used, so the bot's
// update stream stays free for other programs.
// TEAMS_BRIDGE_TG_DRY=1: print instead of calling Telegram (tests). Fake ids count up from 900000.
const DRY = !!process.env.TEAMS_BRIDGE_TG_DRY;
let dryId = 900000, warned = false;
export const dryLog = [];

// Without credentials this records nothing and returns null ids; callers keep working.
export async function send(html, { silent = false, buttons = null, replyTo = null } = {}) {
  if (DRY) { const messageId = ++dryId; dryLog.push({ op: 'send', messageId, html, silent, replyTo }); console.error(`[tg send ${messageId}${replyTo ? ` reply to ${replyTo}` : ''}]\n${html}\n`); return { chat: 'dry', messageId }; }
  const e = env();
  if (!e) { if (!warned) { warned = true; log('telegram not configured; notifications are recorded as events only'); } return { chat: null, messageId: null }; }
  const m = await call('sendMessage', { chat_id: e.chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });
  return { chat: String(e.chat), messageId: m.message_id };
}

export async function edit(chat, messageId, html) {
  if (DRY) { dryLog.push({ op: 'edit', messageId, html }); console.error(`[tg edit ${messageId}]\n${html}\n`); return; }
  if (!chat || !messageId || !env()) return;
  try { await call('editMessageText', { chat_id: chat, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { if (!/not modified/.test(e.message)) throw e; }
}
