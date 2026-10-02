import { describe, it, expect, beforeAll } from 'vitest';
import { MockRuleBasedAIProvider } from '../../server/ai/providers/mock-rule-based';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { AIOrchestrator } from '../../server/ai/orchestrator/orchestrator';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { BookingState } from '../../shared/states';

describe('Group 3: Search orchestrator + voice/text switching + confirmation', () => {
  let orchestrator: AIOrchestrator;
  let stateManager: ConversationStateManager;
  let sessionId: string;

  beforeAll(async () => {
    const ai = new MockRuleBasedAIProvider();
    await ai.init({ providerId: 'test' });
    stateManager = new ConversationStateManager();
    railwayRegistry.register('test-mock-2', () => new MockRailwayProvider());
    railwayRegistry.setActive('test-mock-2');
    const tools = new RailwayToolService();
    orchestrator = new AIOrchestrator(ai, stateManager, tools);
    const s = stateManager.createSession();
    sessionId = s.sessionId;
  });

  it('preserves state across VOICE/TEXT; invalidates on destination change; requires confirmation', async () => {
    // Voice: Amritsar se Delhi
    let res = await orchestrator.processTurn(sessionId, 'Amritsar se Delhi', 'VOICE');
    expect(res.context.origin).toBe('ASR');
    expect(res.context.destination).toBe('NDLS');

    // Text: 3 October
    res = await orchestrator.processTurn(sessionId, '3 October', 'TEXT');
    expect(res.context.date).toBe('2026-10-03');
    expect(res.context.origin).toBe('ASR');

    // Voice: do (2 passengers) + AC morning
    res = await orchestrator.processTurn(sessionId, 'do', 'VOICE');
    expect(res.context.passengersCount).toBe(2);
    expect(res.newState).toBe(BookingState.SHOWING_TRAINS);

    // Text: 12014
    res = await orchestrator.processTurn(sessionId, '12014', 'TEXT');
    expect(res.newState).toBe(BookingState.CLASS_OPTIONS);

    // Voice: CC
    res = await orchestrator.processTurn(sessionId, 'CC', 'VOICE');
    expect(res.context.selectedClass).toBe('CC');
    expect(res.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);

    await orchestrator.processTurn(sessionId, 'Rahul', 'VOICE');
    await orchestrator.processTurn(sessionId, '31', 'VOICE');
    await orchestrator.processTurn(sessionId, 'Male', 'VOICE');
    await orchestrator.processTurn(sessionId, 'Neha', 'TEXT');
    await orchestrator.processTurn(sessionId, '28', 'TEXT');
    res = await orchestrator.processTurn(sessionId, 'Female', 'TEXT');
    expect(res.newState).toBe(BookingState.REVIEW);
    expect(res.cards?.some(c => c.type === 'review')).toBe(true);

    // Reaching REVIEW must NOT confirm
    const s = stateManager.getSession(sessionId);
    expect(s.reviewConfirmed).toBe(false);

    // Change destination mid-flow should invalidate selections (test "actually Ludhiana jana hai")
    res = await orchestrator.processTurn(sessionId, 'Actually Ludhiana jana hai', 'TEXT');
    const s2 = stateManager.getSession(sessionId);
    expect(s2.destination).toBe('LDH');
    expect(s2.selectedTrain).toBeUndefined();
    expect(s2.selectedClass).toBeUndefined();
    expect(s2.bookingState).not.toBe(BookingState.REVIEW);

    // Re-search automatically because all required fields now present (origin ASR, destination LDH, date still set, passengers count set)
    expect(s2.availableTrains.length).toBeGreaterThan(0);
  });
});
