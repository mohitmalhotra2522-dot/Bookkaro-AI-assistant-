/**
 * Prompt 35 — WEB_EXTERNAL railway research (LLM-chosen tool, disabled by default).
 *
 * Authority boundary (enforced in the backend, not by prompt wording):
 *  - Results are ALWAYS labelled dataSource=WEB_EXTERNAL and authority=NOT_AUTHORITATIVE.
 *  - They are never railway-provider evidence: GET_FARE alone authorizes fares, CHECK_AVAILABILITY alone
 *    authorizes seat status, CHECK_PNR alone authorizes PNR, and the P16 fact guard ignores web steps when it
 *    harvests train numbers / ₹ amounts.
 *  - The backend NEVER launches this after a provider failure — only the LLM can choose it (closed tool set).
 *  - Only trusted railway-information domains are searched (official IR / IRCTC first, then well-known
 *    secondary sites). No scraping, no login, no CAPTCHA/auth bypass — a documented search API only.
 *  - Third-party sites are labelled SECONDARY, never "official".
 *
 * Config (env only; keys never logged / returned / sent to the LLM):
 *   WEB_RESEARCH_ENABLED=true, WEB_RESEARCH_PROVIDER=tavily, WEB_RESEARCH_API_KEY, WEB_RESEARCH_TIMEOUT_MS (default 5000)
 */

export const OFFICIAL_DOMAINS = Object.freeze(['indianrail.gov.in', 'enquiry.indianrail.gov.in', 'irctc.co.in', 'indianrailways.gov.in']);
export const SECONDARY_DOMAINS = Object.freeze(['confirmtkt.com', 'railyatri.in', 'erail.in']);
export type SourceTier = 'OFFICIAL' | 'SECONDARY';

export interface WebResearchItem { title: string; url: string; domain: string; sourceTier: SourceTier; snippet: string; publishedAt?: string }
export interface WebResearchData {
  query: string;
  dataSource: 'WEB_EXTERNAL';
  authority: 'NOT_AUTHORITATIVE';
  note: string;
  results: WebResearchItem[];
}
export type WebResearchResponse =
  | { ok: true; data: WebResearchData; meta: { source: 'web_external'; provider: string; latencyMs: number; timestamp: string; dataSource: 'WEB_EXTERNAL'; freshness: { mode: 'live'; retrievedAt: string } } }
  | { ok: false; error: { code: string; message: string; retryable?: boolean }; meta: { source: 'web_external'; provider: string; latencyMs: number; timestamp: string; dataSource: 'WEB_EXTERNAL' } };

export interface WebResearchService { readonly name: string; configured(): boolean; search(query: string): Promise<WebResearchResponse> }

export const WEB_NOTE = 'Web research (third-party/official web pages) — NOT verified railway data. Never use it for seat availability, fare, booking or PNR status; those need the railway tools.';

const SNIPPET_MAX = 320;
const MAX_RESULTS = 5;

export function domainOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}
export function tierOf(domain: string | null): SourceTier | null {
  if (!domain) return null;
  const m = (list: readonly string[]) => list.some(d => domain === d || domain.endsWith('.' + d));
  return m(OFFICIAL_DOMAINS) ? 'OFFICIAL' : m(SECONDARY_DOMAINS) ? 'SECONDARY' : null;
}

/** Keep trusted domains only, official first; strip control chars; bounded snippet length. */
export function normalizeWebResults(raw: any[]): WebResearchItem[] {
  const out: WebResearchItem[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const url = typeof r?.url === 'string' ? r.url : '';
    const domain = domainOf(url);
    const sourceTier = tierOf(domain);
    if (!domain || !sourceTier || !/^https:\/\//i.test(url)) continue;
    const clean = (s: any, n: number) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    out.push({ title: clean(r.title, 160), url, domain, sourceTier, snippet: clean(r.content, SNIPPET_MAX), ...(r.published_date ? { publishedAt: clean(r.published_date, 40) } : {}) });
  }
  return out.sort((a, b) => (a.sourceTier === b.sourceTier ? 0 : a.sourceTier === 'OFFICIAL' ? -1 : 1)).slice(0, MAX_RESULTS);
}

export class TavilyWebResearchService implements WebResearchService {
  readonly name = 'TAVILY';
  constructor(private readonly cfg: { apiKey?: string; timeoutMs?: number; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {}
  configured(): boolean { return !!this.cfg.apiKey; }
  async search(query: string): Promise<WebResearchResponse> {
    const t0 = Date.now();
    const meta = () => ({ source: 'web_external' as const, provider: this.name, latencyMs: Date.now() - t0, timestamp: new Date().toISOString(), dataSource: 'WEB_EXTERNAL' as const });
    const fail = (code: string, message: string, retryable = false): WebResearchResponse => ({ ok: false, error: { code, message, retryable }, meta: meta() });
    if (!this.cfg.apiKey) return fail('TOOL_NOT_IMPLEMENTED', 'Web research configured nahi hai.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(500, this.cfg.timeoutMs ?? 5000));
    try {
      const res = await (this.cfg.fetchImpl || fetch)(`${this.cfg.baseUrl || 'https://api.tavily.com'}/search`, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, search_depth: 'basic', max_results: 8, topic: 'general', include_answer: false, include_raw_content: false, include_images: false, include_domains: [...OFFICIAL_DOMAINS, ...SECONDARY_DOMAINS] })
      });
      if (res.status === 429) return fail('RATE_LIMITED', 'Web research rate-limited hai.', true);
      if (res.status === 401 || res.status === 403) return fail('PROVIDER_UNAVAILABLE', 'Web research abhi uplabdh nahi hai.');
      if (!res.ok) return fail('PROVIDER_UNAVAILABLE', 'Web research abhi uplabdh nahi hai.', res.status >= 500);
      let body: any;
      try { body = await res.json(); } catch { return fail('PROVIDER_DATA_INVALID', 'Web research ka jawab sahi format mein nahi tha.'); }
      if (!body || !Array.isArray(body.results)) return fail('PROVIDER_DATA_INVALID', 'Web research ka jawab sahi format mein nahi tha.');
      const results = normalizeWebResults(body.results);
      const m = meta();
      return { ok: true, data: { query, dataSource: 'WEB_EXTERNAL', authority: 'NOT_AUTHORITATIVE', note: WEB_NOTE, results }, meta: { ...m, freshness: { mode: 'live', retrievedAt: m.timestamp } } };
    } catch (e: any) {
      return e?.name === 'AbortError' ? fail('TOOL_TIMEOUT', 'Web research ne time par jawab nahi diya.', true) : fail('PROVIDER_UNAVAILABLE', 'Web research abhi uplabdh nahi hai.', true);
    } finally { clearTimeout(timer); }
  }
}

/** Env gate: the tool exists for the LLM only when explicitly enabled AND keyed. Default: disabled. */
export function webResearchEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.WEB_RESEARCH_ENABLED || '').toLowerCase() === 'true'
    && String(env.WEB_RESEARCH_PROVIDER || 'tavily').toLowerCase() === 'tavily'
    && !!env.WEB_RESEARCH_API_KEY;
}
export function webResearchStatus(env: NodeJS.ProcessEnv = process.env) {
  return { enabled: webResearchEnabledFromEnv(env), provider: String(env.WEB_RESEARCH_PROVIDER || 'tavily').toUpperCase(), configured: !!env.WEB_RESEARCH_API_KEY, authority: 'NOT_AUTHORITATIVE' as const };
}

let current: WebResearchService | null = null;
/** Module-level service (no new orchestrator wiring). Tests inject a MOCK-labelled stub via setWebResearchService. */
export function getWebResearchService(): WebResearchService {
  if (!current) current = new TavilyWebResearchService({ apiKey: webResearchEnabledFromEnv() ? process.env.WEB_RESEARCH_API_KEY : undefined, timeoutMs: Number(process.env.WEB_RESEARCH_TIMEOUT_MS) || 5000 });
  return current;
}
export function setWebResearchService(s: WebResearchService | null): void { current = s; }

/** Privacy: web queries must never carry a PNR-like number or credential words. */
export function validateWebQuery(q: unknown): { ok: true; query: string } | { ok: false; message: string } {
  const s = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : '';
  if (s.length < 3 || s.length > 200) return { ok: false, message: 'WEB_RAILWAY_RESEARCH: query 3–200 characters ki honi chahiye.' };
  if (/(?<!\d)\d{10}(?!\d)/.test(s)) return { ok: false, message: 'WEB_RAILWAY_RESEARCH: PNR jaisi personal jaankari web par nahi bheji jaati.' };
  if (/\b(otp|password|passcode|cvv|upi\s*pin|captcha)\b/i.test(s)) return { ok: false, message: 'WEB_RAILWAY_RESEARCH: sensitive jaankari web par nahi bheji jaati.' };
  return { ok: true, query: s };
}
