/**
 * P37 — LLM-native direct multi-provider railway tools (G2, deterministic MOCK connectors only — no network, no credits).
 *   user text → native tool calls (fake OpenAI-compatible server playing the LLM) → provider tool gateway
 *   (railcore_* / railradar_*) → the NAMED provider only → provider result + providerStatus back to the LLM → reply.
 * The fake LLM's decisions are scripted; what is under test is the BACKEND: it exposes only implemented providers,
 * runs exactly the provider the LLM named, never switches provider by itself, returns failures honestly, keeps parallel
 * provider results separate, refuses unimplemented providers, keeps booking disabled and never leaks keys.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { currentResults } from '../../server/ai/context/train-reference-resolver';
import { providerToolCatalog, providerStatusOf } from '../../server/ai/tools/provider-tools';
import { registerMockProviderConnectors, type MockProviderConnector } from '../../server/railway/providers/mock/mock-provider-connectors';
import { todayInIndia } from '../../server/ai/providers/openai-compatible-llm';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P37-PROVIDER-SECRET-37373';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const S = (p: string, date = TOMORROW, origin = 'ASR', destination = 'NDLS') => ({ name: `${p}_search`, args: { origin, destination, date } });
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, selectionPurpose: 'INFORMATION', ...(cls ? { classRaw: cls } : {}) });

type Script = (v: TurnView) => FakeReply;
let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;

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
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>;
  return { fake, say, sid, s: () => state.getSession(sid) as any };
}
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText].map(x => String(x ?? '')).join(' | ');
const toolsSent = (h: ReturnType<typeof harness>) => (h.fake.decisionRequests[0].body.tools as any[]).map(t => t.function.name);
const resultsOf = (v: TurnView) => v.results.map(x => ({ name: x.name, ...(typeof x.content === 'object' ? x.content : { raw: x.content }) }));

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => { ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors()); });
afterAll(() => dispose());
beforeEach(() => {
  rc.reset(); rr.reset();
  railwayRegistry.setActive('mock');            // the active (generic) provider is NOT what provider tools execute on
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('P37 provider tools — exposure + gateway', () => {
  it('[1] only implemented providers are exposed as tools; no generic railway tools, no fake ConfirmTkt/RailYatri/eRail', async () => {
    const h = harness({ 'hi': [{ content: 'Namaste! Kahan jaana hai?' }] });
    await h.say('hi');
    const names = toolsSent(h);
    expect(names).toEqual(expect.arrayContaining(['railcore_search', 'railcore_availability', 'railcore_fare', 'railcore_live_status', 'railradar_search', 'railradar_pnr', 'update_booking_session']));
    expect(names.some(n => /^(SEARCH_TRAINS|CHECK_AVAILABILITY|GET_FARE|TRACK_TRAIN|CHECK_PNR)$/.test(n))).toBe(false);
    expect(names.some(n => /confirmtkt|railyatri|erail/i.test(n))).toBe(false);
    expect(names).not.toContain('railcore_pnr');                     // not a capability of this connector → not exposed
    const search = (h.fake.decisionRequests[0].body.tools as any[]).find(t => t.function.name === 'railcore_search').function;
    expect(search.parameters.required).toEqual(expect.arrayContaining(['origin', 'destination', 'date']));
    expect(JSON.stringify(search)).toMatch(/station code/i);
    expect(JSON.stringify(search)).toMatch(/YYYY-MM-DD/);
    expect(JSON.stringify(h.fake.decisionRequests[0].body)).not.toContain(KEY);   // keys never reach the LLM
    expect(rc.calls.length + rr.calls.length).toBe(0);                             // general chat → no provider call
    // the LLM gets today's date (it interprets dates itself)
    const ctx = h.fake.decisionRequests[0].body.messages.find((m: any) => String(m.content).startsWith('AUTHORITATIVE SESSION CONTEXT')).content;
    expect(ctx).toContain(`"date":"${todayInIndia().date}"`);
    expect(ctx).toMatch(/RailCore \(MOCK\)/);
  });

  it('[2] English: railcore_search runs on RailCore ONLY (not the active provider, not RailRadar); providerStatus SUCCESS', async () => {
    let seen: any[] = [];
    const h = harness({ 'Amritsar to Delhi tomorrow': (v) => v.step === 0 ? { calls: [S('railcore')] } : (seen = resultsOf(v), { content: 'RailCore par kal ke liye trains mili hain. Kaunsi dekhni hai?' }) });
    const r = await h.say('Amritsar to Delhi tomorrow');
    expect(rc.calls.map(c => c[0])).toEqual(['search']);
    expect(rr.calls).toHaveLength(0);
    expect(rc.calls[0][1]).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: TOMORROW });
    expect(seen[0]).toMatchObject({ providerTool: 'railcore_search', tool: 'SEARCH_TRAINS', providerStatus: 'SUCCESS', ok: true });
    expect(recs(r).map(x => [x.tool, x.provider, x.status])).toEqual([['SEARCH_TRAINS', 'railcore', 'SUCCEEDED']]);
    expect(recs(r)[0]).toMatchObject({ fresh: true, sessionId: h.sid });
    expect(typeof recs(r)[0].latencyMs).toBe('number');
    expect(currentResults(h.s()).length).toBeGreaterThan(0);
    expect(h.s()).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: TOMORROW });
  });

  it('[3] Hindi / Devanagari: the LLM passes official codes + ISO date; the backend accepts them (no Hindi parser, no AMBIGUOUS_ROUTE)', async () => {
    const said = 'मुझे अमृतसर से दिल्ली कल जाना है';
    const h = harness({ [said]: [{ calls: [S('railcore')] }, { content: 'कल अमृतसर से नई दिल्ली की ट्रेनें मिल गई हैं। कौन सी देखनी है?' }] });
    const r = await h.say(said);
    expect(rc.calls.map(c => c[1].origin + '>' + c[1].destination + '@' + c[1].date)).toEqual([`ASR>NDLS@${TOMORROW}`]);
    expect(shown(r)).not.toMatch(/samajh nahi aaya/);
    expect(h.s()).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: TOMORROW });
    // an unlisted (but well-formed) official code is passed to the provider untouched — the provider validates it
    const h2 = harness({ 'लुधियाना से दिल्ली कल': [{ calls: [S('railradar', TOMORROW, 'LDH')] }, { content: 'ठीक है।' }] });
    await h2.say('लुधियाना से दिल्ली कल');
    expect(rr.calls.at(-1)![1]).toMatchObject({ origin: 'LDH', destination: 'NDLS' });
  });

  it('[4] provider TIMEOUT → returned to the LLM as PROVIDER_TIMEOUT (never "no trains"); NO hidden switch; the LLM chooses RailRadar', async () => {
    rc.faults.search = 'TIMEOUT';
    let first: any = null;
    const h = harness({ 'Amritsar to Delhi tomorrow': (v) => {
      if (v.step === 0) return { calls: [S('railcore')] };
      const res = resultsOf(v);
      if (v.step === 1) { first = res[0]; return res[0].providerStatus === 'PROVIDER_TIMEOUT' ? { calls: [S('railradar')] } : { content: 'x' }; }
      return { content: 'RailCore se jawab nahi aaya, RailRadar par kal ke liye trains mili hain.' };
    } });
    const r = await h.say('Amritsar to Delhi tomorrow');
    expect(first).toMatchObject({ providerTool: 'railcore_search', providerStatus: 'PROVIDER_TIMEOUT', ok: false });
    expect(rr.calls.map(c => c[0])).toEqual(['search']);              // ONLY because the LLM asked for railradar_search
    expect(recs(r).map(x => x.provider)).toEqual(expect.arrayContaining(['railcore', 'railradar']));
    expect(recs(r).filter(x => x.provider === 'railcore').every(x => x.status !== 'SUCCEEDED')).toBe(true);
    expect(currentResults(h.s()).length).toBeGreaterThan(0);
    // and if the LLM does NOT ask for another provider, the backend does not either
    rc.reset(); rr.reset(); rc.faults.search = 'UNAVAILABLE';
    const h2 = harness({ 'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'RailCore abhi uplabdh nahi hai, thodi der baad try karein.' }] });
    const r2 = await h2.say('Amritsar to Delhi tomorrow');
    expect(rr.calls).toHaveLength(0);
    expect(shown(r2)).not.toMatch(/koi train nahi|no trains/i);
  });

  it('[5] AUTH_ERROR / RATE_LIMITED normalized for the LLM; SUCCESS with an empty list = NO_RESULTS (distinct from failure)', async () => {
    expect(providerStatusOf({ ok: false, error: { code: 'AUTH_ERROR' } })).toBe('AUTH_ERROR');
    expect(providerStatusOf({ ok: false, error: { code: 'RATE_LIMITED' } })).toBe('RATE_LIMITED');
    expect(providerStatusOf({ ok: false, error: { code: 'TIMEOUT' } })).toBe('PROVIDER_TIMEOUT');
    expect(providerStatusOf({ ok: true, empty: true })).toBe('NO_RESULTS');
    rc.faults.search = 'AUTH_ERROR'; rr.faults.search = 'EMPTY';
    let st: string[] = [];
    const h = harness({ 'Amritsar to Delhi tomorrow': (v) => v.step === 0 ? { calls: [S('railcore'), S('railradar')] } : (st = resultsOf(v).map(x => `${x.providerTool}:${x.providerStatus}`), { content: 'RailCore check nahi ho paya; RailRadar par is din koi train nahi mili.' }) });
    await h.say('Amritsar to Delhi tomorrow');
    expect(st.sort()).toEqual(['railcore_search:AUTH_ERROR', 'railradar_search:NO_RESULTS']);
  });

  it('[6] parallel search on two providers: both run, results come back SEPARATELY per provider', async () => {
    let res: any[] = [];
    const h = harness({ 'Dono providers par check karo: kal Amritsar se Delhi': (v) => v.step === 0 ? { calls: [S('railcore'), S('railradar')] } : (res = resultsOf(v), { content: 'Dono providers par kal ki trains mili hain.' }) });
    const r = await h.say('Dono providers par check karo: kal Amritsar se Delhi');
    expect(rc.calls.map(c => c[0])).toEqual(['search']);
    expect(rr.calls.map(c => c[0])).toEqual(['search']);
    expect(res.map(x => x.providerTool).sort()).toEqual(['railcore_search', 'railradar_search']);
    expect(res.every(x => x.providerStatus === 'SUCCESS')).toBe(true);
    expect(recs(r).filter(x => x.status === 'SUCCEEDED').map(x => x.provider).sort()).toEqual(['railcore', 'railradar']);
  });

  it('[7] conflicting fares: each provider\'s fare is reported with its source; nothing averaged / invented', async () => {
    rr.fareOverride['3A'] = 700;
    let res: any[] = [];
    const h = harness({
      'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Trains mil gayi.' }],
      '12497 3A ka fare dono par batao': (v) => v.step === 0 ? { calls: [SEL('12497', '3A')] }
        : v.step === 1 ? { calls: [{ name: 'railcore_fare', args: { trainNumber: '12497', travelClass: '3A' } }, { name: 'railradar_fare', args: { trainNumber: '12497', travelClass: '3A' } }] }
        : (res = resultsOf(v).filter(x => x.tool === 'GET_FARE'), { content: '12497 3A: RailCore par ₹650, RailRadar par ₹700 per passenger.' })
    });
    await h.say('Amritsar to Delhi tomorrow');
    const r = await h.say('12497 3A ka fare dono par batao');
    expect(rc.calls.filter(c => c[0] === 'fare')).toHaveLength(1);
    expect(rr.calls.filter(c => c[0] === 'fare')).toHaveLength(1);
    expect(res.map(x => x.providerTool).sort()).toEqual(['railcore_fare', 'railradar_fare']);
    const txt = shown(r);
    expect(txt).toContain('650'); expect(txt).toContain('700');
    expect(txt).not.toMatch(/675/);
  });

  it('[8] unimplemented provider (ConfirmTkt / RailYatri / eRail) → PROVIDER_NOT_IMPLEMENTED, nothing executed, no fake data', async () => {
    let res: any[] = [];
    const h = harness({ 'ConfirmTkt par check karo': (v) => v.step === 0 ? { calls: [S('confirmtkt'), S('erail')] } : (res = resultsOf(v), { content: 'ConfirmTkt aur eRail abhi integrated nahi hain.' }) });
    const r = await h.say('ConfirmTkt par check karo');
    expect(res.map(x => x.providerStatus)).toEqual(['PROVIDER_NOT_IMPLEMENTED', 'PROVIDER_NOT_IMPLEMENTED']);
    expect(rc.calls.length + rr.calls.length).toBe(0);
    expect(currentResults(h.s())).toHaveLength(0);
    expect(recs(r).every(x => x.status !== 'SUCCEEDED')).toBe(true);
    expect(() => providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt', registryId: 'mock', capabilities: ['SEARCH_TRAINS'] })).toThrow();
  });

  it('[9] a capability a provider does not implement (railcore_pnr) is refused, not silently routed elsewhere', async () => {
    let res: any[] = [];
    const h = harness({ 'PNR 1234567890 check karo': (v) => v.step === 0 ? { calls: [{ name: 'railcore_pnr', args: { pnr: '1234567890' } }] } : (res = resultsOf(v), { content: 'RailCore PNR support nahi karta.' }) });
    await h.say('PNR 1234567890 check karo');
    expect(res[0].ok).toBe(false);
    expect(rr.calls).toHaveLength(0);
    expect(rc.calls).toHaveLength(0);
  });

  it('[10] train reference resolved by the LLM ("pehli wali") → select from the latest results → availability on the named provider', async () => {
    let avail: any = null;
    const h = harness({
      'Amritsar to Delhi tomorrow': [{ calls: [S('railradar')] }, { content: 'Trains mil gayi.' }],
      'pehli wali ki 3A availability': (v) => {
        const first = currentResults(h.s())[0];
        if (v.step === 0) return { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 1, searchResultsVersion: v.context?.searchResultsVersion }, classRaw: 'CC', selectionPurpose: 'INFORMATION' })] };
        if (v.step === 1) return { calls: [{ name: 'railradar_availability', args: { trainNumber: first.trainNumber, travelClass: 'CC' } }] };
        avail = resultsOf(v).find(x => x.tool === 'CHECK_AVAILABILITY');
        return { content: `${first.trainNumber} CC: dekh liya.` };
      }
    });
    await h.say('Amritsar to Delhi tomorrow');
    await h.say('pehli wali ki 3A availability');
    expect(avail).toMatchObject({ providerTool: 'railradar_availability', providerStatus: 'SUCCESS' });
    expect(rr.calls.filter(c => c[0] === 'availability')).toHaveLength(1);
    expect(rc.calls).toHaveLength(0);
    expect(h.s().selectedTrain?.number || h.s().selectedTrain?.trainNumber).toBe(currentResults(h.s())[0].trainNumber);
  });

  it('[11] fresh data: "abhi dobara check karo" makes a NEW provider call (no cache)', async () => {
    const h = harness({
      'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Trains mil gayi.' }],
      '12497 3A': [{ calls: [SEL('12497', '3A')] }, { calls: [{ name: 'railcore_availability', args: { trainNumber: '12497', travelClass: '3A' } }] }, { content: '12497 3A dekh liya.' }],
      'abhi dobara check karo': [{ calls: [{ name: 'railcore_availability', args: { trainNumber: '12497', travelClass: '3A' } }] }, { content: '12497 3A dobara dekh liya.' }]
    });
    await h.say('Amritsar to Delhi tomorrow');
    await h.say('12497 3A');
    const r = await h.say('abhi dobara check karo');
    expect(rc.calls.filter(c => c[0] === 'availability')).toHaveLength(2);
    expect(recs(r).find(x => x.tool === 'CHECK_AVAILABILITY')).toMatchObject({ fresh: true, status: 'SUCCEEDED', provider: 'railcore' });
  });

  it('[12] live status on the provider the LLM picked (MOCK-labelled data)', async () => {
    let res: any = null;
    const h = harness({ '12497 kahan hai abhi?': (v) => v.step === 0 ? { calls: [{ name: 'railradar_live_status', args: { trainNumber: '12497' } }] } : (res = resultsOf(v)[0], { content: '12497 abhi Ludhiana ke paas hai, 15 minute late.' }) });
    await h.say('12497 kahan hai abhi?');
    expect(res).toMatchObject({ providerTool: 'railradar_live_status', providerStatus: 'SUCCESS' });
    expect(rr.calls.map(c => c[0])).toEqual(['live_status']);
    expect(rc.calls).toHaveLength(0);
  });

  it('[13] tool budget: more calls than MAX_TOOL_CALLS_PER_TURN → TOOL_CALL_LIMIT_EXCEEDED, budget not raised', async () => {
    const day = (n: number) => { const d = new Date(`${TOMORROW}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const many = Array.from({ length: 12 }, (_, i) => S(i % 2 ? 'railradar' : 'railcore', day(i)));   // 12 DISTINCT calls
    const h = harness({ 'sab check karo': [{ calls: many }, { content: 'Theek hai.' }] });
    const r = await h.say('sab check karo');
    const st = recs(r).map(x => x.rejectionReason || x.status);
    expect(st.some(x => /TOOL_CALL_LIMIT_EXCEEDED/.test(String(x)))).toBe(true);
    expect(rc.calls.length + rr.calls.length).toBeLessThanOrEqual(8);
  });

  it('[14] VOICE uses the same pipeline + booking stays disabled; no payment / booking tools; LLM booking claims rejected', async () => {
    const h = harness({
      'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Kal ke liye trains mili hain. Kaunsi dekhni hai?' }],
      'seedha book kar do': [{ calls: [{ name: 'BOOK_TICKET', args: { trainNumber: '12497' } }, { name: 'railcore_book', args: { trainNumber: '12497' } }] }, { content: 'Booked! Payment ho gaya. PNR 4512345678.' }]
    });
    const v = await h.say('Amritsar to Delhi tomorrow', 'VOICE');
    expect(v.voice?.speechText).toBeTruthy();
    expect(rc.calls.map(c => c[0])).toEqual(['search']);
    const names = toolsSent(h);
    expect(names.filter(n => n !== 'update_booking_session').some(n => /book|pay|otp|captcha|irctc/i.test(n))).toBe(false);
    const r = await h.say('seedha book kar do', 'VOICE');
    expect(shown(r)).not.toMatch(/book ho gayi|booked|payment ho gaya|PNR\s*\d{6,}/i);
    expect(recs(r).every(x => x.status !== 'SUCCEEDED')).toBe(true);
    expect(JSON.stringify(h.fake.requests.map(q => q.body))).not.toContain(KEY);
  });
});
