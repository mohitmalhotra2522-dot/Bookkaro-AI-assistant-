/**
 * P39.3 — IRCTC handoff integrity + approved-host guard (backend manager → extension background → guard).
 * A real handoff is created through the existing flow (MockLLM + mock railway provider), the extension background
 * service worker (extension/background.js) runs in a VM with a stub `chrome` whose fetch goes to the real
 * IrctcHandoffManager. Proves: valid / expired / stale review version / invalid schema / unauthorized host /
 * modified payload / rotated token → STALE_IRCTC_HANDOFF (+ reason) and nothing stays registered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import vm from 'vm';
import { webcrypto } from 'crypto';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { BookingState } from '../../shared/states';
import { canonicalJson, irctcIntegrityPayload, IRCTC_INTEGRITY_FIELDS, IRCTC_HANDOFF_SCHEMA_VERSION, IRCTC_APPROVED_HOST } from '../../shared/irctc-handoff';
import { checkNoSensitiveData } from '../../server/booking/handoff/sensitive-data-guard';

const require = createRequire(import.meta.url);
const Guard = require('../../extension/irctc-handoff-guard.js');
const BACKGROUND = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const say = (sid: string, text: string): Promise<any> => orch.processTurn(sid, text, 'TEXT');
const M = () => orch.preparation.irctcHandoffs;

async function toHandoff() {
  const sid = state.createSession().sessionId;
  await say(sid, 'Amritsar se Delhi kal 2 log');
  await say(sid, '12497');
  await say(sid, 'CC');
  await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
  const r = await say(sid, 'haan book karo');
  expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  const a = M().ownerAccess(state.getSession(sid), Date.now())!;
  return { sid, a };
}

/** extension/background.js in a VM; its fetch() is answered by the real backend manager (clock + tamper hooks). */
function background(sid: string, o: { now?: () => number; tamper?: (s: any) => any } = {}) {
  let listener: any = null;
  const store: Record<string, any> = {};
  const chrome = {
    runtime: { id: 'bk-ext', onMessage: { addListener: (fn: any) => { listener = fn; } } },
    storage: { session: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o2: any) => { Object.assign(store, o2); },
      remove: async (k: string) => { delete store[k]; }
    } }
  };
  const fetch = async (url: string, init: any) => {
    const id = decodeURIComponent(new URL(url).pathname.split('/')[4] || '');
    const r = M().snapshot(id, init.headers['X-BookKaro-Bridge-Token'], state.getSession(sid), o.now ? o.now() : Date.now());
    const body = r.ok ? (o.tamper ? o.tamper(structuredClone(r.value)) : r.value) : { code: r.code };
    return { ok: r.ok, status: r.ok ? 200 : r.status, json: async () => body };
  };
  vm.runInNewContext(BACKGROUND, { importScripts: () => undefined, self: { BookKaroHandoffGuard: Guard }, chrome, fetch, crypto: webcrypto, URL, Date, JSON, Object, Number, console, structuredClone });
  const send = (msg: any, sender: any) => new Promise<any>(res => listener(msg, sender, res));
  const fromApp = { id: 'bk-ext', origin: 'http://localhost:5173', url: 'http://localhost:5173/irctc-assist' };
  const fromIrctc = { id: 'bk-ext', url: 'https://www.irctc.co.in/nget/train-search' };
  return { send, store, fromApp, fromIrctc };
}
const register = (bg: any, a: any, over: any = {}) => bg.send({ type: 'BK_REGISTER', handoffId: a.view.handoffId, bridgeToken: a.bridgeToken, reviewVersion: a.view.reviewVersion, ...over }, bg.fromApp);

beforeEach(() => {
  railwayRegistry.setActive('mock');
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
});

describe('P39.3 — handoff payload contract + integrity', () => {
  it('[1] valid handoff: backend signs the validated payload; the extension registers, verifies and serves it to an approved IRCTC page', async () => {
    const { sid, a } = await toHandoff();
    const s = a.snapshot;
    expect(s.schemaVersion).toBe(IRCTC_HANDOFF_SCHEMA_VERSION);
    expect(s.sourceReviewVersion).toBe(a.view.reviewVersion);
    expect(s.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(Guard.validateSnapshotSchema(s)).toBeNull();
    // the same canonical form on both sides
    expect(Guard.integrityPayload(s)).toBe(irctcIntegrityPayload(s));
    expect(Guard.INTEGRITY_FIELDS).toEqual([...IRCTC_INTEGRITY_FIELDS]);
    expect(Guard.canonicalJson({ b: 1, a: [{ d: undefined, c: 'x' }] })).toBe(canonicalJson({ b: 1, a: [{ d: undefined, c: 'x' }] }));
    expect(await Guard.verifyIntegrity(s, a.bridgeToken, webcrypto.subtle)).toBe(true);
    expect(checkNoSensitiveData(s).ok).toBe(true);
    const bg = background(sid);
    expect(await register(bg, a)).toMatchObject({ ok: true, status: 'READY' });
    expect(bg.store.handoff).toMatchObject({ handoffId: a.view.handoffId, reviewVersion: a.view.reviewVersion });
    const got = await bg.send({ type: 'BK_GET_SNAPSHOT' }, bg.fromIrctc);
    expect(got.ok).toBe(true);
    expect(got.body.passengers.map((p: any) => [p.index, p.name])).toEqual([[1, 'Rahul Sharma'], [2, 'Neha Sharma']]);
    expect(got.body.train.number).toBe('12497');
  });

  it('[2] expired handoff (backend TTL passed, or expiresAt in the past) → STALE_IRCTC_HANDOFF / EXPIRED, registration dropped', async () => {
    const { sid, a } = await toHandoff();
    const late = Date.parse(a.snapshot.expiresAt) + 1000;
    const bg = background(sid, { now: () => late });
    expect(await register(bg, a)).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'EXPIRED' });
    expect(bg.store.handoff).toBeUndefined();
    // client-side clock check too (even if a response claimed READY)
    expect(Guard.checkBinding(a.snapshot, { handoffId: a.view.handoffId, reviewVersion: a.view.reviewVersion }, late)).toBe('EXPIRED');
  });

  it('[3] stale review version: registered for an older / newer review, or the review changed after the handoff → refused', async () => {
    const { sid, a } = await toHandoff();
    const bg = background(sid);
    expect(await register(bg, a, { reviewVersion: a.view.reviewVersion + 1 })).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'REVIEW_VERSION_MISMATCH' });
    expect(bg.store.handoff).toBeUndefined();
    expect(await register(bg, a, { reviewVersion: 'x' })).toEqual({ ok: false, code: 'INVALID_HANDOFF' });
    // the review was invalidated after the handoff → backend marks it STALE_HANDOFF → refused
    expect(await register(bg, a)).toMatchObject({ ok: true });
    (state.getSession(sid) as any).handoff.status = 'INVALIDATED';
    expect(await bg.send({ type: 'BK_GET_SNAPSHOT' }, bg.fromIrctc)).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'STALE_HANDOFF' });
  });

  it('[4] invalid schema: unknown keys (raw LLM text / transcript), reordered passengers, date mismatch, bad version → SCHEMA_INVALID', async () => {
    const { a } = await toHandoff();
    const s = a.snapshot as any;
    const bad = (f: (x: any) => void) => { const x = structuredClone(s); f(x); return Guard.validateSnapshotSchema(x); };
    expect(bad(x => { x.llmText = 'book 12497'; })).toBe('UNKNOWN_KEYS');
    expect(bad(x => { x.transcript = 'haan'; })).toBe('UNKNOWN_KEYS');
    expect(bad(x => { x.passengers[0].mobile = '9800000000'; })).toBe('PASSENGER_KEYS');
    expect(bad(x => { x.passengers.reverse(); })).toBe('PASSENGER_ORDER');
    expect(bad(x => { x.journey.dateIrctc = x.journey.dateIrctc === '07/10/2026' ? '08/10/2026' : '07/10/2026'; })).toBe('DATE');   // always ≠ the real journey date (clock-independent)
    expect(bad(x => { x.schemaVersion = 2; })).toBe('SCHEMA_VERSION');
    expect(bad(x => { x.passengers = []; })).toBe('PASSENGERS');
    expect(bad(x => { x.travelClass = { code: 'CC', label: 'AC 3 Tier (3A)' }; })).toBe('CLASS');
    expect(bad(x => { x.journey.to = x.journey.from; })).toBe('JOURNEY');
    expect(bad(x => { delete x.integrity; })).toBe('MISSING_integrity');
    const r = await Guard.guardSnapshot({ ...s, extra: 1 }, { handoffId: s.handoffId, reviewVersion: s.sourceReviewVersion }, a.bridgeToken, Date.now(), webcrypto.subtle);
    expect(r).toMatchObject({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'SCHEMA_INVALID' });
  });

  it('[19] unauthorized host: exact https://www.irctc.co.in/nget/* (or the local mock) only — no wildcard; background refuses other senders', async () => {
    const ok = (u: string) => Guard.isApprovedIrctcPage(u).ok;
    expect(IRCTC_APPROVED_HOST).toBe(Guard.APPROVED_HOST);
    expect(Guard.isApprovedIrctcPage('https://www.irctc.co.in/nget/train-search')).toEqual({ ok: true, kind: 'REAL' });
    expect(Guard.isApprovedIrctcPage('http://localhost:3000/api/dev/mock-irctc/real-search')).toEqual({ ok: true, kind: 'MOCK' });
    expect(ok('http://127.0.0.1:3000/api/dev/mock-irctc')).toBe(true);
    for (const u of ['https://irctc.co.in/nget/train-search', 'https://m.irctc.co.in/nget/', 'https://www.irctc.co.in.evil.example/nget/', 'https://evil.example/www.irctc.co.in/nget/',
      'http://www.irctc.co.in/nget/train-search', 'https://www.irctc.co.in/eticketing/', 'https://www.irctc.co.in:8443/nget/', 'https://xn--irctc-www.co.in/nget/',
      'http://localhost:3000/irctc', 'http://localhost:3000/api/dev/mock-irctc-evil/x', 'http://evil.localhost/api/dev/mock-irctc', 'file:///nget/', 'not a url'])
      expect(Guard.isApprovedIrctcPage(u), u).toEqual({ ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' });
    const { sid, a } = await toHandoff();
    const bg = background(sid);
    expect(await register(bg, a)).toMatchObject({ ok: true });
    for (const url of ['https://evil.example/nget/', 'https://irctc.co.in/nget/x', 'http://localhost:5173/irctc-assist']) {
      expect(await bg.send({ type: 'BK_GET_SNAPSHOT' }, { id: 'bk-ext', url }), url).toEqual({ ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' });
      expect(await bg.send({ type: 'BK_EVENT', event: { type: 'PAUSED' } }, { id: 'bk-ext', url })).toEqual({ ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' });
    }
    expect(await bg.send({ type: 'BK_GET_SNAPSHOT' }, { id: 'other-ext', url: 'https://www.irctc.co.in/nget/' })).toEqual({ ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' });
    // registration only from the BookKaro origins
    expect(await bg.send({ type: 'BK_REGISTER', handoffId: a.view.handoffId, bridgeToken: a.bridgeToken, reviewVersion: a.view.reviewVersion }, { id: 'bk-ext', origin: 'https://www.irctc.co.in' })).toEqual({ ok: false, code: 'ORIGIN_NOT_ALLOWED' });
    // manifest: the IRCTC content scripts load the guard first; no wildcard host
    const mf = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
    const cs = mf.content_scripts.find((c: any) => c.js.includes('irctc-content.js'));
    expect(cs.js[0]).toBe('irctc-handoff-guard.js');
    expect(cs.matches.join(' ')).not.toMatch(/\*\.irctc|\*:\/\//);
  });

  it('[20] modified handoff: any changed field / forged MAC / another handoff\'s token / rotated token → refused (INTEGRITY_FAILED / SESSION_MISMATCH / UNKNOWN_HANDOFF)', async () => {
    const { sid, a } = await toHandoff();
    const exp = { handoffId: a.view.handoffId, reviewVersion: a.view.reviewVersion };
    const g = (x: any, key = a.bridgeToken) => Guard.guardSnapshot(x, exp, key, Date.now(), webcrypto.subtle);
    const mod = (f: (x: any) => void) => { const x = structuredClone(a.snapshot) as any; f(x); return x; };
    expect((await g(a.snapshot)).ok).toBe(true);
    for (const [label, f] of [
      ['name', (x: any) => { x.passengers[0].name = 'Mallory'; }], ['age', (x: any) => { x.passengers[1].age = 29; }],
      ['train', (x: any) => { x.train.number = '12014'; }], ['class', (x: any) => { x.travelClass = { code: 'EC', label: 'Exec. Chair Car (EC)' }; }],
      ['from', (x: any) => { x.journey.from = { code: 'DLI', display: 'DELHI - DLI', query: 'DLI' }; }], ['expiry', (x: any) => { x.expiresAt = new Date(Date.now() + 864e5).toISOString(); }],
      ['mac', (x: any) => { x.integrity = x.integrity.replace(/^./, (c: string) => (c === '0' ? '1' : '0')); }]
    ] as Array<[string, (x: any) => void]>)
      expect(await g(mod(f)), label).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'INTEGRITY_FAILED' });
    // a payload re-signed with a different key (not this handoff's token)
    expect(await g(a.snapshot, 'f'.repeat(64))).toMatchObject({ reason: 'INTEGRITY_FAILED' });
    // tampered in transit → the background refuses and drops the registration
    const bgT = background(sid, { tamper: x => { x.passengers[0].name = 'Mallory'; return x; } });
    expect(await register(bgT, a)).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'INTEGRITY_FAILED' });
    expect(bgT.store.handoff).toBeUndefined();
    // a wrong handoff id
    expect(Guard.checkBinding(a.snapshot, { ...exp, handoffId: 'irh_00000000-0000-0000-0000-000000000000' }, Date.now())).toBe('HANDOFF_MISMATCH');
    // session mismatch: the old token after the session's handoff was retired (token rotated) / unknown handoff
    const bg = background(sid);
    expect(await register(bg, a)).toMatchObject({ ok: true });
    bg.store.handoff.bridgeToken = 'a'.repeat(64);
    expect(await bg.send({ type: 'BK_GET_SNAPSHOT' }, bg.fromIrctc)).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'SESSION_MISMATCH' });
    bg.store.handoff.handoffId = 'irh_00000000-0000-0000-0000-000000000000';
    expect(await bg.send({ type: 'BK_GET_SNAPSHOT' }, bg.fromIrctc)).toEqual({ ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'UNKNOWN_HANDOFF' });
  });
});
