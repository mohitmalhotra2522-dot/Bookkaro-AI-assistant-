/**
 * P42.1 (pre-release) — passenger-update claim guard.
 *
 * An LLM sentence may say that a passenger detail was stored / updated ("Age 31 noted", "naam save ho gaya",
 * "gender male kar diya", "Rahul's age is updated") ONLY when the deterministic passenger state action actually
 * changed that detail in THIS turn. Otherwise the sentence is removed (the rest of the reply stays). No backend
 * acknowledgement is ever written here — when the update did succeed the LLM's own wording passes untouched.
 *
 * Evidence = the passenger fields that really changed in the session during this turn (`P1.age`, `P2.name`, …),
 * computed by the orchestrator from a before / after snapshot. No passenger values are logged or returned.
 */
import type { BookingSession } from '@shared/entities';

export type PassengerField = 'name' | 'age' | 'gender' | 'berthPreference' | 'foodPreference';
const FIELDS: PassengerField[] = ['name', 'age', 'gender', 'berthPreference', 'foodPreference'];

/** `P1.age`-style keys of the passenger fields whose value differs between two session snapshots. */
export function passengerFieldsChanged(before: Array<Record<string, any>> | undefined, after: Array<Record<string, any>> | undefined): string[] {
  const out: string[] = [];
  const b = before || [], a = after || [];
  for (let k = 0; k < a.length; k++) {
    const pa = a[k] || {}, pb = b.find(x => x && pa.id && x.id === pa.id) || b[k] || {};
    for (const f of FIELDS) {
      const va = pa[f], vb = pb[f];
      if ((va ?? '') !== '' && String(va) !== String(vb ?? '')) out.push(`${pa.id || `P${k + 1}`}.${f}`);
    }
  }
  return out;
}

/** Snapshot of the passenger fields only (taken at turn start). */
export function passengerSnapshot(s: BookingSession | undefined): Array<Record<string, any>> {
  return ((s?.passengers || []) as any[]).map(p => {
    const o: Record<string, any> = { id: p?.id };
    for (const f of FIELDS) o[f] = p?.[f];
    return o;
  });
}

const FIELD_WORDS: Array<[PassengerField, RegExp]> = [
  ['age', /\b(age|umar|umr|umra|years? old|saal)\b/i],
  ['name', /\b(name|naam)\b/i],
  ['gender', /\b(gender|ling|male|female)\b/i],
  ['berthPreference', /\b(berth|seat preference|window|lower|upper|middle|side lower|side upper)\b/i],
  ['foodPreference', /\b(food|meal|khana|khaana|veg|non-veg|jain)\b/i]
];
const PASSENGER_WORD = /\b(passenger|yatri|details?)\b/i;
const NEG = /\b(nahi|nahin|nhi|not|never|couldn'?t|could not|wasn'?t|isn'?t|haven'?t|hasn'?t|unable|abhi tak nahi)\b|n't\b/i;
/** "noted" / "note kar liya" — a storage claim even without naming the field */
const NOTED = /\bnoted\b|\bnote\s+(?:kar|kr)\s+(?:li|liya|liye|lee|di|diya)\b/i;
/** completed storage / update verbs (Hinglish + English) */
const STORED = new RegExp([
  String.raw`\b(?:save|store|record|update|add|set|change|darj|enter)\w*\s+(?:ho\s+(?:gay[aie]|gai|chuk[aie])|kar\s+(?:di|diya|diye|dia|li|liya|liye|lee|dee)|kr\s+(?:di|diya|li|liya))\b`,
  String.raw`\b(?:saved|stored|recorded|updated|added|changed|entered)\b`,
  String.raw`\b(?:badal|likh)\s+(?:di|diya|diye|li|liya|liye)\b`
].join('|'), 'i');
/** "<field> … kar diya" ("gender male kar diya") — counts only when a field is named */
const SET_TO = /\b(?:kar|kr)\s+(?:di|diya|diye|dia)\b/i;

/**
 * null = no unsupported passenger-update claim in this sentence; otherwise the reason it must be removed.
 * `updated` undefined → the caller supplied no evidence → nothing is judged (only the orchestrator turn supplies it).
 */
export function verifyPassengerUpdateClaim(sentence: string, updated: string[] | undefined): string | null {
  if (!Array.isArray(updated)) return null;
  const t = String(sentence || '').trim();
  if (!t || /\?\s*$/.test(t) || NEG.test(t)) return null;            // a question / honest negative is not a claim
  const fields = FIELD_WORDS.filter(([, re]) => re.test(t)).map(([f]) => f);
  const noted = NOTED.test(t);
  const stored = STORED.test(t) || (fields.length > 0 && SET_TO.test(t));
  if (!noted && !stored) return null;
  if (!noted && !fields.length && !PASSENGER_WORD.test(t)) return null; // e.g. "review updated" — not a passenger claim
  const changed = new Set(updated.map(k => k.split('.').pop()));
  if (!fields.length) return updated.length ? null : 'NO_PASSENGER_UPDATE_APPLIED';
  const missing = fields.filter(f => !changed.has(f));
  return missing.length ? `FIELD_NOT_UPDATED:${missing.join(',')}` : null;
}

/** Screen-reply path (orchestrator compose): remove unsupported passenger-update claim sentences; the rest stays. */
export function guardPassengerUpdateClaims(text: string, updated: string[] | undefined): { text: string; removed: Array<{ sentence: string; reason: string }> } {
  const res = { text, removed: [] as Array<{ sentence: string; reason: string }> };
  if (!text || !Array.isArray(updated)) return res;
  const lines = String(text).split('\n').map(line => line.split(/(?<=[.!?।])\s+/).filter(sn => {
    const reason = verifyPassengerUpdateClaim(sn, updated);
    if (reason) res.removed.push({ sentence: sn.trim().slice(0, 120), reason });
    return !reason;
  }).join(' ').trim());
  res.text = res.removed.length ? lines.filter(Boolean).join('\n').trim() : text;
  return res;
}
