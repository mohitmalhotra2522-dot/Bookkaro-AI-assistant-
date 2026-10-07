/**
 * PROMPT 42.9 — G3: D2 fresh-date grounding (offline, no LLM, no network).
 *   - a dated railway fact (train count / availability / fare) must be about the canonical date of its result;
 *   - the P42.8 regression: 8 Oct result set (29 trains), user "Kal nahi, parso", Muse claims "parso 9 Oct … 29 trainein"
 *     in a turn with NO tool → claim rejected (DATE_MISMATCH / NO_FRESH_RESULT_FOR_DATE), safe date fallback, text = voice;
 *   - date change invalidates every date-bound result (search, availability, fare, recovery, review), journeyVersion++,
 *     passengers kept; "RAC kya hota hai?" stays a direct general answer.
 */
import { describe, it, expect, vi } from 'vitest';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { judgeDateBoundClaim, dateSourcesOf, statedDates, dateFreshFallbackText, dateBoundKind } from '../../server/ai/response/claim-date-freshness';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { syncJourneyVersion } from '../../server/ai/tool-runtime/journey-version';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}`; };

/** 29 trains for KAL (the P42.8 live count) */
const TRAINS = Array.from({ length: 29 }, (_, i) => ({ trainNumber: String(12000 + i * 7), trainName: `Test Express ${i}`, origin: 'JUC', destination: 'NDLS',
  departure: `${String(i % 24).padStart(2, '0')}:10`, arrival: `${String((i + 6) % 24).padStart(2, '0')}:40`, duration: '6h 30m', classes: [{ code: '3A' }, { code: 'SL' }] }));

function session(extra: Record<string, any> = {}) {
  const st = new ConversationStateManager();
  const sid = st.createSession().sessionId;
  const s: any = st.getSession(sid);
  Object.assign(s, { origin: 'JUC', destination: 'NDLS', originName: 'Jalandhar City', destinationName: 'New Delhi', date: KAL, bookingState: 'SHOWING_TRAINS',
    searchResults: { journey: { origin: 'JUC', destination: 'NDLS', date: KAL }, trains: TRAINS.map(t => ({ ...t })) }, pendingInteraction: { type: 'NONE' } }, extra);
  return { st, sid, s };
}
const llm = () => ({ providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn(async () => ({ text: 'WORDING' })) } as any);
function compose(s: any, agentText: string, o: { userText?: string; general?: boolean; steps?: any[]; mode?: 'TEXT' | 'VOICE' } = {}) {
  return naturalResponseComposer.compose({
    llm: llm(), session: s, userText: o.userText ?? 'theek hai', backendReply: '', deterministicSpeech: 'DETERMINISTIC',
    stateBefore: s.bookingState, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null,
    steps: o.steps ?? [], appliedActions: [], changes: [], error: null, pendingQuestionCode: null, pendingQuestion: null,
    history: [], mode: o.mode ?? 'TEXT', agentText, general: o.general ?? false
  } as any) as Promise<any>;
}
const reasons = (r: any): string[] => (r.rejected || []).map((x: any) => String(x.reason));
const searchStep = (date: string, n: number) => ({ toolCall: { name: 'SEARCH_TRAINS', callId: 's1' }, status: 'ok', execution: { status: 'SUCCEEDED' },
  result: { toolName: 'SEARCH_TRAINS', success: true, data: { journey: { origin: 'JUC', destination: 'NDLS', date }, trains: TRAINS.slice(0, n), totalCount: n } } });

describe('P42.9 G3 — D2 date-bound railway claims', () => {
  it('[1] EXACT P42.8 regression: 8-Oct-style result set (29), "Kal nahi, parso", no tool, "parso 9 Oct … 29 trainein" → rejected, safe fallback', async () => {
    const { s } = session();
    const claim = `Jalandhar City se New Delhi, parso ${dm(PARSO)} ko 3A mein 29 trainein mili hain.`;
    for (const general of [true, false]) {
      const r = await compose(s, claim, { userText: 'Kal nahi, parso', general });
      expect(r.source).toBe('FALLBACK');
      // the general-knowledge turn (the P42.8 failure path) → DATE_MISMATCH; a non-general turn is caught by the
      // existing P28 relative-date guard first (UNGROUNDED_DATE) — either way rejected, same safe date fallback
      if (general) expect(reasons(r)).toContain(`DATE_MISMATCH:${PARSO}`);
      else expect(reasons(r).some(x => /^(DATE_MISMATCH|NO_FRESH_RESULT_FOR_DATE|UNGROUNDED_DATE|CROSS_DATE_FACT):/.test(x))).toBe(true);
      expect(r.text).toBe('Parso ke liye fresh railway data abhi verify nahi hua.');
      expect(r.text).not.toMatch(/29/);
    }
    // the session itself never moved: no backend date arithmetic, no deterministic SEARCH routing from the guard
    expect(s.date).toBe(KAL);
    expect(s.searchResults.trains).toHaveLength(29);
  });

  it('[2] unstated date: user asks for parso, Muse says "29 trainein mili hain" without a fresh parso result → NO_FRESH_RESULT_FOR_DATE', async () => {
    const { s } = session();
    const r = await compose(s, '29 trainein mili hain.', { userText: 'Kal nahi, parso', general: true });
    expect(reasons(r)).toContain(`NO_FRESH_RESULT_FOR_DATE:${PARSO}`);
    expect(r.text).toBe('Parso ke liye fresh railway data abhi verify nahi hua.');
  });

  it('[3] honest wording is kept: "Kal ke liye 29 trains mili thi; parso ke liye fresh check karna hoga."', async () => {
    const { s } = session();
    const r = await compose(s, 'Kal ke liye 29 trains mili thi; parso ke liye fresh check karna hoga.', { userText: 'Kal nahi, parso', general: true });
    expect(r.source).toBe('LLM');
    expect(reasons(r).filter(x => /DATE/.test(x))).toEqual([]);
  });

  it('[4] a FRESH parso tool result this turn supports the parso count (DateResolver date = result date)', async () => {
    // after Muse's fresh parso SEARCH_TRAINS the runtime has synced the session to the parso result set
    const { s } = session({ date: PARSO, searchResults: { journey: { origin: 'JUC', destination: 'NDLS', date: PARSO }, trains: TRAINS.slice(0, 12) } });
    const r = await compose(s, `Parso ${dm(PARSO)} ke liye 12 trainein mili hain.`, { userText: 'Kal nahi, parso', steps: [searchStep(PARSO, 12)] });
    expect(reasons(r).filter(x => /DATE_MISMATCH|NO_FRESH/.test(x))).toEqual([]);
    expect(r.text).toMatch(/12 trainein/);
  });

  it('[5] availability / fare claims are date-bound too (stale-date fact → DATE_MISMATCH)', () => {
    const { s } = session({ availability: { trainNumber: '12000', travelClass: '3A', date: KAL, status: 'AVAILABLE 5' }, fare: { trainNumber: '12000', travelClass: '3A', date: KAL, total: 900, perPassenger: 900 } });
    const src = dateSourcesOf(s, []);
    expect(judgeDateBoundClaim('Parso 12000 ke 3A mein AVAILABLE 5 hai.', src)?.reason).toBe(`DATE_MISMATCH:${PARSO}`);
    expect(judgeDateBoundClaim(`Parso ka fare ₹900 hai.`, src)?.reason).toBe(`DATE_MISMATCH:${PARSO}`);
    expect(judgeDateBoundClaim('Kal 12000 ke 3A mein AVAILABLE 5 hai.', src)).toBeNull();
    // no result of that kind at all for the claimed date
    expect(judgeDateBoundClaim('Parso 3 trainein hain.', dateSourcesOf({ date: KAL }, []))?.reason).toBe(`NO_FRESH_RESULT_FOR_DATE:${PARSO}`);
  });

  it('[6] DateResolver is the only date authority; negated day words are not the claimed date', () => {
    expect(statedDates('Kal nahi, parso')).toEqual([PARSO]);
    expect(statedDates(`parso ${dm(PARSO)} ko`)).toEqual([PARSO]);
    expect(dateBoundKind('RAC mein do passengers ek berth share karte hain.')).toBeNull();
    expect(dateFreshFallbackText(PARSO)).toBe('Parso ke liye fresh railway data abhi verify nahi hua.');
    expect(dateFreshFallbackText(KAL)).toBe('Kal ke liye fresh railway data abhi verify nahi hua.');
  });

  it('[7] "RAC kya hota hai?" stays a direct general answer (no date, no tool, no rejection)', async () => {
    const { s } = session();
    const r = await compose(s, 'RAC ka matlab hai Reservation Against Cancellation. RAC mein do passengers ek berth share karte hain.', { userText: 'RAC kya hota hai?', general: true });
    expect(r.source).toBe('LLM');
    expect(r.rejected).toEqual([]);
  });

  it('[8] voice / text parity: the same stale-date claim is rejected in VOICE exactly like TEXT', async () => {
    const { s } = session();
    const claim = `Parso ${dm(PARSO)} ko 29 trainein mili hain.`;
    const t = await compose(s, claim, { userText: 'Kal nahi, parso', general: true, mode: 'TEXT' });
    const v = await compose(s, claim, { userText: 'Kal nahi, parso', general: true, mode: 'VOICE' });
    expect(t.text).toBe('Parso ke liye fresh railway data abhi verify nahi hua.');
    expect(v.text).toBe(t.text);
  });

  it('[9] date change invalidates every date-bound result (search, availability, fare, recovery, review), journeyVersion++, passengers kept', () => {
    const { st, sid, s } = session({
      availability: { trainNumber: '12000', travelClass: '3A', date: KAL, status: 'AVAILABLE 5' }, fare: { total: 900 },
      selectedTrain: { trainNumber: '12000', number: '12000' }, selectedClass: '3A',
      sameTrainAlternatives: { alternativeSearchId: 'sta_x', date: KAL }, sameTrainAlternativeSets: [{ alternativeSearchId: 'sta_x' }], sameTrainSelection: { alternativeId: 'A1' },
      review: { reviewVersion: 1, createdAt: '', sessionVersion: 1, fingerprint: 'f', valid: true, data: {} },
      passengers: [{ id: 'P1', name: 'Mohit', age: 30, gender: 'M' }], passengersCount: 1
    });
    const jv0 = syncJourneyVersion(s);
    const cleared = st.invalidate(sid, 'DATE');
    s.date = PARSO; st.bump(sid);
    expect(cleared).toEqual(expect.arrayContaining(['searchResults', 'availability', 'fare', 'sameTrainAlternatives', 'sameTrainSelection', 'sameTrainAlternativeSets', 'review']));
    expect(s.searchResults).toBeUndefined(); expect(s.availability).toBeUndefined(); expect(s.fare).toBeUndefined();
    expect(s.sameTrainAlternatives).toBeUndefined(); expect(s.sameTrainSelection).toBeUndefined(); expect(s.sameTrainAlternativeSets).toEqual([]);
    expect(s.review.valid).toBe(false); expect(s.review.invalidatedReason).toBe('DATE_CHANGED');
    expect(s.passengers).toHaveLength(1); expect(s.passengers[0].name).toBe('Mohit');
    expect(s.journeyVersion).toBeGreaterThan(jv0);
    // after invalidation there is no result to support ANY old-date count
    expect(judgeDateBoundClaim('Kal 29 trainein thi.', dateSourcesOf(s, []))?.reason).toBe(`NO_FRESH_RESULT_FOR_DATE:${KAL}`);
  });

  it('[10] provenance: an accepted count claim is bound to the canonical date of its result set', async () => {
    const { s } = session();
    const r = await compose(s, 'Kal ke liye 29 trainein mili hain.', { userText: 'kal ki trains dikhao' });
    expect(r.source).toBe('LLM');
    const p = (r.claimProvenance as any[]).find(x => x.sourceTool === 'SEARCH_TRAINS' && (x.fields || []).includes('resultCount'));
    expect(p?.date).toBe(KAL);
  });
});
