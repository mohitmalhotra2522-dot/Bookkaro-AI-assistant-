import type { AIProvider } from '../providers/ai-provider';
import { ConversationStateManager } from '../state/conversation-state';
import { RailwayToolService } from '../../railway/tools/railway-tool-service';
import { BookingState } from '@shared/states';
import { Intent } from '@shared/intents';
import {
  validateIntent,
  containsSensitiveRequest,
  redactSensitiveData
} from '../../security/validators/intent-validator';
import { canExecuteTool } from '../../security/validators/tool-guard';
import type { BookingSession, ChatMessage, TurnLog } from '@shared/entities';
import { uuid } from './utils';
import { IrctcHandoffAdapter } from '../../irctc/handoff/irctc-handoff-adapter';
import { RailwaySearchOrchestrator } from '../../railway/orchestrator/search-orchestrator';
import { toolLogger } from '../../observability/tool-logger';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveRoute } from '../../railway/resolvers/route-resolver';
import { railwayRegistry } from '../../railway/registry/provider-registry';

export interface OrchestratorResult {
  responseMessage: string;
  newState: BookingState;
  context: BookingSession;
  cards?: Array<{ type: string; data: any }>;
  toolActivity?: string;
  turnLog: TurnLog;
}

export class AIOrchestrator {
  private history: Map<string, ChatMessage[]> = new Map();
  private search: RailwaySearchOrchestrator;
  private irctc = new IrctcHandoffAdapter();

  constructor(
    private readonly aiProvider: AIProvider,
    private readonly stateManager: ConversationStateManager,
    private readonly railwayTools: RailwayToolService
  ) {
    this.search = new RailwaySearchOrchestrator(
      () => this.currentSession,
      (patch) => this.applySessionPatch(patch)
    );
  }

  private _currentSessionId: string = '';
  private get currentSession(): BookingSession {
    return this.stateManager.getSession(this._currentSessionId);
  }
  private applySessionPatch(patch: Partial<BookingSession>) {
    const s = this.stateManager.getSession(this._currentSessionId);
    Object.assign(s, patch);
  }

  async processTurn(
    sessionId: string,
    userText: string,
    mode: 'TEXT' | 'VOICE' = 'TEXT'
  ): Promise<OrchestratorResult> {
    this._currentSessionId = sessionId;
    const startTs = Date.now();
    const ctx0 = this.stateManager.getSession(sessionId);
    const stateBefore = ctx0.bookingState;
    this.stateManager.setMode(sessionId, mode);

    const cards: Array<{ type: string; data: any }> = [];
    let toolActivity: string | undefined;
    let toolCalled: string | undefined;
    let toolResultStatus: 'ok' | 'error' | 'none' = 'none';
    let detectedChanges: string[] = [];

    this.addHistory(sessionId, {
      id: uuid(), role: 'user', content: userText, timestamp: Date.now(), inputMode: mode
    });

    const aiInput = {
      userText,
      conversationHistory: this.serializedHistory(sessionId),
      currentState: stateBefore,
      context: this.stateManager.getSession(sessionId),
      missingFields: this.stateManager.getMissingJourneyFields(sessionId)
    };

    const aiResp = await this.aiProvider.generateStructuredAction(aiInput);
    let responseMessage = aiResp.message;

    if (!validateIntent(aiResp.action.type)) {
      responseMessage = 'Invalid action. Please try again.';
    } else if (containsSensitiveRequest(aiResp.message) || containsSensitiveRequest(userText)) {
      responseMessage = 'मैं कभी भी password / OTP / कार्ड / कैप्चा नहीं माँगती।';
    } else {
      // Tool execution guard
      const guard = canExecuteTool(aiResp.action.type, this.stateManager.getSession(sessionId));
      if (!guard.allowed) {
        responseMessage = guard.message || 'यह action अभी allow नहीं है।';
      } else {
        const action = aiResp.action;
        try {
          switch (action.type) {
            case Intent.PROVIDE_FIELD: {
              const updates: any = {};
              const payload = action.payload || {};
              if (payload.updates) Object.assign(updates, payload.updates);
              if (payload.field) {
                updates[payload.field] = payload.value;
              }

              // Deterministic date/route resolution for raw updates
              if (updates.date && typeof updates.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(updates.date)) {
                const dr = resolveDate(updates.date);
                if (dr.ok) updates.date = dr.date;
                else { responseMessage = dr.message; break; }
              }
              if (updates.date === undefined) {
                const dr = resolveDate(userText);
                if (dr.ok) updates.date = dr.date;
              }

              // Always attempt route resolution on natural text
              const rr = resolveRoute(userText, {
                origin: updates.origin ?? this.currentSession.origin,
                destination: updates.destination ?? this.currentSession.destination
              });
              if (rr.ok && rr.origin && rr.destination) {
                updates.origin = rr.origin.code;
                updates.originName = rr.origin.name;
                updates.destination = rr.destination.code;
                updates.destinationName = rr.destination.name;
              }

              const changes = this.stateManager.updateJourney(sessionId, updates);
              detectedChanges = changes;

              // Move out of IDLE once any journey info arrives
              const cur = this.stateManager.getSession(sessionId);
              if (cur.bookingState === BookingState.IDLE) {
                this.stateManager.transitionState(sessionId, BookingState.COLLECTING_JOURNEY);
              }

              // Try to execute search if ready
              const searchRes = await this.search.trySearch(userText, updates);
              if (searchRes.meta) {
                toolLogger.record({
                  sessionId, turnId: uuid(), toolName: 'SEARCH_TRAINS', provider: searchRes.meta.providerId,
                  requestTimestamp: searchRes.meta.requestTimestamp,
                  responseTimestamp: searchRes.meta.responseTimestamp,
                  latencyMs: searchRes.meta.latencyMs,
                  success: searchRes.ok, errorCode: searchRes.error?.code, cache: 'disabled'
                });
              }
                if (searchRes.ok && searchRes.data) {
                  toolCalled = 'SEARCH_TRAINS';
                  toolActivity = 'ट्रेनें खोजी जा रही हैं...';
                  toolResultStatus = 'ok';
                  cards.push({ type: 'trains', data: { trains: searchRes.data.trains, source: searchRes.meta?.source || 'mock' } });
                  responseMessage = `${searchRes.data.totalCount} trains mili hain. कौनसी ट्रेन लेनी है? (बोलिए या कार्ड टैप कीजिए)`;
                  if (this.railwayTools.isMock) responseMessage += ' (यह मॉक डेव डेटा है)';
              } else if (searchRes.nextQuestion) {
                // Transition to appropriate collecting state
                this.stateManager.transitionState(sessionId, searchRes.targetState);
                responseMessage = searchRes.nextQuestion;
              }
              break;
            }

            case Intent.SEARCH_TRAINS: {
              // Apply any updates the AI attached (e.g. passengerCount just provided)
              const payloadUpdates = action.payload?.updates || {};
              if (Object.keys(payloadUpdates).length > 0) {
                this.stateManager.updateJourney(sessionId, payloadUpdates);
                detectedChanges.push(...Object.keys(payloadUpdates));
              }
              const searchRes = await this.search.trySearch(userText, payloadUpdates);
              if (searchRes.meta) {
                toolLogger.record({
                  sessionId, turnId: uuid(), toolName: 'SEARCH_TRAINS', provider: searchRes.meta.providerId,
                  requestTimestamp: searchRes.meta.requestTimestamp,
                  responseTimestamp: searchRes.meta.responseTimestamp,
                  latencyMs: searchRes.meta.latencyMs,
                  success: searchRes.ok, errorCode: searchRes.error?.code, cache: 'disabled'
                });
              }
              toolCalled = 'SEARCH_TRAINS';
              if (searchRes.ok && searchRes.data) {
                cards.push({ type: 'trains', data: { trains: searchRes.data.trains, source: 'MOCK' } });
                responseMessage = `${searchRes.data.totalCount} trains mili hain. कौनसी लेनी है?`;
              } else {
                responseMessage = searchRes.nextQuestion || searchRes.error?.message || 'ट्रेन खोज नहीं हो सकी।';
              }
              break;
            }

            case Intent.SELECT_TRAIN: {
              let trainNumber = action.payload?.trainNumber;
              if (!trainNumber) {
                const m = userText.match(/(\d{4,5})/);
                if (m) trainNumber = m[1];
              }
              const sel = this.search.selectTrain(trainNumber);
              if (!sel.ok || !sel.train) {
                responseMessage = sel.error?.message || 'यह ट्रेन list में नहीं है।';
                break;
              }
              this.stateManager.setSelectedTrain(sessionId, sel.train as any);
              this.stateManager.transitionState(sessionId, BookingState.TRAIN_SELECTED);
              this.stateManager.transitionState(sessionId, BookingState.CLASS_OPTIONS);
              const codeList = (sel.classes || []).map((c: any) => c.code).join(', ');
              responseMessage = `${sel.train.trainNumber} select hui. Isme ${codeList} available हैं। कौनसी class चाहिए? (जैसे CC)`;
              toolResultStatus = 'ok';
              break;
            }

            case Intent.SELECT_CLASS: {
              let code = action.payload?.classCode;
              if (!code) {
                const upper = userText.toUpperCase().trim();
                const codes = this.currentSession.selectedTrain?.classes?.map((c: any) => c.code) || [];
                code = codes.find((c: string) => upper === c || upper.includes(c));
              }
              const cs = this.search.selectClass(code);
              if (!cs.ok || !cs.class) {
                responseMessage = cs.error?.message || 'यह class उपलब्ध नहीं।';
                break;
              }
              this.stateManager.setSelectedClass(sessionId, cs.class.code);
              this.stateManager.transitionState(sessionId, BookingState.CLASS_SELECTED);
              toolCalled = 'GET_FARE';
              const fareRes = await this.railwayTools.GET_FARE({
                trainNumber: this.currentSession.selectedTrain!.trainNumber || this.currentSession.selectedTrain!.number,
                travelClass: cs.class.code,
                passengersCount: this.currentSession.passengersCount || 1
              });
              toolResultStatus = fareRes.ok ? 'ok' : 'error';
              if (fareRes.ok && fareRes.data) {
                this.stateManager.setFare(sessionId, fareRes.data as any);
              }
              this.stateManager.initPassengers(sessionId);
              this.stateManager.transitionState(sessionId, BookingState.BOOKING_PREPARE);
              this.stateManager.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
              responseMessage = `${cs.class.code} class select hui. Passenger 1 ka naam kya hai?`;
              break;
            }

            case Intent.ADD_PASSENGER: {
              const { begin, index, field, value, nextPassenger, complete } = action.payload || {};
              if (begin) {
                this.stateManager.initPassengers(sessionId);
                this.stateManager.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
                responseMessage = 'Passenger 1 ka naam kya hai?';
                break;
              }
              if (typeof index === 'number' && field) {
                this.stateManager.updatePassenger(sessionId, index, { [field]: value });
                detectedChanges.push(`passenger[${index}].${field}`);
              }
              if (nextPassenger) this.stateManager.advanceToNextPassenger(sessionId);
              if (complete) {
                if (this.stateManager.areAllPassengersComplete(sessionId)) {
                  this.stateManager.transitionState(sessionId, BookingState.PASSENGERS_READY);
                  this.stateManager.transitionState(sessionId, BookingState.REVIEW);
                  const s = this.stateManager.getSession(sessionId);
                  cards.push({ type: 'passengers', data: { passengers: s.passengers } });
                  cards.push({ type: 'review', data: this.buildReviewData(s) });
                  responseMessage = 'Booking summary ready hai. Sab details theek hain? Change karna hai ya continue karun?';
                }
              } else {
                this.stateManager.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
              }
              break;
            }

            case Intent.UPDATE_PASSENGER: {
              const { index, field } = action.payload || {};
              this.stateManager.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
              detectedChanges.push(`update passenger[${index}].${field}`);
              break;
            }

            case Intent.CHANGE_BOOKING_DETAIL: {
              const { target } = action.payload || {};
              const s = this.stateManager.getSession(sessionId);
              if (target === 'date') {
                this.stateManager.updateJourney(sessionId, { date: undefined });
                this.stateManager.transitionState(sessionId, BookingState.COLLECTING_DATE);
                responseMessage = 'Nayi date batayein?';
              } else if (target === 'train' || target === undefined) {
                const res = await this.search.trySearch(userText, {});
                if (res.ok && res.data) {
                  cards.push({ type: 'trains', data: { trains: res.data.trains, source: 'MOCK' } });
                  responseMessage = `${res.data.totalCount} trains mili hain, कौनसी चाहिए?`;
                } else responseMessage = res.nextQuestion || 'ट्रेनें फिर से खोज रहे हैं...';
              } else if (target === 'class') {
                this.stateManager.transitionState(sessionId, BookingState.TRAIN_SELECTED);
                this.stateManager.transitionState(sessionId, BookingState.CLASS_OPTIONS);
                responseMessage = 'कौनसी class चाहिए?';
              } else if (target === 'passenger') {
                this.stateManager.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
                responseMessage = 'Passenger detail बदलने के लिए field बताइए।';
              }
              break;
            }

            case Intent.CONFIRM_BOOKING: {
              const { step } = action.payload || {};
              const cur = this.stateManager.getSession(sessionId).bookingState;
              if (step === 'first' && cur === BookingState.REVIEW) {
                this.stateManager.transitionState(sessionId, BookingState.AWAITING_CONFIRMATION);
                responseMessage = 'पक्का confirm karne ke liye haan bolिए।';
              } else if ((step === 'final' || cur === BookingState.AWAITING_CONFIRMATION)) {
                this.stateManager.markReviewConfirmed(sessionId);
                this.stateManager.transitionState(sessionId, BookingState.IRCTC_HANDOFF_READY);
                this.stateManager.markHandoffReady(sessionId);
                const s = this.stateManager.getSession(sessionId);
                const hr = this.irctc.prepareHandoff(s);
                responseMessage = 'Booking details तैयार हैं। IRCTC integration भविष्य में connect होगा।';
                cards.push({ type: 'handoff', data: { status: hr.status, message: hr.message } });
              }
              break;
            }

            case Intent.REVIEW_BOOKING: {
              this.stateManager.transitionState(sessionId, BookingState.PASSENGERS_READY);
              this.stateManager.transitionState(sessionId, BookingState.REVIEW);
              const s = this.stateManager.getSession(sessionId);
              cards.push({ type: 'review', data: this.buildReviewData(s) });
              responseMessage = 'Booking summary ready hai. Sab theek hai?';
              break;
            }
          }
        } catch (e: any) {
          responseMessage = `कुछ गलत हुआ: ${e.message}`;
        }
      }
    }

    // Handle class selection via plain text while in CLASS_OPTIONS (defensive)
    const after = this.stateManager.getSession(sessionId);
    if (after.bookingState === BookingState.CLASS_OPTIONS && after.selectedTrain) {
      const upper = userText.toUpperCase().trim();
      const codes = after.selectedTrain.classes?.map((c: any) => c.code) || after.selectedTrain.availableClasses || [];
      const match = codes.find((c: string) => c === upper || upper.includes(c));
      if (match) {
        const cs = this.search.selectClass(match);
        if (cs.ok && cs.class) {
          this.stateManager.setSelectedClass(sessionId, cs.class.code);
          this.stateManager.transitionState(sessionId, BookingState.CLASS_SELECTED);
          const fareRes = await this.railwayTools.GET_FARE({
            trainNumber: after.selectedTrain.trainNumber || after.selectedTrain.number,
            travelClass: cs.class.code, passengersCount: after.passengersCount || 1
          });
          if (fareRes.ok && fareRes.data) this.stateManager.setFare(sessionId, fareRes.data as any);
          this.stateManager.initPassengers(sessionId);
          this.stateManager.transitionState(sessionId, BookingState.BOOKING_PREPARE);
          this.stateManager.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
          responseMessage = `${cs.class.code} class select hui. Passenger 1 ka naam kya hai?`;
        }
      }
    }

    const safeMsg = redactSensitiveData(responseMessage);
    this.addHistory(sessionId, {
      id: uuid(), role: 'assistant', content: safeMsg, timestamp: Date.now()
    });

    const finalCtx = this.stateManager.getSession(sessionId);
    const latency = Date.now() - startTs;
    const turnLog: TurnLog = {
      turnId: uuid(), sessionId, timestamp: new Date().toISOString(),
      stateBefore, userInput: redactSensitiveData(userText), inputMode: mode,
      detectedChanges, toolCalled, toolResultStatus,
      stateAfter: finalCtx.bookingState, latencyMs: latency
    };

    return {
      responseMessage: safeMsg,
      newState: finalCtx.bookingState,
      context: finalCtx,
      cards,
      toolActivity,
      turnLog
    };
  }

  private buildReviewData(s: BookingSession) {
    return {
      journey: { origin: s.origin, originName: s.originName, destination: s.destination, destinationName: s.destinationName, date: s.date, passengerCount: s.passengersCount, preferredClass: s.preferredClass, preferredTime: s.preferredTime },
      train: s.selectedTrain, selectedClass: s.selectedClass, passengers: s.passengers, fare: s.fare
    };
  }

  private addHistory(sessionId: string, msg: ChatMessage) {
    const h = this.history.get(sessionId) || [];
    h.push(msg);
    if (h.length > 50) h.splice(0, h.length - 50);
    this.history.set(sessionId, h);
  }

  private serializedHistory(sessionId: string) {
    return (this.history.get(sessionId) || []).map(m => ({ role: m.role, content: m.content }));
  }
}
