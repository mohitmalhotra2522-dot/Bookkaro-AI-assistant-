/*
 * BookKaro IRCTC Assist — background service worker.
 * Holds the ACTIVE handoff reference { apiBase, handoffId, bridgeToken } in chrome.storage.session (memory only,
 * cleared when the browser closes). Fetches the snapshot and posts METADATA-ONLY events to the BookKaro backend.
 * It never reads IRCTC cookies, never stores passwords / OTP / CAPTCHA / payment data, never calls IRCTC APIs.
 */
'use strict';
const TOKEN_HEADER = 'X-BookKaro-Bridge-Token';
const ALLOWED_API = [/^https:\/\/bookkaro-ai-assistant\.onrender\.com$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const SAFE_EVENT_KEYS = new Set(['type', 'page', 'filled', 'skipped', 'field', 'language']);

async function active() { return (await chrome.storage.session.get('handoff')).handoff || null; }

async function api(path, init) {
  const h = await active();
  if (!h) return { ok: false, code: 'NO_ACTIVE_HANDOFF' };
  const res = await fetch(`${h.apiBase}${path.replace(':id', encodeURIComponent(h.handoffId))}`, {
    ...init, headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: h.bridgeToken, ...(init && init.headers) }, credentials: 'omit', cache: 'no-store'
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, body } : { ok: false, code: body.code || `HTTP_${res.status}`, message: body.message };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'BK_REGISTER') {
      const origin = sender.origin || (sender.url ? new URL(sender.url).origin : '');
      if (!ALLOWED_API.some(re => re.test(origin))) return sendResponse({ ok: false, code: 'ORIGIN_NOT_ALLOWED' });
      if (!/^irh_[0-9a-f-]{36}$/.test(String(msg.handoffId)) || !/^[0-9a-f]{64}$/.test(String(msg.bridgeToken))) return sendResponse({ ok: false, code: 'INVALID_HANDOFF' });
      await chrome.storage.session.set({ handoff: { apiBase: origin, handoffId: msg.handoffId, bridgeToken: msg.bridgeToken, registeredAt: Date.now() } });
      const snap = await api('/api/irctc/handoff/:id', { method: 'GET' });
      return sendResponse(snap.ok ? { ok: true, status: snap.body.status } : snap);
    }
    if (msg && msg.type === 'BK_GET_SNAPSHOT') return sendResponse(await api('/api/irctc/handoff/:id', { method: 'GET' }));
    if (msg && msg.type === 'BK_EVENT') {
      const ev = msg.event || {};
      if (Object.keys(ev).some(k => !SAFE_EVENT_KEYS.has(k))) return sendResponse({ ok: false, code: 'INVALID_EVENT' });
      return sendResponse(await api('/api/irctc/handoff/:id/events', { method: 'POST', body: JSON.stringify(ev) }));
    }
    if (msg && msg.type === 'BK_CLEAR') { await chrome.storage.session.remove('handoff'); return sendResponse({ ok: true }); }
    if (msg && msg.type === 'BK_STATUS') { const h = await active(); return sendResponse({ ok: true, active: !!h, handoffId: h ? h.handoffId : null, apiBase: h ? h.apiBase : null }); }
    sendResponse({ ok: false, code: 'UNKNOWN_MESSAGE' });
  })();
  return true;
});
