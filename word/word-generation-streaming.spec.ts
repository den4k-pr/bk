// Нове слово з читалки: картка генерується тим самим запитом, але потоком, а
// контекстний переклад форми ("made" у реченні) стартує, щойно модель видала
// переклад леми — паралельно з генерацією прикладів. Перевіряємо, що дані
// картки, розбір і відповідь клієнту ІДЕНТИЧНІ звичайному шляху.
// 🔒 Жодного реального OpenAI.
const openAiCreate = jest.fn();
jest.mock('openai/client.js', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));

import { WordGenerationService, extractStreamedTranslation } from './words-details/word-generation.service';
import { WordService } from './word.service';

const SENTENCE = 'She made a cake for us';

const content = (translation: string, examples?: string[]) =>
  JSON.stringify({
    translation,
    pronunciation: 'meɪk',
    examples: examples ?? [
      'I make tea every morning',
      'Я роблю чай щоранку',
      'She made a cake yesterday',
      'Вона спекла торт учора',
      'They will make a plan tomorrow',
      'Вони складуть план завтра',
    ],
    level: 'A1',
    isProperNoun: false,
    isRealEnglishEntry: true,
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Потік як у OpenAI SDK: шматки JSON з паузами; час останнього шматка фіксується. */
const streamOf = (json: string, timeline: string[], pieces = 8, delayMs = 15) => ({
  async *[Symbol.asyncIterator]() {
    const size = Math.ceil(json.length / pieces);
    for (let i = 0; i < json.length; i += size) {
      await sleep(delayMs);
      yield { choices: [{ delta: { content: json.slice(i, i + size) } }] };
    }
    timeline.push('content:done');
  },
});

const memoryAiCache = () => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key: string, _kind: string, value: unknown) => void store.set(key, value)),
  };
};

const qbMany = (rows: any[]) => {
  const qb: any = {};
  for (const m of ['where', 'andWhere', 'orWhere', 'orderBy', 'select', 'take']) qb[m] = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);
  qb.getOne = jest.fn(async () => rows[0] ?? null);
  return qb;
};

const build = (contents: string[]) => {
  const timeline: string[] = [];
  const requests: any[] = [];
  let call = 0;
  openAiCreate.mockReset();
  const optionsSeen: any[] = [];
  openAiCreate.mockImplementation(async (req: any, options?: any) => {
    requests.push(req);
    optionsSeen.push(options);
    const json = contents[Math.min(call++, contents.length - 1)];
    if (req.stream) return streamOf(json, timeline);
    await sleep(8 * 15);
    timeline.push('content:done');
    return { choices: [{ message: { content: json } }] };
  });
  const wordRepo: any = {
    createQueryBuilder: jest.fn(() => qbMany([])),
    findOne: jest.fn(async () => null),
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (d: any) => ({ ...d, id: 501 })),
    query: jest.fn(async () => []),
  };
  const aiCache = memoryAiCache();
  const service = new WordGenerationService({ clear: jest.fn() } as any, wordRepo, {} as any, {} as any, aiCache as any);
  for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
  jest.spyOn(service as any, 'assertEntryValid').mockImplementation(() => undefined);
  const analysisInputs: any[] = [];
  const surfaceRequest = jest.spyOn(service as any, 'requestFormTranslation').mockImplementation(async (w: any) => {
    analysisInputs.push({ text: w.text, partOfSpeech: w.partOfSpeech, translation: w.translation });
    timeline.push('analysis:start');
    await sleep(40);
    return w.translation.startsWith('робити') ? 'зробив' : 'виготовив';
  });
  const create = (scope?: { surface: string; rawContext?: string }, pos: string | null = 'verb') => {
    const run = () => (service as any).createSingleWordEntry('make', pos, SENTENCE);
    return scope ? (service as any).lookupScope.run(scope, run) : run();
  };
  return { service, wordRepo, aiCache, timeline, requests, optionsSeen, surfaceRequest, analysisInputs, create };
};

beforeEach(() => {
  (WordGenerationService as any).openAiQuotaBlockedUntil = null;
});

describe('Нове слово з читалки: переклад форми паралельно з генерацією картки', () => {
  it('розбір "made" стартує ДО завершення генерації картки, і використовується рівно один раз', async () => {
    const t = build([content('робити / зробити')]);
    const saved = await t.create({ surface: 'made', rawContext: SENTENCE });
    expect(t.timeline.indexOf('analysis:start')).toBeLessThan(t.timeline.indexOf('content:done'));

    const result = await t.service.analyzeSurfaceInContext(saved, 'made', SENTENCE);
    expect(result).toMatchObject({ surface: 'made', contextualTranslation: 'зробив', verbGroup: null });
    expect(t.surfaceRequest).toHaveBeenCalledTimes(1);
    // Переклад форми отримав РІВНО ті дані, що й зі звичайного шляху (зі збереженого запису).
    expect(t.analysisInputs[0]).toEqual({ text: saved.text, partOfSpeech: saved.partOfSpeech, translation: saved.translation });
    expect((t.service as any).surfacePrefetches.size).toBe(0);
    // Переклад форми збережено в записі слова — один раз, для всіх речень.
    expect(t.wordRepo.query).toHaveBeenCalledTimes(1);
    expect((t.wordRepo.query.mock.calls[0] as any[])[1]).toEqual([JSON.stringify({ 'v3|made': 'зробив' }), 501]);
  });

  it('збережений запис ідентичний звичайному (без потоку) шляху', async () => {
    const fast = build([content('робити / зробити')]);
    const viaStream = await fast.create({ surface: 'made', rawContext: SENTENCE });
    const plain = build([content('робити / зробити')]);
    const viaPlain = await plain.create();
    expect(viaStream).toEqual(viaPlain);
  });

  it('запит до OpenAI той самий — відрізняється лише stream: true', async () => {
    const fast = build([content('робити / зробити')]);
    await fast.create({ surface: 'made', rawContext: SENTENCE });
    const plain = build([content('робити / зробити')]);
    await plain.create();
    const { stream, ...rest } = fast.requests[0];
    expect(stream).toBe(true);
    // Потік обмежений тими самими 30 с, що й звичайний запит (таймаут SDK — лише до заголовків).
    expect(fast.optionsSeen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(plain.optionsSeen[0]).toBeUndefined();
    expect(rest).toEqual(plain.requests[0]);
    expect(plain.requests[0].stream).toBeUndefined();
  });

  it('звичайний розбір (без попереднього) дає той самий результат, що й ранній', async () => {
    const fast = build([content('робити / зробити')]);
    const s1 = await fast.create({ surface: 'made', rawContext: SENTENCE });
    const early = await fast.service.analyzeSurfaceInContext(s1, 'made', SENTENCE);
    const plain = build([content('робити / зробити')]);
    const s2 = await plain.create();
    const late = await plain.service.analyzeSurfaceInContext(s2, 'made', SENTENCE);
    expect(early).toEqual(late);
    expect(fast.analysisInputs).toEqual(plain.analysisInputs);
  });

  it('поза тапом (адмінка, пошук) — без потоку і без раннього розбору, як раніше', async () => {
    const t = build([content('робити / зробити')]);
    await t.create();
    expect(t.requests[0].stream).toBeUndefined();
    expect(t.surfaceRequest).not.toHaveBeenCalled();
  });

  it('частину мови визначає AI (приходить в кінці) — без змін: без потоку', async () => {
    const t = build([JSON.stringify({ ...JSON.parse(content('робити / зробити')), partOfSpeech: 'verb' })]);
    await t.create({ surface: 'made', rawContext: SENTENCE }, null);
    expect(t.requests[0].stream).toBeUndefined();
    expect(t.surfaceRequest).not.toHaveBeenCalled();
  });

  it('натиснута базова форма "make" — розбір не потрібен, AI для нього не викликається', async () => {
    const t = build([content('робити / зробити')]);
    await t.create({ surface: 'make', rawContext: 'I make tea' });
    expect(t.surfaceRequest).not.toHaveBeenCalled();
  });

  it('повтор генерації з ІНШИМ перекладом → використовується розбір саме для фінального перекладу', async () => {
    // Спроба 1: 5 прикладів замість 6 (повтор), спроба 2: інший переклад.
    const bad = content('робити / зробити', ['a', 'b', 'c', 'd', 'e']);
    const t = build([bad, content('зробити / виготовити')]);
    const saved = await t.create({ surface: 'made', rawContext: SENTENCE });
    expect(saved.translation).toBe('зробити / виготовити');
    const result = await t.service.analyzeSurfaceInContext(saved, 'made', SENTENCE);
    expect(result?.contextualTranslation).toBe('виготовив');
    const used = t.analysisInputs.filter((i) => i.translation === saved.translation);
    expect(used).toHaveLength(1);
  });

  it('збій AI у ранньому розборі → як і раніше: null і нічого не кешується', async () => {
    const t = build([content('робити / зробити')]);
    t.surfaceRequest.mockRejectedValue(new Error('timeout'));
    const saved = await t.create({ surface: 'made', rawContext: SENTENCE });
    await expect(t.service.analyzeSurfaceInContext(saved, 'made', SENTENCE)).resolves.toBeNull();
    expect(t.wordRepo.query).not.toHaveBeenCalled();
  });

  it('обрив потоку посеред відповіді обробляється так само, як помилка запиту без потоку', async () => {
    const broken = build([content('робити / зробити')]);
    openAiCreate.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: '{"translation":"робити"' } }] };
        throw Object.assign(new Error('Connection reset'), { status: 500 });
      },
    }));
    const streamErr = await broken.create({ surface: 'made', rawContext: SENTENCE }).catch((e: any) => e);

    const plain = build([content('робити / зробити')]);
    openAiCreate.mockRejectedValue(Object.assign(new Error('Connection reset'), { status: 500 }));
    const plainErr = await plain.create().catch((e: any) => e);

    expect(streamErr?.constructor).toBe(plainErr?.constructor);
    expect(streamErr?.message).toBe(plainErr?.message);
  });

  it('невикористаний ранній розбір не лежить у пам\'яті вічно', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const t = build([content('робити / зробити')]);
      (t.service as any).lookupScope.run({ surface: 'made', rawContext: SENTENCE }, () =>
        (t.service as any).startSurfacePrefetch({ text: 'make', partOfSpeech: 'verb', translation: 'робити' }),
      );
      expect((t.service as any).surfacePrefetches.size).toBe(1);
      jest.advanceTimersByTime(60_001);
      expect((t.service as any).surfacePrefetches.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Повний тап у читалці (WordService) — відповідь клієнту та сама', () => {
  it('нове слово "made": лема make, переклад і контекстний переклад речення', async () => {
    const t = build([content('робити / зробити')]);
    jest.spyOn(t.service as any, 'findOrGenerateWord').mockImplementation(() =>
      (t.service as any).createSingleWordEntry('make', 'verb', SENTENCE),
    );
    const cache: any = { set: jest.fn(async () => undefined), get: jest.fn() };
    const userWordRepo: any = { findOne: jest.fn(async () => null) };
    const wordService = new WordService({ save: jest.fn(async (w: any) => w) } as any, userWordRepo, {} as any, {} as any, {} as any, cache, {} as any, t.service, {} as any, {} as any);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((wordService as any).logger, l).mockImplementation(() => undefined);

    const res = await wordService.searchOrCreateGlobalWord(7, 'made', undefined, SENTENCE);
    expect(res.word).toMatchObject({ id: 501, text: 'make', translation: 'робити / зробити', partOfSpeech: 'verb' });
    expect(res.word.examples).toHaveLength(6);
    expect(res.surfaceTranslation).toBe('зробив');
    expect(res.transient).toBe(false);
    expect(Object.keys(res).sort()).toEqual(['isAdded', 'surfaceAnalysis', 'surfaceTranslation', 'transient', 'userWordId', 'verbForms', 'word']);
    expect(t.requests[0].stream).toBe(true);
    expect(t.surfaceRequest).toHaveBeenCalledTimes(1);
    expect(t.timeline.indexOf('analysis:start')).toBeLessThan(t.timeline.indexOf('content:done'));
  });
});

describe('extractStreamedTranslation', () => {
  it.each([
    ['', null],
    ['{"transl', null],
    ['{"translation":"роб', null],
    ['{"translation":"робити / зробити"', 'робити / зробити'],
    ['{ "translation" : "зроблений", "pron', 'зроблений'],
    ['{"translation":"він сказав \\"так\\"","x":1', 'він сказав "так"'],
    ['{"translation":"\\u0456ти"', 'іти'],
  ])('%j → %j', (input, expected) => {
    expect(extractStreamedTranslation(input)).toBe(expected);
  });

  it('текст "translation" усередині прикладу (екрановані лапки) не плутається з полем', () => {
    expect(extractStreamedTranslation('{"examples":["say \\"translation\\": \\"x\\""],"translation":"так"')).toBe('так');
    expect(extractStreamedTranslation('{"examples":["say \\"translation\\": \\"x\\""')).toBeNull();
  });
});
