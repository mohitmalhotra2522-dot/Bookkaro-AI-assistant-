/**
 * v0.39.6 — step-by-step passenger details through the REAL orchestrator with a native (OpenAI-compatible) agent
 * (injected fake server — no network, no credits) and the mock railway provider (labelled mock, non-live).
 *   - the context carries bookingPreparation.nextToAsk (name → age → berth → gender → meal; passenger 1 first);
 *   - a detail the agent really stored + its own next question → no second backend question ("… ki umar kitni hai?");
 *   - an agent that only CLAIMS a detail (no update_booking_session) stores nothing and the backend question still
 *     follows (honesty unchanged);
 *   - while nextToAsk is the berth choice, the backend's gender question is not appended as a second question.
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

railwayRegistry.register('p396-steps', () => new MockRailwayProvider());
const istTomorrow = () => new Date(Date.now() + 5.5 * 3600_000 + 86400_000).toISOString().slice(0, 10);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const PAX = (changes: any, passengerIndex = 1) => U('COLLECT_PASSENGER_DETAILS', 'UPDATE_PASSENGER', { passengerChanges: [{ passengerIndex, changes }] });

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P396-UNIT', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { views, say: (t: string) => eng.processTurn(sid, t, 'TEXT') as Promise<any>, s: () => state.getSession(sid) as any };
}

let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p396-steps'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('v0.39.6 — passenger details one at a time (native agent, real orchestrator)', () => {
  it('[1] nextToAsk in context; no doubled question after a stored detail; a claim without the tool call stores nothing; no gender question while berth is next', async () => {
    const d = istTomorrow();
    const h = stack({
      'search': [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: d } }] }, { content: 'Trains mil gayi.' }],
      '12497 CC 1 log': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'CC', passengersCountRaw: '1', selectionPurpose: 'BOOKING' })] }, { content: 'Passenger 1 ka naam kya hai?' }],
      'Rahul Sharma': [{ calls: [PAX({ name: 'Rahul Sharma' })] }, { content: 'Noted. Rahul ji ki age kya hai?' }],
      '31': [{ content: 'Age 31 noted. Ab gender bataiye?' }],                                     // claims, but never calls the tool
      'umar 31 hai': [{ calls: [PAX({ age: 31 })] }, { content: 'Theek hai. Window seat chahiye ya koi preference nahi?' }],
    });
    await h.say('search');
    const r1 = await h.say('12497 CC 1 log');
    expect(h.s().selectedClass).toBe('CC');
    expect(h.s().passengersCount).toBe(1);
    expect(String(r1.responseMessage)).toContain('Passenger 1 ka naam kya hai?');

    const r2 = await h.say('Rahul Sharma');
    const v2 = h.views.filter(v => v.user === 'Rahul Sharma');
    expect(v2[0].context.context.bookingPreparation.nextToAsk).toEqual({ passenger: 1, field: 'name' });
    expect(v2[v2.length - 1].context.context.bookingPreparation.nextToAsk).toEqual({ passenger: 1, field: 'age' });   // updated after the store
    expect(h.s().passengers[0].name).toBe('Rahul Sharma');
    expect(String(r2.responseMessage)).toContain('Rahul ji ki age kya hai?');
    expect(String(r2.responseMessage)).not.toMatch(/umar kitni hai/);

    const r3 = await h.say('31');
    expect(h.s().passengers[0].age).toBeUndefined();                                               // nothing stored
    expect(String(r3.responseMessage)).toMatch(/umar kitni hai\?/);                                // honest backend question kept

    const r4 = await h.say('umar 31 hai');
    expect(h.s().passengers[0].age).toBe(31);
    const v4 = h.views.filter(v => v.user === 'umar 31 hai');
    expect(v4[v4.length - 1].context.context.bookingPreparation.nextToAsk).toEqual({ passenger: 1, field: 'berthPreference' });
    expect(String(r4.responseMessage)).toContain('Window seat chahiye');
    expect(String(r4.responseMessage)).not.toMatch(/gender — male, female ya other/);
  }, 30000);
});
