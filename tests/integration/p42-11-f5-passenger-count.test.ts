/**
 * Post-P42.10 — Group 5 (F5): passenger count is preserved across date / train / class / route changes.
 * Root cause (production 2026-10-07): on "Kal nahi, parso." Muse filled the optional SEARCH_TRAINS argument
 * passengersCount: 1 and the search commit copied it into BookingSession (UNSET → 1). A search argument now sets the
 * session count only when the user's own words this turn name it (same grounding rule as update_booking_session).
 *   [1] 3 + date correction → 3        [2] 2 + train change → 2        [3] 4 + class change → 4
 *   [4] UNSET + date correction → UNSET (the production case)          [5] explicit "3 passengers" → 3
 *   [6] explicit "actually 2 passengers" → 2
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
import { groundedSearchPassengers } from '../../server/ai/runtime/llm-tool-runtime';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4211-f5', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1), D2 = ist(2), D3 = ist(3);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = (date: string, extra: any = {}) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date, ...extra } });
const SELECT = (n: string, cls: string) => U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: n }, classRaw: cls, selectionPurpose: 'BOOKING' });
// the production shape: date correction + a fresh search on which Muse fills passengersCount: 1 by itself
const DATE_FIX = { 'Kal nahi, parso.': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: D2, correctionTarget: 'date', correctionValueRaw: 'parso' }), SEARCH(D2, { passengersCount: 1 })] }, { content: 'Parso ki trains mil gayi.' }] };
const START = { 'Kal Amritsar se Delhi ki trains dikhao': [{ calls: [SEARCH(D1)] }, { content: 'Kal ki trains mil gayi.' }] };
const PAX = (n: string) => [{ calls: [U('UPDATE_PASSENGERS', 'SET_PASSENGER_COUNT', { passengersCountRaw: n })] }, { content: `${n} passengers note kar liye.` }];
function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4211-F5', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const execs = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]).map(x => [x.tool, x.status]);
let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p4211-f5'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('Post-P42.10 G5 (F5) — passenger count invariant', () => {
  it('[1] passengersCount 3 + "Kal nahi, parso." (Muse fills search passengersCount 1) → stays 3', async () => {
    const h = stack({ ...START, '3 log hain': PAX('3'), ...DATE_FIX });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('3 log hain');
    expect(h.s().passengersCount).toBe(3);
    const r = await h.say('Kal nahi, parso.');
    expect(execs(r)).toContainEqual(['SEARCH_TRAINS', 'SUCCEEDED']);
    expect(h.s().date).toBe(D2);
    expect(h.s().passengersCount).toBe(3);
  }, 30000);

  it('[2] passengersCount 2 + train change → stays 2', async () => {
    const h = stack({ ...START, 'Do log': PAX('2'), '12014 CC': [{ calls: [SELECT('12014', 'CC')] }, { content: '12014 CC.' }],
      'Nahi, 12497 3A kar do': [{ calls: [SELECT('12497', '3A')] }, { content: '12497 3A.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('Do log');
    await h.say('12014 CC');
    await h.say('Nahi, 12497 3A kar do');
    expect(String(h.s().selectedTrain?.number ?? h.s().selectedTrain?.trainNumber)).toBe('12497');
    expect(h.s().passengersCount).toBe(2);
  }, 30000);

  it('[3] passengersCount 4 + class change → stays 4', async () => {
    const h = stack({ ...START, '4 passengers': PAX('4'), '12497 3A': [{ calls: [SELECT('12497', '3A')] }, { content: '12497 3A.' }],
      'Class SL kar do': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'SL' })] }, { content: 'SL kar diya.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('4 passengers');
    await h.say('12497 3A');
    await h.say('Class SL kar do');
    expect(h.s().selectedClass).toBe('SL');
    expect(h.s().passengersCount).toBe(4);
  }, 30000);

  it('[4] passengersCount UNSET + "Kal nahi, parso." (the production case) → stays UNSET; route correction too', async () => {
    const h = stack({ ...START, ...DATE_FIX,
      'Delhi nahi, Ludhiana': [{ calls: [U('UPDATE_JOURNEY', 'UPDATE_JOURNEY', { destinationRaw: 'LDH', correctionTarget: 'destination', correctionValueRaw: 'Ludhiana' }),
        { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Ludhiana', date: D2, passengersCount: 1 } }] }, { content: 'Theek hai.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    expect(h.s().passengersCount ?? null).toBeNull();
    const r = await h.say('Kal nahi, parso.');
    expect(execs(r)).toContainEqual(['SEARCH_TRAINS', 'SUCCEEDED']);
    expect(h.s().date).toBe(D2);
    expect(h.s().passengersCount ?? null).toBeNull();                                                     // never manufactured from a default
    await h.say('Delhi nahi, Ludhiana');
    expect(h.s().passengersCount ?? null).toBeNull();
  }, 30000);

  it('[5] explicit "3 passengers" → 3 (update_booking_session, and a search argument the user\'s words name)', async () => {
    const h = stack({ ...START, '3 passengers': PAX('3'),
      'Parso Amritsar se Delhi, 3 passengers': [{ calls: [SEARCH(D3, { passengersCount: 3 })] }, { content: 'Mil gayi.' }] });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('3 passengers');
    expect(h.s().passengersCount).toBe(3);
    const h2 = stack({ 'Parso Amritsar se Delhi, 3 passengers': [{ calls: [SEARCH(D3, { passengersCount: 3 })] }, { content: 'Mil gayi.' }] });
    await h2.say('Parso Amritsar se Delhi, 3 passengers');
    expect(h2.s().passengersCount).toBe(3);                                                               // grounded search argument
    expect(groundedSearchPassengers(1, 'Kal nahi, parso.')).toBeUndefined();
    expect(groundedSearchPassengers(3, 'teen log hain')).toBe(3);
    expect(groundedSearchPassengers(2, 'दो लोग')).toBe(2);
  }, 30000);

  it('[6] explicit "actually 2 passengers" → 2', async () => {
    const h = stack({ ...START, '3 passengers': PAX('3'), 'Actually 2 passengers': PAX('2') });
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('3 passengers');
    await h.say('Actually 2 passengers');
    expect(h.s().passengersCount).toBe(2);
  }, 30000);
});
