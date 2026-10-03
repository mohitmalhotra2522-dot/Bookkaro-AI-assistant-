/**
 * PROMPT 26 — G2: strict seat-availability authority. Offline: no LLM, no network, no provider.
 * Availability is verified ONLY by a matching CHECK_AVAILABILITY result (train + date + class + status); keyword
 * presence (LLM text, backend reply, user words) and non-availability tools are never evidence.
 */
import { describe, it, expect, vi } from 'vitest';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import {
  classifyAvailabilityClaim, judgeAvailabilityClaim, collectAvailabilityEvidence, type AvailabilityContext
} from '../../server/ai/response/availability-authority';
import { guardResponseFacts } from '../../server/ai/conversation/response-fact-guard';
import { railwayResponseGrounding } from '../../server/ai/tool-runtime/railway-response-grounding';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const TRAINS = [
  { trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '10:50', duration: '5h 55m', classes: [{ code: 'CC', fare: 520, avail: 'Available' }, { code: '2S', fare: 120, avail: 'Available' }], resultId: 'rs:1' },
  { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', origin: 'ASR', destination: 'NDLS', departure: '06:35', arrival: '13:50', duration: '7h 15m', classes: [{ code: '3A', avail: 'Available' }, { code: 'CC', avail: 'RAC 4' }, { code: 'SL', avail: 'Waitlist 12' }, { code: '2S' }], resultId: 'rs:2' }
];
const LISTED = [{ num: '12014', classes: ['CC', '2S'] }, { num: '12497', classes: ['3A', 'CC', 'SL', '2S'] }];

function session(extra: Record<string, any> = {}) {
  const st = new ConversationStateManager();
  const s: any = st.getSession(st.createSession().sessionId);
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar', destinationName: 'New Delhi', date: KAL, bookingState: 'SHOWING_TRAINS',
    searchResults: { trains: TRAINS.map(t => ({ ...t, classes: t.classes.map(c => ({ ...c })) })) }, pendingInteraction: { type: 'TRAIN_SELECTION_REQUIRED' } }, extra);
  return s;
}
/** a validated CHECK_AVAILABILITY runtime step (the only availability authority) */
const availStep = (d: Record<string, any>, id = 'te_av_1') => ({ toolCall: { name: 'CHECK_AVAILABILITY', callId: 'a1' }, result: { toolName: 'CHECK_AVAILABILITY', success: true, data: { trainNumber: '12014', travelClass: 'CC', date: KAL, status: 'Available', available: true, ...d } }, status: 'ok', execution: { status: 'SUCCEEDED', toolExecutionId: id } });
const step = (toolName: string, data: any) => ({ toolCall: { name: toolName, callId: 'x' }, result: { toolName, success: true, data }, status: 'ok', execution: { status: 'SUCCEEDED' } });
const ctx = (steps: any[] = [], s: any = session()): AvailabilityContext => ({ session: s, evidence: collectAvailabilityEvidence(s, steps), trains: LISTED });
const llm = () => ({ providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn(async () => ({ text: 'WORDING' })) } as any);
function compose(s: any, agentText: string, o: { userText?: string; general?: boolean; steps?: any[]; backendReply?: string; mode?: 'TEXT' | 'VOICE' } = {}) {
  return naturalResponseComposer.compose({
    llm: llm(), session: s, userText: o.userText ?? 'theek hai', backendReply: o.backendReply ?? '2 trainein mili hain. Kaunsi train chahiye?', deterministicSpeech: 'DETERMINISTIC',
    stateBefore: s.bookingState, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null,
    steps: o.steps ?? [], appliedActions: [], changes: [], error: null, pendingQuestionCode: 'SELECT_TRAIN', pendingQuestion: 'Kaunsi train chahiye?',
    history: [], mode: o.mode ?? 'TEXT', agentText, general: !!o.general
  } as any);
}
const reasons = (r: any) => r.rejected.map((x: any) => x.reason);

describe('P26 G2 — negative: nothing but CHECK_AVAILABILITY proves seats (Part 8)', () => {
  it('[N1–N3] RAC explanations are GENERAL_KNOWLEDGE; a class list is CLASS_LIST — no availability tool required', () => {
    const c = ctx();
    for (const t of ['RAC mein cancellation hone par seat confirm ho sakti hai.', 'RAC passengers berth share kar sakte hain.', 'RAC passengers ko berth sharing mil sakti hai.']) {
      expect(classifyAvailabilityClaim(t), t).toBe('GENERAL_KNOWLEDGE_CLAIM');
      expect(judgeAvailabilityClaim(t, c), t).toMatchObject({ outcome: 'GENERAL_KNOWLEDGE_CLAIM', reason: null });
    }
    expect(classifyAvailabilityClaim('12014 mein CC aur 2S available hain.')).toBe('CLASS_LIST');
    expect(judgeAvailabilityClaim('12014 mein CC aur 2S available hain.', c)).toMatchObject({ outcome: 'CLASS_LIST', reason: null });
    expect(judgeAvailabilityClaim('12014 mein CC aur 2S classes listed hain.', c)).toMatchObject({ outcome: 'NONE', reason: null });
    for (const t of ['RAC kya hota hai?', 'Shatabdi aur Vande Bharat mein kya difference hai?', 'Tatkal mein seats jaldi bhar jaati hain.', '12014 CC ki availability check karun?'])
      expect(judgeAvailabilityClaim(t, c).reason, t).toBeNull();
  });

  it('[N4–N6 + Part 4] live claims without CHECK_AVAILABILITY evidence → UNVERIFIED_AVAILABILITY', () => {
    const c = ctx();
    for (const t of ['12014 mein CC available hai.', 'Kal 12014 mein 3A seats available hain.', '12014 mein RAC 5 available hai.', '12014 mein RAC available hai.',
      'Is train mein 5 seats available hain.', '2 berths available hain.', 'RAC 12 available hai.', 'WL 4 hai.', 'Seats available hain.', '12014 mein CC seats available hain.', '12014 full hai.']) {
      expect(classifyAvailabilityClaim(t), t).toBe('LIVE_AVAILABILITY_CLAIM');
      expect(judgeAvailabilityClaim(t, c), t).toMatchObject({ outcome: 'UNVERIFIED_AVAILABILITY', reason: 'UNVERIFIED_AVAILABILITY' });
    }
  });

  it('[N7 + Part 5] a user statement is USER_PROVIDED_FACT — never promoted; acknowledging it is allowed, repeating it as fact is not', async () => {
    expect(classifyAvailabilityClaim('CC available hai.', 'USER')).toBe('USER_PROVIDED_FACT');
    expect(classifyAvailabilityClaim('12014 mein RAC 5 hai.', 'USER')).toBe('USER_PROVIDED_FACT');
    expect(judgeAvailabilityClaim('CC available hai.', { ...ctx(), origin: 'USER' })).toMatchObject({ outcome: 'USER_PROVIDED_FACT', provenance: { claimType: 'USER_PROVIDED', verified: false, sourceTool: null } });
    const s = session();
    const echo = await compose(s, 'Haan, 12014 mein CC available hai.', { userText: '12014 mein CC available hai na?' });
    expect(reasons(echo)).toEqual(['UNVERIFIED_AVAILABILITY']);                 // the user's words are not evidence
    const ack = await compose(s, 'Aapne bataya 12014 mein CC available hai — ise abhi railway data se verify nahi kiya gaya.', { userText: '12014 mein CC available hai na?' });
    expect(ack.rejected).toEqual([]);
    expect(ack.provenance![0]).toMatchObject({ claimType: 'USER_PROVIDED', factSubtype: 'SEAT_AVAILABILITY', verified: false, sourceTool: null });
    expect(s.availability).toBeUndefined();                                     // nothing was promoted into session facts
  });

  it('[Part 7] keyword presence is never evidence: backend reply / user text full of "Available, RAC 4, WL 12, seats" proves nothing', async () => {
    const s = session();
    const r = await compose(s, '12014 mein CC available hai. 12497 CC mein RAC 4 hai.', { backendReply: 'CC: Available. RAC 4. WL 12. Seats available hain.', userText: 'RAC 4 aur seats available hai kya?' });
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY', 'UNVERIFIED_AVAILABILITY']);
    expect(r.text).not.toMatch(/available hai|RAC 4/);
  });
});

describe('P26 G2 — no cross-tool leakage (Part 10)', () => {
  it('[L1] SEARCH_TRAINS (even with per-class "avail"), GET_TRAIN_INFO, GET_TIMETABLE, GET_FARE and failed checks yield ZERO evidence', () => {
    const s = session({ lastTrainInfo: { trainNumber: '12014', status: 'Available', travelClass: 'CC' }, lastTimetable: { trainNumber: '12014', status: 'Available' }, fare: { trainNumber: '12014', travelClass: 'CC', perPassenger: 520, total: 520, status: 'Available' } });
    const steps = [
      step('SEARCH_TRAINS', { trains: TRAINS, status: 'Available' }), step('GET_TRAIN_INFO', { trainNumber: '12014', travelClass: 'CC', status: 'Available', available: true }),
      step('GET_TIMETABLE', { trainNumber: '12014', travelClass: 'CC', status: 'Available' }), step('GET_FARE', { trainNumber: '12014', travelClass: 'CC', status: 'Available', perPassenger: 520 }),
      { ...availStep({}), status: 'error', result: { toolName: 'CHECK_AVAILABILITY', success: false, data: { trainNumber: '12014', travelClass: 'CC', status: 'Available' } } }
    ];
    expect(collectAvailabilityEvidence(s, steps)).toEqual([]);
    expect(judgeAvailabilityClaim('12014 mein CC available hai.', ctx(steps, s)).outcome).toBe('UNVERIFIED_AVAILABILITY');
  });

  it('[L2] the composer and BOTH legacy layers (fact guard, grounding) apply the same scoped rule', async () => {
    const other = session({ availability: { CC: { trainNumber: '12497', travelClass: 'CC', date: KAL, status: 'RAC 4', available: false, toolExecutionId: 'te_9' } } });
    // another train's availability result does not prove 12014
    expect(guardResponseFacts('12014 mein CC available hai.', { session: other, steps: [] }).rejected).toEqual(['AVAILABILITY_CLAIM']);
    expect(railwayResponseGrounding.validate('12014 CC mein RAC 4 hai.', { session: other, steps: [] }).rejected).toContain('AVAILABILITY_CODE');
    // …and the matching one does
    expect(railwayResponseGrounding.validate('12497 CC mein RAC 4 hai.', { session: other, steps: [] }).rejected).toEqual([]);
    // general explanations pass every layer (no keyword guard overrides the classification)
    expect(guardResponseFacts('RAC mein cancellation hone par seat confirm ho sakti hai.', { session: session(), steps: [] }).rejected).toEqual([]);
    const fareOnly = await compose(session({ selectedTrain: { number: '12014', name: 'Amritsar Shatabdi Express', classes: [{ code: 'CC' }, { code: '2S' }] }, selectedClass: 'CC', fare: { trainNumber: '12014', travelClass: 'CC', passengersCount: 1, perPassenger: 520, total: 520 } }),
      '12014 CC ka fare ₹520 hai. CC mein seats available hain.', { steps: [step('GET_FARE', { trainNumber: '12014', travelClass: 'CC', passengersCount: 1, perPassenger: 520, total: 520 }), step('GET_TRAIN_INFO', { trainNumber: '12014', trainName: 'Amritsar Shatabdi Express' })] });
    expect(reasons(fareOnly)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(fareOnly.text).toMatch(/^12014 CC ka fare ₹520 hai\./);
  });
});

describe('P26 G2 — positive: matching CHECK_AVAILABILITY results (Part 9) + provenance (Part 6)', () => {
  it('[P1] AVAILABLE for 12014 / kal / CC → "12014 mein CC available hai." accepted with explicit provenance', async () => {
    const r = await compose(session(), '12014 mein CC available hai.', { steps: [availStep({})] });
    expect(r.rejected).toEqual([]);
    expect(r.text).toBe('12014 mein CC available hai. Kaunsi train chahiye?');
    expect(r.provenance![0]).toEqual({ claimType: 'RAILWAY_LIVE_FACT', factSubtype: 'SEAT_AVAILABILITY', verified: true, sourceTool: 'CHECK_AVAILABILITY', sourceResultId: 'te_av_1',
      fields: ['availability', 'trainNumber', 'date', 'travelClass'], trainNumber: '12014', date: KAL, travelClass: 'CC', availability: 'Available' });
  });

  it('[P2] RAC 5 and WL 4 results: the matching status is accepted, a different number / status is a mismatch', () => {
    const rac = ctx([availStep({ status: 'RAC 5', available: false })]);
    expect(judgeAvailabilityClaim('12014 CC mein RAC 5 hai.', rac)).toMatchObject({ outcome: 'VERIFIED_AVAILABILITY', provenance: { availability: 'RAC 5' } });
    expect(judgeAvailabilityClaim('12014 CC mein RAC 3 hai.', rac).reason).toBe('AVAILABILITY_MISMATCH:RAC 3');
    expect(judgeAvailabilityClaim('12014 mein CC available hai.', rac).reason).toBe('AVAILABILITY_MISMATCH');   // RAC ≠ available
    const wl = ctx([availStep({ status: 'Waitlist 4', available: false })]);
    expect(judgeAvailabilityClaim('12014 CC mein WL 4 hai.', wl).outcome).toBe('VERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('12014 CC mein waitlist 4 chal raha hai.', wl).outcome).toBe('VERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('12014 CC mein WL 9 hai.', wl).reason).toBe('AVAILABILITY_MISMATCH:WL 9');
    // the session entry committed by the runtime from CHECK_AVAILABILITY is the same authority
    const sess = session({ availability: { CC: { trainNumber: '12014', travelClass: 'CC', date: KAL, status: 'RAC 5', available: false, toolExecutionId: 'te_s' } } });
    expect(judgeAvailabilityClaim('12014 CC mein RAC 5 hai.', ctx([], sess))).toMatchObject({ outcome: 'VERIFIED_AVAILABILITY', provenance: { sourceResultId: 'te_s' } });
  });

  it('[P3] another train / date / class is never accepted; an enumeration needs a result per class', () => {
    const c = ctx([availStep({})]);                                            // 12014 · kal · CC · Available
    expect(judgeAvailabilityClaim('12497 mein CC available hai.', c).reason).toBe('UNVERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('Parso 12014 mein CC available hai.', c).reason).toBe('UNVERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('12014 mein 2S available hai.', c).reason).toBe('UNVERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('12014 mein 3A available hai.', c).reason).toBe('CLASS_NOT_LISTED:3A');
    expect(judgeAvailabilityClaim('12014 mein CC aur 2S available hain.', c).outcome).toBe('CLASS_LIST');   // 2S unchecked → stays a class list
    const both = ctx([availStep({}), availStep({ travelClass: '2S' }, 'te_av_2')]);
    expect(judgeAvailabilityClaim('12014 mein CC aur 2S available hain.', both).outcome).toBe('VERIFIED_AVAILABILITY');
    const parso = ctx([availStep({ date: PARSO })]);
    expect(judgeAvailabilityClaim('12014 mein CC available hai.', parso).reason).toBe('UNVERIFIED_AVAILABILITY');   // session date is kal
  });
});

describe('P26 G2 — composer: GK regression + clean removal (Parts 12–13)', () => {
  it('[G1] RAC explanations and a class list survive a NON-general turn with trains on screen and no availability result', async () => {
    const r = await compose(session(), 'RAC mein cancellation hone par seat confirm ho sakti hai. RAC passengers berth share kar sakte hain. 12014 mein CC aur 2S classes listed hain.', { userText: 'RAC kya hota hai?' });
    expect(r.rejected).toEqual([]);
    expect(r.text).toBe('RAC mein cancellation hone par seat confirm ho sakti hai. RAC passengers berth share kar sakte hain. 12014 mein CC aur 2S classes listed hain. Kaunsi train chahiye?');
    const g = await compose(session(), 'Shatabdi din ki chair car train hai, jabki Vande Bharat semi high-speed train hai jisme CC aur EC classes hoti hain.', { general: true, userText: 'Shatabdi aur Vande Bharat mein kya difference hai?' });
    expect(g.rejected).toEqual([]);
  });

  it('[R1] removed availability items leave no "1." / "2." / "Aur" / fragments; surrounding facts are preserved', async () => {
    const r = await compose(session(), '1. 12014 mein CC available hai.\n2. 12014 10:50 par pahunchti hai.');
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(r.text).toBe('12014 10:50 par pahunchti hai. Kaunsi train chahiye?');
    const a = await compose(session(), '12014 mein RAC 5 available hai. Aur 12014 04:55 par nikalti hai.\n- ');
    expect(a.text).toBe('12014 04:55 par nikalti hai. Kaunsi train chahiye?');
    expect(a.text).not.toMatch(/(^|\s)\d{1,2}[.)](\s|$)|(^|\s)[-*•](\s|$)|^Aur\b/);
  });
});
