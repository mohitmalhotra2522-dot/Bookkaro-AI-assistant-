/**
 * PROMPT 42.2 — shortage evidence for a SEARCH_SAME_TRAIN_ALTERNATIVES call (hard constraint input, not a decision).
 *
 * Muse decides whether a same-train search is useful. The validator only needs one fact: does CURRENT authoritative
 * data for exactly this train + class + date + requested pair already show enough seats for this party? If so the
 * search is refused (SAME_TRAIN_ALTERNATIVE_NOT_NEEDED) before any provider call. Evidence order:
 *   1. the session's CHECK_AVAILABILITY entry (committed by the runtime from a provider result), then
 *   2. the current SEARCH_TRAINS result set's per-class availability,
 * both only when they belong to the same journey (date / origin / destination). Missing / UNKNOWN data proves nothing
 * — the call is then allowed (Muse's judgement), never blocked and never treated as a shortage.
 */
import { evaluateSeatShortage, type SeatShortageAssessment, type ShortageTriggerReason, SHORTAGE_TRIGGER_REASONS } from '@shared/same-train-shortage';

export interface ShortageQuery { trainNumber: string; travelClass: string; date: string; origin: string; destination: string; passengersCount: number }
export interface ShortageEvidence { assessment: SeatShortageAssessment; source: 'CHECK_AVAILABILITY' | 'SEARCH_TRAINS'; status: string; resultId: string | null }

const same = (a: unknown, b: string) => a === undefined || a === null || a === '' || String(a).toUpperCase() === b.toUpperCase();

export function sessionShortageEvidence(session: any, q: ShortageQuery): ShortageEvidence | null {
  const s: any = session || {};
  const av = s.availability?.[q.travelClass];
  const sel = s.selectedTrain ? String(s.selectedTrain.number ?? s.selectedTrain.trainNumber ?? '') : '';
  if (av && typeof av === 'object' && av.status) {
    const train = String(av.trainNumber ?? sel ?? '');
    if (train === q.trainNumber && same(av.date ?? s.date, q.date) && same(av.origin ?? s.origin, q.origin) && same(av.destination ?? s.destination, q.destination)) {
      return { assessment: evaluateSeatShortage({ status: av.status, requestedPassengerCount: q.passengersCount }), source: 'CHECK_AVAILABILITY', status: String(av.status), resultId: av.toolExecutionId ?? null };
    }
  }
  const sr = s.searchResults;
  if (sr && Array.isArray(sr.trains) && same(sr.date ?? sr.journey?.date, q.date) && same(sr.origin ?? sr.journey?.origin, q.origin) && same(sr.destination ?? sr.journey?.destination, q.destination)) {
    const row = sr.trains.find((t: any) => String(t.trainNumber ?? t.number) === q.trainNumber);
    const c = row ? (row.classes || []).find((x: any) => String(x?.code ?? '').toUpperCase() === q.travelClass) : undefined;
    if (c && c.availability) {
      return { assessment: evaluateSeatShortage({ status: c.availability, requestedPassengerCount: q.passengersCount }), source: 'SEARCH_TRAINS', status: String(c.availability), resultId: sr.resultId ?? null };
    }
  }
  return null;
}

/** Muse's stated reason, only when it is one of the documented codes (never free text). */
export function museTriggerReason(v: unknown): ShortageTriggerReason | null {
  const r = String(v ?? '').trim().toUpperCase();
  return (SHORTAGE_TRIGGER_REASONS as readonly string[]).includes(r) ? (r as ShortageTriggerReason) : null;
}
