/**
 * PROMPT 17 — RailwayToolRuntime.
 *
 *   LLMToolCall → strict name → forbidden / unknown / not-implemented → allowed state
 *     → ToolArgumentNormalizer (+ argument security) → ToolCallValidator (existing)
 *     → budget / loop protection → executor (RailwaySearchOrchestrator / RailwayToolService /
 *       Live / PNR services → active RailwayProvider) bounded by a timeout
 *     → error normalization → LLMToolResult (+ freshness metadata) → result guard (turn / journeyVersion)
 *
 * Freshness: every railway tool is ALWAYS_FRESH. There is NO application cache — the only
 * de-duplication is of accidental duplicates inside ONE turn (handled by the caller); a new user turn,
 * including "abhi dobara check karo", always reaches the provider again.
 *
 * The runtime never mutates BookingSession; callers own session sync behind their RequestGuard.
 */
import { dataSourceOf, isWellFormedToolData, toolOutcomeOf, type DataSourceKind } from './tool-outcome';
import type { BookingSession } from '@shared/entities';
import type {
  LLMToolResult, ToolErrorCode, ToolExecutionRecord, ToolExecutionStatus, RailwayToolName
} from '@shared/railway-tool-runtime';
import type { ToolCall } from '../tools/tool-registry';
import type { ValidatedToolCall } from '../tools/tool-call-validator';
import { resolveToolName, isStateAllowed } from './railway-tool-registry';
import { sameTrainLimitsFromEnv } from '../../railway/same-train/same-train-engine';

/** P42: runtime timeout for the composite search = engine total budget + one provider call + 3 s margin. */
function sameTrainToolTimeoutMs(): number { const l = sameTrainLimitsFromEnv(); return l.totalTimeoutMs + l.perCallTimeoutMs + 3000; }
import { normalizeToolArguments } from './tool-argument-normalizer';
import { normalizeToolErrorCode, statusForError, safeErrorMessage, SAFE_ERROR_MESSAGE } from './tool-error-normalizer';
import { syncJourneyVersion, journeyKeyOf } from './journey-version';
import { maskPnr } from '../../booking/post-booking/pnr-validator';
import { v4 as uuidv4 } from '../orchestrator/utils';
import type { ToolExecutionPlanNode } from '@shared/turn-engine';
import { DEFAULT_TOOL_RETRY_POLICY, shouldRetry, type ToolRetryPolicy } from './tool-retry-policy';
import { buildToolExecutionPlan, unsatisfiedDependency } from './tool-execution-plan';
import { inProviderScope, providerToolCatalog } from '../tools/provider-tools';
import { fallbackProviderFor, runWithProviderFallback, isFallbackEligible } from '../../railway/providers/provider-fallback';

/** Prompt 18: lifecycle observer (turn engine streaming events). Never receives raw arguments. */
export interface ToolObserver {
  onRecord?: (rec: ToolExecutionRecord, phase: 'REQUESTED' | 'STARTED' | 'COMPLETED' | 'FAILED' | 'RETRY') => void;
  onPlan?: (nodes: readonly ToolExecutionPlanNode[]) => void;
}

/** P37: configurable budgets (defaults unchanged). Invalid / non-positive env values fall back to the default. */
const envInt = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isInteger(n) && n > 0 && n <= 50 ? n : d; };
export const MAX_TOOL_CALLS_PER_TURN = envInt('MAX_TOOL_CALLS_PER_TURN', 8);
/** Prompt 27: the per-turn tool-step budget of a multi-step chain — the SAME budget (one constant, never silently raised). */
export const MAX_TOOL_STEPS_PER_TURN = MAX_TOOL_CALLS_PER_TURN;
export const MAX_TOOL_ROUNDS_PER_TURN = envInt('MAX_TOOL_ROUNDS_PER_TURN', 5);
/** Same normalized call requested this many times in one turn → TOOL_LOOP_DETECTED. */
export const TOOL_LOOP_THRESHOLD = 3;
export const DEFAULT_TOOL_TIMEOUT_MS = Number(process.env.RAILWAY_TOOL_TIMEOUT_MS) > 0 ? Number(process.env.RAILWAY_TOOL_TIMEOUT_MS) : 9000;

export function stableJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
/** Short, non-reversible hash (FNV-1a) — observability never logs raw argument values. */
export function hashArguments(tool: string, args: Record<string, any>): string {
  const s = `${tool}|${stableJson(args || {})}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function safeSummary(args: Record<string, any>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of ['origin', 'destination', 'date', 'trainNumber', 'travelClass', 'passengersCount']) {
    const v = args?.[k]; if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  if (args?.pnr) out.pnr = maskPnr(String(args.pnr)) || '**********';
  return out;
}
const selectedTrainOf = (s: BookingSession): string => { const t: any = s.selectedTrain; return t ? String(t.number || t.trainNumber || '') : ''; };
/** Prompt 27: provider failures where ONE identical retry by the LLM is meaningful. */
const TRANSIENT_FAILURES: ReadonlySet<string> = new Set(['TOOL_FAILED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'TOOL_TIMEOUT']);
const selectionKeyOf = (s: BookingSession) => `${selectedTrainOf(s)}|${s.selectedClass || ''}|${s.passengersCount || ''}`;

/** Executes a VALIDATED call against the existing railway layer. `canApply` must be honoured before any commit. */
export interface RailwayToolExecutor {
  readonly providerLabel?: string;
  execute(vt: ValidatedToolCall, guard: { canApply: () => boolean }): Promise<any>;
}

export interface ToolTurnContext {
  sessionId: string;
  turnId: string;
  requestId?: string;
  userText: string;
  getSession: () => BookingSession;
  /** Existing ToolCallValidator (with grounding) — runs AFTER normalization. */
  validate: (tc: ToolCall, s: BookingSession) => { ok: true; v: ValidatedToolCall } | { ok: false; error: { code: string; message: string } };
  allowedTools?: () => readonly string[] | undefined;
  /** Turn superseded (newer request) — RequestGuard view. */
  isStale?: () => boolean;
  /** Part 7: the user explicitly asked for fresh data this turn. Informational — runtime never caches anyway. */
  forceFresh?: boolean;
  /** Prompt 18: streaming / observability hooks. */
  observer?: ToolObserver;
}

export type PreparedCall =
  | { ok: true; tc: ToolCall; vt: ValidatedToolCall; record: ToolExecutionRecord; journeyVersion: number; selectionKey: string; corrections: string[]; failSig?: string }
  | { ok: false; tc: ToolCall; record: ToolExecutionRecord; error: { code: string; normalized: ToolErrorCode; message: string; details?: any }; result: LLMToolResult; stop: boolean };

export interface ExecutedCall {
  prepared: Extract<PreparedCall, { ok: true }>;
  record: ToolExecutionRecord;
  success: boolean;
  empty: boolean;
  data?: any;
  /** Original (service-level) error code is kept for existing flows; `normalized` is the Part 47 code. */
  error?: { code: string; normalized: ToolErrorCode; message: string };
  provider: string | null;
  /** Prompt 32: provider identity from the provider's own response meta ('MOCK' | 'LIVE'; null = no response). */
  dataSource?: DataSourceKind | null;
  /** Prompt 35: failover chain behind this answer (provider layer; never a different tool, never a cache). */
  providerAttempts?: ToolExecutionRecord['providerAttempts'];
  fallbackUsed?: boolean;
  /** P42.9: primary provider error that triggered the backend fallback (RATE_LIMITED / TIMEOUT / PROVIDER_UNAVAILABLE) */
  fallbackReason?: string;
  freshness?: ToolExecutionRecord['freshness'];
  latencyMs: number;
  timedOut: boolean;
  /** The result guard dropped it (superseded journey / request) before any commit. */
  stale: boolean;
  result: LLMToolResult;
}

const SELECTION_TOOLS = new Set(['CHECK_AVAILABILITY', 'GET_FARE']);

export class RailwayToolRuntime {
  constructor(readonly opts: { timeoutMs?: number; maxCallsPerTurn?: number; maxRounds?: number; loopThreshold?: number;
    /** Prompt 18: backend retry policy (default: 1 retry for transient provider errors). */
    retryPolicy?: ToolRetryPolicy; sleep?: (ms: number) => Promise<void> } = {}) {}
  beginTurn(ctx: ToolTurnContext): ToolTurn { return new ToolTurn(ctx, this.opts); }
}

export class ToolTurn {
  readonly records: ToolExecutionRecord[] = [];
  private llmCalls = 0;
  private rounds = 0;
  private readonly sigCounts = new Map<string, number>();
  /** Prompt 25 Part 9: LLM calls rejected by validation in this turn (raw loop signature → why). */
  private readonly invalidSigs = new Map<string, { code: string; message: string; details?: any; clarify?: string }>();
  private readonly invalidTools = new Set<string>();
  /** Prompt 25 Part 17: validation failures / identical invalid repeats / corrected retries of this turn. */
  readonly validation = { failures: 0, repeatedInvalid: 0, correctedRetries: 0, coerced: 0 };
  /** Prompt 27: bounded LLM retries of provider failures (kept apart from the P25 validation counters). */
  readonly retryStats = { llmRetries: 0, repeatedFailed: 0 };
  /** Prompt 27: provider failures of VALIDATED calls this turn (same tool + validated args + journey) → bounded LLM retry. */
  private readonly failedSigs = new Map<string, { code: string; count: number }>();
  private parallelGroup = 0;
  readonly timeoutMs: number;
  readonly maxCalls: number;
  readonly maxRounds: number;
  readonly loopThreshold: number;
  /** Prompt 18: dependency graph of every round run in this turn (LLM rounds + backend prep). */
  readonly plans: ToolExecutionPlanNode[] = [];
  private planRounds = 0;
  readonly retryPolicy: ToolRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly ctx: ToolTurnContext, opts: RailwayToolRuntime['opts']) {
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_TOOL_RETRY_POLICY;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.maxCalls = opts.maxCallsPerTurn ?? MAX_TOOL_CALLS_PER_TURN;
    this.maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS_PER_TURN;
    this.loopThreshold = opts.loopThreshold ?? TOOL_LOOP_THRESHOLD;
  }

  get roundsUsed() { return this.rounds; }
  get callsUsed() { return this.llmCalls; }

  /** A new LLM round that requested tools. false → MAX_TOOL_ROUNDS_PER_TURN reached (no calls run). */
  startRound(): boolean { this.rounds++; return this.rounds <= this.maxRounds; }

  /** Loop signature on the RAW request (before dedup): same tool + same args + same selection context. */
  loopSignature(tc: ToolCall): string {
    // P37: the provider is part of the request — railcore_search and railradar_search are different calls
    const pv = tc?.provider ? `${tc.provider}:` : '';
    if (tc?.name === 'SEARCH_TRAINS') return `${pv}SEARCH_TRAINS|${stableJson(tc?.arguments || {})}`;
    const s = this.ctx.getSession();
    // Prompt 27: + result-list version and booking state — after a fresh search (e.g. a date correction re-derived the
    // same train) a call that was invalid on the OLD state is a genuinely new call, not a blind repeat
    return `${pv}${tc?.name}|${stableJson(tc?.arguments || {})}|${selectionKeyOf(s)}|${journeyKeyOf(s)}|${s.searchResultsVersion ?? ''}|${s.bookingState}`;
  }

  private newRecord(tc: ToolCall): ToolExecutionRecord {
    const s = this.ctx.getSession();
    const rec: ToolExecutionRecord = {
      toolExecutionId: `tx_${uuidv4()}`, sessionId: this.ctx.sessionId, turnId: this.ctx.turnId, requestId: this.ctx.requestId ?? null,
      tool: String(tc?.name ?? ''), journeyVersion: syncJourneyVersion(s),
      argumentsHash: hashArguments(String(tc?.name ?? ''), tc?.arguments || {}), argumentsSummary: safeSummary(tc?.arguments || {}),
      provider: null, requestedAt: new Date().toISOString(), startedAt: null, completedAt: null,
      status: 'REQUESTED', fresh: false, latencyMs: null, resultCount: null, rejectionReason: null, parallelGroup: null,
      attempt: 1, retryOf: null, planNodeId: null,
      // P37: the provider tool the LLM named (railcore_search …) + the provider it selected — observability only
      ...(tc?.toolName && tc.toolName !== tc.name ? { providerTool: tc.toolName } : {}), ...(tc?.provider ? { provider: tc.provider } : {})
    };
    this.records.push(rec);
    this.notify(rec, 'REQUESTED');
    return rec;
  }

  private reject(tc: ToolCall, rec: ToolExecutionRecord, code: string, message: string, stop = false, details?: any, normalizedOverride?: ToolErrorCode): PreparedCall {
    const normalized = normalizedOverride ?? normalizeToolErrorCode(code);
    rec.status = 'REJECTED'; rec.rejectionReason = normalizedOverride ?? code; rec.completedAt = new Date().toISOString();
    this.notify(rec, 'FAILED');
    const msg = safeErrorMessage(normalized, message || SAFE_ERROR_MESSAGE[normalized]);
    return {
      ok: false, tc, record: rec, stop, error: { code, normalized, message: msg, details },
      result: this.toLLMResult(rec, 'REJECTED', { error: { code: normalized, message: msg, detail: code } })
    };
  }

  /**
   * Validate one call without touching the provider. `fromLLM=false` = deterministic backend prep
   * (BookingPreparationService) — exempt from the per-turn LLM budget/loop counters, same gates otherwise.
   */
  prepare(tc: ToolCall, fromLLM: boolean, admitted = false): PreparedCall {
    if (fromLLM && !admitted) { const a = this.admit(tc); if (a) return a; }
    const rec = this.newRecord(tc);
    // P37 gateway: a provider tool without an implemented / exposed integration never runs (no fake provider), and in
    // provider-tool mode a railway call must name its provider — the backend never chooses one for the LLM.
    if (tc?.providerNotImplemented) {
      return this.reject(tc, rec, 'PROVIDER_NOT_IMPLEMENTED', `"${String(tc.toolName || tc.name).slice(0, 40)}" is not available: ${tc.providerNotImplemented} has no implemented integration here. Use one of the provider tools you were given.`,
        false, { provider: tc.providerNotImplemented, available: providerToolCatalog.list().map(c => c.id) }, 'TOOL_NOT_IMPLEMENTED');
    }
    // P39: a robots-blocked / private-API web capability is never fetched — honest WEB_ACCESS_BLOCKED, nothing executed
    if ((tc as any)?.webAccessBlocked) {
      const b = (tc as any).webAccessBlocked;
      return this.reject(tc, rec, 'WEB_ACCESS_BLOCKED' as any, `"${String(tc.toolName || tc.name).slice(0, 40)}" is not accessible: ${b.provider} ${b.status === 'BLOCKED_BY_ROBOTS' ? 'robots.txt disallows this page' : b.status === 'PRIVATE_API' ? 'offers this only through a private API' : b.status === 'UNVERIFIABLE' ? 'data cannot be verified' : 'has no public page for this'} (${String(b.note).slice(0, 120)}). Nothing was fetched.`,
        false, { provider: b.provider, webStatus: b.status }, 'WEB_ACCESS_BLOCKED' as any);
    }
    if (fromLLM && providerToolCatalog.enabled() && !tc?.provider && providerToolCatalog.toolName('x', tc?.name as any)) {
      return this.reject(tc, rec, 'PROVIDER_TOOL_REQUIRED', `Call a provider tool (${providerToolCatalog.list().map(c => `${c.id}_…`).join(', ')}) — the backend does not pick a provider.`, false, undefined, 'INVALID_REQUEST');
    }
    if (tc?.provider) rec.provider = tc.provider;
    const res = resolveToolName(tc?.name);
    // Backend-controlled action: not a registered tool (step code UNKNOWN_TOOL, as before) and explicitly
    // classified FORBIDDEN_ACTION in the execution record / normalized result.
    if (res.kind === 'FORBIDDEN') return this.reject(tc, rec, 'UNKNOWN_TOOL', SAFE_ERROR_MESSAGE.FORBIDDEN_ACTION, false, { forbidden: true }, 'FORBIDDEN_ACTION');
    if (res.kind === 'UNKNOWN') return this.reject(tc, rec, 'UNKNOWN_TOOL', `"${String(tc?.name ?? '').slice(0, 40)}" registered railway tool nahi hai.`);
    if (!res.meta.implemented || !res.meta.enabled) return this.reject(tc, rec, 'TOOL_NOT_IMPLEMENTED', SAFE_ERROR_MESSAGE.TOOL_NOT_IMPLEMENTED);
    const allowed = this.ctx.allowedTools?.();
    if (allowed && !allowed.includes(res.name)) return this.reject(tc, rec, 'INVALID_ACTION_FOR_STATE', 'Is step par sirf read-only railway jaankari (PNR / live status / timetable) available hai.');
    const s = this.ctx.getSession();
    if (!isStateAllowed(res.meta, s.bookingState)) return this.reject(tc, rec, 'INVALID_ACTION_FOR_STATE', 'Booking process chal raha hai — abhi ye jaankari nahi mangwa sakte.');

    rec.status = 'VALIDATING';
    const raw = (tc?.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments)) ? tc.arguments : {};
    // Prompt 25 Part 9: the SAME invalid call again (same tool + args + context) is not re-validated or executed —
    // the LLM is told to correct the arguments or ask the user; a third identical request ends in the loop guard.
    const sig = fromLLM ? this.loopSignature(tc) : '';
    const prevInvalid = fromLLM ? this.invalidSigs.get(sig) : undefined;
    if (prevInvalid) {
      this.validation.repeatedInvalid++;
      return this.reject(tc, rec, 'INVALID_REPEATED_CALL', `Identical ${res.name} call was already rejected (${prevInvalid.code}). Do not repeat it: correct the arguments or ask the user.`,
        false, { previousCode: prevInvalid.code, ...(prevInvalid.details && typeof prevInvalid.details === 'object' ? prevInvalid.details : {}) });
    }
    const invalid = (code: string, message: string, details?: any): PreparedCall => {
      if (fromLLM) {
        this.validation.failures++;
        this.invalidTools.add(res.name);
        this.invalidSigs.set(sig, { code, message, details, clarify: typeof details?.clarify === 'string' ? details.clarify : undefined });
      }
      return this.reject(tc, rec, code, message, false, details);
    };
    const norm = normalizeToolArguments(res.name, raw, s, this.ctx.userText);
    if (!norm.ok) return invalid(norm.code, norm.message, norm.details);
    const val = this.ctx.validate({ callId: tc.callId, name: res.name as any, arguments: norm.arguments }, s);
    if (!val.ok) return invalid(val.error.code, val.error.message, (val.error as any).details);
    if (fromLLM && this.invalidTools.has(res.name)) this.validation.correctedRetries++;
    this.validation.coerced += norm.corrections.filter(c => c.startsWith('type:')).length;
    rec.argumentsHash = hashArguments(res.name, val.v.arguments);
    rec.argumentsSummary = safeSummary(val.v.arguments);
    // Prompt 27: an identical VALIDATED call that already failed at the provider this turn — a transient failure may be
    // retried ONCE by the LLM; a non-transient failure (or a second failure) is not re-sent: the LLM gets a structured
    // reason and answers / asks / tries a genuinely different step instead (bounded, never an endless retry).
    const failSig = fromLLM ? `${tc?.provider || ''}:${res.name}|${rec.argumentsHash}|${journeyKeyOf(s)}` : undefined;
    const prevFail = failSig ? this.failedSigs.get(failSig) : undefined;
    if (prevFail) {
      if (!TRANSIENT_FAILURES.has(prevFail.code) || prevFail.count >= 2) {
        this.retryStats.repeatedFailed++;
        return this.reject(tc, rec, 'REPEATED_FAILED_CALL', `Identical ${res.name} call already failed (${prevFail.code}) ${prevFail.count}x this turn. Do not repeat it: answer from the results you have, tell the user it could not be checked, or try a different step.`,
          false, { previousCode: prevFail.code, attempts: String(prevFail.count) });
      }
      this.retryStats.llmRetries++;
      rec.llmRetry = true;
    }
    return { ok: true, tc, vt: val.v, record: rec, journeyVersion: syncJourneyVersion(s), selectionKey: selectionKeyOf(s), corrections: norm.corrections, ...(failSig ? { failSig } : {}) };
  }

  /** Result guard (Part 55): same request, same journeyVersion, same selection (quotes). */
  isCurrent(p: Extract<PreparedCall, { ok: true }>): boolean {
    if (this.ctx.isStale?.()) return false;
    const s = this.ctx.getSession();
    if (p.vt.name === 'SEARCH_TRAINS') {
      const a = p.vt.arguments;
      return s.origin === a.origin && s.destination === a.destination && s.date === a.date;
    }
    if (syncJourneyVersion(s) !== p.journeyVersion) return false;
    if (SELECTION_TOOLS.has(p.vt.name) && selectionKeyOf(s) !== p.selectionKey) return false;
    return true;
  }

  private notify(rec: ToolExecutionRecord, phase: Parameters<NonNullable<ToolObserver['onRecord']>>[1]) {
    try { this.ctx.observer?.onRecord?.(rec, phase); } catch { /* observers never break execution */ }
  }

  /**
   * Execute one prepared call (fresh provider call, timeout, normalization) with the backend
   * ToolRetryPolicy (Prompt 18): a transient failure may be retried while the turn is still current;
   * every retry is a NEW execution record (new toolExecutionId, retryOf → previous). Never commits.
   */
  async execute(p: Extract<PreparedCall, { ok: true }>, executor: RailwayToolExecutor): Promise<ExecutedCall> {
    let x = await this.executeOnce(p, p.record, executor);
    let retries = 0;
    while (!x.success && !x.stale && x.error && shouldRetry(this.retryPolicy, x.error.normalized, retries) && this.isCurrent(p)) {
      retries++;
      this.notify(x.record, 'RETRY');
      await this.sleep(this.retryPolicy.backoffMs(retries));
      if (!this.isCurrent(p)) break;   // superseded while backing off → never retried for an obsolete turn
      const prev = x.record;
      const rec = this.newRecord(p.tc);
      rec.attempt = retries + 1; rec.retryOf = prev.toolExecutionId; rec.planNodeId = prev.planNodeId ?? null;
      rec.parallelGroup = prev.parallelGroup; rec.argumentsHash = prev.argumentsHash; rec.argumentsSummary = prev.argumentsSummary;
      x = await this.executeOnce(p, rec, executor);
    }
    return x;
  }

  private async executeOnce(p: Extract<PreparedCall, { ok: true }>, rec: ToolExecutionRecord, executor: RailwayToolExecutor): Promise<ExecutedCall> {
    rec.status = 'RUNNING'; rec.startedAt = new Date().toISOString();
    this.notify(rec, 'STARTED');
    const t0 = Date.now();
    let timedOut = false;
    const guard = { canApply: () => !timedOut && this.isCurrent(p) };
    let raw: any; let thrown: any;
    let timer: any;
    try {
      raw = await Promise.race([
        // P37: executed on the LLM-selected provider connector. P42.9: when that connector is the configured PRIMARY and
        // it fails with an ELIGIBLE fault, the backend runs the SAME request once on the configured fallback provider
        // (visible: provider / fallbackUsed / fallbackReason / providerAttempts) — Muse never picks the fallback.
        this.executeOnProvider(p, guard, executor, rec, t0),
        // P42: the composite Same Train Alternative search is bounded by its OWN engine budget (total + one call + margin)
        new Promise(res => { timer = setTimeout(() => { timedOut = true; res({ __timeout: true }); }, p.vt.name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' ? sameTrainToolTimeoutMs() : this.timeoutMs); })
      ]);
    } catch (e) { thrown = e; } finally { clearTimeout(timer); }
    const latencyMs = Date.now() - t0;
    const provider = raw?.meta?.providerId || executor.providerLabel || null;
    rec.provider = (raw?.meta?.fallbackUsed && raw?.meta?.providerId) || p.tc?.provider || provider; rec.latencyMs = latencyMs; rec.completedAt = new Date().toISOString();
    if (raw?.meta?.fallbackUsed) { rec.fallbackUsed = true; rec.fallbackReason = String(raw.meta.fallbackReason || '') || null; }

    const done = (status: ToolExecutionStatus, x: Partial<ExecutedCall>): ExecutedCall => {
      rec.status = status;
      rec.fresh = status === 'SUCCEEDED';
      rec.resultCount = x.success ? countOf(p.vt.name, x.data) : null;
      if (x.error) rec.rejectionReason = x.error.code;
      // Prompt 35: observability — data source, honest outcome, failover attempts, provider freshness (no keys, no bodies)
      const pm = raw?.meta;
      rec.dataSource = dataSourceOf(pm);
      rec.outcome = toolOutcomeOf({ ok: !!x.success, empty: !!x.empty, status, code: x.error?.code, normalizedCode: x.error?.normalized });
      if (Array.isArray(pm?.attempts)) { rec.providerAttempts = pm.attempts.map((a: any) => ({ provider: String(a.provider), attempt: Number(a.attempt), outcome: String(a.outcome), errorCode: a.errorCode ?? null, httpStatus: a.httpStatus ?? null, latencyMs: Number(a.latencyMs) || 0, retryable: !!a.retryable })); rec.fallbackUsed = !!pm.fallbackUsed; }
      if (pm?.freshness && typeof pm.freshness === 'object') rec.freshness = { ...(pm.freshness.mode ? { mode: String(pm.freshness.mode) } : {}), ...(pm.freshness.retrievedAt ? { retrievedAt: String(pm.freshness.retrievedAt) } : {}) };
      this.notify(rec, status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED');
      const out: ExecutedCall = {
        prepared: p, record: rec, success: !!x.success, empty: !!x.empty, data: x.data, error: x.error, provider,
        latencyMs, timedOut, stale: !!x.stale, result: undefined as any, dataSource: dataSourceOf(raw?.meta),
        ...(rec.providerAttempts ? { providerAttempts: rec.providerAttempts, fallbackUsed: !!rec.fallbackUsed } : {}), ...(rec.fallbackReason ? { fallbackReason: rec.fallbackReason } : {}), ...(rec.freshness ? { freshness: rec.freshness } : {})
      };
      out.result = this.toLLMResult(rec, status, {
        result: x.success ? llmView(p.vt.name, x.data) : undefined, empty: x.empty || undefined,
        error: x.error ? { code: x.error.normalized, message: x.error.message, detail: x.error.code } : undefined
      });
      return out;
    };

    if (raw && raw.__timeout) {
      // Timeout ≠ empty ≠ zero availability. The late answer (if any) is dropped by canApply.
      return done('TIMEOUT', { error: { code: timeoutCode(p.vt.name), normalized: 'TOOL_TIMEOUT', message: SAFE_ERROR_MESSAGE.TOOL_TIMEOUT } });
    }
    if (thrown) return done('FAILED', { error: { code: 'TOOL_FAILED', normalized: 'TOOL_FAILED', message: SAFE_ERROR_MESSAGE.TOOL_FAILED } });
    if (!raw || typeof raw !== 'object' || !('ok' in raw)) {
      return done('FAILED', { error: { code: 'TOOL_FAILED', normalized: 'TOOL_FAILED', message: 'Provider ka result samajh nahi aaya — jaankari verify nahi ho paayi.' } });
    }
    if (!raw.ok) {
      const code = String(raw.error?.code || 'TOOL_FAILED');
      if (code === 'STALE_TOOL_RESULT') return done('CANCELLED', { stale: true, error: { code, normalized: 'STALE_TOOL_RESULT', message: SAFE_ERROR_MESSAGE.STALE_TOOL_RESULT } });
      // Part 46: the provider explicitly returned NO trains for a search → SUCCESS with zero items.
      if (p.vt.name === 'SEARCH_TRAINS' && code === 'NO_TRAINS_FOUND') {
        const a = p.vt.arguments;
        return done('SUCCEEDED', { success: true, empty: true, data: { trains: [], origin: a.origin, destination: a.destination, date: a.date, totalCount: 0 } });
      }
      const normalized = normalizeToolErrorCode(code);
      return done(statusForError(normalized), { error: { code, normalized, message: safeErrorMessage(normalized, raw.error?.message) } });
    }
    const data = raw.data;
    // Prompt 32: malformed provider "success" → PROVIDER_DATA_INVALID (FAILED, not retried) — never empty, never a result
    if (!isWellFormedToolData(p.vt.name, data)) {
      return done('FAILED', { error: { code: 'PROVIDER_DATA_INVALID', normalized: 'PROVIDER_DATA_INVALID', message: SAFE_ERROR_MESSAGE.PROVIDER_DATA_INVALID } });
    }
    const empty = p.vt.name === 'SEARCH_TRAINS' && data.trains.length === 0;
    return done('SUCCEEDED', { success: true, empty, data: empty ? { ...(data || {}), trains: [] } : data });
  }

  /**
   * Parallel execution plan (Part 19/20): independent calls run concurrently; a SEARCH_TRAINS call is
   * a barrier (later calls may depend on its results), so each segment is validated against the
   * session AFTER the previous segment was synced.
   */
  static segments(calls: ToolCall[]): ToolCall[][] {
    const out: ToolCall[][] = [];
    let cur: ToolCall[] = [];
    for (const c of calls) {
      if (c?.name === 'SEARCH_TRAINS') {
        // P37: the SAME search on DIFFERENT providers (LLM-requested comparison) is independent → one parallel segment
        const last = out[out.length - 1];
        if (!cur.length && last && c.provider && last.every(x => x?.name === 'SEARCH_TRAINS' && x.provider && x.provider !== c.provider
          && stableJson(x.arguments || {}) === stableJson(c.arguments || {}))) { last.push(c); continue; }
        if (cur.length) out.push(cur); out.push([c]); cur = [];
      }
      else cur.push(c);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /**
   * Run one LLM round. Hooks are called in the ORIGINAL call order after each segment completes.
   * Returns 'stop' when a limit / loop rejection or a stale result ended the round.
   */
  async runRound(calls: ToolCall[], executor: RailwayToolExecutor, h: {
    fromLLM: boolean;
    /** Caller-handled accidental duplicate (already answered this turn). */
    skip?: (tc: ToolCall) => boolean;
    onRejected: (p: Extract<PreparedCall, { ok: false }>) => void;
    /** Return false to stop (e.g. the result was stale). Session sync happens here. */
    onExecuted: (x: ExecutedCall) => boolean;
    /** Prompt 25: a call whose VALIDATED request was already answered this turn (different raw args, same data). */
    skipPrepared?: (p: Extract<PreparedCall, { ok: true }>) => boolean;
    /** Identical call inside the SAME parallel segment — answered by the original's result (one provider call). */
    onDuplicate?: (tc: ToolCall, original: ExecutedCall) => void;
  }): Promise<'done' | 'stop'> {
    // Prompt 18: ToolExecutionPlan — dependency graph for this round (SEARCH → train-dependent quotes)
    const plan = buildToolExecutionPlan(calls, ++this.planRounds);
    this.plans.push(...plan);
    const nodeQueue = [...plan];
    const nodeFor = (tc: ToolCall) => { const i = nodeQueue.findIndex(n => n.callId === String(tc?.callId ?? '') && n.tool === String(tc?.name ?? '')); return i >= 0 ? nodeQueue.splice(i, 1)[0] : nodeQueue.shift(); };
    const nodeByCall = new Map<ToolCall, ToolExecutionPlanNode>();
    for (const c of calls) { const n = nodeFor(c); if (n) { nodeByCall.set(c, n); n.arguments = safeSummary((c?.arguments as any) || {}); } }
    const emptyNodes = new Set<string>();
    try { this.ctx.observer?.onPlan?.(plan); } catch { /* ignore */ }
    for (const seg of ToolTurn.segments(calls)) {
      if (this.ctx.isStale?.()) return 'stop';
      const prepared: Array<PreparedCall | null | { alias: number; tc: ToolCall }> = [];
      const inSeg = new Map<string, number>();
      let stop = false;
      for (const tc of seg) {
        if (stop) break;
        const node = nodeByCall.get(tc);
        if (h.fromLLM) { const a = this.admit(tc); if (a) { if (node) { node.status = 'REJECTED'; node.toolExecutionId = a.record.toolExecutionId; } prepared.push(a); stop = true; continue; } }
        if (h.skip?.(tc)) { if (node) node.status = 'SKIPPED_DUPLICATE'; prepared.push(null); continue; }
        const key = `${tc?.provider || ''}:${tc?.name}|${stableJson(tc?.arguments || {})}`;   // P37: per-provider identity
        const prev = inSeg.get(key);
        if (prev !== undefined && (prepared[prev] as any)?.ok) { if (node) node.status = 'SKIPPED_DUPLICATE'; prepared.push({ alias: prev, tc }); continue; }
        // a dependent call never runs before its dependency succeeded with usable results
        const unmet = node ? unsatisfiedDependency(node, plan) : null;
        if (node && (unmet || node.dependencies.some(d => emptyNodes.has(d)))) {
          const r = this.reject(tc, this.newRecord(tc), 'DEPENDENCY_NOT_SATISFIED', SAFE_ERROR_MESSAGE.DEPENDENCY_NOT_SATISFIED) as Extract<PreparedCall, { ok: false }>;
          r.record.planNodeId = node.planNodeId;
          node.status = 'BLOCKED'; node.toolExecutionId = r.record.toolExecutionId;
          prepared.push(r);
          continue;
        }
        const p = this.prepare(tc, h.fromLLM, true);
        if (p.ok && h.skipPrepared?.(p)) {
          // never re-fetch identical data inside one turn (not a cache: the next turn always calls the provider)
          p.record.status = 'CANCELLED'; p.record.rejectionReason = 'DUPLICATE_CALL'; p.record.completedAt = new Date().toISOString();
          if (node) { node.toolExecutionId = p.record.toolExecutionId; p.record.planNodeId = node.planNodeId; node.status = 'SKIPPED_DUPLICATE'; }
          prepared.push(null);
          continue;
        }
        if (node) { node.toolExecutionId = p.record.toolExecutionId; p.record.planNodeId = node.planNodeId; if (!p.ok) node.status = 'REJECTED'; else node.status = 'RUNNING'; }
        if (p.ok) inSeg.set(key, prepared.length);
        prepared.push(p);
        if (!p.ok && p.stop) stop = true;
      }
      const runnable = prepared.filter((p): p is Extract<PreparedCall, { ok: true }> => !!p && 'ok' in p && p.ok);
      const group = runnable.length > 1 ? ++this.parallelGroup : null;
      for (const p of runnable) p.record.parallelGroup = group;
      const executed = await Promise.all(runnable.map(p => this.execute(p, executor)));
      const byIndex = new Map<number, ExecutedCall>();
      let k = 0;
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        if (!p) continue;
        if ('alias' in p) { const orig = byIndex.get(p.alias); if (orig && !orig.stale) h.onDuplicate?.(p.tc, orig); continue; }
        if (!p.ok) { h.onRejected(p); continue; }
        const x = executed[k++];
        byIndex.set(i, x);
        // Prompt 27: remember a provider failure of this validated call (bounded LLM retry, see prepare)
        if (h.fromLLM && p.failSig && !x.success && !x.stale) {
          const prev = this.failedSigs.get(p.failSig);
          // count provider ATTEMPTS (a backend retry already used the one meaningful retry → identical call not re-sent)
          this.failedSigs.set(p.failSig, { code: String(x.error?.normalized || x.error?.code || 'TOOL_FAILED'), count: (prev?.count || 0) + Math.max(1, x.record.attempt || 1) });
        }
        const node = nodeByCall.get(p.tc);
        if (node) {
          node.toolExecutionId = x.record.toolExecutionId;
          node.status = x.stale ? 'CANCELLED' : x.success ? 'SUCCEEDED' : 'FAILED';
          if (x.success && x.empty) emptyNodes.add(node.planNodeId);
        }
        if (!h.onExecuted(x)) { if (node && node.status === 'SUCCEEDED') node.status = 'CANCELLED'; return 'stop'; }
      }
      if (stop) return 'stop';
    }
    return 'done';
  }

  /**
   * Per-turn budget + loop admission for an LLM-requested call (counted BEFORE caller de-duplication,
   * so an accidental repeat still advances the loop detector). Returns a rejection or null.
   */
  admit(tc: ToolCall): Extract<PreparedCall, { ok: false }> | null {
    this.llmCalls++;
    if (this.llmCalls > this.maxCalls) return this.reject(tc, this.newRecord(tc), 'TOOL_CALL_LIMIT_EXCEEDED', SAFE_ERROR_MESSAGE.TOOL_CALL_LIMIT_EXCEEDED, true) as any;
    const sig = this.loopSignature(tc);
    const n = (this.sigCounts.get(sig) || 0) + 1;
    this.sigCounts.set(sig, n);
    // Prompt 25: a loop of INVALID calls ends with a clarification for the user (there is no verified result to keep)
    if (n >= this.loopThreshold) return this.reject(tc, this.newRecord(tc), 'TOOL_LOOP_DETECTED', this.invalidSigs.get(sig)?.clarify || SAFE_ERROR_MESSAGE.TOOL_LOOP_DETECTED, true) as any;
    return null;
  }

  /**
   * P42.9: execute on the LLM-named connector; RailCore (configured primary) → RailRadar (configured fallback) ONLY for an
   * eligible fault (RATE_LIMITED / PROVIDER_UNAVAILABLE / TIMEOUT), never for INVALID_* / NOT_FOUND / user-input errors,
   * never when the primary succeeded. Sequential: the primary call has completed before the fallback starts, so a late
   * primary answer can never overwrite the fallback answer. Same tool, same validated arguments, one attempt each.
   */
  private async executeOnProvider(p: Extract<PreparedCall, { ok: true }>, guard: { canApply: () => boolean }, executor: RailwayToolExecutor, rec: ToolExecutionRecord, t0: number): Promise<any> {
    const primary = p.tc?.provider;
    if (!primary || !fallbackProviderFor(primary, p.vt.name)) return inProviderScope(primary, () => executor.execute(p.vt, guard));
    const o = await runWithProviderFallback<any>({
      primary, capability: p.vt.name,
      call: prov => inProviderScope(prov, () => executor.execute(p.vt, guard)).catch(() => ({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } })),
      errorCodeOf: r => (r && typeof r === 'object' && 'ok' in r && !r.ok ? String(r.error?.code || 'TOOL_FAILED') : null),
      rateLimitLocalOf: r => r?.meta?.rateLimit?.local,
      // only while this call is still current and the runtime budget leaves room for one more bounded attempt
      canFallback: () => guard.canApply() && this.timeoutMs - (Date.now() - t0) > Math.min(2500, this.timeoutMs / 2),
      log: (event, fields) => { try { console.info(JSON.stringify({ event, ...fields })); } catch { /* never throws */ } },
      context: { tool: p.vt.name, toolExecutionId: rec.toolExecutionId, requestId: rec.requestId }
    });
    if (!o.fallbackUsed) return o.result;
    const r = o.result && typeof o.result === 'object' ? o.result : { ok: false, error: { code: 'TOOL_FAILED' } };
    const outcomeOf = (a: { status: string; errorCode: string | null }) => (a.status === 'SUCCESS' ? 'DATA' : a.errorCode === 'TIMEOUT' || a.errorCode === 'TOOL_TIMEOUT' || a.errorCode === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_FAILURE');
    return { ...r, meta: { ...(r.meta || {}), providerId: o.served, fallbackUsed: true, fallbackReason: o.fallbackReason,
      attempts: o.attempts.map(a => ({ provider: a.provider, attempt: a.attempt, outcome: outcomeOf(a), errorCode: a.errorCode, httpStatus: null, latencyMs: a.latencyMs, retryable: isFallbackEligible(a.errorCode) })) } };
  }

  toLLMResult(rec: ToolExecutionRecord, status: ToolExecutionStatus, x: { result?: unknown; empty?: boolean; error?: LLMToolResult['error'] }): LLMToolResult {
    return {
      toolExecutionId: rec.toolExecutionId, tool: rec.tool, status, fresh: status === 'SUCCEEDED',
      ...(x.result !== undefined ? { result: x.result } : {}), ...(x.empty ? { empty: true } : {}), ...(x.error ? { error: x.error } : {}),
      meta: {
        toolExecutionId: rec.toolExecutionId, requestId: rec.requestId, provider: rec.provider, fetchedAt: rec.completedAt || new Date().toISOString(),
        fresh: status === 'SUCCEEDED', source: status === 'SUCCEEDED' ? 'RAILWAY_PROVIDER' : 'NONE', journeyVersion: rec.journeyVersion
      }
    };
  }
}

function timeoutCode(tool: string): string {
  if (tool === 'CHECK_PNR') return 'PNR_PROVIDER_TIMEOUT';
  if (tool === 'TRACK_TRAIN') return 'LIVE_STATUS_TIMEOUT';
  return 'TOOL_TIMEOUT';
}
function countOf(tool: string, data: any): number {
  if (tool === 'SEARCH_TRAINS') return Array.isArray(data?.trains) ? data.trains.length : 0;
  if (tool === 'GET_TIMETABLE') return Array.isArray(data?.stops) ? data.stops.length : (data ? 1 : 0);
  return data ? 1 : 0;
}
/** Provider-independent view for the LLM (PNR masked; never raw provider payloads beyond normalized data). */
function llmView(tool: string, data: any): any {
  if (tool === 'CHECK_PNR' && data) return { ...data, pnr: maskPnr(data.pnr) };
  return data;
}

export type { RailwayToolName };
