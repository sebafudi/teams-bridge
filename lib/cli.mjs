// teams-bridge CLI for the owner and for agents. Run `teams-bridge help`.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { P, db, loadConfig, saveConfigPatch, sleep } from './core.mjs';
import { tokenInfo, sendToOwnNotes } from './teams.mjs';
import { loadRules, validate } from './rules.mjs';
import { catchUp, getConv, composeNotification, ingestMessage, backfill } from './engine.mjs';
import { refreshToken } from './token-refresh.mjs';
import * as notifier from './notify.mjs';
import * as api from './api.mjs';
import { createDraft, listDrafts, publicDraft } from './drafts.mjs';

const HELP = `teams-bridge: your Microsoft Teams messages, read-only, for you and your agents.

Setup
  login                                 open a browser window, sign in to Teams once; saves the token
  daemon                                run the listener in the foreground (the installed service runs this)

Reading
  status                                daemon, token, connection, counts
  tail [--since SEQ | --last N] [--kind K[,K]] [--rule ID] [--follow] [--json]
                                        event log; SEQ is a cursor, keep the last one you saw
  convs [--limit N] [--json]            conversations with unread counts
  read CONV [--last N] [--json]         messages of one conversation (id or title substring)
  unread [--json]                       unread messages from others, by conversation
  people [NAME] [--json]                people seen in your chats (accents optional); chat status is from the local
                                        store, drafts check Teams itself
  notifications [--limit N]             sent notifications and their state
  context CONV [--msg ID] [--messages N]  exactly what classifiers and agents see for a message

Rules (JSON files in ${P.rulesDir})
  rules list [--json]                   all rules, with load errors
  rules show ID
  rules validate FILE
  rules add FILE [--force]              validate and install (refuses another owner's rule without --force)
  rules enable ID | rules disable ID
  rules remove ID                       moves the file to rules.d/.removed/
  rules test ID|FILE [--days N] [--llm] replay stored messages; --llm runs the classifier for uncached ones

Control
  pause | resume                        stop / restart notifications (recording continues)
  notify-test                           send a test notification to every channel in notify.channels
  notify-preview CONV [--last N] [--send]  render (and optionally send, silently) a notification for CONV
  catchup                               fetch recent messages now (normally automatic)
  backfill [--days 14] [--convs 40]     one-off history import for rule testing (read-only, no notifications or agents)
  token [status | refresh]              ic3 token state / refresh it headless (no chat is opened)
Drafts (nothing is sent until the owner approves it on the page linked from a notification)
  draft create (--conv CONV | --to PERSON) --text TEXT [--reason WHY] [--agent NAME] [--reply-to MSGID]
                                        --to works for people you never chatted with: marked as a first message
                                        and the owner must tick an extra confirmation
  draft list [--state pending|sent|rejected|expired|failed|cancelled] [--json]
  draft show ID | draft cancel ID

Places (named groups of chats; rules use "@name" in match.conv / not_conv)
  places [list] | places set NAME CONV... [--force] | places rm NAME

Subscriptions (a named cursor over events; rules decide what matters, subscriptions deliver it)
  sub add NAME --owner AGENT [--rule ID]... [--kind K[,K]] [--conv CONV]... [--from-start]
  sub list | sub rm NAME
  watch NAME [--json]                   DEFAULT way to listen: stream new events, one readable line each,
                                        for the Claude Code Monitor tool (re-arm on expiry; cursor is kept)
  wait NAME [--timeout SEC] [--text]    block until something arrives, print JSON lines, exit 0 (2 = timeout)

Status (your Teams presence; works without any Teams client open)
  presence [get]                        what others see now, and whether you forced it
  presence set available|busy|dnd|brb|away|offline [--for 2h | --until 17:30]
  presence reset                        drop the forced status; Teams follows your devices again
  presence note TEXT [--for 1d] | presence note --clear

  mcp                                   run the MCP server on stdio (tools for agents)
  notes-send TEXT                       post TEXT to the owner's own Notes chat (the only chat it can write to)

Event kinds: message message_edited message_deleted read member_read rule_match notify_sent
  notify_read notify_skipped system connected disconnected catchup token_refreshed
  token_refresh_failed auth_problem error draft_created draft_sent draft_rejected
  draft_expired draft_failed presence_set presence_reset presence_note`;

const args = process.argv.slice(2);
const flag = (name, def = undefined) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const ago = ts => { if (!ts) return '-'; const s = (Date.now() - ts) / 1000; return s < 90 ? `${s | 0}s ago` : s < 5400 ? `${(s / 60) | 0}m ago` : s < 172800 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`; };
const when = ts => new Date(ts).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const out = o => console.log(JSON.stringify(o));
const die = m => { console.error(`teams-bridge: ${m}`); process.exit(1); };

function findConv(q) {
  const d = db();
  return d.prepare('SELECT * FROM convs WHERE id = ?').get(q) ||
    d.prepare('SELECT * FROM convs WHERE lower(title) LIKE ? ORDER BY last_msg DESC LIMIT 1').get(`%${q.toLowerCase()}%`) ||
    die(`no conversation matches "${q}" (see: teams-bridge convs)`);
}

function eventLine(e) {
  const d = e.data ? JSON.parse(e.data) : {};
  const conv = e.conv ? (getConv(e.conv)?.title || d.conv_title || e.conv.slice(0, 24)) : '';
  let detail = '';
  if (e.kind.startsWith('message')) detail = `${d.sender || '?'}: ${(d.text || '').replace(/\s+/g, ' ').slice(0, 120)}`;
  else if (e.kind === 'rule_match') detail = `${e.rule}${d.verdict ? ` (${d.verdict.label} ${d.verdict.confidence})` : ''}`;
  else if (d && Object.keys(d).length) detail = JSON.stringify(d).slice(0, 140);
  return `${String(e.seq).padStart(6)} ${e.at.slice(5, 19).replace('T', ' ')} ${e.kind.padEnd(15)} ${conv ? `[${conv}] ` : ''}${detail}`;
}

async function main() {
  const cmd = args.shift() || 'help';
  const d = db();
  switch (cmd) {
    case 'help': case '--help': case '-h': console.log(HELP); break;

    case 'status': {
      const st = api.status();
      if (bool('--json')) out(st); else for (const [k, v] of Object.entries(st)) console.log(`${k.padEnd(18)} ${v && typeof v === 'object' ? JSON.stringify(v) : v ?? '-'}`);
      break;
    }

    case 'tail': {
      const json = bool('--json'), follow = bool('--follow');
      const kinds = flag('--kind')?.split(','), rule = flag('--rule');
      let since = Number(flag('--since', NaN));
      if (Number.isNaN(since)) { const last = Number(flag('--last', 20)); since = Math.max(0, (d.prepare('SELECT max(seq) s FROM events').get().s || 0) - last); }
      const q = () => d.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 500').all(since)
        .filter(e => (!kinds || kinds.includes(e.kind)) && (!rule || e.rule === rule));
      for (; ;) {
        const rows = q();
        for (const e of rows) json ? out({ ...e, data: e.data ? JSON.parse(e.data) : null }) : console.log(eventLine(e));
        const max = d.prepare('SELECT max(seq) s FROM events').get().s || since;
        since = Math.max(since, max);
        if (!follow) break;
        await sleep(2000);
      }
      break;
    }

    case 'convs': {
      const json = bool('--json'), rows = api.conversations(Number(flag('--limit', 30)));
      if (json) rows.forEach(out);
      else for (const r of rows) console.log(`${(r.unread ? `${r.unread} unread` : '').padEnd(10)} ${(r.kind || '').padEnd(8)} ${(r.last_msg_at ? ago(r.last_msg_at) : '-').padEnd(9)} ${r.title || '?'}  ${r.id}`);
      break;
    }

    case 'read': {
      const last = Number(flag('--last', 20)), json = bool('--json');
      const q = args.join(' ') || die('usage: read CONV');
      const c = api.readConversation(q, last);
      if (json) c.messages.forEach(m => out({ conv: c.conv, conv_title: c.title, ...m }));
      else {
        console.log(`# ${c.title} (${c.kind}) ${c.conv}`);
        for (const m of c.messages) console.log(`${!m.read_by_owner && !m.from_me ? '*' : ' '} ${when(m.ts)} ${m.sender}${m.edited ? ' (edited)' : ''}: ${m.deleted ? '[deleted]' : m.text}`);
      }
      break;
    }

    case 'unread': {
      const json = bool('--json'), rows = api.unread();
      if (json) rows.forEach(out);
      else { let cur; for (const m of rows) { if (m.conv !== cur) { cur = m.conv; console.log(`\n# ${m.conv_title} (${m.kind})`); } console.log(`  ${when(m.ts)} ${m.sender}: ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`); } }
      break;
    }

    case 'context': {
      // What a model sees for a message: conversation, team, members, thread or earlier messages, mentions.
      const { buildContext } = await import('./context.mjs');
      const n = Number(flag('--messages', 6)), msgId = flag('--msg');
      const c = api.findConv(args.join(' ') || die('usage: context CONV [--msg MSGID] [--messages N]')) || die('no such conversation');
      const row = msgId ? d.prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(c.id, msgId) : d.prepare('SELECT * FROM messages WHERE conv = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1').get(c.id);
      if (!row) die('no message');
      console.log(await buildContext({ conv: row.conv, id: row.id, ts: row.ts, reply_to: row.reply_to, senderName: row.sender_name, text: row.text }, { n }));
      break;
    }

    case 'places': {
      const sub = args.shift() || 'list';
      if (sub === 'list') { const pl = api.places(); if (bool('--json')) out(pl); else for (const [n, cs] of Object.entries(pl)) console.log(`@${n}: ${cs.map(c => c.title || c.conv).join(', ')}`); }
      else if (sub === 'set') { const force = bool('--force'); const name = args.shift(); out(api.setPlace(name, args, { force })); }
      else if (sub === 'rm') out(api.removePlace(args[0]));
      else die(`unknown: places ${sub}`);
      break;
    }

    case 'people': {
      const json = bool('--json'), rows = api.people(args.join(' '), Number(flag('--limit', 20)));
      if (json) rows.forEach(out);
      else for (const p of rows) console.log(`${p.name.padEnd(28)} ${(p.has_dm_chat ? (p.my_messages_in_dm ? '1:1 chat, you wrote' : '1:1 chat, none of yours stored') : 'no 1:1 chat stored').padEnd(30)}  seen ${ago(p.last_seen)} in ${p.seen_in}  ${p.mri}`);
      break;
    }

    case 'notifications': {
      const rows = d.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(Number(flag('--limit', 20)));
      for (const n of rows) console.log(`${String(n.id).padStart(4)} ${n.state.padEnd(19)} ${(getConv(n.conv)?.title || n.conv).slice(0, 40).padEnd(40)} msgs ${JSON.parse(n.msg_ids).length} rules ${JSON.parse(n.rules).join(',')} ${n.sent_at ? 'sent ' + ago(n.sent_at) : ''}`);
      break;
    }

    case 'rules': {
      const sub = args.shift() || 'list';
      const file = id => `${P.rulesDir}/${id}.json`;
      const load = idOrFile => existsSync(idOrFile) ? JSON.parse(readFileSync(idOrFile, 'utf8')) : existsSync(file(idOrFile)) ? JSON.parse(readFileSync(file(idOrFile), 'utf8')) : die(`no rule ${idOrFile}`);
      if (sub === 'list') {
        const { rules, errors } = loadRules({ includeDisabled: true });
        if (bool('--json')) { out({ rules, errors }); break; }
        for (const r of rules) console.log(`${r.enabled === false ? '-' : '+'} ${r.id.padEnd(28)} owner=${r.owner} ${r.classify ? 'llm ' : ''}actions=${r.actions.map(a => a.type).join(',')}  ${r.description || ''}`);
        for (const e of errors) console.log(`! ${e.file}: ${e.errors.join('; ')}`);
      } else if (sub === 'show') console.log(JSON.stringify(load(args[0]), null, 2));
      else if (sub === 'validate') { const errs = validate(load(args[0])); if (errs.length) die(errs.join('\n')); console.log('ok'); }
      else if (sub === 'add') {
        const force = bool('--force');
        const r = load(args[0]); const errs = validate(r); if (errs.length) die(errs.join('\n'));
        if (existsSync(file(r.id))) { const cur = JSON.parse(readFileSync(file(r.id), 'utf8')); if (cur.owner !== r.owner && !force) die(`rule ${r.id} belongs to ${cur.owner}; use another id or --force`); }
        writeFileSync(file(r.id), JSON.stringify(r, null, 2) + '\n'); console.log(`installed ${file(r.id)}`);
      } else if (sub === 'enable' || sub === 'disable') {
        const r = load(args[0]); r.enabled = sub === 'enable'; writeFileSync(file(r.id), JSON.stringify(r, null, 2) + '\n'); console.log(`${r.id} ${sub}d`);
      } else if (sub === 'remove') {
        const r = load(args[0]); mkdirSync(`${P.rulesDir}/.removed`, { recursive: true });
        renameSync(file(r.id), `${P.rulesDir}/.removed/${r.id}.${Date.now()}.json`); console.log(`removed ${r.id}`);
      } else if (sub === 'test') {
        const days = Number(flag('--days', 7)), llm = bool('--llm'), json = bool('--json');
        const r = await api.testRule(load(args[0]), { days, llm, limit: 200 });
        if (json) { out(r); break; }
        for (const h of r.hits) console.log(`✓ ${when(h.ts)} [${h.conv_title}] ${h.sender}: ${h.text.replace(/\s+/g, ' ').slice(0, 100)}${h.verdict ? `  (${h.verdict.label} ${h.verdict.confidence}: ${h.verdict.reason})` : ''}`);
        for (const u of r.needs_classifier_sample) console.log(`? ${when(u.ts)} [${u.conv_title}] ${u.sender}: ${u.text.slice(0, 80)}  (needs --llm)`);
        console.log(`\n${r.would_fire} of ${r.scanned} messages in the last ${days} days would fire${r.needs_classifier ? `, ${r.needs_classifier} need the classifier (--llm)` : ''}${r.classifier_errors ? `, ${r.classifier_errors} classifier errors (${r.classifier_error_sample.join('; ')})` : ''}`);
      } else die(`unknown: rules ${sub}`);
      break;
    }

    case 'pause': saveConfigPatch({ paused: true }); console.log('notifications paused (recording continues)'); break;
    case 'resume': saveConfigPatch({ paused: false }); console.log('notifications resumed'); break;
    case 'notify-test': { const r = await notifier.send('🧪 <b>teams-bridge</b> test notification. Teams summaries will look like this.'); console.log('sent', r.messageId); break; }
    case 'notify-preview': {
      const send = bool('--send'), last = Number(flag('--last', 5));
      const c = findConv(args.join(' ') || die('usage: notify-preview CONV [--last N] [--send]'));
      const msgs = d.prepare('SELECT * FROM messages WHERE conv = ? AND from_me = 0 AND deleted = 0 ORDER BY ts DESC LIMIT ?').all(c.id, last).reverse();
      if (!msgs.length) die('no messages from others in that conversation');
      const text = await composeNotification(c, msgs);
      console.log(text);
      if (send) { const r = await notifier.send('🧪 preview\n' + text, { silent: true }); console.log('sent', r.messageId); }
      break;
    }
    case 'import-jsonl': {
      // Replay recorded push bodies (one JSON per line) into the database without notifying.
      let n = 0;
      for (const line of readFileSync(args[0] || die('usage: import-jsonl FILE'), 'utf8').split('\n').filter(Boolean)) {
        let b = JSON.parse(line); if (b.body && b.path) b = b.body; // listener spike format
        if (b.resourceType === 'NewMessage' && b.resource) { await ingestMessage(b.resource, { source: 'import', notifyOk: false }); n++; }
      }
      console.log(`imported ${n} message pushes`);
      break;
    }
    case 'draft': {
      const sub = args.shift() || 'list';
      if (sub === 'create') {
        const conv = flag('--conv'), to = flag('--to'), text = flag('--text'), reason = flag('--reason', ''), agent = flag('--agent', process.env.AGENT_NAME || 'cli'), replyTo = flag('--reply-to', null);
        if ((!conv && !to) || !text) die('usage: draft create (--conv CONV | --to PERSON) --text TEXT [--reason WHY] [--agent NAME] [--reply-to MSGID]');
        out(await createDraft({ conv: conv ? findConv(conv).id : undefined, to, text, reason, agent, replyTo }));
      } else if (sub === 'list') {
        const json = bool('--json'), rows = listDrafts({ state: flag('--state'), limit: Number(flag('--limit', 20)) });
        if (json) rows.forEach(r => out(publicDraft(r)));
        else for (const r of rows) console.log(`${String(r.id).padStart(4)} ${r.state.padEnd(9)} ${(getConv(r.conv)?.title || r.conv).slice(0, 30).padEnd(30)} by ${r.agent}: ${(r.final_text || r.text).replace(/\s+/g, ' ').slice(0, 70)}`);
      } else if (sub === 'show') { const r = d.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(args[0])) || die('no such draft'); out(publicDraft(r)); }
      else if (sub === 'cancel') {
        const r = d.prepare("SELECT * FROM drafts WHERE id = ? AND state = 'pending'").get(Number(args[0])) || die('no pending draft with that id');
        d.prepare("UPDATE drafts SET state = 'cancelled', decided_at = ? WHERE id = ?").run(Date.now(), r.id);
        if (r.tg_message_id) await notifier.edit(r.tg_chat, r.tg_message_id, `✍️ Draft #${r.id} was withdrawn by ${notifier.esc(r.agent)}. Nothing was sent.`).catch(() => { });
        console.log('cancelled');
      } else die(`unknown: draft ${sub}`);
      break;
    }
    case 'presence': {
      const pr = await import('./presence.mjs');
      const json = bool('--json'), clear = bool('--clear');
      const sub = args.shift() || 'get';
      const until = pr.parseUntil(flag('--for') || flag('--until'));
      let r;
      if (sub === 'get') r = await pr.getPresence();
      else if (sub === 'set') r = await pr.setStatus((args[0] || die(`usage: presence set ${Object.keys(pr.STATUSES).join('|')} [--for 2h | --until 17:30]`)).toLowerCase(), until);
      else if (sub === 'reset') r = await pr.resetStatus();
      else if (sub === 'note') r = await pr.setNote(clear ? '' : (args.join(' ') || die('usage: presence note TEXT [--for 1d] | presence note --clear')), until);
      else die(`unknown: presence ${sub}`);
      if (json) out(r);
      else console.log(`shown: ${r.shown}${r.forced ? ` (set by you${r.forced.until ? ` until ${new Date(r.forced.until).toLocaleString('en-GB')}` : ''})` : ' (from your devices)'}${r.note ? `\nnote: ${r.note.text}${r.note.until ? ` (until ${new Date(r.note.until).toLocaleString('en-GB')})` : ''}` : ''}${r.out_of_office ? '\nout of office' : ''}`);
      break;
    }
    case 'sub': {
      const api = await import('./api.mjs');
      const sub = args.shift() || 'list';
      if (sub === 'add') {
        const rules = [], kinds = [], convs = []; let v;
        while ((v = flag('--rule'))) rules.push(v);
        while ((v = flag('--kind'))) kinds.push(...v.split(','));
        while ((v = flag('--conv'))) convs.push(v);
        const owner = flag('--owner', process.env.AGENT_NAME), fromStart = bool('--from-start');
        const r = api.subscribe({ name: args[0], owner, rules, kinds, convs, fromStart });
        if (bool('--json')) out(r);
        else console.log(`subscribed ${r.name} (rules ${r.rules.join(',') || '-'}, kinds ${r.kinds.join(',') || '-'}, convs ${r.convs.length || '-'})\nlisten (default, Claude Code Monitor tool): ${r.listen.monitor.command}\nother harnesses: ${r.listen.wait}`);
      } else if (sub === 'list') api.subscriptions().forEach(x => out(x));
      else if (sub === 'rm') out(api.unsubscribe(args[0] || die('usage: sub rm NAME'), flag('--owner')));
      else die(`unknown: sub ${sub}`);
      break;
    }
    case 'watch': case 'wait': {
      // watch: stream new events of a subscription, one line each, forever (Monitor-friendly).
      // wait: block until at least one event (or --timeout), print them, exit 0; exit 2 on timeout.
      const api = await import('./api.mjs');
      // watch prints readable lines by default (best for Monitor notifications); wait prints JSON by default.
      const asJson = bool('--json'), asText = bool('--text'), timeout = Number(flag('--timeout', 600));
      const text = cmd === 'watch' ? !asJson : asText;
      const name = args[0] || die(`usage: ${cmd} SUBSCRIPTION [--text]${cmd === 'wait' ? ' [--timeout SEC]' : ''}`);
      api.subscription(name);
      const line = e => text
        ? `[teams ${e.kind}${e.rule ? ' ' + e.rule : ''}] ${e.conv_title || ''}${e.sender ? ` · ${e.sender}` : ''}${e.mentions_me ? ' (@you)' : ''}: ${(e.text ?? JSON.stringify(e.data ?? '')).replace(/\s+/g, ' ').slice(0, 400)} (conv ${e.conv || '-'}, msg ${e.msg_id || '-'}, seq ${e.seq})`
        : JSON.stringify(e);
      if (cmd === 'wait') {
        const r = await api.waitSub(name, { timeoutSec: timeout });
        r.events.forEach(e => console.log(line(e)));
        process.exit(r.timed_out ? 2 : 0);
      }
      for (; ;) {
        const r = api.readSub(name);
        for (const e of r.events) console.log(line(e));
        await sleep(r.events.length ? 200 : 1500);
      }
    }
    case 'login': {
      console.error('A browser window opens on Teams. Sign in; it closes by itself once the token is saved (up to 15 minutes).');
      const r = await refreshToken({ headed: true, force: false, timeoutSec: 900 });
      console.log(JSON.stringify(r)); if (!r.ok) process.exit(1); break;
    }
    case 'daemon': process.env.TEAMS_BRIDGE_DAEMON = '1'; await import('./daemon.mjs'); return new Promise(() => { });
    case 'mcp': await (await import('./mcp.mjs')).serve(); return new Promise(() => { });
    case 'backfill': {
      const r = await backfill({ days: Number(flag('--days', 14)), maxConvs: Number(flag('--convs', 40)) });
      await sleep(500); // let queued rule evaluation (notify/spawn disabled for backfill) finish its writes
      out(r); break;
    }
    case 'catchup': console.log(JSON.stringify(await catchUp({ reason: 'manual', force: true }))); break;
    case 'token': {
      const sub = args.shift() || 'status';
      if (sub === 'status') { const t = tokenInfo(); console.log(t.ok ? `valid for ${t.leftMin} minutes (until ${new Date(t.exp * 1000).toLocaleString('en-GB')}), chat service ${t.chatsvc}` : `not usable: ${t.reason || 'expired'}`); }
      else if (sub === 'refresh') { const r = await refreshToken({ force: !bool('--no-force') }); console.log(JSON.stringify(r)); if (!r.ok) process.exit(1); }
      else die(`unknown: token ${sub}`);
      break;
    }
    case 'notes-send': { const text = args.join(' ') || die('usage: notes-send TEXT'); await sendToOwnNotes(text); console.log('sent to your Notes chat'); break; }
    default: die(`unknown command ${cmd} (teams-bridge help)`);
  }
}
main().then(() => process.exit(0), e => die(e.message));
