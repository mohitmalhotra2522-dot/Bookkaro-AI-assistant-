/**
 * Prompt 16 — Response fact guard (Part 40 / 43).
 *
 * LLM wording may PHRASE authoritative facts but never introduce new ones. Every sentence of the
 * LLM's final message / clarification is checked against the authoritative sources of this turn:
 *   - train numbers (5 digits)   → current displayed results, selected train, this turn's provider
 *                                  results (data or validated error), last train info / timetable,
 *                                  the session's booking records
 *   - ₹ amounts                   → provider fare / search-result fares / review / booking records
 *   - PNR-like 10-digit numbers   → authoritative booking records / CHECK_PNR results only
 *   - availability claims         → Prompt 26: only a CHECK_AVAILABILITY result matching train / date / class / status
 * Sentences with an unsupported fact are removed (never displayed as fact). The backend's own
 * deterministic phrasing is not filtered here.
 */
import type { BookingSession } from '@shared/entities';
import { collectAvailabilityEvidence, judgeAvailabilityClaim, hasAvailabilityCode } from '../response/availability-authority';

export interface FactSources {
  session: BookingSession;
  /** This turn's tool steps (validated provider results, ok or error). */
  steps: Array<{ status: string; result: { toolName: string; data?: any; error?: { message?: string } | null } }>;
  /** Authoritative booking records for the session (BookingHistoryStore). */
  records?: Array<{ train?: { trainNumber?: string }; pnr?: string | null; fareSummary?: { total?: number | null } | null }>;
  /** P42.12: this turn's user text — an explicit fresh request is never answered from an earlier search row. */
  userText?: string;
}

export interface FactGuardResult { text: string; rejected: string[] }

const SENT_SPLIT = /(?<=[.!?।])\s+/;

function numbersIn(v: any, re: RegExp, out: Set<string>) {
  if (v === undefined || v === null) return;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  for (const m of s.matchAll(re)) out.add(m[1]);
}

export function guardResponseFacts(text: string, src: FactSources): FactGuardResult {
  if (!text) return { text, rejected: [] };
  const s: any = src.session;
  const trains = new Set<string>();
  const amounts = new Set<string>();
  const pnrs = new Set<string>();
  const T5 = /(?<!\d)(\d{5})(?!\d)/g;
  const NUM = /(?<![\d.])(\d{2,6})(?![\d])/g;
  const P10 = /(?<!\d)(\d{10})(?!\d)/g;
  const authoritative = [s.searchResults, s.selectedTrain, s.lastTrainInfo, s.lastTimetable, s.carryOverSelection];
  for (const a of authoritative) numbersIn(a, T5, trains);
  // Prompt 35: WEB_EXTERNAL research is never railway evidence — its train numbers / ₹ amounts authorize nothing
  const railSteps = src.steps.filter(st => st.result?.toolName !== 'WEB_RAILWAY_RESEARCH');
  for (const st of railSteps) { numbersIn(st.result.data, T5, trains); numbersIn(st.result.error?.message, T5, trains); }
  for (const r of src.records || []) if (r.train?.trainNumber) trains.add(String(r.train.trainNumber));
  for (const a of [s.fare, s.searchResults?.trains, s.review?.data, s.availability]) numbersIn(a, NUM, amounts);
  for (const st of railSteps) if (st.status === 'ok') numbersIn(st.result.data, NUM, amounts);
  for (const r of src.records || []) if (r.fareSummary?.total) amounts.add(String(r.fareSummary.total));
  for (const r of src.records || []) if (r.pnr) pnrs.add(String(r.pnr));
  for (const st of src.steps) if (st.status === 'ok' && st.result.toolName === 'CHECK_PNR') numbersIn(st.result.data?.pnr, P10, pnrs);
  // Prompt 26: availability authority = CHECK_AVAILABILITY evidence matched to the sentence's train / date / class / status
  const availability = { session: s, evidence: collectAvailabilityEvidence(s, src.steps as any[], { userText: src.userText }) };

  const rejected: string[] = [];
  const kept = String(text).split(SENT_SPLIT).filter(sn => {
    for (const m of sn.matchAll(P10)) if (!pnrs.has(m[1])) { rejected.push(`PNR:${m[1].slice(0, 2)}******${m[1].slice(-2)}`); return false; }
    for (const m of sn.replace(P10, ' ').matchAll(T5)) if (!trains.has(m[1])) { rejected.push(`TRAIN:${m[1]}`); return false; }
    for (const m of sn.matchAll(/₹\s?([\d,]+)/g)) { const v = m[1].replace(/,/g, ''); if (!amounts.has(v)) { rejected.push(`FARE:${v}`); return false; } }
    if (!hasAvailabilityCode(sn) && judgeAvailabilityClaim(sn, availability).reason) { rejected.push('AVAILABILITY_CLAIM'); return false; }
    return true;
  });
  if (!rejected.length) return { text, rejected };
  return { text: kept.join(' ').trim(), rejected };
}
