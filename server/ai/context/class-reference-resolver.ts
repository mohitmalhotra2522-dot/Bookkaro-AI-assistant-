/**
 * ClassReferenceResolver — resolves "CC", "CC wali", "chair car", "AC wali",
 * "2S", "EC", "3AC" … strictly against selectedTrain.availableClasses.
 *
 *  - Unknown / not offered on this train → INVALID_CLASS_SELECTION (never selected).
 *  - Generic "AC" with >1 AC class on the train → AMBIGUOUS_REFERENCE.
 */
export const AC_CLASSES = new Set(['1A', '2A', '3A', 'CC', 'EC', 'FC', '3E']);

export type ClassResolution =
  | { ok: true; code: string }
  | { ok: false; code: 'INVALID_CLASS_SELECTION' | 'AMBIGUOUS_REFERENCE'; message: string; available: string[] };

/** Map free text to a canonical class code (or 'AC' / 'NON_AC' family). */
export function canonicalClassToken(raw: string): string | null {
  const t = ` ${String(raw || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
  if (/ (chair car|chaircar) /.test(t)) return 'CC';
  if (/ (executive|exec chair|ec) /.test(t)) return 'EC';
  if (/ (second sitting|2s|ds) /.test(t)) return '2S';
  if (/ (sleeper|sl) /.test(t)) return 'SL';
  if (/ (3e|3 e|3ae|3 economy|ac economy|ac 3 economy|3 tier economy|economy) /.test(t)) return '3E';   // AC 3 Economy is its own class — never 3A
  if (/ (3a|3ac|3 ac|third ac|3 tier) /.test(t)) return '3A';
  if (/ (2a|2ac|2 ac|second ac|2 tier) /.test(t)) return '2A';
  if (/ (1a|1ac|1 ac|first ac|first class ac) /.test(t)) return '1A';
  if (/ (cc) /.test(t)) return 'CC';
  if (/ (fc|first class) /.test(t)) return 'FC';
  if (/ (non ac|nonac) /.test(t)) return 'NON_AC';
  if (/ ac /.test(t)) return 'AC';
  return null;
}

export function trainClassCodes(train: any): string[] {
  if (!train) return [];
  if (Array.isArray(train.availableClasses) && train.availableClasses.length) return train.availableClasses.map(String);
  return (train.classes || []).map((c: any) => c.code);
}

const join = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} aur ${xs[xs.length - 1]}`;

export class ClassReferenceResolver {
  resolve(raw: string, train: any): ClassResolution {
    const available = trainClassCodes(train);
    const num = train?.number || train?.trainNumber || 'Is train';
    const tok = canonicalClassToken(raw) || String(raw || '').toUpperCase().trim();
    const ask = `${num} mein available classes ${join(available)} hain. Kaunsi chahiye?`;

    if (tok === 'AC' || tok === 'NON_AC') {
      const cands = available.filter(c => tok === 'AC' ? AC_CLASSES.has(c) : !AC_CLASSES.has(c));
      if (cands.length === 1) return { ok: true, code: cands[0] };
      if (cands.length === 0) return { ok: false, code: 'INVALID_CLASS_SELECTION', message: `${num} mein koi ${tok === 'AC' ? 'AC' : 'non-AC'} class nahi hai. ${ask}`, available };
      return { ok: false, code: 'AMBIGUOUS_REFERENCE', message: `${num} mein ${tok === 'AC' ? 'AC' : 'non-AC'} classes ${join(cands)} hain. Kaunsi chahiye?`, available };
    }
    if (available.includes(tok)) return { ok: true, code: tok };
    return { ok: false, code: 'INVALID_CLASS_SELECTION', message: `${tok} is train mein available nahi hai. ${ask}`, available };
  }
}
