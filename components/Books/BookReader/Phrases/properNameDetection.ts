import { ENGLISH_PROPER_NOUN_LISTS } from '../../../../utils/properNounCapitalization';

/**
 * Чи є слово в тексті книжки ім'ям / назвою (Arkad, Babylon, Mr Smith).
 * Тап по такому слову в читалці не відкриває переклад — імена не вчать.
 * Виділення ("обвести", "промаркувати") лишається як було.
 *
 * Правило:
 *  - з великої літери ПОСЕРЕДИНІ речення → ім'я / назва;
 *  - на ПОЧАТКУ речення велика літера нічого не каже, тож ім'я — лише якщо
 *    це слово вже траплялось У ЦІЙ книжці з великої посеред речення, або
 *    воно є у списку імен людей (країни тут не рахуються: "Turkey is
 *    tasty", "China is fragile" — звичайні слова);
 *  - рядок-заголовок ("The Seven Cures for a Lean Purse") — велика
 *    літера там стилістична: слова з нього не вважаються іменами і не
 *    "вивчаються" як імена;
 *  - дні тижня, місяці, мови й національності (Monday, English) — звичайні
 *    слова для вивчення, їх не чіпаємо;
 *  - "I", "I'm", слова КАПСОМ (заголовки) та однолітерні — не імена;
 *  - слово, яке в цій книжці трапляється й з малої літери ("love" …
 *    "this book, Love Transformation"), — звичайне слово, а не ім'я: велика
 *    літера там від назви книги / закону / палацу. Виняток — відомі імена
 *    людей ("Will", "Mark") посеред речення.
 *
 * Текст сторінки — чанки з split(/(\s+)/): слова чергуються з пробілами.
 */

const VOCABULARY_PROPER_WORDS = new Set<string>([
  ...ENGLISH_PROPER_NOUN_LISTS.days,
  ...ENGLISH_PROPER_NOUN_LISTS.months,
  ...ENGLISH_PROPER_NOUN_LISTS.nationalitiesAndLanguages,
]);

// На початку речення — лише імена людей. Країни/континенти посеред
// речення й так розпізнаються за великою літерою.
const KNOWN_NAME_WORDS = new Set<string>([...ENGLISH_PROPER_NOUN_LISTS.givenNames]);

// Після них крапка не означає кінця речення: "Mr. Smith".
const TITLE_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'sir', 'lady', 'lord', 'king', 'queen']);

// Імена, вже побачені посеред речення (нижній регістр) — ОКРЕМО для кожної
// книжки: "Arkad" на початку речення впізнаємо, бо раніше було "…told
// Arkad". Раніше набір був один на всю сесію, і "Will" як ім'я з однієї
// книжки блокував переклад "Will you…?" в усіх інших.
const learnedNamesByBook = new Map<string, Set<string>>();
// Слова, що в цій книжці траплялися з малої літери (нижній регістр).
const lowercaseWordsByBook = new Map<string, Set<string>>();
const MAX_BOOKS_REMEMBERED = 10;

const perBook = (store: Map<string, Set<string>>, bookKey: string): Set<string> => {
  let set = store.get(bookKey);
  if (!set) {
    set = new Set<string>();
    store.set(bookKey, set);
    if (store.size > MAX_BOOKS_REMEMBERED) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }
  return set;
};

const namesOf = (bookKey: string): Set<string> => perBook(learnedNamesByBook, bookKey);
const lowercaseWordsOf = (bookKey: string): Set<string> => perBook(lowercaseWordsByBook, bookKey);

// Рядок-заголовок: щонайменше 3 слова і 60%+ з великої літери.
const HEADING_MIN_WORDS = 3;
const HEADING_CAPITALIZED_SHARE = 0.6;

const LEADING_PUNCT = /^[\s"'“”‘’«»([{—–-]+/;
const TRAILING_PUNCT = /[\s"'“”‘’«»)\]}.,!?;:…—–-]+$/;

/** Слово без обрамлювальних знаків і присвійного 's: "Arkad's," → "Arkad". */
const cleanWord = (chunk: string): string =>
  chunk.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '').replace(/['’]s$/i, '');

const isCapitalizedWord = (word: string): boolean =>
  word.length > 1 && /^[A-Z][a-z]/.test(word) && word !== word.toUpperCase();

const isWhitespace = (chunk: string) => /^\s*$/.test(chunk);

/** Чи стоїть слово chunks[index] на початку речення / абзацу. */
const isSentenceStart = (chunks: string[], index: number): boolean => {
  const raw = chunks[index] ?? '';
  // Відкривальна лапка / дужка перед словом — пряма мова теж з великої.
  if (/^["“‘'«(]/.test(raw)) return true;

  for (let i = index - 1; i >= 0; i--) {
    const prev = chunks[i];
    if (isWhitespace(prev)) {
      if (prev.includes('\n')) return true; // новий абзац
      continue;
    }
    const prevClean = cleanWord(prev).toLowerCase();
    if (/[.!?…:;]["'”’)\]]*$/.test(prev)) {
      return !TITLE_ABBREVIATIONS.has(prevClean);
    }
    return false;
  }
  return true; // перше слово сторінки
};

// Ознака "слово в рядку-заголовку" для кожного шматка сторінки — рахується
// ОДНИМ проходом і запам'ятовується для цього масиву chunks. Раніше рядок
// проходився заново для кожного слова: на розділі без переносів (один
// суцільний блок) це мільйони операцій і ~9 с замерзання читалки.
const headingFlagsCache = new WeakMap<string[], Uint8Array>();

const isLineBreak = (chunk: string | undefined) => !!chunk && isWhitespace(chunk) && chunk.includes('\n');

const headingFlagsOf = (chunks: string[]): Uint8Array => {
  const cached = headingFlagsCache.get(chunks);
  if (cached) return cached;

  const flags = new Uint8Array(chunks.length);
  let lineStart = 0;
  const closeLine = (end: number) => {
    let words = 0;
    let capitalized = 0;
    for (let i = lineStart; i < end; i++) {
      const chunk = chunks[i] ?? '';
      if (isWhitespace(chunk)) continue;
      const w = cleanWord(chunk);
      if (!/\p{L}/u.test(w)) continue;
      words++;
      if (isCapitalizedWord(w)) capitalized++;
    }
    if (words >= HEADING_MIN_WORDS && capitalized / words >= HEADING_CAPITALIZED_SHARE) {
      for (let i = lineStart; i < end; i++) flags[i] = 1;
    }
  };

  for (let i = 0; i < chunks.length; i++) {
    if (isLineBreak(chunks[i])) {
      closeLine(i);
      lineStart = i + 1;
    }
  }
  closeLine(chunks.length);

  headingFlagsCache.set(chunks, flags);
  return flags;
};

/** Чи стоїть chunks[index] у рядку-заголовку (Title Case). */
const isInHeadingLine = (chunks: string[], index: number): boolean => headingFlagsOf(chunks)[index] === 1;

/** Запам'ятати імена, що стоять посеред речення на цій сторінці книжки. */
export const learnNamesFromChunks = (chunks: string[], bookKey: string = ''): void => {
  const names = namesOf(bookKey);
  const lowercaseWords = lowercaseWordsOf(bookKey);
  for (let i = 0; i < chunks.length; i++) {
    const word = cleanWord(chunks[i] ?? '');
    if (/^[a-z]/.test(word)) {
      lowercaseWords.add(word.toLowerCase());
      continue;
    }
    if (!isCapitalizedWord(word)) continue;
    const lower = word.toLowerCase();
    if (VOCABULARY_PROPER_WORDS.has(lower) || TITLE_ABBREVIATIONS.has(lower)) continue;
    if (isSentenceStart(chunks, i) || isInHeadingLine(chunks, i)) continue;
    names.add(lower);
  }
};

/** Чи є слово chunks[index] ім'ям / назвою. */
export const isProperNameAt = (chunks: string[], index: number, bookKey: string = ''): boolean => {
  const word = cleanWord(chunks[index] ?? '');
  if (!isCapitalizedWord(word)) return false;

  const lower = word.toLowerCase();
  if (VOCABULARY_PROPER_WORDS.has(lower)) return false;
  if (TITLE_ABBREVIATIONS.has(lower)) return true; // "Mr", "Sir" — частина імені

  if (KNOWN_NAME_WORDS.has(lower)) {
    // Відоме ім'я людини — ім'я і посеред, і на початку речення (як і раніше).
    return true;
  }
  // Траплялось у книжці з малої — звичайне слово з великої літери в назві.
  if (lowercaseWordsOf(bookKey).has(lower)) return false;

  const knownName = namesOf(bookKey).has(lower);
  // У заголовку велика літера стилістична — як на початку речення.
  if (isSentenceStart(chunks, index) || isInHeadingLine(chunks, index)) return knownName;
  return true;
};
