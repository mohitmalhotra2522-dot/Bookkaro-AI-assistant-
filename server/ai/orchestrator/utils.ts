// Minimal uuid v4 generator (works in Node + browser without crypto dependency)
export function v4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Legacy alias — used by older v1 orchestrator + state manager
export const uuid = v4;

// Legacy alias — used by v1 conversation-state.ts
export function sessionId(): string { return v4(); }
