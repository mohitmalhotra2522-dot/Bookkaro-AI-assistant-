/**
 * 2026-10-09 (approved) — LOCAL monthly request accounting for RailKit (Advance plan: 10,000 requests / calendar month).
 *
 * NOT AUTHORITATIVE. RailKit returns no quota / usage headers (only the 10-minute window policy), so this is a local
 * ESTIMATE of requests THIS process sent. It cannot see requests made by another process, another deployment sharing the
 * key, or the RailKit dashboard. A safety margin (default 200) is kept below the plan limit for that reason.
 *
 *   reserve()  BEFORE the pacer / dispatch — synchronous check-and-increment (no await between check and increment, so
 *              concurrent callers in this Node process can never over-commit);
 *   commit()   exactly when the HTTP request is dispatched → each real HTTP request is counted ONCE (a later failover or a
 *              same-train re-dispatch is a new request with its own reservation);
 *   release()  when it was never dispatched (local pacer refused / budget gone) → the reservation is returned.
 *
 * At the (effective) limit reserve() fails → the adapter answers RATE_LIMITED (local) WITHOUT a provider request, which the
 * existing failover / P42.9 fallback treats as an eligible fault → the next provider (RailCore → RailRadar) answers.
 *
 * The month is the CALENDAR month in IST (Asia/Kolkata); a new month resets the count. Optional persistence:
 * RAILKIT_QUOTA_STATE_FILE (JSON {month, used}; atomic tmp-file + rename, writes serialized). Without it the count
 * restarts at 0 on every process restart (stated in health as persisted:false). Single-instance only (no file lock).
 *
 *   RAILKIT_MONTHLY_LIMIT (default 10000) · RAILKIT_MONTHLY_SAFETY_MARGIN (default 200) · RAILKIT_MONTHLY_QUOTA=off
 */
import fs from 'node:fs';
import path from 'node:path';

type Env = Record<string, string | undefined>;
const IST_OFFSET_MS = 330 * 60_000;

export const LOCAL_QUOTA_NOTE = 'Local estimate of requests sent by this server process — NOT authoritative (RailKit returns no quota headers).';

/** Calendar month (YYYY-MM) in IST. */
export function istMonth(nowMs: number = Date.now()): string { return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 7); }
/** First instant of the next IST calendar month (ISO, UTC). */
export function nextIstMonthStart(nowMs: number = Date.now()): string {
  const d = new Date(nowMs + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - IST_OFFSET_MS).toISOString();
}

export interface MonthlyQuotaOptions { limit: number; safetyMargin: number; stateFile?: string | null; now?: () => number }
export type QuotaReservation =
  | { ok: true; id: number; month: string; /** settled once: committed (counted) or released */ state: 'open' | 'committed' | 'released' }
  | { ok: false; reason: 'LOCAL_MONTHLY_LIMIT'; month: string; used: number; effectiveLimit: number };

export interface MonthlyQuotaSnapshot {
  source: 'LOCAL_ESTIMATE'; authoritative: false; note: string; month: string; used: number; inFlight: number;
  limit: number; safetyMargin: number; effectiveLimit: number; remaining: number; exhausted: boolean;
  resetsAt: string; persisted: boolean; persistError: boolean;
}

export class MonthlyRequestQuota {
  private month: string;
  private used = 0;
  private readonly open = new Set<number>();
  private seq = 0;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private persistError = false;
  private readonly now: () => number;

  constructor(private readonly opts: MonthlyQuotaOptions) {
    this.now = opts.now || Date.now;
    this.month = istMonth(this.now());
    this.load();
  }

  get effectiveLimit(): number { return Math.max(0, Math.floor(this.opts.limit) - Math.max(0, Math.floor(this.opts.safetyMargin))); }

  /** Check-and-reserve one request slot (synchronous → atomic within this process). */
  reserve(): QuotaReservation {
    this.roll();
    if (this.used + this.open.size >= this.effectiveLimit) {
      return { ok: false, reason: 'LOCAL_MONTHLY_LIMIT', month: this.month, used: this.used, effectiveLimit: this.effectiveLimit };
    }
    const id = ++this.seq;
    this.open.add(id);
    return { ok: true, id, month: this.month, state: 'open' };
  }

  /** The request is being dispatched NOW → count it once (idempotent per reservation). */
  commit(r: QuotaReservation): void {
    if (!r.ok || r.state !== 'open') return;                // already counted / released → never twice
    r.state = 'committed';
    this.roll();
    // a reservation from a month that rolled over while it waited is still ONE request, sent (and counted) this month
    this.open.delete(r.id);
    this.used++;
    this.persist();
  }

  /** Never dispatched → return the reservation (no-op after commit). */
  release(r: QuotaReservation): void {
    if (!r.ok || r.state !== 'open') return;
    r.state = 'released';
    this.open.delete(r.id);
  }

  snapshot(): MonthlyQuotaSnapshot {
    this.roll();
    const eff = this.effectiveLimit;
    return { source: 'LOCAL_ESTIMATE', authoritative: false, note: LOCAL_QUOTA_NOTE, month: this.month, used: this.used, inFlight: this.open.size,
      limit: this.opts.limit, safetyMargin: this.opts.safetyMargin, effectiveLimit: eff, remaining: Math.max(0, eff - this.used - this.open.size),
      exhausted: this.used + this.open.size >= eff, resetsAt: nextIstMonthStart(this.now()), persisted: !!this.opts.stateFile, persistError: this.persistError };
  }

  /** Resolves when pending state writes are on disk (tests / shutdown). */
  flush(): Promise<void> { return this.writing; }

  private roll(): void {
    const m = istMonth(this.now());
    if (m === this.month) return;
    this.month = m; this.used = 0; this.open.clear();
    this.persist();
  }

  private load(): void {
    const f = this.opts.stateFile;
    if (!f) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.month === this.month && Number.isFinite(Number(j.used)) && Number(j.used) >= 0) this.used = Math.floor(Number(j.used));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') { this.persistError = true; console.warn(JSON.stringify({ event: 'railkit_quota_state_unreadable' })); }
    }
  }

  /** Coalesced, serialized, atomic (tmp + rename) write of {month, used}. Never throws. */
  private persist(): void {
    const f = this.opts.stateFile;
    if (!f) return;
    if (this.dirty) return;            // a queued write will pick up the latest values
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      const body = JSON.stringify({ month: this.month, used: this.used, source: 'LOCAL_ESTIMATE', updatedAt: new Date(this.now()).toISOString() });
      const tmp = `${f}.${process.pid}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(f), { recursive: true });
        await fs.promises.writeFile(tmp, body, { mode: 0o600 });
        await fs.promises.rename(tmp, f);
        this.persistError = false;
      } catch {
        this.persistError = true;
        try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
      }
    });
  }
}

const posInt = (v: string | undefined, d: number) => (Number(v) > 0 ? Math.floor(Number(v)) : d);
const nonNegInt = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number(v) >= 0 ? Math.floor(Number(v)) : d);

export function monthlyQuotaEnabled(env: Env = process.env): boolean {
  const v = String(env.RAILKIT_MONTHLY_QUOTA || '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0');
}

let railKitQuota: MonthlyRequestQuota | null = null;
/** Process-wide RailKit quota (shared by every RailKit adapter instance); null when RAILKIT_MONTHLY_QUOTA=off. */
export function railKitMonthlyQuota(env: Env = process.env): MonthlyRequestQuota | null {
  if (!monthlyQuotaEnabled(env)) return null;
  if (!railKitQuota) {
    railKitQuota = new MonthlyRequestQuota({
      limit: posInt(env.RAILKIT_MONTHLY_LIMIT, 10_000),
      safetyMargin: nonNegInt(env.RAILKIT_MONTHLY_SAFETY_MARGIN, 200),
      stateFile: String(env.RAILKIT_QUOTA_STATE_FILE || '').trim() || null
    });
  }
  return railKitQuota;
}
/** Tests only. */
export function resetRailKitMonthlyQuota(q: MonthlyRequestQuota | null = null): void { railKitQuota = q; }
