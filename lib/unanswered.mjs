// Messages that needed the owner and never got an answer, for a daily review (a task board, a morning
// agent). Read-only: it never writes to Teams and never marks anything read.
//
// Candidates are messages that matched a rule with a notify or spawn action. Being read in Teams does
// not count as handled: in a busy chat the owner can scroll past a question. A question counts as
// answered only when the owner replied to it (a direct reply, or, checked by a model, a message about
// the same issue), or when someone else's reply settled it (the notification's reply verdict, or a
// spawn skipped because the replies settled it).
import { db } from './core.mjs';
import { loadRules } from './rules.mjs';
import { relatedTo } from './llm.mjs';

const ownerRuleIds = () => new Set(loadRules({ includeDisabled: true }).rules
  .filter(r => (r.actions || []).some(a => a.type === 'notify' || a.type === 'spawn')).map(r => r.id));

export async function unanswered({ days = 7, llm = true, all = false } = {}) {
  const d = db(), since = Date.now() - days * 86400e3, wanted = ownerRuleIds();
  const matches = d.prepare("SELECT conv, msg_id, rule FROM events WHERE kind = 'rule_match' AND at >= ? ORDER BY seq")
    .all(new Date(since).toISOString()).filter(e => e.conv && e.msg_id && wanted.has(String(e.rule).replace(/\?$/, '')));
  // One group per conversation (channel: per thread), since one answer usually covers a burst.
  const groups = new Map();
  for (const e of matches) {
    const row = d.prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(e.conv, e.msg_id);
    if (!row || row.deleted || row.from_me || row.kind === 'self') continue;
    const root = row.kind === 'channel' ? String(row.reply_to || row.id) : '';
    const k = `${row.conv}|${root}`;
    const g = groups.get(k) || { conv: row.conv, root, kind: row.kind, asked: new Map(), rules: new Set() };
    g.asked.set(String(row.id), row); g.rules.add(String(e.rule).replace(/\?$/, ''));
    groups.set(k, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const asked = [...g.asked.values()].sort((a, b) => a.ts - b.ts);
    const later = d.prepare('SELECT * FROM messages WHERE conv = ? AND CAST(id AS INTEGER) > ? AND deleted = 0 ORDER BY ts').all(g.conv, Number(asked[0].id))
      .filter(x => !g.root || String(x.reply_to || x.id) === g.root);
    const mine = later.filter(x => x.from_me);
    // Which of the owner's later messages answer these questions?
    let answers = mine.filter(x => g.asked.has(String(x.reply_to))), unsure = false;
    const rest = mine.filter(x => !answers.includes(x));
    if (rest.length && llm) {
      try { const keep = new Set(await relatedTo(asked, rest)); answers = answers.concat(rest.filter((_, j) => keep.has(j))); }
      catch { unsure = true; }
    } else if (rest.length) unsure = true;
    const lastAnswer = Math.max(0, ...answers.map(x => x.ts));
    const open = asked.filter(x => x.ts > lastAnswer);
    // Others' replies: what the notification and spawn checks concluded.
    const ids = open.map(x => String(x.id));
    const notes = d.prepare("SELECT msg_ids, replies, reply_verdict FROM notifications WHERE conv = ? AND reply_verdict IS NOT NULL").all(g.conv)
      .filter(n => JSON.parse(n.msg_ids || '[]').some(id => ids.includes(String(id)))).map(n => JSON.parse(n.reply_verdict));
    const skips = d.prepare("SELECT msg_id, data FROM events WHERE kind = 'spawn_skipped' AND conv = ?").all(g.conv)
      .filter(r => ids.includes(String(r.msg_id))).map(r => JSON.parse(r.data || '{}').reason);
    const settledBy = notes.find(v => v.verdict === 'resolved')?.note || skips.find(r => /replied: /.test(r || '')) || null;
    const status = !open.length ? 'answered' : settledBy ? 'settled_by_others' : unsure ? 'maybe_answered' : 'open';
    if (!all && (status === 'answered' || status === 'settled_by_others')) continue;
    const others = [...new Set(later.filter(x => !x.from_me && !asked.some(a => a.sender_mri === x.sender_mri) && x.ts > (open[0]?.ts ?? 0)).map(x => x.sender_name))];
    const c = d.prepare('SELECT title FROM convs WHERE id = ?').get(g.conv);
    // T3 research started for these messages (its suggested reply is a good start for the answer).
    const research = d.prepare("SELECT msg_id, data FROM events WHERE kind = 'action_spawned' AND conv = ?").all(g.conv)
      .filter(r => g.asked.has(String(r.msg_id))).map(r => JSON.parse(r.data || '{}')).filter(x => x.link || x.thread)
      .map(x => ({ title: x.title, link: x.link || x.thread }));
    const shown = open.length ? open : asked;
    out.push({
      key: `teams:${g.conv}:${shown[0].id}`, status, conv: g.conv, conv_title: c?.title || g.conv, kind: g.kind,
      asked_by: [...new Set(shown.map(x => x.sender_name))], since: new Date(shown[0].ts).toISOString(), last: new Date(shown.at(-1).ts).toISOString(),
      messages: shown.slice(-5).map(x => ({ id: String(x.id), ts: new Date(x.ts).toISOString(), sender: x.sender_name, text: (x.text || '').slice(0, 500) })),
      owner_wrote_since: mine.some(x => x.ts > shown[0].ts), others_replied: others, others_verdict: notes.at(-1) || undefined,
      settled_note: status === 'settled_by_others' ? settledBy : undefined, research: research.length ? research : undefined,
      rules: [...g.rules],
    });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}
