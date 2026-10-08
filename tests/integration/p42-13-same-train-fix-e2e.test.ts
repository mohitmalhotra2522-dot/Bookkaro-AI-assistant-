/**
 * P42-13 Part 1 end-to-end through the Muse integration (fake OpenAI-compatible server, deterministic MOCK connectors —
 * no network, no credits). Reproduces the production chain: a search WITHOUT a class, then the same-train request with
 * NO class (chip / fallback text) → before the fix: SAME_TRAIN_ALTERNATIVE_NOT_READY. Now the class is resolved from the
 * authoritative row for the tool only — identical for TEXT and VOICE — and the booking class is never touched.
 * F2: a rate-limited route surfaces the provider-busy reason, never "route verify nahi".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => {
  process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1';
  process.env.SAME_TRAIN_CALL_TIMEOUT_MS = '500';
  process.env.SAME_TRAIN_TOTAL_TIMEOUT_MS = '4000';
});
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { registerMockProviderConnectors, MOCK_CONNECTOR_CAPS, type MockProviderConnector } from '../../server/railway/providers/mock/mock-provider-connectors';
import { todayInIndia } from '../../server/ai/providers/openai-compatible-llm';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P4213-FIX-SECRET-1313';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const ROUTE = [['JUC', 'Jalandhar City'], ['ASR', 'Amritsar Jn'], ['LDH', 'Ludhiana Jn'], ['UMB', 'Ambala Cant Jn'], ['NDLS', 'New Delhi']].map(([station, stationName]) => ({ station, stationName }));
const ROW: Array<[string, string]> = [['2A', 'AVAILABLE-0009'], ['SL', 'WL 1'], ['3A', 'WL 6']];
const train = (num: string, classes: Array<[string, string]>) => ({ trainNumber: num, trainName: 'Pooja SF Express', origin: 'ASR', destination: 'NDLS', departure: '06:00', arrival: '12:00', duration: '6h 0m',
  classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null })) });
const SEARCH = { name: 'railcore_search', args: { origin: 'ASR', destination: 'NDLS', date: TOMORROW, passengersCount: 2 } };   // NO class named
const ALT_NO_CLASS = { name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12414', date: TOMORROW, origin: 'ASR', destination: 'NDLS', combinedPairs: 'NEVER', providers: 'railcore' } };
const Q = 'Amritsar se New Delhi kal, 2 log';
const ASK = '12414 ka same train alternative dikhao';

let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
let routeFault: string | null = null;
function harness(state = new ConversationStateManager()) {
  const results: Record<string, any> = {};
  const fake = new FakeOpenAI((v: TurnView) => {
    if (v.user === Q) return v.step === 0 ? { calls: [SEARCH] } : { content: '12414 mein SL WL 1 hai.' };
    if (v.user === ASK) {
      const r = v.results.find(x => x.name === 'SEARCH_SAME_TRAIN_ALTERNATIVES'); if (r) results.alt = r.content;
      return v.step === 0 ? { calls: [ALT_NO_CLASS] } as FakeReply : { content: '' };   // empty wording → backend fallback text
    }
    return { content: 'Theek hai.' };
  });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const id = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(id, t, mode) as Promise<any>;
  return { say, s: () => state.getSession(id) as any, results };
}
const stRecs = (r: any) => ((r.turnLog?.toolExecutions || []) as any[]).filter(x => x.tool === 'SEARCH_SAME_TRAIN_ALTERNATIVES');
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage].map(x => String(x ?? '')).join(' | ');

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors());
  providerToolCatalog.register({ id: 'railcore', label: rc.connectorLabel, registryId: rc.mockProviderId, capabilities: [...MOCK_CONNECTOR_CAPS.railcore, 'GET_TIMETABLE' as any] });
});
afterAll(() => dispose());
beforeEach(() => {
  rc.reset(); rr.reset(); routeFault = null;
  for (const c of [rc, rr]) {
    (c as any).getTimetable = async (req: any) => { c.calls.push(['timetable' as any, req]); return routeFault ? { ok: false, error: { code: routeFault, message: 'mock fault' } } : { ok: true, data: ROUTE, meta: { source: 'mock' } }; };
    (c as any).searchTrains = async (req: any) => { c.calls.push(['search', req]); return { ok: true, data: { journey: { origin: req.origin, destination: req.destination, date: req.date }, trains: [train('12414', ROW)], totalCount: 1 }, meta: { source: 'mock', providerId: c.mockProviderId } }; };
    (c as any).checkAvailability = async (req: any) => { c.calls.push(['availability', req]); return { ok: true, data: { trainNumber: req.trainNumber, travelClass: req.travelClass, date: req.date, status: req.origin === 'JUC' ? 'AVAILABLE-0004' : 'GNWL 5' }, meta: { source: 'mock' } }; };
  }
  railwayRegistry.setActive('mock');
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('P42-13 Part 1 — E2E (mock connectors, fake Muse)', () => {
  it('[14] TEXT and VOICE: no class anywhere → the tool runs with the first shortage class (SL), never NOT_READY; booking class untouched; identical', async () => {
    const out: any[] = [];
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const h = harness();
      await h.say(Q, mode);
      expect(h.s().requestedClass).toBeFalsy(); expect(h.s().selectedClass).toBeFalsy();
      const r = await h.say(ASK, mode);
      const recs = stRecs(r);
      expect(recs.length).toBeGreaterThan(0);
      expect(JSON.stringify(h.results.alt || {})).not.toMatch(/SAME_TRAIN_ALTERNATIVE_NOT_READY/);
      expect(recs[recs.length - 1].status).toBe('SUCCEEDED');
      const args = recs[recs.length - 1].argumentsSummary || {};
      expect(args).toMatchObject({ travelClass: 'SL' });
      expect(h.s().requestedClass).toBeFalsy(); expect(h.s().selectedClass).toBeFalsy(); expect(h.s().selectedTrain).toBeFalsy();
      out.push({ travelClass: args.travelClass, classes: args.classes, status: recs[recs.length - 1].status });
    }
    expect(out[0]).toEqual(out[1]);
  }, 30000);

  it('[15] route RATE_LIMITED on every provider → the user hears the provider-busy reason, never "route verify nahi"', async () => {
    const h = harness();
    await h.say(Q);
    routeFault = 'RATE_LIMITED';
    const r = await h.say(ASK);
    expect(JSON.stringify(h.results.alt || {})).toMatch(/RATE_LIMITED/);
    expect(JSON.stringify(h.results.alt || {})).not.toMatch(/INVALID_TRAIN_ROUTE/);
    expect(shown(r)).not.toMatch(/route verify nahi/i);
  }, 30000);
});
