/**
 * PROMPT 42 — Same Train Alternative service: binds the pure engine to the existing railway architecture.
 *
 *   - providers: ONLY connectors registered in the ProviderToolCatalog with CHECK_AVAILABILITY (RailCore, RailRadar, or
 *     their MOCK test connectors). Muse may restrict / choose them; an unknown or web-only id is rejected. Without
 *     provider-tool mode (canonical / dev mode) the single active registry provider is used.
 *   - every provider call runs inside that connector's provider scope (AsyncLocalStorage — parallel-safe, no failover).
 *   - web evidence: robots-allowed web connectors with SEARCH_TRAINS only ("is this train listed between X and Y?"),
 *     always UNVERIFIED_WEB, never availability.
 *   - no cache anywhere: every call is a fresh provider request.
 */
import { providerToolCatalog, inProviderScope } from '../../ai/tools/provider-tools';
import { railwayRegistry } from '../registry/provider-registry';
import { RailwayToolService } from '../tools/railway-tool-service';
import { WEB_PROVIDER_IDS } from '../providers/web/web-providers';
import { evaluateSeatShortage } from '@shared/same-train-shortage';
import {
  type SameTrainAlternative, type SameTrainAlternativesResult, type SameTrainErrorCode, SameTrainErrorCode as E,
  sameTrainJourneyKeyString
} from '@shared/same-train-alternatives';
import {
  type ProviderRef, type SameTrainDeps, type SameTrainSearchRequest, type AvailabilityQuery,
  runSameTrainSearch, sameTrainLimitsFromEnv, evaluateAvailabilityAnswer, statusKey
} from './same-train-engine';

const isWebId = (id: string) => (WEB_PROVIDER_IDS as readonly string[]).includes(id);
const ACTIVE = 'active';

function refOf(id: string): ProviderRef {
  const c = providerToolCatalog.get(id);
  const registryId = c?.registryId || '';
  const label = c?.label || id;
  return { id, label, level: isWebId(id) ? 'UNVERIFIED_WEB' : 'PROVIDER_API', isMock: /mock/i.test(registryId) || /\(MOCK\)/.test(label) };
}

function activeRef(): ProviderRef {
  let mock = false; let label = 'Railway provider';
  try { mock = railwayRegistry.getActiveKind() === 'MOCK'; label = railwayRegistry.getActiveId(); } catch { /* no provider */ }
  return { id: ACTIVE, label, level: 'PROVIDER_API', isMock: mock };
}

/** Connectors that can answer availability (API only — web connectors never give authoritative availability). */
export function availabilityProviders(): ProviderRef[] {
  if (!providerToolCatalog.enabled()) return [activeRef()];
  return providerToolCatalog.list().filter(c => !isWebId(c.id) && c.capabilities.includes('CHECK_AVAILABILITY')).map(c => refOf(c.id));
}

export type ProviderResolution =
  | { ok: true; providers: ProviderRef[]; routeProvider: ProviderRef; webProviders: ProviderRef[]; selection: 'LLM' | 'DEFAULT_ALL' }
  | { ok: false; code: string; message: string };

/** Validate Muse's provider choice (CSV of connector ids) — arbitrary / web-only / route-less ids are rejected. */
export function resolveSameTrainProviders(providersCsv?: string | null, routeProviderId?: string | null): ProviderResolution {
  const avail = availabilityProviders();
  if (!avail.length) return { ok: false, code: E.NOT_READY, message: 'Koi availability provider configured nahi hai.' };
  const catalog = providerToolCatalog.enabled();
  let chosen = avail;
  let selection: 'LLM' | 'DEFAULT_ALL' = 'DEFAULT_ALL';
  const ids = String(providersCsv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (ids.length && catalog) {
    const bad = ids.filter(id => !avail.some(p => p.id === id));
    if (bad.length) {
      const web = bad.filter(isWebId);
      return { ok: false, code: 'INVALID_TOOL_CALL', message: web.length
        ? `${web.join(', ')} web source hai — availability ke liye nahi; webEvidence=true use karein. Providers: ${avail.map(p => p.id).join(', ')}.`
        : `Unknown provider ${bad.join(', ')}. Available: ${avail.map(p => p.id).join(', ')}.` };
    }
    chosen = [...new Set(ids)].map(id => avail.find(p => p.id === id)!);
    selection = 'LLM';
  }
  const routeCapable = (id: string) => !catalog || (providerToolCatalog.get(id)?.capabilities || []).includes('GET_TIMETABLE');
  let routeProvider: ProviderRef | undefined;
  if (routeProviderId && catalog) {
    const id = String(routeProviderId).trim().toLowerCase();
    if (!providerToolCatalog.get(id) || isWebId(id) || !routeCapable(id)) {
      return { ok: false, code: 'INVALID_TOOL_CALL', message: `routeProvider ${id} route (timetable) nahi deta. Route-capable: ${providerToolCatalog.list().filter(c => !isWebId(c.id) && routeCapable(c.id)).map(c => c.id).join(', ') || 'none'}.` };
    }
    routeProvider = refOf(id);
  } else {
    routeProvider = catalog
      ? (chosen.find(p => routeCapable(p.id)) || providerToolCatalog.list().filter(c => !isWebId(c.id) && routeCapable(c.id)).map(c => refOf(c.id))[0])
      : chosen[0];
  }
  if (!routeProvider) return { ok: false, code: E.NOT_READY, message: 'Koi route-capable (timetable) provider configured nahi hai.' };
  const webProviders = catalog ? providerToolCatalog.list().filter(c => isWebId(c.id) && c.capabilities.includes('SEARCH_TRAINS')).map(c => refOf(c.id)) : [];
  return { ok: true, providers: chosen, routeProvider, webProviders, selection };
}

const scoped = <T>(p: ProviderRef, fn: () => Promise<T>): Promise<T> => (p.id === ACTIVE ? fn() : inProviderScope(p.id, fn));

/** Real adapters over RailwayToolService (each call fresh, inside the provider's own scope). */
export function liveSameTrainDeps(tools: RailwayToolService = new RailwayToolService(), extra: Partial<SameTrainDeps> = {}): SameTrainDeps {
  return {
    limits: sameTrainLimitsFromEnv(),
    getRoute: (p, trainNumber) => scoped(p, () => tools.GET_TIMETABLE(trainNumber)),
    checkAvailability: (p, q) => scoped(p, () => tools.CHECK_AVAILABILITY({ trainNumber: q.trainNumber, travelClass: q.travelClass as any, date: q.date, origin: q.origin, destination: q.destination } as any)),
    getFare: (p, q) => scoped(p, () => tools.GET_FARE({ trainNumber: q.trainNumber, travelClass: q.travelClass as any, passengersCount: q.passengersCount, date: q.date, origin: q.origin, destination: q.destination } as any)),
    webListsTrain: async (p, q) => {
      const r: any = await scoped(p, () => (railwayRegistry.getActive() as any).searchTrains({ origin: q.origin, destination: q.destination, date: q.date }));
      if (!r || r.ok !== true) return { ok: false, code: String(r?.error?.code || 'WEB_ERROR') };
      const trains: any[] = Array.isArray(r.data?.trains) ? r.data.trains : [];
      return { ok: true, listed: trains.some(t => String(t.trainNumber ?? t.number) === q.trainNumber) };
    },
    ...extra
  };
}

export async function searchSameTrainAlternatives(req: SameTrainSearchRequest, deps?: SameTrainDeps) {
  return runSameTrainSearch(req, deps || liveSameTrainDeps());
}

// ------------------------------------------------------------------ explicit selection → fresh revalidation

export interface RevalidationOutcome {
  ok: boolean;
  code?: SameTrainErrorCode | 'ALTERNATIVE_NOT_ACTIONABLE' | 'ALTERNATIVE_NO_LONGER_AVAILABLE' | 'ALTERNATIVE_INSUFFICIENT_SEATS';
  message: string;
  alternative?: Pick<SameTrainAlternative, 'alternativeId' | 'trainNumber' | 'travelClass' | 'date' | 'ticketOrigin' | 'ticketDestination' | 'boardingStation' | 'alightingStation' | 'boardingRuleStatus' | 'alightingRuleStatus' | 'verificationStatus'>;
  fresh?: { provider: string; status: string; category: string; fetchedAt: string }[];
  /** text the UI may send as the user's explicit choice (existing chat flow → Muse → SESSION_UPDATE → validators) */
  handoffText?: string;
}

/**
 * "Use this option": the stored result must still be current (same train / date / class / route / pax), the option
 * must be shown (not INVALID / CONFLICTING / UNVERIFIED), and a FRESH availability call to the same providers must
 * still return an AVAILABLE / RAC / WAITLIST answer consistent across providers. Nothing in the BookingSession changes
 * here — the selection continues through the existing chat flow (Muse + SESSION_UPDATE validators) only.
 */
export async function revalidateSameTrainAlternative(stored: SameTrainAlternativesResult | undefined, alternativeSearchId: string, alternativeId: string,
  currentKey: string, opts: { acknowledgeUnverifiedRules?: boolean; deps?: SameTrainDeps } = {}): Promise<RevalidationOutcome> {
  if (!stored || stored.alternativeSearchId !== alternativeSearchId) return { ok: false, code: E.NOT_FOUND, message: 'Yeh alternative result ab available nahi hai — dobara search karein.' };
  if (stored.journeyKey !== currentKey) return { ok: false, code: E.RESULT_STALE, message: 'Journey badal gayi hai — same train alternative dobara check karna hoga.' };
  const alt = stored.alternatives.find(a => a.alternativeId === alternativeId);
  if (!alt) return { ok: false, code: E.NOT_FOUND, message: 'Yeh option is result mein nahi hai.' };
  if (alt.verificationStatus !== 'VERIFIED' && alt.verificationStatus !== 'PARTIALLY_VERIFIED') {
    return { ok: false, code: 'ALTERNATIVE_NOT_ACTIONABLE', message: alt.verificationStatus === 'CONFLICTING' ? 'Providers ka data match nahi kar raha — yeh option select nahi ho sakta.' : 'Yeh option verify nahi hua — select nahi ho sakta.' };
  }
  if (alt.verificationStatus === 'PARTIALLY_VERIFIED' && !opts.acknowledgeUnverifiedRules) {
    return { ok: false, code: alt.boardingRuleStatus === 'UNVERIFIED' ? E.BOARDING_RULE_UNVERIFIED : E.ALIGHTING_RULE_UNVERIFIED,
      message: 'Boarding / deboarding rule verify nahi hua — ticket stations se hi travel maan kar aage badhna hoga. Pehle confirm karein.' };
  }
  const deps = opts.deps || liveSameTrainDeps();
  const providerIds = [...new Set(alt.evidence.filter(e => e.level === 'PROVIDER_API' && e.outcome === 'SUCCESS').map(e => e.provider))];
  const refs = providerIds.map(id => (id === ACTIVE ? activeRef() : refOf(id)));
  const q: AvailabilityQuery = { trainNumber: alt.trainNumber, travelClass: alt.travelClass, date: alt.date, origin: alt.ticketOrigin, destination: alt.ticketDestination, passengersCount: alt.passengersCount };
  const answers = await Promise.all(refs.map(async p => {
    const r = await Promise.race([deps.checkAvailability(p, q), new Promise(res => setTimeout(() => res({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } }), deps.limits.perCallTimeoutMs))]);
    return { p, ev: evaluateAvailabilityAnswer(r, q) };
  }));
  const ok = answers.filter(a => a.ev.outcome === 'SUCCESS' && a.ev.availability);
  const fresh = ok.map(a => ({ provider: a.p.id, status: a.ev.availability!.status, category: a.ev.availability!.category, fetchedAt: new Date().toISOString() }));
  const view = { alternativeId: alt.alternativeId, trainNumber: alt.trainNumber, travelClass: alt.travelClass, date: alt.date, ticketOrigin: alt.ticketOrigin, ticketDestination: alt.ticketDestination,
    boardingStation: alt.boardingStation, alightingStation: alt.alightingStation, boardingRuleStatus: alt.boardingRuleStatus, alightingRuleStatus: alt.alightingRuleStatus, verificationStatus: alt.verificationStatus };
  if (!ok.length) return { ok: false, code: E.SEARCH_FAILED, message: 'Fresh availability verify nahi ho paayi — abhi select nahi kar sakte.', alternative: view };
  if (new Set(ok.map(a => statusKey(a.ev.availability!.status))).size > 1) return { ok: false, code: E.PROVIDER_DATA_CONFLICT, message: 'Providers ka fresh data match nahi kar raha.', alternative: view, fresh };
  const cat = ok[0].ev.availability!.category;
  // P42.4: an alternative is actionable only while it is still AVAILABLE (whole party) or RAC — a pair that has fallen to
  // WAITLIST since the search is no longer an alternative to the waitlisted original
  if (cat === 'NOT_AVAILABLE' || cat === 'UNKNOWN' || cat === 'WAITLIST') return { ok: false, code: 'ALTERNATIVE_NO_LONGER_AVAILABLE', message: `Fresh check: ${ok[0].ev.availability!.status} — yeh option ab available nahi.`, alternative: view, fresh };
  // P42.2: the fresh count must still cover the whole party ("AVAILABLE-0001" for 3 passengers is not selectable)
  const seats = evaluateSeatShortage({ status: ok[0].ev.availability!.status, requestedPassengerCount: alt.passengersCount });
  if (seats.sufficiency === 'INSUFFICIENT') {
    return { ok: false, code: 'ALTERNATIVE_INSUFFICIENT_SEATS', message: `Fresh check: ${ok[0].ev.availability!.status} — ${alt.passengersCount} passengers ke liye seats kaafi nahi.`, alternative: view, fresh };
  }
  const handoffText = `Same Train Alternative chuna (${alt.alternativeId}): train ${alt.trainNumber}, ${alt.travelClass}, ${alt.date}, ticket ${alt.ticketOrigin} se ${alt.ticketDestination}. Isi ticket journey ke saath booking aage badhao.`;
  return { ok: true, message: `Fresh check: ${ok[0].ev.availability!.status}.`, alternative: view, fresh, handoffText };
}

/**
 * Journey key of the CURRENT BookingSession, compared with a stored result's key (stale detection). A session field
 * that is set and differs (selected train / class, origin, destination, date, passengers) makes the result stale; an
 * unset field (e.g. no train selected yet) does not.
 */
export function currentSameTrainKey(s: any, r: Pick<SameTrainAlternativesResult, 'trainNumber' | 'travelClass' | 'date' | 'requestedOrigin' | 'requestedDestination' | 'passengersCount'>): string {
  const sel = s?.selectedTrain ? String(s.selectedTrain.number ?? s.selectedTrain.trainNumber ?? '') : '';
  return sameTrainJourneyKeyString({
    trainNumber: sel || r.trainNumber, travelClass: String(s?.selectedClass || r.travelClass), date: String(s?.date || r.date),
    origin: String(s?.origin || r.requestedOrigin), destination: String(s?.destination || r.requestedDestination),
    passengersCount: Number(s?.passengersCount || r.passengersCount)
  });
}

/**
 * Stored result for this session is stale against the current journey.
 * Date / route / passengers: any set session value that differs → stale (unchanged P42 rule).
 * Train / class (P42.2): a result created by the runtime carries the session selection at creation (contextSnapshot) —
 * it becomes stale only when the selected train / class CHANGED after it was produced and no longer matches the result.
 * That keeps Muse's multi-class (2A while 1A is selected) and multi-train (another displayed train before selection)
 * results current, while "Actually 2A" makes a 3A result stale and 12903 → 12014 makes every 12903 result stale.
 * Results without a snapshot (older / engine-direct) keep the original P42 key comparison.
 */
export function isSameTrainResultStale(s: any, r: SameTrainAlternativesResult | undefined | null): boolean {
  if (!r) return false;
  const snap = r.contextSnapshot;
  if (!snap) return currentSameTrainKey(s, r) !== r.journeyKey;
  if (s?.date && String(s.date) !== r.date) return true;
  if (s?.origin && String(s.origin) !== r.requestedOrigin) return true;
  if (s?.destination && String(s.destination) !== r.requestedDestination) return true;
  if (s?.passengersCount && Number(s.passengersCount) !== Number(r.passengersCount)) return true;
  const selTrain = s?.selectedTrain ? String(s.selectedTrain.number ?? s.selectedTrain.trainNumber ?? '') || null : null;
  if (selTrain && selTrain !== r.trainNumber && selTrain !== (snap.selectedTrain || null)) return true;
  const selClass = s?.selectedClass ? String(s.selectedClass).toUpperCase() : null;
  if (selClass && selClass !== r.travelClass && selClass !== (snap.selectedClass || null)) return true;
  // P42.7: the class the user named changed after the result (e.g. SL → 3A) → the recovery context is stale
  const reqClass = s?.requestedClass ? String(s.requestedClass).toUpperCase() : null;
  if (reqClass && snap.requestedClass && reqClass !== snap.requestedClass && reqClass !== r.travelClass) return true;
  return false;
}

/** Key to hand to revalidateSameTrainAlternative: the result's own key while current, else the current journey key. */
export function sameTrainSelectionKey(s: any, r: SameTrainAlternativesResult): string {
  if (!r.contextSnapshot) return currentSameTrainKey(s, r);
  return isSameTrainResultStale(s, r) ? `${currentSameTrainKey(s, r)}|STALE` : r.journeyKey;
}

/** P42.2: every same-train result kept for this session (latest first, bounded) — multi-class / multi-train searches. */
export function sameTrainResultsOf(s: any): SameTrainAlternativesResult[] {
  const out: SameTrainAlternativesResult[] = [];
  const seen = new Set<string>();
  for (const r of [s?.sameTrainAlternatives, ...((s?.sameTrainAlternativeSets || []) as any[])]) {
    if (r && r.alternativeSearchId && !seen.has(r.alternativeSearchId)) { seen.add(r.alternativeSearchId); out.push(r); }
  }
  return out;
}
export function findSameTrainResult(s: any, alternativeSearchId: string): SameTrainAlternativesResult | undefined {
  return sameTrainResultsOf(s).find(r => r.alternativeSearchId === alternativeSearchId);
}
