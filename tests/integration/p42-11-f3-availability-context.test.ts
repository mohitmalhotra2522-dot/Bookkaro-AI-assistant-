/**
 * Post-P42.10 — Group 3 (F3): valid PRE-SELECTION availability.
 * Real orchestrator + turn engine + validator + runtime, fake OpenAI-compatible server plays Muse, mock railway provider.
 * Mock ASR→NDLS list: 1 → 12014 Amritsar Shatabdi 04:55 (CC, 2S) · 2 → 12497 Shan-e-Punjab 06:35 (3A, CC, SL, 2S) ·
 *                     3 → 18238 Chhattisgarh Express 19:35 (3A, SL).
 *   [1] search availability is visible to Muse before any selection     [2] "kaunsi train available hai?" without selecting
 *   [3] specific train + class, no UI selection → executes                [4] display index ("doosri wali") without selection
 *   [5] unique natural reference (evening / name)                          [6] ambiguous reference → candidates, no guess
 *   [7] unknown train rejected                                              [8] missing context rejected
 *   [9] explicit fresh request → new provider call                         [10] no stale availability reuse
 *   [11] cross-train grounding: an info check never becomes the booking selection / another train's fact
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
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4211-f3', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D1 } };
const AV = (args: any) => ({ name: 'CHECK_AVAILABILITY', args });
const SEARCH_TURN = { 'Kal Amritsar se Delhi ki trains dikhao': [{ calls: [SEARCH] }, { content: 'Kal ke liye 3 trains mili hain.' }] };

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4211-F3', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const text = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? '');
const execsOf = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]);
const av = (r: any) => execsOf(r).filter(x => x.tool === 'CHECK_AVAILABILITY').map(x => [x.status, x.rejectionReason ?? null]);
let fetchSpy: any; let availSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p4211-f3');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('Post-P42.10 G3 (F3) — availability before explicit train selection', () => {
  it('[1] SEARCH_TRAINS availability reaches Muse with no selection — not an invalid state', async () => {
    const h = stack(SEARCH_TURN);
    const r = await h.say('Kal Amritsar se Delhi ki trains dikhao');
    expect(execsOf(r).map(x => [x.tool, x.status])).toEqual([['SEARCH_TRAINS', 'SUCCEEDED']]);
    expect(h.s().selectedTrain ?? null).toBeNull();
    const searchResult = JSON.stringify(h.views[1].results);                                             // what Muse read after the search
    expect(searchResult).toMatch(/12014/); expect(searchResult).toMatch(/Available/); expect(searchResult).toMatch(/Waitlist 12/);
  }, 30000);

  it('[2] "kaunsi train mein CC available hai?" before selection → Muse checks listed trains directly, no SELECT_TRAIN, grounded answer', async () => {
    const h = stack({ ...SEARCH_TURN,
      '12014 aur 12497 mein se kisme CC available hai?': [{ calls: [AV({ trainNumber: '12014', travelClass: 'CC' }), AV({ trainNumber: '12497', travelClass: 'CC' })] },
        { content: '12014 mein CC available hai. 12497 mein CC RAC 4 hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const n0 = availSpy.mock.calls.length;
    const r = await h.say('12014 aur 12497 mein se kisme CC available hai?');
    expect(av(r)).toEqual([['SUCCEEDED', null], ['SUCCEEDED', null]]);
    expect(execsOf(r).some(x => x.tool === 'update_booking_session')).toBe(false);
    expect(availSpy.mock.calls.length - n0).toBe(2);
    expect(text(r)).toMatch(/12014 mein CC available hai/);
    expect(text(r)).toMatch(/12497 mein CC RAC 4/);
    expect(h.s().selectedTrain ?? null).toBeNull();
  }, 30000);

  it('[3] "12497 SL mein availability check karo" — resolvable train + listed class + journey date, no UI selection → executes', async () => {
    const h = stack({ ...SEARCH_TURN,
      '12497 SL mein availability check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const r = await h.say('12497 SL mein availability check karo');
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12497', travelClass: 'SL', date: D1 });
    expect(text(r)).toMatch(/12497 mein SL Waitlist 12/);
  }, 30000);

  it('[4] "doosri wali ki CC availability" → trainRef DISPLAY_INDEX 2 resolves to 12497 without a selection', async () => {
    const h = stack({ ...SEARCH_TURN,
      'Doosri wali ki CC availability check karo': [{ calls: [AV({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, travelClass: 'CC' })] }, { content: '12497 mein CC RAC 4 hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const r = await h.say('Doosri wali ki CC availability check karo');
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12497', travelClass: 'CC' });
    expect(h.s().selectedTrain ?? null).toBeNull();
  }, 30000);

  it('[5] unique natural references: "evening wali" (TIME_PREFERENCE) and "Shatabdi wali" (TRAIN_NAME) resolve to the one match', async () => {
    const h = stack({ ...SEARCH_TURN,
      'Evening wali ki SL availability': [{ calls: [AV({ trainRef: { kind: 'TIME_PREFERENCE', value: 'EVENING' }, travelClass: 'SL' })] }, { content: '18238 mein SL Waitlist 8 hai.' }],
      'Shatabdi wali ki CC availability': [{ calls: [AV({ trainRef: { kind: 'TRAIN_NAME', value: 'Shatabdi' }, travelClass: 'CC' })] }, { content: '12014 mein CC available hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const r1 = await h.say('Evening wali ki SL availability');
    expect(av(r1)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '18238', travelClass: 'SL' });
    const r2 = await h.say('Shatabdi wali ki CC availability');
    expect(av(r2)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12014', travelClass: 'CC' });
  }, 30000);

  it('[6] ambiguous references ("morning wali", "us train ki", "Express wali") → AMBIGUOUS_REFERENCE + candidates, provider NOT called, Muse asks', async () => {
    const ask = (v: TurnView) => {
      const c = v.results[0]?.content?.error || {};
      return { content: c.code === 'AMBIGUOUS_REFERENCE' && Array.isArray(c.candidates) && c.candidates.length >= 2 ? `Kaunsi train — ${c.candidates.join(' ya ')}?` : 'WRONG' };
    };
    const h = stack({ ...SEARCH_TURN,
      'Morning wali ki CC availability': [{ calls: [AV({ trainRef: { kind: 'TIME_PREFERENCE', value: 'MORNING' }, travelClass: 'CC' })] }, ask],
      'Express wali ki 3A availability': [{ calls: [AV({ trainRef: { kind: 'TRAIN_NAME', value: 'Express' }, travelClass: '3A' })] }, ask],
      'Us train ki availability check karo': [{ calls: [AV({ trainRef: { kind: 'DEMONSTRATIVE', value: 'THIS' } })] }, ask] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const n0 = availSpy.mock.calls.length;
    const r1 = await h.say('Morning wali ki CC availability');
    expect(av(r1)).toEqual([['REJECTED', 'AMBIGUOUS_REFERENCE']]);
    expect(text(r1)).toBe('Kaunsi train — 12014 ya 12497?');
    const r2 = await h.say('Express wali ki 3A availability');
    expect(av(r2)).toEqual([['REJECTED', 'AMBIGUOUS_REFERENCE']]);
    const r3 = await h.say('Us train ki availability check karo');
    expect(av(r3)).toEqual([['REJECTED', 'AMBIGUOUS_REFERENCE']]);
    expect(text(r3)).toMatch(/^Kaunsi train — 12014 ya 12497 ya 18238\?$/);
    expect(availSpy.mock.calls.length).toBe(n0);                                                        // never a guess
  }, 30000);

  it('[7] unknown train 99999 (not in the current results, no new search requested) → rejected, provider NOT called', async () => {
    const h = stack({ ...SEARCH_TURN,
      '99999 ki SL availability': [{ calls: [AV({ trainNumber: '99999', travelClass: 'SL' })] }, (v: TurnView) => ({ content: v.results[0]?.content?.error?.code === 'INVALID_TRAIN_REFERENCE' ? '99999 is list mein nahi hai.' : 'WRONG' })] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const n0 = availSpy.mock.calls.length;
    const r = await h.say('99999 ki SL availability');
    expect(av(r)).toEqual([['REJECTED', 'INVALID_TRAIN_REFERENCE']]);
    expect(availSpy.mock.calls.length).toBe(n0);
    expect(text(r)).toBe('99999 is list mein nahi hai.');
  }, 30000);

  it('[8] missing context: no search results / no train named / class not listed / class missing → rejected (no provider call)', async () => {
    const h = stack({
      '12497 SL availability': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: 'Pehle route aur date batayein.' }],
      ...SEARCH_TURN,
      'Availability check karo': [{ calls: [AV({})] }, { content: 'Kis train ki?' }],
      '12014 SL availability': [{ calls: [AV({ trainNumber: '12014', travelClass: 'SL' })] }, { content: '12014 mein SL nahi hai.' }],
      '12014 ki availability': [{ calls: [AV({ trainNumber: '12014' })] }, (v: TurnView) => ({ content: v.results[0]?.content?.error?.missingField === 'CLASS' ? `Kaunsi class — ${v.results[0].content.error.availableClasses.join(' ya ')}?` : 'WRONG' })] });
    const r0 = await h.say('12497 SL availability');
    expect(av(r0)).toEqual([['REJECTED', 'INVALID_ACTION_FOR_STATE']]);
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const n0 = availSpy.mock.calls.length;
    const r1 = await h.say('Availability check karo');
    expect(av(r1)).toEqual([['REJECTED', 'INVALID_ACTION_FOR_STATE']]);
    const r2 = await h.say('12014 SL availability');
    expect(av(r2)).toEqual([['REJECTED', 'INVALID_CLASS_SELECTION']]);
    const r3 = await h.say('12014 ki availability');
    expect(av(r3)).toEqual([['REJECTED', 'MISSING_REQUIRED_FIELD']]);
    expect(text(r3)).toBe('Kaunsi class — CC ya 2S?');
    expect(availSpy.mock.calls.length).toBe(n0);
  }, 30000);

  it('[9] explicit "abhi dobara check karo" → a NEW provider call every time (no cache)', async () => {
    const CALL = [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }];
    const h = stack({ ...SEARCH_TURN, '12497 SL availability': CALL, 'Abhi dobara check karo': CALL });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    const n0 = availSpy.mock.calls.length;
    await h.say('12497 SL availability');
    const r = await h.say('Abhi dobara check karo');
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.length - n0).toBe(2);
  }, 30000);

  it('[10] no stale reuse: after a date change the old list cannot serve an availability check (rejected until a fresh search)', async () => {
    const h = stack({ ...SEARCH_TURN,
      '12497 SL availability': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
      'Kal nahi parso, 12497 SL dobara check karo': [
        { calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' })] },
        { calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] },                                    // old list is gone
        { calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: ist(2) } }] },
        { calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] },                                    // fresh list → executes
        { content: 'Parso 12497 mein SL Waitlist 12 hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('12497 SL availability');
    const n0 = availSpy.mock.calls.length;
    const r = await h.say('Kal nahi parso, 12497 SL dobara check karo');
    expect(av(r)).toEqual([['REJECTED', 'INVALID_ACTION_FOR_STATE'], ['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.length - n0).toBe(1);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12497', travelClass: 'SL', date: ist(2) });
  }, 30000);

  it('[11] cross-train grounding: an info check of 12497 never becomes 12014\'s booking availability; another train\'s claim is rejected', async () => {
    const h = stack({ ...SEARCH_TURN,
      '12014 CC select karo': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: '12014 CC select ho gayi.' }],
      '12497 CC ka status?': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: '12497 mein CC RAC 4 hai. 12014 mein CC RAC 4 hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('12014 CC select karo');
    const r = await h.say('12497 CC ka status?');
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(String(h.s().selectedTrain?.number ?? h.s().selectedTrain?.trainNumber)).toBe('12014');     // selection unchanged
    expect(h.s().availability?.CC).toBeUndefined();                                                      // 12497's result is not 12014's
    expect(text(r)).toMatch(/12497 mein CC RAC 4/);
    expect(text(r)).not.toMatch(/12014 mein CC RAC 4/);                                                   // cross-train claim removed
  }, 30000);

  it('[unit] validator: selection contract unchanged; info path resolves only against the current result set', () => {
    const v = new ToolCallValidator();
    const trains = [{ trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', departure: '04:55', classes: [{ code: 'CC' }, { code: '2S' }], displayIndex: 1 },
      { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', departure: '06:35', classes: [{ code: '3A' }, { code: 'SL' }], displayIndex: 2 }];
    const s: any = { origin: 'ASR', destination: 'NDLS', date: D1, searchResultsVersion: 1, searchResults: { trains, date: D1, origin: 'ASR', destination: 'NDLS' } };
    expect(v.validate({ callId: 'a', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12497', travelClass: 'SL' } } as any, s, undefined, { userText: '12497 SL availability' })).toMatchObject({ ok: true, v: { arguments: { trainNumber: '12497', travelClass: 'SL', date: D1 } } });
    expect(v.validate({ callId: 'b', name: 'CHECK_AVAILABILITY', arguments: { trainRef: { kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: 0 }, travelClass: 'SL' } } as any, s)).toMatchObject({ ok: false, error: { code: 'INVALID_TRAIN_REFERENCE' } });   // stale version
    expect(v.validate({ callId: 'c', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12497', travelClass: 'SL', date: ist(3) } } as any, s, undefined, { userText: '12497 SL availability' })).toMatchObject({ ok: false, error: { code: 'CONTEXT_CONFLICT' } });          // other date than the list
    const stale = { ...s, date: ist(2) };                                                                                                                                   // list belongs to another journey date
    expect(v.validate({ callId: 'd', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12497', travelClass: 'SL' } } as any, stale)).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION_FOR_STATE' } });
    // GET_FARE keeps the selection contract (fare feeds the booking review)
    expect(v.validate({ callId: 'e', name: 'GET_FARE', arguments: { trainNumber: '12497', travelClass: 'SL' } } as any, s)).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION_FOR_STATE' } });
  });
});
