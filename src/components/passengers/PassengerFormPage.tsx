import React, { useEffect, useMemo, useState } from 'react';
import { getPassengerForm, submitPassengerForm, type PassengerFormSpec, type PassengerFormInput } from '../../lib/api';
import { IconAlert, IconClose, IconInfo, IconPlus, IconTrain, IconUsers } from '../icons/Icons';
import { formatDate } from '../../lib/format';
import { irctcAgeCategory } from './irctc-age-category';

/**
 * P38 — IRCTC-style passenger details page (full screen).
 * Everything shown comes from the backend form spec:
 *   - berth choices = the selected class's coach layout (none for seat classes);
 *   - meal choice only when the provider says catering is included for this train;
 * The backend validates again on submit (names in English letters, age 1–120, gender, berth for the class, meal only
 * when offered). Nothing is calculated or invented here.
 */
const BERTH_LABEL: Record<string, string> = {
  // exact IRCTC passenger-form texts (labels_en.json: noPreference / LB / MB / UB / SL / SU / SM / WS / CB / CP)
  NO_PREFERENCE: 'No Preference', LOWER: 'Lower', MIDDLE: 'Middle', UPPER: 'Upper', SIDE_LOWER: 'Side Lower', SIDE_UPPER: 'Side Upper', SIDE_MIDDLE: 'Side Middle', WINDOW: 'Window Side', CABIN: 'Cabin', COUPE: 'Coupe'
};
const FOOD_LABEL: Record<string, string> = { VEG: 'Veg', NON_VEG: 'Non Veg', NO_FOOD: 'No Food/Beverages' };   // IRCTC V / N / NF
const GENDERS: Array<[string, string]> = [['MALE', 'Male'], ['FEMALE', 'Female'], ['OTHER', 'Transgender']];

type Row = { name: string; age: string; gender: string; berthPreference: string; foodPreference: string };
const emptyRow = (): Row => ({ name: '', age: '', gender: '', berthPreference: '', foodPreference: '' });

interface Props {
  sessionId: string;
  onClose: () => void;
  /** Called after the backend accepted the form (the app then asks for the review in a visible chat turn). */
  onSaved: (count: number) => void;
}

export const PassengerFormPage: React.FC<Props> = ({ sessionId, onClose, onSaved }) => {
  const [spec, setSpec] = useState<PassengerFormSpec | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = async () => {
    setLoadError(null); setSpec(null);
    const r = await getPassengerForm(sessionId).catch(() => null);
    if (!r) { setLoadError('Server se jud nahi paaye. Dobara koshish kijiye.'); return; }
    if (!r.ok) { setLoadError(r.message); return; }
    const s = r.spec;
    setSpec(s);
    const existing = s.passengers.map(p => ({
      name: p.name || '', age: p.age ? String(p.age) : '', gender: p.gender || '',
      berthPreference: p.berthPreference && s.berth.options.includes(p.berthPreference) ? p.berthPreference : '',
      foodPreference: p.foodPreference && s.food.options.includes(p.foodPreference) ? p.foodPreference : ''
    }));
    const n = Math.max(1, s.passengersCount || 0, existing.length);
    setRows(Array.from({ length: Math.min(n, s.maxPassengers) }, (_, i) => existing[i] || emptyRow()));
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sessionId]);

  // Esc closes (no data is lost on the server — nothing was submitted)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const set = (i: number, k: keyof Row, v: string) => {
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
    setFieldErrors(fe => { const n = { ...fe }; delete n[`${i + 1}.${k}`]; return n; });
  };
  const foodOffered = spec?.food.status === 'OFFERED';
  const berthOptions = spec?.berth.options || [];

  const localErrors = useMemo(() => {
    const e: Record<string, string> = {};
    rows.forEach((r, i) => {
      const k = i + 1;
      if (!/^[A-Za-z][A-Za-z .'-]{1,39}$/.test(r.name.trim())) e[`${k}.name`] = 'Naam English letters mein (2–40 akshar)';
      const a = Number(r.age);
      if (!Number.isInteger(a) || a < 1 || a > 120) e[`${k}.age`] = 'Umar 1–120';
      if (!r.gender) e[`${k}.gender`] = 'Gender chuniye';
      if (foodOffered && !r.foodPreference) e[`${k}.foodPreference`] = 'Khana chuniye';
    });
    return e;
  }, [rows, foodOffered]);

  const [touched, setTouched] = useState(false);
  const shownErrors = touched ? { ...localErrors, ...fieldErrors } : fieldErrors;

  const submit = async () => {
    if (!spec || busy) return;
    setTouched(true); setFormError(null);
    if (Object.keys(localErrors).length) { setFormError('Kuch details adhoori hain — laal nishaan wali jagah dekhiye.'); return; }
    setBusy(true);
    const passengers: PassengerFormInput[] = rows.map(r => ({
      name: r.name.trim().replace(/\s+/g, ' '), age: Number(r.age), gender: r.gender,
      ...(r.berthPreference ? { berthPreference: r.berthPreference } : {}),
      ...(foodOffered && r.foodPreference ? { foodPreference: r.foodPreference } : {})
    }));
    const res = await submitPassengerForm(sessionId, { passengers, expectedSessionVersion: spec.sessionVersion }).catch(() => null);
    setBusy(false);
    if (!res) { setFormError('Server se jud nahi paaye. Details save nahi hui — dobara koshish kijiye.'); return; }
    if (res.ok) { onSaved(res.passengersCount); return; }
    if (res.code === 'STALE_SESSION_VERSION') { setFormError(res.message); void load(); return; }
    const fe: Record<string, string> = {};
    for (const f of res.fieldErrors || []) fe[`${f.passengerIndex}.${f.field}`] = f.message;
    setFieldErrors(fe);
    setFormError(res.message);
  };

  const err = (i: number, f: keyof Row) => shownErrors[`${i + 1}.${f}`];

  return (
    <div className="bk-pform" role="dialog" aria-modal="true" aria-labelledby="bk-pform-title">
      <header className="bk-pform__bar">
        <button type="button" className="bk-iconbtn" onClick={onClose} aria-label="Close passenger form" disabled={busy}><IconClose size={20} /></button>
        <h2 id="bk-pform-title">Passenger details</h2>
        <span className="bk-pform__step">Step 2 of 3</span>
      </header>

      <div className="bk-pform__body">
        {!spec && !loadError && <div className="bk-meta" role="status">Form khul raha hai…</div>}
        {loadError && (
          <div className="bk-error" role="alert">
            <span className="bk-error__icon"><IconAlert size={18} /></span>
            <span className="bk-error__text">{loadError}</span>
            <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={() => void load()}>Retry</button>
          </div>
        )}

        {spec && (
          <>
            <section className="bk-card bk-pform__train" aria-label="Journey">
              <div className="bk-pform__train-top">
                <span className="bk-pform__train-icon" aria-hidden="true"><IconTrain size={18} /></span>
                <div>
                  <div className="bk-pform__train-name">{spec.train.number} {spec.train.name}</div>
                  <div className="bk-meta">
                    {[spec.train.origin && spec.train.destination ? `${spec.train.origin} → ${spec.train.destination}` : '',
                      spec.train.date ? formatDate(spec.train.date) : '',
                      spec.train.departure && spec.train.arrival ? `${spec.train.departure}–${spec.train.arrival}` : ''].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className="bk-tag bk-tag--navy">{spec.travelClass}</span>
              </div>
              {spec.train.dataSource === 'MOCK' && <div className="bk-tag bk-tag--warn" style={{ marginTop: 8 }}>Development data — not live</div>}
            </section>

            <section className="bk-pform__notes" aria-label="Train facilities">
              <div className="bk-pform__note"><IconInfo size={15} /> <span>{spec.berth.note || `Berth choice: ${spec.travelClass} ke IRCTC options. Allotment railway karti hai — preference guarantee nahi. IRCTC is train ke liye koi option na de toh woh field IRCTC par aap khud chuniye.`}</span></div>
              <div className="bk-pform__note"><IconInfo size={15} /> <span>{spec.food.note}{spec.food.source ? ` (Source: ${spec.food.source})` : ''}</span></div>
            </section>

            {rows.map((r, i) => (
              <section key={i} className="bk-card bk-pform__pax" aria-label={`Passenger ${i + 1}`}>
                <div className="bk-section-head">
                  <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><IconUsers size={17} /> Passenger {i + 1}
                    {irctcAgeCategory(r.age) && (
                      <span className={`bk-tag ${irctcAgeCategory(r.age)!.kind === 'ADULT' ? 'bk-tag--navy' : 'bk-tag--warn'}`} data-testid={`pax-${i}-category`}>{irctcAgeCategory(r.age)!.label}</span>
                    )}
                  </h3>
                  {rows.length > 1 && (
                    <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} disabled={busy}>Remove</button>
                  )}
                </div>

                <label className="bk-field">
                  <span className="bk-field__label">Name (as per ID, English letters)</span>
                  <input className={`bk-field__input${err(i, 'name') ? ' is-invalid' : ''}`} value={r.name} maxLength={40} autoComplete="off"
                    onChange={e => set(i, 'name', e.target.value)} placeholder="e.g. Rahul Sharma" aria-invalid={!!err(i, 'name')} />
                  {err(i, 'name') && <span className="bk-field__err">{err(i, 'name')}</span>}
                </label>

                <div className="bk-field-row">
                  <label className="bk-field bk-field--age">
                    <span className="bk-field__label">Age</span>
                    <input className={`bk-field__input${err(i, 'age') ? ' is-invalid' : ''}`} value={r.age} inputMode="numeric" maxLength={3}
                      onChange={e => set(i, 'age', e.target.value.replace(/\D/g, ''))} placeholder="Age" aria-invalid={!!err(i, 'age')} />
                    {err(i, 'age') && <span className="bk-field__err">{err(i, 'age')}</span>}
                  </label>
                  <div className="bk-field bk-field--grow" role="radiogroup" aria-label={`Passenger ${i + 1} gender`}>
                    <span className="bk-field__label">Gender</span>
                    <div className="bk-seg">
                      {GENDERS.map(([v, l]) => (
                        <button key={v} type="button" role="radio" aria-checked={r.gender === v} className={`bk-seg__opt${r.gender === v ? ' is-on' : ''}`} onClick={() => set(i, 'gender', v)}>{l}</button>
                      ))}
                    </div>
                    {err(i, 'gender') && <span className="bk-field__err">{err(i, 'gender')}</span>}
                  </div>
                </div>

                {irctcAgeCategory(r.age)?.note && (
                  <div className="bk-pform__note" role="note"><IconInfo size={15} /> <span>{irctcAgeCategory(r.age)!.note}</span></div>
                )}

                {berthOptions.length > 0 && (
                  <label className="bk-field">
                    <span className="bk-field__label">{berthOptions.every(o => o === 'NO_PREFERENCE' || o === 'WINDOW') ? 'Seat preference' : 'Berth preference'} ({spec.travelClass})</span>
                    <select className={`bk-field__input${err(i, 'berthPreference') ? ' is-invalid' : ''}`} value={r.berthPreference || 'NO_PREFERENCE'} onChange={e => set(i, 'berthPreference', e.target.value)}>
                      {berthOptions.map(o => <option key={o} value={o}>{BERTH_LABEL[o] || o}</option>)}
                    </select>
                    {err(i, 'berthPreference') && <span className="bk-field__err">{err(i, 'berthPreference')}</span>}
                  </label>
                )}

                {foodOffered && (
                  <div className="bk-field" role="radiogroup" aria-label={`Passenger ${i + 1} meal`}>
                    <span className="bk-field__label">Food choice</span>
                    <div className="bk-seg">
                      {spec.food.options.map(o => (
                        <button key={o} type="button" role="radio" aria-checked={r.foodPreference === o} className={`bk-seg__opt${r.foodPreference === o ? ' is-on' : ''}`} onClick={() => set(i, 'foodPreference', o)}>{FOOD_LABEL[o] || o}</button>
                      ))}
                    </div>
                    {err(i, 'foodPreference') && <span className="bk-field__err">{err(i, 'foodPreference')}</span>}
                  </div>
                )}
              </section>
            ))}

            {rows.length < spec.maxPassengers && (
              <button type="button" className="bk-btn bk-btn--ghost bk-pform__add" onClick={() => setRows(rs => [...rs, emptyRow()])} disabled={busy}>
                <IconPlus size={16} /> Add passenger ({rows.length}/{spec.maxPassengers})
              </button>
            )}
            <p className="bk-meta bk-pform__fine">Fare aur seat availability review mein railway API se dobara check hongi. Password, OTP ya payment details yahan kabhi nahi maangi jaati.</p>
          </>
        )}
      </div>

      {spec && (
        <footer className="bk-pform__foot">
          {formError && <div className="bk-pform__ferr" role="alert"><IconAlert size={15} /> {formError}</div>}
          <button type="button" className="bk-btn bk-btn--primary bk-pform__submit" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Saving…' : `Save ${rows.length} passenger${rows.length > 1 ? 's' : ''} & review`}
          </button>
        </footer>
      )}
    </div>
  );
};
