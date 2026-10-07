import { SameTrainCard } from '../components/trains/SameTrainAlternatives';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../state/chatStore';
import { createSession, sendMessage, executeBooking, reconcileBooking, fetchTurnEvents, interruptTurn, resumeSession } from '../lib/api';
import { reduceTurnEvent, EMPTY_TURN_VIEW, type TurnStreamView } from '@shared/turn-engine';
import { useConversationalVoice } from '../voice/useConversationalVoice';
import { turnEventToVoiceEvent } from '@shared/voice/voice-events';
import type { TurnProcessor, VoiceTurnEvent, VoiceTurnOutcome } from '@shared/voice/conversational-voice-agent';
import { MessageBubble } from '../components/chat/MessageBubble';
import { MicButton, voiceVisual } from '../components/voice/MicButton';
import { TrainResults } from '../components/trains/TrainCard';
import { PassengerList } from '../components/passengers/PassengerCard';
import { PassengerFormPage } from '../components/passengers/PassengerFormPage';
import { BookingReviewCard } from '../components/review/BookingReviewCard';
import { SessionInspector, type InspectorMeta } from '../components/debug/SessionInspector';
import type { VoiceTranscriptInfo } from '@shared/voice/transcript';
import { HandoffCard } from '../components/review/HandoffCard';
import { IrctcAssistPage, IrctcHandoffCard } from '../components/irctc/IrctcAssistPage';
import * as Info from '../components/trains/InfoCards';
import { Composer } from '../components/chat/Composer';
import { EmptyChat, ErrorBanner, ThinkingIndicator, QUICK_PROMPTS } from '../components/chat/ChatStates';
import { TopBar, Sheet, MobileMenu, SettingsPanel, type StatusTone } from '../components/shell/Shell';
import { HomeView } from '../components/home/HomeView';
import { TripPanel, TripSummary, tripHasContent } from '../components/context/TripPanel';
import { useAppStatus } from '../hooks/useAppStatus';
import { toolProgressLabel } from '../lib/format';

const App: React.FC = () => {
  const {
    sessionId,
    messages,
    isLoading,
    toolActivity,
    context,
    error,
    setSessionId,
    addMessage,
    setContext,
    setLoading,
    addCard,
    setToolActivity,
    setError,
    reset
  } = useChatStore();

  // UI-only state (presentation; no booking/voice logic lives here)
  const [view, setView] = useState<'home' | 'chat'>('home');
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [sheet, setSheet] = useState<null | 'menu' | 'settings' | 'trip' | 'suggest'>(null);
  const [showInspector, setShowInspector] = useState(false);
  // P38: full-screen IRCTC-style passenger form (opens only once a train + class are selected)
  const [paxForm, setPaxForm] = useState(false);
  const [irctcAssist, setIrctcAssist] = useState(false);
  const lastUserTextRef = useRef<string>('');
  const appStatus = useAppStatus();

  const [inputText, setInputText] = useState('');
  const [lastInputMode, setLastInputMode] = useState<'TEXT' | 'VOICE'>('TEXT');
  const [meta, setMeta] = useState<InspectorMeta>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Prompt 18: last streamed event seq (ordered; duplicates / out-of-order events ignored by the reducer)
  const turnViewRef = useRef<TurnStreamView>(EMPTY_TURN_VIEW);
  // Prompt 18: bumped on every mic tap (barge-in) — a reply that arrives after it is shown but never spoken
  const speechGenRef = useRef(0);

  // Prompt 18: reconnect — when the connection returns, recover the SAME session (no new session, nothing re-run)
  useEffect(() => {
    const onOnline = () => {
      if (!sessionId) return;
      resumeSession(sessionId).then((snap) => {
        if (!snap) { createSession().then((id) => setSessionId(id)); return; }
        setMeta((m) => ({ ...m, state: snap.bookingState, journeyVersion: snap.journeyVersion }));
      });
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [sessionId, setSessionId]);

  useEffect(() => {
    if (!sessionId) {
      createSession().then((id) => setSessionId(id));
    }
  }, [sessionId, setSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(
    async (text: string, mode: 'TEXT' | 'VOICE', extra: { searchResultsVersion?: number; reviewVersion?: number; bargeIn?: boolean; transcript?: VoiceTranscriptInfo } = {},
      voiceTurn?: { onEvent: (e: VoiceTurnEvent) => void }): Promise<any> => {
      // Prompt 21: a voice barge-in may start a new turn while the previous request is still in flight
      if (!text.trim() || !sessionId || (isLoading && !extra.bargeIn)) return;
      addMessage({ id: `u-${Date.now()}`, role: 'user', content: text.trim(), timestamp: Date.now(), inputMode: mode });
      lastUserTextRef.current = text.trim();
      setView('chat');
      setError(null);
      setInputText('');
      setLoading(true);
      setToolActivity(null);
      setLastInputMode(mode);
      // Prompt 18: honest progress from real tool events (no percentages). Prompt 21: in VOICE the shared
      // ConversationalVoiceAgent speaks (one ack, streamed grounded sentences) — this function only transports.
      let myTurn: string | null = null;
      let polling = true;
      const speechGen = speechGenRef.current;
      const maySpeak = () => mode === 'VOICE' && speechGen === speechGenRef.current;
      const poll = async () => {
        while (polling) {
          const r = await fetchTurnEvents(sessionId, turnViewRef.current.lastSeq).catch(() => null);
          for (const ev of r?.events || []) {
            turnViewRef.current = reduceTurnEvent(turnViewRef.current, ev);
            if (voiceTurn) {
              if (!myTurn && ev.type === 'TURN_STARTED') myTurn = ev.turnId;
              const v = ev.turnId === myTurn ? turnEventToVoiceEvent(ev) : null;
              if (v) voiceTurn.onEvent(v);
            }
          }
          if (polling && turnViewRef.current.progressText) setToolActivity(turnViewRef.current.progressText);
          if (polling) setActiveTools(turnViewRef.current.activeTools || []);
          await new Promise((res) => setTimeout(res, 350));
        }
      };
      void poll();
      try {
        const resp = await sendMessage(sessionId, text.trim(), mode, extra);
        polling = false;
        if (typeof resp.lastEventSeq === 'number' && resp.lastEventSeq > turnViewRef.current.lastSeq) turnViewRef.current = { ...turnViewRef.current, lastSeq: resp.lastEventSeq };
        // A response from an obsolete / superseded request must never be shown or spoken.
        if (resp.stale || resp.presentable === false) return resp;
        if (resp.sessionId && resp.sessionId !== sessionId) setSessionId(resp.sessionId);
        setMeta({
          state: resp.state, pendingType: resp.pendingInteraction?.type, pendingQuestion: resp.pendingQuestion,
          sessionVersion: resp.sessionVersion, searchResultsVersion: resp.searchResultsVersion,
          toolActivity: resp.toolActivity, events: resp.events, error: resp.error,
          executionCapability: resp.executionCapability,
          tools: (resp.turnLog?.toolExecutions || []).map((t: any) => ({ tool: t.tool, status: t.status, fresh: !!t.fresh, latencyMs: t.latencyMs ?? null, parallelGroup: t.parallelGroup ?? null, rejectionReason: t.rejectionReason ?? null })),
          journeyVersion: resp.turnLog?.journeyVersion,
          turn: resp.turn ? { sequence: resp.turn.sequence, status: resp.turn.status, responseType: resp.assistantTurnResponse?.type ?? null,
            grounding: resp.turnLog?.turnEngine?.groundingStatus ?? null, superseded: !!resp.turnLog?.turnEngine?.superseded, interrupted: !!resp.turnLog?.turnEngine?.interrupted } : undefined,
          conversation: resp.conversationContext ? {
            activeJourneyId: resp.conversationContext.activeJourneyId, pendingQuestion: resp.conversationContext.pendingQuestion,
            missingFields: resp.conversationContext.missingFields || [], activeBookingId: resp.conversationContext.activeBookingId,
            activePnrMasked: resp.conversationContext.activePnrMasked, resultSetId: resp.conversationContext.displayedResults?.resultSetId ?? null,
            resultCount: resp.conversationContext.displayedResults?.items?.length || 0,
            clarification: resp.assistantResponse?.clarification ?? null, rejectedClaims: resp.assistantResponse?.rejectedClaims?.length || 0
          } : undefined
        });
        if (resp.toolActivity) setToolActivity(resp.toolActivity);
        // Prompt 22: show the grounded LLM wording (assistantText); the backend reply only when it is unavailable
        addMessage({ id: `a-${Date.now()}`, role: 'assistant', content: resp.voice?.assistantText || resp.message, timestamp: Date.now() });
        setContext(resp.context);
        resp.cards.forEach((card: any) => addCard(card));
        void maySpeak;   // Prompt 21: speech is owned by the voice agent (current turn only)
        return resp;
      } catch (e: any) {
        setError(e.message || 'कुछ गलत हुआ।');
      } finally {
        polling = false;
        setLoading(false);
        setToolActivity(null);
        setActiveTools([]);
      }
    },
    [sessionId, isLoading, addMessage, setLoading, setToolActivity, setContext, addCard, setError, setSessionId]
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

  // Prompt 21: the shared ConversationalVoiceAgent — HTTP turn processor (same /api/chat pipeline as text)
  const voiceProcess: TurnProcessor = useCallback(async (text, x) => {
    speechGenRef.current += 1;
    // Prompt 34 (§2): the structured STT metadata of the FINAL transcript travels with the turn (no extra brain)
    const resp = await send(text, 'VOICE', { ...(x.bargeIn ? { bargeIn: true } : {}), ...(x.transcript ? { transcript: x.transcript } : {}) }, { onEvent: x.onEvent });
    const none: VoiceTurnOutcome = { sessionId: sessionId || '', turnId: 'none', sequence: 0, presentable: false, assistantText: '', speechText: '', segments: [], shouldSpeak: false, interruptible: true, responsePriority: 'NORMAL' };
    return (resp && resp.voice) || none;
  }, [send, sessionId]);
  const conv = useConversationalVoice({
    sessionId, processTurn: voiceProcess,
    interruptRemote: (reason) => { if (sessionId) void interruptTurn(sessionId, reason); }
  });

  // Tap-to-talk (default): a tap while the agent speaks / thinks is the barge-in (handled by the agent).
  const handleMicStart = useCallback(() => conv.listen(), [conv]);
  // P36-C: in batch tap-to-talk the stop tap is the release (submit the recording once); otherwise the one-tap stop
  const handleMicStop = useCallback(() => conv.release(), [conv]);

  const handleFormSubmit = () => {
    // Prompt 21: a typed message supersedes whatever the voice agent is still saying (never resumes)
    if (conv.snapshot.state === 'SPEAKING') conv.agent.interrupt('USER_STOP');
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

  // P42: Same Train Alternative — an explicit user request to the agent (Muse decides how to search); never automatic
  const handleSameTrain = (trainNumber: string, classCode?: string) => {
    if (conv.snapshot.state === 'SPEAKING') conv.agent.interrupt('USER_STOP');
    send(`Same Train Alternative: train ${trainNumber}${classCode ? `, class ${classCode}` : ''} — isi train mein dusre station pairs check karo`, 'TEXT');
  };

  // ───────────────────────── presentation ─────────────────────────
  const snap = conv.snapshot;
  const visual = voiceVisual({ isRecording: snap.listening, agentState: snap.state, sttPhase: conv.sttPhase, micReady: conv.micReady });
  const voiceActive = visual !== 'idle' || snap.conversationMode || !!conv.inputErrorMessage;
  const progressLabel = toolProgressLabel(activeTools, toolActivity);
  const conversation = messages.filter(m => m.id !== 'welcome');
  const hasConversation = conversation.length > 0;
  const showTrip = tripHasContent(context);

  const status: { tone: StatusTone; label: string } =
    visual === 'preparing' ? { tone: 'busy', label: 'Opening mic' } :
    visual === 'listening' ? { tone: 'busy', label: 'Listening' } :
    visual === 'transcribing' ? { tone: 'busy', label: 'Understanding' } :
    visual === 'speaking' ? { tone: 'busy', label: 'Speaking' } :
    isLoading || visual === 'thinking' ? { tone: 'busy', label: 'Thinking' } :
    appStatus.state === 'unavailable' ? { tone: 'bad', label: 'Offline' } :
    !sessionId ? { tone: 'idle', label: 'Connecting' } :
    appStatus.railwayKind === 'MOCK' ? { tone: 'warn', label: 'Dev data' } :
    { tone: 'good', label: 'Ready' };

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view === 'chat') messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [isLoading, view]);

  const focusComposer = () => setTimeout(() => document.getElementById('bk-input')?.focus(), 30);
  const prefill = (text: string) => { setInputText(text); setSheet(null); focusComposer(); };
  const pickPrompt = (text: string) => { setSheet(null); if (conv.snapshot.state === 'SPEAKING') conv.agent.interrupt('USER_STOP'); void send(text, 'TEXT'); };

  /** New chat = a fresh backend session via the existing endpoint; the old one is simply left. */
  const startNewChat = async () => {
    if (isLoading) return;
    setSheet(null);
    if (conv.snapshot.listening || conv.snapshot.state === 'SPEAKING') conv.stop();
    const id = await createSession().catch(() => null);
    if (!id) { setError('session'); return; }
    reset();
    setError(null);
    setInputText('');
    setActiveTools([]);
    turnViewRef.current = EMPTY_TURN_VIEW;
    setMeta({});
    setSessionId(id);
    setView('chat');
    focusComposer();
  };

  const ctxAny: any = context;
  const canOpenPaxForm = !!sessionId && !!ctxAny?.selectedTrain && !!ctxAny?.selectedClass && !['HANDOFF_READY', 'BOOKING_SUBMITTED', 'CONFIRMED', 'COMPLETE'].includes(String(ctxAny?.bookingState || ''));
  const openPaxForm = () => { if (canOpenPaxForm && !isLoading) { setSheet(null); setPaxForm(true); } };
  /** After the backend accepted the form, ask for the review in a VISIBLE chat turn (fare / availability re-checked by the API). */
  const onPaxSaved = (count: number) => {
    setPaxForm(false);
    void send(`Passenger details form se bhar di hain (${count} passenger${count > 1 ? 's' : ''}) — review dikhao`, 'TEXT');
  };

  const retry = lastUserTextRef.current ? () => { setError(null); void send(lastUserTextRef.current, 'TEXT'); } : undefined;

  const micLabel =
    conv.sttPhase === 'RECORDING' ? 'Send recording' :
    conv.sttPhase === 'TRANSCRIBING' ? 'Cancel transcription' :
    snap.listening ? 'Stop listening' :
    snap.state === 'SPEAKING' || snap.state === 'PROCESSING' ? 'Interrupt and speak' : 'Speak to BookKaro';

  const composerEl = (variant: 'hero' | 'dock') => (
    <Composer
      variant={variant}
      inputId={variant === 'dock' ? 'bk-input' : 'bk-hero-input'}
      value={inputText}
      onChange={setInputText}
      onSubmit={handleFormSubmit}
      inputDisabled={isLoading || (snap.listening && !snap.conversationMode)}
      sendDisabled={!inputText.trim() || isLoading}
      placeholder={variant === 'hero' ? 'Try: Amritsar se Delhi kal jaana hai…' : 'Type your journey…'}
      micSupported={snap.sttAvailable}
      micLive={snap.listening}
      onMic={snap.listening ? handleMicStop : handleMicStart}
      micLabel={micLabel}
      onPlus={variant === 'dock' ? () => setSheet('suggest') : undefined}
    />
  );

  const voicePanelEl = voiceActive ? (
    <MicButton isRecording={snap.listening} isSupported={snap.sttAvailable} onStart={handleMicStart} onStop={handleMicStop} transcript={snap.partialTranscript}
      conversationMode={snap.conversationMode} onToggleConversationMode={conv.setConversationMode} agentState={snap.state} textFallback={snap.textFallback}
      sttPhase={conv.sttPhase} micReady={conv.micReady} inputError={conv.inputErrorMessage} progressLabel={progressLabel}
      sttSource={snap.listening || conv.sttPhase !== 'IDLE' ? conv.sttSource : null}
      onRetrySpeech={snap.textFallback && snap.ttsAvailable ? () => { conv.retrySpeech(); } : undefined} />
  ) : null;

  const placeLabel = (code: string) => {
    const c: any = context;
    if (c?.origin === code && c?.originName) return c.originName;
    if (c?.destination === code && c?.destinationName) return c.destinationName;
    return code;
  };

  const renderCard = (msg: any, key: string) => {
    const d: any = msg.cardData;
    switch (msg.cardType as string) {
      case 'trains': {
        const trains = (d.trains || []).map((t: any) => ({
          trainNumber: t.trainNumber || t.number,
          trainName: t.trainName || t.name,
          origin: t.origin, destination: t.destination, departure: t.departure, arrival: t.arrival, duration: t.duration,
          runsOn: t.runsOn, retrievedAt: t.retrievedAt, provider: t.provider,
          classes: t.classes || (t.availableClasses || []).map((code: string) => ({ code, availability: null, availabilityStatus: 'UNKNOWN' as const, fare: null, fareCurrency: null }))
        }));
        const first = trains[0];
        const ctx: any = context;
        return (
          <TrainResults key={key} trains={trains} source={d.source} retrievedAt={d.retrievedAt || first?.retrievedAt}
            routeLabel={first ? `${placeLabel(first.origin)} → ${placeLabel(first.destination)}` : undefined}
            selectedTrainNumber={ctx?.selectedTrain?.number} selectedClass={ctx?.selectedClass}
            originLabel={placeLabel} disabled={isLoading}
            onSelectTrain={(n: string) => handleSelectTrain(n, d.searchResultsVersion)}
            onSelectClass={(n: string, c: string) => handleSelectClass(n, c, d.searchResultsVersion)}
            onSameTrain={appStatus.sameTrainAlternatives ? (n: string, c?: string) => handleSameTrain(n, c || (ctx?.selectedTrain?.number === n ? ctx?.selectedClass : undefined)) : undefined}
            // P42.4: verified same-train options appear by themselves under waitlisted classes of the CURRENT list only
            autoSameTrain={appStatus.sameTrainAlternatives && sessionId && typeof d.searchResultsVersion === 'number' && d.searchResultsVersion === ctx?.searchResultsVersion
              ? { sessionId, searchResultsVersion: d.searchResultsVersion, passengers: Number(ctx?.passengersCount) || 1, onHandoff: (text: string) => { void send(text, 'TEXT'); } }
              : undefined} />
        );
      }
      case 'passengers':
        return (
          <PassengerList key={key} passengers={d.passengers || []}
            onEdit={(p, i) => prefill(`Passenger ${i + 1}${p.name ? ` (${p.name})` : ''} ki details badalni hain: `)}
            onAdd={() => prefill('Ek aur passenger add karna hai: ')}
            onOpenForm={canOpenPaxForm ? openPaxForm : undefined} />
        );
      case 'review':
        return (
          <BookingReviewCard key={key}
            data={d}
            confirmable={context?.bookingState === 'AWAITING_CONFIRMATION' && !!context?.review?.valid && context?.confirmedReviewVersion === d.reviewVersion}
            onChange={() => send('change details', 'TEXT')}
            onConfirm={(v?: number) => send('haan', 'TEXT', { reviewVersion: v })}
            realBookingEnabled={appStatus.realBookingEnabled}
          />
        );
      case 'handoff': return <HandoffCard key={key} d={d} onProviderStatus={() => runExecute()} />;
      case 'irctc_handoff': return <IrctcHandoffCard key={key} d={d} onOpen={() => { setSheet(null); setIrctcAssist(true); }} />;
      case 'booking_execution': return <Info.BookingExecutionNote key={key} d={d} onReconcile={runReconcile} />;
      case 'handoff_consume': return <Info.HandoffConsumeNote key={key} d={d} />;
      case 'handoff_status': return <Info.HandoffStatusNote key={key} d={d} />;
      case 'selected_train': return <Info.SelectedTrainNote key={key} d={d} />;
      case 'selected_class': return <Info.SelectedClassNote key={key} d={d} />;
      case 'availability': return <Info.AvailabilityNote key={key} d={d} />;
      case 'same_train_alternatives': return (
        <SameTrainCard key={key} d={d} sessionId={sessionId} disabled={isLoading}
          onHandoff={(text: string) => { void send(text, 'TEXT'); }}
          onCheckAgain={() => handleSameTrain(d.trainNumber, d.travelClass)} />
      );
      case 'fare': return <Info.FareNote key={key} d={d} />;
      case 'train_info': return <Info.TrainInfoNote key={key} d={d} />;
      case 'timetable': return <Info.TimetableNote key={key} d={d} />;
      // Prompt 14: post-booking cards — backend BookingDetailsResponse / normalized lookups only (no raw provider data)
      case 'booking_details': return <Info.BookingDetailsNote key={key} d={d} />;
      case 'booking_action': return <Info.BookingActionNote key={key} d={d} />;
      case 'booking_history': return <Info.BookingHistoryNote key={key} d={d} />;
      case 'pnr_status': return <Info.PnrNote key={key} d={d} />;
      case 'live_status': return <Info.LiveStatusNote key={key} d={d} />;
      default: return null;
    }
  };

  const sheets = sheet && (
    <Sheet
      title={sheet === 'menu' ? 'Menu' : sheet === 'settings' ? 'Settings' : sheet === 'trip' ? 'Your trip' : 'Try asking'}
      onClose={() => setSheet(null)}
    >
      {sheet === 'menu' && (
        <MobileMenu onHome={() => { setSheet(null); setView('home'); }} onNewChat={startNewChat} newChatDisabled={isLoading}
          onTrip={showTrip ? () => setSheet('trip') : undefined} onSettings={() => setSheet('settings')} />
      )}
      {sheet === 'settings' && (
        <SettingsPanel
          conversationMode={snap.conversationMode} onConversationMode={conv.setConversationMode} voiceSupported={snap.sttAvailable}
          sttLabel={!snap.sttAvailable ? 'unavailable in this browser — typing works' : conv.sttPreference === 'DEVICE_FIRST' && conv.deviceSttSupported ? 'device first, enhanced as backup' : conv.batchSttEnabled ? 'enhanced' : 'device'}
          ttsAvailable={snap.ttsAvailable && !snap.textFallback}
          deviceSttSupported={conv.deviceSttSupported && conv.batchSttEnabled} deviceSttFirst={conv.sttPreference === 'DEVICE_FIRST'}
          onDeviceSttFirst={(on) => conv.setSttPreference(on ? 'DEVICE_FIRST' : 'ENHANCED_FIRST')}
          dataLabel={appStatus.railwayKind === 'REAL' ? 'Live railway data' : appStatus.railwayKind === 'MOCK' ? 'Development data — not live' : appStatus.state === 'unavailable' ? 'Service unreachable' : 'Checking…'}
          showInspector={showInspector} onInspector={setShowInspector} />
      )}
      {sheet === 'trip' && <TripSummary ctx={context} />}
      {sheet === 'suggest' && (
        <div className="bk-menu">
          {QUICK_PROMPTS.map(p => (
            <button key={p.text} type="button" className="bk-menu__item" onClick={() => pickPrompt(p.text)} disabled={isLoading}>{p.icon} {p.text}</button>
          ))}
        </div>
      )}
    </Sheet>
  );

  return (
    <div className="bk-app">
      <a href="#bk-input" className="bk-skip">Skip to message box</a>
      <TopBar
        isChat={view === 'chat'}
        status={status}
        onHome={() => setView('home')}
        onNewChat={startNewChat}
        newChatDisabled={isLoading}
        onTrip={view === 'chat' && showTrip ? () => setSheet('trip') : undefined}
        onSettings={() => setSheet('settings')}
        onMenu={() => setSheet('menu')}
      />

      {view === 'home' ? (
        <main className="bk-main">
          <HomeView
            composer={composerEl('hero')}
            voicePanel={voicePanelEl}
            onPrompt={pickPrompt}
            promptsDisabled={isLoading || !sessionId}
            status={appStatus}
            voiceAvailable={snap.sttAvailable}
            hasConversation={hasConversation}
            onResume={() => setView('chat')}
          />
        </main>
      ) : (
        <main className="bk-main">
          <div className="bk-chat">
            <div className="bk-chat__col">
              <div className="bk-chat__scroll" ref={scrollRef} aria-live="polite" aria-relevant="additions" aria-label="Conversation">
                <div className="bk-chat__thread">
                  {showInspector && <div className="bk-inspector-wrap"><SessionInspector ctx={context} meta={meta} /></div>}
                  {!hasConversation && <EmptyChat onPick={pickPrompt} disabled={isLoading || !sessionId} />}
                  {conversation.map((msg, i) =>
                    msg.role === 'card'
                      ? <div key={`${msg.id}-${i}`} className="bk-block">{renderCard(msg, `${msg.id}-${i}`)}</div>
                      : <MessageBubble key={`${msg.id}-${i}`} message={msg} />
                  )}
                  {isLoading && <ThinkingIndicator label={progressLabel} />}
                  {snap.listening && snap.partialTranscript && (
                    <div className="bk-partial" aria-live="polite"><span className="bk-dot bk-dot--busy" aria-hidden="true" /> {snap.partialTranscript}</div>
                  )}
                  {error && <ErrorBanner onRetry={retry} onDismiss={() => setError(null)} />}
                  <div ref={messagesEndRef} />
                </div>
              </div>
              <div className="bk-chat__dock">
                <div className="bk-chat__dock-inner">
                  {canOpenPaxForm && !isLoading && (
                    <div className="bk-formcta">
                      <span>{ctxAny?.selectedTrain?.number} · {ctxAny?.selectedClass} — passenger details chat / voice mein bataiye ya form mein bharein</span>
                      <button type="button" className="bk-btn bk-btn--primary bk-btn--sm" onClick={openPaxForm}>Passenger form</button>
                    </div>
                  )}
                  {voicePanelEl}
                  {composerEl('dock')}
                </div>
              </div>
            </div>
            {showTrip && <TripPanel ctx={context} />}
          </div>
        </main>
      )}
      {view === 'home' && error && (
        <div className="bk-toast"><ErrorBanner onRetry={retry} onDismiss={() => setError(null)} /></div>
      )}
      {sheets}
      {paxForm && sessionId && <PassengerFormPage sessionId={sessionId} onClose={() => setPaxForm(false)} onSaved={onPaxSaved} />}
      {irctcAssist && sessionId && <IrctcAssistPage sessionId={sessionId} onClose={() => setIrctcAssist(false)} />}
    </div>
  );
};

export default App;
