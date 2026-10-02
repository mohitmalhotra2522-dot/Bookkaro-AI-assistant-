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
  handoff?: { handoffId: string; status: string; statusReason: string | null; reviewVersion: number; expiresAt: string } | null;
  bookingLifecycle?: string | null;
  execution?: any;
  /** Prompt 11 — secure handoff session (status + capability only; snapshot stays server-side). */
  handoffSession?: { handoffSessionId: string; status: string; statusReason: string | null; reviewVersion: number; expiresAt: string; executorCapability: { enabled: boolean; executorName: string; supportsRealBooking: boolean; reason?: string } } | null;
  confirmation?: { status: string; reviewVersion: number; sessionVersion: number; confirmedAt: string; statusReason: string | null } | null;
  executorCapability?: { enabled: boolean; executorName: string; supportsRealBooking: boolean; reason?: string };
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
