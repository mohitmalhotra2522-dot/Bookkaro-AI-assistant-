/**
 * PendingInteraction — deterministic derivation of what the assistant is
 * currently waiting for, plus contextual (never generic) clarification text.
 *
 * The backend uses this to interpret short replies ("kal", "haan", "2",
 * "doosri"). It is derived from BookingSession only — never from LLM memory.
 */
import { BookingState } from '@shared/states';
import type { BookingSession, PendingInteraction } from '@shared/entities';
import { currentResults, listTrains } from './train-reference-resolver';
import { trainClassCodes } from './class-reference-resolver';
import { getNextRequiredField } from '../../booking/booking-readiness';
import { ordinalLabel } from '../../booking/passenger-collection';

export function derivePendingInteraction(s: BookingSession): PendingInteraction {
  switch (s.bookingState) {
    case BookingState.IRCTC_HANDOFF_READY:
    case BookingState.COMPLETE:
    case BookingState.BOOKING_EXECUTION_REQUESTED:   // provider-owned states: nothing to ask
    case BookingState.BOOKING_IN_PROGRESS:
    case BookingState.BOOKING_CONFIRMED:
    case BookingState.BOOKING_FAILED:
      return { type: 'NONE' };
    case BookingState.AWAITING_CONFIRMATION:
      return { type: 'CONFIRMATION_REQUIRED', data: { reviewVersion: s.review?.reviewVersion } };
    case BookingState.REVIEW:
      return { type: 'REVIEW_APPROVAL_REQUIRED', data: { reviewVersion: s.review?.reviewVersion } };
    case BookingState.PASSENGERS_READY:
      return { type: 'CLARIFICATION_REQUIRED', hint: 'Dobara check karun? Haan boliye.', data: { kind: 'RETRY_PREPARATION' } };
    case BookingState.COLLECTING_PASSENGER_DETAILS: {
      const nf: any = getNextRequiredField(s);
      if (nf && ['name', 'age', 'gender'].includes(nf.field)) {
        return { type: 'PASSENGER_DETAILS_REQUIRED', data: { index: nf.passengerIndex, passengerId: nf.passengerId, field: nf.field } };
      }
      return { type: 'NONE' };
    }
    case BookingState.TRAIN_SELECTED:
    case BookingState.CLASS_OPTIONS:
      return { type: 'CLASS_SELECTION_REQUIRED' };
    case BookingState.CLASS_SELECTED:
    case BookingState.BOOKING_PREPARE:
      return s.passengersCount ? { type: 'NONE' } : { type: 'PASSENGERS_REQUIRED' };
    case BookingState.SHOWING_TRAINS:
      return { type: 'TRAIN_SELECTION_REQUIRED' };
  }
  if (!s.origin && !s.destination) return { type: 'ORIGIN_REQUIRED', data: { route: true } };
  if (!s.origin) return { type: 'ORIGIN_REQUIRED' };
  if (!s.destination) return { type: 'DESTINATION_REQUIRED' };
  if (!s.date) return { type: 'DATE_REQUIRED' };
  return { type: 'NONE' };
}

const stationLabel = (code?: string, name?: string) => {
  const n = (name || code || '').replace(/ Junction$/, '').replace(/ City$/, '');
  return n || '';
};

/** Contextual question for a pending interaction (one question, voice-friendly). */
export function questionFor(p: PendingInteraction | undefined, s: BookingSession, mode: 'TEXT' | 'VOICE' = 'TEXT'): string {
  if (!p) return '';
  switch (p.type) {
    case 'ORIGIN_REQUIRED': return p.data?.route ? 'Kahan se kahan jaana hai?' : p.data?.correction ? 'Ab kahan se chalna hai?' : 'Kahan se chalna hai?';
    case 'DESTINATION_REQUIRED': return p.data?.correction ? 'Naya destination kya hai?' : `${stationLabel(s.origin, s.originName)} se kahan jaana hai?`;
    case 'DATE_REQUIRED': return p.data?.correction ? 'Nayi date kya rakhni hai?' : 'Kis date ko jaana hai?';
    case 'PASSENGERS_REQUIRED': return 'Kitne passengers hain?';
    case 'TRAIN_SELECTION_REQUIRED': {
      const ts = currentResults(s);
      if (!ts.length) return 'Kaunsi train chahiye?';
      const shown = mode === 'VOICE' ? ts.slice(0, 3) : ts;
      return `${listTrains(shown)}${mode === 'VOICE' && ts.length > 3 ? ' ya koi aur' : ''} — kaunsi train select karni hai?`;
    }
    case 'CLASS_SELECTION_REQUIRED': {
      const t: any = s.selectedTrain;
      const codes = trainClassCodes(t);
      const join = codes.length <= 1 ? codes.join('') : `${codes.slice(0, -1).join(', ')} aur ${codes[codes.length - 1]}`;
      return `${t?.number || t?.trainNumber || 'Is train'} mein ${join} available hain. Kaunsi class chahiye?`;
    }
    case 'PASSENGER_DETAILS_REQUIRED': {
      const i = (p.data?.index ?? s.currentPassengerIndex ?? 0) as number;
      const pax = (p.data?.passengerId && s.passengers?.find(x => x.id === p.data!.passengerId)) || s.passengers?.[i] || ({} as any);
      const field = p.data?.field || 'name';
      const who = pax.name || `Passenger ${i + 1}`;
      if (p.data?.correction) {
        if (field === 'name') return `${who} ka naya naam kya hai?`;
        if (field === 'age') return `${who} ki sahi umar kya hai?`;
        return `${who} ka gender — male, female ya other?`;
      }
      if (field === 'name') {
        const nobodyStarted = !(s.passengers || []).some(x => x.name || x.age || x.gender);
        if (i === 0 && nobodyStarted) {
          // Prompt 19 (Part 36): "2 passengers ke details chahiye" — one question at a time (voice stays short)
          const n = s.passengersCount || 0;
          if (mode === 'VOICE') return 'Pehle passenger ka naam?';
          return n > 1 ? `${n} passengers ke details chahiye. Pehle passenger ka naam bataiye.` : 'Passenger details ke liye pehle passenger ka naam bataiye.';
        }
        return `${ordinalLabel(i)} ka naam bataiye.`;
      }
      if (field === 'age') return mode === 'VOICE' ? `${who} ki umar?` : `${who} ki umar kitni hai?`;
      return `${who} ka gender — male, female ya other?`;
    }
    case 'REVIEW_APPROVAL_REQUIRED': return 'Sab details sahi hain? Haan bolein to final confirmation lunga.';
    case 'CONFIRMATION_REQUIRED': return 'Confirm karna hai? Haan ya nahi boliye.';
    case 'CLARIFICATION_REQUIRED': {
      if (p.data?.kind === 'STATION_ROLE') {
        const n = stationLabel(p.data.code, p.data.name);
        return `${n} ko origin rakhna hai ya destination?`;
      }
      if (p.data?.kind === 'STATION_CHOICE') {
        const c = (p.data.candidates || []).map((x: any) => String(x.name || x.code).replace(/ Junction$/, ''));
        return c.length > 1 ? `${c.slice(0, -1).join(', ')} ya ${c[c.length - 1]} — kaunsa station?` : 'Kaunsa station?';
      }
      return p.hint || 'Thoda spasht batayein?';
    }
    default: return '';
  }
}

/** Short reply classification (pure language — meaning comes from context). */
const AFFIRM_STRONG = new Set(['haan', 'haa', 'han', 'ha', 'ji', 'yes', 'yeah', 'yep', 'ok', 'okay', 'theek', 'thik', 'sahi', 'confirm', 'book', 'bilkul', 'sure', 'continue', 'done', 'chalo', 'हाँ', 'हां', 'जी', 'ठीक']);
const AFFIRM_WEAK = new Set(['hai', 'kar', 'do', 'karo', 'it', 'please', 'plz', 'hmm', 'aage', 'badhao', 'sab', 'kardo', 'karna', 'karein', 'booking', 'details', 'hain', 'है', 'कर', 'दो']);

export function isPureAffirmation(text: string): boolean {
  const t = text.toLowerCase().replace(/[.,!?।]/g, ' ').trim();
  if (/^(kar do|kardo|karo|कर दो)$/.test(t)) return true;
  const toks = t.split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 5) return false;
  return toks.every(w => AFFIRM_STRONG.has(w) || AFFIRM_WEAK.has(w)) && toks.some(w => AFFIRM_STRONG.has(w));
}

export function isPureNegation(text: string): boolean {
  const t = text.toLowerCase().replace(/[.,!?।]/g, ' ').trim();
  return /^(nahi|nahin|nai|no|nope|mat karo|ruko|ruk jao|wait|cancel|abhi nahi|na|नहीं|रुको)( ji| abhi| please| karo)?$/.test(t);
}
