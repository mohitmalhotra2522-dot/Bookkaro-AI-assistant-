/**
 * MockBookingProvider — TEST-ONLY (Prompt 13). NEVER registered in production:
 *  - kind 'TEST' + name prefix "test" → the production registry refuses it;
 *  - the constructor throws when NODE_ENV === 'production';
 *  - nothing in server/main.ts imports this file.
 * Deterministic scenarios — no randomness, no network. The only PNR it can return is
 * MOCK_TEST_ONLY_PNR, clearly marked as test data (never shown as a real ticket outside tests).
 */
import type { BookingProviderCapabilities, BookingProviderRequest, BookingProviderResult, BookingStatusResult, ProviderHealth } from '@shared/booking-provider';
import type { BookingProvider, ProviderCallOptions } from '../provider/booking-provider';
import { BookingProviderError } from '../provider/booking-provider';
import type {
  ModificationChangeType, ProviderActionCapability, ProviderActionStatusResult, ProviderCancellationRequest, ProviderCancellationResult,
  ProviderEligibilityRequest, ProviderEligibilityResult, ProviderModificationRequest, ProviderModificationResult, ProviderRefundStatusResult
} from '@shared/booking-lifecycle-action';

/** TEST-ONLY placeholder PNR. Not a railway PNR. */
export const MOCK_TEST_ONLY_PNR = '0000000000';
export const MOCK_TEST_ONLY_REFERENCE = 'TEST-ONLY-REF-0001';

export type MockExecuteScenario =
  | 'CONFIRMED' | 'CONFIRMED_WITHOUT_PNR' | 'FAILED' | 'IN_PROGRESS' | 'TIMEOUT' | 'NETWORK_ERROR'
  | 'UNKNOWN_STATUS' | 'REQUIRES_EXTERNAL_HANDOFF' | 'INVALID_RESPONSE' | 'NOT_SENT_UNAVAILABLE' | 'ACCEPTED_WITHOUT_REFERENCE';

export type MockStatusScenario = 'CONFIRMED' | 'CONFIRMED_WITHOUT_PNR' | 'FAILED' | 'CANCELLED' | 'IN_PROGRESS' | 'UNKNOWN' | 'TIMEOUT' | 'ERROR' | 'INVALID';

export interface MockBookingProviderOptions {
  name?: string;
  execute: MockExecuteScenario;
  /** Status answers per getBookingStatus call, in order (last one repeats). Omit → no status API. */
  status?: MockStatusScenario[];
  supportsIdempotency?: boolean;
  /** Only when true does the mock report a reference for IN_PROGRESS/ACCEPTED/etc. (default true). */
  returnsReference?: boolean;

  // ---- Prompt 15 lifecycle scenarios (each method exists ONLY when its option is set) ----
  /** cancelBooking() behaviour. Omit → cancellation NOT supported (scenario 2). */
  cancel?: MockCancelScenario;
  /** getCancellationStatus() answers in order (last repeats). Omit → no reconciliation API. */
  cancelStatus?: MockActionStatusScenario[];
  cancelEligibility?: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'ERROR';
  /** modifyBooking() behaviour. Omit → modification NOT supported (scenario 7). */
  modify?: MockModifyScenario;
  /** Which change types are supported (default all three). */
  modifyTypes?: ModificationChangeType[];
  /** checkModificationEligibility(); ELIGIBLE_NO_FARE omits the fare difference. Omit → no eligibility API. */
  modifyEligibility?: 'ELIGIBLE' | 'ELIGIBLE_NO_FARE' | 'NOT_ELIGIBLE' | 'ERROR';
  fareDifference?: number;
  modifyStatus?: MockActionStatusScenario[];
  /** getRefundStatus(). Omit → refund status unavailable (scenario 11). */
  refund?: MockRefundScenario;
  /** Capabilities DECLARED without an implementation (must still resolve to false). */
  declareOnly?: ProviderActionCapability[];
}

export type MockCancelScenario = 'CONFIRMED' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PENDING' | 'NOT_ELIGIBLE' | 'ALREADY_CANCELLED' | 'INVALID' | 'NOT_SENT';
export type MockModifyScenario = 'MODIFIED' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PENDING' | 'NOT_ELIGIBLE' | 'ALREADY_MODIFIED' | 'INVALID' | 'NOT_SENT';
export type MockActionStatusScenario = 'CANCELLED' | 'MODIFIED' | 'PENDING' | 'FAILED' | 'UNKNOWN' | 'ERROR' | 'TIMEOUT';
export type MockRefundScenario = 'PROCESSED' | 'PENDING' | 'NOT_INITIATED' | 'FAILED' | 'ERROR' | 'INVALID';

const hang = (o: ProviderCallOptions) => new Promise<never>((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

export class MockBookingProvider implements BookingProvider {
  readonly name: string;
  readonly kind = 'TEST' as const;
  executeCalls = 0;
  statusCalls = 0;
  readonly requests: Array<Readonly<BookingProviderRequest>> = [];
  readonly statusRefs: string[] = [];
  readonly getBookingStatus?: (reference: string, o: ProviderCallOptions) => Promise<BookingStatusResult>;
  // Prompt 15 call counters + requests (tests assert exact provider-call counts)
  cancelCalls = 0; cancelStatusCalls = 0; cancelEligibilityCalls = 0;
  modifyCalls = 0; modifyStatusCalls = 0; modifyEligibilityCalls = 0; refundCalls = 0;
  duplicateKeyCalls = 0;
  readonly cancelRequests: Array<Readonly<ProviderCancellationRequest>> = [];
  readonly modifyRequests: Array<Readonly<ProviderModificationRequest>> = [];
  private readonly byKey = new Map<string, unknown>();
  // `declare` → no own property unless the scenario is configured (Object.keys stays clean)
  declare readonly cancelBooking?: (r: Readonly<ProviderCancellationRequest>, o: ProviderCallOptions) => Promise<ProviderCancellationResult>;
  declare readonly getCancellationStatus?: (r: Readonly<{ bookingId: string; providerReference: string; idempotencyKey: string }>, o: ProviderCallOptions) => Promise<ProviderActionStatusResult>;
  declare readonly checkCancellationEligibility?: (r: Readonly<ProviderEligibilityRequest>, o: ProviderCallOptions) => Promise<ProviderEligibilityResult>;
  declare readonly modifyBooking?: (r: Readonly<ProviderModificationRequest>, o: ProviderCallOptions) => Promise<ProviderModificationResult>;
  declare readonly getModificationStatus?: (r: Readonly<{ bookingId: string; providerReference: string; idempotencyKey: string; modificationId: string }>, o: ProviderCallOptions) => Promise<ProviderActionStatusResult>;
  declare readonly checkModificationEligibility?: (r: Readonly<ProviderEligibilityRequest>, o: ProviderCallOptions) => Promise<ProviderEligibilityResult>;
  declare readonly getRefundStatus?: (r: Readonly<{ bookingId: string; providerReference: string }>, o: ProviderCallOptions) => Promise<ProviderRefundStatusResult>;

  constructor(private readonly opts: MockBookingProviderOptions) {
    if (process.env.NODE_ENV === 'production') throw new Error('MockBookingProvider is test-only and can never be used in production.');
    this.name = opts.name || 'test-mock-booking';
    if (!this.name.startsWith('test')) throw new Error('MockBookingProvider name must start with "test".');
    if (opts.status) this.getBookingStatus = (ref, o) => this.status(ref, o);
    const self = this as any;
    if (opts.cancel) self.cancelBooking = (r: ProviderCancellationRequest, o: ProviderCallOptions) => this.doCancel(r, o);
    if (opts.cancelStatus) self.getCancellationStatus = (_r: unknown, o: ProviderCallOptions) => { const sc = opts.cancelStatus![Math.min(this.cancelStatusCalls, opts.cancelStatus!.length - 1)]; this.cancelStatusCalls++; return this.actionStatus(sc, o); };
    if (opts.cancelEligibility) self.checkCancellationEligibility = async () => { this.cancelEligibilityCalls++; return this.elig(opts.cancelEligibility!, false); };
    if (opts.modify) self.modifyBooking = (r: ProviderModificationRequest, o: ProviderCallOptions) => this.doModify(r, o);
    if (opts.modifyStatus) self.getModificationStatus = (_r: unknown, o: ProviderCallOptions) => { const sc = opts.modifyStatus![Math.min(this.modifyStatusCalls, opts.modifyStatus!.length - 1)]; this.modifyStatusCalls++; return this.actionStatus(sc, o); };
    if (opts.modifyEligibility) self.checkModificationEligibility = async () => { this.modifyEligibilityCalls++; return this.elig(opts.modifyEligibility!, true); };
    if (opts.refund) self.getRefundStatus = async () => { this.refundCalls++; return this.doRefund(opts.refund!); };
  }

  getCapabilities(): BookingProviderCapabilities {
    return {
      providerName: this.name, available: true, supportsBooking: true, supportsStatus: !!this.opts.status,
      supportsCancellation: !!this.opts.cancel, requiresExternalHandoff: false, supportsIdempotency: !!this.opts.supportsIdempotency,
      health: 'AVAILABLE', reason: 'TEST_ONLY_MOCK',
      ...(this.hasLifecycleOptions() ? { actions: this.declaredActions() } : {})
    };
  }

  private hasLifecycleOptions() {
    const o = this.opts;
    return !!(o.cancel || o.cancelStatus || o.cancelEligibility || o.modify || o.modifyStatus || o.modifyEligibility || o.refund || o.declareOnly);
  }
  private declaredActions(): Partial<Record<ProviderActionCapability, boolean>> {
    const o = this.opts;
    const types = o.modifyTypes || ['JOURNEY', 'CLASS', 'PASSENGER'];
    const a: Partial<Record<ProviderActionCapability, boolean>> = {
      CANCEL_BOOKING: !!o.cancel, GET_CANCELLATION_STATUS: !!o.cancelStatus, CHECK_CANCELLATION_ELIGIBILITY: !!o.cancelEligibility,
      MODIFY_BOOKING: !!o.modify, CHANGE_JOURNEY: !!o.modify && types.includes('JOURNEY'), CHANGE_CLASS: !!o.modify && types.includes('CLASS'),
      CHANGE_PASSENGER: !!o.modify && types.includes('PASSENGER'), GET_MODIFICATION_STATUS: !!o.modifyStatus,
      CHECK_MODIFICATION_ELIGIBILITY: !!o.modifyEligibility, GET_REFUND_STATUS: !!o.refund
    };
    for (const c of o.declareOnly || []) a[c] = true;
    return a;
  }

  /** Deterministic cancellation; a repeated idempotency key returns the SAME stored result (scenario 12). */
  private async doCancel(r: ProviderCancellationRequest, o: ProviderCallOptions): Promise<ProviderCancellationResult> {
    this.cancelCalls++;
    this.cancelRequests.push(r);
    if (this.byKey.has(r.idempotencyKey)) { this.duplicateKeyCalls++; return this.byKey.get(r.idempotencyKey) as ProviderCancellationResult; }
    let out: ProviderCancellationResult;
    switch (this.opts.cancel!) {
      case 'CONFIRMED': out = { status: 'CANCELLED', cancellationReference: 'TEST-ONLY-CXL-0001' }; break;
      case 'ALREADY_CANCELLED': out = { status: 'CANCELLED', cancellationReference: 'TEST-ONLY-CXL-ALREADY' }; break;
      case 'PENDING': out = { status: 'PENDING', cancellationReference: 'TEST-ONLY-CXL-0002' }; break;
      case 'FAILED': out = { status: 'FAILED', failureCode: 'TEST_CANCELLATION_REJECTED' }; break;
      case 'NOT_ELIGIBLE': out = { status: 'NOT_ELIGIBLE', failureCode: 'TEST_NOT_ELIGIBLE' }; break;
      case 'INVALID': return { status: 'DONE', refund: 'yes' } as any;
      case 'TIMEOUT': return hang(o);
      case 'UNKNOWN': throw new BookingProviderError('PROVIDER_UNKNOWN_ERROR' as any, 502);   // after send → uncertain
      case 'NOT_SENT': throw new BookingProviderError('NETWORK_NOT_SENT');
    }
    this.byKey.set(r.idempotencyKey, out);
    return out;
  }

  private async doModify(r: ProviderModificationRequest, o: ProviderCallOptions): Promise<ProviderModificationResult> {
    this.modifyCalls++;
    this.modifyRequests.push(r);
    if (this.byKey.has(r.idempotencyKey)) { this.duplicateKeyCalls++; return this.byKey.get(r.idempotencyKey) as ProviderModificationResult; }
    let out: ProviderModificationResult;
    switch (this.opts.modify!) {
      case 'MODIFIED': out = { status: 'MODIFIED', applied: { ...(r.changes.journeyDate ? { journeyDate: r.changes.journeyDate } : {}), ...(r.changes.travelClass ? { travelClass: r.changes.travelClass } : {}) } }; break;
      case 'PENDING': out = { status: 'PENDING' }; break;
      case 'FAILED': out = { status: 'FAILED', failureCode: 'TEST_MODIFICATION_REJECTED' }; break;
      case 'ALREADY_MODIFIED': out = { status: 'FAILED', failureCode: 'ALREADY_MODIFIED' }; break;
      case 'NOT_ELIGIBLE': out = { status: 'NOT_ELIGIBLE', failureCode: 'TEST_NOT_ELIGIBLE' }; break;
      case 'INVALID': return { status: 'CHANGED', fare: 500 } as any;
      case 'TIMEOUT': return hang(o);
      case 'UNKNOWN': throw new BookingProviderError('PROVIDER_UNKNOWN_ERROR' as any, 502);
      case 'NOT_SENT': throw new BookingProviderError('NETWORK_NOT_SENT');
    }
    this.byKey.set(r.idempotencyKey, out);
    return out;
  }

  private async actionStatus(sc: MockActionStatusScenario, o: ProviderCallOptions): Promise<ProviderActionStatusResult> {
    switch (sc) {
      case 'TIMEOUT': return hang(o);
      case 'ERROR': throw new BookingProviderError('PROVIDER_UNAVAILABLE' as any, 503);
      case 'FAILED': return { status: 'FAILED', failureCode: 'TEST_ACTION_REJECTED' };
      default: return { status: sc };
    }
  }

  private elig(sc: 'ELIGIBLE' | 'ELIGIBLE_NO_FARE' | 'NOT_ELIGIBLE' | 'ERROR', withFare: boolean): ProviderEligibilityResult {
    if (sc === 'ERROR') throw new BookingProviderError('PROVIDER_UNAVAILABLE' as any, 503);
    if (sc === 'NOT_ELIGIBLE') return { eligible: false, reasonCode: 'TEST_CHART_PREPARED' };
    if (sc === 'ELIGIBLE' && withFare) return { eligible: true, fareDifference: { amount: this.opts.fareDifference ?? 250, currency: 'INR' } };
    return { eligible: true };
  }

  private doRefund(sc: MockRefundScenario): ProviderRefundStatusResult {
    switch (sc) {
      case 'ERROR': throw new BookingProviderError('PROVIDER_UNAVAILABLE' as any, 503);
      case 'INVALID': return { status: 'MAYBE' } as any;
      case 'PROCESSED': return { status: 'PROCESSED', amount: 410, currency: 'INR', refundReference: 'TEST-ONLY-RFD-0001' };
      case 'PENDING': return { status: 'PENDING', amount: 410, currency: 'INR' };
      default: return { status: sc };
    }
  }

  async checkHealth(): Promise<ProviderHealth> { return 'AVAILABLE'; }

  async executeBooking(req: Readonly<BookingProviderRequest>, o: ProviderCallOptions): Promise<BookingProviderResult> {
    this.executeCalls++;
    this.requests.push(req);
    const ref = this.opts.returnsReference === false ? {} : { providerReference: MOCK_TEST_ONLY_REFERENCE };
    switch (this.opts.execute) {
      case 'CONFIRMED': return { status: 'CONFIRMED', ...ref, pnr: MOCK_TEST_ONLY_PNR } as BookingProviderResult;
      case 'CONFIRMED_WITHOUT_PNR': return { status: 'CONFIRMED', ...ref } as BookingProviderResult;
      case 'FAILED': return { status: 'FAILED', ...ref, failureCode: 'TEST_PROVIDER_REJECTED' } as BookingProviderResult;
      case 'IN_PROGRESS': return { status: 'IN_PROGRESS', ...ref } as BookingProviderResult;
      case 'ACCEPTED_WITHOUT_REFERENCE': return { status: 'ACCEPTED' } as BookingProviderResult;
      case 'REQUIRES_EXTERNAL_HANDOFF': return { status: 'REQUIRES_EXTERNAL_HANDOFF' } as BookingProviderResult;
      case 'INVALID_RESPONSE': return { status: 'OK', pnr: 'BOOKED!!', ticket: true } as any;
      case 'TIMEOUT': return hang(o);
      case 'NETWORK_ERROR': throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });   // may have been sent
      case 'UNKNOWN_STATUS': throw new BookingProviderError('PROVIDER_UNKNOWN_ERROR' as any, 502);         // 5xx after send → uncertain
      case 'NOT_SENT_UNAVAILABLE': throw new BookingProviderError('NETWORK_NOT_SENT');
    }
  }

  private async status(ref: string, o: ProviderCallOptions): Promise<BookingStatusResult> {
    const seq = this.opts.status!;
    const sc = seq[Math.min(this.statusCalls, seq.length - 1)];
    this.statusCalls++;
    this.statusRefs.push(ref);
    switch (sc) {
      case 'CONFIRMED': return { status: 'CONFIRMED', providerReference: MOCK_TEST_ONLY_REFERENCE, pnr: MOCK_TEST_ONLY_PNR } as BookingStatusResult;
      case 'CONFIRMED_WITHOUT_PNR': return { status: 'CONFIRMED', providerReference: MOCK_TEST_ONLY_REFERENCE } as BookingStatusResult;
      case 'FAILED': return { status: 'FAILED', failureCode: 'TEST_PROVIDER_REJECTED' } as BookingStatusResult;
      case 'CANCELLED': return { status: 'CANCELLED' } as BookingStatusResult;
      case 'IN_PROGRESS': return { status: 'IN_PROGRESS' } as BookingStatusResult;
      case 'UNKNOWN': return { status: 'UNKNOWN' } as BookingStatusResult;
      case 'INVALID': return { status: 'DONE', pnr: 'X' } as any;
      case 'TIMEOUT': return hang(o);
      case 'ERROR': default: throw new BookingProviderError('PROVIDER_UNAVAILABLE' as any, 503);
    }
  }
}
