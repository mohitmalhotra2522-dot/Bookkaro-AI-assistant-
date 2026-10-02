/**
 * Deterministic passenger field resolvers.
 * LLM extracts raw strings; these functions convert them to canonical values.
 */

export function resolvePassengerAge(raw: string): number | null {
  if (!raw) return null;
  const n = raw.match(/(\d{1,3})/);
  if (!n) return null;
  const age = parseInt(n[1], 10);
  if (age < 1 || age > 120) return null;
  return age;
}

export function resolvePassengerGender(raw: string): 'MALE' | 'FEMALE' | 'OTHER' | null {
  const t = raw.toLowerCase();
  if (/\b(male|ladka|mard|purush|aadmi)\b/.test(t)) return 'MALE';
  if (/\b(female|ladki|mahila|aurat|woman)\b/.test(t)) return 'FEMALE';
  if (/\b(other|trans|any)\b/.test(t)) return 'OTHER';
  // Hindi shortforms
  if (/लड़का|पुरुष|आदमी/.test(t)) return 'MALE';
  if (/लड़की|महिला|औरत/.test(t)) return 'FEMALE';
  return null;
}

export function resolvePassengerCount(raw: string): number | null {
  if (!raw) return null;
  const map: Record<string, number> = { ek:1, do:2, teen:3, char:4, paanch:5, chhe:6 };
  const key = raw.toLowerCase().trim();
  if (map[key] !== undefined) return map[key];
  const n = raw.match(/(\d+)/);
  if (n) {
    const v = parseInt(n[1], 10);
    if (v >= 1 && v <= 6) return v;
  }
  return null;
}
