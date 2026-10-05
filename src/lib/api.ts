export async function createSession(): Promise<string> {
  const res = await fetch('/api/session', { method: 'POST' });
  const data = await res.json();
  return data.sessionId;
}

export interface ChatResponse {
  sessionId: string;
  message: string;
  stale?: boolean;
  pendingInteraction?: { type: string; data?: any };
  pendingQuestion?: string;
  sessionVersion?: number;
  searchResultsVersion?: number;
  error?: { code: string; message: string } | null;
  events?: string[];
  state: string;
  cards: Array<{ type: string; data: any }>;
  context: any;
  toolActivity?: string;
  dataSourceLabel: string;
  turnLog?: any;
  reviewVersion?: number | null;
  confirmedReviewVersion?: number | null;
  readiness?: any;
  /** Prompt 19 — booking preparation summary (statuses / counts only; no passenger PII). */
  bookingPreparation?: { bookingPreparationState: string; passengerCollectionState: string; passengerCount: number | null; passengersComplete: number; reviewVersion: number | null; reviewStatus: string; confirmationStatus: string; availabilityStatus: string; fareStatus: string; missingPrerequisites: string[] };
  /** Prompt 10 — execution boundary (real booking disabled). */
  executionCapability?: { realBookingEnabled: boolean; configuredExecutor: string; effectiveExecutor: string; reason: string; executionPossible: false; configErrors: string[] };
  /** Prompt 16 — structured AssistantResponse + derived conversation context (no secrets, PNR masked). */
  /** Prompt 21/22: shared turn metadata (assistantText = grounded LLM wording shown to the user). */
  voice?: { assistantText: string; speechText: string; shouldSpeak: boolean; [k: string]: any };
  assistantResponse?: { text: string; speechText: string; clarification: string | null; requiresConfirmation: boolean; rejectedClaims: string[]; error: { code: string; recoveryCode: string | null; message: string } | null };
  conversationContext?: { activeJourneyId: string; pendingQuestion: string | null; missingFields: string[]; selectedTrain: string | null; selectedClass: string | null; activeBookingId: string | null; activePnrMasked: string | null; displayedResults: { resultSetId: string | null; items: ReadonlyArray<unknown> } };
  handoff?: { handoffId: string; status: string; statusReason: string | null; reviewVersion: number; expiresAt: string } | null;
  bookingLifecycle?: string | null;
  execution?: any;
  /** Prompt 11 — secure handoff session (status + capability only; snapshot stays server-side). */
  handoffSession?: { handoffSessionId: string; status: string; statusReason: string | null; reviewVersion: number; expiresAt: string; executorCapability: { enabled: boolean; executorName: string; supportsRealBooking: boolean; reason?: string } } | null;
  confirmation?: { status: string; reviewVersion: number; sessionVersion: number; confirmedAt: string; statusReason: string | null } | null;
  executorCapability?: { enabled: boolean; executorName: string; supportsRealBooking: boolean; reason?: string };
  /** Prompt 12 — booking provider (honest capabilities) + normalized execution record. */
  bookingProvider?: BookingProviderView;
  bookingExecution?: BookingExecutionView | null;
  /** Prompt 18 — logical turn + typed response; presentable=false → never show / speak (superseded). */
  turn?: { turnId: string; sequence: number; status: string; presentation: string };
  assistantTurnResponse?: { type: string; text: string; speechText?: string; turnId: string; sequence: number } | null;
  progress?: Array<{ type: string; text: string; speechText?: string }>;
  presentable?: boolean;
  lastEventSeq?: number;
}

export interface BookingProviderView {
  configured: string; effective: string; enabled: boolean; resolved: boolean; code: string | null;
  capabilities: { providerName: string; available: boolean; supportsBooking: boolean; supportsStatus: boolean; supportsCancellation: boolean; requiresExternalHandoff: boolean; supportsIdempotency: boolean; health: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN'; reason?: string };
}

/** Safe execution view: status, safe reference, authoritative PNR (only when the provider CONFIRMED). */
export interface BookingExecutionView {
  bookingExecutionId: string; providerName: string; status: string; code: string; providerStatus?: string;
  providerReference?: string; pnr?: string; failureCode?: string; submitted: boolean; retryBlocked: boolean; updatedAt: string;
  createdAt?: string; startedAt?: string | null; completedAt?: string | null; lastCheckedAt?: string | null;
  attemptCount?: number; reconciliationAttempts?: number; unresolved?: boolean; manualVerificationRequired?: boolean;
}

export interface ExecuteBookingResponse {
  code: string; message: string; duplicate: boolean; providerCalled: boolean; retryBlocked: boolean; manualVerificationRequired: boolean;
  state: string; bookingExecution: BookingExecutionView | null; bookingProvider: BookingProviderView; cards: Array<{ type: string; data: any }>;
}

/** Explicit execution request via the gateway → provider registry. Disabled provider in this build: nothing is booked. */
export async function executeBooking(sessionId: string): Promise<ExecuteBookingResponse> {
  const res = await fetch('/api/booking/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  return res.json();
}

/** Prompt 13: explicit booking status verification (bounded provider status lookup — never a new booking). */
export async function reconcileBooking(sessionId: string): Promise<{ code: string; message: string; providerCalled: boolean; manualVerificationRequired: boolean; state: string; bookingExecution: BookingExecutionView | null; cards: Array<{ type: string; data: any }> }> {
  const res = await fetch('/api/booking/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  return res.json();
}

export interface ConsumeHandoffResponse {
  code: string;
  message: string;
  duplicate: boolean;
  executorAttempted: boolean;
  executionStatus: string | null;
  handoffSession: ChatResponse['handoffSession'];
  realBooking: false;
  cards: Array<{ type: string; data: any }>;
}

/** Explicit handoff consumption — returns BOOKING_EXECUTION_DISABLED in this build (nothing is booked). */
export async function consumeHandoff(sessionId: string, handoffSessionId: string): Promise<ConsumeHandoffResponse> {
  const res = await fetch('/api/handoff/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, handoffSessionId })
  });
  return res.json();
}

export async function sendMessage(
  sessionId: string,
  text: string,
  mode: 'TEXT' | 'VOICE' = 'TEXT',
  extra: { searchResultsVersion?: number; expectedSessionVersion?: number; reviewVersion?: number; clientMessageId?: string; bargeIn?: boolean; transcript?: import('@shared/voice/transcript').VoiceTranscriptInfo } = {}
): Promise<ChatResponse> {
  // Prompt 17: one id per user message — a network retry of the SAME message is replayed server-side,
  // a new message (even an identical "abhi dobara check karo") gets a new id and fresh provider calls.
  const clientMessageId = extra.clientMessageId || newClientMessageId();
  const body = JSON.stringify({ sessionId, text, mode, ...extra, clientMessageId });
  let res: Response;
  try {
    res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  } catch {
    // one transparent retry on a dropped connection — same clientMessageId, so no duplicate tool execution
    res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  }
  if (!res.ok && res.status !== 409) throw new Error('Failed to send message');
  return res.json();
}

/** Prompt 18: ordered turn events (seq) for honest progress; reduce with reduceTurnEvent (out-of-order safe). */
export async function fetchTurnEvents(sessionId: string, after: number): Promise<{ events: import('@shared/turn-engine').TurnEvent[]; lastSeq: number }> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/turn-events?after=${after}`);
  if (!res.ok) return { events: [], lastSeq: after };
  return res.json();
}

/** Prompt 18: barge-in / stop — marks the spoken presentation (or in-flight turn) INTERRUPTED. */
export async function interruptTurn(sessionId: string, reason: 'BARGE_IN' | 'USER_STOP' = 'BARGE_IN'): Promise<void> {
  await fetch(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }).catch(() => undefined);
}

/** Prompt 18: reconnect — recover the SAME session's state / turn status / latest response (null = unknown session). */
export async function resumeSession(sessionId: string): Promise<import('@shared/turn-engine').TurnResumeSnapshot | null> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/resume`).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

/** Prompt 17: client message id (duplicate-delivery protection; not a cache key for railway data). */
export function newClientMessageId(): string {
  const r = (globalThis.crypto && 'randomUUID' in globalThis.crypto) ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `cm_${r.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 100);
}

/** P36-C: safe server STT capability (no key — the key never leaves the server). */
export interface VoiceConfig { stt: { enabled: boolean; provider: 'elevenlabs'; model: string; mode: 'batch'; keytermsEnabled: boolean } }
export async function fetchVoiceConfig(): Promise<VoiceConfig | null> {
  const res = await fetch('/api/voice/config').catch(() => null);
  if (!res || !res.ok) return null;
  return res.json().catch(() => null);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

/**
 * P36-C: ONE tap-to-talk recording (16 kHz mono PCM16) → server → ElevenLabs Scribe v2 batch → FINAL transcript.
 * Transcript only — this does NOT start an agent turn (the voice agent does that through /api/chat).
 */
export async function transcribeSpeech(req: { sessionId: string; voiceTurnId: string; audio: Uint8Array; durationMs: number }, signal: AbortSignal):
  Promise<{ ok: true; transcript: string; language?: string | null } | { ok: false; code: string; message?: string }> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: req.sessionId, voiceTurnId: req.voiceTurnId, mimeType: 'audio/pcm', sampleRate: 16000, durationMs: Math.round(req.durationMs), audioBase64: bytesToBase64(req.audio) })
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (res.ok && body && typeof body.transcript === 'string' && body.voiceTurnId === req.voiceTurnId) return { ok: true, transcript: body.transcript, language: body.language ?? null };
  return { ok: false, code: typeof body?.error === 'string' && /^STT_[A-Z_]+$/.test(body.error) ? body.error : (res.ok ? 'STT_PROVIDER_BAD_RESPONSE' : 'STT_PROVIDER_UNAVAILABLE'), message: typeof body?.message === 'string' ? body.message : undefined };
}

// ───────────── P38: IRCTC-style passenger form (deterministic backend validation) ─────────────
export interface PassengerFormSpec {
  sessionId: string;
  sessionVersion: number;
  train: { number: string; name: string; origin?: string; destination?: string; departure?: string; arrival?: string; date?: string; dataSource?: string };
  travelClass: string;
  berth: { options: string[]; note: string | null };
  food: { status: 'OFFERED' | 'NOT_INCLUDED' | 'UNKNOWN'; options: string[]; pantry: boolean | null; source: string | null; note: string };
  maxPassengers: number;
  passengersCount: number;
  passengers: Array<{ name: string; age: number | null; gender: string | null; berthPreference: string | null; foodPreference: string | null }>;
}
export interface PassengerFormInput { name: string; age: number | string; gender: string; berthPreference?: string; foodPreference?: string }
export type PassengerFormSubmitResult =
  | { ok: true; sessionVersion: number; passengersCount: number; changedFields: number; bookingState: string }
  | { ok: false; status: number; code: string; message: string; fieldErrors?: Array<{ passengerIndex: number; field: string; message: string }> };

export async function getPassengerForm(sessionId: string): Promise<{ ok: true; spec: PassengerFormSpec } | { ok: false; status: number; code: string; message: string }> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/passenger-form`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, code: data.code || 'ERROR', message: data.message || 'Passenger form abhi nahi khul paaya.' };
  return { ok: true, spec: data };
}

export async function submitPassengerForm(sessionId: string, body: { passengers: PassengerFormInput[]; expectedSessionVersion: number }): Promise<PassengerFormSubmitResult> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/passenger-form`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, code: data.code || 'ERROR', message: data.message || 'Details save nahi ho paayi.', fieldErrors: data.fieldErrors };
  return { ok: true, ...data };
}

// ---- P39: user-controlled IRCTC handoff (session owner). Never sends credentials; the bridge token is only handed
// to the BookKaro extension via same-window postMessage. ----
export type IrctcOwnerAccess = { view: import('@shared/irctc-handoff').IrctcHandoffView; snapshot: import('@shared/irctc-handoff').IrctcHandoffSnapshot; bridgeToken: string };
export async function getIrctcHandoff(sessionId: string): Promise<{ ok: true; access: IrctcOwnerAccess } | { ok: false; status: number; code: string; message: string }> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/irctc-handoff`, { cache: 'no-store' }).catch(() => null);
  if (!res) return { ok: false, status: 0, code: 'NETWORK', message: 'Network error' };
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, access: body } : { ok: false, status: res.status, code: body.code || `HTTP_${res.status}`, message: body.message || '' };
}
export async function irctcHandoffAction(sessionId: string, body: { action: 'create' | 'language'; language?: 'en' | 'hi' }): Promise<{ ok: boolean; code?: string; message?: string }> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/irctc-handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { ok: false, code: 'NETWORK' };
  const b = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, code: b.code, message: b.message };
}
export async function postIrctcEvent(handoffId: string, bridgeToken: string, event: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
  const res = await fetch(`/api/irctc/handoff/${encodeURIComponent(handoffId)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BookKaro-Bridge-Token': bridgeToken }, body: JSON.stringify(event) }).catch(() => null);
  if (!res) return { ok: false, code: 'NETWORK' };
  const b = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, code: b.code };
}
