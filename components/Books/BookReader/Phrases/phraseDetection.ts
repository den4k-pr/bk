/**
 * Phrasedetection.ts
 *
 * Пошук фразового дієслова / сталої фрази навколо слова, на яке натиснули.
 *
 * Словник (phrase_library із сервера) — це мапа "форма з тексту → лема".
 * Дані в ньому неідеальні: частини базових форм немає ("break down" є лише
 * як "broke down"), частина лем змінює саму фразу ("pick up" →
 * "pick yourself up"), є неіснуючі форми ("geted", "falled"). Тому:
 *  - окрім прямого збігу, шукаємо за лемою: перше слово зводиться до
 *    базової форми, а результат перевіряється по індексу лем словника;
 *  - лема, що не збігається з фразою за "хвостом" (частками), не
 *    використовується — натомість головне дієслово зводиться до бази;
 *  - розірвані фрази ("turn the light off") дозволені лише для
 *    відокремлюваних часток і лише коли частка не починає прийменникову
 *    групу ("put the book on the table" — це НЕ "put on").
 */
import { PUNCTUATION, MAX_GAP } from '../BookReader.constants';

export interface PhraseMatch {
  exactIndicesToHighlight: number[];
  baseForm: string;
  partOfSpeech: string | null;
}

interface DictionaryEntry {
  lemma: string;
  partOfSpeech: string | null;
}

const MAX_NGRAM_WORDS = 5;

let PHRASE_DICTIONARY: Map<string, DictionaryEntry> = new Map();
// Узгоджені леми словника ("break down", "look after") — для пошуку за лемою.
let LEMMA_INDEX: Set<string> = new Set();
// Форма головного дієслова → базові форми, виведені зі словника (broke → break).
let HEAD_BASES: Map<string, Set<string>> = new Map();

// Частки, які можуть відриватися від дієслова: "turn it off", "pick her up".
const SEPARABLE_PARTICLES = new Set([
  'up', 'down', 'off', 'out', 'back', 'away', 'over', 'on', 'in', 'around',
  'round', 'about', 'through', 'apart', 'together', 'aside', 'along',
  'forward', 'forth',
]);

// Слова, яких не буває всередині розриву (між дієсловом і часткою стоїть
// лише додаток: займенник або іменникова група).
const GAP_BLOCKERS = new Set([
  'to', 'at', 'by', 'for', 'from', 'with', 'of', 'into', 'onto', 'in', 'on',
  'under', 'over', 'after', 'before', 'about', 'through', 'without', 'during',
  'towards', 'toward', 'across', 'behind', 'beside', 'between', 'near', 'since',
  'until', 'upon', 'and', 'or', 'but', 'that', 'which', 'who', 'when', 'where',
  'if', 'because', 'as', 'than', 'not', 'is', 'are', 'was', 'were', 'be', 'been',
  'am', 'will', 'would', 'can', 'could', 'should', 'must', 'may', 'might',
  'have', 'has', 'had', 'do', 'does', 'did', 'up', 'down', 'off', 'out', 'back',
  'away', 'so', 'then', 'there', 'here', 'very', 'too',
]);

// Якщо після "частки" стоїть початок іменникової групи — це прийменник
// ("on the table"), а не частка фразового дієслова.
const NOUN_PHRASE_STARTERS = new Set([
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this',
  'that', 'these', 'those', 'some', 'any', 'every', 'each', 'no', 'one', 'two',
  'three', 'four', 'five', 'several', 'many', 'much', 'all', 'both',
]);

// "was in", "been with" — сміттєві записи словника, не фразові дієслова.
const BE_FORMS = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);

// Після цих слів стоїть іменник, а не особова форма дієслова: "their lives
// on their shoulders" — це НЕ "live on". "her" навмисно відсутнє ("saw her
// turn off the light").
const NOMINAL_DETERMINERS = new Set([
  'a', 'an', 'the', 'my', 'your', 'his', 'its', 'our', 'their', 'whose',
  'this', 'these', 'those', 'every', 'each',
]);

const splitWords = (phrase: string): string[] => phrase.split(' ').filter(Boolean);

const hasSameTail = (surface: string, lemma: string): boolean => {
  const s = splitWords(surface);
  const l = splitWords(lemma);
  return s.length === l.length && s.slice(1).join(' ') === l.slice(1).join(' ');
};

export const loadPhraseDictionary = (data: Record<string, DictionaryEntry>) => {
  PHRASE_DICTIONARY = new Map(Object.entries(data));
  LEMMA_INDEX = new Set();
  HEAD_BASES = new Map();

  PHRASE_DICTIONARY.forEach((entry, surface) => {
    if (!entry?.lemma || !surface.includes(' ') || !hasSameTail(surface, entry.lemma)) return;
    LEMMA_INDEX.add(entry.lemma);
    const surfaceHead = splitWords(surface)[0];
    const lemmaHead = splitWords(entry.lemma)[0];
    if (surfaceHead !== lemmaHead) {
      const bases = HEAD_BASES.get(surfaceHead) ?? new Set<string>();
      bases.add(lemmaHead);
      HEAD_BASES.set(surfaceHead, bases);
    }
  });
};

export const getPhraseDictionarySize = (): number => PHRASE_DICTIONARY.size;

/**
 * Можливі базові форми головного дієслова: відомі зі словника (broke →
 * break) + регулярні правила. Регулярні кандидати самі по собі можуть бути
 * сміттям — вони приймаються лише якщо фраза з ними є в LEMMA_INDEX.
 */
function headBaseCandidates(head: string): { known: string[]; regular: string[] } {
  const known = Array.from(HEAD_BASES.get(head) ?? []);
  const regular = new Set<string>();
  const add = (v: string) => {
    if (v && v !== head && v.length >= 2) regular.add(v);
  };

  if (/ies$/.test(head)) add(head.slice(0, -3) + 'y');
  if (/es$/.test(head)) add(head.slice(0, -2));
  if (/s$/.test(head)) add(head.slice(0, -1));
  if (/ied$/.test(head)) add(head.slice(0, -3) + 'y');
  if (/ed$/.test(head)) {
    const stem = head.slice(0, -2);
    add(stem);
    add(head.slice(0, -1));
    if (/([bdgklmnprtz])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (/ing$/.test(head)) {
    const stem = head.slice(0, -3);
    add(stem);
    add(stem + 'e');
    if (/([bdgklmnprtz])\1$/.test(stem)) add(stem.slice(0, -1));
    if (/y$/.test(stem)) add(stem.slice(0, -1) + 'ie');
  }

  return { known, regular: Array.from(regular) };
}

/**
 * Шукає фразу для послідовності слів. Повертає лему, яку треба надіслати
 * на сервер (завжди узгоджену з фразою), або null.
 */
function lookupPhrase(words: string[]): DictionaryEntry | null {
  if (words.length < 2) return null;
  const [head, ...rest] = words;
  if (words.length === 2 && BE_FORMS.has(head)) return null;

  const tail = rest.join(' ');
  const surface = words.join(' ');
  const { known, regular } = headBaseCandidates(head);

  const direct = PHRASE_DICTIONARY.get(surface);
  if (direct) {
    if (hasSameTail(surface, direct.lemma)) {
      return { lemma: direct.lemma, partOfSpeech: direct.partOfSpeech };
    }
    // Лема словника змінює фразу ("pick up" → "pick yourself up") —
    // беремо фразу з тексту, звівши лише головне дієслово до бази.
    const indexed = [...known, ...regular].find(base => LEMMA_INDEX.has(`${base} ${tail}`));
    const base = indexed ?? known[0];
    return { lemma: base ? `${base} ${tail}` : surface, partOfSpeech: direct.partOfSpeech };
  }

  // Прямого збігу немає: можливо, у словнику просто бракує цієї форми
  // ("break down" є лише як "broke down").
  if (LEMMA_INDEX.has(surface)) return { lemma: surface, partOfSpeech: null };
  for (const base of [...known, ...regular]) {
    const candidate = `${base} ${tail}`;
    if (LEMMA_INDEX.has(candidate)) return { lemma: candidate, partOfSpeech: null };
  }

  return null;
}

/** Нормалізація слова з тексту для пошуку (нижній регістр, без розділових знаків). */
export const cleanToken = (chunks: string[], idx: number): string => {
  const token = chunks?.[idx];
  if (typeof token !== 'string') return '';
  return cleanWordForLookup(token).toLowerCase();
};

/**
 * Прибирає розділові знаки, типографські лапки, "…" і тире, зберігаючи
 * дефіс і апостроф усередині слова ("well-known", "don't"). Кручений
 * апостроф зводиться до звичайного. Злиті через тире слова ("yes—no")
 * дають перше слово.
 */
// М'який перенос, пробіли нульової ширини, маркери напрямку, BOM — після
// конвертації книги трапляються всередині слів ("wro\u00ADng").
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const toCompatibleForm = (value: string): string => {
  try {
    return value.normalize('NFKC');
  } catch {
    return value;
  }
};

export const cleanWordForLookup = (raw: string): string => {
  const firstSegment =
    toCompatibleForm(String(raw ?? ''))
      .replace(INVISIBLE_CHARS, '')
      .replace(/[’‘]/g, "'")
      .split(/[—–]+/)
      .map(part => part.trim())
      .find(part => /[a-zA-Z0-9]/.test(part)) ?? '';

  return firstSegment
    .replace(PUNCTUATION, '')
    .replace(/^[-']+|[-']+$/g, '')
    .trim();
};

export const isSentenceEnd = (chunks: string[], idx: number): boolean => {
  const token = chunks?.[idx];
  if (typeof token !== 'string') return true;
  return /[.!?…]["'”’»)]*$/.test(token.trim());
};

// Межа пошуку фрази — кінець речення, а також кома / ; / : (межа клаузи).
const isClauseBreak = (chunks: string[], idx: number): boolean => {
  const token = chunks?.[idx];
  if (typeof token !== 'string') return false;
  return /[,;:—–]["'”’»)]*$/.test(token.trim());
};

const isSearchBoundary = (chunks: string[], idx: number): boolean =>
  isSentenceEnd(chunks, idx) || isClauseBreak(chunks, idx);

const isParagraphBreak = (chunks: string[], idx: number): boolean => {
  const token = chunks?.[idx];
  return typeof token === 'string' && /\n/.test(token);
};

interface WordToken {
  text: string;
  origIndex: number;
}

function getBounds(
  chunks: string[],
  clickedIndex: number,
  isBoundary: (c: string[], i: number) => boolean,
): [number, number] {
  let start = clickedIndex;
  while (start > 0) {
    const prev = start - 1;
    if (isParagraphBreak(chunks, prev)) break;
    if (typeof chunks[prev] === 'string' && chunks[prev].trim().length > 0 && isBoundary(chunks, prev)) break;
    start = prev;
  }

  let end = clickedIndex;
  while (end < chunks.length - 1) {
    if (isParagraphBreak(chunks, end + 1)) break;
    if (typeof chunks[end] === 'string' && chunks[end].trim().length > 0 && isBoundary(chunks, end)) break;
    end = end + 1;
  }

  return [start, end];
}

/**
 * Речення навколо слова — надсилається на сервер як контекст, щоб
 * відрізнити "She is training" (train) від "The training was hard" (training).
 */
export const extractSentenceContext = (chunks: string[], clickedIndex: number, maxLength = 300): string => {
  if (!Array.isArray(chunks) || clickedIndex < 0 || clickedIndex >= chunks.length) return '';
  const [start, end] = getBounds(chunks, clickedIndex, isSentenceEnd);
  const sentence = chunks.slice(start, end + 1).join('').replace(/\s+/g, ' ').trim();
  if (sentence.length <= maxLength) return sentence;

  // Задовге "речення" (діалог без крапок тощо) — вікно навколо слова.
  const before = chunks.slice(start, clickedIndex).join('');
  const offset = before.length;
  const from = Math.max(0, offset - Math.floor(maxLength / 2));
  return sentence.slice(from, from + maxLength).trim();
};

/**
 * Чи є перше слово фрази насправді іменником: воно стоїть у формі
 * -s / -ed / неправильного минулого часу (лема інша, ніж слово в тексті),
 * а перед ним — артикль / присвійний займенник / присвійна форма
 * ("fathers'", "Ivan's"). Особова форма дієслова після них неможлива.
 * Форми на -ing не чіпаємо: "his giving up" — фразове дієслово.
 */
function isNominalHead(chunks: string[], wordTokens: WordToken[], headPos: number, lemma: string): boolean {
  const head = wordTokens[headPos]?.text;
  const lemmaHead = splitWords(lemma)[0];
  if (!head || !lemmaHead || head === lemmaHead || head.endsWith('ing')) return false;

  const prev = wordTokens[headPos - 1];
  if (!prev) return false;
  if (NOMINAL_DETERMINERS.has(prev.text)) return true;
  const rawPrev = (chunks[prev.origIndex] ?? '').trim().replace(/[’‘]/g, "'").replace(/[.,;:!?"«»“”]+$/, '');
  return /^[a-zA-Z]+(?:'s|s')$/.test(rawPrev) && !/^(it|he|she|that|what|there|here|who|let)'s$/i.test(rawPrev);
}

interface ContiguousCandidate {
  start: number;
  end: number;
  len: number;
  entry: DictionaryEntry;
}

// Довша фраза перемагає коротшу; при рівній довжині — та, що починається
// з натиснутого слова (головне дієслово phrasal verb іде першим).
function scoreCandidate(candidate: ContiguousCandidate, clickedPos: number): number {
  const startsAtClick = candidate.start === clickedPos ? 1 : 0;
  return candidate.len * 10 + startsAtClick * 5;
}

/**
 * Чи можна вважати verb … particle розірваним фразовим дієсловом:
 * частка відокремлювана, у розриві лише додаток, а після частки не
 * починається іменникова група.
 */
function isValidGap(wordTokens: WordToken[], verbPos: number, particlePos: number): boolean {
  const particle = wordTokens[particlePos]?.text;
  if (!particle || !SEPARABLE_PARTICLES.has(particle)) return false;

  for (let i = verbPos + 1; i < particlePos; i++) {
    if (GAP_BLOCKERS.has(wordTokens[i].text)) return false;
  }

  const next = wordTokens[particlePos + 1]?.text;
  if (next && NOUN_PHRASE_STARTERS.has(next)) return false;

  return true;
}

export const findPhrasalVerbMatch = (
  chunks: string[],
  clickedIndex: number,
): PhraseMatch | null => {
  if (PHRASE_DICTIONARY.size === 0) return null;

  const [sentenceStart, sentenceEnd] = getBounds(chunks, clickedIndex, isSearchBoundary);
  const wordTokens: WordToken[] = [];
  let clickedPos = -1;

  for (let i = sentenceStart; i <= sentenceEnd; i++) {
    const raw = chunks[i];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const text = cleanToken(chunks, i);
    if (!text) continue;
    if (i === clickedIndex) clickedPos = wordTokens.length;
    wordTokens.push({ text, origIndex: i });
  }

  if (clickedPos === -1 || wordTokens.length === 0) return null;

  // ─── 1. Суцільні фрази: усі кандидати, що містять натиснуте слово ───
  const candidates: ContiguousCandidate[] = [];

  for (let len = Math.min(MAX_NGRAM_WORDS, wordTokens.length); len >= 2; len--) {
    const minStart = Math.max(0, clickedPos - len + 1);
    const maxStart = Math.min(clickedPos, wordTokens.length - len);

    for (let start = minStart; start <= maxStart; start++) {
      const end = start + len - 1;
      const entry = lookupPhrase(wordTokens.slice(start, end + 1).map(w => w.text));
      if (entry && !isNominalHead(chunks, wordTokens, start, entry.lemma)) {
        candidates.push({ start, end, len, entry });
      }
    }
  }

  if (candidates.length > 0) {
    let best = candidates[0];
    let bestScore = scoreCandidate(best, clickedPos);

    for (let i = 1; i < candidates.length; i++) {
      const score = scoreCandidate(candidates[i], clickedPos);
      if (score > bestScore) {
        best = candidates[i];
        bestScore = score;
      }
    }

    const indices: number[] = [];
    for (let i = best.start; i <= best.end; i++) {
      indices.push(wordTokens[i].origIndex);
    }
    return {
      exactIndicesToHighlight: indices,
      baseForm: best.entry.lemma,
      partOfSpeech: best.entry.partOfSpeech,
    };
  }

  // ─── 2. Розірвані фразові дієслова: найближча частка перемагає ───
  let bestGapped: { first: number; second: number; entry: DictionaryEntry } | null = null;

  for (let gap = 1; gap <= MAX_GAP && !bestGapped; gap++) {
    const asFirstSecondPos = clickedPos + gap + 1;
    if (asFirstSecondPos < wordTokens.length && isValidGap(wordTokens, clickedPos, asFirstSecondPos)) {
      const entry = lookupPhrase([wordTokens[clickedPos].text, wordTokens[asFirstSecondPos].text]);
      if (entry && !isNominalHead(chunks, wordTokens, clickedPos, entry.lemma)) {
        bestGapped = { first: clickedPos, second: asFirstSecondPos, entry };
        break;
      }
    }

    const asSecondFirstPos = clickedPos - gap - 1;
    if (asSecondFirstPos >= 0 && isValidGap(wordTokens, asSecondFirstPos, clickedPos)) {
      const entry = lookupPhrase([wordTokens[asSecondFirstPos].text, wordTokens[clickedPos].text]);
      if (entry && !isNominalHead(chunks, wordTokens, asSecondFirstPos, entry.lemma)) {
        bestGapped = { first: asSecondFirstPos, second: clickedPos, entry };
        break;
      }
    }
  }

  if (bestGapped) {
    return {
      exactIndicesToHighlight: [
        wordTokens[bestGapped.first].origIndex,
        wordTokens[bestGapped.second].origIndex,
      ],
      baseForm: bestGapped.entry.lemma,
      partOfSpeech: bestGapped.entry.partOfSpeech,
    };
  }

  return null;
};
