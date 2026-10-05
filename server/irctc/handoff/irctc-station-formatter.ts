/**
 * P39 — IRCTCStationFormatter: turns VALIDATED booking values into what the IRCTC forms expect.
 *
 * Pure functions, no guessing: a value that cannot be represented exactly is returned as null and reported as
 * IRCTC_FIELD_NOT_CONFIRMED so the USER chooses it on IRCTC (e.g. gender OTHER, an unknown class code).
 * Stations are matched on IRCTC by their official CODE (suggestions end in "- CODE"); the display name is informational.
 */
import type { IrctcPassengerFill, IrctcStationRef } from '@shared/irctc-handoff';

const CODE_RE = /^[A-Z]{1,5}$/;

export function formatIrctcStation(code: string, name?: string | null): IrctcStationRef | null {
  const c = String(code || '').trim().toUpperCase();
  if (!CODE_RE.test(c)) return null;
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  const display = n && n.toUpperCase() !== c ? `${n.toUpperCase()} - ${c}` : null;
  return { code: c, display, query: c };
}

/** IRCTC journey date box format: DD/MM/YYYY (from a validated YYYY-MM-DD). */
export function formatIrctcDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** IRCTC class drop-down labels (the extension matches the option containing "(CODE)"). */
export const IRCTC_CLASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  EA: 'Anubhuti Class (EA)', '1A': 'AC First Class (1A)', EV: 'Vistadome AC (EV)', EC: 'Exec. Chair Car (EC)',
  '2A': 'AC 2 Tier (2A)', FC: 'First Class (FC)', '3A': 'AC 3 Tier (3A)', '3E': 'AC 3 Economy (3E)',
  VC: 'Vistadome Chair Car (VC)', CC: 'AC Chair car (CC)', SL: 'Sleeper (SL)', VS: 'Vistadome Non AC (VS)', '2S': 'Second Sitting (2S)'
});

export function formatIrctcClass(code: string): { code: string; label: string | null } {
  const c = String(code || '').trim().toUpperCase();
  return { code: c, label: IRCTC_CLASS_LABELS[c] ?? null };
}

const GENDER: Record<string, IrctcPassengerFill['gender']> = { MALE: 'Male', FEMALE: 'Female' };
const BERTH: Record<string, string> = {
  LOWER: 'Lower', MIDDLE: 'Middle', UPPER: 'Upper', SIDE_LOWER: 'Side Lower', SIDE_UPPER: 'Side Upper', SIDE_MIDDLE: 'Side Middle',
  WINDOW: 'Window Side', CABIN: 'Cabin', COUPE: 'Coupe', NO_PREFERENCE: 'No Preference'
};
const FOOD: Record<string, string> = { VEG: 'Veg', NON_VEG: 'Non Veg', NO_FOOD: 'No Food' };

export interface PassengerFormatResult { fill: IrctcPassengerFill; notConfirmed: Array<{ field: 'passengerGender' | 'passengerBerth' | 'passengerFood' | 'passengerName' | 'passengerAge'; reason: string }> }

/** IRCTC name box: letters / spaces / dots, 3..16 chars on IRCTC. Longer names are NOT truncated silently. */
export function formatIrctcPassenger(p: { name: string; age: number; gender: string; berthPreference?: string; foodPreference?: string }, index: number): PassengerFormatResult {
  const notConfirmed: PassengerFormatResult['notConfirmed'] = [];
  const name = String(p.name || '').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z][A-Za-z .]*$/.test(name)) notConfirmed.push({ field: 'passengerName', reason: 'NAME_NOT_LATIN_LETTERS' });
  else if (name.length < 3 || name.length > 16) notConfirmed.push({ field: 'passengerName', reason: 'NAME_LENGTH_IRCTC_3_16' });
  const age = Number(p.age);
  if (!Number.isInteger(age) || age < 1 || age > 125) notConfirmed.push({ field: 'passengerAge', reason: 'AGE_INVALID' });
  const gender = GENDER[String(p.gender || '').toUpperCase()] ?? null;
  if (!gender) notConfirmed.push({ field: 'passengerGender', reason: 'GENDER_NOT_REPRESENTABLE' });
  const bp = p.berthPreference ? String(p.berthPreference).toUpperCase() : '';
  const berth = bp ? (BERTH[bp] ?? null) : null;
  if (bp && !berth) notConfirmed.push({ field: 'passengerBerth', reason: 'BERTH_UNKNOWN' });
  const fp = p.foodPreference ? String(p.foodPreference).toUpperCase() : '';
  const food = fp ? (FOOD[fp] ?? null) : null;
  if (fp && !food) notConfirmed.push({ field: 'passengerFood', reason: 'FOOD_UNKNOWN' });
  return { fill: { index, name, age, gender, berth, food }, notConfirmed };
}
