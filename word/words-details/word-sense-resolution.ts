/**
 * word-sense-resolution.ts
 *
 * Чиста (без БД і AI) логіка вибору словникового запису для ОДНОГО слова,
 * на яке натиснули в тексті.
 *
 * Вхід: слово, його морфологічні розбори (inflection.ts), записи словника,
 * що можуть йому відповідати, і граматична підказка з речення
 * (context-cues.ts). Вихід — план: повернути наявний запис, створити нове
 * значення (напр. "train" як ДІЄСЛОВО, коли в словнику є лише іменник
 * "поїзд"), запитати AI (лише коли варіантів справді кілька) або піти
 * повним шляхом генерації для невідомого слова.
 *
 * Гарантії:
 *   - форма приймається лише якщо вона граматично утворюється від леми
 *     (round-trip), і лише від запису з сумісною частиною мови
 *     ("trained" ніколи не стане іменником "train");
 *   - словотвір не зводиться до іншого слова (wooden ≠ wood);
 *   - AI потрібен тільки коли є реальна неоднозначність.
 */
import {
  InflectionAnalysis,
  InflectionKind,
  KIND_TO_POS,
  PosClass,
  isPosCompatibleWithKind,
  posClassOf,
} from './inflection';
import { CueClass } from './context-cues';
import { isKnownVerbLemma } from './english-verb-lexicon';
import { ADVERBS_AFTER_DETERMINER, FLAT_ADVERBS, NOUN_ADJECTIVE_HOMOGRAPHS } from './flat-adverbs';

export interface LexEntry {
  id: number;
  text: string;
  partOfSpeech: string | null;
  forms?: string[] | null;
  translation?: string | null;
  senseKey?: string | null;
}

export type SenseOptionKind = 'surface' | 'forms' | 'base' | InflectionKind;

export interface SenseOption {
  /** Стабільний ідентифікатор для AI-вибору й кешу: "w123" або "new:train:verb". */
  key: string;
  type: 'existing' | 'new_sense';
  entry?: LexEntry;
  lemma: string;
  /** Частина мови САМЕ цього прочитання (для форми — частина мови леми). */
  pos: string | null;
  kind: SenseOptionKind;
  cls: PosClass;
  /** Для new_sense: лексикон підтверджує, що в леми є така частина мови. */
  confirmed: boolean;
}

export interface PlanInput {
  surface: string;
  entries: LexEntry[];
  analyses: InflectionAnalysis[];
  cue: CueClass | null;
  hasContext: boolean;
  /** Слово з явного списку неоднозначних форм (left, found, used, tired…). */
  explicitAmbiguous: boolean;
  /** Частина мови з бібліотеки фраз для цього написання, якщо є. */
  libraryPos?: string | null;
}

export type PlanAction =
  | 'return'      // повернути наявний запис option.entry
  | 'create'      // створити нове значення option (new_sense)
  | 'separate'    // згенерувати запис для самого слова (без зведення до леми)
  | 'ask_ai'      // кілька реальних варіантів — вибір за реченням (AI)
  | 'unknown';    // нічого не знайдено — повний шлях визначення леми

export interface ResolutionPlan {
  action: PlanAction;
  option?: SenseOption;
  options: SenseOption[];
  reason: string;
}

const DEGREE_KINDS = new Set<SenseOptionKind>(['adj_comparative', 'adj_superlative']);

export function isIngForm(surface: string): boolean {
  return surface.length > 5 && surface.endsWith('ing');
}

function existingOption(entry: LexEntry, kind: SenseOptionKind, readingPos: string | null): SenseOption {
  return {
    key: `w${entry.id}`,
    type: 'existing',
    entry,
    lemma: entry.text.toLowerCase(),
    pos: readingPos,
    kind,
    cls: posClassOf(readingPos),
    confirmed: true,
  };
}

function newSenseOption(lemma: string, pos: string, kind: SenseOptionKind, confirmed: boolean): SenseOption {
  return {
    key: `new:${lemma}:${pos}`,
    type: 'new_sense',
    lemma,
    pos,
    kind,
    cls: posClassOf(pos),
    confirmed,
  };
}

/** Усі граматично можливі прочитання слова серед записів словника. */
export function buildSenseOptions(input: PlanInput): SenseOption[] {
  const s = input.surface.toLowerCase();
  const options: SenseOption[] = [];
  const seenKeys = new Set<string>();
  const add = (o: SenseOption) => {
    if (seenKeys.has(o.key)) return;
    seenKeys.add(o.key);
    options.push(o);
  };

  const byText = new Map<string, LexEntry[]>();
  for (const e of input.entries) {
    const t = e.text.toLowerCase();
    const list = byText.get(t) ?? [];
    list.push(e);
    byText.set(t, list);
  }

  // 1. Саме слово як окремий запис (усі його значення).
  const surfaceEntries = byText.get(s) ?? [];
  for (const e of surfaceEntries) add(existingOption(e, 'surface', e.partOfSpeech));

  // 2. Явно збережені форми (forms) інших записів: went → go.
  for (const e of input.entries) {
    if (e.text.toLowerCase() === s) continue;
    if ((e.forms ?? []).some(f => typeof f === 'string' && f.toLowerCase() === s)) {
      add(existingOption(e, 'forms', e.partOfSpeech));
    }
  }

  // 3. Граматичні форми лем — лише від записів із сумісною частиною мови.
  for (const a of input.analyses) {
    const matching = byText.get(a.lemma) ?? [];
    if (matching.length === 0) {
      // Леми ще немає в словнику, але лексикон знає, що це дієслово
      // ("telling" → tell): дієслівне прочитання має бути серед варіантів,
      // інакше лишався б тільки запис самої форми ("telling" — "розповідь").
      if (KIND_TO_POS[a.kind] === 'verb' && isKnownVerbLemma(a.lemma)) {
        add(newSenseOption(a.lemma, 'verb', a.kind, true));
      }
      continue;
    }
    const compatible = matching.filter(e => isPosCompatibleWithKind(e.partOfSpeech, a.kind));
    for (const e of compatible) {
      // "faster" від прислівника "fast" лишається прислівником.
      const readingPos =
        DEGREE_KINDS.has(a.kind) && posClassOf(e.partOfSpeech) === 'adverb' ? 'adverb' : KIND_TO_POS[a.kind];
      add(existingOption(e, a.kind, readingPos));
    }

    // Лема є, але лише з іншою частиною мови ("train" — тільки іменник,
    // а "trained" — форма дієслова): можливе нове дієслівне значення.
    if (compatible.length === 0 && KIND_TO_POS[a.kind] === 'verb') {
      const confirmed = isKnownVerbLemma(a.lemma);
      // "-s" без підтвердження частіше множина іменника ("talents"), ніж дієслово.
      if (a.kind !== 'verb_3sg' || confirmed) {
        add(newSenseOption(a.lemma, 'verb', a.kind, confirmed));
      }
    }
  }

  // 4. Базова форма в дієслівній позиції ("I watch TV", "can train"), коли
  //    у словнику є лише недієслівне значення.
  const verbSignal = input.cue === 'subject' || input.cue === 'modal' || input.cue === 'to' || input.cue === 'weak_verb';
  const hasVerbReading = options.some(o => o.cls === 'verb' || o.cls === 'unknown');
  if (verbSignal && surfaceEntries.length > 0 && !hasVerbReading && isKnownVerbLemma(s)) {
    const hasVerbSense = surfaceEntries.some(e => {
      const cls = posClassOf(e.partOfSpeech);
      return cls === 'verb' || cls === 'unknown';
    });
    if (!hasVerbSense) add(newSenseOption(s, 'verb', 'base', true));
  }

  // 5. Прислівник тієї ж форми ("trained hard" — старанно, "walked home" —
  //    додому): друге значення, якщо його ще немає.
  const surfaceClasses = new Set(surfaceEntries.map(e => posClassOf(e.partOfSpeech)));
  if (input.hasContext && FLAT_ADVERBS.has(s) && surfaceEntries.length > 0) {
    if (!surfaceClasses.has('adverb')) add(newSenseOption(s, 'adverb', 'base', true));
    if (surfaceClasses.has('adverb') && !surfaceClasses.has('adjective') && !surfaceClasses.has('noun')) {
      add(newSenseOption(s, 'adjective', 'base', true));
    }
  }

  // 6. Омоніми іменник / прикметник ("patient and kind" — добрий, а не "вид").
  if (input.hasContext && NOUN_ADJECTIVE_HOMOGRAPHS.has(s) && surfaceEntries.length > 0) {
    if (surfaceClasses.has('noun') && !surfaceClasses.has('adjective')) add(newSenseOption(s, 'adjective', 'base', true));
    if (surfaceClasses.has('adjective') && !surfaceClasses.has('noun')) add(newSenseOption(s, 'noun', 'base', true));
  }

  return options;
}

function isVerbish(o: SenseOption): boolean {
  return o.cls === 'verb';
}

function isNounish(o: SenseOption): boolean {
  return o.cls === 'noun';
}

/** Прикметник (не прислівник): не буває присудком одразу після підмета. */
function isAdjectiveProper(o: SenseOption): boolean {
  return (o.pos ?? '').toLowerCase() === 'adjective';
}

/**
 * Виключає варіанти, неможливі після попереднього слова. Повертає null,
 * якщо підказка нічого не каже про ці варіанти.
 */
function applyCue(options: SenseOption[], cue: CueClass | null, surface: string): SenseOption[] | null {
  switch (cue) {
    case 'determiner':
      // "a hard day" — прикметник, не прислівник (крім "a pretty good…").
      if (FLAT_ADVERBS.has(surface) && !ADVERBS_AFTER_DETERMINER.has(surface)) {
        return options.filter(o => !isVerbish(o) && o.cls !== 'adverb');
      }
      return options.filter(o => !isVerbish(o));
    case 'subject':
    case 'modal':
      // "he left" — дієслово, не прикметник "лівий"; прислівники лишаємо ("he never").
      return options.filter(o => !isNounish(o) && !isAdjectiveProper(o));
    case 'be':
      // "was boiling" — кипів, але "was boring" / "was amazing" — прикметник:
      // якщо серед варіантів є прикметник, be + -ing нічого не вирішує.
      if (!isIngForm(surface) || options.some(o => isAdjectiveProper(o))) return null;
      return options.filter(o => isVerbish(o));
    case 'gerund':
      // keep / stop / without / after … + -ing: дієслівне вживання.
      return isIngForm(surface) ? options.filter(o => isVerbish(o)) : null;
    case 'have':
      return options.some(o => o.kind === 'verb_past') ? options.filter(o => !isNounish(o)) : null;
    default:
      return null;
  }
}

const NO_CONTEXT_PRIORITY: SenseOptionKind[] = [
  'surface', 'forms', 'verb_past', 'verb_ing', 'verb_3sg', 'noun_plural', 'adj_comparative', 'adj_superlative', 'base',
];

/** Без речення — детерміновано, як і раніше: спершу саме слово. */
function planWithoutContext(input: PlanInput, options: SenseOption[], reason: string): ResolutionPlan {
  const existing = options.filter(o => o.type === 'existing');
  const surface = existing.filter(o => o.kind === 'surface').sort((a, b) => a.entry!.id - b.entry!.id);
  if (surface.length > 0) {
    return { action: 'return', option: surface[0], options, reason: `${reason}; без контексту — саме слово` };
  }
  if (input.explicitAmbiguous || isIngForm(input.surface)) {
    return { action: 'separate', options, reason: `${reason}; неоднозначна форма без контексту — саме слово, не лема` };
  }
  for (const kind of NO_CONTEXT_PRIORITY) {
    const hit = existing.find(o => o.kind === kind);
    if (hit) return { action: 'return', option: hit, options, reason: `${reason}; без контексту — ${kind}` };
  }
  const confirmedNew = options.find(o => o.type === 'new_sense' && o.confirmed);
  if (confirmedNew) {
    return { action: 'create', option: confirmedNew, options, reason: `${reason}; без контексту — нове значення ${confirmedNew.pos}` };
  }
  return { action: 'unknown', options, reason: `${reason}; без контексту — потрібне визначення леми` };
}

function choose(input: PlanInput, option: SenseOption, options: SenseOption[], reason: string): ResolutionPlan {
  if (option.type === 'existing') return { action: 'return', option, options, reason };
  if (option.confirmed) return { action: 'create', option, options, reason };
  // Нове значення без підтвердження (лексикон не знає, що "talent" — дієслово):
  // за реченням вирішує AI, без речення — повне визначення леми.
  return input.hasContext
    ? { action: 'ask_ai', options, reason: `${reason}; нове значення "${option.lemma}" (${option.pos}) потребує підтвердження` }
    : { action: 'unknown', options, reason: `${reason}; нове значення без підтвердження — визначення леми` };
}

export function planResolution(input: PlanInput): ResolutionPlan {
  const s = input.surface.toLowerCase();
  let options = buildSenseOptions(input);

  if (options.length === 0) {
    return { action: 'unknown', options, reason: 'жодного граматично сумісного запису' };
  }

  // Окремий запис -ing форми з частиною мови "дієслово" ("telling" — verb)
  // дублює лему: дієслівне прочитання дає лема ("tell"), а не цей запис.
  // Без цього такий запис витісняв лему фільтром нижче.
  if (isIngForm(s) && options.some(o => o.kind === 'verb_ing')) {
    options = options.filter(o => !(o.kind === 'surface' && o.cls === 'verb'));
  }

  // Саме слово є в словнику: прочитання тієї ж частини мови та ступені
  // порівняння ("number" ≠ numb+er, "people" ≠ person+s) поступаються йому,
  // якщо слово не з явного списку неоднозначних.
  const surfaceOptions = options.filter(o => o.kind === 'surface');
  if (surfaceOptions.length > 0 && !input.explicitAmbiguous) {
    const surfaceClasses = new Set<PosClass>(surfaceOptions.map(o => o.cls).filter(c => c !== 'unknown'));
    options = options.filter(
      o => o.kind === 'surface' || (!surfaceClasses.has(o.cls) && !DEGREE_KINDS.has(o.kind)),
    );
  }

  // Підказка з бібліотеки фраз (адмінка) для цього написання.
  if (input.libraryPos) {
    const cls = posClassOf(input.libraryPos);
    const matched = options.filter(o => o.cls === cls);
    if (matched.length === 1 && cls !== 'unknown') {
      return choose(input, matched[0], options, `частина мови з бібліотеки фраз: ${input.libraryPos}`);
    }
  }

  // Граматична підказка з речення.
  const cueFiltered = input.hasContext ? applyCue(options, input.cue, s) : null;
  if (cueFiltered) {
    if (cueFiltered.length === 0) {
      return {
        action: 'ask_ai',
        options,
        reason: `підказка "${input.cue}" виключила всі наявні значення — потрібне інше значення`,
      };
    }
    if (cueFiltered.length === 1 && cueFiltered.length < options.length) {
      return choose(input, cueFiltered[0], options, `граматична підказка "${input.cue}"`);
    }
    options = cueFiltered;
  }

  const ing = isIngForm(s);
  const hasSurface = options.some(o => o.kind === 'surface');
  const decisiveBeCue =
    ing && (input.cue === 'gerund' || (input.cue === 'be' && !options.some(o => isAdjectiveProper(o))));
  const needsAi =
    options.length > 1 ||
    (input.explicitAmbiguous && !decisiveBeCue) ||
    (ing && !hasSurface && !decisiveBeCue) ||
    options.some(o => o.type === 'new_sense' && !o.confirmed);

  if (!needsAi) {
    return choose(input, options[0], options, 'єдине граматично сумісне значення');
  }

  if (!input.hasContext) {
    return planWithoutContext(input, options, 'кілька варіантів');
  }

  return { action: 'ask_ai', options, reason: `варіантів: ${options.length}${ing ? ', -ing форма' : ''}${input.explicitAmbiguous ? ', неоднозначна форма' : ''}` };
}
