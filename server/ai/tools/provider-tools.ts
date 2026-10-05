/**
 * P37 — LLM-NATIVE DIRECT MULTI-PROVIDER RAILWAY TOOLS.
 *
 * The LLM is the railway agent: it sees PROVIDER-LEVEL tools (`railcore_search`, `railradar_availability`, …) and
 * decides which provider(s) to call, whether to call several in parallel, and whether to try another provider after a
 * failure. This module is only the catalog + name mapping for the secure generic gateway:
 *
 *   - a tool is exposed ONLY for a registered connector that is implemented, configured (server-side key present) and
 *     declares the capability (documented endpoint). No fake provider tools — ConfirmTkt has no allowed integration,
 *     so it is never exposed; a call returns PROVIDER_NOT_IMPLEMENTED. P38: eRail / RailYatri are WEB connectors
 *     (robots-allowed public pages, results labelled UNVERIFIED_WEB).
 *   - `railcore_search` maps to the canonical, already-validated tool contract (SEARCH_TRAINS) + provider `railcore`.
 *     The gateway then executes it on THAT connector only (provider scope) — it never picks, re-orders or switches the
 *     provider and never chains another tool.
 *
 * Credentials never appear here: connectors read their own keys server-side; the LLM sees names, descriptions and
 * structured results only.
 */
import type { RegisteredToolName, ToolDefinition, ToolParam } from './tool-registry';
import { runWithProvider } from '../../railway/providers/provider-scope';

/** Canonical railway tool contract → provider tool suffix (one provider tool per declared capability). */
export const PROVIDER_TOOL_SUFFIX: Readonly<Partial<Record<RegisteredToolName, string>>> = Object.freeze({
  SEARCH_TRAINS: 'search',
  GET_TRAIN_INFO: 'train_info',
  GET_TIMETABLE: 'timetable',
  CHECK_AVAILABILITY: 'availability',
  GET_FARE: 'fare',
  TRACK_TRAIN: 'live_status',
  CHECK_PNR: 'pnr'
});
const SUFFIX_TO_CANONICAL = new Map(Object.entries(PROVIDER_TOOL_SUFFIX).map(([k, v]) => [v as string, k as RegisteredToolName]));
/** Extra suffixes the brief names; no RailwayProvider contract exists for them → never exposed. */
const KNOWN_UNEXPOSED_SUFFIXES = new Set(['cancelled_trains', 'status']);

/** Providers named in the product brief WITHOUT an implemented / authorized integration (never exposed).
 *  P38: eRail + RailYatri now have robots-allowed WEB connectors (unverified, live mode only); ConfirmTkt stays out
 *  (robots.txt disallows its train / PNR pages, private token API). */
export const NOT_IMPLEMENTED_PROVIDERS: readonly string[] = Object.freeze(['confirmtkt']);

export interface ProviderConnectorInfo {
  /** Tool prefix + provider id the LLM sees (`railcore`). */
  id: string;
  /** Human label used in tool descriptions (`RailCore`). */
  label: string;
  /** railwayRegistry entry that executes it (`railcore` live adapter, `mock-railcore` in tests). */
  registryId: string;
  /** Canonical tool contracts this connector really implements. */
  capabilities: readonly RegisteredToolName[];
  /** Short, factual coverage note for the LLM (no ranking, no instruction to prefer it). */
  note?: string;
}

export type ProviderToolResolution =
  | { kind: 'PROVIDER_TOOL'; provider: string; canonical: RegisteredToolName; registryId: string }
  | { kind: 'NOT_IMPLEMENTED'; provider: string; requested: string }
  | { kind: 'UNSUPPORTED'; provider: string; requested: string };

class ProviderToolCatalog {
  private readonly connectors = new Map<string, ProviderConnectorInfo>();

  register(info: ProviderConnectorInfo): void {
    if (NOT_IMPLEMENTED_PROVIDERS.includes(info.id)) throw new Error(`${info.id} has no authorized integration`);
    this.connectors.set(info.id, Object.freeze({ ...info, capabilities: Object.freeze([...info.capabilities]) }));
  }
  unregister(id: string): void { this.connectors.delete(id); }
  clear(): void { this.connectors.clear(); }
  list(): ProviderConnectorInfo[] { return [...this.connectors.values()]; }
  get(id: string): ProviderConnectorInfo | undefined { return this.connectors.get(id); }
  /** Provider-tool mode is on when at least one connector is registered (live mode / provider tests). */
  enabled(): boolean { return this.connectors.size > 0; }
  /** First registered connector (configured order) — used ONLY for backend booking re-validation, never for LLM calls. */
  defaultProvider(): string | null { return this.connectors.keys().next().value ?? null; }

  /** Exact provider-tool name → canonical contract + provider. null = not a provider-tool name. */
  resolve(name: unknown): ProviderToolResolution | null {
    const n = typeof name === 'string' ? name : '';
    const m = /^([a-z][a-z0-9]*)_([a-z_]+)$/.exec(n);
    if (!m) return null;
    const [, provider, suffix] = m;
    const canonical = SUFFIX_TO_CANONICAL.get(suffix);
    if (NOT_IMPLEMENTED_PROVIDERS.includes(provider)) return { kind: 'NOT_IMPLEMENTED', provider, requested: n };
    const c = this.connectors.get(provider);
    if (!c) return canonical || KNOWN_UNEXPOSED_SUFFIXES.has(suffix) ? { kind: 'NOT_IMPLEMENTED', provider, requested: n } : null;
    if (!canonical || !c.capabilities.includes(canonical)) return { kind: 'UNSUPPORTED', provider, requested: n };
    return { kind: 'PROVIDER_TOOL', provider, canonical, registryId: c.registryId };
  }

  /** Provider tool name for a canonical contract (`railcore` + SEARCH_TRAINS → `railcore_search`). */
  toolName(provider: string, canonical: RegisteredToolName): string | null {
    const s = PROVIDER_TOOL_SUFFIX[canonical];
    return s ? `${provider}_${s}` : null;
  }

  /**
   * Tool definitions shown to the LLM in provider-tool mode: one provider tool per (connector × implemented capability)
   * derived from the canonical definitions (same parameters, validated by the same validator), plus every non-railway
   * tool unchanged (e.g. WEB_RAILWAY_RESEARCH when configured). Canonical railway tools are NOT shown.
   */
  definitions(base: readonly ToolDefinition[]): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const c of this.connectors.values()) {
      for (const canonical of c.capabilities) {
        const d = base.find(t => t.name === canonical);
        const name = this.toolName(c.id, canonical);
        if (!d || !name) continue;
        out.push({ ...d, name: name as RegisteredToolName, description: providerDescription(c, canonical, d), parameters: providerParams(canonical, d.parameters) });
      }
    }
    for (const d of base) if (!PROVIDER_TOOL_SUFFIX[d.name]) out.push(d);
    return out;
  }
}

export const providerToolCatalog = new ProviderToolCatalog();

const WHAT: Partial<Record<RegisteredToolName, string>> = {
  SEARCH_TRAINS: 'trains between two stations on a date',
  GET_TRAIN_INFO: 'details of one train',
  GET_TIMETABLE: 'station-wise timetable of one train',
  CHECK_AVAILABILITY: 'live seat availability for the selected train + class on the journey date',
  GET_FARE: 'current fare for the selected train + class',
  TRACK_TRAIN: 'live running status of a train',
  CHECK_PNR: 'PNR status (read-only)'
};

function providerDescription(c: ProviderConnectorInfo, canonical: RegisteredToolName, d: ToolDefinition): string {
  return `${c.label} (railway data provider): ${WHAT[canonical] || d.description}. Calls ${c.label} ONLY — if it fails, the error comes back to you `
    + `and you decide whether to try another provider tool.${c.note ? ` ${c.note}` : ''} ${d.description}`.slice(0, 900);
}

/** Provider tools take canonical values decided by the LLM (station codes, ISO dates) — no raw-words date resolver. */
function providerParams(canonical: RegisteredToolName, params: Record<string, ToolParam>): Record<string, ToolParam> {
  const p: Record<string, ToolParam> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'dateExpression') continue;
    if (k === 'origin' || k === 'destination') {
      p[k] = { ...v, description: `Official Indian Railways station code of the ${k} (e.g. ASR = Amritsar Jn, NDLS = New Delhi, LDH = Ludhiana Jn, JUC = Jalandhar City, CDG = Chandigarh). Understand the station from ANY language or script (Hindi / Devanagari, Hinglish, English) and pass its code. If the user's place has several major stations and it matters, ask instead of guessing.` };
    } else if (k === 'date') {
      p[k] = { ...v, description: `Journey date as YYYY-MM-DD. You compute it from the user's words (aaj / kal / parso / "5 October" / "5 अक्टूबर" / next Monday) using "today" in the session context.` };
    } else p[k] = v;
  }
  return p;
}

/** Execute `fn` bound to the connector of `provider` (no scope when provider-tool mode is off / unknown provider). */
export function inProviderScope<T>(provider: string | undefined | null, fn: () => Promise<T>): Promise<T> {
  const c = provider ? providerToolCatalog.get(provider) : undefined;
  return c ? runWithProvider(c.registryId, fn) : fn();
}

/**
 * Normalized provider status returned to the LLM next to every provider result (Part 21). Success with zero items is
 * NO_RESULTS (a valid answer) — never a failure; a timeout is never "no trains" / "0 availability".
 */
export type ProviderStatus = 'SUCCESS' | 'NO_RESULTS' | 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' | 'AUTH_ERROR'
  | 'INVALID_REQUEST' | 'DATA_UNAVAILABLE' | 'PROVIDER_NOT_IMPLEMENTED' | 'UNKNOWN';

export function providerStatusOf(r: { ok: boolean; empty?: boolean; error?: { code?: string } | null }): ProviderStatus {
  if (r.ok) return r.empty ? 'NO_RESULTS' : 'SUCCESS';
  const c = String(r.error?.code || '').toUpperCase();
  if (c === 'PROVIDER_NOT_IMPLEMENTED' || c === 'TOOL_NOT_IMPLEMENTED' || c === 'NOT_CONFIGURED') return 'PROVIDER_NOT_IMPLEMENTED';
  if (/TIMEOUT|TIMED_OUT/.test(c)) return 'PROVIDER_TIMEOUT';
  if (/RATE_?LIMIT|TOO_MANY/.test(c)) return 'RATE_LIMITED';
  if (/AUTH|UNAUTHORI[SZ]ED|API_KEY|FORBIDDEN_PROVIDER/.test(c)) return 'AUTH_ERROR';
  if (c === 'NO_TRAINS_FOUND' || c === 'NOT_FOUND' || c === 'NO_RESULTS' || c === 'EMPTY_RESULT') return 'NO_RESULTS';
  if (c === 'PROVIDER_UNAVAILABLE' || /PROVIDER_(ERROR|DOWN)|PROVIDER_DATA_INVALID/.test(c)) return 'PROVIDER_UNAVAILABLE';
  if (/_UNAVAILABLE$|NOT_AVAILABLE$/.test(c)) return 'DATA_UNAVAILABLE';
  if (/^INVALID_|^MISSING_|^AMBIGUOUS_|TRAIN_NOT_IN_RESULTS|PROVIDER_TOOL_REQUIRED|AUTHORITATIVE_DATA_REQUIRED/.test(c)) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}
