/**
 * PROMPT 33 — G2: AI-driven booking preparation + review + secure handoff readiness (domain / security).
 *   - structured bookingPreparation view for the LLM (known / missing; statuses only — no ids, amounts, credentials)
 *   - a NEW review version needs availability + fare from the review-building turn (freshSince)
 *   - review requires current availability AND fare (default policy) — failures report the real P32 reason
 *   - informed confirmation: a new review reply must carry the confirmed facts
 *   - booking-state claims: never "booked"; handoff / review only when real
 *   - preparation changes are not post-booking lifecycle claims
 *   - confirmation policy unchanged; no booking / payment / IRCTC tools
 * Offline: MockLLM + mock railway provider. No network, no credits, no real booking.
 */
import { describe, it, expect } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { lifecycleClaimGuard } from '../../server/ai/agent/conversation-agent-orchestrator';
import { bookingPreparationView, buildLLMContext } from '../../server/ai/context/context-builder';
import { BookingReadinessEvaluator, defaultPolicy } from '../../server/booking/booking-readiness';
import { dependencyFailureReason, BookingPreparationService } from '../../server/booking/booking-preparation-service';
import { missingReviewFacts } from '../../server/ai/response/natural-response-composer';
import { verifyBookingStateClaim, guardBookingStateClaims } from '../../server/ai/response/booking-state-claims';
import { classifyConfirmation } from '../../server/booking/handoff/confirmation-policy';
import { passengerCollection } from '../../server/booking/passenger-collection';
import { DEFAULT_PREPARATION_POLICY } from '../../shared/constants';
import { BookingState } from '../../shared/states';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { nativeToolDefs } from '../../server/ai/providers/openai-compatible-llm';

const CREDENTIAL_RE = /password|otp|captcha|cvv|upi\s?pin|cardNumber|cookie|token|irctcUser/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function handSession(o: { pax?: number; p1?: boolean } = {}) {
  const st = new ConversationStateManager();
  const s: any = st.getSession(st.createSession().sessionId);
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', date: '2026-10-05', selectedTrain: { number: '12497', name: 'Shan-e-Punjab Express' }, selectedClass: '3A',
    bookingState: BookingState.COLLECTING_PASSENGER_DETAILS });
  if (o.pax) { s.passengersCount = o.pax; passengerCollection.ensureSlots(s); }
  if (o.p1) Object.assign(s.passengers[0], { name: 'Rahul', age: 31, gender: 'MALE' });
  return s;
}

/** Real session through the offline MockLLM flow (authoritative results, review, confirmation, handoff). */
async function flow(upto: 'review' | 'handoff') {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(new MockLLMProvider({}), state, new RailwayToolService());
  const sid = state.createSession().sessionId;
  for (const t of ['Kal Amritsar se Delhi jaana hai', '12014', 'CC', '1', 'Rahul 31 male']) await orch.processTurn(sid, t, 'TEXT');
  if (upto === 'handoff') await orch.processTurn(sid, 'haan', 'TEXT');
  return { state, orch, sid, s: state.getSession(sid) as any };
}

describe('P33 G2 — structured booking preparation for the LLM', () => {
  it('[1] no booking started → no bookingPreparation view (GK / info turns stay unchanged)', () => {
    const st = new ConversationStateManager();
    const s: any = st.getSession(st.createSession().sessionId);
    expect(bookingPreparationView(s)).toBeUndefined();
    expect(buildLLMContext(s, [])).not.toHaveProperty('bookingPreparation');
  });

  it('[2] partial passengers: count 2, P1 complete, P2 missing → only P2 fields are missing (never re-ask P1)', () => {
    const v: any = bookingPreparationView(handSession({ pax: 2, p1: true }));
    expect(v).toMatchObject({ origin: 'ASR', destination: 'NDLS', journeyDate: '2026-10-05', train: { number: '12497' }, class: '3A', passengerCount: 2 });
    expect(v.passengers[0]).toEqual({ passenger: 1, name: 'Rahul', age: 31, gender: 'MALE', missing: [] });
    expect(v.passengers[1]).toEqual({ passenger: 2, missing: ['name', 'age', 'gender'] });
    expect(v.missing).toEqual(['passenger2.name', 'passenger2.age', 'passenger2.gender']);
    expect(v).toMatchObject({ availabilityCheck: 'NOT_CHECKED', fareCheck: 'NOT_CHECKED', review: null, handoff: null });
  });

  it('[3] count unknown → passengerCount missing; no train → train + class missing', () => {
    const s = handSession();
    expect((bookingPreparationView(s) as any).missing).toEqual(['passengerCount']);
    s.selectedTrain = undefined; s.selectedClass = undefined; s.passengersCount = 1;
    expect((bookingPreparationView(s) as any).missing).toEqual(expect.arrayContaining(['train', 'class', 'passenger1.name']));
  });

  it('[4] privacy: no internal ids, no fare amount / availability value, no credential keys; sessionView unchanged', async () => {
    const { s } = await flow('review');
    const ctx: any = buildLLMContext(s, []);
    const j = JSON.stringify(ctx.bookingPreparation);
    expect(j).not.toMatch(UUID_RE);
    expect(j).not.toMatch(/"id"|passengerId|toolExecutionId|resultSetId|sourceResultId/);
    expect(j).not.toMatch(/total|perPassenger|₹|"Available"/);
    expect(j).not.toMatch(CREDENTIAL_RE);
    expect(ctx.bookingPreparation).toMatchObject({ availabilityCheck: 'MATCHING_RESULT', fareCheck: 'MATCHING_RESULT', review: { version: 1, status: 'CURRENT' }, missing: [] });
    expect(ctx.sessionView.passengerDetails).toEqual({ required: 1, completed: 1, currentIndex: expect.any(Number) });
  });
});

describe('P33 G2 — review authority + freshness', () => {
  const ev = new BookingReadinessEvaluator();
  const withData = (retrievedAt: string) => {
    const s = handSession({ pax: 2 });
    s.availability = { '3A': { trainNumber: '12497', travelClass: '3A', date: '2026-10-05', status: 'Available', retrievedAt } };
    s.fare = { trainNumber: '12497', travelClass: '3A', passengersCount: 2, origin: 'ASR', destination: 'NDLS', total: 1300, perPassenger: 650, retrievedAt };
    return s;
  };

  it('[5] freshSince: data from a previous turn (within TTL) is STALE for a NEW review; data from this turn is FRESH', () => {
    const now = Date.now();
    const prev = withData(new Date(now - 20_000).toISOString());
    expect(ev.availabilityFreshness(prev, now)).toBe('FRESH');                 // TTL alone (confirmation boundary) unchanged
    expect(ev.fareFreshness(prev, now)).toBe('FRESH');
    expect(ev.availabilityFreshness(prev, now, now - 5_000)).toBe('STALE');    // turn started 5 s ago → previous-turn data
    expect(ev.fareFreshness(prev, now, now - 5_000)).toBe('STALE');
    const cur = withData(new Date(now - 1_000).toISOString());
    expect(ev.availabilityFreshness(cur, now, now - 5_000)).toBe('FRESH');
    expect(ev.fareFreshness(cur, now, now - 5_000)).toBe('FRESH');
  });

  it('[6] mismatched basis is never authority (class / passenger count changed)', () => {
    const now = Date.now();
    const s = withData(new Date(now).toISOString());
    s.passengersCount = 3;
    expect(ev.fareFreshness(s, now)).toBe('STALE');
    s.passengersCount = 2; s.selectedClass = 'SL';
    expect(ev.availabilityFreshness(s, now)).toBe('MISSING');
  });

  it('[7] default policy REQUIRES availability and fare — missing data blocks the review (REQUIRED_TOOL_DATA_MISSING)', () => {
    expect(DEFAULT_PREPARATION_POLICY).toEqual({ requireAvailability: true, requireFare: true });
    expect(defaultPolicy()).toMatchObject({ requireAvailability: true, requireFare: true });
  });

  it('[8] dependency failure reasons are distinct per P32 outcome and never claim readiness', () => {
    const codes = ['TOOL_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_DATA_INVALID', 'TOOL_NOT_IMPLEMENTED', 'DATA_UNAVAILABLE'];
    const reasons = codes.map(dependencyFailureReason);
    expect(new Set(reasons).size).toBe(codes.length);
    expect(reasons[0]).toMatch(/time par jawab nahi/);
    expect(reasons[1]).toMatch(/uplabdh nahi/);
    expect(reasons[2]).toMatch(/sahi format/);
    for (const r of reasons) expect(r).not.toMatch(/ready|taiyaar|confirm/i);
  });

  it('[9] blocker message names the dependency + its real reason; never "ready"', () => {
    const svc = new BookingPreparationService(new ConversationStateManager() as any);
    const s: any = { preparationDependencies: { availability: { status: 'UNAVAILABLE', errorCode: 'TOOL_TIMEOUT' }, fare: { status: 'UNAVAILABLE', errorCode: 'PROVIDER_DATA_INVALID' } } };
    const m = svc.blockerMessage({ blockers: ['REQUIRED_TOOL_DATA_MISSING'], availability: 'MISSING', fare: 'MISSING' } as any, s);
    expect(m).toMatch(/availability aur fare verify hona zaroori hai/);
    expect(m).toMatch(/availability check mein railway provider ne time par jawab nahi diya/);
    expect(m).toMatch(/fare check mein provider ka jawab sahi format mein nahi tha/);
    expect(m).toMatch(/review abhi nahi bana/);
    expect(m).not.toMatch(/booking ready|handoff ready/i);
  });
});

describe('P33 G2 — informed confirmation (review facts) + booking-state claims', () => {
  const snap = { train: { number: '12497' }, travelClass: '3A', fare: { status: 'VERIFIED', total: 1300, perPassenger: 650 }, availability: { status: 'VERIFIED', value: 'Available' } };

  it('[10] a reply covering train / class / fare / availability passes in natural wording', () => {
    expect(missingReviewFacts('12497 Shan-e-Punjab, 3A, do log — total ₹1,300, seats available hain. Confirm karun?', snap)).toEqual([]);
    expect(missingReviewFacts('12497 mein third AC, 650 per passenger, availability uplabdh hai.', snap)).toEqual([]);
    expect(missingReviewFacts('12497 3A — ₹1300, waiting list 8.', { ...snap, availability: { status: 'VERIFIED', value: 'WL 8' } })).toEqual([]);
  });

  it('[11] a reply omitting the confirmed facts is flagged (→ validated review fallback)', () => {
    expect(missingReviewFacts('Theek hai. Confirm karna hai?', snap)).toEqual(['TRAIN', 'CLASS', 'FARE', 'AVAILABILITY']);
    expect(missingReviewFacts('12497 3A ready hai, confirm karein?', snap)).toEqual(['FARE', 'AVAILABILITY']);
    expect(missingReviewFacts('12497 3A ₹999 available.', snap)).toEqual(['FARE']);                       // wrong amount is not the fare
    // unverified fare / availability are not demanded (the review itself says they are not verified)
    expect(missingReviewFacts('12497 3A.', { ...snap, fare: { status: 'NOT_VERIFIED' }, availability: { status: 'NOT_VERIFIED' } })).toEqual([]);
  });

  it('[12] "booked" claims are NEVER valid — not even in IRCTC_HANDOFF_READY; negations are not claims', async () => {
    const { s } = await flow('handoff');
    expect(s.bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    for (const t of ['Ticket book ho gayi hai!', 'Aapki booking confirmed hai.', 'Booked successfully.', 'Ticket has been booked.', 'Seat confirm ho gayi.'])
      expect([t, verifyBookingStateClaim(t, s).reason]).toEqual([t, 'BOOKED_CLAIM_NEVER_VALID']);
    for (const t of ['Ticket abhi book nahi hua hai.', 'The ticket is not booked yet.', 'Booking confirm karni hai?', 'Actual railway booking abhi enabled nahi hai.'])
      expect([t, verifyBookingStateClaim(t, s).reason]).toEqual([t, null]);
    expect(verifyBookingStateClaim('Ticket book ho gayi, koi tension nahi.', s).reason).toBe('BOOKED_CLAIM_NEVER_VALID');   // far-away negation does not excuse it
  });

  it('[13] handoff claims only with a READY handoff; review claims only with a CURRENT review', async () => {
    const h = await flow('handoff');
    expect(verifyBookingStateClaim('Details confirmed hain; booking handoff ready hai.', h.s).reason).toBeNull();
    const r = await flow('review');
    expect(r.s.bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(verifyBookingStateClaim('Details confirmed hain; booking handoff ready hai.', r.s).reason).toBe('HANDOFF_CLAIM_WITHOUT_HANDOFF');
    expect(verifyBookingStateClaim('Review ready hai.', r.s).reason).toBeNull();
    r.s.passengersCount = 2;                                                       // data moved on → review no longer current
    expect(verifyBookingStateClaim('Review ready hai.', r.s).reason).toBe('REVIEW_CLAIM_WITHOUT_CURRENT_REVIEW');
    const fresh = new ConversationStateManager();
    const empty: any = fresh.getSession(fresh.createSession().sessionId);
    expect(verifyBookingStateClaim('Final details ready hain.', empty).reason).toBe('REVIEW_CLAIM_WITHOUT_CURRENT_REVIEW');
  });

  it('[14] guardBookingStateClaims removes only the failing sentence', () => {
    const st = new ConversationStateManager();
    const s: any = st.getSession(st.createSession().sessionId);
    const g = guardBookingStateClaims('Dono passengers note kar liye. Review ready. Ticket book ho gayi!', s);
    expect(g.text).toBe('Dono passengers note kar liye.');
    expect(g.removed.map(r => r.reason)).toEqual(['REVIEW_CLAIM_WITHOUT_CURRENT_REVIEW', 'BOOKED_CLAIM_NEVER_VALID']);
  });

  it('[15] a backend-applied preparation change is not a lifecycle claim; cancellation / refund still removed', () => {
    expect(lifecycleClaimGuard('Age update kar di. 12497 3A rakhi hai.', true)).toBe('Age update kar di. 12497 3A rakhi hai.');
    expect(lifecycleClaimGuard('Age update kar di. Booking cancel ho gayi.', true)).not.toMatch(/cancel ho gayi/);
    expect(lifecycleClaimGuard('Refund mil gaya.', true)).not.toMatch(/Refund mil gaya/);
    expect(lifecycleClaimGuard('Age update kar di.')).not.toMatch(/Age update kar di/);   // P15 default unchanged
  });
});

describe('P33 G2 — confirmation policy unchanged; no booking / payment / IRCTC tools', () => {
  it('[16] explicit / ambiguous / not-a-confirmation (policy not broadened)', () => {
    for (const t of ['haan', 'yes', 'confirm', 'continue', 'proceed']) expect([t, classifyConfirmation(t)]).toEqual([t, 'EXPLICIT']);
    for (const t of ['theek hai', 'hmm', 'achha', 'ok']) expect([t, classifyConfirmation(t)]).toEqual([t, 'AMBIGUOUS']);
    expect(classifyConfirmation('do it')).not.toBe('EXPLICIT');
  });

  it('[17] the LLM tool set has no booking / payment / IRCTC / OTP / CAPTCHA tool', () => {
    const names = nativeToolDefs({ tools: REGISTERED_TOOLS }).map((t: any) => t.function?.name);
    for (const f of ['BOOK_TICKET', 'MAKE_PAYMENT', 'SUBMIT_IRCTC_BOOKING', 'PAYMENT_API', 'OTP_VERIFY', 'CAPTCHA_SUBMIT']) expect(names).not.toContain(f);
    expect(names.join(' ')).not.toMatch(/pay|otp|captcha|irctc|book_ticket/i);
  });

  it('[18] handoff-ready session: execution disabled, no PNR / transaction id, snapshot immutable', async () => {
    const { s } = await flow('handoff');
    expect(s.handoffSession.status).toBe('READY');
    expect(s.bookingExecution?.pnr ?? null).toBeNull();                         // no PNR (null / absent)
    expect(JSON.stringify(s.handoffSession)).not.toMatch(/pnr|transactionId|paymentId/i);
    expect(Object.isFrozen(s.review.snapshot)).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(CREDENTIAL_RE);
  });
});
