import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../state/chatStore';
import { createSession, sendMessage, executeBooking, reconcileBooking } from '../lib/api';
import { useVoice } from '../voice/useVoice';
import { MessageBubble } from '../components/chat/MessageBubble';
import { MicButton } from '../components/voice/MicButton';
import { TrainCard, SearchStatus, ProviderErrorCard } from '../components/trains/TrainCard';
import { PassengerCard } from '../components/passengers/PassengerCard';
import { BookingReviewCard } from '../components/review/BookingReviewCard';
import { SessionInspector, type InspectorMeta } from '../components/debug/SessionInspector';

const App: React.FC = () => {
  const {
    sessionId,
    messages,
    isLoading,
    toolActivity,
    context,
    setSessionId,
    addMessage,
    setContext,
    setLoading,
    addCard,
    setToolActivity,
    setError
  } = useChatStore();

  const [inputText, setInputText] = useState('');
  const [lastInputMode, setLastInputMode] = useState<'TEXT' | 'VOICE'>('TEXT');
  const [meta, setMeta] = useState<InspectorMeta>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const voice = useVoice();

  useEffect(() => {
    if (!sessionId) {
      createSession().then((id) => setSessionId(id));
    }
  }, [sessionId, setSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(
    async (text: string, mode: 'TEXT' | 'VOICE', extra: { searchResultsVersion?: number; reviewVersion?: number } = {}) => {
      if (!text.trim() || !sessionId || isLoading) return;
      addMessage({ id: `u-${Date.now()}`, role: 'user', content: text.trim(), timestamp: Date.now(), inputMode: mode });
      setInputText('');
      setLoading(true);
      setToolActivity(null);
      setLastInputMode(mode);
      try {
        const resp = await sendMessage(sessionId, text.trim(), mode, extra);
        // A response from an obsolete request must never be shown or spoken.
        if (resp.stale) return;
        if (resp.sessionId && resp.sessionId !== sessionId) setSessionId(resp.sessionId);
        setMeta({
          state: resp.state, pendingType: resp.pendingInteraction?.type, pendingQuestion: resp.pendingQuestion,
          sessionVersion: resp.sessionVersion, searchResultsVersion: resp.searchResultsVersion,
          toolActivity: resp.toolActivity, events: resp.events, error: resp.error,
          executionCapability: resp.executionCapability
        });
        if (resp.toolActivity) setToolActivity(resp.toolActivity);
        addMessage({ id: `a-${Date.now()}`, role: 'assistant', content: resp.message, timestamp: Date.now() });
        setContext(resp.context);
        resp.cards.forEach((card: any) => addCard(card));
        if (mode === 'VOICE') {
          voice.speak(resp.message);
        }
      } catch (e: any) {
        setError(e.message || 'कुछ गलत हुआ।');
      } finally {
        setLoading(false);
        setToolActivity(null);
      }
    },
    [sessionId, isLoading, addMessage, setLoading, setToolActivity, setContext, addCard, voice, setError, setSessionId]
  );

  /** Explicit, user-initiated execution request (gateway → provider registry). Disabled provider in this build. */
  const runExecute = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await executeBooking(sessionId);
      addMessage({ id: `a-${Date.now()}`, role: 'assistant', content: r.message, timestamp: Date.now() });
      (r.cards || []).forEach((card: any) => addCard(card));
    } catch (e: any) {
      setError(e.message || 'Handoff status check nahi ho paaya.');
    }
  }, [sessionId, addMessage, addCard, setError]);

  /** Prompt 13: explicit status verification — provider status lookup only, never a new booking. */
  const runReconcile = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await reconcileBooking(sessionId);
      addMessage({ id: `a-${Date.now()}`, role: 'assistant', content: r.message, timestamp: Date.now() });
      (r.cards || []).forEach((card: any) => addCard(card));
    } catch (e: any) {
      setError(e.message || 'Booking status verify nahi ho paaya.');
    }
  }, [sessionId, addMessage, addCard, setError]);

  const handleMicStart = useCallback(() => {
    voice.cancelSpeak();
    voice.startRecording((transcript) => {
      send(transcript, 'VOICE');
    });
  }, [voice, send]);

  const handleMicStop = useCallback(() => voice.stopRecording(), [voice]);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(inputText, 'TEXT');
  };

  // Card taps carry the searchResultsVersion they were rendered from, so a tap
  // on an outdated list is rejected server-side (STALE_SEARCH_REFERENCE).
  const handleSelectTrain = (trainNumber: string, version?: number) => {
    send(`${trainNumber} wali`, 'TEXT', { searchResultsVersion: version });
  };

  const handleSelectClass = (trainNumber: string, classCode: string, version?: number) => {
    send(`${trainNumber} ${classCode}`, 'TEXT', { searchResultsVersion: version });
  };

  const chip = (bg: string, fg: string, content: React.ReactNode, key: string) => (
    <div key={key} style={{ margin: '4px 16px', padding: '8px 12px', background: bg, color: fg, borderRadius: 10, fontSize: 13 }}>{content}</div>
  );

  return (
    <div style={{ height: '100dvh', maxWidth: 600, margin: '0 auto', background: '#f5f7fa', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px', background: '#1976d2', color: '#fff', fontWeight: 700, fontSize: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>🚆 Railway AI Assistant</div>
        <div style={{ fontSize: 10, opacity: 0.85, background: 'rgba(255,255,255,0.2)', padding: '4px 8px', borderRadius: 8 }}>
          MOCK DEV DATA
        </div>
      </div>

      <SessionInspector ctx={context} meta={meta} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0 20px' }}>
        {messages.map(msg => {
          if (msg.role === 'card') {
            if (msg.cardType === 'trains') {
              const trains = msg.cardData.trains || [];
              return (
                <div key={msg.id}>
                  <SearchStatus label={`🚂 ${trains.length} trains found · list v${msg.cardData.searchResultsVersion ?? '?'}`} />
                  {trains.map((t: any) => (
                    <TrainCard
                      key={t.trainNumber || t.number}
                      train={{
                        trainNumber: t.trainNumber || t.number,
                        trainName: t.trainName || t.name,
                        origin: t.origin,
                        destination: t.destination,
                        departure: t.departure,
                        arrival: t.arrival,
                        duration: t.duration,
                        classes: t.classes || (t.availableClasses || []).map((code: string) => ({
                          code, availability: null, availabilityStatus: 'UNKNOWN' as const, fare: null, fareCurrency: null
                        }))
                      }}
                      onSelectTrain={(n: string) => handleSelectTrain(n, msg.cardData.searchResultsVersion)}
                      onSelectClass={(n: string, c: string) => handleSelectClass(n, c, msg.cardData.searchResultsVersion)}
                    />
                  ))}
                  {msg.cardData.source === 'mock' && (
                    <div style={{ padding: '4px 16px', fontSize: 11, color: '#9e9e9e', textAlign: 'center' }}>* यह डेवलपमेंट मॉक डेटा है लाइव डेटा नहीं</div>
                  )}
                </div>
              );
            }
            if (msg.cardType === 'passengers') {
              return (
                <div key={msg.id}>
                  <div style={{ padding: '8px 16px', fontSize: 13, color: '#2e7d32', fontWeight: 500 }}>👥 Passenger Details</div>
                  {msg.cardData.passengers.map((p: any, i: number) => <PassengerCard key={p.id} passenger={p} index={i} />)}
                </div>
              );
            }
            if (msg.cardType === 'review') {
              return (
                <div key={msg.id}>
                  <BookingReviewCard
                    data={msg.cardData}
                    confirmable={context?.bookingState === 'AWAITING_CONFIRMATION' && !!context?.review?.valid && context?.confirmedReviewVersion === msg.cardData.reviewVersion}
                    onChange={() => send('change details', 'TEXT')}
                    onConfirm={(v?: number) => send('haan', 'TEXT', { reviewVersion: v })}
                  />
                </div>
              );
            }
            if (msg.cardType === 'handoff') {
              const bx: any = msg.cardData.bookingExecution;
              const ex: any = bx?.execution;
              const confirmed = ex?.status === 'CONFIRMED';
              return (
                <div key={msg.id} style={{ margin: '8px 16px', padding: 16, background: '#e8f5e9', borderRadius: 12, textAlign: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#2e7d32', marginBottom: 6 }}>{confirmed ? '✅ Booking provider ne confirm kiya' : ex?.submitted ? `⏳ Booking provider: ${ex.status}` : '📝 Booking details ready · real booking disabled'} (v{msg.cardData.reviewVersion})</div>
                  <div style={{ fontSize: 13, color: '#424242' }}>{msg.cardData.message}</div>
                  {msg.cardData.handoffId && (
                    <div style={{ fontSize: 11, color: '#616161', marginTop: 8, fontFamily: 'monospace' }}>
                      handoff {msg.cardData.handoffId} · {msg.cardData.handoffStatus} · executor: {msg.cardData.executorName} → {msg.cardData.executionStatus}
                      {msg.cardData.expiresAt ? ` · valid till ${new Date(msg.cardData.expiresAt).toLocaleTimeString()}` : ''}{msg.cardData.duplicate ? ' · duplicate (no new handoff)' : ''}
                    </div>
                  )}
                  {msg.cardData.handoffSessionId && (
                    <div style={{ fontSize: 11, color: '#616161', marginTop: 4, fontFamily: 'monospace' }}>
                      session {msg.cardData.handoffSessionId.slice(0, 11)}… · {msg.cardData.handoffSessionStatus}
                      {msg.cardData.handoffSessionExpiresAt ? ` · expires ${new Date(msg.cardData.handoffSessionExpiresAt).toLocaleTimeString()}` : ''}
                      {' · executor '}{msg.cardData.executorCapability?.executorName} ({msg.cardData.executorCapability?.enabled ? 'enabled' : 'disabled'}, real booking: {msg.cardData.executorCapability?.supportsRealBooking ? 'yes' : 'no'})
                    </div>
                  )}
                  {bx && (
                    <div style={{ fontSize: 11, color: '#616161', marginTop: 4, fontFamily: 'monospace' }}>
                      provider {bx.provider?.providerName} ({bx.provider?.available ? 'available' : 'unavailable'}, health {bx.provider?.health}) · {bx.code}
                      {ex?.providerReference ? ` · ref ${ex.providerReference}` : ''}
                    </div>
                  )}
                  {confirmed && ex?.pnr && <div style={{ fontSize: 14, fontWeight: 700, color: '#1b5e20', marginTop: 6 }}>PNR {ex.pnr}</div>}
                  {msg.cardData.handoffSessionId && !ex?.submitted && (
                    <button
                      onClick={() => runExecute()}
                      style={{ marginTop: 10, padding: '6px 14px', borderRadius: 8, border: '1px solid #9e9e9e', background: '#fafafa', color: '#616161', fontSize: 12, cursor: 'pointer' }}
                    >
                      Booking provider status
                    </button>
                  )}
                </div>
              );
            }
            const d: any = msg.cardData;
            if (msg.cardType === ('booking_execution' as any)) return (
              <div key={msg.id}>
                {chip(d.execution?.status === 'CONFIRMED' ? '#e8f5e9' : d.execution?.unresolved ? '#fff8e1' : '#eceff1', '#37474f', <>🔒 Booking provider <b>{d.execution?.providerName || d.provider?.providerName}</b>: <b>{d.execution?.status || d.code}</b>{d.duplicate ? ' · duplicate (no new request)' : ''}{d.execution?.status === 'CONFIRMED' && d.execution?.pnr ? <> · PNR <b>{d.execution.pnr}</b></> : ''}{d.manualVerificationRequired ? ' · manual provider verification required' : ''}{d.execution?.reconciliationAttempts ? ` · status checks: ${d.execution.reconciliationAttempts}` : ''}</>, msg.id + '-c')}
                {d.execution?.unresolved && (
                  <div style={{ margin: '0 16px 8px' }}>
                    <button onClick={runReconcile} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 16, border: '1px solid #f9a825', background: '#fffde7', color: '#5d4037', cursor: 'pointer' }}>Status verify karein</button>
                  </div>
                )}
              </div>
            );
            if (msg.cardType === ('handoff_consume' as any)) return chip('#eceff1', '#37474f', <>🔒 Handoff execution: <b>{d.code}</b>{d.duplicate ? ' · duplicate (no new attempt)' : ''} · executor {d.executorName || 'none'} ({d.executorEnabled ? 'enabled' : 'disabled'}) · real booking: no</>, msg.id);
            if (msg.cardType === ('handoff_status' as any)) return chip('#fff3e0', '#e65100', <>⚠️ Handoff {d.handoffId} <b>{d.status}</b> ({d.reason}) — naya review confirm karna hoga</>, msg.id);
            if (msg.cardType === ('selected_train' as any)) return chip('#e3f2fd', '#0d47a1', <>🚆 Selected: <b>{d.trainNumber}</b> {d.trainName}</>, msg.id);
            if (msg.cardType === ('selected_class' as any)) return chip('#e3f2fd', '#0d47a1', <>🎫 Class: <b>{d.classCode}</b></>, msg.id);
            if (msg.cardType === ('availability' as any)) return chip('#fff8e1', '#795548', <>📊 {d.trainNumber} {d.travelClass} availability: <b>{d.status}</b> <span style={{ opacity: 0.7 }}>({d.date})</span></>, msg.id);
            if (msg.cardType === ('fare' as any)) return chip('#f1f8e9', '#33691e', <>💰 {d.trainNumber} {d.travelClass}: ₹{d.perPassenger} × {d.passengersCount} = <b>₹{d.total}</b></>, msg.id);
            if (msg.cardType === ('train_info' as any)) return chip('#ede7f6', '#4527a0', <>ℹ️ {d.trainNumber} {d.trainName}: {d.departure} → {d.arrival} ({d.duration})</>, msg.id);
            if (msg.cardType === ('timetable' as any)) return chip('#ede7f6', '#4527a0', <>🕒 {(d || []).map((x: any) => `${x.station} ${x.departure || x.arrival}`).join(' → ')}</>, msg.id);
            // Prompt 14: post-booking cards — backend BookingDetailsResponse / normalized lookups only (no raw provider data)
            if (msg.cardType === ('booking_details' as any)) return chip(d.status === 'CONFIRMED' ? '#e8f5e9' : d.status === 'FAILED' || d.status === 'CANCELLED' ? '#ffebee' : '#fff8e1', '#37474f', <>🧾 <b>{d.train?.trainNumber}</b> {d.journey?.origin} → {d.journey?.destination} · {d.journeyDate} · {d.travelClass} · {d.passengersCount} pax · <b>{d.statusLabel}</b> · PNR {d.pnr ? <b>{d.pnr}</b> : d.pnrMasked ? d.pnrMasked : 'not available'}</>, msg.id);
            if (msg.cardType === ('booking_history' as any)) return chip('#eceff1', '#37474f', <>🗂️ {(d.bookings || []).map((b: any) => `${b.train?.trainNumber} ${b.journey?.origin}→${b.journey?.destination} ${b.journeyDate} (${b.statusLabel})`).join(' · ') || 'Koi booking nahi'}</>, msg.id);
            if (msg.cardType === ('pnr_status' as any)) return chip('#e3f2fd', '#0d47a1', <>🎟️ PNR {d.pnrMasked}: <b>{d.pnrStatus}</b>{d.chartStatus ? ` · chart: ${d.chartStatus}` : ''}{(d.passengers || []).map((p: any) => ` · P${p.number}: ${p.currentStatus}`).join('')} <span style={{ opacity: 0.7 }}>({d.dataSource === 'MOCK' ? 'mock / non-live' : 'fetched now'})</span></>, msg.id);
            if (msg.cardType === ('live_status' as any)) return chip('#e0f2f1', '#004d40', <>📍 {d.trainNumber}: <b>{d.currentStatus}</b>{d.currentStationName || d.currentStationCode ? ` · ${d.currentStationName || d.currentStationCode}` : ''}{typeof d.delayMinutes === 'number' ? ` · ${d.delayMinutes} min late` : ''} <span style={{ opacity: 0.7 }}>({d.dataSource === 'MOCK' ? 'mock / non-live' : 'fetched now'})</span></>, msg.id);
            return null;
          }
          return <MessageBubble key={msg.id} message={msg} />;
        })}

        {isLoading && (
          <div style={{ padding: '0 16px', marginBottom: 12, display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ padding: '12px 16px', borderRadius: '18px 18px 18px 4px', background: '#fff', fontSize: 14, color: '#9e9e9e' }}>
              {toolActivity || 'Railway tools check kar raha hoon…'}
            </div>
          </div>
        )}

        {voice.isRecording && voice.transcript && (
          <div style={{ margin: '8px 16px', padding: '10px 14px', background: '#e3f2fd', borderRadius: 12, fontSize: 14, color: '#1565c0' }}>🎙️ {voice.transcript}</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ borderTop: '1px solid #e0e0e0', background: '#fff', paddingBottom: 8 }}>
        <MicButton isRecording={voice.isRecording} isSupported={voice.isSupported} onStart={handleMicStart} onStop={handleMicStop} transcript={voice.transcript} />
        <form onSubmit={handleFormSubmit} style={{ display: 'flex', gap: 8, padding: '0 16px' }}>
          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="Type a message..."
            disabled={isLoading || voice.isRecording}
            style={{ flex: 1, padding: '12px 16px', borderRadius: 24, border: '1px solid #e0e0e0', fontSize: 15, outline: 'none', background: '#fafafa' }}
          />
          <button
            type="submit"
            disabled={!inputText.trim() || isLoading}
            style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: inputText.trim() ? '#1976d2' : '#bdbdbd', color: '#fff', fontSize: 18, cursor: inputText.trim() ? 'pointer' : 'not-allowed' }}
          >➤</button>
        </form>
      </div>
    </div>
  );
};

export default App;
