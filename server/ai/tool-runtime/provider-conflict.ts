/**
 * PROMPT 17 — Provider conflict policy (Part 45).
 *
 * The backend (never the LLM) chooses providers. Phase 1 has exactly ONE registered railway provider
 * and NO fallback chain, so no reconciliation happens in production today. When more than one provider
 * answer exists for the same request (future fallback / cross-check), conflicting facts are NEVER merged
 * or "averaged": the result is PROVIDER_DATA_CONFLICT and no fact is shown.
 */
export interface ProviderAnswer { provider: string; ok: boolean; data?: any }

const KEY_FIELDS = ['status', 'total', 'perPassenger', 'departure', 'arrival', 'pnrStatus', 'currentStatus', 'delayMinutes', 'trainNumber', 'travelClass'];

function fingerprint(d: any): string {
  if (!d || typeof d !== 'object') return JSON.stringify(d ?? null);
  if (Array.isArray(d.trains)) return d.trains.map((t: any) => `${t.trainNumber}@${t.departure}`).sort().join(',');
  return KEY_FIELDS.filter(k => d[k] !== undefined).map(k => `${k}=${JSON.stringify(d[k])}`).join('|');
}

export type ReconcileResult =
  | { ok: true; provider: string; data: any }
  | { ok: false; code: 'PROVIDER_DATA_CONFLICT'; providers: string[] }
  | { ok: false; code: 'NO_PROVIDER_RESULT'; providers: string[] };

export function reconcileProviderAnswers(answers: ProviderAnswer[]): ReconcileResult {
  const good = answers.filter(a => a.ok);
  if (!good.length) return { ok: false, code: 'NO_PROVIDER_RESULT', providers: answers.map(a => a.provider) };
  const fps = new Set(good.map(a => fingerprint(a.data)));
  if (fps.size > 1) return { ok: false, code: 'PROVIDER_DATA_CONFLICT', providers: good.map(a => a.provider) };
  return { ok: true, provider: good[0].provider, data: good[0].data };
}
