/**
 * ResponseFormatter — deterministic, fact-only phrasing of authoritative data.
 * TEXT mode may be richer; VOICE mode is concise (no big tables).
 * Every number/time/status here comes from BookingSession / tool results.
 */
import type { BookingSession } from '@shared/entities';
import { currentResults, type ResultTrain } from './train-reference-resolver';
import { userSafeToolError } from '../tool-runtime/tool-error-normalizer';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function humanDate(iso?: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MON[m - 1]}`;
}

export function searchSummary(s: BookingSession, mode: 'TEXT' | 'VOICE'): string {
  const ts = currentResults(s);
  const route = `${shortName(s.originName, s.origin)} → ${shortName(s.destinationName, s.destination)}`;
  // P38: results from a web connector (eRail) are labelled in the text/voice too — never presented as railway data
  const web = s.providerSource === 'erail' ? ' (eRail website — unverified web data; fare / seat availability nahi)' : '';
  if (!ts.length) return `${route} ${humanDate(s.date)} ke liye koi train nahi mili${web}.`;
  if (mode === 'VOICE') {
    const top = ts.slice(0, 2).map(t => t.trainNumber).join(' aur ');
    return `${humanDate(s.date)} ko ${ts.length} ${ts.length > 1 ? 'trainein mili hain' : 'train mili hai'}${web ? ' — eRail website se, unverified' : ''}. ${top}${ts.length > 2 ? ' sabse pehle hain' : ''}.`;
  }
  const lines = ts.map(t => `${t.displayIndex}. ${t.trainNumber} ${t.trainName} — ${t.departure} → ${t.arrival} (${t.duration}) · ${(t.classes || []).map(c => c.code).join('/')}`);
  return `${route}, ${humanDate(s.date)}: ${ts.length} ${ts.length > 1 ? 'trains mili hain' : 'train mili hai'}${web}.\n${lines.join('\n')}`;
}

export function shortName(name?: string, code?: string) {
  return (name || code || '').replace(/ Junction$/, '').replace(/ City$/, '');
}

/** Phrase one successful tool result strictly from its data. */
export function factFromTool(toolName: string, data: any, mode: 'TEXT' | 'VOICE'): string {
  if (!data) return '';
  switch (toolName) {
    case 'CHECK_AVAILABILITY':
      return `${data.trainNumber} ${data.travelClass} ki current availability ${data.status} hai.`;
    case 'GET_FARE':
      return `${data.trainNumber} ${data.travelClass} ka fare ₹${data.perPassenger} per passenger hai — ${data.passengersCount} passenger${data.passengersCount > 1 ? 's' : ''} ke liye total ₹${data.total}.`;
    case 'GET_TRAIN_INFO':
      return `${data.trainNumber} ${data.trainName}: ${data.origin} ${data.departure} se ${data.destination} ${data.arrival} (${data.duration}). Classes: ${(data.classes || []).map((c: any) => c.code).join(', ')}.`;
    case 'GET_TIMETABLE': {
      const stops: any[] = Array.isArray(data) ? data : [];
      if (!stops.length) return 'Is train ka timetable abhi available nahi hai.';
      if (mode === 'VOICE') return `Timetable mein ${stops.length} stops hain — ${stops[0].station} se ${stops[stops.length - 1].station} tak.`;
      return `Timetable: ${stops.map(x => `${x.station} ${x.departure || x.arrival}`).join(' → ')}.`;
    }
    // ---- Prompt 14: fresh read-only lookups (masked PNR; mock data always labelled non-live) ----
    case 'CHECK_PNR': {
      const src = data.dataSource === 'MOCK' ? 'mock / non-live development data' : 'railway provider, abhi fetch kiya';
      const head = `PNR ${data.pnrMasked} ka current status (${src}): ${data.pnrStatus}${data.chartStatus ? `, chart: ${data.chartStatus}` : ''}.`;
      const pax: any[] = Array.isArray(data.passengers) ? data.passengers : [];
      if (!pax.length) return head;
      const rows = (mode === 'VOICE' ? pax.slice(0, 2) : pax).map(p => `Passenger ${p.number}: ${p.currentStatus}${mode === 'TEXT' ? ` (booking ke waqt ${p.bookingStatus})` : ''}`);
      return `${head} ${rows.join(', ')}.`;
    }
    case 'TRACK_TRAIN': {
      // P38: a web connector result (RailYatri) is crowd-sourced website data — never "railway provider"
      const src = data.dataSource === 'MOCK' ? 'mock / non-live development data'
        : data.sourceNote ? `${data.providerId === 'confirmtkt' ? 'ConfirmTkt website — unverified' : 'RailYatri website, crowd-sourced — unverified'}${data.lastUpdated ? `, as of ${String(data.lastUpdated).slice(11, 16)}` : ''}`
        : 'railway provider, abhi fetch kiya';
      const where = data.currentStationName || data.currentStationCode;
      return `${data.trainNumber}${data.trainName && mode === 'TEXT' ? ' ' + data.trainName : ''} live status (${src}): ${data.currentStatus}${where ? ` — last reported: ${where}` : ''}${typeof data.delayMinutes === 'number' ? `, ${data.delayMinutes} min late` : ''}.`;
    }
  }
  return '';
}

export const LIVE_TOOLS: ReadonlySet<string> = new Set(['CHECK_PNR', 'TRACK_TRAIN']);

/**
 * Prompt 14: deterministic message for a turn that ran CHECK_PNR / TRACK_TRAIN — successful
 * results phrased strictly from provider data; rejected / failed calls use the validated error
 * message (INVALID_PNR, PNR_NOT_AVAILABLE, PNR_STATUS_UNAVAILABLE …). Never LLM wording.
 */
export function liveToolMessage(steps: Array<{ status: string; result: { toolName: string; data?: any; error?: { code: string; message: string; details?: any } } }>, mode: 'TEXT' | 'VOICE'): string {
  const out: string[] = [];
  for (const st of steps) {
    if (st.status === 'ok') { const f = factFromTool(st.result.toolName, st.result.data, mode); if (f) out.push(f); }
    else {
      // Bug-fix pass (Bug 1): validation / runtime-guard text is LLM-directed — the user gets the fact-only clarification
      const m = userSafeToolError(st.result.error);
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out.join(' ');
}

export const TOOL_LABEL: Record<string, string> = {
  SEARCH_TRAINS: 'Train search', CHECK_AVAILABILITY: 'Availability', GET_FARE: 'Fare',
  GET_TRAIN_INFO: 'Train info', GET_TIMETABLE: 'Timetable', CHECK_PNR: 'PNR status', TRACK_TRAIN: 'Live train status'
};

// ---------- deterministic comparisons over authoritative results ----------

export function minutesOf(hhmm?: string): number | null {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
export function durationMinutes(d?: string): number | null {
  const m = String(d || '').match(/(\d+)\s*h\s*(\d+)\s*m/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
/** Absolute arrival (minutes from journey-day midnight) = departure + duration. */
export function absoluteArrival(t: ResultTrain): number | null {
  const dep = minutesOf(t.departure), dur = durationMinutes(t.duration);
  return dep === null || dur === null ? null : dep + dur;
}

export function compareArrival(a?: ResultTrain, b?: ResultTrain, missing: string[] = []): string {
  if (!a || !b) return `${missing.join(' aur ')} current results mein nahi hai, isliye comparison abhi verify nahi ho sakta.`;
  const aa = absoluteArrival(a), bb = absoluteArrival(b);
  if (aa === null || bb === null) return 'Ek train ka arrival time available nahi hai, isliye comparison abhi verify nahi ho sakta.';
  if (aa === bb) return `${a.trainNumber} aur ${b.trainNumber} dono ek hi time (${a.arrival}) par pahunchti hain.`;
  const [first, second] = aa < bb ? [a, b] : [b, a];
  const nextDay = (t: ResultTrain) => (absoluteArrival(t)! >= 1440 ? ' (agle din)' : '');
  return `${first.trainNumber} ${first.arrival}${nextDay(first)} par pahunchti hai aur ${second.trainNumber} ${second.arrival}${nextDay(second)} par — ${first.trainNumber} pehle pahunchti hai.`;
}
