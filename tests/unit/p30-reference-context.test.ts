/**
 * PROMPT 30 — G2: contextual reference resolution + agent memory hardening (focused unit tests, offline).
 * The LLM interprets "doosri wali", "iska", "same class"; the backend only validates the entity it chose against the
 * CURRENT result set, keeps provenance, and never lets stale / failed / discarded work move the focus.
 * MockLLM / an injected fake OpenAI-compatible server; mock railway spy. No network, credits, booking or handoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { TrainReferenceResolver, currentResults } from '../../server/ai/context/train-reference-resolver';
import { ClassReferenceResolver } from '../../server/ai/context/class-reference-resolver';
import { buildLLMContext } from '../../server/ai/context/context-builder';
import { recordTrainReference, referenceContextView, resultSetOf } from '../../server/ai/context/reference-context';
import { verifyReferenceClaims, guardReferenceClaims } from '../../server/ai/response/reference-claims';

const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---- full-stack harness (mock railway spy: failure / gate / omit switches) ----
const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p30u-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; failInfo = 0; infoGate: Promise<void> | null = null; omit: { date: string; train: string } | null = null;
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> {
    this.b('search');
    const res: any = await super.searchTrains(r);
    if (this.omit && res.ok && r.date === this.omit.date) res.data = { ...res.data, trains: res.data.trains.filter((t: any) => t.trainNumber !== this.omit!.train) };
    return res;
  }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
  async getTrainInfo(r: any): Promise<any> {
    this.b('info');
    if (this.infoGate) await this.infoGate;
    if (this.failInfo > 0) { this.failInfo--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock train info down.' }, meta: pmeta() }; }
    return super.getTrainInfo(r);
  }
}
const rail = new SpyRailway();
railwayRegistry.register('p30u-spy', () => rail);
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { eng, sid, state, s: () => state.getSession(sid) as any, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => eng.processTurn(sid, t, mode, o) as Promise<any> };
}
function native(plan: Record<string, any[]>) {
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-p30-unit', LLM_MODEL: 'fake', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  return wire(sel.provider);
}
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, ...(cls ? { classRaw: cls } : {}), selectionPurpose: 'INFORMATION' });
const CAV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const INFO = (num: string) => ({ name: 'GET_TRAIN_INFO', args: { trainNumber: num } });
const UPDATE_PARSO = U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' });
const START = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }] };
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare', 'info'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const refs = (r: any) => r.turnLog.diagnostics.references as { records: any[]; claims: any[] };
const flush = () => new Promise(r => setTimeout(r, 15));

/** a session with a REAL current result set (MockLLM search through the full stack) */
async function searched(text = 'Kal Amritsar se Delhi') { const h = wire(new MockLLMProvider({})); await h.say(text); return h; }

function compose(s: any, agentText: string, steps: any[] = []): Promise<any> {
  return naturalResponseComposer.compose({
    llm: { providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn(async () => ({ text: 'W' })) } as any,
    session: s, userText: 'batao', backendReply: 'OK', deterministicSpeech: 'DETERMINISTIC', stateBefore: s.bookingState, reviewVersionBefore: null,
    selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null, steps, appliedActions: [], changes: [], error: null,
    pendingQuestionCode: null, pendingQuestion: null, history: [], mode: 'TEXT', agentText, general: false
  } as any);
}

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p30u-spy');
  Object.assign(rail, { n: {}, failInfo: 0, infoGate: null, omit: null });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore(); handoffSpy.mockRestore();
  railwayRegistry.setActive('mock');
});

const trains = new TrainReferenceResolver();

describe('P30 G2 — display references resolve against the CURRENT result set only', () => {
  it('[1] "doosri wali" → display index 2 of the current set; the record carries the set\'s provenance (date / route / source turn)', async () => {
    const h = await searched();
    const s = h.s();
    const res: any = trains.resolve({ kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: s.searchResultsVersion } as any, s);
    expect(res.ok).toBe(true);
    expect(res.train.trainNumber).toBe(currentResults(s)[1].trainNumber);
    const rec = recordTrainReference({ kind: 'DISPLAY_INDEX', value: 2 } as any, res, s);
    expect(rec).toMatchObject({ status: 'VALID', resolutionType: 'DISPLAY_INDEX', displayIndex: 2, source: { tool: 'SEARCH_TRAINS', date: KAL, route: 'ASR-NDLS', resultSetVersion: s.searchResultsVersion } });
    expect(rec.source!.turnId).toBeTruthy();
    expect(rec.source!.toolResultId).toBeTruthy();
    expect(resultSetOf(s)).toMatchObject({ date: KAL, origin: 'ASR', destination: 'NDLS', current: true, count: 3 });
  });

  it('[2] "last wali" → the last train of the current set (never of an older list)', async () => {
    const h = await searched();
    const s = h.s();
    const list = currentResults(s);
    const res: any = trains.resolve({ kind: 'DEMONSTRATIVE', value: 'LAST' } as any, s);
    expect(res.ok && res.train.trainNumber).toBe(list[list.length - 1].trainNumber);
    expect(recordTrainReference({ kind: 'DEMONSTRATIVE', value: 'LAST' } as any, res, s)).toMatchObject({ resolutionType: 'POSITION', status: 'VALID', displayIndex: list.length });
  });

  it('[3] an old index does not survive a new search: the old version is STALE, and "doosri wali 12497 hai" after a route change is removed', async () => {
    const h = await searched();
    const oldVersion = h.s().searchResultsVersion;
    await h.say('Nahi, Ludhiana se Delhi');
    const s = h.s();
    expect(s.searchResultsVersion).toBeGreaterThan(oldVersion);
    const res: any = trains.resolve({ kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: oldVersion } as any, s);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('STALE_SEARCH_REFERENCE');
    expect(recordTrainReference({ kind: 'DISPLAY_INDEX', value: 2 } as any, res, s).status).toBe('STALE');
    expect(currentResults(s).some(t => t.trainNumber === '12497')).toBe(false);
    expect(verifyReferenceClaims('Doosri wali 12497 hai.', s).reason).toBe('STALE_INDEX_REFERENCE:12497');
    const g = guardReferenceClaims(`Doosri wali 12497 hai. Ludhiana se ${currentResults(s).length} trainein hain.`, s);
    expect(g.text).toBe(`Ludhiana se ${currentResults(s).length} trainein hain.`);
  });

  it('[4] ambiguous "uska" (no focus, several results) → clarification with candidates; nothing is picked', async () => {
    const h = await searched();
    const s = h.s();
    expect(s.focusTrainNumber).toBeUndefined();
    const res: any = trains.resolve({ kind: 'DEMONSTRATIVE', value: 'THIS' } as any, s);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AMBIGUOUS_REFERENCE');
    expect(res.message).toMatch(/12014/);
    expect(res.message).toMatch(/\?/);
    expect(recordTrainReference({ kind: 'DEMONSTRATIVE', value: 'THIS' } as any, res, s)).toMatchObject({ status: 'AMBIGUOUS', ambiguityReason: 'NO_FOCUS_MULTIPLE_RESULTS', resolvedTrainNumber: null });
    expect(h.s().selectedTrain).toBeUndefined();
  });
});

describe('P30 G2 — focus and class carry-over', () => {
  it('[5] the selected train becomes the focus; "iska" (THIS) resolves to it and the LLM context shows it', async () => {
    const h = await searched();
    await h.say('12497 wali');
    const s = h.s();
    expect(s.focusTrainNumber).toBe('12497');
    const res: any = trains.resolve({ kind: 'DEMONSTRATIVE', value: 'THIS' } as any, s);
    expect(res.ok && res.train.trainNumber).toBe('12497');
    expect(buildLLMContext(s, []).referenceContext!.focusTrainNumber).toBe('12497');
  });

  it('[6] an explicitly named train overrides the focus', async () => {
    const h = await searched();
    await h.say('12497 wali');
    const res: any = trains.resolve({ kind: 'TRAIN_NUMBER', value: '12014' } as any, h.s());
    expect(res.ok && res.train.trainNumber).toBe('12014');
    await h.say('12014 wali');
    expect(h.s().focusTrainNumber).toBe('12014');
    expect(h.s().selectedTrain.number).toBe('12014');
  });

  it('[7] a class carries over only when the (new) train lists it — 3A on 12497 yes, 3A on 12014 no', async () => {
    const h = await searched();
    const list = currentResults(h.s());
    const classes = new ClassReferenceResolver();
    const t12497: any = list.find(t => t.trainNumber === '12497');
    const t12014: any = list.find(t => t.trainNumber === '12014');
    expect((classes.resolve('3A', { number: '12497', availableClasses: t12497.classes.map((c: any) => c.code), classes: t12497.classes }) as any).ok).toBe(true);
    expect((classes.resolve('3A', { number: '12014', availableClasses: t12014.classes.map((c: any) => c.code), classes: t12014.classes }) as any).ok).toBe(false);
  });

  it('[8] a class merely listed / an invalid class is never availability evidence', async () => {
    const h = await searched();
    await h.say('12014 wali');
    const out = await compose(h.s(), '12014 mein 3A available hai.');
    expect(out.rejected.map((r: any) => r.reason).join(',')).toMatch(/CLASS_NOT_LISTED|UNVERIFIED_AVAILABILITY/);
    const out2 = await compose(h.s(), '12014 mein CC available hai.');
    expect(out2.rejected.map((r: any) => r.reason).join(',')).toMatch(/UNVERIFIED_AVAILABILITY/);
  });
});

describe('P30 G2 — date / route changes are hard boundaries', () => {
  it('[9] a date change invalidates list, selection, availability, fare and focus; the old choice survives only as an expired preference', async () => {
    const h = await searched();
    await h.say('12497 wali'); await h.say('3A');
    const sid = h.sid;
    Object.assign(h.s(), { availability: { trainNumber: '12497', classCode: '3A', date: KAL, status: 'AVAILABLE' }, fare: { trainNumber: '12497', classCode: '3A', perPassenger: 650 } });
    const n0 = { ...rail.n };
    h.s().date = PARSO;
    h.state.invalidate(sid, 'DATE');
    const s = h.s();
    for (const k of ['searchResults', 'selectedTrain', 'selectedClass', 'availability', 'fare', 'focusTrainNumber', 'focusTurnId']) expect(s[k]).toBeUndefined();
    expect(s.staleReference).toEqual({ trainNumber: '12497', classCode: '3A', date: KAL, origin: 'ASR', destination: 'NDLS', reason: 'DATE_CHANGED' });
    expect(referenceContextView(s)).toMatchObject({ activeResultSet: null, focusTrainNumber: null, previousChoiceForOlderJourney: { trainNumber: '12497', factsExpired: true } });
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0, info: 0 });            // the backend never auto-calls anything
  });

  it('[10] a route change invalidates the same way (reason ROUTE_CHANGED); a set whose route no longer matches is not current', async () => {
    const h = await searched();
    await h.say('12497 wali');
    const s0 = h.s();
    s0.origin = 'LDH';
    expect(resultSetOf(s0)).toMatchObject({ current: false, staleReason: 'ROUTE_CHANGED' });
    expect(verifyReferenceClaims('Doosri wali 12497 hai.', s0).reason).toBe('STALE_INDEX_REFERENCE:12497');
    h.state.invalidate(h.sid, 'ROUTE');
    expect(h.s().staleReference).toMatchObject({ trainNumber: '12497', reason: 'ROUTE_CHANGED' });
    expect(h.s().searchResults).toBeUndefined();
  });

  it('[11] after a date change the LLM may re-select the train only from the FRESH results (record: VALID, source date = new date)', async () => {
    const h = native({ ...START, '12497 wali': [{ calls: [SEL('12497')] }, { content: 'Theek hai, 12497.' }],
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { content: 'Parso ke liye trainein mil gayi.' }],
      'Wahi 12497 rakh do': [{ calls: [SEL('12497')] }, { content: '12497 rakh li.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 wali'); await h.say('Kal nahi parso');
    expect(h.s().date).toBe(PARSO);
    const r = await h.say('Wahi 12497 rakh do');
    expect(h.s().selectedTrain?.number).toBe('12497');
    const rec = refs(r).records.find((x: any) => x.via === 'SELECTION');
    expect(rec).toMatchObject({ status: 'VALID', resolvedTrainNumber: '12497', source: { date: PARSO } });
    expect(h.s().staleReference).toBeUndefined();
  });

  it('[12] a train missing from the new results is never silently replaced; a false "list mein hai" claim is removed', async () => {
    rail.omit = { date: PARSO, train: '12497' };
    const h = native({ ...START, '12497 wali': [{ calls: [SEL('12497')] }, { content: 'Theek hai, 12497.' }],
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { content: '12497 parso ki list mein bhi hai, wahi rakh li. Parso ke liye trainein mil gayi.' }],
      'Wahi 12497 rakh do': [{ calls: [SEL('12497')] }, { content: 'Kaunsi train chahiye?' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 wali');
    const r = await h.say('Kal nahi parso');
    expect(currentResults(h.s()).some(t => t.trainNumber === '12497')).toBe(false);
    expect(h.s().selectedTrain).toBeUndefined();
    expect(String(r.voice.assistantText)).not.toMatch(/12497 parso ki list mein bhi hai/);
    // removed by the FIRST guard that catches it (railway-fact step 1: 12497 is not in the current results → UNGROUNDED_NUMBER);
    // the step-7 reference guard rejects the same claim on its own
    expect(r.turnLog.diagnostics.validation.rejected.join(',')).toMatch(/UNGROUNDED_NUMBER:12497|NOT_IN_CURRENT_RESULTS:12497/);
    expect(guardReferenceClaims('12497 parso ki list mein bhi hai, wahi rakh li. Parso ke liye trainein mil gayi.', h.s()).removed[0]?.reason).toBe('NOT_IN_CURRENT_RESULTS:12497');
    const r2 = await h.say('Wahi 12497 rakh do');
    expect(h.s().selectedTrain).toBeUndefined();                                     // not replaced by another train
    expect(refs(r2).records.find((x: any) => x.via === 'SELECTION')).toMatchObject({ status: 'INVALID', resolvedTrainNumber: null });
  });

  it('[13] an old-date availability can never support a new-date availability claim', async () => {
    const h = await searched();
    await h.say('12497 wali'); await h.say('3A');
    const s = h.s();
    Object.assign(s, { date: PARSO, availability: { trainNumber: '12497', classCode: '3A', travelClass: '3A', date: KAL, status: 'AVAILABLE', available: true } });
    const out = await compose(s, 'Parso 12497 mein 3A available hai.');
    expect(out.rejected.length).toBeGreaterThan(0);
    expect(out.rejected.map((r: any) => r.reason).join(',')).toMatch(/AVAILAB|CROSS_DATE/);
  });

  it('[14] an old-date fare can never support a new-date fare claim', async () => {
    const h = await searched();
    await h.say('12497 wali'); await h.say('3A');
    const s = h.s();
    Object.assign(s, { date: PARSO, fare: { trainNumber: '12497', classCode: '3A', travelClass: '3A', date: KAL, perPassenger: 650, total: 650 } });
    const out = await compose(s, 'Parso 12497 3A ka fare ₹650 hai.');
    expect(out.rejected.length).toBeGreaterThan(0);
    expect(out.rejected.map((r: any) => r.reason).join(',')).toMatch(/FARE|CROSS_DATE|UNGROUNDED/);
  });
});

describe('P30 G2 — regressions, privacy, focus integrity, dedup', () => {
  it('[15] "RAC kya hota hai?" stays general knowledge: no tool, no reference record, no focus change', async () => {
    const h = await searched();
    const n0 = { ...rail.n };
    const r = await h.say('RAC kya hota hai?');
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0, info: 0 });
    expect(r.turnLog.diagnostics.toolCalls).toBe(0);
    expect(refs(r).records).toEqual([]);
    expect(String(r.voice.assistantText).length).toBeGreaterThan(5);
    expect(h.s().focusTrainNumber).toBeUndefined();
  });

  it('[16] the search count is the current set\'s count (reply, context and provenance agree)', async () => {
    const h = wire(new MockLLMProvider({}));
    const r = await h.say('Kal Amritsar se Delhi');
    const n = currentResults(h.s()).length;
    expect(n).toBe(3);
    expect(String(r.voice.assistantText)).toMatch(new RegExp(`\\b${n} trainein`));
    expect(referenceContextView(h.s()).activeResultSet!.count).toBe(n);
    expect(h.s().searchMeta.totalCount).toBe(n);
  });

  it('[17] no internal id ever reaches the user or the LLM reference view (result ids, turn ids, tool result ids)', async () => {
    const h = await searched();
    const r = await h.say('doosri wali');
    const view = JSON.stringify(referenceContextView(h.s()));
    for (const t of [view, r.voice.assistantText, r.voice.speechText, r.responseMessage].map(x => String(x ?? ''))) {
      expect(t).not.toMatch(UUID);
      expect(t).not.toMatch(/\bturn_|\btx_|resultId|toolResultId|sourceTurnId/);
    }
    // …while the internal record keeps them for logs
    expect(refs(r).records[0].source.turnId).toMatch(/turn/);
  });

  it('[18] a stale / interrupted turn never moves the focus (late info result rejected; discarded turn\'s focus rolled back)', async () => {
    const h = native({ ...START, '12014 ka route batao': [{ calls: [INFO('12014')] }, { content: '12014 Amritsar se New Delhi jaati hai.' }],
      '12497 wali': [{ calls: [SEL('12497')] }, { content: 'Theek hai, 12497.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    let release!: () => void; rail.infoGate = new Promise<void>(r => { release = r; });
    const p1 = h.say('12014 ka route batao', 'VOICE');
    await flush();
    const p2 = h.say('12497 wali', 'VOICE', { interruptPrevious: true });
    await flush();
    rail.infoGate = null; release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2.presentable).toBe(true);
    expect(r1.presentable).toBe(false);
    expect(h.s().focusTrainNumber).toBe('12497');
    // discarded-turn rollback (the engine path for a turn that completed but is no longer relevant)
    const s = h.s();
    Object.assign(s, { focusTrainNumber: '18238', focusTurnId: 'turn_discarded' });
    s.selectedTrain = undefined;
    (h.eng as any).rollbackDiscardedFocus(h.sid, 'turn_discarded', '12014');
    expect(s.focusTrainNumber).toBe('12014');
    Object.assign(s, { focusTrainNumber: '18238', focusTurnId: 'turn_discarded' });
    (h.eng as any).rollbackDiscardedFocus(h.sid, 'turn_discarded', '99999');     // not in the current results → no focus (never a guess)
    expect(s.focusTrainNumber).toBeUndefined();
    Object.assign(s, { focusTrainNumber: '18238', focusTurnId: 'turn_newer' });
    (h.eng as any).rollbackDiscardedFocus(h.sid, 'turn_discarded', '12014');     // a newer turn owns the focus → untouched
    expect(s.focusTrainNumber).toBe('18238');
  });

  it('[19] a failed tool never updates the focus (record: INVALID)', async () => {
    const h = native({ ...START, '18238 ke baare mein batao': [{ calls: [INFO('18238')] }, { content: 'Abhi train ki jaankari nahi mil paayi.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    rail.failInfo = 5;
    const r = await h.say('18238 ke baare mein batao');
    expect(h.s().focusTrainNumber).toBeUndefined();
    expect(h.s().lastTrainInfo).toBeUndefined();
    expect(refs(r).records.find((x: any) => x.tool === 'GET_TRAIN_INFO')).toMatchObject({ via: 'TOOL_ARGUMENT', status: 'INVALID', resolvedTrainNumber: '18238' });
  });

  it('[20] a successful tool updates the context (focus stamped with its turn; "iska" then means that train)', async () => {
    const h = native({ ...START, '18238 ke baare mein batao': [{ calls: [INFO('18238')] }, { content: '18238 Amritsar se New Delhi jaati hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('18238 ke baare mein batao');
    expect(h.s().focusTrainNumber).toBe('18238');
    expect(h.s().focusTurnId).toBe(r.turnLog.turnId);
    expect(refs(r).records.find((x: any) => x.tool === 'GET_TRAIN_INFO')).toMatchObject({ status: 'VALID', displayIndex: 3, source: { date: KAL } });
    const res: any = trains.resolve({ kind: 'DEMONSTRATIVE', value: 'THIS' } as any, h.s());
    expect(res.ok && res.train.trainNumber).toBe('18238');
  });

  it('[21] same-turn duplicate protection stays: an identical availability call twice in ONE turn hits the provider once', async () => {
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'availability batao': [{ calls: [CAV('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: 'Ho gaya.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const n0 = { ...rail.n };
    await h.say('availability batao');
    expect(delta(n0).avail).toBe(1);
  });

  it('[22] a NEW turn may fetch fresh data for the same train (no cross-turn railway cache)', async () => {
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'availability batao': [{ calls: [CAV('12497', '3A')] }, { content: 'Ho gaya.' }],
      'phir se availability batao': [{ calls: [CAV('12497', '3A')] }, { content: 'Ho gaya.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const n0 = { ...rail.n };
    await h.say('availability batao');
    await h.say('phir se availability batao');
    expect(delta(n0).avail).toBe(2);
  });
});
