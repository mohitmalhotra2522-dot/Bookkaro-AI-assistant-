/**
 * Shared constants for booking flow.
 */

export const MOCK_DATA_LABEL = 'MOCK / DEVELOPMENT DATA';
export const MOCK_DATA_DISCLAIMER =
  'यह डेवलपमेंट मॉक डेटा है, लाइव रेलवे डेटा नहीं। This is development mock data, not live railway information.';

export const STATION_ALIASES: Record<string, { code: string; name: string }> = {
  amritsar: { code: 'ASR', name: 'Amritsar Junction' },
  asr: { code: 'ASR', name: 'Amritsar Junction' },
  ludhiana: { code: 'LDH', name: 'Ludhiana Junction' },
  ldh: { code: 'LDH', name: 'Ludhiana Junction' },
  delhi: { code: 'NDLS', name: 'New Delhi' },
  'new delhi': { code: 'NDLS', name: 'New Delhi' },
  ndls: { code: 'NDLS', name: 'New Delhi' },
  chandigarh: { code: 'CDG', name: 'Chandigarh' },
  cdg: { code: 'CDG', name: 'Chandigarh' },
  jalandhar: { code: 'JUC', name: 'Jalandhar City' },
  juc: { code: 'JUC', name: 'Jalandhar City' },
  // Prompt 16: two real stations share the name "Ambala" — the bare name is AMBIGUOUS (never guessed)
  'ambala cantt': { code: 'UMB', name: 'Ambala Cantt Junction' },
  'ambala city': { code: 'UBC', name: 'Ambala City' }
};

/**
 * Prompt 16 — station names that map to MORE THAN ONE station. The backend asks the user
 * (AMBIGUOUS_STATION) instead of picking one; the LLM never chooses a station code.
 */
export const AMBIGUOUS_STATION_NAMES: Readonly<Record<string, ReadonlyArray<{ code: string; name: string }>>> = Object.freeze({
  ambala: [{ code: 'UMB', name: 'Ambala Cantt Junction' }, { code: 'UBC', name: 'Ambala City' }]
});

export const SUPPORTED_TRAVEL_CLASSES = {
  '1A': 'AC First Class',
  '2A': 'AC 2 Tier',
  '3A': 'AC 3 Tier',
  CC: 'AC Chair Car',
  FC: 'First Class',
  SL: 'Sleeper',
  '2S': 'Second Sitting'
};

export const HINDI_WORD_MAP: Record<string, string | number> = {
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  paanch: 5,
  chhe: 6,
  kal: 'tomorrow',
  aaj: 'today',
  '1 october': '2026-10-01',
  '2 october': '2026-10-02',
  '3 october': '2026-10-03'
};

/**
 * Freshness policy for railway facts used in booking preparation (Prompt 9).
 * Conversation memory is NOT a railway-data cache: before REVIEW (and again at
 * confirmation) availability/fare older than these limits — or retrieved for a
 * different train/class/date/route/passenger count — are treated as STALE and
 * re-fetched from the provider.
 */
export const FRESHNESS_POLICY = {
  AVAILABILITY_MAX_AGE_MS: 2 * 60_000,
  FARE_MAX_AGE_MS: 10 * 60_000
} as const;

/**
 * Booking preparation contract. Prompt 33 (§14 / §34) supersedes the Prompt 8 default: a review is VALID only with
 * current, matching availability AND fare (a fresh fetch is always attempted first). A timeout / provider failure /
 * malformed / unsupported / empty result leaves NO valid review (→ REQUIRED_TOOL_DATA_MISSING with the real reason);
 * an unverified fare / availability is never presented for confirmation. The flags stay configurable for unit tests.
 */
export const DEFAULT_PREPARATION_POLICY = {
  requireAvailability: true,
  requireFare: true
};

/** Passenger schema used for collection — ONLY fields of the existing Passenger contract. */
export const PASSENGER_REQUIRED_FIELDS = ['name', 'age', 'gender'] as const;
export const PASSENGER_OPTIONAL_FIELDS = ['berthPreference'] as const;
export const MAX_PASSENGERS = 6;

/**
 * P38 — berth choices per class (standard Indian Railways coach layout, as offered on the IRCTC passenger form).
 * Source of truth = IRCTC's own web app (www.irctc.co.in/nget, BookingModule chunk + berthName pipe + labels_en.json,
 * fetched Oct 2026): the passenger "berth" <select> is `No Preference` + bkgCfg.applicableBerthTypes — a list IRCTC's
 * server sends per train/class/date at booking time (after login; never called by BookKaro). IRCTC codes → labels:
 * LB Lower · MB Middle · UB Upper · SL Side Lower · SU Side Upper · SM Side Middle · WS Window Side · CB Cabin · CP Coupe.
 * This table = which of those codes physically exist per class (EC: seen on the real IRCTC page for 12014 EC):
 *   SL / 3A: LB MB UB SL SU · 3E: + SM · 2A: LB UB SL SU · 1A: LB UB CB CP · FC: LB UB · CC / 2S / EC: WS.
 * EA / EV / VS / unknown: none (not verified — nothing invented). At handoff the extension only selects an option the
 * real IRCTC dropdown contains; if IRCTC does not offer it for that train the field is reported, never substituted.
 */
export const BERTH_OPTIONS_BY_CLASS: Readonly<Record<string, readonly BerthPreferenceCode[]>> = Object.freeze({
  SL: ['NO_PREFERENCE', 'LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER'],
  '3A': ['NO_PREFERENCE', 'LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER'],
  '3E': ['NO_PREFERENCE', 'LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_MIDDLE', 'SIDE_UPPER'],
  '2A': ['NO_PREFERENCE', 'LOWER', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER'],
  '1A': ['NO_PREFERENCE', 'LOWER', 'UPPER', 'CABIN', 'COUPE'],
  FC: ['NO_PREFERENCE', 'LOWER', 'UPPER'],
  CC: ['NO_PREFERENCE', 'WINDOW'],
  '2S': ['NO_PREFERENCE', 'WINDOW'],
  EC: ['NO_PREFERENCE', 'WINDOW']
});
type BerthPreferenceCode = 'LOWER' | 'MIDDLE' | 'UPPER' | 'SIDE_LOWER' | 'SIDE_UPPER' | 'SIDE_MIDDLE' | 'WINDOW' | 'CABIN' | 'COUPE' | 'NO_PREFERENCE';
/** Classes whose only IRCTC choice is a seat preference (Window Side), not a berth. */
export function isSeatPreferenceClass(cls: string | null | undefined): boolean {
  const o = berthOptionsForClass(cls);
  return o.length > 0 && o.every(x => x === 'NO_PREFERENCE' || x === 'WINDOW');
}
export function berthOptionsForClass(cls: string | null | undefined): readonly BerthPreferenceCode[] {
  return BERTH_OPTIONS_BY_CLASS[String(cls || '').toUpperCase()] || [];
}
/** P38 — meal choice, offered ONLY when the provider says catering is included for the selected train. */
export const FOOD_PREFERENCES = ['VEG', 'NON_VEG', 'NO_FOOD'] as const;
