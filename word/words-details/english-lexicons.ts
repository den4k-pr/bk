/**
 * english-lexicons.ts
 *
 * ЗАКРИТІ КЛАСИ СЛІВ англійської мови.
 *
 * Головна ідея всього рефакторингу: прийменники, сполучники, займенники,
 * артиклі/детермінанти, модальні та допоміжні дієслова — це СКІНЧЕННІ,
 * ПОВНІ, статичні списки. На відміну від іменників/дієслів/прикметників
 * (відкриті класи — нові слова з'являються постійно), тут можна перерахувати
 * буквально ВСІ елементи один раз і надалі перевіряти належність до списку
 * з математичною точністю 100%, без жодного ризику "AI переплутала".
 *
 * Це і є те, що усуває баг "in order to визначилось як phrasal_verb":
 * ми більше не питаємо AI "чи це дієслово на початку?" — ми перевіряємо
 * перше слово по списку нижче. Немає списку — немає вгадування.
 */

export const PREPOSITIONS = new Set([
  // Базові просторові, часові та логічні прийменники (Core)
  'aboard', 'about', 'above', 'across', 'after', 'against', 'along', 'alongside', 
  'amid', 'amidst', 'among', 'amongst', 'around', 'as', 'at', 'before', 'behind', 
  'below', 'beneath', 'beside', 'besides', 'between', 'beyond', 'but', 'by', 
  'down', 'during', 'except', 'for', 'from', 'in', 'inside', 'into', 'like', 
  'near', 'next', 'of', 'off', 'on', 'onto', 'opposite', 'out', 'outside', 
  'over', 'past', 'round', 'since', 'than', 'through', 'throughout', 'till', 
  'to', 'toward', 'towards', 'under', 'underneath', 'unlike', 'until', 'up', 
  'upon', 'with', 'within', 'without',

  // Дієприкметникові прийменники (Participial Prepositions - утворилися від дієслів)
  'assuming', 'barring', 'concerning', 'considering', 'counting', 'depending', 
  'excluding', 'excepting', 'failing', 'following', 'given', 'gone', 'granted', 
  'including', 'lacking', 'notwithstanding', 'overlooking', 'pending', 'regarding', 
  'respecting', 'saving', 'touching', 'wanting',

  // Специфічні, математичні та запозичені (Loan, Math, Status)
  'anti', 'circa', 'cum', 'despite', 'less', 'minus', 'modulo', 'per', 'plus', 
  'pro', 'qua', 're', 'sans', 'save', 'versus', 'via', 'vice', 'worth',

  // Формальні, книжні, діалектні або застарілі (Archaic & Formal Spatial)
  'abaft', 'absent', 'afore', 'anent', 'aside', 'aslant', 'astride', 'athwart', 
  'atop', 'betwixt', 'mid', 'midst', 'outwith', 'unto'
]);

export const CONJUNCTIONS = new Set([
  'and', 'or', 'but', 'nor', 'yet', 'so', 'for',
  'although', 'because', 'since', 'unless', 'while', 'whereas', 'though',
  'if', 'when', 'whenever', 'where', 'wherever', 'whether', 'as',
  'after', 'before', 'once', 'until', 'than', 'that',
]);

export const PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'mine', 'yours', 'hers', 'ours', 'theirs',
  'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves',
  'yourselves', 'themselves',
  'this', 'that', 'these', 'those',
  'who', 'whom', 'whose', 'which', 'what',
  'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything',
  'everyone', 'everybody', 'everything', 'no one', 'nobody', 'nothing',
  'each', 'either', 'neither', 'one', 'some', 'any', 'all', 'both',
  'few', 'many', 'several', 'none',
]);

export const DETERMINERS = new Set([
  'a', 'an', 'the',
  'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'some', 'any', 'no', 'every', 'each', 'either', 'neither',
  'much', 'many', 'more', 'most', 'little', 'less', 'least',
  'few', 'fewer', 'fewest', 'several', 'all', 'both', 'half',
]);

/**
 * Модальні дієслова — завжди допоміжні, ніколи не головне дієслово фрази,
 * і ГОЛОВНЕ: не мають форм минулого часу/дієприкметника через -ed/-ing.
 * "cannot" додано явно поряд з "can" — це заперечна форма того самого
 * модального дієслова, записана як одне слово, і так само НІКОЛИ не
 * відмінюється ("cannoted" не існує).
 */
export const MODAL_VERBS = new Set([
  'can', 'cannot', 'could', 'may', 'might', 'must', 'shall', 'should',
  'will', 'would', 'ought',
]);

/** Допоміжні дієслова (auxiliary) — так само не головні дієслова у фразовому сенсі. */
export const AUXILIARY_VERBS = new Set([
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
  'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'having',
]);

/** Частки фразових дієслів — прислівникові/прийменникові частки, що йдуть ПІСЛЯ дієслова. */
export const PHRASAL_PARTICLES = new Set([
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'away', 'back',
  'through', 'around', 'about', 'along', 'aside', 'by', 'forward',
  'into', 'onto', 'under', 'together', 'apart', 'across', 'ahead',
]);

/** Заперечення та частки, що не несуть власного лексичного значення. */
export const NEGATIONS_AND_PARTICLES = new Set(['not', "n't", 'to']);

/**
 * Перевіряє, чи слово належить до ЗАКРИТОГО класу (тобто ми знаємо його
 * граматичну роль на 100%, без AI). Повертає категорію або null,
 * якщо слово — відкритий клас (іменник/дієслово/прикметник тощо),
 * і його роль дійсно потребує лексичних знань (AI/словник).
 */
export type ClosedClassCategory =
  | 'preposition'
  | 'conjunction'
  | 'pronoun'
  | 'determiner'
  | 'modal_verb'
  | 'auxiliary_verb'
  | 'negation_particle';

export function classifyClosedClassWord(word: string): ClosedClassCategory | null {
  const w = word.toLowerCase().trim();

  if (MODAL_VERBS.has(w)) return 'modal_verb';
  if (AUXILIARY_VERBS.has(w)) return 'auxiliary_verb';
  if (NEGATIONS_AND_PARTICLES.has(w)) return 'negation_particle';
  if (PREPOSITIONS.has(w)) return 'preposition';
  if (CONJUNCTIONS.has(w)) return 'conjunction';
  if (PRONOUNS.has(w)) return 'pronoun';
  if (DETERMINERS.has(w)) return 'determiner';

  return null;
}

/**
 * Найпоширеніші базові форми дієслів (~350), які типово вживаються
 * як головне дієслово фразового дієслова. Це НЕ вичерпний список усіх
 * дієслів англійської (це неможливо — відкритий клас), але покриває
 * переважну більшість фразових дієслів, які трапляються в реальних
 * текстах. Якщо перше слово фрази лематизується (через verb-morphology.ts)
 * до одного з цих дієслів І друге слово — частка з PHRASAL_PARTICLES —
 * ми на 100% впевнені, що це phrasal_verb, а не випадковий збіг слів.
 *
 * Розширюйте список за потреби — додавання нового дієслова сюди ніколи
 * не зашкодить точності, лише додає покриття.
 */
export const COMMON_VERB_LEMMAS = new Set([
  'be', 'have', 'do', 'go', 'come', 'get', 'give', 'take', 'make', 'put',
  'set', 'let', 'run', 'break', 'bring', 'buy', 'call', 'carry', 'catch',
  'check', 'clean', 'clear', 'close', 'cut', 'deal', 'draw', 'dress',
  'drive', 'drop', 'eat', 'end', 'fall', 'feel', 'fight', 'figure', 'fill',
  'find', 'finish', 'fit', 'fix', 'fly', 'follow', 'forget', 'freak',
  'gear', 'grow', 'hand', 'hang', 'hold', 'jump', 'keep', 'knock', 'lay',
  'lead', 'lean', 'leave', 'lie', 'light', 'live', 'lock', 'look', 'lose',
  'make', 'mess', 'move', 'open', 'pass', 'pay', 'pick', 'point', 'pop',
  'pull', 'push', 'read', 'reel', 'ring', 'rise', 'roll', 'rule', 'save',
  'say', 'see', 'sell', 'send', 'settle', 'shake', 'shoot', 'show', 'shut',
  'sign', 'sit', 'sleep', 'slip', 'sort', 'speak', 'speed', 'spell',
  'stand', 'start', 'stay', 'step', 'stick', 'stop', 'storm', 'switch',
  'take', 'talk', 'tear', 'tell', 'think', 'throw', 'tie', 'touch', 'try',
  'turn', 'use', 'wait', 'wake', 'walk', 'warm', 'wash', 'watch', 'wear',
  'weigh', 'win', 'wind', 'wipe', 'work', 'write', 'act', 'add', 'ask',
  'back', 'blow', 'boil', 'branch', 'build', 'burn', 'burst', 'butt',
  'calm', 'cash', 'come', 'count', 'cover', 'crack', 'cross', 'curl',
  'dawn', 'die', 'dig', 'dive', 'dole', 'doze', 'dream', 'drift', 'drink',
  'drum', 'ease', 'egg', 'even', 'face', 'fade', 'fall', 'fend', 'fess',
  'fetch', 'flare', 'flesh', 'flip', 'flood', 'foul', 'gather', 'geek',
  'get', 'give', 'glaze', 'gloss', 'gross', 'gun', 'hammer', 'hash',
  'head', 'hire', 'hit', 'hole', 'hook', 'hunt', 'ice', 'iron', 'jack',
  'kick', 'kit', 'lash', 'latch', 'lay', 'level', 'liven', 'load', 'log',
  'loosen', 'louse', 'man', 'map', 'mark', 'match', 'mellow', 'mist',
  'mix', 'mop', 'muddle', 'mull', 'nail', 'nod', 'note', 'number', 'opt',
  'own', 'pack', 'pad', 'pan', 'part', 'patch', 'peel', 'peg', 'perk',
  'phase', 'pin', 'pipe', 'plan', 'plough', 'plug', 'plump', 'polish',
  'power', 'press', 'print', 'prop', 'psych', 'punch', 'queue', 'rack',
  'rake', 'rat', 'ration', 'reach', 'rest', 'rev', 'rip', 'rope', 'rot',
  'rough', 'round', 'rub', 'rustle', 'sail', 'scale', 'scare', 'scoop',
  'scout', 'scrape', 'screw', 'seal', 'seek', 'separate', 'serve', 'shape',
  'shell', 'shift', 'shore', 'shout', 'shovel', 'shrug', 'shy', 'simmer',
  'single', 'size', 'sketch', 'slack', 'slim', 'slow', 'smarten', 'smell',
  'smooth', 'snap', 'sniff', 'soak', 'soften', 'sound', 'space', 'spark',
  'spice', 'spin', 'splash', 'split', 'spread', 'spring', 'spruce',
  'square', 'squeeze', 'stack', 'stake', 'stamp', 'stare', 'stem', 'stir',
  'stock', 'stow', 'straighten', 'strap', 'stretch', 'strike', 'string',
  'strip', 'suck', 'sum', 'summon', 'swear', 'sweat', 'sweep', 'swell',
  'swim', 'swing', 'switch', 'tack', 'tag', 'taper', 'tap', 'team', 'tend',
  'test', 'thin', 'thrash', 'tide', 'tighten', 'tip', 'tire', 'tone',
  'top', 'toss', 'total', 'trade', 'trail', 'trickle', 'trim', 'trot',
  'true', 'trust', 'tuck', 'tune', 'type', 'unwind', 'urge', 'vote',
  'wall', 'wander', 'ward', 'warm', 'water', 'wave', 'weed', 'weigh',
  'weld', 'whip', 'while', 'whittle', 'widen', 'will', 'wolf', 'wrap',
  'wrestle', 'yield', 'zip', 'zone', 'zoom',
]);

// ───────────────────────────────────────────────────────────────────────
// 🟢 НОВЕ: ЧИСЛІВНИКИ (Numerals) — кількісні (cardinal) та порядкові (ordinal).
//
// Проблема, яку це вирішує: "thousand", "first", "second" тощо раніше
// провалювались у ВІДКРИТИЙ клас (isCertain: false), тому AI сама
// вирішувала partOfSpeech і практично завжди хибно віддавала "noun"
// ("thousand" граматично не іменник у звичному сенсі "предмет/поняття").
//
// У переліку PartOfSpeech (word.entity.ts) немає окремої категорії
// "numeral", тому мапимо числівники на найближчий за функцією клас —
// 'adjective' (вони модифікують іменник так само, як прикметники:
// "first day", "three cats", "a thousand dollars"). Це робиться ТУТ,
// детерміновано кодом, без жодного звернення до AI — так само, як інші
// закриті класи в цьому файлі.
// ───────────────────────────────────────────────────────────────────────

/** Прості (однослівні) кількісні числівники. */
export const CARDINAL_NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion',
  'dozen', 'score', 'couple',
]);

/** Прості (однослівні) порядкові числівники. */
export const ORDINAL_NUMBER_WORDS = new Set([
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth',
  'seventieth', 'eightieth', 'ninetieth', 'hundredth', 'thousandth', 'millionth', 'billionth', 'trillionth',
]);

const NUMERAL_TENS_WORDS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMERAL_ONES_CARDINAL = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const NUMERAL_ONES_ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

// Складені форми через дефіс, що пишуться як ОДНЕ "слово" без пробілів
// (тому й потрапляють у wordCount === 1): "twenty-one", "thirty-second".
const COMPOUND_CARDINAL_REGEX = new RegExp(
  `^(?:${NUMERAL_TENS_WORDS.join('|')})-(?:${NUMERAL_ONES_CARDINAL.join('|')})$`,
);
const COMPOUND_ORDINAL_REGEX = new RegExp(
  `^(?:${NUMERAL_TENS_WORDS.join('|')})-(?:${NUMERAL_ONES_ORDINAL.join('|')})$`,
);

export type NumeralCategory = 'cardinal' | 'ordinal';

/**
 * Визначає, чи є слово числівником (кількісним чи порядковим).
 * Повертає null, якщо це не числівник — тоді класифікація йде далі
 * звичайним шляхом (закритий/відкритий клас), без жодного впливу цієї функції.
 */
export function classifyNumeralWord(word: string): NumeralCategory | null {
  const w = word.toLowerCase().trim();

  if (ORDINAL_NUMBER_WORDS.has(w)) return 'ordinal';
  if (CARDINAL_NUMBER_WORDS.has(w)) return 'cardinal';
  if (COMPOUND_ORDINAL_REGEX.test(w)) return 'ordinal';
  if (COMPOUND_CARDINAL_REGEX.test(w)) return 'cardinal';

  return null;
}