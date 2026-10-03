/**
 * PROMPT 21 — pure voice-response policy shared by server + browser (no I/O, no state).
 *
 *   Part 3/13/15 — acknowledgement safety: a pre-tool acknowledgement is conversational only; it may name what is
 *                  being checked (the user's own words / the selected train), never a railway RESULT.
 *   Part 5       — no exposed chain-of-thought.
 *   Part 14      — sentence segmentation for streaming TTS (speak the first sentence while the rest is queued).
 *   Part 27/44   — robotic / IVR phrasing detection.
 *   Part 33      — response priority NORMAL < HIGH < INTERRUPT.
 *   Part 34      — speakability: a response is spoken only while it still belongs to the current turn / journey.
 *   Part 10      — barge-in echo filter (the agent's own TTS picked up by the mic is not a user turn).
 */
export type ResponsePriority = 'NORMAL' | 'HIGH' | 'INTERRUPT';
const RANK: Record<ResponsePriority, number> = { NORMAL: 0, HIGH: 1, INTERRUPT: 2 };

/** true → `next` must stop whatever `current` is playing. A newer turn always wins over an older one. */
export function preempts(next: { priority: ResponsePriority; sequence: number }, current: { priority: ResponsePriority; sequence: number } | null): boolean {
  if (!current) return true;
  if (next.sequence > current.sequence) return true;
  if (next.sequence < current.sequence) return false;
  return RANK[next.priority] > RANK[current.priority];
}

export interface SpeakableRef { sessionId: string; turnId: string; sequence: number; journeyVersion?: number | null }
export interface SpeakContext { sessionId: string; latestSequence: number; interruptedTurnIds: ReadonlySet<string>; journeyVersion?: number | null }

/** Part 34 — only the latest, non-interrupted turn of this session (and journey) may be spoken. */
export function isSpeakable(r: SpeakableRef, c: SpeakContext): { ok: true } | { ok: false; reason: 'OTHER_SESSION' | 'SUPERSEDED' | 'INTERRUPTED' | 'JOURNEY_CHANGED' } {
  if (r.sessionId !== c.sessionId) return { ok: false, reason: 'OTHER_SESSION' };
  if (c.interruptedTurnIds.has(r.turnId)) return { ok: false, reason: 'INTERRUPTED' };
  if (r.sequence < c.latestSequence) return { ok: false, reason: 'SUPERSEDED' };
  if (typeof r.journeyVersion === 'number' && typeof c.journeyVersion === 'number' && r.journeyVersion !== c.journeyVersion) return { ok: false, reason: 'JOURNEY_CHANGED' };
  return { ok: true };
}

// ------------------------------------------------------------------ language hygiene

const COT = /\b(let me (?:think|reason|analy[sz]e|inspect)|i (?:will|'ll) (?:first )?(?:inspect|analy[sz]e|reason|think about)|first i will|according to my (?:internal )?reasoning|my (?:internal )?reasoning|chain[- ]of[- ]thought|step[- ]by[- ]step reasoning|reasoning about|internally|tool (?:call|result) (?:inspect|dekh) ?(?:karke|kar raha)|soch(?:ta|ti)? (?:hoon|hu) ki (?:pehle|tool)|mujhe (?:pehle )?(?:tool|function) call karn[ai]|tool call karna (?:hoga|padega)|function call|system prompt|json (?:decision|output)|toolcalls?)\b/i;
const ROBOTIC = /\b(your request (?:has been|is being|was) (?:received|processed)|request has been processed|the (?:requested )?information is as follows|as follows:?|please provide the required information|kindly|dear (?:customer|user|sir|madam)|we regret to inform|thank you for your patience|aapka request (?:process|receive) ho (?:gaya|raha))\b/i;

export const containsChainOfThought = (t: string): boolean => COT.test(String(t || ''));
export const soundsRobotic = (t: string): boolean => ROBOTIC.test(String(t || ''));

/** Split into speakable sentences (Hindi danda included). Keeps "4:55" / "₹1040" / "12014" intact. */
export function splitSentences(text: string): string[] {
  const flat = String(text || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  return flat.split(/(?<=[.!?।])\s+(?=\S)/).map(s => s.trim()).filter(Boolean);
}

/** Streaming TTS segments: sentences, very long ones split at a comma / dash so the first audio starts early. */
export function segmentForSpeech(text: string, maxLen = 140): string[] {
  const out: string[] = [];
  for (const s of splitSentences(text)) {
    if (s.length <= maxLen) { out.push(s); continue; }
    const parts = s.split(/(?<=[,—–;])\s+/);
    let cur = '';
    for (const p of parts) {
      if ((cur + ' ' + p).trim().length > maxLen && cur) { out.push(cur.trim()); cur = p; } else cur = `${cur} ${p}`;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

// ------------------------------------------------------------------ acknowledgement safety (Parts 3, 13, 15)

const ACK_RESULT_WORDS = /\b(available|waiting|wl|rac|gnwl|cnf|confirm(?:ed)?|seats?|berth|mili|mile|milin|found|hain\s+\d|trains? (?:hain|hai|mili)|late|on time|cancel(?:led)?|book(?:ed)? ho|pnr)\b/i;
const MONEY = /₹|\brs\.?\s*\d|\brupa?y?e?s?\b|\brupees?\b/i;
const TIME = /\b([01]?\d|2[0-3]):[0-5]\d\b/;

/**
 * An acknowledgement is safe only if it states no railway result: no fare, no availability / status word,
 * no time, and no number except a train number the user / session already has.
 */
export function validateAcknowledgement(text: string, known: { trainNumbers: Iterable<string> }): { ok: boolean; reason?: string } {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'EMPTY' };
  if (t.length > 120) return { ok: false, reason: 'TOO_LONG' };
  if (containsChainOfThought(t)) return { ok: false, reason: 'CHAIN_OF_THOUGHT' };
  if (soundsRobotic(t)) return { ok: false, reason: 'ROBOTIC' };
  if (MONEY.test(t)) return { ok: false, reason: 'FARE' };
  if (TIME.test(t)) return { ok: false, reason: 'TIME' };
  if (ACK_RESULT_WORDS.test(t)) return { ok: false, reason: 'RESULT_WORD' };
  const allowed = new Set([...known.trainNumbers].map(String));
  for (const m of t.matchAll(/\d+/g)) if (!allowed.has(m[0])) return { ok: false, reason: 'NUMBER' };
  return { ok: true };
}

// ------------------------------------------------------------------ barge-in echo filter (Part 10)

const tokens = (t: string) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);

/** The mic heard the agent's own speech → not a barge-in. */
export function isLikelyEcho(heard: string, speaking: string): boolean {
  const h = tokens(heard);
  if (!h.length) return true;
  const spoken = new Set(tokens(speaking));
  if (!spoken.size) return false;
  const overlap = h.filter(w => spoken.has(w)).length / h.length;
  return overlap >= 0.7;
}
