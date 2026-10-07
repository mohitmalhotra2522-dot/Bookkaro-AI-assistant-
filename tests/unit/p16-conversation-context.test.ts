/**
 * PROMPT 16 — GROUP 2 (unit): conversation context, ContextPatch validation, grounding, dependency
 * rules, input normalizer, reference resolution, response fact guard, AssistantResponse, MockLLM
 * scenarios and the explicit new-journey reset. Railway data is the labelled (non-live) mock.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { stateTransitionValidator } from '../../server/ai/state/state-transition-validator';
import { BookingState } from '../../shared/states';
import { ContextPatchValidator, DEPENDENCY_RULES, ALLOWED_PATCH_FIELDS, classPreferenceFamily } from '../../server/ai/conversation/context-patch';
import { resolveStationDetailed, stationCodesMentioned, extractDateExpression, countMentioned } from '../../server/ai/conversation/grounding';
import { ConversationContextManager, pendingQuestionOf, summarizeContext, missingSlots } from '../../server/ai/conversation/conversation-context';
import { normalizeUtterance } from '../../server/ai/conversation/input-normalizer';
import { guardResponseFacts } from '../../server/ai/conversation/response-fact-guard';
import { ConversationReferenceResolver } from '../../server/ai/conversation/reference-resolution';
import { buildAssistantResponse, toRecoveryCode, speechOf } from '../../server/ai/conversation/assistant-response';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { AMBIGUOUS_STATION_NAMES } from '../../shared/constants';

const iso = (expr: string) => { const r: any = resolveDate(expr); if (!r.ok) throw new Error(expr); return r.date as string; };
const KAL = iso('kal'), PARSO = iso('parso');

function session(over: Record<string, any> = {}) {
  const m = new ConversationStateManager();
  const s: any = m.getSession(m.createSession().sessionId);
  Object.assign(s, over);
  return { m, s };
}
const journey = () => session({ origin: 'ASR', originName: 'Amritsar Junction', destination: 'NDLS', destinationName: 'New Delhi', date: KAL, passengersCount: 2 });
const V = new ContextPatchValidator();

describe('P16 grounding helpers', () => {
  it('[1] station resolution: Ambala is AMBIGUOUS (never guessed), Ambala Cantt / Delhi resolve, unknown stays unknown', () => {
    const a = resolveStationDetailed('Ambala');
    expect(a.kind).toBe('AMBIGUOUS');
    expect((a as any).candidates.map((c: any) => c.code).sort()).toEqual(['UBC', 'UMB']);
    expect(resolveStationDetailed('ambala cantt')).toMatchObject({ kind: 'RESOLVED', code: 'UMB' });
    expect(resolveStationDetailed('Delhi')).toMatchObject({ kind: 'RESOLVED', code: 'NDLS' });
    expect(resolveStationDetailed('Atlantis').kind).toBe('UNKNOWN');
    expect(Object.keys(AMBIGUOUS_STATION_NAMES)).toContain('ambala');
    expect([...stationCodesMentioned('Actually Delhi nahi Ludhiana')].sort()).toEqual(['LDH', 'NDLS']);
  });

  it('[2] date expression is taken AFTER a negation; counts are only what the user said', () => {
    expect(extractDateExpression('Kal nahi parso')).toEqual({ expression: 'parso', date: PARSO });
    expect(extractDateExpression('Amritsar se Delhi kal 2 log')?.date).toBe(KAL);
    expect(extractDateExpression('2 log hain')).toBeNull();
    expect([...countMentioned('teen log hain')]).toContain(3);
    expect([...countMentioned('Amritsar se Delhi')].length).toBe(0);
  });
});

describe('P16 ContextPatchValidator (LLM proposes → backend validates)', () => {
  it('[3] explicit correction grounded in the user words → CORRECTION patch with dependency invalidation', () => {
    const { s } = journey();
    const e: any = { destinationRaw: 'ludhiana' };
    const r = V.review(s, e, 'Actually Delhi nahi Ludhiana');
    expect(r.ok).toBe(true);
    const p = (r as any).patches.find((x: any) => x.field === 'destination');
    expect(p).toMatchObject({ kind: 'CORRECTION', value: 'LDH', previous: 'NDLS', resolvedBy: expect.stringMatching(/Station/) });
    expect(p.invalidates).toEqual(expect.arrayContaining(['searchResults', 'selectedTrain', 'selectedClass', 'availability', 'fare']));
  });

  it('[4] LLM value the user never said, contradicting the session → CONTEXT_CONFLICT question (nothing applied)', () => {
    const { s } = session({ origin: 'ASR', destination: 'LDH', destinationName: 'Ludhiana', date: KAL });
    const r = V.review(s, { destinationRaw: 'Delhi' } as any, 'subah wali train dikhao');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 'CONTEXT_CONFLICT' });
    expect((r as any).message).toBe('Abhi destination Ludhiana hai; New Delhi par badlav abhi apply nahi hua.');   // P42.1: fact, no question
    expect((r as any).pending).toMatchObject({ type: 'CLARIFICATION_REQUIRED', data: { kind: 'CONTEXT_CONFLICT', field: 'destination', proposedCode: 'NDLS' } });
  });

  it('[5] ungrounded value for an EMPTY slot is dropped (LLM never fills facts the user did not give)', () => {
    const { s } = session();
    const e: any = { originRaw: 'amritsar', destinationRaw: 'Delhi' };
    const r: any = V.review(s, e, 'Amritsar se jaana hai');
    expect(r.ok).toBe(true);
    expect(e.destinationRaw).toBeUndefined();
    expect(r.rejected).toEqual([expect.objectContaining({ field: 'destination', code: 'UNGROUNDED_VALUE' })]);
  });

  it('[6] LLM-computed YYYY-MM-DD contradicting the DateResolver is ignored; the user expression wins', () => {
    const { s } = journey();
    const e: any = { dateRaw: '2026-12-25' };
    const r: any = V.review(s, e, 'Kal nahi parso');
    expect(r.ok).toBe(true);
    expect(e.dateRaw).toBe('parso');
    expect(r.rejected).toEqual([expect.objectContaining({ field: 'date', code: 'LLM_DATE_OVERRIDDEN' })]);
    expect(r.patches.find((p: any) => p.field === 'date')).toMatchObject({ value: PARSO, previous: KAL, kind: 'CORRECTION', resolvedBy: 'DateResolver' });
  });

  it('[7] ambiguous station → deferred AMBIGUOUS_STATION clarification; other slots still valid', () => {
    const { s } = session();
    const e: any = { originRaw: 'ambala', destinationRaw: 'delhi', dateRaw: 'kal' };
    const r: any = V.review(s, e, 'Ambala se Delhi kal');
    expect(r.ok).toBe(true);
    expect(e.originRaw).toBeUndefined();
    expect(r.clarify).toMatchObject({ code: 'AMBIGUOUS_STATION', pending: { data: { kind: 'STATION_CHOICE', role: 'origin' } } });
    expect(r.clarify.message).toMatch(/Ambala Cantt \(UMB\).*Ambala City \(UBC\)/);
    expect(r.patches.map((p: any) => p.field).sort()).toEqual(['date', 'destination']);
  });

  it('[8] STATION_CHOICE answer maps onto the pending role; pending candidate code is grounded', () => {
    const { s } = session({ destination: 'NDLS', pendingInteraction: { type: 'CLARIFICATION_REQUIRED', data: { kind: 'STATION_CHOICE', role: 'origin', candidates: [{ code: 'UMB', name: 'Ambala Cantt' }, { code: 'UBC', name: 'Ambala City' }] } } });
    const e: any = { stationOnlyRaw: 'UMB' };
    const r: any = V.review(s, e, 'cantt wala');
    expect(r.ok).toBe(true);
    expect(e.originRaw).toBe('UMB');
    expect(r.patches[0]).toMatchObject({ field: 'origin', value: 'UMB' });
  });

  it('[9] dependency rules: route/date → results+train+class+availability+fare; train → class+avail+fare; class → avail+fare; count → fare', () => {
    expect(DEPENDENCY_RULES.date.invalidates).toEqual(expect.arrayContaining(['searchResults', 'selectedTrain', 'selectedClass', 'availability', 'fare']));
    expect(DEPENDENCY_RULES.selectedTrain.invalidates).toEqual(['selectedClass', 'availability', 'fare']);
    expect(DEPENDENCY_RULES.selectedClass.invalidates).toEqual(['availability', 'fare']);
    expect(DEPENDENCY_RULES.passengersCount).toMatchObject({ scope: 'PASSENGER_COUNT', invalidates: ['fare'] });
    expect(ALLOWED_PATCH_FIELDS.has('bookingState')).toBe(false);
    expect(ALLOWED_PATCH_FIELDS.has('pnr')).toBe(false);
    expect(classPreferenceFamily('3A')).toBe('AC');
    expect(classPreferenceFamily('SL')).toBe('NON_AC');
    expect(classPreferenceFamily('rocket')).toBeNull();
  });

  it('[10] passenger count the user never said, contradicting the session → conflict', () => {
    const { s } = journey();
    const r: any = V.review(s, { passengersCountRaw: '5' } as any, '12497 ka timetable');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONTEXT_CONFLICT');
  });
});

describe('P16 conversation context / summarizer', () => {
  it('[11] snapshot: derived from BookingSession, masked PNR, journeys isolated (J1 → J2)', () => {
    const { s } = journey();
    const cm = new ConversationContextManager();
    const c = cm.snapshot(s, { bookingId: 'BKG-1', pnr: '1234567890' });
    expect(c.activeJourney).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: KAL, passengersCount: 2 });
    expect(c.activePnrMasked).toBe('12******90');
    expect(JSON.stringify(c)).not.toContain('1234567890');
    expect(cm.activeJourneyId(s.sessionId)).toBe('J1');
    expect(cm.startNewJourney(s.sessionId)).toBe('J2');
  });

  it('[12] summary never presents unverified availability/fare as fact and carries no names/PNR', () => {
    const { s } = journey();
    s.passengers = [{ id: 'P1', name: 'Rahul Sharma', age: 31, gender: 'MALE' }];
    const sum = summarizeContext(new ConversationContextManager().snapshot(s, null), s);
    expect(sum.verified).toEqual({ fare: false, availability: false });
    expect(JSON.stringify(sum)).not.toMatch(/Rahul/);
    expect(sum.missingFields).toEqual(missingSlots(s));
    expect(pendingQuestionOf({ type: 'DATE_REQUIRED' } as any)).toBe('ASK_DATE');
    expect(pendingQuestionOf({ type: 'CLARIFICATION_REQUIRED', data: { kind: 'CONTEXT_CONFLICT' } } as any)).toBe('ASK_CONTEXT_CONFLICT');
  });
});

describe('P16 input normalizer', () => {
  it('[13] barge-in prefix stripped and flagged; safety phrases untouched; explicit new booking detected', () => {
    expect(normalizeUtterance('Ruko, Delhi nahi Ludhiana')).toMatchObject({ text: 'Delhi nahi Ludhiana', interruption: true });
    expect(normalizeUtterance('ruko ruko band karo')).toMatchObject({ text: 'ruko ruko band karo', interruption: false });
    expect(normalizeUtterance('new booking')).toMatchObject({ newBooking: true, remainder: '' });
    expect(normalizeUtterance('ek aur ticket Ludhiana se Delhi parso')).toMatchObject({ newBooking: true, remainder: 'Ludhiana se Delhi parso' });
    expect(normalizeUtterance('Amritsar se Delhi kal').newBooking).toBe(false);
  });
});

describe('P16 response fact guard / AssistantResponse', () => {
  it('[14] invented train / fare / PNR / availability removed; validated facts kept', () => {
    const { s } = journey();
    s.searchResults = { resultId: 'R1', version: 1, retrievedAt: new Date().toISOString(), journey: {}, trains: [{ number: '12497', displayIndex: 1 }] };
    const g = guardResponseFacts('12497 subah 06:35 chalti hai. Train 99999 Rajdhani bhi hai. Fare ₹1234 hai. PNR 4567891234 hai. Seats available hain.', { session: s, steps: [] });
    expect(g.text).toContain('12497');
    expect(g.text).not.toMatch(/99999|1234|4567891234|available hain/);
    expect(g.rejected.length).toBe(4);
  });

  it('[15] AssistantResponse: recovery codes, concise speech, confirmation flag', () => {
    expect(toRecoveryCode('STALE_SEARCH_REFERENCE')).toBe('STALE_RESULT_REFERENCE');
    expect(toRecoveryCode('INVALID_CLASS_SELECTION')).toBe('INVALID_CLASS_REFERENCE');
    expect(toRecoveryCode('CONTEXT_CONFLICT')).toBe('CONTEXT_CONFLICT');
    const long = 'Amritsar → New Delhi: 3 trains mili hain. 1. 12014 Amritsar Shatabdi — 04:55. 2. 12497 Shan-e-Punjab — 06:35. 3. 18238 Chhattisgarh Express — 19:35. Kaunsi train select karni hai?';
    expect(long.length).toBeGreaterThan(160);   // speechOf only condenses text replies above 160 chars
    expect(speechOf(long, 'TEXT', 'Kaunsi train select karni hai?').length).toBeLessThan(long.length);
    const ar = buildAssistantResponse({ text: 'Confirm karna hai?', mode: 'VOICE', state: 'AWAITING_CONFIRMATION', pendingQuestion: 'ASK_CONFIRMATION' as any, question: 'Confirm karna hai?', cards: [], steps: [], error: null, rejectedClaims: [] });
    expect(ar).toMatchObject({ requiresConfirmation: true, speechText: 'Confirm karna hai?', error: null });
  });
});

describe('P16 reference resolution', () => {
  it('[16] "iska" resolves only with exactly one valid referent; booking refs only from history records', () => {
    const { s } = session();
    const R = new ConversationReferenceResolver();
    expect(R.pronoun('BOOKING', s, [])).toMatchObject({ ok: false, code: 'MISSING_CONTEXT' });
    const recs: any[] = [{ bookingId: 'B1', train: { trainNumber: '12497' }, journeyDate: KAL }, { bookingId: 'B2', train: { trainNumber: '12014' }, journeyDate: PARSO }];
    expect(R.pronoun('BOOKING', s, recs)).toMatchObject({ ok: false, code: 'AMBIGUOUS_REFERENCE' });
    s.activeBookingId = 'B2';
    expect(R.pronoun('BOOKING', s, recs)).toMatchObject({ ok: true, bookingId: 'B2' });
    expect(R.pronoun('LIVE_TRAIN', s, recs)).toMatchObject({ ok: true, trainNumber: '12014', source: 'BOOKING_RECORD' });
    expect(R.cls('3A', s)).toMatchObject({ ok: false, code: 'MISSING_CONTEXT' });
  });
});

describe('P16 new-journey reset (state layer)', () => {
  it('[17] reset is refused while a provider execution may be in flight; allowed from planning/terminal states', () => {
    expect(stateTransitionValidator.checkReset(BookingState.BOOKING_IN_PROGRESS).ok).toBe(false);
    expect(stateTransitionValidator.checkReset(BookingState.BOOKING_STATUS_UNKNOWN).ok).toBe(false);
    expect(stateTransitionValidator.checkReset(BookingState.BOOKING_CONFIRMED).ok).toBe(true);
    expect(stateTransitionValidator.checkReset(BookingState.SHOWING_TRAINS).ok).toBe(true);
  });

  it('[18] resetForNewJourney clears journey A planning slots, keeps booking history ids, bumps result version', () => {
    const { m, s } = journey();
    s.bookingState = BookingState.SHOWING_TRAINS;
    s.bookingRecordIds = ['BKG-A'];
    const v = s.searchResultsVersion || 0;
    const r: any = m.resetForNewJourney(s.sessionId);
    expect(r.ok).toBe(true);
    expect(s).toMatchObject({ bookingState: BookingState.IDLE, origin: undefined, destination: undefined, date: undefined, passengersCount: undefined });
    expect(s.bookingRecordIds).toEqual(['BKG-A']);
    expect(s.searchResultsVersion).toBe(v + 1);
    expect(r.cleared).toEqual(expect.arrayContaining(['origin', 'destination', 'date']));
  });
});

describe('P16 MockLLM scenarios + tool surface', () => {
  const llm = new MockLLMProvider();
  const decide = async (s: any, text: string) => (await llm.generateStructuredDecision({ userText: text, session: s, state: s.bookingState, history: [], tools: REGISTERED_TOOLS, missingFields: [], inputMode: 'TEXT' } as any)).decision;

  it('[19] STATION_CHOICE follow-up ("cantt wala") → pending role entity, never a guessed code', async () => {
    const { s } = session({ destination: 'NDLS', date: KAL, pendingInteraction: { type: 'CLARIFICATION_REQUIRED', data: { kind: 'STATION_CHOICE', role: 'origin', candidates: [{ code: 'UMB', name: 'Ambala Cantt' }, { code: 'UBC', name: 'Ambala City' }] } } });
    const d: any = await decide(s, 'cantt wala');
    expect(d.entities.originRaw).toBe('UMB');
    expect(d.toolCalls[0]).toMatchObject({ name: 'SEARCH_TRAINS', arguments: { origin: 'UMB', destination: 'NDLS' } });
  });

  it('[20] side question ("Waise 12497 kal chalti hai?") proposes no journey slots; conflict "haan" re-proposes the asked value', async () => {
    const { s } = journey();
    const d1: any = await decide(s, 'Waise 12497 kal chalti hai?');
    expect(d1.entities.dateRaw).toBeUndefined();
    expect(d1.entities.trainRef).toBeUndefined();
    expect(d1.toolCalls.map((c: any) => c.name)).toEqual(['GET_TRAIN_INFO']);
    s.pendingInteraction = { type: 'CLARIFICATION_REQUIRED', data: { kind: 'CONTEXT_CONFLICT', field: 'destination', proposedCode: 'LDH', current: 'NDLS' } };
    const d2: any = await decide(s, 'haan');
    expect(d2.entities).toEqual({ destinationRaw: 'LDH' });
    expect(d2.toolCalls[0]).toMatchObject({ name: 'SEARCH_TRAINS', arguments: { destination: 'LDH' } });
    const d3: any = await decide(s, 'nahi');
    expect(d3.toolCalls.length).toBe(0);
  });

  it('[21] Part 44: exactly 7 LLM tools; no booking/cancel/modify/refund mutation tool exposed', () => {
    const names = REGISTERED_TOOLS.map((t: any) => t.name);
    expect(names.length).toBe(7);
    expect(names.filter((n: string) => /BOOK|CANCEL|MODIFY|REFUND|PAY|CONFIRM/.test(n))).toEqual([]);
  });

  it('[22] the new conversation layer never reads credentials or the real-IRCTC flag', () => {
    for (const f of ['context-patch', 'conversation-context', 'grounding', 'input-normalizer', 'response-fact-guard', 'reference-resolution', 'assistant-response']) {
      const src = readFileSync(`server/ai/conversation/${f}.ts`, 'utf8');
      expect(src).not.toMatch(/process\.env|REAL_IRCTC_ENABLED|password|otp\b|captcha|cvv/i);
    }
  });
});
