import { describe, it, expect } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { REGISTERED_TOOLS, getToolDefinition } from '../../server/ai/tools/tool-registry';
import type { BookingSession } from '../../shared/entities';
import { BookingState } from '../../shared/states';

function blankSession(): BookingSession {
  return {
    sessionId: 's1', createdAt: new Date().toISOString(), mode: 'TEXT',
    bookingState: BookingState.IDLE,
    origin: undefined, destination: undefined, date: undefined,
    passengersCount: undefined,
    availableTrains: [], passengers: [],
    originName: undefined, destinationName: undefined,
    reviewConfirmed: false, irctcHandoffReady: false,
    selectedTrain: undefined, selectedClass: undefined,
    fare: undefined, availability: undefined,
    preferredClass: undefined, preferredTime: undefined,
    searchResults: undefined
  } as any;
}

describe('Group 2a: AgentDecision schema + MockLLMProvider slot extraction', () => {
  const llm = new MockLLMProvider();

  it('extracts multi-slot journey+date+passengers+class and emits SEARCH_TRAINS tool call', async () => {
    const s = blankSession();
    const res = await llm.generateStructuredDecision({
      userText: 'Amritsar se Delhi kal jaana hai, 2 log hain, AC chahiye',
      history: [], state: s.bookingState, session: s,
      missingFields: ['origin','destination','date','passengers'],
      inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    const d = res.decision;
    expect(d.toolCalls?.length).toBeGreaterThanOrEqual(1);
    const sc = d.toolCalls!.find(t => t.name === 'SEARCH_TRAINS');
    expect(sc).toBeTruthy();
    // Mock emits raw station words; backend resolves to codes via RouteResolver.
    expect(sc!.arguments.origin.toLowerCase()).toContain('amritsar');
    expect(sc!.arguments.destination.toLowerCase()).toContain('delhi');
    expect(sc!.arguments.date).toBeTruthy();
    expect(sc!.arguments.passengersCount).toBe(2);
    expect(sc!.arguments.preferredClass).toBe('AC');
  });

  it('asks only for next missing field when not enough info', async () => {
    const s = { ...blankSession() };
    s.bookingState = BookingState.COLLECTING_JOURNEY;
    const res = await llm.generateStructuredDecision({
      userText: 'jana hai', history: [], state: s.bookingState, session: s,
      missingFields: ['origin','destination','date'], inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    // No slots → ask clarification, no tool call
    expect(res.decision.action).toBe('ASK_CLARIFICATION');
    expect(res.decision.toolCalls?.length || 0).toBe(0);
    expect(res.decision.clarification).toBeTruthy();
  });

  it('handles correction ("actually Ludhiana") by emitting SEARCH_TRAINS with new destination', async () => {
    const s = { ...blankSession(), origin: 'ASR', destination: 'NDLS', date: '2026-10-05', passengersCount: 1 };
    s.bookingState = BookingState.REVIEW;
    const res = await llm.generateStructuredDecision({
      userText: 'actually Delhi nahi Ludhiana jana hai', history: [],
      state: s.bookingState, session: s,
      missingFields: [], inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    const sc = res.decision.toolCalls?.find(t => t.name === 'SEARCH_TRAINS');
    expect(sc).toBeTruthy();
    expect(sc!.arguments.destination.toLowerCase()).toContain('ludhiana');
  });

  it('rejects non-railway intent with UNKNOWN/no tool call', async () => {
    const s = blankSession();
    const res = await llm.generateStructuredDecision({
      userText: 'weather kaisa hai aaj', history: [], state: s.bookingState, session: s,
      missingFields: ['origin','destination','date'], inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    expect(res.decision.toolCalls?.length).toBeFalsy();
    expect(['UNKNOWN','GENERAL_RAILWAY_QUERY']).toContain(res.decision.intent);
    expect(res.decision.finalMessage).toBeTruthy();
  });

  it('rejects sensitive requests (password) with NO_ACTION', async () => {
    const s = blankSession();
    const res = await llm.generateStructuredDecision({
      userText: 'mera IRCTC password booker123 hai', history: [], state: s.bookingState, session: s,
      missingFields: [], inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    expect(res.decision.action).toBe('NO_ACTION');
  });

  it('handles ambiguity for bare "delhi" when nothing set', async () => {
    const s = blankSession();
    const res = await llm.generateStructuredDecision({
      userText: 'delhi', history: [], state: s.bookingState, session: s,
      missingFields: ['origin','destination','date'], inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    // With no other slots, "delhi" alone is ambiguous → ask clarification
    const isAsk = res.decision.action === 'ASK_CLARIFICATION' || (res.decision.clarification && !res.decision.toolCalls?.length);
    expect(isAsk).toBe(true);
  });

  it('tool registry has exactly the 5 tools (TRACK/PNR NOT registered)', () => {
    const names = REGISTERED_TOOLS.map(t => t.name).sort();
    expect(names).toEqual(['CHECK_AVAILABILITY','GET_FARE','GET_TIMETABLE','GET_TRAIN_INFO','SEARCH_TRAINS']);
    expect(getToolDefinition('TRACK_TRAIN')).toBeUndefined();
    expect(getToolDefinition('CHECK_PNR')).toBeUndefined();
  });

  it('finalMessage present on non-tool responses; not present when toolCalls pending', async () => {
    const s = blankSession();
    const res1 = await llm.generateStructuredDecision({
      userText: 'Amritsar se Delhi kal 2 log', history: [], state: s.bookingState, session: s,
      missingFields: ['origin','destination','date','passengers'], inputMode: 'TEXT', tools: REGISTERED_TOOLS
    });
    expect(res1.decision.toolCalls?.length).toBeGreaterThan(0);
    // When tool calls exist, finalMessage should be empty/absent (LLM waits for tool result)
    expect(res1.decision.finalMessage).toBeFalsy();
  });
});
