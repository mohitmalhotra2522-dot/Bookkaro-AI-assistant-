/**
 * PROMPT 27 — G2: autonomous multi-step LLM ↔ tool orchestration (focused unit tests).
 * The LLM (MockLLM here; offline, deterministic) decides every step; the backend only validates, executes approved
 * tools, enforces the step budget / dedup / retry bounds and keeps BookingSession authoritative.
 * Covers: budget constant, MIDDLE reference resolution, informational selection hold, general knowledge (zero tools),
 * comparison over returned times only, class-not-listed stop, date-correction re-search, chain-stop answers,
 * chain trace / observability, in-chain dedup, max steps, malformed-call bound, forbidden tools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { mockChainDecision, MOCK_CHAIN_SCENARIOS, type MockChainScenarioId } from '../../server/ai/providers/mock-llm-chains';
import { TrainReferenceResolver } from '../../server/ai/context/train-reference-resolver';
import { derivePendingInteraction } from '../../server/ai/context/pending-interaction';
import { MAX_TOOL_STEPS_PER_TURN } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';

class SpyLLM extends MockLLMProvider {
  inputs: any[] = [];
  async generateStructuredDecision(input: any): Promise<any> { this.inputs.push(input); return super.generateStructuredDecision(input); }
}
function mk(forced?: MockChainScenarioId) {
  const state = new ConversationStateManager();
  const llm = new SpyLLM({ chainScenario: forced });
  const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(llm as any, state, new RailwayToolService()), state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { llm, state, sid, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const chain = (r: any) => r.turnLog.diagnostics.chain;
const tools = (d: any) => (d?.toolCalls || []).map((c: any) => c.name);
const SEARCH_T = 'Kal Amritsar se Delhi trains batao';
async function sessionWithResults() { const h = mk(); await h.say(SEARCH_T); return h.s(); }
const decide = (userText: string, session: any, extra: any = {}) => mockChainDecision({ userText, session, history: [], state: session.bookingState, missingFields: [], inputMode: 'TEXT', tools: [], currentTurnToolResults: [], ...extra } as any);
const withTrains = (s: any, f: (ts: any[]) => any[]) => ({ ...s, searchResults: { ...s.searchResults, trains: f(s.searchResults.trains.map((t: any) => ({ ...t }))) } });

let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore(); handoffSpy.mockRestore();
});

describe('P27 G2 — budget, references, informational hold', () => {
  it('[1] the per-turn tool-step budget is exactly 8 and is reported in the chain trace (never silently raised)', async () => {
    expect(MAX_TOOL_STEPS_PER_TURN).toBe(8);
    const h = mk(); const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    expect(chain(r).budget.maxToolSteps).toBe(8);
    expect(MOCK_CHAIN_SCENARIOS).toHaveLength(16);
  });

  it('[2] "beech wali" (MIDDLE) resolves only for an odd list ≥ 3; 2 results → INVALID_TRAIN_REFERENCE; 4 → AMBIGUOUS_REFERENCE', async () => {
    const s = await sessionWithResults();
    const R = new TrainReferenceResolver(); const ref = { kind: 'DEMONSTRATIVE', value: 'MIDDLE' } as any;
    const three: any = R.resolve(ref, s);
    expect(three.ok).toBe(true); expect(three.train.trainNumber ?? three.train.number).toBe('12497');
    expect((R.resolve(ref, withTrains(s, ts => ts.slice(0, 2))) as any).code).toBe('INVALID_TRAIN_REFERENCE');
    const four: any = R.resolve(ref, withTrains(s, ts => [...ts, { ...ts[0], trainNumber: '12460', displayIndex: 4 }]));
    expect(four.code).toBe('AMBIGUOUS_REFERENCE');
    expect(four.candidates.map((t: any) => t.trainNumber)).toEqual(['12497', '18238']);
  });

  it('[3] an INFORMATIONAL class selection holds at CLASS_SELECTED (no passenger question); a booking selection still asks', async () => {
    const s = await sessionWithResults();
    const base = { ...s, bookingState: 'CLASS_SELECTED', selectedTrain: { number: '12497' }, selectedClass: '3A', passengersCount: undefined };
    expect(derivePendingInteraction({ ...base, selectionPurpose: 'INFORMATION' } as any).type).toBe('NONE');
    expect(derivePendingInteraction({ ...base, selectionPurpose: undefined } as any).type).toBe('PASSENGERS_REQUIRED');
  });
});

describe('P27 G2 — the LLM plans; general knowledge needs no tools', () => {
  it('[4] RAC / Tatkal / Shatabdi vs Vande Bharat → a final answer with ZERO tool calls; railway lookups phrased as questions are not GK', async () => {
    const idle = mk().s();
    for (const q of ['RAC kya hota hai?', 'Tatkal kya hota hai?', 'Shatabdi aur Vande Bharat mein difference kya hai?', 'What is RAC?']) {
      const d = decide(q, idle);
      expect(d, q).not.toBeNull();
      expect(tools(d), q).toEqual([]);
      expect(String(d!.finalMessage).length, q).toBeGreaterThan(20);
    }
    expect(decide('What is RAC?', idle)!.finalMessage).toMatch(/Reservation Against Cancellation/);
    const s = await sessionWithResults();
    for (const q of ['3A ka fare kya hai?', 'PNR kya hai?', 'latest booking ka PNR kya hai?']) expect(decide(q, s)?.finalMessage ?? null, q).toBeNull();
  });

  it('[5] a chain-stop input → final answer only, never another tool request; empty results → honest "could not complete"', async () => {
    const s = await sessionWithResults();
    const stop = { reason: 'TOOL_BUDGET_EXHAUSTED', code: 'TOOL_CALL_LIMIT_EXCEEDED', instruction: 'answer from results' };
    const empty = decide('Sab trains ki details batao', s, { chainStop: stop });
    expect(tools(empty)).toEqual([]);
    expect(empty!.finalMessage).toMatch(/poori nahi ho paayi/);
    expect(empty!.finalMessage).not.toMatch(/₹|available|\d{2}:\d{2}/);
  });
});

describe('P27 G2 — comparison uses only the returned times; the backend never picks', () => {
  it('[6] "sabse jaldi pahunchne wali" + 3A → 12497 (12014 arrives first but lists no 3A) → SELECT + parallel availability & fare', async () => {
    const s = await sessionWithResults();
    const d = decide('Kal Amritsar se Delhi ki sabse jaldi pahunchne wali train ki 3A availability aur fare batao', s)!;
    expect(d.entities.trainRef).toMatchObject({ kind: 'TRAIN_NUMBER', value: '12497' });
    expect(d.entities.classRaw).toBe('3A');
    expect((d.entities as any).selectionPurpose).toBe('INFORMATION');
    expect(tools(d).sort()).toEqual(['CHECK_AVAILABILITY', 'GET_FARE']);
    for (const c of d.toolCalls!) expect(c.arguments).toMatchObject({ trainNumber: '12497', travelClass: '3A' });
    const cc = decide('Kal Amritsar se Delhi ki sabse jaldi pahunchne wali train ki CC availability batao', s)!;
    expect(cc.entities.trainRef).toMatchObject({ value: '12014' });
    expect(tools(cc)).toEqual(['CHECK_AVAILABILITY']);
  });

  it('[7] a train whose arrival cannot be derived from RETURNED values (no arrival, no duration) is excluded — never inferred', async () => {
    const s = await sessionWithResults();
    const noArr = withTrains(s, ts => ts.map(t => (t.trainNumber === '12014' ? { ...t, arrival: '', duration: '' } : t)));
    const d = decide('Sabse pehle pahunchne wali ki CC availability batao', noArr)!;
    expect(d.entities.trainRef).toMatchObject({ value: '12497' });
  });

  it('[8] "beech wali ki 2A" — the middle train does not list 2A → final answer, NO availability / fare call', async () => {
    const s = await sessionWithResults();
    const d = decide('Beech wali ki 2A availability aur fare batao', s)!;
    expect(tools(d)).toEqual([]);
    expect(d.finalMessage).toMatch(/12497/);
    expect(d.finalMessage).toMatch(/2A/);
    expect(d.finalMessage).not.toMatch(/₹|seats? available/i);
  });

  it('[9] "kal nahi parso … phir se check" → UPDATE_DATE + a FRESH search first (no availability before the new list)', async () => {
    const h = mk(); await h.say(SEARCH_T); await h.say('Beech wali ki 3A availability batao');
    const d = decide('Kal nahi parso, usi train ki 3A availability phir se check karo', h.s())!;
    expect(d.action).toBe('UPDATE_DATE');
    expect(tools(d)).toEqual(['SEARCH_TRAINS']);
  });

  it('[10] English in → English answer (language follows the user)', async () => {
    const s = await sessionWithResults();
    const d = decide('Which of these trains reaches Delhi earliest?', s)!;
    expect(tools(d)).toEqual([]);
    expect(d.finalMessage).toMatch(/^12014 reaches .* earliest, at 10:50\.$/);
  });
});

describe('P27 G2 — loop guards and observability through the real runtime', () => {
  it('[11] 3-step chain trace: 3 LLM calls, 3 provider calls, availability + fare share one parallel group, sanitized args', async () => {
    const h = mk(); const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao');
    const c = chain(r);
    // chainLength = sequential tool rounds: search, then availability ‖ fare
    expect(c).toMatchObject({ llmCallCount: 3, toolCallCount: 3, providerCallCount: 3, redundantCallCount: 0, chainStopReason: 'FINAL_RESPONSE', chainLength: 2 });
    expect(c.steps.map((x: any) => x.toolName)).toEqual(['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE']);
    expect(c.steps[1].parallelGroup).not.toBeNull();
    expect(c.steps[1].parallelGroup).toBe(c.steps[2].parallelGroup);
    expect(c.steps[0].llmCall).toBe(1); expect(c.steps[2].llmCall).toBe(2);
    expect(c.chainId).toMatch(/\S{6,}/);
    expect(JSON.stringify(c.steps)).not.toMatch(/batao|availability aur/);           // never the user's text
    for (const st of c.steps) expect(st.toolResultId).toBeTruthy();
    expect(h.s()).toMatchObject({ bookingState: 'CLASS_SELECTED', selectedClass: '3A', selectionPurpose: 'INFORMATION' });
  });

  it('[12] identical call inside one chain → reused (DEDUPLICATED, redundantCallCount 1), the provider is not hit twice', async () => {
    const h = mk('REPEATED_IDENTICAL_CALL'); const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    const c = chain(r);
    expect(c.providerCallCount).toBe(2);
    expect(c.redundantCallCount).toBe(1);
    expect(c.steps.at(-1)).toMatchObject({ toolName: 'CHECK_AVAILABILITY', decisionReason: 'DEDUPLICATED' });
  });

  it('[13] max steps: exactly 8 executions, the 9th is rejected, nothing runs after; the LLM answers once from results with tools disabled', async () => {
    const h = mk('MAX_TOOL_STEPS'); await h.say(SEARCH_T);
    h.llm.inputs.length = 0;
    const r = await h.say('Sab trains ki poori details batao');
    const c = chain(r);
    expect(c.chainStopReason).toBe('TOOL_BUDGET_EXHAUSTED');
    expect(c.providerCallCount).toBe(8);
    expect(c.steps.filter((x: any) => x.toolResultStatus === 'SUCCEEDED')).toHaveLength(8);
    expect(c.steps.at(-1).decisionReason).toBe('REJECTED:TOOL_CALL_LIMIT_EXCEEDED');
    expect(c.answeredAfterStop).toBe(true);
    const last = h.llm.inputs.at(-1);
    expect(last.chainStop).toMatchObject({ reason: 'TOOL_BUDGET_EXHAUSTED', code: 'TOOL_CALL_LIMIT_EXCEEDED' });
    expect(h.llm.inputs.filter((i: any) => i.chainStop)).toHaveLength(1);
    expect(r.voice.assistantText).toMatch(/12014/);
  });

  it('[14] a malformed call is never executed and never repeated blindly: invalid → repeat rejected → loop stop → one clarification, 0 provider calls', async () => {
    const h = mk('INVALID_ARGUMENT_STUBBORN'); await h.say(SEARCH_T);
    const r = await h.say('12497 ki 3A availability batao');
    const c = chain(r);
    expect(c.providerCallCount).toBe(0);
    expect(c.steps.map((x: any) => x.decisionReason)).toEqual(['REJECTED:INVALID_ARGUMENT', 'REJECTED:INVALID_REPEATED_CALL', 'REJECTED:TOOL_LOOP_DETECTED']);
    expect(c.chainStopReason).toBe('TOOL_LOOP_DETECTED');
    expect(r.voice.assistantText).toMatch(/\?/);
    expect(h.s().selectedTrain ?? null).toBeNull();
  });

  it('[15] forbidden tools (BOOK_TICKET / MAKE_PAYMENT) from the LLM → SAFETY_BLOCKED, nothing executed, state unchanged', async () => {
    const h = mk('FORBIDDEN_TOOL_ATTEMPT'); await h.say(SEARCH_T);
    const before = h.s().bookingState;
    const r = await h.say('Pehli wali book karke payment bhi kar do');
    expect(chain(r)).toMatchObject({ chainStopReason: 'SAFETY_BLOCKED', providerCallCount: 0 });
    expect(chain(r).steps.map((x: any) => x.decisionReason)).toEqual(['REJECTED:FORBIDDEN_ACTION', 'REJECTED:FORBIDDEN_ACTION']);
    expect(h.s().bookingState).toBe(before);
    expect(r.voice.assistantText).not.toMatch(/book ho gay|booked|payment (ho gaya|done|successful)|PNR/i);
  });
});
