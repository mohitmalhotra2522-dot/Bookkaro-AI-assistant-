import { create } from 'zustand';
import type { ChatMessage, BookingSession } from '@shared/entities';

interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  context: BookingSession | null;
  isLoading: boolean;
  isRecording: boolean;
  toolActivity: string | null;
  error: string | null;
  setSessionId: (id: string) => void;
  addMessage: (msg: ChatMessage) => void;
  setContext: (ctx: BookingSession) => void;
  setLoading: (loading: boolean) => void;
  setRecording: (recording: boolean) => void;
  setToolActivity: (activity: string | null) => void;
  setError: (error: string | null) => void;
  addCard: (card: { type: string; data: any }) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>(set => ({
  sessionId: null,
  messages: [
    { id: 'welcome', role: 'assistant', content: 'Namaste! Main Railway AI Assistant hoon. Aap kaha jaana chahte hain?', timestamp: Date.now() }
  ],
  context: null,
  isLoading: false,
  isRecording: false,
  toolActivity: null,
  error: null,
  setSessionId: id => set({ sessionId: id }),
  addMessage: msg => set(s => ({ messages: [...s.messages, msg] })),
  setContext: ctx => set({ context: ctx }),
  setLoading: loading => set({ isLoading: loading }),
  setRecording: recording => set({ isRecording: recording }),
  setToolActivity: activity => set({ toolActivity: activity }),
  setError: error => set({ error }),
  addCard: card =>
    set(s => ({
      messages: [
        ...s.messages,
        { id: `card-${Date.now()}`, role: 'card', content: '', timestamp: Date.now(), cardType: card.type as any, cardData: card.data }
      ]
    })),
  reset: () =>
    set({
      messages: [
        { id: 'welcome', role: 'assistant', content: 'Namaste! Main Railway AI Assistant hoon. Aap kaha jaana chahte hain?', timestamp: Date.now() }
      ],
      context: null,
      isLoading: false,
      toolActivity: null
    })
}));
