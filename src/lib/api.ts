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
