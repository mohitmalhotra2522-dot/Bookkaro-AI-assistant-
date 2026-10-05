import type { BookingSession, Passenger, Train, Journey, FareResult } from '@shared/entities';

/**
 * Validated IRCTC handoff payload. Contains ONLY validated booking data.
 * NEVER includes credentials, OTP, CAPTCHA, payment info, or session tokens.
 */
export interface IrctcHandoffPayload {
  handoffVersion: '1.0';
  generatedAt: string;
  journey: Journey;
  train: Pick<Train, 'number' | 'name' | 'departure' | 'arrival'> | null;
  travelClass: string | null;
  passengers: Array<Omit<Passenger, 'missingFields' | 'manuallyEdited'>>;
  fare: Pick<FareResult, 'total' | 'currency' | 'dataSource'> | null;
}

export interface HandoffValidationError {
  field: string;
  message: string;
}

export interface HandoffResult {
  status: 'READY' | 'NOT_CONNECTED' | 'INVALID';
  payload?: IrctcHandoffPayload;
  errors?: HandoffValidationError[];
  message: string;
}

/**
 * IrctcHandoffAdapter boundary.
 * Phase 1: prepare + validate work; executeHandoff returns NOT_CONNECTED.
 * NO login, NO OTP, NO CAPTCHA, NO payment, NO credentials, NO auto-submit.
 * Future: connect to authorized user-controlled IRCTC autofill system WITHOUT
 * modifying AI, booking, or conversation layers.
 */
export class IrctcHandoffAdapter {
  /**
   * Validate that session contains all required booking data.
   */
  validateHandoff(session: BookingSession): HandoffValidationError[] {
    const errors: HandoffValidationError[] = [];
    if (!session.origin) errors.push({ field: 'journey.origin', message: 'Origin required' });
    if (!session.destination) errors.push({ field: 'journey.destination', message: 'Destination required' });
    if (!session.date) errors.push({ field: 'journey.date', message: 'Date required' });
    const pcount = session.passengersCount ?? 0;
    if (!pcount || pcount < 1) errors.push({ field: 'passengersCount', message: 'At least one passenger required' });
    if (!session.selectedTrain) errors.push({ field: 'selectedTrain', message: 'Train selection required' });
    if (!session.selectedClass) errors.push({ field: 'selectedClass', message: 'Travel class required' });
    if (session.passengers.length < pcount) errors.push({ field: 'passengers', message: 'All passenger details required' });
    session.passengers.forEach((p, i) => {
      if (!p.name) errors.push({ field: `passengers[${i}].name`, message: 'Name required' });
      if (!p.age) errors.push({ field: `passengers[${i}].age`, message: 'Age required' });
      if (!p.gender) errors.push({ field: `passengers[${i}].gender`, message: 'Gender required' });
    });
    return errors;
  }

  /**
   * Prepare validated handoff payload from session.
   */
  prepareHandoff(session: BookingSession): HandoffResult {
    const errors = this.validateHandoff(session);
    if (errors.length > 0) {
      return { status: 'INVALID', errors, message: 'Booking validation failed.' };
    }
    const payload: IrctcHandoffPayload = {
      handoffVersion: '1.0',
      generatedAt: new Date().toISOString(),
      journey: {
        origin: session.origin,
        originName: session.originName,
        destination: session.destination,
        destinationName: session.destinationName,
        date: session.date,
        passengerCount: session.passengersCount,
        preferredClass: session.preferredClass,
        preferredTime: session.preferredTime
      },
      train: session.selectedTrain
        ? {
            number: session.selectedTrain.number,
            name: session.selectedTrain.name,
            departure: session.selectedTrain.departure,
            arrival: session.selectedTrain.arrival
          }
        : null,
      travelClass: session.selectedClass ?? null,
      passengers: session.passengers.map(p => ({
        id: p.id,
        name: p.name,
        age: p.age,
        gender: p.gender,
        berthPreference: p.berthPreference,
        ...(p.foodPreference ? { foodPreference: p.foodPreference } : {})
      })),
      fare: session.fare ? { total: session.fare.total, currency: session.fare.currency, dataSource: session.fare.dataSource } : null
    };
    return { status: 'READY', payload, message: 'Handoff payload ready.' };
  }

  /**
   * Execute handoff (Phase 1: returns NOT_CONNECTED; no IRCTC interaction).
   * Future: user-controlled redirect/autofill via separate authorized layer.
   */
  async executeHandoff(_session: BookingSession): Promise<HandoffResult> {
    return {
      status: 'NOT_CONNECTED',
      message: 'IRCTC हैंडऑफ अभी कनेक्ट नहीं है। भविष्य में user-controlled integration add किया जाएगा।'
    };
  }
}
