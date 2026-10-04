/**
 * PROMPT 28 — claim ↔ entity binding.
 *
 * P27 live bug: the reply named 12014, then said "Is train ki 3A … ₹650", and the guard accepted it because the
 * facts existed — for 12497. Facts were checked for EXISTENCE, not for the ENTITY the sentence is about.
 *
 * Here every railway claim sentence (seat availability, ₹ fare, a time / class list said about "this train") is bound
 * to exactly one train before it is verified:
 *   1. EXPLICIT            — the sentence names the train (number / distinctive name);
 *   2. REFERENCE_RESOLVED  — "is train / iski / ye wali / us train / this train / it" (or an unnamed claim) → the single
 *                            train the reply named most recently (what the reader resolves the pronoun to);
 *   3. SESSION_FOCUS       — nothing named in the reply → the session's selected (or, for a pronoun, focused) train;
 *   4. SINGLE_RESULT       — no focus → the only train this turn's fare / availability results are about;
 *   otherwise AMBIGUOUS    — the claim is removed (never guessed). An unnamed claim whose reply antecedent and session
 *                            focus disagree is AMBIGUOUS too.
 * The bound form ("12014: Is train ki 3A …") is then judged by the EXISTING P25 / P26 judges, so the same rules apply —
 * only now to the right train, class and date. This is linguistic binding + structured matching; it never decides
 * intent, never picks a train for the user, never changes what the LLM may call.
 */
import type { BookingSession } from '@shared/entities';
import { trainsIn, judgeFareScope, judgeFareAuthority, judgeTimes, judgeClassList, isClassListClaim, buildFactIndex, type FactIndex, type FactView } from './claim-facts';
import { classifyAvailabilityClaim, judgeAvailabilityClaim, collectAvailabilityEvidence, type AvailabilityContext, type AvailabilityEvidence } from './availability-authority';
import { claimedDate } from './claim-dates';

export type ClaimBindingStatus =
  | 'EXPLICIT' | 'REFERENCE_RESOLVED' | 'SESSION_FOCUS' | 'SINGLE_RESULT' | 'AMBIGUOUS' | 'UNBOUND' | 'NOT_APPLICABLE';

export interface ClaimBinding {
  status: ClaimBindingStatus;
  trainNumbers: string[];
  travelClass?: string;
  date?: string;
  anaphor: boolean;
  via?: 'SENTENCE' | 'REPLY' | 'SESSION' | 'RESULT';
}

export type CrossEntityDiagnosis = 'CROSS_TRAIN_FACT' | 'CROSS_CLASS_FACT' | 'CROSS_DATE_FACT';

/** "is train / iss train / us train / ye(h) train / wo(h) train / ye wali / iski / uska / isme / this train / that one / it" */
export const ANAPHOR_RE = /\b((is|iss|us|uss|yeh|ye|woh|wo|isi|usi)\s+(train|gaadi|gadi|wali|waali|wale|waale)|iski|iska|iske|uski|uska|uske|isme|ismein|usme|usmein|is\s+mein|us\s+mein|this\s+(train|one)|that\s+(train|one)|the\s+same\s+train|it|its|it's)\b|^\s*(yeh|ye|woh|wo|yahi|wahi|vahi)\b/i;
const CLASS_CODE_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA)\b/g;
const TIME_RE = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/;
const FARE_RE = /(?:₹|\brs\.?\s?|\binr\s?)\s?\d/i;
const codesIn = (t: string) => [...new Set((t.match(CLASS_CODE_RE) || []).map(c => c.toUpperCase()))];

/** A sentence that states a live railway fact ABOUT A TRAIN (and therefore needs an entity). */
export function isEntityClaim(t: string): boolean {
  if (FARE_RE.test(t)) return true;
  if (classifyAvailabilityClaim(t, 'ASSISTANT') === 'LIVE_AVAILABILITY_CLAIM') return true;
  // a time / class list is entity-bound only when said about "this train" (otherwise P25 judges it against the set)
  return ANAPHOR_RE.test(t) && (TIME_RE.test(t) || codesIn(t).length > 0);
}

export interface BinderContext {
  idx: FactIndex;
  session: BookingSession | any;
  /** trains this turn's fare / availability results are about (identity) */
  resultTrains?: string[];
}

/**
 * Binds sentences IN ORDER (one instance per reply). The reply's own most recently named train is the antecedent —
 * tracked from every sentence the LLM wrote (also removed ones: the writer meant that train, so a claim about it is
 * checked against it, never against a different train that happens to have the fact).
 */
export class ClaimEntityBinder {
  private lastNamed: string[] = [];
  private lastClasses: string[] = [];
  constructor(private readonly ctx: BinderContext) {}

  bind(sentence: string): ClaimBinding {
    const t = String(sentence || '');
    const s: any = this.ctx.session || {};
    const anaphor = ANAPHOR_RE.test(t);
    const date = claimedDate(t);
    const named = [...new Set([...trainsIn(t, this.ctx.idx).map(f => f.num), ...(t.match(/\b\d{5}\b/g) || [])])];
    const codes = codesIn(t);
    const claim = isEntityClaim(t);
    const cls = codes.length === 1 ? codes[0] : !codes.length && this.lastClasses.length === 1 ? this.lastClasses[0] : undefined;
    const out = (status: ClaimBindingStatus, trainNumbers: string[], via?: ClaimBinding['via']): ClaimBinding =>
      ({ status, trainNumbers, ...(status !== 'NOT_APPLICABLE' && cls ? { travelClass: cls } : {}), ...(date ? { date } : {}), anaphor, ...(via ? { via } : {}) });
    if (named.length) {
      this.lastNamed = named;
      if (codes.length) this.lastClasses = codes;
      return out('EXPLICIT', named, 'SENTENCE');
    }
    try {
      if (!claim) return out('NOT_APPLICABLE', []);
      const selected = String(s.selectedTrain?.number ?? s.selectedTrain?.trainNumber ?? '') || undefined;
      const focus = selected ?? (anaphor ? (String(s.focusTrainNumber ?? '') || undefined) : undefined);
      if (this.lastNamed.length === 1) {
        const ante = this.lastNamed[0];
        // a pronoun refers to the reply's antecedent; an unnamed claim is ambiguous when antecedent ≠ session focus
        if (anaphor || !focus || focus === ante) return out('REFERENCE_RESOLVED', [ante], 'REPLY');
        return out('AMBIGUOUS', []);
      }
      if (this.lastNamed.length > 1) return out('AMBIGUOUS', []);
      if (focus) return out('SESSION_FOCUS', [focus], 'SESSION');
      const rt = [...new Set(this.ctx.resultTrains || [])];
      if (rt.length === 1) return out('SINGLE_RESULT', rt, 'RESULT');
      return out(anaphor ? 'AMBIGUOUS' : 'UNBOUND', []);
    } finally {
      if (codes.length) this.lastClasses = codes;
    }
  }
}

/** The bound form judged internally ("12014 3A: Is train ki seats …") — never shown to the user. */
export function boundSentence(t: string, b: ClaimBinding): string {
  if (b.status === 'EXPLICIT' || b.trainNumbers.length !== 1) return t;
  if (!['REFERENCE_RESOLVED', 'SESSION_FOCUS', 'SINGLE_RESULT'].includes(b.status)) return t;
  const cls = b.travelClass && !codesIn(t).length ? ` ${b.travelClass}` : '';
  return `${b.trainNumbers[0]}${cls}: ${t}`;
}

/** Trains this turn's fare / availability results are about (from identity / provider fields). */
export function resultTrainsOf(idx: FactIndex, evidence: AvailabilityEvidence[]): string[] {
  return [...new Set([...idx.fares.map(f => f.train), ...evidence.map(e => e.trainNumber)].filter((x): x is string => !!x))];
}

/**
 * Why an explicit / bound claim failed, in entity terms (internal diagnostics only): the fact exists — for another
 * train (CROSS_TRAIN), another class of the same train (CROSS_CLASS) or another date (CROSS_DATE).
 */
export function diagnoseCrossEntity(t: string, b: ClaimBinding, idx: FactIndex, evidence: AvailabilityEvidence[], sessionDate?: string): CrossEntityDiagnosis | null {
  const train = b.trainNumbers[0];
  if (!train) return null;
  const codes = codesIn(t);
  const cls = codes[0] ?? b.travelClass;
  const date = b.date ?? sessionDate;
  const amounts = [...t.matchAll(/(?:₹|\brs\.?\s?|\binr\s?)\s?([\d,]+(?:\.\d+)?)/gi)].map(m => Number(m[1].replace(/,/g, '')));
  if (amounts.length) {
    const has = (f: any) => amounts.some(n => f.perPassenger === n || f.total === n);
    if (idx.fares.some(f => has(f) && f.train && f.train !== train)) return 'CROSS_TRAIN_FACT';
    if (idx.fares.some(f => has(f) && (!f.train || f.train === train) && cls && f.cls && f.cls !== cls)) return 'CROSS_CLASS_FACT';
    if (idx.fares.some(f => has(f) && (!f.train || f.train === train) && date && f.date && f.date !== date)) return 'CROSS_DATE_FACT';
  }
  // a time said about the bound train that is ANOTHER train's departure / arrival
  for (const m of t.matchAll(new RegExp(TIME_RE.source, 'g'))) {
    const v = `${m[1].padStart(2, '0')}:${m[2]}`;
    const own = idx.trains.filter(f => f.num === train).some(f => f.dep === v || f.arr === v);
    if (!own && idx.trains.some(f => f.num !== train && (f.dep === v || f.arr === v))) return 'CROSS_TRAIN_FACT';
  }
  if (classifyAvailabilityClaim(t, 'ASSISTANT') === 'LIVE_AVAILABILITY_CLAIM' || ANAPHOR_RE.test(t)) {
    if (evidence.some(e => e.trainNumber && e.trainNumber !== train && (!cls || e.travelClass === cls))) return 'CROSS_TRAIN_FACT';
    if (evidence.some(e => e.trainNumber === train && cls && e.travelClass !== cls)) return 'CROSS_CLASS_FACT';
    if (evidence.some(e => e.trainNumber === train && (!cls || e.travelClass === cls) && date && e.date && e.date !== date)) return 'CROSS_DATE_FACT';
  }
  return null;
}

export interface BoundVerdict { reason: string | null; diagnosis?: CrossEntityDiagnosis | null }

/**
 * Verify the BOUND form of a sentence that already passed the unbound P25 / P26 checks. Only the structured railway
 * judges run again (availability authority, fare scope, train ↔ time, class list) — scoped to the bound train / class.
 */
export function verifyBoundClaim(t: string, b: ClaimBinding, idx: FactIndex, availCtx: AvailabilityContext, opts: { general?: boolean } = {}): BoundVerdict {
  if (b.status === 'AMBIGUOUS') return { reason: isEntityClaim(t) ? 'AMBIGUOUS_REFERENCE' : null };
  const bt = boundSentence(t, b);
  if (bt === t) return { reason: null };
  // the fact exists for another entity → CROSS_*; otherwise the judge's own reason for the bound train
  const fail = (underlying: string): BoundVerdict => {
    const diagnosis = diagnoseCrossEntity(t, b, idx, availCtx.evidence, String(availCtx.session?.date || '') || undefined);
    return diagnosis ? { reason: `${diagnosis}:${b.trainNumbers[0]}`, diagnosis } : { reason: underlying, diagnosis: null };
  };
  const av = judgeAvailabilityClaim(bt, availCtx);
  if (av.reason) return fail(av.reason);
  const fr = judgeFareScope(bt, idx).reason;
  if (fr) return fail(fr);
  if (TIME_RE.test(t) && b.anaphor && !opts.general) { const tv = judgeTimes(bt, idx, true).reason; if (tv) return fail(tv); }
  if (b.anaphor && isClassListClaim(bt)) { const cl = judgeClassList(bt, idx); if (cl) return fail(cl); }
  return { reason: null };
}

// ------------------------------------------------------------------ whole-text guard (backend reply path)

const SPLIT_RE = /(?<=[.!?।])\s+/;

/**
 * Sentence-level entity guard for an LLM final message that becomes part of the backend reply (non-native path).
 * Keeps every sentence whose train / class / date binding verifies; removes cross-entity and ambiguous claims.
 */
/**
 * Prompt 34 follow-up — sentence-level FARE AUTHORITY guard for LLM text that becomes the backend reply (native agent
 * final message, clarification). Every sentence with a ₹ amount must pass `judgeFareAuthority`; failing sentences are
 * removed (the caller substitutes deterministic tool facts / the honest fallback). Mode-independent: TEXT and VOICE
 * get the identical result, and the composer then sees only validated text (no self-grounding).
 */
export function guardFareClaims(text: string, session: BookingSession | any, steps: any[] = [])
  : { kept: string[]; rejected: Array<{ sentence: string; reason: string; binding: ClaimBindingStatus }> } {
  const views: FactView[] = (steps || []).map((st: any) => ({
    toolName: st?.result?.toolName ?? st?.toolCall?.name, ok: st?.status === 'ok' || st?.result?.success === true,
    data: st?.result?.data, callId: st?.toolCall?.callId, identity: st?.result?.identity
  }));
  const idx = buildFactIndex(session || ({} as any), views);
  const kept: string[] = []; const rejected: Array<{ sentence: string; reason: string; binding: ClaimBindingStatus }> = [];
  for (const raw of String(text || '').split(SPLIT_RE)) {
    const t = raw.trim();
    if (!t) continue;
    const reason = judgeFareAuthority(t, idx);
    if (reason) rejected.push({ sentence: t.slice(0, 120), reason, binding: 'NOT_APPLICABLE' });
    else kept.push(t);
  }
  return { kept, rejected };
}

export function bindAndVerifyClaims(text: string, session: BookingSession | any, steps: any[] = [])
  : { kept: string[]; rejected: Array<{ sentence: string; reason: string; binding: ClaimBindingStatus }>; bindings: ClaimBinding[] } {
  const views: FactView[] = (steps || []).map((st: any) => ({
    toolName: st?.result?.toolName ?? st?.toolCall?.name, ok: st?.status === 'ok' || st?.result?.success === true,
    data: st?.result?.data, callId: st?.toolCall?.callId, identity: st?.result?.identity
  }));
  const idx = buildFactIndex(session, views);
  const evidence = collectAvailabilityEvidence(session, steps);
  const availCtx: AvailabilityContext = { session, evidence, trains: idx.trains.map(f => ({ num: f.num, classes: f.classes })) };
  const binder = new ClaimEntityBinder({ idx, session, resultTrains: resultTrainsOf(idx, evidence) });
  const kept: string[] = []; const rejected: Array<{ sentence: string; reason: string; binding: ClaimBindingStatus }> = []; const bindings: ClaimBinding[] = [];
  for (const raw of String(text || '').split(SPLIT_RE)) {
    const t = raw.trim();
    if (!t) continue;
    const b = binder.bind(t);
    bindings.push(b);
    let reason: string | null = null;
    if (b.status === 'EXPLICIT' && b.trainNumbers.length >= 1) {
      // an explicit claim: the named train's own fare must carry the amount; its own availability result the status
      const f = judgeFareScope(t, idx);
      if (f.reason) reason = f.reason;
      else if (classifyAvailabilityClaim(t, 'ASSISTANT') === 'LIVE_AVAILABILITY_CLAIM' && evidence.length) {
        const av = judgeAvailabilityClaim(t, availCtx);
        if (av.reason) reason = av.reason;
      }
    } else {
      // unnamed claims: remove what is provably about ANOTHER entity, or unresolvable; a claim with no evidence at all
      // stays the composer's (P26) responsibility on this path
      const v = verifyBoundClaim(t, b, idx, availCtx);
      if (v.reason && (v.reason === 'AMBIGUOUS_REFERENCE' || v.diagnosis)) reason = v.reason;
    }
    if (reason) rejected.push({ sentence: t.slice(0, 120), reason, binding: b.status });
    else kept.push(t);
  }
  return { kept, rejected, bindings };
}
