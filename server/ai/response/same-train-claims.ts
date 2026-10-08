/**
 * PROMPT 42 — Same Train Alternative claim guard (hard safety constraint on wording, not an interpretation).
 *
 * "Book Amritsar → Delhi, board at Ludhiana" is only allowed when the boarding rule was VERIFIED by a rule-evidence
 * source (likewise for alighting before the ticket destination). A sentence that combines an ALTERNATIVE ticket station
 * with the requested travel station and a boarding / deboarding verb, WITHOUT an honest verification hedge, is removed
 * when that rule is UNVERIFIED. Sentences about the requested pair itself are never touched.
 * P42-13: plus the route-data limitation rule (guardRouteDataClaims below).
 */
import { SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE } from '@shared/same-train-alternatives';

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

type GuardStep = { status: string; result: { toolName: string; data?: any; error?: { code?: string; message?: string } } };

export function guardSameTrainRuleClaims(text: string, steps: GuardStep[]): { text: string; removed: string[] } {
  if (!text) return { text, removed: [] };
  const route = guardRouteDataClaims(text, steps);
  const rule = guardBoardingRuleClaims(route.text, steps);
  const removed = [...route.removed, ...rule.removed];
  return removed.length ? { text: rule.text, removed } : { text, removed: [] };
}

/**
 * P42-13 — route-DATA limitation. When this turn's same-train search failed with INVALID_STATION_PAIR (the provider's
 * route data does not contain / order the requested pair), the data may simply be incomplete: a sentence that turns it
 * into a definite railway fact ("ASR is route par nahi hai", "train NDLS par nahi rukti", "not on this route") is
 * replaced by the truthful limitation line (once; further such sentences are dropped). Hedged sentences ("verify nahi
 * ho paaya", "data adhoora ho sakta hai") are kept. Nothing is added when no such claim was made.
 */
const ROUTE_ABSENCE_RE = new RegExp([
  String.raw`\broute\s*(par|pe|mein|me|main|mai)\s*(nahi|nahin|nhi)\b`,
  String.raw`\broute\s*ka\s*(hissa|part)\s*(nahi|nahin|nhi)\b`,
  String.raw`\b(nahi|nahin|nhi)\s*(rukti|rukta|rukegi|rukega|rukti\s+hai|guzarti|guzarta|aata|aati)\b`,
  String.raw`\b(is|was)\s*(not|n't)\s+(on|part\s+of|in)\s+(the|this|its|that)\s+(train'?s?\s+)?route\b`,
  String.raw`\bnot\s+on\s+(the|this|its|that)\s+(train'?s?\s+)?route\b`,
  String.raw`\b(does\s+not|doesn'?t|never)\s+(stop|pass|run)\s+(at|through|via)\b`,
  String.raw`रूट\s*(पर|में|मे)\s*नहीं`, String.raw`नहीं\s*(रुकती|रुकता|गुज़रती|गुजरती|आता|आती)`
].join('|'), 'i');
const ROUTE_HEDGE_RE = /verif\w*\s+nahi|verify\s+nahin|confirm\s+nahi|pakka\s+nahi|could\s*n[o']?t\s+(be\s+)?(verif|confirm)|cannot\s+(be\s+)?(verif|confirm)|can'?t\s+(verify|confirm)|unable\s+to\s+(verify|confirm)|adhoor|incomplete|ho\s+sakta\s+hai|may\s+be|might\s+be|matlab\s+yeh\s+nahi|does\s*n[o']?t\s+mean|सत्यापित\s*नहीं|वेरिफाई\s*नहीं|पुष्टि\s*नहीं|अधूरा/i;

export function guardRouteDataClaims(text: string, steps: GuardStep[]): { text: string; removed: string[] } {
  if (!text) return { text, removed: [] };
  const limited = (steps || []).some(x => x.status !== 'ok' && x.status !== 'rejected'
    && x.result?.toolName === 'SEARCH_SAME_TRAIN_ALTERNATIVES' && x.result.error?.code === 'INVALID_STATION_PAIR');
  if (!limited) return { text, removed: [] };
  const removed: string[] = [];
  let lineUsed = text.includes(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE);
  const out: string[] = [];
  for (const sn of String(text).split(SENT_SPLIT)) {
    if (!ROUTE_ABSENCE_RE.test(sn) || ROUTE_HEDGE_RE.test(sn)) { out.push(sn); continue; }
    removed.push('ROUTE_DATA_UNVERIFIED');
    if (!lineUsed) { out.push(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE); lineUsed = true; }
  }
  return removed.length ? { text: out.join(' ').trim(), removed } : { text, removed: [] };
}

function guardBoardingRuleClaims(text: string, steps: GuardStep[]): { text: string; removed: string[] } {
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
