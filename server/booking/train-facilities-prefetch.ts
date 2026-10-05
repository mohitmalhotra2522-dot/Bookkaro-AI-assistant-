/**
 * P39.2 — catering facts for the passenger questions (same provider fetch the P38 passenger form already does).
 *
 * The meal question (Veg / Non-veg / No food) may only be asked / stored when the provider says catering is included
 * for the SELECTED train. Waiting for the LLM to remember a GET_TRAIN_INFO call meant the meal was often never asked,
 * or a meal the user said was dropped. So once a train + class are selected, the backend fetches that train's
 * facilities ONCE from the provider that produced the search results (`fetchTrainFacilities`, as the form does) and
 * records only the catering / pantry flags on the session (`trainFacilities`, keyed by train number).
 *
 *  - It answers no user question and decides nothing: it is validation metadata for the passenger options.
 *  - It is started after a turn (fire-and-forget) and awaited — briefly, bounded — before the next turn's LLM call.
 *  - Never invents: a failed / missing flag leaves the status NOT_CHECKED / UNKNOWN, so no meal choice is offered.
 *  - Values are never logged.
 */
import type { BookingSession } from '@shared/entities';
import { fetchTrainFacilities } from './passenger-form';
import { foodStatusOf, selectedTrainNumber } from './passenger-options';

const inflight = new Map<string, Promise<void>>();
const attempted = new Set<string>();

const keyOf = (sessionId: string, train: string) => `${sessionId}|${train}`;

/** Start (once per session + train) a facilities fetch when a train + class are selected and catering is unknown. */
export function prefetchTrainFacilities(getSession: () => BookingSession | undefined, sessionId: string): Promise<void> | null {
  const s = getSession();
  if (!s || !s.selectedClass) return null;
  const train = selectedTrainNumber(s);
  if (!train || foodStatusOf(s).status !== 'NOT_CHECKED') return null;
  const key = keyOf(sessionId, train);
  const running = inflight.get(key);
  if (running) return running;
  if (attempted.has(key)) return null;            // one attempt per session + train (a provider failure is not retried in a loop)
  attempted.add(key);
  if (attempted.size > 5000) attempted.clear();
  const p = (async () => {
    try {
      const f = await fetchTrainFacilities(s);
      const now = getSession();
      if (f.error || !now || selectedTrainNumber(now) !== train) return;
      now.trainFacilities = { trainNumber: train, catering: f.catering, pantry: f.pantry, provider: f.provider, dataSource: f.dataSource };
    } catch { /* never throws into a turn */ }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Before a turn: if a fetch is needed / running, wait for it at most `ms` (the turn never fails because of it). */
export async function awaitTrainFacilities(getSession: () => BookingSession | undefined, sessionId: string, ms = 3000): Promise<void> {
  const p = prefetchTrainFacilities(getSession, sessionId);
  if (!p) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>(r => { t = setTimeout(r, ms); })]);
  if (t) clearTimeout(t);
}

/** Test helper. */
export function resetFacilitiesPrefetch(): void { inflight.clear(); attempted.clear(); }
