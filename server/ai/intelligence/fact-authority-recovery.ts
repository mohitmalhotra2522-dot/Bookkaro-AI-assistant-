/**
 * General Agent Intelligence — fact-authority recovery (native agent only).
 *
 * The model answered WITHOUT consulting any railway tool in this turn, and its draft states provider facts (a train,
 * fare, seat status, timing, running status, PNR status, cancellation) that no tool result, session data or booking
 * record supports. Before this layer the response guards removed those sentences and the user got a generic
 * "not verified" line even when a capability could have answered.
 *
 * Now the backend gives the model ONE structured second chance (like the P42.5 safety-net / P27 chain-stop messages):
 * it hears which kinds of facts were unverified and which capabilities own them, and decides itself — call the owning
 * tool, ask one short question, or answer generally without those facts. Its next answer goes through exactly the same
 * validators and guards; a second invented answer is stripped as before (no further recovery).
 *
 * What this is NOT: no intent router, no keyword list over the user's words, no tool call by the backend, no argument
 * filled by the backend. It reads our own draft with the EXISTING grounding validator (RailwayResponseGroundingValidator)
 * and maps the existing rejection kinds to capabilities via the catalog.
 */
import type { BookingSession } from '@shared/entities';
import { railwayResponseGrounding } from '../tool-runtime/railway-response-grounding';
import { UNVERIFIED_FACT_OWNERS, factKindOf } from './capability-catalog';

export const FACT_AUTHORITY_INSTRUCTION = 'Your draft answer was NOT shown to the user: it stated specific railway facts that no tool result, session data or booking record in this conversation supports. Decide again. If the user needs those facts, call the capability that owns them now (arguments from the user\'s words and the session context; ask ONE short question only if an essential detail is missing). If the question is general, answer it again WITHOUT those specific facts. Never state such facts from memory, and do not mention this check.';

export interface FactAuthorityInput {
  origin: 'BACKEND_FACT_AUTHORITY';
  /** Fact kinds the draft stated without authority, each with the capabilities (tools) that own that kind of fact. */
  unverified: Array<{ kind: string; capabilities: string[] }>;
  /** Fixed, fact-free instruction (no user text, no internal codes beyond the kinds above). */
  instruction: string;
}

export interface FactAuthorityContext {
  session: BookingSession;
  steps: Array<{ status: string; result: { toolName: string; data?: any; error?: { message?: string } | null } }>;
  userText: string;
  records?: Array<{ train?: { trainNumber?: string }; pnr?: string | null }>;
  /** Canonical names of the railway tools exposed to the model this turn. */
  exposed: ReadonlySet<string>;
}

/**
 * Returns the structured recovery input when the draft needs it, else null. Pure: reads, never mutates, never calls.
 *   - only facts whose owning capability is exposed this turn count (a capability that does not exist gives no retry —
 *     the guards strip the claim and the honest fallback stands);
 *   - general wording without provider facts → null (knowledge answers pass untouched).
 */
export function factAuthorityRecovery(draft: string, ctx: FactAuthorityContext): FactAuthorityInput | null {
  if (!draft || !draft.trim()) return null;
  const codes = unverifiedCodes(draft, ctx);
  if (!codes.length) return null;
  const byKind = new Map<string, string[]>();
  for (const code of codes) {
    const kind = factKindOf(code);
    if (!kind || byKind.has(kind)) continue;
    const owners = UNVERIFIED_FACT_OWNERS[kind].filter(t => ctx.exposed.has(t));
    if (owners.length) byKind.set(kind, [...owners]);
  }
  if (!byKind.size) return null;
  return { origin: 'BACKEND_FACT_AUTHORITY', unverified: [...byKind].map(([kind, capabilities]) => ({ kind, capabilities })), instruction: FACT_AUTHORITY_INSTRUCTION };
}

/**
 * All guard rejection codes of the draft. The base fact guard stops at the FIRST violation of a sentence ("12497 mein 14
 * seats available" → only TRAIN), so each identified token is masked in OUR OWN draft and the draft re-validated, until
 * nothing new appears (bounded). Never reads or rewrites the user's words; the masked text is never shown.
 */
function unverifiedCodes(draft: string, ctx: FactAuthorityContext): string[] {
  const all: string[] = [];
  let text = draft;
  for (let pass = 0; pass < 4; pass++) {
    const g = railwayResponseGrounding.validate(text, { session: ctx.session, steps: ctx.steps as any, records: ctx.records as any, userText: ctx.userText });
    const fresh = g.rejected.filter(c => !all.includes(c));
    if (!fresh.length) break;
    all.push(...fresh);
    let masked = text;
    for (const c of fresh) {
      const [head, ...rest] = c.split(':'); const v = rest.join(':');
      if (head === 'TRAIN' && v) masked = masked.split(v).join('is train');
      else if (head === 'FARE' && v) masked = masked.replace(/₹\s?[\d,]+/g, m => (m.replace(/[^\d]/g, '') === v ? 'kuch rupaye' : m));
      else if (head === 'PNR') masked = masked.replace(/\b\d{10}\b/g, 'PNR');
    }
    if (masked === text) break;
    text = masked;
  }
  return all;
}
