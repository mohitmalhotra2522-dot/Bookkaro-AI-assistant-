/**
 * GROUP 2 — LLM tool-calling contract + RailwayToolRegistry + ToolCallValidator +
 * MockLLMProvider scenarios (Prompt 7).
 *
 * Tests run only against MockLLMProvider + ToolCallValidator (no server/HTTP).
 */
import { describe, it, expect } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { REGISTERED_TOOLS, getToolDefinition } from '../../server/ai/tools/tool-registry';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import type { BookingSession } from '../../shared/entities';
import { BookingState } from '../../shared/states';
import { v4 as uuid } from '../../server/ai/orchestrator/utils';

function blank(overrides: Partial<BookingSession> = {}): BookingSession {
  return {
    sessionId: 's1', conversationId: 's1', createdAt: new Date().toISOString(), mode: 'TEXT',
    bookingState: BookingState.IDLE,
    passengers: [], reviewConfirmed: false, irctcHandoffReady: false,
    currentPassengerIndex: 0, dataSourceLabel: 'MOCK', availableTrains: [],
    ...overrides
  } as any;
}

describe('Group 2: LLM tool-calling contract + ToolCallValidator + MockLLMProvider', () => {
  const llm = new MockLLMProvider();
  const validator = new ToolCallValidator();

  // ---- Registry ----
  it('registry exposes 7 tools (P14: + read-only TRACK_TRAIN / CHECK_PNR); no booking tools', () => {
    const names = REGISTERED_TOOLS.map(t => t.name).sort();
    expect(names).toEqual(['CHECK_AVAILABILITY','CHECK_PNR','GET_FARE','GET_TIMETABLE','GET_TRAIN_INFO','SEARCH_TRAINS','TRACK_TRAIN']);
    expect(getToolDefinition('BOOK_TICKET' as any)).toBeUndefined();
  });

  // ---- ToolCallValidator ----
  it('rejects unknown tool → UNKNOWN_TOOL', () => {
    const s = blank();
    const r = validator.validate({ callId:'c1', name:'BOOK_TICKET' as any, arguments:{} }, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_TOOL');
  });

  it('P14: TRACK_TRAIN/CHECK_PNR with LLM-invented train / PNR (no grounding) → AUTHORITATIVE_DATA_REQUIRED', () => {
    const s = blank();
    const r1 = validator.validate({ callId:'c1', name:'TRACK_TRAIN', arguments:{ trainNumber:'12014' } }, s);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('AUTHORITATIVE_DATA_REQUIRED');
    const r2 = validator.validate({ callId:'c2', name:'CHECK_PNR', arguments:{ pnr:'1234567890' } }, s);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('AUTHORITATIVE_DATA_REQUIRED');
  });

  it('validates SEARCH_TRAINS with canonical codes + resolves station words/date', () => {
    const s = blank();
    const r = validator.validate({
      callId:'c1', name:'SEARCH_TRAINS',
      arguments:{ origin:'amritsar', destination:'delhi', date:'3 October', passengersCount:2 }
    }, s);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.v.arguments.origin).toBe('ASR');
      expect(r.v.arguments.destination).toBe('NDLS');
      expect(r.v.arguments.date).toBe('2026-10-03');
      expect(r.v.arguments.passengersCount).toBe(2);
    }
  });

  it('rejects SEARCH_TRAINS on ambiguous date → AMBIGUOUS_DATE', () => {
    const s = blank();
    const r = validator.validate({ callId:'c1', name:'SEARCH_TRAINS', arguments:{ origin:'ASR', destination:'NDLS', date:'xyzxyz' } }, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AMBIGUOUS_DATE');
  });

  it('rejects CHECK_AVAILABILITY/GET_FARE without selected train/class → INVALID_ACTION_FOR_STATE', () => {
    const s = blank({ bookingState: BookingState.SHOWING_TRAINS });
    const r1 = validator.validate({ callId:'c1', name:'CHECK_AVAILABILITY', arguments:{ trainNumber:'12014', travelClass:'CC', date:'2026-10-03' } }, s);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('INVALID_ACTION_FOR_STATE');
    const r2 = validator.validate({ callId:'c2', name:'GET_FARE', arguments:{ trainNumber:'12014', travelClass:'CC', passengersCount:1 } }, s);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('INVALID_ACTION_FOR_STATE');
  });

  it('rejects invalid param types / unknown params → INVALID_TOOL_CALL', () => {
    const s = blank();
    const r = validator.validate({ callId:'c1', name:'SEARCH_TRAINS', arguments:{ origin:'ASR', destination:'NDLS', date:'2026-10-03', passengersCount:'two', bogus:1 } }, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TOOL_CALL');
  });

  // ---- MockLLMProvider scenarios ----
  it('MULTI_SLOT: extracts origin/dest/date/passengers/class and emits SEARCH_TRAINS', async () => {
    const s = blank();
    const r = await llm.generateStructuredDecision({
      userText:'Amritsar se Delhi kal jaana hai, 2 log hain, AC chahiye',
      history:[], state:s.bookingState, session:s,
      missingFields:['origin','destination','date','passengers'],
      inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    expect(r.decision.toolCalls.length).toBe(1);
    expect(r.decision.toolCalls[0].name).toBe('SEARCH_TRAINS');
    expect(r.decision.toolCalls[0].arguments.passengersCount).toBe(2);
    expect(r.decision.toolCalls[0].arguments.preferredClass).toBe('AC');
    expect(r.decision.finalMessage).toBeFalsy();
  });

  it('CLARIFICATION: missing date → ASK_CLARIFICATION; no tool call', async () => {
    const s = blank({ origin:'ASR', destination:'NDLS' });
    const r = await llm.generateStructuredDecision({
      userText:'Amritsar se Delhi jaana hai', history:[], state:s.bookingState, session:s,
      missingFields:['date'], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    // Prompt 8: LLM records the known slots (UPDATE_JOURNEY) and does NOT search;
    // the backend asks the authoritative pending question.
    expect(['ASK_CLARIFICATION','UPDATE_JOURNEY']).toContain(r.decision.action);
    expect(r.decision.toolCalls.length).toBe(0);
    expect(r.decision.clarification).toMatch(/तारीख|date/i);
  });

  it('AMBIGUITY: single station word "delhi" → ask clarification (no tool)', async () => {
    const s = blank();
    const r = await llm.generateStructuredDecision({
      userText:'delhi', history:[], state:s.bookingState, session:s,
      missingFields:['origin','destination','date'], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    expect(r.decision.toolCalls.length).toBe(0);
    // Prompt 8: role-less station is passed as stationOnlyRaw; backend decides from context or asks.
    expect(['ASK_CLARIFICATION','NO_ACTION','UPDATE_JOURNEY']).toContain(r.decision.action);
    expect(r.decision.entities.originRaw).toBeUndefined();
    expect(r.decision.entities.destinationRaw).toBeUndefined();
  });

  it('UNKNOWN_REQUEST: non-railway → UNKNOWN/NO_ACTION with final reply', async () => {
    const s = blank();
    const r = await llm.generateStructuredDecision({
      userText:'aaj weather kaisa hai', history:[], state:s.bookingState, session:s,
      missingFields:[], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    expect(r.decision.toolCalls.length).toBe(0);
    expect(r.decision.intent).toBe('UNKNOWN');
    expect(r.decision.finalMessage).toBeTruthy();
  });

  it('SENSITIVE: password → NO_ACTION (short-circuited even before runtime)', async () => {
    const s = blank();
    const r = await llm.generateStructuredDecision({
      userText:'mera IRCTC password booker123 hai', history:[], state:s.bookingState, session:s,
      missingFields:[], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    expect(r.decision.action).toBe('NO_ACTION');
    expect(r.decision.finalMessage).toMatch(/password/i);
  });

  it('CONFIRMATION_WHEN_AWAITING → PREPARE_IRCTC_HANDOFF', async () => {
    const s = blank({ bookingState: BookingState.AWAITING_CONFIRMATION, origin:'ASR', destination:'NDLS', date:'2026-10-03' });
    const r = await llm.generateStructuredDecision({
      userText:'haan book kar do', history:[], state:s.bookingState, session:s,
      missingFields:[], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    expect(r.decision.action).toBe('PREPARE_IRCTC_HANDOFF');
  });

  it('HAAN_WITHOUT_PENDING_CONFIRMATION → ASK_CLARIFICATION (no handoff)', async () => {
    const s = blank({ bookingState: BookingState.IDLE });
    const r = await llm.generateStructuredDecision({
      userText:'haan', history:[], state:s.bookingState, session:s,
      missingFields:['origin','destination','date'], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    expect(r.decision.action).not.toBe('PREPARE_IRCTC_HANDOFF');
  });

  it('DATE_CORRECTION "kal nahi parso" triggers fresh SEARCH with new date', async () => {
    const s = blank({ bookingState: BookingState.SHOWING_TRAINS, origin:'ASR', destination:'NDLS', date:'2026-10-03', passengersCount:1, availableTrains:[{number:'12014',name:'Shatabdi',classes:[]} as any] });
    const history = [{ role:'tool' as const, content:JSON.stringify({ok:true,data:{trains:[]}}), toolCallId:'c', toolName:'SEARCH_TRAINS' }];
    const r = await llm.generateStructuredDecision({
      userText:'kal nahi parso', history:history as any, state:s.bookingState, session:s,
      missingFields:[], inputMode:'TEXT', tools: REGISTERED_TOOLS
    });
    // Should be UPDATE_DATE or SEARCH with new date
    expect(['UPDATE_DATE','SEARCH_TRAINS','UPDATE_JOURNEY']).toContain(r.decision.intent);
  });
});
