import { validateWebQuery } from '../../research/web-research-service';
/**
 * ToolCallValidator — validates individual LLM-issued tool calls BEFORE any
 * RailwayProvider call is made. Treats LLM arguments as UNTRUSTED external
 * input. Validates:
 *   1. Tool name is registered
 *   2. Tool is currently enabled/available
 *   3. Argument types / required fields match the tool schema
 *   4. Route (origin/destination) resolves via RouteResolver
 *   5. Date resolves via DateResolver
 *   6. Selected train exists in current session (when required)
 *   7. Selected class exists on selected train (when required)
 *   8. Booking state permits the operation
 *
 * If validation fails: returns INVALID_TOOL_CALL / UNKNOWN_TOOL / TOOL_UNAVAILABLE
 * / MISSING_REQUIRED_FIELD / AMBIGUOUS_STATION / AMBIGUOUS_DATE /
 * INVALID_ACTION_FOR_STATE — RailwayProvider is NOT called.
 */
import type { BookingSession } from '@shared/entities';
import { BookingState, EXECUTION_LOCKED_STATES } from '@shared/states';
import { SameTrainErrorCode } from '@shared/same-train-alternatives';
import { resolveSameTrainProviders, isSameTrainResultStale } from '../../railway/same-train/same-train-service';
import { REGISTERED_TOOLS, getToolDefinition, type ToolCall, type ToolDefinition, type RegisteredToolName, type ToolParam } from './tool-registry';
import type { OrchestratorError } from '../decisions/agent-decision';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationToken } from '../../railway/resolvers/route-resolver';
import { normalizePnrInput, pnrsInText } from '../../booking/post-booking/pnr-validator';
import type { ToolGrounding } from '../../booking/post-booking/post-booking-service';

export interface ValidatedToolCall {
  name: RegisteredToolName;
  callId: string;
  arguments: Record<string, any>; // canonicalized (codes, YYYY-MM-DD, numbers)
  tool: ToolDefinition;
}

/**
 * Tools that are intentionally NOT available — the runtime returns a clean
 * TOOL_UNAVAILABLE response rather than executing them. (Prompt 14: TRACK_TRAIN and
 * CHECK_PNR are now registered read-only lookups with strict grounding below.)
 */
const UNAVAILABLE_TOOLS: ReadonlySet<RegisteredToolName> = new Set<RegisteredToolName>([]);

export class ToolCallValidator {

  /**
   * @param ground Prompt 14 grounding for CHECK_PNR / TRACK_TRAIN (user's own words + this session's
   *               booking records). Without it, PNR / train values can never be grounded.
   */
  validate(call: ToolCall, session: BookingSession, ground?: ToolGrounding): { ok: true; v: ValidatedToolCall } | { ok: false; error: OrchestratorError } {
    if (!call || !call.name || typeof call.name !== 'string') {
      return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: 'Tool call malformed hai.' } };
    }
    // 1. Existence in closed registry
    const def = getToolDefinition(call.name as RegisteredToolName);
    if (!def) {
      if (UNAVAILABLE_TOOLS.has(call.name as RegisteredToolName)) {
        return { ok: false, error: { code: 'TOOL_UNAVAILABLE', message: `"${call.name}" अभी उपलब्ध नहीं है।` } };
      }
      return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `"${call.name}" tool मौजूद नहीं है।` } };
    }
    // 2. Availability
    if (UNAVAILABLE_TOOLS.has(call.name as RegisteredToolName)) {
      return { ok: false, error: { code: 'TOOL_UNAVAILABLE', message: `"${call.name}" अभी उपलब्ध नहीं है।` } };
    }
    const args = call.arguments || {};

    // 3. Schema: required fields + types
    for (const [pname, pspec] of Object.entries(def.parameters) as Array<[string, ToolParam]>) {
      if (pspec.required && (args[pname] === undefined || args[pname] === null || args[pname] === '')) {
        return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: `${def.name} के लिए "${pname}" चाहिए।`, details: { param: pname } } };
      }
      if (args[pname] !== undefined && args[pname] !== null) {
        if (pspec.type === 'number' && typeof args[pname] !== 'number') {
          const n = Number(args[pname]);
          if (Number.isNaN(n)) return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: `"${pname}" number होना चाहिए।`, details: { param: pname } } };
          args[pname] = n;
        } else if (pspec.type === 'string' && typeof args[pname] !== 'string') {
          return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: `"${pname}" string होनी चाहिए।`, details: { param: pname } } };
        } else if (pspec.type === 'boolean' && typeof args[pname] !== 'boolean') {
          return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: `"${pname}" boolean होनी चाहिए।`, details: { param: pname } } };
        }
        if (pspec.enum && !pspec.enum.includes(args[pname])) {
          return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: `"${pname}" के लिए मान्य values: ${pspec.enum.join(', ')}`, details: { param: pname } } };
        }
      }
    }
    // Reject any unknown arguments
    for (const k of Object.keys(args)) {
      if (!(k in def.parameters)) {
        return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: `"${k}" ${def.name} का ज्ञात parameter नहीं है।` } };
      }
    }

    // 4. Per-tool state/argument validation
    switch (def.name) {
      case 'SEARCH_TRAINS': return this.validateSearch(call.callId, def, args, session);
      case 'GET_TRAIN_INFO': return this.validateTrainInfo(call.callId, def, args, session);
      case 'GET_TIMETABLE': return this.validateTimetable(call.callId, def, args, session);
      case 'CHECK_AVAILABILITY': return this.validateAvailability(call.callId, def, args, session);
      case 'GET_FARE': return this.validateFare(call.callId, def, args, session);
      case 'TRACK_TRAIN': return this.validateTrack(call.callId, def, args, session, ground);
      case 'CHECK_PNR': return this.validatePnr(call.callId, def, args, session, ground);
      case 'WEB_RAILWAY_RESEARCH': {
        const q = validateWebQuery(args.query);
        if (!q.ok) return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: q.message } as OrchestratorError };
        return { ok: true, v: { name: def.name, callId: call.callId, arguments: { query: q.query }, tool: def } };
      }
      case 'SEARCH_SAME_TRAIN_ALTERNATIVES': return this.validateSameTrainSearch(call.callId, def, args, session, ground);
      case 'PRESENT_SAME_TRAIN_ALTERNATIVES': return this.validateSameTrainPresent(call.callId, def, args, session);
      default:
        return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `"${def.name}" tool मौजूद नहीं है।` } };
    }
  }

  /**
   * Prompt 42 — SEARCH_SAME_TRAIN_ALTERNATIVES. Hard constraints only (Muse chose to call it):
   *   - the train must be grounded (shown results / selection / focus / last train info / the user's own words);
   *   - class, date, requested origin + destination and passengers resolve from the arguments or the session journey;
   *   - providers / routeProvider must be configured connectors with the needed capability (no arbitrary ids);
   *   - never while a booking execution is locked.
   */
  private validateSameTrainSearch(callId: string, def: ToolDefinition, args: Record<string, any>, session: BookingSession, g?: ToolGrounding) {
    const E = (code: any, message: string, details?: any) => ({ ok: false as const, error: { code, message, ...(details ? { details } : {}) } as OrchestratorError });
    if (EXECUTION_LOCKED_STATES.has(session.bookingState as BookingState)) return E('INVALID_ACTION_FOR_STATE', 'Booking process chal raha hai — abhi same train alternative check nahi kar sakte.');
    const s: any = session;
    const train = String(args.trainNumber ?? '').trim();
    if (!/^\d{5}$/.test(train)) return E('INVALID_TOOL_CALL', 'Train number 5 digits ka hona chahiye.');
    const sel: any = s.selectedTrain;
    const known = new Set<string>([
      ...((s.searchResults?.trains || []) as any[]).map(t => String(t.trainNumber || t.number)),
      ...(sel ? [String(sel.number || sel.trainNumber)] : []),
      ...(s.focusTrainNumber ? [String(s.focusTrainNumber)] : []),
      ...(s.lastTrainInfo?.trainNumber ? [String(s.lastTrainInfo.trainNumber)] : []),
      ...(s.carryOverSelection?.trainNumber ? [String(s.carryOverSelection.trainNumber)] : [])
    ]);
    const typed = !!g && [...String(g.userText || '').matchAll(/(?<!\d)(\d{5})(?!\d)/g)].some(m => m[1] === train);
    if (!known.has(train) && !typed) return E('AUTHORITATIVE_DATA_REQUIRED', 'Same train alternative ke liye train identify nahi hui.', { missingField: 'TRAIN' });
    const travelClass = String(args.travelClass || s.selectedClass || '').toUpperCase();
    if (!travelClass) return E(SameTrainErrorCode.NOT_READY, 'Kaunsi class ke liye check karna hai? (jaise CC, 3A, SL)', { missing: 'travelClass' });
    const row = ((s.searchResults?.trains || []) as any[]).find(t => String(t.trainNumber || t.number) === train);
    const rowClasses: string[] = row ? [...(row.classes || []).map((c: any) => String(c.code || c).toUpperCase()), ...(row.availableClasses || []).map((c: any) => String(c).toUpperCase())] : [];
    if (rowClasses.length && !rowClasses.includes(travelClass)) return E('INVALID_TOOL_CALL', `${train} mein ${travelClass} class nahi hai (${rowClasses.join(', ')}).`);
    const date = this.resolveDateStr(args.date || s.date);
    if (!date) return E(SameTrainErrorCode.NOT_READY, 'Journey date abhi set nahi hai.', { missing: 'date', missingField: 'DATE' });
    const o = this.resolveStation(String(args.origin || s.origin || '').trim());
    const d = this.resolveStation(String(args.destination || s.destination || '').trim());
    if (!o || !d) return E(SameTrainErrorCode.NOT_READY, 'Route (origin / destination) abhi set nahi hai.', { missing: !o ? 'origin' : 'destination', missingField: !o ? 'ORIGIN' : 'DESTINATION' });
    if (o.code === d.code) return E(SameTrainErrorCode.INVALID_STATION_PAIR, 'Origin aur destination ek jaise nahi ho sakte.');
    const pax = args.passengersCount !== undefined ? Number(args.passengersCount) : Number(s.passengersCount || 1);
    if (!Number.isInteger(pax) || pax < 1 || pax > 6) return E('INVALID_TOOL_CALL', 'Passengers 1 se 6 ke beech hone chahiye.');
    if (args.destinationExtensionStations !== undefined) {
      const n = Number(args.destinationExtensionStations);
      if (!Number.isInteger(n) || n < 5 || n > 7) return E('INVALID_TOOL_CALL', 'destinationExtensionStations 5 se 7 ke beech hona chahiye.');
    }
    const pr = resolveSameTrainProviders(args.providers, args.routeProvider);
    if (!pr.ok) return E(pr.code, pr.message);
    const canonical: Record<string, any> = {
      trainNumber: train, travelClass, date, origin: o.code, destination: d.code, passengersCount: pax,
      originSweep: args.originSweep !== false, destinationSweep: args.destinationSweep !== false,
      ...(args.destinationExtensionStations !== undefined ? { destinationExtensionStations: Number(args.destinationExtensionStations) } : {}),
      combinedPairs: args.combinedPairs || 'AUTO',
      providers: pr.providers.map(p => p.id).join(','), routeProvider: pr.routeProvider.id, providerSelection: pr.selection,
      includeFare: args.includeFare === true, webEvidence: args.webEvidence === true
    };
    return { ok: true as const, v: { name: def.name, callId, arguments: canonical, tool: def } };
  }

  /** Prompt 42 — PRESENT_SAME_TRAIN_ALTERNATIVES: Muse's ranking must reference the CURRENT result's shown ids only. */
  private validateSameTrainPresent(callId: string, def: ToolDefinition, args: Record<string, any>, session: BookingSession) {
    const E = (code: any, message: string, details?: any) => ({ ok: false as const, error: { code, message, ...(details ? { details } : {}) } as OrchestratorError });
    const r: any = (session as any).sameTrainAlternatives;
    const id = String(args.alternativeSearchId || '').trim();
    if (!r || r.alternativeSearchId !== id) return E(SameTrainErrorCode.NOT_FOUND, 'Yeh alternativeSearchId current Same Train Alternative result nahi hai.');
    if (isSameTrainResultStale(session, r)) return E(SameTrainErrorCode.STALE_RESULT, 'Journey badal gayi — yeh alternative result stale hai.');
    const shown = new Map<string, any>((r.alternatives || []).map((a: any) => [a.alternativeId, a]));
    const best = args.bestMatch ? String(args.bestMatch).trim().toUpperCase() : '';
    if (best) {
      const a = shown.get(best);
      if (!a) return E('INVALID_TOOL_CALL', `bestMatch ${best} is result mein nahi hai (${[...shown.keys()].join(', ')}).`);
      if (a.verificationStatus !== 'VERIFIED' && a.verificationStatus !== 'PARTIALLY_VERIFIED') return E('INVALID_TOOL_CALL', `${best} ${a.verificationStatus} hai — best match sirf VERIFIED / PARTIALLY_VERIFIED ho sakta hai.`);
    }
    const order = String(args.order || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    const unknown = order.filter(x => !shown.has(x));
    if (unknown.length) return E('INVALID_TOOL_CALL', `order mein unknown ids: ${unknown.join(', ')}.`);
    return { ok: true as const, v: { name: def.name, callId, arguments: { alternativeSearchId: id, ...(best ? { bestMatch: best } : {}), order: [...new Set(order)].join(',') }, tool: def } };
  }

  /**
   * CHECK_PNR (Prompt 14): the PNR comes ONLY from (a) the user's own words this turn or
   * (b) this session's authoritative booking record (via bookingId / booking in focus).
   * Malformed → INVALID_PNR; another session's booking / PNR → BOOKING_ACCESS_DENIED;
   * an LLM-supplied PNR that the user never typed → AUTHORITATIVE_DATA_REQUIRED.
   * The provider is NOT called on any of these errors.
   */
  private validatePnr(callId: string, def: ToolDefinition, args: Record<string, any>, _session: BookingSession, g?: ToolGrounding) {
    const E = (code: any, message: string, details?: any) => ({ ok: false as const, error: { code, message, ...(details ? { details } : {}) } as OrchestratorError });
    const has = (v: any) => v !== undefined && v !== null && v !== '';
    if (has(args.pnr) && has(args.bookingId)) return E('INVALID_TOOL_CALL', 'CHECK_PNR: pnr ya bookingId — dono nahi.');
    if (has(args.pnr)) {
      const v = normalizePnrInput(args.pnr);
      if (!v.ok) return E('INVALID_PNR', v.message);
      const owner = g ? g.pnrOwner(v.pnr) : 'NONE';
      if (owner === 'OTHER') return E('BOOKING_ACCESS_DENIED', 'Yeh PNR is session ki kisi booking ka nahi hai.');
      const typed = !!g && pnrsInText(g.userText).includes(v.pnr);
      if (!typed && owner !== 'SELF') return E('AUTHORITATIVE_DATA_REQUIRED', 'PNR user ya booking record se hi aa sakta hai. Kripya 10-digit PNR batayein.');
      const own = g?.bookings.find(b => b.pnr === v.pnr);
      return { ok: true as const, v: { name: def.name, callId, arguments: { pnr: v.pnr, ...(own ? { bookingId: own.bookingId } : {}) }, tool: def } };
    }
    const id: string | undefined = has(args.bookingId) ? String(args.bookingId)
      : g?.activeBookingId && g.bookings.some(b => b.bookingId === g.activeBookingId) ? g.activeBookingId
      : g?.bookings.length === 1 ? g.bookings[0].bookingId : undefined;
    if (!id) {
      return (g?.bookings.length || 0) > 1
        ? E('MULTIPLE_BOOKINGS_MATCHED', 'Is session mein ek se zyada booking match hui.', { missingField: 'BOOKING' })
        : E('BOOKING_CONTEXT_MISSING', 'PNR number nahi mila (10-digit chahiye).', { missingField: 'PNR' });
    }
    const owner = g ? g.bookingOwner(id) : 'NONE';
    if (owner === 'OTHER') return E('BOOKING_ACCESS_DENIED', 'Yeh booking is session ki nahi hai.');
    const b = g?.bookings.find(x => x.bookingId === id);
    if (owner === 'NONE' || !b) return E('BOOKING_NOT_FOUND', 'Booking record nahi mila.');
    if (!b.pnr) return E('PNR_NOT_AVAILABLE', b.status === 'CONFIRMED' ? 'Is booking ka PNR provider ne abhi nahi diya, isliye PNR status check nahi ho sakta.' : 'Yeh booking confirmed nahi hai, isliye PNR available nahi hai.');
    return { ok: true as const, v: { name: def.name, callId, arguments: { pnr: b.pnr, bookingId: b.bookingId }, tool: def } };
  }

  /**
   * TRACK_TRAIN (Prompt 14): the train number must come from the user's words, the session
   * (results / selection / focus) or this session's booking record — never an LLM guess.
   */
  private validateTrack(callId: string, def: ToolDefinition, args: Record<string, any>, session: BookingSession, g?: ToolGrounding) {
    const E = (code: any, message: string, details?: any) => ({ ok: false as const, error: { code, message, ...(details ? { details } : {}) } as OrchestratorError });
    const explicit = args.trainNumber !== undefined && args.trainNumber !== null && args.trainNumber !== '';
    const sel: any = session.selectedTrain;
    const sessionTrains = new Set<string>([
      ...((session.searchResults?.trains || []) as any[]).map(t => String(t.trainNumber || t.number)),
      ...(sel ? [String(sel.number || sel.trainNumber)] : []),
      ...(session.focusTrainNumber ? [String(session.focusTrainNumber)] : [])
    ]);
    if (explicit) {
      const s = String(args.trainNumber).trim();
      if (!/^\d{4,5}$/.test(s)) return E('INVALID_TOOL_CALL', 'Train number 4-5 digits ka hona chahiye.');
      const typed = !!g && [...g.userText.matchAll(/(?<!\d)(\d{4,5})(?!\d)/g)].some(m => m[1] === s);
      const own = g?.bookings.find(b => b.trainNumber === s);
      if (!typed && !own && !sessionTrains.has(s)) return E('AUTHORITATIVE_DATA_REQUIRED', 'Track karne ke liye train identify nahi hui.', { missingField: 'TRAIN' });
      return { ok: true as const, v: { name: def.name, callId, arguments: { trainNumber: s, ...(own ? { bookingId: own.bookingId } : {}) }, tool: def } };
    }
    const b = g && (g.bookings.find(x => x.bookingId === g.activeBookingId) || (g.bookings.length === 1 ? g.bookings[0] : undefined));
    if (b) return { ok: true as const, v: { name: def.name, callId, arguments: { trainNumber: b.trainNumber, bookingId: b.bookingId }, tool: def } };
    const focus = (sel && String(sel.number || sel.trainNumber)) || session.focusTrainNumber;
    if (focus) return { ok: true as const, v: { name: def.name, callId, arguments: { trainNumber: String(focus) }, tool: def } };
    return E('MISSING_REQUIRED_FIELD', 'Track karne ke liye train number nahi mila.', { missingField: 'TRAIN' });
  }

  private resolveStation(raw: string): { code: string; name: string } | null {
    if (!raw) return null;
    if (/^[A-Z]{2,5}$/.test(raw)) return resolveStationToken(raw) || { code: raw, name: raw };   // P37: LLM-supplied official code
    return resolveStationToken(raw);
  }

  private resolveDateStr(raw: any): string | null {
    if (!raw) return null;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const r = resolveDate(String(raw));
    return r.ok ? r.date : null;
  }

  private validateSearch(callId: string, def: ToolDefinition, args: Record<string,any>, session: BookingSession) {
    // Accept station codes (3-4 letter) directly or resolve raw city words via RouteResolver.
    const o = this.resolveStation(String(args.origin || session.origin || ''));
    const d = this.resolveStation(String(args.destination || session.destination || ''));
    const date = this.resolveDateStr(args.date || session.date);
    if (!o || !d) return { ok:false as const, error:{ code:'AMBIGUOUS_STATION' as const, message:'शुरुआत/मंज़िल स्टेशन समझ नहीं आया।' } };
    if (!date) return { ok:false as const, error:{ code:'AMBIGUOUS_DATE' as const, message:'तारीख समझ नहीं आयी।' } };
    if (o.code === d.code) return { ok:false as const, error:{ code:'AMBIGUOUS_ROUTE' as any, message:'शुरुआत और मंज़िल एक जैसी नहीं हो सकतीं।' } };
    const canonical: Record<string, any> = { ...args, origin: o.code, destination: d.code, date };
    if (canonical.passengersCount !== undefined) {
      const n = Number(canonical.passengersCount);
      if (!(n >= 1 && n <= 6)) return { ok:false as const, error:{ code:'INVALID_TOOL_CALL' as const, message:'Passengers 1-6 के बीच होने चाहिए।' } };
      canonical.passengersCount = n;
    }
    if (canonical.preferredClass && !['AC','NON_AC','ANY'].includes(canonical.preferredClass)) {
      return { ok:false as const, error:{ code:'INVALID_TOOL_CALL' as const, message:'preferredClass AC | NON_AC | ANY होना चाहिए।' } };
    }
    return { ok:true as const, v: { name: def.name, callId, arguments: canonical, tool: def } };
  }

  private validateTrainNumber(raw: any, session: BookingSession): string | null {
    if (!raw) return null;
    const num = String(raw).match(/(\d{4,5})/);
    if (num) return num[1];
    return null;
  }

  /** Train in focus: explicit arg → selected train → last discussed train. */
  private focusTrain(args: Record<string, any>, session: BookingSession): string | null {
    if (args.trainNumber !== undefined && args.trainNumber !== null && args.trainNumber !== '') return this.validateTrainNumber(args.trainNumber, session);
    const sel: any = session.selectedTrain;
    return (sel && (sel.number || sel.trainNumber)) || session.focusTrainNumber || null;
  }

  private validateTrainInfo(callId: string, def: ToolDefinition, args: Record<string,any>, session: BookingSession) {
    const explicit = args.trainNumber !== undefined && args.trainNumber !== null && args.trainNumber !== '';
    const trainNumber = this.focusTrain(args, session);
    if (!trainNumber) return explicit
      ? { ok:false as const, error:{ code:'INVALID_TOOL_CALL' as const, message:'Train number चाहिए (4-5 अंक)।' } }
      : { ok:false as const, error:{ code:'MISSING_REQUIRED_FIELD' as const, message:'Train number nahi mila.', details: { missingField: 'TRAIN' } } };
    const date = args.date ? this.resolveDateStr(args.date) : undefined;
    if (args.date && !date) return { ok:false as const, error:{ code:'AMBIGUOUS_DATE' as const, message:'तारीख समझ नहीं आयी।' } };
    return { ok:true as const, v: { name: def.name, callId, arguments: { trainNumber, ...(date ? { date } : {}) }, tool: def } };
  }

  private validateTimetable(callId: string, def: ToolDefinition, args: Record<string,any>, _session: BookingSession) {
    const trainNumber = this.focusTrain(args, _session);
    if (!trainNumber) return { ok:false as const, error:{ code:'MISSING_REQUIRED_FIELD' as const, message:'Timetable ke liye train number nahi mila.', details: { missingField: 'TRAIN' } } };
    return { ok:true as const, v: { name: def.name, callId, arguments: { trainNumber }, tool: def } };
  }

  /**
   * Availability/fare are only for the AUTHORITATIVE selection. Arguments that
   * disagree with the selected train/class are rejected (so a result for a
   * different train can never be synced into the session as if it were ours).
   */
  private selectionCheck(args: Record<string, any>, session: BookingSession):
    { ok: true; trainNumber: string; travelClass: string } | { ok: false; error: OrchestratorError } {
    const sel: any = session.selectedTrain;
    const selNum = String(sel.number || sel.trainNumber);
    if (args.trainNumber !== undefined && args.trainNumber !== null && args.trainNumber !== '') {
      const n = this.validateTrainNumber(args.trainNumber, session);
      if (!n) return { ok: false, error: { code: 'INVALID_TOOL_CALL', message: 'Train number चाहिए।' } };
      if (n !== selNum) return { ok: false, error: { code: 'INVALID_TRAIN_REFERENCE', message: `Selected train ${selNum} hai, ${n} nahi. Pehle ${n} select karein.` } };
    }
    const travelClass = String(args.travelClass || session.selectedClass).toUpperCase();
    if (args.travelClass && travelClass !== String(session.selectedClass).toUpperCase()) {
      return { ok: false, error: { code: 'INVALID_CLASS_SELECTION', message: `Selected class ${session.selectedClass} hai. Pehle ${travelClass} select karein.` } };
    }
    const codes: string[] = (sel.availableClasses && sel.availableClasses.length) ? sel.availableClasses : (sel.classes || []).map((c: any) => c.code);
    if (!codes.includes(travelClass)) return { ok: false, error: { code: 'INVALID_CLASS_SELECTION', message: `"${travelClass}" इस ट्रेन में उपलब्ध नहीं है।` } };
    return { ok: true, trainNumber: selNum, travelClass };
  }

  private resolveSelectedTrain(session: BookingSession): any | null {
    return session.selectedTrain || null;
  }

  private validateAvailability(callId: string, def: ToolDefinition, args: Record<string,any>, session: BookingSession) {
    // State guard
    if (!session.selectedTrain || !session.selectedClass) {
      return { ok:false as const, error:{ code:'INVALID_ACTION_FOR_STATE' as const, message:'पहले train और class select होनी चाहिए।' } };
    }
    const sel = this.selectionCheck(args, session);
    if (!sel.ok) return sel;
    const { trainNumber, travelClass } = sel;
    const date = this.resolveDateStr(args.date || session.date);
    if (!date) return { ok:false as const, error:{ code:'AMBIGUOUS_DATE' as const, message:'तारीख चाहिए।' } };
    return { ok:true as const, v: { name: def.name, callId, arguments: { trainNumber, travelClass, date }, tool: def } };
  }

  private validateFare(callId: string, def: ToolDefinition, args: Record<string,any>, session: BookingSession) {
    if (!session.selectedTrain || !session.selectedClass) {
      return { ok:false as const, error:{ code:'INVALID_ACTION_FOR_STATE' as const, message:'पहले train और class select होनी चाहिए।' } };
    }
    const sel = this.selectionCheck(args, session);
    if (!sel.ok) return sel;
    const { trainNumber, travelClass } = sel;
    const passengersCount = typeof args.passengersCount === 'number' ? args.passengersCount : (session.passengersCount || 1);
    if (!(passengersCount >= 1 && passengersCount <= 6)) return { ok:false as const, error:{ code:'INVALID_TOOL_CALL' as const, message:'Passengers 1-6 के बीच होने चाहिए।' } };
    const date = args.date ? this.resolveDateStr(args.date) : undefined;
    if (args.date && !date) return { ok:false as const, error:{ code:'AMBIGUOUS_DATE' as const, message:'तारीख समझ नहीं आयी।' } };
    const a: any = { trainNumber, travelClass, passengersCount };
    if (date) a.date = date;
    return { ok:true as const, v: { name: def.name, callId, arguments: a, tool: def } };
  }
}
