/**
 * generated-entry-validation.ts
 *
 * Єдина перевірка AI-контенту перед записом у глобальний словник `word`.
 * Раніше все, що повертала модель, зберігалось як є: заглушка
 * "переклад відсутній", латиниця в перекладі, порожні приклади після
 * примусового доповнення, кирилиця чи набір літер як англійське слово
 * ("vfibyf xfce"). Такий запис бачать усі користувачі, тому краще не
 * зберегти нічого, ніж зберегти сміття.
 */

const UK_LETTER = /[а-щьюяєіїґ]/i;
const LATIN_LETTER = /[a-z]/i;

const TRANSLATION_PLACEHOLDERS: RegExp[] = [
  /переклад\s+відсутн/i,
  /немає\s+перекладу/i,
  /не\s+перекладається/i,
  /невідом/i,
  /не\s+знайдено/i,
  /^n\/?a$/i,
  /^[-–—?.…\s]+$/,
];

export interface GeneratedEntryCandidate {
  text: string;
  translation: string;
  pronunciation?: string | null;
  examples?: string[] | null;
  isProperNoun?: boolean;
  /** Відповідь моделі: чи це справжнє англійське слово / вираз. */
  isRealEnglishEntry?: boolean;
}

/** Причини відмови; порожній масив — запис можна зберігати. */
export function validateGeneratedEntry(entry: GeneratedEntryCandidate): string[] {
  const reasons: string[] = [];

  const text = (entry.text ?? '').trim();
  if (!/^[a-z][a-z' .-]*$/i.test(text) || text.length > 150) reasons.push('text_not_latin');
  // Абревіатури (tv, pc, dvd) лишаємо: короткий набір літер відсіює
  // відповідь моделі isRealEnglishEntry.
  else if (text.split(/[\s-]+/).some(w => w.replace(/[^a-z]/gi, '').length >= 4 && !/[aeiouy]/i.test(w))) {
    reasons.push('text_no_vowel');
  }

  reasons.push(...validateUkrainianTranslation(entry.translation));

  const pronunciation = (entry.pronunciation ?? '').trim();
  if (pronunciation && LATIN_LETTER.test(pronunciation)) reasons.push('pronunciation_latin');

  const examples = entry.examples;
  if (!Array.isArray(examples) || examples.length !== 6) {
    reasons.push('examples_count');
  } else {
    examples.forEach((example, i) => {
      const value = typeof example === 'string' ? example.trim() : '';
      if (!value) reasons.push(`example_${i}_empty`);
      else if (i % 2 === 0 && !LATIN_LETTER.test(value)) reasons.push(`example_${i}_not_en`);
      else if (i % 2 === 1 && !UK_LETTER.test(value)) reasons.push(`example_${i}_not_uk`);
    });
  }

  if (entry.isRealEnglishEntry === false) reasons.push('model_not_real_entry');

  return reasons;
}

/** Перевірка лише перекладу (для швидкого запасного перекладу без збереження). */
export function validateUkrainianTranslation(raw: string | null | undefined): string[] {
  const reasons: string[] = [];
  const translation = (raw ?? '').trim();
  if (!translation) return ['translation_empty'];
  if (!UK_LETTER.test(translation)) reasons.push('translation_not_ukrainian');
  if (LATIN_LETTER.test(translation)) reasons.push('translation_has_latin');
  if (TRANSLATION_PLACEHOLDERS.some(p => p.test(translation))) reasons.push('translation_placeholder');
  if (translation.length > 120) reasons.push('translation_too_long');
  return reasons;
}

/**
 * Український інфінітив: -ти, -тися, -тись, -чи (пекти). Коротку форму на
 * "-ть" не враховуємо: вона збігається з 3-ю особою ("ходить", "кипить").
 */
export function isUkrainianInfinitive(word: string): boolean {
  return /(ти|тися|тись|чи|чися)$/i.test(word.trim());
}

/** Рядок, придатний як англійський запит (латиниця, апострофи, пробіли, дефіси). */
export function isLatinQuery(value: string): boolean {
  return /^[a-z][a-z' -]*$/i.test(value.trim());
}

export function hasCyrillic(value: string): boolean {
  return /[а-яіїєґё]/i.test(value);
}
