export type WordEntryType = 'word' | 'phrase' | 'phrasal_verb';

/**
 * Тип запису словника (фільтр "Слова / Фрази / Фразові дієслова"):
 *  - одне слово (у т.ч. з дефісом чи апострофом: well-known, don't) — word;
 *  - фразове дієслово — phrasal_verb;
 *  - будь-що інше з кількох слів (стала фраза, ідіома, речення) — phrase.
 * Раніше все, що не phrasal_verb, ставало word — "I love cats" потрапляло в слова.
 */
export function resolveEntryType(
  text: string,
  partOfSpeech: string | null | undefined,
  structureType?: string | null,
): WordEntryType {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount <= 1) return 'word';
  if (partOfSpeech === 'phrasal_verb' || structureType === 'phrasal_verb') return 'phrasal_verb';
  return 'phrase';
}
