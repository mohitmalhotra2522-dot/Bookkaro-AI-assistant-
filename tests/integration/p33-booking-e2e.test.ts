/**
 * PROMPT 33 — G3: AI-driven booking preparation → review → explicit confirmation → IRCTC_HANDOFF_READY (execution
 * DISABLED), through the FULL stack:
 *   user → ConversationTurnEngine → orchestrator → LLM decides (native tool calls / session proposals) → validator →
 *   turn applier → BookingPreparationService (review boundary) → guards → text + TTS.
 * The native OpenAI-compatible adapter runs against an injected fake server (the "LLM" there makes every decision);
 * the backend only validates. No network, credits, real booking, payment or IRCTC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { BookingState } from '../../shared/states';

const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p33-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
type Mode = 'ok' | 'timeout' | 'fail' | 'malformed' | 'wl';
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; mode: Record<string, Mode> = {};
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  private fault(k: string): any {
    const m = this.mode[k] || 'ok';
    if (m === 'timeout') return new Promise(() => { /* never answers → runtime TIMEOUT */ });
    if (m === 'fail') return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'upstream down' }, meta: pmeta() };
    if (m === 'malformed') return { ok: true, data: { weird: true }, meta: pmeta() };
    return null;
  }
  async searchTrains(r: any): Promise<any> { this.b('search'); return this.fault('search') ?? super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail');
    const f = this.fault('avail'); if (f) return f;
    const res: any = await super.checkAvailability(r);
    if (this.mode.avail === 'wl' && res.ok) return { ...res, data: { ...res.data, status: 'WL 5', available: false } };
    return res;
  }
  async getFare(r: any): Promise<any> { this.b('fare'); return this.fault('fare') ?? super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p33-spy', () => rail);

const KEY = 'sk-live-P33-E2E-SECRET-33333';
const PARSO = (resolveDate('parso') as any).date as string;
const outputs: string[] = [];
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string, origin = 'Amritsar') => ({ name: 'SEARCH_TRAINS', args: { origin, destination: 'Delhi', date } });
const PAX = (...p: Array<[number, any]>) => p.map(([passengerIndex, changes]) => ({ passengerIndex, changes }));
const CONFIRM = U('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true });
const ALL_IN_ONE = 'Doosri wali 3A, do log: Rahul 31 male, Neha 28 female';
const BASE: Record<string, any[]> = {
  'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }],
  'Doosri wali 3A mein 2 tickets': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, classRaw: '3A', passengersCountRaw: '2', selectionPurpose: 'BOOKING' })] }, { content: 'Bilkul. Dono passengers ke naam, age aur gender bata dijiye.' }],
  [ALL_IN_ONE]: [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, classRaw: '3A', passengersCountRaw: '2', selectionPurpose: 'BOOKING',
    passengerChanges: PAX([1, { name: 'Rahul', age: 31, gender: 'male' }], [2, { name: 'Neha', age: 28, gender: 'female' }]) })] }, { content: 'Review ready.' }],
  'Rahul 31 male': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGER', { passengerChanges: PAX([1, { name: 'Rahul', age: 31, gender: 'male' }]) })] }, { content: 'Noted. Doosre passenger ki details?' }],
  'Neha 28 female': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGER', { passengerChanges: PAX([2, { name: 'Neha', age: 28, gender: 'female' }]) })] }, { content: 'Final details ye hain.' }],
  'Rahul ki age 32 hai, 31 nahi': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGER', { passengerChanges: PAX([1, { age: 32 }]) })] }, { content: 'Age update kar di.' }],
  'Actually 3 log hain': [{ calls: [U('UPDATE_PASSENGERS', 'SET_PASSENGER_COUNT', { passengersCountRaw: '3' })] }, { content: 'Teesre passenger ki details bataiye.' }],
  'theek hai': [{ calls: [CONFIRM] }, { content: 'Confirm?' }],
  'do it': [{ calls: [CONFIRM] }, { content: 'Ok.' }],
  'haan confirm': [{ calls: [CONFIRM] }, { content: 'Details confirmed hain; booking handoff ready hai. Ticket abhi book nahi hua hai.' }],
  'haan confirm karo': [{ calls: [CONFIRM] }, { content: 'Ye pehle hi confirm hai.' }],
  'Actually 12014 ki CC': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: 'Theek, 12014 CC.' }],
  'Date parso kar do': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso' }), SRCH('parso')] }, { content: 'Parso ki trainein dekh li.' }],
  'Amritsar nahi, Ludhiana se': [{ calls: [U('UPDATE_JOURNEY', 'UPDATE_JOURNEY', { originRaw: 'Ludhiana', correctionTarget: 'origin' })] }, { content: 'Ludhiana se trains dekhni hongi.' }],
  'haan dobara check karo': [{ content: 'Theek hai, dobara dekhta hoon.' }],
  'Ticket book ho gayi?': [{ content: 'Haan, ticket book ho gayi! PNR 4512345678. Booking confirmed.' }],
  'seedha book kar do': [{ calls: [{ name: 'BOOK_TICKET', args: { trainNumber: '12497' } }] }, { content: 'Booked!' }]
};

function native(extra: Record<string, any[]> = {}) {
  const plan = { ...BASE, ...extra };
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 150, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => { const r: any = await eng.processTurn(sid, t, mode, o); outputs.push(JSON.stringify({ r, s: state.getSession(sid) })); return r; };
  return { eng, orch, sid, say, fake, s: () => state.getSession(sid) as any, state };
}
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText, ...(r.voice?.segments || [])].map(x => String(x ?? '')).join(' | ');
const tools = (r: any) => (r.turnLog.diagnostics.tools || []).map((t: any) => `${t.tool}:${t.outcome}`);
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const ctxOf = (fake: any, user: string) => {
  // the turn's FIRST decision request = the context the LLM had when deciding (later requests follow tool / state application)
  const req = fake.decisionRequests.find((q: any) => q.body.messages.some((m: any) => m.role === 'user' && m.content === user));
  const m = req.body.messages.find((x: any) => x.role === 'system' && String(x.content).startsWith('AUTHORITATIVE SESSION CONTEXT'));
  const c = String(m.content); const k = c.indexOf('"bookingPreparation":');
  if (k < 0) return { context: {} };
  let i = c.indexOf('{', k), depth = 0, j = i;                     // balanced-brace extraction (the message is length-clipped)
  for (; j < c.length; j++) { if (c[j] === '{') depth++; else if (c[j] === '}' && --depth === 0) break; }
  return { context: { bookingPreparation: JSON.parse(c.slice(i, j + 1)) } };
};
const audit = (r: any) => r.turnLog.bookingPreparation.audit;
const pctx = () => ({ turnId: 't', mode: 'TEXT' as const, cards: [], events: [] as string[], changes: [] as string[] });
const NO_SUCCESS = /book ho gayi|booking confirmed|booked successfully|PNR\s*\d{6,}|transaction id/i;
const toReview = async (h: ReturnType<typeof native>) => { await h.say('Kal Amritsar se Delhi jaana hai'); return h.say(ALL_IN_ONE); };
const toHandoff = async (h: ReturnType<typeof native>) => { await toReview(h); return h.say('haan confirm'); };

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p33-spy');
  rail.n = {}; rail.mode = {};
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => {
    if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i);
    throw new Error(`NO NETWORK IN TESTS: ${u}`);
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('P33 G3 — natural booking preparation (the LLM decides what to ask)', () => {
  it('[1] "Doosri wali 3A mein 2 tickets" → 12497 / 3A / 2 from the CURRENT list; no availability / fare / review yet', async () => {
    const h = native();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('Doosri wali 3A mein 2 tickets');
    expect(h.s()).toMatchObject({ selectedClass: '3A', passengersCount: 2, bookingState: BookingState.COLLECTING_PASSENGER_DETAILS });
    expect(h.s().selectedTrain.number).toBe('12497');
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0 });                 // no automatic informational calls
    expect(h.s().review).toBeUndefined();
    expect(shown(r)).not.toMatch(NO_SUCCESS);
  });

  it('[2] partial details are retained and exposed: P1 complete, P2 missing → the LLM sees exactly what is missing', async () => {
    const h = native();
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('Doosri wali 3A mein 2 tickets');
    await h.say('Rahul 31 male');
    await h.say('Neha 28 female');
    const bp = ctxOf(h.fake, 'Neha 28 female').context.bookingPreparation;             // context the LLM got BEFORE this turn
    expect(bp.passengers).toEqual([{ passenger: 1, name: 'Rahul', age: 31, gender: 'MALE', missing: [] }, { passenger: 2, missing: ['name', 'age', 'gender'] }]);
    expect(bp.missing).toEqual(['passenger2.name', 'passenger2.age', 'passenger2.gender']);
    expect(bp).toMatchObject({ train: { number: '12497' }, class: '3A', passengerCount: 2, availabilityCheck: 'NOT_CHECKED', fareCheck: 'NOT_CHECKED' });
    expect(JSON.stringify(bp)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(h.s().review).toMatchObject({ reviewVersion: 1, valid: true });
  });

  it('[3] one natural message with train + class + count + both passengers → review from THIS turn\'s availability + fare', async () => {
    const h = native();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say(ALL_IN_ONE);
    expect(h.s().passengers.map((p: any) => [p.name, p.age, p.gender])).toEqual([['Rahul', 31, 'MALE'], ['Neha', 28, 'FEMALE']]);
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(delta(n0)).toEqual({ search: 0, avail: 1, fare: 1 });               // the review boundary refresh only
    expect(h.s().review.snapshot).toMatchObject({ reviewVersion: 1, travelClass: '3A', availability: { status: 'VERIFIED' }, fare: { status: 'VERIFIED', total: 1300 } });
    for (const re of [/12497/, /3A/, /1300/, /Available/i]) expect(r.voice.assistantText).toMatch(re);     // informed confirmation
    expect(shown(r)).not.toMatch(NO_SUCCESS);
    expect(audit(r)).toMatchObject({ trainNumber: '12497', travelClass: '3A', availabilityRefresh: 'DATA', fareRefresh: 'DATA', reviewCreatedAt: expect.any(String) });
  });

  it('[4] voice review speaks the confirmed facts; text and voice share one session', async () => {
    const h = native();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say(ALL_IN_ONE, 'VOICE');
    for (const re of [/12497/, /3A/, /1300/]) expect(r.voice.speechText ?? r.voice.assistantText).toMatch(re);
    const c = await h.say('haan confirm', 'TEXT');                               // switch modality → same review / handoff
    expect(h.s().bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(h.s().confirmation).toMatchObject({ reviewVersion: 1, status: 'VALID' });
    expect(shown(c)).not.toMatch(NO_SUCCESS);
  });
});

describe('P33 G3 — corrections invalidate review / confirmation / handoff', () => {
  it('[5] passenger correction at review → new review version built from fresh availability + fare (no previous-turn fare)', async () => {
    const h = native();
    await toReview(h);
    const n0 = { ...rail.n };
    const r = await h.say('Rahul ki age 32 hai, 31 nahi');
    expect(h.s().passengers[0].age).toBe(32);
    expect(h.s().review).toMatchObject({ reviewVersion: 2, valid: true });
    expect(delta(n0)).toEqual({ search: 0, avail: 1, fare: 1 });
    expect(shown(r)).toMatch(/32/);
    expect(shown(r)).not.toMatch(/Cancellation, modification ya refund/);       // a preparation change is not a lifecycle claim
  });

  it('[6] count 2 → 3 keeps the valid passengers, asks only for P3, invalidates the review, no railway calls', async () => {
    const h = native();
    await toReview(h);
    const n0 = { ...rail.n };
    await h.say('Actually 3 log hain');
    expect(h.s().passengers.map((p: any) => p.name)).toEqual(['Rahul', 'Neha', undefined]);
    expect(h.s().review.valid).toBe(false);
    expect(h.s().bookingState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0 });
  });

  it('[7] train + class change after handoff → handoff + confirmation INVALIDATED; new review for 12014 CC; old handoff unusable', async () => {
    const h = native();
    await toHandoff(h);
    const oldId = h.s().handoffSession.handoffSessionId;
    const r = await h.say('Actually 12014 ki CC');
    expect(h.s().handoffSession.status).toBe('INVALIDATED');
    expect(h.s().handoffSession.statusReason).toMatch(/BOOKING_DETAILS_CHANGED/);
    expect(h.s().confirmation.status).toBe('INVALIDATED');
    expect(h.s().review.snapshot).toMatchObject({ reviewVersion: 2, travelClass: 'CC', train: { number: '12014' }, fare: { total: 1040 } });
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(audit(r).invalidationReason ?? h.s().handoffSession.statusReason).toBeTruthy();
    expect(await h.orch.preparation.consumeHandoff(h.sid, oldId, pctx() as any)).toMatchObject({ ok: false, executorAttempted: false });
  });

  it('[8] date change after handoff → INVALIDATED; train revalidated against the NEW list; review for the new date', async () => {
    const h = native();
    await toHandoff(h);
    await h.say('Date parso kar do');
    expect(h.s().handoffSession.status).toBe('INVALIDATED');
    expect(h.s().date).toBe(PARSO);
    expect(h.s().review?.snapshot?.journey?.date ?? PARSO).toBe(PARSO);
    expect(h.s().bookingState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[9] route change at review → the review is no longer valid; no review / handoff for the old route', async () => {
    const h = native();
    await toReview(h);
    await h.say('Amritsar nahi, Ludhiana se');
    expect(h.s().origin).toBe('LDH');
    expect(h.s().review?.valid ?? false).toBe(false);
    expect([BookingState.AWAITING_CONFIRMATION, BookingState.IRCTC_HANDOFF_READY]).not.toContain(h.s().bookingState);
    expect(h.s().handoffSession).toBeUndefined();
  });
});

describe('P33 G3 — review failures report the real reason (no valid review)', () => {
  for (const [name, mode, re] of [
    ['availability TIMEOUT', { avail: 'timeout' }, /availability check mein railway provider ne time par jawab nahi diya/],
    ['fare PROVIDER_FAILURE', { fare: 'fail' }, /fare check mein railway provider abhi uplabdh nahi hai/],
    ['fare MALFORMED', { fare: 'malformed' }, /fare check mein provider ka jawab sahi format mein nahi tha/]
  ] as Array<[string, Record<string, Mode>, RegExp]>) {
    it(`[10] ${name} during review → no review, honest reason, never "ready"`, async () => {
      const h = native();
      await h.say('Kal Amritsar se Delhi jaana hai');
      rail.mode = mode;
      const r = await h.say(ALL_IN_ONE);
      expect(h.s().review?.valid ?? false).toBe(false);
      expect(h.s().bookingState).toBe(BookingState.PASSENGERS_READY);
      expect(r.voice.assistantText).toMatch(re);
      expect(r.voice.assistantText).toMatch(/review abhi nahi bana/);
      expect(shown(r)).not.toMatch(/Review ready|booking ready|handoff ready|₹\s?\d/i);
      expect(r.cards.find((c: any) => c.type === 'review')).toBeUndefined();
    });
  }

  it('[11] after a failure the user retries → fresh calls → review (nothing reused from the failed turn)', async () => {
    const h = native();
    await h.say('Kal Amritsar se Delhi jaana hai');
    rail.mode = { avail: 'timeout' };
    await h.say(ALL_IN_ONE);
    rail.mode = {};
    const n0 = { ...rail.n };
    await h.say('haan dobara check karo');
    expect(delta(n0).avail).toBe(1);
    expect(h.s().review).toMatchObject({ valid: true });
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
  });

  it('[12] availability changes between review and confirmation → old review invalidated, rebuilt from the newest result, no handoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = native();
    await toReview(h);
    expect(h.s().review.snapshot.availability.value).toMatch(/available/i);
    vi.setSystemTime(Date.now() + 3 * 60_000);                                  // beyond the availability window
    rail.mode = { avail: 'wl' };
    const r = await h.say('haan confirm');
    expect(h.s().handoffSession?.status === 'READY').toBe(false);
    expect(h.s().bookingState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(h.s().review.reviewVersion).toBeGreaterThan(1);
    expect(h.s().review.snapshot.availability.value).toBe('WL 5');
    expect(shown(r)).not.toMatch(NO_SUCCESS);
  });
});

describe('P33 G3 — confirmation + handoff', () => {
  it('[13] ambiguous "theek hai" and "do it" never confirm', async () => {
    const h = native();
    await toReview(h);
    const r = await h.say('theek hai');
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(h.s().handoffSession).toBeUndefined();
    expect(shown(r)).toMatch(/confirm karni hai\?/i);
    await h.say('do it');
    expect(h.s().handoffSession).toBeUndefined();
    expect(h.s().bookingState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[14] "haan confirm" → IRCTC_HANDOFF_READY bound to review v1; execution disabled; audit trail; no IRCTC call', async () => {
    const h = native();
    const r = await toHandoff(h);
    const s = h.s();
    expect(s.bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(s.confirmation).toMatchObject({ reviewVersion: 1, status: 'VALID' });
    expect(s.handoffSession.status).toBe('READY');
    expect(shown(r)).toMatch(/booking abhi enabled nahi hai/i);
    expect(shown(r)).not.toMatch(NO_SUCCESS);
    expect(audit(r)).toMatchObject({ handoffSessionId: s.handoffSession.handoffSessionId, handoffState: 'READY', confirmedAt: expect.any(String), confirmationState: 'VALID' });
    expect(JSON.stringify(audit(r))).not.toMatch(/Rahul|Neha/);
    expect(handoffSpy).not.toHaveBeenCalled();
  });

  it('[15] repeated confirmation never creates a second handoff', async () => {
    const h = native();
    await toHandoff(h);
    const id = h.s().handoffSession.handoffSessionId;
    const histLen = (h.s().handoffSessionHistory || []).length;
    const r = await h.say('haan confirm karo');
    expect(h.s().handoffSession.handoffSessionId).toBe(id);
    expect((h.s().handoffSessionHistory || []).length).toBe(histLen);
    expect(shown(r)).not.toMatch(NO_SUCCESS);
  });

  it('[16] handoff expiry → EXPIRED; consume rejected; not resurrected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = native();
    await toHandoff(h);
    const id = h.s().handoffSession.handoffSessionId;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(h.orch.preparation.handoffSessions.check(h.s(), Date.now())).toMatchObject({ status: 'EXPIRED' });
    expect(await h.orch.preparation.consumeHandoff(h.sid, id, pctx() as any)).toMatchObject({ ok: false, code: 'HANDOFF_SESSION_EXPIRED', executorAttempted: false });
    expect(h.s().bookingState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
  });
});

describe('P33 G3 — truthfulness, voice interruption, security', () => {
  it('[17] a false "Review ready" before any review is removed', async () => {
    const h = native({ 'Rahul 31 male': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGER', { passengerChanges: PAX([1, { name: 'Rahul', age: 31, gender: 'male' }]) })] }, { content: 'Review ready. Doosre passenger ki details?' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('Doosri wali 3A mein 2 tickets');
    const r = await h.say('Rahul 31 male');
    expect(h.s().review).toBeUndefined();
    expect(r.voice.assistantText).not.toMatch(/Review ready/i);
  });

  it('[18] fake success / PNR after handoff is never shown', async () => {
    const h = native();
    await toHandoff(h);
    const r = await h.say('Ticket book ho gayi?');
    expect(shown(r)).not.toMatch(NO_SUCCESS);
    expect(shown(r)).not.toMatch(/4512345678/);
  });

  it('[19] voice interruption (barge-in) keeps the booking state; confirmation still works afterwards', async () => {
    const h = native();
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say(ALL_IN_ONE, 'VOICE');
    h.eng.interrupt(h.sid, 'USER_STOP');
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(h.s().review).toMatchObject({ reviewVersion: 1, valid: true });
    await h.say('haan confirm', 'VOICE');
    expect(h.s().bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[20] a booking tool proposed by the LLM is rejected (no BOOK_TICKET / payment / IRCTC)', async () => {
    const h = native();
    await toReview(h);
    const r = await h.say('seedha book kar do');
    expect(r.turnLog.toolExecutions.map((e: any) => e.status)).not.toContain('SUCCEEDED');
    expect(h.s().handoffSession).toBeUndefined();
    expect(shown(r)).not.toMatch(/Booked!|book ho gayi/i);
    expect(handoffSpy).not.toHaveBeenCalled();
  });

  it('[21] secrets: the API key never appears in any output, session or log; no network beyond the fake LLM', () => {
    const all = outputs.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toMatch(/password|otp\b|captcha|cvv|upi pin/i);
    expect(all).not.toContain('"sourceResultId"');
    for (const c of fetchSpy.mock.calls) expect(String(c[0])).toMatch(/^https:\/\/llm\.fake\.test|^http:\/\/127\.0\.0\.1:/);
  });
});
