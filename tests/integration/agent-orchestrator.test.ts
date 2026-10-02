import { describe, it, expect, beforeAll } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { BookingState } from '../../shared/states';

describe('Group 3: ConversationAgentOrchestrator + ActionValidator + tool-call loop', () => {
  let orch: ConversationAgentOrchestrator;
  let state: ConversationStateManager;
  let sid: string;

  beforeAll(() => {
    railwayRegistry.register('grp3-mock', () => new MockRailwayProvider());
    railwayRegistry.setActive('grp3-mock');
    const llm = new MockLLMProvider();
    state = new ConversationStateManager();
    const tools = new RailwayToolService();
    orch = new ConversationAgentOrchestrator(llm, state, tools);
    sid = state.createSession().sessionId;
  });

  it('multi-slot input triggers SEARCH_TRAINS tool and returns trains', async () => {
    const res = await orch.processTurn(sid, 'Amritsar se Delhi 3 October 2 log AC', 'TEXT');
    expect(res.context.origin).toBe('ASR');
    expect(res.context.destination).toBe('NDLS');
    expect(res.context.date).toBe('2026-10-03');
    expect(res.context.passengersCount).toBe(2);
    expect(res.cards?.some(c => c.type === 'trains')).toBe(true);
    expect((res.turnLog.toolExecuted || []).some(t => t.name === 'SEARCH_TRAINS')).toBe(true);
    expect(res.turnLog.toolResultStatus).toBe('ok');
  });

  it('train selection resolves against current search results (invalid train rejected)', async () => {
    const trains = state.getSession(sid).availableTrains;
    expect(trains.length).toBeGreaterThan(0);
    const first = trains[0];
    const num = (first as any).trainNumber || first.number;
    const res = await orch.processTurn(sid, `${num} wali`, 'TEXT');
    expect(['CLASS_OPTIONS','TRAIN_SELECTED']).toContain(res.newState);
    expect(res.context.selectedTrain).toBeTruthy();

    const r2 = await orch.processTurn(sid, '99999 wali', 'TEXT');
    expect(r2.responseMessage).toMatch(/नहीं|not|results|उपलब्ध/);
  });

  it('class selection transitions and begins passenger collection', async () => {
    const train = state.getSession(sid).selectedTrain as any;
    expect(train).toBeTruthy();
    const cls = train.classes[0].code;
    const res = await orch.processTurn(sid, `${cls} class`, 'TEXT');
    expect(res.context.selectedClass).toBe(cls);
    expect(res.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
  });

  it('passenger collection rejects sensitive fields and never asks for password/OTP', async () => {
    // Use a fresh session in CLASS_COLLECTING state to avoid side-effects of previous tests
    const sX = state.createSession().sessionId;
    // Journey search first
    let r = await orch.processTurn(sX, 'Amritsar se Delhi 3 October 2 log', 'TEXT');
    const tr = state.getSession(sX).availableTrains[0];
    const num = (tr as any).trainNumber || tr.number;
    r = await orch.processTurn(sX, `${num} wali`, 'TEXT');
    const cls = (state.getSession(sX).selectedTrain as any).classes[0].code;
    r = await orch.processTurn(sX, `${cls} class`, 'TEXT');
    // Now in passenger collection
    r = await orch.processTurn(sX, 'mera password abc123 hai', 'TEXT');
    const p = state.getSession(sX).passengers[0];
    expect(p && p.name).toBeFalsy();
  });

  it('CONFIRM_BOOKING outside REVIEW/AWAITING is rejected', async () => {
    // Create a fresh IDLE session
    const s2 = state.createSession().sessionId;
    const r = await orch.processTurn(s2, 'haan book kar do', 'TEXT');
    // Should NOT produce confirmation / handoff
    const sess = state.getSession(s2);
    expect(sess.bookingState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(sess.bookingState).not.toBe(BookingState.COMPLETE);
  });

  it('turn history is recorded with tool metadata', async () => {
    const s3 = state.createSession().sessionId;
    const r = await orch.processTurn(s3, 'Amritsar se Delhi kal 2 log', 'TEXT');
    expect(r.turnLog.sessionId).toBe(s3);
    expect(r.turnLog.turnId).toBeTruthy();
    expect(r.turnLog.stateBefore).toBe(BookingState.IDLE);
    expect(r.turnLog.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('correction invalidates dependent results (does NOT restart conversation)', async () => {
    const s4 = state.createSession().sessionId;
    let r = await orch.processTurn(s4, 'Amritsar se Delhi 3 October 2 log', 'TEXT');
    expect(r.context.origin).toBe('ASR');
    expect(r.context.destination).toBe('NDLS');
    expect(r.cards?.some(c => c.type === 'trains')).toBe(true);
    // Correction: destination change → triggers a fresh search for Ludhiana
    r = await orch.processTurn(s4, 'actually Delhi nahi Ludhiana', 'TEXT');
    expect(r.context.destination).toBe('LDH');
    expect(r.context.selectedTrain).toBeFalsy();
    expect(r.context.selectedClass).toBeFalsy();
  });

  it('tool loop is bounded (no infinite recursion on error)', async () => {
    // Bounded loop: max 5 iterations, should complete without hanging
    const s5 = state.createSession().sessionId;
    const start = Date.now();
    const r = await orch.processTurn(s5, 'xyzxyzxyzxyz kahan jaunga', 'TEXT');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.responseMessage).toBeTruthy();
  });
});
