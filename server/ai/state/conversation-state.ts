import { BookingState } from '@shared/states';
import type { BookingSession, Journey, Train, Passenger, FareResult, AvailabilityResult, BookingEvent, BookingEventType } from '@shared/entities';
import { stateTransitionValidator, InvalidStateTransitionError, type TransitionCheck } from './state-transition-validator';

/** Scope of invalidation when a slot changes. */
export type InvalidationScope = 'ROUTE' | 'DATE' | 'TRAIN' | 'CLASS' | 'PASSENGER_COUNT';
import { MOCK_DATA_LABEL } from '@shared/constants';
import { uuid, sessionId as newSessionId } from '../orchestrator/utils';
import { passengerCollection } from '../../booking/passenger-collection';

/**
 * Conversation/Booking state manager.
 * Maintains the strongly-typed BookingSession per session. Enforces explicit
 * valid state transitions and invalidation of dependent state when fields change.
 */
export class ConversationStateManager {
  private sessions: Map<string, BookingSession> = new Map();

  createSession(): BookingSession {
    const id = newSessionId();
    const sess: BookingSession = {
      sessionId: id,
      conversationId: uuid(),
      mode: 'TEXT',
      passengers: [],
      availableTrains: [],
      bookingState: BookingState.IDLE,
      reviewConfirmed: false,
      irctcHandoffReady: false,
      currentPassengerIndex: 0,
      dataSourceLabel: MOCK_DATA_LABEL,
      sessionVersion: 0,
      searchResultsVersion: 0,
      requestVersion: 0,
      eventLog: [],
      pendingInteraction: { type: 'NONE' }
    };
    this.sessions.set(id, sess);
    return sess;
  }

  getSession(sessionId: string): BookingSession {
    let s = this.sessions.get(sessionId);
    if (!s) s = this.createSession();
    return s;
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  /** Throwing transition (validated by StateTransitionValidator). */
  transitionState(sessionId: string, target: BookingState): void {
    const r = this.tryTransition(sessionId, target);
    if (!r.ok) {
      const s = this.getSession(sessionId);
      throw new InvalidStateTransitionError(r.message, s.bookingState, target);
    }
  }

  /** Non-throwing transition; walks the validated path (e.g. IDLE → COLLECTING_JOURNEY → target). */
  tryTransition(sessionId: string, target: BookingState): TransitionCheck {
    const s = this.getSession(sessionId);
    const r = stateTransitionValidator.check(s.bookingState, target);
    if (r.ok) {
      for (const st of r.path) s.bookingState = st;
      if (r.path.length) this.bump(sessionId);
    }
    return r;
  }

  // ---- Versioning / requests / events (Prompt 8) ----

  bump(sessionId: string): number {
    const s = this.getSession(sessionId);
    s.sessionVersion = (s.sessionVersion || 0) + 1;
    return s.sessionVersion;
  }

  /** Start a new turn request; any older in-flight request becomes stale. */
  beginRequest(sessionId: string, requestId: string): number {
    const s = this.getSession(sessionId);
    s.requestVersion = (s.requestVersion || 0) + 1;
    s.activeRequestId = requestId;
    return s.requestVersion;
  }

  isCurrentRequest(sessionId: string, requestVersion: number): boolean {
    return this.getSession(sessionId).requestVersion === requestVersion;
  }

  emit(sessionId: string, type: BookingEventType, turnId: string, data?: Record<string, any>): BookingEvent {
    const s = this.getSession(sessionId);
    const ev: BookingEvent = { type, turnId, timestamp: new Date().toISOString(), sessionVersion: s.sessionVersion, data };
    if (!s.eventLog) s.eventLog = [];
    s.eventLog.push(ev);
    if (s.eventLog.length > 200) s.eventLog.splice(0, s.eventLog.length - 200);
    return ev;
  }

  /**
   * Invalidate railway facts that depend on a changed slot. Never touches
   * unrelated context (passenger count / entered passenger details are kept).
   */
  invalidate(sessionId: string, scope: InvalidationScope): string[] {
    const s = this.getSession(sessionId);
    const cleared: string[] = [];
    const clr = (k: keyof BookingSession) => { if ((s as any)[k] !== undefined && !(Array.isArray((s as any)[k]) && (s as any)[k].length === 0)) cleared.push(String(k)); };
    if (scope === 'ROUTE' || scope === 'DATE') {
      clr('searchResults'); clr('selectedTrain'); clr('selectedClass'); clr('availability'); clr('fare');
      s.availableTrains = [];
      s.searchResults = undefined;
      s.lastSearch = undefined;
      s.searchMeta = undefined;
      if (s.selectedTrain) s.previousTrainNumber = (s.selectedTrain as any).number || (s.selectedTrain as any).trainNumber;
      s.selectedTrain = undefined;
      s.selectedClass = undefined;
      s.availability = undefined;
      s.fare = undefined;
      s.lastTrainInfo = undefined;
      s.lastTimetable = undefined;
      s.focusTrainNumber = undefined;
      s.reviewConfirmed = false;
      s.irctcHandoffReady = false;
      // A new search will be required → bump search version so any old
      // displayIndex reference is now stale.
      s.searchResultsVersion = (s.searchResultsVersion || 0) + 1;
    } else if (scope === 'TRAIN') {
      clr('selectedClass'); clr('availability'); clr('fare');
      s.selectedClass = undefined;
      s.availability = undefined;
      s.fare = undefined;
      s.reviewConfirmed = false;
    } else if (scope === 'CLASS') {
      clr('availability'); clr('fare');
      s.availability = undefined;
      s.fare = undefined;
      s.reviewConfirmed = false;
    } else if (scope === 'PASSENGER_COUNT') {
      // Fare depends on passenger count in the provider contract; availability does not.
      clr('fare');
      s.fare = undefined;
      s.reviewConfirmed = false;
    }
    if (cleared.length) this.bump(sessionId);
    return cleared;
  }

  /** Reconcile passenger records to a count (stable ids P1, P2…; see PassengerCollection). */
  resizePassengers(sessionId: string, count: number): { added: string[]; removed: Passenger[] } {
    return passengerCollection.reconcile(this.getSession(sessionId), count);
  }

  setMode(sessionId: string, mode: 'TEXT' | 'VOICE'): void {
    this.getSession(sessionId).mode = mode;
  }

  updateJourney(sessionId: string, updates: Partial<Journey>): string[] {
    const s = this.getSession(sessionId);
    const changes: string[] = [];

    // If origin or destination changes, invalidate dependent train/class/passenger selection
    if ((updates.origin && updates.origin !== s.origin) || (updates.destination && updates.destination !== s.destination)) {
      s.availableTrains = [];
      s.selectedTrain = undefined;
      s.selectedClass = undefined;
      s.fare = undefined;
      s.availability = undefined;
      s.passengers = [];
      s.currentPassengerIndex = 0;
      s.reviewConfirmed = false;
      s.irctcHandoffReady = false;
    }
    if (updates.date && updates.date !== s.date) {
      // Date change invalidates train results (different availability)
      s.availableTrains = [];
      s.selectedTrain = undefined;
      s.selectedClass = undefined;
      s.fare = undefined;
      s.availability = undefined;
    }
    if (updates.passengerCount !== undefined && updates.passengerCount !== s.passengersCount) {
      s.passengers = [];
      s.currentPassengerIndex = 0;
    }

    if (updates.origin) { s.origin = updates.origin; s.originName = updates.originName; changes.push('origin'); }
    if (updates.destination) { s.destination = updates.destination; s.destinationName = updates.destinationName; changes.push('destination'); }
    if (updates.date) { s.date = updates.date; changes.push('date'); }
    if (updates.passengerCount !== undefined) { s.passengersCount = updates.passengerCount; changes.push('passengerCount'); }
    if (updates.preferredTime) { s.preferredTime = updates.preferredTime; changes.push('preferredTime'); }
    if (updates.preferredClass) { s.preferredClass = updates.preferredClass; changes.push('preferredClass'); }

    s.lastDetectedChanges = changes;
    return changes;
  }

  setAvailableTrains(sessionId: string, trains: Train[]): void {
    this.getSession(sessionId).availableTrains = trains;
  }

  setSelectedTrain(sessionId: string, train: any): void {
    const s = this.getSession(sessionId);
    // Normalize train shape
    const normalized = {
      number: train.trainNumber || train.number,
      name: train.trainName || train.name,
      origin: train.origin,
      destination: train.destination,
      departure: train.departure,
      arrival: train.arrival,
      duration: train.duration,
      availableClasses: (train.classes || []).map((c: any) => c.code),
      classes: train.classes || [],
      dataSource: train.dataSource || 'MOCK',
      // ---- Prompt 10: authoritative provenance (validated by the execution gateway) ----
      /** Result row id from the search that produced this selection. */
      resultId: train.resultId,
      /** Search result set id + journey date / version the selection belongs to. */
      searchResultId: s.searchResults?.resultId,
      searchResultsVersion: s.searchResultsVersion,
      date: s.searchResults?.journey?.date || s.date
    };
    const prev = s.selectedTrain ? ((s.selectedTrain as any).number || (s.selectedTrain as any).trainNumber) : undefined;
    if (prev && prev !== normalized.number) s.previousTrainNumber = prev;
    s.selectedTrain = normalized as any;
    s.focusTrainNumber = normalized.number;
    s.selectedClass = undefined;
    s.fare = undefined;
    s.availability = undefined;
    this.bump(sessionId);
  }

  setSelectedClass(sessionId: string, classCode: string): void {
    this.getSession(sessionId).selectedClass = classCode;
    this.bump(sessionId);
  }

  setFare(sessionId: string, fare: FareResult): void {
    this.getSession(sessionId).fare = fare;
  }

  setAvailability(sessionId: string, trainClass: string, result: AvailabilityResult): void {
    const s = this.getSession(sessionId);
    if (!s.availability) s.availability = {};
    s.availability[trainClass] = result;
  }

  /** Initialise passenger slots for the current count, preserving entered passengers. */
  initPassengers(sessionId: string): void {
    const s = this.getSession(sessionId);
    this.resizePassengers(sessionId, s.passengersCount || 1);
  }

  updatePassenger(sessionId: string, index: number, updates: Partial<Passenger>): void {
    const s = this.getSession(sessionId);
    while (s.passengers.length <= index) s.passengers.push(passengerCollection.newPassenger(s));
    Object.assign(s.passengers[index], updates);
    passengerCollection.refresh(s);
  }

  advanceToNextPassenger(sessionId: string): boolean {
    const s = this.getSession(sessionId);
    passengerCollection.refresh(s);
    return !passengerCollection.allComplete(s);
  }

  areAllPassengersComplete(sessionId: string): boolean {
    return passengerCollection.allComplete(this.getSession(sessionId));
  }

  markReviewConfirmed(sessionId: string): void {
    this.getSession(sessionId).reviewConfirmed = true;
  }

  markHandoffReady(sessionId: string): void {
    this.getSession(sessionId).irctcHandoffReady = true;
  }

  isSearchReady(sessionId: string): boolean {
    const s = this.getSession(sessionId);
    return !!(s.origin && s.destination && s.date && s.passengersCount);
  }

  getMissingJourneyFields(sessionId: string): string[] {
    const s = this.getSession(sessionId);
    const missing: string[] = [];
    if (!s.origin) missing.push('origin');
    if (!s.destination) missing.push('destination');
    if (!s.date) missing.push('date');
    if (!s.passengersCount) missing.push('passengers');
    return missing;
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
