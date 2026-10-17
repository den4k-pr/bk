/**
 * context-cues.ts
 *
 * Дешеві (без AI) і надійні граматичні підказки з речення: яке слово стоїть
 * безпосередньо ПЕРЕД натиснутим. Вони не вгадують значення — лише
 * ВИКЛЮЧАЮТЬ неможливі варіанти:
 *   - після артикля / присвійного займенника не буває дієслова
 *     ("the train", "his watch");
 *   - після підметового займенника чи модального дієслова не буває
 *     іменника ("he trains", "I watch", "can train");
 *   - be + -ing — тривалий час ("was training"), have + -ed — перфект.
 *
 * Якщо слово трапляється в реченні кілька разів із різними підказками —
 * підказки немає (обережність важливіша за економію).
 */

export type CueClass =
  | 'determiner'   // далі іменник / прикметник, але не дієслово
  | 'subject'      // далі дієслово
  | 'modal'        // далі базова форма дієслова
  | 'be'           // be + -ing → дієслово (тривалий час)
  | 'have'         // have + -ed → дієслово (перфект)
  | 'gerund'       // keep / stop / without / after … + -ing → дієслівне вживання
  | 'to'           // "to" + базова форма: часто дієслово, але не завжди ("go to work")
  | 'weak_verb';   // and/or/not/never…: дієслово можливе, але не гарантоване

const DETERMINERS = new Set([
  'a', 'an', 'the', 'my', 'your', 'his', 'its', 'our', 'their', 'whose',
  'every', 'each', 'another', 'these', 'those', 'several', 'many', 'few',
  'some', 'any', 'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten',
]);
// "all" / "both" навмисно відсутні: "they all trained", "we both watch".

// "her", "it", "you", "this", "that" навмисно відсутні: вони бувають і
// додатком перед дієсловом ("watched her train", "made you laugh").
const SUBJECTS = new Set(['i', 'we', 'they', 'he', 'she']);

const MODALS = new Set([
  'will', 'would', 'can', 'could', 'should', 'must', 'might', 'may', 'shall',
  'cannot', "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't",
  // do/does/did без заперечення бувають і перед іменником ("did my homework").
  "don't", "doesn't", "didn't", "i'll", "you'll", "we'll",
  "they'll", "he'll", "she'll", "let's",
]);

const BE_FORMS = new Set([
  'am', 'is', 'are', 'was', 'were', 'be', 'been', "i'm", "you're", "we're",
  "they're", "isn't", "aren't", "wasn't", "weren't",
]);

const HAVE_FORMS = new Set([
  'have', 'has', 'had', "i've", "you've", "we've", "they've", "haven't",
  "hasn't", "hadn't", "i'd", "you'd", "we'd", "they'd", "he'd", "she'd",
]);

const WEAK_VERB = new Set([
  'and', 'or', 'not', 'never', 'always', 'often', 'also', 'just', 'please', 'usually', 'sometimes',
  // Після додатка часто стоїть інфінітив без to ("watch him fight", "let me go",
  // "made them laugh"), але буває й іменник ("gave him money") — лише сигнал.
  'him', 'them', 'me', 'us', 'her', 'it', 'you',
]);

// Після них -ing форма вжита дієслівно: "kept telling", "without telling",
// "after leaving". "of" / "for" навмисно відсутні ("the art of telling").
const GERUND_TRIGGERS = new Set([
  'keep', 'keeps', 'kept', 'keeping', 'start', 'starts', 'started', 'stop', 'stops',
  'stopped', 'finish', 'finishes', 'finished', 'avoid', 'avoids', 'avoided', 'enjoy',
  'enjoys', 'enjoyed', 'mind', 'quit', 'continue', 'continued', 'began', 'begin',
  'without', 'after', 'before', 'by', 'while', 'when', 'about',
]);

// Слова, через які дивимось назад до be: "was not telling", "is slowly walking".
const LOOKBEHIND_SKIP = new Set([
  'not', 'never', 'always', 'still', 'just', 'also', 'really', 'already', 'only',
  'even', 'all', 'both', 'constantly', 'actually', "n't",
]);

interface Token {
  text: string;
  /** Присвійна форма: "Ivan's", "fathers'". */
  possessive: boolean;
}

const NOT_POSSESSIVE = new Set(["it's", "he's", "she's", "that's", "what's", "there's", "here's", "who's", "let's"]);

function tokenize(context: string): Token[] {
  return context
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^a-z'-]+/)
    .filter(Boolean)
    .map(raw => {
      const possessive = (/^[a-z]+'s$/.test(raw) && !NOT_POSSESSIVE.has(raw)) || /^[a-z]+s'$/.test(raw);
      return { text: raw.replace(/^['-]+|['-]+$/g, ''), possessive };
    })
    .filter(t => t.text.length > 0);
}

function classifyPrevious(prev: Token | undefined): CueClass | null {
  if (!prev) return null;
  if (prev.possessive || DETERMINERS.has(prev.text)) return 'determiner';
  if (SUBJECTS.has(prev.text)) return 'subject';
  if (MODALS.has(prev.text)) return 'modal';
  if (BE_FORMS.has(prev.text)) return 'be';
  if (HAVE_FORMS.has(prev.text)) return 'have';
  if (prev.text === 'to') return 'to';
  if (WEAK_VERB.has(prev.text)) return 'weak_verb';
  return null;
}

/** Підказка для -ing форми з урахуванням кількох попередніх слів. */
function classifyIngLookbehind(tokens: Token[], i: number): CueClass | null {
  const prev = tokens[i - 1];
  if (!prev) return null;
  if (GERUND_TRIGGERS.has(prev.text)) return 'gerund';
  // be + (до двох прислівників) + -ing — тривалий час.
  for (let j = i - 1, skipped = 0; j >= 0 && skipped <= 2; j--, skipped++) {
    const t = tokens[j].text;
    if (BE_FORMS.has(t)) return 'be';
    if (!(LOOKBEHIND_SKIP.has(t) || /^[a-z]{3,}ly$/.test(t))) return null;
  }
  return null;
}

function classifyAt(tokens: Token[], i: number, target: string): CueClass | null {
  if (target.length > 5 && target.endsWith('ing')) {
    const ingCue = classifyIngLookbehind(tokens, i);
    if (ingCue) return ingCue;
  }
  return classifyPrevious(tokens[i - 1]);
}

/**
 * Підказка для слова surface у реченні context. null — підказки немає
 * (слова в реченні не знайдено, або воно трапляється кілька разів з
 * різними попередніми словами).
 */
export function contextCue(surface: string, context: string | undefined): CueClass | null {
  if (!context) return null;
  const target = surface.toLowerCase();
  const tokens = tokenize(context);
  let found: CueClass | null | undefined;
  let previousOccurrenceCue: CueClass | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== target) continue;
    // Повтор слова ("a long, long time", "very, very") — та сама роль,
    // що й у попереднього входження.
    const cue = tokens[i - 1]?.text === target ? previousOccurrenceCue : classifyAt(tokens, i, target);
    previousOccurrenceCue = cue;
    if (found === undefined) found = cue;
    else if (found !== cue) return null;
  }
  return found ?? null;
}
