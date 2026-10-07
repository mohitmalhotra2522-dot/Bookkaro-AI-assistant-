/**
 * BookingReferenceResolver (Prompt 14) — deterministic resolution of natural booking
 * references against AUTHORITATIVE store records (never against LLM memory):
 *   latest / last / recent / jo abhi ki / abhi wali → newest matching record
 *   aaj / kal / parso wali                          → journey date (or booking day for aaj / kal)
 *   Delhi wali / Amritsar wali                      → journey origin / destination
 *   12014 wali                                      → train number
 *   iska / uska / woh / ye                          → the booking currently in focus (activeBookingId)
 * Multiple matches without a disambiguating word → MULTIPLE_BOOKINGS_MATCHED + a clarification
 * question. It NEVER guesses.
 */
import type { BookingRecord } from '@shared/booking-record';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationToken } from '../../railway/resolvers/route-resolver';
import { humanDate } from '../../ai/context/response-formatter';

export type BookingResolution =
  | { kind: 'RESOLVED'; record: Readonly<BookingRecord>; how: string }
  | { kind: 'NONE' }                                                     // no records in this session
  | { kind: 'NOT_FOUND'; code: 'BOOKING_NOT_FOUND' | 'INVALID_BOOKING_REFERENCE'; message: string }
  | { kind: 'AMBIGUOUS'; code: 'MULTIPLE_BOOKINGS_MATCHED'; candidates: Readonly<BookingRecord>[]; message: string };

const LATEST_RE = /\b(latest|last|recent|sabse nayi|sabse naya|nayi wali|naya wala|aakhri|akhri|pichli|pichhli|abhi wali|abhi wala|jo abhi|abhi ki|abhi ka|abhi book)\b/i;
const PRONOUN_RE = /\b(iska|iski|iske|uska|uski|uske|woh|wo|ye|yeh|is booking|us booking|isi|usi)\b/i;
const STOP = new Set(['booking', 'bookings', 'ticket', 'tickets', 'tikat', 'wali', 'wala', 'wale', 'ka', 'ki', 'ke', 'ko', 'hai', 'kya', 'status', 'pnr',
  'check', 'karo', 'kar', 'do', 'dikhao', 'batao', 'show', 'meri', 'mera', 'mere', 'train', 'abhi', 'kaha', 'kahan', 'latest', 'last', 'details',
  'aaj', 'kal', 'parso', 'today', 'tomorrow', 'yesterday', 'the', 'and', 'ya', 'aur', 'number', 'please', 'plz', 'confirm', 'hua', 'hui', 'gayi',
  'live', 'track', 'chahiye', 'dekhna', 'dekho', 'iska', 'uska', 'woh', 'recent', 'new']);
const COUNT_WORD = ['', 'Ek', 'Do', 'Teen', 'Chaar', 'Paanch', 'Chhe'];

export interface ResolveOptions {
  activeBookingId?: string;
  /** Restrict to these candidates (follow-up answer to a clarification). */
  candidateIds?: string[];
  today?: string; // YYYY-MM-DD (IST) — injected for determinism
}

export class BookingReferenceResolver {
  resolve(records: readonly Readonly<BookingRecord>[], rawText: string, opts: ResolveOptions = {}): BookingResolution {
    const all = opts.candidateIds?.length ? records.filter(r => opts.candidateIds!.includes(r.bookingId)) : [...records];
    if (!all.length) return { kind: 'NONE' };
    const t = ` ${String(rawText || '').toLowerCase().replace(/[,?!।;:.]/g, ' ').replace(/\s+/g, ' ').trim()} `;
    let set = all;
    const used: string[] = [];

    // ---- train number (5 digits, never part of a 10-digit PNR) ----
    const trains = [...t.matchAll(/(?<!\d)(\d{5})(?!\d)/g)].map(m => m[1]);
    if (trains.length) {
      const hit = set.filter(r => trains.includes(r.train.trainNumber));
      if (!hit.length) return { kind: 'NOT_FOUND', code: 'BOOKING_NOT_FOUND', message: `Is session mein ${trains.join('/')} wali koi booking nahi mili.` };
      set = hit; used.push('TRAIN');
    }

    // ---- station words (journey origin / destination) ----
    const stationHits: Array<{ word: string; codes: Set<string> }> = [];
    for (const w of t.trim().split(' ')) {
      if (w.length < 3 || STOP.has(w) || /\d/.test(w)) continue;
      const codes = new Set<string>();
      const rs = resolveStationToken(w);
      if (rs && (rs.code.toLowerCase() === w || rs.name.toLowerCase().split(/\s+/).includes(w))) codes.add(rs.code);
      for (const r of all) {
        for (const [code, name] of [[r.journey.origin, r.journey.originName], [r.journey.destination, r.journey.destinationName]] as const) {
          if (code.toLowerCase() === w || (name || '').toLowerCase().split(/\s+/).includes(w)) codes.add(code);
        }
      }
      if (codes.size) stationHits.push({ word: w, codes });
    }
    let stationLabel = '';
    if (stationHits.length) {
      const hit = set.filter(r => stationHits.every(h => h.codes.has(r.journey.origin) || h.codes.has(r.journey.destination)));
      if (!hit.length) return { kind: 'NOT_FOUND', code: 'BOOKING_NOT_FOUND', message: `Is session mein ${cap(stationHits[0].word)} wali koi booking nahi mili.` };
      set = hit; used.push('STATION');
      stationLabel = cap(stationHits[0].word);
    }

    // ---- date words ----
    const dm = t.match(/\b(aaj|today|kal|tomorrow|parso|parson|yesterday)\b/);
    if (dm) {
      const rd = resolveDate('aaj');
      const today = opts.today || (rd.ok ? rd.date : '');
      const w = dm[1];
      // journey date relative to the SAME reference day (deterministic; injectable for tests)
      const journeyDate = w === 'aaj' || w === 'today' ? today : w === 'kal' || w === 'tomorrow' ? shiftDay(today, 1) : w === 'yesterday' ? null : shiftDay(today, 2);
      const createdDay = w === 'aaj' || w === 'today' ? today : (w === 'kal' || w === 'yesterday') ? shiftDay(today, -1) : null;
      const hit = set.filter(r => (w !== 'yesterday' && r.journeyDate === journeyDate) || (createdDay && istDay(r.bookingCreatedAt) === createdDay));
      if (!hit.length) return { kind: 'NOT_FOUND', code: 'BOOKING_NOT_FOUND', message: `Is session mein ${w} wali koi booking nahi mili.` };
      set = hit; used.push('DATE');
    }

    if (set.length === 1) return { kind: 'RESOLVED', record: set[0], how: used.join('+') || 'ONLY_BOOKING' };

    // newest first (store order)
    if (LATEST_RE.test(t)) return { kind: 'RESOLVED', record: set[0], how: [...used, 'LATEST'].join('+') };
    if (PRONOUN_RE.test(t) && opts.activeBookingId) {
      const a = set.find(r => r.bookingId === opts.activeBookingId);
      if (a) return { kind: 'RESOLVED', record: a, how: [...used, 'ACTIVE'].join('+') };
    }
    // no disambiguating word at all → the booking the conversation is about (context, not a guess)
    if (!used.length && opts.activeBookingId) {
      const a = set.find(r => r.bookingId === opts.activeBookingId);
      if (a) return { kind: 'RESOLVED', record: a, how: 'ACTIVE' };
    }
    return { kind: 'AMBIGUOUS', code: 'MULTIPLE_BOOKINGS_MATCHED', candidates: set.slice(0, 4), message: clarification(set.slice(0, 4), stationLabel) };
  }
}

/** "Do Delhi bookings mil rahi hain. Aap 12014 wali dekhna chahte ho ya 14542 wali?" */
export function clarification(c: readonly Readonly<BookingRecord>[], stationLabel = ''): string {
  const nums = c.map(r => r.train.trainNumber);
  const unique = new Set(nums).size === nums.length;
  const label = (r: Readonly<BookingRecord>) => unique ? r.train.trainNumber : `${r.train.trainNumber} (${humanDate(r.journeyDate)})`;
  const head = `${COUNT_WORD[c.length] || c.length} ${stationLabel ? stationLabel + ' ' : ''}bookings mil rahi hain.`;
  // P42.1: facts only (the matching bookings) — the LLM asks which one, if needed
  return `${head} (${c.map(label).join(' / ')})`;
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

function istDay(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
}
function shiftDay(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms + delta * 86400_000).toISOString().slice(0, 10) : '';
}
