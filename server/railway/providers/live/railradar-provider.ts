/**
 * PROMPT 35 — RailRadar (live fallback). Contract: RailRadar OpenAPI 3.1 (https://api.railradar.in/openapi.json) +
 * https://railradar.in/docs. Base https://api.railradar.in, `Authorization: Bearer <key>`. Envelope { success, data, meta }.
 * Documented endpoints only — no scraping of railradar.in pages.
 */
import type {
  RailwayResponse, SearchTrainsRequest, TrainSearchResultData, NormalizedTrain, TrainInfoRequest, TrainDetails,
  TimetableRequest, AvailabilityRequest, AvailabilityData, FareRequest, FareData, TrackRequest, TrackData, PNRRequest, PNRData, PNRPassengerStatus
} from '../../types/railway-types';
import { LiveRailwayProvider, need, MalformedProviderData } from './live-provider-base';
import { str, num, hhmm, durationText, todayIST, canonicalAvailability, VALID_CLASSES } from './live-http';

/** RailRadar 404 = "requested train, station, or PNR record was not found" — but NOT an unknown route ("Route not found"). */
const notFound = (status: number, json: any) => status === 404 && String(json?.error?.code || '') === 'NOT_FOUND' && !/route not found/i.test(String(json?.error?.message || ''));
const envelope = (json: any): any => {
  if (!json || json.success !== true || json.data === undefined || json.data === null) throw new MalformedProviderData('envelope');
  return json.data;
};
const freshnessOf = (json: any) => (str(json?.meta?.timestamp) ? { mode: 'live', retrievedAt: str(json.meta.timestamp) } : null);
/** "2026-10-05" | "05-10-2026" | "5-10-2026" → YYYY-MM-DD (or undefined). */
const isoDate = (x: unknown): string | undefined => {
  const s = str(x); if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : undefined;
};

export class RailRadarProvider extends LiveRailwayProvider {
  readonly providerId = 'railradar' as const;
  readonly label = 'RailRadar (live)';
  protected authHeaders() { return { Authorization: `Bearer ${String(this.cfg.apiKey || '')}` }; }

  searchTrains(req: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> {
    return this.run('SEARCH_TRAINS', async t0 => {
      const seg = this.segment(req);
      if (!seg || !/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Search ke liye valid from / to station codes aur date chahiye.' });
      const r = await this.get(`/v1/trains/between/${seg.from}/${seg.to}`, { date: req.date }, notFound);
      if (!r.ok) return this.httpFail(r, t0, 'NO_TRAINS_FOUND');
      const d = envelope(r.json);
      if (!Array.isArray(d.trains)) throw new MalformedProviderData('trains');
      const origin = str(d.from?.code) || req.origin, destination = str(d.to?.code) || req.destination;
      const trains: NormalizedTrain[] = d.trains.map((t: any) => ({
        trainNumber: need(str(t?.train?.number), 'train.number'), trainName: str(t?.train?.name) || '',
        origin: str(t?.from?.code) || origin, destination: str(t?.to?.code) || destination,
        departure: hhmm(t?.from?.departure) || '', arrival: hhmm(t?.to?.arrival) || '', duration: durationText(num(t?.duration)) || '',
        ...(Array.isArray(t?.train?.runDays) ? { runsOn: t.train.runDays.map((x: any) => String(x).toUpperCase()) } : {}),
        // the between-stations endpoint returns no class list → none populated (never assumed)
        classes: []
      }));
      return { ok: true, data: { journey: { origin, originName: str(d.from?.name), destination, destinationName: str(d.to?.name), date: req.date }, trains, totalCount: trains.length }, meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }

  private async train(trainNumber: string, t0: number) {
    const r = await this.get(`/v1/trains/${encodeURIComponent(trainNumber)}`, { haltsOnly: 'true' }, notFound);
    if (!r.ok) return { ok: false as const, resp: this.httpFail<any>(r, t0) };
    const d = envelope(r.json);
    if (!d.train || !Array.isArray(d.route)) throw new MalformedProviderData('train/route');
    return { ok: true as const, d, fresh: freshnessOf(r.json) };
  }
  private stopsOf(route: any[]) {
    return route.filter(s => s && s.isHalt !== false).map((s, i, all) => ({
      station: need(str(s.station?.code), 'station.code'), stationName: str(s.station?.name),
      ...(i > 0 && hhmm(s.arrival) ? { arrival: hhmm(s.arrival) } : {}), ...(i < all.length - 1 && hhmm(s.departure) ? { departure: hhmm(s.departure) } : {}),
      ...(num(s.arrivalDay ?? s.departureDay) !== undefined ? { day: num(s.arrivalDay ?? s.departureDay) } : {}),
      ...(num(s.distance) !== undefined ? { distanceKm: num(s.distance) } : {}), ...(str(s.platform) ? { platform: str(s.platform) } : {})
    }));
  }

  getTrainInfo(req: TrainInfoRequest): Promise<RailwayResponse<TrainDetails | null>> {
    return this.run('GET_TRAIN_INFO', async t0 => {
      const x = await this.train(req.trainNumber, t0);
      if (!x.ok) return x.resp;
      const t = x.d.train; const stops = this.stopsOf(x.d.route);
      return { ok: true, data: {
        trainNumber: need(str(t.number), 'train.number'), trainName: str(t.name) || '',
        origin: str(t.source?.code) || stops[0]?.station || '', destination: str(t.destination?.code) || stops[stops.length - 1]?.station || '',
        departure: stops[0]?.departure || '', arrival: stops[stops.length - 1]?.arrival || '', duration: durationText(num(t.duration)) || '',
        ...(Array.isArray(t.runDays) ? { runsOn: t.runDays.map((d: any) => String(d).toUpperCase()) } : {}),
        classes: (Array.isArray(t.classes) ? t.classes : []).map((c: any) => String(c).toUpperCase()).filter((c: string) => VALID_CLASSES.has(c))
          .map((code: string) => ({ code, availability: null, availabilityStatus: 'UNKNOWN' as const, fare: null, fareCurrency: null })),
        timetable: stops.map(({ station, stationName, arrival, departure }) => ({ station, stationName, arrival, departure }))
      }, meta: this.meta(t0, x.fresh) };
    });
  }

  getTimetable(req: TimetableRequest): Promise<RailwayResponse<any[]>> {
    return this.run('GET_TIMETABLE', async t0 => {
      const x = await this.train(req.trainNumber, t0);
      if (!x.ok) return x.resp;
      return { ok: true, data: this.stopsOf(x.d.route), meta: this.meta(t0, x.fresh) };
    });
  }

  checkAvailability(req: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>> {
    return this.run('CHECK_AVAILABILITY', async t0 => {
      const seg = this.segment(req);
      if (!seg) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Availability ke liye journey ke from / to stations chahiye.' });
      const cls = req.travelClass.toUpperCase();
      const r = await this.get(`/v1/trains/${encodeURIComponent(req.trainNumber)}/seats`, { source: seg.from, destination: seg.to, journeyDate: req.date, classCode: cls, quotaCode: 'GN' }, notFound);
      if (!r.ok) return this.httpFail(r, t0, 'CLASS_NOT_AVAILABLE');
      const d = envelope(r.json);
      if (!Array.isArray(d.calendar)) throw new MalformedProviderData('calendar');
      const day = d.calendar.find((c: any) => isoDate(c?.date) === req.date);
      if (!day) throw new MalformedProviderData('calendar-date');   // the requested date is not in the provider answer → unusable, never guessed
      const rac = num(day.racNumber) ?? num(String(day.status || '').match(/RAC\s*(\d+)\s*$/i)?.[1]);
      const c = canonicalAvailability(str(day.statusCode), { available: num(day.availableSeats), rac, wl: num(day.waitlistNumber) });
      if (!c) throw new MalformedProviderData('statusCode');
      return { ok: true, data: { trainNumber: str(d.trainNumber) || req.trainNumber, travelClass: cls, date: req.date, status: c.status, available: c.available,
        ...(str(day.status) ? { statusText: str(day.status) } : {}), ...(str(d.quotaCode) ? { quota: str(d.quotaCode) } : {}), providerUpdatedAt: str(d.generatedAt) ?? null
      }, meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }

  getFare(req: FareRequest): Promise<RailwayResponse<FareData>> {
    return this.run('GET_FARE', async t0 => {
      const seg = this.segment(req);
      if (!seg || !req.date) return this.fail('INVALID_REQUEST', t0, { retryable: false, message: 'Fare ke liye journey ke from / to stations aur date chahiye.' });
      const cls = req.travelClass.toUpperCase();
      const pax = Number.isInteger(req.passengersCount) && req.passengersCount > 0 ? req.passengersCount : 1;
      const r = await this.get(`/v1/trains/${encodeURIComponent(req.trainNumber)}/fare`, { source: seg.from, destination: seg.to, journeyDate: req.date, classCode: cls, quotaCode: 'GN' }, notFound);
      if (!r.ok) return this.httpFail(r, t0, 'FARE_UNAVAILABLE');
      const d = envelope(r.json);
      const per = num(d.breakdown?.totalFare);
      if (per === undefined || per <= 0) throw new MalformedProviderData('totalFare');
      const breakdown: Record<string, number> = {};
      for (const [k, v] of Object.entries(d.breakdown || {})) { const n = num(v); if (n !== undefined && n !== 0 && k !== 'totalFare') breakdown[k] = n; }
      return { ok: true, data: { trainNumber: str(d.trainNumber) || req.trainNumber, travelClass: cls, passengersCount: pax, perPassenger: per, total: per * pax, currency: 'INR', breakdown, date: req.date, quota: 'GN' },
        meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }

  trackTrain(req: TrackRequest): Promise<RailwayResponse<TrackData>> {
    return this.run('TRACK_TRAIN', async t0 => {
      const r = await this.get(`/v1/trains/${encodeURIComponent(req.trainNumber)}/live`, { date: todayIST() }, notFound);
      if (!r.ok) return this.httpFail(r, t0);
      const d = envelope(r.json);
      const loc = d.currentLocation || {};
      const delay = num(d.delayMinutes ?? loc.delayMinutes);
      return { ok: true, data: {
        trainNumber: str(d.trainNumber) || req.trainNumber, currentStatus: need(str(d.status), 'status'),
        ...(str(d.lastUpdatedAt) ? { lastUpdated: str(d.lastUpdatedAt) } : {}), ...(str(d.trainName) ? { trainName: str(d.trainName) } : {}),
        ...(str(loc.stationCode) ? { currentStationCode: str(loc.stationCode) } : {}), ...(str(loc.stationName) ? { currentStationName: str(loc.stationName) } : {}),
        ...(delay !== undefined && delay >= 0 ? { delayMinutes: Math.round(delay) } : {})
      }, meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }

  checkPNR(req: PNRRequest): Promise<RailwayResponse<PNRData>> {
    return this.run('CHECK_PNR', async t0 => {
      const r = await this.get(`/v1/pnr/${encodeURIComponent(req.pnr)}`, {}, notFound);
      if (!r.ok) return this.httpFail(r, t0);
      const d = envelope(r.json);
      const pax: any[] = Array.isArray(d.passengers) ? d.passengers : [];
      const passengers: PNRPassengerStatus[] = pax.map((p, i) => ({ number: num(p?.passengerNumber) ?? i + 1, bookingStatus: need(str(p?.bookingStatus), 'bookingStatus'), currentStatus: need(str(p?.currentStatus), 'currentStatus') }));
      const statuses = [...new Set(passengers.map(p => p.currentStatus))];
      return { ok: true, data: {
        pnr: need(str(d.pnrNumber), 'pnrNumber'), status: need(statuses.join(', ') || undefined, 'status'),
        ...(str(d.charting?.status) ? { chartStatus: str(d.charting.status) } : {}), ...(str(d.train?.number) ? { trainNumber: str(d.train.number) } : {}),
        ...(str(d.train?.name) ? { trainName: str(d.train.name) } : {}), ...(isoDate(d.journey?.date) ? { journeyDate: isoDate(d.journey.date) } : {}),
        ...(str(d.train?.boardingPoint?.code ?? d.train?.source?.code) ? { from: str(d.train?.boardingPoint?.code ?? d.train?.source?.code) } : {}),
        ...(str(d.train?.reservationUpto?.code ?? d.train?.destination?.code) ? { to: str(d.train?.reservationUpto?.code ?? d.train?.destination?.code) } : {}),
        ...(str(d.journey?.class) ? { travelClass: str(d.journey.class)!.toUpperCase() } : {}), passengers
      }, meta: this.meta(t0, freshnessOf(r.json)) };
    });
  }
}
