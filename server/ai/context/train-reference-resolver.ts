/**
 * TrainReferenceResolver — backend-authoritative resolution of natural train
 * references ("12014 wali", "second wali", "ye wali", "morning wali",
 * "jo pehle batayi thi", "nahi, doosri train", "last wali").
 *
 * The LLM only proposes a TrainReference. Resolution happens HERE, strictly
 * against the CURRENT search results:
 *    displayIndex → resultId → actual normalized train
 *
 * Safety:
 *  - References carrying an older searchResultsVersion → STALE_SEARCH_REFERENCE.
 *  - Never guesses: >1 candidate → AMBIGUOUS_REFERENCE (with candidates),
 *    0 candidates → INVALID_TRAIN_REFERENCE.
 */
import type { BookingSession } from '@shared/entities';
import type { TrainReference } from '../decisions/agent-decision';

export interface ResultTrain {
  trainNumber: string;
  trainName: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  duration: string;
  classes: Array<{ code: string; name?: string; availability?: string | null; fare?: number | null }>;
  displayIndex: number;
  resultId?: string;
  provider?: string;
  retrievedAt?: string;
}

export type TrainRefResolution =
  | { ok: true; train: ResultTrain; displayIndex: number }
  | {
      ok: false;
      code: 'INVALID_TRAIN_REFERENCE' | 'AMBIGUOUS_REFERENCE' | 'STALE_SEARCH_REFERENCE' | 'MISSING_REQUIRED_FIELD';
      message: string;
      candidates?: ResultTrain[];
    };

/** Current authoritative result list with deterministic display indexes. */
export function currentResults(session: BookingSession): ResultTrain[] {
  const raw: any[] = session.searchResults?.trains || [];
  if (raw.length) {
    return raw.map((t: any, i: number) => ({ ...t, displayIndex: t.displayIndex ?? i + 1 }));
  }
  // Legacy shape fallback (availableTrains: {number,name,...})
  return (session.availableTrains || []).map((t: any, i: number) => ({
    trainNumber: t.number || t.trainNumber, trainName: t.name || t.trainName,
    origin: t.origin, destination: t.destination, departure: t.departure, arrival: t.arrival,
    duration: t.duration, classes: t.classes || [], displayIndex: i + 1
  }));
}

export function timeWindowOf(departure: string): 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | null {
  const h = parseInt(String(departure || '').split(':')[0], 10);
  if (Number.isNaN(h)) return null;
  if (h >= 4 && h < 12) return 'MORNING';
  if (h >= 12 && h < 16) return 'AFTERNOON';
  if (h >= 16 && h < 20) return 'EVENING';
  return 'NIGHT';
}

const WINDOW_LABEL: Record<string, string> = { MORNING: 'morning', AFTERNOON: 'afternoon', EVENING: 'evening', NIGHT: 'night' };

export const listTrains = (ts: ResultTrain[]) => {
  const parts = ts.map(t => `${t.trainNumber} (${t.departure})`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ya ${parts[parts.length - 1]}`;
};

export class TrainReferenceResolver {
  resolve(ref: TrainReference, session: BookingSession): TrainRefResolution {
    // 1) Version check — a reference minted for an older result list is stale.
    if (typeof ref.searchResultsVersion === 'number' && ref.searchResultsVersion !== session.searchResultsVersion) {
      const trains = currentResults(session);
      return {
        ok: false, code: 'STALE_SEARCH_REFERENCE',
        message: trains.length
          ? `Wo option purani list ka tha. Current results mein se chuniye: ${listTrains(trains)}.`
          : 'Wo option purani search ka tha. Nayi search ke results aane ke baad train chuniye.',
        candidates: trains
      };
    }

    const trains = currentResults(session);
    if (!trains.length) {
      return {
        ok: false, code: 'MISSING_REQUIRED_FIELD',
        message: ref.kind === 'TRAIN_NUMBER'
          ? `${ref.value} abhi current search results mein nahi hai. Pehle route aur date ke liye trains search kar lete hain.`
          : 'Abhi koi train list nahi hai. Pehle trains search kar lete hain.'
      };
    }
    const one = (t: ResultTrain): TrainRefResolution => ({ ok: true, train: t, displayIndex: t.displayIndex });
    const choose = (cands: ResultTrain[], emptyMsg: string, ambiguousPrefix: string): TrainRefResolution => {
      if (cands.length === 1) return one(cands[0]);
      if (cands.length === 0) return { ok: false, code: 'INVALID_TRAIN_REFERENCE', message: emptyMsg, candidates: trains };
      return { ok: false, code: 'AMBIGUOUS_REFERENCE', message: `${ambiguousPrefix} ${listTrains(cands)} — kaunsi chahiye?`, candidates: cands };
    };
    const selectedNum = session.selectedTrain ? ((session.selectedTrain as any).number || (session.selectedTrain as any).trainNumber) : undefined;

    switch (ref.kind) {
      case 'TRAIN_NUMBER': {
        const t = trains.find(x => x.trainNumber === String(ref.value));
        return t ? one(t) : {
          ok: false, code: 'INVALID_TRAIN_REFERENCE',
          message: `${ref.value} current results mein nahi hai. Available: ${listTrains(trains)}.`, candidates: trains
        };
      }
      case 'DISPLAY_INDEX': {
        const t = trains.find(x => x.displayIndex === Number(ref.value));
        return t ? one(t) : {
          ok: false, code: 'INVALID_TRAIN_REFERENCE',
          message: `List mein sirf ${trains.length} train${trains.length > 1 ? 's' : ''} hai${trains.length > 1 ? 'n' : ''}: ${listTrains(trains)}.`, candidates: trains
        };
      }
      case 'DEMONSTRATIVE': {
        if (ref.value === 'FIRST') return one(trains[0]);
        if (ref.value === 'LAST') return one(trains[trains.length - 1]);
        // THIS — the train in focus (selected / last discussed), else the only result.
        const focus = selectedNum || session.focusTrainNumber;
        const f = focus ? trains.find(x => x.trainNumber === focus) : undefined;
        if (f) return one(f);
        if (focus && !f) {
          return { ok: false, code: 'INVALID_TRAIN_REFERENCE', message: `${focus} current results mein nahi hai. Available: ${listTrains(trains)}.`, candidates: trains };
        }
        return choose(trains, '', '"Ye wali" se kaunsi train? Options:');
      }
      case 'PREVIOUS': {
        const prev = session.previousTrainNumber || session.focusTrainNumber;
        const p = prev ? trains.find(x => x.trainNumber === prev) : undefined;
        if (p) return one(p);
        return { ok: false, code: prev ? 'INVALID_TRAIN_REFERENCE' : 'AMBIGUOUS_REFERENCE',
          message: prev ? `${prev} current results mein nahi hai. Available: ${listTrains(trains)}.` : `Kaunsi train ki baat kar rahe hain? ${listTrains(trains)}.`,
          candidates: trains };
      }
      case 'ALTERNATIVE': {
        const exclude = selectedNum || session.focusTrainNumber;
        const others = trains.filter(x => x.trainNumber !== exclude);
        return choose(others, 'Is search mein aur koi train nahi hai.', 'Doosre options:');
      }
      case 'TIME_PREFERENCE': {
        const cands = trains.filter(x => timeWindowOf(x.departure) === ref.value);
        return choose(cands, `Current results mein koi ${WINDOW_LABEL[ref.value]} train nahi hai. Available: ${listTrains(trains)}.`,
          `${WINDOW_LABEL[ref.value][0].toUpperCase()}${WINDOW_LABEL[ref.value].slice(1)} mein`);
      }
      case 'CLASS_PREFERENCE': {
        const code = String(ref.value).toUpperCase();
        const cands = trains.filter(x => (x.classes || []).some(c => c.code === code));
        return choose(cands, `Current results mein kisi train mein ${code} nahi hai.`, `${code} in trains mein hai:`);
      }
    }
    return { ok: false, code: 'INVALID_TRAIN_REFERENCE', message: 'Train reference samajh nahi aaya.', candidates: trains };
  }
}
