/**
 * General Agent Intelligence — capability catalog.
 *
 * ONE declarative description of what BookKaro can answer and where each kind of fact comes from. It is the single
 * source for:
 *   - the CAPABILITY ROUTING section of the native agent prompt (generated, see capabilityRoutingPrompt),
 *   - the intent definition appended to every railway tool description the model sees (capabilityToolNote),
 *   - the backend fact-authority recovery (which capability owns an unverified fact, see fact-authority-recovery.ts).
 *
 * Design rules:
 *   - Intent DEFINITIONS, not trigger phrases. A capability is described by the user's underlying need and by the facts
 *     it is the only source for, so novel wording (any language, slang, indirect question, follow-up fragment) maps to
 *     it through understanding — never through keyword lists.
 *   - The model routes; the backend stays the authority. Nothing here selects a train, fills an argument, or calls a
 *     tool. Existing validators / grounding (SELECT_TRAIN, GET_TRAIN_INFO / TIMETABLE, CHECK_AVAILABILITY, P42-12 / P42-13,
 *     P29 action claims, response fact guards) are unchanged and remain final.
 *   - Capabilities without an authoritative provider implementation are declared as NOT AVAILABLE so the model can say
 *     so honestly instead of answering from memory. No new tool is exposed.
 */
import type { RegisteredToolName } from '../tools/tool-registry';

export type FactAuthority = 'PROVIDER_DATA' | 'GENERAL_KNOWLEDGE';

export interface Capability {
  id: string;
  /** Registered railway tool that serves it; null = answered without a tool (knowledge) or not available. */
  tool: RegisteredToolName | null;
  authority: FactAuthority;
  /** false = no authoritative implementation exists (never exposed as a tool). */
  available: boolean;
  /** The user's underlying need — an intent definition, not a phrase list. */
  need: string;
  /** Facts this capability is the ONLY source for (never from memory / estimate). */
  owns: string;
  /** What it can take from the session instead of asking the user again. */
  context?: string;
  /** When it must be called again rather than reusing an earlier answer. */
  freshness?: string;
  /** For unavailable capabilities: what the model can honestly do instead. */
  instead?: string;
}

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  {
    id: 'SEARCH_TRAINS', tool: 'SEARCH_TRAINS', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants to know which trains connect two places on a date, or wants options for a journey',
    owns: 'which trains run on a route and date, how many, their departure / arrival times, durations and listed classes',
    context: 'route and date from the session when the user does not restate them; a class or time the user names in this message narrows the search',
    freshness: 'a new route, date or explicit re-check means a new search'
  },
  {
    id: 'GET_TRAIN_INFO', tool: 'GET_TRAIN_INFO', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants to know about one specific train as such — what it is, where it runs between, on which days, which classes or facilities it has',
    owns: 'a specific train\'s identity / name, endpoints, run days, class list and facilities',
    context: 'the train the user names, or the train in focus / selected when the user refers to it'
  },
  {
    id: 'GET_TIMETABLE', tool: 'GET_TIMETABLE', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants to know when or where one specific train runs or stops — its stops, stop times, halts or route order',
    owns: 'station-wise arrival / departure times, halts and stop order of a specific train',
    context: 'the train the user names, or the train in focus / selected when the user refers to it'
  },
  {
    id: 'CHECK_AVAILABILITY', tool: 'CHECK_AVAILABILITY', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants to know whether a seat or berth can be had — in a train, class and date — however they ask it',
    owns: 'seat status: available count, RAC / waitlist position, regret / not available',
    context: 'train from the user\'s words, the selected train or a reference to the current results; class from the user, the selection or the class named at search; date, route and passengers from the journey',
    freshness: 'every request for current / fresh / repeated status is a new provider call; a newer check outranks a list value'
  },
  {
    id: 'GET_FARE', tool: 'GET_FARE', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants to know what a ticket costs in a train and class for their party',
    owns: 'fare amounts',
    context: 'works for the backend-selected train and class: when the user clearly identified a train, propose that selection first; ask for the class only if it cannot be taken from the session',
    freshness: 'quoted only from a fare result of this conversation for that train, class and party'
  },
  {
    id: 'TRACK_TRAIN', tool: 'TRACK_TRAIN', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants to know what a train is doing right now — where it is, how late it is, when it will reach, whether it has left or arrived, its platform',
    owns: 'live position, delay, expected arrival / departure, platform, whether today\'s run is running or cancelled',
    context: 'the train the user names, or the train / booking in focus when the user refers to it',
    freshness: 'always a new provider call'
  },
  {
    id: 'CHECK_PNR', tool: 'CHECK_PNR', authority: 'PROVIDER_DATA', available: true,
    need: 'the user wants the status of a booked ticket identified by its PNR',
    owns: 'PNR status: confirmed / RAC / waitlist, chart status, coach and berth',
    context: 'only a PNR the user typed or the booking record in focus — never a guessed or completed PNR',
    freshness: 'always a new provider call'
  },
  {
    id: 'ROUTE_CANCELLATIONS', tool: null, authority: 'PROVIDER_DATA', available: false,
    need: 'the user wants a list of trains cancelled, diverted or rescheduled on a route or day',
    owns: 'which trains are cancelled / diverted / rescheduled',
    instead: 'say plainly that the current cancellation list cannot be checked here; for ONE specific train its live status (TRACK_TRAIN) can show whether that run is cancelled. A search list or timetable never shows whether a train is cancelled, late or running normally, so never conclude that from them'
  },
  {
    id: 'GENERAL_RAILWAY_KNOWLEDGE', tool: null, authority: 'GENERAL_KNOWLEDGE', available: true,
    need: 'the user wants to understand something general — meanings, rules, quotas, classes, train types, how booking or travel works, general comparisons',
    owns: 'nothing provider-specific: answer directly and keep it general (no specific train numbers, timings, fares, seat or running status from memory)'
  }
]);

/** Capability that owns a registered tool (provider-level tool names are mapped to their canonical tool first). */
export function capabilityOfTool(canonicalTool: string): Capability | undefined {
  return CAPABILITIES.find(c => c.tool === canonicalTool);
}

/** Intent definition + authority appended to a railway tool description the model sees (generated, never per phrase). */
export function capabilityToolNote(canonicalTool: string): string {
  const c = capabilityOfTool(canonicalTool);
  if (!c) return '';
  return ` [Use when ${c.need}. Only source for: ${c.owns} — never answer these from memory.${c.context ? ` Context: ${c.context}.` : ''}${c.freshness ? ` Freshness: ${c.freshness}.` : ''}]`;
}

/**
 * The CAPABILITY ROUTING section of the native agent prompt — generated from the catalog. A decision procedure plus
 * capability definitions; deliberately NO example user phrases (examples elsewhere in the prompt are illustrations, not
 * a list of supported questions).
 */
export function capabilityRoutingPrompt(): string {
  const tools = CAPABILITIES.filter(c => c.tool && c.available);
  const unavailable = CAPABILITIES.filter(c => !c.available);
  const knowledge = CAPABILITIES.find(c => c.authority === 'GENERAL_KNOWLEDGE')!;
  return [
    'CAPABILITY ROUTING (general; any example in this prompt is an illustration, never the list of supported questions)',
    '- For every request decide from its MEANING: does a correct answer depend on railway data that changes or is',
    '  provider-specific (a particular train, route, date, PNR, seat status, fare, timing or running position)?',
    '  YES → use the capability that owns that fact. NO → answer from general knowledge. UNCLEAR → resolve it from the',
    '  conversation and the session context; ask ONE short question only when an essential detail is genuinely unknown.',
    '- Understand intent, not trigger words: any wording, language, script, slang, indirect question or follow-up fragment',
    '  that asks for a capability\'s fact routes to that capability. Words about time or freshness (now, today, tomorrow,',
    '  latest, again …) tell you the date or that a NEW provider call is needed — they do not choose the capability alone.',
    '- Capabilities (tool = the railway tool, or its <provider>_<capability> version in your tool list):',
    ...tools.map(c => `  • ${c.id}: when ${c.need}. Only source for: ${c.owns}.${c.context ? ` Context: ${c.context}.` : ''}`),
    `  • General railway knowledge (no tool): when ${knowledge.need}. ${knowledge.owns[0].toUpperCase()}${knowledge.owns.slice(1)}.`,
    ...unavailable.map(c => `  • NOT AVAILABLE — ${c.id.replace(/_/g, ' ').toLowerCase()}: when ${c.need}, ${c.instead}. Never answer it from memory.`),
    '- Context before questions: take route, date, train (selected, in focus, or the user\'s reference to the current',
    '  results), class, passenger count and stated preferences from the session context and use them as tool arguments',
    '  instead of asking again. A reference that does not identify exactly one train is not resolved by you — ask which train. Never',
    '  create a train number, reference, selection, class, date or route the user did not give; the backend validates',
    '  every reference and selection and its decision is final.',
    '- Authority: a tool result is the answer ONLY for the facts it owns (a search or timetable result says nothing about',
    '  seats, fares, delays or cancellations). If the tool failed, timed out, is unavailable or',
    '  returned nothing usable, say briefly that the current information could not be obtained and optionally offer the',
    '  next sensible step — never fill the gap from memory. Mixed requests: answer the general part yourself and fetch only',
    '  the part that needs provider data. Never mention tools, routing or checks in the reply.',
    ''
  ].join('\n');
}

/**
 * Which capability owns a fact the response guards could not verify. Keys are the existing guard rejection kinds
 * (response-fact-guard / railway-response-grounding) — this reads OUR OWN draft reply's claims, never the user's words.
 */
export const UNVERIFIED_FACT_OWNERS: Readonly<Record<string, readonly RegisteredToolName[]>> = Object.freeze({
  TRAIN: ['SEARCH_TRAINS', 'GET_TRAIN_INFO'],
  FARE: ['GET_FARE'],
  AVAILABILITY: ['CHECK_AVAILABILITY'],
  TIMING: ['GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS'],
  LIVE_STATUS: ['TRACK_TRAIN'],
  PNR_STATUS: ['CHECK_PNR'],
  CANCELLATION: ['TRACK_TRAIN']
});

/** Guard rejection code (e.g. `FARE:650`, `PUNCTUALITY_CLAIM`) → fact kind. Unknown codes → null. */
export function factKindOf(rejection: string): keyof typeof UNVERIFIED_FACT_OWNERS | null {
  const head = String(rejection).split(':')[0];
  switch (head) {
    case 'TRAIN': return 'TRAIN';
    case 'FARE': return 'FARE';
    case 'AVAILABILITY_CLAIM': case 'AVAILABILITY_CODE': return 'AVAILABILITY';
    case 'TIMING': return 'TIMING';
    case 'PUNCTUALITY_CLAIM': return 'LIVE_STATUS';
    case 'PNR': case 'PNR_STATUS_CLAIM': return 'PNR_STATUS';
    case 'CANCELLATION_CLAIM': return 'CANCELLATION';
    default: return null;
  }
}
