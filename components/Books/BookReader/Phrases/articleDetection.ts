import { cleanToken } from './phraseDetection';
import { PagePhraseOverrides, findPhraseMatchWithOverrides } from './phraseOverrides';

const ARTICLES = new Set(['a', 'an', 'the']);

export const isArticleAt = (chunks: string[], index: number): boolean =>
  ARTICLES.has(cleanToken(chunks, index));

/**
 * Артикль, натиснутий сам по собі: переклад не відкривається (як і для імен).
 * Якщо артикль — частина фрази з бібліотеки чи ручної розмітки ("a lot of",
 * "in the end"), тап відкриває фразу, як і раніше.
 */
export const isStandaloneArticleAt = (
  chunks: string[],
  index: number,
  overrides: PagePhraseOverrides | null | undefined,
): boolean => isArticleAt(chunks, index) && !findPhraseMatchWithOverrides(chunks, index, overrides);
