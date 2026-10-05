'use strict';
const el = document.getElementById('status');
function refresh() {
  chrome.runtime.sendMessage({ type: 'BK_STATUS' }, (r) => {
    el.textContent = r && r.active ? `Active handoff: ${r.handoffId} (from ${r.apiBase})` : 'Koi active handoff nahi. BookKaro mein review confirm karke “Continue to IRCTC” dabaiye.';
  });
}
document.getElementById('clear').onclick = () => chrome.runtime.sendMessage({ type: 'BK_CLEAR' }, refresh);
refresh();
