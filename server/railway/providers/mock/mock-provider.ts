import type { RailwayProvider } from '../railway-provider';
import type {
  SearchTrainsRequest, TrainSearchResultData,
  TrainInfoRequest, TrainDetails,
  TimetableRequest, AvailabilityRequest, AvailabilityData,
  FareRequest, FareData,
  TrackRequest, TrackData,
  PNRRequest, PNRData,
  RailwayResponse, RailwayMeta, RailwayErrorCode
} from '../../types/railway-types';
import { normalizeTrainResults } from '../../normalizers/railway-normalizer';
import { MOCK_DATA_LABEL } from '@shared/constants';

/**
 * Deterministic Mock Railway Provider for development/testing.
 * Clearly marked as source: "mock". NEVER pretends to be live.
 * Provides fixed scenarios:
 *  1) Multiple trains with multiple classes (ASR→NDLS, LDH→NDLS, ASR→LDH)
 *  2) Multiple classes per train (CC / 2S / 3A / SL etc.) grouped by normalizer
 *  3) No trains found (simulated via unsupported routes)
 *  4) Provider error scenario (triggered by origin='ERR')
 *  5) Availability unavailable (class code "XX" / waitlist status)
 *  6) Fare unavailable (when class not in fare table)
 */

const FIXTURES: {
  origin: string; destination: string; date: string;
  rows: Array<{
    number: string; name: string; dep: string; arr: string; dur: string;
    runs?: string[];
    classes: Array<{ code: string; name: string; avail: string; fare: number | null }>;
  }>;
}[] = [
  {
    origin: 'ASR', destination: 'NDLS', date: '2026-10-03',
    rows: [
      {
        number: '12014', name: 'Amritsar Shatabdi Express',
        dep: '04:55', arr: '10:50', dur: '5h 55m', runs: ['Daily'],
        classes: [
          { code: 'CC', name: 'AC Chair Car', avail: 'Available', fare: 520 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 120 }
        ]
      },
      {
        number: '12497', name: 'Shan-e-Punjab Express',
        dep: '06:35', arr: '13:50', dur: '7h 15m', runs: ['Daily'],
        classes: [
          { code: '3A', name: 'AC 3 Tier', avail: 'Available', fare: 650 },
          { code: 'CC', name: 'AC Chair Car', avail: 'RAC 4', fare: 490 },
          { code: 'SL', name: 'Sleeper', avail: 'Waitlist 12', fare: 220 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 120 }
        ]
      },
      {
        number: '18238', name: 'Chhattisgarh Express',
        dep: '19:35', arr: '04:10', dur: '8h 35m', runs: ['Daily'],
        classes: [
          { code: '3A', name: 'AC 3 Tier', avail: 'Available', fare: 680 },
          { code: 'SL', name: 'Sleeper', avail: 'Waitlist 8', fare: 240 }
        ]
      }
    ]
  },
  {
    origin: 'LDH', destination: 'NDLS', date: '2026-10-03',
    rows: [
      {
        number: '12030', name: 'Swarna Shatabdi Express',
        dep: '07:50', arr: '12:50', dur: '5h 00m', runs: ['Mon-Sat'],
        classes: [
          { code: 'CC', name: 'AC Chair Car', avail: 'Available', fare: 480 },
          { code: '1A', name: 'AC First Class', avail: 'Available', fare: 1650 },
          { code: '2A', name: 'AC 2 Tier', avail: 'RAC 2', fare: 880 }
        ]
      },
      {
        number: '14682', name: 'Jalandhar-New Delhi Intercity',
        dep: '05:10', arr: '10:45', dur: '5h 35m', runs: ['Daily'],
        classes: [
          { code: 'CC', name: 'AC Chair Car', avail: 'Available', fare: 440 },
          { code: '3A', name: 'AC 3 Tier', avail: 'Available', fare: 620 },
          { code: 'SL', name: 'Sleeper', avail: 'Available', fare: 200 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 110 }
        ]
      }
    ]
  },
  {
    origin: 'ASR', destination: 'CDG', date: '2026-10-03',
    rows: [
      {
        number: '12412', name: 'Amritsar-Chandigarh Intercity',
        dep: '05:05', arr: '09:25', dur: '4h 20m', runs: ['Daily'],
        classes: [
          { code: 'CC', name: 'AC Chair Car', avail: 'Available', fare: 410 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 95 }
        ]
      }
    ]
  },
  {
    origin: 'ASR', destination: 'JUC', date: '2026-10-03',
    rows: [
      {
        number: '12014', name: 'Amritsar Shatabdi Express',
        dep: '04:55', arr: '05:58', dur: '1h 03m', runs: ['Daily'],
        classes: [
          { code: 'CC', name: 'AC Chair Car', avail: 'Available', fare: 210 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 55 }
        ]
      },
      {
        number: '14682', name: 'ASR-JUC Intercity',
        dep: '17:40', arr: '19:05', dur: '1h 25m', runs: ['Daily'],
        classes: [
          { code: 'SL', name: 'Sleeper', avail: 'Available', fare: 120 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 50 }
        ]
      }
    ]
  },
  {
    origin: 'ASR', destination: 'LDH', date: '2026-10-03',
    rows: [
      {
        number: '12014', name: 'Amritsar Shatabdi Express',
        dep: '04:55', arr: '06:57', dur: '2h 02m', runs: ['Daily'],
        classes: [
          { code: 'CC', name: 'AC Chair Car', avail: 'Available', fare: 260 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 70 }
        ]
      },
      {
        number: '04672', name: 'ASR-LDH MEMU Special',
        dep: '13:25', arr: '15:40', dur: '2h 15m', runs: ['Daily'],
        classes: [
          { code: 'SL', name: 'Sleeper', avail: 'Available', fare: 140 },
          { code: '2S', name: 'Second Sitting', avail: 'Available', fare: 60 }
        ]
      }
    ]
  }
];

// Fare lookup table (class → per-passenger fare, INR) — null for unavailable
const FARE_TABLE: Record<string, number> = {
  '1A': 1800, '2A': 950, '3A': 650, 'CC': 520, 'FC': 700, 'SL': 220, '2S': 120
};

function meta(startedAt: number, providerId: string, source: 'mock' | 'railway-provider'): RailwayMeta {
  const end = Date.now();
  return {
    source, providerId,
    requestTimestamp: new Date(startedAt).toISOString(),
    responseTimestamp: new Date(end).toISOString(),
    latencyMs: end - startedAt,
    cache: 'disabled'
  };
}

function errResp<T>(code: RailwayErrorCode, message: string, startedAt: number, providerId: string): RailwayResponse<T> {
  return { ok: false, error: { code, message }, meta: meta(startedAt, providerId, 'mock') };
}

export class MockRailwayProvider implements RailwayProvider {
  readonly providerId = 'mock';
  readonly source = 'mock' as const;
  readonly label = MOCK_DATA_LABEL;
  readonly isMock = true;

  async searchTrains(req: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> {
    const startedAt = Date.now();

    // Scenario 4: provider error
    if (req.origin === 'ERR') {
      return errResp('PROVIDER_UNAVAILABLE', 'Mock provider error scenario triggered (origin=ERR).', startedAt, this.providerId);
    }

    // Filter by preferences
    const acCodes = new Set(['1A', '2A', '3A', 'CC', 'EC', 'FC']);
    const nonAcCodes = new Set(['SL', '2S']);

    const timeInWindow = (dep: string, pref?: string): boolean => {
      if (!pref || pref === 'ANY') return true;
      const h = parseInt(dep.split(':')[0], 10);
      if (pref === 'MORNING') return h >= 4 && h < 12;
      if (pref === 'AFTERNOON') return h >= 12 && h < 16;
      if (pref === 'EVENING') return h >= 16 && h < 20;
      if (pref === 'NIGHT') return h >= 20 || h < 4;
      return true;
    };

    const allRows: any[] = [];
    for (const fx of FIXTURES) {
      // Match regardless of date in mock (so any future date returns same fixtures)
      if (fx.origin === req.origin && fx.destination === req.destination) {
        for (const r of fx.rows) {
          let classes = r.classes;
          if (req.preferredClass === 'AC') classes = classes.filter(c => acCodes.has(c.code));
          if (req.preferredClass === 'NON_AC') classes = classes.filter(c => nonAcCodes.has(c.code));
          if (!timeInWindow(r.dep, req.preferredTime)) continue;
          for (const c of classes) {
            allRows.push({
              number: r.number,
              trainName: r.name,
              origin: r.number === '12014' && fx.destination === 'LDH' ? 'ASR' : fx.origin,
              destination: fx.destination,
              departure: r.dep, arrival: r.arr, duration: r.dur, runsOn: r.runs,
              classCode: c.code, className: c.name,
              availability: c.avail,
              fare: c.fare === null ? undefined : c.fare
            });
          }
        }
      }
    }

    if (allRows.length === 0) {
      return errResp('NO_TRAINS_FOUND', `क्षमा करें, ${req.origin} → ${req.destination} के लिए कोई ट्रेन नहीं मिली (mock data)।`, startedAt, this.providerId);
    }

    const normalized = normalizeTrainResults(allRows, {
      origin: req.origin, destination: req.destination, date: req.date
    });

    return { ok: true, data: normalized, meta: meta(startedAt, this.providerId, 'mock') };
  }

  async getTrainInfo(req: TrainInfoRequest): Promise<RailwayResponse<TrainDetails | null>> {
    const startedAt = Date.now();
    for (const fx of FIXTURES) {
      for (const r of fx.rows) {
        if (r.number === req.trainNumber) {
          const normalized = normalizeTrainResults(
            r.classes.map(c => ({
              number: r.number, trainName: r.name, origin: fx.origin, destination: fx.destination,
              departure: r.dep, arrival: r.arr, duration: r.dur, runsOn: r.runs,
              classCode: c.code, className: c.name, availability: c.avail,
              fare: c.fare === null ? undefined : c.fare
            })),
            { origin: fx.origin, destination: fx.destination, date: req.date || '' }
          );
          const t = normalized.trains[0];
          if (!t) break;
          return {
            ok: true,
            data: { ...t, timetable: [] },
            meta: meta(startedAt, this.providerId, 'mock')
          };
        }
      }
    }
    return errResp('NO_TRAINS_FOUND', `Train ${req.trainNumber} mock data mein uplabdh nahi hai.`, startedAt, this.providerId);
  }

  /**
   * Mock timetable derived ONLY from the mock fixtures (origin departure +
   * each fixture destination's arrival for that train). No invented stops.
   */
  async getTimetable(req: TimetableRequest): Promise<RailwayResponse<any[]>> {
    const s = Date.now();
    const stops = new Map<string, { station: string; arrival?: string; departure?: string; order: number }>();
    const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    const durMin = (d: string) => { const m = d.match(/(\d+)h\s*(\d+)m/); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
    for (const fx of FIXTURES) for (const r of fx.rows) {
      if (r.number !== req.trainNumber) continue;
      if (!stops.has(fx.origin)) stops.set(fx.origin, { station: fx.origin, departure: r.dep, order: 0 });
      stops.set(fx.destination, { station: fx.destination, arrival: r.arr, order: durMin(r.dur) || toMin(r.arr) });
    }
    if (stops.size === 0) {
      return errResp('NO_TRAINS_FOUND', `Train ${req.trainNumber} का timetable mock data में नहीं है।`, s, this.providerId);
    }
    const data = [...stops.values()].sort((a, b) => a.order - b.order).map(({ order, ...x }) => x);
    return { ok: true, data, meta: meta(s, this.providerId, 'mock') };
  }

  async checkAvailability(req: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>> {
    const s = Date.now();
    // Simulate availability unavailable for class "XX"
    if (req.travelClass === 'XX') {
      return errResp('AVAILABILITY_UNAVAILABLE', 'इस क्लास की उपलब्धता अभी प्राप्त नहीं हो सकी।', s, this.providerId);
    }
    // Use the fixture's per-class availability (e.g. 'RAC 4', 'Waitlist 12') —
    // the agent must relay this verbatim, never upgrade it to "confirmed".
    let status: string | null = null;
    for (const fx of FIXTURES) for (const r of fx.rows) {
      if (r.number === req.trainNumber) {
        const c = r.classes.find(x => x.code === req.travelClass);
        if (c && status === null) status = c.avail;
      }
    }
    if (status === null) {
      return errResp('AVAILABILITY_UNAVAILABLE', `${req.trainNumber} ${req.travelClass} की उपलब्धता mock data में नहीं है।`, s, this.providerId);
    }
    return {
      ok: true,
      data: { trainNumber: req.trainNumber, travelClass: req.travelClass, date: req.date, status, available: /^available/i.test(status) },
      meta: meta(s, this.providerId, 'mock')
    };
  }

  async getFare(req: FareRequest): Promise<RailwayResponse<FareData>> {
    const s = Date.now();
    // Scenario 6: fare unavailable for class "ZZ"
    if (req.travelClass === 'ZZ') {
      return errResp('FARE_UNAVAILABLE', 'किराया अभी उपलब्ध नहीं है।', s, this.providerId);
    }
    // Prefer the fixture fare for this exact route+train+class (consistent with search results).
    let per: number | undefined;
    for (const fx of FIXTURES) {
      if (req.origin && req.destination && (fx.origin !== req.origin || fx.destination !== req.destination)) continue;
      const row = fx.rows.find(r => r.number === req.trainNumber);
      const c = row?.classes.find(x => x.code === req.travelClass);
      if (c && c.fare !== null) { per = c.fare; break; }
    }
    if (per === undefined) per = FARE_TABLE[req.travelClass];
    if (per === undefined) {
      return errResp('FARE_UNAVAILABLE', `${req.travelClass} का किराया ज्ञात नहीं है।`, s, this.providerId);
    }
    return {
      ok: true,
      data: {
        trainNumber: req.trainNumber, travelClass: req.travelClass, passengersCount: req.passengersCount,
        perPassenger: per, total: per * req.passengersCount, currency: 'INR', breakdown: { baseFare: per * req.passengersCount }
      },
      meta: meta(s, this.providerId, 'mock')
    };
  }

  async trackTrain(req: TrackRequest): Promise<RailwayResponse<TrackData>> {
    const s = Date.now();
    return { ok: true, data: { trainNumber: req.trainNumber, currentStatus: 'Track status not implemented in mock' }, meta: meta(s, this.providerId, 'mock') };
  }

  async checkPNR(_req: PNRRequest): Promise<RailwayResponse<PNRData>> {
    const s = Date.now();
    return errResp('PROVIDER_UNAVAILABLE', 'PNR check mock provider mein uplabdh nahi hai.', s, this.providerId);
  }
}
