import { candidateLemmas } from '../books/verb-lemmatizer';

export interface HighlightRange {
  start: number;
  end: number;
}

interface OffsetToken {
  token: string;
  start: number;
  end: number;
}

const TRIM_PUNCTUATION = /[.,!?;:()"'«»]/;

const EN_STOP_WORDS = new Set(['to', 'a', 'an', 'the', 'my', 'your', 'his', 'her', 'our', 'their', 'some', 'any']);
const UA_STOP_WORDS = new Set(['до', 'на', 'з', 'і', 'та', 'а', 'в', 'у', 'що', 'як', 'це', 'за', 'й']);

function tokenizeWithOffsets(text: string): OffsetToken[] {
  const result: OffsetToken[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    let token = match[0];
    let start = match.index;
    let end = match.index + token.length;

    while (token.length && TRIM_PUNCTUATION.test(token[0])) {
      token = token.slice(1);
      start += 1;
    }
    while (token.length && TRIM_PUNCTUATION.test(token[token.length - 1])) {
      token = token.slice(0, -1);
      end -= 1;
    }

    if (token.length > 0) {
      result.push({ token, start, end });
    }
  }

  return result;
}

/**
 * Розбиває рядок-ціль (text / translation з БД) на варіанти слів.
 * У БД трапляються "It's raining.", "Що це?", "ти / ви", "ці (множина)",
 * "голодний/а", "Будь ласка (у відповідь на дякую)" — без очищення такі
 * цілі ніколи повністю не збігались з реченням.
 */
export function splitTargetAlternatives(target: string | null | undefined): string[][] {
  if (!target) return [];
  const cleaned = target
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    // Закінчення роду, приклеєне через слеш: "голодний/а", "згоден/на".
    .replace(/(\p{L})\/(\p{L}{1,2})(?=\s|$|[.,!?;:])/gu, '$1');
  return cleaned
    .split('/')
    .map(alt =>
      alt
        .split(/\s+/)
        .map(w => w.replace(/^[.,!?;:"'«»…]+|[.,!?;:"'«»…]+$/g, ''))
        .filter(Boolean),
    )
    .filter(words => words.length > 0)
    // Довший варіант — першим: "не / не робив" → "не робив", а не голе "не".
    .sort((a, b) => b.length - a.length);
}

function getEnglishStem(word: string): string {
  if (word.length <= 3) return word;
  let w = word;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('ied')) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing')) {
    w = w.slice(0, -3);
    if (w.length > 2 && w[w.length - 1] === w[w.length - 2]) return w.slice(0, -1);
    return w;
  }
  if (w.endsWith('ed')) {
    w = w.slice(0, -2);
    if (w.length > 2 && w[w.length - 1] === w[w.length - 2]) return w.slice(0, -1);
    return w;
  }
  if (w.endsWith('es')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function isEnglishSoftMatch(w1: string, w2: string): boolean {
  if (w1 === w2) return true;

  const lemmas1 = candidateLemmas(w1) || [];
  const lemmas2 = candidateLemmas(w2) || [];
  
  if (lemmas1.includes(w2) || lemmas2.includes(w1)) return true;
  for (const l1 of lemmas1) {
    if (lemmas2.includes(l1)) return true;
  }

  const stem1 = getEnglishStem(w1);
  const stem2 = getEnglishStem(w2);
  if (stem1 === stem2) return true;

  // Дієслова на -e: die → died / dies, use → used.
  const [shorter, longer] = w1.length <= w2.length ? [w1, w2] : [w2, w1];
  if (shorter.endsWith('e') && (longer === shorter + 'd' || longer === shorter + 's')) return true;

  // Короткі слова — без грубого збігу за частиною основи нижче:
  // "a" не має збігатися з "at".
  if (w1.length <= 2 || w2.length <= 2) return false;

  if ((stem1.includes(stem2) || stem2.includes(stem1)) && Math.abs(stem1.length - stem2.length) <= 1) {
    return true;
  }

  return false;
}

export function findEnglishHighlight(sentence: string, targets: string[]): HighlightRange | null {
  if (!sentence || !targets || targets.length === 0) return null;

  const tokens = tokenizeWithOffsets(sentence);

  // Очищаємо цілі від стоп-слів ("to bring" -> "bring")
  const phrases = targets
    .flatMap(t => splitTargetAlternatives(t))
    .map(words => {
      const filtered = words.filter(w => !EN_STOP_WORDS.has(w));
      return filtered.length > 0 ? filtered : words;
    })
    .filter(t => t.length > 0);

  const MAX_GAP = 2; // Дозволяє знаходити фрази з розривом (напр. "give it up" для цілі "give up")

  // Спроба 1: Пошук точних фраз з дозволеним розривом
  for (const phraseWords of phrases) {
    const phraseLen = phraseWords.length;
    
    for (let start = 0; start <= tokens.length - phraseLen; start++) {
      if (isEnglishSoftMatch(tokens[start].token.toLowerCase(), phraseWords[0])) {
        if (phraseLen === 1) {
          return { start: tokens[start].start, end: tokens[start].end };
        }

        let currentWordIdx = start;
        let endTokenIdx = start;
        let matchFailed = false;

        for (let i = 1; i < phraseLen; i++) {
          const targetWord = phraseWords[i];
          let foundNext = false;

          for (let offset = 1; offset <= MAX_GAP + 1; offset++) {
            const nextIdx = currentWordIdx + offset;
            if (nextIdx < tokens.length && isEnglishSoftMatch(tokens[nextIdx].token.toLowerCase(), targetWord)) {
              currentWordIdx = nextIdx;
              endTokenIdx = nextIdx;
              foundNext = true;
              break;
            }
          }

          if (!foundNext) {
            matchFailed = true;
            break;
          }
        }

        if (!matchFailed) {
          return {
            start: tokens[start].start,
            end: tokens[endTokenIdx].end
          };
        }
      }
    }
  }

  // Спроба 2: Якщо повна фраза не знайдена, шукаємо хоча б одне ключове слово з фрази
  for (const phraseWords of phrases) {
    for (const w of phraseWords) {
      if (w.length > 2) {
        for (const tok of tokens) {
          if (isEnglishSoftMatch(tok.token.toLowerCase(), w)) {
            return { start: tok.start, end: tok.end };
          }
        }
      }
    }
  }

  return null;
}

function isUkrainianSoftMatch(tokStr: string, tgtStr: string): boolean {
  if (tokStr === tgtStr) return true;
  const minLen = Math.min(tokStr.length, tgtStr.length);
  if (minLen < 3) return false;
  
  let common = 0;
  while (common < minLen && tokStr[common] === tgtStr[common]) common++;
  
  return common >= Math.min(4, minLen);
}

export function findUkrainianHighlight(sentence: string, target: string | undefined | null): HighlightRange | null {
  if (!sentence || !target) return null;

  const tokens = tokenizeWithOffsets(sentence);

  // Кожен варіант перекладу ("ти / ви", "вставляти / вкладати") — окрема фраза.
  const alternatives = splitTargetAlternatives(target).map(raw => {
    const filtered = raw.filter(w => !UA_STOP_WORDS.has(w));
    return filtered.length > 0 ? filtered : raw;
  });

  if (alternatives.length === 0) return null;

  const MAX_GAP = 2;

  // Спроба 1: Фразовий пошук з пропусками — по кожному варіанту
  for (const targetWords of alternatives) {
    const phraseLen = targetWords.length;
    for (let start = 0; start <= tokens.length - phraseLen; start++) {
      if (!isUkrainianSoftMatch(tokens[start].token.toLowerCase(), targetWords[0])) continue;
      if (phraseLen === 1) {
        return { start: tokens[start].start, end: tokens[start].end };
      }

      let currentWordIdx = start;
      let endTokenIdx = start;
      let matchFailed = false;

      for (let i = 1; i < phraseLen; i++) {
        const targetWord = targetWords[i];
        let foundNext = false;

        for (let offset = 1; offset <= MAX_GAP + 1; offset++) {
          const nextIdx = currentWordIdx + offset;
          if (nextIdx < tokens.length && isUkrainianSoftMatch(tokens[nextIdx].token.toLowerCase(), targetWord)) {
            currentWordIdx = nextIdx;
            endTokenIdx = nextIdx;
            foundNext = true;
            break;
          }
        }

        if (!foundNext) {
          matchFailed = true;
          break;
        }
      }

      if (!matchFailed) {
        return {
          start: tokens[start].start,
          end: tokens[endTokenIdx].end
        };
      }
    }
  }

  // Спроба 2: Пошук найкращого часткового збігу для будь-якого слова
  let best: { start: number; end: number; score: number } | null = null;
  for (const tgt of alternatives.flat()) {
    if (tgt.length < 3) continue;
    for (const tok of tokens) {
      const lower = tok.token.toLowerCase();
      const minLen = Math.min(lower.length, tgt.length);
      if (minLen < 3) continue;

      let common = 0;
      while (common < minLen && lower[common] === tgt[common]) common++;
      const threshold = Math.min(4, minLen);
      
      if (common >= threshold && (!best || common > best.score)) {
        best = { start: tok.start, end: tok.end, score: common };
      }
    }
  }

  return best ? { start: best.start, end: best.end } : null;
}

export function computeExampleHighlights(word: {
  text: string;
  translation: string;
  forms?: string[] | null;
  examples?: string[] | null;
}): Array<HighlightRange | null> {
  const examples = word.examples || [];
  const englishTargets = [word.text, ...(word.forms || [])].filter(Boolean);

  return examples.map((sentence, idx) => {
    const isEnglishLine = idx % 2 === 0;
    return isEnglishLine
      ? findEnglishHighlight(sentence, englishTargets)
      : findUkrainianHighlight(sentence, word.translation);
  });
}