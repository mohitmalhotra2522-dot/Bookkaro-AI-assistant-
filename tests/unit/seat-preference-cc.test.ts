/**
 * Chair-car seat preference (IRCTC "Window Side", code WS — verified for CC and 2S only) + live trains no longer
 * labelled "Development data". Nothing invented: EC / EA / EV / unknown classes still get no choice.
 */
import { describe, it, expect } from 'vitest';
import { berthOptionsForClass, isSeatPreferenceClass } from '../../shared/constants';
import { buildFormSpec, validateForm, type TrainFacilitiesView } from '../../server/booking/passenger-form';
import { passengerOptionsView, gateOptionalField } from '../../server/booking/passenger-options';
import { formatIrctcPassenger } from '../../server/irctc/handoff/irctc-station-formatter';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';

const session = (cls: string, extra: any = {}): any => ({
  sessionId: 's1', sessionVersion: 7, date: '2026-10-07', selectedClass: cls, passengersCount: 1, passengers: [],
  selectedTrain: { number: '12014', name: 'AMRITSAR SHTABDI', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '11:02' },
  providerSource: 'railcore', ...extra
});
const fac = (catering: boolean | null): TrainFacilitiesView => ({ catering, pantry: null, provider: 'railcore', dataSource: 'LIVE' });

describe('[1] CC / 2S: IRCTC seat preference Window Side — EC & unknown stay empty', () => {
  it('class table', () => {
    expect(berthOptionsForClass('CC')).toEqual(['NO_PREFERENCE', 'WINDOW']);
    expect(berthOptionsForClass('cc')).toEqual(['NO_PREFERENCE', 'WINDOW']);
    expect(berthOptionsForClass('2S')).toEqual(['NO_PREFERENCE', 'WINDOW']);
    expect(berthOptionsForClass('EC')).toEqual(['NO_PREFERENCE', 'WINDOW']);   // real IRCTC 12014 EC page
    expect(berthOptionsForClass('1A')).toEqual(['NO_PREFERENCE', 'LOWER', 'UPPER', 'CABIN', 'COUPE']);
    expect(berthOptionsForClass('3E')).not.toContain('WINDOW');
    for (const c of ['EA', 'EV', 'VS', 'XYZ', '']) expect(berthOptionsForClass(c)).toEqual([]);
    expect(berthOptionsForClass('3A')).not.toContain('WINDOW');
    expect(berthOptionsForClass('SL')).not.toContain('WINDOW');
    expect(isSeatPreferenceClass('CC')).toBe(true);
    expect(isSeatPreferenceClass('3A')).toBe(false);
    expect(isSeatPreferenceClass('EC')).toBe(true);
    expect(isSeatPreferenceClass('1A')).toBe(false);
    expect(isSeatPreferenceClass('EA')).toBe(false);
  });

  it('form spec: CC / EC offer Window Side with an honest note; EA says not verified', () => {
    const cc = buildFormSpec(session('CC'), fac(true));
    expect(cc.berth.options).toEqual(['NO_PREFERENCE', 'WINDOW']);
    expect(cc.berth.note).toMatch(/Window Side/);
    expect(cc.berth.note).toMatch(/guarantee nahi/);
    expect(buildFormSpec(session('EC'), fac(true)).berth.options).toEqual(['NO_PREFERENCE', 'WINDOW']);
    const ea = buildFormSpec(session('EA'), fac(true));
    expect(ea.berth.options).toEqual([]);
    expect(ea.berth.note).toMatch(/verified jaankari nahi/);
  });

  it('form validation: WINDOW accepted for CC, refused for 3A; LOWER refused for CC', () => {
    expect(validateForm({ passengers: [{ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'WINDOW', foodPreference: 'VEG' }] }, session('CC'), fac(true)).ok).toBe(true);
    const lower = validateForm({ passengers: [{ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'LOWER', foodPreference: 'VEG' }] }, session('CC'), fac(true));
    expect(lower.ok).toBe(false);
    expect((lower as any).error.fieldErrors.map((e: any) => e.field)).toContain('berthPreference');
    const w3a = validateForm({ passengers: [{ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'WINDOW' }] }, session('3A'), fac(false));
    expect(w3a.ok).toBe(false);
  });

  it('chat: CC seat preference is asked; WINDOW / NO_PREFERENCE pass the gate; a berth is refused', () => {
    expect(passengerOptionsView(session('CC'))!.berth).toMatchObject({ ask: true, options: ['NO_PREFERENCE', 'WINDOW'] });
    expect(gateOptionalField(session('CC'), 'berthPreference', 'WINDOW')).toEqual({ ok: true });
    expect(gateOptionalField(session('CC'), 'berthPreference', 'NO_PREFERENCE')).toEqual({ ok: true });
    expect(gateOptionalField(session('CC'), 'berthPreference', 'LOWER')).toMatchObject({ ok: false, message: expect.stringMatching(/berth choice nahi hoti — sirf seat preference: No preference, Window side/) });
    expect(gateOptionalField(session('3A'), 'berthPreference', 'WINDOW')).toMatchObject({ ok: false, message: expect.stringMatching(/3A mein berth options/) });
    expect(gateOptionalField(session('EC'), 'berthPreference', 'WINDOW')).toEqual({ ok: true });
    expect(gateOptionalField(session('1A'), 'berthPreference', 'COUPE')).toEqual({ ok: true });
    expect(gateOptionalField(session('2A'), 'berthPreference', 'COUPE')).toMatchObject({ ok: false });
    expect(passengerOptionsView(session('1A'))!.berth).toMatchObject({ ask: true, options: ['NO_PREFERENCE', 'LOWER', 'UPPER', 'CABIN', 'COUPE'] });
  });

  it('IRCTC handoff maps WINDOW → "Window Side", CABIN → "Cabin", COUPE → "Coupe"', () => {
    expect(formatIrctcPassenger({ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'WINDOW' }, 1).fill.berth).toBe('Window Side');
    expect(formatIrctcPassenger({ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'CABIN' }, 1).fill.berth).toBe('Cabin');
    expect(formatIrctcPassenger({ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'COUPE' }, 1).fill.berth).toBe('Coupe');
    expect(formatIrctcPassenger({ name: 'Rahul Sharma', age: 31, gender: 'MALE', berthPreference: 'COUPE' }, 1).notConfirmed).toEqual([]);
  });
});

describe('[2] selected train data label: live provider rows are LIVE, unknown stays MOCK', () => {
  const sel = (train: any) => { const st = new ConversationStateManager(); const id = st.createSession().sessionId; st.setSelectedTrain(id, train); return (st.getSession(id).selectedTrain as any).dataSource; };
  const row = { trainNumber: '12014', trainName: 'AMRITSAR SHTABDI', classes: [{ code: 'CC' }] };
  it('derives from the row provider when dataSource is absent', () => {
    expect(sel({ ...row, provider: 'railcore' })).toBe('LIVE');
    expect(sel({ ...row, provider: 'railradar' })).toBe('LIVE');
    expect(sel({ ...row, provider: 'mock-tool-runtime' })).toBe('MOCK');
    expect(sel({ ...row, provider: 'MockRailwayProvider' })).toBe('MOCK');
    expect(sel({ ...row })).toBe('MOCK');
    expect(sel({ ...row, provider: '' })).toBe('MOCK');
  });
  it('an explicit dataSource always wins', () => {
    expect(sel({ ...row, provider: 'railcore', dataSource: 'MOCK' })).toBe('MOCK');
    expect(sel({ ...row, dataSource: 'LIVE' })).toBe('LIVE');
  });
});
