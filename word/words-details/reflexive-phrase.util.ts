/**
 * Нейтральна форма фрази для словника: займенник на "-self" у фразі
 * замінюється на "oneself" ("demanding of himself" → "demanding of oneself",
 * "help yourself" → "help oneself"). Так фрази подають словники, і всі
 * варіанти (himself / herself / themselves…) зводяться до одного запису.
 *
 * - Лише фрази з двох і більше слів: окреме "himself" лишається як є.
 * - "itself" не чіпаємо: "in itself" — окремий сталий вираз.
 */
const PERSONAL_REFLEXIVES = /\b(myself|yourself|himself|herself|ourselves|yourselves|themselves|themself)\b/g;

export function toNeutralReflexivePhrase(phrase: string): string {
  const text = String(phrase ?? '');
  if (text.trim().split(/\s+/).filter(Boolean).length < 2) return text;
  return text.replace(PERSONAL_REFLEXIVES, 'oneself');
}
