/**
 * PROMPT 34 — §2 STT integration boundary: the structured transcript the speech layer hands over.
 *
 * STT produces TRANSCRIPT INFORMATION only — text, interim/final status, confidence, language hint, timing and the
 * utterance identity. It never decides intent, never calls a railway tool and never touches booking state: a FINAL
 * transcript is handed to the SAME ConversationTurnEngine.processTurn() as typed text, and only the LLM agent decides
 * what it means. Interim transcripts are display-only (and stop TTS for barge-in); they never become a turn.
 *
 * Pure + shared (browser, server, tests). No transcript text is ever written to observability by this module.
 */
export type TranscriptStatus = 'INTERIM' | 'FINAL';

/** Optional recogniser metadata attached to a partial / final result (Web Speech: `result[0].confidence`, `rec.lang`). */
export interface TranscriptMeta {
  /** 0..1 when the recogniser reports one (0 / undefined = unknown — many engines report 0 for finals). */
  confidence?: number;
  /** BCP-47 language hint of the recogniser / detected language, when available. */
  language?: string;
}

/** One structured STT result (§2). */
export interface TranscriptEvent {
  utteranceId: string;
  sessionId: string;
  text: string;
  status: TranscriptStatus;
  confidence: number | null;
  languageHint: string | null;
  receivedAt: number;
}

/** What travels with a voice turn to the engine (metadata only — the text is the turn input itself). */
export interface VoiceTranscriptInfo {
  status: TranscriptStatus;
  confidence?: number | null;
  languageHint?: string | null;
  /** First speech activity / transcript of the utterance → end-of-turn decision. */
  sttDurationMs?: number | null;
  utteranceId?: string | null;
}

/** A FINAL with a reported confidence below this is UNCERTAIN: the agent waits for more speech (never invents words). */
export const MIN_FINAL_CONFIDENCE = 0.35;

/** Reported (non-zero) confidence below the floor. Unknown confidence (0 / undefined) is not "uncertain". */
export function isUncertainConfidence(c: number | null | undefined): boolean {
  return typeof c === 'number' && Number.isFinite(c) && c > 0 && c < MIN_FINAL_CONFIDENCE;
}

export function makeTranscriptEvent(o: { utteranceId: string; sessionId: string; text: string; isFinal: boolean; meta?: TranscriptMeta; now: number }): TranscriptEvent {
  const c = o.meta?.confidence;
  return {
    utteranceId: o.utteranceId, sessionId: o.sessionId, text: String(o.text || '').trim(), status: o.isFinal ? 'FINAL' : 'INTERIM',
    confidence: typeof c === 'number' && Number.isFinite(c) && c > 0 ? Math.min(1, Math.round(c * 100) / 100) : null,
    languageHint: cleanLanguage(o.meta?.language), receivedAt: o.now
  };
}

const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const UTTERANCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
function cleanLanguage(x: unknown): string | null { return typeof x === 'string' && LANG_RE.test(x) ? x : null; }

/**
 * Server boundary: client-supplied transcript metadata is untrusted → keep only well-formed, bounded fields
 * (never free text). Anything malformed is dropped, an unknown status makes the whole object invalid (undefined).
 */
export function sanitizeTranscriptInfo(x: unknown): VoiceTranscriptInfo | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (o.status !== 'INTERIM' && o.status !== 'FINAL') return undefined;
  const c = typeof o.confidence === 'number' && Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1 ? Math.round(o.confidence * 100) / 100 : null;
  const d = typeof o.sttDurationMs === 'number' && Number.isFinite(o.sttDurationMs) && o.sttDurationMs >= 0 && o.sttDurationMs <= 120_000 ? Math.round(o.sttDurationMs) : null;
  const u = typeof o.utteranceId === 'string' && UTTERANCE_RE.test(o.utteranceId) ? o.utteranceId : null;
  return { status: o.status, confidence: c, languageHint: cleanLanguage(o.languageHint), sttDurationMs: d, utteranceId: u };
}

export type TranscriptTurnCheck = { ok: true } | { ok: false; code: 'TRANSCRIPT_NOT_FINAL' | 'TRANSCRIPT_EMPTY' };

/** §3 — only a FINAL, non-empty transcript may become an agent turn (interim speech never triggers anything). */
export function checkTranscriptForTurn(text: string, info: VoiceTranscriptInfo | undefined): TranscriptTurnCheck {
  if (!String(text || '').trim()) return { ok: false, code: 'TRANSCRIPT_EMPTY' };
  if (info && info.status !== 'FINAL') return { ok: false, code: 'TRANSCRIPT_NOT_FINAL' };
  return { ok: true };
}

/** Thrown by the turn engine BEFORE a turn exists (no LLM call, no tool, no state change). */
export class VoiceTranscriptRejectedError extends Error {
  constructor(readonly code: 'TRANSCRIPT_NOT_FINAL' | 'TRANSCRIPT_EMPTY') {
    super(code === 'TRANSCRIPT_NOT_FINAL' ? 'Interim transcript — the turn starts only after the final transcript.' : 'Empty transcript — nothing to process.');
    this.name = 'VoiceTranscriptRejectedError';
  }
}
