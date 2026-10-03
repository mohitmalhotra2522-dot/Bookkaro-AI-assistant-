/**
 * PROMPT 18 — TurnEventBus (Parts 23, 57, 58). Session-scoped, bounded, ordered event log with
 * monotonic sequence numbers. Consumers (SSE / polling UI / tests) read `since(seq)`; the pure
 * `reduceTurnEvent` reducer (shared) ignores duplicate / out-of-order delivery.
 * Event data is user-presentable only (tool name, status, progress text) — never arguments or secrets.
 */
import type { TurnEvent, TurnEventType } from '@shared/turn-engine';

const MAX_EVENTS_PER_SESSION = 500;
type Listener = (ev: TurnEvent) => void;

export class TurnEventBus {
  private logs = new Map<string, TurnEvent[]>();
  private seqs = new Map<string, number>();
  private listeners = new Map<string, Set<Listener>>();

  emit(sessionId: string, turnId: string, turnSequence: number, type: TurnEventType, data?: Record<string, any>): TurnEvent {
    const seq = (this.seqs.get(sessionId) || 0) + 1;
    this.seqs.set(sessionId, seq);
    const ev: TurnEvent = Object.freeze({ seq, sessionId, turnId, turnSequence, type, at: new Date().toISOString(), ...(data ? { data: Object.freeze({ ...data }) } : {}) });
    const log = this.logs.get(sessionId) || [];
    log.push(ev);
    if (log.length > MAX_EVENTS_PER_SESSION) log.splice(0, log.length - MAX_EVENTS_PER_SESSION);
    this.logs.set(sessionId, log);
    for (const l of this.listeners.get(sessionId) || []) { try { l(ev); } catch { /* a broken listener never breaks the turn */ } }
    return ev;
  }

  since(sessionId: string, afterSeq = 0): TurnEvent[] {
    return (this.logs.get(sessionId) || []).filter(e => e.seq > afterSeq);
  }

  forTurn(sessionId: string, turnId: string): TurnEvent[] {
    return (this.logs.get(sessionId) || []).filter(e => e.turnId === turnId);
  }

  lastSeq(sessionId: string): number { return this.seqs.get(sessionId) || 0; }

  subscribe(sessionId: string, l: Listener): () => void {
    const set = this.listeners.get(sessionId) || new Set<Listener>();
    set.add(l); this.listeners.set(sessionId, set);
    return () => { set.delete(l); };
  }
}
