import type { RailwayProvider } from '../providers/railway-provider';
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import type { SearchTrainsRequest, RailwayResponse, TrainSearchResultData, RailwayError, ClassOption } from '../types/railway-types';
import { railwayRegistry } from '../registry/provider-registry';
import { resolveDate } from '../resolvers/date-resolver';
import { resolveRoute } from '../resolvers/route-resolver';

export interface SearchOrchestratorResult {
  ok: boolean;
  data?: TrainSearchResultData;
  error?: RailwayError;
  resolved?: { origin: { code: string; name: string }; destination: { code: string; name: string }; date: string };
  nextQuestion?: string;
  targetState: BookingState;
  meta?: RailwayResponse<any>['meta'];
}

/**
 * RailwaySearchOrchestrator — deterministic search flow.
 * Responsibilities:
 *  1. Validate required search fields
 *  2. Resolve date / route via deterministic resolvers (NOT LLM)
 *  3. Call active RailwayProvider
 *  4. Results come back already normalized (the provider normalizes them)
 *  5. Store search result into BookingSession, invalidate dependent state when route changes
 *  6. Drive state transitions COLLECTING_* → SEARCHING_TRAINS → SHOWING_TRAINS
 *
 * The LLM never calls the provider directly; it only emits validated tool intents.
 */
export class RailwaySearchOrchestrator {
  constructor(private getSession: () => BookingSession, private commitSession: (patch: Partial<BookingSession>) => void) {}

  private getProvider(): RailwayProvider {
    return railwayRegistry.getActive();
  }

  /**
   * Attempt to run a search given the latest user text AND current session.
   * Applies any detected route/date updates from the text first, then validates
   * required fields, then executes SEARCH_TRAINS.
   */
  async trySearch(
    text: string,
    detectedUpdates: { origin?: string; originName?: string; destination?: string; destinationName?: string; date?: string; passengerCount?: number; preferredClass?: any; preferredTime?: any },
    /** Prompt 17: result guard evaluated AFTER the provider returns and BEFORE anything is committed.
     *  false → the late result belongs to a superseded journey / turn / timed-out call and is NOT applied. */
    opts?: { canApply?: () => boolean }
  ): Promise<SearchOrchestratorResult> {
    const session = this.getSession();

    // Merge detected updates into working copies
    let origin = detectedUpdates.origin ?? session.origin;
    let originName = detectedUpdates.originName ?? session.originName;
    let destination = detectedUpdates.destination ?? session.destination;
    let destinationName = detectedUpdates.destinationName ?? session.destinationName;
    let date = detectedUpdates.date ?? session.date;
    let preferredClass = detectedUpdates.preferredClass ?? session.preferredClass;
    let preferredTime = detectedUpdates.preferredTime ?? session.preferredTime;
    const passengersCount = detectedUpdates.passengerCount ?? session.passengersCount;

    // Check if origin/destination changed relative to stored session → invalidate downstream state
    const routeChanged =
      (detectedUpdates.origin && detectedUpdates.origin !== session.origin) ||
      (detectedUpdates.destination && detectedUpdates.destination !== session.destination);
    const dateChanged = detectedUpdates.date && detectedUpdates.date !== session.date;

    if (routeChanged || dateChanged) {
      this.invalidateDependentResults();
    }

    // Resolve date from free text if not already canonical
    if (detectedUpdates.date && !/^\d{4}-\d{2}-\d{2}$/.test(detectedUpdates.date)) {
      const dr = resolveDate(detectedUpdates.date);
      if (!dr.ok) {
        return {
          ok: false,
          error: { code: dr.error === 'AMBIGUOUS_DATE' ? 'AMBIGUOUS_DATE' : 'INVALID_DATE', message: dr.message },
          nextQuestion: dr.message,
          targetState: !origin || !destination ? BookingState.COLLECTING_JOURNEY : BookingState.COLLECTING_DATE
        };
      }
      date = dr.date;
    } else if (text && !date) {
      // maybe the entire user text is a date (e.g. "kal")
      const dr = resolveDate(text);
      if (dr.ok) date = dr.date;
    }

    // Resolve route from free text if new tokens appeared
    if (detectedUpdates.origin === undefined && detectedUpdates.destination === undefined && text) {
      const rr = resolveRoute(text, { origin, destination });
      if (rr.ok && rr.origin && rr.destination) {
        if (rr.origin.code !== origin || rr.destination.code !== destination) {
          origin = rr.origin.code;
          originName = rr.origin.name;
          destination = rr.destination.code;
          destinationName = rr.destination.name;
          this.invalidateDependentResults();
        }
      }
    }

    // Determine missing required fields (do NOT ask for fields already present)
    const missing: string[] = [];
    if (!origin) missing.push('origin');
    if (!destination) missing.push('destination');
    if (!date) missing.push('date');
    // Passenger count is NOT required to search (Prompt 8): SEARCH_TRAINS needs
    // origin + destination + date only. Count is collected later if unknown.

    if (missing.length > 0) {
      const nextQuestion = this.buildMissingQuestion(missing);
      // Pick appropriate collection state based on what's missing
      let targetState = BookingState.COLLECTING_JOURNEY;
      if (origin && destination && !date) targetState = BookingState.COLLECTING_DATE;
      else if (origin && destination && date && missing.includes('passengers')) targetState = BookingState.COLLECTING_PASSENGERS;
      return {
        ok: false,
        error: { code: 'MISSING_REQUIRED_FIELD', message: nextQuestion, missing },
        nextQuestion,
        targetState
      };
    }

    // Transition: SEARCHING_TRAINS
    this.commitSession({
      origin, originName, destination, destinationName,
      date, preferredClass, preferredTime,
      passengersCount: passengersCount ?? this.getSession().passengersCount,
      bookingState: BookingState.SEARCHING_TRAINS,
      lastToolActivity: 'SEARCH_TRAINS',
      searchTimestamp: new Date().toISOString(),
      providerSource: this.getProvider().providerId
    });

    const req: SearchTrainsRequest = {
      origin: origin!,
      destination: destination!,
      date: date!,
      preferredTime: preferredTime ?? 'ANY',
      preferredClass: preferredClass ?? 'ANY',
      passengersCount: passengersCount ?? 1
    };

    const resp = await this.getProvider().searchTrains(req);

    if (opts?.canApply && !opts.canApply()) {
      return {
        ok: false,
        error: { code: 'STALE_TOOL_RESULT' as any, message: 'Search result belongs to a superseded journey/request and was not applied.' },
        targetState: this.getSession().bookingState,
        meta: resp.meta
      };
    }

    if (!resp.ok || !resp.data) {
      // Error → conversation will surface structured error, never fake trains
      return {
        ok: false,
        error: resp.error || { code: 'PROVIDER_UNAVAILABLE', message: 'लाइव ट्रेन जानकारी अभी प्राप्त नहीं हो सकी।' },
        nextQuestion: 'क्षमा करें, लाइव ट्रेन जानकारी अभी प्राप्त नहीं हो पाई। कृपया कुछ देर बाद पुनः प्रयास करें।',
        targetState: BookingState.COLLECTING_JOURNEY,
        meta: resp.meta
      };
    }

    // Store results on session, transition to SHOWING_TRAINS
    this.commitSession({
      availableTrains: resp.data.trains.map(t => ({
        number: t.trainNumber,
        name: t.trainName,
        origin: t.origin,
        destination: t.destination,
        departure: t.departure,
        arrival: t.arrival,
        duration: t.duration,
        availableClasses: t.classes.map(c => c.code),
        classes: t.classes,
        dataSource: resp.meta.source === 'mock' ? 'MOCK' : 'LIVE'
      })) as any,
      lastSearch: resp.data,
      searchResults: resp.data,
      selectedTrain: undefined,
      selectedClass: undefined,
      fare: undefined,
      availability: undefined,
      bookingState: BookingState.SHOWING_TRAINS,
      searchTimestamp: resp.meta.responseTimestamp,
      providerSource: resp.meta.providerId
    });

    return {
      ok: true,
      data: resp.data,
      resolved: { origin: { code: origin!, name: originName || origin! }, destination: { code: destination!, name: destinationName || destination! }, date: date! },
      targetState: BookingState.SHOWING_TRAINS,
      meta: resp.meta
    };
  }

  /**
   * Validate train selection: train must exist in current search results.
   */
  selectTrain(trainNumberInput: string): { ok: boolean; train?: any; error?: RailwayError; classes?: ClassOption[] } {
    const session = this.getSession();
    const trains = session.searchResults?.trains ?? (session.availableTrains as any[]);
    if (!trains || trains.length === 0) {
      return { ok: false, error: { code: 'NO_TRAINS_FOUND', message: 'पहले trains search करें।' } };
    }
    const digits = trainNumberInput.match(/(\d{4,5})/);
    const num = digits ? digits[1] : trainNumberInput;
    const train = trains.find((t: any) => t.trainNumber === num || t.number === num);
    if (!train) {
      return { ok: false, error: { code: 'TRAIN_NOT_IN_RESULTS', message: `यह ट्रेन (${num}) वर्तमान results में नहीं है। कृपया list में से चुनें।` } };
    }
    const classes: ClassOption[] = train.classes || [];
    return { ok: true, train, classes };
  }

  /**
   * Validate class selection: class must exist on the selected train.
   */
  selectClass(classCodeInput: string): { ok: boolean; class?: ClassOption; error?: RailwayError } {
    const session = this.getSession();
    const train = session.selectedTrain as any;
    if (!train) return { ok: false, error: { code: 'INVALID_ROUTE', message: 'पहले train select करें।' } };
    const classes: ClassOption[] = train.classes || [];
    const up = classCodeInput.toUpperCase().trim();
    const cls = classes.find(c => c.code === up || up.includes(c.code));
    if (!cls) return { ok: false, error: { code: 'CLASS_NOT_AVAILABLE', message: `${up} class इस ट्रेन में उपलब्ध नहीं है।` } };
    return { ok: true, class: cls };
  }

  private buildMissingQuestion(missing: string[]): string {
    if (missing.includes('origin')) return 'कहाँ से चलना है?';
    if (missing.includes('destination')) return 'कहाँ जाना है?';
    if (missing.includes('date')) return 'किस तारीख को जाना है?';
    if (missing.includes('passengers')) return 'कितने passengers हैं?';
    return 'ज़रूरी जानकारी दीजिए।';
  }

  private invalidateDependentResults() {
    this.commitSession({
      availableTrains: [],
      lastSearch: undefined,
      searchResults: undefined,
      selectedTrain: undefined,
      selectedClass: undefined,
      fare: undefined,
      availability: undefined,
      // Passenger details are user-entered context unrelated to route/date —
      // they are preserved (never silently discarded or overwritten).
      reviewConfirmed: false,
      irctcHandoffReady: false
    });
  }
}
