/**
 * ResponseFormatter — deterministic, fact-only phrasing of authoritative data.
 * TEXT mode may be richer; VOICE mode is concise (no big tables).
 * Every number/time/status here comes from BookingSession / tool results.
 */
import type { BookingSession } from '@shared/entities';
import { currentResults, type ResultTrain } from './train-reference-resolver';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function humanDate(iso?: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MON[m - 1]}`;
}

export function searchSummary(s: BookingSession, mode: 'TEXT' | 'VOICE'): string {
  const ts = currentResults(s);
  const route = `${shortName(s.originName, s.origin)} → ${shortName(s.destinationName, s.destination)}`;
  if (!ts.length) return `${route} ${humanDate(s.date)} ke liye koi train nahi mili.`;
  if (mode === 'VOICE') {
    const top = ts.slice(0, 2).map(t => t.trainNumber).join(' aur ');
    return `${humanDate(s.date)} ko ${ts.length} ${ts.length > 1 ? 'trainein mili hain' : 'train mili hai'}. ${top}${ts.length > 2 ? ' sabse pehle hain' : ''}.`;
  }
  const lines = ts.map(t => `${t.displayIndex}. ${t.trainNumber} ${t.trainName} — ${t.departure} → ${t.arrival} (${t.duration}) · ${(t.classes || []).map(c => c.code).join('/')}`);
  return `${route}, ${humanDate(s.date)}: ${ts.length} ${ts.length > 1 ? 'trains mili hain' : 'train mili hai'}.\n${lines.join('\n')}`;
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
  }
  return '';
}

export const TOOL_LABEL: Record<string, string> = {
  SEARCH_TRAINS: 'Train search', CHECK_AVAILABILITY: 'Availability', GET_FARE: 'Fare',
  GET_TRAIN_INFO: 'Train info', GET_TIMETABLE: 'Timetable'
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
