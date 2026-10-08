/**
 * PROMPT 17 — RailwayResponseGroundingValidator (Parts 15, 16, 17, 50).
 *
 * Before an LLM-worded answer is shown or spoken, every railway fact in it must trace back to an
 * authoritative source of THIS session: RAILWAY_PROVIDER (this turn's normalized tool results or the
 * provider data synced into BookingSession), BOOKING_RECORD or BOOKING_SESSION.
 *
 * Extends the Prompt 16 guard (train numbers, ₹ amounts, PNRs, availability claims) with:
 *   - timings (HH:MM)                      → provider timetable / search / train-info data only
 *   - punctuality ("usually on time", "late chal rahi") → a fresh TRACK_TRAIN result this turn only
 *   - PNR / booking status words next to "PNR" → CHECK_PNR result or booking record only
 *   - availability codes (WL 12 / RAC 4 / AVL 40) → provider availability only
 *   - "train cancelled" claims             → provider cancelled-trains / live data only
 * Unsupported sentences are removed; if nothing verified remains the safe fallback is used.
 */
import { guardResponseFacts, type FactSources } from '../conversation/response-fact-guard';
import { collectAvailabilityEvidence, judgeAvailabilityClaim, hasAvailabilityCode } from '../response/availability-authority';
import { buildFactIndex, isGeneralTimeContext, type FactIndex } from '../response/claim-facts';
import { collectRouteFacts, judgeRouteClaim, type RouteFacts } from '../response/route-claims';

export const UNVERIFIED_FALLBACK = 'Is information ka verified result available nahi hai.';

export interface GroundingResult {
  text: string;
  rejected: string[];
  /** true when the answer had to be replaced by the safe fallback. */
  replaced: boolean;
}

const SENT_SPLIT = /(?<=[.!?।])\s+/;
const TIME = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;
const HAS_TIME = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/;
// Prompt 22: widened — "time pe chal rahi", "chal rahi hai", "pahunch gayi", platform numbers are live claims too
const PUNCTUAL = /\b(usually on time|generally on time|on time|on schedule|time (par|pe|se) (chal|pahunch|aa)|samay (par|pe)|late (chal|ho|hai)|der se (chal|pahunch)|delay(ed)? (hai|chal)|running late|kitni late|chal rahi hai|pahunch (gayi|chuki)|platform (number |no\.? )?\d+)\b/i;
const PNR_STATUS = /\bpnr\b[^.?!]*\b(confirm(ed)?|cnf|waiting|wl|rac|chart (ban|prepared)|cancel(led)?)\b/i;
const CANCELLED = /\b(train|gaadi|gadi)\b[^.?!]*\b(cancel(led)? (hai|ho gayi|kar di)|rad (hai|ho gayi)|cancelled)\b|\b\d{5}\b[^.?!]*\b(cancel(led)?|radd?)\b(?!\s+(karna|karni|karni hai|karo|kar sakte|request))/i;

// Bug-fix pass (Bug 2): "verified / checked / actual / current result" or "maine verify kar liya" — a statement that
// a result WAS verified. Negated forms ("verified result available nahi hai", the honest fallback) are not claims.
const VERIFIED_CLAIM = /\b(verified|checked|actual|current|confirmed)\s+(\w+\s+)?(results?|data|jaankari|jankari|information|info|status|details?)\b|\b(result|data|jaankari|jankari|information|status)\s+(verified|checked|confirmed)\b|\b(verify|check|confirm)\s+(kar\s+(liya|li|diya|di|chuka|chuki)|ho\s+(gaya|gayi|chuka|chuki))\b|\b(i have|i've|we have|maine)\s+(verified|checked|confirmed|verify|check|confirm)\b/i;
const NEGATED = /\b(nahi|nahin|nhi|not|no|never|couldn'?t|can'?t|cannot|unable|na(hi)? (ho|mil) (paay|paya|saka))\b/i;
/** Which tool(s) own the result a verified-claim sentence talks about (by the fact it names); none = any result. */
const CLAIM_OWNERS: Array<[RegExp, string[]]> = [
  [/\b(availability|seats?|berths?|avl|wl|rac|waiting|khaali|khali)\b/i, ['CHECK_AVAILABILITY']],
  [/(₹|\b(fare|kiraya|price|amount)\b)/i, ['GET_FARE']],
  [/\bpnr\b/i, ['CHECK_PNR']],
  [/\b(live|running|late|delay\w*|location|kahan hai|platform)\b/i, ['TRACK_TRAIN']],
  [/\b(timetable|schedule|route|stops?|stations?|halts?)\b/i, ['GET_TIMETABLE', 'GET_TRAIN_INFO']]
];

function collectTimes(v: any, out: Set<string>) {
  if (v === undefined || v === null) return;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  for (const m of s.matchAll(TIME)) out.add(`${m[1].padStart(2, '0')}:${m[2]}`);
}

export class RailwayResponseGroundingValidator {
  validate(text: string, src: FactSources): GroundingResult {
    if (!text) return { text, rejected: [], replaced: false };
    const base = guardResponseFacts(text, src);
    const s: any = src.session;
    const okSteps = src.steps.filter(st => st.status === 'ok');
    const has = (tool: string) => okSteps.some(st => st.result.toolName === tool);

    const times = new Set<string>();
    for (const a of [s.searchResults, s.selectedTrain, s.lastTrainInfo, s.lastTimetable, s.carryOverSelection]) collectTimes(a, times);
    for (const st of okSteps) collectTimes(st.result.data, times);
    for (const r of src.records || []) collectTimes(r, times);
    // Prompt 26: a status code ("WL 12", "RAC 4") is verified only by a matching CHECK_AVAILABILITY result (scoped)
    const availability = { session: s, evidence: collectAvailabilityEvidence(s, src.steps as any[], { userText: src.userText }) };
    const pnrKnown = has('CHECK_PNR') || (src.records || []).some(r => !!r.pnr);
    const liveKnown = has('TRACK_TRAIN');
    const cancelledKnown = has('GET_CANCELLED_TRAINS') || okSteps.some(st => st.result.toolName === 'TRACK_TRAIN' && /cancel/i.test(JSON.stringify(st.result.data || {})));

    // Bug 2: evidence that a result of tool X really exists — a successful step THIS turn, or (when this turn did not
    // try X and failed) the authoritative session data of that kind. A rejected / failed / stale call never counts.
    const triedFailed = (tools: string[]) => src.steps.some(st => st.status !== 'ok' && tools.includes(st.result.toolName));
    const sessionHas = (tool: string): boolean => {
      switch (tool) {
        case 'CHECK_AVAILABILITY': return availability.evidence.length > 0;
        case 'GET_FARE': return !!s.fare;
        case 'CHECK_PNR': return (src.records || []).some(r => !!r.pnr);
        case 'GET_TIMETABLE': return Array.isArray(s.lastTimetable) && s.lastTimetable.length > 0;
        case 'GET_TRAIN_INFO': return !!s.lastTrainInfo;
        case 'SEARCH_TRAINS': return !!s.searchResults?.trains?.length;
        default: return false;     // TRACK_TRAIN: live status is never "verified" from an earlier turn
      }
    };
    const verifiedClaimOk = (sn: string): boolean => {
      const owners = CLAIM_OWNERS.filter(([re]) => re.test(sn)).flatMap(([, t]) => t);
      if (owners.length) return owners.some(t => has(t)) || (!triedFailed(owners) && owners.some(sessionHas));
      if (okSteps.length) return true;
      // nothing named and no successful result this turn: only an untouched turn may lean on authoritative session data
      return !src.steps.length && ['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE', 'CHECK_PNR'].some(sessionHas);
    };
    // Bug 3 / Bug 4: built lazily (most sentences have no time / station)
    let idx: FactIndex | null = null;
    const factIdx = () => (idx ??= buildFactIndex(s, src.steps.map(st => ({ toolName: st.result.toolName, ok: st.status === 'ok', data: st.result.data }))));
    let routes: RouteFacts | null = null;
    const routeFacts = () => (routes ??= collectRouteFacts(s, src.steps as any));

    const rejected = [...base.rejected];
    // every violation in a sentence is recorded (observability), then the sentence is dropped
    const kept = String(base.text).split(SENT_SPLIT).filter(sn => {
      const before = rejected.length;
      // Bug 4: a clock time in a general explanation (no train / station / movement / live context) is not a timing fact
      const generalTime = HAS_TIME.test(sn) && isGeneralTimeContext(sn, factIdx());
      if (!generalTime) for (const m of sn.matchAll(TIME)) {
        const t = `${m[1].padStart(2, '0')}:${m[2]}`;
        if (!times.has(t)) rejected.push(`TIMING:${t}`);
      }
      if (VERIFIED_CLAIM.test(sn) && !NEGATED.test(sn) && !verifiedClaimOk(sn)) rejected.push('VERIFIED_RESULT_CLAIM');
      { const rc = judgeRouteClaim(sn, routeFacts()); if (rc) rejected.push(rc); }
      if (PUNCTUAL.test(sn) && !liveKnown) rejected.push('PUNCTUALITY_CLAIM');
      if (PNR_STATUS.test(sn) && !pnrKnown) rejected.push('PNR_STATUS_CLAIM');
      if (hasAvailabilityCode(sn) && judgeAvailabilityClaim(sn, availability).reason) rejected.push('AVAILABILITY_CODE');
      if (CANCELLED.test(sn) && !cancelledKnown) rejected.push('CANCELLATION_CLAIM');
      return rejected.length === before;
    });
    if (!rejected.length) return { text, rejected, replaced: false };
    const out = kept.join(' ').trim();
    return out ? { text: out, rejected, replaced: false } : { text: '', rejected, replaced: true };
  }
}

export const railwayResponseGrounding = new RailwayResponseGroundingValidator();
