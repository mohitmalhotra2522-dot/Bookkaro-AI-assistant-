/**
 * 2026-10-09 — station recognition for ALL stations (reported: "SVDK" / "Svdk" / "Shri Mata Vaishno Devi Katra" was
 * never accepted, the assistant kept asking for the code). Station catalog (reference data) for whole station values:
 * official code in any case, full official name; a shared name is AMBIGUOUS (asked, never guessed); a partial name
 * never resolves; free-text word scanning is unchanged (Hinglish words that are also codes stay non-stations).
 */
import { describe, it, expect } from 'vitest';
import { lookupStationCatalog, stationCatalogSize, stationCodesNamedInText, normStationName } from '../../server/railway/resolvers/station-catalog';
import { resolveStationArgument, resolveStationArgumentDetailed, resolveStationToken, resolveRoute } from '../../server/railway/resolvers/route-resolver';
import { resolveStationDetailed, stationCodesMentioned } from '../../server/ai/conversation/grounding';
import { normalizeToolArguments } from '../../server/ai/tool-runtime/tool-argument-normalizer';

describe('station catalog', () => {
  it('[C1] covers the national station list (> 12k codes) incl. SVDK', () => {
    expect(stationCatalogSize()).toBeGreaterThan(12000);
    expect(lookupStationCatalog('SVDK')).toMatchObject({ kind: 'RESOLVED', code: 'SVDK', name: 'Shri Mata Vaishno Devi Katra' });
  });
  it('[C2] official code in any letter case', () => {
    for (const v of ['SVDK', 'Svdk', 'svdk', ' svdk ']) expect(resolveStationArgument(v)).toEqual({ code: 'SVDK', name: 'Shri Mata Vaishno Devi Katra' });
    expect(resolveStationArgument('jat')?.code).toBe('JAT');
    expect(resolveStationArgument('PTKC')?.code).toBe('PTKC');
  });
  it('[C3] full official name (case / punctuation / "Jn" insensitive)', () => {
    expect(resolveStationArgument('Shri Mata Vaishno Devi Katra')?.code).toBe('SVDK');
    expect(resolveStationArgument('shri mata vaishno devi katra')?.code).toBe('SVDK');
    expect(resolveStationArgument('Hazrat Nizamuddin')?.code).toBe('NZM');
    expect(resolveStationArgument('Pathankot Cantt')?.code).toBe('PTKC');
  });
  it('[C4] a name several stations share is AMBIGUOUS with the candidates (never guessed)', () => {
    const k = resolveStationArgumentDetailed('Katra');
    expect(k.kind).toBe('AMBIGUOUS');
    if (k.kind === 'AMBIGUOUS') expect(k.candidates.map(c => c.code)).toEqual(expect.arrayContaining(['KEA', 'MK', 'SVDK']));
    expect(resolveStationArgument('Katra')).toBeNull();
    expect(resolveStationDetailed('Katra').kind).toBe('AMBIGUOUS');
    expect(resolveStationDetailed('Ambala').kind).toBe('AMBIGUOUS');            // existing dictionary rule kept
  });
  it('[C5] a partial name alone never resolves to another station ("Jammu" ≠ Vijiypur Jammu); official alternate names do', () => {
    expect(lookupStationCatalog('Jammu')).toBeNull();
    expect(resolveStationArgument('Jammu Tawi')?.code).toBe('JAT');
    expect(resolveStationArgument('Old Delhi')?.code).toBe('DLI');
  });
  it('[C6] catalog exact names beat the old partial alias match (no more Delhi Cantt → NDLS / Jalandhar Cantt → JUC)', () => {
    expect(resolveStationArgument('Delhi Cantt')?.code).toBe('DEC');
    expect(resolveStationArgument('Jalandhar Cantt')?.code).toBe('JRC');
    // dictionary aliases unchanged
    expect(resolveStationArgument('Delhi')?.code).toBe('NDLS');
    expect(resolveStationArgument('ludhiana')?.code).toBe('LDH');
    expect(resolveStationArgument('ldh')?.code).toBe('LDH');
  });
  it('[C7] free-text word scanning is unchanged — Hinglish words that are also codes are not stations there', () => {
    for (const w of ['kal', 'se', 'do', 'ko', 'to']) expect(resolveStationToken(w)).toBeNull();
    expect(resolveRoute('ludhiana se delhi').ok).toBe(true);
  });
  it('[C8] grounding: the user\'s full station name / capitalised code counts as naming that station', () => {
    expect([...stationCodesMentioned('Shri Mata Vaishno Devi Katra')]).toContain('SVDK');
    expect([...stationCodesNamedInText('ludhiana se SVDK jaana hai')]).toContain('SVDK');
    expect([...stationCodesNamedInText('kal do log')]).toEqual([]);
    expect(normStationName('Ludhiana Jn.')).toBe('ludhiana');
  });
  it('[C9] SEARCH_TRAINS arguments: "Svdk" / full name → SVDK; "Katra" → AMBIGUOUS_STATION listing the stations', () => {
    const s: any = { origin: null, destination: null };
    const a: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'Svdk', date: '2026-10-20' }, s, 'ludhiana se svdk 20 oct');
    expect(a.ok).toBe(true);
    expect(a.arguments.destination).toBe('SVDK');
    const b: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'Shri Mata Vaishno Devi Katra', date: '2026-10-20' }, s, 'Shri Mata Vaishno Devi Katra');
    expect(b.ok).toBe(true);
    expect(b.arguments.destination).toBe('SVDK');
    const c: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'Katra', date: '2026-10-20' }, s, 'ludhiana se katra');
    expect(c.ok).toBe(false);
    expect(c.code).toBe('AMBIGUOUS_STATION');
    expect(c.message).toMatch(/Shri Mata Vaishno Devi Katra \(SVDK\)/);
    expect(c.details.candidates.map((x: any) => x.code)).toEqual(expect.arrayContaining(['KEA', 'SVDK']));
  });
  it('[C10] LLM code contradicting the station the user TYPED in full → corrected to the typed station (live: "KTR" for SVDK)', () => {
    const s: any = { origin: null, destination: null };
    const a: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'KTR', date: '2026-10-20' }, s, 'Ludhiana se Shri Mata Vaishno Devi Katra 20 October ki trains dikhao');
    expect(a.ok).toBe(true);
    expect(a.arguments.destination).toBe('SVDK');
    expect(a.corrections.join(' ')).toMatch(/destination: KTR → SVDK \(user named the station\)/);
  });
  it('[C11] shared name typed ("Katra") + a code outside its stations → AMBIGUOUS_STATION with the real candidates', () => {
    const s: any = { origin: null, destination: null };
    const a: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'KTR', date: '2026-10-20' }, s, 'Katra jaana hai Ludhiana se 20 October');
    expect(a.ok).toBe(false);
    expect(a.code).toBe('AMBIGUOUS_STATION');
    expect(a.details.candidates.map((x: any) => x.code)).toEqual(expect.arrayContaining(['KEA', 'MK', 'SVDK']));
    // a code among the real Katra stations is the LLM's semantic pick → kept
    const b: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'SVDK', date: '2026-10-20' }, s, 'Katra jaana hai Ludhiana se 20 October');
    expect(b.ok).toBe(true);
    expect(b.arguments.destination).toBe('SVDK');
  });
  it('[C12] LLM semantic mappings without a typed official name stay untouched (Jammu → JAT, Bombay → BCT, Delhi se Mumbai)', () => {
    const s: any = { origin: null, destination: null };
    const cases: Array<[string, string, string]> = [['LDH', 'JAT', 'Ludhiana se Jammu 20 October'], ['LDH', 'BCT', 'Ludhiana se Bombay 20 October'],
      ['NDLS', 'CSMT', 'Delhi se Mumbai 20 October'], ['DEC', 'SVDK', 'Delhi Cantt se Katra 20 October'], ['LDH', 'NDLS', 'ludhiana se delhi kal']];
    for (const [o, d, text] of cases) {
      const r: any = normalizeToolArguments('SEARCH_TRAINS', { origin: o, destination: d, date: '2026-10-20' }, s, text);
      expect(r.ok, text).toBe(true);
      expect([r.arguments.origin, r.arguments.destination], text).toEqual([o, d]);
    }
  });
  it('[C13] other scripts keep the LLM semantic authority (no Latin name scan)', () => {
    const s: any = { origin: null, destination: null };
    const r: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'LDH', destination: 'SVDK', date: '2026-10-20' }, s, 'लुधियाना से कटरा 20 अक्टूबर');
    expect(r.ok).toBe(true);
    expect(r.arguments.destination).toBe('SVDK');
  });
});
