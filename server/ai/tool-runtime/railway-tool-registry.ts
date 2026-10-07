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
import { SAME_TRAIN_TOOL_NAMES, type SameTrainToolName } from '@shared/same-train-alternatives';

export type ToolCapability = 'SEARCH' | 'TRAIN_INFO' | 'TIMETABLE' | 'AVAILABILITY' | 'FARE' | 'LIVE_STATUS' | 'PNR_STATUS' | 'CANCELLED_TRAINS' | 'GENERAL_INFO' | 'WEB_RESEARCH'
  | 'SAME_TRAIN_ALTERNATIVES' | 'SAME_TRAIN_PRESENTATION';
/** Which existing backend component executes the tool (the LLM never picks a provider). */
export type ProviderRoute = 'RailwaySearchOrchestrator' | 'RailwayToolService' | 'LiveTrainStatusService' | 'PnrStatusService' | 'WebResearchService' | 'SameTrainAlternativeService' | 'NONE';

export interface RailwayToolMetadata {
  name: RailwayToolName | SameTrainToolName;
  description: string;
  capability: ToolCapability;
  inputSchema: { fields: Record<string, ToolParam>; required: string[]; additionalProperties: false };
  /** Required input fields (mirror of inputSchema.required — missing ⇒ ask the user, never call the provider). */
  requiredFields: readonly string[];
  /** Shape of the NormalizedRailwayResult returned to the LLM (provider-specific shapes never reach it). */
  outputSchema: ToolOutputSchema;
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

/** Normalized result contract per tool (Part 1 / Part 18). Every result also carries LLMToolResult metadata:
 *  toolExecutionId, status, fresh, fetchedAt, provider, requestId. */
export interface ToolOutputSchema { resultType: string; fields: readonly string[]; source: 'RAILWAY_PROVIDER' | 'WEB_EXTERNAL' | 'NONE' }
const OUT = (resultType: string, fields: string[]): ToolOutputSchema => Object.freeze({ resultType, fields: Object.freeze(fields), source: 'RAILWAY_PROVIDER' as const });
export const TOOL_OUTPUT_SCHEMAS: Readonly<Record<RailwayToolName, ToolOutputSchema>> = Object.freeze({
  SEARCH_TRAINS: OUT('NormalizedTrainSearchResult', ['resultId', 'origin', 'destination', 'date', 'trains[]{trainNumber,trainName,departure,arrival,duration,classes[]}']),
  GET_TRAIN_INFO: OUT('NormalizedTrainInfo', ['trainNumber', 'trainName', 'origin', 'destination', 'runningDays', 'classes[]']),
  GET_TIMETABLE: OUT('NormalizedTimetable', ['trainNumber', 'stops[]{stationCode,arrival,departure,day}']),
  CHECK_AVAILABILITY: OUT('NormalizedAvailability', ['trainNumber', 'travelClass', 'date', 'status', 'count']),
  GET_FARE: OUT('NormalizedFare', ['trainNumber', 'travelClass', 'passengersCount', 'perPassenger', 'total', 'currency']),
  TRACK_TRAIN: OUT('NormalizedLiveStatus', ['trainNumber', 'currentStatus', 'currentStationCode', 'delayMinutes']),
  CHECK_PNR: OUT('NormalizedPnrStatus', ['pnr(masked in logs)', 'status', 'chartStatus', 'passengers[]{number,bookingStatus,currentStatus}']),
  GET_CANCELLED_TRAINS: OUT('NormalizedCancelledTrains', ['date', 'trains[]{trainNumber,trainName,cancellationType}']),
  GENERAL_RAILWAY_ANSWER: Object.freeze({ resultType: 'NotApplicable', fields: Object.freeze([]), source: 'NONE' as const }),
  WEB_RAILWAY_RESEARCH: Object.freeze({ resultType: 'WebResearchResult', fields: Object.freeze(['query', 'dataSource=WEB_EXTERNAL', 'authority=NOT_AUTHORITATIVE', 'results[]{title,url,domain,sourceTier,snippet}']), source: 'WEB_EXTERNAL' as const })
});

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
    inputSchema: schemaOf(d), requiredFields: Object.freeze(schemaOf(d).required), outputSchema: TOOL_OUTPUT_SCHEMAS[e.name as RailwayToolName],
    freshnessPolicy: 'ALWAYS_FRESH' as const,
    allowedStates: e.allowedStates || 'ANY', providerRoute: e.providerRoute,
    enabled: true, llmCallable: true, implemented: !!d, dependsOnSelection: e.dependsOnSelection
  });
});

// Approved but NOT implemented: the Phase-1 RailwayProvider interface has no cancelled-trains endpoint,
// and a "general answer" is not a live-data tool. Both answer TOOL_NOT_IMPLEMENTED — never fake data.
entries.push(Object.freeze({
  name: 'GET_CANCELLED_TRAINS', description: 'Cancelled trains from the railway provider (not available in Phase 1).',
  capability: 'CANCELLED_TRAINS', inputSchema: { fields: {}, required: [], additionalProperties: false }, requiredFields: [], outputSchema: TOOL_OUTPUT_SCHEMAS.GET_CANCELLED_TRAINS,
  freshnessPolicy: 'ALWAYS_FRESH', allowedStates: 'ANY', providerRoute: 'NONE', enabled: false, llmCallable: false, implemented: false, dependsOnSelection: false
}) as RailwayToolMetadata);
entries.push(Object.freeze({
  name: 'GENERAL_RAILWAY_ANSWER', description: 'General railway guidance only — never live trains, timings, availability, fare, PNR or status.',
  capability: 'GENERAL_INFO', inputSchema: { fields: {}, required: [], additionalProperties: false }, requiredFields: [], outputSchema: TOOL_OUTPUT_SCHEMAS.GENERAL_RAILWAY_ANSWER,
  freshnessPolicy: 'NOT_APPLICABLE', allowedStates: 'ANY', providerRoute: 'NONE', enabled: false, llmCallable: false, implemented: false, dependsOnSelection: false
}) as RailwayToolMetadata);

// Prompt 35: WEB_EXTERNAL research — enabled / LLM-callable only when configured (definition present).
{
  const d = def('WEB_RAILWAY_RESEARCH');
  entries.push(Object.freeze({
    name: 'WEB_RAILWAY_RESEARCH', description: d?.description || 'Web research (disabled — not configured).',
    capability: 'WEB_RESEARCH', inputSchema: schemaOf(d), requiredFields: Object.freeze(schemaOf(d).required), outputSchema: TOOL_OUTPUT_SCHEMAS.WEB_RAILWAY_RESEARCH,
    freshnessPolicy: 'ALWAYS_FRESH', allowedStates: 'ANY', providerRoute: 'WebResearchService', enabled: !!d, llmCallable: !!d, implemented: !!d, dependsOnSelection: false
  }) as RailwayToolMetadata);
}

export const RAILWAY_TOOL_REGISTRY: ReadonlyMap<RailwayToolName, RailwayToolMetadata> = new Map(entries.map(e => [e.name as RailwayToolName, e]));

/**
 * Prompt 42 — composite tools (Same Train Alternative). A separate closed set next to the Prompt-17 enum (which stays
 * unchanged): exact-name match only, enabled / LLM-callable only when the definition is registered
 * (SAME_TRAIN_ALTERNATIVES_ENABLED). Allowed in every state except a locked booking execution.
 */
export const COMPOSITE_TOOL_REGISTRY: ReadonlyMap<SameTrainToolName, RailwayToolMetadata> = new Map(SAME_TRAIN_TOOL_NAMES.map(name => {
  const d = def(name);
  const meta: RailwayToolMetadata = Object.freeze({
    name, description: d?.description || 'Same Train Alternative (disabled — not configured).',
    capability: name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' ? 'SAME_TRAIN_ALTERNATIVES' as const : 'SAME_TRAIN_PRESENTATION' as const,
    inputSchema: schemaOf(d), requiredFields: Object.freeze(schemaOf(d).required),
    outputSchema: Object.freeze({ resultType: name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' ? 'SameTrainAlternativesResult' : 'SameTrainPresentation',
      fields: Object.freeze(name === 'SEARCH_SAME_TRAIN_ALTERNATIVES'
        ? ['alternativeSearchId', 'route{trainOrigin,trainTerminal,originSweep[],destinationExtension[]}', 'alternatives[]{alternativeId,ticketOrigin,ticketDestination,availability,verificationStatus,boardingRuleStatus,alightingRuleStatus,fare,evidence[]}', 'providers[]', 'status', 'errors[]']
        : ['alternativeSearchId', 'bestMatchId', 'order[]']),
      source: name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' ? 'RAILWAY_PROVIDER' as const : 'NONE' as const }),
    freshnessPolicy: (name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' ? 'ALWAYS_FRESH' : 'NOT_APPLICABLE') as FreshnessPolicy,
    allowedStates: QUOTE_STATES, providerRoute: name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' ? 'SameTrainAlternativeService' as const : 'NONE' as const,
    enabled: !!d, llmCallable: !!d, implemented: !!d, dependsOnSelection: false
  });
  return [name, meta] as const;
}));

export type ToolNameResolution =
  | { kind: 'TOOL'; name: RailwayToolName | SameTrainToolName; meta: RailwayToolMetadata }
  | { kind: 'FORBIDDEN'; name: string }
  | { kind: 'UNKNOWN'; name: string };

/** Strict lookup: exact enum match only (no case folding, no fuzzy matching, no dynamic dispatch). */
export function resolveToolName(raw: unknown): ToolNameResolution {
  const name = typeof raw === 'string' ? raw : String(raw ?? '');
  if ((FORBIDDEN_LLM_ACTIONS as readonly string[]).includes(name.trim().toUpperCase())) return { kind: 'FORBIDDEN', name };
  const composite = COMPOSITE_TOOL_REGISTRY.get(name as SameTrainToolName);
  if (composite) return { kind: 'TOOL', name: name as SameTrainToolName, meta: composite };
  if (!(RAILWAY_TOOL_NAMES as readonly string[]).includes(name)) return { kind: 'UNKNOWN', name };
  const meta = RAILWAY_TOOL_REGISTRY.get(name as RailwayToolName)!;
  return { kind: 'TOOL', name: name as RailwayToolName, meta };
}

export function llmCallableTools(): RailwayToolMetadata[] {
  return [...RAILWAY_TOOL_REGISTRY.values(), ...COMPOSITE_TOOL_REGISTRY.values()].filter(m => m.enabled && m.llmCallable && m.implemented);
}

export function isStateAllowed(meta: RailwayToolMetadata, state: BookingState): boolean {
  return meta.allowedStates === 'ANY' || meta.allowedStates.includes(state);
}

export { RailwayToolName };
