// ⚠️ Такий самий файл є в CRM: CRM/src/utils/phraseOverrides.ts — змінюючи
// логіку тут, повторіть зміну там (CRM показує рівно те, що зробить читалка).
import { cleanToken, findPhrasalVerbMatch, PhraseMatch } from './phraseDetection';

/**
 * Ручна розмітка фраз однієї сторінки (CRM → сервер → читалка), поверх
 * глобальної бібліотеки фраз:
 *  - on  — у цьому місці ці слова одна фраза: тап на будь-яке з них
 *          виділяє всі й перекладає lemma (дозволені розриви, коми, 6+ слів);
 *  - off — у цьому місці бібліотечну фразу вимкнено: тап дає лише слово.
 * text — слова за indices, очищені як cleanToken. Якщо текст сторінки
 * змінили і слова вже інші — позначка ігнорується (не "липне" до чужих слів).
 */
export interface PhraseSpan {
  indices: number[];
  text: string;
}

export interface ManualPhraseSpan extends PhraseSpan {
  lemma: string;
}

export interface PagePhraseOverrides {
  off: PhraseSpan[];
  on: ManualPhraseSpan[];
}

export const wordsAtIndices = (chunks: string[], indices: number[]): string =>
  indices.map(i => cleanToken(chunks, i)).filter(Boolean).join(' ');

/** Позначка відповідає поточному тексту сторінки. */
export const isSpanValid = (chunks: string[], span: PhraseSpan | null | undefined): boolean =>
  !!span &&
  Array.isArray(span.indices) &&
  span.indices.length > 0 &&
  span.indices.every(i => Number.isInteger(i) && i >= 0 && i < chunks.length && !!chunks[i]?.trim()) &&
  wordsAtIndices(chunks, span.indices) === String(span.text ?? '').toLowerCase();

/** Ручна фраза, що містить це слово (якщо є і відповідає тексту). */
export const findManualPhraseAt = (
  chunks: string[],
  index: number,
  overrides: PagePhraseOverrides | null | undefined,
): ManualPhraseSpan | null =>
  overrides?.on?.find(span => span.indices.includes(index) && isSpanValid(chunks, span)) ?? null;

/** Чи вимкнено фразу бібліотеки в цьому місці. */
export const isPhraseSuppressedAt = (
  chunks: string[],
  index: number,
  overrides: PagePhraseOverrides | null | undefined,
): boolean => !!overrides?.off?.some(span => span.indices.includes(index) && isSpanValid(chunks, span));

/**
 * Що виділить тап по слову з урахуванням розмітки сторінки:
 * ручна фраза → вимкнено тут (null) → бібліотека.
 */
export const findPhraseMatchWithOverrides = (
  chunks: string[],
  index: number,
  overrides: PagePhraseOverrides | null | undefined,
): PhraseMatch | null => {
  const manual = findManualPhraseAt(chunks, index, overrides);
  if (manual) {
    const indices = [...manual.indices].sort((a, b) => a - b);
    return {
      exactIndicesToHighlight: indices,
      baseForm: manual.lemma || manual.text,
      partOfSpeech: null,
    };
  }
  if (isPhraseSuppressedAt(chunks, index, overrides)) return null;
  return findPhrasalVerbMatch(chunks, index);
};
