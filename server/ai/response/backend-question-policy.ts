/**
 * P42.1 — backend conversational-question policy.
 *
 * The backend never authors a conversational question (or an "ask the user …" request). It provides facts and
 * STRUCTURED context (error code, missing field, whether user action is required, pending confirmation); Muse /
 * the user-selected fallback LLM decides whether and how to ask. Two helpers enforce that at the choke points:
 *
 *   factOnly(text)        — drops every sentence of a backend-authored text that asks / requests something from the
 *                           user ("…?", "…batayein.", "…chuniye."). Facts stay; nothing new is written.
 *   missingInfoOf(…)      — maps an error code / pending interaction to { missingField, userActionRequired }.
 *   pendingInfoView(…)    — the pending interaction as structured data (type + data, NO canned hint text).
 *
 * Safety (Category B) is untouched: the backend still decides that a confirmation is REQUIRED and independently
 * verifies the user's explicit confirmation before any protected step — only the wording moved to the LLM.
 */
import type { BookingSession } from '@shared/entities';

/** A sentence that asks or requests something from the user (conversational — the LLM's job). Mirrors the composer's
 *  "already asks" rule; retry advice ("dobara boliye") and boundary facts are NOT requests for information. */
const ASKS_USER = /\?|\b(bataiye|batayein|bataen|batao|bata dijiye|bata do|bataa dijiye|chuniye|chun lijiye|likhiye|please (?:share|tell|choose|select|pick)|let me know|which (?:one|train|class|date|station))\b/i;

/** Quoted text (an example of what the user can say, e.g. (poora PNR: "PNR kya hai?")) is not the backend asking. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
export function asksUser(sentence: string): boolean { return ASKS_USER.test(String(sentence || '').replace(QUOTED, '""')); }

/** Sentence split that keeps line structure (review / list texts keep their newlines). */
function sentencesOf(line: string): string[] {
  // split at sentence ends OUTSIDE quotes (a quoted "…?" example stays inside its sentence)
  const out: string[] = []; let cur = ''; let inQ = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k]; cur += ch;
    if (ch === '"' || ch === '“' || ch === '”') inQ = ch === '“' ? true : ch === '”' ? false : !inQ;
    if (!inQ && /[.!?।]/.test(ch) && (k + 1 >= line.length || /\s/.test(line[k + 1]))) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Backend-authored text → facts only (every asking / requesting sentence removed). Never adds wording. */
export function factOnly(text: string | null | undefined): string {
  const src = String(text ?? '');
  if (!src.trim()) return '';
  const lines = src.split('\n').map(l => {
    const lead = (l.match(/^\s*/) || [''])[0];
    const kept = sentencesOf(l).filter(x => !asksUser(x));
    return kept.length ? lead + kept.join(' ') : null;
  }).filter((l): l is string => l !== null);
  return lines.join('\n').trim();
}

export type MissingField =
  | 'ORIGIN' | 'DESTINATION' | 'ORIGIN_AND_DESTINATION' | 'DATE' | 'DATE_MONTH' | 'PASSENGER_COUNT' | 'TRAIN' | 'CLASS'
  | 'PASSENGER_DETAILS' | 'PASSENGER' | 'STATION' | 'STATION_ROLE' | 'BOOKING' | 'CHANGE_DETAILS' | 'NEW_ROUTE'
  | 'CONFIRM_CHANGE' | 'RETRY_PREPARATION' | 'CONFIRMATION' | 'CLARIFICATION';

const PENDING_FIELD: Record<string, MissingField> = {
  ORIGIN_REQUIRED: 'ORIGIN', DESTINATION_REQUIRED: 'DESTINATION', DATE_REQUIRED: 'DATE', PASSENGERS_REQUIRED: 'PASSENGER_COUNT',
  TRAIN_SELECTION_REQUIRED: 'TRAIN', CLASS_SELECTION_REQUIRED: 'CLASS', PASSENGER_DETAILS_REQUIRED: 'PASSENGER_DETAILS',
  REVIEW_APPROVAL_REQUIRED: 'CONFIRMATION', CONFIRMATION_REQUIRED: 'CONFIRMATION'
};
const KIND_FIELD: Record<string, MissingField> = {
  DATE_MONTH: 'DATE_MONTH', STATION_ROLE: 'STATION_ROLE', STATION_CHOICE: 'STATION', CHANGE_DETAILS: 'CHANGE_DETAILS',
  NEW_ROUTE: 'NEW_ROUTE', CONTEXT_CONFLICT: 'CONFIRM_CHANGE', RETRY_PREPARATION: 'RETRY_PREPARATION'
};
const CODE_FIELD: Record<string, MissingField> = {
  AMBIGUOUS_ROUTE: 'STATION', AMBIGUOUS_STATION: 'STATION', INVALID_STATION: 'STATION', UNKNOWN_STATION: 'STATION',
  INVALID_PASSENGER_COUNT: 'PASSENGER_COUNT', MISSING_PASSENGER_COUNT: 'PASSENGER_COUNT', INVALID_CLASS_SELECTION: 'CLASS',
  AMBIGUOUS_CLASS: 'CLASS', INVALID_PASSENGER_INDEX: 'PASSENGER', AMBIGUOUS_PASSENGER: 'PASSENGER', AMBIGUOUS_DATE: 'DATE',
  INVALID_DATE: 'DATE', PAST_DATE: 'DATE', MISSING_DATE: 'DATE', INVALID_CONFIRMATION: 'CONFIRMATION',
  MULTIPLE_BOOKINGS_MATCHED: 'BOOKING', BOOKING_NOT_FOUND: 'BOOKING', AMBIGUOUS_REFERENCE: 'CLARIFICATION',
  STALE_SEARCH_REFERENCE: 'TRAIN', TRAIN_NOT_IN_RESULTS: 'TRAIN', MISSING_TRAIN: 'TRAIN', MISSING_CLASS: 'CLASS'
};

type PendingLike = { type?: string; data?: any } | null | undefined;

/** Structured "what is missing" for an error / pending interaction — never a sentence. */
export function missingInfoOf(code: string | null | undefined, pending?: PendingLike, details?: any): { missingField?: MissingField; userActionRequired: boolean } {
  const kind = pending?.data?.kind ? KIND_FIELD[String(pending.data.kind)] : undefined;
  const fromPending = kind || (pending?.type ? (pending.type === 'ORIGIN_REQUIRED' && pending.data?.route ? 'ORIGIN_AND_DESTINATION' : PENDING_FIELD[pending.type]) : undefined);
  const fromDetails = details && typeof details === 'object' && typeof details.missingField === 'string' ? details.missingField as MissingField : undefined;
  const field = fromDetails || (code ? CODE_FIELD[String(code)] : undefined) || fromPending;
  return field ? { missingField: field, userActionRequired: true } : { userActionRequired: false };
}

/** The pending interaction as structured data for the LLM: type + data, without any canned hint / question text. */
export function pendingInfoView(p: BookingSession['pendingInteraction'] | PendingLike): Record<string, any> | null {
  if (!p || !(p as any).type || (p as any).type === 'NONE') return null;
  const { hint: _hint, ...rest } = p as any;
  const data = rest.data && typeof rest.data === 'object' ? { ...rest.data } : undefined;
  if (data) for (const k of Object.keys(data)) if (typeof data[k] === 'string' && asksUser(data[k]) && !/^[A-Z_]+$/.test(data[k])) delete data[k];
  const mi = missingInfoOf(null, p as any);
  return { type: rest.type, ...(data ? { data } : {}), ...(mi.missingField ? { missingField: mi.missingField } : {}), userActionRequired: mi.userActionRequired };
}

/** Category B — a protected action awaiting the user's explicit confirmation (backend-verified; the LLM words it). */
export function pendingConfirmationOf(s: BookingSession, reviewAwaiting: boolean): { action: string; confirmationRequired: true; confirmationStatus: 'PENDING' } | null {
  const lc: any = s.pendingLifecycleAction;
  if (lc && lc.actionId) {
    const last: any = (s as any).lastLifecycleAction;
    const t = String(last && last.actionId === lc.actionId ? last.actionType : '').toUpperCase();
    return { action: /CANCEL/.test(t) ? 'CANCELLATION' : /MODIF|CHANGE/.test(t) ? 'MODIFICATION' : (t || 'LIFECYCLE_ACTION'), confirmationRequired: true, confirmationStatus: 'PENDING' };
  }
  if (reviewAwaiting || s.pendingInteraction?.type === 'CONFIRMATION_REQUIRED' || s.pendingInteraction?.type === 'REVIEW_APPROVAL_REQUIRED') {
    return { action: 'BOOKING_CONFIRMATION', confirmationRequired: true, confirmationStatus: 'PENDING' };
  }
  return null;
}

/** P42.1: structured missing information for the LLM (it decides whether and how to ask). */
export function missingInformationOf(s: BookingSession): Record<string, 'present' | 'missing'> {
  const st = (v: unknown): 'present' | 'missing' => (v === undefined || v === null || v === '' || v === 0 ? 'missing' : 'present');
  const count = s.passengersCount || 0;
  const paxDone = count > 0 && (s.passengers || []).filter(p => p && p.name && p.age && p.gender).length >= count;
  return {
    origin: st(s.origin), destination: st(s.destination), date: st(s.date), passengersCount: st(count),
    train: st(s.selectedTrain), class: st(s.selectedClass), passengerDetails: paxDone ? 'present' : 'missing'
  };
}

/**
 * P42.1 hardening — did this (LLM-written) reply ask about THIS optional passenger detail? True only when one sentence
 * both asks the user something and refers to the field (seat / berth vs meal / food, English · Hinglish · Hindi).
 * Response-side check only (like the claim guards): it records "asked once"; it never routes or adds a question.
 */
const OPTIONAL_FIELD_TERMS: Record<'berthPreference' | 'foodPreference', RegExp> = {
  berthPreference: /\b(berth|seat|window|lower|middle|upper|side|cabin|coupe|preference)\b|सीट|बर्थ|विंडो|खिड़की|लोअर|मिडिल|अपर|साइड|प्राथमिकता|पसंद/i,
  foodPreference: /\b(food|meal|meals|khana|khaana|khane|khaane|veg|non[\s-]?veg|catering|bhojan)\b|खाना|खाने|भोजन|वेज|शाकाहारी|मील/i
};
export function asksAboutOptionalField(text: string, field: string): boolean {
  const terms = (OPTIONAL_FIELD_TERMS as Record<string, RegExp>)[field];
  if (!terms) return false;
  return String(text || '').split(/\n+/).flatMap(sentencesOf).some(sn => asksUser(sn) && terms.test(sn.replace(QUOTED, '""')));
}
