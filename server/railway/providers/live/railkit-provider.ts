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

const envelope = (json: any): any => {
  if (!json || json.success !== true || json.data === undefined || json.data === null) throw new MalformedProviderData('envelope');
  return json.data;
};
/** "1-9-2026" / "01-09-2026" → YYYY-MM-DD */
const isoOfDMY = (x: unknown): string | undefined => { const m = str(x)?.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : undefined; };
/** "19:55 hrs" → "19h 55m" */
const travelTime = (x: unknown): string => { const m = str(x)?.match(/^(\d{1,3}):(\d{2})/); return m ? `${Number(m[1])}h ${Number(m[2])}m` : ''; };
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export class RailKitProvider extends LiveRailwayProvider {
  readonly providerId = 'railkit' as const;
  readonly label = 'RailKit (live)';
  protected authHeaders() { return { 'x-api-key': String(this.cfg.apiKey || '') }; }

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
      const c = canonicalAvailability(str(day.status), { available: n, rac: n, wl: n });
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
