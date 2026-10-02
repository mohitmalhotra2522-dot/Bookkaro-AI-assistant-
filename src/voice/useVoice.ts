import { useCallback, useRef, useState } from 'react';

// Types for browser SpeechRecognition (not in standard TS DOM lib)
interface SpeechRecognitionEvent {
  results: {
    [index: number]: {
      [index: number]: { transcript: string; confidence: number };
      isFinal: boolean;
    };
    length: number;
  };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

/**
 * Voice hook: implements tap-to-talk STT + TTS using browser Web Speech API.
 * No background listening, no hidden recording, explicit user activation only.
 * All transcribed text goes through the same message pipeline as typed text,
 * so state is perfectly preserved across voice/text switching.
 */
export function useVoice() {
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const getRecognition = useCallback((): SpeechRecognitionInstance | null => {
    if (recognitionRef.current) return recognitionRef.current;
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('आपके ब्राउज़र में voice recognition support नहीं है। कृपया type करके बात करें।');
      return null;
    }
    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'hi-IN'; // Hindi + English mixed support
    recognitionRef.current = rec;
    return rec;
  }, []);

  const startRecording = useCallback(
    (onFinalTranscript: (text: string) => void) => {
      setError(null);
      setTranscript('');
      const rec = getRecognition();
      if (!rec) return;

      rec.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i][0];
          if (event.results[i].isFinal) {
            finalTranscript += result.transcript;
          } else {
            interimTranscript += result.transcript;
          }
        }
        setTranscript(finalTranscript || interimTranscript);
        if (finalTranscript.trim()) {
          onFinalTranscript(finalTranscript.trim());
        }
      };
      rec.onerror = (e) => {
        setError('Voice recognition error. Aap type kar ke message bhej sakte hain.');
        setIsRecording(false);
      };
      rec.onend = () => {
        setIsRecording(false);
      };

      try {
        rec.start();
        setIsRecording(true);
      } catch (e) {
        setError('माइक्रोफोन शुरू नहीं हो सका।');
        setIsRecording(false);
      }
    },
    [getRecognition]
  );

  const stopRecording = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      rec.stop();
    }
    setIsRecording(false);
  }, []);

  const speak = useCallback((text: string) => {
    // TTS fails gracefully: if unavailable, text still appears in chat
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'hi-IN';
      utter.rate = 1.0;
      utter.pitch = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) {
      // Silent failure - text is already visible to user
    }
  }, []);

  const cancelSpeak = useCallback(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  return {
    isRecording,
    transcript,
    error,
    startRecording,
    stopRecording,
    speak,
    cancelSpeak,
    isSupported: typeof window !== 'undefined' && !!(
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    )
  };
}
