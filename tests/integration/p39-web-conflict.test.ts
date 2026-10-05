/**
 * P39 — G2 (integration): API-first fallback is the LLM's choice, SOURCE_CONFLICT, WEB_ACCESS_BLOCKED, fresh calls.
 * Fake OpenAI-compatible server plays the LLM (scripted decisions); MOCK provider connectors; no network.
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
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { registerMockProviderConnectors, type MockProviderConnector } from '../../server/railway/providers/mock/mock-provider-connectors';
import { todayInIndia } from '../../server/ai/providers/openai-compatible-llm';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P39-WEB-SECRET-39393';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const S = (p: string) => ({ name: `${p}_search`, args: { origin: 'ASR', destination: 'NDLS', date: TOMORROW } });
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, selectionPurpose: 'INFORMATION', ...(cls ? { classRaw: cls } : {}) });
const CT_HTML = `<script>var data = {"TrainName":"Amritsar Shtabdi","TrainNo":"12014"};
</script><div>Last Updated:&nbsp;05 Oct 2026 10:51</div>
<div class="row rs__station-row"><svg class="bi bi-check-circle"></svg><span class="rs__station-name">Ludhiana Jn</span><div class="rs__station-delay">Delay by 7 min</div></div>
<div class="row rs__station-row"><span class="rs__station-name">New Delhi</span><div class="rs__station-delay"></div></div>`;

type Script = (v: TurnView) => FakeReply;
let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
const webFetches: string[] = [];

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
  const say = (t: string) => eng.processTurn(sid, t, 'TEXT') as Promise<any>;
  return { fake, say, sid, s: () => state.getSession(sid) as any };
}
const resultsOf = (v: TurnView) => v.results.map(x => ({ name: x.name, ...(typeof x.content === 'object' ? x.content : { raw: x.content }) }));
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => { ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors()); });
afterAll(() => dispose());
beforeEach(() => {
  rc.reset(); rr.reset(); webFetches.length = 0;
  railwayRegistry.setActive('mock');
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => {
    const url = String(u);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(u, i);
    if (url.startsWith('https://www.confirmtkt.com/train-running-status/')) { webFetches.push(url); return Promise.resolve(new Response(CT_HTML, { status: 200 })); }
    webFetches.push(url);
    throw new Error(`NO NETWORK IN TESTS: ${url}`);
  }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); providerToolCatalog.unregister('confirmtkt'); });

describe('P39 G2 — SOURCE_CONFLICT', () => {
  it('[1] two providers disagree on fare → both values reported to the LLM, conflicting fare removed from the session', async () => {
    rr.fareOverride['3A'] = 700;
    let res: any[] = [];
    const h = harness({
      'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Trains mil gayi.' }],
      '12497 3A ka fare dono par batao': (v) => v.step === 0 ? { calls: [SEL('12497', '3A')] }
        : v.step === 1 ? { calls: [{ name: 'railcore_fare', args: { trainNumber: '12497', travelClass: '3A' } }, { name: 'railradar_fare', args: { trainNumber: '12497', travelClass: '3A' } }] }
        : (res = resultsOf(v).filter(x => x.tool === 'GET_FARE'), { content: 'RailCore par ₹650, RailRadar par ₹700 — dono alag hain, fresh check chahiye.' })
    });
    await h.say('Amritsar to Delhi tomorrow');
    await h.say('12497 3A ka fare dono par batao');
    expect(res).toHaveLength(2);
    const withConflict = res.filter(x => x.sourceConflict);
    expect(withConflict).toHaveLength(1);
    const c = withConflict[0].sourceConflict;
    expect(c).toMatchObject({ code: 'SOURCE_CONFLICT', kind: 'FARE', trainNumber: '12497', travelClass: '3A' });
    expect(c.values.map((x: any) => x.provider).sort()).toEqual(['railcore', 'railradar']);
    expect(c.values.map((x: any) => x.value).sort()).toEqual(['INR 650', 'INR 700']);
    expect(h.s().fare).toBeUndefined();                  // never left in the session as if verified
    expect(h.s().sourceConflicts?.[0]).toMatchObject({ kind: 'FARE', travelClass: '3A' });
    expect(JSON.stringify(h.s().sourceConflicts)).not.toMatch(/650|700/);
  });

  it('[2] same fare from both providers → no conflict, fare kept', async () => {
    let res: any[] = [];
    const h = harness({
      'Amritsar to Delhi tomorrow': [{ calls: [S('railcore')] }, { content: 'Trains mil gayi.' }],
      '12497 3A fare dono par': (v) => v.step === 0 ? { calls: [SEL('12497', '3A')] }
        : v.step === 1 ? { calls: [{ name: 'railcore_fare', args: { trainNumber: '12497', travelClass: '3A' } }, { name: 'railradar_fare', args: { trainNumber: '12497', travelClass: '3A' } }] }
        : (res = resultsOf(v).filter(x => x.tool === 'GET_FARE'), { content: 'Dono par same fare.' })
    });
    await h.say('Amritsar to Delhi tomorrow');
    await h.say('12497 3A fare dono par');
    expect(res.some(x => x.sourceConflict)).toBe(false);
    expect(h.s().fare?.perPassenger).toBeTypeOf('number');
  });
});

describe('P39 G2 — LLM-chosen web fallback, WEB_ACCESS_BLOCKED, freshness', () => {
  it('[3] API live status fails → the LLM chooses ConfirmTkt → web envelope + priorApiFailures; nothing switched by the backend', async () => {
    providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt (web)', registryId: 'confirmtkt', capabilities: ['TRACK_TRAIN'] } as any);
    rc.faults.live_status = 'UNAVAILABLE';
    let first: any[] = [], second: any[] = [];
    const h = harness({
      '12014 abhi kahan hai': (v) => v.step === 0 ? { calls: [{ name: 'railcore_live_status', args: { trainNumber: '12014' } }] }
        : v.step === 1 ? (first = resultsOf(v), { calls: [{ name: 'confirmtkt_live_status', args: { trainNumber: '12014' } }] })
        : (second = resultsOf(v), { content: 'RailCore se status nahi mila. ConfirmTkt website ke according (unverified, 10:51 tak) train Ludhiana Jn par thi.' })
    });
    const r = await h.say('12014 abhi kahan hai');
    expect(first[0].ok).toBe(false);
    expect(first[0].providerStatus).not.toBe('SUCCESS');
    expect(rr.calls).toHaveLength(0);                      // no hidden failover to RailRadar
    const web = second.find(x => x.providerTool === 'confirmtkt_live_status' || x.name === 'confirmtkt_live_status');
    expect(web.ok).toBe(true);
    expect(web.verification).toBe('UNVERIFIED_WEB');
    expect(web.webResult).toMatchObject({ source: 'confirmtkt', status: 'SUCCESS', freshness: 'WEB_REPORTED_TIME' });
    expect(web.priorApiFailures).toEqual([{ provider: 'railcore', code: expect.any(String) }]);
    expect(webFetches).toEqual(['https://www.confirmtkt.com/train-running-status/12014']);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('[4] a robots-blocked web capability (confirmtkt_pnr) → WEB_ACCESS_BLOCKED, nothing fetched, no fake data', async () => {
    providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt (web)', registryId: 'confirmtkt', capabilities: ['TRACK_TRAIN'] } as any);
    let res: any[] = [];
    const h = harness({ 'ConfirmTkt par PNR 1234567890 check karo': (v) => v.step === 0 ? { calls: [{ name: 'confirmtkt_pnr', args: { pnr: '1234567890' } }] } : (res = resultsOf(v), { content: 'ConfirmTkt par PNR check automated tareeke se allowed nahi hai.' }) });
    const r = await h.say('ConfirmTkt par PNR 1234567890 check karo');
    expect(res[0].ok).toBe(false);
    expect(res[0].providerStatus).toBe('WEB_ACCESS_BLOCKED');
    expect(webFetches).toHaveLength(0);
    expect(rc.calls.length + rr.calls.length).toBe(0);
    expect(recs(r).every(x => x.status !== 'SUCCEEDED')).toBe(true);
  });

  it('[5] "abhi dobara" → a NEW provider call every time (no cache)', async () => {
    providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt (web)', registryId: 'confirmtkt', capabilities: ['TRACK_TRAIN'] } as any);
    const call = { calls: [{ name: 'confirmtkt_live_status', args: { trainNumber: '12014' } }] };
    const h = harness({ '12014 kahan hai': [call, { content: 'Ludhiana Jn.' }], 'abhi dobara 12014 check karo': [call, { content: 'Ludhiana Jn.' }] });
    await h.say('12014 kahan hai');
    await h.say('abhi dobara 12014 check karo');
    expect(webFetches).toHaveLength(2);
  });
});
