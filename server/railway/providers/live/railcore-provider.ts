/**
 * PROMPT 35 — RailCore (PRIMARY live provider). Docs: https://railcore.tech/docs (v1, base https://ir.railcore.tech/v1,
 * header X-RailCore-Key). Envelope: { success, data, meta: { freshness: { mode, retrieved_at } } } ·
 * errors { success:false, error: { code, message, retryable } }. Documented not-found codes: NO_TRAINS_FOUND, TRAIN_NOT_FOUND.
 * RailCore has no PNR operation → CHECK_PNR is UNSUPPORTED here (the failover layer may use a provider that declares it).
 */
import type {
  RailwayResponse, SearchTrainsRequest, TrainSearchResultData, NormalizedTrain, ClassOption, TrainInfoRequest, TrainDetails,
  TimetableRequest, AvailabilityRequest, AvailabilityData, FareRequest, FareData, TrackRequest, TrackData
} from '../../types/railway-types';
import { LiveRailwayProvider, need, MalformedProviderData } from './live-provider-base';
import { str, num, hhmm, durationText, todayIST, canonicalAvailability, VALID_CLASSES } from './live-http';

const notFound = (codes: string[]) => (status: number, json: any) => status === 404 && codes.includes(String(json?.error?.code || ''));
const freshnessOf = (json: any) => {
  const f = json?.meta?.freshness;
  return f && typeof f === 'object' ? { mode: str(f.mode), retrievedAt: str(f.retrieved_at) } : null;
};
const envelope = (json: any): any => {
  if (!json || json.success !== true || !json.data || typeof json.data !== 'object') throw new MalformedProviderData('envelope');
  return json.data;
};
const AVAIL_STATUS: Record<string, ClassOption['availabilityStatus']> = { AVAILABLE: 'AVAILABLE', RAC: 'RAC', WAITLIST: 'WAITLIST', REGRET: 'NOT_AVAILABLE', NOT_AVAILABLE: 'NOT_AVAILABLE' };

export class RailCoreProvider extends LiveRailwayProvider {
  readonly providerId = 'railcore' as const;
  readonly label = 'RailCore (live)';
  protected authHeaders() { return { 'X-RailCore-Key': String(this.cfg.apiKey || '') }; }

  searchTrains(req: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> {
    return this.run('SEARCH_TRAINS', async t0 => {
      const seg = this.segment(req);
      if (!seg || !/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Search ke liye valid from / to station codes aur date chahiye.' });
      const r = await this.get('/routes/trains', { from: seg.from, to: seg.to, date: req.date, quota: 'GN' }, notFound(['NO_TRAINS_FOUND']));
      if (!r.ok) return this.httpFail(r, t0, 'NO_TRAINS_FOUND');
      const d = envelope(r.json);
      if (!Array.isArray(d.trains)) throw new MalformedProviderData('trains');
      const origin = str(d.from_station_code) || req.origin, destination = str(d.to_station_code) || req.destination;
      const trains: NormalizedTrain[] = d.trains.map((t: any) => {
        const summary: any[] = Array.isArray(t?.availability_summary) ? t.availability_summary : [];
        const codes: string[] = (Array.isArray(t?.classes) ? t.classes : []).map((c: any) => String(c).toUpperCase()).filter((c: string) => VALID_CLASSES.has(c));
        const classes: ClassOption[] = codes.map(code => {
          const s = summary.find(x => String(x?.class_code || '').toUpperCase() === code);
          return {
            code, availability: str(s?.text) ?? null, availabilityStatus: AVAIL_STATUS[String(s?.status || '').toUpperCase()] || 'UNKNOWN',
            fare: num(s?.fare) ?? null, fareCurrency: num(s?.fare) !== undefined ? 'INR' : null
          };
        });
        return {
          trainNumber: need(str(t?.train_number), 'train_number'), trainName: str(t?.train_name) || '', origin, destination,
          departure: hhmm(t?.departure_time) || '', arrival: hhmm(t?.arrival_time) || '', duration: durationText(num(t?.duration_minutes)) || '',
          ...(Array.isArray(t?.running_days) ? { runsOn: t.running_days.map((x: any) => String(x)) } : {}), classes
        };
      });
      return { ok: true, data: { journey: { origin, destination, date: str(d.journey_date) || req.date }, trains, totalCount: trains.length }, meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }

  private async schedule(trainNumber: string, t0: number): Promise<{ ok: true; d: any; fresh: any } | { ok: false; resp: RailwayResponse<any> }> {
    const r = await this.get(`/trains/${encodeURIComponent(trainNumber)}/schedule`, {}, notFound(['TRAIN_NOT_FOUND']));
    if (!r.ok) return { ok: false, resp: this.httpFail(r, t0) };
    const d = envelope(r.json);
    if (!Array.isArray(d.stops)) throw new MalformedProviderData('stops');
    return { ok: true, d, fresh: freshnessOf(r.json) };
  }
  private stopsOf(d: any) {
    return (d.stops as any[]).filter(s => s && s.is_stop !== false).map((s, i, all) => ({
      station: need(str(s.station_code), 'station_code'), stationName: str(s.station_name),
      ...(i > 0 && hhmm(s.arrival_time) ? { arrival: hhmm(s.arrival_time) } : {}),
      ...(i < all.length - 1 && hhmm(s.departure_time) ? { departure: hhmm(s.departure_time) } : {}),
      ...(num(s.day) !== undefined ? { day: num(s.day) } : {}), ...(num(s.distance_km) !== undefined ? { distanceKm: num(s.distance_km) } : {}),
      ...(str(s.platform_number) ? { platform: str(s.platform_number) } : {})
    }));
  }

  getTrainInfo(req: TrainInfoRequest): Promise<RailwayResponse<TrainDetails | null>> {
    return this.run('GET_TRAIN_INFO', async t0 => {
      const s = await this.schedule(req.trainNumber, t0);
      if (!s.ok) return s.resp;
      const d = s.d; const stops = this.stopsOf(d);
      const details: TrainDetails = {
        trainNumber: need(str(d.train_number), 'train_number'), trainName: str(d.train_name) || '',
        origin: str(d.source_station_code) || stops[0]?.station || '', destination: str(d.destination_station_code) || stops[stops.length - 1]?.station || '',
        departure: stops[0]?.departure || '', arrival: stops[stops.length - 1]?.arrival || '', duration: durationText(num(d.total_duration_minutes)) || '',
        ...(Array.isArray(d.running_days) ? { runsOn: d.running_days.map((x: any) => String(x)) } : {}),
        classes: (Array.isArray(d.classes) ? d.classes : []).map((c: any) => String(c).toUpperCase()).filter((c: string) => VALID_CLASSES.has(c))
          .map((code: string) => ({ code, availability: null, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null } as ClassOption)),
        timetable: stops.map(({ station, stationName, arrival, departure }) => ({ station, stationName, arrival, departure }))
      };
      return { ok: true, data: details, meta: this.meta(t0, s.fresh) };
    });
  }

  getTimetable(req: TimetableRequest): Promise<RailwayResponse<any[]>> {
    return this.run('GET_TIMETABLE', async t0 => {
      const s = await this.schedule(req.trainNumber, t0);
      if (!s.ok) return s.resp;
      return { ok: true, data: this.stopsOf(s.d), meta: this.meta(t0, s.fresh) };
    });
  }

  /** One availability row for (train, segment, date, class). */
  private async seatRow(trainNumber: string, from: string, to: string, date: string, cls: string, t0: number) {
    const r = await this.get('/availability/seats', { train_number: trainNumber, from, to, date, class: cls, quota: 'GN' });
    if (!r.ok) return { ok: false as const, resp: this.httpFail<any>(r, t0) };
    const d = envelope(r.json);
    if (!Array.isArray(d.classes)) throw new MalformedProviderData('classes');
    const row = d.classes.find((c: any) => String(c?.class_code || '').toUpperCase() === cls);
    return { ok: true as const, d, row, fresh: freshnessOf(r.json) };
  }

  checkAvailability(req: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>> {
    return this.run('CHECK_AVAILABILITY', async t0 => {
      const seg = this.segment(req);
      if (!seg) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Availability ke liye journey ke from / to stations chahiye.' });
      const cls = req.travelClass.toUpperCase();
      const x = await this.seatRow(req.trainNumber, seg.from, seg.to, req.date, cls, t0);
      if (!x.ok) return x.resp;
      if (!x.row) return this.fail('CLASS_NOT_AVAILABLE', t0, { retryable: false, message: `${req.trainNumber} mein ${cls} class ka availability record provider ke paas nahi hai.` });
      const c = canonicalAvailability(str(x.row.status), { available: num(x.row.available_count), rac: num(x.row.rac_count), wl: num(x.row.waitlist_count) });
      if (!c) throw new MalformedProviderData('status');
      return { ok: true, data: {
        trainNumber: str(x.d.train_number) || req.trainNumber, travelClass: cls, date: str(x.d.journey_date) || req.date, status: c.status, available: c.available,
        ...(str(x.row.availability_text) ? { statusText: str(x.row.availability_text) } : {}), ...(str(x.d.quota) ? { quota: str(x.d.quota) } : {}),
        providerUpdatedAt: str(x.row.last_updated_at) ?? null
      }, meta: this.meta(t0, x.fresh) };
    });
  }

  /**
   * Date known (always, in the booking flow) → the date-specific class fare from /availability/seats (dynamic-fare
   * trains price per date). No date → /fares/estimate (documented as not date-specific; `date` is then omitted).
   */
  getFare(req: FareRequest): Promise<RailwayResponse<FareData>> {
    return this.run('GET_FARE', async t0 => {
      const seg = this.segment(req);
      if (!seg) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Fare ke liye journey ke from / to stations chahiye.' });
      const cls = req.travelClass.toUpperCase();
      const pax = Number.isInteger(req.passengersCount) && req.passengersCount > 0 ? req.passengersCount : 1;
      let per: number | undefined; let date: string | undefined; let quota: string | undefined; let trainNumber = req.trainNumber; let fresh: any = null;
      if (req.date) {
        const x = await this.seatRow(req.trainNumber, seg.from, seg.to, req.date, cls, t0);
        if (!x.ok) return x.resp;
        if (!x.row) return this.fail('FARE_UNAVAILABLE', t0, { retryable: false, message: `${req.trainNumber} ${cls} ka fare provider ke paas nahi hai.` });
        per = num(x.row.total_fare) ?? num(x.row.fare); date = str(x.d.journey_date) || req.date; quota = str(x.d.quota); trainNumber = str(x.d.train_number) || trainNumber; fresh = x.fresh;
      } else {
        const r = await this.get('/fares/estimate', { train_number: req.trainNumber, from: seg.from, to: seg.to, class: cls, quota: 'GN' });
        if (!r.ok) return this.httpFail(r, t0);
        const d = envelope(r.json);
        if (!Array.isArray(d.fares)) throw new MalformedProviderData('fares');
        const f = d.fares.find((x: any) => String(x?.class_code || '').toUpperCase() === cls);
        if (!f) return this.fail('FARE_UNAVAILABLE', t0, { retryable: false, message: `${req.trainNumber} ${cls} ka fare provider ke paas nahi hai.` });
        per = num(f.fare); quota = str(d.quota); trainNumber = str(d.train_number) || trainNumber; fresh = freshnessOf(r.json);
      }
      if (per === undefined || per <= 0) throw new MalformedProviderData('fare');
      return { ok: true, data: { trainNumber, travelClass: cls, passengersCount: pax, perPassenger: per, total: per * pax, currency: 'INR', breakdown: {},
        ...(date ? { date } : {}), ...(quota ? { quota } : {}) }, meta: this.meta(t0, fresh) };
    });
  }

  trackTrain(req: TrackRequest): Promise<RailwayResponse<TrackData>> {
    return this.run('TRACK_TRAIN', async t0 => {
      const r = await this.get(`/trains/${encodeURIComponent(req.trainNumber)}/live`, { date: todayIST() }, notFound(['TRAIN_NOT_FOUND']));
      if (!r.ok) return this.httpFail(r, t0);
      const d = envelope(r.json);
      const delay = num(d.delay_minutes);
      return { ok: true, data: {
        trainNumber: str(d.train_number) || req.trainNumber, currentStatus: need(str(d.status_text) || str(d.status), 'status'),
        ...(str(d.last_reported_at) ? { lastUpdated: str(d.last_reported_at) } : {}), ...(str(d.train_name) ? { trainName: str(d.train_name) } : {}),
        ...(str(d.current_station_code) ? { currentStationCode: str(d.current_station_code) } : {}), ...(str(d.current_station_name) ? { currentStationName: str(d.current_station_name) } : {}),
        // an EARLY train (negative delay) has no delay; the provider's own status text still says so
        ...(delay !== undefined && delay >= 0 ? { delayMinutes: Math.round(delay) } : {})
      }, meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }
}
