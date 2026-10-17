import { analyzeInflections } from './inflection';
import { contextCue } from './context-cues';
import { AMBIGUOUS_FORMS } from './lexical-exceptions';
import { LexEntry, planResolution, ResolutionPlan } from './word-sense-resolution';

let nextId = 1;
const e = (text: string, partOfSpeech: string | null, translation = '', forms: string[] = []): LexEntry => ({
  id: nextId++,
  text,
  partOfSpeech,
  translation,
  forms,
  senseKey: '',
});

// Модель словника, у якій відтворено баги зі скріншотів: "train" — лише
// іменник "поїзд", "wood" — лише іменник "дерево".
const DB: LexEntry[] = [
  e('train', 'noun', 'поїзд'),
  e('wood', 'noun', 'дерево'),
  e('watch', 'noun', 'годинник'),
  e('notice', 'verb', 'помічати'),
  e('push', 'verb', 'штовхати'),
  e('saw', 'noun', 'пила'),
  e('see', 'verb', 'бачити', ['saw', 'seen']),
  e('number', 'noun', 'число'),
  e('numb', 'adjective', 'онімілий'),
  e('people', 'noun', 'люди'),
  e('person', 'noun', 'людина'),
  e('life', 'noun', 'життя'),
  e('live', 'verb', 'жити'),
  e('training', 'noun', 'тренування'),
  e('talent', 'noun', 'талант'),
  e('good', 'adjective', 'добрий'),
  e('corn', 'noun', 'кукурудза'),
  e('grow', 'verb', 'рости', ['grew', 'grown']),
  e('empty', 'adjective', 'порожній'),
  e('room', 'noun', 'кімната'),
  e('bench', 'noun', 'лавка'),
  e('stare', 'verb', 'пильно дивитися'),
  e('star', 'noun', 'зірка'),
  e('book', 'noun', 'книга'),
  e('leave', 'verb', 'залишати', ['left']),
  e('left', 'adjective', 'лівий'),
];

function plan(surface: string, context?: string, extra: Partial<Parameters<typeof planResolution>[0]> = {}): ResolutionPlan {
  const analyses = analyzeInflections(surface);
  const lemmas = new Set([surface, ...analyses.map(a => a.lemma)]);
  const entries = DB.filter(x => lemmas.has(x.text) || (x.forms ?? []).includes(surface));
  return planResolution({
    surface,
    entries,
    analyses,
    cue: contextCue(surface, context),
    hasContext: !!context,
    explicitAmbiguous: AMBIGUOUS_FORMS.has(surface),
    ...extra,
  });
}

const picked = (p: ResolutionPlan) =>
  p.option ? `${p.action}:${p.option.lemma}:${p.option.pos}` : p.action;

describe('скріншот 1: "trained" не може бути іменником "train" (поїзд)', () => {
  const ctx = 'He noticed how hard the young man trained, pushing his body again and again.';

  it('у реченні → створюється дієслівне значення "train" (без AI-вибору)', () => {
    expect(picked(plan('trained', ctx))).toBe('create:train:verb');
  });

  it('без речення — так само дієслово', () => {
    expect(picked(plan('trained'))).toBe('create:train:verb');
  });

  it('коли дієслівне значення вже є — повертається воно', () => {
    const verbTrain = e('train', 'verb', 'тренувати');
    const p = planResolution({
      surface: 'trained',
      entries: [DB[0], verbTrain],
      analyses: analyzeInflections('trained'),
      cue: contextCue('trained', ctx),
      hasContext: true,
      explicitAmbiguous: false,
    });
    expect(p.action).toBe('return');
    expect(p.option?.entry?.id).toBe(verbTrain.id);
  });
});

describe('скріншот 2: "wooden" не зводиться до "wood" (дерево)', () => {
  it('немає жодного граматично сумісного запису → визначення леми (AI + перевірка морфологією)', () => {
    const p = plan('wooden', 'Ivan would sit down on the wooden bench.');
    expect(p.action).toBe('unknown');
    expect(p.options).toHaveLength(0);
  });
});

describe('звичайні слова — без AI', () => {
  it.each([
    ['noticed', 'He noticed how hard the young man trained.', 'return:notice:verb'],
    ['grew', 'when the gym grew empty and quiet', 'return:grow:verb'],
    ['empty', 'one empty spot on the floor', 'return:empty:adjective'],
    ['room', 'walk into the locker room', 'return:room:noun'],
    ['benches', 'the benches were cold', 'return:bench:noun'],
    ['people', 'young people do not see', 'return:people:noun'],
    ['number', 'a large number of people', 'return:number:noun'],
  ])('%s', (surface, ctx, expected) => {
    expect(picked(plan(surface, ctx))).toBe(expected);
  });
});

describe('граматичні підказки вирішують омоніми без AI', () => {
  it('"I saw him" → see; "the saw was sharp" → saw (пила)', () => {
    expect(picked(plan('saw', 'I saw him yesterday'))).toBe('return:see:verb');
    expect(picked(plan('saw', 'The saw was sharp'))).toBe('return:saw:noun');
  });

  it('"their lives" → life; "she lives" → live', () => {
    expect(picked(plan('lives', 'They changed their lives'))).toBe('return:life:noun');
    expect(picked(plan('lives', 'She lives in Kyiv'))).toBe('return:live:verb');
  });

  it('"The training was hard" → training (іменник); "she was training" → train (дієслово)', () => {
    expect(picked(plan('training', 'The training was hard'))).toBe('return:training:noun');
    expect(picked(plan('training', 'She was training every day'))).toBe('create:train:verb');
  });

  it('"I watch TV" → нове дієслівне значення watch; "his watch" → годинник', () => {
    expect(picked(plan('watch', 'I watch TV every evening'))).toBe('create:watch:verb');
    expect(picked(plan('watch', 'He looked at his watch'))).toBe('return:watch:noun');
  });

  it('"turn left" (лівий) vs "he left early" (leave)', () => {
    expect(picked(plan('left', 'He left early'))).toBe('return:leave:verb');
    expect(plan('left', 'Turn left at the corner').action).toBe('ask_ai');
  });
});

describe('справжня неоднозначність → AI-вибір (з контекстом) або детермінований вибір (без)', () => {
  it('-ing без підказки → AI', () => {
    const p = plan('watching', 'Petro had quietly watching Ivan');
    expect(p.action).toBe('ask_ai');
    expect(p.options.map(o => o.key)).toContain('new:watch:verb');
  });

  it('be + -ing → дієслово без AI', () => {
    expect(picked(plan('watching', 'Petro had been watching Ivan'))).toBe('create:watch:verb');
  });

  it('"talented" (зі списку неоднозначних): з речення → AI, без речення — саме слово', () => {
    expect(plan('talented', 'a talented young man').action).toBe('ask_ai');
    expect(plan('talented').action).toBe('separate');
  });

  it('"wooded": "wood" — не відоме дієслово → AI з речення, без речення — визначення леми', () => {
    expect(plan('wooded', 'a wooded hill').action).toBe('ask_ai');
    expect(plan('wooded').action).toBe('unknown');
  });

  it('"the trained dog": артикль виключає дієслово → AI (дієприкметник-прикметник)', () => {
    expect(plan('trained', 'the trained dog barked').action).toBe('ask_ai');
  });

  it('без речення неоднозначна -ing форма — саме слово (як і раніше)', () => {
    expect(picked(plan('training'))).toBe('return:training:noun');
    expect(plan('watching').action).toBe('separate');
  });
});

describe('захист від хибних збігів', () => {
  it('"staring" → stare (не star)', () => {
    const p = plan('staring', 'just staring at one empty spot');
    expect(p.options.map(o => o.lemma)).toEqual(['stare']);
  });

  it('"corner" не стає ступенем порівняння "corn"', () => {
    expect(plan('corner', 'in the corner').action).toBe('unknown');
  });

  it('"booked" — форма дієслова, а не іменника "book" (книга)', () => {
    expect(picked(plan('booked', 'We booked a room'))).toBe('create:book:verb');
  });

  it('"better" → good (прикметник), а не іменник', () => {
    expect(picked(plan('better', 'It was better than before'))).toBe('return:good:adjective');
  });
});

describe('прикметник / прислівник однієї форми', () => {
  const hardAdj = e('hard', 'adjective', 'важкий');
  const run = (ctx: string, entries: LexEntry[] = [hardAdj]) =>
    planResolution({
      surface: 'hard',
      entries,
      analyses: analyzeInflections('hard'),
      cue: contextCue('hard', ctx),
      hasContext: true,
      explicitAmbiguous: false,
    });

  it('"how hard the young man trained" — прислівник можливий → вибір за реченням', () => {
    const p = run('He noticed how hard the young man trained');
    expect(p.action).toBe('ask_ai');
    expect(p.options.map(o => o.key)).toEqual([`w${hardAdj.id}`, 'new:hard:adverb']);
  });

  it('"a hard day" — після артикля лише прикметник, без AI', () => {
    expect(picked(run('It was a hard day'))).toBe('return:hard:adjective');
  });

  it('коли обидва значення вже є — "a hard day" без AI', () => {
    const hardAdv = e('hard', 'adverb', 'старанно');
    expect(run('It was a hard day', [hardAdj, hardAdv]).option?.entry?.id).toBe(hardAdj.id);
  });

  it('"for a long, long time" — обидва "long" прикметники без AI', () => {
    const longAdj = e('long', 'adjective', 'довгий');
    const p = planResolution({
      surface: 'long',
      entries: [longAdj],
      analyses: analyzeInflections('long'),
      cue: contextCue('long', 'just staring at one empty spot on the floor for a long, long time.'),
      hasContext: true,
      explicitAmbiguous: false,
    });
    expect(picked(p)).toBe('return:long:adjective');
  });

  it('"a pretty good idea" — "pretty" після артикля може бути прислівником', () => {
    const prettyAdj = e('pretty', 'adjective', 'гарний');
    const p = planResolution({
      surface: 'pretty',
      entries: [prettyAdj],
      analyses: analyzeInflections('pretty'),
      cue: contextCue('pretty', 'It was a pretty good idea'),
      hasContext: true,
      explicitAmbiguous: false,
    });
    expect(p.action).toBe('ask_ai');
  });

  it('без речення — наявне значення', () => {
    const p = planResolution({ surface: 'hard', entries: [hardAdj], analyses: [], cue: null, hasContext: false, explicitAmbiguous: false });
    expect(picked(p)).toBe('return:hard:adjective');
  });
});

describe('виправлення за результатами прогону сторінки книги', () => {
  const fightNoun = e('fight', 'noun', 'бій');
  const kindNoun = e('kind', 'noun', 'вид / тип');
  const homeNoun = e('home', 'noun', 'дім');
  const run = (surface: string, ctx: string, entries: LexEntry[]) =>
    planResolution({
      surface,
      entries,
      analyses: analyzeInflections(surface),
      cue: contextCue(surface, ctx),
      hasContext: true,
      explicitAmbiguous: AMBIGUOUS_FORMS.has(surface),
    });

  it('"watch him fight" — після додатка можливе дієслово → вибір за реченням', () => {
    const p = run('fight', 'People booked tickets just to watch him fight.', [fightNoun]);
    expect(p.action).toBe('ask_ai');
    expect(p.options.map(o => o.key)).toContain('new:fight:verb');
  });

  it('"win his fights" — іменник без AI', () => {
    expect(picked(run('fights', "You don't have to win his fights.", [fightNoun]))).toBe('return:fight:noun');
  });

  it('"patient and kind" — пропонується прикметник "kind" (добрий)', () => {
    const p = run('kind', "He felt the old man's eyes watching him, patient and kind.", [kindNoun]);
    expect(p.action).toBe('ask_ai');
    expect(p.options.map(o => o.key)).toContain('new:kind:adjective');
  });

  it('"walked home" — пропонується прислівник "home" (додому); "his home" — дім без AI', () => {
    expect(run('home', 'Ivan walked home slower than usual.', [homeNoun]).options.map(o => o.key)).toContain('new:home:adverb');
    expect(picked(run('home', 'He sold his home', [homeNoun]))).toBe('return:home:noun');
  });
});

describe('підказка частини мови з бібліотеки фраз', () => {
  it('libraryPos обирає значення серед кількох', () => {
    expect(picked(plan('saw', 'it saw', { libraryPos: 'noun' }))).toBe('return:saw:noun');
  });
});

describe('-ing форми: дієслівне прочитання не губиться', () => {
  const tellDb: LexEntry[] = [
    e('tell', 'verb', 'казати / розповідати'),
    // Запис самої форми, створений раніше (продакшн: "telling" — verb, "розповідь").
    e('telling', 'verb', 'розповідь / повідомлення'),
  ];
  const planWith = (db: LexEntry[], surface: string, context?: string) => {
    const analyses = analyzeInflections(surface);
    const lemmas = new Set([surface, ...analyses.map(a => a.lemma)]);
    return planResolution({
      surface,
      entries: db.filter(x => lemmas.has(x.text)),
      analyses,
      cue: contextCue(surface, context),
      hasContext: !!context,
      explicitAmbiguous: false,
    });
  };

  it('"was telling" → лема tell, а не запис "telling"', () => {
    const p = planWith(tellDb, 'telling', 'She was telling me a story');
    expect(p.action).toBe('return');
    expect(p.option?.entry?.text).toBe('tell');
  });

  it('"kept telling" → лема tell (gerund)', () => {
    const p = planWith(tellDb, 'telling', 'She kept telling me the truth');
    expect(p.option?.entry?.text).toBe('tell');
  });

  it('леми ще немає в словнику — пропонується нове дієслівне значення', () => {
    const p = planWith([e('telling', 'noun', 'розповідь')], 'telling', 'He was telling the truth');
    expect(p.options.some(o => o.type === 'new_sense' && o.lemma === 'tell' && o.pos === 'verb')).toBe(true);
    expect(p.action).not.toBe('return');
  });

  it('"was amazing" з прикметником у словнику — be не вирішує, питаємо AI', () => {
    const db = [e('amazing', 'adjective', 'дивовижний'), e('amaze', 'verb', 'дивувати')];
    expect(planWith(db, 'amazing', 'The film was amazing').action).toBe('ask_ai');
  });

  it('"is boiling" без прикметника в словнику → дієслово boil', () => {
    const p = planWith([e('boil', 'verb', 'кипіти')], 'boiling', 'The water is boiling');
    expect(p.option?.entry?.text).toBe('boil');
  });
});

