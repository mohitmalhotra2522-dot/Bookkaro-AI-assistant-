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
  /** Prompt 10 — execution boundary (real booking disabled). */
  executionCapability?: { realBookingEnabled: boolean; configuredExecutor: string; effectiveExecutor: string; reason: string; executionPossible: false; configErrors: string[] };
  /** Prompt 16 — structured AssistantResponse + derived conversation context (no secrets, PNR masked). */
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
  extra: { searchResultsVersion?: number; expectedSessionVersion?: number; reviewVersion?: number } = {}
): Promise<ChatResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text, mode, ...extra })
  });
  if (!res.ok && res.status !== 409) throw new Error('Failed to send message');
  return res.json();
}
