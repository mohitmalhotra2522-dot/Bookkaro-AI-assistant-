/**
 * PROMPT 29 — truthful action / progress claims.
 *
 * "availability check kar raha hoon", "fare verify ho gaya", "I'm searching for trains" are NOT railway facts — they are
 * claims about what the SYSTEM is doing / did. A claim like that is allowed only when the current turn's actual
 * execution supports it. Authority is never taken from the words: the words only say WHAT is claimed (tool, phase,
 * entity); the existing ToolExecutionRecord lifecycle of THIS turn decides whether it is true.
 *
 *   PLANNED / EXECUTING claim ("check karta hoon", "check kar raha hoon")  → that tool was DISPATCHED this turn
 *   SUCCEEDED claim ("check ho gayi", "I checked")                          → that tool SUCCEEDED this turn (same entity)
 *   NOT-DONE / FAILED claim ("check nahi ho paayi")                         → it did NOT succeed this turn
 *   OFFER / question / conditional ("check karun?", "phir check kar deta hoon") → not a claim (allowed)
 *
 * The backend never decides the next tool here — it only removes (clause-level) statements that the recorded execution
 * contradicts. No new state system: the ledger is derived from the runtime's ToolCallStep / ToolExecutionRecord.
 */
import { claimedDates } from './claim-dates';

// ------------------------------------------------------------------ vocabulary (types)
/** Conceptual action lifecycle (derived from ToolExecutionStatus — not a second state machine). */
export type ActionStatus = 'NOT_REQUESTED' | 'PLANNED' | 'REQUESTED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | 'STALE';
/** ACTION_STATEMENT subtypes (ClaimType 'ACTION_STATEMENT' already exists in claim-facts). */
export type ActionClaimSubtype = 'ACTION_PLANNED' | 'ACTION_REQUESTED' | 'ACTION_EXECUTING' | 'ACTION_SUCCEEDED' | 'ACTION_FAILED'
  | 'ACTION_CANCELLED' | 'ACTION_STALE' | 'ACTION_OFFERED';
export type ActionPhase = 'PLANNED' | 'EXECUTING' | 'SUCCEEDED' | 'NOT_DONE' | 'OFFER';
export type ActionRemovalReason = 'NO_CURRENT_TURN_EXECUTION' | 'NO_SUCCESSFUL_CURRENT_TURN_EXECUTION' | 'TOOL_NOT_EXECUTED'
  | 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'STALE_PREVIOUS_TURN_ACTION' | 'ACTION_STALE' | 'ACTION_TRAIN_MISMATCH' | 'ACTION_CLASS_MISMATCH'
  | 'ACTION_DATE_MISMATCH' | 'CONTRADICTS_SUCCESSFUL_EXECUTION' | 'PREVIOUS_ACTION_NOT_FOUND';

/** Explicit action → tool mapping (the 9 approved info tools + the generic "check kar raha hoon"). */
export const ACTION_TOOLS = ['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN', 'CHECK_PNR',
  'GET_CANCELLED_TRAINS', 'GET_LIVE_STATION'] as const;
export type ActionType = typeof ACTION_TOOLS[number] | 'ANY_RAILWAY_TOOL';

export interface ActionExecution {
  toolCallId: string;
  toolName: string;
  status: ActionStatus;
  /** raw ToolExecutionStatus (SUCCEEDED / FAILED / TIMEOUT / UNKNOWN / REJECTED / CANCELLED …) */
  outcome: string;
  turnId: string | null;
  trainNumber?: string;
  travelClass?: string;
  date?: string;
}
export interface ActionLedger {
  turnId: string | null;
  /** this turn's executions (LLM tool calls + backend booking-preparation refreshes) */
  current: ActionExecution[];
  /** the previous turn's executions — only used to label a leaked claim STALE, never as authority */
  previous: ActionExecution[];
  /** committed session evidence for an explicit "pehle check kar li thi" reference */
  session?: any;
}
export interface ActionClaim {
  phrase: string;
  phase: ActionPhase;
  subtype: ActionClaimSubtype;
  actionTypes: ActionType[];
  trainNumbers: string[];
  travelClasses: string[];
  dates: string[];
  previousRef: boolean;
}
export interface ActionVerdict {
  ok: boolean;
  actionType: ActionType | null;
  actionStatus: ActionStatus;
  toolCallId: string | null;
  toolName: string | null;
  removalReason?: ActionRemovalReason;
}
/** Observability record (codes + ids + a short action phrase — never secrets / PII / provenance to users). */
export interface ActionClaimDiagnostic {
  actionClaim: string;
  actionSubtype: ActionClaimSubtype;
  actionType: ActionType | null;
  actionStatus: ActionStatus;
  toolCallId: string | null;
  toolName: string | null;
  turnId: string | null;
  entity: { trainNumber?: string; travelClass?: string } | null;
  date: string | null;
  validationStatus: 'VALID' | 'REJECTED' | 'NOT_APPLICABLE';
  removalReason: ActionRemovalReason | null;
}

// ------------------------------------------------------------------ ledger (from the existing runtime records)
const STATUS_OF: Record<string, ActionStatus> = {
  REQUESTED: 'REQUESTED', VALIDATING: 'REQUESTED', RUNNING: 'EXECUTING', SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED',
  TIMEOUT: 'FAILED', UNKNOWN: 'FAILED', REJECTED: 'SKIPPED', CANCELLED: 'CANCELLED'
};
const DISPATCHED: ReadonlySet<ActionStatus> = new Set<ActionStatus>(['EXECUTING', 'SUCCEEDED', 'FAILED', 'STALE']);

const CLS_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA)\b/g;

/** One execution per runtime step (ToolCallStep) — LLM-requested and backend-preparation steps alike. */
export function actionExecutionOf(st: any, turnId: string | null, session?: any): ActionExecution | null {
  const tool = String(st?.result?.toolName || st?.toolCall?.name || st?.execution?.tool || '');
  if (!tool) return null;
  const rec = st?.execution;
  const raw = String(rec?.status || (st?.status === 'ok' ? 'SUCCEEDED' : st?.status === 'rejected' ? 'REJECTED'
    : st?.result?.error?.code === 'TOOL_TIMEOUT' ? 'TIMEOUT' : st?.status === 'stale' ? 'CANCELLED' : 'FAILED'));
  // a dropped (stale) result is STALE, whatever the provider said; a deduplicated / superseded call never ran
  const status: ActionStatus = st?.status === 'stale' ? 'STALE' : (STATUS_OF[raw] || 'FAILED');
  const id = st?.result?.identity || {};
  const a = st?.validatedArguments || st?.toolCall?.arguments || {};
  const d = st?.result?.data || {};
  const sel = session?.selectedTrain;
  const perTrain = tool === 'CHECK_AVAILABILITY' || tool === 'GET_FARE' || tool === 'GET_TRAIN_INFO' || tool === 'GET_TIMETABLE' || tool === 'TRACK_TRAIN';
  const trainNumber = String(id.trainNumber || a.trainNumber || d.trainNumber || (perTrain ? (sel?.number || sel?.trainNumber || '') : '') || '') || undefined;
  const travelClass = String(id.travelClass || a.travelClass || d.travelClass || ((tool === 'CHECK_AVAILABILITY' || tool === 'GET_FARE') ? session?.selectedClass || '' : '') || '').toUpperCase() || undefined;
  const date = String(id.date || a.date || d.date || ((tool === 'SEARCH_TRAINS' || tool === 'CHECK_AVAILABILITY' || tool === 'GET_FARE') ? session?.date || '' : '') || '') || undefined;
  return { toolCallId: String(st?.toolCall?.callId || rec?.toolExecutionId || ''), toolName: tool, status, outcome: raw,
    turnId: rec?.turnId ?? turnId, ...(trainNumber ? { trainNumber } : {}), ...(travelClass ? { travelClass } : {}), ...(date ? { date } : {}) };
}

export function actionLedgerFromSteps(steps: any[] | undefined, opts: { turnId?: string | null; session?: any; previous?: ActionExecution[] } = {}): ActionLedger {
  const turnId = opts.turnId ?? null;
  const current = (steps || []).map(st => actionExecutionOf(st, turnId, opts.session)).filter((x): x is ActionExecution => !!x);
  return { turnId, current, previous: opts.previous || [], session: opts.session };
}

/** Execution records (ToolExecutionRecord) observed live by the turn engine → ledger entries (progress / ack checks). */
export function actionExecutionOfRecord(rec: any): ActionExecution {
  const s = rec?.argumentsSummary || {};
  const raw = String(rec?.status || 'REQUESTED');
  return { toolCallId: String(rec?.toolExecutionId || ''), toolName: String(rec?.tool || ''),
    // VALIDATING after preparation = validated and entering execution in this dispatch batch
    status: raw === 'VALIDATING' ? 'EXECUTING' : (STATUS_OF[raw] || 'FAILED'), outcome: raw, turnId: rec?.turnId ?? null,
    ...(s.trainNumber ? { trainNumber: String(s.trainNumber) } : {}), ...(s.travelClass ? { travelClass: String(s.travelClass).toUpperCase() } : {}),
    ...(s.date ? { date: String(s.date) } : {}) };
}

// ------------------------------------------------------------------ detection (what is claimed — never authority)
const VERB_RE = /\b(check(?:ing|ed|s)?|chek|re-?check(?:ing|ed)?|verif(?:y|ied|ying|ication)|search(?:ing|ed)?|dhoo?n?dh\w*|dhundh\w*|fetch(?:ing|ed)?|look(?:ing|ed)? (?:up|into)|pull(?:ing)? up|dekh|dekha|dekhi|dekhta|dekhti|nika?al|nika?alta)\b/i;
/** offer / question / capability / conditional → not a claim about what happened */
const OFFER_RE = /\?\s*$|\b(kar sakta|kar sakti|kar sakte|dekh sakta|dekh sakti|ja sakta|ja sakti|ja sakte|sakta hai|sakti hai|sakte hain|can (?:also )?(?:check|search|look|verify|be)|could (?:check|search|look|verify)|karun|karoon|karu|kar doon|kar dun|kar du|dekhun|dekhu|dekh loon|dekh lun|shall i|should i|want me to|would you like|chahein to|chahen to|chahte hain to|chahenge|bataiye to|boliye to|kahiye to|if you (?:want|like))\b/i;
const CONDITIONAL_RE = /\b(agar|jab|once|if)\b|\bpehle\b[\s\S]*\b(phir|fir|uske baad)\b/i;
const NEG_RE = /\b(nahi|nahin|nhi|not|never|couldn'?t|could not|wasn'?t|weren'?t|haven'?t|hasn'?t|unable|fail(?:ed|s)?|abhi tak nahi)\b|n't\b/i;
const MAINE_RE = /\bmaine\b[\s\S]*\b(kiya|ki|dekha|dekhi|dekh li|nikala|nikali)\b/i;
const SUCC_RE = /\b(kar (?:li|liya|liye|lie|lee|di|diya|diye|die)(?: hai| hain| gayi| gaya| gaye)?|ki (?:hai|hain|gayi|gai)|kiya (?:hai|gaya)|kiye (?:hain|gaye)|ho (?:gayi|gaya|gaye|gai|chuki|chuka|chuke)|dekh (?:li|liya|liye|lee)|nika?al (?:li|liya|liye)|i'?ve (?:already )?(?:checked|searched|verified|looked|fetched)|i have (?:already )?(?:checked|searched|verified|looked|fetched)|we'?ve (?:checked|searched|verified)|i (?:already )?(?:checked|searched|verified|looked up|fetched)|(?:has|have) been (?:checked|verified|searched|fetched)|(?:is|are|was|were) (?:now )?(?:checked|verified)|done checking|checked|verified|searched)\b/i;
const EXEC_RE = /\b(kar raha|kar rahi|kar rahe|dekh raha|dekh rahi|dekh rahe|nika?al raha|nika?al rahi|dhoo?n?dh raha|dhundh raha|ho raha|ho rahi|ho rahe|(?:i'?m|i am|we'?re|we are) (?:now |currently |still |just )?(?:checking|searching|verifying|looking|fetching|pulling|re-?checking|getting)|checking now|now checking|searching now|still checking|in progress)\b/i;
const PLAN_RE = /\b(karta (?:hoon|hu|hun)|karti (?:hoon|hu|hun)|kar deta|kar deti|kar dunga|kar dungi|karunga|karungi|kar leta|kar leti|dekhta (?:hoon|hu)|dekhti (?:hoon|hu)|dekh leta|dekh leti|nika?alta (?:hoon|hu)|i'?ll|i will|we'?ll|we will|let me|let's|i'?m going to|i am going to|going to (?:check|search|verify|look)|about to)\b/i;
/** explanations of how railways work are never action claims ("PNR status usually checked …") */
const GENERAL_RE = /\b(usually|generally|normally|typically|often|always|aam taur|aamtaur|aksar|hamesha|niyam|rule|log\b|yatri|passengers can|ttes?\b)\b/i;
/** booking / lifecycle / passenger wording is guarded by the booking claim guards — not a railway-tool action */
const NON_TOOL_RE = /\b(booking|book|handoff|irctc|passenger|yatri|review|payment|otp|captcha|request prepare|cancel karne|cancellation request|details?)\b/i;
const PREVIOUS_RE = /\b(pehle|pahle|pichhli baar|pichli baar|pichhle|earlier|previously|already|pehle hi|thodi der pehle|last time)\b/i;
const FILLER_RE = /^(?:\s|[,.!:;—–-])*(?:(?:ek second|ek minute|ek pal|haan|han|ji|theek hai|thik hai|ok(?:ay)?|sure|achha|acha|accha|bas|zara|jaldi|abhi|turant|main|maine|hum|dobara|phir se|fir se|ek baar|now|just|again|let me|i'?ll|i will|i'?m|i am|re-?|ruko|wait|one sec(?:ond)?)(?:\s|[,.!:;—–-])*)*$/i;

const OBJECTS: Array<[ActionType, RegExp]> = [
  ['CHECK_PNR', /\bpnr\b/i],
  ['TRACK_TRAIN', /\b(live status|running status|live location|current location|kahan pahunchi|kahaan pahunchi|kahan hai|kahaan hai)\b/i],
  ['GET_CANCELLED_TRAINS', /\b(cancel+ed trains?|radd trains?|cancel+ed gaadiyan)\b/i],
  ['GET_LIVE_STATION', /\b(live station|station (?:board|arrivals|departures))\b/i],
  ['GET_TIMETABLE', /\b(timetable|time table|schedule|route|stops|halts?|stations? list)\b/i],
  ['GET_TRAIN_INFO', /\b(train (?:info|information|details)|train ki (?:jaankari|jankari|details)|jaankari|jankari|information)\b/i],
  ['CHECK_AVAILABILITY', /\b(availability|avlb|seats?|seat status|berth status|uplabdhta)\b/i],
  ['GET_FARE', /\b(fare|fares|kiraya|kiraaya|price|ticket price|daam)\b/i]
];
const SEARCH_OBJ_RE = /\b(trains|trainein|gaadiyan|fresh trains?|train list|trains? ki list|options|list)\b/i;
const SEARCH_VERB_RE = /\b(search(?:ing|ed)?|dhoo?n?dh\w*|dhundh\w*)\b/i;

/** The action claim a single clause makes, or null (not an action statement). */
export function detectActionClaim(clause: string, context = ''): ActionClaim | null {
  const t = String(clause || '').trim();
  if (!t || !VERB_RE.test(t)) return null;
  if (GENERAL_RE.test(t)) return null;
  // "Availability check kar li hai, kaunsi class chahiye?" — only the trailing question is a question; a statement
  // before it is still judged as a statement
  if (/\?\s*$/.test(t)) {
    const cut = t.lastIndexOf(',');
    const head = cut > 0 ? t.slice(0, cut) : '';
    if (head && VERB_RE.test(head) && (SUCC_RE.test(head) || EXEC_RE.test(head) || PLAN_RE.test(head) || MAINE_RE.test(head))) return detectActionClaim(head + '.', context);
  }
  const neg = NEG_RE.test(t);
  const phase: ActionPhase | null = OFFER_RE.test(t) || CONDITIONAL_RE.test(t) ? 'OFFER'
    : neg ? 'NOT_DONE'
    : SUCC_RE.test(t) || MAINE_RE.test(t) ? 'SUCCEEDED'
    : EXEC_RE.test(t) ? 'EXECUTING'
    : PLAN_RE.test(t) ? 'PLANNED' : null;
  if (!phase) return null;
  const types: ActionType[] = [];
  for (const [tool, re] of OBJECTS) if (re.test(t)) types.push(tool);
  if (!types.length && (SEARCH_VERB_RE.test(t) || SEARCH_OBJ_RE.test(t))) types.push('SEARCH_TRAINS');
  // "maine train check kar li" — some train lookup, not one specific tool
  if (!types.length && /\b(train|gaadi)\b/i.test(t) && !NON_TOOL_RE.test(t)) types.push('ANY_RAILWAY_TOOL');
  if (!types.length) {
    if (NON_TOOL_RE.test(t)) return null;
    // generic "Ek second, dobara verify kar raha hoon" — only when NOTHING but fillers precedes the verb (an unmapped
    // object like "status" / "details" is not a railway-tool action and stays with the other guards)
    const m = t.match(VERB_RE)!;
    if (!FILLER_RE.test(t.slice(0, m.index))) return null;
    types.push('ANY_RAILWAY_TOOL');
  } else if (NON_TOOL_RE.test(t) && /\b(booking|handoff|irctc|payment|otp)\b/i.test(t)) return null;
  const own = (s: string) => ({ trains: [...new Set(s.match(/\b\d{5}\b/g) || [])], classes: [...new Set((s.toUpperCase().match(CLS_RE) || []))], dates: claimedDates(s) });
  let e = own(t);
  // a clause without its own entity inherits the sentence's (one antecedent — "12497 hai; availability check kar li")
  if (!e.trains.length && !e.classes.length && !e.dates.length && context) e = own(context);
  const subtype: ActionClaimSubtype = phase === 'OFFER' ? 'ACTION_OFFERED' : phase === 'NOT_DONE' ? 'ACTION_FAILED'
    : phase === 'SUCCEEDED' ? 'ACTION_SUCCEEDED' : phase === 'EXECUTING' ? 'ACTION_EXECUTING' : 'ACTION_PLANNED';
  return { phrase: phraseOf(t), phase, subtype, actionTypes: types, trainNumbers: e.trains, travelClasses: e.classes, dates: e.dates,
    previousRef: PREVIOUS_RE.test(t) };
}

/** short, id-free action phrase for logs ("availability check kar raha hoon") */
function phraseOf(t: string): string {
  const m = t.match(VERB_RE);
  const at = m ? Math.max(0, (m.index || 0) - 32) : 0;
  return t.slice(at, at + 64).replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ verification (authority = execution records)
const PER_TRAIN = new Set(['CHECK_AVAILABILITY', 'GET_FARE', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'TRACK_TRAIN']);
const PER_CLASS = new Set(['CHECK_AVAILABILITY', 'GET_FARE']);
const DATED = new Set(['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE']);

function entityMiss(e: ActionExecution, c: ActionClaim, type: ActionType): ActionRemovalReason | null {
  const tool = type === 'ANY_RAILWAY_TOOL' ? e.toolName : type;
  if (PER_TRAIN.has(tool) && c.trainNumbers.length && !(e.trainNumber && c.trainNumbers.includes(e.trainNumber))) return 'ACTION_TRAIN_MISMATCH';
  if (PER_CLASS.has(tool) && c.travelClasses.length && !(e.travelClass && c.travelClasses.includes(e.travelClass))) return 'ACTION_CLASS_MISMATCH';
  if (DATED.has(tool) && c.dates.length && !(e.date && c.dates.includes(e.date))) return 'ACTION_DATE_MISMATCH';
  return null;
}

/** committed session evidence for an explicit "pehle hi check kar li thi" — the date must still be the session's */
function previousEvidence(type: ActionType, c: ActionClaim, s: any): boolean {
  if (!s) return false;
  const okTrain = (n?: string) => !c.trainNumbers.length || (!!n && c.trainNumbers.includes(String(n)));
  const okCls = (k?: string) => !c.travelClasses.length || (!!k && c.travelClasses.includes(String(k).toUpperCase()));
  const okDate = (d?: string) => !c.dates.length || (!!d && c.dates.includes(String(d)));
  if (type === 'CHECK_AVAILABILITY') return Object.values(s.availability || {}).some((a: any) => okTrain(a?.trainNumber) && okCls(a?.travelClass) && okDate(a?.date || s.date));
  if (type === 'GET_FARE') { const b = s.fareBasis || {}; return !!s.fare && okTrain(b.trainNumber) && okCls(b.travelClass) && okDate(b.date || s.date); }
  if (type === 'SEARCH_TRAINS') return !!s.searchResults && okDate(s.date);
  return false;
}

export function verifyActionClaim(c: ActionClaim, ledger: ActionLedger): ActionVerdict {
  if (c.phase === 'OFFER') return { ok: true, actionType: c.actionTypes[0] ?? null, actionStatus: 'NOT_REQUESTED', toolCallId: null, toolName: null };
  let last: ActionVerdict | null = null;
  for (const type of c.actionTypes) {
    const same = ledger.current.filter(e => type === 'ANY_RAILWAY_TOOL' ? ACTION_TOOLS.includes(e.toolName as any) : e.toolName === type);
    const matching = same.filter(e => !entityMiss(e, c, type));
    const pick = (es: ActionExecution[]) => es[es.length - 1];
    const v = (ok: boolean, status: ActionStatus, e?: ActionExecution, reason?: ActionRemovalReason): ActionVerdict =>
      ({ ok, actionType: type, actionStatus: status, toolCallId: e?.toolCallId || null, toolName: e?.toolName || (type === 'ANY_RAILWAY_TOOL' ? null : type), ...(reason ? { removalReason: reason } : {}) });
    const succeeded = matching.filter(e => e.status === 'SUCCEEDED');
    if (c.phase === 'NOT_DONE') {
      // "check nahi ho paayi" is false only when it DID succeed (for that entity) this turn
      last = succeeded.length ? v(false, 'SUCCEEDED', pick(succeeded), 'CONTRADICTS_SUCCESSFUL_EXECUTION') : v(true, pick(matching)?.status || 'NOT_REQUESTED', pick(matching));
      if (!last.ok) return last;
      continue;
    }
    if (c.phase === 'SUCCEEDED') {
      if (succeeded.length) { last = v(true, 'SUCCEEDED', pick(succeeded)); continue; }
      if (c.previousRef && type !== 'ANY_RAILWAY_TOOL' && previousEvidence(type, c, ledger.session)) { last = v(true, 'SUCCEEDED'); continue; }
      const stale = matching.filter(e => e.status === 'STALE');
      if (stale.length) return v(false, 'STALE', pick(stale), 'ACTION_STALE');
      const failed = matching.filter(e => e.status === 'FAILED');
      if (failed.length) { const e = pick(failed); return v(false, 'FAILED', e, e.outcome === 'TIMEOUT' || e.outcome === 'UNKNOWN' ? 'TOOL_TIMEOUT' : 'TOOL_FAILED'); }
      return miss(type, c, same, matching, ledger, v, c.previousRef ? 'PREVIOUS_ACTION_NOT_FOUND' : 'NO_SUCCESSFUL_CURRENT_TURN_EXECUTION');
    }
    // PLANNED / EXECUTING — the tool must genuinely have entered execution this turn (a proposal alone is not enough)
    const dispatched = matching.filter(e => DISPATCHED.has(e.status));
    if (dispatched.some(e => e.status !== 'STALE')) { const e = pick(dispatched.filter(x => x.status !== 'STALE')); last = v(true, e.status, e); continue; }
    if (dispatched.length) return v(false, 'STALE', pick(dispatched), 'ACTION_STALE');
    return miss(type, c, same, matching, ledger, v, 'NO_CURRENT_TURN_EXECUTION');
  }
  return last || { ok: true, actionType: null, actionStatus: 'NOT_REQUESTED', toolCallId: null, toolName: null };
}

function miss(type: ActionType, c: ActionClaim, same: ActionExecution[], matching: ActionExecution[], ledger: ActionLedger,
  v: (ok: boolean, s: ActionStatus, e?: ActionExecution, r?: ActionRemovalReason) => ActionVerdict, fallback: ActionRemovalReason): ActionVerdict {
  // a call of that tool ran, but for another train / class / date
  const other = same.filter(e => DISPATCHED.has(e.status));
  if (!matching.length && other.length) { const e = other[other.length - 1]; return v(false, e.status, e, entityMiss(e, c, type) || fallback); }
  // proposed but never executed (validator rejection / duplicate / cancelled)
  const notRun = matching.filter(e => !DISPATCHED.has(e.status));
  if (notRun.length) { const e = notRun[notRun.length - 1]; return v(false, e.status, e, 'TOOL_NOT_EXECUTED'); }
  // the claim matches only what an EARLIER turn did → that progress is stale for this turn
  const prev = ledger.previous.filter(e => (type === 'ANY_RAILWAY_TOOL' || e.toolName === type) && DISPATCHED.has(e.status) && !entityMiss(e, c, type));
  if (prev.length) return v(false, 'STALE', prev[prev.length - 1], 'STALE_PREVIOUS_TURN_ACTION');
  return v(false, 'NOT_REQUESTED', undefined, fallback);
}

// ------------------------------------------------------------------ guard: remove only the false action clause
const SENT_SPLIT = /(?<=[.!?।])\s+(?=\S)/;
/** clause separators inside one sentence (the separator is kept with the clause that follows it) */
const CLAUSE_SPLIT = /(\s*;\s*|\s+[—–]\s+|\s+-\s+|,\s+(?=(?:aur|and|lekin|but|par|phir|toh|so|magar)\b)|\s+(?:aur|and)\s+(?=(?:main|maine|i|i'm|i'll|abhi|ab|we)\b))/i;
const ORPHAN_RE = /^[\s\d.,;:!?()•*·\-–—]*$/;
const LONE_CONJ_RE = /^(aur|and|or|ya|lekin|but|par|toh|to|phir|fir|then|also|bhi|magar|so)[\s.,;:!?—–-]*$/i;
const LEAD_CONJ_RE = /^(aur|and|lekin|but|par|toh|phir|magar|so)\s+/i;

export interface ActionGuardResult {
  text: string;
  removed: Array<{ clause: string; verdict: ActionVerdict; claim: ActionClaim }>;
  diagnostics: ActionClaimDiagnostic[];
}

export function diagnosticOf(claim: ActionClaim, verdict: ActionVerdict, ledger: ActionLedger, rejected: boolean): ActionClaimDiagnostic {
  const e = verdict.toolCallId ? [...ledger.current, ...ledger.previous].find(x => x.toolCallId === verdict.toolCallId) : undefined;
  return {
    actionClaim: claim.phrase, actionSubtype: rejected && verdict.actionStatus === 'STALE' ? 'ACTION_STALE' : claim.subtype,
    actionType: verdict.actionType, actionStatus: verdict.actionStatus, toolCallId: verdict.toolCallId, toolName: verdict.toolName,
    turnId: e?.turnId ?? ledger.turnId,
    entity: (claim.trainNumbers[0] || claim.travelClasses[0]) ? { ...(claim.trainNumbers[0] ? { trainNumber: claim.trainNumbers[0] } : {}), ...(claim.travelClasses[0] ? { travelClass: claim.travelClasses[0] } : {}) } : null,
    date: claim.dates[0] ?? e?.date ?? null,
    validationStatus: claim.phase === 'OFFER' ? 'NOT_APPLICABLE' : rejected ? 'REJECTED' : 'VALID',
    removalReason: rejected ? (verdict.removalReason ?? null) : null
  };
}

/** Guard one sentence: false action clauses are removed, everything else (facts, questions) stays untouched. */
export function guardActionSentence(sentence: string, ledger: ActionLedger): ActionGuardResult {
  const out: ActionGuardResult = { text: sentence, removed: [], diagnostics: [] };
  if (!VERB_RE.test(sentence)) return out;
  const parts = sentence.split(CLAUSE_SPLIT);
  // parts = [clause, sep, clause, sep, clause…]
  const clauses: Array<{ sep: string; text: string }> = [];
  for (let i = 0; i < parts.length; i += 2) clauses.push({ sep: i ? parts[i - 1] : '', text: parts[i] });
  const keep: Array<{ sep: string; text: string }> = [];
  for (const c of clauses) {
    const claim = detectActionClaim(c.text, sentence);
    if (!claim) { keep.push(c); continue; }
    // one verdict per claimed tool ("availability aur fare check ho gaye" needs BOTH executions)
    const verdicts = claim.phase === 'OFFER' ? [verifyActionClaim(claim, ledger)] : claim.actionTypes.map(t => verifyActionClaim({ ...claim, actionTypes: [t] }, ledger));
    for (const v of verdicts) out.diagnostics.push(diagnosticOf(claim, v, ledger, !v.ok));
    const bad = verdicts.find(v => !v.ok);
    if (!bad) keep.push(c); else out.removed.push({ clause: c.text.trim(), verdict: bad, claim });
  }
  if (!out.removed.length) return out;
  const end = (sentence.trim().match(/[.!?।]+$/) || ['.'])[0];
  let txt = keep.map((c, i) => (i ? c.sep : '') + c.text).join('').trim();
  txt = txt.replace(/[\s,;:—–-]+$/g, '').replace(/[.!?।]+$/, '').trim();
  txt = txt.replace(LEAD_CONJ_RE, '');
  if (!txt || ORPHAN_RE.test(txt) || LONE_CONJ_RE.test(txt) || !/[A-Za-zऀ-ॿ]{2,}/.test(txt)) { out.text = ''; return out; }
  out.text = txt.charAt(0).toUpperCase() + txt.slice(1) + end;
  return out;
}

/**
 * Guard a whole reply (multi-line backend reply or LLM text). Lines without a removal are returned byte-identical
 * (list rows, cards text); a line that lost a clause is cleaned of orphan fragments ("1.", dangling "aur").
 */
export function guardActionClaims(text: string, ledger: ActionLedger): ActionGuardResult {
  const res: ActionGuardResult = { text, removed: [], diagnostics: [] };
  if (!text || !VERB_RE.test(text)) return res;
  const lines = String(text).split('\n');
  const outLines: string[] = [];
  for (const line of lines) {
    if (!VERB_RE.test(line)) { outLines.push(line); continue; }
    const sents = line.split(SENT_SPLIT);
    let changed = false;
    const kept: string[] = [];
    for (const s of sents) {
      const g = guardActionSentence(s, ledger);
      res.diagnostics.push(...g.diagnostics);
      if (g.removed.length) { changed = true; res.removed.push(...g.removed); if (g.text) kept.push(g.text); }
      else kept.push(s);
    }
    if (!changed) { outLines.push(line); continue; }
    // orphan cleanup only where something was removed
    const clean: string[] = [];
    for (const k of kept) {
      const t = k.trim();
      if (!t || ORPHAN_RE.test(t) || LONE_CONJ_RE.test(t)) continue;
      clean.push(clean.length ? t.replace(LEAD_CONJ_RE, (m) => '').replace(/^./, ch => ch.toUpperCase()) : t);
    }
    if (clean.length) outLines.push(clean.join(' '));
  }
  res.text = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return res;
}

/**
 * Barge-in / superseded turn: every pending progress statement of the interrupted turn is STALE — removed whatever the
 * execution said (offers / questions / "nahi ho paayi" stay). Used on an interrupted turn's late response.
 */
export function stripStaleActionClaims(text: string, turnId: string | null): ActionGuardResult {
  const staleLedger: ActionLedger = { turnId, current: [], previous: [] };
  const g = guardActionClaims(text, staleLedger);
  for (const d of g.diagnostics) if (d.validationStatus === 'REJECTED') { d.actionStatus = 'STALE'; d.actionSubtype = 'ACTION_STALE'; d.removalReason = 'ACTION_STALE'; }
  for (const r of g.removed) { r.verdict = { ...r.verdict, actionStatus: 'STALE', removalReason: 'ACTION_STALE' }; }
  return g;
}

/**
 * Progress / acknowledgement check at DISPATCH time: an acknowledgement may describe only tools that genuinely entered
 * execution (same train / class / date). Statements without an action claim (pure fillers) are fine.
 */
export function acknowledgementMatchesDispatch(ack: string, dispatched: ActionExecution[]): boolean {
  const ledger: ActionLedger = { turnId: null, current: dispatched, previous: [] };
  for (const s of String(ack || '').split(SENT_SPLIT)) {
    const g = guardActionSentence(s, ledger);
    if (g.removed.length) return false;
    // an acknowledgement must not already claim a result while the tool is still running
    if (g.diagnostics.some(d => d.actionSubtype === 'ACTION_SUCCEEDED')) return false;
  }
  return true;
}
