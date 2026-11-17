// Delayed spawn scenarios: scheduling, typing postpones, the wait cap, collapsing, skip on reply,
// rate limits and a daemon restart. No model calls (the model budget is spent, so the reply check
// falls back to the plain rule) and no real T3 Code: a fake t3 binary records what it was asked.
// Run: test/spawn.sh (also run by test/offline.sh)
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const L = process.argv[2];
const { db, kvSet, P } = await import(`${L}/core.mjs`);
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 86400, oid = '11111111-2222-3333-4444-555555555555';
writeFileSync(P.token, JSON.stringify({ ic3: `${b64({ alg: 'none' })}.${b64({ exp, oid, name: 'Test Owner' })}.x`, exp, oid, chatsvc: 'http://127.0.0.1:9/api/chatsvc/test' }));

// Fake t3: logs argv and stdin, answers `thread start` with a thread id and link.
const t3log = `${P.state}/t3.jsonl`, t3 = `${P.state}/t3`;
writeFileSync(t3, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2), stdin = argv.at(-1) === '-' ? readFileSync(0, 'utf8') : '';
appendFileSync(${JSON.stringify(t3log)}, JSON.stringify({ argv, stdin }) + '\\n');
if (argv[1] === 'start') { const id = 'th-' + Date.now(); console.log(JSON.stringify({ thread: { threadId: id, link: 't3://' + id } })); }
`);
chmodSync(t3, 0o755);
writeFileSync(P.configFile, JSON.stringify({ owner: { name: 'Test Owner' }, notify: { channels: [] }, t3: { bin: t3 } }));
const rule = extra => ({ id: 'ask-research', owner: 'test', match: { sender: 'Test Asker', kind: 'group' },
  actions: [{ type: 'spawn', via: 't3', project: P.state, title: 'Asks: {conv_title}', prompt: 'TASK: research this', follow_up_minutes: 60, max_per_hour: 5, ...extra }] });
writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));

const { ingestMessage, handlePush, processSpawns } = await import(`${L}/engine.mjs`);
const { flushForwards } = await import(`${L}/spawn.mjs`);
const { myMri } = await import(`${L}/teams.mjs`);
const d = db(), me = myMri();
kvSet('llm_budget', { hour: new Date().toISOString().slice(0, 13), n: 1e9 }); // no model calls

const conv = n => `19:SPAWNTEST${n}000000000000000000000@thread.v2`;
function setup(c, title) {
  d.prepare("INSERT OR REPLACE INTO convs (id, kind, title) VALUES (?, 'group', ?)").run(c, title);
  kvSet(`convinfo:${c}`, { at: Date.now(), title, kind: 'group', members: [], memberCount: 3 });
}
const people = { asker: ['00000000-0000-0000-0000-000000000001', 'Test Asker'], bob: ['00000000-0000-0000-0000-000000000002', 'Test Bob'], carol: ['00000000-0000-0000-0000-000000000003', 'Test Carol'], owner: [oid, 'Test Owner'] };
let clock = Date.now() - 3600e3;
async function say(c, who, text, extra = {}) {
  const id = clock += 1000, [o, name] = people[who];
  await ingestMessage({ id: String(id), conversationLink: `https://x/v1/users/ME/conversations/${c}`, from: `https://x/contacts/8:orgid:${o}`, imdisplayname: name, messagetype: 'RichText/Html', content: `<p>${text}</p>`, originalarrivaltime: new Date(id).toISOString(), version: String(id), threadtype: 'chat', properties: {}, ...extra }, { source: 'test' });
  await new Promise(r => setTimeout(r, 150)); // rule evaluation runs in the background
  return String(id);
}
const typing = (c, who = 'bob') => handlePush('messaging', JSON.stringify({ resourceType: 'NewMessage', resource: { messagetype: 'Control/Typing', conversationLink: `https://x/v1/users/ME/conversations/${c}`, from: `https://x/contacts/8:orgid:${people[who][0]}` } }));
const pending = c => d.prepare("SELECT * FROM spawns WHERE conv = ? ORDER BY id DESC LIMIT 1").get(c);
const events = (kind, c) => d.prepare('SELECT * FROM events WHERE kind = ? AND conv = ? ORDER BY seq').all(kind, c).map(e => ({ ...e, data: JSON.parse(e.data || 'null') }));
const t3calls = () => existsSync(t3log) ? readFileSync(t3log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function settled(cond, what, ms = 4e3) { for (let i = 0; i < ms / 100; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); }
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 5e3, `${msg}: ${a} vs ${b}`);
let n = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); n++; console.log('ok'); }

await step('a match schedules the spawn instead of starting it', async () => {
  const c = conv(1); setup(c, 'Spawn A');
  await say(c, 'asker', 'How does the refund retry pick invoices?');
  const s = pending(c);
  assert.equal(s.state, 'pending');
  near(s.due_at, Date.now() + 5 * 60e3, 'due after the default 5 minutes');
  near(s.cap_at, Date.now() + 30 * 60e3, 'cap after the default 30 minutes');
  await processSpawns();
  assert.equal(pending(c).state, 'pending'); assert.equal(t3calls().length, 0);
  assert.equal(events('spawn_scheduled', c).length, 1);
});
await step('someone typing pushes the deadline to a quiet window', async () => {
  const c = conv(1);
  d.prepare('UPDATE spawns SET due_at = ? WHERE conv = ?').run(Date.now() + 10e3, c);
  await typing(c, 'asker');
  const s = pending(c);
  near(s.due_at, Date.now() + 2 * 60e3, 'due 2 quiet minutes after typing'); assert.equal(s.postponed, 1);
});
await step('someone else typing means people are online: at least the active delay', async () => {
  const c = conv(1);
  await typing(c, 'bob');
  const s = pending(c);
  near(s.due_at, s.created_at + 15 * 60e3, 'due 15 minutes after the match'); assert.equal(s.postponed, 2);
});
await step('someone else wrote shortly before the match: the longer delay from the start', async () => {
  const c = conv(12); setup(c, 'Spawn online');
  await say(c, 'bob', 'Morning all, deploy went fine.');
  await say(c, 'asker', 'Does the payout export include fees?');
  const s = pending(c);
  near(s.due_at, Date.now() + 15 * 60e3, 'due after the 15 minute active delay');
  assert.equal(events('spawn_scheduled', c)[0].data.others_online, true);
  d.prepare("UPDATE spawns SET state = 'skipped' WHERE id = ?").run(s.id);
});
await step('a second match collapses into one spawn for the latest message', async () => {
  const c = conv(1);
  const second = await say(c, 'asker', 'Specifically the ACH ones from last week.');
  const s = pending(c);
  assert.equal(d.prepare("SELECT count(*) n FROM spawns WHERE conv = ?").get(c).n, 1);
  assert.equal(JSON.parse(s.msg_ids).length, 2); assert.equal(s.last_msg, second);
  await processSpawns({ now: s.due_at + 1 });
  await settled(() => events('action_spawned', c).length, 'the thread to start');
  assert.equal(pending(c).state, 'started');
  const starts = t3calls().filter(x => x.argv[1] === 'start');
  assert.equal(starts.length, 1);
  assert.match(starts[0].stdin, /TASK: research this/);
  assert.match(starts[0].stdin, /Specifically the ACH ones/); // latest message
  assert.match(starts[0].stdin, /refund retry pick invoices/);  // earlier one, as context
  assert.equal(events('spawn_fired', c)[0].data.messages, 2);
});
await step('a match while its thread is live is a follow-up at once', async () => {
  const c = conv(1), before = t3calls().length;
  await say(c, 'asker', 'Also, is there a log for it?');
  await settled(() => t3calls().length > before, 'the follow-up');
  assert.equal(t3calls().at(-1).argv[1], 'send');
  assert.equal(d.prepare("SELECT count(*) n FROM spawns WHERE conv = ? AND state = 'pending'").get(c).n, 0);
});
await step('forwarding without the model: only the asker and the owner go through', async () => {
  const c = conv(1), before = t3calls().length;
  await say(c, 'bob', 'Anyone up for lunch at 12?');
  await say(c, 'owner', 'I think the retry job is in the payments worker.');
  await flushForwards();
  const sent = t3calls().slice(before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].stdin, /retry job is in the payments worker/); assert.doesNotMatch(sent[0].stdin, /lunch/);
  assert.equal(events('session_forward', c).at(-1).data.dropped, 1);
});
await step('a stopped session gets nothing more', async () => {
  const c = conv(1), k = `session:ask-research:0:${c}`;
  kvSet(k, { ...JSON.parse(d.prepare('SELECT v FROM kv WHERE k = ?').get(k).v), stopped: 'test' });
  const before = t3calls().length;
  await say(c, 'owner', 'One more thing about the retry job.');
  await flushForwards();
  assert.equal(t3calls().length, before);
});
await step('typing cannot postpone past the cap', async () => {
  const c = conv(2); setup(c, 'Spawn B');
  await say(c, 'asker', 'Who owns the statement export?');
  const cap = Date.now() + 30e3;
  d.prepare('UPDATE spawns SET cap_at = ?, due_at = ? WHERE conv = ?').run(cap, Date.now() + 10e3, c);
  await typing(c);
  assert.equal(pending(c).due_at, cap);
  await processSpawns({ now: cap });
  await settled(() => events('action_spawned', c).length, 'the thread to start');
  assert.equal(pending(c).state, 'started');
});
await step('someone else answered: skipped (model check unavailable, plain fallback)', async () => {
  const c = conv(3); setup(c, 'Spawn C');
  await say(c, 'asker', 'Why is the surcharge missing on this invoice?');
  await say(c, 'bob', 'It is off for that client, I checked the settings.');
  const s = pending(c);
  await processSpawns({ now: s.due_at + 1 });
  assert.equal(pending(c).state, 'skipped');
  const e = events('spawn_skipped', c)[0];
  assert.match(e.data.reason, /Test Bob replied/); assert.equal(events('action_spawned', c).length, 0);
});
await step('recheck "plain": any reply by someone else skips', async () => {
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule({ recheck: 'plain' })));
  const c = conv(4); setup(c, 'Spawn D');
  await say(c, 'asker', 'Is the payout report broken?');
  await say(c, 'bob', 'Looking.');
  await processSpawns({ now: pending(c).due_at + 1 });
  assert.equal(events('spawn_skipped', c)[0].data.reason, 'Test Bob replied');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
});
await step('the owner wrote after it: skipped (plain: any message; model down: skipped too)', async () => {
  const c = conv(5); setup(c, 'Spawn E');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule({ recheck: 'plain' })));
  await say(c, 'asker', 'Can refunds be partial?');
  await say(c, 'owner', 'Yes, from the invoice page.');
  await processSpawns({ now: pending(c).due_at + 1 });
  assert.equal(events('spawn_skipped', c)[0].data.reason, 'owner replied');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
  await say(c, 'asker', 'And can they go to a different card?');
  await say(c, 'owner', 'Checking.');
  await processSpawns({ now: pending(c).due_at + 1 });
  assert.match(events('spawn_skipped', c)[1].data.reason, /^owner wrote in the chat/);
});
await step('read in Teams is not handled: started anyway; skip_if_read true: skipped', async () => {
  const c = conv(6); setup(c, 'Spawn F');
  const id = await say(c, 'asker', 'Where do payment links expire?');
  d.prepare('UPDATE convs SET my_horizon = ? WHERE id = ?').run(Number(id), c);
  await processSpawns({ now: pending(c).due_at + 1 });
  await settled(() => events('action_spawned', c).length, 'the thread to start');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule({ skip_if_read: true, follow_up_minutes: 0 })));
  const id2 = await say(c, 'asker', 'And can we extend them?');
  d.prepare('UPDATE convs SET my_horizon = ? WHERE id = ?').run(Number(id2), c);
  await processSpawns({ now: pending(c).due_at + 1 });
  assert.equal(events('spawn_skipped', c)[0].data.reason, 'owner read it');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
});
await step('the asker adding more is not an answer', async () => {
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify({ ...rule(), match: { sender: 'Test Asker', kind: 'group', text: '\\?' } }));
  const c = conv(7); setup(c, 'Spawn G');
  await say(c, 'asker', 'Which job sends the reminders?');
  await say(c, 'asker', 'asking for a client call tomorrow');
  const s = pending(c);
  assert.equal(JSON.parse(s.msg_ids).length, 1);
  await processSpawns({ now: s.due_at + 1 });
  await settled(() => events('action_spawned', c).length, 'the thread to start');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
});
await step('max_per_hour still applies when the spawn is due', async () => {
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule({ max_per_hour: 1 })));
  kvSet('action_rate:ask-research:0', { hour: new Date().toISOString().slice(0, 13), n: 1 });
  const c = conv(8); setup(c, 'Spawn H');
  await say(c, 'asker', 'What is the retry limit for card payments?');
  await processSpawns({ now: pending(c).due_at + 1 });
  assert.equal(pending(c).state, 'rate_limited');
  assert.equal(events('action_skipped', c)[0].data.reason, 'max_per_hour 1');
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
  kvSet('action_rate:ask-research:0', { hour: '', n: 0 });
});
await step('delay_minutes 0 starts at once', async () => {
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule({ delay_minutes: 0 })));
  const c = conv(9); setup(c, 'Spawn I');
  await say(c, 'asker', 'Is the ledger sync stuck?');
  await settled(() => events('action_spawned', c).length, 'the thread to start');
  assert.equal(pending(c), undefined);
  writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
});
await step('a pending spawn survives a restart', async () => {
  const c = conv(10); setup(c, 'Spawn J');
  await say(c, 'asker', 'Do we store the card brand anywhere?');
  const s = pending(c);
  // A fresh process (a restarted daemon) with the same state folder runs the queue.
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const { processSpawns } = await import(${JSON.stringify(`${L}/engine.mjs`)});
    const { db } = await import(${JSON.stringify(`${L}/core.mjs`)});
    await processSpawns({ now: ${s.due_at + 1} });
    for (let i = 0; i < 40 && !db().prepare("SELECT 1 FROM events WHERE kind = 'action_spawned' AND conv = ?").get(${JSON.stringify(c)}); i++) await new Promise(r => setTimeout(r, 100));
    console.log(db().prepare('SELECT state FROM spawns WHERE id = ?').get(${s.id}).state);
    process.exit(0);`], { env: process.env, encoding: 'utf8' });
  assert.equal(out.trim(), 'started');
  assert.equal(events('action_spawned', c).length, 1);
});
await step('unanswered: open, read-only-in-Teams, direct replies, unsure without the model', async () => {
  const { unanswered } = await import(`${L}/api.mjs`);
  const c = conv(14); setup(c, 'Spawn unanswered');
  const q = await say(c, 'asker', 'Can we resend a statement email?');
  await say(c, 'owner', 'Yes, from the statements tab.', { parentMessageId: q });
  const q2 = await say(c, 'asker', 'Is there an audit log for refunds?');
  d.prepare('UPDATE convs SET my_horizon = ? WHERE id = ?').run(Number(q2), c); // read in Teams: still open
  const all = await unanswered({ days: 1, llm: false, all: true });
  const g = all.find(x => x.conv === c);
  assert.equal(g.status, 'open'); assert.equal(g.key, `teams:${c}:${q2}`);
  assert.deepEqual(g.messages.map(m => m.id), [q2]);
  const rows = await unanswered({ days: 1, llm: false });
  assert.equal(rows.find(x => x.conv === conv(5))?.status, 'maybe_answered'); // owner wrote, topic unknown
  const c3 = rows.find(x => x.conv === conv(3));
  assert.equal(c3.status, 'open'); assert.deepEqual(c3.others_replied, ['Test Bob']);
  assert.ok(rows.find(x => x.conv === conv(1))?.research?.[0]?.link?.startsWith('t3://'), 'links the research thread');
});
await step('rules validate the new fields', async () => {
  const { validate } = await import(`${L}/rules.mjs`);
  assert.deepEqual(validate(rule({ delay_minutes: 4, quiet_minutes: 2, max_wait_minutes: 20, recheck: 'plain', skip_if_read: false })), []);
  const errs = validate(rule({ delay_minutes: -1, recheck: 'maybe', skip_if_read: 'no', active_delay_minutes: 999 }));
  assert.equal(errs.length, 4);
});
if (process.env.TEAMS_BRIDGE_TEST_LLM) {
  kvSet('llm_budget', { hour: new Date().toISOString().slice(0, 13), n: 0 });
  const c = conv(11); setup(c, 'Spawn busy chat');
  await step('[model] several topics in one chat: only messages about the issue are forwarded', async () => {
    writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule({ delay_minutes: 0 })));
    await say(c, 'asker', 'How does the refund retry job decide which invoices to retry?');
    await settled(() => events('action_spawned', c).length, 'the thread to start');
    const before = t3calls().length;
    await say(c, 'bob', 'Anyone up for lunch at 12?');
    await say(c, 'carol', 'The refund retry job only picks failed refunds with fewer than 3 attempts, see RetryService.');
    await say(c, 'bob', 'Deploying the statements service to staging now, ignore the alerts.');
    await flushForwards();
    const th = JSON.parse(d.prepare('SELECT v FROM kv WHERE k = ?').get(`session:ask-research:0:${c}`).v).threadId;
    const sent = t3calls().slice(before).filter(x => x.argv[2] === th);
    assert.equal(sent.length, 1);
    assert.match(sent[0].stdin, /fewer than 3 attempts/); assert.doesNotMatch(sent[0].stdin, /lunch|staging/);
  });
  await step('[model] the owner answering something else in a busy chat does not skip the spawn', async () => {
    const c2 = conv(13); setup(c2, 'Spawn busy owner');
    writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
    await say(c2, 'asker', 'Why did the nightly invoice sync skip three clients yesterday?');
    await say(c2, 'carol', 'Can someone approve my PR for the login page?');
    await say(c2, 'owner', 'Approved, go ahead and merge.');
    await processSpawns({ now: pending(c2).due_at + 1 });
    await settled(() => events('action_spawned', c2).length || events('spawn_skipped', c2).length, 'the re-check', 60e3);
    assert.equal(events('spawn_skipped', c2).length, 0, JSON.stringify(events('spawn_skipped', c2)[0]?.data));
    await say(c2, 'owner', 'About the invoice sync: those three clients have sync disabled in their settings.');
  });
  await step('[model] unanswered: an unrelated owner message leaves it open, a related one answers it', async () => {
    const { unanswered } = await import(`${L}/api.mjs`);
    let rows = await unanswered({ days: 1, all: true });
    assert.equal(rows.find(x => x.conv === conv(13))?.status, 'answered');
    const c3 = conv(15); setup(c3, 'Spawn unanswered busy');
    await say(c3, 'asker', 'Do we support refunds to a different card than the original?');
    await say(c3, 'carol', 'Who is joining the planning call at 3?');
    await say(c3, 'owner', 'I will join the planning call.');
    rows = await unanswered({ days: 1, all: true });
    assert.equal(rows.find(x => x.conv === c3)?.status, 'open');
  });
  await step('[model] a new topic from the asker while the thread is live gets its own delayed thread', async () => {
    writeFileSync(`${P.rulesDir}/ask-research.json`, JSON.stringify(rule()));
    kvSet('action_rate:ask-research:0', { hour: '', n: 0 }); // earlier scenarios used up the hourly cap
    const first = JSON.parse(d.prepare('SELECT v FROM kv WHERE k = ?').get(`session:ask-research:0:${c}`).v);
    const before = t3calls().length;
    await say(c, 'asker', 'Separate question: why do card surcharges show twice on the statement PDF?');
    await settled(() => pending(c) || t3calls().length > before, 'the topic check', 60e3);
    const s = pending(c);
    assert.equal(s?.state, 'pending'); assert.equal(s.fresh, 1);
    await processSpawns({ now: s.due_at + 1 });
    await settled(() => events('action_spawned', c).length === 2, 'the second thread');
    const now = JSON.parse(d.prepare('SELECT v FROM kv WHERE k = ?').get(`session:ask-research:0:${c}`).v);
    assert.notEqual(now.threadId, first.threadId);
    assert.ok(d.prepare('SELECT 1 FROM kv WHERE k = ?').get(`session:ask-research:0:${c}:${first.threadId}`), 'the first thread is kept for its own issue');
  });
}
console.log(`${n} spawn scenarios passed`);
process.exit(0);
