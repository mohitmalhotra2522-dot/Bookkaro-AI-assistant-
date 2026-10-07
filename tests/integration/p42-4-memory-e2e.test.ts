/**
 * P42.4 — Part 2.1 LLM memory through the REAL orchestrator + native agent (fake OpenAI-compatible server, mock railway
 * provider — no network). "2 passengers" → "Mohit" → "31 male" → "Actually age 32": only the age changes; count, name
 * and gender are kept, sent back to the LLM every turn and never re-asked. The context carries the memory versions,
 * the recent turns arrive as chat messages (not duplicated in the context JSON), and the safe `llm_context` log holds
 * field names / versions only — never names, ages or credentials.
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
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { LLM_CONTEXT_VERSION } from '../../server/ai/context/context-builder';

railwayRegistry.register('p424-memory', () => new MockRailwayProvider());
const istTomorrow = () => new Date(Date.now() + 5.5 * 3600_000 + 86400_000).toISOString().slice(0, 10);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const PAX = (changes: any, passengerIndex = 1) => U('COLLECT_PASSENGER_DETAILS', 'UPDATE_PASSENGER', { passengerChanges: [{ passengerIndex, changes }] });
function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P424-MEMORY', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { views, say: (t: string) => eng.processTurn(sid, t, 'TEXT') as Promise<any>, s: () => state.getSession(sid) as any };
}
let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p424-memory'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); delete process.env.LLM_CONTEXT_LOG; });

describe('P42.4 Part 2.1 — memory of answered details', () => {
  it('[M1] 2 passengers → Mohit → 31 male → Actually age 32: only age changes; nothing re-asked; context + safe log', async () => {
    process.env.LLM_CONTEXT_LOG = '1';
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    const d = istTomorrow();
    const h = stack({
      'search': [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: d } }] }, { content: 'Trains mil gayi.' }],
      '12497 CC book karna hai': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: 'Kitne passengers hain?' }],
      '2 passengers': [{ calls: [U('UPDATE_PASSENGERS', 'SET_PASSENGER_COUNT', { passengersCountRaw: '2' })] }, { content: 'Passenger 1 ka naam bataiye.' }],
      'Mohit': [{ calls: [PAX({ name: 'Mohit' })] }, { content: 'Mohit ji ki age aur gender bataiye.' }],
      '31 male': [{ calls: [PAX({ age: 31, gender: 'male' })] }, { content: 'Noted. Window seat chahiye ya koi preference nahi?' }],
      'Actually age 32': [{ calls: [PAX({ age: 32 })] }, { content: 'Mohit ji ki age 32 kar di. Window seat chahiye ya koi preference nahi?' }]
    });
    await h.say('search');
    await h.say('12497 CC book karna hai');
    await h.say('2 passengers');
    expect(h.s().passengersCount).toBe(2);
    await h.say('Mohit');
    await h.say('31 male');
    expect(h.s().passengers[0]).toMatchObject({ name: 'Mohit', age: 31 });
    const gender = h.s().passengers[0].gender;
    expect(gender).toBeTruthy();
    const r = await h.say('Actually age 32');
    // only the corrected field changed
    expect(h.s().passengersCount).toBe(2);
    expect(h.s().passengers[0]).toMatchObject({ name: 'Mohit', age: 32, gender });
    expect(h.s().selectedClass).toBe('CC');
    // what the LLM received on the correction turn: every answered detail + the next open one is passenger 2's name
    const v = h.views.filter(x => x.user === 'Actually age 32');
    const ctx0 = v[0].context.context;
    expect(ctx0.bookingPreparation.passengers[0]).toMatchObject({ passenger: 1, name: 'Mohit', age: 31, missing: [] });
    // answered fields are never the next ask (the next open detail is P1's optional berth choice on this train/class)
    const nx = ctx0.bookingPreparation.nextToAsk;
    expect(nx.passenger === 1 && ['name', 'age', 'gender'].includes(nx.field)).toBe(false);
    expect(v[v.length - 1].context.context.bookingPreparation.passengers[0]).toMatchObject({ name: 'Mohit', age: 32, missing: [] });
    expect(ctx0.memory).toMatchObject({ contextVersion: LLM_CONTEXT_VERSION, journeyVersion: expect.any(Number) });
    expect(ctx0.passengersCount ?? ctx0.sessionView.passengersCount).toBe(2);
    // recent turns are real chat messages (Mohit / 31 male are visible) — not duplicated inside the context JSON
    expect(ctx0.recentMessages).toBeUndefined();
    const chat = (v[0].body.messages as any[]).filter(m => m.role === 'user').map(m => String(m.content));
    expect(chat).toEqual(expect.arrayContaining(['2 passengers', 'Mohit', '31 male', 'Actually age 32']));
    // the reply is Muse's (age really stored), no re-ask of count / name / gender
    expect(String(r.responseMessage)).toContain('age 32');
    expect(String(r.responseMessage)).not.toMatch(/kitne passengers|naam kya|gender/i);
    // safe log: field names / versions only
    logSpy.mockRestore();
    const recs = logs.filter(l => l.includes('"event":"llm_context"')).map(l => JSON.parse(l));
    expect(recs.length).toBeGreaterThanOrEqual(6);                                                   // one per turn
    const last = recs[recs.length - 1];
    expect(Object.keys(last).sort()).toEqual(['contextFieldsProvided', 'contextVersion', 'event', 'journeyVersion', 'memoryFieldsUsed', 'pendingInteraction', 'staleContextRejected', 'turnId'].sort());
    expect(last.memoryFieldsUsed).toEqual(expect.arrayContaining(['passengersCount', 'passengerFields', 'selectedTrain', 'selectedClass']));
    const all = logs.filter(l => l.includes('llm_context')).join('\n');
    expect(all).not.toMatch(/Mohit|"age"|\b32\b.*Mohit|sk-test/);
  }, 30000);

  it('[M2] a new date invalidates journey-bound data; the memory journeyVersion moves', async () => {
    const d = istTomorrow();
    const d2 = new Date(Date.now() + 5.5 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
    const h = stack({
      'search': [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: d } }] }, { content: 'Trains mil gayi.' }],
      '12497 CC': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: 'Theek hai.' }],
      'kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: d2 })] }, { content: 'Date badal di.' }],
      'next': [{ content: 'Theek hai.' }]
    });
    await h.say('search');
    await h.say('12497 CC');
    await h.say('kal nahi parso');
    await h.say('next');
    const jv = (u: string) => h.views.filter(x => x.user === u)[0].context.context.memory.journeyVersion;
    expect(h.s().date).toBe(d2);
    expect(jv('next')).toBeGreaterThan(jv('12497 CC'));
    expect(h.s().selectedTrain).toBeUndefined();                                                      // journey-bound selection invalidated
    expect(h.s().availability).toBeUndefined();
  }, 30000);
});
