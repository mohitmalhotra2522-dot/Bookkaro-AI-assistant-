/**
 * PROMPT 21 — one mapping from ConversationTurnEngine events to voice-agent events, used by BOTH the server-side
 * agent (TurnEventBus subscription) and the browser (polled /turn-events) so the two paths cannot drift.
 */
import type { TurnEvent } from '../turn-engine';
import type { VoiceTurnEvent } from './conversational-voice-agent';

export function turnEventToVoiceEvent(ev: TurnEvent): VoiceTurnEvent | null {
  const base = { turnId: ev.turnId, sequence: ev.turnSequence };
  const d: any = ev.data || {};
  switch (ev.type) {
    case 'TURN_STARTED': return { type: 'TURN_STARTED', ...base };
    case 'TOOL_REQUESTED': return { type: 'TOOL_REQUESTED', ...base, tool: String(d.tool || '') };
    case 'TOOL_COMPLETED': return { type: 'TOOL_RESULT', ...base, tool: String(d.tool || ''), ok: d.status === 'SUCCEEDED' };
    case 'TOOL_FAILED': return { type: 'TOOL_RESULT', ...base, tool: String(d.tool || ''), ok: false };
    case 'TOOL_PROGRESS':
      if (!d.speechText) return null;
      return d.kind === 'STATUS' ? { type: 'STATUS_UPDATE', ...base, text: String(d.speechText) } : { type: 'ACKNOWLEDGEMENT', ...base, text: String(d.speechText) };
    case 'SPEECH_SEGMENT': return { type: 'SPEECH_SEGMENT', ...base, index: Number(d.index) || 0, text: String(d.text || '') };
    default: return null;
  }
}
