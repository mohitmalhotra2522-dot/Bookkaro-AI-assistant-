/**
 * PROMPT 21 — MockLLMProvider's natural spoken-response + acknowledgement generator (DEVELOPMENT stand-in for a real
 * LLM; the OpenAI-compatible adapter generates wording freely).
 *
 * Like a real LLM it works ONLY from what it is given: the user's words, the authoritative post-turn BookingSession,
 * this turn's tool results and the backend reply. It never invents a fact; its output is still grounded by
 * NaturalResponseComposer exactly like real-LLM output. Phrasing varies (seeded) so tests cannot depend on one
 * scripted sentence (Part 44). Returns null when it has nothing better than the backend reply.
 */
import type { SpokenResponseInput, LLMTurnInput } from './llm-provider';
import type { AgentDecision } from '../decisions/agent-decision';
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import { searchSummary } from '../context/response-formatter';

const ORD = ['Pehle', 'Doosre', 'Teesre', 'Chauthe', 'Paanchve', 'Chhathe'];
const EN_ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const SAFETY_CODES = new Set(['SENSITIVE_REQUEST_REJECTED', 'SENSITIVE_DATA_REJECTED', 'BOOKING_ACCESS_DENIED', 'INVALID_LLM_OUTPUT']);

function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const pick = <T,>(xs: T[], seed: number): T => xs[seed % xs.length];
const cap = (x: string) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);

/** Date words exactly as the user said them (never a resolved fact). */
export function dateWordOf(text: string): string | null {
  // the LAST date word wins: "kal nahi parso" → parso
  const all = String(text || '').toLowerCase().match(/\b(aaj|kal|parso|parson|narso|day after tomorrow|today|tomorrow)\b/g);
  if (!all) return null;
  const w = all[all.length - 1];
  return w === 'parson' ? 'parso' : w;
}

function spokenTime(hhmm?: string): string | null {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const part = h < 12 ? 'subah' : h < 16 ? 'dopahar' : h < 20 ? 'shaam' : 'raat';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${part} ${h12}:${m[2]}`;
}

function shortStation(name?: string, code?: string): string {
  const n = String(name || code || '').replace(/\b(Junction|Jn|Cantt|Railway Station|Terminus|Central)\b/gi, '').trim();
  return n || String(code || '');
}

function classesOf(s: BookingSession): string[] {
  const t: any = s.selectedTrain;
  if (!t) return [];
  return (t.availableClasses || (t.classes || []).map((c: any) => c.code)).map(String);
}

function firstMissing(s: BookingSession): { index: number; field: 'name' | 'age' | 'gender' } | null {
  const ps: any[] = s.passengers || [];
  for (let i = 0; i < ps.length; i++) for (const f of ['name', 'age', 'gender'] as const) {
    const v = ps[i]?.[f];
    if (v === undefined || v === null || v === '') return { index: i, field: f };
  }
  return null;
}

function passengerQuestion(s: BookingSession, en: boolean, seed: number): string | null {
  const m = firstMissing(s);
  if (!m) return null;
  if (m.field === 'name') return en ? `${cap(EN_ORD[m.index] || 'next')} passenger's name?` : `${ORD[m.index] || 'Agle'} passenger ka naam?`;
  const nm = String((s.passengers as any[])[m.index]?.name || '').trim();
  if (m.field === 'age') return en ? (nm ? `${nm}'s age?` : 'Age?') : nm ? pick([`${nm} ki age?`, `${nm} ki umar kitni hai?`], seed) : 'Umar kitni hai?';
  return en ? 'Male or female?' : nm ? `${nm} — male ya female?` : 'Male ya female?';
}

function availabilityPhrase(status: string, cls: string, en: boolean): string {
  const st = String(status || '').trim();
  const n = st.match(/^available[\s-]*0*(\d+)$/i);
  if (/^available$/i.test(st)) return en ? `${cls} has seats available.` : `${cls} mein seats available hain.`;
  if (n) return en ? `${cls} has ${n[1]} available.` : `${cls} mein ${n[1]} available hai.`;
  return en ? `${cls} shows ${st} right now.` : `${cls} mein abhi ${st} hai.`;
}

/** Part 3 — a fact-free acknowledgement for the tool(s) the mock LLM is requesting (null → backend default). */
export function mockAcknowledgement(d: AgentDecision, input: LLMTurnInput): string | null {
  const calls = d.toolCalls || [];
  if (!calls.length) return null;
  const s = input.session as BookingSession;
  const raw = input.userText || '';
  const seed = hash(raw + (s.sessionVersion ?? 0));
  const search = calls.find(c => c.name === 'SEARCH_TRAINS');
  if (search) {
    const dw = dateWordOf(raw);
    const newDate = (search.arguments as any)?.date;
    // only a CORRECTION gets a custom ack; a first search keeps the backend's default acknowledgement
    if (dw && s.date && newDate && newDate !== s.date) return pick([`Achha, ${dw}. ${cap(dw)} ki fresh trains check karta hoon.`, `Theek hai, ${dw} kar dete hain. ${cap(dw)} ke liye trains dekh raha hoon.`], seed);
    return null;
  }
  const train = (s.selectedTrain as any)?.number || String((calls[0].arguments as any)?.trainNumber || '') || '';
  const clsRaw = String((calls[0].arguments as any)?.travelClass || (raw.toUpperCase().match(/\b(1A|2A|3A|3E|CC|EC|SL|2S)\b/) || [])[1] || s.selectedClass || '').toUpperCase();
  const cls = /^[0-9A-Z]{2}$/.test(clsRaw) ? clsRaw : '';
  if (calls.some(c => c.name === 'CHECK_AVAILABILITY')) {
    const what = `${train ? `${train} ki ` : ''}${cls ? `${cls} ` : ''}availability`;
    return pick([`Haan, ek second, ${what} check karta hoon.`, `Sure, ${what} dekh raha hoon.`, `Ek second, ${what} check kar raha hoon.`], seed);
  }
  if (calls.some(c => c.name === 'GET_FARE')) return pick(['Ek second, fare dekh raha hoon.', `Haan, ${cls ? `${cls} ka ` : ''}fare check karta hoon.`], seed);
  return null;
}

/** Natural spoken reply (Parts 2, 6, 16–19, 23, 24, 36). */
export function mockSpokenResponse(i: SpokenResponseInput): string | null {
  const s = i.session as BookingSession;
  const en = i.language === 'ENGLISH';
  const seed = hash(i.userText + (s.sessionVersion ?? 0) + i.backendReply.length);
  const ok = i.toolResults.filter(r => r.ok);
  const failed = i.toolResults.filter(r => !r.ok && (r.status === 'FAILED' || r.status === 'TIMEOUT'));
  // Part 17 — follow-up question in the user's language (English replies get an English question)
  const EN_Q: Record<string, string> = { PASSENGERS_REQUIRED: 'How many passengers?', DATE_REQUIRED: 'Which date?', CLASS_SELECTION_REQUIRED: 'Which class?', TRAIN_SELECTION_REQUIRED: 'Which train?', REVIEW_APPROVAL_REQUIRED: 'Shall I confirm?', CONFIRMATION_REQUIRED: 'Shall I confirm?' };
  const q = en && i.pendingQuestion ? (EN_Q[String((s as any).pendingInteraction?.type || '')] || i.pendingQuestion) : i.pendingQuestion;

  if (i.error && SAFETY_CODES.has(i.error.code)) return null;
  // Prompt 22 — a fresh journey the backend just started (nothing else said yet): one natural question
  const newJourney = i.appliedActions.includes('NEW_JOURNEY_STARTED');
  if (newJourney && !i.toolResults.length && !s.origin && !s.destination) {
    return en ? 'Sure, a new booking. Where are you travelling from and to?' : pick(['Bilkul, nayi booking. Kahan se kahan jaana hai?', 'Theek hai, naye safar ki baat karte hain. Kahan se kahan jaana hai?'], seed);
  }

  // Part 36 — provider failure: honest, short; retry offered because these are read-only lookups (safe to repeat)
  if (failed.length && !ok.some(r => r.toolName !== 'SEARCH_TRAINS')) {
    const f = failed[failed.length - 1].toolName;
    if (f === 'SEARCH_TRAINS') return en ? "I couldn't load the trains just now. Shall I try again?" : 'Trains abhi load nahi ho paayi. Dobara try karoon?';
    const label = f === 'GET_FARE' ? 'Fare' : f === 'CHECK_AVAILABILITY' ? 'Availability' : null;
    if (label) return en ? `I couldn't verify the ${label.toLowerCase()} right now. Shall I check again?` : `${label} abhi verify nahi ho paayi. Dobara check kar doon?`;
    return null;
  }
  // Part 8 / 43 — a train the user named is not in the authoritative results: say so briefly, keep the context
  if (i.error?.code === 'INVALID_TRAIN_REFERENCE') {
    const named = (i.userText.match(/\b\d{5}\b/) || [])[0];
    const cur = (s.selectedTrain as any)?.number;
    if (!named) return null;
    return en ? `${named} isn't in this route's list.${cur ? ` ${cur} is still selected.` : ''} ${q || 'Which train?'}`
      : `${named} is route ki list mein nahi hai.${cur ? ` ${cur} hi selected hai.` : ''} ${q || 'Kaunsi train chahiye?'}`;
  }
  if (i.error) return null;                       // other validation errors: the backend reply is already precise

  // Part 26 — confirmation REQUEST only (booking disabled): never a booked claim
  if (s.bookingState === BookingState.IRCTC_HANDOFF_READY && i.stateBefore !== BookingState.IRCTC_HANDOFF_READY) {
    return en ? "Done — all the details are verified. Actual booking isn't enabled yet, so no ticket has been booked and no payment was made."
      : pick(['Details confirm ho gayi. Ticket book nahi hua — actual booking abhi enabled nahi hai.',
        'Theek hai, details verify ho gayi. Actual booking enabled nahi hai, toh ticket book nahi hua.'], seed);
  }

  // Part 24 — review (new or rebuilt) → one natural summary + the confirmation question
  const rv = s.review?.valid ? s.review.reviewVersion : null;
  if (rv !== null && s.bookingState === BookingState.AWAITING_CONFIRMATION && rv !== i.reviewVersionBefore) {
    const t: any = s.selectedTrain;
    const snap: any = (s.review as any)?.snapshot;
    const fare = snap?.fare?.status === 'VERIFIED' ? `, total ₹${snap.fare.total}` : '';
    const n = s.passengersCount || s.passengers.length;
    const route = `${shortStation(s.originName, s.origin)} se ${shortStation(s.destinationName, s.destination)}`;
    const dw = dateWordOf(i.userText);
    const dateFixed = !!dw && i.changes.some(c => c.field === 'date' && c.corrected);
    // Part 7 — date correction: say the new day and that the SAME train was found again in the fresh list
    const head = dateFixed ? `Achha, ${dw}. ${t?.number} ${dw} ki fresh list mein bhi hai —`
      : i.reviewVersionBefore ? pick(['Theek hai, update kar diya.', 'Achha, badal diya.'], seed) : pick(['Achha, review ready hai —', 'Review taiyaar hai —'], seed);
    const body = dateFixed ? `${s.selectedClass}, ${n} passenger${n > 1 ? 's' : ''}${fare}.` : `${route}, ${t?.number}, ${s.selectedClass} aur ${n} passenger${n > 1 ? 's' : ''}${fare}.`;
    const fareNote = snap?.fare?.status === 'VERIFIED' ? '' : ' Fare abhi verify nahi hua hai.';
    return en ? `Review is ready — ${route.replace(' se ', ' to ')}, ${t?.number}, ${s.selectedClass}, ${n} passenger${n > 1 ? 's' : ''}${fare}.${fareNote} Shall I confirm?`
      : `${head} ${body}${fareNote} Confirm karna hai?`;
  }

  const search = ok.filter(r => r.toolName === 'SEARCH_TRAINS').slice(-1)[0];
  if (search) {
    const trains: any[] = (s.searchResults as any)?.trains || [];
    if (!trains.length) return null;
    const dw = dateWordOf(i.userText);
    const corrected = i.changes.some(c => c.field === 'date' && c.corrected);
    const when = dw ? cap(dw) : 'Is date';
    const lead = corrected && dw ? `Achha, ${dw}. ` : '';
    const t: any = s.selectedTrain;
    // Prompt 27 — a multi-step chain (search → select → availability/fare) or a mixed general + search turn: the answer
    // the user asked for is what follows the train list in the backend reply (already fact-guarded) — speak THAT, not
    // the list summary. The selection question is dropped when the chain already answered.
    // anchor = the exact search summary the backend produced for this mode (TEXT: header + rows; VOICE: one sentence)
    const summ = searchSummary(s, i.inputMode);
    const at = summ ? i.backendReply.indexOf(summ) : -1;
    let tailText = at >= 0 ? i.backendReply.slice(at + summ.length) : '';
    if (at < 0) {
      const lines = i.backendReply.split('\n');
      let lastRow = -1;
      lines.forEach((l, k) => { if (/^\s*\d+\.\s/.test(l)) lastRow = k; });
      tailText = lastRow >= 0 ? lines.slice(lastRow + 1).join('\n') : '';
    }
    const answer = (tailText.match(/[^.!?\n]+[.!?]?/g) || []).map(x => x.trim()).filter(x => x && !/\?$/.test(x)).join(' ');
    const chained = ok.some(r => r.toolName === 'CHECK_AVAILABILITY' || r.toolName === 'GET_FARE');
    if (answer && chained) {
      const kept = t && i.selectedTrainBefore && t.number === i.selectedTrainBefore && corrected
        ? (en ? `${t.number} is in the fresh list too. ` : `${when} ki fresh list mein ${t.number} bhi hai. `) : '';
      // VOICE stays short (≤ 3 sentences): keep the comparison lead, say availability + fare in ONE sentence from the
      // authoritative tool results
      const avR = ok.filter(r => r.toolName === 'CHECK_AVAILABILITY').slice(-1)[0];
      const frR = ok.filter(r => r.toolName === 'GET_FARE').slice(-1)[0];
      if (i.inputMode === 'VOICE' && !failed.length && t) {
        const sentences = answer.match(/[^.!?]+[.!?]?/g)!.map(x => x.trim()).filter(Boolean);
        const leadS = sentences.filter(x => !/available|waitlist|\brac\b|₹|fare|verify/i.test(x)).slice(-2);
        const st = String(avR?.data?.status ?? '').trim();
        const cls = String(avR?.data?.travelClass || frR?.data?.travelClass || s.selectedClass || '');
        const pieces: string[] = [];
        if (avR && st) pieces.push(en ? `${t.number} ${cls} is ${st.toLowerCase() === 'available' ? 'available' : st}` : `${t.number} mein ${cls} ${/^available$/i.test(st) ? 'available hai' : `${st} hai`}`);
        if (frR && Number.isFinite(Number(frR.data?.perPassenger))) pieces.push(en ? `fare ₹${frR.data.perPassenger} per passenger` : `fare ₹${frR.data.perPassenger} per passenger`);
        if (pieces.length) return `${lead}${kept}${[...leadS, `${pieces.join(', ')}.`].join(' ')}`.trim();
      }
      return `${lead}${kept}${answer}`;
    }
    // mixed general + search: only a purely general tail (no digits — backend carry-over / class notes always name a train)
    if (answer && !chained && !corrected && !/\d/.test(answer)) {
      const n0 = trains.length;
      const summary = en ? `I found ${n0} train${n0 > 1 ? 's' : ''} — which one would you like?` : `${when} ke liye ${n0} train${n0 > 1 ? 'ein' : ''} mili hain — kaunsi chahiye?`;
      return `${lead}${answer} ${summary}`;
    }
    // Part 38 — the previously chosen train is NOT in the fresh list: say so plainly (never carry it over)
    const dropped = i.selectedTrainBefore && !t && !newJourney ? (en ? `${i.selectedTrainBefore} isn't in the new list. ` : `${i.selectedTrainBefore} ${dw || 'nayi date'} ki list mein nahi hai. `) : '';
    // Part 38 — carry-over: the same train was re-derived from the NEW results
    if (t && i.selectedTrainBefore && t.number === i.selectedTrainBefore) {
      const keep = `${when} ke liye fresh trains dekh li — ${t.number} ismein bhi hai, toh wahi rakhi hai.`;
      return `${lead}${keep}${q ? ` ${q}` : ''}`;
    }
    const first = trains[0];
    const time = spokenTime(first.departure);
    const n = trains.length;
    const body = en ? `I found ${n} train${n > 1 ? 's' : ''}. The earliest is ${first.trainNumber}${time ? ` at ${first.departure}` : ''}. Which one would you like?`
      : `${when} ke liye ${n} train${n > 1 ? 'ein' : ''} mili hain. Sabse pehli ${first.trainNumber} hai${time ? `, ${time} wali` : ''}. Kaunsi chahiye?`;
    return `${lead}${dropped}${body}`;
  }

  const avail = ok.filter(r => r.toolName === 'CHECK_AVAILABILITY').slice(-1)[0];
  const fareR = ok.filter(r => r.toolName === 'GET_FARE').slice(-1)[0];
  if (avail || fareR) {
    const parts: string[] = [];
    if (avail) parts.push(availabilityPhrase(avail.data?.status, String(avail.data?.travelClass || s.selectedClass || ''), en));
    if (fareR) {
      const d = fareR.data || {};
      const pc = Number(d.passengersCount) || 1;
      parts.push(en ? `Fare is ₹${d.perPassenger} per passenger${pc > 1 ? `, ₹${d.total} for ${pc}` : ''}.`
        : `${d.travelClass || ''} ka fare ₹${d.perPassenger} per passenger hai${pc > 1 ? `, ${pc} ke liye ₹${d.total}` : ''}.`.trim());
    }
    if (q) parts.push(q);
    return parts.join(' ');
  }

  const trainNow = (s.selectedTrain as any)?.number || null;
  // Part 6 — "12014 wali" → short confirmation + the next question
  if (trainNow && trainNow !== i.selectedTrainBefore && s.bookingState === BookingState.CLASS_OPTIONS) {
    const cls = classesOf(s);
    const opts = cls.length > 1 ? `${cls.slice(0, -1).join(', ')} ya ${cls[cls.length - 1]}` : cls[0];
    const enOpts = cls.length > 1 ? `${cls.slice(0, -1).join(', ')} or ${cls[cls.length - 1]}` : cls[0];
    return en ? `Okay, ${trainNow}. Which class — ${enOpts}?`
      : pick([`Haan, ${trainNow}. ${opts} — kaunsi class chahiye?`, `Theek hai, ${trainNow} rakh li. Kaunsi class — ${opts}?`], seed);
  }
  if (s.selectedClass && s.selectedClass !== i.selectedClassBefore && q) {
    return en ? `${s.selectedClass}, got it. ${q}` : `${s.selectedClass} theek hai. ${q}`;
  }
  // Part 23 — passengers: conversational, one field at a time
  const pq = passengerQuestion(s, en, seed);
  const countNow = s.passengersCount ?? null;
  if (countNow && countNow !== i.passengersCountBefore && pq) {
    return en ? `Okay, ${countNow} passenger${countNow > 1 ? 's' : ''}. ${pq}` : `Theek hai, ${countNow} passenger${countNow > 1 ? 's' : ''}. ${pq}`;
  }
  if (pq && i.appliedActions.some(a => /PASSENGER/.test(a))) return `${pick(en ? ['Got it.', 'Okay.'] : ['Theek hai.', 'Achha.', 'Ok.'], seed)} ${pq}`;
  // Part 27 — greeting: friendly, short, straight to the one useful question (no menu of capabilities)
  if (/^(namaste|namaskar|hello|hi|hey|hii+|good (morning|evening|afternoon))\b/i.test(i.userText.trim()) && !i.toolResults.length) {
    return en ? 'Hi! Where would you like to travel?' : pick(['Namaste! Kahan se kahan jaana hai?', 'Namaste! Batao, kahan jaana hai?'], seed);
  }
  // Part 20 — journey slot answers
  if (s.bookingState === BookingState.COLLECTING_DATE && i.changes.some(c => c.field === 'origin' || c.field === 'destination')) {
    return en ? 'Sure. When do you want to travel?' : pick(['Bilkul. Kab jaana hai?', 'Theek hai. Kis din jaana hai?'], seed);
  }
  // Prompt 27 — English user, backend follow-up question in Hinglish: keep the (already guarded) answer, ask in English
  if (en && q && !i.toolResults.length) {
    const m = i.backendReply.match(/^([\s\S]*?[.!])\s+([^.!?]*\b(kaunsi|kitne|karni|chahiye|karna|batao)\b[^.!?]*\?)\s*$/i);
    if (m && !/^\s*\d+\.\s/m.test(m[1])) return `${m[1].trim()} ${q}`;
  }
  return null;
}
