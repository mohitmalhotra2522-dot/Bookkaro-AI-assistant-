/**
 * PROMPT 42 — Same Train Alternative claim guard (hard safety constraint on wording, not an interpretation).
 *
 * "Book Amritsar → Delhi, board at Ludhiana" is only allowed when the boarding rule was VERIFIED by a rule-evidence
 * source (likewise for alighting before the ticket destination). A sentence that combines an ALTERNATIVE ticket station
 * with the requested travel station and a boarding / deboarding verb, WITHOUT an honest verification hedge, is removed
 * when that rule is UNVERIFIED. Sentences about the requested pair itself are never touched.
 */
const SENT_SPLIT = /(?<=[.!?।])\s+/;
const BOARD_RE = /\b(board(ing)?|chadh(na|ni|en|ein|o|iye|enge|ega|egi)?|chadhe|baith(na|iye|en)?)\b/i;
const ALIGHT_RE = /\b(deboard(ing)?|alight(ing)?|utar(na|ni|en|ein|o|iye|enge|ega|egi)?|utre|get off)\b/i;
const HEDGE_RE = /\b(verify|verified|verification|confirm nahi|pakka nahi|rule|zaroori|check kar(na|ein|iye|lein)?|not verified|unverified|nahi pata|guarantee nahi)\b/i;

interface StationRef { code: string; name?: string }
const tokensOf = (s: StationRef): RegExp[] => {
  const out = [new RegExp(`\\b${String(s.code).replace(/[^A-Z0-9]/g, '')}\\b`)];
  const first = String(s.name || '').split(/[\s(]/)[0].replace(/[^A-Za-z]/g, '');
  if (first.length >= 4) out.push(new RegExp(`\\b${first}`, 'i'));
  return out;
};
const mentions = (sn: string, s: StationRef) => tokensOf(s).some(re => re.test(sn));

export function guardSameTrainRuleClaims(text: string, steps: Array<{ status: string; result: { toolName: string; data?: any } }>): { text: string; removed: string[] } {
  if (!text) return { text, removed: [] };
  const st = [...(steps || [])].reverse().find(x => x.status === 'ok' && x.result?.toolName === 'SEARCH_SAME_TRAIN_ALTERNATIVES' && x.result.data?.alternatives);
  if (!st) return { text, removed: [] };
  const r = st.result.data;
  const names = new Map<string, string | undefined>(((r.route?.stations || []) as any[]).map(s => [String(s.code), s.name]));
  const reqO: StationRef = { code: r.requestedOrigin, name: r.requestedOriginName || names.get(r.requestedOrigin) };
  const reqD: StationRef = { code: r.requestedDestination, name: r.requestedDestinationName || names.get(r.requestedDestination) };
  const altOrigins: StationRef[] = []; const altDests: StationRef[] = [];
  for (const a of r.alternatives as any[]) {
    if (a.boardingRuleStatus === 'UNVERIFIED' && a.ticketOrigin !== r.requestedOrigin) altOrigins.push({ code: a.ticketOrigin, name: a.ticketOriginName || names.get(a.ticketOrigin) });
    if (a.alightingRuleStatus === 'UNVERIFIED' && a.ticketDestination !== r.requestedDestination) altDests.push({ code: a.ticketDestination, name: a.ticketDestinationName || names.get(a.ticketDestination) });
  }
  if (!altOrigins.length && !altDests.length) return { text, removed: [] };
  const removed: string[] = [];
  const kept = String(text).split(SENT_SPLIT).filter(sn => {
    if (HEDGE_RE.test(sn)) return true;
    const boardClaim = BOARD_RE.test(sn) && mentions(sn, reqO) && altOrigins.some(o => mentions(sn, o));
    const alightClaim = ALIGHT_RE.test(sn) && mentions(sn, reqD) && altDests.some(d => mentions(sn, d));
    if (boardClaim || alightClaim) { removed.push(boardClaim ? 'BOARDING_RULE_UNVERIFIED' : 'ALIGHTING_RULE_UNVERIFIED'); return false; }
    return true;
  });
  return removed.length ? { text: kept.join(' ').trim(), removed } : { text, removed };
}
