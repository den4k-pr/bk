import {
  classifyClosedClassWord,
  PHRASAL_PARTICLES,
  COMMON_VERB_LEMMAS,
  classifyNumeralWord,
} from './english-lexicons';
import { lemmatizeVerb, isKnownVerbBase } from './verb-morphology';
import { resolveQuantityAdjective } from './quantity-adjectives';
import { isIngAdjective } from './ing-adjectives';

export type QueryType = 'word' | 'phrasal_verb' | 'idiom' | 'fixed_expression' | 'phrase';
export type QueryPartOfSpeech =
  | 'verb' | 'noun' | 'adjective' | 'adverb' | 'pronoun'
  | 'preposition' | 'conjunction' | 'interjection'
  | 'phrasal_verb' | 'prepositional_phrase' | 'conjunction_phrase'
  | 'fixed_expression' | 'idiom' | 'numeral' | 'none';

export interface StructureClassification {
  normalizedQuery: string;
  wordCount: number;
  type: QueryType;
  partOfSpeech: QueryPartOfSpeech;
  headVerbLemma?: string;
  headAdjectiveLemma?: string;
  lockedLemma?: string;
  isCertain: boolean;
  reason: string;
}

export function classifyQueryStructure(rawQuery: string): StructureClassification {
  const normalizedQuery = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
  const words = normalizedQuery.split(' ').filter(Boolean);
  const wordCount = words.length;

  if (wordCount === 1) {
    const quantityAdj = resolveQuantityAdjective(words[0]);
    if (quantityAdj) {
      return {
        normalizedQuery,
        wordCount,
        type: 'word',
        partOfSpeech: 'adjective',
        headAdjectiveLemma: quantityAdj.base,
        isCertain: true,
        reason: `кількісний прикметник: "${words[0]}" -> база "${quantityAdj.base}"`,
      };
    }

    const numeralCategory = classifyNumeralWord(words[0]);
    if (numeralCategory) {
      return {
        normalizedQuery,
        wordCount,
        type: 'word',
        partOfSpeech: 'numeral',
        isCertain: true,
        reason:
          `${numeralCategory === 'ordinal' ? 'порядковий' : 'кількісний'} числівник: "${words[0]}" — ` +
          `детерміновано класифіковано як numeral`,
      };
    }

    const closedClass = classifyClosedClassWord(words[0]);
    if (closedClass) {
      const posMap: Record<string, QueryPartOfSpeech> = {
        preposition: 'preposition',
        conjunction: 'conjunction',
        pronoun: 'pronoun',
        determiner: 'none',
        modal_verb: 'verb',
        auxiliary_verb: 'verb',
        negation_particle: 'none',
      };

      if (closedClass === 'auxiliary_verb' || closedClass === 'modal_verb') {
        const lemma = lemmatizeVerb(words[0]);
        return {
          normalizedQuery,
          wordCount,
          type: 'word',
          partOfSpeech: posMap[closedClass] ?? 'none',
          headVerbLemma: lemma,
          isCertain: true,
          reason: `однослівний запит належить до закритого класу: ${closedClass}; лематизовано "${words[0]}" -> "${lemma}"`,
        };
      }

      return {
        normalizedQuery,
        wordCount,
        type: 'word',
        partOfSpeech: posMap[closedClass] ?? 'none',
        isCertain: true,
        reason: `однослівний запит належить до закритого класу: ${closedClass}`,
      };
    }

    if (words[0].length > 3 && words[0].endsWith('ing') && isIngAdjective(words[0])) {
      return {
        normalizedQuery,
        wordCount,
        type: 'word',
        partOfSpeech: 'none',
        isCertain: false,
        lockedLemma: words[0],
        reason:
          `слово зі списку лексикалізованих "-ing"-прикметників — лема ЗАФІКСОВАНА як "${words[0]}" ` +
          `і НЕ підлягає скороченню до базового дієслова; частину мови визначає AI`,
      };
    }

    if (words[0].length > 3 && /^[a-z]+ly$/.test(words[0])) {
      return {
        normalizedQuery,
        wordCount,
        type: 'word',
        partOfSpeech: 'none',
        isCertain: false,
        lockedLemma: words[0],
        reason:
          `слово закінчується на "-ly" — лема ЗАФІКСОВАНА як "${words[0]}" і НЕ підлягає ` +
          `скороченню AI; частину мови (adverb/adjective) визначає AI`,
      };
    }

    return {
      normalizedQuery,
      wordCount,
      type: 'word',
      partOfSpeech: 'none',
      isCertain: false,
      reason: 'однослівний запит належить до відкритого класу — потрібен AI/словник',
    };
  }

  const [firstWord, secondWord] = words;
  const lastWord = words[words.length - 1];

  const firstWordClosedClass = classifyClosedClassWord(firstWord);

  if (firstWordClosedClass && firstWordClosedClass !== 'modal_verb' && firstWordClosedClass !== 'auxiliary_verb') {
    const posMap: Partial<Record<typeof firstWordClosedClass, QueryPartOfSpeech>> = {
      preposition: 'prepositional_phrase',
      conjunction: 'conjunction_phrase',
      pronoun: 'fixed_expression',
      determiner: 'fixed_expression',
      negation_particle: 'fixed_expression',
    };
    return {
      normalizedQuery,
      wordCount,
      type: 'fixed_expression',
      partOfSpeech: posMap[firstWordClosedClass] ?? 'fixed_expression',
      isCertain: true,
      reason: `перше слово "${firstWord}" — закритий клас (${firstWordClosedClass}), не може починати phrasal_verb`,
    };
  }

  if (firstWordClosedClass === 'modal_verb' || firstWordClosedClass === 'auxiliary_verb') {
    return {
      normalizedQuery,
      wordCount,
      type: 'fixed_expression',
      partOfSpeech: 'fixed_expression',
      isCertain: true,
      reason: `перше слово "${firstWord}" — модальне/допоміжне дієслово, граматична конструкція`,
    };
  }

  const headLemma = lemmatizeVerb(firstWord);
  const isRecognizedVerb = isKnownVerbBase(headLemma) || COMMON_VERB_LEMMAS.has(headLemma);
  const secondIsParticle = PHRASAL_PARTICLES.has(secondWord);

  if (isRecognizedVerb && secondIsParticle && wordCount === 2) {
    return {
      normalizedQuery,
      wordCount,
      type: 'phrasal_verb',
      partOfSpeech: 'phrasal_verb',
      headVerbLemma: headLemma,
      isCertain: true,
      reason: `"${firstWord}"->"${headLemma}" — відоме дієслово, "${secondWord}" — частка`,
    };
  }

  if (isRecognizedVerb && wordCount <= 3) {
    const restAreFunctionWords = words.slice(1).every(w => {
      const cls = classifyClosedClassWord(w);
      return PHRASAL_PARTICLES.has(w) || cls === 'preposition';
    });
    if (restAreFunctionWords) {
      return {
        normalizedQuery,
        wordCount,
        type: 'phrasal_verb',
        partOfSpeech: 'phrasal_verb',
        headVerbLemma: headLemma,
        isCertain: true,
        reason: `"${firstWord}"->"${headLemma}" — відоме дієслово, решта слів — частки/прийменники`,
      };
    }
  }

  // Змінена форма + повнозначне слово — це радше означення до іменника
  // ("running shoes", "boiled eggs"), а не дієслово з додатком: лему не
  // фіксуємо, інакше зберігалось "run shoes". Дієслівні ідіоми з формою
  // ("kicked the bucket") мають далі службове слово й лишаються ідіомами.
  if (isRecognizedVerb && firstWord !== headLemma && !classifyClosedClassWord(secondWord)) {
    return {
      normalizedQuery,
      wordCount,
      type: 'phrase',
      partOfSpeech: 'none',
      isCertain: false,
      reason: `"${firstWord}" — змінена форма перед повнозначним "${secondWord}": означення + іменник, лему визначить AI`,
    };
  }

  if (isRecognizedVerb) {
    return {
      normalizedQuery,
      wordCount,
      type: 'idiom',
      partOfSpeech: 'idiom',
      headVerbLemma: headLemma,
      isCertain: true,
      reason: `"${firstWord}"->"${headLemma}" — дієслово, але далі не частка — структура ідіоми`,
    };
  }

  return {
    normalizedQuery,
    wordCount,
    type: 'phrase',
    partOfSpeech: 'none',
    isCertain: false,
    reason: `перше слово "${firstWord}" не розпізнано ні як закритий клас, ні як відоме дієслово`,
  };
}