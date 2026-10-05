/*
 * BookKaro IRCTC Assist — bridge on the BookKaro app origin.
 * The BookKaro page posts { source:'bookkaro-app', type:'BK_IRCTC_HANDOFF', handoffId, bridgeToken } to itself;
 * only same-window, same-origin messages are accepted and forwarded to the extension background.
 */
'use strict';
(function () {
  const reply = (m) => window.postMessage({ source: 'bookkaro-extension', ...m }, window.location.origin);
  reply({ type: 'BK_EXTENSION_READY', version: chrome.runtime.getManifest().version });
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data || {};
    if (d.source !== 'bookkaro-app') return;
    if (d.type === 'BK_PING') return reply({ type: 'BK_EXTENSION_READY', version: chrome.runtime.getManifest().version });
    if (d.type !== 'BK_IRCTC_HANDOFF') return;
    chrome.runtime.sendMessage({ type: 'BK_REGISTER', handoffId: d.handoffId, bridgeToken: d.bridgeToken }, (r) => {
      reply({ type: 'BK_IRCTC_HANDOFF_ACK', ok: !!(r && r.ok), code: r && r.code, status: r && r.status });
    });
  });
})();
