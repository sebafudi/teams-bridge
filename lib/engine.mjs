// Ingest pushes and catch-up results, evaluate rules, and run the notification lifecycle.
import { db, addEvent, loadConfig, log, kvGet, kvSet, norm, htmlToText, expandHome, locale } from './core.mjs';
import { normalizeMessage, isHumanMessage, horizonId, myMri, getConversation, getThread, listConversations, listMessages, convKind } from './teams.mjs';
import { loadRules, matchReason, verdictFires } from './rules.mjs';
import { classify, summarize, assessReplies } from './llm.mjs';
import * as notifier from './notify.mjs';
import { spawn as spawnProc } from 'node:child_process';
import { startSession, forwardToSessions, buildPrompt } from './spawn.mjs';
import { buildContext, convInfo } from './context.mjs';

// ---------- conversations ----------

function upsertConv(id, fields) {
  const d = db();
  d.prepare('INSERT INTO convs (id, updated_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(id, Date.now());
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) d.prepare(`UPDATE convs SET ${k} = ?, updated_at = ? WHERE id = ?`).run(v, Date.now(), id);
}
export const getConv = id => db().prepare('SELECT * FROM convs WHERE id = ?').get(id);

// Title lookup: DMs are named after the other person; others fetched once from the chat service.
async function ensureTitle(conv, kind, msg) {
  const c = getConv(conv);
  if (c?.title && (kind !== 'dm' || c.title !== 'DM')) return c.title;
  if (kind === 'self') { upsertConv(conv, { title: 'Notes (yourself)', kind }); return 'Notes (yourself)'; }
  if (kind === 'dm') {
    const other = msg && !msg.fromMe ? msg.senderName : db().prepare("SELECT sender_name FROM messages WHERE conv = ? AND from_me = 0 AND sender_name != '' ORDER BY ts DESC LIMIT 1").get(conv)?.sender_name;
    if (other) { upsertConv(conv, { title: other, kind }); return other; }
  }
  if (!c?.title_checked) {
    upsertConv(conv, { title_checked: 1 });
    try {
      const t = kind === 'dm' ? null : await getThread(conv).catch(() => getConversation(conv));
      const topic = t?.properties?.topic || t?.threadProperties?.topic;
      let title = topic;
      if (!title && t?.members) {
        const names = t.members.filter(m => m.id !== myMri()).map(m => m.friendlyName || m.userDisplayName).filter(Boolean);
        if (names.length) title = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
      }
      if (title) { upsertConv(conv, { title, kind }); return title; }
    } catch (e) { log('title lookup failed', conv.slice(0, 30), e.message); }
  }
  const fallback = msg?.threadTopic || (kind === 'dm' ? 'DM' : kind);
  upsertConv(conv, { title: c?.title || fallback, kind });
  return c?.title || fallback;
}

// ---------- read markers ----------

export function setMyHorizon(conv, horizon, source = 'push') {
  const id = horizonId(horizon);
  if (!id) return;
  const c = getConv(conv);
  if (c && c.my_horizon >= id) return;
  upsertConv(conv, { my_horizon: id, my_horizon_at: Date.now() });
  // The first marker seen for a conversation is a starting point, not news.
  if (c?.my_horizon || source !== 'catchup') addEvent('read', { conv, msgId: String(id), data: { source } });
}

function setMemberHorizon(conv, user, horizon) {
  const id = horizonId(horizon);
  if (!id || user === myMri()) return;
  db().prepare('INSERT INTO member_reads (conv, user_mri, horizon, at) VALUES (?, ?, ?, ?) ON CONFLICT(conv, user_mri) DO UPDATE SET horizon = max(horizon, excluded.horizon), at = excluded.at')
    .run(conv, user, id, Date.now());
  addEvent('member_read', { conv, msgId: String(id), data: { user } });
}

// ---------- messages ----------

const ruleQueue = [];
let ruleWorker = null;

export async function ingestMessage(resource, { source = 'push', notifyOk = true } = {}) {
  const me = myMri();
  if (resource.messagetype === 'ThreadActivity/MemberConsumptionHorizonUpdate') {
    try { const c = JSON.parse(resource.content); const conv = (resource.conversationLink || '').split('/').pop().split(';')[0]; setMemberHorizon(conv, c.user, c.consumptionhorizon); } catch { }
    return;
  }
  if (!isHumanMessage(resource.messagetype)) {
    if (!/^Control\//.test(resource.messagetype || '')) addEvent('system', { conv: (resource.conversationLink || '').split('/').pop().split(';')[0], msgId: String(resource.id), data: { messagetype: resource.messagetype } });
    return;
  }
  const m = normalizeMessage(resource, me);
  if (!m.conv) return;
  const d = db();
  const prev = d.prepare('SELECT version, deleted FROM messages WHERE conv = ? AND id = ?').get(m.conv, m.id);
  if (prev && prev.version === m.version) return; // duplicate push or catch-up overlap
  const isEdit = !!prev || m.edited;
  d.prepare(`INSERT INTO messages (conv, id, ts, version, sender_mri, sender_name, kind, messagetype, importance, subject, text, mentions_me, from_me, edited, deleted, reply_to, source, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(conv, id) DO UPDATE SET version=excluded.version, text=excluded.text, edited=excluded.edited, deleted=excluded.deleted, importance=excluded.importance, subject=excluded.subject, raw=excluded.raw`)
    .run(m.conv, m.id, m.ts, m.version, m.senderMri, m.senderName, m.kind, m.messagetype, m.importance, m.subject, m.text, m.mentionsMe ? 1 : 0, m.fromMe ? 1 : 0, isEdit ? 1 : 0, m.deleted ? 1 : 0, m.replyTo, source, JSON.stringify(resource));
  if (!m.fromMe && /^8:orgid:/.test(m.senderMri) && m.senderName)
    d.prepare('INSERT INTO people (mri, name, name_norm, last_seen, seen_in) VALUES (?,?,?,?,?) ON CONFLICT(mri) DO UPDATE SET name = excluded.name, name_norm = excluded.name_norm, last_seen = max(last_seen, excluded.last_seen), seen_in = excluded.seen_in')
      .run(m.senderMri, m.senderName, norm(m.senderName), m.ts, m.conv);
  const c = getConv(m.conv);
  if (!c || Number(m.id) > (c.last_msg || 0)) upsertConv(m.conv, { last_msg: Number(m.id), kind: m.kind });
  if (m.fromMe) setMyHorizon(m.conv, m.id, 'own message'); // sending means you have seen the chat up to here
  m.convTitle = await ensureTitle(m.conv, m.kind, m);
  addEvent(m.deleted ? 'message_deleted' : isEdit ? 'message_edited' : 'message', { conv: m.conv, msgId: m.id, data: publicMessage(m, source) });
  log(m.deleted ? 'deleted' : isEdit ? 'edited' : 'message', m.kind, `[${m.convTitle}]`, m.fromMe ? '(own)' : '', source === 'push' ? '' : source);
  if (!isEdit && !m.deleted) {
    ruleQueue.push({ m, notifyOk });
    pumpRules();
    if (notifyOk && source !== 'backfill') {
      try { noteReply(m); } catch (e) { log('ERROR noteReply', e.message); }
      forwardToSessions(m);
    }
  }
}

const publicMessage = (m, source) => ({ conv_title: m.convTitle, kind: m.kind, sender: m.senderName, sender_mri: m.senderMri, ts: m.ts, text: m.text, subject: m.subject || undefined, mentions_me: m.mentionsMe, importance: m.importance || undefined, from_me: m.fromMe, source });

function pumpRules() {
  if (ruleWorker) return;
  ruleWorker = (async () => {
    while (ruleQueue.length) {
      const job = ruleQueue.shift();
      try { await evaluate(job.m, job.notifyOk); } catch (e) { log('ERROR rules', e.message); }
    }
    ruleWorker = null;
  })();
}

export async function verdictFor(rule, m, { allowLlm = true, bucket = 'live' } = {}) {
  const d = db();
  const cached = d.prepare('SELECT * FROM verdicts WHERE rule_key = ? AND conv = ? AND msg_id = ?').get(rule._key, m.conv, m.id);
  if (cached) return { label: cached.label, confidence: cached.confidence, reason: cached.reason, cached: true };
  if (!allowLlm) return null;
  const v = await classify(rule, await buildContext(m, { n: rule.classify.context_messages ?? 6 }), { bucket });
  d.prepare('INSERT OR REPLACE INTO verdicts (rule_key, conv, msg_id, fire, label, confidence, reason, at) VALUES (?,?,?,?,?,?,?,?)')
    .run(rule._key, m.conv, m.id, verdictFires(rule, v) ? 1 : 0, v.label, v.confidence, v.reason, Date.now());
  return v;
}

async function evaluate(m, notifyOk) {
  const { rules } = loadRules();
  for (const rule of rules) {
    if (matchReason(rule, m)) continue;
    let verdict = null;
    if (rule.classify) {
      let err = null;
      try { verdict = await verdictFor(rule, m); } catch (e) { err = e; }
      if (err && !/budget exhausted/.test(err.message)) { // one retry for timeouts and CLI hiccups
        await new Promise(r => setTimeout(r, 20e3));
        try { verdict = await verdictFor(rule, m); err = null; } catch (e) { err = e; }
      }
      if (err) {
        log('ERROR classify', rule.id, err.message);
        addEvent('error', { conv: m.conv, msgId: m.id, rule: rule.id, data: { error: err.message } });
        // Fail safe: without a verdict, still run plain notify actions (marked unclassified), never spawn/exec.
        if ((rule.classify.on_error || 'notify') !== 'notify' || !notifyOk) continue;
        addEvent('rule_match', { conv: m.conv, msgId: m.id, rule: rule.id, data: { unclassified: true, conv_title: m.convTitle, sender: m.senderName } });
        for (const a of rule.actions) if (a.type === 'notify' && !a.when_label) queueNotification(m, { id: `${rule.id}?` }, a);
        continue;
      }
      if (!verdictFires(rule, verdict)) continue;
    }
    addEvent('rule_match', { conv: m.conv, msgId: m.id, rule: rule.id, data: { verdict, conv_title: m.convTitle, sender: m.senderName } });
    log('rule_match', rule.id, `[${m.convTitle}]`, verdict ? `${verdict.label} ${verdict.confidence}` : '');
    for (const [i, a] of rule.actions.entries()) {
      // when_label: run this action only for some classifier labels (one model call, several branches).
      if (a.when_label && !(verdict && [].concat(a.when_label).includes(verdict.label))) continue;
      if (a.type === 'notify' && notifyOk) queueNotification(m, rule, a);
      if ((a.type === 'spawn' || a.type === 'exec') && notifyOk) runAction(rule, i, a, m, verdict);
    }
  }
}

// ---------- reactions: start an agent or run a command ----------

function actionBudgetOk(rule, i, max) {
  const k = `action_rate:${rule.id}:${i}`, hour = new Date().toISOString().slice(0, 13);
  const b = kvGet(k, { hour, n: 0 });
  if (b.hour !== hour) { b.hour = hour; b.n = 0; }
  if (b.n >= max) return false;
  b.n++; kvSet(k, b); return true;
}

function eventPayload(m, rule, verdict) {
  return { rule: rule.id, conv: m.conv, conv_title: m.convTitle, conv_kind: m.kind, msg_id: m.id, ts: m.ts, sender: m.senderName, sender_mri: m.senderMri, text: m.text, mentions_me: m.mentionsMe, importance: m.importance || undefined, verdict: verdict || undefined };
}

function runAction(rule, i, a, m, verdict) {
  const max = a.max_per_hour ?? (a.type === 'spawn' ? 4 : 30);
  if (!actionBudgetOk(rule, i, max)) { addEvent('action_skipped', { conv: m.conv, msgId: m.id, rule: rule.id, data: { type: a.type, reason: `max_per_hour ${max}` } }); return; }
  const payload = eventPayload(m, rule, verdict);
  if (a.type === 'spawn') {
    startSession(rule, i, a, m, payload).catch(e => {
      log('ERROR spawn', rule.id, e.message);
      addEvent('action_failed', { conv: m.conv, msgId: m.id, rule: rule.id, data: { type: 'spawn', via: a.via || loadConfig().spawn?.defaultVia, error: e.message.slice(0, 300) } });
    });
    return;
  }
  runExec(rule, a, m, payload).catch(e => {
    log('ERROR exec action', rule.id, e.message);
    addEvent('action_failed', { conv: m.conv, msgId: m.id, rule: rule.id, data: { type: 'exec', error: e.message.slice(0, 300) } });
  });
}

// exec: argv (no shell). stdin is the event JSON; with a "prompt" the JSON also carries the full agent
// prompt (the action's prompt, the safety rules and the chat context), and stdin: "prompt" sends
// only that text, so a CLI agent can read it directly (e.g. ["claude", "-p"], ["codex", "exec", "-"]).
async function runExec(rule, a, m, payload) {
  const prompt = a.prompt ? await buildPrompt(a, rule, payload, m) : null;
  const input = a.stdin === 'prompt' ? prompt : JSON.stringify(prompt ? { ...payload, prompt } : payload) + '\n';
  const [cmd, ...args] = a.command;
  const p = spawnProc(cmd, args, { cwd: a.cwd ? expandHome(a.cwd) : undefined, stdio: ['pipe', a.output === 'notify' ? 'pipe' : 'ignore', 'pipe'], env: { ...process.env, TEAMS_BRIDGE_RULE: rule.id, TEAMS_BRIDGE_CONV: m.conv, TEAMS_BRIDGE_MSG: String(m.id) } });
  let err = '', out = '';
  const timer = setTimeout(() => p.kill('SIGKILL'), (a.timeout_sec || 60) * 1000);
  p.stderr.on('data', d => { if (err.length < 500) err += d; });
  p.stdout?.on('data', d => { if (out.length < 20000) out += d; });
  p.on('error', e => { err += e.message; });
  p.on('close', code => {
    clearTimeout(timer);
    addEvent(code === 0 ? 'action_exec' : 'action_failed', { conv: m.conv, msgId: m.id, rule: rule.id, data: { type: 'exec', exit: code, stderr: err.slice(0, 300) || undefined } });
    if (code !== 0) log('ERROR exec action', rule.id, code, err.slice(0, 200));
    // output: "notify" sends what the command printed (e.g. an agent's findings) as a silent notification.
    if (code === 0 && a.output === 'notify' && out.trim())
      notifier.send(`🤖 <b>${notifier.esc(rule.id)}</b> · ${notifier.esc(m.convTitle || '')}\n\n${notifier.esc(out.trim().slice(0, 3500))}`, { silent: true }).catch(e => log('ERROR notify', e.message));
  });
  p.stdin.on('error', () => { });
  p.stdin.end(input);
}

// ---------- notifications ----------

function queueNotification(m, rule, action) {
  const { notify } = loadConfig();
  const d = db();
  const open = d.prepare("SELECT * FROM notifications WHERE conv = ? AND state = 'pending' ORDER BY id DESC LIMIT 1").get(m.conv);
  if (open) {
    const ids = [...new Set([...JSON.parse(open.msg_ids), m.id])];
    const rules = [...new Set([...JSON.parse(open.rules), rule.id])];
    d.prepare('UPDATE notifications SET last_msg = ?, msg_ids = ?, rules = ? WHERE id = ?').run(m.id, JSON.stringify(ids), JSON.stringify(rules), open.id);
    return;
  }
  const delay = (action.delay_minutes ?? notify.delayMinutes) * 60e3;
  d.prepare("INSERT INTO notifications (conv, first_msg, last_msg, msg_ids, rules, state, due_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
    .run(m.conv, m.id, m.id, JSON.stringify([m.id]), JSON.stringify([rule.id]), Date.now() + delay);
}

const hhmm = ts => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const KIND_LABEL = { dm: 'direct message', group: 'group chat', channel: 'channel', meeting: 'meeting chat', self: 'your notes', other: 'chat' };

function renderPending(c, unread, summary, n, unclassified = false) {
  const first = unread[0];
  const senders = [...new Set(unread.map(u => u.sender_name).filter(Boolean))].join(', ');
  const head = `💬 <b>${notifier.esc(c.title || 'Teams')}</b> · ${KIND_LABEL[c.kind] || 'chat'}`;
  const who = c.kind === 'dm' ? '' : `\nFrom: ${notifier.esc(senders)}`;
  const mention = unread.some(u => u.mentions_me) ? ' · you were @mentioned' : '';
  // No model summary (plain mode, budget, timeout): quote the newest message so the problem is still visible.
  const last = unread[unread.length - 1];
  const raw = (last.text || '').replace(/\s+/g, ' ').trim();
  const quote = raw ? `${c.kind === 'dm' || unread.length === 1 ? '' : `${last.sender_name}: `}${raw.length > 280 ? raw.slice(0, 279) + '…' : raw}` : '';
  const body = summary ? notifier.esc(summary) : quote ? `<blockquote>${notifier.esc(quote)}</blockquote>` : '';
  return `${head}${who}\n${body ? body + '\n' : ''}${unclassified ? '<i>Sent unfiltered: the model check was unavailable, so this may not need you.</i>\n' : ''}<i>${n} unread · waiting for you since ${hhmm(first.ts)}${mention}</i>`;
}
const VERDICT_LINE = {
  resolved: '✅ <b>Looks handled</b>, probably nothing needed from you',
  still_needs_you: '👀 <b>Still needs you</b>',
  check_reply: '⚠️ <b>Check the reply</b>',
  unclear: '❔ <b>Not sure</b> whether that settles it',
};
// Replies minus messages that joined the notification itself (a second person asking the owner too).
const repliesOf = n => { const ids = JSON.parse(n.msg_ids || '[]'); return (n.replies ? JSON.parse(n.replies) : []).filter(r => !ids.includes(r.id)); };
function replyBlock(n) {
  const replies = repliesOf(n);
  if (!replies.length) return '';
  const names = [...new Set(replies.map(r => r.sender))];
  const last = replies[replies.length - 1];
  let out = `\n\n↪ ${notifier.esc(names.join(', '))} replied (${replies.length}, last ${hhmm(last.ts)})`;
  const v = n.reply_verdict ? JSON.parse(n.reply_verdict) : null;
  if (v) out += `\n${VERDICT_LINE[v.verdict] || VERDICT_LINE.unclear}${v.note ? `: ${notifier.esc(v.note)}` : ''}`;
  return out;
}
const renderRead = (n, at) => `✅ <s>${n.text.replace(/\n<i>[^\n]*<\/i>$/, '').replace(/<\/?blockquote>/g, '')}</s>\n<i>read in Teams at ${hhmm(at)}</i>${replyBlock(n)}`;
const renderSent = n => `${n.text}${replyBlock(n)}`;

// Someone other than the people the owner was notified about answered in the same chat (or thread).
function threadRoot(row) { return row ? String(row.reply_to || row.id) : null; }
function noteReply(m) {
  if (m.fromMe) return;
  const d = db();
  for (const n of d.prepare("SELECT * FROM notifications WHERE conv = ? AND state IN ('pending', 'sent')").all(m.conv)) {
    if (Number(m.id) <= Number(n.first_msg)) continue;
    const ids = JSON.parse(n.msg_ids);
    const notified = d.prepare(`SELECT * FROM messages WHERE conv = ? AND id IN (${ids.map(() => '?').join(',')})`).all(m.conv, ...ids);
    if (notified.some(x => x.sender_mri === m.senderMri)) continue; // the asker adding more is not a reply
    if (m.kind === 'channel') {
      const roots = new Set(notified.map(threadRoot));
      if (!roots.has(String(m.replyTo || m.id))) continue;
    }
    const replies = n.replies ? JSON.parse(n.replies) : [];
    replies.push({ id: m.id, sender: m.senderName, mri: m.senderMri, ts: m.ts });
    d.prepare('UPDATE notifications SET replies = ?, reply_due = ? WHERE id = ?').run(JSON.stringify(replies), Date.now() + 60e3, n.id);
    addEvent('notify_reply', { conv: m.conv, msgId: m.id, data: { notification: n.id, sender: m.senderName } });
  }
}

async function assessFor(n, c) {
  const d = db();
  const ids = JSON.parse(n.msg_ids), replies = repliesOf(n);
  if (!replies.length) { d.prepare('UPDATE notifications SET reply_due = NULL WHERE id = ?').run(n.id); return null; }
  const asked = d.prepare(`SELECT * FROM messages WHERE conv = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY ts`).all(n.conv, ...ids);
  const rep = d.prepare(`SELECT * FROM messages WHERE conv = ? AND id IN (${replies.map(() => '?').join(',')}) ORDER BY ts`).all(n.conv, ...replies.map(r => r.id));
  const info = await convInfo(n.conv);
  const header = `Conversation: ${c.title} (${info.team ? `channel in team "${info.team}"` : c.kind})`;
  const v = await assessReplies(header, asked, rep);
  d.prepare('UPDATE notifications SET reply_verdict = ?, reply_due = NULL WHERE id = ?').run(JSON.stringify(v), n.id);
  addEvent('notify_reply_assessed', { conv: n.conv, data: { notification: n.id, ...v } });
  return v;
}

export async function composeNotification(c, unread, { unclassified = false } = {}) {
  let summary = '';
  if (loadConfig().notify.summary === 'llm') {
    try {
      const info = await convInfo(c.id);
      const header = `Conversation: ${c.title} (${c.kind}${info.team ? `, channel in team "${info.team}"` : ''})${info.memberCount ? `, ${info.memberCount} members` : ''}`;
      summary = await summarize(header, unread.slice(-12));
    } catch (e) { log('ERROR summary', e.message); }
  }
  return renderPending(c, unread, summary, unread.length, unclassified);
}

function rateOk() {
  const { notify } = loadConfig();
  const n = db().prepare('SELECT count(*) n FROM notifications WHERE sent_at > ?').get(Date.now() - 3600e3).n;
  return n < notify.maxPerHour;
}

export async function processNotifications() {
  const cfg = loadConfig();
  const d = db();
  const now = Date.now();
  // Due: send, or drop when already read elsewhere.
  for (const n of d.prepare("SELECT * FROM notifications WHERE state = 'pending' AND due_at <= ?").all(now)) {
    const c = getConv(n.conv) || { title: n.conv, kind: 'other', my_horizon: 0 };
    if ((c.my_horizon || 0) >= Number(n.last_msg)) {
      d.prepare("UPDATE notifications SET state = 'read_before_notify', closed_at = ? WHERE id = ?").run(now, n.id);
      addEvent('notify_skipped', { conv: n.conv, msgId: n.last_msg, data: { reason: 'read elsewhere before the delay ended' } });
      continue;
    }
    if (cfg.paused) { d.prepare("UPDATE notifications SET state = 'paused', closed_at = ? WHERE id = ?").run(now, n.id); continue; }
    if (!rateOk()) { d.prepare("UPDATE notifications SET state = 'rate_limited', closed_at = ? WHERE id = ?").run(now, n.id); addEvent('notify_skipped', { conv: n.conv, data: { reason: 'rate limit' } }); continue; }
    const unread = d.prepare('SELECT * FROM messages WHERE conv = ? AND CAST(id AS INTEGER) > ? AND from_me = 0 AND deleted = 0 ORDER BY ts').all(n.conv, c.my_horizon || 0);
    if (!unread.length) { d.prepare("UPDATE notifications SET state = 'read_before_notify', closed_at = ? WHERE id = ?").run(now, n.id); continue; }
    // Unfiltered only when every rule behind it lacked a verdict ("rule?" ids).
    const text = await composeNotification(c, unread, { unclassified: JSON.parse(n.rules).every(r => r.endsWith('?')) });
    if (repliesOf(n).length) { try { await assessFor(n, c); } catch (e) { log('ERROR assess', e.message); } }
    try {
      const fresh = { ...d.prepare('SELECT * FROM notifications WHERE id = ?').get(n.id), text };
      const r = await notifier.send(renderSent(fresh));
      // Without a channel the notification is only an event (with its text) for subscribed agents.
      d.prepare("UPDATE notifications SET state = ?, sent_at = ?, tg_chat = ?, tg_message_id = ?, text = ? WHERE id = ?").run(r.messageId ? 'sent' : 'recorded', now, r.chat, r.messageId, text, n.id);
      addEvent('notify_sent', { conv: n.conv, msgId: n.last_msg, data: { rules: JSON.parse(n.rules), unread: unread.length, ...(r.messageId ? {} : { channel: 'events', text: htmlToText(text) }) } });
      log('notified', c.title, unread.length, 'unread');
    } catch (e) {
      log('ERROR notify', e.message);
      d.prepare('UPDATE notifications SET due_at = ? WHERE id = ?').run(now + 120e3, n.id);
    }
  }
  // Sent, and others replied since: assess and edit the message (silent), ping only for check_reply.
  for (const n of d.prepare("SELECT * FROM notifications WHERE state = 'sent' AND reply_due IS NOT NULL AND reply_due <= ?").all(now)) {
    const c = getConv(n.conv) || { title: n.conv, kind: 'other' };
    try {
      const v = await assessFor(n, c);
      if (!v) continue;
      const fresh = d.prepare('SELECT * FROM notifications WHERE id = ?').get(n.id);
      await notifier.edit(n.tg_chat, n.tg_message_id, renderSent(fresh));
      if (v.verdict === 'check_reply' && n.tg_message_id)
        await notifier.send(`⚠️ A reply in <b>${notifier.esc(c.title)}</b> may need you: ${notifier.esc(v.note)}`, { replyTo: { chat: n.tg_chat, messageId: n.tg_message_id } });
      log('reply assessed', c.title, v.verdict);
    } catch (e) { log('ERROR reply update', e.message); d.prepare('UPDATE notifications SET reply_due = ? WHERE id = ?').run(now + 120e3, n.id); }
  }
  // Sent: mark as read once the owner's read marker passes the newest notified message.
  if (cfg.notify.editOnRead) {
    for (const n of d.prepare("SELECT * FROM notifications WHERE state = 'sent'").all()) {
      const c = getConv(n.conv);
      if (!c || (c.my_horizon || 0) < Number(n.last_msg)) {
        if (now - n.sent_at > 7 * 86400e3) d.prepare("UPDATE notifications SET state = 'expired', closed_at = ? WHERE id = ?").run(now, n.id);
        continue;
      }
      try {
        await notifier.edit(n.tg_chat, n.tg_message_id, renderRead(n, c.my_horizon_at || now));
        d.prepare("UPDATE notifications SET state = 'read', closed_at = ? WHERE id = ?").run(now, n.id);
        addEvent('notify_read', { conv: n.conv, msgId: n.last_msg });
      } catch (e) { log('ERROR notify edit', e.message); }
    }
  }
}

// ---------- pushes ----------

export async function handlePush(path, bodyText) {
  if (path !== 'messaging') return;
  let b; try { b = JSON.parse(bodyText); } catch { return; }
  const r = b.resource || {};
  switch (b.resourceType) {
    case 'NewMessage':
    case 'MessageUpdate':
      return ingestMessage(r, { source: 'push' });
    case 'ConversationUpdate': {
      const conv = String(r.id || '').split(';')[0];
      if (r.properties?.consumptionhorizon) setMyHorizon(conv, r.properties.consumptionhorizon, 'push');
      if (r.threadProperties?.topic) upsertConv(conv, { title: r.threadProperties.topic, kind: convKind(conv, r.threadProperties.threadType) });
      return;
    }
    case 'ThreadUpdate':
      if (r.properties?.topic) upsertConv(r.id, { title: r.properties.topic });
      return;
    default:
      return;
  }
}

// ---------- catch-up after missed pushes ----------

let catchupRunning = false;
export async function catchUp({ reason = 'message_loss', force = false } = {}) {
  const cfg = loadConfig();
  const last = kvGet('last_catchup', 0);
  if (catchupRunning || (!force && Date.now() - last < cfg.catchup.minIntervalMinutes * 60e3)) return { skipped: true };
  catchupRunning = true; kvSet('last_catchup', Date.now());
  const firstRun = !kvGet('baseline_done', false);
  let fetched = 0, convs = 0;
  try {
    const list = await listConversations(40);
    for (const c of list.conversations || []) {
      const id = c.id, kind = convKind(id, c.threadProperties?.threadType);
      if (c.threadProperties?.topic) upsertConv(id, { title: c.threadProperties.topic, kind });
      else upsertConv(id, { kind });
      const lmFrom = (c.lastMessage?.from || '').split('/').pop();
      if (kind === 'dm' && lmFrom && lmFrom !== myMri() && c.lastMessage?.imdisplayname && (!getConv(id)?.title || getConv(id).title === 'DM'))
        upsertConv(id, { title: c.lastMessage.imdisplayname });
      if (c.properties?.consumptionhorizon) setMyHorizon(id, c.properties.consumptionhorizon, 'catchup');
      const lastId = Number(c.lastMessage?.id || 0);
      const known = getConv(id)?.last_msg || 0;
      if (!lastId || lastId <= known) continue;
      if (firstRun) { upsertConv(id, { last_msg: lastId }); continue; } // baseline: do not replay history
      const since = Math.max(known, Date.now() - cfg.catchup.maxAgeHours * 3600e3);
      if (lastId < since) { upsertConv(id, { last_msg: lastId }); continue; }
      convs++;
      const page = await listMessages(id, { pageSize: 30, startTime: since });
      for (const msg of (page.messages || []).reverse()) {
        if (Number(msg.id) <= known) continue;
        msg.conversationLink ||= `/conversations/${id}`;
        fetched++;
        await ingestMessage(msg, { source: 'catchup' });
      }
    }
    if (firstRun) kvSet('baseline_done', true);
    addEvent('catchup', { data: { reason, convs, fetched, baseline: firstRun } });
    log('catchup', reason, firstRun ? 'baseline' : `${convs} conversations, ${fetched} messages`);
    return { convs, fetched, baseline: firstRun };
  } catch (e) {
    log('ERROR catchup', e.message);
    addEvent('error', { data: { where: 'catchup', error: e.message } });
    return { error: e.message };
  } finally { catchupRunning = false; }
}

// ---------- retention ----------
// Raw push bodies are only for debugging; message text and metadata stay. Old bookkeeping events go.
export function prune({ rawDays = 30, eventDays = 90 } = {}) {
  const d = db(), now = Date.now();
  const raw = d.prepare('UPDATE messages SET raw = NULL WHERE raw IS NOT NULL AND ts < ?').run(now - rawDays * 86400e3).changes;
  const ev = d.prepare("DELETE FROM events WHERE at < ? AND kind NOT IN ('message', 'message_edited', 'message_deleted', 'rule_match')").run(new Date(now - eventDays * 86400e3).toISOString()).changes;
  const verd = d.prepare('DELETE FROM verdicts WHERE at < ?').run(now - eventDays * 86400e3).changes;
  if (raw || ev || verd) log('pruned', `raw ${raw}`, `events ${ev}`, `verdicts ${verd}`);
  return { raw, events: ev, verdicts: verd };
}

// ---------- backfill (one-off, read-only, never notifies or spawns) ----------
export async function backfill({ days = 14, maxConvs = 40, perConv = 50 } = {}) {
  const since = Date.now() - days * 86400e3;
  const list = await listConversations(maxConvs);
  let convs = 0, msgs = 0;
  for (const c of list.conversations || []) {
    const lastId = Number(c.lastMessage?.id || 0);
    if (!lastId || lastId < since) continue;
    const kind = convKind(c.id, c.threadProperties?.threadType);
    if (c.threadProperties?.topic) upsertConv(c.id, { title: c.threadProperties.topic, kind }); else upsertConv(c.id, { kind });
    const page = await listMessages(c.id, { pageSize: perConv, startTime: since });
    convs++;
    for (const msg of (page.messages || []).reverse()) {
      msg.conversationLink ||= `/conversations/${c.id}`;
      await ingestMessage(msg, { source: 'backfill', notifyOk: false });
      msgs++;
    }
  }
  addEvent('backfill', { data: { days, convs, msgs } });
  return { convs, messages: msgs };
}
