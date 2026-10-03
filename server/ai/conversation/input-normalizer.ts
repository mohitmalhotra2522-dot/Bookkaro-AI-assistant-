/**
 * Prompt 16 — Input Normalizer (first stage of the pipeline, TEXT and STT alike).
 *
 *  - Barge-in prefix: "Ruko, doosri wali dikhao" → "doosri wali dikhao" (interruption=true). The
 *    client stops TTS; the remaining words go through the SAME orchestrator. A prefix is stripped
 *    only when punctuation separates it from real content, so a bare "ruko" / "ruk jao" keeps its
 *    existing meaning (stop speaking / not a booking command).
 *  - New booking: "new booking", "ek aur ticket …", "another ticket" → explicit new journey request;
 *    the remainder ("Ludhiana se Chandigarh ki") is processed as the first turn of the new journey.
 */
export interface NormalizedUtterance {
  text: string;
  interruption: boolean;
  newBooking: boolean;
  /** Words left after removing the new-booking phrase ('' = nothing else said). */
  remainder: string;
}

const BARGE_IN = /^\s*(ruko|ruk jao|ruko ruko|wait|ek minute|ek second|ek sec|sorry|arre|hold on|stop)\s*[,!.।]+\s*(\S.*)$/i;
const NEW_BOOKING = /\b(new booking|nayi booking|naya booking|new ticket|naya ticket|nayi ticket|another ticket|another booking|ek aur ticket|ek aur booking|ek aur ticket book|dusri booking|doosri booking|ek nayi booking|start (a )?new booking|fresh booking)\b/i;
const FILLER = /^(book|karni|karna|karo|kar do|hai|hain|chahiye|please|plz|ji|mujhe|ko|ki|ka|ke|start|shuru|karte|karein|krni|krna|ek|aur|for|me|a)$/i;

export function normalizeUtterance(text: string): NormalizedUtterance {
  let t = String(text || '');
  let interruption = false;
  const b = t.match(BARGE_IN);
  if (b && b[2].trim().length >= 2) { t = b[2].trim(); interruption = true; }
  const nb = t.match(NEW_BOOKING);
  let remainder = t;
  if (nb) {
    remainder = (t.slice(0, nb.index) + ' ' + t.slice(nb.index! + nb[0].length)).replace(/[,.!?।]/g, ' ').replace(/\s+/g, ' ').trim();
    if (remainder.split(' ').every(w => !w || FILLER.test(w))) remainder = '';
  }
  return { text: t, interruption, newBooking: !!nb, remainder };
}
