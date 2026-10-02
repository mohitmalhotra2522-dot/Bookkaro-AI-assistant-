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
import { BookingState } from '@shared/states';
import { REGISTERED_TOOLS, getToolDefinition, type ToolCall, type ToolDefinition, type RegisteredToolName, type ToolParam } from './tool-registry';
import type { OrchestratorError } from '../decisions/agent-decision';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationToken } from '../../railway/resolvers/route-resolver';

export interface ValidatedToolCall {
  name: RegisteredToolName;
  callId: string;
  arguments: Record<string, any>; // canonicalized (codes, YYYY-MM-DD, numbers)
  tool: ToolDefinition;
}

/**
 * Tools that are intentionally NOT exposed to the LLM — the runtime will return
 * a clean TOOL_UNAVAILABLE response rather than executing them, because no
 * authoritative provider implementation exists yet (mock returns fake/stub data).
 */
const UNAVAILABLE_TOOLS: ReadonlySet<RegisteredToolName> = new Set<RegisteredToolName>(['TRACK_TRAIN', 'CHECK_PNR']);

export class ToolCallValidator {

  validate(call: ToolCall, session: BookingSession): { ok: true; v: ValidatedToolCall } | { ok: false; error: OrchestratorError } {
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
      case 'TRACK_TRAIN':
      case 'CHECK_PNR':
        return { ok: false, error: { code: 'TOOL_UNAVAILABLE', message: `"${def.name}" अभी उपलब्ध नहीं है।` } };
      default:
        return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `"${def.name}" tool मौजूद नहीं है।` } };
    }
  }

  private resolveStation(raw: string): { code: string; name: string } | null {
    if (!raw) return null;
    if (/^[A-Z]{2,4}$/.test(raw)) return { code: raw, name: raw };
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
      : { ok:false as const, error:{ code:'MISSING_REQUIRED_FIELD' as const, message:'Kaunsi train ki jaankari chahiye? Train number batayein.' } };
    const date = args.date ? this.resolveDateStr(args.date) : undefined;
    if (args.date && !date) return { ok:false as const, error:{ code:'AMBIGUOUS_DATE' as const, message:'तारीख समझ नहीं आयी।' } };
    return { ok:true as const, v: { name: def.name, callId, arguments: { trainNumber, ...(date ? { date } : {}) }, tool: def } };
  }

  private validateTimetable(callId: string, def: ToolDefinition, args: Record<string,any>, _session: BookingSession) {
    const trainNumber = this.focusTrain(args, _session);
    if (!trainNumber) return { ok:false as const, error:{ code:'MISSING_REQUIRED_FIELD' as const, message:'Kis train ka timetable chahiye? Train number batayein.' } };
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
