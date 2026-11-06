// Read/configure operations shared by the CLI and the MCP server. All return plain JSON.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { P, db, loadConfig, saveConfigPatch, kvGet, norm, readJson } from './core.mjs';
import { tokenInfo } from './teams.mjs';
import { channels as notifyChannels } from './notify.mjs';
import { loadRules, validate, matchReason, verdictFires, ruleKey } from './rules.mjs';
import { verdictFor, getConv } from './engine.mjs';

export function status() {
  // The daemon writes a heartbeat every minute; works the same under systemd, launchd or a terminal.
  const beat = kvGet('heartbeat', 0);
  const daemon = !beat ? 'never ran' : Date.now() - beat < 150e3 ? 'running' : `not running (last seen ${new Date(beat).toISOString()})`;
  const d = db(), t = tokenInfo(), cfg = loadConfig();
  const ev = k => d.prepare('SELECT at FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1').get(k)?.at || null;
  const counts = d.prepare('SELECT count(*) n, sum(from_me = 0) others FROM messages WHERE ts > ?').get(Date.now() - 86400e3);
  const { rules, errors } = loadRules({ includeDisabled: true });
  const reg = kvGet('last_registration', null);
  return {
    daemon, paused: cfg.paused, notify_channels: notifyChannels().join(', ') || 'none (events only)',
    token: t.ok ? `valid, ${Math.floor(t.leftMin / 60)}h${t.leftMin % 60}m left` : (t.reason || 'expired'),
    last_connected: ev('connected'), last_disconnected: ev('disconnected'), last_registration: reg ? new Date(reg).toISOString() : null,
    messages_24h: counts.n, from_others_24h: counts.others || 0,
    notifications: Object.fromEntries(d.prepare('SELECT state, count(*) n FROM notifications GROUP BY state').all().map(r => [r.state, r.n])),
    drafts: Object.fromEntries(d.prepare('SELECT state, count(*) n FROM drafts GROUP BY state').all().map(r => [r.state, r.n])),
    rules: rules.map(r => `${r.id}${r.enabled === false ? ' (disabled)' : ''}`), rule_errors: errors,
    llm_this_hour: (() => {
      const { llm } = loadConfig(), hour = new Date().toISOString().slice(0, 13);
      const used = k => { const b = kvGet(k, {}); return b.hour === hour ? b.n : 0; };
      return `live ${used('llm_budget')}/${llm.maxCallsPerHour}, replay ${used('llm_budget_replay')}/${llm.maxReplayCallsPerHour ?? 300}`;
    })(),
    last_seq: d.prepare('SELECT max(seq) s FROM events').get().s || 0,
  };
}

// ---------- people ----------
// Everyone seen sending a message (any chat). The Teams directory itself is not searched.
const myOid = () => readJson(P.token, {}).oid;
export const dmConvId = mri => {
  const ids = [myOid(), String(mri).split(':').pop()].sort();
  return `19:${ids[0]}_${ids[1]}@unq.gbl.spaces`;
};

export function people(q = '', limit = 20) {
  const d = db(), nq = norm(q);
  const rows = d.prepare('SELECT * FROM people ORDER BY last_seen DESC').all()
    .filter(p => !nq || norm(p.name).includes(nq) || nq.split(/\s+/).every(w => norm(p.name).includes(w)) || p.mri.endsWith(q));
  return rows.slice(0, limit).map(p => {
    const dm = dmConvId(p.mri), conv = d.prepare('SELECT * FROM convs WHERE id = ?').get(dm);
    const fromMe = conv ? d.prepare('SELECT count(*) n FROM messages WHERE conv = ? AND from_me = 1').get(dm).n : 0;
    return { mri: p.mri, name: p.name, last_seen: p.last_seen, seen_in: d.prepare('SELECT title FROM convs WHERE id = ?').get(p.seen_in)?.title || p.seen_in,
      dm_conv: dm, has_dm_chat: !!conv, my_messages_in_dm: fromMe };
  });
}

export function findPerson(q) {
  const hits = people(q, 5);
  if (!hits.length) throw new Error(`nobody called "${q}" has been seen in your chats (teams-bridge people)`);
  const exact = hits.filter(h => norm(h.name) === norm(q));
  if (exact.length === 1) return exact[0];
  if (hits.length > 1) throw new Error(`"${q}" is ambiguous: ${hits.map(h => `${h.name} (${h.mri})`).join(', ')}; pass the mri`);
  return hits[0];
}

export function findConv(q) {
  const d = db();
  return d.prepare('SELECT * FROM convs WHERE id = ?').get(q) ||
    d.prepare('SELECT * FROM convs WHERE lower(title) LIKE ? ORDER BY last_msg DESC LIMIT 1').get(`%${String(q).toLowerCase()}%`) ||
    d.prepare('SELECT * FROM convs ORDER BY last_msg DESC').all().find(c => norm(c.title).includes(norm(q))) ||
    (() => { try { const p = findPerson(q); return d.prepare('SELECT * FROM convs WHERE id = ?').get(p.dm_conv) || null; } catch { return null; } })();
}

export function conversations(limit = 30) {
  return db().prepare(`SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conv = c.id AND m.from_me = 0 AND m.deleted = 0 AND CAST(m.id AS INTEGER) > c.my_horizon) unread
    FROM convs c ORDER BY last_msg DESC LIMIT ?`).all(limit)
    .map(r => ({ id: r.id, title: r.title, kind: r.kind, last_msg_at: r.last_msg || null, unread: r.unread, my_read_up_to: r.my_horizon || null }));
}

export function readConversation(q, last = 20) {
  const c = findConv(q);
  if (!c) throw new Error(`no conversation matches "${q}"`);
  const msgs = db().prepare('SELECT * FROM messages WHERE conv = ? ORDER BY ts DESC LIMIT ?').all(c.id, last).reverse()
    .map(m => ({ id: m.id, ts: m.ts, sender: m.sender_name, from_me: !!m.from_me, text: m.deleted ? null : m.text, edited: !!m.edited, deleted: !!m.deleted, mentions_me: !!m.mentions_me, read_by_owner: Number(m.id) <= c.my_horizon }));
  return { conv: c.id, title: c.title, kind: c.kind, messages: msgs };
}

export function unread() {
  return db().prepare(`SELECT m.*, c.title, c.kind ck FROM messages m JOIN convs c ON c.id = m.conv
    WHERE m.from_me = 0 AND m.deleted = 0 AND CAST(m.id AS INTEGER) > c.my_horizon ORDER BY m.conv, m.ts`).all()
    .map(m => ({ conv: m.conv, conv_title: m.title, kind: m.ck, id: m.id, ts: m.ts, sender: m.sender_name, text: m.text, mentions_me: !!m.mentions_me }));
}

export function events({ since = 0, kinds = null, rule = null, limit = 200 } = {}) {
  const rows = db().prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(since, Math.min(limit, 1000));
  const next = rows.length ? rows[rows.length - 1].seq : since;
  return {
    next_since: next,
    events: rows.filter(e => (!kinds?.length || kinds.includes(e.kind)) && (!rule || e.rule === rule))
      .map(e => ({ ...e, conv_title: e.conv ? getConv(e.conv)?.title || null : null, data: e.data ? JSON.parse(e.data) : null })),
  };
}

const ruleFile = id => `${P.rulesDir}/${id}.json`;
export function getRule(id) {
  if (!existsSync(ruleFile(id))) throw new Error(`no rule ${id}`);
  return JSON.parse(readFileSync(ruleFile(id), 'utf8'));
}

export function saveRule(rule, { force = false } = {}) {
  const errs = validate(rule);
  if (errs.length) throw new Error(`invalid rule: ${errs.join('; ')}`);
  if (existsSync(ruleFile(rule.id))) {
    const cur = getRule(rule.id);
    if (cur.owner !== rule.owner && !force) throw new Error(`rule ${rule.id} belongs to ${cur.owner}; choose another id`);
  }
  writeFileSync(ruleFile(rule.id), JSON.stringify(rule, null, 2) + '\n');
  return { saved: ruleFile(rule.id) };
}

export function setRuleEnabled(id, enabled, owner) {
  const r = getRule(id);
  if (owner && r.owner !== owner) throw new Error(`rule ${id} belongs to ${r.owner}`);
  r.enabled = !!enabled;
  writeFileSync(ruleFile(id), JSON.stringify(r, null, 2) + '\n');
  return { id, enabled: r.enabled };
}

// Replay stored messages through a rule. Classifier verdicts come from the cache unless llm is true.
export async function testRule(rule, { days = 7, llm = false, limit = 50 } = {}) {
  const errs = validate(rule);
  if (errs.length) throw new Error(`invalid rule: ${errs.join('; ')}`);
  rule._key = ruleKey(rule);
  const msgs = db().prepare('SELECT m.*, c.title FROM messages m LEFT JOIN convs c ON c.id = m.conv WHERE m.ts > ? ORDER BY m.ts').all(Date.now() - days * 86400e3);
  const hits = [], unknown = [], errors = [];
  for (const row of msgs) {
    const m = { conv: row.conv, id: row.id, ts: row.ts, senderMri: row.sender_mri, senderName: row.sender_name, kind: row.kind, importance: row.importance, subject: row.subject, text: row.text, mentionsMe: !!row.mentions_me, fromMe: !!row.from_me, edited: !!row.edited, deleted: !!row.deleted, convTitle: row.title };
    if (matchReason(rule, m)) continue;
    let v = null;
    if (rule.classify) {
      try { v = await verdictFor(rule, m, { allowLlm: llm, bucket: 'replay' }); } catch (e) { errors.push(e.message); continue; }
      if (!v) { unknown.push({ conv_title: m.convTitle, sender: m.senderName, ts: m.ts, text: m.text.slice(0, 120) }); continue; }
      if (!verdictFires(rule, v)) continue;
    }
    hits.push({ conv_title: m.convTitle, sender: m.senderName, ts: m.ts, text: m.text.slice(0, 160), verdict: v ? { label: v.label, confidence: v.confidence, reason: v.reason } : null });
  }
  return { scanned: msgs.length, days, would_fire: hits.length, hits: hits.slice(-limit), needs_classifier: unknown.length, needs_classifier_sample: unknown.slice(-10), classifier_errors: errors.length, classifier_error_sample: [...new Set(errors)].slice(0, 3) };
}

// ---------- subscriptions ----------
// A subscription is a named cursor over the event log with a filter: rule ids (their rule_match
// events), event kinds, and/or conversations. Consumers: `watch` (stream), `wait` (block until
// something arrives), MCP teams_wait / channel push. Reading through a subscription advances its
// cursor, so a consumer that restarts continues where it stopped.

const parseList = v => v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).split(',').map(s => s.trim()).filter(Boolean);

export function subscribe({ name, owner, rules, kinds, convs, fromStart = false }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name || '')) throw new Error('name: lowercase letters, digits, . _ - (max 64)');
  if (!owner) throw new Error('owner (your agent name) is required');
  const r = parseList(rules), k = parseList(kinds), c = parseList(convs);
  if (!r.length && !k.length && !c.length) throw new Error('give at least one of rules, kinds, convs');
  const { rules: known } = loadRules({ includeDisabled: true });
  for (const id of r) if (!known.some(x => x.id === id)) throw new Error(`no rule ${id} (create it first, with a queue action)`);
  const d = db();
  const cur = d.prepare('SELECT * FROM subscriptions WHERE name = ?').get(name);
  if (cur && cur.owner !== owner) throw new Error(`subscription ${name} belongs to ${cur.owner}`);
  const resolved = c.map(x => findConv(x)?.id || x);
  const cursor = cur ? cur.cursor : fromStart ? 0 : (d.prepare('SELECT max(seq) s FROM events').get().s || 0);
  d.prepare(`INSERT INTO subscriptions (name, owner, rules, kinds, convs, cursor, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET rules = excluded.rules, kinds = excluded.kinds, convs = excluded.convs`)
    .run(name, owner, JSON.stringify(r), JSON.stringify(k), JSON.stringify(resolved), cursor, Date.now());
  return { ...subscription(name), listen: listenHow(name) };
}

// How to listen, returned with every subscription. Monitor is the default for Claude Code.
export const listenHow = name => ({
  default: 'monitor',
  monitor: { tool: 'Monitor', command: `teams-bridge watch ${name}`, description: `Teams: ${name}`, timeout_ms: 1800000,
    note: 'Claude Code: start the Monitor tool with this command; each new event becomes a notification. Re-arm the same command when it expires; the cursor is kept, so nothing is lost or repeated.' },
  wait: `teams-bridge wait ${name} --timeout 1800`,
  mcp_wait: { tool: 'teams_wait', arguments: { name } },
  note: 'Other harnesses and scripts: run the wait command in the background or loop teams_wait.',
});

export function subscription(name) {
  const s = db().prepare('SELECT * FROM subscriptions WHERE name = ?').get(name);
  if (!s) throw new Error(`no subscription ${name}`);
  return { name: s.name, owner: s.owner, rules: JSON.parse(s.rules), kinds: JSON.parse(s.kinds), convs: JSON.parse(s.convs), cursor: s.cursor, last_read_at: s.last_read_at };
}
export const subscriptions = () => db().prepare('SELECT name FROM subscriptions ORDER BY name').all().map(r => subscription(r.name));
export function unsubscribe(name, owner) {
  const s = subscription(name);
  if (owner && s.owner !== owner) throw new Error(`subscription ${name} belongs to ${s.owner}`);
  db().prepare('DELETE FROM subscriptions WHERE name = ?').run(name);
  return { removed: name };
}

// Event as delivered to subscribers: flat, with the message text joined in for rule matches.
export function present(e) {
  const data = e.data ? (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) : {};
  const out = { seq: e.seq, at: e.at, kind: e.kind, rule: e.rule || undefined, conv: e.conv || undefined, conv_title: e.conv ? (getConv(e.conv)?.title || data.conv_title) : undefined };
  if (e.conv && e.msg_id && (e.kind === 'rule_match' || e.kind.startsWith('message'))) {
    const m = db().prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(e.conv, e.msg_id);
    if (m) Object.assign(out, { msg_id: m.id, sender: m.sender_name, text: m.deleted ? null : m.text, ts: m.ts, mentions_me: !!m.mentions_me, from_me: !!m.from_me, conv_kind: m.kind });
  }
  if (data.verdict) out.verdict = data.verdict;
  if (!out.text && e.kind !== 'rule_match' && !e.kind.startsWith('message')) out.data = data;
  return out;
}

export function matchesSub(sub, e) {
  if (sub.convs.length && !sub.convs.includes(e.conv)) return false;
  const byRule = sub.rules.length && e.kind === 'rule_match' && sub.rules.includes(e.rule);
  const byKind = sub.kinds.length && sub.kinds.includes(e.kind);
  if (!sub.rules.length && !sub.kinds.length) return true; // conv-only subscription: everything in those chats
  return !!(byRule || byKind);
}

// Read new events for a subscription. advance=false peeks without moving the cursor.
export function readSub(name, { limit = 50, advance = true } = {}) {
  const sub = subscription(name);
  const rows = db().prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 2000').all(sub.cursor);
  const hits = []; let cursor = sub.cursor;
  for (const e of rows) {
    if (hits.length >= limit) break;
    cursor = e.seq;
    if (matchesSub(sub, e)) hits.push(present(e));
  }
  if (advance && cursor !== sub.cursor) db().prepare('UPDATE subscriptions SET cursor = ?, last_read_at = ? WHERE name = ?').run(cursor, Date.now(), name);
  return { subscription: name, cursor, events: hits };
}

// Block until the subscription has events or the timeout passes.
export async function waitSub(name, { timeoutSec = 300, limit = 50 } = {}) {
  const end = Date.now() + timeoutSec * 1000;
  for (; ;) {
    const r = readSub(name, { limit });
    if (r.events.length || Date.now() >= end) return { ...r, timed_out: !r.events.length };
    await new Promise(res => setTimeout(res, 1500));
  }
}

// ---------- places: named groups of conversations for rules ("@name") ----------
export function places() {
  const pl = loadConfig().places || {};
  return Object.fromEntries(Object.entries(pl).map(([name, convs]) => [name, [].concat(convs).map(c => ({ conv: c, title: getConv(c)?.title || null }))]));
}
export function setPlace(name, convs, { force = false } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name || '')) throw new Error('place name: lowercase letters, digits, . _ -');
  if (!convs?.length) throw new Error('give at least one conversation (id or title)');
  if ((loadConfig().places || {})[name] && !force) throw new Error(`place ${name} exists; use --force to replace it`);
  const ids = convs.map(q => { const c = findConv(q); if (!c) throw new Error(`no conversation matches "${q}"`); return c.id; });
  saveConfigPatch({ places: { [name]: ids } });
  return places()[name];
}
export function removePlace(name) {
  const cfg = JSON.parse(readFileSync(P.configFile, 'utf8'));
  if (!cfg.places?.[name]) throw new Error(`no place ${name}`);
  delete cfg.places[name];
  writeFileSync(P.configFile, JSON.stringify(cfg, null, 2) + '\n');
  return { removed: name };
}
