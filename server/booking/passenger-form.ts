/**
 * P38 — IRCTC-style PASSENGER FORM (deterministic, backend-validated).
 *
 * The full-screen form is a direct, explicit user edit of the booking session's passengers — no LLM involved:
 *   - berth choices come from the SELECTED class (standard IR coach layout, `berthOptionsForClass`); seat classes and
 *     unknown classes get no berth choice;
 *   - the meal choice (Veg / Non-Veg / No Food) is offered ONLY when the provider's train details say catering is
 *     included for that train (RailCore schedule `catering`). Unknown → not offered, and the form says so;
 *   - train facilities are fetched fresh from the SAME provider that produced the search results (no cache);
 *   - names must be in English letters (IRCTC), age 1–120, gender MALE / FEMALE / OTHER — via PassengerValidator;
 *   - a stale form (sessionVersion moved on) is refused with 409, never merged silently.
 * Values are never logged (privacy); only counts / field names leave this module in diagnostics.
 */
import type { BookingSession, Passenger, FoodPreference, BerthPreference } from '@shared/entities';
import { BookingState } from '@shared/states';
import { MAX_PASSENGERS, berthOptionsForClass, isSeatPreferenceClass, FOOD_PREFERENCES } from '@shared/constants';
import { passengerValidator } from './passenger-validator';
import { passengerCollection } from './passenger-collection';
import { railwayRegistry } from '../railway/registry/provider-registry';
import { inProviderScope } from '../ai/tools/provider-tools';
import { STATE_ORDER } from '../ai/state/state-transition-validator';
import type { ConversationStateManager } from '../ai/state/conversation-state';

export type FoodStatus = 'OFFERED' | 'NOT_INCLUDED' | 'UNKNOWN';

export interface TrainFacilitiesView {
  catering: boolean | null;
  pantry: boolean | null;
  provider: string | null;
  dataSource: 'LIVE' | 'MOCK' | null;
  error?: string;
}

export interface PassengerFormSpec {
  sessionId: string;
  sessionVersion: number;
  train: { number: string; name: string; origin?: string; destination?: string; departure?: string; arrival?: string; date?: string; dataSource?: string };
  travelClass: string;
  berth: { options: readonly string[]; note: string | null };
  food: { status: FoodStatus; options: readonly string[]; pantry: boolean | null; source: string | null; note: string };
  maxPassengers: number;
  passengersCount: number;
  passengers: Array<{ name: string; age: number | null; gender: string | null; berthPreference: string | null; foodPreference: string | null }>;
}

export type FormError = { status: number; code: string; message: string; fieldErrors?: Array<{ passengerIndex: number; field: string; message: string }> };

const SEAT_CLASSES = new Set(['CC', 'EC', '2S', 'EA', 'EV', 'VS']);
const LATIN_NAME = /^[A-Za-z][A-Za-z .'-]{1,39}$/;

/** Fresh train facilities from the provider that produced the search results. Never throws, never invents. */
export async function fetchTrainFacilities(s: BookingSession): Promise<TrainFacilitiesView> {
  const t: any = s.selectedTrain;
  const trainNumber = String(t?.number || t?.trainNumber || '');
  const provider = s.providerSource && s.providerSource !== 'live' ? s.providerSource : null;
  if (!trainNumber) return { catering: null, pantry: null, provider, dataSource: null, error: 'NO_TRAIN' };
  try {
    const r = await inProviderScope(provider, () => railwayRegistry.getActive().getTrainInfo({ trainNumber } as any));
    if (!r.ok || !r.data) return { catering: null, pantry: null, provider, dataSource: null, error: r.ok ? 'NO_DATA' : (r as any).error?.code || 'PROVIDER_ERROR' };
    const f = (r.data as any).facilities || {};
    return {
      catering: typeof f.catering === 'boolean' ? f.catering : null,
      pantry: typeof f.pantry === 'boolean' ? f.pantry : null,
      provider: r.meta?.providerId || provider,
      dataSource: r.meta?.source === 'mock' ? 'MOCK' : 'LIVE'
    };
  } catch {
    return { catering: null, pantry: null, provider, dataSource: null, error: 'PROVIDER_ERROR' };
  }
}

function foodView(f: TrainFacilitiesView): PassengerFormSpec['food'] {
  const src = f.provider ? `${f.provider}${f.dataSource === 'MOCK' ? ' (MOCK)' : ''}` : null;
  if (f.catering === true) return { status: 'OFFERED', options: FOOD_PREFERENCES, pantry: f.pantry, source: src, note: 'Is train ke fare mein catering shaamil hai (provider data) — har passenger ke liye khana chuniye.' };
  if (f.catering === false) return { status: 'NOT_INCLUDED', options: [], pantry: f.pantry, source: src, note: f.pantry === true ? 'Catering fare mein shaamil nahi hai; provider ke hisaab se pantry car hai (khana train mein khareed sakte hain).' : 'Provider data ke hisaab se is train ke fare mein catering shaamil nahi hai.' };
  return { status: 'UNKNOWN', options: [], pantry: f.pantry, source: src, note: 'Provider ne is train ki catering jaankari nahi di — isliye khane ka option nahi dikhaya.' };
}

export function buildFormSpec(s: BookingSession, facilities: TrainFacilitiesView): PassengerFormSpec {
  const t: any = s.selectedTrain || {};
  const cls = String(s.selectedClass || '');
  const options = berthOptionsForClass(cls);
  return {
    sessionId: s.sessionId,
    sessionVersion: s.sessionVersion,
    train: { number: String(t.number || t.trainNumber || ''), name: String(t.name || t.trainName || ''), origin: t.origin, destination: t.destination, departure: t.departure, arrival: t.arrival, date: t.date || s.date, dataSource: t.dataSource },
    travelClass: cls,
    berth: { options, note: isSeatPreferenceClass(cls) ? `${cls} mein berth nahi hoti — IRCTC sirf seat preference deta hai (Window Side). Seat railway allot karti hai, preference guarantee nahi.`
      : options.length ? null : SEAT_CLASSES.has(cls.toUpperCase()) ? `${cls} mein seat preference ki verified jaankari nahi hai — seat railway allot karti hai.` : 'Is class ke liye berth choice ki verified jaankari nahi hai.' },
    food: foodView(facilities),
    maxPassengers: MAX_PASSENGERS,
    passengersCount: s.passengersCount || 0,
    passengers: (s.passengers || []).map(p => ({ name: p.name || '', age: p.age ?? null, gender: p.gender ?? null, berthPreference: p.berthPreference ?? null, foodPreference: p.foodPreference ?? null }))
  };
}

export function formNotReady(s: BookingSession): FormError | null {
  if (!s.selectedTrain || !s.selectedClass) return { status: 409, code: 'PASSENGER_FORM_NOT_READY', message: 'Pehle train aur class select kijiye — uske baad passenger form khulega.' };
  return null;
}

/** Validate a submitted form. Pure (no session mutation). */
export function validateForm(body: any, s: BookingSession, facilities: TrainFacilitiesView | null): { ok: true; passengers: Array<Required<Pick<Passenger, 'name' | 'age' | 'gender'>> & { berthPreference?: BerthPreference; foodPreference?: FoodPreference }> } | { ok: false; error: FormError } {
  const list = Array.isArray(body?.passengers) ? body.passengers : null;
  if (!list || list.length < 1 || list.length > MAX_PASSENGERS) return { ok: false, error: { status: 400, code: 'INVALID_PASSENGER_COUNT', message: `Ek booking mein 1 se ${MAX_PASSENGERS} passengers tak ho sakte hain.` } };
  const berthOptions = berthOptionsForClass(s.selectedClass);
  const foodOffered = facilities?.catering === true;
  const fieldErrors: NonNullable<FormError['fieldErrors']> = [];
  const out: any[] = [];
  list.forEach((raw: any, i: number) => {
    const idx = i + 1;
    const label = `Passenger ${idx}`;
    const name = typeof raw?.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
    if (!LATIN_NAME.test(name)) fieldErrors.push({ passengerIndex: idx, field: 'name', message: `${label}: naam English letters mein likhiye (IRCTC), jaise "Rahul Sharma".` });
    const v = passengerValidator.validatePartial({ name: LATIN_NAME.test(name) ? name : undefined, age: raw?.age, gender: raw?.gender }, label);
    for (const e of v.errors) fieldErrors.push({ passengerIndex: idx, field: e.field, message: e.message });
    for (const f of ['age', 'gender'] as const) if (raw?.[f] === undefined || raw?.[f] === null || raw?.[f] === '') fieldErrors.push({ passengerIndex: idx, field: f, message: `${label}: ${f === 'age' ? 'umar' : 'gender'} zaroori hai.` });
    const rec: any = { name: v.valid.name, age: v.valid.age, gender: v.valid.gender };
    const b = raw?.berthPreference ? String(raw.berthPreference).toUpperCase() : '';
    if (b && b !== 'NO_PREFERENCE') {
      if (!berthOptions.includes(b as any)) fieldErrors.push({ passengerIndex: idx, field: 'berthPreference', message: `${label}: ${s.selectedClass} mein yeh berth option nahi hai.` });
      else rec.berthPreference = b;
    } else if (b === 'NO_PREFERENCE' && berthOptions.length) rec.berthPreference = 'NO_PREFERENCE';
    const food = raw?.foodPreference ? String(raw.foodPreference).toUpperCase() : '';
    if (food) {
      if (!foodOffered) fieldErrors.push({ passengerIndex: idx, field: 'foodPreference', message: `${label}: is train ke liye khane ka option provider data mein nahi hai.` });
      else if (!(FOOD_PREFERENCES as readonly string[]).includes(food)) fieldErrors.push({ passengerIndex: idx, field: 'foodPreference', message: `${label}: khana Veg, Non-Veg ya No Food chuniye.` });
      else rec.foodPreference = food;
    } else if (foodOffered) fieldErrors.push({ passengerIndex: idx, field: 'foodPreference', message: `${label}: khane ki choice chuniye (Veg / Non-Veg / No Food).` });
    out.push(rec);
  });
  if (fieldErrors.length) return { ok: false, error: { status: 400, code: 'INVALID_PASSENGER_DETAILS', message: 'Kuch passenger details theek nahi hain.', fieldErrors } };
  return { ok: true, passengers: out };
}

/** Apply a validated form as an explicit user edit. Returns field-name level diagnostics only (no values). */
export function applyForm(state: ConversationStateManager, sessionId: string, passengers: ReturnType<typeof validateForm> extends infer R ? R extends { ok: true; passengers: infer P } ? P : never : never)
  : { passengersCount: number; changedFields: number; countChanged: boolean; invalidated: string[] } {
  const s = state.getSession(sessionId);
  const n = passengers.length;
  const countChanged = s.passengersCount !== n;
  let invalidated: string[] = [];
  // fare depends on the passenger count (same rule as the chat path)
  if (countChanged && s.fare) invalidated = state.invalidate(sessionId, 'PASSENGER_COUNT');
  s.passengersCount = n;
  passengerCollection.reconcile(s, n);
  let changedFields = 0;
  passengers.forEach((v, i) => {
    const p = s.passengers[i] as any;
    const edited = new Set<string>(p.editedFields || []);
    for (const k of ['name', 'age', 'gender', 'berthPreference', 'foodPreference'] as const) {
      const val = (v as any)[k];
      if (val === undefined) { if (p[k] !== undefined) { delete p[k]; edited.add(k); changedFields++; } continue; }
      if (p[k] !== val) { p[k] = val; edited.add(k); changedFields++; }
    }
    p.manuallyEdited = true;
    if (edited.size) p.editedFields = [...edited];
  });
  delete (s as any).heldPassengerChanges;
  passengerCollection.refresh(s);
  // an edited passenger list invalidates any review / confirmation built on the old one (same as the chat path)
  if (STATE_ORDER.indexOf(s.bookingState) > STATE_ORDER.indexOf(BookingState.COLLECTING_PASSENGER_DETAILS)) state.tryTransition(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
  else if (STATE_ORDER.indexOf(s.bookingState) < STATE_ORDER.indexOf(BookingState.COLLECTING_PASSENGER_DETAILS)) state.tryTransition(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
  if ((s as any).pendingInteraction?.type === 'CONFIRMATION_REQUIRED') (s as any).pendingInteraction = undefined;
  state.bump(sessionId);
  return { passengersCount: n, changedFields, countChanged, invalidated };
}
