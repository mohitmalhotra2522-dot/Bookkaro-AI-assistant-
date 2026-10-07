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

export const UNVERIFIED_FALLBACK = 'Is information ka verified result available nahi hai.';

export interface GroundingResult {
  text: string;
  rejected: string[];
  /** true when the answer had to be replaced by the safe fallback. */
  replaced: boolean;
}

const SENT_SPLIT = /(?<=[.!?।])\s+/;
const TIME = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;
// Prompt 22: widened — "time pe chal rahi", "chal rahi hai", "pahunch gayi", platform numbers are live claims too
const PUNCTUAL = /\b(usually on time|generally on time|on time|on schedule|time (par|pe|se) (chal|pahunch|aa)|samay (par|pe)|late (chal|ho|hai)|der se (chal|pahunch)|delay(ed)? (hai|chal)|running late|kitni late|chal rahi hai|pahunch (gayi|chuki)|platform (number |no\.? )?\d+)\b/i;
const PNR_STATUS = /\bpnr\b[^.?!]*\b(confirm(ed)?|cnf|waiting|wl|rac|chart (ban|prepared)|cancel(led)?)\b/i;
const CANCELLED = /\b(train|gaadi|gadi)\b[^.?!]*\b(cancel(led)? (hai|ho gayi|kar di)|rad (hai|ho gayi)|cancelled)\b|\b\d{5}\b[^.?!]*\b(cancel(led)?|radd?)\b(?!\s+(karna|karni|karni hai|karo|kar sakte|request))/i;

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

    const rejected = [...base.rejected];
    // every violation in a sentence is recorded (observability), then the sentence is dropped
    const kept = String(base.text).split(SENT_SPLIT).filter(sn => {
      const before = rejected.length;
      for (const m of sn.matchAll(TIME)) {
        const t = `${m[1].padStart(2, '0')}:${m[2]}`;
        if (!times.has(t)) rejected.push(`TIMING:${t}`);
      }
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
