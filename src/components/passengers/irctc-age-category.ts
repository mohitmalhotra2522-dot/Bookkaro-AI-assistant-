/**
 * IRCTC passenger category from the age typed in the form — display only (no fare, no backend logic).
 *
 * Source: IRCTC's own passenger page (www.irctc.co.in/nget BookingModule + labels_en.json, fetched Oct 2026):
 *   - infantMsg: "*Children under 5 years of age shall be carried free and no purchase of any ticket is required.
 *     (If no separate berth is opted.)" — infants (age 0–4) WITHOUT a berth go in IRCTC's separate
 *     "+ Add Infant Without Berth" section; "Add Infant With Berth" = a normal passenger row (age 1–4 accepted).
 *   - validateChildBerth(): for a child (age up to bkgCfg.maxChildAge, standard 5–11) IRCTC shows the "Opt Berth"
 *     checkbox, ticked by default (berth opted). BookKaro never ticks / unticks it.
 */
export type IrctcAgeCategory = { kind: 'INFANT' | 'CHILD' | 'ADULT'; label: string; note: string | null };

export const IRCTC_INFANT_MAX_AGE = 4;
export const IRCTC_CHILD_MAX_AGE = 11;

export function irctcAgeCategory(age: number | string | null | undefined): IrctcAgeCategory | null {
  const a = typeof age === 'number' ? age : Number(String(age ?? '').trim());
  if (!Number.isInteger(a) || a < 1 || a > 125 || String(age ?? '').trim() === '') return null;
  if (a <= IRCTC_INFANT_MAX_AGE) {
    return {
      kind: 'INFANT', label: 'Child · 5 saal se kam (IRCTC: Infant)',
      note: 'IRCTC: 5 saal se kam bachche alag berth na lene par free travel karte hain — ticket nahi lagta. Yahan jodne par IRCTC par ' +
        '“Infant With Berth” (berth ke saath, normal passenger) booking hogi. Bina berth ke liye inhe yahan mat jodiye — IRCTC par ' +
        '“+ Add Infant Without Berth” mein aap khud jodiye.'
    };
  }
  if (a <= IRCTC_CHILD_MAX_AGE) {
    return {
      kind: 'CHILD', label: 'Child (5–11)',
      note: 'IRCTC par is bachche ke liye “Opt Berth” option aata hai (default: berth ke saath). Bina berth chahiye toh IRCTC par ' +
        '“Opt Berth” aap khud hataiye — BookKaro use nahi badalta.'
    };
  }
  return { kind: 'ADULT', label: 'Adult', note: null };
}
