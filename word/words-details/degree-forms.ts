/**
 * degree-forms.ts
 *
 * Детерміновані (БЕЗ AI) «форми слова», які показуються в картці перекладу:
 * це СТУПЕНІ ПОРІВНЯННЯ (comparative / superlative) для прикметників і
 * прислівників.
 *
 * Дієслова / фразові дієслова / іменники / службові слова сюди НЕ потрапляють:
 * їхня словозміна (went, going, houses…) — це відмінювання, а не ступені
 * порівняння (вимога вчителя: форми показуємо лише для прикметника й
 * прислівника).
 *
 * Ключові виправлення проти старої логіки (computeAdjectiveForms у
 * word-generation.service.ts):
 *   - прислівники на -ly тепер дають "more/most" (quickly → more quickly),
 *     а не псевдо-"quicklier" (раніше до них застосовували правила прикметників);
 *   - неградуальні прислівники (very, now, here, always тощо) → порожній список
 *     (раніше "now" → "nower", "very" → "verier");
 *   - слова на -ing → порожній список (вимога вчителя);
 *   - дієприкметникові прикметники на -ed (tired, bored, scared) → more/most,
 *     а не псевдо-"tireder"/"boreder";
 *   - жодного штучного дублювання: одна форма = один елемент масиву.
 */
import { getAdjectiveForms, isNonGradable } from './adjective-morphology';
import { resolveQuantityAdjective } from './quantity-adjectives';

const SINGLE_WORD_RE = /^[a-z]+$/;

function normalize(text: string): string {
  return (text ?? '').toLowerCase().trim();
}

/** Прибирає дублі, порожні значення та значення, що дорівнюють базовій формі. */
function clean(forms: Array<string | undefined | null>, base: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of forms) {
    const f = (raw ?? '').toLowerCase().trim();
    if (!f || f === base || seen.has(f)) continue;
    seen.add(f);
    result.push(f);
  }
  return result;
}

/**
 * Неградуальні прислівники — семантично не мають ступенів порівняння.
 * Це підсилювачі, епістемічні модальні, дискурсивні звʼязки, абсолютні
 * вказівки часу/місця та інші слова, для яких "more X" було б помилкою.
 */
// Прислівники способу дії від градуальних прикметників (simply, fairly,
// fully, highly, completely, generally, obviously, suddenly) тут НЕ
// стоять: окрім значення "лише / дуже" вони мають значення "у спосіб",
// де ступені звичайні — "explain more simply", "most simply" (вчитель).
const NON_GRADABLE_ADVERBS = new Set<string>([
  // підсилювачі / ступеневі
  'very', 'too', 'quite', 'rather', 'pretty', 'extremely', 'absolutely',
  'totally', 'entirely', 'nearly', 'almost',
  'hardly', 'barely', 'scarcely', 'merely', 'just', 'only', 'even', 'also',
  'enough',
  // епістемічні / оцінні модальні
  'really', 'actually', 'truly', 'certainly', 'definitely', 'surely', 'probably',
  'possibly', 'perhaps', 'maybe', 'apparently', 'evidently',
  'presumably', 'indeed', 'necessarily', 'basically', 'essentially',
  'especially', 'particularly',
  // дискурсивні / логічні звʼязки
  'therefore', 'however', 'moreover', 'furthermore', 'meanwhile', 'otherwise',
  'likewise', 'accordingly', 'consequently', 'additionally', 'alternatively',
  'similarly', 'thus', 'hence', 'namely', 'instead', 'nevertheless', 'nonetheless',
  // час / частота (абсолютні, неградуальні)
  'always', 'never', 'ever', 'sometimes', 'usually', 'once', 'twice', 'again',
  'already', 'still', 'yet', 'now', 'then', 'today', 'tomorrow', 'yesterday',
  'tonight', 'nowadays', 'currently', 'immediately', 'instantly', 'eventually',
  'finally', 'ultimately', 'lately', 'first', 'last', 'next', 'seldom',
  // періодичні (daily/weekly…) — утворені від іменників часу
  'daily', 'weekly', 'monthly', 'yearly', 'annually', 'hourly', 'nightly',
  // місце / напрям
  'here', 'there', 'away', 'back', 'home', 'together', 'alone', 'ahead',
  'upstairs', 'downstairs', 'inside', 'outside', 'forward', 'backward',
  'forwards', 'backwards', 'upwards', 'downwards', 'onwards', 'elsewhere',
  'somewhere', 'anywhere', 'nowhere', 'everywhere', 'abroad', 'ashore',
  // оцінні вставні / порядкові вставні
  'fortunately', 'unfortunately', 'luckily', 'surprisingly', 'interestingly',
  'firstly', 'secondly', 'thirdly', 'lastly',
  // заперечення / частки
  'not', 'yes', 'no',
]);

/**
 * Неправильні ступені порівняння прислівників. Окремо від quantity-adjectives,
 * бо там немає "badly"/"soon"/"often"/"early", а "well" там змішано з good.
 */
const IRREGULAR_ADVERBS: Record<string, string[]> = {
  well: ['better', 'best'],
  badly: ['worse', 'worst'],
  much: ['more', 'most'],
  little: ['less', 'least'],
  far: ['farther', 'further', 'farthest', 'furthest'],
  early: ['earlier', 'earliest'],
  late: ['later', 'latest'],
  soon: ['sooner', 'soonest'],
  often: ['more often', 'most often'],
};

/**
 * Додаткові неградуальні прикметники/прислівники: порядкові числівники та
 * слова, що ВЖЕ є порівняльним/найвищим ступенем (їх не можна градуювати
 * далі — "more further" є помилкою).
 */
const NON_GRADABLE_EXTRA = new Set<string>([
  // порядкові числівники (не мають ступенів порівняння)
  'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth',
  'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
  'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth',
  'ninetieth', 'hundredth', 'thousandth', 'millionth', 'billionth',
  // слова, що вже є ступенем порівняння
  'better', 'best', 'worse', 'worst', 'more', 'most', 'less', 'least',
  'farther', 'further', 'farthest', 'furthest', 'nearer', 'nearest',
  'lower', 'lowest', 'upper', 'uppermost', 'inner', 'innermost', 'inmost',
  'outer', 'outermost', 'outmost', 'former', 'latter', 'elder', 'eldest',
  'older', 'oldest', 'later', 'latest',
]);

function computeAdjectiveForms(word: string): string[] {
  if (isNonGradable(word) || NON_GRADABLE_EXTRA.has(word)) return [];
  const quantity = resolveQuantityAdjective(word);
  if (quantity && quantity.base === word) {
    return clean([...quantity.comparative, ...quantity.superlative], word);
  }
  // Дієприкметникові прикметники на -ed (tired, bored, scared) → more/most,
  // бо "tireder"/"boreder" не існують. Короткі слова (red, dead) не чіпаємо:
  // "dead" вже у non-gradable, а "red" → redder/reddest.
  if (word.length >= 4 && word.endsWith('ed')) {
    return [`more ${word}`, `most ${word}`];
  }
  const result = getAdjectiveForms(word);
  if (!result || result.hasNoDegree) return [];
  return clean([result.comparative, result.superlative], word);
}

function computeAdverbForms(word: string): string[] {
  if (NON_GRADABLE_ADVERBS.has(word) || isNonGradable(word) || NON_GRADABLE_EXTRA.has(word)) return [];
  const irregular = IRREGULAR_ADVERBS[word];
  if (irregular) return clean([...irregular], word);
  if (word.endsWith('ly')) return [`more ${word}`, `most ${word}`];
  // Плоскі прислівники (hard, fast, high, low, deep, wide, close, straight…)
  // відмінюються за правилами односкладових прикметників (-er/-est).
  const result = getAdjectiveForms(word);
  if (!result || result.hasNoDegree) return [];
  return clean([result.comparative, result.superlative], word);
}

/**
 * Єдина точка обчислення «форм» для картки перекладу. Повертає ступені
 * порівняння лише для прикметників і прислівників; для решти — порожній
 * список. Слова на -ing свідомо виключені (вимога вчителя).
 */
export function computeDegreeForms(
  text: string,
  partOfSpeech: string | null | undefined,
): string[] {
  const word = normalize(text);
  if (!SINGLE_WORD_RE.test(word)) return [];
  if (word.endsWith('ing')) return [];
  if (partOfSpeech === 'adjective') return computeAdjectiveForms(word);
  if (partOfSpeech === 'adverb') return computeAdverbForms(word);
  return [];
}

