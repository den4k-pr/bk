// «Достовірний переклад» форми слова ("climbed" → "піднявся"):
//  - перекладається лише саме слово, без дієслівної групи й без речення;
//  - генерується ОДИН раз на форму і зберігається в записі слова;
//  - у будь-якому іншому реченні береться з бази, без AI.
// 🔒 Жодного реального OpenAI.
const openAiCreate = jest.fn();
jest.mock('openai/client.js', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));

import { WordGenerationService, formTranslationProblems } from './words-details/word-generation.service';
import { WordService } from './word.service';

const S1 = 'Like he had just climbed Mount Everest';
const S2 = 'She climbed the stairs slowly';
const S3 = 'They climbed into the car';

const reply = (translation: string) => ({ choices: [{ message: { content: JSON.stringify({ translation }) } }] });

const build = (answers: string[] = ['піднявся']) => {
  const requests: any[] = [];
  openAiCreate.mockReset();
  openAiCreate.mockImplementation(async (req: any) => {
    requests.push(req);
    await new Promise((r) => setTimeout(r, 5));
    return reply(answers.length > 1 ? (answers.shift() as string) : answers[0]);
  });
  // "База": один запис слова; UPDATE доповнює surfaceTranslations.
  const row: any = { id: 31, text: 'climb', partOfSpeech: 'verb', translation: 'підніматися / лізти', surfaceTranslations: null };
  const wordRepo: any = {
    findOne: jest.fn(async () => ({ id: row.id, surfaceTranslations: row.surfaceTranslations })),
    query: jest.fn(async (_sql: string, params: any[]) => {
      row.surfaceTranslations = { ...(row.surfaceTranslations ?? {}), ...JSON.parse(params[0]) };
      return [];
    }),
  };
  const aiCache = { get: jest.fn(async () => null), set: jest.fn(async () => undefined) };
  const service = new WordGenerationService({ clear: jest.fn() } as any, wordRepo, {} as any, {} as any, aiCache as any);
  for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
  /** Слово так, як воно приходить з бази на початку кожного тапу. */
  const word = () => ({ ...row }) as any;
  return { service, wordRepo, aiCache, requests, row, word };
};

beforeEach(() => {
  (WordGenerationService as any).openAiQuotaBlockedUntil = null;
  (WordGenerationService as any).openAiOutOfFundsUntil = null;
});

describe('Переклад форми — один раз на слово-форму', () => {
  it('перший тап генерує переклад і зберігає його в записі слова', async () => {
    const t = build();
    const result = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    expect(result).toMatchObject({ surface: 'climbed', contextualTranslation: 'піднявся', verbGroup: null });
    expect(t.requests).toHaveLength(1);
    expect(t.row.surfaceTranslations).toEqual({ 'v3|climbed': 'піднявся' });
  });

  it('те саме слово в ІНШИХ реченнях — з бази, без жодного запиту до AI', async () => {
    const t = build();
    await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    const r2 = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S2);
    const r3 = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S3);
    const r4 = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', undefined);
    expect([r2, r3, r4].map((r) => r?.contextualTranslation)).toEqual(['піднявся', 'піднявся', 'піднявся']);
    expect(t.requests).toHaveLength(1);
  });

  it('у запит іде лише саме слово і словникова форма — без речення й без групи слів', async () => {
    const t = build();
    await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    const sent = JSON.stringify(t.requests[0].messages);
    expect(sent).toContain('climbed');
    expect(sent).toContain('climb');
    expect(sent).not.toContain('Everest');
    expect(sent).not.toContain('had just');
    expect(t.requests[0].response_format.json_schema.name).toBe('form_translation_v1');
  });

  it('відповідь не містить групи слів: клієнт підписує лише натиснуте слово', async () => {
    const t = build();
    const result = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    expect(result?.verbGroup).toBeNull();
    expect(result?.surface).toBe('climbed');
  });

  it('різні форми одного слова зберігаються окремо і не затирають одна одну', async () => {
    const t = build(['піднявся', 'піднімається']);
    await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    await t.service.analyzeSurfaceInContext(t.word(), 'climbs', 'He climbs fast');
    expect(t.row.surfaceTranslations).toEqual({ 'v3|climbed': 'піднявся', 'v3|climbs': 'піднімається' });
    expect(t.requests).toHaveLength(2);
  });

  it('раніше збережений у базі переклад форми (v2) використовується як є, без AI', async () => {
    const t = build();
    t.row.surfaceTranslations = { 'v2|climbed': 'піднявся (старий запис)' };
    const result = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    expect(result?.contextualTranslation).toBe('піднявся (старий запис)');
    expect(t.requests).toHaveLength(0);
  });

  it('два одночасні тапи по тій самій формі в різних реченнях → один запит до AI', async () => {
    const t = build();
    const [a, b] = await Promise.all([
      t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1),
      t.service.analyzeSurfaceInContext(t.word(), 'climbed', S2),
    ]);
    expect(a?.contextualTranslation).toBe('піднявся');
    expect(b?.contextualTranslation).toBe('піднявся');
    expect(t.requests).toHaveLength(1);
  });

  it('інший запит уже зберіг переклад (застарілий об\'єкт слова) → береться з бази, без AI', async () => {
    const t = build();
    const stale = t.word();
    t.row.surfaceTranslations = { 'v3|climbed': 'піднявся' };
    const result = await t.service.analyzeSurfaceInContext(stale, 'climbed', S1);
    expect(result?.contextualTranslation).toBe('піднявся');
    expect(t.requests).toHaveLength(0);
  });

  it('натиснута сама словникова форма ("climb") — окремого перекладу немає', async () => {
    const t = build();
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'climb', 'I climb')).resolves.toBeNull();
    expect(t.requests).toHaveLength(0);
  });

  it('фрази, слова з цифрами, незбережений запис (id 0) — без перекладу форми і без AI', async () => {
    const t = build();
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'climbed up', S1)).resolves.toBeNull();
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'covid19', S1)).resolves.toBeNull();
    await expect(t.service.analyzeSurfaceInContext({ ...t.word(), id: 0 }, 'climbed', S1)).resolves.toBeNull();
    expect(t.requests).toHaveLength(0);
  });

  it('негодяща відповідь (латиниця / ціле речення) → друга спроба; годяща зберігається', async () => {
    const t = build(['climbed', 'піднявся']);
    const result = await t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1);
    expect(result?.contextualTranslation).toBe('піднявся');
    expect(t.requests).toHaveLength(2);
  });

  it('обидві спроби негодящі → нічого не зберігається, картка показує лише словникову форму', async () => {
    const t = build(['він щойно піднявся на гору Еверест']);
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1)).resolves.toBeNull();
    expect(t.wordRepo.query).not.toHaveBeenCalled();
  });

  it('збій AI → null без збереження; наступний тап пробує знову', async () => {
    const t = build();
    openAiCreate.mockRejectedValueOnce(new Error('timeout'));
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1)).resolves.toBeNull();
    expect(t.row.surfaceTranslations).toBeNull();
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'climbed', S2)).resolves.toMatchObject({ contextualTranslation: 'піднявся' });
  });

  it('збій запису в базу не лишає користувача без перекладу', async () => {
    const t = build();
    t.wordRepo.query.mockRejectedValueOnce(new Error('db'));
    await expect(t.service.analyzeSurfaceInContext(t.word(), 'climbed', S1)).resolves.toMatchObject({ contextualTranslation: 'піднявся' });
  });
});

describe('Повний тап у книзі: "climbed"', () => {
  it('картка — словникова форма "climb", а «у тексті» — лише climbed → піднявся', async () => {
    const t = build();
    jest.spyOn(t.service, 'searchOrCreateGlobalWord').mockImplementation(async () => ({ ...t.word(), examples: [], exampleHighlights: [], forms: [], type: 'word' }));
    const cache: any = { set: jest.fn(async () => undefined), get: jest.fn(), clear: jest.fn(), clearByPattern: jest.fn() };
    const wordService = new WordService({ save: jest.fn(async (w: any) => w), update: jest.fn() } as any, { findOne: jest.fn(async () => null) } as any, {} as any, {} as any, {} as any, cache, {} as any, t.service, {} as any, {} as any);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((wordService as any).logger, l).mockImplementation(() => undefined);

    const tap1 = await wordService.searchOrCreateGlobalWord(7, 'climbed', undefined, S1);
    const tap2 = await wordService.searchOrCreateGlobalWord(7, 'climbed', undefined, S2);
    expect(tap1.word).toMatchObject({ text: 'climb', translation: 'підніматися / лізти' });
    expect(tap1.surfaceTranslation).toBe('піднявся');
    expect(tap1.surfaceAnalysis).toMatchObject({ surface: 'climbed', verbGroup: null, isAuxiliary: false });
    expect(tap2.surfaceTranslation).toBe('піднявся');
    expect(t.requests).toHaveLength(1);
  });
});

describe('formTranslationProblems', () => {
  it.each([
    ['піднявся', []],
    ['біжучи / біг', []],
    ['найбільш цікавий', []],
    ['', ['empty']],
    ['climbed', ['not_ukrainian', 'has_latin']],
    ['піднявся (past)', ['has_latin']],
    ['а / б / в', ['too_many_variants']],
    ['він щойно піднявся на гору', ['not_single_word']],
  ])('%j → %j', (input, expected) => {
    expect(formTranslationProblems(input as string)).toEqual(expected);
  });
});
