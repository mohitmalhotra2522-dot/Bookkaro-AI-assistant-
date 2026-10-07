/**
 * PROMPT 42.9 — G2 (integration): backend RailCore → RailRadar fallback through the REAL turn pipeline
 * (fake OpenAI-compatible server plays Muse; deterministic MOCK connectors; no network, no credits).
 *   - Muse calls railcore_* ; RailCore RATE_LIMITED / UNAVAILABLE → the BACKEND runs the same request on RailRadar once,
 *     visibly (provider / fallbackUsed / fallbackReason / providerAttempts) — Muse never had to choose RailRadar;
 *   - RailCore success → RailRadar never called; AUTH_ERROR (not eligible) → no fallback, honest failure to Muse;
 *   - the same-train provider resolution defaults to the PRIMARY with a per-request fallback (no RailRadar double-query).
 * Fallback is enabled explicitly (RAILWAY_PROVIDER_FALLBACK=on) — the policy default is on only for live providers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { registerMockProviderConnectors, type MockProviderConnector } from '../../server/railway/providers/mock/mock-provider-connectors';
import { resolveSameTrainProviders } from '../../server/railway/same-train/same-train-service';
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { todayInIndia } from '../../server/ai/providers/openai-compatible-llm';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P429-FALLBACK-SECRET-42942';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const S = (p: string) => ({ name: `${p}_search`, args: { origin: 'ASR', destination: 'NDLS', date: TOMORROW } });
type Script = (v: TurnView) => FakeReply;
let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
const saved: Record<string, string | undefined> = {};

function harness(script: Record<string, Script | FakeReply[]>) {
  const fake = new FakeOpenAI((v: TurnView) => {
    const p = script[v.user];
    if (!p) return { content: 'Theek hai.' };
    if (typeof p === 'function') return p(v);
    return v.step < p.length ? p[v.step] : { content: 'Theek hai.' };
  });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 400, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>;
  return { fake, say, sid, s: () => state.getSession(sid) as any };
}
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];
const resultsOf = (v: TurnView) => v.results.map(x => ({ name: x.name, ...(typeof x.content === 'object' ? x.content : { raw: x.content }) }));

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  for (const k of ['RAILWAY_PROVIDER_FALLBACK', 'RAILWAY_PRIMARY_PROVIDER', 'RAILWAY_FALLBACK_PROVIDERS']) saved[k] = process.env[k];
  process.env.RAILWAY_PROVIDER_FALLBACK = 'on';
  process.env.RAILWAY_PRIMARY_PROVIDER = 'railcore';
  process.env.RAILWAY_FALLBACK_PROVIDERS = 'railradar';
  ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors());
});
afterAll(() => { dispose(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
beforeEach(() => {
  rc.reset(); rr.reset();
  railwayRegistry.setActive('mock');
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('P42.9 G2 — backend provider fallback (turn pipeline)', () => {
  it('[F1] RailCore RATE_LIMITED → backend runs the SAME search on RailRadar once; visible to Muse + logs; Muse never chose RailRadar', async () => {
    rc.faults.search = 'RATE_LIMITED';
    let seen: any[] = [];
    const h = harness({ 'Amritsar to Delhi tomorrow': (v) => v.step === 0 ? { calls: [S('railcore')] } : (seen = resultsOf(v), { content: 'Kal ke liye trains mili hain. Kaunsi dekhni hai?' }) });
    const r = await h.say('Amritsar to Delhi tomorrow');
    expect(rc.calls.map(c => c[0])).toEqual(['search']);
    expect(rr.calls.map(c => c[0])).toEqual(['search']);
    expect(rr.calls[0][1]).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: TOMORROW });       // same canonical request
    expect(h.fake.decisionRequests.flatMap(q => (q.body.messages as any[]).filter(m => m.role === 'assistant').flatMap(m => (m.tool_calls || []).map((c: any) => c.function.name)))).not.toContain('railradar_search');
    expect(seen[0]).toMatchObject({ provider: 'RAILRADAR', fallbackUsed: true, fallbackReason: 'RATE_LIMITED', ok: true });
    expect(seen[0].providerAttempts.map((a: any) => [a.provider, a.outcome])).toEqual([['RAILCORE', 'PROVIDER_FAILURE'], ['RAILRADAR', 'DATA']]);
    const rec = recs(r).find(x => x.tool === 'SEARCH_TRAINS');
    expect(rec).toMatchObject({ provider: 'railradar', status: 'SUCCEEDED', fallbackUsed: true, fallbackReason: 'RATE_LIMITED' });
    expect(h.s().searchResults?.trains?.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('[F2] RailCore success → RailRadar is never called (no double query)', async () => {
    const h = harness({ 'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Kal ke liye trains mili hain.' }] });
    const r = await h.say('Amritsar to Delhi tomorrow');
    expect(rc.calls).toHaveLength(1);
    expect(rr.calls).toHaveLength(0);
    expect(recs(r)[0]).toMatchObject({ provider: 'railcore', status: 'SUCCEEDED' });
    expect(recs(r)[0].fallbackUsed ?? false).toBe(false);
  });

  it('[F3] not eligible (AUTH_ERROR) → no fallback, honest failure back to Muse; both down (UNAVAILABLE) → one fallback each attempt, still honest', async () => {
    rc.faults.search = 'AUTH_ERROR';
    const h = harness({ 'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Railway provider abhi jawab nahi de raha.' }] });
    await h.say('Amritsar to Delhi tomorrow');
    expect(rr.calls).toHaveLength(0);
    rc.reset(); rr.reset(); rc.faults.search = 'UNAVAILABLE'; rr.faults.search = 'UNAVAILABLE';
    let seen: any[] = [];
    const h2 = harness({ 'Amritsar to Delhi tomorrow': (v) => v.step === 0 ? { calls: [S('railcore')] } : (seen = resultsOf(v), { content: 'Railway provider abhi uplabdh nahi hai.' }) });
    const r2 = await h2.say('Amritsar to Delhi tomorrow');
    // bounded: RailCore + RailRadar per execution attempt; the runtime retry policy allows at most 1 retry
    expect(rc.calls.length).toBeLessThanOrEqual(2); expect(rr.calls.length).toBeLessThanOrEqual(2); expect(rr.calls.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)).toMatchObject({ ok: false });
    expect(String(r2.voice?.assistantText || '')).not.toMatch(/koi train nahi|no trains/i);
  });

  it('[F4] same-train providers: no explicit choice → PRIMARY only + RailRadar per-request fallback; explicit both → cross-check, no fallback map', () => {
    // the mock connectors expose no timetable capability; give both a route capability (registry ids unchanged)
    for (const id of ['railcore', 'railradar']) { const c = providerToolCatalog.get(id)!; providerToolCatalog.register({ ...c, capabilities: [...new Set([...c.capabilities, 'GET_TIMETABLE' as const])] }); }
    const d = resolveSameTrainProviders(null, null);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.providers.map(p => p.id)).toEqual(['railcore']);
      expect(d.selection).toBe('DEFAULT_PRIMARY');
      expect(d.fallbacks.railcore?.id).toBe('railradar');
      expect(d.routeFallback?.id).toBe('railradar');
    }
    const both = resolveSameTrainProviders('railcore,railradar', null);
    expect(both.ok && both.providers.map(p => p.id)).toEqual(['railcore', 'railradar']);
    expect(both.ok && both.fallbacks).toEqual({});
  });
});
