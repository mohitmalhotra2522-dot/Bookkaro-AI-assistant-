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
 * Booking preparation contract. The existing review contract (Prompt 8) allows
 * fare/availability to be shown as "abhi verify nahi hua/hui hai", so by
 * default they are NOT hard requirements — but a fresh fetch is ALWAYS attempted
 * before review. Deployments may make them mandatory (→ REQUIRED_TOOL_DATA_MISSING).
 */
export const DEFAULT_PREPARATION_POLICY = {
  requireAvailability: false,
  requireFare: false
};

/** Passenger schema used for collection — ONLY fields of the existing Passenger contract. */
export const PASSENGER_REQUIRED_FIELDS = ['name', 'age', 'gender'] as const;
export const PASSENGER_OPTIONAL_FIELDS = ['berthPreference'] as const;
export const MAX_PASSENGERS = 6;
