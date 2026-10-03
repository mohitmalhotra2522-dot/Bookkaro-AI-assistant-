/**
 * PROMPT 17 — MockRailwayToolRuntime (Part 57).
 *
 * Deterministic test double around the REAL RailwayToolRuntime pipeline (registry → normalizer →
 * existing ToolCallValidator → limits → executor → normalization → result guard). Only the executor
 * is scripted. No randomness, no real network, no live data — every result is labelled mock.
 */
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import type { LLMToolResult, ToolExecutionRecord } from '@shared/railway-tool-runtime';
import type { ToolExecutionPlanNode } from '@shared/turn-engine';
import type { ToolCall } from '../tools/tool-registry';
import { ToolCallValidator, type ValidatedToolCall } from '../tools/tool-call-validator';
import type { ToolRetryPolicy } from './tool-retry-policy';
import { RailwayToolRuntime, type RailwayToolExecutor, type ExecutedCall, ToolTurn } from './railway-tool-runtime';
import { reconcileProviderAnswers } from './provider-conflict';
import type { ToolGrounding } from '../../booking/post-booking/post-booking-service';

export type MockToolScenario =
  | 'SEARCH_SUCCESS' | 'SEARCH_EMPTY' | 'TRAIN_INFO' | 'TIMETABLE' | 'AVAILABILITY' | 'FARE' | 'TRACK' | 'PNR'
  | 'CANCELLED_TRAINS' | 'TIMEOUT' | 'PROVIDER_FAILURE' | 'UNKNOWN_TOOL' | 'INVALID_ARGS' | 'MISSING_ARGS'
  | 'STALE_RESULT' | 'PARALLEL_SUCCESS' | 'PARTIAL_FAILURE' | 'LOOP' | 'PROVIDER_CONFLICT' | 'FRESH_REPEAT';

export const MOCK_TOOL_SCENARIOS: readonly MockToolScenario[] = [
  'SEARCH_SUCCESS', 'SEARCH_EMPTY', 'TRAIN_INFO', 'TIMETABLE', 'AVAILABILITY', 'FARE', 'TRACK', 'PNR',
  'CANCELLED_TRAINS', 'TIMEOUT', 'PROVIDER_FAILURE', 'UNKNOWN_TOOL', 'INVALID_ARGS', 'MISSING_ARGS',
  'STALE_RESULT', 'PARALLEL_SUCCESS', 'PARTIAL_FAILURE', 'LOOP', 'PROVIDER_CONFLICT', 'FRESH_REPEAT'
];

const META = (ms = 5) => ({ providerId: 'mock-tool-runtime', source: 'mock', latencyMs: ms, responseTimestamp: '2026-10-03T10:00:00.000Z', cache: 'disabled' });
const TRAINS = [
  { trainNumber: '12014', trainName: 'Shatabdi Express (MOCK)', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '10:50', duration: '5h 55m', classes: [{ code: 'CC' }, { code: '2S' }] },
  { trainNumber: '12497', trainName: 'Shan-e-Punjab (MOCK)', origin: 'ASR', destination: 'NDLS', departure: '05:10', arrival: '12:30', duration: '7h 20m', classes: [{ code: '3A' }, { code: 'CC' }, { code: 'SL' }, { code: '2S' }] }
];

export function mockToolSession(): BookingSession {
  return {
    sessionId: 'mock-tool-session', bookingState: BookingState.CLASS_SELECTED, sessionVersion: 1, searchResultsVersion: 1,
    origin: 'ASR', originName: 'Amritsar Junction', destination: 'NDLS', destinationName: 'New Delhi', date: '2026-10-04', passengersCount: 2,
    searchResults: { trains: TRAINS.map((t, i) => ({ ...t, displayIndex: i + 1 })), version: 1, resultId: 'rs-mock-1' } as any,
    selectedTrain: { number: '12497', name: 'Shan-e-Punjab (MOCK)', availableClasses: ['3A', 'CC', 'SL', '2S'] } as any,
    selectedClass: 'CC', passengers: [], mode: 'TEXT'
  } as any;
}

interface ScriptOptions { delayMs?: number; timeout?: boolean; failTools?: string[]; empty?: boolean; onCall?: (vt: ValidatedToolCall) => void }

/** Scripted executor: deterministic normalized responses per tool. Counts every provider call. */
export class ScriptedRailwayExecutor implements RailwayToolExecutor {
  readonly providerLabel = 'mock-tool-runtime';
  readonly calls: Array<{ tool: string; args: Record<string, any> }> = [];
  constructor(private readonly o: ScriptOptions = {}) {}
  async execute(vt: ValidatedToolCall, guard: { canApply: () => boolean }): Promise<any> {
    this.calls.push({ tool: vt.name, args: { ...vt.arguments } });
    this.o.onCall?.(vt);
    if (this.o.timeout) return new Promise(() => { /* never resolves → runtime TIMEOUT */ });
    if (this.o.delayMs) await new Promise(r => setTimeout(r, this.o.delayMs));
    if (this.o.failTools?.includes(vt.name)) return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock provider down.' }, meta: META() };
    if (!guard.canApply()) return { ok: false, error: { code: 'STALE_TOOL_RESULT', message: 'superseded' }, meta: META() };
    const a = vt.arguments;
    switch (vt.name) {
      case 'SEARCH_TRAINS': return this.o.empty
        ? { ok: false, error: { code: 'NO_TRAINS_FOUND', message: 'No trains (mock).' }, meta: META() }
        : { ok: true, data: { trains: TRAINS, origin: a.origin, destination: a.destination, date: a.date }, meta: META() };
      case 'GET_TRAIN_INFO': return { ok: true, data: { ...TRAINS.find(t => t.trainNumber === a.trainNumber) || TRAINS[1] }, meta: META() };
      case 'GET_TIMETABLE': return { ok: true, data: [{ station: 'ASR', departure: '05:10' }, { station: 'LDH', arrival: '07:20', departure: '07:25' }, { station: 'NDLS', arrival: '12:30' }], meta: META() };
      case 'CHECK_AVAILABILITY': return { ok: true, data: { trainNumber: a.trainNumber, travelClass: a.travelClass, date: a.date, status: 'RAC 4' }, meta: META() };
      case 'GET_FARE': return { ok: true, data: { trainNumber: a.trainNumber, travelClass: a.travelClass, perPassenger: 490, passengersCount: a.passengersCount, total: 490 * (a.passengersCount || 1) }, meta: META() };
      case 'TRACK_TRAIN': return { ok: true, data: { trainNumber: a.trainNumber, currentStatus: 'RUNNING', currentStationCode: 'LDH', delayMinutes: 12, dataSource: 'MOCK' }, meta: META() };
      case 'CHECK_PNR': return { ok: true, data: { pnr: a.pnr, pnrMasked: `${String(a.pnr).slice(0, 2)}******${String(a.pnr).slice(-2)}`, pnrStatus: 'CNF', dataSource: 'MOCK' }, meta: META() };
    }
    return { ok: false, error: { code: 'TOOL_FAILED', message: 'unsupported' }, meta: META() };
  }
}

export interface ScenarioOutcome {
  scenario: MockToolScenario;
  results: LLMToolResult[];
  records: ToolExecutionRecord[];
  providerCalls: number;
  stopped: boolean;
  session: BookingSession;
  conflict?: { code: string; providers: string[] };
}

const call = (name: string, args: Record<string, any> = {}, id?: string): ToolCall => ({ callId: id || `c-${name}-${Math.abs(hash(JSON.stringify(args)))}`, name: name as any, arguments: args });
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

export class MockRailwayToolRuntime {
  private readonly validator = new ToolCallValidator();
  /** Prompt 18: retry policy pass-through; backoff sleep is a no-op by default (deterministic, no real waiting). */
  constructor(private readonly opts: { timeoutMs?: number; retryPolicy?: ToolRetryPolicy; sleep?: (ms: number) => Promise<void> } = {}) {}

  /** Run ONE turn's calls through the real runtime with a scripted executor. */
  async runTurn(calls: ToolCall[][], session: BookingSession, userText: string, executor: ScriptedRailwayExecutor, turnId = 't1'): Promise<{ results: LLMToolResult[]; records: ToolExecutionRecord[]; stopped: boolean; plans: ToolExecutionPlanNode[] }> {
    const rt = new RailwayToolRuntime({ timeoutMs: this.opts.timeoutMs ?? 50, retryPolicy: this.opts.retryPolicy, sleep: this.opts.sleep ?? (async () => { /* no real backoff in mocks */ }) });
    const ground: ToolGrounding = { userText, bookings: [], pnrOwner: () => 'NONE', bookingOwner: () => 'NONE' };
    const turn = rt.beginTurn({
      sessionId: session.sessionId, turnId, requestId: `req-${turnId}`, userText, getSession: () => session,
      validate: (tc, s) => this.validator.validate(tc, s, ground) as any
    });
    const results: LLMToolResult[] = [];
    let stopped = false;
    for (const round of calls) {
      if (!turn.startRound()) { stopped = true; break; }
      const r = await turn.runRound(round, executor, {
        fromLLM: true,
        onRejected: p => { results.push(p.result); },
        onExecuted: (x: ExecutedCall) => {
          if (x.prepared.vt.name !== 'SEARCH_TRAINS' && !turn.isCurrent(x.prepared)) {
            x.record.status = 'CANCELLED'; x.record.rejectionReason = 'STALE_TOOL_RESULT';
            results.push({ ...x.result, status: 'CANCELLED', fresh: false, result: undefined, error: { code: 'STALE_TOOL_RESULT', message: 'Purana result ignore kiya gaya.' } });
            return true;
          }
          results.push(x.result);
          return true;
        }
      });
      if (r === 'stop') { stopped = true; break; }
    }
    return { results, records: turn.records, stopped, plans: turn.plans };
  }

  async run(scenario: MockToolScenario): Promise<ScenarioOutcome> {
    const s = mockToolSession();
    const out = (r: { results: LLMToolResult[]; records: ToolExecutionRecord[]; stopped: boolean }, ex: ScriptedRailwayExecutor, extra: Partial<ScenarioOutcome> = {}): ScenarioOutcome =>
      ({ scenario, results: r.results, records: r.records, stopped: r.stopped, providerCalls: ex.calls.length, session: s, ...extra });
    const SEARCH = call('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: '2026-10-04' });
    switch (scenario) {
      case 'SEARCH_SUCCESS': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[SEARCH]], s, 'Amritsar se Delhi kal', ex), ex); }
      case 'SEARCH_EMPTY': { const ex = new ScriptedRailwayExecutor({ empty: true }); return out(await this.runTurn([[SEARCH]], s, 'Amritsar se Delhi kal', ex), ex); }
      case 'TRAIN_INFO': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('GET_TRAIN_INFO', { trainNumber: '12014' })]], s, '12014 ke baare mein batao', ex), ex); }
      case 'TIMETABLE': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('GET_TIMETABLE', { trainNumber: '12497' })]], s, '12497 ka timetable', ex), ex); }
      case 'AVAILABILITY': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('CHECK_AVAILABILITY', {})]], s, 'availability batao', ex), ex); }
      case 'FARE': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('GET_FARE', {})]], s, 'fare batao', ex), ex); }
      case 'TRACK': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('TRACK_TRAIN', { trainNumber: '12497' })]], s, '12497 ka live status', ex), ex); }
      case 'PNR': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('CHECK_PNR', { pnr: '4512345678' })]], s, 'PNR 4512345678 check karo', ex), ex); }
      case 'CANCELLED_TRAINS': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('GET_CANCELLED_TRAINS', {})]], s, 'aaj ki cancelled trains', ex), ex); }
      case 'TIMEOUT': { const ex = new ScriptedRailwayExecutor({ timeout: true }); return out(await this.runTurn([[call('CHECK_AVAILABILITY', {})]], s, 'availability batao', ex), ex); }
      case 'PROVIDER_FAILURE': { const ex = new ScriptedRailwayExecutor({ failTools: ['GET_FARE'] }); return out(await this.runTurn([[call('GET_FARE', {})]], s, 'fare batao', ex), ex); }
      case 'UNKNOWN_TOOL': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('BOOK_TICKET_NOW', { trainNumber: '12497' }), call('CANCEL_BOOKING', {})]], s, 'book karo', ex), ex); }
      case 'INVALID_ARGS': { const ex = new ScriptedRailwayExecutor(); return out(await this.runTurn([[call('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: '2026-10-04', password: 'x' }), call('CHECK_PNR', { pnr: '9876543210' })]], s, 'search karo', ex), ex); }
      case 'MISSING_ARGS': {
        const ex = new ScriptedRailwayExecutor();
        const s2: any = { ...s, origin: undefined, destination: undefined, date: undefined, searchResults: undefined, selectedTrain: undefined, selectedClass: undefined, bookingState: BookingState.IDLE };
        const r = await this.runTurn([[call('SEARCH_TRAINS', { origin: 'ASR' }), call('GET_FARE', {})]], s2, 'train dikhao', ex);
        return { ...out(r, ex), session: s2 };
      }
      case 'STALE_RESULT': {
        // the journey date changes while availability is in flight → journeyVersion moves → not applied
        const ex = new ScriptedRailwayExecutor({ delayMs: 5, onCall: () => { setTimeout(() => { s.date = '2026-10-05'; }, 1); } });
        return out(await this.runTurn([[call('CHECK_AVAILABILITY', {})]], s, 'availability', ex), ex);
      }
      case 'PARALLEL_SUCCESS': { const ex = new ScriptedRailwayExecutor({ delayMs: 20 }); return out(await this.runTurn([[call('GET_TIMETABLE', { trainNumber: '12497' }), call('CHECK_AVAILABILITY', {}), call('GET_FARE', {})]], s, 'timetable, availability aur fare', ex), ex); }
      case 'PARTIAL_FAILURE': { const ex = new ScriptedRailwayExecutor({ failTools: ['CHECK_AVAILABILITY'] }); return out(await this.runTurn([[call('GET_TIMETABLE', { trainNumber: '12497' }), call('CHECK_AVAILABILITY', {})]], s, 'timetable aur availability', ex), ex); }
      case 'LOOP': { const ex = new ScriptedRailwayExecutor(); const c = () => call('GET_TIMETABLE', { trainNumber: '12497' }); return out(await this.runTurn([[c()], [c()], [c()], [c()]], s, 'timetable', ex), ex); }
      case 'PROVIDER_CONFLICT': {
        const ex = new ScriptedRailwayExecutor();
        const r = await this.runTurn([[call('CHECK_AVAILABILITY', {})]], s, 'availability', ex);
        // a second (hypothetical) provider disagrees → never merged
        const rec = reconcileProviderAnswers([
          { provider: 'mock-tool-runtime', ok: true, data: (r.results[0] as any)?.result },
          { provider: 'mock-secondary', ok: true, data: { ...(r.results[0] as any)?.result, status: 'WL 12' } }
        ]);
        return out(r, ex, { conflict: rec.ok ? undefined : { code: rec.code, providers: rec.providers } });
      }
      case 'FRESH_REPEAT': {
        const ex = new ScriptedRailwayExecutor();
        const a = await this.runTurn([[call('CHECK_AVAILABILITY', {}, 'x1')]], s, 'availability batao', ex, 't1');
        const b = await this.runTurn([[call('CHECK_AVAILABILITY', {}, 'x2')]], s, 'abhi dobara check karo', ex, 't2');
        return out({ results: [...a.results, ...b.results], records: [...a.records, ...b.records], stopped: false }, ex);
      }
    }
  }
}

export { ToolTurn };
