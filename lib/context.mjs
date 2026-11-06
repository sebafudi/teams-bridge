// One context block for every place a model looks at a message: rule classifiers, notification
// summaries and spawned sessions. Conversation facts are cached for a day, so this costs at most one
// or two chat-service reads per conversation per day.
import { db, kvGet, kvSet, log, ownerFirst } from './core.mjs';
import { getThread, myMri, convKind } from './teams.mjs';

const DAY = 86400e3;
const ago = ts => { const m = (Date.now() - ts) / 60e3; return m < 90 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const when = ts => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const nameOf = mri => db().prepare('SELECT name FROM people WHERE mri = ?').get(mri)?.name || null;

// Title, kind, team, description and members of a conversation.
export async function convInfo(conv) {
  const key = `convinfo:${conv}`, cached = kvGet(key, null);
  if (cached && Date.now() - cached.at < DAY) return cached;
  const c = db().prepare('SELECT * FROM convs WHERE id = ?').get(conv) || {};
  const info = { at: Date.now(), title: c.title || conv, kind: c.kind || convKind(conv), team: null, description: null, members: [], memberCount: null };
  const me = myMri();
  try {
    if (info.kind === 'dm') {
      const other = conv.replace(/^19:|@unq\.gbl\.spaces$/g, '').split('_').find(id => !me.endsWith(id));
      info.members = [{ mri: `8:orgid:${other}`, name: nameOf(`8:orgid:${other}`) || c.title }];
      info.memberCount = 2;
    } else if (!['self', 'system'].includes(info.kind)) {
      const t = await getThread(conv);
      info.description = t.properties?.description || null;
      let members = t.members || [];
      if (info.kind === 'channel' && t.properties?.spaceId) {
        const team = await getThread(t.properties.spaceId).catch(() => null);
        info.team = team?.properties?.topic || team?.properties?.spaceThreadTopic || null;
        if (team?.members?.length) members = team.members;
      }
      const people = members.filter(m => /^8:orgid:/.test(m.id) && m.id !== me);
      info.memberCount = people.length + 1;
      info.members = people.map(m => ({ mri: m.id, name: nameOf(m.id) }));
    }
  } catch (e) { log('convinfo failed', conv.slice(0, 30), e.message); }
  kvSet(key, info);
  return info;
}

function mentionNames(row) {
  try {
    const raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
    let ms = raw?.properties?.mentions; if (typeof ms === 'string') ms = JSON.parse(ms);
    return [...new Set((ms || []).map(x => x.displayName || nameOf(x.mri)).filter(Boolean))];
  } catch { return []; }
}

const line = r => `[${when(r.ts)}] ${r.sender_name || '?'}${r.from_me ? ` (${ownerFirst()}, the owner)` : ''}: ${(r.text || '').replace(/\s+\n/g, '\n').slice(0, 1200)}`;

// m: normalized message (conv, id, ts, replyTo, ...) or a stored row. n: earlier messages to include.
export async function buildContext(m, { n = 6 } = {}) {
  const d = db(), conv = m.conv, id = Number(m.id), replyTo = m.replyTo ?? m.reply_to ?? null;
  const info = await convInfo(conv);
  const out = [];
  out.push(`Conversation: ${info.title} (${info.team ? `channel in team "${info.team}"` : info.kind})${info.description ? ` - ${info.description.slice(0, 200)}` : ''}`);
  if (info.members.length) {
    const named = info.members.map(x => x.name).filter(Boolean);
    const rest = (info.memberCount - 1) - named.length;
    out.push(`Members (${info.memberCount}, including ${ownerFirst()}): ${named.slice(0, 15).join(', ')}${named.length > 15 ? ` and ${named.length - 15} more named` : ''}${rest > 0 ? `${named.length ? ', plus' : ''} ${rest} not seen posting` : ''}`);
  }
  let earlier;
  if (replyTo) {
    // A channel reply: its thread is the context, not the whole channel.
    const root = d.prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(conv, String(replyTo));
    out.push(root ? `This is a reply in a thread. Thread starts with:\n${line(root)}` : 'This is a reply in a thread whose first post is not stored.');
    earlier = d.prepare('SELECT * FROM messages WHERE conv = ? AND reply_to = ? AND CAST(id AS INTEGER) < ? AND deleted = 0 ORDER BY ts DESC LIMIT ?').all(conv, String(replyTo), id, n).reverse();
  } else if (info.kind === 'channel') {
    earlier = d.prepare('SELECT * FROM messages WHERE conv = ? AND reply_to IS NULL AND CAST(id AS INTEGER) < ? AND deleted = 0 ORDER BY ts DESC LIMIT ?').all(conv, id, n).reverse();
  } else {
    earlier = d.prepare('SELECT * FROM messages WHERE conv = ? AND CAST(id AS INTEGER) < ? AND deleted = 0 ORDER BY ts DESC LIMIT ?').all(conv, id, n).reverse();
  }
  if (n && earlier.length) out.push(`Earlier messages${replyTo ? ' in this thread' : ''}:\n${earlier.map(line).join('\n')}`);
  const mine = d.prepare('SELECT max(ts) t FROM messages WHERE conv = ? AND from_me = 1').get(conv).t;
  out.push(`${ownerFirst()} last wrote in this conversation: ${mine ? ago(mine) : 'not in the stored history'}.`);
  const row = d.prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(conv, String(m.id));
  const mentions = row ? mentionNames(row) : [];
  const facts = [mentions.length ? `mentions: ${mentions.join(', ')}` : null, (m.mentionsMe ?? row?.mentions_me) ? `${ownerFirst()} is @mentioned` : null,
    (m.importance || row?.importance) && (m.importance || row?.importance) !== 'normal' ? `importance: ${m.importance || row?.importance}` : null,
    (m.subject || row?.subject) ? `subject: ${m.subject || row?.subject}` : null].filter(Boolean);
  out.push(`The message${facts.length ? ` (${facts.join('; ')})` : ''}:\n${line(row || { ts: m.ts, sender_name: m.senderName, from_me: m.fromMe, text: m.text })}`);
  return out.join('\n\n');
}
