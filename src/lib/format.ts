/**
 * Presentation-only helpers. They FORMAT values the backend already returned —
 * they never compute availability, fares, train status or booking state.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-05" → "Mon, 5 Oct 2026". Anything else is shown verbatim. */
export function formatDate(iso?: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return String(iso);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Time of day for an ISO timestamp the backend supplied (e.g. retrievedAt). */
export function formatClock(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** ₹ with Indian digit grouping — only for numbers the backend returned. */
export function inr(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '';
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function genderLabel(g?: string | null): string {
  if (!g) return '';
  const u = String(g).toUpperCase();
  return u === 'MALE' || u === 'M' ? 'Male' : u === 'FEMALE' || u === 'F' ? 'Female' : u === 'OTHER' || u === 'O' ? 'Other' : String(g);
}

export function initials(name?: string | null): string {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** Visual tone for an availability status STRING / enum the backend returned (display only). */
export function availabilityTone(status?: string | null, enumStatus?: string | null): Tone {
  const e = String(enumStatus || '').toUpperCase();
  if (e === 'AVAILABLE') return 'good';
  if (e === 'RAC' || e === 'WAITLIST') return 'warn';
  if (e === 'NOT_AVAILABLE') return 'bad';
  const s = String(status || '').trim();
  if (!s) return 'neutral';
  if (/^(avl|available|curr_?avbl)/i.test(s)) return 'good';
  if (/(wl|waitlist|rac|gnwl|pqwl|rlwl|tqwl)/i.test(s)) return 'warn';
  if (/(regret|not available|no seats|train cancelled|departed)/i.test(s)) return 'bad';
  return 'neutral';
}

/** Human labels for the backend's booking state (no state is decided here). */
const STATE_LABELS: Record<string, string> = {
  IDLE: 'Getting started',
  COLLECTING_JOURNEY: 'Planning your journey',
  COLLECTING_DATE: 'Choosing a date',
  SHOWING_TRAINS: 'Choosing a train',
  CLASS_OPTIONS: 'Choosing a class',
  BOOKING_PREPARE: 'Preparing your booking',
  COLLECTING_PASSENGER_DETAILS: 'Adding passengers',
  AWAITING_CONFIRMATION: 'Review & confirm',
  IRCTC_HANDOFF_READY: 'Details verified · booking not enabled'
};
export function bookingStateLabel(state?: string | null): string {
  if (!state) return '';
  return STATE_LABELS[state] || String(state).toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

/** Contextual progress labels for railway tools that the turn-event stream reports as STARTED. */
const TOOL_LABELS: Record<string, string> = {
  SEARCH_TRAINS: 'Searching trains',
  CHECK_AVAILABILITY: 'Checking availability',
  GET_FARE: 'Checking fare',
  GET_TRAIN_INFO: 'Getting train details',
  GET_TIMETABLE: 'Getting the timetable',
  TRACK_TRAIN: 'Tracking the train',
  CHECK_PNR: 'Checking PNR status',
  GET_CANCELLED_TRAINS: 'Checking cancelled trains',
  WEB_RAILWAY_RESEARCH: 'Looking up railway information'
};
export function toolProgressLabel(activeTools: string[] | null | undefined, fallbackText?: string | null): string | null {
  const tools = (activeTools || []).filter(Boolean);
  if (tools.length > 1) return 'Checking railway data';
  if (tools.length === 1) return TOOL_LABELS[tools[0]] || 'Checking railway data';
  return fallbackText || null;
}

/** Station display: prefer the backend-supplied name when the code matches the session journey. */
export function stationLabel(code?: string | null, ctx?: { origin?: string; originName?: string; destination?: string; destinationName?: string } | null): string {
  if (!code) return '';
  if (ctx?.origin && ctx.origin === code && ctx.originName) return ctx.originName;
  if (ctx?.destination && ctx.destination === code && ctx.destinationName) return ctx.destinationName;
  return String(code);
}
