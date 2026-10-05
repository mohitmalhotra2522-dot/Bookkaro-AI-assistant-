// Prompt 23: local .env (gitignored) → process.env, never overriding real env vars. Must stay the first import.
import './config/load-dotenv';
import { bookingPreparationSummary } from './booking/preparation/booking-preparation';
import { preparationErrorTypeOf } from '@shared/booking-preparation';
import { parseReconciliationConfig } from './booking/lifecycle/reconciliation-config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createLLMProvider } from './ai/providers/llm-provider-factory';
import { ConversationStateManager } from './ai/state/conversation-state';
import { RailwayToolService } from './railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from './ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from './railway/registry/provider-registry';
import { questionFor } from './ai/context/pending-interaction';
import { parseExecutionConfig } from './booking/execution/execution-config';
import { createProductionExecutorRegistry } from './booking/execution/booking-executor-registry';
import { createProductionAdapterRegistry } from './booking/handoff/booking-executor-adapter-registry';
import { checkNoSensitiveData } from './booking/handoff/sensitive-data-guard';
import { HANDOFF_READY_MESSAGE } from './booking/booking-preparation-service';
import { randomUUID } from 'crypto';
import { parseBookingProviderConfig } from './booking/provider/booking-provider-config';
import { createProductionBookingProviderRegistry } from './booking/provider/booking-provider-registry';
import { bookingExecutionView } from './booking/provider/booking-provider-execution-service';
import { ConversationTurnEngine } from './ai/turn-engine/conversation-turn-engine';
import { sanitizeTranscriptInfo, VoiceTranscriptRejectedError } from '@shared/voice/transcript';
import { liveProviderStatus } from './railway/providers/live/live-config';
import { webResearchStatus } from './research/web-research-service';
import { createServerSTT, createServerTTS, voiceProviderStatus } from './voice/live/openai-compatible-voice';
import { registerVoiceRoutes } from './voice/live/voice-routes';
import { createElevenLabsBatchSTT } from './voice/stt/elevenlabs-batch-stt';
import { applyForm, buildFormSpec, fetchTrainFacilities, formNotReady, validateForm } from './booking/passenger-form';

// Initialize layers — LLM provider is pluggable (default: deterministic MockLLMProvider).
// Prompt 21: LLM_PROVIDER=openai-compatible + LLM_API_KEY + LLM_MODEL (server env only) enables a real LLM;
// incomplete config falls back to the mock. The key is never logged or sent to the client.
const llmSelection = createLLMProvider(process.env);
const llmProvider = llmSelection.provider;
const stateManager = new ConversationStateManager();
const railwayTools = new RailwayToolService();
// Booking execution boundary (Prompt 10): server-side env only, parsed FAIL-CLOSED.
// REAL_BOOKING_ENABLED defaults to false; the production registry contains ONLY
// the DisabledBookingExecutor — no real booking can be executed by this server.
const executionConfig = parseExecutionConfig(process.env);
const orchestrator = new ConversationAgentOrchestrator(llmProvider, stateManager, railwayTools, {
  executionConfig, executorRegistry: createProductionExecutorRegistry(),
  // Prompt 11: executor ADAPTER registry — production contains ONLY DisabledBookingExecutorAdapter.
  adapterRegistry: createProductionAdapterRegistry(),
  // Prompt 12: booking PROVIDER registry — production contains ONLY DisabledBookingProvider.
  // BOOKING_PROVIDER defaults to "disabled"; unknown names fail closed (no fallback).
  bookingProviderRegistry: createProductionBookingProviderRegistry(),
  bookingProviderConfig: parseBookingProviderConfig(process.env),
  bookingReconciliation: { config: parseReconciliationConfig(process.env) }
});
// Prompt 18: ConversationTurnEngine — one logical turn per message, lifecycle, ordered events, interruption.
const turnEngine = new ConversationTurnEngine(orchestrator, stateManager);
const executionCapability = () => orchestrator.gateway.capability();
const executorCapability = () => orchestrator.preparation.handoffSessions.capability();
/** Client view of the handoff session — status + frozen capability only (snapshot stays server-side). */
const handoffSessionView = (hs: any) => hs ? {
  handoffSessionId: hs.handoffSessionId, bookingHandoffId: hs.bookingHandoffId, status: hs.status, statusReason: hs.statusReason ?? null,
  reviewVersion: hs.reviewVersion, sessionVersion: hs.sessionVersion, createdAt: hs.createdAt, expiresAt: hs.expiresAt,
  executorCapability: hs.executorCapability, executionAttempts: hs.executionAttempts, lastConsumeResult: hs.lastConsumeResult ?? null
} : null;
/** Safe provider status for clients: name + honest capabilities only (no baseUrl / config internals). */
const bookingProviderView = () => {
  const p = orchestrator.gateway.bookingProviders.providerStatus();
  return { configured: p.configured, effective: p.effective, enabled: p.enabled, resolved: p.resolved, code: p.code ?? null, capabilities: p.capabilities };
};
const confirmationView = (c: any) => c ? { status: c.status, reviewVersion: c.reviewVersion, sessionVersion: c.sessionVersion, confirmedAt: c.confirmedAt, statusReason: c.statusReason ?? null } : null;

const server = Fastify({ logger: false });
await server.register(cors, { origin: true });

/**
 * Single conversational endpoint for BOTH text and voice (voice = browser STT
 * transcript with mode=VOICE). Same orchestrator, session, tools, validation.
 */
server.post('/api/chat', async (request, reply) => {
  const body = request.body as any;
  const { text, mode, expectedSessionVersion, searchResultsVersion, reviewVersion, clientMessageId, bargeIn } = body || {};
  // Prompt 34 (§2): structured STT metadata (untrusted → sanitized; never free text); only meaningful for VOICE
  const transcript = mode === 'VOICE' ? sanitizeTranscriptInfo(body?.transcript) : undefined;
  if (mode === 'VOICE' && body?.transcript !== undefined && !transcript) return reply.status(400).send({ error: 'invalid transcript metadata' });
  let { sessionId } = body || {};
  if (!text || typeof text !== 'string') return reply.status(400).send({ error: 'text required' });
  if (text.length > 2000) return reply.status(413).send({ error: 'text too long' });
  if (!sessionId || typeof sessionId !== 'string' || !stateManager.hasSession(sessionId)) {
    sessionId = stateManager.createSession().sessionId;
  }
  // Prompt 18: TEXT and STT transcripts share the SAME turn engine → orchestrator → runtime pipeline
  // Prompt 34 (§3): an interim / empty transcript is refused BEFORE a turn exists (422 — no LLM, no tool, no state)
  let result;
  try { result = await turnEngine.processTurn(sessionId, text, mode === 'VOICE' ? 'VOICE' : 'TEXT', {
    interruptPrevious: bargeIn === true,
    ...(transcript ? { transcript } : {}),
    expectedSessionVersion: typeof expectedSessionVersion === 'number' ? expectedSessionVersion : undefined,
    searchResultsVersion: typeof searchResultsVersion === 'number' ? searchResultsVersion : undefined,
    reviewVersion: typeof reviewVersion === 'number' ? reviewVersion : undefined,
    // Prompt 17: duplicate delivery (retry / reconnect / double submit) replays the turn — never a cache of railway data
    clientMessageId: typeof clientMessageId === 'string' && /^[A-Za-z0-9_-]{6,100}$/.test(clientMessageId) ? clientMessageId : undefined
  }); } catch (e) {
    if (e instanceof VoiceTranscriptRejectedError) return reply.status(422).send({ sessionId, error: e.code, message: e.message });
    throw e;
  }
  const ctx = result.context;
  if (result.error?.code === 'SESSION_VERSION_CONFLICT') reply.status(409);
  return reply.send({
    sessionId,
    message: result.responseMessage,
    stale: !!result.stale,
    duplicateDelivery: !!result.duplicateDelivery,
    state: result.newState,
    pendingInteraction: result.pendingInteraction,
    pendingQuestion: questionFor(result.pendingInteraction, ctx, ctx.mode),
    sessionVersion: ctx.sessionVersion,
    searchResultsVersion: ctx.searchResultsVersion,
    reviewVersion: ctx.review?.valid ? ctx.review.reviewVersion : null,
    confirmedReviewVersion: ctx.confirmedReviewVersion ?? null,
    readiness: ctx.readiness ?? null,
    // Prompt 19: derived booking-preparation status (counts / statuses only)
    bookingPreparation: bookingPreparationSummary(ctx as any),
    executionCapability: executionCapability(),
    handoff: ctx.handoff ? { handoffId: ctx.handoff.snapshot.handoffId, status: ctx.handoff.status, statusReason: ctx.handoff.statusReason ?? null, reviewVersion: ctx.handoff.snapshot.reviewVersion, expiresAt: ctx.handoff.snapshot.expiresAt } : null,
    bookingLifecycle: ctx.bookingLifecycle?.status ?? null,
    execution: ctx.execution ?? null,
    handoffSession: handoffSessionView(ctx.handoffSession),
    confirmation: confirmationView(ctx.confirmation),
    executorCapability: executorCapability(),
    bookingProvider: bookingProviderView(),
    bookingExecution: bookingExecutionView(ctx.bookingExecution) ?? null,
    // Prompt 20 (Part 51): stable code + typed preparation error category
    error: result.error ? { code: result.error.code, message: result.error.message, type: preparationErrorTypeOf(result.error.code) } : null,
    // Prompt 16: structured response (validated facts only; speechText for TTS) + derived context (PNR masked)
    assistantResponse: result.assistantResponse,
    conversationContext: result.conversationContext,
    events: result.events,
    cards: result.cards || [],
    context: { ...ctx, eventLog: (ctx.eventLog || []).slice(-15) },
    toolActivity: result.toolActivity,
    dataSourceLabel: railwayRegistry.getActive().label,
    turnLog: result.turnLog,
    // Prompt 18: logical turn + typed response + honest progress; presentable=false → do not show / speak
    turn: { turnId: result.turn.turnId, sequence: result.turn.sequence, status: result.turn.status, presentation: result.turn.presentation },
    assistantTurnResponse: result.assistantTurnResponse,
    progress: result.progress,
    presentable: result.presentable,
    // Prompt 21 (Part 32): voice view of the same logical turn (shouldSpeak / interruptible / priority / segments)
    voice: result.voice,
    lastEventSeq: turnEngine.events.lastSeq(sessionId)
  });
});

/** Prompt 18: ordered turn events (polling; seq-ordered, safe data only) — progress for the minimal UI. */
server.get('/api/session/:id/turn-events', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  const after = Math.max(0, Number((request.query as any)?.after) || 0);
  return reply.send({ sessionId: id, events: turnEngine.events.since(id, after).slice(0, 200), lastSeq: turnEngine.events.lastSeq(id) });
});

/**
 * P38 — IRCTC-style passenger form (full-screen page). GET returns the class-specific berth choices and the provider's
 * catering info for the selected train (fetched fresh from the provider that produced the results); POST applies the
 * form as an explicit user edit after deterministic validation. Values are never logged.
 */
server.get('/api/session/:id/passenger-form', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  const s = stateManager.getSession(id);
  const nr = formNotReady(s);
  if (nr) return reply.status(nr.status).send({ code: nr.code, message: nr.message });
  const facilities = await fetchTrainFacilities(s);
  return reply.send(buildFormSpec(stateManager.getSession(id), facilities));
});

server.post('/api/session/:id/passenger-form', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  const body = (request.body || {}) as any;
  const s = stateManager.getSession(id);
  const nr = formNotReady(s);
  if (nr) return reply.status(nr.status).send({ code: nr.code, message: nr.message });
  if (body.expectedSessionVersion !== undefined && Number(body.expectedSessionVersion) !== s.sessionVersion) {
    return reply.status(409).send({ code: 'STALE_SESSION_VERSION', message: 'Booking beech mein badal gayi — form dobara khol kar details check kijiye.', sessionVersion: s.sessionVersion });
  }
  // catering is re-checked fresh from the provider on every submit (never trusted from the client)
  const facilities = await fetchTrainFacilities(s);
  const v = validateForm(body, stateManager.getSession(id), facilities);
  if (!v.ok) return reply.status(v.error.status).send({ code: v.error.code, message: v.error.message, fieldErrors: v.error.fieldErrors });
  if (stateManager.getSession(id).sessionVersion !== s.sessionVersion) {
    return reply.status(409).send({ code: 'STALE_SESSION_VERSION', message: 'Booking beech mein badal gayi — form dobara khol kar details check kijiye.', sessionVersion: stateManager.getSession(id).sessionVersion });
  }
  const r = applyForm(stateManager, id, v.passengers);
  request.log.info({ sessionId: id, passengers: r.passengersCount, changedFields: r.changedFields, countChanged: r.countChanged }, 'passenger form applied');
  const after = stateManager.getSession(id);
  return reply.send({ ok: true, sessionVersion: after.sessionVersion, passengersCount: r.passengersCount, changedFields: r.changedFields, invalidated: r.invalidated, bookingState: after.bookingState });
});

/** Prompt 18: barge-in / stop — marks the presentation or in-flight turn INTERRUPTED (no provider cancel, session untouched). */
server.post('/api/session/:id/interrupt', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  const reason = (request.body as any)?.reason === 'BARGE_IN' ? 'BARGE_IN' : 'USER_STOP';
  return reply.send({ sessionId: id, ...turnEngine.interrupt(id, reason) });
});

/** Prompt 18: reconnect (text or voice) — same session, current turn status, latest response; never re-runs actions. */
server.get('/api/session/:id/resume', async (request, reply) => {
  const { id } = request.params as any;
  const snap = turnEngine.resume(id);
  if (!snap) return reply.status(404).send({ error: 'unknown session' });
  return reply.send(snap);
});

/** Prompt 18: conversation history (logical turns; masked / redacted). */
server.get('/api/session/:id/conversation', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  return reply.send({ sessionId: id, turns: turnEngine.getTurns(id) });
});

/**
 * Explicit handoff consumption boundary (Prompt 11). NOT called by the conversation.
 * With the DisabledBookingExecutorAdapter this always returns BOOKING_EXECUTION_DISABLED
 * (or an earlier fail-closed rejection) — nothing is booked, no IRCTC call, no payment.
 * Credential-like fields in the body are rejected (never stored or logged).
 */
server.post('/api/handoff/consume', async (request, reply) => {
  const body = (request.body as any) || {};
  const sens = checkNoSensitiveData(body);
  if (!sens.ok) return reply.status(400).send({ code: 'SENSITIVE_DATA_REJECTED', message: 'Password, OTP, CAPTCHA, card/UPI/bank details ya tokens yahan accept nahi kiye jaate.' });
  const { sessionId, handoffSessionId } = body;
  if (!sessionId || typeof sessionId !== 'string' || !stateManager.hasSession(sessionId)) return reply.status(404).send({ code: 'HANDOFF_NOT_FOUND', message: 'Handoff session nahi mila.' });
  const cards: any[] = [];
  const r = await orchestrator.preparation.consumeHandoff(sessionId, String(handoffSessionId || ''), { turnId: `consume-${randomUUID()}`, mode: 'TEXT', cards, events: [], changes: [], requestId: randomUUID() });
  const s = stateManager.getSession(sessionId);
  const message = r.code === 'BOOKING_EXECUTION_DISABLED'
    ? `${HANDOFF_READY_MESSAGE} Booking execution abhi enabled nahi hai — kuch book nahi hua.`
    : `Handoff execute nahi hua (${r.code}). Kuch book nahi hua.`;
  return reply.send({ code: r.code, message, duplicate: !!r.duplicate, executorAttempted: r.executorAttempted, executionStatus: r.executionStatus ?? null,
    handoffSession: handoffSessionView(s.handoffSession), executorCapability: executorCapability(), realBooking: false, cards });
});

/**
 * Explicit booking execution request (Prompt 12) — BookingExecutionGateway →
 * BookingProviderRegistry → provider. Same validation/lock/idempotency as the confirmation
 * turn; duplicates return the existing record. With the production registry (disabled
 * provider) nothing is sent: BOOKING_EXECUTION_DISABLED / BOOKING_PROVIDER_UNAVAILABLE.
 * Credential-like fields in the body are rejected. NOT an LLM tool.
 */
server.post('/api/booking/execute', async (request, reply) => {
  const body = (request.body as any) || {};
  const sens = checkNoSensitiveData(body);
  if (!sens.ok) return reply.status(400).send({ code: 'SENSITIVE_DATA_REJECTED', message: 'Password, OTP, CAPTCHA, card/UPI/bank details ya tokens yahan accept nahi kiye jaate.' });
  const { sessionId } = body;
  if (!sessionId || typeof sessionId !== 'string' || !stateManager.hasSession(sessionId)) return reply.status(404).send({ code: 'HANDOFF_NOT_FOUND', message: 'Session nahi mila.' });
  const cards: any[] = [];
  const events: string[] = [];
  const px = await orchestrator.preparation.executeBookingProvider(sessionId, { turnId: `execute-${randomUUID()}`, mode: 'TEXT', cards, events, changes: [], requestId: randomUUID() });
  const s = stateManager.getSession(sessionId);
  return reply.send({
    code: px.code, message: px.message, duplicate: px.duplicate, providerCalled: px.providerCalled, retryBlocked: px.retryBlocked,
    manualVerificationRequired: px.manualVerificationRequired, state: s.bookingState, sessionVersion: s.sessionVersion,
    bookingExecution: bookingExecutionView(s.bookingExecution) ?? null, bookingProvider: bookingProviderView(), events, cards
  });
});

/**
 * Prompt 13: explicit booking status verification — bounded provider status lookups only.
 * NEVER submits a booking. The only way out of MANUAL_VERIFICATION_REQUIRED.
 */
server.post('/api/booking/reconcile', async (request, reply) => {
  const body = (request.body as any) || {};
  const sens = checkNoSensitiveData(body);
  if (!sens.ok) return reply.status(400).send({ code: 'SENSITIVE_DATA_REJECTED', message: 'Password, OTP, CAPTCHA, card/UPI/bank details ya tokens yahan accept nahi kiye jaate.' });
  const { sessionId } = body;
  if (!sessionId || typeof sessionId !== 'string' || !stateManager.hasSession(sessionId)) return reply.status(404).send({ code: 'RECONCILIATION_UNAVAILABLE', message: 'Session nahi mila.' });
  const cards: any[] = [];
  const events: string[] = [];
  const px = await orchestrator.preparation.reconcileExecution(sessionId, { turnId: `reconcile-${randomUUID()}`, mode: 'TEXT', cards, events, changes: [], requestId: randomUUID() });
  const s = stateManager.getSession(sessionId);
  return reply.send({
    code: px.code, message: px.message, providerCalled: px.providerCalled, manualVerificationRequired: px.manualVerificationRequired,
    state: s.bookingState, sessionVersion: s.sessionVersion, bookingExecution: bookingExecutionView(s.bookingExecution) ?? null, events, cards
  });
});

/** Prompt 13: safe booking execution history (status, provider, reference, authoritative PNR, failure reason, reconciliation). */
server.get('/api/session/:id/booking-history', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  // Prompt 14: + normalized BookingDetailsResponse DTOs (masked PNR, no raw provider payloads, no credentials)
  return reply.send({ sessionId: id, history: orchestrator.preparation.bookingHistory(id), bookings: orchestrator.postBooking.listDetails(id) });
});

/** Prompt 14: one booking's details — session-scoped ownership (another session's booking → 403). */
server.get('/api/session/:id/bookings/:bookingId', async (request, reply) => {
  const { id, bookingId } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ code: 'BOOKING_NOT_FOUND', message: 'Session nahi mila.' });
  const r = orchestrator.postBooking.getBookingDetails(id, String(bookingId), { revealPnr: true });
  if (!r.ok) return reply.status(r.code === 'BOOKING_ACCESS_DENIED' ? 403 : r.code === 'BOOKING_HISTORY_UNAVAILABLE' ? 503 : 404).send({ code: r.code, message: r.message });
  return reply.send({ sessionId: id, booking: r.details });
});

/** Prompt 15: lifecycle actions (cancel / modify / refund checks) — read-only, session-scoped, no PNR / provider payloads.
 *  There is deliberately NO endpoint that executes a cancellation or modification: those run only through the
 *  conversation path (validator + explicit confirmation on a later turn). */
server.get('/api/session/:id/booking-actions', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ code: 'BOOKING_NOT_FOUND', message: 'Session nahi mila.' });
  return reply.send({ sessionId: id, actions: orchestrator.lifecycleActions.listActions(id), log: orchestrator.lifecycleActions.actionLog(id) });
});

/** Structured, redacted turn history (observability; no secrets are ever stored). */
server.get('/api/session/:id/turns', async (request, reply) => {
  const { id } = request.params as any;
  if (!stateManager.hasSession(id)) return reply.status(404).send({ error: 'unknown session' });
  return reply.send({ sessionId: id, turns: orchestrator.getTurnHistory(id) });
});

server.post('/api/session', async (_, reply) => {
  const s = stateManager.createSession();
  return reply.send({ sessionId: s.sessionId, activeProvider: railwayRegistry.getActiveId() });
});

// Prompt 35: optional server STT/TTS transport → the same /api/chat pipeline (no second voice brain)
// P36-C: ElevenLabs Scribe v2 batch STT (ELEVENLABS_API_KEY server env only; missing → browser speech fallback)
const batchStt = createElevenLabsBatchSTT(process.env);
registerVoiceRoutes(server, {
  stt: createServerSTT(), tts: createServerTTS(),
  batchStt, sessionExists: (sid) => stateManager.hasSession(sid),
  latestSpeech: (sid) => {
    const snap = turnEngine.resume(sid);
    const r: any = snap?.latestAssistantResponse;
    const text = r ? String(r.speechText || r.text || '').trim() : '';
    return text ? { text, turnId: r.turnId ?? null } : null;
  },
  log: (e) => server.log.info(e)
});

server.get('/api/health', async (_, reply) => {
  return reply.send({
    ok: true,
    provider: railwayRegistry.getActiveId(),
    providerLabel: railwayRegistry.getActive().label,
    // Prompt 32: MOCK = development data (never live); no silent MOCK↔REAL switching
    providerKind: railwayRegistry.getActiveKind(),
    orchestrator: 'ConversationTurnEngine + ConversationAgentOrchestrator (Prompt 18 conversation loop)',
    llm: llmSelection.info,
    executionCapability: executionCapability(),
    executorCapability: executorCapability(),
    // static capability only — no live health check, never reported "healthy" without one
    bookingProvider: bookingProviderView(),
    // Prompt 35: provider chain + per-provider configured flag (NEVER key values) and WEB_EXTERNAL gate
    railwayProviders: liveProviderStatus(),
    webResearch: webResearchStatus(),
    voice: voiceProviderStatus(process.env, batchStt)
  });
});

const PORT = 3000;
await server.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Railway AI Assistant server running on http://localhost:${PORT}`);
console.log(`Active railway provider: ${railwayRegistry.getActiveId()} (${railwayRegistry.getActive().label}) [${railwayRegistry.getActiveKind()}]`);
console.log(`Active LLM provider: ${llmSelection.info.providerId}${llmSelection.info.model ? ` (${llmSelection.info.model})` : ''} — ${llmSelection.info.reason}`);
console.log(`Booking provider: ${bookingProviderView().effective} (available=${bookingProviderView().capabilities.available}, health=${bookingProviderView().capabilities.health})`);
console.log(`Railway provider chain (RAILWAY_PROVIDER=live): ${liveProviderStatus().filter(p => p.priority).sort((a, b) => a.priority! - b.priority!).map(p => `${p.provider}${p.configured ? '' : '(no key)'}`).join(' → ')}`);
console.log(`Voice STT (batch): elevenlabs/${batchStt.model} — ${batchStt.configured() ? 'configured' : 'not configured (browser speech fallback)'}`);
console.log(`Booking execution: ${executionCapability().effectiveExecutor} (${executionCapability().reason}) — real booking is NOT possible in this build`);
