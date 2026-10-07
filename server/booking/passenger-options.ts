/**
 * P39.2 — what the CHAT may ask / accept per passenger beyond name, age and gender (same rules as the P38 form).
 *
 *   - berth: only the choices of the SELECTED class (standard IR coach layout, `berthOptionsForClass`); seat classes
 *     (CC / EC / 2S …) and unknown classes have no berth choice → never asked, never stored;
 *   - meal: only when the provider's train data for the SELECTED train says catering is included. The status comes from
 *     a real provider result already in this session — a GET_TRAIN_INFO the LLM chose to call (`lastTrainInfo`) or the
 *     passenger form's own fresh facilities fetch (`trainFacilities`). No result for this train → NOT_CHECKED (the LLM
 *     may call GET_TRAIN_INFO); a result without a catering flag → UNKNOWN. Never inferred, never invented.
 * Pure functions over the BookingSession — values are never logged.
 */
import type { BookingSession, Passenger } from '@shared/entities';
import { berthOptionsForClass, isSeatPreferenceClass, FOOD_PREFERENCES } from '@shared/constants';
import { isLatinName } from './passenger-validator';

export type FoodOptionStatus = 'OFFERED' | 'NOT_INCLUDED' | 'UNKNOWN' | 'NOT_CHECKED';

const SEAT_CLASSES = new Set(['CC', 'EC', '2S', 'EA', 'EV', 'VS']);

export function selectedTrainNumber(s: BookingSession): string {
  const t: any = s.selectedTrain;
  return t ? String(t.number || t.trainNumber || '') : '';
}

/** Catering status for the SELECTED train from a provider result already in the session (no fetch, no guess). */
export function foodStatusOf(s: BookingSession): { status: FoodOptionStatus; pantry: boolean | null } {
  const num = selectedTrainNumber(s);
  if (!num) return { status: 'NOT_CHECKED', pantry: null };
  const fromInfo: any = (s as any).lastTrainInfo;
  const fromForm: any = (s as any).trainFacilities;
  const src = fromInfo && String(fromInfo.trainNumber || fromInfo.number || '') === num ? fromInfo.facilities || {}
    : fromForm && String(fromForm.trainNumber || '') === num ? fromForm : null;
  if (!src) return { status: 'NOT_CHECKED', pantry: null };
  const pantry = typeof src.pantry === 'boolean' ? src.pantry : null;
  if (src.catering === true) return { status: 'OFFERED', pantry };
  if (src.catering === false) return { status: 'NOT_INCLUDED', pantry };
  return { status: 'UNKNOWN', pantry };
}

/** The options view the LLM sees in context.bookingPreparation (train + class selected only). */
export function passengerOptionsView(s: BookingSession) {
  const cls = String(s.selectedClass || '');
  if (!selectedTrainNumber(s) || !cls) return undefined;
  const berth = berthOptionsForClass(cls);
  const food = foodStatusOf(s);
  return {
    berth: berth.length
      ? { options: [...berth], labels: berth.map(berthLabel), ask: true, ...(isSeatPreferenceClass(cls) ? { note: `${cls}: no berth — IRCTC seat preference only (WINDOW = Window Side)` } : {}) }
      : { options: [] as string[], ask: false, note: SEAT_CLASSES.has(cls.toUpperCase()) ? `${cls}: seat is allotted by the railway — no verified seat preference` : `${cls}: no verified berth choices` },
    food: food.status === 'OFFERED'
      ? { status: food.status, options: [...FOOD_PREFERENCES], labels: FOOD_PREFERENCES.map(foodLabel), ask: true }
      : { status: food.status, options: [] as string[], ask: false,
          ...(food.status === 'NOT_CHECKED' ? { howToCheck: 'GET_TRAIN_INFO for the selected train (facilities.catering)' } : {}),
          ...(food.pantry === true ? { pantryCar: true } : {}) }
  };
}

/**
 * P42.1 hardening — optional details (berth / meal) are asked ONCE. The key binds the question to the selected train +
 * class + stable passenger id, so a new train / class asks again. Session-scoped; holds no values.
 */
type OptionalField = 'berthPreference' | 'foodPreference';
export function optionalAskKey(s: BookingSession, passengerId: string | undefined, field: OptionalField): string {
  return `${selectedTrainNumber(s)}|${String(s.selectedClass || '')}|${passengerId || ''}|${field}`;
}
export function optionalAlreadyAsked(s: BookingSession, p: Partial<Passenger> | undefined, field: OptionalField): boolean {
  const asked: unknown = (s as any).optionalAsked;
  return !!p?.id && Array.isArray(asked) && asked.includes(optionalAskKey(s, p.id, field));
}
/** Record that the reply asked this optional detail (called once per turn by the orchestrator; values never stored). */
export function markOptionalAsked(s: BookingSession, d: { passenger: number; field: string } | null | undefined): void {
  if (!d || (d.field !== 'berthPreference' && d.field !== 'foodPreference')) return;
  const p = (s.passengers || [])[d.passenger - 1];
  if (!p?.id) return;
  const key = optionalAskKey(s, p.id, d.field);
  const asked: string[] = Array.isArray((s as any).optionalAsked) ? (s as any).optionalAsked : [];
  if (!asked.includes(key)) (s as any).optionalAsked = [...asked, key].slice(-24);
}

/** Optional details still unanswered for ONE passenger that this train + class offer (asked or not). */
export function optionalUnanswered(s: BookingSession, p: Partial<Passenger> | undefined): OptionalField[] {
  const o = passengerOptionsView(s);
  if (!o) return [];
  const out: OptionalField[] = [];
  if (o.berth.ask && !p?.berthPreference) out.push('berthPreference');
  if (o.food.ask && !p?.foodPreference) out.push('foodPreference');
  return out;
}

/** Optional details still worth asking for ONE passenger (never the required ones — those are in `missing`).
 *  P42.1 hardening: a detail already asked once (and not answered) is not asked again. */
export function optionalToAsk(s: BookingSession, p: Partial<Passenger> | undefined): OptionalField[] {
  return optionalUnanswered(s, p).filter(f => !optionalAlreadyAsked(s, p, f));
}

/**
 * v0.39.6 — the next single passenger detail still open, in the order the user asked for: name → age → berth (only when
 * the class offers berths) → gender → meal (only when catering is OFFERED); passenger 1 is finished before passenger 2.
 * A fact derived from the session (the LLM writes the question). null when nothing is open.
 */
export function nextPassengerDetail(s: BookingSession): { passenger: number; field: 'name' | 'age' | 'berthPreference' | 'gender' | 'foodPreference' } | null {
  const count = s.passengersCount || 0;
  for (let k = 0; k < count; k++) {
    const p: any = (s.passengers || [])[k] || {};
    const opt = optionalToAsk(s, (s.passengers || [])[k]);
    // P42.1 hardening: a stored name that is not in Latin letters is not a valid IRCTC name → still open
    const isMissing = (f: string) => p[f] === undefined || p[f] === null || p[f] === '' || (f === 'name' && !isLatinName(p[f]));
    const order = ['name', 'age', ...(opt.includes('berthPreference') ? ['berthPreference'] : []), 'gender', ...(opt.includes('foodPreference') ? ['foodPreference'] : [])] as const;
    const f = order.find(x => (x === 'berthPreference' || x === 'foodPreference') ? true : isMissing(x));
    if (f) return { passenger: k + 1, field: f as any };
  }
  return null;
}

/**
 * Session-aware gate for chat-proposed berth / meal values (already enum-validated by PassengerValidator).
 * Returns the value to store, or null + a user-facing reason. NO_PREFERENCE on a class without berth choice is
 * dropped silently (nothing to choose), exactly like the form.
 */
export function gateOptionalField(s: BookingSession, field: 'berthPreference' | 'foodPreference', value: string): { ok: true } | { ok: false; silent?: boolean; message: string } {
  if (field === 'berthPreference') {
    const opts = berthOptionsForClass(s.selectedClass) as readonly string[];
    if (!opts.length) return value === 'NO_PREFERENCE' ? { ok: false, silent: true, message: '' }
      : { ok: false, message: `${s.selectedClass || 'Is class'} mein berth choice nahi hoti — seat railway allot karti hai.` };
    if (!opts.includes(value)) return { ok: false, message: isSeatPreferenceClass(s.selectedClass)
      ? `${s.selectedClass} mein berth choice nahi hoti — sirf seat preference: ${opts.map(berthLabel).join(', ')}.`
      : `${s.selectedClass} mein berth options: ${opts.map(berthLabel).join(', ')}.` };
    return { ok: true };
  }
  const f = foodStatusOf(s).status;
  if (f === 'OFFERED') return { ok: true };
  if (f === 'NOT_CHECKED') return { ok: false, message: 'Khane ki choice abhi save nahi hui, kyunki is train ki catering jaankari abhi verify nahi hui.' };
  return { ok: false, message: 'Provider data ke hisaab se is train ke fare mein khana shaamil nahi hai — meal choice nahi hoti.' };
}

const BERTH_LABEL: Record<string, string> = { NO_PREFERENCE: 'No preference', LOWER: 'Lower', MIDDLE: 'Middle', UPPER: 'Upper', SIDE_LOWER: 'Side lower', SIDE_UPPER: 'Side upper', SIDE_MIDDLE: 'Side middle', WINDOW: 'Window side', CABIN: 'Cabin', COUPE: 'Coupe' };
const FOOD_LABEL: Record<string, string> = { VEG: 'Veg', NON_VEG: 'Non-veg', NO_FOOD: 'No food' };
export const berthLabel = (v: string) => BERTH_LABEL[v] || String(v);
export const foodLabel = (v: string) => FOOD_LABEL[v] || String(v);
