/**
 * Prompt 30 — Contextual reference context (extends the existing session model; no parallel state system).
 *
 *  - `resultSetOf`        : provenance of the CURRENT authoritative result set (date / route / source turn / tool result)
 *                           and whether it still matches the session journey (a date / route change makes it stale).
 *  - `referenceContextView`: the compact view the LLM receives so IT can interpret "doosri wali", "iska", "same class"
 *                           — active result set journey, current focus, and the previous choice for an older journey
 *                           marked as an expired preference (never as a fact).
 *  - `recordTrainReference` / `recordToolArgReference`: internal resolution records for observability
 *                           (diagnostics.references). Reference kind / value codes only — never raw user text, never
 *                           shown to the user.
 *
 * The LLM interprets references; the backend only validates the entity it chose against the current result set.
 * Nothing here calls a tool, picks a train, or stores railway facts.
 */
import type { BookingSession } from '@shared/entities';
import type { TrainReference } from '../decisions/agent-decision';
import { currentResults, type TrainRefResolution } from './train-reference-resolver';

const code = (x: any): string | undefined => (x && typeof x === 'object' ? x.code : x) || undefined;

export interface ResultSetProvenance {
  resultSetId: string | null;
  version: number;
  date: string | null;
  origin: string | null;
  destination: string | null;
  count: number;
  sourceTool: 'SEARCH_TRAINS';
  sourceTurnId: string | null;
  sourceToolResultId: string | null;
  retrievedAt: string | null;
  /** false → the session journey (date / route) moved on; display indexes of this set are stale */
  current: boolean;
  staleReason: 'DATE_CHANGED' | 'ROUTE_CHANGED' | null;
}

/** Provenance of the current result set (null when there is none). */
export function resultSetOf(s: BookingSession): ResultSetProvenance | null {
  const sr: any = s.searchResults;
  const trains = currentResults(s);
  if (!sr || !trains.length) return null;
  const j = sr.journey || {};
  const date = sr.date ?? j.date ?? null;
  const origin = code(sr.origin) ?? code(j.origin) ?? null;
  const destination = code(sr.destination) ?? code(j.destination) ?? null;
  const routeChanged = (!!origin && !!s.origin && origin !== s.origin) || (!!destination && !!s.destination && destination !== s.destination);
  const dateChanged = !!date && !!s.date && date !== s.date;
  return {
    resultSetId: sr.resultId ?? s.searchMeta?.resultId ?? null,
    version: s.searchResultsVersion || 0,
    date, origin, destination, count: trains.length,
    sourceTool: 'SEARCH_TRAINS',
    sourceTurnId: sr.sourceTurnId ?? null,
    sourceToolResultId: sr.sourceToolResultId ?? null,
    retrievedAt: sr.retrievedAt ?? null,
    current: !routeChanged && !dateChanged,
    staleReason: routeChanged ? 'ROUTE_CHANGED' : dateChanged ? 'DATE_CHANGED' : null
  };
}

/** Compact LLM view (no internal ids). */
export function referenceContextView(s: BookingSession) {
  const rs = resultSetOf(s);
  const st = s.staleReference;
  return {
    activeResultSet: rs ? { date: rs.date, origin: rs.origin, destination: rs.destination, count: rs.count, current: rs.current } : null,
    focusTrainNumber: s.focusTrainNumber ?? null,
    previousChoiceForOlderJourney: st ? {
      trainNumber: st.trainNumber, classCode: st.classCode ?? null, date: st.date ?? null, origin: st.origin ?? null,
      destination: st.destination ?? null, reason: st.reason, factsExpired: true
    } : null,
    rules: 'Display positions (pehli / doosri / last wali) refer ONLY to activeResultSet. previousChoiceForOlderJourney is a preference, not a fact: use it only if that train is in the current results; otherwise say it is not there and let the user choose. If a pronoun (iska / uska / ye wali) could mean more than one train, ask which one.'
  };
}

// ------------------------------------------------------------------ resolution records (internal observability)

export type ReferenceStatus = 'VALID' | 'STALE' | 'AMBIGUOUS' | 'INVALID';
export type ResolutionType = 'TRAIN_NUMBER' | 'DISPLAY_INDEX' | 'POSITION' | 'FOCUS' | 'TIME_WINDOW' | 'CLASS_PREFERENCE' | 'PREVIOUS' | 'ALTERNATIVE' | 'TOOL_ARGUMENT' | 'TRAIN_NAME';

export interface ReferenceResolutionRecord {
  via: 'SELECTION' | 'TOOL_ARGUMENT';
  referenceType: string;
  /** the LLM's structured reference value ("2", "LAST", "MORNING", a train number) — never raw user text */
  referenceValue: string | null;
  resolutionType: ResolutionType;
  status: ReferenceStatus;
  resolvedTrainNumber: string | null;
  displayIndex: number | null;
  candidates: number;
  ambiguityReason: string | null;
  tool: string | null;
  /** provenance of the result set the entity came from (P28 diagnostics convention: tool / toolResultId / turnId);
   *  null when the entity is not from the current result set */
  source: { tool: 'SEARCH_TRAINS'; toolResultId: string | null; turnId: string | null; resultSetVersion: number; date: string | null; route: string | null } | null;
}

function resolutionTypeOf(ref: TrainReference): ResolutionType {
  switch (ref.kind) {
    case 'TRAIN_NUMBER': return 'TRAIN_NUMBER';
    case 'DISPLAY_INDEX': return 'DISPLAY_INDEX';
    case 'DEMONSTRATIVE': return ref.value === 'THIS' ? 'FOCUS' : 'POSITION';
    case 'TIME_PREFERENCE': return 'TIME_WINDOW';
    case 'CLASS_PREFERENCE': return 'CLASS_PREFERENCE';
    case 'PREVIOUS': return 'PREVIOUS';
    case 'TRAIN_NAME': return 'TRAIN_NAME';
    default: return 'ALTERNATIVE';
  }
}

function sourceOf(s: BookingSession, matched: boolean): { source: ReferenceResolutionRecord['source'] } {
  const rs = resultSetOf(s);
  return { source: rs && matched
    ? { tool: rs.sourceTool, toolResultId: rs.sourceToolResultId, turnId: rs.sourceTurnId, resultSetVersion: rs.version, date: rs.date, route: rs.origin && rs.destination ? `${rs.origin}-${rs.destination}` : null }
    : null };
}

/** Record for an LLM trainRef the backend resolved (or refused) against the current result set. */
export function recordTrainReference(ref: TrainReference, res: TrainRefResolution, s: BookingSession): ReferenceResolutionRecord {
  const rs = resultSetOf(s);
  const status: ReferenceStatus = res.ok ? (rs && !rs.current ? 'STALE' : 'VALID')
    : res.code === 'STALE_SEARCH_REFERENCE' ? 'STALE' : res.code === 'AMBIGUOUS_REFERENCE' ? 'AMBIGUOUS' : 'INVALID';
  return {
    via: 'SELECTION', referenceType: ref.kind, referenceValue: String((ref as any).value ?? '').slice(0, 24) || null,
    resolutionType: resolutionTypeOf(ref), status,
    resolvedTrainNumber: res.ok ? res.train.trainNumber : null,
    displayIndex: res.ok ? res.displayIndex : null,
    candidates: res.ok ? 1 : (res.candidates || []).length,
    ambiguityReason: !res.ok && res.code === 'AMBIGUOUS_REFERENCE'
      ? (ref.kind === 'DEMONSTRATIVE' && ref.value === 'THIS' ? 'NO_FOCUS_MULTIPLE_RESULTS' : 'MULTIPLE_CANDIDATES') : null,
    tool: null, ...sourceOf(s, res.ok)
  };
}

/** Record for a train number the LLM put into a tool call (its own interpretation of the user's reference). */
export function recordToolArgReference(tool: string, trainNumber: string, s: BookingSession, ok: boolean): ReferenceResolutionRecord {
  const hit = currentResults(s).find(t => t.trainNumber === trainNumber);
  const rs = resultSetOf(s);
  const selected = ((s.selectedTrain as any)?.number || (s.selectedTrain as any)?.trainNumber) === trainNumber;
  const staleChoice = !hit && !selected && s.staleReference?.trainNumber === trainNumber;
  const status: ReferenceStatus = staleChoice || (hit && rs && !rs.current) ? 'STALE' : ok ? 'VALID' : 'INVALID';
  return {
    via: 'TOOL_ARGUMENT', referenceType: 'TRAIN_NUMBER', referenceValue: trainNumber, resolutionType: 'TOOL_ARGUMENT', status,
    resolvedTrainNumber: trainNumber, displayIndex: hit?.displayIndex ?? null, candidates: 1, ambiguityReason: null,
    tool, ...sourceOf(s, !!hit)
  };
}
