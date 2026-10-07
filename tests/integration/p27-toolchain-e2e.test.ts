/**
 * PROMPT 27 — G3: autonomous multi-step tool chains through the FULL agent stack
 *   user → ConversationTurnEngine → orchestrator → LLM decides → validator → RailwayToolRuntime → (labelled, non-live)
 *   mock railway spy → result back to the LLM → next decision … → grounded final answer.
 * MockLLM (offline) for A–M, O–T; the native OpenAI-compatible adapter against an injected fake server for N
 * (structured chain stop: tool_choice 'none' + CHAIN_STOP). No network, no credits, no booking, no handoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import type { MockChainScenarioId } from '../../server/ai/providers/mock-llm-chains';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { FORBIDDEN_SUCCESS_CLAIMS } from '../../server/ai/turn-engine/mock-conversation-scenarios';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { MockBookingProvider } from '../../server/booking/testing/mock-booking-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

const meta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p27-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string]> = []; failAvail = 0;
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? r?.date ?? '')]); }
  async searchTrains(r: any): Promise<any> { this.b('search', { trainNumber: '', date: r?.date }); return super.searchTrains(r); }
  async getTrainInfo(r: any): Promise<any> { this.b('info', r); return super.getTrainInfo(r); }
  async getTimetable(r: any): Promise<any> { this.b('tt', r); return super.getTimetable(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail', r);
    if (this.failAvail > 0) { this.failAvail--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: meta() }; }
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.b('fare', r); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p27-spy', () => rail);

class SpyLLM extends MockLLMProvider {
  override: null | ((input: any, d: any) => any) = null;
  async generateStructuredDecision(input: any): Promise<any> {
    const r: any = await super.generateStructuredDecision(input);
    if (this.override) r.decision = this.override(input, r.decision) ?? r.decision;
    return r;
  }
}
const KEY = 'sk-live-P27-E2E-SECRET-77777';
const outputs: string[] = [];
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => { const r: any = await eng.processTurn(sid, t, mode); outputs.push(JSON.stringify({ r, s: state.getSession(sid) })); return r; };
  return { state, sid, say, s: () => state.getSession(sid) as any, run: async (ts: string[], mode: 'TEXT' | 'VOICE' = 'TEXT') => { let r: any; for (const t of ts) r = await say(t, mode); return r; } };
}
const mk = (forced?: MockChainScenarioId) => { const llm = new SpyLLM({ chainScenario: forced }); return { llm, ...wire(llm) }; };
const chain = (r: any) => r.turnLog.diagnostics.chain;
const text = (r: any) => String(r.voice?.assistantText ?? '');
const both = (r: any) => `${text(r)}\n${r.responseMessage ?? ''}`;
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'info', 'tt', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');
const SEARCH_T = 'Kal Amritsar se Delhi trains batao';
const nextDay = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any, execSpies: any[] = [];
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p27-spy');
  Object.assign(rail, { n: {}, calls: [], failAvail: 0 });
  outputs.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
  execSpies = [vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking'), vi.spyOn(MockBookingProvider.prototype, 'executeBooking')];
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  for (const s of execSpies) expect(s).not.toHaveBeenCalled();
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  for (const out of outputs) {
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/"bookingState":"COMPLETE"/);
    expect(out).not.toMatch(/"sourceResultId"/);
  }
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P27 G3 — the LLM chains tools from one utterance', () => {
  it('[A] search → availability: one search, one availability check for the train the user named; no fare call; no booking prep', async () => {
    const h = mk(); const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    expect(delta({})).toEqual({ search: 1, info: 0, tt: 0, avail: 1, fare: 0 });
    expect(rail.calls.find(c => c[0] === 'avail')).toEqual(['avail', '12497', '3A']);
    expect(text(r)).toMatch(/12497/); expect(text(r)).toMatch(/3A/); expect(text(r)).toMatch(/available/i);
    expect(chain(r)).toMatchObject({ llmCallCount: 3, providerCallCount: 2, chainStopReason: 'FINAL_RESPONSE' });
    expect(h.s()).toMatchObject({ bookingState: 'CLASS_SELECTED', selectionPurpose: 'INFORMATION' });
    expect(text(r)).not.toMatch(/passengers?/i);
  });

  it('[B] search → fare: fare comes from GET_FARE only (₹650), no availability call', async () => {
    const h = mk(); const r = await h.say('Kal Amritsar se Delhi 12497 ka 3A fare batao');
    expect(delta({})).toEqual({ search: 1, info: 0, tt: 0, avail: 0, fare: 1 });
    expect(text(r)).toMatch(/₹650/);
    expect(text(r)).not.toMatch(/available|waitlist|RAC/i);
  });

  it('[C] search → availability → fare: both after selection, in ONE parallel group; both facts in the reply', async () => {
    const h = mk(); const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao');
    expect(delta({})).toEqual({ search: 1, info: 0, tt: 0, avail: 1, fare: 1 });
    const st = chain(r).steps;
    expect(st.map((x: any) => x.toolName)).toEqual(['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE']);
    expect(st[0].parallelGroup).toBeNull();
    expect(st[1].parallelGroup).not.toBeNull(); expect(st[1].parallelGroup).toBe(st[2].parallelGroup);
    expect(text(r)).toMatch(/available/i); expect(text(r)).toMatch(/₹650/);
  });

  it('[D] Example 1 — compare over returned times: 12014 arrives first but has no 3A → 12497 checked; nothing called for 12014', async () => {
    const h = mk(); const r = await h.say('Kal Amritsar se Delhi ki sabse jaldi pahunchne wali train ki 3A availability aur fare batao.');
    expect(delta({})).toMatchObject({ search: 1, avail: 1, fare: 1 });
    expect(rail.calls.filter(c => c[0] !== 'search').every(c => c[1] === '12497' && c[2] === '3A')).toBe(true);
    expect(text(r)).toMatch(/12014/); expect(text(r)).toMatch(/3A listed nahi/);
    expect(text(r)).toMatch(/12497/); expect(text(r)).toMatch(/₹650/);
    expect(h.s().selectedTrain.number).toBe('12497');
  });

  it('[E] "Beech wali ki 3A availability?" → "Fare bhi." continues without clarification; middle train without the class → no fare call', async () => {
    const h = mk(); await h.say(SEARCH_T);
    const a = await h.say('Beech wali ki 3A availability?');
    expect(rail.calls.filter(c => c[0] === 'avail')).toEqual([['avail', '12497', '3A']]);
    expect(text(a)).toMatch(/available/i);
    const n0 = { ...rail.n };
    const f = await h.say('Fare bhi.');
    expect(delta(n0)).toMatchObject({ search: 0, avail: 0, fare: 1 });
    expect(text(f)).toMatch(/₹650/);
    expect(f.assistantTurnResponse.type).not.toBe('CLARIFICATION');
    const h2 = mk(); await h2.say(SEARCH_T); const n1 = { ...rail.n };
    const x = await h2.say('Beech wali ki 2A availability aur fare batao');
    expect(delta(n1)).toMatchObject({ avail: 0, fare: 0 });
    expect(text(x)).toMatch(/2A/);
    expect(text(x)).not.toMatch(/₹/);
  });

  it('[F] "subah wali jo sabse pehle pahunchti hai … CC" → 12014; plain "subah wali" (two morning trains) → one clarification, no check', async () => {
    const h = mk(); await h.say(SEARCH_T); const n0 = { ...rail.n };
    const r = await h.say('Subah wali train jo sabse pehle Delhi pahunchti hai uski CC check karo');
    expect(delta(n0)).toMatchObject({ avail: 1 });
    expect(rail.calls.at(-1)).toEqual(['avail', '12014', 'CC']);
    expect(h.s().selectedTrain.number).toBe('12014');
    const h2 = mk(); await h2.say(SEARCH_T); const n1 = { ...rail.n };
    const c = await h2.say('Subah wali ki CC availability');
    expect(delta(n1)).toMatchObject({ avail: 0, fare: 0 });
    expect(text(c)).toMatch(/12014/); expect(text(c)).toMatch(/12497/); expect(text(c)).toMatch(/\?/);
    expect(h2.s().selectedTrain ?? null).toBeNull();
  });

  it('[G] "Kal nahi parso … phir se check" → fresh search for the new date, train re-derived from the NEW list, availability + fare re-checked', async () => {
    const h = mk(); await h.say(SEARCH_T); await h.say('Beech wali ki 3A availability aur fare check karo');
    const d0 = h.s().date; const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso, aur jo train pehle choose ki thi uski 3A availability aur fare phir se check karo');
    expect(h.s().date).toBe(nextDay(d0));
    expect(delta(n0)).toMatchObject({ search: 1, avail: 1, fare: 1 });
    expect(rail.calls.find((c, i) => i >= rail.calls.length - 3 && c[0] === 'search')?.[2]).toBe(nextDay(d0));
    const st = chain(r).steps.map((x: any) => x.toolName);
    expect(st.indexOf('SEARCH_TRAINS')).toBeLessThan(st.indexOf('CHECK_AVAILABILITY'));
    expect(h.s()).toMatchObject({ selectedTrain: { number: '12497' }, selectedClass: '3A' });
    expect(text(r)).toMatch(/parso/i); expect(text(r)).toMatch(/₹650/);
  });

  it('[H] "dobara check karo" in a NEW turn always reaches the provider (no cross-turn cache)', async () => {
    const h = mk(); await h.say(SEARCH_T); await h.say('Beech wali ki 3A availability?');
    const n0 = { ...rail.n };
    const a = await h.say('Dobara check karo availability');
    const b = await h.say('Dobara check karo availability');
    expect(delta(n0).avail).toBe(2);
    expect(chain(a).steps[0].toolResultId).not.toBe(chain(b).steps[0].toolResultId);
  });

  it('[I] an identical call inside the SAME chain is reused, not re-sent', async () => {
    const h = mk('REPEATED_IDENTICAL_CALL'); const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    expect(delta({}).avail).toBe(1);
    expect(chain(r).redundantCallCount).toBe(1);
    expect(text(r)).toMatch(/available/i);
  });
});

describe('P27 G3 — general knowledge, mixed, corrections, failures, limits', () => {
  it('[J] RAC / Tatkal / Shatabdi vs Vande Bharat → zero tools, real answers; off-topic → no tool, no fake railway fact', async () => {
    const h = mk();
    for (const q of ['RAC kya hota hai?', 'Tatkal kya hota hai?', 'Shatabdi aur Vande Bharat mein difference kya hai?']) {
      const r = await h.say(q);
      expect(chain(r).toolCallCount, q).toBe(0);
      expect(text(r).length, q).toBeGreaterThan(30);
    }
    const w = await h.say('Delhi ka weather kaisa hai?');
    expect(chain(w).toolCallCount).toBe(0);
    expect(delta({})).toEqual({ search: 0, info: 0, tt: 0, avail: 0, fare: 0 });
    expect(text(w)).not.toMatch(/\d{2}:\d{2}|₹/);
  });

  it('[K] mixed general + railway → both parts answered: the explanation AND a real search', async () => {
    const h = mk(); const r = await h.say('Shatabdi aur Vande Bharat mein difference kya hai aur kal Amritsar se Delhi trains dikhao');
    expect(delta({}).search).toBe(1);
    expect(text(r)).toMatch(/Vande Bharat/); expect(text(r)).toMatch(/3 trainein/);
    expect(r.responseMessage).toMatch(/12014/);
  });

  it('[L] invalid tool argument → typed rejection → the LLM corrects it → valid call succeeds (the malformed call never reaches the provider)', async () => {
    const h = mk('INVALID_ARGUMENT_CORRECTION'); await h.say(SEARCH_T); const n0 = { ...rail.n };
    const r = await h.say('12497 ki 3A availability batao');
    expect(chain(r).steps.map((x: any) => x.decisionReason)).toEqual(['REJECTED:INVALID_ARGUMENT', 'LLM_TOOL_CALL']);
    expect(delta(n0).avail).toBe(1);
    expect(rail.calls.at(-1)).toEqual(['avail', '12497', '3A']);
    expect(text(r)).toMatch(/available/i);
  });

  it('[M] transient failure → ONE retry then success; persistent failure → at most 2 attempts and an honest "not verified" (never a status)', async () => {
    const h = mk(); rail.failAvail = 1;
    const ok = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    expect(rail.n.avail).toBe(2);
    expect(chain(ok).retryCount).toBe(1);
    expect(text(ok)).toMatch(/available/i);
    const h2 = mk(); rail.n = {}; rail.failAvail = 99;
    const bad = await h2.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    expect(rail.n.avail).toBe(2);
    expect(both(bad)).toMatch(/verify nahi/);
    expect(both(bad)).not.toMatch(/\b(RAC \d|WL \d|Waitlist \d|seats available)/i);
    rail.failAvail = 0;
  });

  it('[N] native adapter: an LLM that never stops → 8 executions, then ONE tools-disabled call (tool_choice none + CHAIN_STOP) answers from results', async () => {
    const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: 'kal' } };
    const nums = ['12014', '12497', '18238'];
    let iso = '';                                                                   // the session's resolved journey date
    const waves = () => [nums.map(n => ({ name: 'GET_TRAIN_INFO', args: { trainNumber: n } })), nums.map(n => ({ name: 'GET_TIMETABLE', args: { trainNumber: n } })),
      nums.map(n => ({ name: 'GET_TRAIN_INFO', args: { trainNumber: n, date: iso } })), nums.map(n => ({ name: 'GET_TIMETABLE', args: { trainNumber: n, date: iso } }))];
    const fake = new FakeOpenAI((v: TurnView, body: any) => {
      if (v.user === 'Kal Amritsar se Delhi jaana hai') return v.step === 0 ? { calls: [SEARCH] } : { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' };
      if (body.tool_choice === 'none') return { content: '12014 Amritsar Shatabdi Express ASR se 04:55 par nikalti hai. Baaki details ek saath poori nahi ho paayi.' };
      const w = waves(); return { calls: w[Math.min(v.step, w.length - 1)] };
    });
    const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
    const h = wire(sel.provider);
    await h.say('Kal Amritsar se Delhi jaana hai');
    iso = h.s().date;
    const n0 = { ...rail.n };
    const r = await h.say('Sab trains ki poori details batao');
    const d = delta(n0);
    expect(d.info + d.tt).toBe(8);
    const c = chain(r);
    expect(c).toMatchObject({ chainStopReason: 'TOOL_BUDGET_EXHAUSTED', providerCallCount: 8, answeredAfterStop: true });
    const stopReqs = fake.decisionRequests.filter(q => q.body.tool_choice === 'none');
    expect(stopReqs).toHaveLength(1);
    expect(stopReqs[0].body.messages.some((m: any) => m.role === 'system' && /^CHAIN_STOP .*TOOL_BUDGET_EXHAUSTED/.test(String(m.content)))).toBe(true);
    expect(fake.decisionRequests.at(-1)!.body.tool_choice).toBe('none');      // nothing was requested after the stop
    expect(both(r)).toMatch(/04:55/);
    expect(JSON.stringify(fake.requests.map(q => q.body))).not.toContain(KEY);
  });

  it('[N2] native: a stale list is rejected with the ACTIONABLE reason, not a misleading "repeated call" block; after the fresh search the same train is checked directly (post-P42.10 F3: no select-first)', async () => {
    const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
    const SEARCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
    const AV = { name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: '3A' } };
    const plan: Record<string, any[]> = {
      'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }],
      '12497 3A': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: '3A', selectionPurpose: 'INFORMATION' })] }, { calls: [AV] }, { content: '12497 mein 3A available hai.' }],
      'Kal nahi parso, usi train ki availability dobara check karo.': [
        { calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' })] },
        { calls: [AV] },                         // stale list → rejected on the OLD state
        { calls: [SEARCH('parso')] },            // fresh search for the new date
        { calls: [AV] },                         // same arguments on the NEW result list → re-validated there, executes (no selection needed)
        { content: 'Parso ke liye 12497 mein 3A available hai.' }]
    };
    const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
    const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
    const h = wire(sel.provider);
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const d0 = h.s().date; const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso, usi train ki availability dobara check karo.');
    const reasons = chain(r).steps.map((x: any) => `${x.toolName}:${x.decisionReason}`);
    expect(reasons).not.toContain('CHECK_AVAILABILITY:REJECTED:INVALID_REPEATED_CALL');
    expect(reasons).toEqual(['CHECK_AVAILABILITY:REJECTED:INVALID_ACTION_FOR_STATE', 'SEARCH_TRAINS:LLM_TOOL_CALL', 'CHECK_AVAILABILITY:LLM_TOOL_CALL']);
    expect(delta(n0)).toMatchObject({ search: 1, avail: 1 });
    expect(h.s().date).toBe(nextDay(d0));
    expect(rail.calls.at(-1)).toEqual(['avail', '12497', '3A']);
  });

  it('[O] booking / payment from the LLM is blocked (no execution, no payment, no PNR, no success claim)', async () => {
    const h = mk('FORBIDDEN_TOOL_ATTEMPT'); await h.say(SEARCH_T);
    const r = await h.say('Pehli wali book karke payment bhi kar do');
    expect(chain(r).steps.map((x: any) => [x.toolName, x.decisionReason])).toEqual([['BOOK_TICKET', 'REJECTED:FORBIDDEN_ACTION'], ['MAKE_PAYMENT', 'REJECTED:FORBIDDEN_ACTION']]);
    expect(both(r)).not.toMatch(BOOK_CLAIM);
    expect(both(r)).not.toMatch(/\bPNR\b.*\d{10}/);
    expect(h.s().bookingState).toBe('SHOWING_TRAINS');
  });

  it('[P] confirmation cannot be invented: an LLM CONFIRM / handoff decision on a non-confirming utterance changes nothing', async () => {
    const h = mk();
    await h.run(['Amritsar se Delhi kal', '12014 wali kar do', 'CC', '2 passengers. Mohit 31 male, Ravi 28 male.']);
    expect(h.s().bookingState).toBe('AWAITING_CONFIRMATION');
    h.llm.override = (_i, d) => ({ ...d, intent: 'CONFIRM_BOOKING', action: 'PREPARE_IRCTC_HANDOFF', toolCalls: [], finalMessage: 'Booking confirm ho gayi!' });
    const r = await h.say('12014 ka departure time kya hai?');
    h.llm.override = null;
    expect(h.s().bookingState).toBe('AWAITING_CONFIRMATION');
    expect(h.s().pendingInteraction?.type).toBe('CONFIRMATION_REQUIRED');
    expect(both(r)).not.toMatch(/confirm ho gayi/i);
    expect(both(r)).not.toMatch(BOOK_CLAIM);
  });

  it('[Q] P25/P26 guards still apply inside chains: a wrong availability / fare / time in the LLM final never reaches the user', async () => {
    const h = mk();
    h.llm.override = (i, d) => ((i.currentTurnToolResults || []).some((x: any) => x.toolName === 'GET_FARE' && x.ok) && !(d.toolCalls || []).length
      ? { ...d, finalMessage: '12497 mein 3A mein WL 3 hai, fare ₹999 hai aur train 05:10 par nikalti hai.' } : d);
    const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao');
    h.llm.override = null;
    expect(both(r)).not.toMatch(/WL 3|₹999|05:10/);
    expect(r.responseMessage).toMatch(/₹650/);                                       // verified tool facts are kept
  });

  it('[R][S] language follows the user: English chain → English answer; Hinglish chain → Hinglish answer', async () => {
    const en = mk();
    const e = await en.say('Tomorrow Amritsar to Delhi, 12497 3A availability and fare please');
    expect(delta({})).toMatchObject({ search: 1, avail: 1, fare: 1 });
    expect(text(e)).toMatch(/availability: Available\./); expect(text(e)).toMatch(/fare on 12497 is ₹650 per passenger/);
    expect(text(e)).not.toMatch(/\b(hai|kaunsi|chahiye)\b/);
    await en.say(SEARCH_T);
    const e2 = await en.say('Which of these trains reaches Delhi earliest?');
    expect(text(e2)).toMatch(/^12014 reaches .*earliest/); expect(text(e2)).not.toMatch(/kaunsi|karni hai/);
    const hi = mk(); const s = await hi.say('Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao');
    expect(text(s)).toMatch(/\bhai\b/);
  });

  it('[T] voice / text parity: the same chain from VOICE and TEXT → same tools, same provider calls, same state', async () => {
    const U = 'Kal Amritsar se Delhi ki sabse jaldi pahunchne wali train ki 3A availability aur fare batao.';
    const t = mk(); const rt = await t.say(U, 'TEXT'); const nT = { ...rail.n };
    rail.n = {};
    const v = mk(); const rv = await v.say(U, 'VOICE'); const nV = { ...rail.n };
    expect(nV).toEqual(nT);
    expect(chain(rv).steps.map((x: any) => x.toolName)).toEqual(chain(rt).steps.map((x: any) => x.toolName));
    const pick = (s: any) => ({ st: s.bookingState, tr: s.selectedTrain?.number, c: s.selectedClass, d: s.date, p: s.selectionPurpose });
    expect(pick(v.s())).toEqual(pick(t.s()));
    expect(text(rv)).toMatch(/12497/); expect(text(rv)).toMatch(/₹650/);
  });
});
