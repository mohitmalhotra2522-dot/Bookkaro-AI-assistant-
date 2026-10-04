/**
 * PROMPT 29 — G3: truthful action / progress claims through the FULL stack
 *   user → ConversationTurnEngine → orchestrator → LLM decides → validator → RailwayToolRuntime → mock railway spy
 *   → LLM answers → fact guards → entity binding → ACTION-CLAIM GUARD → text + TTS (same validated reply).
 * MockLLM (offline) and the native OpenAI-compatible adapter against an injected fake server (the "LLM" there
 * deliberately promises work it did not do). No network, credits, booking, handoff, real IRCTC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { MockBookingProvider } from '../../server/booking/testing/mock-booking-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p29-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string, string]> = []; failAvail = 0; gate: Promise<void> | null = null;
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? '')]); }
  async searchTrains(r: any): Promise<any> { this.b('search', r); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail', r);
    if (this.gate) await this.gate;
    if (this.failAvail > 0) { this.failAvail--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: pmeta() }; }
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.b('fare', r); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p29-spy', () => rail);

const KEY = 'sk-live-P29-E2E-SECRET-29292';
const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const outputs: string[] = [];
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => { const r: any = await eng.processTurn(sid, t, mode, o); outputs.push(JSON.stringify({ r, s: state.getSession(sid) })); return r; };
  return { eng, sid, say, s: () => state.getSession(sid) as any };
}
const mock = () => wire(new MockLLMProvider({}));
function native(plan: Record<string, any[]>) {
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  return wire(sel.provider);
}
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, ...(cls ? { classRaw: cls } : {}), selectionPurpose: 'INFORMATION' });
const CAV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const CFARE = (num: string, cls: string) => ({ name: 'GET_FARE', args: { trainNumber: num, travelClass: cls } });
const UPDATE_PARSO = U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' });
const START = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }] };
const actions = (r: any) => (r.turnLog.diagnostics.actionClaims || []) as any[];
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText, ...(r.voice?.segments || [])].map(x => String(x ?? ''));
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const flush = () => new Promise(r => setTimeout(r, 15));
const FALSE_AV_FARE = /(availability|fare)[^.?!]*(check|verify)[^.?!]*(kar raha|kar rahi|kar li|kar liye|ho gay|ho gai)/i;

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any, execSpies: any[] = [];
beforeEach(() => {
  railwayRegistry.setActive('p29-spy');
  Object.assign(rail, { n: {}, calls: [], failAvail: 0, gate: null });
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
  for (const out of outputs) {
    const o = JSON.parse(out);
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/"bookingState":"COMPLETE"/);
    // validation codes / internal ids never reach the user (text or speech)
    for (const t of shown(o.r)) expect(t).not.toMatch(/NO_CURRENT_TURN|NO_SUCCESSFUL|STALE_PREVIOUS|ACTION_CLAIM|TOOL_NOT_EXECUTED|toolCallId|call_\d|te_[0-9a-f]/);
  }
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P29 G3 — search and date change: describe only what ran', () => {
  it('[A] "Kal Amritsar se Delhi ki trains batao" → SEARCH_TRAINS only; trains may be described as searched / found, never availability / fare checked', async () => {
    const m = mock();
    const r = await m.say('Kal Amritsar se Delhi ki trains batao.');
    expect(r.turnLog.diagnostics.binding.toolSequence).toEqual(['SEARCH_TRAINS']);
    expect(delta({})).toEqual({ search: 1, avail: 0, fare: 0 });
    for (const t of shown(r)) expect(t).not.toMatch(FALSE_AV_FARE);
    // a native LLM that over-claims: the search claim stays, the availability / fare claim goes
    const h = native({ 'Kal Amritsar se Delhi ki trains batao.': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye trains search kar li hain. Availability aur fare bhi check kar liye.' }] });
    const q = await h.say('Kal Amritsar se Delhi ki trains batao.');
    expect(q.voice.assistantText).toMatch(/search kar li/);
    for (const t of shown(q)) expect(t).not.toMatch(FALSE_AV_FARE);
    expect(actions(q).some(a => a.actionType === 'SEARCH_TRAINS' && a.validationStatus === 'VALID')).toBe(true);
    expect(actions(q).some(a => a.validationStatus === 'REJECTED' && a.removalReason === 'NO_SUCCESSFUL_CURRENT_TURN_EXECUTION')).toBe(true);
  });

  it('[B] "Kal nahi parso" → fresh search for parso; availability / fare did not run → never "verify kar raha hoon" (agent text, carry-over note, voice)', async () => {
    const h = native({ ...START,
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { content: 'Parso ke liye fresh trains check kar li hain. Availability aur fare dobara verify kar raha hoon.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso', 'VOICE');
    expect(delta(n0)).toEqual({ search: 1, avail: 0, fare: 0 });
    expect(rail.calls.at(-1)).toEqual(['search', '', '', PARSO]);
    for (const t of shown(r)) expect(t).not.toMatch(/verify kar raha|check kar raha/i);
    expect(r.voice.assistantText).toMatch(/fresh trains check kar li/);
    // with a carried-over selection (MockLLM, booking purpose): the backend note is truthful too — and no auto check
    const m = mock();
    await m.say('Kal Amritsar se Delhi trains batao'); await m.say('12497 3A');
    const n1 = { ...rail.n };
    const c = await m.say('Kal nahi parso', 'VOICE');
    expect(delta(n1)).toEqual({ search: 1, avail: 0, fare: 0 });
    for (const t of shown(c)) expect(t).not.toMatch(/verify kar raha|check kar raha/i);
    expect(c.s?.date ?? m.s().date).toBe(PARSO);
  });

  it('[C] "Parso wali mein 3A availability aur fare bhi check karo" → the LLM calls both; the claims are valid because those calls executed (parso, 12497, 3A)', async () => {
    const h = native({ ...START,
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { content: 'Parso ki fresh trains mil gayi hain. Availability aur fare bhi check karun?' }],
      'Parso wali mein 3A availability aur fare bhi check karo.': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A'), CFARE('12497', '3A')] },
        { content: 'Parso 12497 ki 3A availability aur fare check kar liye. 3A mein seats available hain, fare ₹650 per passenger.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const b = await h.say('Kal nahi parso');
    expect(b.voice.assistantText).toMatch(/check karun\?/);                 // an offer is not a claim — kept
    const n0 = { ...rail.n };
    const r = await h.say('Parso wali mein 3A availability aur fare bhi check karo.');
    expect(delta(n0)).toMatchObject({ avail: 1, fare: 1 });
    expect(rail.calls.filter(c => c[0] === 'avail').at(-1)).toEqual(['avail', '12497', '3A', PARSO]);
    expect(r.voice.assistantText).toMatch(/check kar liye/);
    const valid = actions(r).filter(a => a.validationStatus === 'VALID' && a.actionStatus === 'SUCCEEDED');
    expect(valid.map(a => a.actionType)).toEqual(expect.arrayContaining(['CHECK_AVAILABILITY', 'GET_FARE']));
    expect(valid.every(a => !!a.toolCallId && a.date === PARSO)).toBe(true);
    expect(actions(r).filter(a => a.validationStatus === 'REJECTED')).toEqual([]);
  });

  it('[D] CHECK_AVAILABILITY fails → "availability check ho gayi" never shown or spoken; the failure may be said', async () => {
    rail.failAvail = 2;
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'availability batao': [{ calls: [CAV('12497', '3A')] }, { content: 'Availability check ho gayi. Abhi availability check nahi ho paayi, thodi der mein dobara try karein.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const r = await h.say('availability batao', 'VOICE');
    for (const t of shown(r)) expect(t).not.toMatch(/check ho gayi/i);
    expect(r.voice.speechText).toMatch(/nahi ho paayi/);
    expect(actions(r).some(a => a.actionStatus === 'FAILED' && a.removalReason === 'TOOL_FAILED')).toBe(true);
  });
});

describe('P29 G3 — stale progress, entities, general knowledge', () => {
  it('[E] voice interruption: the old turn\'s action statement is discarded (progress stale, no further progress, not resumed)', async () => {
    const h = native({ ...START, '12014 CC': [{ calls: [SEL('12014', 'CC')] }, { content: '12014 CC theek hai.' }],
      '12014 ki availability batao': [{ content: 'Ek second, 12014 ki CC availability check karta hoon.', calls: [CAV('12014', 'CC')] }, { content: '12014 ki CC availability check kar raha hoon.' }],
      '12497 wali dekho': [{ calls: [SEL('12497')] }, { content: '12497 Shan-e-Punjab Express theek hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12014 CC');
    let release!: () => void; rail.gate = new Promise<void>(r => { release = r; });
    const p1 = h.say('12014 ki availability batao', 'VOICE');
    await flush();
    const t1 = h.eng.getTurns(h.sid).slice(-1)[0];
    const before = h.eng.events.forTurn(h.sid, t1.turnId).filter((e: any) => e.type === 'TOOL_PROGRESS').length;
    const p2 = h.say('12497 wali dekho', 'VOICE', { interruptPrevious: true });
    await flush();
    rail.gate = null; release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.progress.every((p: any) => p.stale === true)).toBe(true);
    expect(h.eng.events.forTurn(h.sid, t1.turnId).filter((e: any) => e.type === 'TOOL_PROGRESS').length).toBe(before);
    if (r1.presentable) for (const t of shown(r1)) expect(t).not.toMatch(/check kar raha|check karta/i);
    expect(r2.presentable).toBe(true);
    expect(r2.voice.responsePriority).toBe('INTERRUPT');
    for (const t of shown(r2)) expect(t).not.toMatch(/12014[^.]*check kar raha/i);
  });

  it('[F] date correction: the previous date\'s action statements are discarded in the new turn', async () => {
    const h = native({ ...START,
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { content: 'Ek second, 12497 ki 3A availability check karta hoon.', calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
      // the LLM re-selects in-loop (its own choice), so its final text is what the user gets — and is judged
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { calls: [SEL('12497', '3A')] },
        { content: 'Parso ki trains mil gayi hain. 12497 ki 3A availability check kar raha hoon. Kal ki availability check ho gayi thi.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say('12497 3A availability', 'VOICE');
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso', 'VOICE');
    expect(delta(n0)).toEqual({ search: 1, avail: 0, fare: 0 });
    for (const t of shown(r)) { expect(t).not.toMatch(/availability check kar raha/i); expect(t).not.toMatch(/check ho gayi/i); }
    expect(r.voice.assistantText).toMatch(/Parso ki trains mil gayi hain/);
    expect(actions(r).filter(a => a.validationStatus === 'REJECTED').map(a => a.removalReason)).toEqual(expect.arrayContaining(['STALE_PREVIOUS_TURN_ACTION']));
  });

  it('[G] cross-train: an action statement must match the train actually checked', async () => {
    const h = native({ ...START,
      '12014 CC availability': [{ calls: [SEL('12014', 'CC')] }, { calls: [CAV('12014', 'CC')] }, { content: '12497 ki availability check kar li. 12014 ki CC availability check kar li.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('12014 CC availability');
    expect(r.voice.assistantText).not.toMatch(/12497 ki availability check kar li/);
    expect(r.voice.assistantText).toMatch(/12014 ki CC availability check kar li/);
    expect(actions(r).some(a => a.removalReason === 'ACTION_TRAIN_MISMATCH' && a.entity?.trainNumber === '12497')).toBe(true);
  });

  it('[H] "RAC kya hota hai?" → the explanation is never touched by action validation (MockLLM and an agent answer using "check" words)', async () => {
    const m = mock();
    const r = await m.say('RAC kya hota hai?');
    expect(r.turnLog.diagnostics.binding.toolCallCount).toBe(0);
    expect(actions(r).filter(a => a.validationStatus === 'REJECTED')).toEqual([]);
    expect(r.voice.assistantText).toMatch(/RAC/);
    const GK = 'RAC mein ek berth do passengers share karte hain. Train mein TTE ticket check karta hai, aur cancellation hone par RAC confirm ho sakta hai. Aap PNR status IRCTC par check kar sakte hain.';
    const h = native({ 'RAC kya hota hai?': [{ content: GK }] });
    const q = await h.say('RAC kya hota hai?');
    expect(q.turnLog.diagnostics.binding.toolCallCount).toBe(0);
    expect(q.turnLog.naturalSpeech.rejected).toEqual([]);
    expect(q.voice.assistantText).toMatch(/TTE ticket check karta hai/);
    expect(q.voice.assistantText).toMatch(/PNR status IRCTC par check kar sakte hain/);
  });
});
