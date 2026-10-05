/**
 * P39 — IRCTCHandoffManager: the backend owner of the user-controlled IRCTC handoff.
 *
 * - Created ONLY from the CURRENT confirmed review: the booking handoff snapshot (built by BookingHandoffService after
 *   the explicit confirmation, availability + fare from API providers) must exist for this exact review.
 * - Carries non-sensitive validated data only; serves it to the extension / Assist page against a per-handoff bridge
 *   token. Events are metadata only (page kind, field keys) — never field values, never credentials.
 * - The USER does login, CAPTCHA, OTP, the final Book / Continue tap and payment. COMPLETED only when the IRCTC
 *   confirmation page was detected; a flow that ends after the final step without it is BOOKING_STATUS_UNKNOWN.
 * - Never sets BookingSession COMPLETE and never touches the booking state machine.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { BookingSession } from '@shared/entities';
import {
  IRCTC_FILLABLE_FIELDS, IRCTC_HANDOFF_TTL_MS, IRCTC_MAX_PASSENGERS, IRCTC_PAGE_KINDS, IRCTC_TERMINAL_STATUSES, IRCTC_TEXT, IRCTC_USER_ACTIONS,
  IRCTC_HANDOFF_SCHEMA_VERSION, irctcIntegrityPayload, irctcStatusMessage, type IrctcFillableField, type IrctcHandoffErrorCode, type IrctcHandoffEvent, type IrctcHandoffSnapshot,
  type IrctcHandoffStatus, type IrctcHandoffView, type IrctcLanguage, type IrctcPageKind
} from '@shared/irctc-handoff';
import { reviewFingerprint } from '../../booking/review-builder';
import { checkNoSensitiveData } from '../../booking/handoff/sensitive-data-guard';
import { formatIrctcClass, formatIrctcDate, formatIrctcPassenger, formatIrctcStation } from './irctc-station-formatter';

type NotConfirmed = IrctcHandoffSnapshot['notConfirmed'][number];

interface IrctcHandoffRecord {
  handoffId: string;
  sessionId: string;
  bridgeToken: string;
  bookingHandoffId: string;
  reviewVersion: number;
  fingerprint: string;
  status: IrctcHandoffStatus;
  pausedFrom?: IrctcHandoffStatus;
  language: IrctcLanguage;
  languageSelectorMissing: boolean;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  data: Omit<IrctcHandoffSnapshot, 'status' | 'language' | 'message' | 'handoffId' | 'createdAt' | 'expiresAt' | 'notConfirmed' | 'userActions' | 'schemaVersion' | 'sourceReviewVersion' | 'integrity'>;
  notConfirmed: NotConfirmed[];
  filledFields: Set<IrctcFillableField>;
  userOverrides: Set<IrctcFillableField>;
  lastPage: IrctcPageKind | null;
  /** reached CAPTCHA / OTP / payment / final-control stage → the outcome can no longer be assumed */
  pastFinalStep: boolean;
  events: Array<{ type: string; page?: string; field?: string; at: string }>;
}

export type IrctcResult<T> = { ok: true; value: T } | { ok: false; code: IrctcHandoffErrorCode; message: string; status: number };

const FINAL_STAGE: ReadonlySet<IrctcHandoffStatus> = new Set(['READY_FOR_USER_BOOK', 'CAPTCHA_REQUIRED', 'OTP_REQUIRED', 'PAYMENT_PAGE']);
const PAGE_STATUS: Partial<Record<IrctcPageKind, IrctcHandoffStatus>> = {
  LANGUAGE: 'LANGUAGE_SELECTION', LOGIN: 'LOGIN_REQUIRED', HOME_SEARCH: 'JOURNEY_PAGE', TRAIN_LIST: 'TRAIN_LIST', PASSENGER: 'PASSENGER_PAGE',
  REVIEW_CAPTCHA: 'CAPTCHA_REQUIRED', OTP: 'OTP_REQUIRED', PAYMENT: 'PAYMENT_PAGE', CONFIRMATION: 'COMPLETED', FAILURE: 'BOOKING_FAILED',
  SESSION_EXPIRED: 'SESSION_EXPIRED'
};
const EVENT_KEYS: Record<string, readonly string[]> = {
  PAGE_DETECTED: ['page'], FIELDS_FILLED: ['page', 'filled', 'skipped'], FIELD_NOT_CONFIRMED: ['field'], USER_OVERRIDE: ['field'],
  LANGUAGE_SELECTED: ['language'], LANGUAGE_SELECTOR_MISSING: [], FINAL_CONTROL_HIGHLIGHTED: ['page'],
  PAUSED: [], RESUMED: [], STOPPED: [], FLOW_ENDED_WITHOUT_CONFIRMATION: []
};
const FIELD_SET: ReadonlySet<string> = new Set(IRCTC_FILLABLE_FIELDS);
const err = <T>(code: IrctcHandoffErrorCode, message: string, status = 409): IrctcResult<T> => ({ ok: false, code, message, status });

export interface IrctcHandoffManagerOptions { ttlMs?: number; log?: (e: Record<string, unknown>) => void }

export class IrctcHandoffManager {
  private readonly byId = new Map<string, IrctcHandoffRecord>();
  private readonly bySession = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly log: (e: Record<string, unknown>) => void;

  constructor(opts: IrctcHandoffManagerOptions = {}) {
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : IRCTC_HANDOFF_TTL_MS;
    this.log = opts.log || (() => { /* metadata-only audit sink */ });
  }

  /**
   * Create (or return the existing) IRCTC handoff for the session's CURRENT confirmed review. Idempotent: the same
   * booking handoff never yields a second IRCTC handoff.
   */
  create(s: BookingSession, now: number, opts: { language?: IrctcLanguage } = {}): IrctcResult<{ view: IrctcHandoffView; created: boolean }> {
    const h = s.handoff;
    const cf = s.confirmation;
    if (!h || h.status !== 'READY' || !cf || cf.status !== 'VALID' || !s.review?.valid || s.review.reviewVersion !== h.snapshot.reviewVersion
      || cf.reviewVersion !== h.snapshot.reviewVersion) {
      return err('IRCTC_HANDOFF_NOT_READY', 'IRCTC handoff ke liye pehle current review confirm hona chahiye.');
    }
    if (reviewFingerprint(s) !== h.snapshot.fingerprint) return err('STALE_HANDOFF', IRCTC_TEXT.STALE_HANDOFF);
    const existingId = this.bySession.get(s.sessionId);
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing && existing.bookingHandoffId === h.snapshot.handoffId) {
      this.refresh(existing, s, now);
      if (!IRCTC_TERMINAL_STATUSES.includes(existing.status)) { this.sync(s, existing); return { ok: true, value: { view: this.view(existing), created: false } }; }
    }
    const snap = h.snapshot;
    if (snap.validatedPassengers.length > IRCTC_MAX_PASSENGERS) return err('IRCTC_PASSENGER_LIMIT_EXCEEDED', IRCTC_TEXT.PASSENGER_LIMIT, 422);
    if (!snap.validatedPassengers.length) return err('IRCTC_HANDOFF_NOT_READY', 'Passenger details poori nahi hain.');
    const from = formatIrctcStation(snap.journey.origin, snap.journey.originName);
    const to = formatIrctcStation(snap.journey.destination, snap.journey.destinationName);
    const dateIrctc = formatIrctcDate(snap.date);
    if (!from || !to || !dateIrctc) return err('IRCTC_HANDOFF_NOT_READY', 'Journey details IRCTC format mein convert nahi ho paayi.');
    const notConfirmed: NotConfirmed[] = [];
    const passengers = snap.validatedPassengers.map((p, i) => {
      const f = formatIrctcPassenger(p, i + 1);
      for (const n of f.notConfirmed) notConfirmed.push({ field: n.field, passengerIndex: i + 1, reason: n.reason });
      return f.fill;
    });
    const travelClass = formatIrctcClass(snap.selectedClass);
    if (!travelClass.label) notConfirmed.push({ field: 'travelClass', reason: 'CLASS_LABEL_UNKNOWN' });
    if (existing) this.retire(existing);
    const rec: IrctcHandoffRecord = {
      handoffId: `irh_${randomUUID()}`, sessionId: s.sessionId, bridgeToken: randomBytes(32).toString('hex'),
      bookingHandoffId: snap.handoffId, reviewVersion: snap.reviewVersion, fingerprint: snap.fingerprint,
      status: 'READY', language: opts.language === 'hi' ? 'hi' : 'en', languageSelectorMissing: false,
      createdAt: now, expiresAt: now + this.ttlMs, updatedAt: now,
      data: {
        mockData: snap.availabilitySnapshot.dataSource === 'MOCK' || snap.fareSnapshot.dataSource === 'MOCK',
        journey: { from, to, dateIso: snap.date, dateIrctc },
        train: { number: snap.selectedTrain.trainNumber, name: snap.selectedTrain.trainName ?? null, departure: snap.selectedTrain.departure ?? null, arrival: snap.selectedTrain.arrival ?? null },
        travelClass, quota: { code: 'GN', label: 'GENERAL' }, passengers
      },
      notConfirmed, filledFields: new Set(), userOverrides: new Set(), lastPage: null, pastFinalStep: false, events: []
    };
    this.byId.set(rec.handoffId, rec);
    this.bySession.set(s.sessionId, rec.handoffId);
    this.sync(s, rec);
    this.log({ event: 'IRCTC_HANDOFF_CREATED', handoffId: rec.handoffId, reviewVersion: rec.reviewVersion, passengers: passengers.length, notConfirmed: notConfirmed.length, mockData: rec.data.mockData });
    return { ok: true, value: { view: this.view(rec), created: true } };
  }

  /** Current view for the session (re-checked for staleness / expiry). */
  viewFor(s: BookingSession, now: number): IrctcHandoffView | null {
    const rec = this.recordFor(s.sessionId);
    if (!rec) return null;
    this.refresh(rec, s, now);
    this.sync(s, rec);
    return this.view(rec);
  }

  /** Session-owner access for the Assist page / extension launch: view + snapshot + bridge token. */
  ownerAccess(s: BookingSession, now: number): { view: IrctcHandoffView; snapshot: IrctcHandoffSnapshot; bridgeToken: string } | null {
    const rec = this.recordFor(s.sessionId);
    if (!rec) return null;
    this.refresh(rec, s, now);
    this.sync(s, rec);
    return { view: this.view(rec), snapshot: this.snapshotOf(rec), bridgeToken: rec.bridgeToken };
  }

  setLanguage(s: BookingSession, language: IrctcLanguage, now: number): IrctcResult<IrctcHandoffView> {
    const rec = this.recordFor(s.sessionId);
    if (!rec) return err('IRCTC_HANDOFF_NOT_FOUND', 'IRCTC handoff nahi mila.', 404);
    this.refresh(rec, s, now);
    if (IRCTC_TERMINAL_STATUSES.includes(rec.status)) return err('HANDOFF_TERMINAL', irctcStatusMessage(rec.status));
    rec.language = language === 'hi' ? 'hi' : 'en'; rec.updatedAt = now;
    this.sync(s, rec);
    return { ok: true, value: this.view(rec) };
  }

  /** Extension / Assist page snapshot fetch (bridge token required). */
  snapshot(handoffId: string, token: unknown, s: BookingSession | undefined, now: number): IrctcResult<IrctcHandoffSnapshot> {
    const rec = this.authorize(handoffId, token);
    if (!rec.ok) return rec;
    if (s) { this.refresh(rec.value, s, now); this.sync(s, rec.value); }
    return { ok: true, value: this.snapshotOf(rec.value) };
  }

  /** Metadata-only progress event from the extension / Assist page. */
  applyEvent(handoffId: string, token: unknown, body: unknown, s: BookingSession | undefined, now: number): IrctcResult<IrctcHandoffView> {
    const auth = this.authorize(handoffId, token);
    if (!auth.ok) return auth;
    const rec = auth.value;
    if (!checkNoSensitiveData(body).ok) return err('SENSITIVE_DATA_REJECTED', 'Password, OTP, CAPTCHA, card/UPI details ya tokens accept nahi kiye jaate.', 400);
    const ev = parseEvent(body);
    if (!ev) return err('INVALID_EVENT', 'Event format galat hai (sirf metadata allowed hai).', 400);
    if (s) this.refresh(rec, s, now);
    // An UNKNOWN outcome may still be resolved by IRCTC's own evidence (confirmation / failure page seen later);
    // every other terminal status stays terminal.
    const resolvesUnknown = rec.status === 'BOOKING_STATUS_UNKNOWN' && ev.type === 'PAGE_DETECTED' && (ev.page === 'CONFIRMATION' || ev.page === 'FAILURE');
    if (IRCTC_TERMINAL_STATUSES.includes(rec.status) && !resolvesUnknown) return err('HANDOFF_TERMINAL', irctcStatusMessage(rec.status));
    this.transition(rec, ev);
    rec.updatedAt = now;
    rec.events.push({ type: ev.type, ...('page' in ev ? { page: ev.page } : {}), ...('field' in ev ? { field: ev.field } : {}), at: new Date(now).toISOString() });
    if (rec.events.length > 60) rec.events.splice(0, rec.events.length - 60);
    if (s) this.sync(s, rec);
    this.log({ event: 'IRCTC_HANDOFF_EVENT', handoffId: rec.handoffId, type: ev.type, page: 'page' in ev ? ev.page : undefined, status: rec.status,
      fields: ev.type === 'FIELDS_FILLED' ? ev.filled.length : undefined });
    return { ok: true, value: this.view(rec) };
  }

  /** Booking details changed / confirmation invalidated → the IRCTC handoff is stale (before the final step). */
  markStale(s: BookingSession, reason: string, now: number): boolean {
    const rec = this.recordFor(s.sessionId);
    if (!rec || IRCTC_TERMINAL_STATUSES.includes(rec.status) || rec.pastFinalStep) return false;
    rec.status = 'STALE_HANDOFF'; rec.updatedAt = now;
    this.sync(s, rec);
    this.log({ event: 'IRCTC_HANDOFF_STALE', handoffId: rec.handoffId, reason: reason.split(':')[0] });
    return true;
  }

  sessionOf(handoffId: string): string | null { return this.byId.get(handoffId)?.sessionId ?? null; }

  /** Test / audit view of the metadata event trail (never values). */
  eventsOf(handoffId: string): ReadonlyArray<{ type: string; page?: string; field?: string; at: string }> { return [...(this.byId.get(handoffId)?.events || [])]; }

  // ---------------------------------------------------------------------------------------------------------------

  private recordFor(sessionId: string): IrctcHandoffRecord | undefined {
    const id = this.bySession.get(sessionId);
    return id ? this.byId.get(id) : undefined;
  }

  private retire(rec: IrctcHandoffRecord): void {
    if (!IRCTC_TERMINAL_STATUSES.includes(rec.status)) rec.status = rec.pastFinalStep ? 'BOOKING_STATUS_UNKNOWN' : 'STALE_HANDOFF';
    rec.bridgeToken = randomBytes(32).toString('hex'); // the old token stops working
  }

  private authorize(handoffId: string, token: unknown): IrctcResult<IrctcHandoffRecord> {
    const rec = this.byId.get(String(handoffId || ''));
    if (!rec) return err('IRCTC_HANDOFF_NOT_FOUND', 'IRCTC handoff nahi mila.', 404);
    const t = typeof token === 'string' ? token : '';
    const a = Buffer.from(t); const b = Buffer.from(rec.bridgeToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return err('BRIDGE_TOKEN_INVALID', 'Bridge token valid nahi hai.', 401);
    return { ok: true, value: rec };
  }

  /** Expiry + staleness against the live session (never after the user reached the final steps). */
  private refresh(rec: IrctcHandoffRecord, s: BookingSession, now: number): void {
    if (IRCTC_TERMINAL_STATUSES.includes(rec.status) || rec.pastFinalStep) return;
    const h = s.handoff;
    if (!h || h.snapshot.handoffId !== rec.bookingHandoffId || h.status === 'INVALIDATED' || reviewFingerprint(s) !== rec.fingerprint) {
      rec.status = 'STALE_HANDOFF'; rec.updatedAt = now; return;
    }
    if (now >= rec.expiresAt) { rec.status = 'EXPIRED'; rec.updatedAt = now; }
  }

  private transition(rec: IrctcHandoffRecord, ev: IrctcHandoffEvent): void {
    switch (ev.type) {
      case 'PAGE_DETECTED': {
        rec.lastPage = ev.page;
        const next = PAGE_STATUS[ev.page];
        if (!next) return;
        // outcome pages always apply; otherwise a user pause is respected (status kept, page recorded)
        if (next === 'COMPLETED' || next === 'BOOKING_FAILED') { rec.status = next; return; }
        if (rec.status === 'PAUSED') { rec.pausedFrom = next; return; }
        if (next === 'PASSENGER_PAGE' && rec.status === 'READY_FOR_USER_BOOK') return; // same page, still waiting for the user
        rec.status = next;
        if (FINAL_STAGE.has(next)) rec.pastFinalStep = true;
        return;
      }
      case 'FIELDS_FILLED':
        for (const f of ev.filled) rec.filledFields.add(f);
        for (const sk of ev.skipped || []) if (!rec.notConfirmed.some(n => n.field === sk.field && n.reason === sk.reason)) rec.notConfirmed.push({ field: sk.field, reason: sk.reason });
        return;
      case 'FIELD_NOT_CONFIRMED':
        if (!rec.notConfirmed.some(n => n.field === ev.field && n.reason === 'NOT_CONFIRMED_ON_PAGE')) rec.notConfirmed.push({ field: ev.field, reason: 'NOT_CONFIRMED_ON_PAGE' });
        return;
      case 'USER_OVERRIDE':
        // the user's own edit wins — never overwritten; the assistant pauses so the user decides
        rec.userOverrides.add(ev.field);
        if (rec.status !== 'PAUSED') { rec.pausedFrom = rec.status; rec.status = 'PAUSED'; }
        return;
      case 'LANGUAGE_SELECTED': rec.language = ev.language; rec.languageSelectorMissing = false; return;
      case 'LANGUAGE_SELECTOR_MISSING': rec.languageSelectorMissing = true; return;
      case 'FINAL_CONTROL_HIGHLIGHTED': {
        // only when every passenger field could be filled; otherwise the user still has fields to complete
        const blocking = rec.notConfirmed.filter(n => n.field.startsWith('passenger') && n.field !== 'passengerBerth' && n.field !== 'passengerFood');
        if (ev.page === 'PASSENGER' && !blocking.length && rec.status !== 'PAUSED') { rec.status = 'READY_FOR_USER_BOOK'; rec.pastFinalStep = true; }
        return;
      }
      case 'PAUSED': if (rec.status !== 'PAUSED') { rec.pausedFrom = rec.status; rec.status = 'PAUSED'; } return;
      case 'RESUMED': if (rec.status === 'PAUSED') { rec.status = rec.pausedFrom || 'READY'; rec.pausedFrom = undefined; } return;
      case 'STOPPED': rec.status = rec.pastFinalStep ? 'BOOKING_STATUS_UNKNOWN' : 'STOPPED'; return;
      case 'FLOW_ENDED_WITHOUT_CONFIRMATION': rec.status = rec.pastFinalStep ? 'BOOKING_STATUS_UNKNOWN' : 'STOPPED'; return;
    }
  }

  private message(rec: IrctcHandoffRecord): string {
    if (rec.status === 'PAUSED' && rec.userOverrides.size) return `Aapne ${[...rec.userOverrides].join(', ')} khud badla hai — BookKaro use overwrite nahi karega. Resume karne par baaki fields fill hongi.`;
    if (rec.status === 'PASSENGER_PAGE' && rec.notConfirmed.length) return `${IRCTC_TEXT.PASSENGER_PAGE} Ye fields aap khud bhariye: ${[...new Set(rec.notConfirmed.map(n => n.field))].join(', ')} (IRCTC_FIELD_NOT_CONFIRMED).`;
    const base = irctcStatusMessage(rec.status);
    return rec.languageSelectorMissing && rec.status === 'LANGUAGE_SELECTION' ? IRCTC_TEXT.LANGUAGE_UNAVAILABLE : base;
  }

  private view(rec: IrctcHandoffRecord): IrctcHandoffView {
    return {
      handoffId: rec.handoffId, status: rec.status, createdAt: new Date(rec.createdAt).toISOString(), expiresAt: new Date(rec.expiresAt).toISOString(),
      language: rec.language, mockData: rec.data.mockData, reviewVersion: rec.reviewVersion, passengersCount: rec.data.passengers.length,
      trainNumber: rec.data.train.number, travelClass: rec.data.travelClass.code, dateIso: rec.data.journey.dateIso,
      message: this.message(rec), lastPage: rec.lastPage, filledFields: [...rec.filledFields], notConfirmed: rec.notConfirmed.map(n => ({ ...n })),
      userOverrides: [...rec.userOverrides], updatedAt: new Date(rec.updatedAt).toISOString()
    };
  }

  private snapshotOf(rec: IrctcHandoffRecord): IrctcHandoffSnapshot {
    const base = {
      handoffId: rec.handoffId, status: rec.status, createdAt: new Date(rec.createdAt).toISOString(), expiresAt: new Date(rec.expiresAt).toISOString(),
      language: rec.language, ...structuredClone(rec.data), userActions: IRCTC_USER_ACTIONS, notConfirmed: rec.notConfirmed.map(n => ({ ...n })), message: this.message(rec),
      schemaVersion: IRCTC_HANDOFF_SCHEMA_VERSION, sourceReviewVersion: rec.reviewVersion
    };
    // P39.3: integrity over the validated payload, keyed by this handoff's bridge token (no new secret / env var)
    return { ...base, integrity: createHmac('sha256', rec.bridgeToken).update(irctcIntegrityPayload(base)).digest('hex') };
  }

  /**
   * Session copy = statuses / field names only. The user-facing message (it names login / OTP / CAPTCHA steps the user
   * does on IRCTC) is rendered for the API view and the chat card, never persisted on the BookingSession, so the session
   * never carries credential vocabulary (P33 [18] invariant).
   */
  private sync(s: BookingSession, rec: IrctcHandoffRecord): void { const { message: _m, ...v } = this.view(rec); s.irctcHandoff = v; }
}

/** Strict event parser — unknown keys (e.g. a field VALUE) are rejected: events are metadata only. */
export function parseEvent(body: unknown): IrctcHandoffEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const type = String(b.type || '');
  const allowed = EVENT_KEYS[type];
  if (!allowed) return null;
  for (const k of Object.keys(b)) if (k !== 'type' && k !== 'at' && !allowed.includes(k)) return null;
  const page = (v: unknown): IrctcPageKind | null => (IRCTC_PAGE_KINDS as readonly string[]).includes(String(v)) ? v as IrctcPageKind : null;
  const field = (v: unknown): IrctcFillableField | null => FIELD_SET.has(String(v)) ? v as IrctcFillableField : null;
  switch (type) {
    case 'PAGE_DETECTED': { const p = page(b.page); return p ? { type, page: p } : null; }
    case 'FINAL_CONTROL_HIGHLIGHTED': { const p = page(b.page); return p ? { type, page: p } : null; }
    case 'FIELDS_FILLED': {
      const p = page(b.page);
      if (!p || !Array.isArray(b.filled) || b.filled.length > 60) return null;
      const filled = b.filled.map(field);
      if (filled.some(f => !f)) return null;
      const skippedIn = b.skipped === undefined ? [] : b.skipped;
      if (!Array.isArray(skippedIn) || skippedIn.length > 60) return null;
      const skipped: Array<{ field: IrctcFillableField; reason: string }> = [];
      for (const x of skippedIn) {
        if (!x || typeof x !== 'object') return null;
        const f = field((x as any).field); const reason = String((x as any).reason || '');
        if (!f || !/^[A-Z_]{3,40}$/.test(reason) || Object.keys(x).some(k => k !== 'field' && k !== 'reason')) return null;
        skipped.push({ field: f, reason });
      }
      return { type, page: p, filled: filled as IrctcFillableField[], skipped };
    }
    case 'FIELD_NOT_CONFIRMED': case 'USER_OVERRIDE': { const f = field(b.field); return f ? { type, field: f } as IrctcHandoffEvent : null; }
    case 'LANGUAGE_SELECTED': return b.language === 'en' || b.language === 'hi' ? { type, language: b.language } : null;
    default: return { type } as IrctcHandoffEvent;
  }
}

/** Process-wide manager (in-memory, like the session store). */
export const irctcHandoffManager = new IrctcHandoffManager({
  log: (e) => { if (process.env.NODE_ENV !== 'test') console.log(JSON.stringify({ irctc: e })); }
});
