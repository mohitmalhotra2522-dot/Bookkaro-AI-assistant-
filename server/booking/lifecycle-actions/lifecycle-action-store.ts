/**
 * LifecycleActionStore (Prompt 15) — backend-owned action records, modification requests
 * and the idempotency ledger. Records are frozen (copy-on-write) with append-only history;
 * every status change follows ACTION_TRANSITIONS (invalid → INVALID_ACTION_TRANSITION).
 * An idempotency key can be claimed exactly once → one provider request per action, ever
 * (frontend / HTTP / websocket retries, voice interruption or duplicate LLM output cannot
 * produce a second destructive call).
 */
import { randomBytes } from 'node:crypto';
import type {
  BookingLifecycleActionRecord, BookingModificationRequest, LifecycleActionStatus
} from '@shared/booking-lifecycle-action';
import { ACTION_TRANSITIONS } from '@shared/booking-lifecycle-action';

export type ActionStoreResult = { ok: true; record: Readonly<BookingLifecycleActionRecord> } | { ok: false; code: 'INVALID_ACTION_TRANSITION' | 'BOOKING_NOT_FOUND'; message: string };

function freeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as any)) freeze(v); }
  return o;
}

export class LifecycleActionStore {
  private readonly actions = new Map<string, Readonly<BookingLifecycleActionRecord>>();
  private readonly mods = new Map<string, Readonly<BookingModificationRequest>>();
  private readonly claimedKeys = new Set<string>();
  private seq = 0;
  private readonly order = new Map<string, number>();

  constructor(private readonly clock: () => number = () => Date.now()) {}
  private iso() { return new Date(this.clock()).toISOString(); }

  newId(prefix: 'act' | 'mod'): string { return `${prefix}_${randomBytes(8).toString('hex')}`; }

  create(rec: Omit<BookingLifecycleActionRecord, 'history' | 'reconciliationAttempts' | 'completedAt' | 'confirmedAt' | 'failureCode' | 'resultStatus'> & Partial<Pick<BookingLifecycleActionRecord, 'confirmedAt'>>): Readonly<BookingLifecycleActionRecord> {
    const r: BookingLifecycleActionRecord = freeze({
      ...rec, confirmedAt: rec.confirmedAt ?? null, failureCode: null, completedAt: null, resultStatus: null, reconciliationAttempts: 0,
      history: [{ at: rec.requestedAt, status: 'ACTION_REQUESTED' as LifecycleActionStatus }, ...(rec.status !== 'ACTION_REQUESTED' ? [{ at: rec.requestedAt, status: rec.status }] : [])]
    });
    this.actions.set(r.actionId, r);
    this.order.set(r.actionId, ++this.seq);
    return r;
  }

  get(actionId: string): Readonly<BookingLifecycleActionRecord> | null { return this.actions.get(actionId) || null; }

  /** Status transition (validated) + optional field patch; history is append-only. */
  transition(actionId: string, to: LifecycleActionStatus, patch: Partial<Pick<BookingLifecycleActionRecord, 'confirmedAt' | 'failureCode' | 'completedAt' | 'resultStatus'>> = {}, note?: string): ActionStoreResult {
    const cur = this.actions.get(actionId);
    if (!cur) return { ok: false, code: 'BOOKING_NOT_FOUND', message: 'Action not found.' };
    if (cur.status !== to && !ACTION_TRANSITIONS[cur.status].includes(to)) {
      return { ok: false, code: 'INVALID_ACTION_TRANSITION', message: `Action ${cur.status} → ${to} allowed nahi hai.` };
    }
    const at = this.iso();
    const next = freeze({ ...cur, ...patch, status: to, history: [...cur.history, { at, status: to, ...(note ? { note } : {}) }] }) as BookingLifecycleActionRecord;
    this.actions.set(actionId, next);
    return { ok: true, record: next };
  }

  noteReconciliation(actionId: string): Readonly<BookingLifecycleActionRecord> | null {
    const cur = this.actions.get(actionId);
    if (!cur) return null;
    const next = freeze({ ...cur, reconciliationAttempts: cur.reconciliationAttempts + 1 }) as BookingLifecycleActionRecord;
    this.actions.set(actionId, next);
    return next;
  }

  forSession(sessionId: string): Readonly<BookingLifecycleActionRecord>[] {
    return [...this.actions.values()].filter(a => a.sessionId === sessionId).sort((a, b) => (this.order.get(b.actionId)! - this.order.get(a.actionId)!));
  }
  forBooking(sessionId: string, bookingId: string): Readonly<BookingLifecycleActionRecord>[] {
    return this.forSession(sessionId).filter(a => a.bookingId === bookingId);
  }
  /** Latest destructive action (cancel / modify) on a booking that actually reached the provider or is in flight. */
  latestDestructive(sessionId: string, bookingId: string, excludeActionId?: string): Readonly<BookingLifecycleActionRecord> | null {
    return this.forBooking(sessionId, bookingId).find(a => a.actionId !== excludeActionId && a.idempotencyKey && !['AWAITING_ACTION_CONFIRMATION', 'ACTION_ABANDONED', 'ACTION_EXPIRED', 'ACTION_REQUESTED'].includes(a.status)) || null;
  }
  latestOfFamily(sessionId: string, bookingId: string, family: 'CANCEL' | 'MODIFY' | 'REFUND'): Readonly<BookingLifecycleActionRecord> | null {
    const match = (a: BookingLifecycleActionRecord) => family === 'CANCEL' ? a.actionType === 'REQUEST_CANCELLATION'
      : family === 'REFUND' ? a.actionType === 'CHECK_REFUND_STATUS'
      : ['REQUEST_JOURNEY_CHANGE', 'REQUEST_CLASS_CHANGE', 'REQUEST_PASSENGER_CHANGE'].includes(a.actionType);
    return this.forBooking(sessionId, bookingId).find(a => match(a) && !['ACTION_ABANDONED', 'ACTION_EXPIRED'].includes(a.status)) || null;
  }

  /** One-shot idempotency claim. false = key already used → the caller must NOT call the provider. */
  claimKey(key: string): boolean {
    if (this.claimedKeys.has(key)) return false;
    this.claimedKeys.add(key);
    return true;
  }
  isClaimed(key: string): boolean { return this.claimedKeys.has(key); }

  // ---- modification requests (the historical BookingRecord is never mutated by these) ----
  createModification(m: BookingModificationRequest): Readonly<BookingModificationRequest> {
    const r = freeze({ ...m, requestedChanges: JSON.parse(JSON.stringify(m.requestedChanges)) });
    this.mods.set(m.modificationId, r);
    return r;
  }
  getModification(id: string): Readonly<BookingModificationRequest> | null { return this.mods.get(id) || null; }
  updateModification(id: string, status: BookingModificationRequest['status']): Readonly<BookingModificationRequest> | null {
    const cur = this.mods.get(id);
    if (!cur) return null;
    const next = freeze({ ...cur, status, updatedAt: this.iso() });
    this.mods.set(id, next);
    return next;
  }
  modificationsFor(sessionId: string, bookingId: string): Readonly<BookingModificationRequest>[] {
    return [...this.mods.values()].filter(m => m.sessionId === sessionId && m.bookingId === bookingId);
  }
}
