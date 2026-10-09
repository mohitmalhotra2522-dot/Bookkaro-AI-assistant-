/**
 * P42 — Same Train Alternative, end-to-end through the Muse integration (G3, deterministic MOCK connectors — no network,
 * no credits). user text → native tool calls (fake OpenAI-compatible server playing Muse) → validator →
 * SEARCH_SAME_TRAIN_ALTERNATIVES (bounded fresh fan-out over RailCore + RailRadar MOCK) → result to Muse →
 * PRESENT_SAME_TRAIN_ALTERNATIVES (Muse's ranking) → guarded reply + same_train_alternatives card.
 * Muse's decisions are scripted; what is under test is the BACKEND: execution, hard constraints, honesty, staleness.
 * The route below is TEST DATA served by the mock route provider (the app never hardcodes a route).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => {
  process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1';
  process.env.SAME_TRAIN_CALL_TIMEOUT_MS = '500';
  process.env.SAME_TRAIN_TOTAL_TIMEOUT_MS = '4000';
  // Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): Muse's tool now runs through the shared paced queue —
  // no queue retries in this file (retry / backoff behaviour is covered by f3-paced-queue), like the timeouts above
  process.env.SAME_TRAIN_QUEUE_MAX_RETRIES = '0';
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
import { revalidateSameTrainAlternative, currentSameTrainKey } from '../../server/railway/same-train/same-train-service';
import { SAME_TRAIN_ALL_FAILED_MESSAGE } from '../../shared/same-train-alternatives';
import { resetSameTrainSchedulers } from '../../server/railway/same-train/same-train-scheduler';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P42-SAME-TRAIN-SECRET-42424';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const ROUTE = [['ASR', 'Amritsar Jn'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Jn'], ['LDH', 'Ludhiana Jn'], ['SIR', 'Sirhind Jn'],
  ['RPJ', 'Rajpura Jn'], ['UMB', 'Ambala Cant Jn'], ['KKDE', 'Kurukshetra Jn'], ['PNP', 'Panipat Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));
const USER = 'Ludhiana se Ambala 12014 CC kal — same train alternative check karo';
const SEARCH = (extra: any = {}) => ({ name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12014', travelClass: 'CC', date: TOMORROW, origin: 'LDH', destination: 'UMB', combinedPairs: 'NEVER', ...extra } });
const HEDGED = 'Amritsar se ticket par AVAILABLE 5 mil raha hai, lekin Ludhiana se boarding ka rule verify karna zaroori hai.';

type Script = (v: TurnView) => FakeReply;
let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
let state: ConversationStateManager;

function harness(script: Record<string, Script | FakeReply[]>) {
  const fake = new FakeOpenAI((v: TurnView) => {
    const p = script[v.user];
    if (!p) return { content: 'Theek hai.' };
    if (typeof p === 'function') return p(v);
    return v.step < p.length ? p[v.step] : { content: 'Theek hai.' };
  });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  // Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): Muse's tool searches only a VERIFIED waitlist — the
  // journey's current availability fact (12014 CC WL, as the mock providers answer for LDH → UMB) is set up front
  Object.assign(state.getSession(sid) as any, { origin: 'LDH', destination: 'UMB', date: TOMORROW,
    availability: { CC: { trainNumber: '12014', travelClass: 'CC', date: TOMORROW, origin: 'LDH', destination: 'UMB', status: 'GNWL 12', available: false, toolExecutionId: 'setup-wl' } } });
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>;
  return { fake, say, sid, s: () => state.getSession(sid) as any };
}
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage].map(x => String(x ?? '')).join(' | ');
/** Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): tests that pin the PRE-Phase-2 Muse rules run with the
 *  documented rollback switch SAME_TRAIN_MUSE_SHARED_POLICY=off; the env is restored afterwards. Assertions unchanged. */
async function withMuseSharedPolicyOff(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.SAME_TRAIN_MUSE_SHARED_POLICY;
  process.env.SAME_TRAIN_MUSE_SHARED_POLICY = 'off';
  try { await fn(); } finally { if (prev === undefined) delete process.env.SAME_TRAIN_MUSE_SHARED_POLICY; else process.env.SAME_TRAIN_MUSE_SHARED_POLICY = prev; }
}
const card = (r: any) => (r.cards || []).find((c: any) => c.type === 'same_train_alternatives')?.data;
const toolsSent = (h: ReturnType<typeof harness>) => (h.fake.decisionRequests[0].body.tools as any[]).map(t => t.function.name);
/** find a key anywhere in a tool result Muse received */
function deep(o: any, k: string): any {
  if (!o || typeof o !== 'object') return undefined;
  if (k in o) return o[k];
  for (const v of Object.values(o)) { const r = deep(v, k); if (r !== undefined) return r; }
  return undefined;
}
const stResult = (v: TurnView) => v.results.find(x => x.name === 'SEARCH_SAME_TRAIN_ALTERNATIVES')?.content;
const idForTicket = (v: TurnView, ticket: string) => {
  const alts = deep(stResult(v), 'alternatives') || {};
  return Object.entries(alts).find(([, a]: any) => a.ticket === ticket)?.[0];
};
/** per-pair availability on both mock connectors (records calls like the real connector does) */
type StatusFn = (provider: string, req: any) => string | 'HANG' | { error: string };
function setStatus(fn: StatusFn) {
  for (const c of [rc, rr]) {
    (c as any).checkAvailability = async (req: any) => {
      c.calls.push(['availability', req]);
      const s = fn(c.connectorId, req);
      if (s === 'HANG') return new Promise(() => { /* never */ });
      if (typeof s === 'object') return { ok: false, error: { code: s.error, message: 'mock fault' } };
      return { ok: true, data: { trainNumber: req.trainNumber, travelClass: req.travelClass, date: req.date, status: s }, meta: { source: 'mock' } };
    };
  }
}
const availCalls = (c: MockProviderConnector) => c.calls.filter(x => x[0] === 'availability');
const ASR_GOOD: StatusFn = (_p, q) => (q.origin === 'ASR' ? 'AVAILABLE 5' : 'GNWL 12');

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors());
  // TEST SETUP: the mock RailCore connector also serves the train route (timetable) — a route-capable provider
  providerToolCatalog.register({ id: 'railcore', label: rc.connectorLabel, registryId: rc.mockProviderId, capabilities: [...MOCK_CONNECTOR_CAPS.railcore, 'GET_TIMETABLE' as any] });
});
afterAll(() => dispose());
beforeEach(() => {
  rc.reset(); rr.reset();
  // Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): the shared paced queue is process-wide — a fresh queue
  // per test so a deliberately never-settling provider call ([6] HANG) cannot hold in-flight slots into the next test
  resetSameTrainSchedulers();
  (rc as any).getTimetable = async (req: any) => { rc.calls.push(['timetable' as any, req]); return { ok: true, data: ROUTE, meta: { source: 'mock' } }; };
  (rr as any).getTimetable = async (req: any) => { rr.calls.push(['timetable' as any, req]); return { ok: true, data: ROUTE, meta: { source: 'mock' } }; };
  setStatus(ASR_GOOD);
  railwayRegistry.setActive('mock');
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); });

const fullFlow = (final: string = HEDGED): Script => (v: TurnView) => {
  if (v.step === 0) return { calls: [SEARCH()] };
  if (v.step === 1) {
    const best = idForTicket(v, 'ASR→UMB');
    return { calls: [{ name: 'PRESENT_SAME_TRAIN_ALTERNATIVES', args: { alternativeSearchId: deep(stResult(v), 'searchRef'), ...(best ? { bestMatch: best } : {}) } }] };
  }
  return { content: final };
};

describe('P42 G3 — Same Train Alternative through Muse', () => {
  it('[1] the composite tools are exposed to Muse; a normal turn never triggers an alternative search (no automatic fallback)', async () => {
    const h = harness({ 'hi': [{ content: 'Namaste! Kahan jaana hai?' }] });
    const r = await h.say('hi');
    expect(toolsSent(h)).toEqual(expect.arrayContaining(['SEARCH_SAME_TRAIN_ALTERNATIVES', 'PRESENT_SAME_TRAIN_ALTERNATIVES']));
    const def = (h.fake.decisionRequests[0].body.tools as any[]).find(t => t.function.name === 'SEARCH_SAME_TRAIN_ALTERNATIVES').function;
    // (native defs mark `required` only for SEARCH_TRAINS — the backend validator enforces the rest, see G2 [32]-[34])
    expect(Object.keys(def.parameters.properties)).toEqual(expect.arrayContaining(['trainNumber', 'travelClass', 'date', 'origin', 'destination', 'providers', 'routeProvider', 'combinedPairs', 'destinationExtensionStations', 'includeFare', 'webEvidence']));
    expect(availCalls(rc).length + availCalls(rr).length).toBe(0);
    expect(card(r)).toBeUndefined();
  });

  it('[2] full flow: Muse searches, ranks (PRESENT) and words it honestly → card with Muse best match, all pairs fresh, booking untouched', async () => {
    const h = harness({ [USER]: fullFlow() });
    const before = { ...h.s() };
    const r = await h.say(USER);
    const names = recs(r).map((x: any) => x.tool);
    expect(names).toEqual(expect.arrayContaining(['SEARCH_SAME_TRAIN_ALTERNATIVES', 'PRESENT_SAME_TRAIN_ALTERNATIVES']));
    const c = card(r);
    expect(c).toBeTruthy();
    expect(c).toMatchObject({ trainNumber: '12014', travelClass: 'CC', date: TOMORROW, requestedOrigin: 'LDH', requestedDestination: 'UMB', fresh: true, cached: false, stale: false, isMock: true });   // MOCK connectors → labelled mock, never live
    const asr = c.alternatives.find((a: any) => a.ticketOrigin === 'ASR');
    expect(c.presentation).toMatchObject({ decidedBy: 'MUSE', bestMatchId: asr.alternativeId });
    expect(asr).toMatchObject({ availability: 'AVAILABLE', verificationStatus: 'PARTIALLY_VERIFIED', boardingRuleStatus: 'UNVERIFIED', boardingStation: 'ASR' });
    expect(c.alternatives[0]).toMatchObject({ isRequestedPair: true, ticketOrigin: 'LDH', ticketDestination: 'UMB', availability: 'WAITLIST' });   // original result kept
    expect(availCalls(rc).length).toBe(c.candidateCount);
    expect(availCalls(rr).length).toBe(c.candidateCount);
    expect(availCalls(rc).every(([, q]) => q.trainNumber === '12014')).toBe(true);                 // same train only
    expect(shown(r)).toContain('Ludhiana se boarding ka rule verify karna zaroori hai');
    const s = h.s();
    expect(s.sameTrainAlternatives?.alternativeSearchId).toBe(c.alternativeSearchId);
    expect(s.selectedTrain ?? null).toEqual(before.selectedTrain ?? null);                          // no booking mutation
    expect(s.bookingState).toBe(before.bookingState);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(h.fake.decisionRequests.map(d => d.body))).not.toContain(KEY);
  });

  it('[3] an unverified "book Amritsar, board at Ludhiana" claim from Muse is removed; the fact-only hedged line replaces it', async () => {
    const h = harness({ [USER]: fullFlow('Amritsar ka ticket book karke Ludhiana se board kar lijiye.') });
    const r = await h.say(USER);
    expect(shown(r)).not.toMatch(/Ludhiana se board kar lijiye/);
    expect(shown(r)).toMatch(/boarding ka rule verify karna zaroori hai/);
    expect(card(r)).toBeTruthy();
  });

  it('[4] provider conflict reaches Muse and the screen as CONFLICTING (no value stated as fact)', async () => {
    setStatus((p, q) => (q.origin === 'JUC' ? (p === 'railcore' ? 'AVAILABLE 3' : 'GNWL 4') : 'GNWL 10'));
    let seen: any;
    const h = harness({ [USER]: (v: TurnView) => { if (v.step === 0) return { calls: [SEARCH()] }; seen = stResult(v); return { content: 'Jalandhar wale option par providers ka data match nahi kar raha.' }; } });
    const r = await h.say(USER);
    expect(card(r)).toBeUndefined();                                                                 // P42.2: card only when a verified alternative exists
    const res = h.s().sameTrainAlternatives;                                                         // the stored result the card would have been built from
    const juc = res.alternatives.find((a: any) => a.ticketOrigin === 'JUC');
    expect(juc).toMatchObject({ availability: 'CONFLICTING', verificationStatus: 'CONFLICTING' });
    expect(juc.conflict.values).toHaveLength(2);
    expect(res.errors).toContain('PROVIDER_DATA_CONFLICT');
    const jucForMuse: any = Object.values(deep(seen, 'alternatives')).find((a: any) => a.ticket === 'JUC→UMB');
    expect(jucForMuse.availability).toBe('CONFLICTING');
    expect(res.presentation.decidedBy).toBe('NONE');                                            // Muse did not rank → backend does not either
  });

  it('[5] all providers fail → honest typed error to Muse, pinned message on screen, no card, nothing invented', async () => {
    setStatus(() => ({ error: 'PROVIDER_UNAVAILABLE' }));
    let err: any;
    const h = harness({ [USER]: (v: TurnView) => { if (v.step === 0) return { calls: [SEARCH()] }; err = stResult(v); return { content: '' }; } });
    const r = await h.say(USER);
    expect(JSON.stringify(err)).toMatch(/ALTERNATIVE_SEARCH_FAILED/);
    expect(shown(r)).toContain(SAME_TRAIN_ALL_FAILED_MESSAGE);
    expect(card(r)).toBeUndefined();
    expect(shown(r)).not.toMatch(/AVAILABLE|RAC \d/);
  });

  it('[6] partial failure (RailRadar times out) keeps RailCore evidence and reports PARTIAL — timeouts are never "no seats"', async () => withMuseSharedPolicyOff(async () => {
    setStatus((p, q) => (p === 'railradar' ? 'HANG' : ASR_GOOD(p, q)));
    const h = harness({ [USER]: fullFlow() });
    const r = await h.say(USER);
    const c = card(r);
    expect(c.status).toBe('PARTIAL');
    expect(c.providers.find((p: any) => p.provider === 'railradar')).toMatchObject({ succeeded: 0 });
    expect(c.alternatives.find((a: any) => a.ticketOrigin === 'ASR').availability).toBe('AVAILABLE');
    expect(c.alternatives.some((a: any) => a.availability === 'NOT_AVAILABLE')).toBe(false);
  }), 20000);

  it('[7] Muse picks the provider: providers="railcore" → RailRadar is never called (no hidden fan-out / failover)', async () => {
    const h = harness({ [USER]: [{ calls: [SEARCH({ providers: 'railcore' })] }, { content: 'RailCore se check kiya.' }] });
    const r = await h.say(USER);
    expect(card(r).providers.map((p: any) => p.provider)).toEqual(['railcore']);
    expect(availCalls(rr).length).toBe(0);
    expect(availCalls(rc).length).toBe(card(r).candidateCount);
  });

  it('[8] arbitrary / web provider ids are rejected before any provider call', async () => {
    let err1: any, err2: any;
    const h = harness({
      [USER]: (v: TurnView) => (v.step === 0 ? { calls: [SEARCH({ providers: 'confirmtkt' })] } : (err1 = stResult(v), { content: 'Theek hai.' })),
      '12014 phir se check karo': (v: TurnView) => (v.step === 0 ? { calls: [SEARCH({ providers: 'railcore', routeProvider: 'railradar' })] } : (err2 = stResult(v), { content: 'Theek hai.' }))
    });
    await h.say(USER);
    await h.say('12014 phir se check karo');
    expect(JSON.stringify(err1)).toMatch(/INVALID_TOOL_CALL|Unknown provider/);
    expect(JSON.stringify(err2)).toMatch(/route/i);
    expect(availCalls(rc).length + availCalls(rr).length).toBe(0);
  });

  it('[9] Muse cannot invent a train the user never mentioned / saw', async () => {
    let err: any;
    const h = harness({ 'koi aur option hai?': (v: TurnView) => (v.step === 0 ? { calls: [SEARCH({ trainNumber: '12460' })] } : (err = stResult(v), { content: 'Kaunsi train?' })) });
    const r = await h.say('koi aur option hai?');
    expect(JSON.stringify(err)).toMatch(/AUTHORITATIVE_DATA_REQUIRED/);
    expect(availCalls(rc).length + availCalls(rr).length).toBe(0);
    expect(card(r)).toBeUndefined();
  });

  it('[10] every explicit search is fresh: the same request twice → providers called twice, new alternativeSearchId', async () => {
    const h = harness({ [USER]: fullFlow() });
    const a = card(await h.say(USER));
    const n1 = availCalls(rc).length;
    const b = card(await h.say(USER));
    expect(availCalls(rc).length).toBe(2 * n1);
    expect(a.alternativeSearchId).not.toBe(b.alternativeSearchId);
  });

  it('[11] journey change makes the stored result stale: PRESENT refused, selection refused (STALE), no provider call', async () => {
    let presentErr: any;
    const h = harness({
      [USER]: fullFlow(),
      'ab dikhao': (v: TurnView) => (v.step === 0 ? { calls: [{ name: 'PRESENT_SAME_TRAIN_ALTERNATIVES', args: { alternativeSearchId: h.s().sameTrainAlternatives.alternativeSearchId, bestMatch: 'A2' } }] } : (presentErr = v.results[0]?.content, { content: 'Theek hai.' }))
    });
    const c = card(await h.say(USER));
    state.updateJourney(h.sid, { destination: 'NDLS' } as any);                    // the user changed the destination
    await h.say('ab dikhao');
    expect(JSON.stringify(presentErr)).toMatch(/STALE_ALTERNATIVE_RESULT/);
    const s = h.s();
    const n = availCalls(rc).length;
    const out = await revalidateSameTrainAlternative(s.sameTrainAlternatives, c.alternativeSearchId, 'A2', currentSameTrainKey(s, s.sameTrainAlternatives));
    expect(out).toMatchObject({ ok: false, code: 'ALTERNATIVE_RESULT_STALE' });
    expect(availCalls(rc).length).toBe(n);
  });

  it('[12] "Use this option" (explicit selection) revalidates fresh against the same providers before any booking step', async () => {
    const h = harness({ [USER]: fullFlow() });
    const c = card(await h.say(USER));
    const s = h.s();
    const asr = c.alternatives.find((a: any) => a.ticketOrigin === 'ASR').alternativeId;
    const key = currentSameTrainKey(s, s.sameTrainAlternatives);
    expect(await revalidateSameTrainAlternative(s.sameTrainAlternatives, c.alternativeSearchId, asr, key)).toMatchObject({ ok: false, code: 'BOARDING_RULE_UNVERIFIED' });
    const n = availCalls(rc).length;
    const ok = await revalidateSameTrainAlternative(s.sameTrainAlternatives, c.alternativeSearchId, asr, key, { acknowledgeUnverifiedRules: true });
    expect(ok).toMatchObject({ ok: true });
    expect(availCalls(rc).length).toBe(n + 1);                                         // one fresh call per provider
    expect(availCalls(rr).length).toBe(c.candidateCount + 1);
    expect(ok.handoffText).toMatch(/ticket ASR se UMB/);
    expect(h.s().selectedTrain ?? null).toBeNull();                                    // still nothing mutated
    setStatus(() => 'REGRET');
    expect(await revalidateSameTrainAlternative(s.sameTrainAlternatives, c.alternativeSearchId, asr, key, { acknowledgeUnverifiedRules: true })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NO_LONGER_AVAILABLE' });
  });

  it('[13] voice uses the same result: same card, concise speech that does not read every option aloud', async () => {
    const h = harness({ [USER]: fullFlow() });
    const r = await h.say(USER, 'VOICE');
    const c = card(r);
    expect(c).toBeTruthy();
    const speech = String(r.voice?.speechText || '');
    expect(speech.length).toBeGreaterThan(0);
    expect(speech.length).toBeLessThanOrEqual(420);
    const codesSpoken = c.alternatives.filter((a: any) => speech.includes(a.ticketOriginName || '@@') && !a.isRequestedPair).length;
    expect(codesSpoken).toBeLessThan(c.alternatives.length - 1);
  });

  it('[14] destination == terminal → no destination sweep; only origin alternatives are checked', async () => withMuseSharedPolicyOff(async () => {
    const h = harness({ [USER]: [{ calls: [SEARCH({ destination: 'NDLS' })] }, { content: 'Check kar liya.' }] });
    const c = card(await h.say(USER));
    expect(c.route.destinationSweep).toBe('NONE_TERMINAL');
    expect(c.alternatives.every((a: any) => a.ticketDestination === 'NDLS')).toBe(true);
    expect(c.candidateCount).toBe(1 + 4);
  }));
});
