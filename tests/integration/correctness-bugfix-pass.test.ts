/**
 * Correctness bug-fix pass (staging) — focused regression tests for the four confirmed bugs.
 *
 *   [B1] CHECK_PNR: a numeric PNR from the model is normalized losslessly; invalid / malformed values are rejected
 *        internally and the user only ever sees a fact-only clarification (never schema / runtime text) — TEXT = VOICE
 *   [B2] "verified / checked / current result" is never claimed without a successful authoritative result for it
 *        (rejected / malformed / failed / loop calls never count); the runtime loop notice only after a real success
 *   [B3] route / station claims (runs between, stops, before / after, origin, destination, negations) — Hinglish and
 *        English — need provider timetable / train-info / search data; false or unverifiable ones never reach the user
 *   [B4] general clock times (Tatkal "10:00", "6 baje", "10 minutes") are not railway timing facts; real departure /
 *        arrival / delay claims stay protected; the screen and the spoken reply follow the same guarded result
 *
 * Real orchestrator + turn engine + runtime + guards; a fake OpenAI-compatible server plays the native agent (scripted);
 * MOCK railway provider (ASR→NDLS = 12014 SHATABDI 04:55 · 12497 SHAN-E-PUNJAB 06:35 · 18238 19:35). No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime, ToolTurn } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { validateToolArgumentShape } from '../../server/ai/tool-runtime/tool-argument-schema';
import { userSafeToolError, SAFE_ERROR_MESSAGE } from '../../server/ai/tool-runtime/tool-error-normalizer';
import { liveToolMessage } from '../../server/ai/context/response-formatter';
import { railwayResponseGrounding, UNVERIFIED_FALLBACK } from '../../server/ai/tool-runtime/railway-response-grounding';
import { isGeneralTimeContext, buildFactIndex } from '../../server/ai/response/claim-facts';
import { collectRouteFacts, judgeRouteClaim } from '../../server/ai/response/route-claims';
import { factKindOf, UNVERIFIED_FACT_OWNERS } from '../../server/ai/intelligence/capability-catalog';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('correctness-bugfix-pass', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D1 } };
const SEARCH_T = 'Amritsar se Delhi kal ki trains dikhao';
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];
/** internal schema / runtime / tool vocabulary that must never reach the screen or TTS */
const LEAK = /Invalid argument|expected a string|expected a|received|Correct it|ask the user|Identical|already (rejected|failed)|INVALID_|REPEATED_|<number>|<object>|CHECK_PNR|Do not repeat|this turn/i;

const faOf = (v: TurnView): any => {
  const m = (v.body?.messages || []).find((x: any) => x.role === 'system' && String(x.content).startsWith('BACKEND_FACT_AUTHORITY '));
  return m ? JSON.parse(String(m.content).split('\n')[0].slice('BACKEND_FACT_AUTHORITY '.length)) : null;
};
const onFA = (first: any, retry: any) => (v: TurnView) => (faOf(v) ? (typeof retry === 'function' ? retry(v) : retry) : first);

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: '' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-BUGFIX', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { views, say: (t: string, m: Mode) => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any,
    callsFor: (u: string) => views.filter(v => v.user === u).length, viewsFor: (u: string) => views.filter(v => v.user === u) };
}
/** what the user sees (VOICE: the on-screen text of the spoken turn) */
const shown = (r: any) => String(r?.voice?.assistantText ?? r?.assistantText ?? r?.responseMessage ?? '');
/** what is spoken (VOICE) / shown (TEXT) */
const spoken = (r: any) => String(r?.voice?.speechText ?? r?.voice?.assistantText ?? r?.responseMessage ?? '');
const execs = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]).map(e => [e.tool, e.status, e.rejectionReason ?? null]);
const eventsOf = (r: any) => ((r?.turnLog?.events || []) as any[]).map(e => (typeof e === 'string' ? e : e?.type));

let fetchSpy: any, availSpy: any, ttSpy: any, fareSpy: any, trackSpy: any, pnrSpy: any;
let meta: any;
beforeEach(async () => {
  railwayRegistry.setActive('correctness-bugfix-pass');
  meta = (await new MockRailwayProvider().getTimetable({ trainNumber: '12014' } as any)).meta;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
  ttSpy = vi.spyOn(MockRailwayProvider.prototype as any, 'getTimetable');
  fareSpy = vi.spyOn(MockRailwayProvider.prototype, 'getFare');
  trackSpy = vi.spyOn(MockRailwayProvider.prototype, 'trackTrain');
  pnrSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkPNR');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

const PNR = '4512345678';
const pnrOk = () => pnrSpy.mockResolvedValue({ ok: true, data: { pnr: PNR, status: 'CNF', chartStatus: 'Chart not prepared', trainNumber: '12497', trainName: 'SHAN-E-PUNJAB', journeyDate: D1, from: 'ASR', to: 'NDLS', travelClass: '3A', passengers: [{ number: 1, bookingStatus: 'CNF', currentStatus: 'CNF', coach: 'B2', berth: '34' }] }, meta });

// =====================================================================================================================
describe('[B1] CHECK_PNR argument normalization — never a schema / runtime leak', () => {
  it('[B1-U1] schema: string PNR unchanged; numeric 10-digit PNR → string (lossless); invalid / malformed → INVALID_ARGUMENT with a fact-only clarification', () => {
    expect(validateToolArgumentShape('CHECK_PNR', { pnr: PNR })).toEqual({ ok: true, arguments: { pnr: PNR }, coerced: [] });
    const n = validateToolArgumentShape('CHECK_PNR', { pnr: 4512345678 });
    expect(n).toEqual({ ok: true, arguments: { pnr: PNR }, coerced: ['pnr:number→string'] });
    expect(typeof (n as any).arguments.pnr).toBe('string');
    for (const bad of [45123, 45123456789, 4512345678.5, 1e21, -4512345678, Number.NaN, true, { value: PNR }, [PNR]]) {
      const r = validateToolArgumentShape('CHECK_PNR', { pnr: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('INVALID_ARGUMENT');
        expect(r.details.clarify).toBe('PNR sahi format mein nahi mila (10 digit ka number chahiye).');
        expect(r.details.clarify).not.toMatch(/\?/);                                // fact only, no question
        if (typeof bad === 'number') expect(r.details.received).toBe('<number>');  // the PNR is never echoed into logs
      }
    }
  });

  it('[B1-U2] userSafeToolError / liveToolMessage: LLM-directed validation text → clarification / safe text; provider messages unchanged', () => {
    const inv = validateToolArgumentShape('CHECK_PNR', { pnr: 45123 }) as any;
    expect(userSafeToolError({ code: 'INVALID_ARGUMENT', message: inv.message, details: inv.details })).toBe('PNR sahi format mein nahi mila (10 digit ka number chahiye).');
    expect(userSafeToolError({ code: 'INVALID_REPEATED_CALL', message: 'Identical CHECK_PNR call was already rejected (INVALID_ARGUMENT). Do not repeat it: correct the arguments or ask the user.', details: { previousCode: 'INVALID_ARGUMENT', clarify: inv.details.clarify } })).toBe(inv.details.clarify);
    expect(userSafeToolError({ code: 'INVALID_ARGUMENT', message: 'Invalid argument "x" for CHECK_PNR: expected a string; received <number>. Correct it or ask the user.' })).toBe(SAFE_ERROR_MESSAGE.INVALID_ARGUMENT);
    expect(userSafeToolError({ code: 'REPEATED_FAILED_CALL', message: 'Identical CHECK_PNR call already failed (X) 1x this turn. Do not repeat it' })).toBe(SAFE_ERROR_MESSAGE.REPEATED_FAILED_CALL);
    expect(userSafeToolError({ code: 'PNR_STATUS_UNAVAILABLE', message: 'PNR status check abhi available nahi hai — railway provider se PNR data nahi mila.' })).toBe('PNR status check abhi available nahi hai — railway provider se PNR data nahi mila.');
    const steps = [
      { status: 'rejected', result: { toolName: 'CHECK_PNR', error: { code: 'INVALID_ARGUMENT', message: inv.message, details: inv.details } } },
      { status: 'rejected', result: { toolName: 'CHECK_PNR', error: { code: 'INVALID_REPEATED_CALL', message: 'Identical CHECK_PNR call was already rejected (INVALID_ARGUMENT).', details: { clarify: inv.details.clarify } } } }
    ];
    for (const mode of MODES) {
      const m = liveToolMessage(steps as any, mode);
      expect(m).toBe('PNR sahi format mein nahi mila (10 digit ka number chahiye).');
      expect(m).not.toMatch(LEAK);
    }
  });

  const PNR_Q = `Mera PNR ${PNR} hai, confirm hua ya nahi?`;
  const pnrCases: Array<[string, any, boolean]> = [
    ['valid string PNR from the model', { pnr: PNR }, true],
    ['numeric PNR from the model (normalized to a string)', { pnr: 4512345678 }, true]
  ];
  for (const [label, args] of pnrCases) {
    it(`[B1-E1] ${label} → CHECK_PNR executes with a STRING pnr; reply from the provider result only — TEXT = VOICE`, async () => {
      const out: Record<string, string> = {};
      for (const mode of MODES) {
        pnrSpy.mockReset(); pnrOk();
        const h = stack({ [PNR_Q]: [{ calls: [{ name: 'CHECK_PNR', args }] }, { content: '' }] });
        const r = await h.say(PNR_Q, mode);
        expect(pnrSpy).toHaveBeenCalledTimes(1);
        expect(pnrSpy.mock.calls[0][0].pnr).toBe(PNR);
        expect(typeof pnrSpy.mock.calls[0][0].pnr).toBe('string');
        expect(execs(r)).toEqual([['CHECK_PNR', 'SUCCEEDED', null]]);
        expect(shown(r)).toMatch(/current status.*CNF, chart: Chart not prepared\. Passenger 1: CNF/);   // provider fields only
        expect(shown(r)).not.toMatch(LEAK);
        out[mode] = shown(r);
      }
      // same facts in both modes (VOICE drops the booking-time status of the passenger line — existing voice brevity)
      expect(out.VOICE.replace(/ \(booking ke waqt [^)]*\)/g, '')).toBe(out.TEXT.replace(/ \(booking ke waqt [^)]*\)/g, ''));
    });
  }

  const badCases: Array<[string, any]> = [
    ['invalid numeric PNR (5 digits)', { pnr: 45123 }],
    ['ambiguous numeric PNR (11 digits)', { pnr: 45123456789 }],
    ['malformed arguments (object PNR)', { pnr: { value: PNR } }],
    ['malformed arguments (unknown argument)', { pnrNumber: PNR }]
  ];
  for (const [label, args] of badCases) {
    it(`[B1-E2] ${label}, repeated by the model → rejected internally, never executed; the user sees a fact-only notice, never schema text — TEXT = VOICE`, async () => {
      const out: Record<string, string> = {};
      for (const mode of MODES) {
        const llmSaw: string[] = [];
        const h = stack({ [PNR_Q]: [{ calls: [{ name: 'CHECK_PNR', args }] }, (v: TurnView) => { llmSaw.push(JSON.stringify(v.results.at(-1)!.content)); return { calls: [{ name: 'CHECK_PNR', args }] }; }, { content: '' }] });
        const r = await h.say(PNR_Q, mode);
        expect(pnrSpy).not.toHaveBeenCalled();
        expect(execs(r).map(e => e[2])).toEqual(['INVALID_ARGUMENT', 'INVALID_REPEATED_CALL']);
        expect(llmSaw[0]).toMatch(/Invalid argument/);          // the MODEL still gets the actionable contract message
        expect(shown(r)).not.toMatch(LEAK);
        expect(spoken(r)).not.toMatch(LEAK);
        expect(shown(r).length).toBeGreaterThan(0);
        out[mode] = shown(r);
      }
      expect(out.VOICE).toBe(out.TEXT);
    });
  }

  it('[B1-E3] provider / tool failure (+ a repeated identical call) → honest provider message, no runtime text — TEXT = VOICE', async () => {
    const out: Record<string, string> = {};
    for (const mode of MODES) {
      const h = stack({ [PNR_Q]: [{ calls: [{ name: 'CHECK_PNR', args: { pnr: 4512345678 } }] }, { calls: [{ name: 'CHECK_PNR', args: { pnr: PNR } }] }, { content: '' }] });
      const r = await h.say(PNR_Q, mode);
      expect(execs(r).map(e => e[2])).toEqual(['PNR_STATUS_UNAVAILABLE', 'REPEATED_FAILED_CALL']);
      expect(shown(r)).toContain('PNR status check abhi available nahi hai');
      expect(shown(r)).not.toMatch(LEAK);
      expect(shown(r)).not.toMatch(/confirm|CNF|berth|coach/i);
      out[mode] = shown(r);
    }
    expect(out.VOICE).toBe(out.TEXT);
  });
});

// =====================================================================================================================
describe('[B2] "verified result" claims need a successful authoritative result', () => {
  const S0: any = { sessionId: 's', bookingState: 'IDLE', sessionVersion: 1, searchResultsVersion: 0 };
  const step = (toolName: string, status: string, data?: any, error?: any) => ({ status, result: { toolName, data, error } });
  const v = (text: string, steps: any[], session: any = S0, records: any[] = []) => railwayResponseGrounding.validate(text, { session, steps, records, userText: 'x' });

  it('[B2-U1] rejected availability / failed provider / malformed call / loop → the claim is removed', () => {
    const claims = ['Upar wala verified result hi current hai.', 'Maine availability check kar li hai.', 'This is the verified availability result.', 'Ye actual result hai.'];
    const failing = [
      [step('CHECK_AVAILABILITY', 'rejected', undefined, { code: 'INVALID_ARGUMENT', message: 'x' })],
      [step('CHECK_AVAILABILITY', 'error', undefined, { code: 'PROVIDER_UNAVAILABLE', message: 'x' })],
      [step('CHECK_AVAILABILITY', 'rejected', undefined, { code: 'TOOL_LOOP_DETECTED', message: 'x' }), step('CHECK_AVAILABILITY', 'stale', undefined, { code: 'STALE_TOOL_RESULT' })]
    ];
    for (const steps of failing) for (const c of claims) {
      const g = v(c, steps);
      expect(g.rejected).toContain('VERIFIED_RESULT_CLAIM');
      expect(g.text).toBe('');
    }
    // no tool, no session data → nothing was verified
    expect(v('Upar wala verified result hi current hai.', []).rejected).toContain('VERIFIED_RESULT_CLAIM');
  });

  it('[B2-U2] honest negations / the fallback text are never caught', () => {
    for (const c of [UNVERIFIED_FALLBACK, 'Ye jaankari abhi verify nahi ho paayi.', 'Availability ka verified result abhi nahi mila.', "I couldn't get a verified availability result."])
      expect(v(c, [step('CHECK_AVAILABILITY', 'rejected', undefined, { code: 'INVALID_ARGUMENT' })]).rejected).toEqual([]);
  });

  it('[B2-U3] successful availability / fare / PNR / live status (and owned session data) → the claim is allowed', () => {
    expect(v('Maine availability check kar li hai.', [step('CHECK_AVAILABILITY', 'ok', { trainNumber: '12497', travelClass: '3A', status: 'Available' })]).rejected).toEqual([]);
    expect(v('Fare ka verified result upar hai.', [step('GET_FARE', 'ok', { trainNumber: '12497', travelClass: '3A', farePerPassenger: 650, totalFare: 650 })]).rejected).toEqual([]);
    expect(v('PNR ka checked status upar hai.', [step('CHECK_PNR', 'ok', { pnr: PNR, status: 'CNF' })]).rejected).toEqual([]);
    expect(v('Live status ka verified result upar hai.', [step('TRACK_TRAIN', 'ok', { trainNumber: '12497', delayMinutes: 5 })]).rejected).toEqual([]);
    // live status is never "verified" from an earlier turn; a failed fare call is not rescued by older session data
    expect(v('Live status ka verified result upar hai.', []).rejected).toContain('VERIFIED_RESULT_CLAIM');
    expect(v('Fare ka verified result upar hai.', [step('GET_FARE', 'error', undefined, { code: 'PROVIDER_UNAVAILABLE' })], { ...S0, fare: { totalFare: 650 } }).rejected).toContain('VERIFIED_RESULT_CLAIM');
    expect(v('Fare ka verified result upar hai.', [], { ...S0, fare: { totalFare: 650 } }).rejected).toEqual([]);
  });

  it('[B2-U4] runtime loop notice: "upar wala verified result" ONLY after the identical call succeeded this turn', () => {
    const mk = () => new ToolTurn({ getSession: () => ({ ...S0 }) as any, userText: 'x', validate: (tc: any) => ({ ok: false, error: { code: 'TRAIN_NOT_IDENTIFIED', message: 'Availability ke liye train identify nahi hui.' } }) } as any, { loopThreshold: 3 } as any);
    const tc = () => ({ callId: `c${Math.random()}`, name: 'CHECK_AVAILABILITY' as any, arguments: { travelClass: 'CC' } });
    const t = mk();
    // prepare(…, fromLLM) runs the per-turn admission (loop counter) itself
    const codes = [0, 1, 2].map(() => { const p = t.prepare(tc(), true) as any; return [p.error?.code, p.error?.message]; });
    expect(codes.map(c => c[0])).toEqual(['TRAIN_NOT_IDENTIFIED', 'INVALID_REPEATED_CALL', 'TOOL_LOOP_DETECTED']);
    expect(codes[2][1]).not.toMatch(/verified result hi current/);
    expect(codes[2][1]).toBe('Availability ke liye train identify nahi hui.');            // the validator's user-facing reason
    // no reason at all (e.g. a provider-failed signature) → the honest UNKNOWN text, never "verified result"
    expect((t as any).loopMessage('never-seen')).toBe(SAFE_ERROR_MESSAGE.UNKNOWN);
    // a signature that really SUCCEEDED this turn keeps the existing notice (end-to-end: p17-tool-runtime-e2e [17])
    (t as any).okLoopSigs.add('ok-sig');
    expect((t as any).loopMessage('ok-sig')).toBe(SAFE_ERROR_MESSAGE.TOOL_LOOP_DETECTED);
  });

  for (const mode of MODES) {
    it(`[B2-E1] 3 rejected CHECK_AVAILABILITY calls + "upar wala verified result" → never shown (${mode})`, async () => {
      const Q = 'Shatabdi mein CC available hai?';
      const AV = { name: 'CHECK_AVAILABILITY', args: { travelClass: 'CC' } };
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [AV] }, { calls: [AV] }, { calls: [AV] }, { content: 'Upar wala verified result hi current hai.' }] });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(availSpy).not.toHaveBeenCalled();
      expect(shown(r)).not.toMatch(/verified result hi current|upar wala verified/i);
      expect(spoken(r)).not.toMatch(/verified result hi current|upar wala verified/i);
      expect(shown(r)).not.toMatch(LEAK);
    });

    it(`[B2-E2] successful availability → "maine check kar liya" + the provider status is kept (${mode})`, async () => {
      const Q = '12497 mein 3A ki berth hai?';
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [{ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: '3A' } }] }, (v: TurnView) => ({ content: `Maine availability check kar li hai. 12497 mein 3A ${v.results.at(-1)!.content.data.status} hai.` })] });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(availSpy).toHaveBeenCalledTimes(1);
      expect(shown(r)).toBe('Maine availability check kar li hai. 12497 mein 3A Available hai.');
    });
  }
});

// =====================================================================================================================
describe('[B3] route / station claims are grounded in provider route data', () => {
  // provider timetable (order = route order): ASR → BEAS → JUC → PGW → LDH → SIR → UMB → NDLS
  const TT = [['ASR', 'Amritsar Junction'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Junction'], ['LDH', 'Ludhiana Junction'], ['SIR', 'Sirhind Junction'], ['UMB', 'Ambala Cantt'], ['NDLS', 'New Delhi']].map(([station, stationName]) => ({ station, stationName }));
  const search = { journey: { origin: 'ASR', originName: 'Amritsar Junction', destination: 'NDLS', destinationName: 'New Delhi', date: D1 }, trains: [{ trainNumber: '12014', trainName: 'AMRITSAR SHATABDI', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '10:50' }, { trainNumber: '12030', trainName: 'SWARN SHATABDI', origin: 'ASR', destination: 'NDLS', departure: '16:55', arrival: '22:50' }], totalCount: 2 };
  const withTT: any = { sessionId: 's', searchResults: search, lastTimetable: TT, focusTrainNumber: '12014' };
  const searchOnly: any = { sessionId: 's', searchResults: search };
  const J = (s: any, t: string) => judgeRouteClaim(t, collectRouteFacts(s, []));

  it('[B3-U1] false order claims (Hinglish + English) → ROUTE_CLAIM; the true order from the timetable passes', () => {
    expect(J(withTT, 'Is train mein Sirhind, Ludhiana se pehle aata hai.')).toBe('ROUTE_CLAIM:ORDER');
    expect(J(withTT, 'Is train mein Ludhiana ke baad Sirhind aata hai.')).toBeNull();
    expect(J(withTT, '12014 reaches Sirhind before Ludhiana.')).toBe('ROUTE_CLAIM:ORDER');
    expect(J(withTT, '12014 reaches Sirhind after Ludhiana.')).toBeNull();
    expect(J(withTT, '12014 mein Phagwara, Jalandhar City ke baad aata hai.')).toBeNull();
    // order with only a search segment: direction known for the searched pair only
    expect(J(searchOnly, '12014 mein New Delhi, Amritsar se pehle aata hai.')).toBe('ROUTE_CLAIM:ORDER');
    expect(J(searchOnly, '12014 mein Amritsar ke baad New Delhi aata hai.')).toBeNull();
    // the live Muse sentence: an order claim about "pehle wale stations" without timetable support
    expect(J(searchOnly, 'Isi train mein pehle wale stations jaise Sirhind, Ludhiana se pehle, check kar sakte hain.')).toMatch(/^ROUTE_CLAIM/);
  });

  it('[B3-U2] stop / route / negation claims need the halt list; origin / destination need train-level data', () => {
    expect(J(withTT, '12014 Phagwara pe nahi rukti.')).toBe('ROUTE_CLAIM:STOP');            // contradicted (it halts there)
    expect(J(withTT, '12014 Chandigarh pe nahi rukti.')).toBeNull();                         // proven absent from the full halt list
    expect(J(searchOnly, '12014 Chandigarh pe nahi rukti.')).toBe('ROUTE_CLAIM:STOP');       // no halt list → unverifiable
    expect(J(withTT, '12014 Ludhiana pe rukti hai.')).toBeNull();
    expect(J(searchOnly, 'Ludhiana se koi Shatabdi nahin chalti.')).toBe('ROUTE_CLAIM:RUN'); // gpt-oss false negative route claim
    expect(J({ sessionId: 's' }, 'Ludhiana se koi Shatabdi nahin chalti.')).toBe('ROUTE_CLAIM:RUN');
    expect(J(withTT, '12014 Ludhiana se shuru hoti hai.')).toBe('ROUTE_CLAIM:ORIGIN');
    expect(J(withTT, '12014 Amritsar se shuru hoti hai aur New Delhi pe khatam hoti hai.')).toBeNull();
    expect(J(withTT, 'The 12014 terminates at Ludhiana.')).toBe('ROUTE_CLAIM:TERMINUS');
    expect(J(searchOnly, '12014 Amritsar se New Delhi jaati hai.')).toBeNull();               // valid route from the search row
    expect(J(searchOnly, '12014 runs from New Delhi to Amritsar.')).toBe('ROUTE_CLAIM:RUN'); // reversed direction
    expect(J(withTT, '12014 passes through Ambala Cantt.')).toBeNull();
    // not route claims: no specific train / no station / no topology
    expect(J(searchOnly, 'Ludhiana ek bada junction hai.')).toBeNull();
    expect(J(searchOnly, 'Amritsar se Delhi ke liye 2 trains mili hain.')).toBeNull();
    expect(J(searchOnly, 'Train nikal gaya hoga.')).toBeNull();
  });

  it('[B3-U3] the claim kind is owned by GET_TIMETABLE / GET_TRAIN_INFO for the one-shot recovery', () => {
    expect(factKindOf('ROUTE_CLAIM:ORDER')).toBe('ROUTE');
    expect(UNVERIFIED_FACT_OWNERS.ROUTE).toEqual(['GET_TIMETABLE', 'GET_TRAIN_INFO']);
    const g = railwayResponseGrounding.validate('12014 mein Sirhind, Ludhiana se pehle aata hai. Aur kuch?', { session: withTT, steps: [], userText: 'x' });
    expect(g.rejected).toEqual(['ROUTE_CLAIM:ORDER']);
    expect(g.text).toBe('Aur kuch?');
  });

  for (const mode of MODES) {
    it(`[B3-E1] tool-less false order claim → one recovery naming GET_TIMETABLE; the retry's timetable-grounded claim is shown (${mode})`, async () => {
      const Q = '12014 mein Ludhiana pehle aata hai ya Jalandhar?';
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [onFA({ content: '12014 mein Ludhiana, Jalandhar se pehle aata hai.' }, { calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '12014' } }] }),
          { content: '12014 mein Jalandhar ke baad Ludhiana aata hai.' }] });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      const fas = h.viewsFor(Q).map(faOf).filter(Boolean);
      expect(fas).toEqual([{ origin: 'BACKEND_FACT_AUTHORITY', unverified: [{ kind: 'ROUTE', capabilities: ['GET_TIMETABLE', 'GET_TRAIN_INFO'] }] }]);
      expect(ttSpy).toHaveBeenCalledTimes(1);
      expect(shown(r)).toContain('12014 mein Jalandhar ke baad Ludhiana aata hai.');
      expect(shown(r)).not.toMatch(/Jalandhar se pehle/);
      expect(spoken(r)).not.toMatch(/Jalandhar se pehle/);
    });

    it(`[B3-E2] false order claim after GET_TIMETABLE ran → removed (never invented / replaced); true claim kept (${mode})`, async () => {
      const Q = '12014 ke stations ka order kya hai?';
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '12014' } }] }, { content: '12014 Amritsar se shuru hoti hai. Isme Ludhiana, Jalandhar se pehle aata hai.' }] });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
      expect(shown(r)).toContain('12014 Amritsar se shuru hoti hai.');
      expect(shown(r)).not.toMatch(/Jalandhar se pehle/);
      expect(spoken(r)).not.toMatch(/Jalandhar se pehle/);
    });

    it(`[B3-E3] false negative route claim with no route data → never shown (${mode})`, async () => {
      const Q = 'Ludhiana se Shatabdi milegi?';
      const h = stack({ [Q]: [{ content: 'Ludhiana se koi Shatabdi nahin chalti.' }] });
      const r = await h.say(Q, mode);
      expect(h.viewsFor(Q).map(faOf).filter(Boolean)).toEqual([{ origin: 'BACKEND_FACT_AUTHORITY', unverified: [{ kind: 'ROUTE', capabilities: ['GET_TIMETABLE', 'GET_TRAIN_INFO'] }] }]);
      expect(h.callsFor(Q)).toBe(2);                                  // exactly one recovery; the repeat is stripped
      expect(shown(r)).not.toMatch(/koi Shatabdi nahin/);
      expect(spoken(r)).not.toMatch(/koi Shatabdi nahin/);
    });
  }
});

// =====================================================================================================================
describe('[B4] general clock times vs railway timing facts', () => {
  const idx = buildFactIndex({ sessionId: 's' } as any, []);
  it('[B4-U1] isGeneralTimeContext: general explanations yes; train / station / movement / live context never', () => {
    for (const t of ['Tatkal booking AC classes ke liye subah 10:00 baje khulti hai.', 'Tatkal booking train ki journey date se ek din pehle 10:00 baje khulti hai.', 'Non-AC Tatkal generally 11:00 baje open hota hai.'])
      expect(isGeneralTimeContext(t, idx)).toBe(true);
    for (const t of ['12014 10:50 pe pahunchti hai.', 'Train 10:00 baje nikalti hai.', 'Shatabdi 07:20 pe chalti hai.', 'Platform 3 pe 10:00 baje aana hota hai.', 'Ludhiana mein 10:00 baje hota hai.', 'Train generally 10:00 baje 20 minute late hoti hai.'])
      expect(isGeneralTimeContext(t, idx)).toBe(false);
  });

  it('[B4-U2] strict grounding: the general time passes; unsupported departure / arrival / delay claims are still rejected', () => {
    const v = (text: string, steps: any[] = [], session: any = { sessionId: 's' }) => railwayResponseGrounding.validate(text, { session, steps, userText: 'x' });
    expect(v('Tatkal booking AC classes ke liye 10:00 baje khulti hai.').rejected).toEqual([]);
    const s12014 = { sessionId: 's', searchResults: { trains: [{ trainNumber: '12014', departure: '04:55', arrival: '10:50' }] } };
    expect(v('Train 12014 New Delhi 09:15 pe pahunchti hai.', [], s12014).rejected).toContain('TIMING:09:15');
    expect(v('Train 12014 Amritsar se 04:30 pe nikalti hai.', [], s12014).rejected).toContain('TIMING:04:30');
    expect(v('Shatabdi 07:20 pe chalti hai.').rejected).toContain('TIMING:07:20');
    expect(v('Train 25 minute late chal rahi hai.').rejected).toContain('PUNCTUALITY_CLAIM');
    const s = { sessionId: 's', searchResults: { journey: { origin: 'ASR', destination: 'NDLS', destinationName: 'New Delhi' }, trains: [{ trainNumber: '12014', departure: '04:55', arrival: '10:50' }] } };
    expect(v('12014 Amritsar se 04:55 pe chalti hai aur 10:50 pe New Delhi pahunchti hai.', [], s).rejected).toEqual([]);
  });

  const GENERAL: Array<[string, string]> = [
    ['Tatkal booking kitne baje khulti hai?', 'Tatkal booking AC classes ke liye journey date se ek din pehle 10:00 baje khulti hai, aur non-AC ke liye 11:00 baje.'],
    ['Tatkal ke liye kab ready rehna chahiye?', 'Tatkal window AC ke liye 10 baje khulti hai, isliye 6 baje ki jagah thoda pehle se login karke ready rehna accha hota hai.'],
    ['Tatkal mein itni jaldi seats kaise khatam hoti hain?', 'Tatkal khulne ke pehle 10 minutes mein demand sabse zyada hoti hai, isliye seats jaldi khatam ho jaati hain.']
  ];
  for (const [Q, A] of GENERAL) it(`[B4-E1] general answer with a clock time ("${A.match(/10:00|6 baje|10 minutes/)![0]}") → shown as written, no recovery, one model call — screen = speech, TEXT = VOICE`, async () => {
    const out: Record<string, string> = {};
    for (const mode of MODES) {
      const h = stack({ [Q]: [{ content: A }] });
      const r = await h.say(Q, mode);
      expect(h.callsFor(Q)).toBe(1);
      expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
      expect(shown(r)).toBe(A);
      expect(shown(r)).not.toMatch(/22:00|pm|departure se/i);
      out[mode] = shown(r);
    }
    expect(out.VOICE).toBe(out.TEXT);
  });

  for (const mode of MODES) {
    it(`[B4-E2] actual departure / arrival from provider data are kept (${mode})`, async () => {
      const Q = '12014 kab chalti hai aur kab pahunchti hai?';
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '12014' } }] }, { content: '12014 Amritsar se 04:55 pe chalti hai aur New Delhi 10:50 pe pahunchti hai.' }] });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(shown(r)).toBe('12014 Amritsar se 04:55 pe chalti hai aur New Delhi 10:50 pe pahunchti hai.');
      expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
    });

    it(`[B4-E3] actual delay from TRACK_TRAIN is kept (${mode})`, async () => {
      trackSpy.mockResolvedValue({ ok: true, data: { trainNumber: '12497', currentStatus: 'Running', currentStationName: 'Ludhiana Jn', delayMinutes: 20, lastUpdated: new Date().toISOString() }, meta });
      const Q = '12497 kitni late hai?';
      const h = stack({ [Q]: [{ calls: [{ name: 'TRACK_TRAIN', args: { trainNumber: '12497' } }] }, { content: 'Train Ludhiana Jn ke paas hai, 20 minute late chal rahi hai.' }] });
      const r = await h.say(Q, mode);
      expect(shown(r)).toMatch(/Ludhiana Jn.*20 min late/);          // the provider delay (backend live-status wording)
    });

    it(`[B4-E4] unsupported train timing → one recovery (TIMING), never shown; screen and speech agree (${mode})`, async () => {
      const Q = '12014 Delhi kitne baje pahunchti hai?';
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ content: '12014 New Delhi 09:15 pe pahunchti hai.' }] });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(h.viewsFor(Q).map(faOf).filter(Boolean).length).toBe(1);
      expect(shown(r)).not.toMatch(/09:15/);
      expect(spoken(r)).not.toMatch(/09:15/);
    });
  }
});
