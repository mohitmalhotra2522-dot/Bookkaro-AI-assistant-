/*
 * BookKaro Android (P40) — IRCTC WebView adapter.
 *
 * Injected natively at document start ONLY into the approved IRCTC origin (WebViewCompat.addDocumentStartJavaScript
 * with an origin allow-list); the native message channel `BookKaroIrctc` exists only for that origin too.
 * It gives the desktop extension's own, unmodified page logic (irctc-handoff-guard.js, irctc-core.js,
 * irctc-content.js — inserted below at build time) the tiny `chrome.runtime` surface it uses:
 *   sendMessage({type:'BK_GET_SNAPSHOT'|'BK_EVENT'|'BK_CLEAR'|'BK_STATUS'}, cb)  → native controller
 *   getManifest().version
 * The bridge token never reaches this page: the native side fetches + verifies the signed snapshot (schema, binding,
 * expiry, HMAC) and returns only the validated booking data the page fields need.
 * Same boundaries as desktop: never touches login / CAPTCHA / OTP / payment fields; never clicks passenger Continue,
 * review Continue, OTP Submit or Pay & Book.
 */
(function () {
  'use strict';
  if (window.top !== window) return;                         // main frame only (native also rejects sub-frame messages)
  var port = window.BookKaroIrctc;
  if (!port || typeof port.postMessage !== 'function') return;
  if (window.__bookkaroAndroidAdapter) return;
  window.__bookkaroAndroidAdapter = true;
  try { delete window.BookKaroIrctc; } catch (e) { /* not deletable on every WebView version */ }

  var pending = {};
  var seq = 0;
  port.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    var cb = m && pending[m.id];
    if (!cb) return;
    delete pending[m.id];
    try { cb(m.body); } catch (x) { /* page logic error — never surfaces data */ }
  };

  // eslint-disable-next-line no-unused-vars
  var chrome = {
    runtime: {
      id: 'bookkaro-android',
      getManifest: function () { return { version: '__BOOKKARO_ANDROID_VERSION__' }; },
      sendMessage: function (msg, cb) {
        var id = ++seq;
        pending[id] = typeof cb === 'function' ? cb : function () {};
        port.postMessage(JSON.stringify({ id: id, msg: msg }));
      }
    }
  };

  function start() {
    // the shared files are UMD: make sure they attach to `window`, whatever the page defines globally
    // eslint-disable-next-line no-unused-vars
    var module = undefined, exports = undefined, define = undefined;
/*__BOOKKARO_GUARD__*/
/*__BOOKKARO_CORE__*/
/*__BOOKKARO_CONTENT__*/
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
