// Teams specifics: the ic3 token, the chat service API, and turning raw pushes into normalized messages.
import { P, readJson, htmlToText } from './core.mjs';

// The Teams web build this presents. Taken from the web app at each token refresh; this is the
// fallback (the build seen in November 2026).
const FALLBACK_CLIENT_V = '1415/26101515216';
export const clientVersion = () => readJson(P.token, {}).clientVersion || FALLBACK_CLIENT_V;
const DEFAULT_CHATSVC = 'https://teams.cloud.microsoft/api/chatsvc/amer';

export function tokenInfo() {
  const t = readJson(P.token, null);
  if (!t?.ic3) return { ok: false, reason: 'no token, run: teams-bridge login' };
  // Renewal is driven by whichever of the ic3 and presence tokens expires first.
  const leftMin = Math.round((Math.min(t.exp, t.presenceExp || t.exp) * 1000 - Date.now()) / 60e3);
  return { ok: leftMin > 2, leftMin, exp: t.exp, oid: t.oid, tid: t.tid, chatsvc: t.chatsvc || DEFAULT_CHATSVC, savedAt: t.savedAt };
}
export function token() {
  const t = readJson(P.token, null);
  if (!t?.ic3) throw new Error('no ic3 token');
  if (t.exp * 1000 < Date.now() + 120e3) throw new Error(`ic3 token expired at ${new Date(t.exp * 1000).toISOString()}`);
  return t.ic3;
}
export const myMri = () => `8:orgid:${readJson(P.token, {}).oid}`;
const chatsvc = () => readJson(P.token, {}).chatsvc || DEFAULT_CHATSVC;

const enc = s => encodeURIComponent(s);
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${chatsvc()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'x-ms-migration': 'True', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`chatsvc ${method} ${path.split('?')[0]} -> ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}

// Read-only calls. None of these change read state or presence.
export const listConversations = (pageSize = 30) => api(`/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=${pageSize}`);
export const getConversation = id => api(`/v1/users/ME/conversations/${enc(id)}?view=msnp24Equivalent`);
export const getThread = id => api(`/v1/threads/${enc(id)}?view=msnp24Equivalent`);
export const listMessages = (id, { pageSize = 20, startTime = 0 } = {}) =>
  api(`/v1/users/ME/conversations/${enc(id)}/messages?view=msnp24Equivalent|supportsMessageProperties&pageSize=${pageSize}&startTime=${startTime}`);

// Writes. There are exactly two ways to post:
//  - sendToOwnNotes: the owner's own Notes chat, for pipeline tests;
//  - postApprovedDraft: a draft the owner approved on the approval page (lib/drafts.mjs checks the
//    approval, the exact text hash and the daily cap before calling it).
const toHtml = text => text.split(/\r?\n/).map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>');
async function post(conv, text) {
  const clientmessageid = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const r = await api(`/v1/users/ME/conversations/${enc(conv)}/messages`, {
    method: 'POST',
    body: { content: `<p>${toHtml(text)}</p>`, messagetype: 'RichText/Html', contenttype: 'text', clientmessageid, imdisplayname: '', properties: { importance: '', subject: null } },
  });
  return { clientmessageid, arrival: r?.OriginalArrivalTime };
}
export const sendToOwnNotes = text => post('48:notes', text);
// A 1:1 chat that does not exist yet: create the thread (the way the Teams client does), then post.
async function createOneOnOne(otherMri) {
  const me = myMri();
  const r = await fetch(`${chatsvc()}/v1/threads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'x-ms-migration': 'True', 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: [{ id: me, role: 'Admin' }, { id: otherMri, role: 'Admin' }], properties: { threadType: 'chat', fixedRoster: 'true', uniquerosterthread: 'true' } }),
  });
  if (!r.ok) throw new Error(`creating the chat failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
  const loc = r.headers.get('location') || '';
  return decodeURIComponent(loc.split('/threads/').pop() || '') || null;
}

export async function postApprovedDraft(draft, approval) {
  if (!approval || approval.draftId !== draft.id || approval.state !== 'approved') throw new Error('refused: draft not approved');
  if (draft.first_contact && draft.to_mri) {
    try { return await post(draft.conv, draft.final_text); }
    catch (e) {
      if (!/-> (400|403|404)/.test(e.message)) throw e;
      const created = await createOneOnOne(draft.to_mri);
      return post(created || draft.conv, draft.final_text);
    }
  }
  // A channel reply goes to the thread of its root post.
  const conv = draft.reply_to && /@thread\.(tacv2|skype)$/.test(draft.conv) ? `${draft.conv};messageid=${draft.reply_to}` : draft.conv;
  return post(conv, draft.final_text);
}

// Conversation kind from its id and thread type.
export function convKind(id, threadtype) {
  id = String(id || '').split(';')[0];
  if (id === '48:notes' || threadtype === 'streamofnotes') return 'self';
  if (/^48:/.test(id)) return 'system'; // 48:notifications, 48:mentions, ...: Teams' own feeds
  if (/^19:meeting_/.test(id) || threadtype === 'meeting') return 'meeting';
  if (/@thread\.(tacv2|skype)$/.test(id) || threadtype === 'topic' || threadtype === 'space') return 'channel';
  if (/@unq\.gbl\.spaces$/.test(id)) return 'dm';
  if (threadtype === 'chat' || /@thread\.v2$/.test(id)) return 'group';
  return 'other';
}

const HUMAN = /^(Text|RichText(\/Html|\/Media_.*|\/UriObject)?)$/;
export const isHumanMessage = mt => HUMAN.test(mt || '');

function parseJsonMaybe(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } }

// Normalize a chat service message resource (from a push or from listMessages).
export function normalizeMessage(r, me = myMri()) {
  // Channel replies live in "<channel>;messageid=<root post id>": keep the channel as the conversation.
  const rawConv = (r.conversationLink || '').split('/').pop() || r.conversationid || r.conversationId || '';
  const [conv, threadPart] = rawConv.split(';');
  const threadRoot = /^messageid=(\d+)/.exec(threadPart || '')?.[1] || null;
  const senderMri = (r.from || '').split('/').pop();
  const props = r.properties || {};
  const mentions = parseJsonMaybe(props.mentions) || [];
  const meId = me.split(':').pop();
  const mentionsMe = Array.isArray(mentions) && mentions.some(m => String(m.mri || m.mentionedId || '').endsWith(meId));
  const text = r.messagetype === 'Text' ? String(r.content || '') : htmlToText(r.content);
  return {
    conv, id: String(r.id), ts: Date.parse(r.originalarrivaltime || r.composetime || 0) || Number(r.id),
    version: String(r.version || ''), senderMri, senderName: r.imdisplayname || r.fromDisplayNameInToken || '',
    threadtype: r.threadtype, kind: convKind(conv, r.threadtype), messagetype: r.messagetype,
    importance: props.importance || '', subject: props.subject || r.threadtopic || '', text,
    mentionsMe: !!mentionsMe, fromMe: senderMri === me,
    edited: !!props.edittime, deleted: !!props.deletetime,
    replyTo: r.parentMessageId || r.replyToId || (threadRoot && threadRoot !== String(r.id) ? threadRoot : null),
    threadTopic: r.threadtopic || null,
  };
}

// "lastReadId;timestamp;clientmsgid" -> lastReadId as a number.
export const horizonId = h => Number(String(h || '').split(';')[0]) || 0;
