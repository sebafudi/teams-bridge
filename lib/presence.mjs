// The owner's Teams status: read it, force one (like the status menu in Teams), reset it, and set
// the status note. Uses the presence token captured during token refresh.
import { P, readJson, addEvent } from './core.mjs';

export const STATUSES = {
  available: { availability: 'Available', activity: 'Available' },
  busy: { availability: 'Busy', activity: 'Busy' },
  dnd: { availability: 'DoNotDisturb', activity: 'DoNotDisturb' },
  brb: { availability: 'BeRightBack', activity: 'BeRightBack' },
  away: { availability: 'Away', activity: 'Away' },
  offline: { availability: 'Offline', activity: 'OffWork' }, // "Appear offline"
};

function auth() {
  const t = readJson(P.token, {});
  if (!t.presence) throw new Error('no presence token yet; run: teams-bridge token refresh');
  if (t.presenceExp * 1000 < Date.now() + 60e3) throw new Error('presence token expired; run: teams-bridge token refresh');
  return { token: t.presence, base: t.ups || 'https://teams.cloud.microsoft/ups/noam/v1', mri: `8:orgid:${t.oid}` };
}

async function call(method, path, body) {
  const { token, base } = auth();
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`presence ${path} -> ${r.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

const nameOf = availability => Object.entries(STATUSES).find(([, v]) => v.availability === availability)?.[0] || availability;

export async function getPresence() {
  const { mri } = auth();
  const [p] = await call('POST', '/presence/getpresence/', [{ mri }]);
  const pr = p?.presence || {};
  const f = pr.forcedAvailability;
  const forcedActive = f && Date.parse(f.expiry) > Date.now();
  return {
    shown: nameOf(pr.availability), availability: pr.availability, activity: pr.activity,
    forced: forcedActive ? { status: nameOf(f.availability), until: f.expiry.startsWith('9999') ? null : f.expiry, since: f.publishTime } : null,
    note: pr.note?.message ? { text: pr.note.message, until: pr.note.expiry?.startsWith('9999') ? null : pr.note.expiry } : null,
    out_of_office: !!pr.calendarData?.isOutOfOffice, last_active: pr.lastActiveTime || null,
  };
}

// until: Date or null (no expiry). Teams falls back to the real device status when it expires.
export async function setStatus(name, until = null) {
  const s = STATUSES[name];
  if (!s) throw new Error(`status must be one of ${Object.keys(STATUSES).join(', ')}`);
  await call('PUT', '/me/forceavailability/', { ...s, ...(until ? { desiredExpirationTime: until.toISOString() } : {}) });
  addEvent('presence_set', { data: { status: name, until: until?.toISOString() || null } });
  return getPresence();
}

// Teams has no delete for a forced status here; re-applying it with an expiry a few seconds away
// lets it lapse, which is what "Reset status" does in effect.
export async function resetStatus() {
  const cur = await getPresence();
  if (!cur.forced) return cur;
  await call('PUT', '/me/forceavailability/', { ...STATUSES[cur.forced.status] || STATUSES.available, desiredExpirationTime: new Date(Date.now() + 5e3).toISOString() });
  addEvent('presence_reset', {});
  await new Promise(r => setTimeout(r, 7e3));
  return getPresence();
}

export async function setNote(text, until = null) {
  await call('PUT', '/me/publishnote', { message: text || '', expiry: (until || new Date('9999-12-31T23:59:59.999Z')).toISOString() });
  addEvent('presence_note', { data: { cleared: !text, until: until?.toISOString() || null } });
  return getPresence();
}

// "90m", "2h", "1d", "17:30" (today, or tomorrow if past) -> Date
export function parseUntil(s) {
  if (!s) return null;
  let m = /^(\d+)\s*(m|min|h|d)$/i.exec(s);
  if (m) return new Date(Date.now() + Number(m[1]) * { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()]);
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) { const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d; }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot read time "${s}" (use 90m, 2h, 1d, 17:30 or an ISO date)`);
  return d;
}
