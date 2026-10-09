/**
 * PROMPT 35 — RailKit (live fallback #1). Docs: https://railkit.in/docs (REST, `x-api-key` header, host https://api.railkit.in).
 * The npm SDK is obfuscated and request-signed — it is NOT used; only the documented REST paths below.
 * Declared capabilities = those whose response contract is shown in the public docs (search, seat availability with
 * fare breakup). Dates on RailKit paths are DD-MM-YYYY. Errors: { success:false, error:"<text>" }.
 * NOTE: no RailKit key is configured in this workspace → every call answers NOT_CONFIGURED and the failover layer
 * moves on. Shapes are implemented from the docs and covered by recorded-shape (MOCK) tests only.
 */
import type {
  RailwayResponse, SearchTrainsRequest, TrainSearchResultData, NormalizedTrain, AvailabilityRequest, AvailabilityData, FareRequest, FareData
} from '../../types/railway-types';
import { LiveRailwayProvider, need, MalformedProviderData } from './live-provider-base';
import { str, num, hhmm, toDMY, canonicalAvailability } from './live-http';
import { railKitMonthlyQuota } from './monthly-quota';

const envelope = (json: any): any => {
  if (!json || json.success !== true || json.data === undefined || json.data === null) throw new MalformedProviderData('envelope');
  return json.data;
};
/** "1-9-2026" / "01-09-2026" → YYYY-MM-DD */
const isoOfDMY = (x: unknown): string | undefined => { const m = str(x)?.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : undefined; };
/** "19:55 hrs" → "19h 55m" */
const travelTime = (x: unknown): string => { const m = str(x)?.match(/^(\d{1,3}):(\d{2})/); return m ? `${Number(m[1])}h ${Number(m[2])}m` : ''; };
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
/**
 * 2026-10-09 (live, paid plan): RailKit's coarse `status` reports RAC rows as "WAITLIST" (status WAITLIST,
 * availabilityText "RAC 80", rawStatus "GNWL53/RAC80"). The class's current status is the availabilityText
 * ("AVL n" / "RAC n" / "WL n" / "REGRET"); the coarse `status` is used only when the text carries no recognised status.
 * Any other text/status contradiction is rejected as malformed (never guessed → the failover layer moves on).
 */
const TEXT_STATUS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(AVL|AVBL|AVAILABLE|CURR_AVBL)\b/i, 'AVAILABLE'], [/^RAC\b/i, 'RAC'], [/^(WL|GNWL|RLWL|PQWL|TQWL|RSWL|RQWL|WAITLIST)\b/i, 'WAITLIST'],
  [/^REGRET\b/i, 'REGRET'], [/^NOT[\s_-]*AVAILABLE\b/i, 'NOT_AVAILABLE']
];
const COMPATIBLE: Record<string, readonly string[]> = {
  AVAILABLE: ['AVAILABLE'], RAC: ['RAC', 'WAITLIST'], WAITLIST: ['WAITLIST'], REGRET: ['REGRET', 'WAITLIST'], NOT_AVAILABLE: ['NOT_AVAILABLE', 'WAITLIST']
};
export function railKitStatusOf(availabilityText: unknown, coarseStatus: unknown): string | undefined {
  const text = str(availabilityText) || '';
  const coarse = (str(coarseStatus) || '').toUpperCase().replace(/[\s-]+/g, '_');
  const fromText = TEXT_STATUS.find(([re]) => re.test(text))?.[1];
  if (!fromText) return coarse || undefined;
  if (coarse && !COMPATIBLE[fromText].includes(coarse)) throw new MalformedProviderData('status-conflict');
  return fromText;
}

export class RailKitProvider extends LiveRailwayProvider {
  readonly providerId = 'railkit' as const;
  readonly label = 'RailKit (live)';
  protected authHeaders() { return { 'x-api-key': String(this.cfg.apiKey || '') }; }
  /** 2026-10-09: LOCAL monthly estimate of the Advance plan's 10,000 requests (not authoritative — no quota headers). */
  protected monthlyQuota() { return railKitMonthlyQuota(); }

  searchTrains(req: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> {
    return this.run('SEARCH_TRAINS', async t0 => {
      const seg = this.segment(req);
      if (!seg || !/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Search ke liye valid from / to station codes aur date chahiye.' });
      const r = await this.get(`/api/v1/trains/between/${seg.from}/${seg.to}`, { date: toDMY(req.date) });
      if (!r.ok) return this.httpFail(r, t0, 'NO_TRAINS_FOUND');
      const list = envelope(r.json);
      if (!Array.isArray(list)) throw new MalformedProviderData('data[]');
      const trains: NormalizedTrain[] = list.map((t: any) => {
        const bits = str(t?.running_days);
        return {
          trainNumber: need(str(t?.train_no), 'train_no'), trainName: str(t?.train_name) || '',
          origin: str(t?.from_stn_code) || req.origin, destination: str(t?.to_stn_code) || req.destination,
          departure: hhmm(t?.from_time) || '', arrival: hhmm(t?.to_time) || '', duration: travelTime(t?.travel_time),
          ...(bits && /^[01]{7}$/.test(bits) ? { runsOn: DAYS.filter((_, i) => bits[i] === '1') } : {}),
          classes: []   // not returned by this endpoint
        };
      });
      return { ok: true, data: { journey: { origin: req.origin, destination: req.destination, date: req.date }, trains, totalCount: trains.length }, meta: this.meta(t0) };
    });
  }

  private async seats(trainNumber: string, from: string, to: string, date: string, cls: string, t0: number) {
    const r = await this.get(`/api/v1/seats/${encodeURIComponent(trainNumber)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${toDMY(date)}/${encodeURIComponent(cls)}/GN`);
    if (!r.ok) return { ok: false as const, resp: this.httpFail<any>(r, t0) };
    const d = envelope(r.json);
    if (!d || typeof d !== 'object' || !Array.isArray(d.availability)) throw new MalformedProviderData('availability');
    return { ok: true as const, d };
  }

  checkAvailability(req: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>> {
    return this.run('CHECK_AVAILABILITY', async t0 => {
      const seg = this.segment(req);
      if (!seg) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Availability ke liye journey ke from / to stations chahiye.' });
      const cls = req.travelClass.toUpperCase();
      const x = await this.seats(req.trainNumber, seg.from, seg.to, req.date, cls, t0);
      if (!x.ok) return x.resp;
      const day = x.d.availability.find((a: any) => isoOfDMY(a?.date) === req.date);
      if (!day) throw new MalformedProviderData('availability-date');
      const text = str(day.availabilityText) || '';
      const n = num(text.match(/(\d+)\s*$/)?.[1]);
      const c = canonicalAvailability(railKitStatusOf(day.availabilityText, day.status), { available: n, rac: n, wl: n });
      if (!c) throw new MalformedProviderData('status');
      return { ok: true, data: { trainNumber: str(x.d.train?.trainNo) || req.trainNumber, travelClass: cls, date: req.date, status: c.status, available: c.available,
        ...(str(day.rawStatus) ? { statusText: str(day.rawStatus) } : {}), ...(str(x.d.train?.quota) ? { quota: str(x.d.train.quota) } : {}), providerUpdatedAt: null
      }, meta: this.meta(t0) };
    });
  }

  getFare(req: FareRequest): Promise<RailwayResponse<FareData>> {
    return this.run('GET_FARE', async t0 => {
      const seg = this.segment(req);
      if (!seg || !req.date) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Fare ke liye journey ke from / to stations aur date chahiye.' });
      const cls = req.travelClass.toUpperCase();
      const pax = Number.isInteger(req.passengersCount) && req.passengersCount > 0 ? req.passengersCount : 1;
      const x = await this.seats(req.trainNumber, seg.from, seg.to, req.date, cls, t0);
      if (!x.ok) return x.resp;
      const per = num(x.d.fare?.totalFare);
      if (per === undefined || per <= 0) throw new MalformedProviderData('fare.totalFare');
      const breakdown: Record<string, number> = {};
      for (const [k, v] of Object.entries(x.d.fare || {})) { const n2 = num(v); if (n2 !== undefined && n2 !== 0 && k !== 'totalFare') breakdown[k] = n2; }
      return { ok: true, data: { trainNumber: str(x.d.train?.trainNo) || req.trainNumber, travelClass: cls, passengersCount: pax, perPassenger: per, total: per * pax, currency: 'INR', breakdown, date: req.date, quota: 'GN' }, meta: this.meta(t0) };
    });
  }
}
