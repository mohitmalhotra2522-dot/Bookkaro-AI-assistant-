/**
 * P42.1 — the backend never authors a conversational question. It returns facts + STRUCTURED context (missingField /
 * userActionRequired / missingInformation / pendingConfirmation); Muse (or the user-selected fallback LLM) decides
 * whether and how to ask. Safety confirmations stay backend-authoritative (the explicit confirm is still verified by
 * the backend before any protected step) — only the wording moved to the LLM.
 *
 * "QuietLLM" = MockLLM's decisions with its own clarification / final wording removed and no wording step: any "?"
 * left in a reply can therefore only have come from the backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { BookingState } from '../../shared/states';
import { LLM_UNAVAILABLE_MESSAGE } from '../../server/ai/providers/llm-provider';
import { buildLLMContext } from '../../server/ai/context/context-builder';
import { factOnly, missingInfoOf, pendingInfoView, pendingConfirmationOf, asksUser } from '../../server/ai/response/backend-question-policy';

railwayRegistry.register('p421-provider', () => new MockRailwayProvider());

class QuietLLM extends MockLLMProvider {
  contexts: any[] = []; decisions = 0; spokenCalls = 0;
  async generateStructuredDecision(input: any): Promise<any> {
    this.decisions++;
    this.contexts.push(input.context);
    const out: any = await super.generateStructuredDecision(input);
    if (out?.decision) { out.decision.clarification = null; out.decision.finalMessage = null; }
    return out;
  }
  async generateSpokenResponse(): Promise<any> { this.spokenCalls++; return null; }   // no LLM wording → backend fallback
}

let state: ConversationStateManager;
const S = (sid: string): any => state.getSession(sid);
const shown = (r: any) => [r.responseMessage, r.voice?.assistantText, r.voice?.speechText, ...(r.voice?.segments || [])].map(x => String(x ?? ''));
const noQuestion = (r: any, tag: string) => { for (const t of shown(r)) expect(asksUser(t), `${tag}: "${t}"`).toBe(false); };
function orchWith(llm: any) { return new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), {}); }

beforeEach(() => { railwayRegistry.setActive('p421-provider'); state = new ConversationStateManager(); });

describe('P42.1 — fact-only helpers (no new wording)', () => {
  it('[0] factOnly drops asking / requesting sentences, keeps facts and line structure, never adds text', () => {
    expect(factOnly('Kam se kam 1 passenger hona zaroori hai. Kitne passengers hain?')).toBe('Kam se kam 1 passenger hona zaroori hai.');
    expect(factOnly('Wo option purani list ka tha. Current results mein se chuniye: 12497.')).toBe('Wo option purani list ka tha.');
    expect(factOnly('Review (v1):\nAmritsar → New Delhi\nConfirm karna hai?')).toBe('Review (v1):\nAmritsar → New Delhi');
    expect(factOnly('Kaunsi train chahiye?')).toBe('');
    expect(factOnly(LLM_UNAVAILABLE_MESSAGE)).toBe(LLM_UNAVAILABLE_MESSAGE);      // retry advice is not a question
    expect(missingInfoOf('MISSING_PASSENGER_COUNT')).toEqual({ missingField: 'PASSENGER_COUNT', userActionRequired: true });
    expect(missingInfoOf('AMBIGUOUS_ROUTE', { type: 'CLARIFICATION_REQUIRED', data: { kind: 'STATION_ROLE' } })).toEqual({ missingField: 'STATION', userActionRequired: true });
    expect(missingInfoOf(null, { type: 'CLARIFICATION_REQUIRED', data: { kind: 'CHANGE_DETAILS' } })).toEqual({ missingField: 'CHANGE_DETAILS', userActionRequired: true });
    expect(missingInfoOf('PROVIDER_TIMEOUT')).toEqual({ userActionRequired: false });
  });
});

describe('P42.1 — A/H: no backend-appended question (text + voice fallback)', () => {
  it('[A] a full mock booking flow: every backend reply is fact-only; the pending interaction stays structured', async () => {
    const llm = new QuietLLM(); const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    const turns: Array<[string, string | null]> = [
      ['Amritsar se Delhi', 'DATE_REQUIRED'], ['kal 2 log', 'TRAIN_SELECTION_REQUIRED'], ['12497', 'CLASS_SELECTION_REQUIRED'], ['CC', null],
      ['Rahul Sharma 31 male, Neha Sharma 28 female', null]
    ];
    for (const [text, pending] of turns) {
      const r = await orch.processTurn(sid, text, 'TEXT');
      noQuestion(r, text);
      expect(String(r.responseMessage).trim().length, text).toBeGreaterThan(0);   // never a blank reply
      if (pending) expect(r.pendingInteraction?.type).toBe(pending);
    }
    expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
  });

  it('[H] VOICE turns with no LLM wording: the deterministic voice fallback carries no question', async () => {
    const llm = new QuietLLM(); const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    for (const text of ['Amritsar se Delhi', 'kal 2 log', '12497', 'CC']) {
      const r = await orch.processTurn(sid, text, 'VOICE');
      noQuestion(r, `VOICE ${text}`);
      expect(String((r as any).voice?.speechText || r.responseMessage).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('P42.1 — B: missing information reaches the LLM as STRUCTURED context', () => {
  it('[B1] the next LLM call sees missingInformation + a hint-free pendingInteraction with missingField', async () => {
    const llm = new QuietLLM(); const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    await orch.processTurn(sid, 'Amritsar se Delhi', 'TEXT');
    await orch.processTurn(sid, 'kal', 'TEXT');
    const ctx = llm.contexts.find(c => c?.pendingInteraction?.type === 'DATE_REQUIRED');
    expect(ctx).toBeTruthy();
    expect(ctx.missingInformation).toMatchObject({ origin: 'present', destination: 'present', date: 'missing' });
    expect(ctx.pendingInteraction).toMatchObject({ type: 'DATE_REQUIRED', missingField: 'DATE', userActionRequired: true });
    expect(ctx.pendingInteraction).not.toHaveProperty('hint');
    expect(JSON.stringify(ctx.pendingInteraction)).not.toMatch(/\?/);
  });

  it('[B2] canned hint text never reaches the LLM context (structured kind instead)', () => {
    const sid = state.createSession().sessionId;
    const s = S(sid);
    s.pendingInteraction = { type: 'CLARIFICATION_REQUIRED', hint: 'Kya badalna hai — train, class, date ya passengers?', data: { kind: 'CHANGE_DETAILS', options: ['train', 'class', 'date', 'passengers'] } };
    const ctx: any = buildLLMContext(s, []);
    expect(ctx.pendingInteraction).toEqual({ type: 'CLARIFICATION_REQUIRED', data: { kind: 'CHANGE_DETAILS', options: ['train', 'class', 'date', 'passengers'] }, missingField: 'CHANGE_DETAILS', userActionRequired: true });
    expect(pendingInfoView({ type: 'NONE' } as any)).toBeNull();
  });

  it('[B3] the bare-day ambiguity ("22") is structured context for the LLM — no backend question, no guessed date', async () => {
    const llm = new QuietLLM(); const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    await orch.processTurn(sid, 'Amritsar se Delhi', 'TEXT');
    const before = llm.decisions;
    const r = await orch.processTurn(sid, '22', 'TEXT');
    noQuestion(r, '22');
    expect(llm.decisions).toBeGreaterThan(before);                       // the LLM decides how to ask
    expect(S(sid).date).toBeFalsy();                                    // never guessed
    const ctx = llm.contexts[llm.contexts.length - 1];
    expect(ctx.pendingInteraction).toMatchObject({ type: 'CLARIFICATION_REQUIRED', data: { kind: 'DATE_MONTH', day: 22 }, missingField: 'DATE_MONTH' });
    expect(ctx.pendingInteraction.data.candidates).toHaveLength(2);
  });
});

describe('P42.1 — C: the LLM\'s own question is preserved', () => {
  it('[C] a native agent question is kept as written (not stripped, nothing appended)', async () => {
    class AskingLLM extends MockLLMProvider {
      readonly agentAuthoredReplies = true;
      async generateStructuredDecision(): Promise<any> {
        return { decision: { intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {}, missingFields: [], confidence: 0.9, clarification: null, toolCalls: [],
          finalMessage: 'Zaroor! Aap kahan se kahan travel karna chahte hain?' } };
      }
    }
    const orch = orchWith(new AskingLLM());
    const sid = state.createSession().sessionId;
    const r = await orch.processTurn(sid, 'train ticket book karni hai', 'TEXT');
    expect([r.responseMessage, (r as any).voice?.assistantText].join(' | ')).toContain('Aap kahan se kahan travel karna chahte hain?');
    expect((r.responseMessage.match(/\?/g) || []).length).toBe(1);       // only the LLM's one question
  });
});

describe('P42.1 — D/E: honest error only; sensitive input never reaches the LLM', () => {
  it('[D] LLM failure → the honest error only, no question appended (text + voice)', async () => {
    class Down extends MockLLMProvider { async generateStructuredDecision(): Promise<any> { throw new Error('LLM down'); } }
    const orch = orchWith(new Down());
    const sid = state.createSession().sessionId;
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const r = await orch.processTurn(sid, 'Amritsar se Delhi kal', mode);
      expect(r.responseMessage).toBe(LLM_UNAVAILABLE_MESSAGE);
      noQuestion(r, `LLM down ${mode}`);
    }
  });

  it('[E] sensitive input → refusal only; no LLM decision / wording call; no question', async () => {
    const llm = new QuietLLM();
    const spy = vi.spyOn(llm, 'generateStructuredDecision');
    const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    const r = await orch.processTurn(sid, 'mera OTP 482913 hai', 'TEXT');
    expect(r.error?.code).toBe('SENSITIVE_REQUEST_REJECTED');
    expect(spy).not.toHaveBeenCalled();
    expect(llm.spokenCalls).toBe(0);
    noQuestion(r, 'sensitive');
    expect(r.responseMessage).not.toContain('482913');
  });
});

describe('P42.1 — F/G: confirmation stays backend-controlled; no booking mutation', () => {
  it('[F] review → pendingConfirmation is structured for the LLM; "theek hai" is NOT a confirmation; explicit "haan" still required', async () => {
    const llm = new QuietLLM(); const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female']) await orch.processTurn(sid, t, 'TEXT');
    expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    const amb = await orch.processTurn(sid, 'theek hai', 'TEXT');
    const ctx = llm.contexts[llm.contexts.length - 1];
    expect(ctx.pendingConfirmation).toEqual({ action: 'BOOKING_CONFIRMATION', confirmationRequired: true, confirmationStatus: 'PENDING' });
    expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);      // ambiguous → nothing moved
    expect(S(sid).handoffSession).toBeFalsy();
    noQuestion(amb, 'theek hai');
    const ok = await orch.processTurn(sid, 'haan', 'TEXT');
    expect(ok.newState).toBe(BookingState.IRCTC_HANDOFF_READY);              // the backend-verified explicit confirm works
    // [G] no booking / payment / IRCTC submission: execution stays disabled and unsubmitted, no PNR, never COMPLETED
    const bx = S(sid).bookingExecution;
    if (bx) expect(bx).toMatchObject({ providerName: 'disabled', submitted: false, status: 'NOT_STARTED', pnr: null, code: 'BOOKING_EXECUTION_DISABLED' });
    expect(S(sid).bookingState).not.toBe('COMPLETED');
  });

  it('[F2] lifecycle: a pending cancellation is structured as CANCELLATION / confirmationRequired / PENDING', () => {
    const sid = state.createSession().sessionId;
    const s = S(sid);
    s.pendingLifecycleAction = { actionId: 'act1', setAtTurnId: 't1', expiresAt: Date.now() + 60_000 };
    s.lastLifecycleAction = { actionId: 'act1', bookingId: 'b1', actionType: 'CANCEL_BOOKING', status: 'AWAITING_ACTION_CONFIRMATION', resultStatus: null, at: Date.now() };
    expect(pendingConfirmationOf(s, false)).toEqual({ action: 'CANCELLATION', confirmationRequired: true, confirmationStatus: 'PENDING' });
    expect((buildLLMContext(s, []) as any).pendingConfirmation).toEqual({ action: 'CANCELLATION', confirmationRequired: true, confirmationStatus: 'PENDING' });
    s.pendingLifecycleAction = undefined;
    expect(pendingConfirmationOf(s, false)).toBeNull();
  });

  it('[G] invalid passenger count is rejected from the user\'s words (fact only) — nothing stored, no LLM "correction"', async () => {
    const llm = new QuietLLM(); const orch = orchWith(llm);
    const sid = state.createSession().sessionId;
    await orch.processTurn(sid, 'Amritsar se Delhi kal', 'TEXT');
    const r = await orch.processTurn(sid, '0 passengers', 'TEXT');
    expect(r.error?.code).toBe('INVALID_PASSENGER_COUNT');
    expect(r.error?.details).toMatchObject({ missingField: 'PASSENGER_COUNT', userActionRequired: true });
    expect(S(sid).passengersCount || 0).toBe(0);
    noQuestion(r, '0 passengers');
  });
});
