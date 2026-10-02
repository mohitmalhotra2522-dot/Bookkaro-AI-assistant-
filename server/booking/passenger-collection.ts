/**
 * PassengerCollection (Prompt 9) — deterministic passenger-record management.
 *
 *  - Stable internal ids (P1, P2, …) from a monotonic per-session counter.
 *    Ids are never reused or re-derived from array positions, so editing or
 *    removing P1 never changes P2's identity.
 *  - The LLM proposes PassengerRef (INDEX / NAME / PRONOUN / ID) + raw fields;
 *    this class resolves the reference to an actual record and stores ONLY
 *    values accepted by PassengerValidator.
 *  - Existing values are overwritten only by EXPLICIT updates (corrections or
 *    field-targeted statements) and every overwrite is announced — never silent.
 *  - Count changes reconcile records: increase → new empty slots; decrease →
 *    incomplete slots removed first, otherwise the last ones (announced).
 */
import type { BookingSession, Passenger } from '@shared/entities';
import { MAX_PASSENGERS } from '@shared/constants';
import type { PassengerRef, PassengerUpdateRaw, OrchestratorErrorCode } from '../ai/decisions/agent-decision';
import { canonicalName, passengerValidator, type PassengerFieldError } from './passenger-validator';

export type RefResolution =
  | { ok: true; passenger: Passenger; index: number }
  | { ok: false; code: Extract<OrchestratorErrorCode, 'INVALID_PASSENGER_INDEX' | 'AMBIGUOUS_REFERENCE'>; message: string };

export interface UpdateOutcome {
  changed: boolean;
  /** passengerId → field names written (values are NOT included — privacy). */
  written: Array<{ passengerId: string; fields: string[]; overwritten: string[] }>;
  errors: PassengerFieldError[];
  refError?: { code: 'INVALID_PASSENGER_INDEX' | 'AMBIGUOUS_REFERENCE'; message: string };
  rejectedFields: string[];
  notes: string[];
}

const ORD = ['Pehle', 'Doosre', 'Teesre', 'Chauthe', 'Paanchve', 'Chhathe'];
const FIELD_LABEL: Record<string, string> = { name: 'naam', age: 'umar', gender: 'gender', berthPreference: 'berth preference' };
const GENDER_LABEL: Record<string, string> = { MALE: 'male', FEMALE: 'female', OTHER: 'other' };

export const passengerLabel = (p: Passenger | undefined, index: number) => p?.name || `Passenger ${index + 1}`;
export const ordinalLabel = (index: number) => `${ORD[index] || `${index + 1}th`} passenger`;

export class PassengerCollection {
  // ------------------------------------------------------------ identity

  newPassenger(s: BookingSession): Passenger {
    s.passengerSeq = (s.passengerSeq || 0) + 1;
    return { id: `P${s.passengerSeq}`, missingFields: ['name', 'age', 'gender'] };
  }

  /** Ensure records exist for passengersCount (never drops data silently — see setCount). */
  ensureSlots(s: BookingSession): string[] {
    const n = s.passengersCount || 0;
    const added: string[] = [];
    if (!s.passengers) s.passengers = [];
    while (s.passengers.length < n) { const p = this.newPassenger(s); s.passengers.push(p); added.push(p.id); }
    this.refresh(s);
    return added;
  }

  /**
   * Reconcile records to a new count. Returns removed records (for an explicit,
   * user-visible note) — invalid/extra records are never silently preserved.
   */
  reconcile(s: BookingSession, n: number): { added: string[]; removed: Passenger[] } {
    if (!s.passengers) s.passengers = [];
    const removed: Passenger[] = [];
    while (s.passengers.length > n) {
      // remove the last INCOMPLETE record first, otherwise the last record
      let k = -1;
      for (let i = s.passengers.length - 1; i >= 0; i--) if (passengerValidator.missingRequired(s.passengers[i]).length) { k = i; break; }
      if (k === -1) k = s.passengers.length - 1;
      removed.push(...s.passengers.splice(k, 1));
    }
    const added: string[] = [];
    while (s.passengers.length < n) { const p = this.newPassenger(s); s.passengers.push(p); added.push(p.id); }
    if (s.lastPassengerRefId && !s.passengers.some(p => p.id === s.lastPassengerRefId)) s.lastPassengerRefId = undefined;
    this.refresh(s);
    return { added, removed };
  }

  /** Recompute per-record missingFields + currentPassengerIndex (first incomplete). */
  refresh(s: BookingSession): void {
    for (const p of s.passengers || []) p.missingFields = passengerValidator.missingRequired(p);
    const k = (s.passengers || []).findIndex(p => (p.missingFields || []).length > 0);
    s.currentPassengerIndex = k === -1 ? Math.max(0, (s.passengers || []).length - 1) : k;
  }

  allComplete(s: BookingSession): boolean {
    const n = s.passengersCount || 0;
    if (!n || (s.passengers || []).length !== n) return false;
    return s.passengers.every(p => passengerValidator.validateRecord(p).complete && passengerValidator.validateRecord(p).valid);
  }

  /** Next required passenger field in deterministic order (passenger order, then name → age → gender). */
  nextMissing(s: BookingSession): { passenger: Passenger; index: number; field: 'name' | 'age' | 'gender' } | null {
    for (let i = 0; i < (s.passengers || []).length; i++) {
      const m = passengerValidator.missingRequired(s.passengers[i]);
      if (m.length) return { passenger: s.passengers[i], index: i, field: m[0] };
    }
    return null;
  }

  // ------------------------------------------------------------ references

  resolveRef(s: BookingSession, ref: PassengerRef): RefResolution {
    const ps = s.passengers || [];
    switch (ref.kind) {
      case 'INDEX': {
        const i = Number(ref.value) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= ps.length) {
          return { ok: false, code: 'INVALID_PASSENGER_INDEX', message: ps.length
            ? `Passenger ${ref.value} nahi hai — abhi ${ps.length} passenger${ps.length > 1 ? 's' : ''} hain.`
            : 'Abhi koi passenger record nahi hai.' };
        }
        return { ok: true, passenger: ps[i], index: i };
      }
      case 'ID': {
        const i = ps.findIndex(p => p.id === ref.value);
        return i === -1 ? { ok: false, code: 'INVALID_PASSENGER_INDEX', message: 'Wo passenger record ab maujood nahi hai.' } : { ok: true, passenger: ps[i], index: i };
      }
      case 'PRONOUN': {
        const i = s.lastPassengerRefId ? ps.findIndex(p => p.id === s.lastPassengerRefId) : -1;
        return i === -1 ? { ok: false, code: 'INVALID_PASSENGER_INDEX', message: 'Kis passenger ki baat ho rahi hai? Passenger number batayein.' } : { ok: true, passenger: ps[i], index: i };
      }
      case 'NAME': {
        const q = String(ref.value || '').trim().toLowerCase();
        const all = ps.map((p, i) => ({ p, i }));
        // an exact full-name match wins; first-name matching is only a fallback
        const exact = all.filter(({ p }) => (p.name || '').toLowerCase() === q);
        const hits = exact.length ? exact : all.filter(({ p }) => {
          const n = (p.name || '').toLowerCase();
          return !!n && n.split(/\s+/)[0] === q.split(/\s+/)[0];
        });
        if (hits.length === 1) return { ok: true, passenger: hits[0].p, index: hits[0].i };
        if (hits.length > 1) return { ok: false, code: 'AMBIGUOUS_REFERENCE', message: `"${ref.value}" naam ke ${hits.length} passengers hain — passenger number batayein (${hits.map(h => h.i + 1).join(' ya ')}).` };
        return { ok: false, code: 'INVALID_PASSENGER_INDEX', message: `"${ref.value}" naam ka koi passenger nahi mila.` };
      }
    }
  }

  // ------------------------------------------------------------ updates

  /**
   * Apply LLM-proposed passenger updates. Unreferenced full entries ("Rahul
   * Sharma 31 male, Neha 28 female") fill passengers without a name in order;
   * unreferenced partial values fill the CURRENT passenger's missing fields;
   * an unreferenced explicit correction targets the last referenced passenger.
   */
  applyUpdates(s: BookingSession, updates: PassengerUpdateRaw[]): UpdateOutcome {
    const out: UpdateOutcome = { changed: false, written: [], errors: [], rejectedFields: [], notes: [] };
    if (!s.passengers) s.passengers = [];
    const usedThisTurn = new Set<string>();

    for (const u of updates || []) {
      const fields = u.fields || {};
      // 1) resolve target
      let target: { passenger: Passenger; index: number } | null = null;
      if (u.ref) {
        const r = this.resolveRef(s, u.ref);
        if (!r.ok) { out.refError = { code: r.code, message: r.message }; continue; }
        target = r;
      } else {
        const looksFull = fields.name !== undefined && (fields.age !== undefined || fields.gender !== undefined);
        // Same person re-stated (e.g. a retry after an invalid age): an incomplete
        // passenger whose name matches exactly is completed, not duplicated.
        const cn = fields.name !== undefined ? canonicalName(fields.name) : null;
        const same = cn ? s.passengers.findIndex(p => !usedThisTurn.has(p.id) && !!p.name && p.name.toLowerCase() === cn.toLowerCase()
          && passengerValidator.missingRequired(p).length > 0) : -1;
        if (looksFull && same !== -1) {
          target = { passenger: s.passengers[same], index: same };
        } else if (looksFull) {
          const i = s.passengers.findIndex(p => !p.name && !usedThisTurn.has(p.id));
          if (i === -1) {
            out.refError = { code: 'INVALID_PASSENGER_INDEX', message: `Sab ${s.passengers.length} passengers ke naam pehle se hain. Naya passenger add karna hai to "ek aur passenger add karo" boliye.` };
            continue;
          }
          target = { passenger: s.passengers[i], index: i };
        } else if (u.explicit && s.lastPassengerRefId && s.passengers.some(p => p.id === s.lastPassengerRefId)) {
          const i = s.passengers.findIndex(p => p.id === s.lastPassengerRefId);
          target = { passenger: s.passengers[i], index: i };
        } else {
          const nm = this.nextMissing(s);
          if (nm) target = { passenger: nm.passenger, index: nm.index };
          else if (s.passengers.length === 1) target = { passenger: s.passengers[0], index: 0 };
          else { out.refError = { code: 'INVALID_PASSENGER_INDEX', message: 'Kis passenger ki detail badalni hai? Passenger number batayein.' }; continue; }
        }
      }
      const p = target.passenger;
      const label = passengerLabel(p, target.index);
      // 2) validate (untrusted)
      const v = passengerValidator.validatePartial(fields, label);
      out.rejectedFields.push(...v.rejectedFields);
      out.errors.push(...v.errors);
      // 3) write — explicit updates may overwrite (announced); implicit ones only fill gaps
      const wrote: string[] = [], over: string[] = [];
      for (const [k, val] of Object.entries(v.valid)) {
        const cur = (p as any)[k];
        if (cur === undefined || cur === null || cur === '') { (p as any)[k] = val; wrote.push(k); continue; }
        if (cur === val) continue;
        if (u.explicit) {
          (p as any)[k] = val; wrote.push(k); over.push(k);
          out.notes.push(`${k === 'name' ? `Passenger ${target.index + 1}` : label} ${poss(k)} ${show(k, cur)} se ${show(k, val)} kar ${k === 'age' ? 'di' : 'diya'}.`);
        } else {
          out.notes.push(`${label} ${poss(k)} pehle se ${show(k, cur)} hai — badalna ho to saaf boliye, jaise "${FIELD_LABEL[k]} ${show(k, val)} kar do".`);
        }
      }
      if (wrote.length) {
        out.changed = true;
        out.written.push({ passengerId: p.id, fields: wrote, overwritten: over });
      }
      usedThisTurn.add(p.id);
      s.lastPassengerRefId = p.id;
    }
    this.refresh(s);
    return out;
  }

  /** Remove one passenger by reference (decrements passengersCount). */
  remove(s: BookingSession, ref: PassengerRef): { ok: true; removed: Passenger; index: number } | { ok: false; code: 'INVALID_PASSENGER_INDEX' | 'AMBIGUOUS_REFERENCE' | 'INVALID_CONTEXT'; message: string } {
    const r = this.resolveRef(s, ref);
    if (!r.ok) return r;
    if ((s.passengers || []).length <= 1) return { ok: false, code: 'INVALID_CONTEXT', message: 'Booking mein kam se kam ek passenger hona zaroori hai.' };
    const [removed] = s.passengers.splice(r.index, 1);
    s.passengersCount = s.passengers.length;
    if (s.lastPassengerRefId === removed.id) s.lastPassengerRefId = undefined;
    this.refresh(s);
    return { ok: true, removed, index: r.index };
  }

  validCount(n: number): boolean { return Number.isInteger(n) && n >= 1 && n <= MAX_PASSENGERS; }
}

/** Hinglish possessive with correct gender agreement: "ka naam", "ki umar", "ka gender". */
function poss(k: string): string { return `${k === 'age' ? 'ki' : 'ka'} ${FIELD_LABEL[k]}`; }

function show(k: string, v: any): string {
  if (k === 'gender') return GENDER_LABEL[v] || String(v).toLowerCase();
  return String(v);
}

export const passengerCollection = new PassengerCollection();
