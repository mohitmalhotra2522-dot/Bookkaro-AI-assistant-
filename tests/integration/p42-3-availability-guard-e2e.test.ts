/**
 * P42.3 BLOCKER — the exact staging failure through the FULL agent stack, deterministic: fake OpenAI-compatible server
 * playing Muse (scripted with the exact reply Muse produced on staging) → RailwayToolRuntime → mock provider that
 * answers CHECK_AVAILABILITY for 12446 1A with RLWL1/WL1 (TEST DATA) → response guard → screen + voice.
 * No network, no credits, no booking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { normalizeTrainResults } from '../../server/railway/normalizers/railway-normalizer';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type FakeReply, type TurnView } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P423-GUARD-SECRET-77777';
class Rail12446 extends MockRailwayProvider {
  avail = 0;
  async searchTrains(r: any): Promise<any> {
    const base: any = await super.searchTrains({ ...r, origin: 'Amritsar', destination: 'Delhi' });
    const row = (classCode: string, className: string) => ({ number: '12446', trainName: 'UTTAR S KRANTI', origin: 'LDH', destination: 'UMB', departure: '02:10', arrival: '04:03',
      duration: '1h 53m', runsOn: ['Daily'], classCode, className, availability: undefined, fare: undefined });
    return { ok: true, data: normalizeTrainResults([row('1A', 'First AC'), row('2A', 'AC 2 Tier')] as any, { origin: r.origin, destination: r.destination, date: r.date }), meta: base.meta };
  }
  async checkAvailability(r: any): Promise<any> {
    this.avail++;
    const base: any = await super.checkAvailability({ ...r, trainNumber: '12497', travelClass: 'SL' });
    return { ok: true, data: { trainNumber: r.trainNumber, travelClass: r.travelClass, date: r.date, status: 'RLWL1/WL1', available: false }, meta: base.meta };
  }
}
const rail = new Rail12446();
railwayRegistry.register('p423-12446', () => rail);

const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const USER = 'Ludhiana se Ambala kal 12446 1A, 3 passengers';
const MUSE_REPLY = '12446 UTTAR S KRANTI ki 1A class mein 3 passengers ke liye seats waitlist pe hain – WL 1. Agar aap seat chahte hain, to 1 seat available hai, baki 2 seats waitlist mein. Agar fare bhi dekhna ho, to batayein.';
const PLAN: Array<FakeReply> = [
  { calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'LDH', destination: 'UMB', date: 'kal', passengersCount: 3 } }] },
  { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12446' } })] },
  { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '1A' })] },
  { calls: [{ name: 'CHECK_AVAILABILITY', args: {} }] },
  { content: MUSE_REPLY }
];

function mk() {
  const fake = new FakeOpenAI((v: TurnView) => (v.user === USER && v.step < PLAN.length ? PLAN[v.step] : { content: 'Theek hai.' }));
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  state.getSession(sid).passengersCount = 3;                                   // TEST SETUP: the party size the user stated
  return { say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.message].map(x => String(x ?? '')).join(' | ');

const realFetch = globalThis.fetch.bind(globalThis);
beforeEach(() => {
  railwayRegistry.setActive('p423-12446');
  rail.avail = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('P42.3 G3 — exact staging blocker through the full stack', () => {
  for (const mode of ['TEXT', 'VOICE'] as const) {
    it(`[${mode}] RLWL1/WL1 for 3 passengers: the false "1 seat available" never reaches the user; the truthful WL sentence stays`, async () => {
      const h = mk();
      const r = await h.say(USER, mode);
      const execs = r.turnLog.toolExecutions.map((e: any) => `${e.tool}:${e.status}`);
      expect(execs).toContain('CHECK_AVAILABILITY:SUCCEEDED');
      expect(rail.avail).toBe(1);
      expect(String(h.s().availability?.['1A']?.status)).toBe('RLWL1/WL1');
      const out = shown(r);
      expect(out).not.toMatch(/1 seat available/i);
      expect(out).not.toMatch(/seat chahte hain, to/i);
      expect(String(r.voice?.speechText ?? '')).not.toMatch(/1 seat available/i);
      expect(out).toContain('WL 1');                                            // Muse's truthful wording is kept, not replaced by a template
      expect(JSON.stringify(r.turnLog.naturalSpeech?.rejected ?? r.turnLog.rejectedClaims ?? [])).toMatch(/AVAILABILITY_MISMATCH/);
      expect(h.s().bookingState === 'COMPLETED').toBe(false);
    });
  }
});
