import { lemmatizeVerb } from './verb-morphology';
import { lemmatizeNoun } from './noun-morphology';
import { classifyClosedClassWord } from './english-lexicons';
import { isIngAdjective } from './ing-adjectives';

/**
 * Лексичні винятки для пошуку слова в БД.
 *
 * Проблема: запит зводився до леми сліпими правилами й одразу шукався в БД
 * ("training" → "train", "tired" → "tire", "used" → "us", "news" → "new",
 * "does" → "doe"). Якщо така лема існувала — користувач отримував інше
 * слово з іншим значенням.
 *
 *  - STANDALONE_WORDS — слова, які ЗАВЖДИ є окремою словниковою одиницею,
 *    хоч і виглядають як форма іншого слова. Їх ніколи не зводимо до леми.
 *  - AMBIGUOUS_FORMS  — слова, що бувають і формою іншого слова, і окремим
 *    словом ("left" — "залишив" / "лівий", "training" — "тренується" /
 *    "тренування"). Для них рішення ухвалюється за контекстом речення;
 *    без контексту — показуємо саме слово, а не лему.
 *  - Будь-яке слово на "-ing" теж вважається неоднозначним (герундій /
 *    віддієслівний іменник vs форма дієслова).
 */

export const STANDALONE_WORDS = new Set<string>([
  // -ing, що не є формою дієслова (або значення давно відокремилось)
  'during', 'nothing', 'something', 'anything', 'everything', 'thing', 'things',
  'morning', 'evening', 'ceiling', 'king', 'ring', 'spring', 'string', 'sibling',
  'darling', 'pudding', 'awning', 'herring', 'duckling', 'earring', 'offspring',
  'interesting', 'boring', 'outstanding', 'willing', 'breathtaking',
  // -ed / -en прикметники
  'naked', 'wicked', 'rugged', 'sacred', 'beloved', 'crooked', 'ragged',
  'wretched', 'hundred', 'kindred',
  // -s, що не є множиною / 3-ю особою
  'news', 'physics', 'mathematics', 'maths', 'economics', 'politics',
  'athletics', 'gymnastics', 'ethics', 'linguistics', 'statistics', 'species',
  'series', 'clothes', 'stairs', 'goods', 'thanks', 'scissors', 'trousers',
  'pants', 'jeans', 'shorts', 'pajamas', 'pyjamas', 'outskirts', 'surroundings',
  'belongings', 'earnings', 'savings', 'headquarters', 'congratulations',
  'always', 'perhaps', 'across', 'less', 'unless', 'bus', 'gas', 'yes', 'plus',
  'bonus', 'virus', 'campus', 'census', 'chaos', 'lens', 'atlas', 'canvas',
  'christmas', 'thus', 'famous', 'nervous', 'serious', 'various', 'previous',
  'obvious', 'curious', 'jealous', 'anxious', 'dangerous', 'generous',
  'delicious', 'enormous', 'precious', 'tennis', 'basis', 'crisis', 'analysis',
  'besides', 'sometimes', 'afterwards', 'towards', 'upwards', 'downwards',
  'backwards', 'forwards', 'whereas', 'overseas', 'nowadays',
]);

/**
 * Слово → леми, формою яких воно МОЖЕ бути. Крім цього списку неоднозначними
 * вважаються всі слова на "-ing" (див. isAmbiguousForm).
 */
export const AMBIGUOUS_FORMS = new Map<string, string[]>([
  // неправильні дієслова, чия форма збігається з іншим словом
  ['left', ['leave']], ['felt', ['feel']], ['found', ['find']], ['saw', ['see']],
  ['lay', ['lie']], ['fell', ['fall']], ['rose', ['rise']], ['bore', ['bear']],
  ['wound', ['wind']], ['ground', ['grind']], ['lives', ['live', 'life']],
  ['leaves', ['leave', 'leaf']], ['means', ['mean']], ['glasses', ['glass']],
  ['arms', ['arm']], ['customs', ['custom']], ['manners', ['manner']],
  ['spirits', ['spirit']], ['works', ['work']], ['papers', ['paper']],
  ['minutes', ['minute']], ['directions', ['direction']], ['remains', ['remain']],
  ['letters', ['letter']], ['used', ['use']], ['born', ['bear']],
  // -ed прикметники, які часто плутаються з формою дієслова
  ['tired', ['tire']], ['bored', ['bore']], ['interested', ['interest']],
  ['excited', ['excite']], ['surprised', ['surprise']], ['worried', ['worry']],
  ['scared', ['scare']], ['frightened', ['frighten']], ['married', ['marry']],
  ['advanced', ['advance']], ['experienced', ['experience']], ['retired', ['retire']],
  ['pleased', ['please']], ['satisfied', ['satisfy']], ['disappointed', ['disappoint']],
  ['embarrassed', ['embarrass']], ['confused', ['confuse']], ['annoyed', ['annoy']],
  ['amazed', ['amaze']], ['shocked', ['shock']], ['relaxed', ['relax']],
  ['exhausted', ['exhaust']], ['depressed', ['depress']], ['determined', ['determine']],
  ['concerned', ['concern']], ['involved', ['involve']], ['supposed', ['suppose']],
  ['limited', ['limit']], ['skilled', ['skill']], ['talented', ['talent']],
  ['crowded', ['crowd']], ['broken', ['break']], ['hidden', ['hide']],
  ['frozen', ['freeze']], ['spoken', ['speak']], ['written', ['write']],
  ['drunk', ['drink']], ['lost', ['lose']], ['closed', ['close']],
  ['opened', ['open']], ['armed', ['arm']], ['named', ['name']],
]);

/**
 * -ing прикметники, що водночас є звичайною формою дієслова: "The water is
 * boiling" — кипить, "a boiling kettle" — киплячий. Раніше вони були в
 * STANDALONE_WORDS, і дієслівне прочитання не розглядалось узагалі. Тепер
 * значення обирається за реченням (як для будь-якої -ing форми), а
 * прикметник лишається одним із варіантів. Адмінський список
 * "-ing прикметників" має ту саму семантику.
 */
export const DUAL_ING_WORDS = new Set<string>([
  'amazing', 'exciting', 'surprising', 'confusing', 'disappointing', 'annoying',
  'frightening', 'terrifying', 'embarrassing', 'tiring', 'relaxing', 'charming',
  'shocking', 'fascinating', 'depressing', 'satisfying', 'convincing', 'promising',
  'amusing', 'astonishing', 'boiling', 'challenging', 'demanding', 'encouraging',
  'entertaining', 'exhausting', 'frustrating', 'inspiring', 'overwhelming',
  'pleasing', 'refreshing', 'rewarding', 'stunning', 'thrilling', 'touching',
  'upsetting', 'worrying', 'alarming', 'appalling', 'disgusting',
]);

const VOWEL = /[aeiouy]/;
const SHORT_LEMMAS = new Set(['be', 'do', 'go', 'ox']);

export function isStandaloneWord(word: string): boolean {
  return STANDALONE_WORDS.has(word.toLowerCase().trim());
}

/** -ing слово, яке буває і прикметником, і формою дієслова (див. DUAL_ING_WORDS). */
export function isDualIngWord(word: string): boolean {
  const w = word.toLowerCase().trim();
  return DUAL_ING_WORDS.has(w) || isIngAdjective(w);
}

export function isAmbiguousForm(word: string): boolean {
  const w = word.toLowerCase().trim();
  if (w.includes(' ')) return false;
  if (AMBIGUOUS_FORMS.has(w)) return true;
  return w.length > 5 && w.endsWith('ing');
}

/**
 * Кандидати-леми для однослівного запиту (без самого запиту), у порядку
 * пріоритету: спершу явні (AMBIGUOUS_FORMS), потім дієслівна, потім іменникова.
 * Сміттєві "леми" без голосної чи з 1 літери відкидаються ("thing" → "th").
 * Для службових слів (this, his, was, does…) іменникові правила не
 * застосовуються — інакше "does" → "doe", "this" → "thi".
 */
export function buildSafeLemmaCandidates(word: string): string[] {
  const w = word.toLowerCase().trim();
  if (!w || w.includes(' ') || STANDALONE_WORDS.has(w)) return [];

  const result: string[] = [];
  const push = (candidate: string | undefined) => {
    if (!candidate) return;
    const c = candidate.toLowerCase().trim();
    if (c === w || !VOWEL.test(c) || result.includes(c)) return;
    // Лема коротша за 3 літери буває лише в кількох дієслів
    // ("need" → "ne", "seed" → "se" — сміття).
    if (c.length < 3 && !SHORT_LEMMAS.has(c)) return;
    result.push(c);
  };

  (AMBIGUOUS_FORMS.get(w) ?? []).forEach(push);

  const closedClass = classifyClosedClassWord(w);
  if (closedClass) {
    // Лише допоміжні/модальні дієслова мають лему (was → be, does → do).
    if (closedClass === 'auxiliary_verb' || closedClass === 'modal_verb') {
      push(lemmatizeVerb(w));
    }
    return result;
  }

  // Для не-службового слова лема не може бути службовим словом
  // ("used" → "us", "hers" → "her"). Допоміжні дієслова дозволені (doing → do).
  const pushContent = (candidate: string | undefined) => {
    const cls = candidate ? classifyClosedClassWord(candidate.toLowerCase().trim()) : null;
    if (cls && cls !== 'auxiliary_verb' && cls !== 'modal_verb') return;
    push(candidate);
  };

  // dying/lying/tying → die/lie/tie; lies/ties/pies → lie/tie/pie
  // (правила нижче дали б "dy"/"ly").
  if (/^[a-z]{1,2}ying$/.test(w)) pushContent(w.slice(0, -4) + 'ie');
  else if (/^[a-z]{1,2}ies$/.test(w)) pushContent(w.slice(0, -1));
  else pushContent(lemmatizeVerb(w));

  const noun = lemmatizeNoun(w);
  // "-oes"/"-ses": правила дають лише один варіант, додаємо другий
  // (shoes → shoe, heroes → hero; houses → house, buses → bus).
  if (!/^[a-z]{1,2}ies$/.test(w)) pushContent(noun);
  if (/(oes|ses)$/.test(w)) pushContent(w.slice(0, -2));

  return result;
}
