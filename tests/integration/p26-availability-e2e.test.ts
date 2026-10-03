/**
 * PROMPT 26 — G3: strict seat-availability authority through the FULL agent stack (native OpenAI-compatible tool
 * calling against a fake server → RailwayToolRuntime → MockRailwayProvider → NaturalResponseComposer).
 * Mock railway data: 12014 CC "Available", 12497 CC "RAC 4", 12497 SL "Waitlist 12". Search rows also carry a per-class
 * `avail` field — which must NEVER count as availability. No network, no credits, no booking, no handoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { FakeOpenAI, type FakeReply, type TurnView } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P26-E2E-SECRET-88888';
const ENV = { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {};
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.b('search'); return super.searchTrains(r); }
  async getTrainInfo(r: any): Promise<any> { this.b('info'); return super.getTrainInfo(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p26-spy', () => rail);

type Step = FakeReply | ((v: TurnView) => FakeReply);
type Plan = Record<string, Step[]>;
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: 'kal' } };
const INFO = (n: any) => ({ calls: [{ name: 'GET_TRAIN_INFO', args: { trainNumber: n } }] });
const FARE_TURN: Step[] = [
  { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' } })] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A' })] },
  { calls: [{ name: 'GET_FARE', args: { trainNumber: 12497 } }] },                                // numeric id → lossless normalization, no bounce
  v => ({ content: `12497 Shan-e-Punjab 3A ka fare ₹${v.results.at(-1)!.content.data.perPassenger} per passenger hai. Yeh 1 passenger ke liye hai.` })
];
const BASE: Plan = {
  'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH] }, v => ({ content: `Kal ke liye ${v.results[0].content.data.trains.length} trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. Kaunsi chahiye?` })],
  '12014 wali CC mein': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' } })] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { content: '12014 mein CC le liya. Kitne log travel karenge?' }],
  '2 passengers. Mohit 31 male, Ravi 28 male.': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { passengersCountRaw: '2', passengerChanges: [{ passengerIndex: 1, changes: { name: 'Mohit', age: 31, gender: 'male' } }, { passengerIndex: 2, changes: { name: 'Ravi', age: 28, gender: 'male' } }] })] }, { content: 'Dono passengers add ho gaye.' }],
  '12497 3A ka fare batao': FARE_TURN
};
const SEARCH_T = 'Kal Amritsar se Delhi jaana hai';

const outputs: string[] = [];
function mk(plan: Plan = {}) {
  const all: Plan = { ...BASE, ...plan };
  const fake = new FakeOpenAI(v => {
    const p = all[v.user];
    if (Array.isArray(p) && v.step < p.length) { const s = p[v.step]; return typeof s === 'function' ? s(v) : s; }
    return { content: 'Theek hai, aur kya madad karun?' };
  });
  const sel = createLLMProvider(ENV, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => {
    const d0 = fake.decisionRequests.length, w0 = fake.wordingRequests.length;
    const r: any = await eng.processTurn(sid, t, mode);
    r.__decisions = fake.decisionRequests.length - d0; r.__wording = fake.wordingRequests.length - w0;
    outputs.push(JSON.stringify({ r, s: state.getSession(sid) }));
    return r;
  };
  const run = async (ts: string[], mode: 'TEXT' | 'VOICE' = 'TEXT') => { let r: any; for (const t of ts) r = await say(t, mode); return r; };
  return { fake, say, run, s: () => state.getSession(sid) as any };
}
const execs = (r: any) => r.turnLog.toolExecutions.map((e: any) => [e.tool, e.status, e.rejectionReason ?? null]);
const text = (r: any) => String(r.voice?.assistantText ?? r.assistantText ?? '');
const ORPHAN = /(^|\s)\d{1,2}[.)](\s|$)|(^|\s)[-*•](\s|$)/;

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any, execSpies: any[] = [];
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p26-spy');
  rail.n = {};
  outputs.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
  execSpies = [vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking'), vi.spyOn(MockBookingProvider.prototype, 'executeBooking')];
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();                                  // the fake LLM is an injected fetch: zero network
  expect(handoffSpy).not.toHaveBeenCalled();
  for (const s of execSpies) expect(s).not.toHaveBeenCalled();              // no booking provider is ever executed
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  for (const out of outputs) {
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/"bookingState":"COMPLETE"/);
    expect(out).not.toMatch(/"sourceResultId"/);                            // provenance ids are internal, never in the turn result
  }
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore();
  railwayRegistry.setActive('mock');
});


const AV = { name: 'CHECK_AVAILABILITY', args: {} };                 // the backend fills the selected train / class / date
const SEL = (n: string, c: string, say: string): Step[] => [
  { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: n } })] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: c })] }, { content: say }];
const status = (v: TurnView) => String(v.results.find(r => r.name === 'CHECK_AVAILABILITY')?.content?.data?.status ?? 'MISSING');
const reasons = (r: any) => r.turnLog.naturalSpeech.rejected;

describe('P26 G3 — general knowledge and class lists are not availability', () => {
  it('[1] RAC explanation + Shatabdi vs Vande Bharat: no tool, nothing removed, never a live-fact claim (trains on screen)', async () => {
    const h = mk({
      'RAC kya hota hai?': [{ content: 'RAC ka matlab hai Reservation Against Cancellation. RAC mein cancellation hone par seat confirm ho sakti hai. RAC passengers berth share kar sakte hain.' }],
      'Shatabdi aur Vande Bharat mein kya difference hai?': [{ content: 'Shatabdi din ki chair car train hai, jabki Vande Bharat semi high-speed train hai jisme CC aur EC classes hoti hain.' }]
    });
    await h.say(SEARCH_T);
    for (const q of ['RAC kya hota hai?', 'Shatabdi aur Vande Bharat mein kya difference hai?']) {
      const r = await h.say(q);
      expect(execs(r), q).toEqual([]);
      expect(reasons(r), q).toEqual([]);
      expect(r.turnLog.diagnostics.validation.claimTypes.RAILWAY_LIVE_FACT, q).toBeUndefined();
    }
    expect(rail.n.avail).toBeUndefined();
  });

  it('[2] class list: "CC aur 2S available" after a search becomes "classes listed"; no availability tool, no availability state', async () => {
    const h = mk({ 'Kal Amritsar se Delhi ki trains dikhao': [{ calls: [SEARCH] }, { content: 'Kal ke liye 3 trainein mili hain. 12014 Amritsar Shatabdi mein CC aur 2S available hain. 12497 Shan-e-Punjab mein 3A, CC, SL aur 2S classes listed hain.' }] });
    const r = await h.say('Kal Amritsar se Delhi ki trains dikhao');
    expect(execs(r)).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
    expect(reasons(r)).toEqual([]);
    expect(text(r)).toContain('12014 Amritsar Shatabdi mein CC aur 2S classes listed hain.');
    expect(text(r)).toContain('12497 Shan-e-Punjab mein 3A, CC, SL aur 2S classes listed hain.');
    expect(text(r)).not.toMatch(/available/i);
    expect(r.turnLog.naturalSpeech.repaired).toBe(1);
    expect(rail.n.avail).toBeUndefined();
    expect(h.s().availability || {}).toEqual({});
  });
});

describe('P26 G3 — unsupported availability is removed; no cross-tool leakage', () => {
  it('[3] SEARCH_TRAINS rows (with their "avail" field) prove nothing: availability sentences go, the arrival fact stays — text and voice alike', async () => {
    const plan = { 'Inme availability kaisi hai?': [{ content: '12014 mein CC available hai. 12497 CC mein RAC 4 hai. 12014 10:50 par pahunchti hai.' }] };
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const h = mk(plan);
      await h.say(SEARCH_T, mode);
      expect(JSON.stringify(h.s().searchResults)).toMatch(/RAC 4/);         // the search result DID carry an avail field
      const r = await h.say('Inme availability kaisi hai?', mode);
      expect(execs(r), mode).toEqual([]);
      expect(reasons(r), mode).toEqual(['UNVERIFIED_AVAILABILITY', 'UNVERIFIED_AVAILABILITY']);
      expect(text(r), mode).toMatch(/^12014 10:50 par pahunchti hai\./);
      expect(text(r), mode).not.toMatch(/available hai|RAC 4/);
    }
    expect(rail.n.avail).toBeUndefined();
  });

  it('[3b] GET_TRAIN_INFO + GET_FARE results do not prove seats: the fare sentence stays, the seat sentence goes', async () => {
    const h = mk({
      '12014 ki info aur CC fare batao': [{ calls: [{ name: 'GET_TRAIN_INFO', args: { trainNumber: '12014' } }, { name: 'GET_FARE', args: {} }] },
        v => ({ content: `12014 CC ka fare ₹${v.results.find(r => r.name === 'GET_FARE')?.content?.data?.perPassenger} hai. CC mein seats available hain.` })]
    });
    await h.run([SEARCH_T, '12014 wali CC mein']);
    const r = await h.say('12014 ki info aur CC fare batao');
    expect(execs(r)).toEqual([['GET_TRAIN_INFO', 'SUCCEEDED', null], ['GET_FARE', 'SUCCEEDED', null]]);
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(text(r)).toMatch(/^12014 CC ka fare ₹520 hai\./);
    expect(text(r)).not.toMatch(/seats available/);
    expect(rail.n.avail).toBeUndefined();
  });

  it('[4] user-provided availability is not authority: an echo is removed, an attributed acknowledgement stays (USER_PROVIDED)', async () => {
    const h = mk({
      '12014 mein CC available hai na?': [{ content: 'Haan, 12014 mein CC available hai.' }],
      'Mujhe pata hai CC available hai, aage badho': [{ content: 'Aapne bataya CC available hai — ise abhi railway data se verify nahi kiya gaya. Kya main 12014 CC ki availability check karun?' }]
    });
    await h.say(SEARCH_T);
    const echo = await h.say('12014 mein CC available hai na?');
    expect(reasons(echo)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(text(echo)).not.toMatch(/CC available hai/);
    const ack = await h.say('Mujhe pata hai CC available hai, aage badho');
    expect(reasons(ack)).toEqual([]);
    expect(text(ack)).toMatch(/^Aapne bataya CC available hai/);
    expect(ack.turnLog.diagnostics.validation.claimTypes).toMatchObject({ USER_PROVIDED: 1 });
    expect(h.s().availability || {}).toEqual({});                            // never promoted into railway facts
    expect(rail.n.avail).toBeUndefined();
  });

  it('[5] cleanup: a removed numbered availability item leaves no "1." / "2." / fragments', async () => {
    const h = mk({ 'Pehli train ka kya scene hai?': [{ content: '1. 12014 mein CC available hai.\n2. 12014 10:50 par pahunchti hai.\n- ' }] });
    await h.say(SEARCH_T);
    const r = await h.say('Pehli train ka kya scene hai?');
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(text(r)).toMatch(/^12014 10:50 par pahunchti hai\./);
    expect(text(r)).not.toMatch(ORPHAN);
  });
});

describe('P26 G3 — CHECK_AVAILABILITY is the authority (matching train / date / class / status), always fresh', () => {
  it('[6] AVAILABLE for 12014 CC → "12014 mein CC available hai." accepted as RAILWAY_LIVE_FACT', async () => {
    const h = mk({ 'CC ki availability batao': [{ calls: [AV] }, v => ({ content: status(v) === 'Available' ? '12014 mein CC available hai.' : `WRONG ${status(v)}` })] });
    await h.run([SEARCH_T, '12014 wali CC mein']);
    const r = await h.say('CC ki availability batao');
    expect(execs(r)).toEqual([['CHECK_AVAILABILITY', 'SUCCEEDED', null]]);
    expect(rail.n.avail).toBe(1);
    expect(reasons(r)).toEqual([]);
    expect(text(r)).toMatch(/^12014 mein CC available hai\./);
    expect(r.turnLog.diagnostics.validation.claimTypes).toMatchObject({ RAILWAY_LIVE_FACT: 1 });
    expect(h.s().availability.CC).toMatchObject({ trainNumber: '12014', travelClass: 'CC', status: 'Available' });
  });

  it('[7] RAC 4 and Waitlist 12 are stated only as returned; a different WL number is a mismatch', async () => {
    const h = mk({
      '12497 CC chahiye': SEL('12497', 'CC', '12497 CC le liya.'),
      'CC availability check karo': [{ calls: [AV] }, v => ({ content: `12497 CC mein ${status(v)} hai.` })],
      'SL kar do': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'SL' })] }, { content: 'SL le liya.' }],
      'SL availability check karo': [{ calls: [AV] }, v => ({ content: `12497 SL mein ${status(v)} hai. 12497 SL mein WL 4 hai.` })]
    });
    await h.run([SEARCH_T, '12497 CC chahiye']);
    const rac = await h.say('CC availability check karo');
    expect(reasons(rac)).toEqual([]);
    expect(text(rac)).toMatch(/^12497 CC mein RAC 4 hai\./);
    await h.say('SL kar do');
    const wl = await h.say('SL availability check karo');
    expect(reasons(wl)).toEqual(['AVAILABILITY_MISMATCH:WL 4']);
    expect(text(wl)).toMatch(/^12497 SL mein Waitlist 12 hai\./);
    expect(text(wl)).not.toMatch(/WL 4/);
    expect(rail.n.avail).toBe(2);
  });

  it('[8] another train\'s or another date\'s claim is not covered by the 12014 · kal · CC result', async () => {
    const h = mk({
      'CC ki availability batao': [{ calls: [AV] }, { content: '12014 mein CC available hai.' }],
      'Aur baaki trains?': [{ content: '12497 mein CC available hai. Parso 12014 mein CC available hai. 12014 mein CC available hai.' }]
    });
    await h.run([SEARCH_T, '12014 wali CC mein', 'CC ki availability batao']);
    const r = await h.say('Aur baaki trains?');
    expect(execs(r)).toEqual([]);
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY', 'UNVERIFIED_AVAILABILITY']);
    expect(text(r)).toMatch(/^12014 mein CC available hai\./);
    expect(text(r)).not.toMatch(/12497 mein CC|Parso/);
  });

  it('[9] freshness: every new availability enquiry hits the provider again (no cache, no reuse)', async () => {
    const h = mk({
      'CC ki availability batao': [{ calls: [AV] }, { content: '12014 mein CC available hai.' }],
      'Ek baar phir CC availability check karo': [{ calls: [AV] }, { content: '12014 mein CC abhi bhi available hai.' }]
    });
    await h.run([SEARCH_T, '12014 wali CC mein']);
    const a = await h.say('CC ki availability batao');
    const b = await h.say('Ek baar phir CC availability check karo');
    expect(execs(a)).toEqual([['CHECK_AVAILABILITY', 'SUCCEEDED', null]]);
    expect(execs(b)).toEqual([['CHECK_AVAILABILITY', 'SUCCEEDED', null]]);
    expect(rail.n.avail).toBe(2);
    expect(reasons(b)).toEqual([]);
  });
});
