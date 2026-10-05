/**
 * PnrStatusService + live-status normalization (Prompt 14).
 *
 *   LLM → CHECK_PNR → ToolCallValidator (grounding, ownership) → LLMToolCallingRuntime
 *       → PnrStatusService.check → RailwayToolService → active RailwayProvider → normalized result
 *
 *  - malformed PNR → INVALID_PNR, provider NOT called
 *  - every call is FRESH (no cache, no reuse of an earlier answer as "current")
 *  - bounded by a timeout → PNR_PROVIDER_TIMEOUT; exceptions → PNR_PROVIDER_ERROR
 *  - provider output is validated: the PNR must echo the request, status text is charset/length
 *    restricted, passenger rows are typed. Anything else → PNR_PROVIDER_ERROR (never shown as fact)
 *  - provider unavailable (e.g. the Phase-1 mock has no PNR data) → PNR_STATUS_UNAVAILABLE (no fake status)
 * Booking status (BookingRecord), PNR status (this) and live train status (TRACK_TRAIN) stay separate.
 */
import type { RailwayToolService } from '../../railway/tools/railway-tool-service';
import { normalizePnrInput, maskPnr } from './pnr-validator';

export interface NormalizedPnrStatus {
  pnr: string;
  pnrMasked: string;
  pnrStatus: string;
  chartStatus: string | null;
  trainNumber: string | null;
  trainName: string | null;
  journeyDate: string | null;
  from: string | null;
  to: string | null;
  travelClass: string | null;
  passengers: Array<{ number: number; bookingStatus: string; currentStatus: string }>;
  dataSource: 'MOCK' | 'LIVE';
  providerId: string;
  retrievedAt: string;
  fresh: true;
}

export interface NormalizedLiveStatus {
  /** P38 (web connector only): unverified crowd-sourced data + extra fields it supplied. */
  verification?: 'UNVERIFIED_WEB'; sourceNote?: string; nextStationName?: string; platformNumber?: string; statusAsOf?: string;
  trainNumber: string;
  trainName: string | null;
  currentStatus: string;
  currentStationCode: string | null;
  currentStationName: string | null;
  delayMinutes: number | null;
  lastUpdated: string | null;
  dataSource: 'MOCK' | 'LIVE';
  providerId: string;
  retrievedAt: string;
  fresh: true;
}

export type LiveToolResponse<T> =
  | { ok: true; data: T; meta: { providerId: string; source: string; latencyMs: number } }
  | { ok: false; error: { code: string; message: string }; meta?: { providerId: string; source: string; latencyMs: number } };

export const PNR_MESSAGES = {
  PNR_STATUS_UNAVAILABLE: 'PNR status check abhi available nahi hai — railway provider se PNR data nahi mila.',
  PNR_PROVIDER_TIMEOUT: 'Railway provider ne time par jawab nahi diya — PNR status abhi verify nahi ho paaya. Thodi der baad try karein.',
  PNR_PROVIDER_ERROR: 'Railway provider se PNR status ka sahi jawab nahi mila — status verify nahi ho paaya.',
  PNR_NOT_FOUND: 'Railway provider ko yeh PNR nahi mila. Kripya PNR number dobara check karein.',
  LIVE_STATUS_UNAVAILABLE: 'Live train status abhi available nahi hai — railway provider se live data nahi mila.',
  LIVE_STATUS_TIMEOUT: 'Railway provider ne time par jawab nahi diya — live status abhi verify nahi ho paaya.',
  LIVE_STATUS_PROVIDER_ERROR: 'Railway provider se live status ka sahi jawab nahi mila.',
  LIVE_STATUS_NOT_FOUND: 'Is train ka live status provider ke paas abhi nahi hai — train shayad abhi chal nahi rahi.'
} as const;

const TEXT_RE = /^[A-Za-z0-9 /,.()#:+&'-]{1,80}$/;
const TRAIN_RE = /^\d{4,5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATION_RE = /^[A-Z]{2,5}$/;
const CLASS_RE = /^[A-Z0-9]{1,3}$/;
const optText = (v: unknown, re = TEXT_RE): string | null | undefined => v === undefined || v === null ? null : (typeof v === 'string' && re.test(v.trim()) ? v.trim() : undefined);

export const DEFAULT_LIVE_TIMEOUT_MS = 8000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<'TIMEOUT'>(res => { timer = setTimeout(() => res('TIMEOUT'), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class PnrStatusService {
  constructor(private readonly tools: RailwayToolService, private readonly timeoutMs = DEFAULT_LIVE_TIMEOUT_MS) {}

  /** Fresh PNR status for an already-grounded PNR. Malformed → INVALID_PNR without a provider call. */
  async check(rawPnr: unknown): Promise<LiveToolResponse<NormalizedPnrStatus>> {
    const v = normalizePnrInput(rawPnr);
    if (!v.ok) return { ok: false, error: { code: 'INVALID_PNR', message: v.message } };
    const t0 = Date.now();
    let raw: any;
    try {
      raw = await withTimeout(this.tools.CHECK_PNR(v.pnr), this.timeoutMs);
    } catch {
      return { ok: false, error: { code: 'PNR_PROVIDER_ERROR', message: PNR_MESSAGES.PNR_PROVIDER_ERROR } };
    }
    if (raw === 'TIMEOUT') return { ok: false, error: { code: 'PNR_PROVIDER_TIMEOUT', message: PNR_MESSAGES.PNR_PROVIDER_TIMEOUT } };
    const meta = { providerId: String(raw?.meta?.providerId || 'unknown'), source: String(raw?.meta?.source || 'unknown'), latencyMs: Date.now() - t0 };
    return normalizePnrResponse(raw, v.pnr, meta);
  }
}

export function normalizePnrResponse(raw: any, requestedPnr: string, meta: { providerId: string; source: string; latencyMs: number }): LiveToolResponse<NormalizedPnrStatus> {
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') return { ok: false, error: { code: 'PNR_PROVIDER_ERROR', message: PNR_MESSAGES.PNR_PROVIDER_ERROR }, meta };
  if (!raw.ok) {
    const c = String(raw.error?.code || '');
    if (/TIMEOUT/.test(c)) return { ok: false, error: { code: 'PNR_PROVIDER_TIMEOUT', message: PNR_MESSAGES.PNR_PROVIDER_TIMEOUT }, meta };
    if (/NOT_FOUND|INVALID_PNR/.test(c)) return { ok: false, error: { code: 'INVALID_PNR', message: PNR_MESSAGES.PNR_NOT_FOUND }, meta };
    if (/UNAVAILABLE|NOT_IMPLEMENTED|NOT_SUPPORTED/.test(c)) return { ok: false, error: { code: 'PNR_STATUS_UNAVAILABLE', message: PNR_MESSAGES.PNR_STATUS_UNAVAILABLE }, meta };
    return { ok: false, error: { code: 'PNR_PROVIDER_ERROR', message: PNR_MESSAGES.PNR_PROVIDER_ERROR }, meta };
  }
  const d = raw.data;
  const fail = () => ({ ok: false as const, error: { code: 'PNR_PROVIDER_ERROR', message: PNR_MESSAGES.PNR_PROVIDER_ERROR }, meta });
  if (!d || typeof d !== 'object' || d.pnr !== requestedPnr) return fail();          // must echo the requested PNR
  const status = optText(d.status);
  if (!status) return fail();                                                       // no status → nothing to report
  const chart = optText(d.chartStatus), trainNumber = optText(d.trainNumber, TRAIN_RE), trainName = optText(d.trainName);
  const journeyDate = optText(d.journeyDate, DATE_RE), from = optText(d.from, STATION_RE), to = optText(d.to, STATION_RE), cls = optText(d.travelClass, CLASS_RE);
  if ([chart, trainNumber, trainName, journeyDate, from, to, cls].some(x => x === undefined)) return fail();
  const passengers: NormalizedPnrStatus['passengers'] = [];
  if (d.passengers !== undefined) {
    if (!Array.isArray(d.passengers) || d.passengers.length > 6) return fail();
    for (const p of d.passengers) {
      const bs = optText(p?.bookingStatus), cs = optText(p?.currentStatus);
      if (!p || !Number.isInteger(p.number) || p.number < 1 || p.number > 6 || !bs || !cs) return fail();
      passengers.push({ number: p.number, bookingStatus: bs, currentStatus: cs });
    }
  }
  return {
    ok: true,
    data: {
      pnr: requestedPnr, pnrMasked: maskPnr(requestedPnr)!, pnrStatus: status, chartStatus: chart ?? null,
      trainNumber: trainNumber ?? null, trainName: trainName ?? null, journeyDate: journeyDate ?? null, from: from ?? null, to: to ?? null, travelClass: cls ?? null,
      passengers, dataSource: /mock/i.test(meta.source) ? 'MOCK' : 'LIVE', providerId: meta.providerId, retrievedAt: new Date().toISOString(), fresh: true
    },
    meta
  };
}

/** Fresh live train status (TRACK_TRAIN) with the same validation discipline. */
export class LiveTrainStatusService {
  constructor(private readonly tools: RailwayToolService, private readonly timeoutMs = DEFAULT_LIVE_TIMEOUT_MS) {}

  async track(trainNumber: string): Promise<LiveToolResponse<NormalizedLiveStatus>> {
    if (typeof trainNumber !== 'string' || !TRAIN_RE.test(trainNumber)) return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: 'Train number 4-5 digits ka hona chahiye.' } };
    const t0 = Date.now();
    let raw: any;
    try { raw = await withTimeout(this.tools.TRACK_TRAIN(trainNumber), this.timeoutMs); }
    catch { return { ok: false, error: { code: 'LIVE_STATUS_PROVIDER_ERROR', message: PNR_MESSAGES.LIVE_STATUS_PROVIDER_ERROR } }; }
    if (raw === 'TIMEOUT') return { ok: false, error: { code: 'LIVE_STATUS_TIMEOUT', message: PNR_MESSAGES.LIVE_STATUS_TIMEOUT } };
    const meta = { providerId: String(raw?.meta?.providerId || 'unknown'), source: String(raw?.meta?.source || 'unknown'), latencyMs: Date.now() - t0 };
    return normalizeTrackResponse(raw, trainNumber, meta);
  }
}

/** P38: plain display text from a web connector result (bounded; never markup). */
const webText = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() && !/[<>]/.test(v) ? v.trim().slice(0, 200) : undefined);

export function normalizeTrackResponse(raw: any, trainNumber: string, meta: { providerId: string; source: string; latencyMs: number }): LiveToolResponse<NormalizedLiveStatus> {
  const fail = (code = 'LIVE_STATUS_PROVIDER_ERROR') => ({ ok: false as const, error: { code, message: (PNR_MESSAGES as any)[code] }, meta });
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') return fail();
  if (!raw.ok) {
    const c = String(raw.error?.code || '');
    if (/TIMEOUT/.test(c)) return fail('LIVE_STATUS_TIMEOUT');
    if (/UNAVAILABLE|NOT_IMPLEMENTED|NOT_SUPPORTED/.test(c)) return fail('LIVE_STATUS_UNAVAILABLE');
    if (c === 'NOT_FOUND' && meta.providerId === 'railyatri') return fail('LIVE_STATUS_NOT_FOUND'); // P38: honest cause, not a generic error
    return fail();
  }
  const d = raw.data;
  if (!d || typeof d !== 'object' || d.trainNumber !== trainNumber) return fail();
  const status = optText(d.currentStatus);
  if (!status) return fail();
  const code = optText(d.currentStationCode, STATION_RE), name = optText(d.currentStationName), tn = optText(d.trainName), upd = optText(d.lastUpdated, /^[0-9T:.+\-Z ]{4,40}$/);
  if ([code, name, tn, upd].some(x => x === undefined)) return fail();
  const delay = d.delayMinutes === undefined || d.delayMinutes === null ? null : (Number.isInteger(d.delayMinutes) && d.delayMinutes >= 0 && d.delayMinutes < 2000 ? d.delayMinutes : undefined);
  if (delay === undefined) return fail();
  return {
    ok: true,
    data: {
      trainNumber, trainName: tn ?? null, currentStatus: status, currentStationCode: code ?? null, currentStationName: name ?? null, delayMinutes: delay,
      lastUpdated: upd ?? null, dataSource: /mock/i.test(meta.source) ? 'MOCK' : 'LIVE', providerId: meta.providerId, retrievedAt: new Date().toISOString(), fresh: true,
      // P38: a web connector (RailYatri) result keeps its UNVERIFIED label + the extra crowd-sourced fields it supplied
      ...(meta.providerId === 'railyatri' ? {
        verification: 'UNVERIFIED_WEB' as const, sourceNote: webText(d.sourceNote) ?? 'Crowd-sourced (RailYatri) — unverified.',
        ...(webText(d.nextStationName) ? { nextStationName: webText(d.nextStationName) } : {}), ...(webText(d.platformNumber) ? { platformNumber: webText(d.platformNumber) } : {}),
        ...(webText(d.statusAsOf) ? { statusAsOf: webText(d.statusAsOf) } : {})
      } : {})
    },
    meta
  };
}
