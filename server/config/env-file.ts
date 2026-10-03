/**
 * PROMPT 23 — minimal, dependency-free .env loader for LOCAL development (vite-node does not populate process.env
 * from .env for server code). Server-side only: values are never logged or sent anywhere. Existing environment
 * variables always win (real deployments configure secrets in the host environment, not in a file).
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Loads KEY=VALUE pairs into `env` without overriding keys that are already set. Returns the names loaded. */
export function loadEnvFile(path = resolve(process.cwd(), '.env'), env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(path, 'utf8')))) {
    if (env[k] === undefined) { env[k] = v; loaded.push(k); }
  }
  return loaded;
}
