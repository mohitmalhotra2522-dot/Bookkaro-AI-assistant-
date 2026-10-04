/**
 * Prompt 16 — AssistantResponse builder (Part 41 / 42).
 *
 * Built from the FINAL validated turn output (after applier, fact guards and deterministic phrasing).
 * TEXT and VOICE share the same backend facts; speechText is a concise rendering of the same
 * validated text (never new facts): in VOICE the message is already short; in TEXT the spoken
 * form keeps the first sentence(s) and the pending question.
 */
import type { AssistantResponse, ConversationErrorCode, PendingQuestion } from '@shared/conversation-context';
import { conciseForVoice } from '@shared/voice/speech-renderer';

/** Map project error codes onto the Part 46 recovery vocabulary (codes themselves are unchanged). */
export function toRecoveryCode(code?: string | null): ConversationErrorCode | null {
  if (!code) return null;
  const M: Record<string, ConversationErrorCode> = {
    INVALID_LLM_OUTPUT: 'INVALID_LLM_OUTPUT', INVALID_CONTEXT: 'INVALID_LLM_OUTPUT', UNKNOWN_INTENT: 'UNKNOWN_INTENT',
    AMBIGUOUS_ROUTE: 'AMBIGUOUS_ROUTE', AMBIGUOUS_STATION: 'AMBIGUOUS_STATION', AMBIGUOUS_DATE: 'AMBIGUOUS_DATE',
    INVALID_TRAIN_REFERENCE: 'INVALID_TRAIN_REFERENCE', INVALID_TRAIN_SELECTION: 'INVALID_TRAIN_REFERENCE', AMBIGUOUS_REFERENCE: 'INVALID_TRAIN_REFERENCE',
    INVALID_CLASS_SELECTION: 'INVALID_CLASS_REFERENCE', STALE_SEARCH_REFERENCE: 'STALE_RESULT_REFERENCE', STALE_TOOL_RESULT: 'STALE_RESULT_REFERENCE',
    MISSING_REQUIRED_FIELD: 'MISSING_CONTEXT', MISSING_CONTEXT: 'MISSING_CONTEXT', CONFIRMATION_NOT_PENDING: 'MISSING_CONTEXT', NO_CONFIRMATION_PENDING: 'MISSING_CONTEXT',
    CONTEXT_CONFLICT: 'CONTEXT_CONFLICT', TOOL_REJECTED: 'TOOL_REJECTED', TOOL_FAILED: 'TOOL_FAILED', UNKNOWN_TOOL: 'TOOL_REJECTED',
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND', MULTIPLE_BOOKINGS_MATCHED: 'BOOKING_NOT_FOUND',
    ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED', INVALID_ACTION_FOR_STATE: 'ACTION_NOT_ALLOWED', EXECUTION_LOCKED: 'ACTION_NOT_ALLOWED', UNSUPPORTED_ACTION: 'ACTION_NOT_ALLOWED'
  };
  return M[code] ?? null;
}

const CLARIFY: ReadonlySet<PendingQuestion> = new Set(['ASK_STATION_ROLE', 'ASK_STATION_CHOICE', 'ASK_CONTEXT_CONFLICT', 'ASK_CLARIFICATION']);

export function speechOf(text: string, mode: 'TEXT' | 'VOICE', question?: string): string {
  const flat = String(text || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  // P36-C.1.1: VOICE speech = a SELECTION of whole sentences of the validated reply (boundary/safety sentences and the
  // final question always kept, fact-free "details on screen" note when shortened). The screen keeps the full text.
  if (mode === 'VOICE') return conciseForVoice(String(text || ''), { question, detailsNote: true }).text;
  if (flat.length <= 160) return flat;
  const sentences = flat.split(/(?<=[.!?।])\s+/);
  let out = sentences[0];
  if (question && flat.includes(question) && !out.includes(question)) out = `${out} ${question}`;
  return out.trim();
}

export function buildAssistantResponse(a: {
  text: string; mode: 'TEXT' | 'VOICE'; state: string; pendingQuestion: PendingQuestion | null; question: string;
  cards: Array<{ type: string; data: any }>; steps: Array<{ toolCall: { name: string }; status: string; result: { error?: { code?: string } | null } }>;
  error?: { code: string; message: string } | null; rejectedClaims: string[];
}): AssistantResponse {
  return Object.freeze({
    text: a.text,
    speechText: speechOf(a.text, a.mode, a.question),
    mode: a.mode,
    state: a.state,
    pendingQuestion: a.pendingQuestion,
    displayData: a.cards,
    toolResults: a.steps.map(st => ({ tool: st.toolCall.name, ok: st.status === 'ok', ...(st.status !== 'ok' && st.result.error?.code ? { errorCode: String(st.result.error.code) } : {}) })),
    clarification: a.pendingQuestion && CLARIFY.has(a.pendingQuestion) ? (a.question || null) : null,
    requiresConfirmation: a.pendingQuestion === 'ASK_CONFIRMATION' || a.pendingQuestion === 'ASK_REVIEW_APPROVAL',
    error: a.error ? { code: a.error.code, recoveryCode: toRecoveryCode(a.error.code), message: a.error.message } : null,
    rejectedClaims: [...a.rejectedClaims]
  }) as AssistantResponse;
}
