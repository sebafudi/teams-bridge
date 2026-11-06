// Get a fresh ic3 token from the logged-in Teams web profile without looking online or reading chats.
// Uses a browser that already runs with this profile and remote debugging (browser.cdpPort), else
// starts Chromium/Chrome/Edge on the profile, headless (refresh) or as a window (`teams-bridge login`).
// While Teams loads, every presence, push-channel and read-marker call is blocked, and so is every
// write except sign-in. The first ic3 bearer the app sends is saved.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readlinkSync, mkdirSync } from 'node:fs';
import { P, readJson, writePrivate, log, sleep, loadConfig } from './core.mjs';

const HOME = process.env.HOME;
const expand = p => p && p.startsWith('~/') ? `${HOME}/${p.slice(2)}` : p;
export const profileDir = () => expand(process.env.TEAMS_BRIDGE_PROFILE || loadConfig().browser?.profile) || `${P.state}/browser-profile`;

const CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  win32: [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`],
};
const ON_PATH = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser'];
export function browserPath() {
  const cfg = expand(loadConfig().browser?.path) || process.env.CHROME_PATH;
  if (cfg) return cfg;
  for (const c of CANDIDATES[process.platform] || []) if (existsSync(c)) return c;
  for (const n of ON_PATH) { try { return execFileSync('which', [n], { encoding: 'utf8' }).trim(); } catch { } }
  throw new Error('no Chromium, Chrome or Edge found; set browser.path in config.json');
}
// Headless Chromium announces itself as HeadlessChrome, which Teams rejects; present the normal UA.
function userAgent(bin) {
  let major = '140';
  try { major = /(\d+)\.\d+\.\d+/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10e3 }))[1]; } catch { }
  const os = { darwin: 'Macintosh; Intel Mac OS X 10_15_7', win32: 'Windows NT 10.0; Win64; x64' }[process.platform] || 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
const OWN_PORT = 9241;
const BLOCK = /trouter|\/ups\/|\/endpoints|consumptionhorizon|\/registrar\/|presence|augloop|\/activity|properties\?name=|pubsub/i;
const ALLOW_WRITE = /login\.microsoftonline\.com|login\.windows\.net|login\.live\.com|\/skypetokenauth|\/aadtokenauth|\/authz|\/cookiev2|config\.teams\.microsoft\.com/i;
const CLEAR_SCRIPT = `(() => { try {
  if (window.top !== window || !/teams\\.(cloud\\.)?microsoft/.test(location.host) || sessionStorage.getItem('tb_cleared')) return;
  sessionStorage.setItem('tb_cleared', '1');
  for (const k of Object.keys(localStorage))
    if ((/accesstoken/i.test(k) && /ic3\\.teams\\.office\\.com|presence\\.teams\\.microsoft\\.com/i.test(k)) || /^tmp\\.auth\\.v1\\..*(IC3\\.TEAMS\\.OFFICE\\.COM|PRESENCE\\.TEAMS\\.MICROSOFT\\.COM)/i.test(k)) localStorage.removeItem(k);
} catch (e) {} })();`;

// SingletonLock is a symlink "host-pid"; a crashed browser can leave it behind. Chromium clears a stale one itself.
function lockHolderAlive(profile) {
  try { const pid = Number(readlinkSync(`${profile}/SingletonLock`).split('-').pop()); if (!(pid > 0)) return false; process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const claims = t => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url')); } catch { return null; } };
const up = async port => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } };

export async function refreshToken({ force = true, timeoutSec = 120, headed = false } = {}) {
  const old = readJson(P.token, {});
  const PROFILE = profileDir(), cdpPort = loadConfig().browser?.cdpPort;
  let browser = cdpPort && !headed ? await up(cdpPort) : null, proc = null, mode = 'attached';
  if (!browser) {
    if (!headed && !existsSync(PROFILE)) throw new Error(`no Teams profile at ${PROFILE}; run: teams-bridge login`);
    if (lockHolderAlive(PROFILE)) throw new Error(`the browser profile ${PROFILE} is open in another browser; close it${cdpPort ? ` or start it with --remote-debugging-port=${cdpPort}` : ''}`);
    mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
    const bin = browserPath();
    mode = headed ? 'window' : 'headless';
    const flags = [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${OWN_PORT}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check'];
    if (!headed) flags.push('--headless=new', '--disable-gpu', `--user-agent=${userAgent(bin)}`);
    proc = spawn(bin, [...flags, 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 75 && !(browser = await up(OWN_PORT)); i++) await sleep(200);
    if (!browser) { proc.kill(); throw new Error(`${mode} browser did not start (${bin})`); }
  }
  const ws = new WebSocket(browser.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
  let id = 0; const pend = new Map();
  const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  let result = null, chatsvc = old.chatsvc, ups = old.ups, clientVersion = null, onLogin = 0, blocked = 0, lastUrl = '', ic3 = null, presence = null;
  const done = new Promise(resolve => {
    const finish = r => { if (!result) { result = r; resolve(r); } };
    ws.onmessage = async e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); return; }
      const s = m.sessionId;
      if (m.method === 'Target.attachedToTarget') {
        const cs = m.params.sessionId;
        await send('Network.enable', {}, cs);
        await send('Network.setBlockedURLs', { urls: ['*trouter*', '*augloop*'] }, cs);
        await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, cs);
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, cs);
        await send('Runtime.runIfWaitingForDebugger', {}, cs);
      }
      if (m.method === 'Fetch.requestPaused') {
        const r = m.params.request;
        const cm = /^(https:\/\/[^/]+\/api\/chatsvc\/[a-z]+)\//.exec(r.url); if (cm) chatsvc = cm[1];
        const um = /^(https:\/\/[^/]+\/ups\/[a-z]+\/v1)\//.exec(r.url); if (um) ups = um[1];
        // The web app's build ("1415/26101515216"); the daemon presents the same one to the registrar.
        const cv = r.headers['x-ms-client-version']; if (cv && /^\d+\/\d+$/.test(cv)) clientVersion = cv;
        const a = r.headers.Authorization || r.headers.authorization || '';
        if (a.startsWith('Bearer ')) {
          const c = claims(a.slice(7));
          if (process.env.TEAMS_BRIDGE_DEBUG) console.error('bearer', c?.aud, `${Math.round((c?.exp * 1000 - Date.now()) / 60e3)}m`, new URL(r.url).host + new URL(r.url).pathname.slice(0, 40));
          // Accept a token that is fresh enough; whether MSAL renewed it or reused a cached one does not matter.
          if (c?.aud === 'https://ic3.teams.office.com' && c.exp * 1000 > Date.now() + (force ? 12 * 3600e3 : 120e3))
            if (!ic3) { ic3 = { ic3: a.slice(7), exp: c.exp, oid: c.oid, tid: c.tid }; setTimeout(() => finish({ ...ic3, ...(presence || {}) }), 25e3); }
          // Prefer a fresh presence token; a stale cached one is kept only if nothing better comes.
          if (c?.aud === 'https://presence.teams.microsoft.com/' && (!presence || c.exp > presence.presenceExp)) presence = { presence: a.slice(7), presenceExp: c.exp };
          if (ic3 && presence && presence.presenceExp * 1000 > Date.now() + (force ? 12 * 3600e3 : 120e3)) finish({ ...ic3, ...presence });
        }
        const write = r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'OPTIONS';
        if (BLOCK.test(r.url) || (write && !ALLOW_WRITE.test(r.url))) { blocked++; send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, s); }
        else send('Fetch.continueRequest', { requestId: m.params.requestId }, s);
      }
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
        lastUrl = m.params.frame.url.split('?')[0];
        if (/login\.microsoftonline\.com|login\.live\.com/.test(m.params.frame.url)) onLogin ||= Date.now(); else onLogin = 0;
      }
    };
    setTimeout(() => finish({ error: `timeout (last page ${lastUrl || 'none'})` }), timeoutSec * 1000);
    const iv = setInterval(() => { if (!headed && onLogin && Date.now() - onLogin > 20e3) finish({ error: 'login_required' }); if (result) clearInterval(iv); }, 1000);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', background: !headed });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Network.setBlockedURLs', { urls: ['*trouter*', '*augloop*'] }, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  if (force) await send('Page.addScriptToEvaluateOnNewDocument', { source: CLEAR_SCRIPT }, sessionId);
  await send('Page.navigate', { url: 'https://teams.cloud.microsoft/v2/' }, sessionId);
  const r = await done;
  await send('Target.closeTarget', { targetId }).catch(() => { });
  ws.close();
  if (proc) { proc.kill('SIGTERM'); await sleep(1500); if (proc.exitCode == null) proc.kill('SIGKILL'); }
  if (r.error) { log('token refresh failed', r.error, mode, `blocked ${blocked}`); return { ok: false, error: r.error, mode }; }
  writePrivate(P.token, { ...r, chatsvc, ups, clientVersion: clientVersion || old.clientVersion, savedAt: Date.now(), via: mode });
  log('token refreshed', mode, 'expires', new Date(r.exp * 1000).toISOString(), `blocked ${blocked}`);
  return { ok: true, mode, exp: r.exp, blocked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshToken({ force: !process.argv.includes('--no-force') }).then(r => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
}
