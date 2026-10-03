/**
 * PROMPT 23 — fake OpenAI-compatible Chat Completions server for automated tests (no network, no credits).
 * Speaks the native function-calling wire format: requests carry `tools` + messages (system / user / assistant
 * tool_calls / role:"tool" results); replies carry `tool_calls` or final `content` (optionally with a hidden
 * `reasoning_content`, like GLM). Works as an injected `fetch` AND as a real local HTTP server (127.0.0.1, port 0).
 */
import { createServer, type Server } from 'http';
import type { FetchLike } from '../../server/ai/providers/openai-compatible-llm';

export type FakeReply =
  | { content?: string; calls?: Array<{ name: string; args?: Record<string, any>; id?: string }>; reasoning?: string }
  | { status: number; body?: string }
  | { networkError: true };

export interface TurnView {
  /** the current user message (last role:"user") */
  user: string;
  /** number of assistant tool-call steps already taken in this turn */
  step: number;
  /** role:"tool" results of this turn, in order, with the tool name resolved from the assistant tool_calls */
  results: Array<{ id: string; name: string; content: any }>;
  /** the authoritative session context the backend sent (parsed) */
  context: any;
  body: any;
}

export function turnView(body: any): TurnView {
  const msgs: any[] = body?.messages || [];
  let u = -1;
  for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].role === 'user') { u = k; break; }
  const names = new Map<string, string>();
  let step = 0;
  const results: TurnView['results'] = [];
  for (const m of msgs.slice(u + 1)) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) { step++; for (const c of m.tool_calls) names.set(c.id, c.function?.name); }
    if (m.role === 'tool') { let content: any = m.content; try { content = JSON.parse(m.content); } catch { /* text */ } results.push({ id: m.tool_call_id, name: names.get(m.tool_call_id) || '?', content }); }
  }
  const ctxMsg = msgs.find(m => m.role === 'system' && String(m.content).startsWith('AUTHORITATIVE SESSION CONTEXT'));
  let context: any = null;
  try { context = ctxMsg ? JSON.parse(String(ctxMsg.content).split('\n').slice(1).join('\n')) : null; } catch { context = null; }
  return { user: u >= 0 ? String(msgs[u].content) : '', step, results, context, body };
}

let idSeq = 0;
function completion(r: Extract<FakeReply, { content?: string }>) {
  const tool_calls = (r.calls || []).map(c => ({ id: c.id || `call_${++idSeq}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
  return {
    id: `chatcmpl-${++idSeq}`, object: 'chat.completion', model: 'fake-model',
    choices: [{ index: 0, finish_reason: tool_calls.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: r.content ?? (tool_calls.length ? '' : null), ...(tool_calls.length ? { tool_calls } : {}), ...(r.reasoning ? { reasoning_content: r.reasoning } : {}) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}

export class FakeOpenAI {
  requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  private server: Server | null = null;
  constructor(public responder: (view: TurnView, body: any, n: number) => FakeReply) {}

  get decisionRequests() { return this.requests.filter(r => Array.isArray(r.body?.tools)); }
  get wordingRequests() { return this.requests.filter(r => !Array.isArray(r.body?.tools)); }

  private respond(body: any): { status: number; json: any; text: string } | 'NETWORK' {
    const n = this.requests.length - 1;
    const r = Array.isArray(body?.tools) ? this.responder(turnView(body), body, n) : { content: 'Theek hai.' };
    if ('networkError' in r) return 'NETWORK';
    if ('status' in r) return { status: r.status, json: null, text: r.body ?? '{"error":{"message":"upstream exploded: internal trace"}}' };
    const j = completion(r);
    return { status: 200, json: j, text: JSON.stringify(j) };
  }

  fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    this.requests.push({ url, headers: { ...init.headers }, body });
    const r = this.respond(body);
    if (r === 'NETWORK') throw new Error('ECONNRESET');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.json ?? JSON.parse(r.text)), text: async () => r.text };
  };

  /** Real HTTP endpoint on 127.0.0.1 (random port) — returns the base URL (…/v1). */
  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let body: any = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* bad body */ }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
        this.requests.push({ url: String(req.url), headers, body });
        const r = this.respond(body);
        if (r === 'NETWORK') { req.socket.destroy(); return; }
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.text);
      });
    });
    await new Promise<void>(ok => this.server!.listen(0, '127.0.0.1', () => ok()));
    const addr = this.server.address() as any;
    return `http://127.0.0.1:${addr.port}/v1`;
  }
  async close() { if (this.server) await new Promise<void>(ok => this.server!.close(() => ok())); this.server = null; }
}
