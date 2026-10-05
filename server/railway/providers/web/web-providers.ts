/**
 * P38 — WEB railway connectors (eRail, RailYatri). Public pages / endpoints that robots.txt ALLOWS, fetched live
 * (no cache), parsed into the existing internal railway schema and labelled UNVERIFIED web data.
 *
 *   erail      SEARCH_TRAINS  GET https://erail.in/rail/getTrains.aspx (robots: Allow /, only /Rail/getAvailability.aspx
 *                             is disallowed). Trains, timings, run days (for the boarding station, Mon-first bitmap) and
 *                             classes from the coach composition. NO fare (the encoded fare table could not be verified
 *                             against provider fares — it is a generic per-distance table) and NO seat availability.
 *   railyatri  TRACK_TRAIN    GET https://www.railyatri.in/live-train-status/{no} (`__NEXT_DATA__` → ltsData).
 *                             Crowd-sourced running status; RailYatri's seat availability is a private token API → never used.
 *   confirmtkt —              robots.txt disallows the train / PNR pages; private API → not implemented.
 *
 * These are never authoritative: booking review / confirmation keep using the railway API providers only. A connector
 * is only ever called because the LLM chose its tool (no hidden fallback). Every failure is a typed error, never data.
 */
import type { RailwayProvider } from '../railway-provider';
import type {
  RailwayResponse, RailwayErrorCode, RailwayMeta, SearchTrainsRequest, TrainSearchResultData, TrainInfoRequest, TrainDetails,
  TimetableRequest, AvailabilityRequest, AvailabilityData, FareRequest, FareData, TrackRequest, TrackData, PNRRequest, PNRData, NormalizedTrain, ClassOption
} from '../../types/railway-types';
import { liveError, VALID_CLASSES, type FetchLike } from '../live/live-http';
import type { RailwayCapability } from '../live/provider-capabilities';

export type WebProviderId = 'erail' | 'railyatri';
export const WEB_PROVIDER_IDS: readonly WebProviderId[] = Object.freeze(['erail', 'railyatri']);
export const WEB_PROVIDER_LABEL: Readonly<Record<WebProviderId, string>> = Object.freeze({ erail: 'eRail', railyatri: 'RailYatri' });
/** Label every web result carries (UI + LLM). */
export const webSourceLabel = (id: string) => `WEB (${WEB_PROVIDER_LABEL[id as WebProviderId] || id}) — unverified`;

/** Declared web capabilities (robots-allowed endpoint behind each). Anything absent is UNSUPPORTED — never emulated. */
export const WEB_CAPABILITY_MATRIX: Readonly<Record<WebProviderId, Readonly<Partial<Record<RailwayCapability, string>>>>> = Object.freeze({
  erail: Object.freeze({ SEARCH_TRAINS: 'GET https://erail.in/rail/getTrains.aspx?Station_From&Station_To' }),
  railyatri: Object.freeze({ TRACK_TRAIN: 'GET https://www.railyatri.in/live-train-status/{train_number} (__NEXT_DATA__.ltsData)' })
});

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CLASS_ORDER = ['1A', 'EA', 'EC', '2A', 'FC', '3A', '3E', 'CC', 'EV', 'VS', 'SL', '2S'];
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export interface WebProviderConfig { timeoutMs: number; fetchImpl?: FetchLike; enabled?: boolean }

class WebDataInvalid extends Error {}

abstract class WebRailwayProvider implements RailwayProvider {
  abstract readonly providerId: WebProviderId;
  abstract readonly label: string;
  readonly source = 'railway-provider' as const;
  readonly isMock = false;
  readonly verification = 'UNVERIFIED_WEB' as const;
  constructor(protected readonly cfg: WebProviderConfig) {}

  get configured(): boolean { return this.cfg.enabled !== false; }
  supports(cap: RailwayCapability): boolean { return !!WEB_CAPABILITY_MATRIX[this.providerId]?.[cap]; }

  protected meta(t0: number): RailwayMeta {
    return { source: this.source, providerId: this.providerId, requestTimestamp: new Date(t0).toISOString(), responseTimestamp: new Date().toISOString(),
      latencyMs: Date.now() - t0, cache: 'disabled', freshness: { mode: 'WEB_UNVERIFIED', retrievedAt: new Date().toISOString() } };
  }
  protected fail<T>(code: RailwayErrorCode, t0: number, message?: string, retryable?: boolean): RailwayResponse<T> {
    const e = liveError(code, null, retryable);
    return { ok: false, error: { code, message: message || e.message, retryable: e.retryable, httpStatus: null }, meta: this.meta(t0) };
  }
  /** One bounded GET of a public page (text). No cache, no retry, generic error messages only (never the body). */
  protected async getText(url: string, t0: number): Promise<{ ok: true; text: string } | { ok: false; resp: RailwayResponse<any> }> {
    const f: FetchLike = this.cfg.fetchImpl || (globalThis.fetch as unknown as FetchLike);
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, this.cfg.timeoutMs));
    try {
      const res = await f(url, { method: 'GET', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,text/plain,*/*', 'Cache-Control': 'no-cache' }, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429) return { ok: false, resp: this.fail('RATE_LIMITED', t0) };
      if (res.status < 200 || res.status >= 300) return { ok: false, resp: this.fail(res.status === 404 ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE', t0, `${this.label} website ne jawab nahi diya (HTTP ${res.status}).`) };
      return { ok: true, text };
    } catch {
      return { ok: false, resp: this.fail(timedOut ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE', t0, timedOut ? `${this.label} website ne time par jawab nahi diya.` : `${this.label} website abhi nahi khul rahi.`) };
    } finally { clearTimeout(timer); }
  }
  protected async run<T>(cap: RailwayCapability, body: (t0: number) => Promise<RailwayResponse<T>>): Promise<RailwayResponse<T>> {
    const t0 = Date.now();
    if (!this.supports(cap)) {
      const why = cap === 'CHECK_AVAILABILITY' ? `${this.label} se seat availability allowed tareeke se nahi mil sakti (robots.txt / private API).`
        : cap === 'GET_FARE' ? `${this.label} ka fare data verify nahi ho saka — isliye nahi diya jaata.` : `${this.label}: ${cap} supported nahi hai.`;
      return this.fail<T>('TOOL_NOT_IMPLEMENTED', t0, why, false);
    }
    if (!this.configured) return this.fail<T>('NOT_CONFIGURED', t0, `${this.label} web connector band hai.`, false);
    try { return await body(t0); }
    catch { return this.fail<T>('PROVIDER_DATA_INVALID', t0, `${this.label} page ka format samajh nahi aaya — data nahi diya.`, false); }
  }

  searchTrains(_r: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> { return this.run('SEARCH_TRAINS', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  getTrainInfo(_r: TrainInfoRequest): Promise<RailwayResponse<TrainDetails | null>> { return this.run('GET_TRAIN_INFO', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  getTimetable(_r: TimetableRequest): Promise<RailwayResponse<any[]>> { return this.run('GET_TIMETABLE', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  checkAvailability(_r: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>> { return this.run('CHECK_AVAILABILITY', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  getFare(_r: FareRequest): Promise<RailwayResponse<FareData>> { return this.run('GET_FARE', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  trackTrain(_r: TrackRequest): Promise<RailwayResponse<TrackData>> { return this.run('TRACK_TRAIN', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  checkPNR(_r: PNRRequest): Promise<RailwayResponse<PNRData>> { return this.run('CHECK_PNR', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
}

// ------------------------------------------------------------------ eRail

const dotTime = (x: string | undefined): string | undefined => { const m = String(x || '').match(/^(\d{1,2})[.:](\d{2})$/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined; };
const dotDuration = (x: string | undefined): string | undefined => { const m = String(x || '').match(/^(\d{1,3})[.:](\d{2})$/); return m ? `${Number(m[1])}h ${Number(m[2])}m` : undefined; };
/** Mon-first weekday index of an ISO date (eRail's run-day bitmap order, verified against RailCore running_days). */
export const monFirstWeekday = (iso: string): number => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Classes from eRail's coach composition (`,,En:SLRD,SLRD,SLRD:S,S1,SL:B,B1,3A:…` → SL, 3A). */
export function erailClasses(fields: string[]): string[] {
  const comp = [...fields].reverse().find(f => /^,,[A-Za-z]*:/.test(f) || /(^|:)[A-Z0-9]+,[A-Z0-9]+,[A-Z0-9]+(:|$)/.test(f)) || '';
  const set = new Set<string>();
  for (const triple of comp.split(':')) {
    const parts = triple.split(',');
    const cls = (parts[2] || '').trim().toUpperCase();
    if (parts.length === 3 && VALID_CLASSES.has(cls)) set.add(cls);
  }
  return CLASS_ORDER.filter(c => set.has(c));
}

export function parseErailTrains(text: string, date: string): { ok: true; originName?: string; destinationName?: string; trains: NormalizedTrain[] } | { ok: false; code: RailwayErrorCode; message: string } {
  const body = String(text || '').trim();
  if (/^~+[^~^]*not found/i.test(body)) return { ok: false, code: 'INVALID_REQUEST', message: `eRail: ${body.replace(/~/g, '').trim().slice(0, 60)}` };
  const rows = body.split('^');
  const head = rows[0].split('~');
  if (rows.length < 1 || head.length < 5) throw new WebDataInvalid('header');
  const wd = monFirstWeekday(date);
  const trains: NormalizedTrain[] = [];
  for (const r of rows.slice(1)) {
    const f = r.split('~');
    if (f.length < 14 || !/^\d{5}$/.test(f[0])) continue;
    const days = f[13];
    if (!/^[01]{7}$/.test(days)) throw new WebDataInvalid('days');
    if (days[wd] !== '1') continue;                                  // does not run from this boarding station on the date
    const dep = dotTime(f[10]), arr = dotTime(f[11]);
    if (!dep || !arr || !f[7] || !f[9]) throw new WebDataInvalid('row');
    trains.push({
      trainNumber: f[0], trainName: (f[1] || '').trim(), origin: f[7].trim().toUpperCase(), destination: f[9].trim().toUpperCase(),
      departure: dep, arrival: arr, duration: dotDuration(f[12]) || '',
      runsOn: DAYS.filter((_, i) => days[i] === '1'),
      classes: erailClasses(f).map(code => ({ code, availability: null, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null } as ClassOption))
    });
  }
  trains.sort((a, b) => a.departure.localeCompare(b.departure));
  return { ok: true, originName: head[2] || undefined, destinationName: head[4] || undefined, trains };
}

export class ErailWebProvider extends WebRailwayProvider {
  readonly providerId = 'erail' as const;
  readonly label = 'eRail';
  searchTrains(req: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> {
    return this.run('SEARCH_TRAINS', async t0 => {
      const from = String(req.origin || '').trim().toUpperCase(), to = String(req.destination || '').trim().toUpperCase();
      if (!/^[A-Z]{1,5}$/.test(from) || !/^[A-Z]{1,5}$/.test(to) || !/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return this.fail('INVALID_REQUEST', t0, 'Search ke liye valid from / to station codes aur date chahiye.', false);
      const g = await this.getText(`https://erail.in/rail/getTrains.aspx?Station_From=${encodeURIComponent(from)}&Station_To=${encodeURIComponent(to)}&DataSource=0&Language=0&Cache=true`, t0);
      if (!g.ok) return g.resp;
      const p = parseErailTrains(g.text, req.date);
      if (!p.ok) return this.fail(p.code, t0, p.message, false);
      if (!p.trains.length) return this.fail('NO_TRAINS_FOUND', t0, `eRail par ${from} → ${to} ke liye ${req.date} ko koi direct train nahi mili.`, false);
      return { ok: true, data: { journey: { origin: from, originName: p.originName, destination: to, destinationName: p.destinationName, date: req.date }, trains: p.trains, totalCount: p.trains.length }, meta: this.meta(t0) };
    });
  }
}

// ------------------------------------------------------------------ RailYatri

const clean = (x: unknown): string | undefined => { const s = typeof x === 'string' ? x.replace(/~/g, ' ').replace(/(\S)['`]+(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim() : typeof x === 'number' ? String(x) : ''; return s || undefined; };

export function parseRailYatriLive(html: string, trainNumber: string): TrackData & Record<string, any> {
  const m = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new WebDataInvalid('next-data');
  const l = JSON.parse(m[1])?.props?.pageProps?.ltsData;
  if (!l || typeof l !== 'object') throw new WebDataInvalid('ltsData');
  if (l.success === false || !clean(l.train_number)) throw Object.assign(new WebDataInvalid('not-found'), { notFound: true });
  if (String(l.train_number) !== String(trainNumber)) throw new WebDataInvalid('train-mismatch');
  const loc = Array.isArray(l.current_location_info) ? l.current_location_info[0] : undefined;
  const status = clean(loc?.message) || clean(l.new_message) || clean(l.title);
  if (!status) throw new WebDataInvalid('status');
  const delay = typeof l.delay === 'number' && l.delay >= 0 ? Math.round(l.delay) : undefined;
  return {
    trainNumber: String(l.train_number), trainName: clean(l.train_name), currentStatus: status,
    ...(clean(l.update_time) ? { lastUpdated: clean(l.update_time) } : {}),
    ...(clean(l.current_station_code) ? { currentStationCode: clean(l.current_station_code) } : {}),
    ...(clean(l.current_station_name) ? { currentStationName: clean(l.current_station_name) } : {}),
    ...(delay !== undefined && clean(l.current_station_code) ? { delayMinutes: delay } : {}),
    ...(clean(l.next_stoppage_info?.next_stoppage) || clean(l.next_station_name) ? { nextStationName: clean(l.next_stoppage_info?.next_stoppage) || clean(l.next_station_name) } : {}),
    ...(clean(l.platform_number) && clean(l.platform_number) !== '0' ? { platformNumber: clean(l.platform_number) } : {}), // '0' = unknown
    ...(clean(l.train_start_date) ? { journeyStartDate: clean(l.train_start_date) } : {}),
    ...(clean(l.status_as_of) ? { statusAsOf: clean(l.status_as_of) } : {}),
    ...(typeof l.pantry_available === 'boolean' ? { pantryAvailable: l.pantry_available } : {}),
    sourceNote: 'Crowd-sourced (RailYatri) — unverified; confirm with Indian Railways / NTES.'
  };
}

export class RailYatriWebProvider extends WebRailwayProvider {
  readonly providerId = 'railyatri' as const;
  readonly label = 'RailYatri';
  trackTrain(req: TrackRequest): Promise<RailwayResponse<TrackData>> {
    return this.run('TRACK_TRAIN', async t0 => {
      const n = String(req.trainNumber || '').trim();
      if (!/^\d{5}$/.test(n)) return this.fail('INVALID_REQUEST', t0, 'Live status ke liye 5 digit ka train number chahiye.', false);
      const g = await this.getText(`https://www.railyatri.in/live-train-status/${n}`, t0);
      if (!g.ok) return g.resp;
      try { return { ok: true, data: parseRailYatriLive(g.text, n), meta: this.meta(t0) }; }
      catch (e: any) { if (e?.notFound) return this.fail('NOT_FOUND', t0, `RailYatri par ${n} ka live status nahi mila.`, false); throw e; }
    });
  }
}

export function createWebProvider(id: WebProviderId, env: NodeJS.ProcessEnv = process.env): WebRailwayProvider {
  const timeoutMs = Math.max(1000, Number(env.RAILWAY_WEB_TIMEOUT_MS) || 12000);
  return id === 'erail' ? new ErailWebProvider({ timeoutMs }) : new RailYatriWebProvider({ timeoutMs });
}

/** Web connectors enabled for this deployment: RAILWAY_WEB_CONNECTORS=erail,railyatri (default) | none. */
export function enabledWebConnectors(env: NodeJS.ProcessEnv = process.env): WebProviderId[] {
  const raw = String(env.RAILWAY_WEB_CONNECTORS ?? 'erail,railyatri').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'off') return [];
  return raw.split(',').map(s => s.trim()).filter((s): s is WebProviderId => (WEB_PROVIDER_IDS as readonly string[]).includes(s));
}
