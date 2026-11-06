// Shared paths, config, database and small helpers for teams-bridge.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const HOME = process.env.HOME;
// Where config and state live. XDG folders by default (also on macOS, like most CLI tools);
// TEAMS_BRIDGE_HOME puts everything in one folder (config files at the top, state in ./state).
const ONE = process.env.TEAMS_BRIDGE_HOME;
export const P = {
  state: ONE ? `${ONE}/state` : `${process.env.XDG_STATE_HOME || `${HOME}/.local/state`}/teams-bridge`,
  config: ONE || `${process.env.XDG_CONFIG_HOME || `${HOME}/.config`}/teams-bridge`,
  get token() { return `${this.state}/token.json`; },
  get listener() { return `${this.state}/listener.json`; },
  get db() { return `${this.state}/bridge.db`; },
  get configFile() { return `${this.config}/config.json`; },
  get rulesDir() { return `${this.config}/rules.d`; },
  lib: new URL('.', import.meta.url).pathname,
};
mkdirSync(P.state, { recursive: true, mode: 0o700 });
mkdirSync(P.config, { recursive: true, mode: 0o700 });
mkdirSync(P.rulesDir, { recursive: true });

export const DEFAULT_CONFIG = {
  paused: false,                 // true: keep recording, send no notifications
  // Who the models work for. name defaults to the name in the Teams sign-in; about is one line of
  // context for classifiers ("backend developer on the payments team").
  owner: { name: null, about: '', language: null },  // language: for summaries and verdict notes (default English)
  locale: null,                  // date/time format, e.g. "en-GB" (24h) or "en-US"; default: the system's
  notify: {
    delayMinutes: 3,             // wait this long; skip if the owner read it elsewhere meanwhile
    summary: 'llm',              // 'llm' (short model summary) or 'plain' (no message text at all)
    maxPerHour: 20,              // hard cap on notifications
    editOnRead: true,            // edit the message when the owner reads it in Teams (channels that can edit)
    // Channels (lib/notify.mjs): any of telegram, ntfy, webhook, command. null: telegram if its
    // credentials exist, else none (notifications are then only events for agents).
    channels: null,
    // TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment or this file (default <config>/telegram.env).
    telegram: { envFile: null },
    ntfy: { url: 'https://ntfy.sh', topic: null, token: null, priority: 3 },
    webhook: { url: null, headers: {} },
    command: { argv: null },
  },
  // Model calls (lib/llm.mjs). provider: claude-cli (default) | openai (any OpenAI-compatible API: set
  // baseUrl and model; key from apiKeyEnv, default OPENAI_API_KEY) | anthropic (ANTHROPIC_API_KEY) |
  // command (argv). model: null uses the provider's default (claude-cli: haiku).
  llm: { provider: 'claude-cli', command: 'claude', model: null, baseUrl: null, apiKeyEnv: null, argv: null,
    maxCallsPerHour: 200, maxReplayCallsPerHour: 300, timeoutSec: 90 },
  catchup: { maxAgeHours: 6, minIntervalMinutes: 10 },
  tokenRefresh: { beforeExpiryMinutes: 180 },
  // The browser that holds the Teams login (see `teams-bridge login`).
  browser: {
    path: null,                  // Chromium, Chrome or Edge; found automatically when null
    profile: null,               // user data dir; default <state>/browser-profile
    cdpPort: null,               // if a browser with this profile already runs with remote debugging, use it
  },
  login: { hint: 'Run: teams-bridge login' },  // shown in the "sign-in needed" alert
  drafts: {
    host: '127.0.0.1',           // approval pages; set 0.0.0.0 (and baseUrl) to open them from your phone
    port: 6095,
    baseUrl: null,               // default http://<host>:<port>
    expiresHours: 24,
    maxSendsPerDay: 10,
    maxFirstContactsPerDay: 3,   // drafts that start a new chat or are your first words to someone
  },
  spawn: { defaultVia: null },   // 't3' or 'agent' if your rules leave out spawn.via
  // Named groups of conversations (ids or title substrings), used in rules as "@name" in conv/not_conv.
  places: {},
};

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
}
export function loadConfig() {
  const user = existsSync(P.configFile) ? JSON.parse(readFileSync(P.configFile, 'utf8')) : {};
  return merge(DEFAULT_CONFIG, user);
}
export function saveConfigPatch(patch) {
  const user = existsSync(P.configFile) ? JSON.parse(readFileSync(P.configFile, 'utf8')) : {};
  writeFileSync(P.configFile, JSON.stringify(merge(user, patch), null, 2) + '\n');
}

// "~/x" in config values means the home folder.
export const expandHome = p => p && String(p).startsWith('~/') ? `${HOME}/${String(p).slice(2)}` : p;

export function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
export function writePrivate(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 1), { mode: 0o600 });
}

// The daemon logs to the journal; CLI and MCP processes stay quiet unless TEAMS_BRIDGE_VERBOSE is set.
export const log = (...a) => { if (process.env.TEAMS_BRIDGE_DAEMON || process.env.TEAMS_BRIDGE_VERBOSE) console.log(new Date().toISOString(), ...a); };

let _db;
export function db() {
  if (_db) return _db;
  if (!existsSync(P.db)) writeFileSync(P.db, '', { mode: 0o600 });
  _db = new DatabaseSync(P.db);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL,
      conv TEXT, msg_id TEXT, rule TEXT, data TEXT);
    CREATE INDEX IF NOT EXISTS events_kind ON events(kind, seq);
    CREATE TABLE IF NOT EXISTS messages (
      conv TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, version TEXT,
      sender_mri TEXT, sender_name TEXT, kind TEXT, messagetype TEXT, importance TEXT,
      subject TEXT, text TEXT, mentions_me INTEGER DEFAULT 0, from_me INTEGER DEFAULT 0,
      edited INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, reply_to TEXT, source TEXT, raw TEXT,
      PRIMARY KEY (conv, id));
    CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
    CREATE TABLE IF NOT EXISTS convs (
      id TEXT PRIMARY KEY, kind TEXT, title TEXT, title_checked INTEGER DEFAULT 0,
      my_horizon INTEGER DEFAULT 0, my_horizon_at INTEGER, last_msg INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS member_reads (
      conv TEXT, user_mri TEXT, horizon INTEGER, at INTEGER, PRIMARY KEY (conv, user_mri));
    CREATE TABLE IF NOT EXISTS verdicts (
      rule_key TEXT, conv TEXT, msg_id TEXT, fire INTEGER, label TEXT, confidence REAL, reason TEXT, at INTEGER,
      PRIMARY KEY (rule_key, conv, msg_id));
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, first_msg TEXT, last_msg TEXT,
      msg_ids TEXT, rules TEXT, state TEXT NOT NULL, due_at INTEGER, sent_at INTEGER,
      tg_chat TEXT, tg_message_id INTEGER, text TEXT, closed_at INTEGER);
    CREATE INDEX IF NOT EXISTS notifications_state ON notifications(state, due_at);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS people (
      mri TEXT PRIMARY KEY, name TEXT, name_norm TEXT, last_seen INTEGER, seen_in TEXT);
    CREATE TABLE IF NOT EXISTS subscriptions (
      name TEXT PRIMARY KEY, owner TEXT, rules TEXT, kinds TEXT, convs TEXT, cursor INTEGER NOT NULL,
      created_at INTEGER, last_read_at INTEGER);
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, reply_to TEXT, text TEXT NOT NULL,
      final_text TEXT, edited INTEGER DEFAULT 0, reason TEXT, agent TEXT, state TEXT NOT NULL,
      created_at INTEGER, expires_at INTEGER, decided_at INTEGER, sent_at INTEGER,
      token TEXT UNIQUE, nonce TEXT, tg_chat TEXT, tg_message_id INTEGER, error TEXT);
  `);
  // Additive migrations for databases created by earlier versions.
  for (const sql of ['ALTER TABLE drafts ADD COLUMN to_mri TEXT', 'ALTER TABLE drafts ADD COLUMN to_name TEXT',
    'ALTER TABLE drafts ADD COLUMN first_contact INTEGER DEFAULT 0', 'ALTER TABLE drafts ADD COLUMN never_written INTEGER DEFAULT 0',
    'ALTER TABLE notifications ADD COLUMN replies TEXT', 'ALTER TABLE notifications ADD COLUMN reply_due INTEGER', 'ALTER TABLE notifications ADD COLUMN reply_verdict TEXT'])
    try { _db.exec(sql); } catch { }
  return _db;
}

export function addEvent(kind, { conv = null, msgId = null, rule = null, data = null } = {}) {
  const r = db().prepare('INSERT INTO events (at, kind, conv, msg_id, rule, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, conv, msgId, rule, data == null ? null : JSON.stringify(data));
  return Number(r.lastInsertRowid);
}

export function kvGet(k, fallback = null) {
  const r = db().prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? JSON.parse(r.v) : fallback;
}
export function kvSet(k, v) {
  db().prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Lowercase without diacritics, so "Zolkiewski" finds "Żółkiewski".
export const norm = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase().trim();

// The owner's name for model prompts: config, else the name in the Teams token, else "the owner".
export function ownerName() {
  const c = loadConfig().owner;
  if (c?.name) return c.name;
  try { return JSON.parse(Buffer.from(readJson(P.token, {}).ic3.split('.')[1], 'base64url')).name || 'the owner'; } catch { return 'the owner'; }
}
export const ownerFirst = () => ownerName().split(/\s+/)[0];
export const ownerAbout = () => { const a = loadConfig().owner?.about; return a ? `${ownerName()} (${a})` : ownerName(); };

// Locale for every time shown to the owner (config locale, else the system default).
export const locale = () => loadConfig().locale || undefined;

export const sleep = ms => new Promise(r => setTimeout(r, ms));
