// Rules: deterministic match first, then an optional model classifier, then actions.
// One JSON file per rule in ~/.config/teams-bridge/rules.d/<id>.json. See README for the schema.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { P, loadConfig } from './core.mjs';

const KINDS = ['dm', 'group', 'channel', 'meeting', 'self', 'system', 'other'];
const FIELD_KEYS = ['kind', 'conv', 'not_conv', 'sender', 'not_sender', 'mentions_me', 'text', 'not_text', 'importance', 'hours', 'days'];
const MATCH_KEYS = [...FIELD_KEYS, 'any', 'include_own', 'include_edits'];
const ACTIONS = ['notify', 'queue', 'spawn', 'exec'];

const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];

function validateFields(m, where, errs) {
  for (const k of arr(m.kind)) if (!KINDS.includes(k)) errs.push(`${where}.kind: ${k} not in ${KINDS.join('|')}`);
  for (const f of ['text', 'not_text']) for (const re of arr(m[f])) { try { new RegExp(re, 'i'); } catch (e) { errs.push(`${where}.${f}: bad regex ${re}`); } }
  if (m.hours != null && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(m.hours)) errs.push(`${where}.hours: "HH:MM-HH:MM" (local time)`);
  for (const d of arr(m.days)) if (!(d >= 1 && d <= 7)) errs.push(`${where}.days: 1 (Mon) .. 7 (Sun)`);
  if (m.mentions_me != null && typeof m.mentions_me !== 'boolean') errs.push(`${where}.mentions_me: boolean`);
  const places = loadConfig().places || {};
  for (const f of ['conv', 'not_conv']) for (const c of arr(m[f])) if (String(c).startsWith('@') && !places[c.slice(1)]) errs.push(`${where}.${f}: no place ${c} (teams-bridge places)`);
}

export function validate(rule) {
  const errs = [];
  if (!rule || typeof rule !== 'object') return ['rule must be an object'];
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(rule.id || '')) errs.push('id: lowercase letters, digits, . _ - (max 64)');
  if (!rule.owner) errs.push('owner: who manages this rule (an agent name or "owner")');
  for (const k of Object.keys(rule)) if (!['id', 'owner', 'description', 'enabled', 'match', 'classify', 'actions', 'priority'].includes(k)) errs.push(`unknown field: ${k}`);
  const m = rule.match || {};
  for (const k of Object.keys(m)) if (!MATCH_KEYS.includes(k)) errs.push(`match: unknown field ${k}`);
  validateFields(m, 'match', errs);
  if (m.any != null) {
    if (!Array.isArray(m.any) || !m.any.length) errs.push('match.any: non-empty array of field sets (at least one must match)');
    else m.any.forEach((sub, i) => {
      for (const k of Object.keys(sub || {})) if (!FIELD_KEYS.includes(k)) errs.push(`match.any[${i}]: field ${k} not allowed here`);
      validateFields(sub || {}, `match.any[${i}]`, errs);
    });
  }
  if (rule.classify) {
    const c = rule.classify;
    if (!c.question) errs.push('classify.question is required');
    if (c.labels && !Array.isArray(c.labels)) errs.push('classify.labels: array');
    const labels = c.labels || ['yes', 'no'];
    if (!arr(c.fire_on).length) errs.push('classify.fire_on: labels that make the rule fire');
    for (const l of arr(c.fire_on)) if (!labels.includes(l)) errs.push(`classify.fire_on: ${l} not in labels`);
    if (c.min_confidence != null && !(c.min_confidence >= 0 && c.min_confidence <= 1)) errs.push('classify.min_confidence: 0..1');
    if (c.on_error != null && !['notify', 'skip'].includes(c.on_error)) errs.push('classify.on_error: notify (default: run plain notify actions, marked unfiltered) | skip');
    if (c.context_messages != null && !(c.context_messages >= 0 && c.context_messages <= 20)) errs.push('classify.context_messages: 0..20');
  }
  const acts = arr(rule.actions);
  if (!acts.length) errs.push('actions: at least one of notify, queue, spawn, exec');
  for (const a of acts) {
    if (!ACTIONS.includes(a?.type)) { errs.push(`actions: type must be ${ACTIONS.join('|')}`); continue; }
    if (a.when_label != null) {
      if (!rule.classify) errs.push('when_label needs a classify block');
      else for (const l of arr(a.when_label)) if (!arr(rule.classify.fire_on).includes(l)) errs.push(`when_label: ${l} is not in classify.fire_on`);
    }
    if (a.type === 'spawn') {
      if (!a.prompt) errs.push('spawn: prompt is required (what the agent should do with the event)');
      const via = a.via || loadConfig().spawn?.defaultVia;
      if (!['t3', 'agent'].includes(via)) errs.push('spawn.via: t3 (T3 Code thread) | agent (`agent spawn` headless run); or set spawn.defaultVia in config. For anything else use an exec action');
      if (via === 't3' && !a.project) errs.push('spawn.project: T3 Code project path or id (e.g. ~/code/my-service)');
      if (a.follow_up_minutes != null && !(a.follow_up_minutes >= 0 && a.follow_up_minutes <= 1440)) errs.push('spawn.follow_up_minutes: 0..1440');
      if (a.runner && !['claude', 'omp'].includes(a.runner)) errs.push('spawn.runner: claude | omp');
      if (a.max_per_hour != null && !(a.max_per_hour >= 1 && a.max_per_hour <= 20)) errs.push('spawn.max_per_hour: 1..20');
      if (a.max_minutes != null && !(a.max_minutes >= 1 && a.max_minutes <= 120)) errs.push('spawn.max_minutes: 1..120');
    }
    if (a.type === 'exec') {
      if (!Array.isArray(a.command) || !a.command.length || !a.command.every(x => typeof x === 'string')) errs.push('exec.command: argv array of strings (no shell)');
      if (a.timeout_sec != null && !(a.timeout_sec >= 1 && a.timeout_sec <= 300)) errs.push('exec.timeout_sec: 1..300');
      if (a.stdin != null && !['json', 'prompt'].includes(a.stdin)) errs.push('exec.stdin: json (default, the event; with a prompt also the full agent prompt) | prompt (only the prompt text)');
      if (a.output != null && !['ignore', 'notify'].includes(a.output)) errs.push('exec.output: ignore (default) | notify (send what the command printed as a notification)');
      if (a.stdin === 'prompt' && !a.prompt) errs.push('exec.stdin "prompt" needs exec.prompt');
      if (a.max_per_hour != null && !(a.max_per_hour >= 1 && a.max_per_hour <= 120)) errs.push('exec.max_per_hour: 1..120');
    }
  }
  return errs;
}

export function loadRules({ includeDisabled = false } = {}) {
  const rules = [], errors = [];
  for (const f of readdirSync(P.rulesDir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const rule = JSON.parse(readFileSync(`${P.rulesDir}/${f}`, 'utf8'));
      const errs = validate(rule);
      if (errs.length) { errors.push({ file: f, errors: errs }); continue; }
      rule._file = f;
      rule._key = ruleKey(rule);
      if (includeDisabled || rule.enabled !== false) rules.push(rule);
    } catch (e) { errors.push({ file: f, errors: [e.message] }); }
  }
  rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { rules, errors };
}

// Cache key for verdicts: changes when the match or classifier changes.
// CONTEXT_VERSION: bump when lib/context.mjs changes what the classifier sees, so old verdicts are not reused.
const CONTEXT_VERSION = 2;
export const ruleKey = r => `${r.id}@${createHash('sha256').update(JSON.stringify({ m: r.match, c: r.classify, v: CONTEXT_VERSION })).digest('hex').slice(0, 10)}`;

const ci = s => String(s || '').toLowerCase();
const anySub = (hay, needles) => needles.some(n => hay.some(h => ci(h).includes(ci(n))));

function inHours(spec, ts) {
  const d = new Date(ts), mins = d.getHours() * 60 + d.getMinutes();
  const [a, b] = spec.split('-').map(x => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

// "@name" entries in conv / not_conv expand to the conversations of a named place (config "places").
function expandConvs(list) {
  const places = loadConfig().places || {};
  return arr(list).flatMap(c => String(c).startsWith('@') ? arr(places[c.slice(1)]) : [c]);
}
const convHit = (msg, list) => expandConvs(list).some(n => msg.conv === n || anySub([msg.conv, msg.convTitle], [n]));

function fieldsReason(m, msg) {
  if (m.kind != null && !arr(m.kind).includes(msg.kind)) return `kind ${msg.kind}`;
  if (m.conv != null && !convHit(msg, m.conv)) return 'conv';
  if (m.not_conv != null && convHit(msg, m.not_conv)) return 'not_conv';
  const senderHay = [msg.senderMri, msg.senderName];
  if (m.sender != null && !anySub(senderHay, arr(m.sender))) return 'sender';
  if (m.not_sender != null && anySub(senderHay, arr(m.not_sender))) return 'not_sender';
  if (m.mentions_me != null && msg.mentionsMe !== m.mentions_me) return 'mentions_me';
  // Subject and body are tested separately so ^ and $ anchor to the message text itself.
  const texts = [msg.text || '', msg.subject || ''];
  const hit = re => { const r = new RegExp(re, 'i'); return texts.some(t => r.test(t)); };
  if (m.text != null && !arr(m.text).some(hit)) return 'text';
  if (m.not_text != null && arr(m.not_text).some(hit)) return 'not_text';
  if (m.importance != null && !arr(m.importance).includes(msg.importance || 'normal')) return 'importance';
  if (m.hours != null && !inHours(m.hours, msg.ts)) return 'hours';
  if (m.days != null && !arr(m.days).includes(((new Date(msg.ts).getDay() + 6) % 7) + 1)) return 'days';
  return null;
}

// msg: normalized message plus convTitle. Returns null on match, or the reason it did not match.
// All top-level fields must match (AND); with "any", at least one of its field sets must match too (OR).
export function matchReason(rule, msg) {
  const m = rule.match || {};
  if (msg.fromMe && !m.include_own) return 'own message';
  if (msg.edited && !m.include_edits) return 'edit';
  if (msg.deleted) return 'deleted';
  const kindsAsked = [...arr(m.kind), ...arr(m.any).flatMap(x => arr(x?.kind))];
  if (msg.kind === 'system' && !kindsAsked.includes('system')) return 'system feed';
  const r = fieldsReason(m, msg);
  if (r) return r;
  if (m.any != null && !arr(m.any).some(sub => !fieldsReason(sub, msg))) return 'any';
  return null;
}

export function verdictFires(rule, v) {
  const c = rule.classify;
  return arr(c.fire_on).includes(v.label) && v.confidence >= (c.min_confidence ?? 0.6);
}
