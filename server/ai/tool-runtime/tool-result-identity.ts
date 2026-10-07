/**
 * PROMPT 28 — ToolResult identity binding.
 *
 * Every railway tool result carries an authoritative IDENTITY: which train / date / class / route the result is about,
 * which tool produced it, the provider and when it arrived. The identity is built ONLY from the backend-validated
 * request arguments and the provider's own result fields — never guessed, never taken from LLM text. It lets
 *  - the LLM see, for every result, exactly which entity it belongs to (`toLLMToolEnvelope`), and
 *  - the response guard bind every railway claim to the result it came from (claim-entity-binding).
 *
 * The internal `resultId` (toolExecutionId) never reaches the user. The LLM sees a short per-turn reference
 * (`fare-2`) that the guard also refuses in user-facing text.
 *
 * This is NOT a cache: identities live on this turn's results only.
 */

export type EntityBindingStatus =
  /** provider result fields agree with the validated request (or the request had no entity to compare) */
  | 'BOUND'
  /** the provider returned a DIFFERENT train / class / date than requested — the result is not used */
  | 'MISMATCH'
  /** tool has no railway entity (e.g. PNR status — the PNR itself is never part of an identity) */
  | 'NO_ENTITY';

export interface ToolResultIdentity {
  /** internal provenance id (toolExecutionId) — never user-facing */
  resultId: string;
  toolName: string;
  trainNumber?: string;
  trainName?: string;
  origin?: string;
  destination?: string;
  /** canonical YYYY-MM-DD */
  date?: string;
  /** RESULT = provider field; REQUEST = validated argument; SESSION = the journey date the request was made for */
  dateSource?: 'RESULT' | 'REQUEST' | 'SESSION';
  travelClass?: string;
  passengersCount?: number;
  /** SEARCH_TRAINS only: number of trains returned */
  resultCount?: number;
  provider?: string;
  receivedAt: string;
  status: string;
  binding: EntityBindingStatus;
  /** fields where the provider result disagreed with the validated request (binding = MISMATCH) */
  mismatch?: string[];
}

const s = (v: any): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const isoDate = (v: any): string | undefined => { const x = s(v); return x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined; };
const up = (v: any) => s(v)?.toUpperCase();

/** Tools whose results are about a railway entity (train / route). */
const ENTITY_TOOLS = new Set(['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN']);

export interface IdentityInput {
  toolName: string;
  resultId: string;
  /** backend-VALIDATED arguments (never raw LLM arguments) */
  args?: Record<string, any>;
  /** provider result data (success only) */
  data?: any;
  provider?: string | null;
  receivedAt?: string;
  status?: string;
  /** the session journey date at call time — used for GET_FARE, whose provider result has no date field */
  sessionDate?: string;
}

/**
 * Build the identity of one result. A field is filled only when the provider result or the validated request carries
 * it; the provider value wins (it is what the facts are about). Disagreement between the two → binding MISMATCH.
 */
export function buildToolResultIdentity(i: IdentityInput): ToolResultIdentity {
  const a = i.args || {};
  const d = i.data && typeof i.data === 'object' ? i.data : {};
  const id: ToolResultIdentity = {
    resultId: i.resultId, toolName: i.toolName, receivedAt: i.receivedAt || new Date().toISOString(),
    status: i.status || (i.data !== undefined ? 'SUCCEEDED' : 'FAILED'), binding: ENTITY_TOOLS.has(i.toolName) ? 'BOUND' : 'NO_ENTITY',
    ...(s(i.provider) ? { provider: s(i.provider) } : {})
  };
  if (!ENTITY_TOOLS.has(i.toolName)) return id;
  const mismatch: string[] = [];
  const pick = (field: string, fromData: string | undefined, fromArgs: string | undefined): string | undefined => {
    if (fromData && fromArgs && fromData !== fromArgs) mismatch.push(field);
    return fromData ?? fromArgs;
  };
  if (i.toolName === 'SEARCH_TRAINS') {
    const o = pick('origin', up(d.origin ?? d.journey?.origin), up(a.origin));
    const de = pick('destination', up(d.destination ?? d.journey?.destination), up(a.destination));
    const dt = pick('date', isoDate(d.date ?? d.journey?.date), isoDate(a.date));
    if (o) id.origin = o;
    if (de) id.destination = de;
    if (dt) { id.date = dt; id.dateSource = isoDate(d.date ?? d.journey?.date) ? 'RESULT' : 'REQUEST'; }
    if (Array.isArray(d.trains)) id.resultCount = d.trains.length;
  } else {
    const tn = pick('trainNumber', s(d.trainNumber ?? d.number), s(a.trainNumber));
    if (tn) id.trainNumber = tn;
    const name = s(d.trainName ?? d.name);
    if (name) id.trainName = name;
    if (i.toolName === 'CHECK_AVAILABILITY' || i.toolName === 'GET_FARE') {
      const cls = pick('travelClass', up(d.travelClass), up(a.travelClass));
      if (cls) id.travelClass = cls;
    }
    if (i.toolName === 'GET_FARE') {
      const pc = typeof d.passengersCount === 'number' ? d.passengersCount : typeof a.passengersCount === 'number' ? a.passengersCount : undefined;
      if (pc !== undefined) id.passengersCount = pc;
    }
    if (i.toolName === 'CHECK_AVAILABILITY' || i.toolName === 'GET_FARE' || i.toolName === 'GET_TRAIN_INFO') {
      const fromData = isoDate(d.date ?? d.fareBasis?.date);
      const fromArgs = isoDate(a.date);
      const dt = pick('date', fromData, fromArgs);
      if (dt) { id.date = dt; id.dateSource = fromData ? 'RESULT' : 'REQUEST'; }
      else if (i.toolName === 'GET_FARE' && isoDate(i.sessionDate)) { id.date = isoDate(i.sessionDate); id.dateSource = 'SESSION'; }
    }
    const o = up(d.origin ?? d.fareBasis?.origin); const de = up(d.destination ?? d.fareBasis?.destination);
    if (o) id.origin = o;
    if (de) id.destination = de;
  }
  if (mismatch.length) { id.binding = 'MISMATCH'; id.mismatch = mismatch; }
  return id;
}

/** Short, opaque per-turn reference the LLM may use to talk about a result (`availability-2`). Never user-facing. */
export function resultRef(toolName: string, seq: number): string {
  const base = ({ SEARCH_TRAINS: 'search', GET_TRAIN_INFO: 'info', GET_TIMETABLE: 'timetable', CHECK_AVAILABILITY: 'availability', GET_FARE: 'fare', TRACK_TRAIN: 'track', CHECK_PNR: 'pnr' } as Record<string, string>)[toolName]
    || String(toolName || 'tool').toLowerCase();
  return `${base}-${seq}`;
}
/** A per-turn result reference leaking into user-facing text. */
export const RESULT_REF_RE = /\b(search|info|timetable|availability|fare|track|pnr)-\d{1,3}\b/i;

/** The entity summary the LLM sees with each result (`entity: { trainNumber, date, class }`). */
export function entityOf(id?: ToolResultIdentity | null): Record<string, string | number> | undefined {
  if (!id || id.binding === 'NO_ENTITY') return undefined;
  const e: Record<string, string | number> = {};
  if (id.trainNumber) e.trainNumber = id.trainNumber;
  if (id.trainName) e.trainName = id.trainName;
  if (id.origin) e.origin = id.origin;
  if (id.destination) e.destination = id.destination;
  if (id.date) e.date = id.date;
  if (id.travelClass) e.class = id.travelClass;
  if (id.passengersCount !== undefined) e.passengersCount = id.passengersCount;
  if (id.resultCount !== undefined) e.resultCount = id.resultCount;
  return Object.keys(e).length ? e : undefined;
}

// ------------------------------------------------------------------ structured errors for the LLM

export type ToolErrorType = 'VALIDATION' | 'STATE' | 'PROVIDER' | 'NOT_FOUND' | 'POLICY' | 'UNAVAILABLE' | 'LIMIT' | 'STALE' | 'IDENTITY';

const TRANSIENT = new Set(['TOOL_FAILED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'TOOL_TIMEOUT', 'TIMEOUT', 'PROVIDER_TIMEOUT']);
const ARGUMENT_OF: Record<string, string> = {
  INVALID_TRAIN_REFERENCE: 'trainNumber', INVALID_TRAIN_SELECTION: 'trainNumber', TRAIN_NOT_IN_RESULTS: 'trainNumber',
  INVALID_CLASS_SELECTION: 'travelClass', CLASS_NOT_AVAILABLE: 'travelClass', AMBIGUOUS_DATE: 'date', PAST_DATE: 'date',
  INVALID_STATION: 'origin', AMBIGUOUS_STATION: 'origin', RESULT_IDENTITY_MISMATCH: 'trainNumber'
};

export function errorTypeOf(code: string): ToolErrorType {
  const c = String(code || '');
  if (c === 'RESULT_IDENTITY_MISMATCH') return 'IDENTITY';
  if (TRANSIENT.has(c) || c === 'PROVIDER_DATA_INVALID') return 'PROVIDER';
  if (/^(NO_RESULTS|DATA_UNAVAILABLE|NOT_FOUND|TRAIN_NOT_FOUND|PNR_NOT_FOUND)$/.test(c)) return 'NOT_FOUND';
  if (/^FORBIDDEN|SENSITIVE|^AUTH/.test(c)) return 'POLICY';
  if (/^(TOOL_NOT_IMPLEMENTED|UNKNOWN_TOOL)$/.test(c)) return 'UNAVAILABLE';
  if (/LOOP|LIMIT|REPEATED/.test(c)) return 'LIMIT';
  if (/STALE|NOT_EXECUTED|CANCELLED/.test(c)) return 'STALE';
  if (/FOR_STATE|STATE|NOT_SELECTED|REQUIRED_STATE/.test(c)) return 'STATE';
  return 'VALIDATION';
}

/**
 * `{ errorType, tool, argument, reason, retryable }` — a failure the LLM can act on without guessing.
 * `retryable` is true only for a transient provider failure the backend has NOT already retried (no blind retries:
 * the same validation error always comes back until an argument changes).
 */
export function structuredToolError(tool: string, err: { code?: string; message?: string; details?: any } | undefined, attempts = 1)
  : { errorType: ToolErrorType; tool: string; argument?: string; reason: string; retryable: boolean; code: string; message: string; expected?: string; received?: string; candidates?: string[]; missingField?: string; availableClasses?: string[] } {
  const code = String(err?.code || 'TOOL_FAILED');
  const d = err?.details && typeof err.details === 'object' ? err.details : {};
  const argument = typeof d.argument === 'string' ? d.argument : ARGUMENT_OF[code];
  const out: any = {
    errorType: errorTypeOf(code), tool, ...(argument ? { argument } : {}), reason: code,
    retryable: TRANSIENT.has(code) && attempts < 2, code, message: String(err?.message || '').slice(0, 300)
  };
  if (typeof d.expected === 'string') out.expected = d.expected.slice(0, 120);
  if (typeof d.received === 'string') out.received = d.received.slice(0, 120);
  // Post-P42.10 F3: what the LLM needs to ask naturally (never a guess) — candidate train numbers / the missing slot
  if (Array.isArray(d.candidates) && d.candidates.length) out.candidates = d.candidates.slice(0, 10).map((c: any) => String(c));
  if (typeof d.missingField === 'string') out.missingField = d.missingField;
  if (Array.isArray(d.availableClasses) && d.availableClasses.length) out.availableClasses = d.availableClasses.slice(0, 12).map((c: any) => String(c));
  return out;
}
