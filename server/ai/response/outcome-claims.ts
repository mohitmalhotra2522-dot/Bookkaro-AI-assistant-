/**
 * PROMPT 32 — Outcome-claim guard (honest failures, provider identity).
 *
 * The LLM words every answer. This guard only verifies three kinds of claims against THIS turn's real tool outcomes
 * (it never calls a tool, never rewrites wording, never decides what to do next):
 *
 *   NO_RESULTS  "koi train nahi mili" / "no trains found"  → only after a SUCCESSFUL empty provider result
 *                (a timeout / provider failure / malformed data / stale result is never "no trains")
 *   SOURCE      "railway data ke according" / "as per railway data" → only when provider data actually exists
 *   LIVE        "live data" / "real-time information"   → never for MOCK development data
 *
 * A failing sentence is removed (same contract as the P29 action guard); rejections go to diagnostics only.
 */
import type { BookingSession } from '@shared/entities';
import { toolOutcomeOf, type ToolOutcome } from '../tool-runtime/tool-outcome';
import { SAFE_ERROR_MESSAGE } from '../tool-runtime/tool-error-normalizer';
import { UNVERIFIED_FALLBACK } from '../tool-runtime/railway-response-grounding';

export type OutcomeClaimKind = 'NO_RESULTS' | 'SOURCE' | 'LIVE';
export interface OutcomeClaimDiagnostic { kind: OutcomeClaimKind; accepted: boolean; reason: string | null; evidence: string | null; sentence: string }

const RAILWAY_TOOLS = new Set(['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN', 'CHECK_PNR', 'GET_CANCELLED_TRAINS']);

const NO_TRAINS_RE = [
  /\b(?:koi|ek\s+bhi)\s+(?:bhi\s+)?(?:(?:direct|seedhi|matching)\s+)?(?:train|trains|trainein|gaadi|gaadiyan)\s+(?:nahi|nahin|nhi)\s+(?:mil|mili|mile|milin|hai|hain|chalti|di|aayi)\b/i,
  /\b(?:train|trains|trainein)\s+(?:nahi|nahin|nhi)\s+(?:mili|mile|milin)\b/i,
  /\bno\s+(?:(?:direct|matching)\s+)?trains?\s+(?:were\s+|was\s+|are\s+)?(?:found|available|running|returned|on\s+(?:this|that)\s+route)\b/i,
  /\bthere\s+are\s+no\s+trains\b/i,
  /\bcould(?:\s+not|n'?t)\s+find\s+any\s+trains?\b/i
];
/** "aaj koi train cancel nahi hui" — a zero-result claim whose only evidence is an empty GET_CANCELLED_TRAINS result. */
const NO_CANCELLED_RE = [
  /\b(?:koi|ek\s+bhi)\s+(?:bhi\s+)?(?:train|trains|trainein|gaadi)\s+(?:cancel|cancelled|radd|rad)\s+(?:nahi|nahin|nhi)\s+(?:hui|hai|hain|hua|huyi|ki\s+gayi)\b/i,
  /\b(?:koi|ek\s+bhi)\s+(?:bhi\s+)?(?:cancel|cancelled|cancellation|radd)\s+(?:train\s+)?(?:nahi|nahin|nhi)\b/i,
  /\bno\s+trains?\s+(?:are|were|have\s+been|has\s+been)?\s*(?:cancelled|canceled)\b/i,
  /\bno\s+(?:cancell?ations?|cancelled\s+trains?)\b/i
];
const NO_RESULT_RE = [
  /\b(?:koi|ek\s+bhi)\s+(?:bhi\s+)?(?:matching\s+)?(?:result|results|jaankari)\s+(?:nahi|nahin|nhi)\s+(?:mil|mila|mili|hai|di|aaya|aayi)\b/i,
  /\bno\s+(?:matching\s+)?results?\s+(?:were\s+|was\s+)?(?:found|returned|available)\b/i
];
const SOURCE_RE = [
  /\b(?:railway|irctc|provider|ntes)\s+(?:ke\s+|ka\s+|ki\s+)?(?:data|source|records?|system|information|jaankari)\s+(?:ke\s+)?(?:according|anusaar|hisaab\s+se|mutabik)\b/i,
  /\b(?:according\s+to|as\s+per)\s+(?:the\s+)?(?:railway|irctc|provider|official\s+railway)\b/i
];
const LIVE_RE = [
  /(?<!non[-\s])\b(?:live|real[-\s]?time)\s+(?:railway\s+)?(?:data|information|jaankari|update|updates|records?|feed)\b/i,
  /\b(?:according\s+to|as\s+per)\s+(?:the\s+)?(?:live|real[-\s]?time)\b/i,
  /\babhi\s+ka\s+live\b/i
];
const NEGATED = /\b(?:nahi|nahin|not|non[-\s]?live|mock|development)\b/i;

interface StepView { tool: string; outcome: ToolOutcome; dataSource: 'MOCK' | 'LIVE' | null }

export function stepOutcomes(steps: any[] | undefined): StepView[] {
  return (steps || []).filter(st => RAILWAY_TOOLS.has(String(st?.result?.toolName || st?.toolCall?.name || ''))).map(st => ({
    tool: String(st.result?.toolName || st.toolCall?.name),
    // a validator-rejected call keeps its code (TOOL_NOT_IMPLEMENTED → UNSUPPORTED, otherwise REJECTED)
    outcome: st.status === 'stale' ? 'STALE' as ToolOutcome
      : toolOutcomeOf({ ok: st.status === 'ok' && !!st.result?.success, empty: !!st.result?.empty, status: st.status === 'rejected' ? 'REJECTED' : st.result?.status, code: st.result?.error?.code, normalizedCode: st.result?.normalizedErrorCode }),
    dataSource: st.dataSource ?? null
  }));
}

function sessionHasProviderData(s: BookingSession | undefined): boolean {
  const x: any = s || {};
  return !!(x.searchResults?.trains?.length || x.availableTrains?.length || (x.availability && Object.keys(x.availability).length) || x.fare || x.lastTrainInfo || x.lastTimetable);
}
function sessionDataSources(s: BookingSession | undefined): Set<string> {
  const x: any = s || {}; const out = new Set<string>();
  for (const t of x.availableTrains || []) if (t?.dataSource) out.add(String(t.dataSource));
  for (const a of Object.values(x.availability || {}) as any[]) if (a?.dataSource) out.add(String(a.dataSource));
  if (x.fare?.dataSource) out.add(String(x.fare.dataSource));
  return out;
}

/** Verify ONE sentence. `reason` null = the sentence's outcome claims (if any) hold. */
export function verifyOutcomeClaims(sentence: string, ctx: { steps?: any[]; session?: BookingSession }): { reason: string | null; diagnostics: OutcomeClaimDiagnostic[] } {
  const t = String(sentence || '');
  const diags: OutcomeClaimDiagnostic[] = [];
  if (!t.trim()) return { reason: null, diagnostics: diags };
  const steps = stepOutcomes(ctx.steps);
  const s = ctx.session;
  const sentenceShort = t.trim().slice(0, 120);
  const push = (kind: OutcomeClaimKind, reason: string | null, evidence: string | null) => diags.push({ kind, accepted: !reason, reason, evidence, sentence: sentenceShort });

  const cancelClaim = NO_CANCELLED_RE.some(r => r.test(t));
  const trainsClaim = !cancelClaim && NO_TRAINS_RE.some(r => r.test(t));
  const resultClaim = !cancelClaim && !trainsClaim && NO_RESULT_RE.some(r => r.test(t));
  if (cancelClaim) {
    // only an empty cancelled-trains result proves "no cancellations" (an UNSUPPORTED / failed check never does)
    const last = steps.filter(x => x.tool === 'GET_CANCELLED_TRAINS').slice(-1)[0];
    const reason = last ? (last.outcome === 'NO_RESULTS' ? null : last.outcome === 'DATA' ? 'NO_RESULTS_CONTRADICTS_DATA' : `NO_RESULTS_CLAIM_ON_${last.outcome}`)
      : 'NO_RESULTS_CLAIM_WITHOUT_EMPTY_RESULT';
    push('NO_RESULTS', reason, reason ? null : 'GET_CANCELLED_TRAINS:NO_RESULTS');
    if (reason) return { reason, diagnostics: diags };
  }
  if (trainsClaim || resultClaim) {
    const searches = steps.filter(x => x.tool === 'SEARCH_TRAINS');
    const last = searches[searches.length - 1];
    let reason: string | null = null; let evidence: string | null = null;
    if (last) {
      if (last.outcome === 'NO_RESULTS') evidence = 'SEARCH_TRAINS:NO_RESULTS';
      else if (last.outcome === 'DATA') reason = 'NO_RESULTS_CONTRADICTS_DATA';
      else reason = `NO_RESULTS_CLAIM_ON_${last.outcome}`;
    } else if (resultClaim && steps.some(x => x.outcome === 'NO_RESULTS')) {
      evidence = `${steps.find(x => x.outcome === 'NO_RESULTS')!.tool}:NO_RESULTS`;
    } else if (steps.length) {
      const failed = steps.find(x => x.outcome !== 'DATA' && x.outcome !== 'NO_RESULTS');
      reason = failed ? `NO_RESULTS_CLAIM_ON_${failed.outcome}` : 'NO_RESULTS_CONTRADICTS_DATA';
    } else {
      // no railway tool this turn: only a restatement of the CURRENT (empty) provider result set is allowed
      const cur: any = (s as any)?.searchResults;
      if (cur && Array.isArray(cur.trains) && cur.trains.length === 0) evidence = 'CURRENT_RESULT_SET_EMPTY';
      else reason = 'NO_RESULTS_CLAIM_WITHOUT_EMPTY_RESULT';
    }
    push('NO_RESULTS', reason, evidence);
    if (reason) return { reason, diagnostics: diags };
  }

  if (SOURCE_RE.some(r => r.test(t))) {
    let reason: string | null = null; let evidence: string | null = null;
    if (steps.length) {
      const ok = steps.find(x => x.outcome === 'DATA' || x.outcome === 'NO_RESULTS');
      if (ok) evidence = `${ok.tool}:${ok.outcome}`; else reason = `SOURCE_CLAIM_ON_${steps[steps.length - 1].outcome}`;
    } else if (sessionHasProviderData(s)) evidence = 'CURRENT_PROVIDER_DATA';
    else reason = 'SOURCE_CLAIM_WITHOUT_PROVIDER_DATA';
    push('SOURCE', reason, evidence);
    if (reason) return { reason, diagnostics: diags };
  }

  if (LIVE_RE.some(r => r.test(t)) && !NEGATED.test(t)) {
    const kinds = new Set<string>([...steps.filter(x => x.outcome === 'DATA' || x.outcome === 'NO_RESULTS').map(x => String(x.dataSource || '')), ...(steps.length ? [] : sessionDataSources(s))].filter(Boolean));
    let reason: string | null = null;
    if (kinds.has('MOCK')) reason = 'MOCK_DATA_PRESENTED_AS_LIVE';
    else if (!kinds.has('LIVE')) reason = 'LIVE_CLAIM_WITHOUT_LIVE_DATA';
    push('LIVE', reason, reason ? null : 'LIVE_PROVIDER_DATA');
    if (reason) return { reason, diagnostics: diags };
  }
  return { reason: null, diagnostics: diags };
}

const SENT_SPLIT = /(?<=[.!?।])\s+/;
const ORPHAN_RE = /^[\s\-–—•*·,;:()\d.]*$/;
const LEAD_CONJ_RE = /^(?:aur|and|lekin|but|par|isliye|so)\s+/i;
export interface OutcomeGuardResult { text: string; removed: Array<{ sentence: string; reason: string }>; diagnostics: OutcomeClaimDiagnostic[] }

/** Final-reply guard: removes only sentences whose outcome claim fails (orphans cleaned). */
export function guardOutcomeClaims(text: string, ctx: { steps?: any[]; session?: BookingSession }): OutcomeGuardResult {
  const res: OutcomeGuardResult = { text, removed: [], diagnostics: [] };
  if (!text) return res;
  const out: string[] = [];
  for (const line of String(text).split('\n')) {
    const kept: string[] = []; let changed = false;
    for (const sent of line.split(SENT_SPLIT)) {
      const v = verifyOutcomeClaims(sent, ctx);
      res.diagnostics.push(...v.diagnostics);
      if (v.reason) { changed = true; res.removed.push({ sentence: sent.trim().slice(0, 120), reason: v.reason }); }
      else kept.push(sent);
    }
    if (!changed) { out.push(line); continue; }
    const clean: string[] = [];
    for (const k of kept) {
      const t = k.trim();
      if (!t || ORPHAN_RE.test(t)) continue;
      clean.push(clean.length ? t : t.replace(LEAD_CONJ_RE, '').replace(/^./, ch => ch.toUpperCase()));
    }
    if (clean.length) out.push(clean.join(' '));
  }
  res.text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return res;
}

/**
 * The honest, category-specific statement used when a reply had to be emptied after a failed tool (instead of the
 * generic "not verified"): timeout ≠ provider failure ≠ malformed data ≠ unsupported.
 */
export function honestFailureFallback(steps: any[] | undefined): string {
  const failed = stepOutcomes(steps).filter(x => x.outcome !== 'DATA' && x.outcome !== 'NO_RESULTS' && x.outcome !== 'REJECTED' && x.outcome !== 'STALE');
  const last = failed[failed.length - 1];
  switch (last?.outcome) {
    case 'TIMEOUT': return SAFE_ERROR_MESSAGE.TOOL_TIMEOUT;
    case 'PROVIDER_FAILURE': return SAFE_ERROR_MESSAGE.PROVIDER_UNAVAILABLE;
    case 'MALFORMED_DATA': return SAFE_ERROR_MESSAGE.PROVIDER_DATA_INVALID;
    case 'UNSUPPORTED': return SAFE_ERROR_MESSAGE.TOOL_NOT_IMPLEMENTED;
    default: return UNVERIFIED_FALLBACK;
  }
}
