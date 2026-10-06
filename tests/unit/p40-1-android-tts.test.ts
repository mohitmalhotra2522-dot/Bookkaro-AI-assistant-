// @vitest-environment happy-dom
/**
 * P40.1 — spoken replies inside the Android app. Android System WebView has `speechSynthesis` without an engine, so the
 * existing web voice flow was silent in the app. android/app/src/main/assets/bookkaro-tts-shim.js (BookKaro origin
 * only) gives the UNCHANGED web code (BrowserSpeechOutput) speechSynthesis backed by the phone's system TTS over the
 * `BookKaroAndroid` bridge. SIMULATED here with a fake bridge (no device); the Kotlin side is covered by JUnit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserSpeechOutput } from '../../src/voice/browser-voice-adapters';

const SHIM = fs.readFileSync(path.resolve(__dirname, '../../android/app/src/main/assets/bookkaro-tts-shim.js'), 'utf8');

function fakeBridge() {
  const posted: any[] = [];
  const listeners: Array<(e: { data: unknown }) => void> = [];
  return {
    posted,
    port: { postMessage: (raw: string) => posted.push(JSON.parse(raw)), addEventListener: (_t: string, fn: any) => listeners.push(fn), removeEventListener: () => {} },
    emit: (o: any) => listeners.forEach(fn => fn({ data: JSON.stringify(o) })),
    tts: (id: number, event: string) => listeners.forEach(fn => fn({ data: JSON.stringify({ source: 'bookkaro-android', type: 'BK_TTS_EVENT', id, event }) }))
  };
}
const tick = () => new Promise(r => setTimeout(r, 5));
const w = window as any;

beforeEach(() => {
  delete w.__bookkaroTtsShim; delete w.BookKaroAndroid; delete w.speechSynthesis; delete w.SpeechSynthesisUtterance;
});
function install() { const b = fakeBridge(); w.BookKaroAndroid = b.port; new Function(SHIM)(); return b; }

describe('P40.1 — speechSynthesis shim for the app (existing web voice flow → phone system TTS)', () => {
  it('[1] outside the app (no BookKaroAndroid bridge) the shim changes nothing', () => {
    new Function(SHIM)();
    expect(w.__bookkaroTtsShim).toBeUndefined();
    expect('speechSynthesis' in window).toBe(false);
    // sub-frame: nothing either
    const frame: any = { top: {}, BookKaroAndroid: fakeBridge().port, document };
    new Function('window', SHIM)(frame);
    expect(frame.__bookkaroTtsShim).toBeUndefined();
  });

  it('[2] BrowserSpeechOutput speaks through the bridge: text / lang / rate, start → started, end → done; speaking flag', async () => {
    const b = install();
    const out = new BrowserSpeechOutput();
    expect(out.available).toBe(true);
    const p = out.speak('Aapki train 12497 Shan-e-Punjab Express hai. IRCTC par continue karun?', { lang: 'hi-IN' });
    expect(b.posted).toEqual([{ source: 'bookkaro-app', type: 'BK_TTS_SPEAK', id: 1, text: out.lastSpoken, lang: 'hi-IN', rate: 1.05 }]);
    expect(w.speechSynthesis.speaking).toBe(true);
    let started = false; expect(p.started).toBeDefined(); p.started!.then(() => { started = true; });
    b.tts(1, 'start'); await tick();
    expect(started).toBe(true);
    let done = false; p.done.then(() => { done = true; });
    b.tts(1, 'end'); await tick();
    expect(done).toBe(true);
    expect(w.speechSynthesis.speaking).toBe(false);
  });

  it('[3] barge-in / cancel: BK_TTS_CANCEL sent, every queued reply settles, late engine events are ignored', async () => {
    const b = install();
    const out = new BrowserSpeechOutput();
    const a = out.speak('Pehla jawab.', { lang: 'hi-IN' });
    const c = out.speak('Doosra jawab.', { lang: 'hi-IN' });
    expect(w.speechSynthesis.pending).toBe(true);
    b.tts(1, 'start');
    c.cancel();                                                   // the existing adapter calls speechSynthesis.cancel()
    expect(b.posted.at(-1)).toEqual({ source: 'bookkaro-app', type: 'BK_TTS_CANCEL' });
    await expect(a.done).resolves.toBeUndefined();               // 'interrupted' resolves (as in Chrome)
    await expect(c.done).resolves.toBeUndefined();
    expect(w.speechSynthesis.speaking).toBe(false);
    b.tts(1, 'interrupted'); b.tts(2, 'end'); await tick();     // engine's late events: no throw, no state change
    expect(w.speechSynthesis.speaking).toBe(false);
  });

  it('[4] engine failure (e.g. no Hindi voice) → TTS_FAILED like before: the reply text stays in chat', async () => {
    const b = install();
    const p = new BrowserSpeechOutput().speak('Booking details verify ho gaye hain.', { lang: 'hi-IN' });
    b.tts(1, 'error');
    await expect(p.done).rejects.toThrow('TTS_FAILED');
    expect(w.speechSynthesis.speaking).toBe(false);
  });

  it('[5] only bookkaro-android BK_TTS_EVENTs for known ids count; values are bounded before they reach native', async () => {
    const b = install();
    const u = new w.SpeechSynthesisUtterance('x'.repeat(5000));
    const seen: string[] = [];
    u.onend = () => seen.push('end'); u.addEventListener('start', () => seen.push('start'));
    u.lang = 'en_in'; u.rate = 50;
    w.speechSynthesis.speak(u);
    expect(b.posted[0]).toMatchObject({ type: 'BK_TTS_SPEAK', lang: 'en-IN', rate: 4 });
    expect(b.posted[0].text.length).toBe(3900);
    b.emit({ source: 'bookkaro-page', type: 'BK_TTS_EVENT', id: 1, event: 'end' });      // wrong source
    b.emit({ source: 'bookkaro-android', type: 'BK_TTS_EVENT', id: 99, event: 'end' });  // unknown id
    b.emit({ source: 'bookkaro-android', type: 'BK_ANDROID_READY' });
    await tick();
    expect(seen).toEqual([]);
    b.tts(1, 'start'); b.tts(1, 'end'); await tick();
    expect(seen).toEqual(['start', 'end']);
    const bad = new w.SpeechSynthesisUtterance('hi'); bad.lang = 'hi-IN"; alert(1)';
    w.speechSynthesis.speak(bad);
    expect(b.posted.at(-1).lang).toBe('hi-IN');
    expect(() => w.speechSynthesis.speak({ text: 'not an utterance' })).toThrow(TypeError);
    // empty text: nothing sent, ends at once
    const empty = new w.SpeechSynthesisUtterance('   '); let ended = false; empty.onend = () => { ended = true; };
    const n = b.posted.length; w.speechSynthesis.speak(empty); await tick();
    expect([b.posted.length, ended]).toEqual([n, true]);
    expect(w.speechSynthesis.getVoices()).toEqual([]);
  });

  it('[6] the bridge carries only speak / cancel; the shim never fetches, stores or logs', () => {
    expect(SHIM).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|console\./);
    const types = [...SHIM.matchAll(/type: '(BK_[A-Z_]+)'/g)].map(m => m[1]);
    expect([...new Set(types)].sort()).toEqual(['BK_TTS_CANCEL', 'BK_TTS_SPEAK']);
  });
});
