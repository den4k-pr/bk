/**
 * Повернення в «Картки» після переходу на іншу вкладку: та сама колода і та
 * сама картка, без нового запиту слів. Пам'ятаємо лише позицію (на час роботи
 * застосунку); слова колоди й прогрес і так лежать у сторі (state.learn).
 *
 * Колода впізнається за id її слів: якщо слова в сторі вже інші (новий цикл,
 * інша категорія, вихід з акаунта) — збережена позиція не застосовується.
 */
const RESUME_TTL_MS = 30 * 60 * 1000;

interface CardsResumeState {
  signature: string;
  category: string | undefined;
  step: 'first' | 'second';
  wordIndex: number;
  savedAt: number;
}

let saved: CardsResumeState | null = null;

type WordsLike = ReadonlyArray<{ word?: { id?: number } | null } | null | undefined>;

export const deckSignature = (words: WordsLike): string =>
  (words || []).map((w) => w?.word?.id ?? '').join(',');

const isFresh = (state: CardsResumeState | null): state is CardsResumeState =>
  !!state && Date.now() - state.savedAt < RESUME_TTL_MS;

export const cardsResumeStore = {
  /** Чи можна продовжити цю колоду (ті самі слова, та сама категорія). */
  canResume(words: WordsLike, category: string | undefined): boolean {
    const signature = deckSignature(words);
    return isFresh(saved) && signature !== '' && saved.signature === signature && saved.category === category;
  },
  step(words: WordsLike): 'first' | 'second' {
    return isFresh(saved) && saved.signature === deckSignature(words) ? saved.step : 'first';
  },
  wordIndex(words: WordsLike): number {
    if (!isFresh(saved) || saved.signature !== deckSignature(words)) return 0;
    return Math.min(Math.max(0, saved.wordIndex), Math.max(0, words.length - 1));
  },
  save(words: WordsLike, category: string | undefined, patch: Partial<Pick<CardsResumeState, 'step' | 'wordIndex'>>): void {
    const signature = deckSignature(words);
    if (!signature) return;
    const base = saved && saved.signature === signature ? saved : { signature, category, step: 'first' as const, wordIndex: 0 };
    saved = { ...base, ...patch, category, signature, savedAt: Date.now() };
  },
  /** Позиція картки в колоді — лише для вже відомої колоди. */
  saveIndex(words: WordsLike, wordIndex: number): void {
    if (!saved || saved.signature !== deckSignature(words)) return;
    saved = { ...saved, wordIndex, savedAt: Date.now() };
  },
  clear(): void {
    saved = null;
  },
};
