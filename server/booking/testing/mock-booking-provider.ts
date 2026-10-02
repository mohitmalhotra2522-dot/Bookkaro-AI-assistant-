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
}

const hang = (o: ProviderCallOptions) => new Promise<never>((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

export class MockBookingProvider implements BookingProvider {
  readonly name: string;
  readonly kind = 'TEST' as const;
  executeCalls = 0;
  statusCalls = 0;
  readonly requests: Array<Readonly<BookingProviderRequest>> = [];
  readonly statusRefs: string[] = [];
  readonly getBookingStatus?: (reference: string, o: ProviderCallOptions) => Promise<BookingStatusResult>;

  constructor(private readonly opts: MockBookingProviderOptions) {
    if (process.env.NODE_ENV === 'production') throw new Error('MockBookingProvider is test-only and can never be used in production.');
    this.name = opts.name || 'test-mock-booking';
    if (!this.name.startsWith('test')) throw new Error('MockBookingProvider name must start with "test".');
    if (opts.status) this.getBookingStatus = (ref, o) => this.status(ref, o);
  }

  getCapabilities(): BookingProviderCapabilities {
    return {
      providerName: this.name, available: true, supportsBooking: true, supportsStatus: !!this.opts.status,
      supportsCancellation: false, requiresExternalHandoff: false, supportsIdempotency: !!this.opts.supportsIdempotency,
      health: 'AVAILABLE', reason: 'TEST_ONLY_MOCK'
    };
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
