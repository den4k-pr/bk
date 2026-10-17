/**
 * reader-lookup.util.ts
 *
 * Чисті (без БД і AI) помічники для натискання на слово в читалці:
 *   - normalizeLookupQuery: слово з тексту книги → чистий запит;
 *   - buildVerbForms: форми дієслова для картки (went · gone · going);
 *   - isAuxiliaryInVerbGroup: чи натиснуте слово лише допоміжне у
 *     дієслівній групі ("had" у "had imagined").
 */
import { AUXILIARY_VERBS, MODAL_VERBS } from './english-lexicons';
import { isKnownVerbLemma } from './english-verb-lexicon';
import { KIND_TO_POS, analyzeInflections } from './inflection';
import { conjugateVerb } from './verb-morphology';

// М'який перенос, пробіли нульової ширини, маркери напрямку тексту, BOM —
// у книгах після конвертації з PDF / EPUB вони трапляються всередині слів.
const INVISIBLE_CHARS = /[­​-‏‪-‮⁠-⁤﻿]/g;

// Кириличні літери, що виглядають як латинські (наслідок розпізнавання тексту).
const CYRILLIC_LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
};

/**
 * Запит із читалки / ручного вводу → чистий рядок. Нічого не вгадує:
 * лише прибирає невидимі символи і зводить сумісні форми (ﬁ → fi).
 * Кирилицю замінює на латиницю тільки в слові, де вже є латинські літери
 * ("wrоng" з кириличною "о"); українські запити не змінюються.
 */
export function normalizeLookupQuery(raw: string): string {
  let value = String(raw ?? '');
  try {
    value = value.normalize('NFKC');
  } catch {
    // normalize кидає лише на некоректних даних — лишаємо рядок як є.
  }
  value = value.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();

  return value
    .split(' ')
    .map(token => {
      if (!/[a-z]/i.test(token) || !/[а-яіїєґѕј]/i.test(token)) return token;
      const mapped = Array.from(token)
        .map(ch => {
          const latin = CYRILLIC_LOOKALIKES[ch.toLowerCase()];
          if (!latin) return ch;
          return ch === ch.toLowerCase() ? latin : latin.toUpperCase();
        })
        .join('');
      // Лишилась кирилиця без латинського двійника — це не одрук розпізнавання.
      return /[а-яіїєґ]/i.test(mapped) ? token : mapped;
    })
    .join(' ');
}

const SINGLE_WORD_RE = /^[a-z]+$/;

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const v = raw.toLowerCase().trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    result.push(v);
  }
  return result;
}

/**
 * Форми на -ing у картці не показуються ні за яких умов — і в нових, і в
 * старих записах БД. Перевіряється змінюване слово: перше ("giving up"),
 * а для ступенів — після more/most ("more interesting"). Решта фрази
 * ("gave something up") не впливає.
 */
export function withoutIngForms(forms: string[]): string[] {
  return forms.filter(f => {
    const words = (f ?? '').toLowerCase().trim().split(/\s+/);
    const head = /^(more|most|less|least)$/.test(words[0]) && words.length > 1 ? words[1] : words[0];
    return !!head && !head.endsWith('ing');
  });
}

/**
 * Запис сам є словоформою іншого дієслова ("taught" → teach, "telling" →
 * tell, "are" → be): від нього форми не утворюються ("taughted").
 */
function isInflectedVerbForm(head: string): boolean {
  if (AUXILIARY_VERBS.has(head) && !['be', 'do', 'have'].includes(head)) return true;
  if (isKnownVerbLemma(head)) return false;
  return analyzeInflections(head).some(
    a => KIND_TO_POS[a.kind] === 'verb' && a.lemma !== head && isKnownVerbLemma(a.lemma),
  );
}

/**
 * Форми дієслова для картки перекладу — ЛИШЕ для неправильних дієслів:
 * минулий час і дієприкметник ("go" → went, gone; "get" → got, got / gotten).
 * Варіанти однієї форми йдуть одним елементом через " / ".
 *
 * null (форм немає):
 *  - правильні дієслова ("walk", "include") — їхні форми утворюються за
 *    правилом (-ed), показувати нічого;
 *  - фразові дієслова і будь-які записи з кількох слів ("give up") — форми
 *    на них НІКОЛИ не виводяться;
 *  - не дієслово, модальне дієслово, запис, що сам є словоформою.
 */
export function buildVerbForms(entry: {
  text?: string | null;
  partOfSpeech?: string | null;
  type?: string | null;
}): string[] | null {
  const text = (entry.text ?? '').toLowerCase().trim();
  const pos = (entry.partOfSpeech ?? '').toLowerCase();
  const isPhrasal = pos === 'phrasal_verb' || entry.type === 'phrasal_verb';
  if (!text || isPhrasal || pos !== 'verb') return null;

  const [head, ...rest] = text.split(/\s+/);
  if (rest.length > 0) return null;
  if (!SINGLE_WORD_RE.test(head) || head.length < 2 || !/[aeiouy]/.test(head)) return null;
  if (MODAL_VERBS.has(head)) return null;
  if (isInflectedVerbForm(head)) return null;

  try {
    const conjugation = conjugateVerb(head);
    if (!conjugation.isIrregular) return null;

    // Дві групи — минулий час і дієприкметник, навіть однакові
    // ("made · made", "put · put"). Форм на -ing немає.
    const forms = [unique(conjugation.pastForms), unique(conjugation.participleForms)]
      .map(g => withoutIngForms(g))
      .filter(g => g.length > 0)
      .map(g => g.join(' / '));
    return forms.length > 0 ? forms : null;
  } catch {
    return null;
  }
}

const COMPOUND_TENSES = new Set([
  'present_continuous', 'past_continuous', 'present_perfect', 'past_perfect',
  'future', 'going_to_future', 'conditional',
]);

const groupWords = (group: string): string[] =>
  group.toLowerCase().replace(/[’‘]/g, "'").split(/[^a-z']+/).filter(Boolean);

/**
 * Чи натиснуте слово — лише допоміжне в дієслівній групі: "had" у
 * "had imagined", "was" у "was not telling", "will" у "will go".
 * Переклад такої групи ("уявив") належить ГОЛОВНОМУ дієслову, тому його
 * не можна показувати як переклад натиснутого слова.
 * "She had a house", "He is a doctor" — не допоміжні (група з одного слова).
 */
export function isAuxiliaryInVerbGroup(
  surface: string,
  analysis: { verbGroup?: string | null; function?: string | null; tense?: string | null },
): boolean {
  const s = (surface ?? '').toLowerCase().trim();
  if (!s) return false;

  const words = analysis.verbGroup ? groupWords(analysis.verbGroup) : [];
  if (words.length > 1) {
    // Головне дієслово групи — останнє слово ("has been told" → told).
    return words[words.length - 1] !== s && words.includes(s);
  }
  if (words.length === 1) return false;

  // Модель не повернула групу: допоміжне слово у складеному часі чи пасиві.
  if (!AUXILIARY_VERBS.has(s) && !MODAL_VERBS.has(s)) return false;
  return analysis.function === 'passive' || COMPOUND_TENSES.has(String(analysis.tense ?? ''));
}
