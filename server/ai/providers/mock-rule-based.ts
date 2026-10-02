import type { AIProvider, AIProviderConfig, TurnInput } from './ai-provider';
import { Intent, type AIResponse, type Action } from '@shared/intents';
import { BookingState } from '@shared/states';
import { STATION_ALIASES } from '@shared/constants';

/**
 * Deterministic rule-based AI provider (development).
 * Implements natural Hinglish conversation — asks ONLY for missing fields,
 * handles partial multi-field inputs, field updates, preferences; keeps
 * responses short/one-question-at-a-time for voice.
 */
export class MockRuleBasedAIProvider implements AIProvider {
  readonly providerId = 'mock-rule-based';
  private config?: AIProviderConfig;

  async init(config: AIProviderConfig): Promise<void> {
    this.config = config;
  }

  async generateStructuredAction(input: TurnInput): Promise<AIResponse> {
    const rawText = input.userText.trim();
    const text = rawText.toLowerCase();
    const { currentState, context } = input;
    const s = context;

    // Detect explicit confirmation phrases (only valid at REVIEW/AWAITING)
    const confirmPhrases = ['haan', 'yes', 'confirm', 'continue', 'book it', 'sab sahi hai', 'kar do', 'thik hai', 'theek hai', 'ji haan'];
    const changePhrases = ['change', 'badal', 'edit', 'galat hai', 'nahi chahiye', 'dusri', 'replace'];

    switch (currentState) {
      case BookingState.IDLE:
        return this.parseJourneyInput(rawText, s);

      case BookingState.COLLECTING_JOURNEY:
      case BookingState.COLLECTING_DATE:
      case BookingState.COLLECTING_PASSENGERS:
        return this.handleCollecting(rawText, text, s, currentState);

      case BookingState.SEARCHING_TRAINS:
        return { message: 'ट्रेनें खोजी जा रही हैं…', action: { type: Intent.SHOW_RESULTS } };

      case BookingState.SHOWING_TRAINS:
        if (changePhrases.some(p => text.includes(p))) {
          return this.parseChangeRequest(text, s);
        }
        return this.handleTrainSelect(rawText, text, s);

      case BookingState.TRAIN_SELECTED:
        return { message: 'उपलब्ध क्लासेस चेक की जा रही हैं…', action: { type: Intent.SELECT_TRAIN } };

      case BookingState.CLASS_SELECTED:
        return { message: 'किराया चेक किया जा रहा है…', action: { type: Intent.SELECT_CLASS } };

      case BookingState.BOOKING_PREPARE:
        return { message: 'Passenger details collect kar rahe hain.', action: { type: Intent.ADD_PASSENGER, payload: { begin: true } } };

      case BookingState.COLLECTING_PASSENGER_DETAILS:
        if (changePhrases.some(p => text.includes(p))) {
          return this.handlePassengerChange(text, s);
        }
        return this.handlePassengerField(rawText, s);

      case BookingState.PASSENGERS_READY:
        return { message: 'समरी तैयार की जा रही है…', action: { type: Intent.REVIEW_BOOKING } };

      case BookingState.REVIEW: {
        if (confirmPhrases.some(p => text.includes(p))) {
          return { message: 'पक्का confirm करें: booking continue karun?', action: { type: Intent.CONFIRM_BOOKING, payload: { step: 'first' } } };
        }
        // Detect destination change by looking for a resolvable station token in text
        const newStation = this.findStationInText(rawText);
        if (newStation) {
          return { message: `ठीक है, destination बदलकर ${newStation.name} कर रहा हूं। नई search कर रहा हूं।`, action: { type: Intent.PROVIDE_FIELD, payload: { updates: { destination: newStation.code, destinationName: newStation.name } } } };
        }
        if (changePhrases.some(p => text.includes(p)) || text.includes('change') || text.includes('badal')) {
          return { message: 'Kya change karna hai? (date/train/class/passenger)', action: { type: Intent.CHANGE_BOOKING_DETAIL } };
        }
        return { message: 'Sab details theek hain? Change karna hai ya continue karun?', action: { type: Intent.ASK_FIELD, payload: { field: 'confirmation' } } };
      }

      case BookingState.AWAITING_CONFIRMATION:
        if (confirmPhrases.some(p => text.includes(p))) {
          return { message: 'ठीक है। IRCTC handoff ready kar rahe hain.', action: { type: Intent.CONFIRM_BOOKING, payload: { step: 'final' } } };
        }
        return { message: 'अंतिम बार confirm karein ya details change karein?', action: { type: Intent.ASK_FIELD, payload: { field: 'finalConfirmation' } } };

      case BookingState.IRCTC_HANDOFF_READY:
        return { message: 'आपकी booking details ready हैं। भविष्य में IRCTC handoff connect होगा।', action: { type: Intent.HANDOFF_TO_IRCTC } };

      default:
        return { message: 'Main aapki madad kar sakti hoon. Journey details batayein.', action: { type: Intent.ASK_FIELD, payload: { field: 'journey' } } };
    }
  }

  private parseStation(raw: string): { code: string; name: string } | null {
    const key = raw.toLowerCase().trim();
    return STATION_ALIASES[key] || null;
  }

  private parseDate(text: string): string | null {
    if (text.includes('kal')) return '2026-10-03';
    if (text.includes('aaj') || text.includes('today')) return '2026-10-02';
    const d = text.match(/(\d{1,2})\s*(october|oct)/i);
    if (d) {
      const day = parseInt(d[1], 10);
      return `2026-10-${String(day).padStart(2, '0')}`;
    }
    const iso = text.match(/2026-\d{2}-\d{2}/);
    if (iso) return iso[0];
    return null;
  }

  private parsePassengerCount(text: string): number | null {
    if (/\b(ek|1)\b/.test(text)) return 1;
    if (/\b(do|2)\b/.test(text)) return 2;
    if (/\b(teen|3)\b/.test(text)) return 3;
    if (/\b(char|4)\b/.test(text)) return 4;
    if (/\b(paanch|5)\b/.test(text)) return 5;
    return null;
  }

  private parseClassPref(text: string): 'AC' | 'NON_AC' | 'ANY' | null {
    if (text.includes('non ac') || text.includes('non-ac')) return 'NON_AC';
    if (text.includes('ac')) return 'AC';
    if (text.includes('koi bhi') || text.includes('any')) return 'ANY';
    return null;
  }

  private parseTimePref(text: string): 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | 'ANY' | null {
    if (text.includes('morning') || text.includes('subah') || text.includes('jaldi') || text.includes('jaldi pahucha')) return 'MORNING';
    if (text.includes('afternoon') || text.includes('dopahar')) return 'AFTERNOON';
    if (text.includes('evening') || text.includes('shaam')) return 'EVENING';
    if (text.includes('night') || text.includes('raat')) return 'NIGHT';
    return null;
  }

  private parseJourneyInput(raw: string, s: any): AIResponse {
    const text = raw.toLowerCase();
    const updates: any = {};
    let qOrigin: string | null = null;
    let qDest: string | null = null;

    // "X se Y" pattern (with or without jaana hai)
    const seMatch = text.match(/([a-z\s]+?)\s+se\s+([a-z\s]+?)(\s+(jana|jaana|jana hai|jaana hai|jana chahenge|jana chahta|jana chahti))?$/i);
    if (seMatch) {
      const originRaw = seMatch[1].trim();
      // destination = first word after se (e.g., "delhi jana hai" → delhi)
      const destRaw = seMatch[2].trim().split(/\s+/)[0];
      const o = this.parseStation(originRaw);
      const d = this.parseStation(destRaw);
      if (o && d) {
        updates.origin = o.code;
        updates.originName = o.name;
        updates.destination = d.code;
        updates.destinationName = d.name;
      } else {
        if (!o) qOrigin = 'source';
        if (!d) qDest = 'destination';
      }
    } else {
      // May be just a fragment ("Amritsar se Delhi", etc.) — try looser match
      const loose = text.match(/(amritsar|asr|ludhiana|ldh|delhi|ndls|new delhi)\s+se\s+(amritsar|asr|ludhiana|ldh|delhi|ndls|new delhi)/i);
      if (loose) {
        const o = this.parseStation(loose[1]);
        const d = this.parseStation(loose[2]);
        if (o && d) { updates.origin = o.code; updates.originName = o.name; updates.destination = d.code; updates.destinationName = d.name; }
      }
    }

    // Handle change: "Delhi nahi, Ludhiana jana hai"
    const destChange = text.match(/(nahi|instead)\s*,?\s*([a-z\s]+?)\s+(jana|jana hai|jaana)/i);
    if (destChange) {
      const d = this.parseStation(destChange[2].trim().split(/\s+/)[0]);
      if (d) {
        updates.destination = d.code;
        updates.destinationName = d.name;
      }
    }

    const d = this.parseDate(text); if (d) updates.date = d;
    const c = this.parsePassengerCount(text);
    if (c && !d && !updates.origin && !updates.destination) updates.passengerCount = c;
    const cp = this.parseClassPref(text); if (cp) updates.preferredClass = cp;
    const tp = this.parseTimePref(text); if (tp) updates.preferredTime = tp;

    // If no fields recognized yet
    if (Object.keys(updates).length === 0) {
      return { message: 'Namaste! Main railway booking assistant hoon. Aap kaha jaana chahte hain?', action: { type: Intent.ASK_FIELD, payload: { field: 'journey' } } };
    }

    return { message: '', action: { type: Intent.PROVIDE_FIELD, payload: { updates } } };
  }

  private handleCollecting(raw: string, text: string, s: any, state: string): AIResponse {
    // Extract all recognized fields from this one turn
    const updates: any = {};
    const seMatch = text.match(/([a-z\s]+?)\s+se\s+([a-z\s]+)/i);
    if (seMatch) {
      const o = this.parseStation(seMatch[1].trim());
      const destRaw = seMatch[2].trim().split(/\s+/)[0];
      const d = this.parseStation(destRaw);
      if (o) { updates.origin = o.code; updates.originName = o.name; }
      if (d) { updates.destination = d.code; updates.destinationName = d.name; }
    }
    const date = this.parseDate(text); if (date && !s.date) updates.date = date;
    // Only treat a number/word as passenger count if no date/route was found in this turn
    const pcount = this.parsePassengerCount(text);
    if (pcount && !s.passengersCount && !date && !updates.origin && !updates.destination) {
      updates.passengerCount = pcount;
    }
    const cp = this.parseClassPref(text); if (cp && !s.preferredClass) updates.preferredClass = cp;
    const tp = this.parseTimePref(text); if (tp && !s.preferredTime) updates.preferredTime = tp;

    // Merge with existing values to determine what's still missing
    const origin = updates.origin || s.origin;
    const destination = updates.destination || s.destination;
    const dateVal = updates.date || s.date;
    const pax = updates.passengerCount ?? s.passengersCount;
    const cls = updates.preferredClass ?? s.preferredClass;

    if (Object.keys(updates).length > 0) {
      // If we now have everything, trigger search
      if (origin && destination && dateVal && pax) {
        return { message: 'Main trains check kar raha hoon.', action: { type: Intent.SEARCH_TRAINS, payload: { updates } } };
      }
      if (!origin) return { message: 'Kaha se nikalna hai?', action: { type: Intent.PROVIDE_FIELD, payload: { updates } } };
      if (!destination) return { message: 'Kaha jaana hai?', action: { type: Intent.PROVIDE_FIELD, payload: { updates } } };
      if (!dateVal) return { message: 'Kis date ko jaana hai?', action: { type: Intent.PROVIDE_FIELD, payload: { updates } } };
      if (!pax) return { message: 'Kitne passengers hain?', action: { type: Intent.PROVIDE_FIELD, payload: { updates } } };
    }

    // Even without new explicit updates, if we have everything now (e.g. previous turns filled it), search
    if (origin && destination && dateVal && pax) {
      return { message: 'Main trains check kar raha hoon.', action: { type: Intent.SEARCH_TRAINS, payload: { updates } } };
    }

    // No new fields parsed — ask the next missing question
    if (!origin) return { message: 'Kaha se nikalna hai?', action: { type: Intent.ASK_FIELD, payload: { field: 'origin' } } };
    if (!destination) return { message: 'Kaha jaana hai?', action: { type: Intent.ASK_FIELD, payload: { field: 'destination' } } };
    if (!dateVal) return { message: 'Kis date ko jaana hai?', action: { type: Intent.ASK_FIELD, payload: { field: 'date' } } };
    if (!pax) return { message: 'Kitne passengers hain?', action: { type: Intent.ASK_FIELD, payload: { field: 'passengers' } } };

    // All core fields present but class preference asked
    if (!cls) {
      return { message: 'AC train chahiye ya non-AC?', action: { type: Intent.PROVIDE_FIELD, payload: { updates } } };
    }

    return { message: 'Main trains check kar raha hoon.', action: { type: Intent.SEARCH_TRAINS, payload: { updates } } };
  }

  private handleTrainSelect(raw: string, text: string, s: any): AIResponse {
    const m = raw.match(/(\d{4,5})/);
    if (m) {
      const num = m[1];
      // Find matching train by number (handles -LDH slip variants)
      const found = s.availableTrains.find((t: any) => t.number === num || t.number.startsWith(num + '-'));
      if (found) {
        const classList = found.classes.map((c: any) => c.code).join(', ');
        const firstClass = found.classes[0];
        return {
          message: `${found.name} select hui. Isme ${classList} available hain. ${firstClass.code} book karni hai?`,
          action: { type: Intent.SELECT_TRAIN, payload: { trainNumber: found.number } }
        };
      }
    }
    return { message: 'Kripya list mein se ek train select karein ya train number batayein.', action: { type: Intent.ASK_FIELD, payload: { field: 'train' } } };
  }

  private parseChangeRequest(text: string, _s: any): AIResponse {
    // Routes back to appropriate collection state based on what user asks to change
    if (text.includes('date')) return { message: 'Nayi date batayein?', action: { type: Intent.CHANGE_BOOKING_DETAIL, payload: { target: 'date' } } };
    if (text.includes('train')) return { message: 'Main trains dobara dhoondh raha hoon.', action: { type: Intent.CHANGE_BOOKING_DETAIL, payload: { target: 'train' } } };
    if (text.includes('class')) return { message: 'Kaunsi class chahiye?', action: { type: Intent.CHANGE_BOOKING_DETAIL, payload: { target: 'class' } } };
    if (text.includes('passenger') || text.includes('name') || text.includes('age')) return { message: 'Passenger details change karni hain?', action: { type: Intent.CHANGE_BOOKING_DETAIL, payload: { target: 'passenger' } } };
    return { message: 'Kya change karna hai?', action: { type: Intent.CHANGE_BOOKING_DETAIL } };
  }

  private handlePassengerField(raw: string, s: any): AIResponse {
    const idx = s.currentPassengerIndex;
    const p = s.passengers[idx] || {};
    const text = raw.trim();
    const numPax = s.passengersCount || 1;

    if (!p.name) {
      const nextQ = idx + 1 >= numPax && p.age && p.gender ? 'समरी बना रहे हैं.' : 'Age?';
      return { message: nextQ !== 'Age?' ? nextQ : 'Age?', action: { type: Intent.ADD_PASSENGER, payload: { index: idx, field: 'name', value: text } } };
    }
    if (!p.age) {
      const ageMatch = raw.match(/(\d+)/);
      const age = ageMatch ? parseInt(ageMatch[1], 10) : null;
      if (!age) return { message: 'Kripya age number mein batayein?', action: { type: Intent.ASK_FIELD, payload: { field: 'age' } } };
      return { message: 'Gender? (Male/Female/Other)', action: { type: Intent.ADD_PASSENGER, payload: { index: idx, field: 'age', value: age } } };
    }
    if (!p.gender) {
      let gender: 'MALE' | 'FEMALE' | 'OTHER' = 'MALE';
      const tl = text.toLowerCase();
      if (tl.includes('female') || tl.includes('mahila') || tl.includes('ladki') || tl.includes('aurat')) gender = 'FEMALE';
      if (tl.includes('other')) gender = 'OTHER';

      // Is this the last passenger?
      if (idx >= numPax - 1) {
        return { message: 'सभी passengers add ho gaye. समरी तैयार हो रही है।', action: { type: Intent.ADD_PASSENGER, payload: { index: idx, field: 'gender', value: gender, complete: true } } };
      }
      return { message: `Passenger ${idx + 2} ka naam kya hai?`, action: { type: Intent.ADD_PASSENGER, payload: { index: idx, field: 'gender', value: gender, nextPassenger: true } } };
    }

    return { message: 'समरी तैयार हो रही है।', action: { type: Intent.REVIEW_BOOKING } };
  }

  private findStationInText(raw: string): { code: string; name: string } | null {
    const tokens = raw.toLowerCase().replace(/[.,!?]/g, '').split(/\s+/).filter(Boolean);
    // Try longest suffix first
    for (let len = tokens.length; len >= 1; len--) {
      for (let start = 0; start + len <= tokens.length; start++) {
        const cand = tokens.slice(start, start + len).join(' ');
        const hit = STATION_ALIASES[cand];
        if (hit) return { code: hit.code, name: hit.name };
      }
    }
    return null;
  }

  private handlePassengerChange(text: string, s: any): AIResponse {
    // Very simple single-field update: "Passenger 1 ka age 32 kar do"
    const idxMatch = text.match(/passenger\s*(\d+)/i);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) - 1 : s.currentPassengerIndex;
    if (text.includes('name')) return { message: `Passenger ${idx + 1} ka naya naam batayein?`, action: { type: Intent.UPDATE_PASSENGER, payload: { index: idx, field: 'name' } } };
    if (text.includes('age')) return { message: `Passenger ${idx + 1} ki sahi age batayein?`, action: { type: Intent.UPDATE_PASSENGER, payload: { index: idx, field: 'age' } } };
    if (text.includes('gender')) return { message: `Passenger ${idx + 1} ka gender batayein?`, action: { type: Intent.UPDATE_PASSENGER, payload: { index: idx, field: 'gender' } } };
    return { message: 'Kaunsa detail change karna hai?', action: { type: Intent.CHANGE_BOOKING_DETAIL, payload: { target: 'passenger' } } };
  }
}
