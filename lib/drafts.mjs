// Drafts: an agent proposes a Teams message, the owner approves (and may edit) it on a small page
// linked from a notification, and only then is it posted. Nothing reaches Teams without that approval.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { db, addEvent, loadConfig, log, locale } from './core.mjs';
import { postApprovedDraft, convKind, getConversation, listMessages, myMri } from './teams.mjs';
import { findPerson, dmConvId } from './api.mjs';
import { getConv } from './engine.mjs';
import * as notifier from './notify.mjs';

const rand = () => randomBytes(18).toString('base64url');
const get = id => db().prepare('SELECT * FROM drafts WHERE id = ?').get(id);
const byToken = t => db().prepare('SELECT * FROM drafts WHERE token = ?').get(t);
const hhmm = ts => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

export function listDrafts({ state, limit = 20 } = {}) {
  return state ? db().prepare('SELECT * FROM drafts WHERE state = ? ORDER BY id DESC LIMIT ?').all(state, limit)
    : db().prepare('SELECT * FROM drafts ORDER BY id DESC LIMIT ?').all(limit);
}
export const publicDraft = d => ({ id: d.id, conv: d.conv, conv_title: getConv(d.conv)?.title || d.to_name || null, to: d.to_name ? { name: d.to_name, mri: d.to_mri } : undefined, first_contact: !!d.first_contact, never_written: !!d.never_written, reply_to: d.reply_to, text: d.text, final_text: d.final_text, edited: !!d.edited, reason: d.reason, agent: d.agent, state: d.state, created_at: d.created_at, expires_at: d.expires_at, decided_at: d.decided_at, sent_at: d.sent_at, error: d.error });

const warning = d => d.first_contact
  ? `⚠️ <b>FIRST MESSAGE to ${notifier.esc(d.to_name || 'this person')}</b>: you have never chatted with them. Approving creates a new chat.\n`
  : d.never_written ? `⚠️ <b>You have never written to ${notifier.esc(d.to_name || 'this person')}</b> in this chat before.\n` : '';

function messageText(d, status) {
  const c = getConv(d.conv) || { title: d.to_name || d.conv };
  const head = `${status === 'pending' ? warning(d) : ''}✍️ <b>Draft for ${notifier.esc(c.title || d.to_name)}</b>${d.reply_to ? ' (reply)' : ''} · from ${notifier.esc(d.agent || 'an agent')}`;
  const why = d.reason ? `\nWhy: ${notifier.esc(d.reason)}` : '';
  const body = `\n\n<blockquote>${notifier.esc(status === 'sent' && d.final_text ? d.final_text : d.text)}</blockquote>`;
  const tail = {
    pending: `\n<i>Nothing is sent until you approve. Expires ${hhmm(d.expires_at)}.</i>`,
    sent: `\n✅ <i>sent at ${hhmm(d.sent_at || Date.now())}${d.edited ? ', with your edits' : ''}</i>`,
    rejected: '\n❌ <i>rejected</i>', expired: '\n⌛ <i>expired, not sent</i>', failed: `\n⚠️ <i>sending failed: ${notifier.esc(d.error || '')}</i>`,
  }[status] || '';
  return head + why + body + tail;
}

// Did the owner ever write in this 1:1 chat? Checks Teams itself when the local store has nothing.
export async function dmState(convId) {
  const local = db().prepare('SELECT count(*) n FROM messages WHERE conv = ? AND from_me = 1').get(convId).n;
  if (local) return { exists: true, written: true };
  try { await getConversation(convId); } catch (e) { if (/-> (400|403|404)/.test(e.message)) return { exists: false, written: false }; throw e; }
  const page = await listMessages(convId, { pageSize: 100 });
  const me = myMri();
  return { exists: true, written: (page.messages || []).some(m => (m.from || '').endsWith(me)) };
}

// conv: an existing conversation id/title. to: a person (name or mri) for a 1:1 message, including
// someone the owner has never chatted with; such drafts are marked and need an extra confirmation.
export async function createDraft({ conv, to, text, reason = '', agent = 'agent', replyTo = null }) {
  const cfg = loadConfig().drafts;
  if ((!conv && !to) || !text?.trim()) throw new Error('text and one of conv or to are required');
  if (text.length > 4000) throw new Error('text longer than 4000 characters');
  // The owner approves through a link in a notification; without a channel nobody would see it.
  if (!notifier.configured()) throw new Error('drafts need a notification channel (notify.channels); none is configured');
  let toMri = null, toName = null, first = 0, never = 0;
  if (to) {
    const p = /^8:orgid:/.test(to) ? { mri: to, name: db().prepare('SELECT name FROM people WHERE mri = ?').get(to)?.name || to } : findPerson(to);
    toMri = p.mri; toName = p.name; conv = dmConvId(p.mri);
  }
  const kind = convKind(conv);
  if (!to && !getConv(conv)) throw new Error(`unknown conversation ${conv} (use an id from convs, or to: a person)`);
  if (kind === 'dm') {
    const st = await dmState(conv);
    first = st.exists ? 0 : 1; never = st.exists && !st.written ? 1 : 0;
    if (!toName) { const other = db().prepare("SELECT sender_mri, sender_name FROM messages WHERE conv = ? AND from_me = 0 AND sender_name != '' ORDER BY ts DESC LIMIT 1").get(conv); toMri = other?.sender_mri || null; toName = other?.sender_name || getConv(conv)?.title || null; }
  }
  const now = Date.now();
  const r = db().prepare("INSERT INTO drafts (conv, reply_to, text, reason, agent, state, created_at, expires_at, token, nonce, to_mri, to_name, first_contact, never_written) VALUES (?,?,?,?,?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(conv, replyTo, text.trim(), reason, agent, now, now + cfg.expiresHours * 3600e3, rand(), rand(), toMri, toName, first, never);
  const d = get(Number(r.lastInsertRowid));
  const url = `${cfg.baseUrl || `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`}/d/${d.token}`;
  try {
    const m = await notifier.send(messageText(d, 'pending'), { buttons: [[{ text: 'Review, edit or approve', url }]] });
    db().prepare('UPDATE drafts SET tg_chat = ?, tg_message_id = ? WHERE id = ?').run(m.chat, m.messageId, d.id);
  } catch (e) { log('ERROR notify draft', e.message); }
  addEvent('draft_created', { conv, data: { draft: d.id, agent, reason, to: toName || undefined, first_contact: !!first, never_written: !!never } });
  return { ...publicDraft(get(d.id)), review_url_sent_to_owner: true };
}

async function finish(d, state, extra = {}) {
  const sets = Object.entries(extra).map(([k]) => `${k} = ?`);
  db().prepare(`UPDATE drafts SET state = ?, decided_at = coalesce(decided_at, ?)${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = ?`)
    .run(state, Date.now(), ...Object.values(extra), d.id);
  const nd = get(d.id);
  addEvent(`draft_${state}`, { conv: d.conv, data: { draft: d.id, agent: d.agent, edited: !!nd.edited, error: nd.error || undefined } });
  if (nd.tg_message_id) await notifier.edit(nd.tg_chat, nd.tg_message_id, messageText(nd, state)).catch(e => log('ERROR notify edit', e.message));
  return nd;
}

export async function expireDrafts() {
  for (const d of db().prepare("SELECT * FROM drafts WHERE state = 'pending' AND expires_at < ?").all(Date.now())) await finish(d, 'expired');
}

async function approve(d, text, confirmedFirst = false) {
  const cfg = loadConfig().drafts;
  if ((d.first_contact || d.never_written) && !confirmedFirst) throw new Error(`tick the box confirming this is your first message to ${d.to_name || 'this person'}`);
  if (d.first_contact || d.never_written) {
    const n = db().prepare("SELECT count(*) n FROM drafts WHERE state = 'sent' AND sent_at > ? AND (first_contact = 1 OR never_written = 1)").get(Date.now() - 86400e3).n;
    if (n >= cfg.maxFirstContactsPerDay) throw new Error(`daily cap of ${cfg.maxFirstContactsPerDay} first messages reached`);
  }
  const sentToday = db().prepare("SELECT count(*) n FROM drafts WHERE state = 'sent' AND sent_at > ?").get(Date.now() - 86400e3).n;
  if (sentToday >= cfg.maxSendsPerDay) throw new Error(`daily cap of ${cfg.maxSendsPerDay} sent drafts reached`);
  const finalText = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!finalText) throw new Error('empty message');
  // Claim the draft atomically so a double click cannot send twice.
  const claimed = db().prepare("UPDATE drafts SET state = 'approved', final_text = ?, edited = ?, decided_at = ? WHERE id = ? AND state = 'pending'")
    .run(finalText, finalText !== d.text ? 1 : 0, Date.now(), d.id);
  if (!claimed.changes) throw new Error('this draft was already decided');
  const nd = get(d.id);
  try {
    await postApprovedDraft(nd, { draftId: nd.id, state: 'approved' });
    log('draft sent', nd.id, getConv(nd.conv)?.title || nd.conv);
    return await finish(nd, 'sent', { sent_at: Date.now() });
  } catch (e) {
    log('ERROR draft send', e.message);
    return await finish(nd, 'failed', { error: e.message.slice(0, 300) });
  }
}

// ---------- approval page ----------

const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${h(title)}</title><style>
:root{--bg:#f6f6f4;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e2e2dd;--accent:#4b53bc;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--card:#1f1f1d;--line:#33332f;--accent:#8f95f0;--danger:#f2b8b5}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0}.muted{color:var(--muted);font-size:14px}
.msg{padding:6px 0;border-bottom:1px solid var(--line)}.msg:last-child{border:0}.who{font-weight:600}
textarea{width:100%;box-sizing:border-box;min-height:140px;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.row{display:flex;gap:10px;margin-top:12px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:8px;border:0;cursor:pointer}
.ok{background:var(--accent);color:#fff}.warn{border:2px solid var(--danger)}.confirm{display:block;margin-top:12px;font-weight:600}.no{background:transparent;color:var(--danger);border:1px solid var(--danger)}</style></head><body><main>${body}</main></body></html>`;

function draftPage(d) {
  const c = getConv(d.conv) || { title: d.to_name || d.conv, kind: convKind(d.conv) };
  const ctx = db().prepare('SELECT * FROM messages WHERE conv = ? AND deleted = 0 ORDER BY ts DESC LIMIT 8').all(d.conv).reverse();
  const when = ts => new Date(ts).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const context = ctx.length ? ctx.map(m => `<div class="msg"><span class="who">${h(m.sender_name)}</span> <span class="muted">${when(m.ts)}</span><div>${h(m.text).replace(/\n/g, '<br>')}</div></div>`).join('') : '<p class="muted">No stored messages from this chat.</p>';
  if (d.state !== 'pending') return PAGE('Draft', `<h2>Draft #${d.id}: ${h(d.state)}</h2><p class="muted">${h(c.title)}</p><div class="card">${h(d.final_text || d.text).replace(/\n/g, '<br>')}</div>`);
  const first = d.first_contact || d.never_written;
  const banner = !first ? '' : `<div class="card warn"><b>⚠️ ${d.first_contact ? `First message to ${h(d.to_name)}` : `You have never written to ${h(d.to_name)} here`}</b><br>${d.first_contact ? 'You have no chat with this person yet. Approving creates a new 1:1 chat and sends this as your first message.' : 'This chat exists, but nothing from you is in it. This would be your first message there.'} Check the recipient and the wording carefully.</div>`;
  const confirm = !first ? '' : `<label class="confirm"><input type="checkbox" name="confirm_first" value="yes" required> I checked: this is my first message to ${h(d.to_name)}${d.to_mri ? ` <span class="muted">(${h(d.to_mri)})</span>` : ''}</label>`;
  return PAGE(`Draft for ${c.title || d.to_name}`, `
${banner}
<h2>Send to ${h(c.title || d.to_name)}?</h2>
<p class="muted">${h(c.kind || '')} · proposed by ${h(d.agent)} · expires ${h(new Date(d.expires_at).toLocaleString(locale()))}</p>
${d.reason ? `<div class="card"><b>Why</b><br>${h(d.reason)}</div>` : ''}
<div class="card"><b>Latest in the chat</b>${context}</div>
<form method="post" action="/d/${h(d.token)}"><input type="hidden" name="nonce" value="${h(d.nonce)}">
<div class="card"><b>Message</b> <span class="muted">(edit freely; exactly this text is sent)</span><br><br>
<textarea name="text" maxlength="4000">${h(d.text)}</textarea>
${confirm}
<div class="row"><button class="no" name="action" value="reject" formnovalidate>Reject</button><button class="ok" name="action" value="approve">Approve and send</button></div></div></form>`);
}

export function startApprovalServer() {
  const { port, host } = loadConfig().drafts;
  const srv = createServer(async (req, res) => {
    const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); res.end(html); };
    const m = /^\/d\/([A-Za-z0-9_-]{20,})$/.exec((req.url || '').split('?')[0]);
    if (!m) return send(404, PAGE('Not found', '<h2>Not found</h2>'));
    const d = byToken(m[1]);
    if (!d) return send(404, PAGE('Not found', '<h2>Not found</h2>'));
    if (d.state === 'pending' && d.expires_at < Date.now()) { await finish(d, 'expired'); return send(410, draftPage(get(d.id))); }
    if (req.method === 'GET') return send(200, draftPage(d));
    if (req.method !== 'POST') return send(405, PAGE('Error', '<h2>Method not allowed</h2>'));
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 20000) return send(413, PAGE('Error', '<h2>Too large</h2>')); }
    const f = new URLSearchParams(body);
    if (f.get('nonce') !== d.nonce) return send(403, PAGE('Error', '<h2>This form is out of date. Reload the page.</h2>'));
    try {
      if (f.get('action') === 'reject') { if (d.state === 'pending') await finish(d, 'rejected'); return send(200, PAGE('Rejected', '<h2>Rejected. Nothing was sent.</h2>')); }
      if (f.get('action') === 'approve') {
        const nd = await approve(d, f.get('text'), f.get('confirm_first') === 'yes');
        return send(200, PAGE(nd.state, nd.state === 'sent' ? `<h2>Sent to ${h(getConv(nd.conv)?.title || nd.conv)}.</h2><div class="card">${h(nd.final_text).replace(/\n/g, '<br>')}</div>` : `<h2>Not sent</h2><p>${h(nd.error)}</p>`));
      }
      return send(400, PAGE('Error', '<h2>Unknown action</h2>'));
    } catch (e) { return send(409, PAGE('Error', `<h2>Not sent</h2><p>${h(e.message)}</p>`)); }
  });
  srv.listen(port, host || '127.0.0.1', () => log('approval pages on', `${host || '127.0.0.1'}:${port}`));
  srv.on('error', e => log('ERROR approval server', e.message));
  return srv;
}
