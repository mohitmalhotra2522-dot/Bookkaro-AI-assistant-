/**
 * PROMPT 17 — RailwayToolRegistry (Parts 2 + 3).
 *
 * Closed, deterministic registry of the railway tools the LLM may REQUEST. Every entry carries its
 * capability, input schema, freshness policy, allowed states, provider route and whether it is
 * implemented / LLM-callable. A tool that is not implemented returns TOOL_NOT_IMPLEMENTED — it never
 * fabricates a result. A name outside the enum is UNKNOWN_TOOL; a backend-controlled action
 * (booking / cancel / refund / payment / login / OTP / CAPTCHA) is FORBIDDEN_ACTION.
 *
 * The input schemas are DERIVED from REGISTERED_TOOLS (the definitions actually shown to the LLM), so
 * the two can never drift apart.
 */
import { REGISTERED_TOOLS, type ToolDefinition, type ToolParam } from '../tools/tool-registry';
import {
  RailwayToolName, RAILWAY_TOOL_NAMES, FORBIDDEN_LLM_ACTIONS, type FreshnessPolicy
} from '@shared/railway-tool-runtime';
import { BookingState, EXECUTION_LOCKED_STATES } from '@shared/states';

export type ToolCapability = 'SEARCH' | 'TRAIN_INFO' | 'TIMETABLE' | 'AVAILABILITY' | 'FARE' | 'LIVE_STATUS' | 'PNR_STATUS' | 'CANCELLED_TRAINS' | 'GENERAL_INFO';
/** Which existing backend component executes the tool (the LLM never picks a provider). */
export type ProviderRoute = 'RailwaySearchOrchestrator' | 'RailwayToolService' | 'LiveTrainStatusService' | 'PnrStatusService' | 'NONE';

export interface RailwayToolMetadata {
  name: RailwayToolName;
  description: string;
  capability: ToolCapability;
  inputSchema: { fields: Record<string, ToolParam>; required: string[]; additionalProperties: false };
  freshnessPolicy: FreshnessPolicy;
  /** States in which the tool may run ('ANY' = read-only lookup, valid everywhere). */
  allowedStates: 'ANY' | BookingState[];
  providerRoute: ProviderRoute;
  enabled: boolean;
  /** Shown to the LLM in the tool list. */
  llmCallable: boolean;
  /** Has an authoritative provider-backed implementation. */
  implemented: boolean;
  /** True when the tool needs a resolved train (dependency ordering for parallel execution). */
  dependsOnSelection: boolean;
}

const schemaOf = (d: ToolDefinition | undefined): RailwayToolMetadata['inputSchema'] => ({
  fields: { ...(d?.parameters || {}) },
  required: Object.entries(d?.parameters || {}).filter(([, p]) => p.required).map(([k]) => k),
  additionalProperties: false
});
const def = (n: string) => REGISTERED_TOOLS.find(t => t.name === n);

/** Selection-dependent quotes are never requested while a booking execution is locked in flight. */
const QUOTE_STATES: BookingState[] = (Object.values(BookingState) as BookingState[]).filter(st => !EXECUTION_LOCKED_STATES.has(st));

const entries: RailwayToolMetadata[] = [
  { name: 'SEARCH_TRAINS', capability: 'SEARCH', providerRoute: 'RailwaySearchOrchestrator', dependsOnSelection: false },
  { name: 'GET_TRAIN_INFO', capability: 'TRAIN_INFO', providerRoute: 'RailwayToolService', dependsOnSelection: false },
  { name: 'GET_TIMETABLE', capability: 'TIMETABLE', providerRoute: 'RailwayToolService', dependsOnSelection: false },
  { name: 'CHECK_AVAILABILITY', capability: 'AVAILABILITY', providerRoute: 'RailwayToolService', dependsOnSelection: true, allowedStates: QUOTE_STATES },
  { name: 'GET_FARE', capability: 'FARE', providerRoute: 'RailwayToolService', dependsOnSelection: true, allowedStates: QUOTE_STATES },
  { name: 'TRACK_TRAIN', capability: 'LIVE_STATUS', providerRoute: 'LiveTrainStatusService', dependsOnSelection: false },
  { name: 'CHECK_PNR', capability: 'PNR_STATUS', providerRoute: 'PnrStatusService', dependsOnSelection: false }
].map((e: any) => {
  const d = def(e.name);
  return Object.freeze({
    name: e.name, description: d?.description || '', capability: e.capability,
    inputSchema: schemaOf(d), freshnessPolicy: 'ALWAYS_FRESH' as const,
    allowedStates: e.allowedStates || 'ANY', providerRoute: e.providerRoute,
    enabled: true, llmCallable: true, implemented: !!d, dependsOnSelection: e.dependsOnSelection
  });
});

// Approved but NOT implemented: the Phase-1 RailwayProvider interface has no cancelled-trains endpoint,
// and a "general answer" is not a live-data tool. Both answer TOOL_NOT_IMPLEMENTED — never fake data.
entries.push(Object.freeze({
  name: 'GET_CANCELLED_TRAINS', description: 'Cancelled trains from the railway provider (not available in Phase 1).',
  capability: 'CANCELLED_TRAINS', inputSchema: { fields: {}, required: [], additionalProperties: false },
  freshnessPolicy: 'ALWAYS_FRESH', allowedStates: 'ANY', providerRoute: 'NONE', enabled: false, llmCallable: false, implemented: false, dependsOnSelection: false
}) as RailwayToolMetadata);
entries.push(Object.freeze({
  name: 'GENERAL_RAILWAY_ANSWER', description: 'General railway guidance only — never live trains, timings, availability, fare, PNR or status.',
  capability: 'GENERAL_INFO', inputSchema: { fields: {}, required: [], additionalProperties: false },
  freshnessPolicy: 'NOT_APPLICABLE', allowedStates: 'ANY', providerRoute: 'NONE', enabled: false, llmCallable: false, implemented: false, dependsOnSelection: false
}) as RailwayToolMetadata);

export const RAILWAY_TOOL_REGISTRY: ReadonlyMap<RailwayToolName, RailwayToolMetadata> = new Map(entries.map(e => [e.name, e]));

export type ToolNameResolution =
  | { kind: 'TOOL'; name: RailwayToolName; meta: RailwayToolMetadata }
  | { kind: 'FORBIDDEN'; name: string }
  | { kind: 'UNKNOWN'; name: string };

/** Strict lookup: exact enum match only (no case folding, no fuzzy matching, no dynamic dispatch). */
export function resolveToolName(raw: unknown): ToolNameResolution {
  const name = typeof raw === 'string' ? raw : String(raw ?? '');
  if ((FORBIDDEN_LLM_ACTIONS as readonly string[]).includes(name.trim().toUpperCase())) return { kind: 'FORBIDDEN', name };
  if (!(RAILWAY_TOOL_NAMES as readonly string[]).includes(name)) return { kind: 'UNKNOWN', name };
  const meta = RAILWAY_TOOL_REGISTRY.get(name as RailwayToolName)!;
  return { kind: 'TOOL', name: name as RailwayToolName, meta };
}

export function llmCallableTools(): RailwayToolMetadata[] {
  return [...RAILWAY_TOOL_REGISTRY.values()].filter(m => m.enabled && m.llmCallable && m.implemented);
}

export function isStateAllowed(meta: RailwayToolMetadata, state: BookingState): boolean {
  return meta.allowedStates === 'ANY' || meta.allowedStates.includes(state);
}

export { RailwayToolName };
