import { parseReconciliationConfig } from './booking/lifecycle/reconciliation-config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { MockLLMProvider } from './ai/providers/mock-llm';
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

// Initialize layers — LLM provider is pluggable (default: deterministic MockLLMProvider)
const llmProvider = new MockLLMProvider();
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
  const { text, mode, expectedSessionVersion, searchResultsVersion, reviewVersion } = body || {};
  let { sessionId } = body || {};
  if (!text || typeof text !== 'string') return reply.status(400).send({ error: 'text required' });
  if (text.length > 2000) return reply.status(413).send({ error: 'text too long' });
  if (!sessionId || typeof sessionId !== 'string' || !stateManager.hasSession(sessionId)) {
    sessionId = stateManager.createSession().sessionId;
  }
  const result = await orchestrator.processTurn(sessionId, text, mode === 'VOICE' ? 'VOICE' : 'TEXT', {
    expectedSessionVersion: typeof expectedSessionVersion === 'number' ? expectedSessionVersion : undefined,
    searchResultsVersion: typeof searchResultsVersion === 'number' ? searchResultsVersion : undefined,
    reviewVersion: typeof reviewVersion === 'number' ? reviewVersion : undefined
  });
  const ctx = result.context;
  if (result.error?.code === 'SESSION_VERSION_CONFLICT') reply.status(409);
  return reply.send({
    sessionId,
    message: result.responseMessage,
    stale: !!result.stale,
    state: result.newState,
    pendingInteraction: result.pendingInteraction,
    pendingQuestion: questionFor(result.pendingInteraction, ctx, ctx.mode),
    sessionVersion: ctx.sessionVersion,
    searchResultsVersion: ctx.searchResultsVersion,
    reviewVersion: ctx.review?.valid ? ctx.review.reviewVersion : null,
    confirmedReviewVersion: ctx.confirmedReviewVersion ?? null,
    readiness: ctx.readiness ?? null,
    executionCapability: executionCapability(),
    handoff: ctx.handoff ? { handoffId: ctx.handoff.snapshot.handoffId, status: ctx.handoff.status, statusReason: ctx.handoff.statusReason ?? null, reviewVersion: ctx.handoff.snapshot.reviewVersion, expiresAt: ctx.handoff.snapshot.expiresAt } : null,
    bookingLifecycle: ctx.bookingLifecycle?.status ?? null,
    execution: ctx.execution ?? null,
    handoffSession: handoffSessionView(ctx.handoffSession),
    confirmation: confirmationView(ctx.confirmation),
    executorCapability: executorCapability(),
    bookingProvider: bookingProviderView(),
    bookingExecution: bookingExecutionView(ctx.bookingExecution) ?? null,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    events: result.events,
    cards: result.cards || [],
    context: { ...ctx, eventLog: (ctx.eventLog || []).slice(-15) },
    toolActivity: result.toolActivity,
    dataSourceLabel: railwayRegistry.getActive().label,
    turnLog: result.turnLog
  });
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
    ? `${HANDOFF_READY_MESSAGE} Booking execution disabled hai — kuch book nahi hua.`
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
  return reply.send({ sessionId: id, history: orchestrator.preparation.bookingHistory(id) });
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

server.get('/api/health', async (_, reply) => {
  return reply.send({
    ok: true,
    provider: railwayRegistry.getActiveId(),
    providerLabel: railwayRegistry.getActive().label,
    orchestrator: 'ConversationAgentOrchestrator.v6 (Prompt 12 booking provider boundary)',
    executionCapability: executionCapability(),
    executorCapability: executorCapability(),
    // static capability only — no live health check, never reported "healthy" without one
    bookingProvider: bookingProviderView()
  });
});

const PORT = 3000;
await server.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Railway AI Assistant server running on http://localhost:${PORT}`);
console.log(`Active railway provider: ${railwayRegistry.getActiveId()} (${railwayRegistry.getActive().label})`);
console.log(`Active LLM provider: mock-llm (deterministic tool-calling agent)`);
console.log(`Booking provider: ${bookingProviderView().effective} (available=${bookingProviderView().capabilities.available}, health=${bookingProviderView().capabilities.health})`);
console.log(`Booking execution: ${executionCapability().effectiveExecutor} (${executionCapability().reason}) — real booking is NOT possible in this build`);
