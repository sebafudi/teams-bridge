// Offline scenario test: an empty database in a temporary TEAMS_BRIDGE_HOME, a fake token, and
// Telegram in dry-run mode. Real model calls are made (a few Haiku calls). Run: test/offline.sh
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const L = process.argv[2];
const { db, kvSet, P } = await import(`${L}/core.mjs`);
// An unsigned token shaped like the real one: only exp, oid and name are read locally.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 86400;
writeFileSync(P.token, JSON.stringify({ ic3: `${b64({ alg: 'none' })}.${b64({ aud: 'https://ic3.teams.office.com', exp, oid: '11111111-2222-3333-4444-555555555555', name: 'Test Owner' })}.x`, exp, oid: '11111111-2222-3333-4444-555555555555', chatsvc: 'http://127.0.0.1:9/api/chatsvc/test' }));
const { ingestMessage, processNotifications } = await import(`${L}/engine.mjs`);
const { myMri } = await import(`${L}/teams.mjs`);
const tg = await import(`${L}/notify.mjs`);
const { writeFileSync: wf, readFileSync: rf, existsSync } = await import('node:fs');
const d = db(), me = myMri();
let n = 0;
const conv = id => `19:OFFLINETEST${id}000000000000000000000@thread.v2`;
function setup(c, title) {
  d.prepare("INSERT OR REPLACE INTO convs (id, kind, title) VALUES (?, 'group', ?)").run(c, title);
  kvSet(`convinfo:${c}`, { at: Date.now(), title, kind: 'group', members: [], memberCount: 3 });
}
const msg = (c, id, who, name, text, mention = false) => ({ id: String(id), conversationLink: `https://x/v1/users/ME/conversations/${c}`, from: `https://x/contacts/8:orgid:00000000-0000-0000-0000-00000000000${who}`, imdisplayname: name, messagetype: 'RichText/Html', content: `<p>${text}</p>`, originalarrivaltime: new Date(id).toISOString(), version: String(id), threadtype: 'chat', properties: mention ? { mentions: JSON.stringify([{ mri: me }]) } : {} });
const settle = () => new Promise(r => setTimeout(r, 1500));
const notif = c => d.prepare('SELECT * FROM notifications WHERE conv = ?').get(c);
const budget = full => kvSet('llm_budget', { hour: new Date().toISOString().slice(0, 13), n: full ? 1e6 : 0 });
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); n++; console.log('ok'); }

const base = Date.now() - 600e3;
await step('mention -> notification, other person answers -> edited with a verdict', async () => {
  const c = conv(1); setup(c, 'Offline test A'); budget(false);
  await ingestMessage(msg(c, base, 1, 'Test Alice', '@Test why did the ACH refund for invoice 1042 fail?', true), { source: 'test' });
  await settle(); d.prepare('UPDATE notifications SET due_at = 0 WHERE conv = ?').run(c);
  await processNotifications();
  assert.equal(notif(c).state, 'sent');
  await ingestMessage(msg(c, base + 60e3, 2, 'Test Bob', 'It was the bank cut-off, I re-ran it this morning and it went through. All good.'), { source: 'test' });
  d.prepare('UPDATE notifications SET reply_due = 0 WHERE conv = ?').run(c);
  await processNotifications();
  const v = JSON.parse(notif(c).reply_verdict || 'null');
  assert.ok(v, 'verdict stored'); assert.equal(v.verdict, 'resolved');
  assert.match(tg.dryLog.at(-1).html, /Test Bob replied/);
});
await step('the asker adding more is not a reply', async () => {
  const c = conv(1);
  const before = JSON.parse(notif(c).replies).length;
  await ingestMessage(msg(c, base + 120e3, 1, 'Test Alice', 'Also invoice 1043.'), { source: 'test' });
  assert.equal(JSON.parse(notif(c).replies).length, before);
});
await step('read in Teams -> edited to read', async () => {
  const c = conv(1);
  d.prepare('UPDATE convs SET my_horizon = ? WHERE id = ?').run(base + 200e3, c);
  await processNotifications();
  assert.equal(notif(c).state, 'read');
  assert.match(tg.dryLog.at(-1).html, /read in Teams/);
});
await step('model unavailable -> unfiltered notification with a quote', async () => {
  const c = conv(2); setup(c, 'Offline test B'); budget(true);
  await ingestMessage(msg(c, base, 1, 'Test Alice', 'Does anyone know who owns the refund retry job?'), { source: 'test' });
  await settle(); d.prepare('UPDATE notifications SET due_at = 0 WHERE conv = ?').run(c);
  await processNotifications();
  assert.equal(notif(c)?.state, 'sent');
  const html = tg.dryLog.at(-1).html;
  assert.match(html, /Sent unfiltered/); assert.match(html, /<blockquote>.*refund retry job/);
  budget(false);
});
await step('command channel: send, then edit with the id it returned', async () => {
  // A tiny receiver: appends each payload to a file and answers with an id.
  const log = `${P.state}/cmd.jsonl`, script = `${P.state}/recv.mjs`;
  wf(script, `import { appendFileSync, readFileSync } from 'node:fs'; const j = JSON.parse(readFileSync(0, 'utf8')); appendFileSync(${JSON.stringify(log)}, JSON.stringify(j) + '\\n'); console.log(JSON.stringify({ id: 'msg-' + Date.now() }));`);
  wf(P.configFile, JSON.stringify({ owner: { name: 'Test Owner' }, notify: { channels: ['command'], command: { argv: [process.execPath, script] } } }));
  const r = await tg.send('💬 <b>Title</b>\n<blockquote>hello</blockquote>', { buttons: [[{ text: 'Open', url: 'http://127.0.0.1:1/x' }]] });
  await tg.edit(r.chat, r.messageId, '💬 <b>Title</b> read');
  const lines = rf(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].event, 'send'); assert.match(lines[0].text, /Title\n“hello”/); assert.match(lines[0].text, /Open: http/);
  assert.equal(lines[1].event, 'edit'); assert.match(lines[1].ref, /^msg-/); assert.equal(lines[1].text, '💬 Title read');
});
await step('no channel: notifications are recorded as events, drafts are refused', async () => {
  wf(P.configFile, JSON.stringify({ owner: { name: 'Test Owner' }, notify: { channels: [] } }));
  assert.deepEqual(await tg.send('x'), { chat: null, messageId: null });
  const { createDraft } = await import(`${L}/drafts.mjs`);
  await assert.rejects(createDraft({ conv: conv(1), text: 'hi' }), /notification channel/);
});
await step('older rows (a bare Telegram chat id) still edit through telegram', async () => {
  wf(P.configFile, JSON.stringify({ owner: { name: 'Test Owner' } }));
  const before = tg.dryLog.length;
  await tg.edit('12345', 777, 'legacy edit');
  assert.equal(tg.dryLog.length, before + 1); assert.equal(tg.dryLog.at(-1).messageId, 777);
});
console.log(`${n} scenarios passed`);
process.exit(0);
