/**
 * inflection.ts
 *
 * Детермінована морфологія СЛОВОЗМІНИ (не словотвору) для англійських слів.
 *
 * Головний принцип — перевірка «туди й назад» (round-trip):
 *   слово S вважається формою леми L з частиною мови P лише тоді, коли
 *   пряма відміна L як P (множина / 3-тя особа / минулий час / -ing /
 *   ступені порівняння, включно з неправильними формами) дає саме S.
 *
 * Це відсікає два класи помилок, через які раніше ламався переклад:
 *   - словотвір, який AI або правила плутали зі словозміною:
 *     wooden → wood, golden → gold, teacher → teach, kitchen → kitch;
 *   - збіг тексту з іншою частиною мови: "trained" (форма ДІЄСЛОВА) не
 *     може бути формою іменника "train" (поїзд) — у іменника немає -ed.
 *
 * Пряма генерація свідомо «щедра» (дає кілька написань: travelled /
 * traveled, preferred / prefered): її задача — не перевіряти орфографію,
 * а гарантувати, що S справді є граматичною формою L. Сміттєві
 * кандидати-леми ("listene", "traine") нешкідливі: вони мають ще й
 * існувати у словнику або бути підтверджені AI.
 */
import { IRREGULAR_VERBS } from './verb-morphology';
import { IRREGULAR_NOUNS } from './noun-morphology';

export type LemmaPos = 'verb' | 'noun' | 'adjective';

export type InflectionKind =
  | 'verb_3sg'
  | 'verb_past'
  | 'verb_ing'
  | 'noun_plural'
  | 'adj_comparative'
  | 'adj_superlative';

export const KIND_TO_POS: Record<InflectionKind, LemmaPos> = {
  verb_3sg: 'verb',
  verb_past: 'verb',
  verb_ing: 'verb',
  noun_plural: 'noun',
  adj_comparative: 'adjective',
  adj_superlative: 'adjective',
};

export interface InflectionAnalysis {
  lemma: string;
  pos: LemmaPos;
  kind: InflectionKind;
  /** Форма з таблиці неправильних (went, children, better). */
  irregular: boolean;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (c: string | undefined): boolean => !!c && VOWELS.has(c);
const WORD_RE = /^[a-z]+$/;

// ─── Неправильні форми ──────────────────────────────────────────────────

interface IrregularVerbForms {
  past: string[];
  /** Додаткові форми 3-ї особи (is/am/are для be, has для have). */
  present: string[];
}

const IRREGULAR_VERB_FORMS = new Map<string, IrregularVerbForms>();
for (const v of IRREGULAR_VERBS) {
  IRREGULAR_VERB_FORMS.set(v.base, {
    past: [v.past, ...(v.pastAlternates ?? []), v.participle, ...(v.participleAlternates ?? [])],
    present: [],
  });
}
IRREGULAR_VERB_FORMS.get('be')!.present.push('is', 'am', 'are');
IRREGULAR_VERB_FORMS.get('have')!.present.push('has');

// Префіксальні дієслова успадковують неправильні форми основи
// (re-take → retook, under-go, mis-read), якщо їх немає в таблиці окремо.
const IRREGULAR_PREFIXES = ['re', 'un', 'over', 'under', 'out', 'mis', 'fore', 'with', 'up', 'be'];

function irregularVerbForms(base: string): IrregularVerbForms | null {
  const direct = IRREGULAR_VERB_FORMS.get(base);
  if (direct) return direct;
  for (const prefix of IRREGULAR_PREFIXES) {
    if (base.length - prefix.length < 2 || !base.startsWith(prefix)) continue;
    const inner = IRREGULAR_VERB_FORMS.get(base.slice(prefix.length));
    if (inner && inner.present.length === 0) {
      return { past: inner.past.map(f => prefix + f), present: [] };
    }
  }
  return null;
}

/** Неправильна форма → можливі базові дієслова (saw → see, saw). */
const IRREGULAR_VERB_FORM_TO_BASES = new Map<string, string[]>();
const addReverse = (map: Map<string, string[]>, form: string, base: string) => {
  const list = map.get(form) ?? [];
  if (!list.includes(base)) list.push(base);
  map.set(form, list);
};
IRREGULAR_VERB_FORMS.forEach((forms, base) => {
  for (const f of [...forms.past, ...forms.present]) {
    if (f !== base) addReverse(IRREGULAR_VERB_FORM_TO_BASES, f, base);
  }
});

const IRREGULAR_NOUN_PLURALS = new Map<string, string[]>();
const IRREGULAR_NOUN_PLURAL_TO_SINGULARS = new Map<string, string[]>();
for (const n of IRREGULAR_NOUNS) {
  const list = IRREGULAR_NOUN_PLURALS.get(n.singular) ?? [];
  list.push(n.plural);
  IRREGULAR_NOUN_PLURALS.set(n.singular, list);
  if (n.plural !== n.singular) addReverse(IRREGULAR_NOUN_PLURAL_TO_SINGULARS, n.plural, n.singular);
}

/**
 * Неправильні ступені порівняння. Навмисно без суплетивних форм, які в
 * сучасній мові є окремими словами: last / latter (≠ late), next (≠ nigh),
 * former / first (≠ fore), elder / eldest (≠ old) — інакше "last" ставав
 * би формою "late".
 */
const IRREGULAR_ADJECTIVE_DEGREES: Record<string, { comparative: string[]; superlative: string[] }> = {
  good: { comparative: ['better'], superlative: ['best'] },
  well: { comparative: ['better'], superlative: ['best'] },
  bad: { comparative: ['worse'], superlative: ['worst'] },
  ill: { comparative: ['worse'], superlative: ['worst'] },
  badly: { comparative: ['worse'], superlative: ['worst'] },
  far: { comparative: ['farther', 'further'], superlative: ['farthest', 'furthest'] },
  little: { comparative: ['littler'], superlative: ['littlest'] },
  much: { comparative: ['more'], superlative: ['most'] },
  many: { comparative: ['more'], superlative: ['most'] },
  old: { comparative: ['older'], superlative: ['oldest'] },
};
const IRREGULAR_DEGREE_TO_BASES = new Map<string, Array<{ base: string; kind: InflectionKind }>>();
for (const [base, d] of Object.entries(IRREGULAR_ADJECTIVE_DEGREES)) {
  for (const f of d.comparative) {
    const list = IRREGULAR_DEGREE_TO_BASES.get(f) ?? [];
    list.push({ base, kind: 'adj_comparative' });
    IRREGULAR_DEGREE_TO_BASES.set(f, list);
  }
  for (const f of d.superlative) {
    const list = IRREGULAR_DEGREE_TO_BASES.get(f) ?? [];
    list.push({ base, kind: 'adj_superlative' });
    IRREGULAR_DEGREE_TO_BASES.set(f, list);
  }
}

// ─── Орфографічні правила ───────────────────────────────────────────────

/**
 * Закінчення "приголосна-голосна-приголосна" (stop, plan, prefer), після
 * якого кінцева приголосна може подвоюватися. Для "qu" голосна u
 * рахується приголосною (quit → quitting).
 */
function endsWithDoublingPattern(w: string): boolean {
  const n = w.length;
  if (n < 2) return false;
  const last = w[n - 1];
  const vowel = w[n - 2];
  const before = w[n - 3];
  if (isVowel(last) || 'wxy'.includes(last)) return false;
  if (!isVowel(vowel)) return false;
  if (before === undefined) return true;
  if (!isVowel(before)) return true;
  return before === 'u' && w[n - 4] === 'q';
}

/** Кількість голосних груп (склади, наближено; y не рахується). */
function vowelGroups(w: string): number {
  return (w.match(/[aeiou]+/g) ?? []).length;
}

/**
 * Подвоєння кінцевої приголосної: в односкладових словах (stop, plan,
 * hop) — обов'язкове, тому без нього форма НЕ генерується ("hoped" — це
 * hope, а не hop; "staring" — stare, а не star). У багатоскладових
 * (visit, travel, prefer) правопис варіюється — генеруємо обидва.
 */
function withSuffix(b: string, suffix: string): string[] {
  if (!endsWithDoublingPattern(b)) return [b + suffix];
  const doubled = b + b[b.length - 1] + suffix;
  return vowelGroups(b) <= 1 ? [doubled] : [b + suffix, doubled];
}

function regularThirdPerson(b: string): string[] {
  if (/(s|x|z|ch|sh)$/.test(b)) {
    const out = [b + 'es'];
    if (/[^aeiou][aeiou][sz]$/.test(b)) out.push(b + b[b.length - 1] + 'es'); // quiz → quizzes
    return out;
  }
  if (/[^aeiou]y$/.test(b)) return [b.slice(0, -1) + 'ies'];
  if (/o$/.test(b)) return [b + 'es', b + 's'];
  return [b + 's'];
}

function regularPast(b: string): string[] {
  const out: string[] = [];
  if (/e$/.test(b)) out.push(b + 'd');
  else if (/[^aeiou]y$/.test(b)) out.push(b.slice(0, -1) + 'ied');
  else out.push(...withSuffix(b, 'ed'));
  if (/[aeiou]c$/.test(b)) out.push(b + 'ked'); // panic → panicked
  return out;
}

function regularIng(b: string): string[] {
  const out: string[] = [];
  if (/ie$/.test(b)) {
    out.push(b.slice(0, -2) + 'ying');
  } else if (/e$/.test(b)) {
    // make → making; see/dye/hoe/singe/age зберігають e (seeing, dyeing, ageing)
    if (!/(ee|ye|oe)$/.test(b)) out.push(b.slice(0, -1) + 'ing');
    out.push(b + 'ing');
  } else {
    out.push(...withSuffix(b, 'ing'));
  }
  if (/[aeiou]c$/.test(b)) out.push(b + 'king'); // panic → panicking
  return out;
}

function regularPlurals(b: string): string[] {
  const out: string[] = [];
  if (/(s|x|z|ch|sh)$/.test(b)) {
    out.push(b + 'es');
    if (/[^aeiou][aeiou][sz]$/.test(b)) out.push(b + b[b.length - 1] + 'es'); // bus → busses, quiz → quizzes
  } else if (/[^aeiou]y$/.test(b)) {
    out.push(b.slice(0, -1) + 'ies');
  } else {
    out.push(b + 's');
  }
  if (/o$/.test(b)) out.push(b + 'es'); // potato → potatoes
  if (/[^f]f$/.test(b)) out.push(b.slice(0, -1) + 'ves'); // wolf → wolves
  if (/fe$/.test(b)) out.push(b.slice(0, -2) + 'ves'); // knife → knives
  if (/man$/.test(b) && b.length > 3) out.push(b.slice(0, -3) + 'men'); // fireman → firemen
  if (/is$/.test(b)) out.push(b.slice(0, -2) + 'es'); // analysis → analyses
  if (/us$/.test(b)) out.push(b.slice(0, -2) + 'i'); // cactus → cacti
  if (/um$/.test(b)) out.push(b.slice(0, -2) + 'a'); // bacterium → bacteria
  return out;
}

function regularDegrees(b: string): { comparative: string[]; superlative: string[] } {
  const comparative: string[] = [];
  const superlative: string[] = [];
  if (/e$/.test(b)) {
    comparative.push(b + 'r');
    superlative.push(b + 'st');
  } else if (/[^aeiou]y$/.test(b)) {
    comparative.push(b.slice(0, -1) + 'ier', b + 'er'); // happier; shyer
    superlative.push(b.slice(0, -1) + 'iest', b + 'est');
  } else {
    comparative.push(...withSuffix(b, 'er'));
    superlative.push(...withSuffix(b, 'est'));
  }
  return { comparative, superlative };
}

// ─── Пряма генерація форм ───────────────────────────────────────────────

export interface VerbForms {
  thirdPerson: Set<string>;
  past: Set<string>;
  ing: Set<string>;
}

export function generateVerbForms(base: string): VerbForms {
  const b = base.toLowerCase().trim();
  const irregular = irregularVerbForms(b);
  const thirdPerson = new Set<string>(regularThirdPerson(b));
  const ing = new Set<string>(regularIng(b));
  const past = new Set<string>();

  if (irregular) {
    irregular.past.forEach(f => past.add(f));
    irregular.present.forEach(f => thirdPerson.add(f));
    // Префіксальне дієслово може бути й правильним (relay → relayed).
    if (!IRREGULAR_VERB_FORMS.has(b)) regularPast(b).forEach(f => past.add(f));
  } else {
    regularPast(b).forEach(f => past.add(f));
  }
  return { thirdPerson, past, ing };
}

export function generateNounPlurals(base: string): Set<string> {
  const b = base.toLowerCase().trim();
  const out = new Set<string>(regularPlurals(b));
  (IRREGULAR_NOUN_PLURALS.get(b) ?? []).forEach(p => out.add(p));
  out.delete(b);
  return out;
}

export function generateAdjectiveDegrees(base: string): { comparative: Set<string>; superlative: Set<string> } {
  const b = base.toLowerCase().trim();
  const irregular = IRREGULAR_ADJECTIVE_DEGREES[b];
  if (irregular) {
    return { comparative: new Set(irregular.comparative), superlative: new Set(irregular.superlative) };
  }
  const r = regularDegrees(b);
  return { comparative: new Set(r.comparative), superlative: new Set(r.superlative) };
}

/**
 * Чи є surface граматичною формою lemma (з частиною мови pos, якщо
 * вказана). Повертає вид форми або null. surface === lemma → null
 * (це не форма, а саме слово).
 */
export function inflectionKindOf(surface: string, lemma: string, pos?: LemmaPos | null): InflectionKind | null {
  const s = surface.toLowerCase().trim();
  const l = lemma.toLowerCase().trim();
  if (!s || !l || s === l || !WORD_RE.test(s) || !WORD_RE.test(l)) return null;

  if (!pos || pos === 'verb') {
    const v = generateVerbForms(l);
    if (v.past.has(s)) return 'verb_past';
    if (v.ing.has(s)) return 'verb_ing';
    if (v.thirdPerson.has(s)) return 'verb_3sg';
  }
  if (!pos || pos === 'noun') {
    if (generateNounPlurals(l).has(s)) return 'noun_plural';
  }
  if (!pos || pos === 'adjective') {
    const d = generateAdjectiveDegrees(l);
    if (d.comparative.has(s)) return 'adj_comparative';
    if (d.superlative.has(s)) return 'adj_superlative';
  }
  return null;
}

// ─── Зворотний аналіз ───────────────────────────────────────────────────

const SHORT_LEMMAS = new Set(['be', 'do', 'go', 'ox']);

/** Кандидати-леми за правилами відсікання закінчень (ще без перевірки). */
function strippingCandidates(s: string): Set<string> {
  const c = new Set<string>();
  const add = (v: string) => {
    if (v && v !== s) c.add(v);
  };
  const undouble = (stem: string) => {
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) add(stem.slice(0, -1));
  };

  // -s / -es / -ies / -ves / -men / -i / -a / -es (is)
  if (s.endsWith('ies')) add(s.slice(0, -3) + 'y');
  if (s.endsWith('es')) {
    add(s.slice(0, -2));
    add(s.slice(0, -1));
    undouble(s.slice(0, -2));
    add(s.slice(0, -2) + 'is');
  }
  if (s.endsWith('s')) add(s.slice(0, -1));
  if (s.endsWith('ves')) {
    add(s.slice(0, -3) + 'f');
    add(s.slice(0, -3) + 'fe');
  }
  if (s.endsWith('men')) add(s.slice(0, -3) + 'man');
  if (s.endsWith('i')) add(s.slice(0, -1) + 'us');
  if (s.endsWith('a')) add(s.slice(0, -1) + 'um');

  // -ed / -d / -ied / -cked
  if (s.endsWith('ied')) add(s.slice(0, -3) + 'y');
  if (s.endsWith('ed')) {
    const stem = s.slice(0, -2);
    add(stem);
    undouble(stem);
    if (stem.endsWith('ck')) add(stem.slice(0, -1));
  }
  if (s.endsWith('d')) add(s.slice(0, -1));

  // -ing / -ying
  if (s.endsWith('ing')) {
    const stem = s.slice(0, -3);
    add(stem);
    add(stem + 'e');
    undouble(stem);
    if (stem.endsWith('ck')) add(stem.slice(0, -1));
    if (stem.endsWith('y')) add(stem.slice(0, -1) + 'ie');
  }

  // -er / -est / -ier / -iest
  if (s.endsWith('ier')) add(s.slice(0, -3) + 'y');
  if (s.endsWith('iest')) add(s.slice(0, -4) + 'y');
  if (s.endsWith('er')) {
    add(s.slice(0, -2));
    add(s.slice(0, -1));
    undouble(s.slice(0, -2));
  }
  if (s.endsWith('est')) {
    add(s.slice(0, -3));
    add(s.slice(0, -2));
    undouble(s.slice(0, -3));
  }

  return c;
}

function isAcceptableLemmaShape(lemma: string, fromIrregularTable: boolean): boolean {
  if (!WORD_RE.test(lemma)) return false;
  if (!/[aeiouy]/.test(lemma)) return false;
  if (lemma.length < 3 && !fromIrregularTable && !SHORT_LEMMAS.has(lemma)) return false;
  return true;
}

/**
 * Усі граматично можливі розбори слова як форми іншої леми. Кожен розбір
 * перевірено прямою генерацією. Порядок: неправильні форми першими, далі
 * дієслівні, іменникові, прикметникові.
 */
export function analyzeInflections(surface: string): InflectionAnalysis[] {
  const s = surface.toLowerCase().trim();
  if (!WORD_RE.test(s) || s.length < 2) return [];

  const result: InflectionAnalysis[] = [];
  const seen = new Set<string>();
  const push = (lemma: string, pos: LemmaPos, kind: InflectionKind, irregular: boolean) => {
    const key = `${lemma}|${pos}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ lemma, pos, kind, irregular });
  };

  // 1. Неправильні форми з таблиць.
  for (const base of IRREGULAR_VERB_FORM_TO_BASES.get(s) ?? []) {
    const kind = inflectionKindOf(s, base, 'verb');
    if (kind) push(base, 'verb', kind, true);
  }
  for (const singular of IRREGULAR_NOUN_PLURAL_TO_SINGULARS.get(s) ?? []) {
    push(singular, 'noun', 'noun_plural', true);
  }
  for (const { base, kind } of IRREGULAR_DEGREE_TO_BASES.get(s) ?? []) {
    push(base, 'adjective', kind, true);
  }
  // Префіксальні неправильні (retook → retake, misled → mislead).
  for (const prefix of IRREGULAR_PREFIXES) {
    if (!s.startsWith(prefix) || s.length - prefix.length < 2) continue;
    for (const base of IRREGULAR_VERB_FORM_TO_BASES.get(s.slice(prefix.length)) ?? []) {
      const lemma = prefix + base;
      const kind = inflectionKindOf(s, lemma, 'verb');
      if (kind) push(lemma, 'verb', kind, true);
    }
  }

  // 2. Правильні форми: кандидати за відсіканням + пряма перевірка.
  const candidates = Array.from(strippingCandidates(s)).filter(l => isAcceptableLemmaShape(l, false));
  const order: LemmaPos[] = ['verb', 'noun', 'adjective'];
  for (const pos of order) {
    for (const lemma of candidates) {
      const kind = inflectionKindOf(s, lemma, pos);
      if (kind) push(lemma, pos, kind, false);
    }
  }

  return result;
}

/** Чи має слово взагалі вигляд словозмінної форми (для швидких перевірок). */
export function looksInflected(surface: string): boolean {
  return analyzeInflections(surface).length > 0;
}

// ─── Частини мови записів словника ──────────────────────────────────────

export type PosClass = 'noun' | 'verb' | 'adjective' | 'adverb' | 'other' | 'unknown';

/** Клас частини мови запису БД (null / 'none' → невідомо). */
export function posClassOf(partOfSpeech: string | null | undefined): PosClass {
  switch ((partOfSpeech ?? '').toLowerCase()) {
    case 'noun':
    case 'pronoun':
    case 'numeral':
      return 'noun';
    case 'verb':
    case 'modal_verb':
      return 'verb';
    case 'adjective':
      return 'adjective';
    // Окремий клас: "hard" (важкий) і "hard" (старанно) — різні значення.
    case 'adverb':
      return 'adverb';
    case '':
    case 'none':
      return 'unknown';
    default:
      return 'other';
  }
}

/**
 * Чи може запис словника з частиною мови entryPos мати форму виду kind.
 * Невідома частина мови (legacy-записи) допускається для дієслівних та
 * іменникових форм, але НЕ для ступенів порівняння ("corner" ≠ "corn"+er).
 */
export function isPosCompatibleWithKind(entryPos: string | null | undefined, kind: InflectionKind): boolean {
  const cls = posClassOf(entryPos);
  const needed = KIND_TO_POS[kind];
  if (cls === 'unknown') return needed !== 'adjective';
  if (needed === 'verb') return cls === 'verb';
  if (needed === 'noun') return cls === 'noun';
  return cls === 'adjective' || cls === 'adverb'; // faster, harder — і прислівники
}

/** Частина мови відповіді AI → клас для морфологічної перевірки. */
export function lemmaPosOf(partOfSpeech: string | null | undefined): LemmaPos | null {
  const cls = posClassOf(partOfSpeech);
  if (cls === 'verb' || cls === 'noun' || cls === 'adjective') return cls;
  if (cls === 'adverb') return 'adjective'; // ступені порівняння ті самі
  return null;
}

export const INFLECTION_KIND_LABEL_UK: Record<InflectionKind, string> = {
  verb_3sg: 'форма 3-ї особи однини дієслова',
  verb_past: 'форма минулого часу / дієприкметник дієслова',
  verb_ing: '-ing форма дієслова',
  noun_plural: 'форма множини іменника',
  adj_comparative: 'вищий ступінь прикметника',
  adj_superlative: 'найвищий ступінь прикметника',
};
