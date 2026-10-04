/**
 * PROMPT 32 — Honest tool outcomes.
 *
 * Every railway tool execution resolves to exactly ONE of eight outcome categories. They are never collapsed into
 * each other: a timeout is not "no trains", a provider failure is not "no seats", malformed data is not an empty list.
 * The category is given to the LLM verbatim (it decides the wording) and is used by the backend's outcome-claim guard
 * (it only verifies the wording does not contradict the category). Pure classification — no routing, no decisions.
 */
export type ToolOutcome =
  | 'DATA' | 'NO_RESULTS' | 'UNSUPPORTED' | 'TIMEOUT' | 'PROVIDER_FAILURE' | 'MALFORMED_DATA' | 'STALE' | 'REJECTED';

export type DataSourceKind = 'MOCK' | 'LIVE';

const NOT_FOUND = /^(NO_RESULTS|DATA_UNAVAILABLE|NO_TRAINS_FOUND|NOT_FOUND|TRAIN_NOT_FOUND|PNR_NOT_FOUND|EMPTY_RESULT)$/;
const UNSUPPORTED = /^(TOOL_NOT_IMPLEMENTED|UNKNOWN_TOOL|TOOL_UNAVAILABLE)$/;
const MALFORMED = /^(PROVIDER_DATA_INVALID|PROVIDER_DATA_CONFLICT|INVALID_PROVIDER_RESPONSE|MALFORMED_PROVIDER_DATA)$/;
const STALE = /^(STALE_TOOL_RESULT|NOT_EXECUTED|RESULT_IDENTITY_MISMATCH)$/;
const PROVIDER = /^(TOOL_FAILED|PROVIDER_UNAVAILABLE|RATE_LIMITED|AUTH_ERROR|UNKNOWN|PROVIDER_ERROR|LIVE_STATUS_UNAVAILABLE|PNR_STATUS_UNAVAILABLE)$/;

export function toolOutcomeOf(r: { ok?: boolean; success?: boolean; empty?: boolean; status?: string | null; code?: string | null; normalizedCode?: string | null }): ToolOutcome {
  const ok = r.ok ?? r.success;
  if (ok) return r.empty ? 'NO_RESULTS' : 'DATA';
  const codes = [r.normalizedCode, r.code].map(c => String(c || '').toUpperCase()).filter(Boolean);
  const status = String(r.status || '').toUpperCase();
  if (status === 'TIMEOUT' || codes.some(c => /TIMEOUT|TIMED_OUT/.test(c))) return 'TIMEOUT';
  if (codes.some(c => MALFORMED.test(c))) return 'MALFORMED_DATA';
  if (status === 'CANCELLED' || codes.some(c => STALE.test(c))) return 'STALE';
  if (codes.some(c => UNSUPPORTED.test(c))) return 'UNSUPPORTED';
  if (codes.some(c => NOT_FOUND.test(c))) return 'NO_RESULTS';
  if (status === 'REJECTED') return 'REJECTED';
  if (codes.some(c => PROVIDER.test(c))) return 'PROVIDER_FAILURE';
  return status === 'FAILED' && !codes.length ? 'PROVIDER_FAILURE' : 'REJECTED';
}

/** Provider identity from the provider's OWN response meta — never inferred, never silently switched. */
export function dataSourceOf(meta: any): DataSourceKind | null {
  const s = String(meta?.source || '').toLowerCase();
  if (!s) return null;
  return s === 'mock' ? 'MOCK' : 'LIVE';
}

/**
 * Shape validation of a provider SUCCESS payload (validation only — malformed data is never repaired, never replaced
 * with a fallback, and never reported as "empty"). TRACK_TRAIN / CHECK_PNR are validated by their own services (P14).
 */
export function isWellFormedToolData(tool: string, data: any): boolean {
  const obj = data && typeof data === 'object' && !Array.isArray(data);
  switch (tool) {
    case 'SEARCH_TRAINS':
      return !!obj && Array.isArray(data.trains) && data.trains.every((t: any) => t && typeof t === 'object' && String(t.trainNumber ?? '').trim() !== '');
    case 'CHECK_AVAILABILITY':
      return !!obj && typeof data.status === 'string' && data.status.trim() !== '';
    case 'GET_FARE':
      return !!obj && (Number.isFinite(data.perPassenger) || Number.isFinite(data.total));
    case 'GET_TRAIN_INFO':
      return !!obj && String(data.trainNumber ?? '').trim() !== '';
    case 'GET_TIMETABLE':
      return Array.isArray(data) || (!!obj && Array.isArray(data.stops));
    default:
      return true;
  }
}
