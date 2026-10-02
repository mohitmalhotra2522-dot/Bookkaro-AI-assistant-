import { describe, it, expect, beforeAll } from 'vitest';
import { MockRuleBasedAIProvider } from '../../server/ai/providers/mock-rule-based';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { AIOrchestrator } from '../../server/ai/orchestrator/orchestrator';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { BookingState } from '../../shared/states';

describe('Group 2: Railway provider + state machine flow', () => {
  let orchestrator: AIOrchestrator;
  let stateManager: ConversationStateManager;
  let sessionId: string;

  beforeAll(async () => {
    const ai = new MockRuleBasedAIProvider();
    await ai.init({ providerId: 'test' });
    stateManager = new ConversationStateManager();
    // Register and select mock provider
    railwayRegistry.register('test-mock', () => new MockRailwayProvider());
    railwayRegistry.setActive('test-mock');
    const tools = new RailwayToolService();
    orchestrator = new AIOrchestrator(ai, stateManager, tools);
    const s = stateManager.createSession();
    sessionId = s.sessionId;
  });

  it('journey→date→passengers→search→train→class→passengers via SearchOrchestrator', async () => {
    let res = await orchestrator.processTurn(sessionId, 'Amritsar se Ludhiana jaana hai', 'TEXT');
    expect(res.context.origin).toBe('ASR');
    expect(res.context.destination).toBe('LDH');

    res = await orchestrator.processTurn(sessionId, '3 October', 'TEXT');
    expect(res.context.date).toBe('2026-10-03');

    res = await orchestrator.processTurn(sessionId, 'do', 'TEXT');
    expect(res.context.passengersCount).toBe(2);
    expect(res.newState).toBe(BookingState.SHOWING_TRAINS);
    expect(res.context.availableTrains.length).toBeGreaterThan(0);
    expect(res.cards?.some(c => c.type === 'trains')).toBe(true);

    res = await orchestrator.processTurn(sessionId, '12014', 'TEXT');
    expect(res.newState).toBe(BookingState.CLASS_OPTIONS);
    expect(res.context.selectedTrain).toBeDefined();

    res = await orchestrator.processTurn(sessionId, 'CC', 'TEXT');
    expect(res.context.selectedClass).toBe('CC');
    expect(res.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);

    res = await orchestrator.processTurn(sessionId, 'Rahul Sharma', 'TEXT');
    expect(res.context.passengers[0].name).toBe('Rahul Sharma');

    res = await orchestrator.processTurn(sessionId, '31', 'TEXT');
    res = await orchestrator.processTurn(sessionId, 'Male', 'TEXT');
    const s8 = stateManager.getSession(sessionId);
    expect(s8.passengers[0].gender).toBe('MALE');

    res = await orchestrator.processTurn(sessionId, 'Priya', 'TEXT');
    res = await orchestrator.processTurn(sessionId, '28', 'TEXT');
    res = await orchestrator.processTurn(sessionId, 'Female', 'TEXT');
    const sf = stateManager.getSession(sessionId);
    expect(sf.passengers[1].gender).toBe('FEMALE');
    expect(res.newState).toBe(BookingState.REVIEW);
    expect(res.cards?.some(c => c.type === 'review')).toBe(true);
    expect(sf.fare).toBeDefined();
  });
});
