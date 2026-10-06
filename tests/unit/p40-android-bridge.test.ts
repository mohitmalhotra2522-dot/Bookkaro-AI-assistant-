// @vitest-environment happy-dom
/**
 * P40 G2 — Android IRCTC WebView bridge (MockIRCTC, happy-dom). SIMULATED: no Android device / emulator / real IRCTC.
 *
 * Runs the EXACT script the app injects (android/app/src/main/assets/irctc-android-adapter.js with the unmodified
 * extension files irctc-handoff-guard.js / irctc-core.js / irctc-content.js inserted — same assembly as
 * InjectedScript.kt) against MockIRCTC pages. `window.BookKaroIrctc` is a fake of the native side with the same rules as
 * HandoffController.kt (approved-host check on the WebView URL, re-fetch + full guard incl. HMAC on every snapshot
 * request, metadata-only events, BK_CLEAR). The handoffs are signed exactly like the backend does (HMAC-SHA256 with the
 * bridge token over the integrity payload); the Kotlin side of the same vectors is covered by the JUnit tests.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, webcrypto } from 'node:crypto';
import { createRequire } from 'module';
import { MOCK_IRCTC_SCENARIOS, renderMockIrctc } from '../../server/irctc/mock/mock-irctc';
import { MOCK_IRCTC_REAL_SCENARIOS, MOCK_IRCTC_REAL_SCRIPT } from '../../server/irctc/mock/mock-irctc-real';
import { androidBridge, parseAndroidMessage } from '../../src/components/irctc/IrctcAssistPage';

const require = createRequire(import.meta.url);
const Guard = require('../../extension/irctc-handoff-guard.js');
const Core = require('../../extension/irctc-core.js');
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VECTORS = JSON.parse(read('android/app/src/test/resources/p40-handoff-vectors.json'));
const VALID = VECTORS.cases.find((c: any) => c.name === 'valid');
const KEY: string = VALID.key;
const MOCK_URL = 'http://localhost:3000/api/dev/mock-irctc/real-search';
const SAFE = new Set(['type', 'page', 'filled', 'skipped', 'field', 'language']);

// ---- the injected script (same assembly as InjectedScript.kt: literal placeholder replacement) ----------------------
const SHARED: Array<[string, string]> = [['/*__BOOKKARO_GUARD__*/', 'irctc-handoff-guard.js'], ['/*__BOOKKARO_CORE__*/', 'irctc-core.js'], ['/*__BOOKKARO_CONTENT__*/', 'irctc-content.js']];
function assemble(version = 'android-0.40.0') {
  let s = read('android/app/src/main/assets/irctc-android-adapter.js');
  for (const [ph, f] of SHARED) { expect(s).toContain(ph); s = s.split(ph).join(read(`extension/${f}`)); }
  return s.split('__BOOKKARO_ANDROID_VERSION__').join(version);
}
const SCRIPT = assemble();

// ---- signed handoffs (backend format) --------------------------------------------------------------------------------
const sign = (s: any) => createHmac('sha256', KEY).update(Guard.integrityPayload(s)).digest('hex');
const SL_PAX = [
  { index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null },
  { index: 2, name: 'Neha Sharma', age: 28, gender: 'Female', berth: 'Side Upper', food: null }
];
function handoff(over: any = {}) {
  const now = Date.now();
  const s: any = {
    ...VALID.snapshot,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 19 * 60_000).toISOString(),
    journey: { ...VALID.snapshot.journey, dateIso: '2026-10-08', dateIrctc: '08/10/2026' },
    train: { number: '12904', name: 'MOCK SUPERFAST', departure: null, arrival: null },
    travelClass: { code: 'SL', label: 'Sleeper (SL)' },
    passengers: SL_PAX.slice(0, 1),
    ...over
  };
  s.integrity = sign(s);
  return s;
}
const EXPECTED = { handoffId: VALID.snapshot.handoffId, reviewVersion: VALID.snapshot.sourceReviewVersion };

// ---- fake native side (rules of HandoffController.kt) ---------------------------------------------------------------
interface Native { posted: string[]; events: any[]; gets: number; active: boolean; dead: boolean; backend: () => any; expected: typeof EXPECTED }
const natives: Native[] = [];
function installNative(o: { backend?: (() => any) | null; expected?: typeof EXPECTED } = {}): Native {
  const nat: Native = { posted: [], events: [], gets: 0, active: o.backend !== null, dead: false, backend: o.backend || (() => handoff()), expected: o.expected || EXPECTED };
  const port: any = {
    onmessage: null,
    postMessage(raw: string) {
      nat.posted.push(raw);
      if (nat.dead) return;
      const { id, msg } = JSON.parse(raw);
      (async () => {
        let body: any;
        if (!Guard.isApprovedIrctcPage(window.location.href).ok) body = { ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' };
        else if (msg.type === 'BK_GET_SNAPSHOT') {
          if (!nat.active) body = { ok: false, code: 'NO_ACTIVE_HANDOFF' };
          else {
            nat.gets++;
            const g = await Guard.guardSnapshot(nat.backend(), nat.expected, KEY, Date.now(), webcrypto.subtle);
            body = g.ok ? { ok: true, body: g.snapshot } : { ok: false, code: g.code, reason: g.reason };
            if (!g.ok) nat.active = false;
          }
        } else if (msg.type === 'BK_EVENT') {
          const ev = msg.event || {};
          if (Object.keys(ev).some(k => !SAFE.has(k))) body = { ok: false, code: 'INVALID_EVENT' };
          else { nat.events.push(ev); body = { ok: true, body: {} }; }
        } else if (msg.type === 'BK_CLEAR') { nat.active = false; body = { ok: true }; }
        else body = { ok: false, code: 'UNKNOWN_MESSAGE' };
        if (!nat.dead) setTimeout(() => port.onmessage && port.onmessage({ data: JSON.stringify({ id, body }) }), 0);
      })();
    }
  };
  (window as any).BookKaroIrctc = port;
  natives.push(nat);
  return nat;
}

// ---- MockIRCTC pages + overlay access --------------------------------------------------------------------------------
const MOCK_SCRIPT = (renderMockIrctc(null).match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
let installed = false;
function load(id: string) {
  const sc = [...MOCK_IRCTC_SCENARIOS, ...MOCK_IRCTC_REAL_SCENARIOS].find(x => x.id === id)!;
  document.body.innerHTML = sc.html;
  if (!installed) { new Function('document', MOCK_SCRIPT)(document); new Function('document', MOCK_IRCTC_REAL_SCRIPT)(document); installed = true; }
  const clicks: string[] = [];
  document.querySelectorAll('[data-final]').forEach(el => {
    el.removeAttribute('onclick');
    el.addEventListener('click', e => { e.preventDefault(); clicks.push((el as HTMLElement).dataset.final!); });
  });
  document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => e.preventDefault()));
  const search = document.querySelector('[data-final="search"]');
  if (search) search.textContent = 'Search Trains';
  return clicks;
}
let overlayRoot: ShadowRoot | null = null;
let overlayHost: Element | null = null;
const origAttach = Element.prototype.attachShadow;
beforeAll(() => {
  // the overlay is a CLOSED shadow root — the test keeps a reference to read what the user sees
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const r = origAttach.call(this, init);
    if ((this as Element).id === 'bookkaro-irctc-assist') { overlayRoot = r; overlayHost = this as Element; }
    return r;
  };
});
const overlay = () => (overlayRoot?.getElementById('msg')?.textContent || '') + ' | ' + (overlayRoot?.getElementById('st')?.textContent || '');
function setUrl(u: string) { (window as any).happyDOM.setURL(u); }
function inject(w: any = window) {
  overlayRoot = null; overlayHost = null;
  new Function('window', 'self', SCRIPT)(w, w);
}
function reattachOverlay() { if (overlayHost && !overlayHost.isConnected) document.body.appendChild(overlayHost); }
async function until(fn: () => boolean, ms = 15000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 50)); }
  return true;
}
const val = (sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value ?? null;
const nameInputs = () => Core.passengerNameInputs(document) as HTMLInputElement[];   // the extension's own passenger-name definition
const noSecrets = (nat: Native) => {
  const all = nat.posted.join('\n');
  expect(all).not.toContain(KEY);
  for (const pii of ['Rahul', 'Neha', 'Sharma', '31', 'ASR KIR']) expect(all.includes(`"${pii}`)).toBe(false);
  for (const ev of nat.events) expect(Object.keys(ev).every(k => SAFE.has(k))).toBe(true);
};

afterEach(() => {
  // retire this test's script instance: its native port goes silent (it can never fetch again) and the flags reset
  for (const n of natives) n.dead = true;
  delete (window as any).__bookkaroAndroidAdapter; delete (window as any).__bookkaroIrctcAssist; delete (window as any).BookKaroIrctc;
  vi.restoreAllMocks();
  setUrl(MOCK_URL);
});

describe('P40 — handoff vectors + URL policy shared by Kotlin and the extension', () => {
  it('[1] every committed vector still matches the current JS guard; the backend signature is reproduced', async () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(28);
    for (const c of VECTORS.cases) {
      const g = await Guard.guardSnapshot(c.snapshot, c.expected, c.key, c.now, webcrypto.subtle);
      const { snapshot: _s, ...rest } = g;
      expect([c.name, rest]).toEqual([c.name, c.result.ok ? { ok: true } : c.result]);
    }
    expect(Guard.integrityPayload(VALID.snapshot)).toBe(VECTORS.integrityPayloadOfValid);
    expect(sign(VALID.snapshot)).toBe(VALID.snapshot.integrity);
    expect((await Guard.guardSnapshot(handoff(), EXPECTED, KEY, Date.now(), webcrypto.subtle)).ok).toBe(true);
  });

  it('[2] URL cases: the JS guard result recorded for Kotlin is what isApprovedIrctcPage returns today', () => {
    expect(VECTORS.urlCases.length).toBeGreaterThanOrEqual(20);
    for (const c of VECTORS.urlCases) expect([c.url, Guard.isApprovedIrctcPage(c.url)]).toEqual([c.url, c.result]);
  });

  it('[3] injected script = adapter + the three UNMODIFIED extension files; no token, no network, no JS interface', () => {
    for (const [, f] of SHARED) expect(SCRIPT).toContain(read(`extension/${f}`));
    expect(SCRIPT).not.toMatch(/__BOOKKARO_(GUARD|CORE|CONTENT|ANDROID_VERSION)__/);
    expect(SCRIPT).toContain("return { version: 'android-0.40.0' }");
    expect(() => new Function('window', 'self', SCRIPT)).not.toThrow();           // valid JS
    const adapter = read('android/app/src/main/assets/irctc-android-adapter.js');
    expect(adapter).not.toMatch(/fetch\(|XMLHttpRequest|addJavascriptInterface|bridgeToken|localStorage|document\.cookie/);
    expect(SCRIPT).not.toContain(KEY);
    // the Gradle copy task ships exactly these files (no fork of the extension)
    const gradle = read('android/app/build.gradle.kts');
    expect(gradle).toMatch(/include\("irctc-handoff-guard\.js", "irctc-core\.js", "irctc-content\.js"\)/);
  });

  it('[4] unapproved host / sub-frame / missing native port → nothing runs, nothing is sent, no overlay', async () => {
    for (const u of ['https://evil.example/nget/train-search', 'https://irctc.co.in/nget/train-search', 'https://www.irctc.co.in.attacker.example/nget/', 'https://www.irctc.co.in:8443/nget/train-search', 'https://www.irctc.co.in/eticketing/login']) {
      setUrl(u);
      load('real-search');
      const nat = installNative();
      inject();
      await new Promise(r => setTimeout(r, 300));
      expect([u, nat.posted.length, !!document.getElementById('bookkaro-irctc-assist')]).toEqual([u, 0, false]);
      nat.dead = true; delete (window as any).__bookkaroAndroidAdapter; delete (window as any).__bookkaroIrctcAssist;
    }
    // sub-frame: window.top !== window → the adapter returns before touching anything
    setUrl(MOCK_URL);
    const nat = installNative();
    const frameWin: any = { top: {}, BookKaroIrctc: (window as any).BookKaroIrctc, document };
    inject(frameWin);
    expect(frameWin.__bookkaroAndroidAdapter).toBeUndefined();
    expect(nat.posted).toEqual([]);
    // no native port (e.g. any non-IRCTC origin, where the native allow-list does not inject it) → nothing
    delete (window as any).BookKaroIrctc;
    load('real-search'); inject();
    await new Promise(r => setTimeout(r, 300));
    expect(document.getElementById('bookkaro-irctc-assist')).toBeNull();
  });
});

describe('P40 — IRCTC WebView flow on MockIRCTC (adapter + extension logic + native rules)', () => {
  it('[5] journey: From / To / Date / Class / Quota verified, Search tapped exactly once; no token / PII leaves the page', async () => {
    setUrl(MOCK_URL);
    const clicks = load('real-search');
    const nat = installNative();
    inject();
    expect((window as any).BookKaroIrctc).toBeUndefined();                       // port removed from page globals
    expect(await until(() => clicks.includes('search'), 20000)).toBe(true);
    await new Promise(r => setTimeout(r, 1500));
    expect(clicks.filter(c => c === 'search')).toEqual(['search']);
    expect(Core.journeyOnPage(document, handoff())).toEqual({ ok: true, missing: [] });
    expect(nat.gets).toBeGreaterThanOrEqual(1);
    expect(nat.events.some(e => e.type === 'PAGE_DETECTED' && e.page === 'HOME_SEARCH')).toBe(true);
    expect(overlay()).toMatch(/BookKaro ne Search tap kiya/);
    noSecrets(nat);
  }, 40000);

  it('[6] station suggestions without the exact code → never the first suggestion; Search not tapped', async () => {
    const clicks = load('real-search-decoy-stations');
    const nat = installNative();
    inject();
    expect(await until(() => /STATION_AUTOFILL_FAILED|From station|To station/.test(overlay()), 25000)).toBe(true);
    await new Promise(r => setTimeout(r, 1000));
    expect(clicks).not.toContain('search');
    const from = val('#origin input') ?? val('#origin > span > input');
    expect(from === null || !/ - (?!ASR)[A-Z]{2,5}\b/.test(from)).toBe(true);   // no other station's code was picked
    noSecrets(nat);
  }, 40000);

  it('[7] the page rejects the date → DATE_AUTOFILL_FAILED shown, the date is reported unconfirmed, Search not tapped', async () => {
    const clicks = load('real-search-date-rejected');
    const nat = installNative();
    inject();
    expect(await until(() => /DATE_AUTOFILL_FAILED|Journey date|date/i.test(overlay()) && nat.events.some(e => /FIELD_NOT_CONFIRMED|VALUE_CHANGED_BY_PAGE|DATE_AUTOFILL_FAILED/.test(JSON.stringify(e))), 30000)).toBe(true);
    await new Promise(r => setTimeout(r, 1000));
    expect(clicks).not.toContain('search');
    expect(nat.events.some(e => e.field === 'date' || /date/i.test(JSON.stringify(e.skipped || '')))).toBe(true);
    noSecrets(nat);
  }, 45000);

  it('[8] passenger page: 2 passengers (name / age / gender / berth) filled; Continue is never tapped', async () => {
    const clicks = load('real-passenger-mobile-2');
    const nat = installNative({ backend: () => handoff({ passengers: SL_PAX }) });
    inject();
    expect(await until(() => nameInputs().filter(i => i.value).length === 2, 25000)).toBe(true);
    await new Promise(r => setTimeout(r, 1200));
    expect(nameInputs().map(i => i.value)).toEqual(['Rahul Sharma', 'Neha Sharma']);
    const ages = [...document.querySelectorAll('input[formcontrolname="passengerAge"]')].map(i => (i as HTMLInputElement).value);
    expect(ages).toEqual(['31', '28']);
    const g = [...document.querySelectorAll('select[formcontrolname="passengerGender"]')].map(s => (s as HTMLSelectElement).value);
    expect(g).toEqual(['M', 'F']);
    const b = [...document.querySelectorAll('select[formcontrolname="passengerBerthChoice"]')].map(s => (s as HTMLSelectElement).value);
    expect(b).toEqual(['LB', 'SU']);
    expect([val('input[formcontrolname="userid"]'), val('input[formcontrolname="password"]')]).toEqual(['', '']);   // hidden login untouched
    expect(clicks).toEqual([]);                                                    // passenger Continue = user only
    noSecrets(nat);
  }, 40000);

  it('[8b] the passenger page shows another train than the review → paused, nothing filled', async () => {
    const clicks = load('passenger-multi');                                         // MockIRCTC: train 12014
    const nat = installNative({ backend: () => handoff({ passengers: SL_PAX }) });
    inject();
    expect(await until(() => /IRCTC page par train 12014 hai/.test(overlay()), 25000)).toBe(true);
    expect(nameInputs().every(i => !i.value)).toBe(true);
    expect(clicks).toEqual([]);
    noSecrets(nat);
  }, 40000);

  for (const [id, page] of [['login-required', 'LOGIN'], ['review-captcha', 'REVIEW_CAPTCHA'], ['otp', 'OTP'], ['payment', 'PAYMENT']] as const) {
    it(`[9] hard stop on ${page}: nothing typed into login / CAPTCHA / OTP / payment fields, nothing tapped, metadata only`, async () => {
      const clicks = load(id);
      expect(Core.detectPage(document)).toBe(page);
      const before = [...document.querySelectorAll('input')].map(i => (i as HTMLInputElement).value);
      const nat = installNative();
      inject();
      expect(await until(() => nat.events.some(e => e.type === 'PAGE_DETECTED' && e.page === page), 15000)).toBe(true);
      await new Promise(r => setTimeout(r, 1500));
      expect([...document.querySelectorAll('input')].map(i => (i as HTMLInputElement).value)).toEqual(before);
      expect(clicks).toEqual([]);
      expect(nat.events.map(e => e.type).every(t => ['PAGE_DETECTED', 'FINAL_CONTROL_HIGHLIGHTED', 'LANGUAGE_SELECTED', 'LANGUAGE_SELECTOR_MISSING'].includes(t))).toBe(true);
      noSecrets(nat);
    }, 30000);
  }

  it('[10] stale handoff: review changed / bad signature → STALE_IRCTC_HANDOFF, nothing filled, never retried', async () => {
    // review version changed after the handoff was made
    let clicks = load('real-search');
    let nat = installNative({ expected: { ...EXPECTED, reviewVersion: EXPECTED.reviewVersion + 1 } });
    inject();
    expect(await until(() => /STALE_IRCTC_HANDOFF · REVIEW_VERSION_MISMATCH/.test(overlay()), 15000)).toBe(true);
    expect(/Booking review badal gaya hai/.test(overlay())).toBe(true);
    expect(clicks).toEqual([]); expect(val('#origin input') || '').not.toMatch(/ASR/);
    expect(nat.active).toBe(false);
    const gets = nat.gets;
    document.body.appendChild(document.createElement('div'));                      // later DOM changes do not retry
    await new Promise(r => setTimeout(r, 1200));
    expect(nat.gets).toBe(gets);
    for (const n of natives) n.dead = true;
    delete (window as any).__bookkaroAndroidAdapter; delete (window as any).__bookkaroIrctcAssist;
    // tampered data (signature no longer matches)
    clicks = load('real-passenger-mobile-2');
    nat = installNative({ backend: () => ({ ...handoff({ passengers: SL_PAX }), passengers: [{ ...SL_PAX[0], name: 'Someone Else' }, SL_PAX[1]] }) });
    inject();
    expect(await until(() => /INTEGRITY_FAILED/.test(overlay()), 15000)).toBe(true);
    expect(nameInputs().every(i => !i.value)).toBe(true);
    expect(clicks).toEqual([]);
  }, 45000);

  it('[11] handoff expires mid-flow → the next IRCTC step is refused (EXPIRED), nothing more filled or tapped', async () => {
    let clicks = load('real-search');
    const nat = installNative();
    inject();
    expect(await until(() => clicks.includes('search'), 20000)).toBe(true);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 21 * 60_000);
    clicks = load('real-train-list-expanded');
    reattachOverlay();
    expect(await until(() => /EXPIRED/.test(overlay()), 15000)).toBe(true);
    expect(/expire ho gaya/.test(overlay())).toBe(true);
    await new Promise(r => setTimeout(r, 1200));
    expect(clicks).toEqual([]);                                                     // no class / date / Book Now
    noSecrets(nat);
  }, 45000);

  it('[12] no active handoff (never registered / cleared / app restarted) → nothing filled', async () => {
    const clicks = load('real-search');
    const nat = installNative({ backend: null });
    inject();
    expect(await until(() => /Koi active BookKaro handoff nahi/.test(overlay()), 15000)).toBe(true);
    await new Promise(r => setTimeout(r, 800));
    expect(clicks).toEqual([]);
    expect(val('#origin input') || '').not.toMatch(/ASR/);
    expect(nat.gets).toBe(0);
  }, 30000);
});

describe('P40 — BookKaro web page side', () => {
  it('[13] androidBridge() only with the native object; only bookkaro-android JSON is accepted; the browser path stays', () => {
    expect(androidBridge({})).toBeNull();
    expect(androidBridge(undefined)).toBeNull();
    expect(androidBridge({ BookKaroAndroid: {} })).toBeNull();
    const b = { postMessage: () => {} };
    expect(androidBridge({ BookKaroAndroid: b })).toBe(b);
    expect(androidBridge()).toBeNull();                                            // plain browser (happy-dom window)
    expect(parseAndroidMessage(JSON.stringify({ source: 'bookkaro-android', type: 'BK_IRCTC_HANDOFF_ACK', ok: true }))).toMatchObject({ type: 'BK_IRCTC_HANDOFF_ACK', ok: true });
    expect(parseAndroidMessage(JSON.stringify({ source: 'bookkaro-extension', type: 'BK_IRCTC_HANDOFF_ACK', ok: true }))).toBeNull();
    expect(parseAndroidMessage({ source: 'bookkaro-android', type: 'X' })).toBeNull();                 // objects are not native replies
    expect(parseAndroidMessage('not json')).toBeNull();
    const page = read('src/components/irctc/IrctcAssistPage.tsx');
    // the token goes only to the native bridge (never into a URL); desktop "Send to extension" + Open IRCTC unchanged
    expect(page).toMatch(/android\.postMessage\(JSON\.stringify\(\{ source: 'bookkaro-app', type: 'BK_IRCTC_HANDOFF', handoffId: access\.view\.handoffId, bridgeToken: access\.bridgeToken, reviewVersion: access\.view\.reviewVersion \}\)\)/);
    expect(page).toMatch(/window\.postMessage\(\{ source: 'bookkaro-app', type: 'BK_IRCTC_HANDOFF'/);
    expect(page).toMatch(/Send to extension/);
    expect(page).toMatch(/IRCTC open nahi ho pa raha\. Please try again\./);
    expect(page).not.toMatch(/[?&](bridgeToken|handoffId)=/);
  });
});
