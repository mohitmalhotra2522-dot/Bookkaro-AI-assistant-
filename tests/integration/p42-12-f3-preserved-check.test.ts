/**
 * P42-12 F3 (live-verification fix) — an UNSELECTED train's fresh CHECK_AVAILABILITY survives into later turns as
 * evidence (session.infoAvailability, evidence-only), so the older search-list value can no longer win.
 * Live failure reproduced: list 12014 CC "AVAILABLE-0097", CHECK → "AVAILABLE 92"; next turn the correct 92 was
 * rejected and a stale 97 would have passed as VERIFIED.
 * Precedence: same-turn CHECK (and the selection's committed CHECK) > preserved CHECK (exact train + class + date + route
 * + current result set) > current search row > unverified.
 * Real orchestrator + turn engine + runtime + composer; a fake OpenAI-compatible server plays Muse; the mock provider
 * (ASR→NDLS: 12014 · 12497 · 18238) is wrapped so 12497 CC is listed "AVAILABLE-0097" and CHECK answers per test.
 *   [1] unselected fresh CHECK → this turn uses the CHECK      [2] same train next turn → preserved 92 beats list 97
 *   [3] train / class / date / route / result-set mismatch → the record never applies (offline, live-shaped rows)
 *   [4] date change clears it    [5] route change clears it    [6] a genuinely new search invalidates it
 *   [7] selected train unchanged [8] a cross-train CHECK never changes the selection / booking state
 *   [9] "Availability batao" (no reference) still asks; never resolved from the record
 *   [10] ambiguous reference still asks    [11] priority: same-turn CHECK > preserved; failed CHECK / fresh request
 *   [12] offline replay of the live S1-10 → S1-12 context (97 → 92)
 * No network, no credits, no booking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { bindAndVerifyClaims } from '../../server/ai/response/claim-entity-binding';
import {
  collectAvailabilityEvidence, judgeAvailabilityClaim, infoAvailabilityRecord, infoAvailabilityKey, infoAvailabilityApplies
} from '../../server/ai/response/availability-authority';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

/** per-test CHECK answers: 'train|class' → status (or 'FAIL' = provider error) */
const CHECK: Record<string, string> = {};
class F3Provider extends MockRailwayProvider {
  async searchTrains(req: any): Promise<any> {
    const r: any = await super.searchTrains(req);
    if (r.ok) for (const t of r.data.trains || []) for (const c of t.classes || [])
      if (String(t.trainNumber ?? t.number) === '12497' && c.code === 'CC') { c.availability = 'AVAILABLE-0097'; c.availabilityStatus = 'AVAILABLE'; }
    return r;
  }
  async checkAvailability(req: any): Promise<any> {
    const o = CHECK[`${req.trainNumber}|${req.travelClass}`];
    if (o === 'FAIL') return super.checkAvailability({ ...req, travelClass: 'XX' });
    const r: any = await super.checkAvailability(req);
    if (o && r.ok) { r.data.status = o; r.data.available = /^AVAILABLE/i.test(o); }
    return r;
  }
}
railwayRegistry.register('p4212f3', () => new F3Provider());

const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = (date: string = D1) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const AV = (args: any) => ({ name: 'CHECK_AVAILABILITY', args });
const SEARCH_T = 'Kal Amritsar se Delhi ki trains dikhao';
const SEARCH_TURN = { [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ke liye 3 trains mili hain.' }] };
const SELECT_12014 = { '12014 CC select karo': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: '12014 CC select ho gayi.' }] };
const CHECK_12497_T = 'Shan-e-Punjab ki CC availability check karo';
const CHECK_12497 = { [CHECK_12497_T]: [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: '12497 CC mein AVAILABLE 92 seats hain.' }] };
const SAY92 = '12497 CC mein AVAILABLE 92 seats hain.';
const SAY97 = '12497 CC mein AVAILABLE 97 seats hain.';
const ASK92 = 'Shan-e-Punjab CC mein kitni seats hain?';
const ASK97 = 'Shan-e-Punjab CC ka status kya hai?';
const NEXT = { [ASK92]: [{ content: SAY92 }], [ASK97]: [{ content: SAY97 }] };

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4212F3', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 300, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const text = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? '');
const execsOf = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]);
const av = (r: any) => execsOf(r).filter(x => x.tool === 'CHECK_AVAILABILITY').map(x => [x.status, x.rejectionReason ?? null]);
const rejected = (r: any) => (r?.turnLog?.naturalSpeech?.rejected || []) as string[];
const selected = (h: any) => h.s().selectedTrain ? String(h.s().selectedTrain.number ?? h.s().selectedTrain.trainNumber) : null;
const info = (h: any) => Object.values(h.s().infoAvailability || {}) as any[];
const listCC12497 = (h: any) => (h.s().searchResults?.trains || []).find((t: any) => String(t.trainNumber ?? t.number) === '12497')?.classes?.find((c: any) => c.code === 'CC')?.availability;

/** offline, live-shaped session (RailCore raw strings) — the live S1 list */
const liveSession = (extra: any = {}) => ({
  origin: 'ASR', destination: 'NDLS', date: '2026-10-09', selectedTrain: null, ...extra,
  searchResults: { date: '2026-10-09', origin: 'ASR', destination: 'NDLS', resultId: 'ce04c720-live', trains: [
    { trainNumber: '12014', classes: [{ code: 'CC', availability: 'AVAILABLE-0097', availabilityStatus: 'AVAILABLE' }, { code: 'EC', availability: 'GNWL12/WL11', availabilityStatus: 'WAITLIST' }] },
    { trainNumber: '12716', classes: [{ code: '3A', availability: 'PQWL38/WL18', availabilityStatus: 'WAITLIST' }] },
    { trainNumber: '12904', classes: [{ code: 'SL', availability: 'PQWL154/WL102', availabilityStatus: 'WAITLIST' }, { code: '2A', availability: 'PQWL30/WL16', availabilityStatus: 'WAITLIST' }] }
  ] }
});
const verdict = (s: any, t: string, steps: any[] = [], userText?: string) => judgeAvailabilityClaim(t, { session: s, evidence: collectAvailabilityEvidence(s, steps, { userText }) });
const preserve = (s: any, train: string, cls: string, status: string, args: any = {}) => {
  const rec = infoAvailabilityRecord(s, { trainNumber: train, travelClass: cls, ...args }, { status, available: /^AVAILABLE/.test(status) }, { toolExecutionId: `te_${train}_${cls}` });
  if (rec) s.infoAvailability = { ...(s.infoAvailability || {}), [infoAvailabilityKey(rec)]: rec };
  return rec;
};

let fetchSpy: any; let availSpy: any;
beforeEach(() => {
  for (const k of Object.keys(CHECK)) delete CHECK[k];
  CHECK['12497|CC'] = 'AVAILABLE 92';
  railwayRegistry.setActive('p4212f3');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(F3Provider.prototype, 'checkAvailability');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('P42-12 F3 — an unselected train\'s fresh CHECK outlives its turn as evidence', () => {
  it('[1] unselected train, fresh CHECK → the current turn uses the CHECK (92), not the list (97); the record is bound exactly', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497, 'Shan-e-Punjab ka CC dobara dekho': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: SAY97 }] });
    await h.say(SEARCH_T);
    expect(listCC12497(h)).toBe('AVAILABLE-0097');
    const r = await h.say(CHECK_12497_T);
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(rejected(r)).toEqual([]);
    expect(text(r)).toMatch(/^12497 CC mein AVAILABLE 92 seats hain\./);
    expect(info(h)).toEqual([expect.objectContaining({ trainNumber: '12497', travelClass: 'CC', date: D1, origin: 'ASR', destination: 'NDLS',
      status: 'AVAILABLE 92', searchResultId: h.s().searchResults.resultId })]);
    expect(Object.keys(h.s().infoAvailability)).toEqual([`12497|CC|${D1}|ASR|NDLS`]);
    const r2 = await h.say('Shan-e-Punjab ka CC dobara dekho');            // same-turn CHECK 92 again; the stale 97 is removed
    expect(av(r2)).toEqual([['SUCCEEDED', null]]);
    expect(rejected(r2)[0]).toMatch(/^AVAILABILITY_MISMATCH/);
    expect(text(r2)).not.toMatch(/AVAILABLE 97/);
  }, 30000);

  it('[2] the live failure: next turn, the same unselected train → preserved 92 is VERIFIED; the stale list 97 is rejected', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497, ...NEXT });
    await h.say(SEARCH_T); await h.say(CHECK_12497_T);
    const n0 = availSpy.mock.calls.length;
    const r1 = await h.say(ASK92);
    expect(execsOf(r1)).toEqual([]);
    expect(rejected(r1)).toEqual([]);
    expect(text(r1)).toMatch(/^12497 CC mein AVAILABLE 92 seats hain\./);
    const r2 = await h.say(ASK97);
    expect(execsOf(r2)).toEqual([]);
    expect(rejected(r2)[0]).toMatch(/^AVAILABILITY_MISMATCH/);
    expect(text(r2)).not.toMatch(/AVAILABLE 97/);
    expect(availSpy.mock.calls.length).toBe(n0);                         // no provider call — the record is evidence only
    expect(listCC12497(h)).toBe('AVAILABLE-0097');                       // the list itself is never rewritten
  }, 30000);

  it('[3] exact binding: another class / date / route / result set, or a train outside the list → the record never applies', () => {
    const base = liveSession();
    const rec = preserve(base, '12014', 'CC', 'AVAILABLE 92')!;
    expect(rec).toMatchObject({ trainNumber: '12014', travelClass: 'CC', date: '2026-10-09', origin: 'ASR', destination: 'NDLS', searchResultId: 'ce04c720-live' });
    expect(verdict(base, '12014 CC mein AVAILABLE 92 seats hain.').outcome).toBe('VERIFIED_AVAILABILITY');
    expect(verdict(base, '12014 CC mein AVAILABLE 97 seats hain.').outcome).toBe('AVAILABILITY_MISMATCH');
    // another class of the same train: the record says nothing about EC (EC stays the row's WL 11)
    expect(verdict(base, '12014 EC mein WL 11 hai.').outcome).toBe('VERIFIED_AVAILABILITY');
    expect(verdict(base, '12014 EC mein AVAILABLE 92 seats hain.').outcome).toBe('AVAILABILITY_MISMATCH');
    // another train: 12904 2A stays the row's WL 16
    expect(verdict(base, '12904 2A mein AVAILABLE 92 seats hain.').outcome).toBe('AVAILABILITY_MISMATCH');
    const variants: Array<[string, any]> = [
      ['date', { ...base, date: '2026-10-10', searchResults: { ...base.searchResults, date: '2026-10-10' } }],
      ['route', { ...base, destination: 'DLI', searchResults: { ...base.searchResults, destination: 'DLI' } }],
      ['result set', { ...base, searchResults: { ...base.searchResults, resultId: 'new-search' } }],
      ['no list', { ...base, searchResults: undefined }]
    ];
    for (const [why, s] of variants) {
      expect(infoAvailabilityApplies(rec, s), why).toBe(false);
      expect(collectAvailabilityEvidence(s).some(e => e.origin === 'PRESERVED_CHECK'), why).toBe(false);
      expect(verdict(s, '12014 CC mein AVAILABLE 92 seats hain.').outcome, why).not.toBe('VERIFIED_AVAILABILITY');
    }
    // the CHECK is never preserved for a train outside the current list, another date, or without a list
    expect(infoAvailabilityRecord(base, { trainNumber: '99999', travelClass: 'CC' }, { status: 'AVAILABLE 5' })).toBeNull();
    expect(infoAvailabilityRecord(base, { trainNumber: '12014', travelClass: 'CC', date: '2026-10-11' }, { status: 'AVAILABLE 5' })).toBeNull();
    expect(infoAvailabilityRecord({ ...base, searchResults: undefined }, { trainNumber: '12014', travelClass: 'CC' }, { status: 'AVAILABLE 5' })).toBeNull();
  });

  it('[4] date change clears the cross-train CHECK; on the new date the old 92 proves nothing', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497, ...NEXT,
      'Kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' })] }, { content: 'Date parso kar di.' }],
      'Parso ki trains dikhao': [{ calls: [SEARCH(ist(2))] }, { content: 'Parso ke liye 3 trains mili hain.' }] });
    await h.say(SEARCH_T); await h.say(CHECK_12497_T);
    expect(info(h)).toHaveLength(1);
    await h.say('Kal nahi parso');
    expect(h.s().date).toBe(ist(2));
    expect(h.s().infoAvailability).toBeUndefined();
    await h.say('Parso ki trains dikhao');
    const r = await h.say(ASK92);
    expect(rejected(r)[0]).toMatch(/^AVAILABILITY_MISMATCH/);            // the new date's row (97) is the only evidence
    expect(text(r)).not.toMatch(/AVAILABLE 92/);
  }, 30000);

  it('[5] route change clears the cross-train CHECK', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497,
      'Amritsar nahi, Ludhiana se': [{ calls: [U('UPDATE_JOURNEY', 'UPDATE_JOURNEY', { originRaw: 'Ludhiana', correctionTarget: 'origin' })] }, { content: 'Ludhiana se trains dekhni hongi.' }] });
    await h.say(SEARCH_T); await h.say(CHECK_12497_T);
    const rec = info(h)[0];
    expect(rec).toBeTruthy();
    await h.say('Amritsar nahi, Ludhiana se');
    expect(h.s().origin).toBe('LDH');
    expect(h.s().infoAvailability).toBeUndefined();
    expect(infoAvailabilityApplies(rec, h.s())).toBe(false);
  }, 30000);

  it('[6] a genuinely new search (same route + date) invalidates the old cross-train CHECK; the new list is evidence again', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497, ...NEXT, 'Trains phir se dikhao': [{ calls: [SEARCH()] }, { content: 'Kal ke liye 3 trains mili hain.' }] });
    await h.say(SEARCH_T); await h.say(CHECK_12497_T);
    const rec = info(h)[0];
    const old = h.s().searchResults.resultId;
    await h.say('Trains phir se dikhao');
    expect(h.s().searchResults.resultId).not.toBe(old);
    expect(h.s().infoAvailability).toBeUndefined();
    expect(infoAvailabilityApplies(rec, h.s())).toBe(false);             // even a re-attached record would not bind
    const r1 = await h.say(ASK92);
    expect(rejected(r1)[0]).toMatch(/^AVAILABILITY_MISMATCH/);
    const r2 = await h.say(ASK97);
    expect(rejected(r2)).toEqual([]);                                     // the NEW list's own value
    expect(text(r2)).toMatch(/^12497 CC mein AVAILABLE 97 seats hain\./);
  }, 30000);

  it('[7] selected train unchanged: its CHECK still commits to booking availability (not to the evidence record) and verifies next turn', async () => {
    CHECK['12014|CC'] = 'AVAILABLE 41';
    const h = stack({ ...SEARCH_TURN, ...SELECT_12014,
      '12014 CC check karo': [{ calls: [AV({ trainNumber: '12014', travelClass: 'CC' })] }, { content: '12014 CC mein AVAILABLE 41 seats hain.' }],
      '12014 CC mein kitni seats?': [{ content: '12014 CC mein AVAILABLE 41 seats hain.' }] });
    await h.say(SEARCH_T); await h.say('12014 CC select karo');
    const r = await h.say('12014 CC check karo');
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(h.s().availability.CC).toMatchObject({ trainNumber: '12014', travelClass: 'CC', status: 'AVAILABLE 41', date: D1 });
    expect(h.s().infoAvailability).toBeUndefined();
    const r2 = await h.say('12014 CC mein kitni seats?');
    expect(rejected(r2)).toEqual([]);
    expect(text(r2)).toMatch(/^12014 CC mein AVAILABLE 41 seats hain\./);
    expect(collectAvailabilityEvidence(h.s()).filter(e => e.trainNumber === '12014' && e.travelClass === 'CC').map(e => [e.origin, e.status])).toEqual([['SESSION', 'AVAILABLE 41']]);
  }, 30000);

  it('[8] a cross-train CHECK never changes the selection or any booking state (text and voice)', async () => {
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const h = stack({ ...SEARCH_TURN, ...SELECT_12014, ...CHECK_12497 });
      await h.say(SEARCH_T, mode); await h.say('12014 CC select karo', mode);
      const before = JSON.parse(JSON.stringify({ selectedTrain: h.s().selectedTrain, selectedClass: h.s().selectedClass, availability: h.s().availability ?? null,
        fare: h.s().fare ?? null, passengersCount: h.s().passengersCount, passengers: h.s().passengers, bookingState: h.s().bookingState, review: h.s().review ?? null }));
      const r = await h.say(CHECK_12497_T, mode);
      expect(av(r)).toEqual([['SUCCEEDED', null]]);
      expect(rejected(r)).toEqual([]);
      const after = JSON.parse(JSON.stringify({ selectedTrain: h.s().selectedTrain, selectedClass: h.s().selectedClass, availability: h.s().availability ?? null,
        fare: h.s().fare ?? null, passengersCount: h.s().passengersCount, passengers: h.s().passengers, bookingState: h.s().bookingState, review: h.s().review ?? null }));
      expect(after).toEqual(before);
      expect(selected(h)).toBe('12014');
      expect(h.s().selectedClass).toBe('CC');
      expect(info(h).map(x => [x.trainNumber, x.travelClass, x.status])).toEqual([['12497', 'CC', 'AVAILABLE 92']]);
    }
  }, 60000);

  it('[9] "Availability batao" with no train reference still asks — never resolved from the preserved record', async () => {
    const h = stack({ ...SEARCH_TURN, ...SELECT_12014, ...CHECK_12497,
      'Availability batao': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: 'Kaunsi train ki availability chahiye — 12014 CC ya koi aur?' }] });
    await h.say(SEARCH_T); await h.say('12014 CC select karo'); await h.say(CHECK_12497_T);
    const n0 = availSpy.mock.calls.length;
    const r = await h.say('Availability batao');
    expect(av(r)).toEqual([['REJECTED', 'CONTEXT_CONFLICT']]);           // the LLM may not pick the remembered train itself
    expect(availSpy.mock.calls.length).toBe(n0);
    expect(text(r)).toBe('Kaunsi train ki availability chahiye — 12014 CC ya koi aur?');
    expect(selected(h)).toBe('12014');
    // no selection at all: still a clarification, the remembered train is never chosen
    const h2 = stack({ ...SEARCH_TURN, ...CHECK_12497, 'Availability batao': [{ content: 'Kaunsi train aur class ki availability chahiye?' }] });
    await h2.say(SEARCH_T); await h2.say(CHECK_12497_T);
    const r2 = await h2.say('Availability batao');
    expect(execsOf(r2)).toEqual([]);
    expect(text(r2)).toBe('Kaunsi train aur class ki availability chahiye?');
    expect(selected(h2)).toBeNull();
  }, 30000);

  it('[10] an ambiguous reference still gets AMBIGUOUS_REFERENCE with candidates — no guess, no provider call', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497,
      'Morning wali ki CC availability': [{ calls: [AV({ trainRef: { kind: 'TIME_PREFERENCE', value: 'MORNING' }, travelClass: 'CC' })] },
        (v: TurnView) => { const e = v.results[0]?.content?.error || {}; return { content: e.code === 'AMBIGUOUS_REFERENCE' ? `Kaunsi train — ${e.candidates.join(' ya ')}?` : 'WRONG' }; }] });
    await h.say(SEARCH_T); await h.say(CHECK_12497_T);
    const n0 = availSpy.mock.calls.length;
    const r = await h.say('Morning wali ki CC availability');
    expect(av(r)).toEqual([['REJECTED', 'AMBIGUOUS_REFERENCE']]);
    expect(text(r)).toBe('Kaunsi train — 12014 ya 12497?');
    expect(availSpy.mock.calls.length).toBe(n0);
  }, 30000);

  it('[11] priority: a same-turn CHECK beats the preserved one (and replaces it); a failed CHECK or a fresh request is never answered from it', async () => {
    const h = stack({ ...SEARCH_TURN, ...CHECK_12497,
      'Shan-e-Punjab CC phir check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: SAY92 }],
      'Shan-e-Punjab CC ek baar aur check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: '12497 CC mein AVAILABLE 90 seats hain.' }],
      'Shan-e-Punjab CC last baar check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: '12497 CC mein AVAILABLE 90 seats hain.' }],
      'Abhi Shan-e-Punjab CC ki fresh availability batao': [{ content: '12497 CC mein AVAILABLE 90 seats hain.' }] });
    await h.say(SEARCH_T); await h.say(CHECK_12497_T);
    CHECK['12497|CC'] = 'AVAILABLE 90';
    const r1 = await h.say('Shan-e-Punjab CC phir check karo');          // CHECK now 90: the preserved 92 no longer verifies
    expect(av(r1)).toEqual([['SUCCEEDED', null]]);
    expect(rejected(r1)[0]).toMatch(/^AVAILABILITY_MISMATCH/);
    expect(info(h).map(x => x.status)).toEqual(['AVAILABLE 90']);         // the newest CHECK replaces the record
    const r2 = await h.say('Shan-e-Punjab CC ek baar aur check karo');
    expect(rejected(r2)).toEqual([]);
    CHECK['12497|CC'] = 'FAIL';
    const r3 = await h.say('Shan-e-Punjab CC last baar check karo');      // a failed CHECK this turn stays a failure
    expect(av(r3)[0][0]).not.toBe('SUCCEEDED');
    expect(text(r3)).not.toMatch(/AVAILABLE 90/);
    expect(info(h).map(x => x.status)).toEqual(['AVAILABLE 90']);         // the failure never overwrites it with nothing
    const r4 = await h.say('Abhi Shan-e-Punjab CC ki fresh availability batao');   // explicit fresh request, no provider call
    expect(execsOf(r4).filter(x => x.tool === 'CHECK_AVAILABILITY' && x.status === 'SUCCEEDED')).toEqual([]);
    expect(text(r4)).not.toMatch(/AVAILABLE 90/);
  }, 30000);

  it('[12] offline replay of the live S1-10 → S1-12 context: list 97, CHECK 92 → the next turn verifies 92 and rejects 97', () => {
    const s = liveSession({ selectedTrain: null, availability: undefined });
    const user = '12014 CC mein kitni seats hain?';
    const say92 = '12014 AMRITSAR SHTABDI CC mein AVAILABLE 92 seats hain.';
    const say97 = '12014 AMRITSAR SHTABDI CC mein AVAILABLE 97 seats hain.';
    // BEFORE the fix (nothing preserved): exactly the live symptom
    expect(bindAndVerifyClaims(say97, s, [], { userText: user }).rejected).toEqual([]);
    expect(bindAndVerifyClaims(say92, s, [], { userText: user }).rejected.map(x => x.reason)).toEqual(['AVAILABILITY_MISMATCH:AVAILABLE 92']);
    // the CHECK turn (S1-10) — as the runtime records an unselected-train CHECK
    preserve(s, '12014', 'CC', 'AVAILABLE 92');
    // AFTER: the next turn (S1-12)
    expect(bindAndVerifyClaims(say92, s, [], { userText: user }).rejected).toEqual([]);
    expect(bindAndVerifyClaims(say97, s, [], { userText: user }).rejected.map(x => x.reason)).toEqual(['AVAILABILITY_MISMATCH:AVAILABLE 97']);
    expect(verdict(s, say92, [], user)).toMatchObject({ outcome: 'VERIFIED_AVAILABILITY', provenance: { sourceTool: 'CHECK_AVAILABILITY', availability: 'AVAILABLE 92' } });
    expect(collectAvailabilityEvidence(s).filter(e => e.trainNumber === '12014' && e.travelClass === 'CC').map(e => [e.origin, e.status])).toEqual([['PRESERVED_CHECK', 'AVAILABLE 92']]);
    // a same-turn CHECK still outranks it, and a fresh request never uses it
    const step = { status: 'ok', result: { toolName: 'CHECK_AVAILABILITY', success: true, data: { trainNumber: '12014', travelClass: 'CC', date: '2026-10-09', status: 'AVAILABLE 88' } } };
    expect(verdict(s, say92, [step]).outcome).toBe('AVAILABILITY_MISMATCH');
    expect(verdict(s, '12014 CC mein AVAILABLE 88 seats hain.', [step]).outcome).toBe('VERIFIED_AVAILABILITY');
    expect(verdict(s, say92, [], 'Abhi dobara 12014 CC check karo').outcome).not.toBe('VERIFIED_AVAILABILITY');
    // a waitlist record stays a waitlist (never seats)
    preserve(s, '12716', '3A', 'WL 17');
    expect(verdict(s, '12716 3A mein WL 17 hai.').outcome).toBe('VERIFIED_AVAILABILITY');
    expect(verdict(s, '12716 3A mein WL 18 hai.').outcome).toBe('AVAILABILITY_MISMATCH');
    expect(verdict(s, '12716 3A mein 17 seats available hain.').outcome).not.toBe('VERIFIED_AVAILABILITY');
  });
});
