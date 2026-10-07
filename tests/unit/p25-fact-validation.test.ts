/**
 * PROMPT 25 — G2: fact validation (claim classification, structured railway claims, provenance, cleanup, language)
 * and deterministic tool-argument validation / retry cap. Offline: no LLM, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { naturalResponseComposer, toSentences } from '../../server/ai/response/natural-response-composer';
import { buildFactIndex, judgeTimes, judgeComparison, isClassListClaim, repairClassList, classifyPaxCount, derivedTrainCounts } from '../../server/ai/response/claim-facts';
import { validateToolArgumentShape } from '../../server/ai/tool-runtime/tool-argument-schema';
import { normalizeToolArguments } from '../../server/ai/tool-runtime/tool-argument-normalizer';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { detectLanguageStyle } from '../../shared/voice/language-style';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const KAL = (resolveDate('kal') as any).date as string;
const TRAINS = [
  { trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '10:50', duration: '5h 55m', classes: [{ code: 'CC', fare: 520 }, { code: '2S', fare: 120 }], resultId: 'rs:1' },
  { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', origin: 'ASR', destination: 'NDLS', departure: '06:35', arrival: '13:50', duration: '7h 15m', classes: [{ code: '3A' }, { code: 'CC' }, { code: 'SL' }, { code: '2S' }], resultId: 'rs:2' },
  { trainNumber: '18238', trainName: 'Chhattisgarh Express', origin: 'ASR', destination: 'NDLS', departure: '19:35', arrival: '04:10', duration: '8h 35m', classes: [{ code: '3A' }, { code: 'SL' }], resultId: 'rs:3' }
];
const FARE = { trainNumber: '12497', travelClass: '3A', passengersCount: 1, perPassenger: 650, total: 650, currency: 'INR' };

function session(extra: Record<string, any> = {}) {
  const st = new ConversationStateManager();
  const s: any = st.getSession(st.createSession().sessionId);
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar', destinationName: 'New Delhi', date: KAL, bookingState: 'SHOWING_TRAINS',
    searchResults: { trains: TRAINS.map(t => ({ ...t, classes: t.classes.map(c => ({ ...c })) })) }, pendingInteraction: { type: 'TRAIN_SELECTION_REQUIRED' } }, extra);
  return s;
}
const fareStep = { toolCall: { name: 'GET_FARE', callId: 'f1' }, result: { toolName: 'GET_FARE', success: true, data: FARE }, status: 'ok', execution: { status: 'SUCCEEDED' } };
const llm = () => ({ providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn(async () => ({ text: 'WORDING' })) } as any);
function compose(s: any, agentText: string, o: { userText?: string; general?: boolean; steps?: any[]; mode?: 'TEXT' | 'VOICE'; q?: string | null; backendReply?: string; llm?: any } = {}) {
  return naturalResponseComposer.compose({
    llm: o.llm ?? llm(), session: s, userText: o.userText ?? 'theek hai', backendReply: o.backendReply ?? '3 trainein mili hain. Kaunsi train chahiye?', deterministicSpeech: 'DETERMINISTIC',
    stateBefore: s.bookingState, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null,
    steps: o.steps ?? [], appliedActions: [], changes: [], error: null,
    pendingQuestionCode: o.q === null ? null : 'SELECT_TRAIN', pendingQuestion: o.q === null ? null : (o.q ?? 'Kaunsi train chahiye?'),
    history: [], mode: o.mode ?? 'TEXT', agentText, general: !!o.general
  } as any);
}
const reasons = (r: any) => r.rejected.map((x: any) => x.reason);

describe('P25 G2 — claim classification + structured railway claims', () => {
  it('[A] RAC / general knowledge keeps its numbers and counts — general turn AND mid-search turn; specific invented facts still go', async () => {
    const empty = session({ searchResults: undefined, pendingInteraction: undefined });
    const g = await compose(empty, 'RAC ka matlab hai Reservation Against Cancellation. RAC mein do passengers ek berth share karte hain. Ek PNR mein maximum 6 passengers ho sakte hain. Tatkal booking AC ke liye subah 10:00 baje khulti hai.', { general: true, q: null, userText: 'RAC kya hota hai?' });
    expect(g).toMatchObject({ source: 'LLM', authoredBy: 'AGENT', rejected: [] });
    expect(g.text).toMatch(/do passengers ek berth.*6 passengers.*10:00/s);
    expect(g.provenance!.every(p => p.claimType === 'GENERAL_KNOWLEDGE')).toBe(true);
    // same explanation in a NON-general turn (train list on screen, no availability result): not a live claim
    const mid = await compose(session(), 'RAC mein do passengers ek berth share karte hain. 12014 mein seats available hain.', { userText: 'RAC kya hota hai?' });
    expect(mid.text).toBe('RAC mein do passengers ek berth share karte hain.');   // P42.1: no backend-appended question
    expect(reasons(mid)).toEqual(['UNVERIFIED_AVAILABILITY']);
    // live Muse regression: HOW RAC works ("seat confirm ho jaati hai") is an explanation, not a seat claim — even with trains on screen
    const how = await compose(session(), 'RAC matlab Reservation Against Cancellation. RAC mein aadhi berth milti hai aur cancellation hone par seat confirm ho jaati hai. Chart ke baad bhi confirmed seat mil sakti hai.', { general: true, userText: 'RAC kya hota hai?' });
    expect(how.rejected).toEqual([]);
    expect(how.text).toMatch(/seat confirm ho jaati hai\. Chart ke baad bhi confirmed seat mil sakti hai\./);
    // …while a concrete, anchored seat claim without CHECK_AVAILABILITY is still rejected
    const anchored = await compose(session(), 'RAC ek quota hai. 12014 mein kal seat confirm milegi.', { general: true, userText: 'RAC kya hota hai?' });
    expect(anchored.rejected).toHaveLength(1);
    expect(anchored.text).not.toMatch(/12014 mein kal/);
    // general mode still rejects what it can falsely claim
    const bad = await compose(empty, 'Vande Bharat 06:00 baje chalti hai. 12951 Rajdhani sabse tez hai.', { general: true, q: null });
    expect(reasons(bad)).toEqual(['UNGROUNDED_TIME', 'UNGROUNDED_TRAIN_NUMBER:12951']);
  });

  it('[B] "12014 sabse pehle 10:50 par pahunchti hai." survives a no-tool follow-up; train ↔ time ↔ comparison is one structured claim', async () => {
    const s = session();
    const ok = await compose(s, '12014 sabse pehle 10:50 par pahunchti hai.', { general: true, userText: 'Inme se sabse pehle kaunsi pahunchti hai?' });
    expect(ok).toMatchObject({ source: 'LLM', rejected: [] });
    expect(ok.text).toBe('12014 sabse pehle 10:50 par pahunchti hai.');   // P42.1
    expect(ok.provenance![0]).toMatchObject({ claimType: 'TOOL_DERIVED_FACT', sourceTool: 'SEARCH_TRAINS', sourceResultId: 'rs:1', fields: ['trainNumber', 'arrival'] });
    const idx = buildFactIndex(s, []);
    expect(judgeTimes('12014 13:50 par pahunchti hai.', idx).reason).toBe('TIME_MISMATCH:12014@13:50');       // 13:50 is 12497's arrival
    expect(judgeTimes('12014 10:50 par nikalti hai.', idx).reason).toBe('TIME_MISMATCH:12014@10:50');          // arrival ≠ departure
    expect(judgeTimes('12014 04:55 se 10:50 tak.', idx).reason).toBeNull();
    expect(judgeComparison('12497 sabse pehle pahunchti hai.', idx)).toBe('COMPARISON_MISMATCH:12497');
    expect(judgeComparison('12014 sabse pehle pahunchti hai.', idx)).toBeNull();                              // 18238 arrives 04:10 NEXT day
    expect(judgeComparison('12014 sabse fast hai.', idx)).toBeNull();
    const wrong = await compose(s, '12014 13:50 par pahunchti hai. 12497 sabse pehle pahunchti hai.', { general: false });
    expect(reasons(wrong)).toEqual(['TIME_MISMATCH:12014@13:50', 'COMPARISON_MISMATCH:12497']);
  });

  it('[C] CLASS_LIST ≠ SEAT_AVAILABILITY: a class list is kept (unambiguous wording), seats need CHECK_AVAILABILITY', async () => {
    expect(isClassListClaim('12014 mein CC aur 2S available hain.')).toBe(true);
    expect(isClassListClaim('CC mein seats available hain.')).toBe(false);
    expect(repairClassList('CC and 2S are available.')).toBe('CC and 2S classes are listed.');
    const s = session();
    const r = await compose(s, '12014 Amritsar Shatabdi – 04:55 se 10:50, CC aur 2S available. 12014 mein 3A available hai. CC mein seats available hain.');
    expect(r.text).toBe('12014 Amritsar Shatabdi – 04:55 se 10:50, CC aur 2S classes listed.');   // P42.1
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY', 'UNVERIFIED_AVAILABILITY']);   // P26: a single-class "available hai" is a seat claim
    expect(r.repaired).toBe(1);
    expect(r.provenance![0]).toMatchObject({ claimType: 'TOOL_DERIVED_FACT', sourceTool: 'SEARCH_TRAINS' });
    // with a real availability result the same words are a seat claim, validated against it (no repair)
    const av = session({ selectedTrain: { number: '12014', name: 'Amritsar Shatabdi Express', departure: '04:55', arrival: '10:50', classes: [{ code: 'CC' }, { code: '2S' }] }, selectedClass: 'CC', availability: { CC: { status: 'WL 12' } } });
    const w = await compose(av, 'CC available hai.');
    expect(reasons(w)).toEqual(['AVAILABILITY_MISMATCH']);
  });

  it('[D] passenger counts by context: session fact verified, user-provided / general mentions are not live claims', async () => {
    const s = session({ passengersCount: 2, pendingInteraction: undefined });
    const ok = await compose(s, 'Aapke 2 passengers ke liye booking aage badh rahi hai. RAC mein do passengers ek berth share karte hain.', { q: null, userText: 'aage badho' });
    expect(ok).toMatchObject({ rejected: [] });
    expect(ok.provenance!.map(p => p.claimType)).toEqual(['SESSION_FACT', 'GENERAL_KNOWLEDGE']);
    const bad = await compose(s, 'Aapke 3 passengers ke liye booking aage badh rahi hai.', { q: null, userText: 'aage badho' });
    expect(reasons(bad)).toEqual(['UNGROUNDED_COUNT:3 passengers']);
    expect(classifyPaxCount('3 passengers ke liye dikhao', 3, '3', 'kal 3 passengers ke liye dikhao')).toBe('USER_PROVIDED');
    expect(classifyPaxCount('RAC mein do passengers ek berth share karte hain.', 2, 'do', 'RAC kya hai')).toBe('GENERAL_KNOWLEDGE');
    expect(classifyPaxCount('Ye fare 1 passenger ke liye hai.', 1, '1', 'fare?')).toBe('TOOL_DERIVED_FACT');
  });

  it('[E] fares are validated only against the exact GET_FARE result (train, class, passenger context, amount)', async () => {
    const s = session({ bookingState: 'BOOKING_PREPARE', selectedTrain: { number: '12497', name: 'Shan-e-Punjab Express', departure: '06:35', arrival: '13:50', classes: [{ code: '3A' }, { code: 'CC' }, { code: 'SL' }, { code: '2S' }] }, selectedClass: '3A', fare: { ...FARE }, pendingInteraction: { type: 'PASSENGERS_REQUIRED' } });
    const ok = await compose(s, '12497 Shan-e-Punjab 3A ka fare ₹650 per passenger hai. Yeh 1 passenger ke liye hai.', { steps: [fareStep], userText: '12497 3A ka fare batao', q: 'Kitne passengers hain?' });
    expect(ok.rejected).toEqual([]);
    expect(ok.text).toMatch(/^12497 Shan-e-Punjab 3A ka fare ₹650 per passenger hai\. Yeh 1 passenger ke liye hai\./);
    expect(ok.provenance![0]).toMatchObject({ claimType: 'TOOL_DERIVED_FACT', sourceTool: 'GET_FARE', fields: ['fare', 'trainNumber', 'travelClass'] });
    const bad = await compose(s, '12014 CC ka fare ₹650 hai. 12497 SL ka fare ₹650 hai.', { steps: [fareStep], q: null });
    expect(reasons(bad)).toEqual(['FARE_MISMATCH:650', 'FARE_MISMATCH:650']);                                  // right amount, wrong train / class
    // a search result's class fare is not a fare quote
    const searchOnly = await compose(session(), '12014 CC ka fare ₹520 hai.', { q: null });
    expect(reasons(searchOnly)).toEqual(['UNGROUNDED_FARE']);
  });

  it('[6] a search result count derived from the returned set is preserved (all / time-of-day / class subsets)', async () => {
    const s = session();
    const idx = buildFactIndex(s, []);
    expect(derivedTrainCounts('subah ki 2 trains hain', idx)).toEqual([2]);
    expect(derivedTrainCounts('3A wali 2 trainein', idx)).toEqual([2]);
    const r = await compose(s, 'Kal 3 trainein mili hain. Subah ki 2 trains hain. Raat ki 4 trainein hain.');
    expect(r.text).toBe('Kal 3 trainein mili hain. Subah ki 2 trains hain.');   // P42.1
    expect(reasons(r)).toEqual(['UNGROUNDED_COUNT:4 trainein']);
    expect(r.provenance![0]).toMatchObject({ claimType: 'TOOL_DERIVED_FACT', fields: ['resultCount'] });
  });
});

describe('P25 G2 — response cleanup, question, language', () => {
  it('[11] lists never leave orphan numbering / bullets; a removed sentence takes its dangling conjunction with it', async () => {
    expect(toSentences('Kal 3 trainein mili hain:\n1. 12014 – 04:55 se 10:50.\n2. 12497 – 06:35 se 13:50.')).toEqual(['Kal 3 trainein mili hain.', '12014 – 04:55 se 10:50.', '12497 – 06:35 se 13:50.']);
    expect(toSentences('Options hain: 1. 12014 10:50. 2. 12497')).toEqual(['Options hain.', '12014 10:50.', '12497.']);
    const s = session();
    const r = await compose(s, 'Kal 3 trainein mili hain:\n1. 12014 – fare ₹999.\n2. 12497 – 06:35 se 13:50.\n- \nAur 12497 sabse pehle pahunchti hai. Aur 12014 04:55 pe nikalti hai.');
    expect(r.text).toBe('Kal 3 trainein mili hain. 12497 – 06:35 se 13:50. 12014 04:55 pe nikalti hai.');   // P42.1
    expect(r.text).not.toMatch(/(^|\s)\d\.(\s|$)|(^|\s)[-•](\s|$)/);
  });

  it('[11b] no backend question is ever added (P42.1): a reply that asks keeps its own question; an English reply stays English', async () => {
    const s = session({ pendingInteraction: { type: 'PASSENGERS_REQUIRED' } });
    const r = await compose(s, 'Main ticket book ya payment nahi kar sakta. Kitne passengers hain, bata dijiye.', { q: 'Kitne passengers hain?', userText: 'book karke payment bhi kar do', general: true });
    expect(r.text).toBe('Main ticket book ya payment nahi kar sakta. Kitne passengers hain, bata dijiye.');
    const e = await compose(session(), '12014 Amritsar Shatabdi reaches New Delhi first, at 10:50.', { userText: 'Which of these trains reaches Delhi earliest?', general: true });
    expect(e.language).toBe('ENGLISH');
    expect(e.text).toBe('12014 Amritsar Shatabdi reaches New Delhi first, at 10:50.');
  });

  it('[7] language = dominant language of the latest user turn (shared words carry no weight)', () => {
    expect(detectLanguageStyle('Which of these trains reaches Delhi earliest?', ['Kal Amritsar se Delhi jaana hai'])).toBe('ENGLISH');
    expect(detectLanguageStyle('Can you tell me how to do this?')).toBe('ENGLISH');
    expect(detectLanguageStyle('please book karke payment bhi kar do')).toBe('HINGLISH');
    expect(detectLanguageStyle('12497 3A ka fare batao')).toBe('HINGLISH');
    expect(detectLanguageStyle('Kal Delhi jaana hai')).toBe('HINGLISH');
    expect(detectLanguageStyle('I want to go to Delhi tomorrow')).toBe('ENGLISH');
    expect(detectLanguageStyle('Mohit 31 male', ['I want to go to Delhi'])).toBe('ENGLISH');
    expect(detectLanguageStyle('कल दिल्ली जाना है')).toBe('HINDI');
  });

  it('[10] no second LLM call when the orchestrator found no material change; voice uses the same validation', async () => {
    const L = llm();
    const r = await naturalResponseComposer.compose({ llm: L, session: session(), userText: 'x', backendReply: 'Backend reply.', deterministicSpeech: 'Backend reply.', stateBefore: 'SHOWING_TRAINS',
      reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null, steps: [], appliedActions: [], changes: [], error: null,
      pendingQuestionCode: null, pendingQuestion: null, history: [], mode: 'TEXT', agentText: null, allowWordingCall: false } as any);
    expect(r).toMatchObject({ source: 'FALLBACK', fallbackReason: 'NO_MATERIAL_CHANGE', text: 'Backend reply.' });
    expect(L.generateSpokenResponse).not.toHaveBeenCalled();
    const text = await compose(session(), '12014 13:50 par pahunchti hai. 12014 sabse pehle 10:50 par pahunchti hai.', { mode: 'TEXT' });
    const voice = await compose(session(), '12014 13:50 par pahunchti hai. 12014 sabse pehle 10:50 par pahunchti hai.', { mode: 'VOICE' });
    expect(reasons(voice)).toEqual(reasons(text));
    expect(voice.text).toBe(text.text);
  });
});

describe('P25 G2 — tool-argument validation before execution + retry cap', () => {
  it('[G] schema / type / train-number format → structured INVALID_ARGUMENT (argument, expected, received); never guesses', () => {
    const bad = (tool: string, args: any) => { const r = validateToolArgumentShape(tool, args); if (r.ok) throw new Error('expected rejection'); return r.details; };
    expect(bad('GET_TRAIN_INFO', { trainNumber: '124977' })).toMatchObject({ argument: 'trainNumber', expected: expect.stringMatching(/4-5 digit/), received: '"124977"' });
    expect(bad('GET_TRAIN_INFO', { trainNumber: 'train 12014' })).toMatchObject({ argument: 'trainNumber' });     // no digit extraction
    expect(bad('GET_TRAIN_INFO', { trainNumber: '12O14' })).toMatchObject({ received: '"12O14"' });
    expect(bad('GET_FARE', { travelClass: 'AC 3 tier' })).toMatchObject({ argument: 'travelClass', expected: expect.stringContaining('3A') });
    expect(bad('GET_FARE', { passengersCount: 9 })).toMatchObject({ argument: 'passengersCount', expected: 'an integer from 1 to 6', received: '9' });
    expect(bad('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: KAL, priority: 'vip' })).toMatchObject({ argument: 'priority', expected: expect.stringMatching(/no such argument/) });
    expect(bad('SEARCH_TRAINS', { origin: { code: 'ASR' }, destination: 'NDLS', date: KAL })).toMatchObject({ argument: 'origin', expected: 'a string' });
    // lossless type normalization only (same meaning)
    const ok = validateToolArgumentShape('GET_FARE', { trainNumber: 12497, travelClass: '3a', passengersCount: '2', origin: '' });
    expect(ok).toMatchObject({ ok: true, arguments: { trainNumber: '12497', travelClass: '3A', passengersCount: 2 } });
    expect((ok as any).arguments).not.toHaveProperty('origin');
    const s = session();
    const n = normalizeToolArguments('GET_TRAIN_INFO', { trainNumber: '1201A' }, s, '1201A ki info');
    expect(n).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', details: { argument: 'trainNumber', received: '"1201A"', clarify: expect.any(String) } });
  });

  it('[H][I] corrected retry continues; identical invalid calls are capped (repeat → INVALID_REPEATED_CALL, 3rd → loop stop with a clarification)', () => {
    const s = session();
    const validator = new ToolCallValidator();
    const turn = new RailwayToolRuntime({ timeoutMs: 40 }).beginTurn({ sessionId: s.sessionId, turnId: 't', requestId: 'r', userText: '99 ki info', getSession: () => s,
      validate: (tc, ss) => validator.validate(tc, ss, { userText: '99 ki info', bookings: [], pnrOwner: () => 'NONE' as const, bookingOwner: () => 'NONE' as const } as any) as any });
    const info = (n: any) => ({ callId: `c${Math.random()}`, name: 'GET_TRAIN_INFO' as any, arguments: { trainNumber: n } });
    const p1 = turn.prepare(info('99'), true);
    expect(p1.ok).toBe(false);
    if (!p1.ok) { expect(p1.error.code).toBe('INVALID_ARGUMENT'); expect(p1.error.details).toMatchObject({ argument: 'trainNumber', received: '"99"' }); expect(p1.stop).toBe(false); }
    const p2 = turn.prepare(info('99'), true);
    if (p2.ok) throw new Error('expected rejection');
    expect(p2.error.code).toBe('INVALID_REPEATED_CALL');
    expect(p2.error.details).toMatchObject({ previousCode: 'INVALID_ARGUMENT', argument: 'trainNumber' });
    const p3 = turn.prepare(info('99'), true);
    if (p3.ok) throw new Error('expected rejection');
    expect(p3.error.code).toBe('TOOL_LOOP_DETECTED');
    expect(p3.stop).toBe(true);
    expect(p3.error.message).toMatch(/train number/i);                                    // a clarification, not "verified result"
    const p4 = turn.prepare(info('12014'), true);                                           // the corrected call is accepted
    expect(p4.ok).toBe(true);
    expect(turn.validation).toEqual({ failures: 1, repeatedInvalid: 1, correctedRetries: 1, coerced: 0 });
    expect(turn.records.map(r => r.rejectionReason)).toEqual(['INVALID_ARGUMENT', 'INVALID_REPEATED_CALL', 'TOOL_LOOP_DETECTED', null]);
  });
});
