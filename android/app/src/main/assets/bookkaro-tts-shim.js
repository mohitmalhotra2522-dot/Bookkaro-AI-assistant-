/*
 * BookKaro Android (P40.1) — speechSynthesis for the EXISTING BookKaro web voice flow.
 *
 * Android System WebView exposes window.speechSynthesis but has no speech engine behind it, so BookKaro's spoken
 * replies (which work in Chrome through the phone's system TTS) were silent in the app. Injected natively at document
 * start ONLY into the BookKaro origin (WebViewCompat.addDocumentStartJavaScript with an origin allow-list), this shim
 * gives the unchanged web code the same speechSynthesis / SpeechSynthesisUtterance surface and forwards each utterance
 * over the origin-restricted `BookKaroAndroid` bridge to the phone's system TTS (Android TextToSpeech — the engine Chrome
 * uses). No new TTS provider, no network, nothing stored or logged. Only speak / cancel exist on the bridge.
 */
(function () {
  'use strict';
  if (window.top !== window) return;                         // main frame only (native also rejects sub-frame messages)
  function bridge() {
    var p = window.BookKaroAndroid;
    return p && typeof p.postMessage === 'function' && typeof p.addEventListener === 'function' ? p : null;
  }
  if (bridge()) install(bridge());
  else document.addEventListener('DOMContentLoaded', function () { if (bridge()) install(bridge()); }, { once: true });

  function install(port) {
  if (window.__bookkaroTtsShim) return;
  window.__bookkaroTtsShim = true;

  var MAX_CHARS = 3900;
  var LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
  var seq = 0;
  var queue = [];            // utterances handed to the engine and not finished yet (head = speaking)
  var byId = {};

  function later(fn) { setTimeout(fn, 0); }
  function fire(u, type, extra) {
    var ev = { type: type, utterance: u, charIndex: 0, charLength: 0, elapsedTime: 0, name: '' };
    if (extra) for (var k in extra) ev[k] = extra[k];
    try { if (typeof u['on' + type] === 'function') u['on' + type].call(u, ev); } catch (e) { /* page handler error */ }
    var ls = (u.__bkListeners[type] || []).slice();
    for (var i = 0; i < ls.length; i++) { try { ls[i].call(u, ev); } catch (e) { /* page handler error */ } }
  }
  function sync() { synth.speaking = queue.length > 0; synth.pending = queue.length > 1; }
  function finish(u) {
    for (var id in byId) if (byId[id] === u) delete byId[id];
    var i = queue.indexOf(u);
    if (i >= 0) queue.splice(i, 1);
    sync();
  }

  function SpeechSynthesisUtterance(text) {
    this.text = text == null ? '' : String(text);
    this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null;
    this.onstart = null; this.onend = null; this.onerror = null; this.onpause = null; this.onresume = null;
    this.onboundary = null; this.onmark = null;
    Object.defineProperty(this, '__bkListeners', { value: {}, enumerable: false });
  }
  SpeechSynthesisUtterance.prototype.addEventListener = function (t, f) { if (typeof f === 'function') (this.__bkListeners[t] = this.__bkListeners[t] || []).push(f); };
  SpeechSynthesisUtterance.prototype.removeEventListener = function (t, f) {
    var a = this.__bkListeners[t]; if (!a) return; var i = a.indexOf(f); if (i >= 0) a.splice(i, 1);
  };

  function langOf(u) {
    var l = String(u.lang || document.documentElement.lang || 'hi-IN').replace('_', '-');
    var parts = l.split('-');
    l = parts[0].toLowerCase() + (parts[1] ? '-' + parts[1].toUpperCase() : '');
    return LANG_RE.test(l) ? l : 'hi-IN';
  }
  function rateOf(u) { var r = Number(u.rate); return isFinite(r) ? Math.min(4, Math.max(0.25, r)) : 1; }

  var synth = {
    speaking: false, pending: false, paused: false, onvoiceschanged: null,
    speak: function (u) {
      if (!(u instanceof SpeechSynthesisUtterance)) throw new TypeError("Failed to execute 'speak': parameter 1 is not of type 'SpeechSynthesisUtterance'.");
      var text = String(u.text || '').slice(0, MAX_CHARS);
      if (!text.trim()) { later(function () { fire(u, 'end'); }); return; }
      var id = ++seq;
      byId[id] = u; queue.push(u); sync();
      port.postMessage(JSON.stringify({ source: 'bookkaro-app', type: 'BK_TTS_SPEAK', id: id, text: text, lang: langOf(u), rate: rateOf(u) }));
    },
    cancel: function () {
      if (!queue.length) return;
      var dropped = queue.slice();
      queue = []; byId = {}; sync();
      port.postMessage(JSON.stringify({ source: 'bookkaro-app', type: 'BK_TTS_CANCEL' }));
      later(function () { for (var i = 0; i < dropped.length; i++) fire(dropped[i], 'error', { error: i === 0 ? 'interrupted' : 'canceled' }); });
    },
    pause: function () { /* the system engine has no pause; BookKaro never pauses speech */ },
    resume: function () { },
    getVoices: function () { return []; },
    addEventListener: function () { }, removeEventListener: function () { }, dispatchEvent: function () { return true; }
  };

  port.addEventListener('message', function (e) {
    var d;
    try { d = JSON.parse(e.data); } catch (x) { return; }
    if (!d || d.source !== 'bookkaro-android' || d.type !== 'BK_TTS_EVENT') return;
    var u = byId[d.id];
    if (!u) return;                                          // cancelled / unknown → ignored
    if (d.event === 'start') { fire(u, 'start'); return; }
    finish(u);
    if (d.event === 'end') fire(u, 'end');
    else fire(u, 'error', { error: d.event === 'interrupted' ? 'interrupted' : 'synthesis-failed' });
  });

  try { Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true }); } catch (e) { window.speechSynthesis = synth; }
  try { Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: SpeechSynthesisUtterance, configurable: true, writable: true }); } catch (e) { window.SpeechSynthesisUtterance = SpeechSynthesisUtterance; }
  }
})();
