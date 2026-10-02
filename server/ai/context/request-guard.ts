/**
 * RequestGuard — stale-result protection for in-flight tool executions.
 *
 * Every turn begins a new request (sessionId, turnId, requestId, requestVersion).
 * All session writes coming from tool results go through `commit()`. If a newer
 * turn has started since this request began, the write is REJECTED
 * (STALE_TOOL_RESULT) and the runtime stops the obsolete loop. This prevents:
 *
 *   Turn 10: SEARCH Amritsar→Delhi (slow) ...
 *   Turn 11: "Actually Ludhiana"  → fresh search commits LDH results
 *   Turn 10 returns late          → rejected; LDH state is NOT overwritten.
 *
 * bookingState changes inside a patch are validated by StateTransitionValidator.
 */
import type { BookingSession } from '@shared/entities';
import type { ConversationStateManager } from '../state/conversation-state';
import { stateTransitionValidator } from '../state/state-transition-validator';

export interface RequestContext {
  sessionId: string;
  turnId: string;
  requestId: string;
  requestVersion: number;
}

export class RequestGuard {
  stale = false;
  readonly rejectedPatches: string[][] = [];
  readonly rejectedTransitions: string[] = [];

  constructor(private readonly state: ConversationStateManager, readonly ctx: RequestContext) {}

  isStale(): boolean {
    if (!this.stale && !this.state.isCurrentRequest(this.ctx.sessionId, this.ctx.requestVersion)) {
      this.stale = true;
    }
    return this.stale;
  }

  getSession = (): BookingSession => this.state.getSession(this.ctx.sessionId);

  /** Guarded commit. Returns false (and records) if the request is stale. */
  commit = (patch: Partial<BookingSession>): boolean => {
    if (this.isStale()) {
      this.rejectedPatches.push(Object.keys(patch));
      this.state.emit(this.ctx.sessionId, 'STALE_RESULT_REJECTED', this.ctx.turnId, {
        requestId: this.ctx.requestId, requestVersion: this.ctx.requestVersion, fields: Object.keys(patch)
      });
      return false;
    }
    const s = this.getSession();
    const { bookingState, ...rest } = patch as any;
    Object.assign(s, rest);
    if (bookingState && bookingState !== s.bookingState) {
      const chk = stateTransitionValidator.check(s.bookingState, bookingState);
      if (chk.ok) for (const st of chk.path) s.bookingState = st;
      else this.rejectedTransitions.push(chk.message);
    }
    this.state.bump(this.ctx.sessionId);
    return true;
  };
}
