/**
 * v0.39.7 — does real IRCTC offer a meal choice (Veg / Non Veg / No Food) on the passenger form for this train?
 *
 * IRCTC shows the food dropdown only for pre-paid catering trains, where catering is optional and charged in the fare
 * when opted for: Rajdhani, Shatabdi, Duronto, Vande Bharat, Tejas, Gatimaan (Railway Board catering circulars; IRCTC
 * "catering service option"). On Mail / Express / Superfast / Intercity / Jan Shatabdi trains food is bought on board
 * and IRCTC shows no food choice at booking.
 *
 * Why not the provider flag: RailCore's schedule `catering` boolean contradicts IRCTC (14680 Intercity → true, while
 * 12952 Rajdhani / 22488 Vande Bharat / 12030 Shatabdi → false), so it is not used for the meal question.
 * The train NAME (provider data) decides. Unrecognised or empty name → null (unknown) → no food choice is shown.
 */
const PREPAID = /\b(rajdhani|rjdhni|shatabdi|shtbdi|duronto|vande\s*-?\s*bharat|vandebharat|tejas|gatimaan|gatiman)\b/i;
const NOT_PREPAID = /\bjan\s*-?\s*(shatabdi|shtbdi)\b|\bjanshatabdi\b/i;

export const IRCTC_FOOD_CHOICE_BASIS = 'IRCTC pre-paid catering train (Rajdhani / Shatabdi / Duronto / Vande Bharat / Tejas / Gatimaan)';

export function irctcFoodChoiceOffered(trainName: unknown): boolean | null {
  const n = typeof trainName === 'string' ? trainName.trim() : '';
  if (!n) return null;
  if (NOT_PREPAID.test(n)) return false;
  return PREPAID.test(n);
}
