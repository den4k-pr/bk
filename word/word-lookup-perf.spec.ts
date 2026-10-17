// Оптимізації шляху "тап по слову в читалці": логіка пошуку / генерації не
// змінюється, лише прибирається дублювання й послідовне очікування.
// 🔒 Жодного реального OpenAI.
const openAiCreate = jest.fn(async () => {
  throw new Error('OpenAI НЕ повинен викликатись у цьому тесті');
});
jest.mock('openai/client.js', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));

import { ServiceUnavailableException } from '@nestjs/common';
import { WordGenerationService } from './words-details/word-generation.service';
import { WordService } from './word.service';

const qbReturning = (result: { many?: any[]; one?: any }) => {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'orWhere', 'orderBy', 'addOrderBy', 'limit', 'take', 'skip', 'setParameter', 'setParameters', 'innerJoin', 'leftJoin']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn(async () => result.many ?? []);
  qb.getOne = jest.fn(async () => result.one ?? null);
  return qb;
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const memoryAiCache = () => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key: string, _kind: string, value: unknown) => void store.set(key, value)),
  };
};

beforeEach(() => {
  openAiCreate.mockClear();
  (WordGenerationService as any).openAiQuotaBlockedUntil = null;
});

describe('WordGenerationService — тап у читалці без дублювання', () => {
  const build = (opts: { entries?: any[]; library?: any } = {}) => {
    const wordRepo: any = {
      createQueryBuilder: jest.fn(() => qbReturning({ many: opts.entries ?? [], one: (opts.entries ?? [])[0] ?? null })),
      findOne: jest.fn(async () => null),
      create: jest.fn((d: any) => ({ ...d })),
      save: jest.fn(),
    };
    const phraseRepo: any = { createQueryBuilder: jest.fn(() => qbReturning({ one: opts.library ?? null })) };
    const aliasRepo: any = { findOne: jest.fn(async () => null), createQueryBuilder: jest.fn() };
    const aiCache = memoryAiCache();
    const service = new WordGenerationService({ clear: jest.fn() } as any, wordRepo, phraseRepo, aliasRepo, aiCache as any);
    for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return { service, wordRepo, phraseRepo, aiCache };
  };

  it('два одночасні однакові тапи → один пошук/генерація, кожен отримує власну копію', async () => {
    const { service } = build();
    const gate = deferred<any>();
    const find = jest.spyOn(service as any, 'findOrGenerateWord').mockImplementation(() => gate.promise);
    const a = service.searchOrCreateGlobalWord('walking', undefined, 'I was walking home');
    const b = service.searchOrCreateGlobalWord('walking', undefined, 'I was walking home');
    gate.resolve({ id: 5, text: 'walk', forms: ['walked'] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(rb);
    expect(ra).not.toBe(rb);
  });

  it('копія для другого запиту зберігає прототип і прапорець transient', async () => {
    const { service } = build();
    class FakeWord {
      id = 0;
      text = 'x';
    }
    const original = Object.assign(new FakeWord(), { transient: true });
    const gate = deferred<any>();
    jest.spyOn(service as any, 'findOrGenerateWord').mockImplementation(() => gate.promise);
    const a = service.searchOrCreateGlobalWord('x', undefined, 'ctx x');
    const b = service.searchOrCreateGlobalWord('x', undefined, 'ctx x');
    gate.resolve(original);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(original);
    expect(rb).toBeInstanceOf(FakeWord);
    expect((rb as any).transient).toBe(true);
  });

  it('інше речення або частина мови → окремі запити (не об\'єднуються)', async () => {
    const { service } = build();
    const find = jest.spyOn(service as any, 'findOrGenerateWord').mockImplementation(async () => ({ id: 1, text: 'walk' }));
    await Promise.all([
      service.searchOrCreateGlobalWord('walking', undefined, 'I was walking home'),
      service.searchOrCreateGlobalWord('walking', undefined, 'She is walking'),
      service.searchOrCreateGlobalWord('walking', 'verb', 'I was walking home'),
    ]);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('після завершення запиту наступний тап шукає знову (результат не "застрягає")', async () => {
    const { service } = build();
    const find = jest.spyOn(service as any, 'findOrGenerateWord').mockImplementation(async () => ({ id: 1, text: 'walk' }));
    await service.searchOrCreateGlobalWord('walking', undefined, 'ctx walking');
    await service.searchOrCreateGlobalWord('walking', undefined, 'ctx walking');
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('помилка спільного запиту доходить до обох викликачів', async () => {
    const { service } = build();
    jest.spyOn(service as any, 'findOrGenerateWord').mockRejectedValue(new ServiceUnavailableException('pause'));
    const results = await Promise.allSettled([
      service.searchOrCreateGlobalWord('walking', undefined, 'c walking'),
      service.searchOrCreateGlobalWord('walking', undefined, 'c walking'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('фраза вже є в словнику → бібліотека фраз не запитується (зайвий запит прибрано)', async () => {
    const giveUp = { id: 3, text: 'give up', senseKey: '', partOfSpeech: 'phrasal_verb', translation: 'здаватися', forms: [], examples: [] };
    const { service, phraseRepo } = build({ entries: [giveUp] });
    await expect(service.searchOrCreateGlobalWord('give up')).resolves.toMatchObject({ id: 3 });
    expect(phraseRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('нова фраза → бібліотека фраз, як і раніше, запитується перед генерацією', async () => {
    (WordGenerationService as any).openAiQuotaBlockedUntil = Date.now() + 30_000;
    const { service, phraseRepo } = build({ entries: [] });
    await expect(service.searchOrCreateGlobalWord('make up for')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(phraseRepo.createQueryBuilder).toHaveBeenCalled();
    expect(openAiCreate).not.toHaveBeenCalled();
  });
});

describe('WordService.searchOrCreateGlobalWord — незалежні кроки паралельно', () => {
  const build = () => {
    const userWordRepo: any = { findOne: jest.fn(async () => ({ id: 42 })) };
    const cache: any = { set: jest.fn(async () => undefined), get: jest.fn() };
    const analysisGate = deferred<any>();
    const gen: any = {
      searchOrCreateGlobalWord: jest.fn(async () => ({ id: 9, text: 'walk', partOfSpeech: 'verb', forms: ['walked'], examples: [], exampleHighlights: [] })),
      analyzeSurfaceInContext: jest.fn(() => analysisGate.promise),
    };
    const wordRepo: any = { findOne: jest.fn(async () => null), update: jest.fn(), save: jest.fn(async (w: any) => w) };
    const service = new WordService(wordRepo, userWordRepo, {} as any, {} as any, {} as any, cache, {} as any, gen, {} as any, {} as any);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return { service, userWordRepo, cache, gen, analysisGate };
  };

  it('пошук у словнику користувача і запис lastLookup стартують, поки AI ще розбирає форму', async () => {
    const { service, userWordRepo, cache, analysisGate } = build();
    const pending = service.searchOrCreateGlobalWord(7, 'walking', undefined, 'I was walking home');
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(userWordRepo.findOne).toHaveBeenCalledWith({
      where: { user: { id: 7 }, word: { id: 9 } },
      select: { id: true },
      loadEagerRelations: false,
    });
    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('7'), 9, 3600);
    analysisGate.resolve({ surface: 'walking', contextualTranslation: 'йшов', verbGroup: 'was walking', function: 'finite_verb' });
    await expect(pending).resolves.toMatchObject({ isAdded: true, userWordId: 42, surfaceTranslation: 'йшов', transient: false });
  });

  it('збій Redis при записі lastLookup не ламає відповідь', async () => {
    const { service, cache, analysisGate } = build();
    cache.set.mockRejectedValue(new Error('redis down'));
    analysisGate.resolve(null);
    await expect(service.searchOrCreateGlobalWord(7, 'walk', undefined, 'I walk')).resolves.toMatchObject({
      isAdded: true,
      surfaceAnalysis: null,
    });
  });
});
