// teams-bridge daemon: receives Teams pushes over Trouter the way the web client does, without the
// web app. It never sends user.activity, never registers presence and never marks anything read.
import { randomUUID } from 'node:crypto';
import { P, readJson, writePrivate, log, addEvent, loadConfig, kvGet, kvSet } from './core.mjs';
import { token, tokenInfo, CLIENT_V } from './teams.mjs';
import { handlePush, catchUp, processNotifications, prune } from './engine.mjs';
import { refreshToken } from './token-refresh.mjs';
import * as tg from './telegram.mjs';
import { startApprovalServer, expireDrafts } from './drafts.mjs';

const TC = JSON.stringify({ cv: '2026.40.01.1', ua: 'TeamsCDL', hr: '', v: CLIENT_V });
const REGISTRAR = 'https://teams.cloud.microsoft/registrar/prod/V2/registrations';

const state = readJson(P.listener, {});
state.epid ||= randomUUID(); state.registrationId ||= randomUUID();
const save = () => writePrivate(P.listener, state);
save();

async function register(surl) {
  const body = {
    clientDescription: { appId: 'TeamsCDLWebWorker', aesKey: '', languageId: 'en-US', platform: 'chrome', templateKey: 'TeamsCDLWebWorker_2.7', platformUIVersion: CLIENT_V },
    registrationId: state.registrationId, nodeId: '', transports: { TROUTER: [{ context: '', path: surl, ttl: 3600 }] },
  };
  const r = await fetch(REGISTRAR, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json, text/javascript', 'X-MS-Migration': 'True' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`registrar ${r.status} ${(await r.text()).slice(0, 200)}`);
  kvSet('last_registration', Date.now());
}

let conNum = 0, backoff = 2, socket = null, lastFrame = Date.now(), connectedAt = 0;
function connect() {
  let tok; try { tok = token(); } catch (e) { authProblem(e.message); setTimeout(connect, 5 * 60e3); return; }
  conNum++;
  const base = state.reconnectUrl || 'wss://go.trouter.teams.microsoft.com/v4/c';
  const q = new URLSearchParams({ tc: TC, timeout: '40', epid: state.epid, ccid: state.ccid || '', cor_id: randomUUID(), con_num: `${Date.now()}_${conNum}` });
  const ws = socket = new WebSocket(`${base}?${q}`);
  let seq = 0, pinger, rereg, opened = false;
  const emit = (name, args) => ws.send(`5:${++seq}+::${JSON.stringify(args ? { name, args } : { name })}`);
  ws.onopen = () => { opened = true; };
  ws.onmessage = async ({ data }) => {
    lastFrame = Date.now();
    const s = String(data);
    if (s.startsWith('1::')) {
      const auth = { headers: { Authorization: `Bearer ${tok}`, 'X-MS-Migration': 'True' } };
      if (state.connectparams) auth.connectparams = state.connectparams;
      ws.send(`5:::${JSON.stringify({ name: 'user.authenticate', args: [auth] })}`);
      return;
    }
    if (s.startsWith('5:')) {
      let ev; try { ev = JSON.parse(s.slice(s.indexOf('{'))); } catch { return; }
      if (ev.name === 'trouter.connected') {
        const c = ev.args[0];
        Object.assign(state, { ccid: c.ccid, connectparams: c.connectparams, reconnectUrl: c.reconnectUrl, surl: c.surl }); save();
        connectedAt = Date.now(); backoff = 2;
        log('connected', new URL(c.surl).host);
        try { await register(c.surl); log('registered'); } catch (e) { log('ERROR', e.message); addEvent('error', { data: { where: 'registrar', error: e.message } }); }
        rereg = setInterval(() => register(c.surl).catch(e => log('ERROR', e.message)), 50 * 60e3);
        pinger = setInterval(() => { try { emit('ping'); } catch { } }, 30e3);
        addEvent('connected', { data: { host: new URL(c.surl).host } });
      } else if (ev.name === 'trouter.message_loss') {
        emit('trouter.processed_message_loss', ev.args);
        const tags = (ev.args[0]?.droppedIndicators || []).map(d => d.tag);
        if (tags.includes('messaging')) catchUp({ reason: 'message_loss' });
      } else if (ev.name !== 'trouter.connected') log('event', ev.name);
      return;
    }
    if (s.startsWith('3:::')) {
      let req; try { req = JSON.parse(s.slice(4)); } catch { return; }
      ws.send(`3:::${JSON.stringify({ id: req.id, status: 200, headers: { 'MS-CV': req.headers?.['MS-CV'] || '', 'trouter-request': req.headers?.['trouter-request'] || '' }, body: '' })}`);
      const path = (req.url || '').split('/').pop();
      try { await handlePush(path, req.body); } catch (e) { log('ERROR push', e.message); }
    }
  };
  ws.onclose = e => {
    clearInterval(pinger); clearInterval(rereg);
    if (socket === ws) socket = null;
    // A connect that never got going after a reconnectUrl: start fresh from the global endpoint.
    if (!opened || Date.now() - connectedAt < 5e3) { delete state.reconnectUrl; delete state.connectparams; save(); }
    log('socket closed', e.code, e.reason || '', `retry in ${backoff}s`);
    addEvent('disconnected', { data: { code: e.code } });
    setTimeout(connect, backoff * 1000); backoff = Math.min(backoff * 2, 300);
  };
  ws.onerror = () => { };
}

// Silent socket: Trouter answers pings, so no frame for 3 minutes means a dead connection.
setInterval(() => { if (socket && Date.now() - lastFrame > 180e3) { log('socket silent, reconnecting'); try { socket.close(); } catch { } } }, 30e3);

// ---------- token upkeep ----------

let refreshing = false;
async function authProblem(msg) {
  log('AUTH', msg);
  const last = kvGet('auth_alert_at', 0);
  addEvent('auth_problem', { data: { error: msg } });
  if (Date.now() - last > 6 * 3600e3) {
    kvSet('auth_alert_at', Date.now());
    try { await tg.send(`⚠️ <b>teams-bridge</b>: Teams sign-in needs you (${tg.esc(msg)}).\n${tg.esc(loadConfig().login?.hint || 'Run: teams-bridge login')}`); } catch (e) { log('ERROR telegram', e.message); }
  }
}

async function tokenUpkeep() {
  if (refreshing) return;
  const t = tokenInfo(), cfg = loadConfig();
  if (t.ok && t.leftMin > cfg.tokenRefresh.beforeExpiryMinutes) return;
  const lastTry = kvGet('token_refresh_try', 0);
  if (Date.now() - lastTry < 20 * 60e3) return;
  kvSet('token_refresh_try', Date.now());
  refreshing = true;
  try {
    const r = await refreshToken({ force: true });
    addEvent(r.ok ? 'token_refreshed' : 'token_refresh_failed', { data: r });
    if (r.ok) { kvSet('auth_alert_at', 0); if (socket) socket.close(); } // reconnect with the new token
    else if (r.error === 'login_required' || !t.ok || t.leftMin < 30) authProblem(r.error === 'login_required' ? 'login required' : `token refresh failed: ${r.error}`);
  } catch (e) {
    log('ERROR token refresh', e.message);
    addEvent('token_refresh_failed', { data: { error: e.message } });
    if (!t.ok || t.leftMin < 30) authProblem(e.message);
  } finally { refreshing = false; }
}

setInterval(() => processNotifications().catch(e => log('ERROR notify', e.message)), 15e3);
setInterval(() => { try { prune(); } catch (e) { log('ERROR prune', e.message); } }, 6 * 3600e3);

// Outage alert: no working push connection for 20 minutes (and not just an expired token, which has its own alert).
let downSince = null;
setInterval(async () => {
  const up = socket && connectedAt && Date.now() - lastFrame < 180e3;
  if (up) { if (downSince && kvGet('outage_alerted', false)) { kvSet('outage_alerted', false); tg.send('✅ <b>teams-bridge</b>: connected to Teams again.', { silent: true }).catch(() => { }); } downSince = null; return; }
  downSince ||= Date.now();
  if (Date.now() - downSince > 20 * 60e3 && !kvGet('outage_alerted', false) && tokenInfo().ok) {
    kvSet('outage_alerted', true);
    addEvent('outage', { data: { since: new Date(downSince).toISOString() } });
    tg.send(`⚠️ <b>teams-bridge</b>: no connection to Teams since ${new Date(downSince).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Messages are not being received. Check: <code>teams-bridge status</code> and the daemon log.`).catch(e => log('ERROR telegram', e.message));
  }
}, 60e3);
kvSet('heartbeat', Date.now());
setInterval(() => kvSet('heartbeat', Date.now()), 60e3);
setInterval(() => expireDrafts().catch(e => log('ERROR drafts', e.message)), 60e3);
startApprovalServer();
setInterval(() => tokenUpkeep(), 10 * 60e3);
tokenUpkeep().finally(() => { connect(); setTimeout(() => catchUp({ reason: 'startup', force: true }), 5e3); });
log('teams-bridge daemon started', `epid ${state.epid.slice(0, 8)}`);
