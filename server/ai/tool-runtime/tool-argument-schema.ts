/**
 * PROMPT 25 — Part 8: deterministic tool-argument validation BEFORE execution.
 *
 * Runs inside ToolArgumentNormalizer (after the argument security scan, before date / station resolution and the
 * existing ToolCallValidator). It checks schema membership, JSON type and the format of identifiers, and returns ONE
 * concise structured error the LLM can act on:
 *
 *   { code: 'INVALID_ARGUMENT', details: { argument, expected, received } }
 *
 * It never guesses: no "closest train", no digit extraction from "124977", no class mapping from free text. The only
 * normalization is LOSSLESS type coercion of an otherwise valid value (JSON number 12497 → "12497", "3a" → "3A",
 * "2" → 2) — the meaning is identical, so the call is not bounced back to the LLM for a cosmetic difference.
 */
import { getToolDefinition, type RegisteredToolName } from '../tools/tool-registry';

export const TRAIN_NUMBER_FORMAT = /^\d{4,5}$/;
export const CLASS_CODES = ['1A', '2A', '3A', '3E', 'CC', 'EC', 'SL', '2S', 'FC', 'EA'] as const;
const CLASS_SET = new Set<string>(CLASS_CODES);

export interface ArgumentIssue {
  argument: string;
  expected: string;
  /** Short, printable view of what was received (never more than 40 chars). */
  received: string;
}

export type SchemaCheck =
  | { ok: true; arguments: Record<string, any>; coerced: string[] }
  | { ok: false; code: 'INVALID_ARGUMENT'; message: string; details: ArgumentIssue & { tool: string; clarify: string } };

const show = (v: unknown): string => {
  if (v === undefined) return 'undefined';
  let s: string;
  try { s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

/** User-facing (Hinglish) clarification per argument — used only if the LLM keeps repeating the same invalid call. */
const CLARIFY: Record<string, string> = {
  trainNumber: 'Train number sahi format mein nahi mila — kaunsi train? 5 digit ka train number bata dijiye.',
  travelClass: 'Kaunsi class chahiye? Jaise 3A, SL, CC ya 2S.',
  passengersCount: 'Kitne passengers hain? 1 se 6 ke beech bata dijiye.',
  date: 'Kis date ko travel karna hai?',
  origin: 'Kahan se travel karna hai?',
  destination: 'Kahan tak jaana hai?'
};

function fail(tool: string, issue: ArgumentIssue): SchemaCheck {
  return {
    ok: false, code: 'INVALID_ARGUMENT',
    message: `Invalid argument "${issue.argument}" for ${tool}: expected ${issue.expected}; received ${issue.received}. Correct it or ask the user.`,
    details: { ...issue, tool, clarify: CLARIFY[issue.argument] || 'Thoda saaf bata dijiye?' }
  };
}

export function validateToolArgumentShape(tool: string, raw: Record<string, any>): SchemaCheck {
  const def = getToolDefinition(tool as RegisteredToolName);
  const args: Record<string, any> = { ...(raw || {}) };
  const coerced: string[] = [];
  if (!def) return { ok: true, arguments: args, coerced };
  const known = Object.keys(def.parameters);
  for (const [k, v] of Object.entries(args)) {
    if (!(k in def.parameters)) return fail(tool, { argument: k, expected: `no such argument (allowed: ${known.join(', ')})`, received: show(v) });
    if (v === undefined || v === null || v === '') { delete args[k]; continue; }   // "not provided" — defaults apply
    const spec = def.parameters[k];
    if (k === 'trainNumber') {
      if (typeof v === 'number' && Number.isInteger(v) && TRAIN_NUMBER_FORMAT.test(String(v))) { args[k] = String(v); coerced.push('trainNumber:number→string'); continue; }
      if (typeof v !== 'string' || !TRAIN_NUMBER_FORMAT.test(v.trim())) return fail(tool, { argument: k, expected: 'a 4-5 digit train number string, e.g. "12497"', received: show(v) });
      if (v !== v.trim()) { args[k] = v.trim(); coerced.push('trainNumber:trim'); }
      continue;
    }
    if (k === 'travelClass') {
      const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
      if (!CLASS_SET.has(c)) return fail(tool, { argument: k, expected: `a class code (${CLASS_CODES.join(', ')})`, received: show(v) });
      if (c !== v) { args[k] = c; coerced.push('travelClass:case'); }
      continue;
    }
    if (k === 'passengersCount') {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
      if (!Number.isInteger(n) || n < 1 || n > 6) return fail(tool, { argument: k, expected: 'an integer from 1 to 6', received: show(v) });
      if (n !== v) { args[k] = n; coerced.push('passengersCount:string→number'); }
      continue;
    }
    if (spec.type === 'string' && typeof v !== 'string') {
      // ids / codes may arrive as JSON numbers; anything else (objects, booleans) is malformed
      if (typeof v === 'number' && Number.isFinite(v) && k !== 'pnr') { args[k] = String(v); coerced.push(`${k}:number→string`); }
      else return fail(tool, { argument: k, expected: 'a string', received: k === 'pnr' ? `<${typeof v}>` : show(v) });
    }
    if (spec.type === 'number' && typeof v !== 'number') {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return fail(tool, { argument: k, expected: 'a number', received: show(v) });
      args[k] = n; coerced.push(`${k}:string→number`);
    }
    if (spec.enum && !spec.enum.includes(args[k])) return fail(tool, { argument: k, expected: `one of ${spec.enum.join(' | ')}`, received: show(v) });
  }
  return { ok: true, arguments: args, coerced };
}
