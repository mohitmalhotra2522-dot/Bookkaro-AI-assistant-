/**
 * Prompt 16 — ContextPatch model + validator + deterministic dependency rules.
 *
 * The LLM never overwrites context. Its extracted entities are PROPOSALS; this validator turns
 * each one into a ContextPatch only after checking:
 *    field allowed → value format → resolver (Station / Date / count) → current state → grounding /
 *    conflict with the authoritative BookingSession → dependency rules.
 *
 * Writing stays with the existing single writer (ContextualTurnApplier → ConversationStateManager,
 * whose invalidate() implements DEPENDENCY_RULES). Invalid patches are rejected, never "fixed up".
 *
 * Conflict rule (Part 29): a proposed value that DIFFERS from an established session value is
 * applied only when the user's own words support it (named station / date expression / number,
 * or an answer to the pending clarification). Otherwise → CONTEXT_CONFLICT clarification.
 */
import { providerToolCatalog } from '../tools/provider-tools';
import type { BookingSession, PendingInteraction } from '@shared/entities';
import type { ContextField, ContextPatch, ContextPatchKind, RejectedPatch } from '@shared/conversation-context';
import type { ExtractedEntities } from '../decisions/agent-decision';
import type { InvalidationScope } from '../state/conversation-state';
import { isISO, resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationDetailed, stationCodesMentioned, extractDateExpression, countMentioned } from './grounding';
import { uuid } from '../orchestrator/utils';

/** Deterministic dependency rules (Part 6). Mirrors ConversationStateManager.invalidate(). */
export const DEPENDENCY_RULES: Readonly<Record<ContextField, { scope: InvalidationScope | null; invalidates: readonly string[] }>> = Object.freeze({
  origin: { scope: 'ROUTE', invalidates: ['searchResults', 'selectedTrain', 'selectedClass', 'availability', 'fare', 'comparison'] },
  destination: { scope: 'ROUTE', invalidates: ['searchResults', 'selectedTrain', 'selectedClass', 'availability', 'fare', 'comparison'] },
  date: { scope: 'DATE', invalidates: ['searchResults', 'selectedTrain', 'selectedClass', 'availability', 'fare', 'comparison'] },
  selectedTrain: { scope: 'TRAIN', invalidates: ['selectedClass', 'availability', 'fare'] },
  selectedClass: { scope: 'CLASS', invalidates: ['availability', 'fare'] },
  // provider contract: fare is per passenger count; availability is per train/class/date
  passengersCount: { scope: 'PASSENGER_COUNT', invalidates: ['fare'] },
  preferredClass: { scope: null, invalidates: [] },
  preferredTime: { scope: null, invalidates: [] }
});

export const ALLOWED_PATCH_FIELDS: ReadonlySet<string> = new Set(Object.keys(DEPENDENCY_RULES));

/** Clarification that does not block the rest of the turn's valid slots (ambiguous station). */
/**
 * P37: in provider-tool mode the LLM is the semantic authority for stations/dates written in a script the backend does
 * not parse (Devanagari, Gurmukhi … — "अमृतसर से दिल्ली कल"). The backend cannot verify an official code / ISO date
 * against such words, so it does not reject them as ungrounded; Latin-script grounding + ambiguity checks stay.
 */
function llmSemanticAuthority(rawText: string): boolean {
  return providerToolCatalog.enabled() && /[\u0900-\u0DFF]/.test(String(rawText || ''));
}

export interface DeferredClarification { code: 'AMBIGUOUS_STATION'; message: string; pending: PendingInteraction }

export type PatchReview =
  | { ok: true; patches: ContextPatch[]; rejected: RejectedPatch[]; clarify?: DeferredClarification }
  | { ok: false; code: 'AMBIGUOUS_STATION' | 'CONTEXT_CONFLICT'; message: string; pending: PendingInteraction; patches: ContextPatch[]; rejected: RejectedPatch[] };

const short = (n?: string | null) => String(n || '').replace(/ Junction$/, '').replace(/ City$/, ' City').trim();
const FIELD_LABEL: Record<string, string> = { origin: 'origin', destination: 'destination', date: 'date', passengersCount: 'passengers' };
const PREF_CLASS = new Set(['AC', 'NON_AC', 'ANY', '1A', '2A', '3A', 'CC', 'EC', 'FC', 'SL', '2S', '3E']);
const AC_CODES = new Set(['AC', '1A', '2A', '3A', 'CC', 'EC', 'FC', '3E']);
/** Session stores only the preference FAMILY ('AC' | 'NON_AC' | 'ANY'); the exact class is chosen later per train. */
export function classPreferenceFamily(raw: string): 'AC' | 'NON_AC' | 'ANY' | null {
  const v = String(raw || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (!PREF_CLASS.has(v)) return null;
  if (v === 'ANY' || v === 'NON_AC') return v;
  return AC_CODES.has(v) ? 'AC' : 'NON_AC';
}
const PREF_TIME = new Set(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'ANY']);

export class ContextPatchValidator {
  /**
   * Review the LLM's proposed entities against the authoritative session + the user's own words.
   * May adjust `e` IN PLACE only in safe directions: drop an ungrounded proposal, replace an
   * LLM-computed ISO date by the DateResolver result, map an answer to a pending station question.
   */
  review(s: BookingSession, e: ExtractedEntities, rawText: string): PatchReview {
    const patches: ContextPatch[] = [];
    const rejected: RejectedPatch[] = [];
    const pend = s.pendingInteraction;
    const pk = pend?.data?.kind;
    const pendingCodes = new Set<string>([
      ...(pk === 'STATION_ROLE' && pend?.data?.code ? [String(pend.data.code)] : []),
      ...(pk === 'STATION_CHOICE' ? (pend?.data?.candidates || []).map((c: any) => String(c.code)) : []),
      ...(pk === 'CONTEXT_CONFLICT' && (pend?.data?.field === 'origin' || pend?.data?.field === 'destination') ? [String(pend.data.proposedCode)] : [])
    ]);
    // answer to "Ambala Cantt ya Ambala City?" keeps the role that was being asked
    if (pk === 'STATION_CHOICE' && e.stationOnlyRaw && !e.originRaw && !e.destinationRaw) {
      if (pend!.data!.role === 'origin') { e.originRaw = e.stationOnlyRaw; delete e.stationOnlyRaw; }
      else if (pend!.data!.role === 'destination') { e.destinationRaw = e.stationOnlyRaw; delete e.stationOnlyRaw; }
    }
    const mentioned = stationCodesMentioned(rawText);
    let clarify: DeferredClarification | undefined;
    const ambiguity = (role: 'origin' | 'destination' | null, proposed: string, candidates: ReadonlyArray<{ code: string; name: string }>): DeferredClarification => {
      const names = candidates.map(c => `${short(c.name)} (${c.code})`);
      return {
        code: 'AMBIGUOUS_STATION',
        message: `"${cap(proposed)}" naam ke ek se zyada stations hain — ${names.slice(0, -1).join(', ')} ya ${names[names.length - 1]}. Kaunsa station?`,
        pending: { type: 'CLARIFICATION_REQUIRED', data: { kind: 'STATION_CHOICE', role, name: cap(proposed), candidates: candidates.map(c => ({ code: c.code, name: c.name })) } }
      };
    };
    if (e.stationOnlyRaw && !e.originRaw && !e.destinationRaw) {
      const r0 = resolveStationDetailed(e.stationOnlyRaw);
      if (r0.kind === 'AMBIGUOUS') {
        rejected.push({ field: 'station', proposed: e.stationOnlyRaw, code: 'AMBIGUOUS_STATION', reason: 'multiple stations' });
        clarify = ambiguity(null, e.stationOnlyRaw, r0.candidates);
        delete e.stationOnlyRaw;
      }
    }

    // ---- stations ----
    for (const field of ['origin', 'destination'] as const) {
      const key = field === 'origin' ? 'originRaw' : 'destinationRaw';
      const proposed = e[key];
      if (!proposed) continue;
      const r = resolveStationDetailed(proposed);
      if (r.kind === 'AMBIGUOUS') {
        // never guessed: the slot stays empty, the turn's other valid slots still apply, user is asked
        rejected.push({ field, proposed, code: 'AMBIGUOUS_STATION', reason: 'multiple stations' });
        clarify ||= ambiguity(field, proposed, r.candidates);
        delete e[key];
        continue;
      }
      if (r.kind === 'UNKNOWN') continue;                                   // existing RouteResolver path explains it
      const previous = (s as any)[field] ?? null;
      const grounded = mentioned.has(r.code) || pendingCodes.has(r.code) || lc(rawText).includes(lc(proposed)) || llmSemanticAuthority(rawText);
      // 2026-10-09: the user's own words name the CURRENT station and the LLM's different value is ungrounded → no change
      // was asked for: the proposal is dropped (never applied, never a pointless conflict question)
      if (previous && previous !== r.code && !grounded && mentioned.has(previous)) {
        delete e[key];
        rejected.push({ field, proposed, code: 'UNGROUNDED_VALUE', reason: 'user named the current station' });
        continue;
      }
      if (previous && previous !== r.code && !grounded) {
        return this.conflict(field, proposed, r.code, r.name, previous, field === 'origin' ? s.originName : s.destinationName, patches, rejected);
      }
      if (!grounded && !previous) {
        delete e[key];
        rejected.push({ field, proposed, code: 'UNGROUNDED_VALUE', reason: 'value not present in the user\'s words' });
        continue;
      }
      patches.push(this.patch(field, proposed, r.code, previous, 'StationResolver', pend));
    }

    // ---- date (DateResolver is authoritative; never LLM arithmetic) ----
    if (e.dateRaw) {
      const proposed = String(e.dateRaw);
      const expr = extractDateExpression(rawText);
      const llmDate = resolveDate(proposed);
      const literal = lc(rawText).includes(lc(proposed)) || (llmDate.ok && llmSemanticAuthority(rawText));
      const conflictPending = pk === 'CONTEXT_CONFLICT' && pend?.data?.field === 'date' && pend?.data?.proposedCode === (llmDate.ok ? llmDate.date : proposed);
      if (expr && (!llmDate.ok || llmDate.date !== expr.date) && !conflictPending) {
        // the user said something else → DateResolver on the user's expression wins
        rejected.push({ field: 'date', proposed, code: 'LLM_DATE_OVERRIDDEN', reason: `DateResolver(${expr.expression}) = ${expr.date}` });
        e.dateRaw = expr.expression;
      } else if (!expr && !literal && !conflictPending) {
        const previous = s.date ?? null;
        if (previous && llmDate.ok && llmDate.date !== previous) {
          return this.conflict('date', proposed, llmDate.date, llmDate.date, previous, previous, patches, rejected);
        }
        if (!previous || !llmDate.ok || llmDate.date === previous) {
          delete e.dateRaw;
          if (!(llmDate.ok && llmDate.date === previous)) rejected.push({ field: 'date', proposed, code: 'UNGROUNDED_VALUE', reason: 'no date expression in the user\'s words' });
        }
      }
      if (e.dateRaw) {
        const fin = resolveDate(String(e.dateRaw));
        patches.push(this.patch('date', proposed, fin.ok ? fin.date : null, s.date ?? null, 'DateResolver', pend));
      }
    }

    // ---- passenger count ----
    if (e.passengersCountRaw !== undefined && e.passengersCountRaw !== null && e.passengersCountRaw !== '') {
      const n = parseInt(String(e.passengersCountRaw), 10);
      const said = countMentioned(rawText);
      const previous = s.passengersCount ?? null;
      const conflictPending = pk === 'CONTEXT_CONFLICT' && pend?.data?.field === 'passengersCount' && Number(pend?.data?.proposedCode) === n;
      if (!Number.isNaN(n) && !said.has(n) && !conflictPending) {
        if (previous && previous !== n) return this.conflict('passengersCount', String(n), String(n), String(n), String(previous), String(previous), patches, rejected);
        if (!previous) { delete e.passengersCountRaw; rejected.push({ field: 'passengersCount', proposed: String(n), code: 'UNGROUNDED_VALUE', reason: 'count not in the user\'s words' }); }
      }
      if (e.passengersCountRaw !== undefined) patches.push(this.patch('passengersCount', String(n), Number.isNaN(n) ? null : n, previous, 'PassengerCount', pend));
    }

    // ---- preferences (validated enums only) ----
    if (e.preferredClassRaw) {
      const v = classPreferenceFamily(e.preferredClassRaw);
      if (v) patches.push(this.patch('preferredClass', e.preferredClassRaw, v, s.preferredClass ?? null, 'ClassPreference', pend));
      else { rejected.push({ field: 'preferredClass', proposed: String(e.preferredClassRaw), code: 'INVALID_CLASS_REFERENCE', reason: 'unknown class preference' }); delete e.preferredClassRaw; }
    }
    if (e.preferredTimeRaw) {
      const v = String(e.preferredTimeRaw).toUpperCase();
      if (PREF_TIME.has(v)) patches.push(this.patch('preferredTime', e.preferredTimeRaw, v, s.preferredTime ?? null, 'TimePreference', pend));
      else { rejected.push({ field: 'preferredTime', proposed: String(e.preferredTimeRaw), code: 'UNGROUNDED_VALUE', reason: 'unknown time window' }); delete e.preferredTimeRaw; }
    }
    // train / class proposals are resolved against DisplayedResults / the selected train by the
    // Train/ClassReferenceResolver (never accepted as raw values) — recorded here for observability.
    if (e.trainRef) patches.push(this.patch('selectedTrain', `${e.trainRef.kind}:${String((e.trainRef as any).value)}`, null, trainNo(s), 'TrainReferenceResolver', pend));
    if (e.classRaw) patches.push(this.patch('selectedClass', String(e.classRaw), null, s.selectedClass ?? null, 'ClassReferenceResolver', pend));
    return { ok: true, patches, rejected, ...(clarify ? { clarify } : {}) };
  }

  private patch(field: ContextField, proposed: string, value: string | number | null, previous: string | number | null, resolvedBy: string, pend?: PendingInteraction): ContextPatch {
    const answers: Record<string, ContextField[]> = { DATE_REQUIRED: ['date'], ORIGIN_REQUIRED: ['origin'], DESTINATION_REQUIRED: ['destination'], PASSENGERS_REQUIRED: ['passengersCount'], CLASS_SELECTION_REQUIRED: ['selectedClass'], TRAIN_SELECTION_REQUIRED: ['selectedTrain'] };
    const kind: ContextPatchKind = previous !== null && previous !== undefined && value !== null && previous === value ? 'NOOP'
      : previous !== null && previous !== undefined && value !== null ? 'CORRECTION'
      : (answers[pend?.type || ''] || []).includes(field) ? 'ANSWER' : 'FILL';
    return Object.freeze({ patchId: uuid(), field, proposed: String(proposed), value, previous: previous ?? null, source: 'LLM', kind, invalidates: kind === 'CORRECTION' ? DEPENDENCY_RULES[field].invalidates : [], resolvedBy }) as ContextPatch;
  }

  private conflict(field: 'origin' | 'destination' | 'date' | 'passengersCount', proposed: string, proposedCode: string, proposedLabel: string, previous: string, previousLabel: string | undefined, patches: ContextPatch[], rejected: RejectedPatch[]): PatchReview {
    const lbl = FIELD_LABEL[field];
    const nameOf = (code: string) => { const r = resolveStationDetailed(code); return r.kind === 'RESOLVED' ? r.name : undefined; };
    const cur = field === 'origin' || field === 'destination' ? short(previousLabel || nameOf(previous) || previous) : previousLabel || previous;
    const nxt = field === 'origin' || field === 'destination' ? short(proposedLabel) : proposedLabel;
    return {
      ok: false, code: 'CONTEXT_CONFLICT', patches,
      rejected: [...rejected, { field, proposed, code: 'CONTEXT_CONFLICT', reason: `session has ${previous}; user did not state ${proposedCode}` }],
      message: `Abhi ${lbl} ${cur} hai; ${nxt} par badlav abhi apply nahi hua.`,
      pending: { type: 'CLARIFICATION_REQUIRED', data: { kind: 'CONTEXT_CONFLICT', field, proposedCode, current: previous } }
    };
  }
}

const lc = (s: string) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f/ -]/g, ' ').replace(/\s+/g, ' ').trim()} `;
const cap = (s: string) => String(s).replace(/\b\w/g, c => c.toUpperCase());
const trainNo = (s: BookingSession): string | null => { const t: any = s.selectedTrain; return t ? (t.number || t.trainNumber || null) : null; };
