// Нове слово не відкидається через поле, що не пройшло перевірку: поле
// ремонтується. Випадок з проду: "described" → лема "describe", модель дала
// вимову латиницею ("dɪˈskraɪb") → "Generation rejected: pronunciation_latin",
// і користувач не бачив нічого.
// 🔒 Жодного реального OpenAI.
const openAiCreate = jest.fn();
jest.mock('openai/client.js', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));

import { GenerationRejectedError, WordGenerationService } from './words-details/word-generation.service';
import { WordService } from './word.service';

const SENTENCE = 'He described the house in detail';

const GOOD_EXAMPLES = [
  'Describe your new room',
  'Опиши свою нову кімнату',
  'She described the trip',
  'Вона описала подорож',
  'They will describe it',
  'Вони це опишуть',
];

const content = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    translation: 'описувати / описати',
    pronunciation: 'діскрайб',
    examples: GOOD_EXAMPLES,
    level: 'B1',
    isProperNoun: false,
    isRealEnglishEntry: true,
    ...over,
  });

const reply = (json: string) => ({ choices: [{ message: { content: json } }] });
const streamOf = (json: string) => ({
  async *[Symbol.asyncIterator]() {
    for (let i = 0; i < json.length; i += 20) yield { choices: [{ delta: { content: json.slice(i, i + 20) } }] };
  },
});

type Replies = { content: string; pronunciation?: string; examples?: string[]; quick?: Record<string, unknown> };

const build = (replies: Replies) => {
  const calls: string[] = [];
  openAiCreate.mockReset();
  openAiCreate.mockImplementation(async (req: any) => {
    const name = req.response_format?.json_schema?.name;
    calls.push(name);
    if (name === 'dictionary_word_content') return req.stream ? streamOf(replies.content) : reply(replies.content);
    if (name === 'pronunciation_cyrillic_v1') return reply(JSON.stringify({ pronunciation: replies.pronunciation ?? '' }));
    if (name === 'examples_repair_v1') return reply(JSON.stringify({ examples: replies.examples ?? [] }));
    if (name === 'quick_translation_v1')
      return reply(JSON.stringify({ isRealEnglishEntry: true, translation: '', partOfSpeech: 'none', ...replies.quick }));
    if (name === 'guaranteed_translation_v1')
      return reply(JSON.stringify({ translation: '', partOfSpeech: 'none', ...replies.quick }));
    if (name === 'surface_analysis_v3') throw new Error('not needed in this test');
    throw new Error(`unexpected request ${name}`);
  });
  const qb: any = {};
  for (const m of ['where', 'andWhere', 'orWhere', 'orderBy']) qb[m] = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => []);
  const wordRepo: any = {
    createQueryBuilder: jest.fn(() => qb),
    findOne: jest.fn(async () => null),
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (d: any) => ({ ...d, id: 501 })),
  };
  const store = new Map<string, unknown>();
  const aiCache = {
    get: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    set: jest.fn(async (k: string, _t: string, v: unknown) => void store.set(k, v)),
  };
  const service = new WordGenerationService({ clear: jest.fn() } as any, wordRepo, {} as any, {} as any, aiCache as any);
  for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
  // Розбір форми в цих тестах не перевіряємо.
  jest.spyOn(service as any, 'startSurfacePrefetch').mockImplementation(() => undefined);

  /** reader = тап у книзі (є речення); інакше — ручний ввід / адмінка. */
  const create = (lemma: string, opts: { reader?: boolean; pos?: string | null; surface?: string } = {}) => {
    const reader = opts.reader ?? true;
    const pos = opts.pos === undefined ? 'verb' : opts.pos;
    const run = () => (service as any).createSingleWordEntry(lemma, pos, reader ? SENTENCE : undefined);
    return reader ? (service as any).lookupScope.run({ surface: opts.surface ?? lemma, rawContext: SENTENCE }, run) : run();
  };
  return { service, wordRepo, calls, create, store };
};

beforeEach(() => {
  (WordGenerationService as any).openAiQuotaBlockedUntil = null;
});

describe('Коректне слово — без змін: один запит, нічого не ремонтується', () => {
  it.each([true, false])('reader=%s', async (reader) => {
    const t = build({ content: content() });
    const saved = await t.create('describe', { reader });
    expect(t.calls).toEqual(['dictionary_word_content']);
    expect(saved).toMatchObject({
      id: 501,
      text: 'describe',
      translation: 'описувати / описати',
      pronunciation: 'діскрайб',
      examples: GOOD_EXAMPLES,
    });
  });
});

describe('Вимова латиницею (випадок "described")', () => {
  it('IPA → окремий запит вимови кирилицею, слово збережене з усіма даними', async () => {
    const t = build({ content: content({ pronunciation: 'dɪˈskraɪb' }), pronunciation: 'діскрайб' });
    const saved = await t.create('describe', { surface: 'described' });
    expect(saved).toMatchObject({ id: 501, pronunciation: 'діскрайб', translation: 'описувати / описати', examples: GOOD_EXAMPLES });
    expect(t.calls).toEqual(['dictionary_word_content', 'pronunciation_cyrillic_v1']);
  });

  it('так само поза книгою (вимова ніколи не блокує)', async () => {
    const t = build({ content: content({ pronunciation: 'dɪˈskraɪb' }), pronunciation: 'діскрайб' });
    await expect(t.create('describe', { reader: false })).resolves.toMatchObject({ pronunciation: 'діскрайб' });
  });

  it('кирилиця з латинською вставкою → латиниця прибирається без запиту до AI', async () => {
    const t = build({ content: content({ pronunciation: 'діскрайб [dɪˈskraɪb]' }) });
    await expect(t.create('describe')).resolves.toMatchObject({ pronunciation: 'діскрайб' });
    expect(t.calls).toEqual(['dictionary_word_content']);
  });

  it('ремонт не вдався → слово все одно збережене, вимова порожня (застосунок її не показує)', async () => {
    const t = build({ content: content({ pronunciation: 'dɪˈskraɪb' }), pronunciation: 'diskraib' });
    await expect(t.create('describe')).resolves.toMatchObject({ id: 501, pronunciation: '', translation: 'описувати / описати' });
  });

  it('вимова не береться з кешу: слово, створене заново (після видалення), генерує її знову', async () => {
    const t = build({ content: content({ pronunciation: 'dɪˈskraɪb' }), pronunciation: 'діскрайб' });
    await t.create('describe');
    t.calls.length = 0;
    await t.create('describe');
    expect(t.calls).toEqual(['dictionary_word_content', 'pronunciation_cyrillic_v1']);
    expect([...t.store.keys()].some((k) => k.includes('pronunciation'))).toBe(false);
  });
});

describe('Приклади', () => {
  it('неповний набір → лишаються коректні пари, без додаткового запиту', async () => {
    const t = build({ content: content({ examples: GOOD_EXAMPLES.slice(0, 5) }) });
    const saved = await t.create('describe');
    expect(saved.examples).toEqual(GOOD_EXAMPLES.slice(0, 4));
    expect(t.calls).not.toContain('examples_repair_v1');
  });

  it('пара з перекладом латиницею відкидається, решта лишається', async () => {
    const broken = [...GOOD_EXAMPLES];
    broken[3] = 'she described it';
    const t = build({ content: content({ examples: broken }) });
    const saved = await t.create('describe');
    expect(saved.examples).toEqual([...GOOD_EXAMPLES.slice(0, 2), ...GOOD_EXAMPLES.slice(4)]);
  });

  it('жодної коректної пари → короткий запит на 2 пари', async () => {
    const t = build({
      content: content({ examples: ['', '', '', '', '', ''] }),
      examples: ['I describe it', 'Я це описую', 'Describe him', 'Опиши його'],
    });
    const saved = await t.create('describe');
    expect(saved.examples).toEqual(['I describe it', 'Я це описую', 'Describe him', 'Опиши його']);
  });

  it('ремонт прикладів не вдався → слово збережене без прикладів (не відкинуте)', async () => {
    const t = build({ content: content({ examples: ['', '', '', '', '', ''] }), examples: [] });
    await expect(t.create('describe')).resolves.toMatchObject({ id: 501, examples: [], translation: 'описувати / описати' });
  });
});

describe('Переклад', () => {
  it('задовгий → лишаються перші варіанти, без запиту', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `варіант${'а'.repeat(i)}`).join(' / ');
    const t = build({ content: content({ translation: long }) });
    const saved = await t.create('describe');
    expect(saved.translation.length).toBeLessThanOrEqual(120);
    expect(long.startsWith(saved.translation)).toBe(true);
    // Повтор генерації картки при некоректному перекладі — як і раніше; ремонт без додаткових запитів.
    expect(t.calls.every((c) => c === 'dictionary_word_content')).toBe(true);
  });

  it('у книзі: переклад без українських літер → переклад у реченні окремим запитом', async () => {
    const t = build({ content: content({ translation: 'Wi-Fi' }), quick: { translation: 'вайфай' } });
    const saved = await t.create('wifi', { pos: 'noun' });
    expect(saved).toMatchObject({ id: 501, translation: 'вайфай' });
  });

  it('у книзі: переклад з латинською назвою, але з українським текстом — приймається', async () => {
    const t = build({ content: content({ translation: 'мережа Wi-Fi' }), quick: { translation: '' } });
    await expect(t.create('wifi', { pos: 'noun' })).resolves.toMatchObject({ translation: 'мережа wi-fi' });
  });

  it('поза книгою некоректний переклад, як і раніше, не зберігається', async () => {
    const t = build({ content: content({ translation: 'Wi-Fi' }) });
    await expect(t.create('wifi', { reader: false, pos: 'noun' })).rejects.toBeInstanceOf(GenerationRejectedError);
  });

  it('у книзі: картка без перекладу → GPT зобов\'язаний перекласти окремим запитом, слово збережене', async () => {
    const t = build({ content: content({ translation: '' }), quick: { translation: 'описувати' } });
    await expect(t.create('describe')).resolves.toMatchObject({ id: 501, translation: 'описувати' });
  });

  it('"невідомий" — справжній переклад слова unknown, а не заглушка: у книзі зберігається', async () => {
    const t = build({ content: content({ translation: 'невідомий' }), quick: { translation: 'невідомий' } });
    await expect(t.create('unknown', { pos: 'adjective' })).resolves.toMatchObject({ id: 501, translation: 'невідомий' });
  });
});

describe('"Чи це слово" — у книзі слово існує в тексті', () => {
  it('модель каже "не слово" (ім\'я, сленг): у книзі — зберігається', async () => {
    const t = build({ content: content({ isRealEnglishEntry: false, translation: 'маґл' }) });
    await expect(t.create('muggle', { pos: 'noun' })).resolves.toMatchObject({ id: 501, translation: 'маґл' });
  });

  it('модель каже "не слово": поза книгою (ручний ввід) — як і раніше відкидається', async () => {
    const t = build({ content: content({ isRealEnglishEntry: false, translation: 'маґл' }) });
    await expect(t.create('vfibyf', { reader: false, pos: 'noun' })).rejects.toBeInstanceOf(GenerationRejectedError);
  });

  it('вигук без голосних ("psst"): у книзі — зберігається, поза книгою — ні', async () => {
    const t1 = build({ content: content({ translation: 'пс-с-с' }) });
    await expect(t1.create('psst', { pos: 'interjection' })).resolves.toMatchObject({ text: 'psst' });
    const t2 = build({ content: content({ translation: 'пс-с-с' }) });
    await expect(t2.create('psst', { reader: false, pos: 'interjection' })).rejects.toBeInstanceOf(GenerationRejectedError);
  });
});

describe('Повний тап у книзі: "described" → картка з даними (не id 0)', () => {
  it('відповідь клієнту з перекладом, вимовою і прикладами', async () => {
    const t = build({ content: content({ pronunciation: 'dɪˈskraɪb' }), pronunciation: 'діскрайб' });
    jest.spyOn(t.service as any, 'findOrGenerateWord').mockImplementation(() =>
      (t.service as any).createSingleWordEntry('describe', 'verb', SENTENCE),
    );
    jest.spyOn(t.service, 'analyzeSurfaceInContext').mockResolvedValue(null);
    const cache: any = { set: jest.fn(async () => undefined), get: jest.fn() };
    const userWordRepo: any = { findOne: jest.fn(async () => null) };
    const wordService = new WordService({ save: jest.fn(async (w: any) => w) } as any, userWordRepo, {} as any, {} as any, {} as any, cache, {} as any, t.service, {} as any, {} as any);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((wordService as any).logger, l).mockImplementation(() => undefined);

    const res = await wordService.searchOrCreateGlobalWord(7, 'described', undefined, SENTENCE);
    expect(res.transient).toBe(false);
    expect(res.word).toMatchObject({ id: 501, text: 'describe', translation: 'описувати / описати', pronunciation: 'діскрайб' });
    expect(res.word.examples).toEqual(GOOD_EXAMPLES);
  });
});
