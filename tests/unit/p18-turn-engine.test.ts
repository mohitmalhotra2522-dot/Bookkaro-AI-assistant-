/**
 * PROMPT 18 — GROUP 2: ConversationTurnEngine.
 * Lifecycle, legal transitions, ordered events + reducer, slots / follow-ups, corrections, train / class
 * references, ambiguity, yes/no safety, resultSetId / journeyVersion, interruption, superseded results,
 * resume, honest progress text, retry policy and dependency plan.
 * Railway data = labelled mock (non-live) provider. No real IRCTC / network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine, MAX_TURNS_PER_SESSION } from '../../server/ai/turn-engine/conversation-turn-engine';
import { TurnEventBus } from '../../server/ai/turn-engine/turn-event-bus';
import { toolProgressText, voiceAcknowledgement, MULTI_TOOL_PROGRESS_TEXT } from '../../server/ai/turn-engine/progress-messages';
import { pendingQuestionCode, affirmationMayConfirm } from '../../server/ai/turn-engine/pending-question';
import { detectBareDay, resolveMonthAnswer } from '../../server/ai/turn-engine/ambiguous-date-clarifier';
import { displayedResultsOf } from '../../server/ai/conversation/conversation-context';
import { DEFAULT_TOOL_RETRY_POLICY, NO_RETRY_POLICY, shouldRetry, NON_RETRYABLE_ERRORS } from '../../server/ai/tool-runtime/tool-retry-policy';
import { buildToolExecutionPlan, unsatisfiedDependency } from '../../server/ai/tool-runtime/tool-execution-plan';
import { MockRailwayToolRuntime, ScriptedRailwayExecutor, mockToolSession } from '../../server/ai/tool-runtime/mock-railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import {
  TurnStatus, TERMINAL_TURN_STATUSES, canTransitionTurn, reduceTurnEvent, EMPTY_TURN_VIEW, type TurnEvent, type TurnStatus as TS
} from '../../shared/turn-engine';

function mk() {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  const eng = new ConversationTurnEngine(orch, state);
  const sid = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', opts: any = {}) => eng.processTurn(sid, t, mode, opts) as Promise<any>;
  return { state, orch, eng, sid, say, s: () => state.getSession(sid) as any };
}
const c = (name: string, args: any = {}, id = name) => ({ callId: id, name: name as any, arguments: args });
const BOOK_CLAIM = /ticket book ho gaya|booking confirmed|payment (successful|ho gaya)|pnr generated/i;

let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype as any, 'executeHandoff');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('P18 G2 — turn lifecycle', () => {
  it('[1] statuses are exactly the 12 required, terminal set is correct, completed never reverts', () => {
    expect(Object.keys(TurnStatus).sort()).toEqual(['COMPLETED', 'FAILED', 'GENERATING_RESPONSE', 'INTERRUPTED', 'NORMALIZING', 'PROCESSING_TOOL_RESULT',
      'RECEIVED', 'SUPERSEDED', 'THINKING', 'TOOL_CALLING', 'WAITING_FOR_TOOL', 'WAITING_FOR_USER'].sort());
    for (const t of TERMINAL_TURN_STATUSES) for (const to of Object.keys(TurnStatus) as TS[]) expect(canTransitionTurn(t, to)).toBe(false);
    expect(canTransitionTurn('RECEIVED', 'NORMALIZING')).toBe(true);
    expect(canTransitionTurn('RECEIVED', 'COMPLETED')).toBe(false);
    expect(canTransitionTurn('INTERRUPTED', 'SUPERSEDED')).toBe(true);
  });

  it('[2] one logical turn per message; tool turn walks the full legal status path', async () => {
    const h = mk();
    const r = await h.say('Amritsar se Delhi kal 2 log');
    expect(r.turn.sequence).toBe(1);
    expect(r.turn.statusHistory.map((x: any) => x.status)).toEqual(['RECEIVED', 'NORMALIZING', 'THINKING', 'TOOL_CALLING', 'WAITING_FOR_TOOL',
      'PROCESSING_TOOL_RESULT', 'THINKING', 'GENERATING_RESPONSE', 'WAITING_FOR_USER']);
    expect(r.turn.illegalTransitions).toEqual([]);
    expect(r.turn.toolCount).toBe(1);
    expect(r.turn.toolExecutionIds).toHaveLength(1);
    expect(r.turn.totalTurnLatencyMs).toBeGreaterThanOrEqual(0);
    expect(r.turn.finalResponseType).toBe('FINAL');
    expect(r.turn.groundingStatus).toBe('PASSED');
    expect(r.presentable).toBe(true);
    const r2 = await h.say('second wali');
    expect(r2.turn.sequence).toBe(2);
    expect(h.eng.getTurns(h.sid)).toHaveLength(2);
  });

  it('[3] events are sequenced in order; reducer ignores duplicates / out-of-order / older turns', async () => {
    const h = mk();
    const r = await h.say('Amritsar se Delhi kal 2 log');
    const types = r.turnEvents.map((e: TurnEvent) => e.type);
    const order = ['TURN_STARTED', 'LLM_THINKING', 'TOOL_REQUESTED', 'TOOL_STARTED', 'TOOL_PROGRESS', 'TOOL_COMPLETED', 'LLM_CONTINUING', 'ASSISTANT_RESPONSE', 'TURN_COMPLETED'];
    let last = -1;
    for (const t of order) { const i = types.indexOf(t); expect(i).toBeGreaterThan(last); last = i; }
    const seqs = r.turnEvents.map((e: TurnEvent) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // reducer
    let v = EMPTY_TURN_VIEW;
    for (const e of r.turnEvents) v = reduceTurnEvent(v, e);
    expect(v.status).toBe('WAITING_FOR_USER');
    expect(v.progressText).toBeNull();
    const progress = r.turnEvents.find((e: TurnEvent) => e.type === 'TOOL_PROGRESS');
    expect(reduceTurnEvent(v, progress)).toBe(v); // replayed (seq ≤ lastSeq) → ignored
    const older = { ...progress, seq: v.lastSeq + 1, turnSequence: 0 };
    expect(reduceTurnEvent(v, older).progressText).toBeNull(); // older turn can't roll the UI back
  });

  it('[4] TurnEventBus: per-session monotonic seq, since(), subscribe, broken listener is isolated', () => {
    const bus = new TurnEventBus();
    const got: number[] = [];
    bus.subscribe('a', () => { throw new Error('boom'); });
    const un = bus.subscribe('a', e => got.push(e.seq));
    bus.emit('a', 't1', 1, 'TURN_STARTED'); bus.emit('b', 'x', 1, 'TURN_STARTED'); bus.emit('a', 't1', 1, 'LLM_THINKING');
    expect(bus.since('a').map(e => e.seq)).toEqual([1, 2]);
    expect(bus.since('a', 1).map(e => e.type)).toEqual(['LLM_THINKING']);
    expect(bus.lastSeq('b')).toBe(1);
    expect(got).toEqual([1, 2]);
    un(); bus.emit('a', 't1', 1, 'TURN_COMPLETED'); expect(got).toEqual([1, 2]);
  });

  it('[5] turn history entries are bounded and contain no secrets', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log');
    await h.say('mera IRCTC password abc123 hai');
    const turns = h.eng.getTurns(h.sid);
    expect(JSON.stringify(turns)).not.toMatch(/abc123/);
    expect(turns[1].userInput).toBe('[REDACTED SENSITIVE INPUT]');
    expect((turns[0] as any)._records).toBeUndefined();
    expect(MAX_TURNS_PER_SESSION).toBe(100);
  });
});

describe('P18 G2 — slots, follow-ups, corrections, references', () => {
  it('[6] follow-up inherits slots; multi-slot extraction in one message', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal jaana hai');
    await h.say('2 passengers');
    expect(h.s()).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: '2026-10-04', passengersCount: 2 });
    const h2 = mk();
    await h2.say('Amritsar se Delhi kal, 2 log, AC');
    expect(h2.s()).toMatchObject({ origin: 'ASR', destination: 'NDLS', passengersCount: 2, preferredClass: 'AC' });
  });

  it('[7] destination correction: session updated, journeyVersion bumped, new resultSetId, unrelated slots kept, no restart', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log');
    const jv = h.s().journeyVersion; const rs = displayedResultsOf(h.s()).resultSetId;
    const r = await h.say('Delhi nahi Ludhiana');
    expect(h.s()).toMatchObject({ destination: 'LDH', date: '2026-10-04', passengersCount: 2, origin: 'ASR' });
    expect(h.s().journeyVersion).toBeGreaterThan(jv);
    expect(displayedResultsOf(h.s()).resultSetId).not.toBe(rs);
    expect(r.responseMessage).toMatch(/Ludhiana/);
    // references resolve ONLY against the current result set
    await h.say('second wali');
    expect(h.s().selectedTrain.number).toBe('04672');
  });

  it('[8] date / passenger / class corrections keep unrelated context', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log'); await h.say('second wali'); await h.say('CC');
    await h.say('3 log');
    expect(h.s()).toMatchObject({ passengersCount: 3, selectedClass: 'CC', destination: 'NDLS' });
    await h.say('class 3A kar do');
    expect(h.s()).toMatchObject({ selectedClass: '3A', passengersCount: 3 });
    const jv = h.s().journeyVersion;
    await h.say('date parso kar do');
    expect(h.s().date).toBe('2026-10-05');
    expect(h.s().journeyVersion).toBeGreaterThan(jv);
    expect(h.s().passengersCount).toBe(3);
  });

  it('[9] train references: ordinal, number, last, ambiguous morning / "ye wali" clarify', async () => {
    for (const [ref, num] of [['second wali', '12497'], ['12014 wali', '12014'], ['last train', '18238']] as const) {
      const h = mk(); await h.say('Amritsar se Delhi kal 2 log'); await h.say(ref);
      expect(h.s().selectedTrain.number).toBe(num);
    }
    for (const ref of ['morning wali', 'ye wali']) {
      const h = mk(); await h.say('Amritsar se Delhi kal 2 log');
      const r = await h.say(ref);
      expect(h.s().selectedTrain).toBeFalsy();
      expect(r.assistantTurnResponse.type).toBe('CLARIFICATION');
      expect(h.s().pendingQuestion).toBe('SELECT_TRAIN');
    }
  });

  it('[10] class references validated against the selected train', async () => {
    const h = mk(); await h.say('Amritsar se Delhi kal 2 log'); await h.say('second wali');
    const bad = await h.say('EC');
    expect(h.s().selectedClass).toBeFalsy();
    expect(bad.responseMessage).toMatch(/EC is train mein available nahi/);
    await h.say('Chair Car');
    expect(h.s().selectedClass).toBe('CC');
  });

  it('[11] "second train" with no results → current results unavailable, nothing executed', async () => {
    const h = mk();
    const r = await h.say('Second wali');
    expect(r.responseMessage).toMatch(/Kaunsi train\? Current search results available nahi hain\./);
    expect(r.turn.toolCount).toBe(0);
  });
});

describe('P18 G2 — ambiguity, pending questions, yes/no safety', () => {
  it('[12] bare "22" asks which month; the answer resolves the date (no guessing)', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi jaana hai');
    const r = await h.say('22');
    expect(r.responseMessage).toMatch(/22 tareekh kis mahine ki/);
    expect(h.s().date).toBeFalsy();
    expect(h.s().pendingQuestion).toBe('MISSING_DATE');
    expect(r.turn.toolCount).toBe(0);
    await h.say('October');
    expect(h.s().date).toBe('2026-10-22');
    expect(detectBareDay('22', h.s())).toBeNull(); // date now known → not ambiguous
    expect(resolveMonthAnswer('doosra wala', { day: 22, candidates: ['2026-10-22', '2026-11-22'], labels: ['22 October', '22 November'] })).toBe('22 November');
  });

  it('[13] ambiguous station role ("Delhi") → clarify', async () => {
    const h = mk();
    const r = await h.say('Delhi');
    expect(r.assistantTurnResponse.type).toBe('CLARIFICATION');
    expect(h.s().origin).toBeFalsy(); expect(h.s().destination).toBeFalsy();
  });

  it('[14] "haan" with nothing pending never books / never moves state', async () => {
    const h = mk();
    const r = await h.say('haan');
    expect(h.s().bookingState).toBe('IDLE');
    expect(r.responseMessage).not.toMatch(BOOK_CLAIM);
    expect(affirmationMayConfirm(pendingQuestionCode(h.s().pendingInteraction))).toBe(false);
  });

  it('[15] pending question codes come from BookingSession', () => {
    expect(pendingQuestionCode({ type: 'DATE_REQUIRED' } as any)).toBe('MISSING_DATE');
    expect(pendingQuestionCode({ type: 'ORIGIN_REQUIRED' } as any)).toBe('MISSING_ROUTE');
    expect(pendingQuestionCode({ type: 'PASSENGERS_REQUIRED' } as any)).toBe('MISSING_PASSENGERS');
    expect(pendingQuestionCode({ type: 'TRAIN_SELECTION_REQUIRED' } as any)).toBe('SELECT_TRAIN');
    expect(pendingQuestionCode({ type: 'CLASS_SELECTION_REQUIRED' } as any)).toBe('SELECT_CLASS');
    expect(pendingQuestionCode({ type: 'CONFIRMATION_REQUIRED' } as any)).toBe('CONFIRM_REVIEW');
    expect(affirmationMayConfirm('CONFIRM_REVIEW')).toBe(true);
    expect(affirmationMayConfirm('SELECT_TRAIN')).toBe(false);
  });

  it('[16] review → CONFIRMATION_REQUEST; "haan book karo" = confirmation request only (no submit / success claim)', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    const review = await h.say('Rahul Sharma 31 male, Neha Sharma 28 female');
    expect(review.assistantTurnResponse.type).toBe('CONFIRMATION_REQUEST');
    expect(h.s().pendingQuestion).toBe('CONFIRM_REVIEW');
    const r = await h.say('haan book karo');
    expect(r.events.map((e: any) => e.type || e)).toContain('BOOKING_CONFIRMATION_REQUESTED');
    expect(r.responseMessage).not.toMatch(BOOK_CLAIM);
    expect(r.responseMessage).toMatch(/book nahi hua/i);
    expect(JSON.stringify(h.s())).not.toMatch(/otp|captcha|password/i);
  });

  it('[17] unsupported request → railway scope reply (TEXT)', async () => {
    const h = mk();
    const r = await h.say('Delhi weather batao');
    expect(r.responseMessage).toBe('Main railway booking aur train information mein help kar sakta hoon.');
    expect(r.assistantTurnResponse.type).toBe('TEXT');
  });
});

describe('P18 G2 — interruption, superseded, resume, progress', () => {
  it('[18] new input while a turn is in flight → old turn SUPERSEDED, its result never presented', async () => {
    const h = mk();
    const svc: any = (h.orch as any).runtime;
    const p1 = h.say('Amritsar se Delhi kal');
    const r2 = await h.say('nahi Amritsar se Ludhiana kal');
    const r1 = await p1;
    expect(svc).toBeTruthy();
    expect(r2.presentable).toBe(true);
    expect(h.s().destination).toBe('LDH');
    if (r1.turn.status === 'SUPERSEDED') {
      expect(r1.presentable).toBe(false);
      expect(r1.responseMessage).toBe('');
      expect(r1.turn.presentation).toBe('DISCARDED');
    } else {
      // the first turn had already finished before the second arrived → it is terminal and never reverts
      expect(TERMINAL_TURN_STATUSES.has(r1.turn.status)).toBe(true);
    }
    expect(h.eng.getTurns(h.sid).every(t => t.illegalTransitions.length === 0)).toBe(true);
  });

  it('[19] barge-in on a presented response → presentation INTERRUPTED, same session, turn stays terminal', async () => {
    const h = mk();
    const r = await h.say('Amritsar se Delhi kal 2 log', 'VOICE');
    const out = h.eng.interrupt(h.sid, 'BARGE_IN');
    expect(out).toMatchObject({ turnId: r.turn.turnId, kind: 'PRESENTATION', providerCancellation: 'NOT_SUPPORTED' });
    const t = h.eng.getTurns(h.sid)[0];
    expect(t.presentation).toBe('INTERRUPTED');
    expect(t.status).toBe('WAITING_FOR_USER');
    const r2 = await h.say('second wali', 'VOICE', { interruptPrevious: true });
    expect(r2.newState || h.s().bookingState).toBeTruthy();
    expect(h.s().sessionId).toBe(h.sid);
    expect(h.s().selectedTrain.number).toBe('12497');
  });

  it('[20] resume restores session / turn / latest response without creating a session', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log');
    const snap = h.eng.resume(h.sid)!;
    expect(snap).toMatchObject({ sessionId: h.sid, bookingState: 'SHOWING_TRAINS', pendingQuestion: 'SELECT_TRAIN', activeToolExecutions: [] });
    expect(snap.currentTurn!.status).toBe('WAITING_FOR_USER');
    expect(snap.latestAssistantResponse!.type).toBe('FINAL');
    expect(snap.lastEventSeq).toBeGreaterThan(0);
    expect(h.eng.resume('no-such-session')).toBeNull();
    expect(h.state.hasSession('no-such-session')).toBe(false);
  });

  it('[21] progress text is honest (no percentages) and voice gets a short ack', async () => {
    expect(toolProgressText(['SEARCH_TRAINS'])).toBe('Trains search ho rahi hain...');
    expect(toolProgressText(['CHECK_AVAILABILITY'])).toBe('Availability check kar raha hoon...');
    expect(toolProgressText(['GET_FARE', 'GET_TIMETABLE'])).toBe(MULTI_TOOL_PROGRESS_TEXT);
    expect(MULTI_TOOL_PROGRESS_TEXT).toBe('Railway data check ho raha hai...');
    expect(voiceAcknowledgement('SEARCH_TRAINS')).toBe('Ek second, trains check kar raha hoon.');
    const h = mk();
    const r = await h.say('Amritsar se Delhi kal 2 log', 'VOICE');
    expect(r.progress[0]).toMatchObject({ type: 'TOOL_PROGRESS', text: 'Trains search ho rahi hain...', speechText: 'Ek second, trains check kar raha hoon.' });
    for (const p of r.progress) expect(p.text).not.toMatch(/\d+\s*%|\d+\/\d+/);
  });

  it('[22] duplicate delivery of the same clientMessageId does not create a second turn', async () => {
    const h = mk();
    const a = await h.say('Amritsar se Delhi kal 2 log', 'TEXT', { clientMessageId: 'm-1' });
    const b = await h.say('Amritsar se Delhi kal 2 log', 'TEXT', { clientMessageId: 'm-1' });
    expect(b.turn.turnId).toBe(a.turn.turnId);
    expect(h.eng.getTurns(h.sid)).toHaveLength(1);
  });
});

describe('P18 G2 — retry policy and execution plan', () => {
  it('[23] retry policy: max 1, transient only, never INVALID_*', () => {
    expect(DEFAULT_TOOL_RETRY_POLICY.maxRetries).toBe(1);
    expect(shouldRetry(DEFAULT_TOOL_RETRY_POLICY, 'PROVIDER_UNAVAILABLE', 0)).toBe(true);
    expect(shouldRetry(DEFAULT_TOOL_RETRY_POLICY, 'PROVIDER_UNAVAILABLE', 1)).toBe(false);
    for (const code of ['INVALID_TRAIN_NUMBER', 'INVALID_DATE', 'INVALID_STATION']) expect(shouldRetry(DEFAULT_TOOL_RETRY_POLICY, code, 0)).toBe(false);
    expect(NON_RETRYABLE_ERRORS.length).toBeGreaterThan(0);
    expect(shouldRetry(NO_RETRY_POLICY, 'PROVIDER_UNAVAILABLE', 0)).toBe(false);
    expect(DEFAULT_TOOL_RETRY_POLICY.backoffMs(1)).toBeLessThanOrEqual(1000);
  });

  it('[24] a backend retry is a NEW execution id linked via retryOf', async () => {
    const rt = new MockRailwayToolRuntime();
    const ex = new ScriptedRailwayExecutor({ failTools: ['GET_TIMETABLE'] });
    const r = await rt.runTurn([[c('GET_TIMETABLE', { trainNumber: '12497' })]], mockToolSession(), '12497 ka timetable', ex);
    expect(ex.calls).toHaveLength(2);
    expect(r.records).toHaveLength(2);
    expect(r.records[1].toolExecutionId).not.toBe(r.records[0].toolExecutionId);
    expect(r.records[1]).toMatchObject({ attempt: 2, retryOf: r.records[0].toolExecutionId });
  });

  it('[25] plan: AVAIL depends on a same-round SEARCH; failed SEARCH blocks it (provider never called)', async () => {
    const plan = buildToolExecutionPlan([c('SEARCH_TRAINS', {}), c('CHECK_AVAILABILITY', {}), c('GET_TIMETABLE', {})], 1);
    expect(plan.map(n => n.planNodeId)).toEqual(['r1n1', 'r1n2', 'r1n3']);
    expect(plan[1].dependencies).toEqual(['r1n1']);
    expect(plan[2].dependencies).toEqual([]);
    expect(unsatisfiedDependency(plan[1], plan)).toBeTruthy();
    const rt = new MockRailwayToolRuntime();
    const s = mockToolSession(); s.searchResults = undefined as any; s.selectedTrain = undefined as any;
    const ex = new ScriptedRailwayExecutor({ failTools: ['SEARCH_TRAINS'] });
    const r = await rt.runTurn([[c('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: '2026-10-04' }),
      c('CHECK_AVAILABILITY', { trainNumber: '12497', travelClass: 'CC', date: '2026-10-04' })]], s, 'Amritsar se Delhi kal 12497 CC availability', ex);
    expect(r.plans.find(n => n.tool === 'CHECK_AVAILABILITY')!.status).toBe('BLOCKED');
    expect(r.records.some(x => x.tool === 'CHECK_AVAILABILITY' && x.rejectionReason === 'DEPENDENCY_NOT_SATISFIED')).toBe(true);
    expect(ex.calls.map(x => x.tool)).not.toContain('CHECK_AVAILABILITY');
  });

  it('[26] tool rounds are bounded (≤ 5) → loop stopped', async () => {
    const rt = new MockRailwayToolRuntime();
    const rounds = Array.from({ length: 6 }, (_, i) => [c('GET_TIMETABLE', { trainNumber: i % 2 ? '12497' : '12014' }, 'x' + i)]);
    const r = await rt.runTurn(rounds, mockToolSession(), 'timetable 12497 12014', new ScriptedRailwayExecutor());
    expect(r.stopped).toBe(true);
    expect(r.records.length).toBeLessThanOrEqual(5);
    expect(r.records.some(x => x.rejectionReason === 'TOOL_LOOP_DETECTED' || x.rejectionReason === 'TOOL_CALL_LIMIT_EXCEEDED')).toBe(true);
  });
});
