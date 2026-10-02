import type {
  ClassOption,
  NormalizedTrain,
  TrainSearchResultData
} from '../types/railway-types';

/**
 * RailwayResultNormalizer — converts ANY raw provider payload shape into
 * the canonical NormalizedTrain / ClassOption structure consumed by the
 * conversation engine and UI.
 *
 * Rules:
 *  - Does NOT invent missing values (uses null / UNKNOWN).
 *  - Preserves source metadata untouched.
 *  - Groups same-train classes deterministically (by train number).
 *  - Normalizes departure/arrival/duration format.
 */

export interface RawTrainLike {
  number?: string;
  trainNumber?: string;
  name?: string;
  trainName?: string;
  origin?: string;
  from?: string;
  destination?: string;
  to?: string;
  departure?: string;
  dep?: string;
  departureTime?: string;
  arrival?: string;
  arr?: string;
  arrivalTime?: string;
  duration?: string;
  runsOn?: string[];
  runs_on?: string[];
  days?: string[];
  classes?: Array<RawClassLike | string>;
  classCode?: string; // when providers return one row per class
  availability?: string;
  fare?: number;
}

export interface RawClassLike {
  code?: string;
  classCode?: string;
  name?: string;
  className?: string;
  availability?: string;
  status?: string;
  available?: boolean | string;
  fare?: number;
  price?: number;
  fareCurrency?: string;
  currency?: string;
}

function pick<T>(...vals: T[]): T | undefined {
  return vals.find(v => v !== undefined && v !== null && v !== '');
}

function normalizeTime(raw: any): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already HH:MM
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':').map(Number);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  // HH:MM:SS
  const hm = s.match(/(\d{1,2}):(\d{2})/);
  if (hm) return `${String(+hm[1]).padStart(2, '0')}:${hm[2]}`;
  return null;
}

function normalizeDuration(dep: string | null, arr: string | null, rawDur?: string): string | null {
  if (rawDur) return String(rawDur);
  if (dep && arr) {
    const [dh, dm] = dep.split(':').map(Number);
    const [ah, am] = arr.split(':').map(Number);
    let mins = (ah * 60 + am) - (dh * 60 + dm);
    if (mins < 0) mins += 24 * 60; // next-day arrival
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${h}h ${m}m`;
  }
  return null;
}

function parseAvailability(raw: any): { status: string | null; statusCode: ClassOption['availabilityStatus'] } {
  if (raw === undefined || raw === null || raw === '') {
    return { status: null, statusCode: 'UNKNOWN' };
  }
  const s = String(raw).toLowerCase();
  if (s.includes('available') || s === 'true' || s.includes('confirm')) {
    return { status: 'Available', statusCode: 'AVAILABLE' };
  }
  if (s.includes('rac')) {
    const m = s.match(/rac\s*(\d+)/i);
    return { status: m ? `RAC ${m[1]}` : 'RAC', statusCode: 'RAC' };
  }
  if (s.includes('waitlist') || s.includes('wl') || s.includes('waiting')) {
    const m = s.match(/(?:wl|waitlist)\s*(\d+)/i) || s.match(/(\d+)/);
    return { status: m ? `Waitlist ${m[1]}` : 'Waitlist', statusCode: 'WAITLIST' };
  }
  if (s.includes('not available') || s.includes('unavailable') || s === 'false' || s.includes('n/a')) {
    return { status: 'Not Available', statusCode: 'NOT_AVAILABLE' };
  }
  return { status: String(raw), statusCode: 'UNKNOWN' };
}

function normalizeClass(c: RawClassLike | string, parentAvail?: any, parentFare?: any): ClassOption {
  if (typeof c === 'string') {
    return {
      code: c.toUpperCase(),
      name: undefined,
      availability: parseAvailability(parentAvail).status,
      availabilityStatus: parseAvailability(parentAvail).statusCode,
      fare: typeof parentFare === 'number' ? parentFare : null,
      fareCurrency: parentFare !== undefined ? 'INR' : null
    };
  }
  const code = String(pick(c.code, c.classCode) || '').toUpperCase();
  const { status, statusCode } = parseAvailability(pick(c.availability, c.status, c.available));
  const fareVal = pick(c.fare, c.price);
  return {
    code: code || '?',
    name: pick(c.name, c.className),
    availability: status,
    availabilityStatus: statusCode,
    fare: typeof fareVal === 'number' ? fareVal : null,
    fareCurrency: pick(c.fareCurrency, c.currency) === 'INR' ? 'INR' : fareVal !== undefined ? 'INR' : null
  };
}

/**
 * Normalize a list of raw train-like records (which may be one-per-class rows
 * from some providers) into grouped NormalizedTrain objects.
 */
export function normalizeTrainResults(
  rawTrains: RawTrainLike[],
  journey: { origin: string; destination: string; date: string; originName?: string; destinationName?: string }
): TrainSearchResultData {
  const trainMap = new Map<string, NormalizedTrain>();

  for (const r of rawTrains) {
    const number = String(pick(r.number, r.trainNumber) || '').trim();
    if (!number) continue;

    const dep = normalizeTime(pick(r.departure, r.dep, r.departureTime));
    const arr = normalizeTime(pick(r.arrival, r.arr, r.arrivalTime));
    const name = String(pick(r.name, r.trainName) || '');
    const origin = String(pick(r.origin, r.from) || journey.origin).toUpperCase();
    const destination = String(pick(r.destination, r.to) || journey.destination).toUpperCase();
    const duration = normalizeDuration(dep, arr, r.duration);
    const runsOn = pick(r.runsOn, r.runs_on, r.days) as string[] | undefined;

    // Classes: either an array OR this row represents a single class entry
    let classes: ClassOption[] = [];
    if (Array.isArray(r.classes)) {
      classes = r.classes.map(c => normalizeClass(c));
    } else if (r.classCode) {
      classes = [normalizeClass({
        code: r.classCode, availability: r.availability, fare: r.fare
      })];
    }

    if (!trainMap.has(number)) {
      trainMap.set(number, {
        trainNumber: number,
        trainName: name,
        origin,
        destination,
        departure: dep || '--:--',
        arrival: arr || '--:--',
        duration: duration || '—',
        runsOn,
        classes: []
      });
    }

    const existing = trainMap.get(number)!;
    // Merge classes, dedupe by code (first value wins if multiple)
    for (const cls of classes) {
      if (!existing.classes.find(x => x.code === cls.code)) {
        existing.classes.push(cls);
      }
    }
  }

  const trains = [...trainMap.values()].sort((a, b) => a.departure.localeCompare(b.departure));

  return {
    journey,
    trains,
    totalCount: trains.length
  };
}
