// 🔒 Жодного реального OpenAI: будь-який виклик create() рахується і за
// замовчуванням падає. Тести, що очікують "AI не викликається", перевіряють 0.
const openAiCreate = jest.fn(async () => {
  throw new Error('OpenAI НЕ повинен викликатись у цьому тесті');
});
jest.mock('openai/client.js', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));

import { ServiceUnavailableException, InternalServerErrorException } from '@nestjs/common';
import { DurableAiCacheService } from './durable-ai-cache.service';
import { SpellCorrectionService } from './spell-correction.service';
import { WordGenerationService } from './words-details/word-generation.service';

const chatReply = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

/** Простий query builder: усі методи ланцюжкові, результат задається ззовні. */
const qbReturning = (result: { many?: any[]; one?: any }) => {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'orWhere', 'orderBy', 'addOrderBy', 'limit', 'take', 'skip', 'setParameter', 'setParameters', 'innerJoin', 'leftJoin']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn(async () => result.many ?? []);
  qb.getOne = jest.fn(async () => result.one ?? null);
  return qb;
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
  openAiCreate.mockReset();
  openAiCreate.mockImplementation(async () => {
    throw new Error('OpenAI НЕ повинен викликатись у цьому тесті');
  });
  (WordGenerationService as any).openAiQuotaBlockedUntil = null;
});

// ═════════════════════ DurableAiCacheService ═════════════════════
describe('DurableAiCacheService (Redis → БД)', () => {
  const build = () => {
    const cache = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
    const repo = { findOne: jest.fn(), upsert: jest.fn().mockResolvedValue(undefined) };
    const service = new DurableAiCacheService(cache as any, repo as any);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    return { cache, repo, service };
  };

  it('гарячий Redis → БД не чіпається', async () => {
    const { cache, repo, service } = build();
    cache.get.mockResolvedValue({ english: 'apple' });
    await expect(service.get('k')).resolves.toEqual({ english: 'apple' });
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('промах Redis → БД; знайдене кладеться назад у Redis на 30 днів', async () => {
    const { cache, repo, service } = build();
    cache.get.mockResolvedValue(undefined);
    repo.findOne.mockResolvedValue({ key: 'k', value: { none: true } });
    await expect(service.get('k')).resolves.toEqual({ none: true });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { key: 'k' } });
    expect(cache.set).toHaveBeenCalledWith('k', { none: true }, 30 * 24 * 3600);
  });

  it('немає ніде → null', async () => {
    const { cache, repo, service } = build();
    cache.get.mockResolvedValue(undefined);
    repo.findOne.mockResolvedValue(null);
    await expect(service.get('k')).resolves.toBeNull();
  });

  it('Redis впав → іде в БД; БД теж впала → null (запит не ламається)', async () => {
    const { cache, repo, service } = build();
    cache.get.mockRejectedValue(new Error('redis down'));
    repo.findOne.mockResolvedValue({ value: 1 });
    await expect(service.get('k')).resolves.toBe(1);
    repo.findOne.mockRejectedValue(new Error('db down'));
    await expect(service.get('k')).resolves.toBeNull();
  });

  it('falsy-значення з Redis (0, false, "") не вважаються промахом', async () => {
    const { cache, repo, service } = build();
    for (const v of [0, false, '']) {
      cache.get.mockResolvedValueOnce(v);
      await expect(service.get('k')).resolves.toBe(v);
    }
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('set: upsert за ключем у БД + Redis; збій БД не заважає Redis і не кидає', async () => {
    const { cache, repo, service } = build();
    await service.set('k', 'spell', { a: 1 });
    expect(repo.upsert).toHaveBeenCalledWith({ key: 'k', kind: 'spell', value: { a: 1 } }, ['key']);
    expect(cache.set).toHaveBeenCalledWith('k', { a: 1 }, 30 * 24 * 3600);
    repo.upsert.mockRejectedValue(new Error('db down'));
    cache.set.mockRejectedValue(new Error('redis down'));
    await expect(service.set('k', 'spell', 1)).resolves.toBeUndefined();
  });
});

// ═════════════════════ SpellCorrectionService ═════════════════════
describe('SpellCorrectionService — AI лише коли справді треба', () => {
  const build = (wordRow: any = null) => {
    const wordRepo: any = {
      createQueryBuilder: jest.fn(() => qbReturning({ one: wordRow, many: [] })),
      query: jest.fn(async () => []),
      findOne: jest.fn(async () => wordRow),
    };
    const aiCache = memoryAiCache();
    const service = new SpellCorrectionService(wordRepo, aiCache as any);
    for (const l of ['log', 'warn'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return { service, aiCache, wordRepo };
  };

  it('порожній ввід / кирилиця → без БД і без AI', async () => {
    const { service, wordRepo } = build();
    await expect(service.resolve('   ')).resolves.toMatchObject({ method: 'none' });
    await expect(service.resolve('яблуко')).resolves.toMatchObject({ method: 'none', query: 'яблуко' });
    expect(wordRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('точний збіг у БД → AI не викликається', async () => {
    const { service } = build({ id: 1, text: 'apple' });
    await expect(service.resolve('Apple.')).resolves.toMatchObject({ method: 'none', matchedWord: { id: 1 } });
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('відомий одрук зі словника → без AI', async () => {
    const { service } = build();
    await expect(service.resolve('recieve')).resolves.toMatchObject({ query: 'receive', method: 'common_typo' });
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('короткі слова (< 4 літер) не виправляються і не йдуть в AI', async () => {
    const { service } = build();
    await expect(service.resolve('xqz')).resolves.toMatchObject({ method: 'none', query: 'xqz' });
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('відповідь AI береться з кешу: той самий ввід удруге — без виклику OpenAI', async () => {
    const { service } = build();
    openAiCreate.mockResolvedValueOnce(chatReply({ isValid: false, corrected: 'banana', confidence: 'high' }) as never);
    const first = await (service as any).correctViaAi('banama');
    const second = await (service as any).correctViaAi('banama');
    expect(first).toBe('banana');
    expect(second).toBe('banana');
    expect(openAiCreate).toHaveBeenCalledTimes(1);
  });

  it('негативна відповідь («слово валідне») теж кешується', async () => {
    const { service } = build();
    openAiCreate.mockResolvedValueOnce(chatReply({ isValid: true, corrected: 'zyzzyva', confidence: 'high' }) as never);
    await (service as any).correctViaAi('zyzzyva');
    await (service as any).correctViaAi('zyzzyva');
    expect(openAiCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['підміна слова (dist > 2)', { isValid: false, corrected: 'serenity', confidence: 'high' }, 'serendipity'],
    ['інша кількість слів', { isValid: false, corrected: 'give it up', confidence: 'high' }, 'gve up'],
    ['небезпечні символи', { isValid: false, corrected: 'drop table;', confidence: 'high' }, 'drop tabel'],
    ['низька впевненість', { isValid: false, corrected: 'house', confidence: 'low' }, 'housr'],
  ])('AI-відповідь відхиляється: %s', async (_n, reply, input) => {
    const { service } = build();
    openAiCreate.mockResolvedValueOnce(chatReply(reply) as never);
    await expect((service as any).correctViaAi(input)).resolves.toBeNull();
  });

  it('збій OpenAI (429 / мережа) → null, запит користувача не падає', async () => {
    const { service } = build();
    openAiCreate.mockRejectedValueOnce(Object.assign(new Error('Rate limit'), { status: 429 }) as never);
    await expect((service as any).correctViaAi('bananna')).resolves.toBeNull();
  });

  // ПРОДУКТИВНІСТЬ / ВИТРАТИ: корекція ігнорує глобальну паузу ШІ
  // (WordGenerationService.openAiQuotaBlockedUntil). Коли OpenAI повернув
  // insufficient_quota, кожен новий тап однаково стукає в gpt-4o (і отримує
  // 429), додаючи затримку й навантаження. Виправлення: перевіряти спільний
  // cooldown перед викликом (винести його в окремий сервіс).
  it('ВИТРАТИ: під час паузи після 429 корекція не має викликати OpenAI', async () => {
    const { service } = build();
    (WordGenerationService as any).openAiQuotaBlockedUntil = Date.now() + 60_000;
    openAiCreate.mockResolvedValue(chatReply({ isValid: true, corrected: 'x', confidence: 'high' }) as never);
    await (service as any).correctViaAi('bananna');
    expect(openAiCreate).not.toHaveBeenCalled();
  });
});

// ═════════════════════ WordGenerationService ═════════════════════
describe('WordGenerationService — кеш, БД і пауза ШІ', () => {
  const apple = { id: 11, text: 'apple', senseKey: '', partOfSpeech: 'noun', translation: 'яблуко', forms: ['apples'], examples: [] };

  const build = (opts: { entries?: any[]; alias?: any; library?: any } = {}) => {
    const wordRepo: any = {
      createQueryBuilder: jest.fn(() => qbReturning({ many: opts.entries ?? [], one: (opts.entries ?? [])[0] ?? null })),
      findOne: jest.fn(async () => null),
      create: jest.fn((d: any) => ({ ...d })),
      save: jest.fn(),
    };
    const phraseRepo: any = { createQueryBuilder: jest.fn(() => qbReturning({ one: opts.library ?? null })) };
    const aliasRepo: any = { findOne: jest.fn(async () => opts.alias ?? null), createQueryBuilder: jest.fn() };
    const aiCache = memoryAiCache();
    const cacheService: any = { clear: jest.fn() };
    const service = new WordGenerationService(cacheService, wordRepo, phraseRepo, aliasRepo, aiCache as any);
    for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return { service, wordRepo, aliasRepo, aiCache };
  };

  it('слово вже є в БД → повертається воно, OpenAI не викликається, у БД нічого не пишеться', async () => {
    const { service, wordRepo } = build({ entries: [apple] });
    await expect(service.searchOrCreateGlobalWord('apple')).resolves.toMatchObject({ id: 11 });
    await expect(service.searchOrCreateGlobalWord('  Apple ')).resolves.toMatchObject({ id: 11 });
    expect(openAiCreate).not.toHaveBeenCalled();
    expect(wordRepo.save).not.toHaveBeenCalled();
  });

  it('ручний виняток адміна (alias) має пріоритет і не викликає AI', async () => {
    const target = { id: 77, text: 'wood', translation: 'дерево' };
    const { service } = build({ alias: { source: 'admin', word: target } });
    await expect(service.searchOrCreateGlobalWord('wooden')).resolves.toBe(target);
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('під час паузи ШІ невідоме слово → 503, OpenAI не викликається', async () => {
    (WordGenerationService as any).openAiQuotaBlockedUntil = Date.now() + 30_000;
    const { service } = build({ entries: [] });
    await expect(service.searchOrCreateGlobalWord('make up for')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(openAiCreate).not.toHaveBeenCalled();
  });

  it('пауза минула → AI знову дозволений (assertOpenAiAvailable не кидає)', () => {
    (WordGenerationService as any).openAiQuotaBlockedUntil = Date.now() - 1;
    const { service } = build();
    expect(() => (service as any).assertOpenAiAvailable()).not.toThrow();
  });

  describe('handleOpenAiError', () => {
    const handle = (service: any, error: any) => {
      try {
        service.handleOpenAiError(error, 'test');
      } catch (e) {
        return e;
      }
      throw new Error('мала бути помилка');
    };

    it('insufficient_quota → 503 і пауза 60 с', () => {
      const { service } = build();
      const before = Date.now();
      expect(handle(service, { status: 429, code: 'insufficient_quota' })).toBeInstanceOf(ServiceUnavailableException);
      const until = (WordGenerationService as any).openAiQuotaBlockedUntil;
      expect(until - before).toBeGreaterThanOrEqual(59_000);
      expect(until - before).toBeLessThanOrEqual(61_000);
    });

    it('rate limit з retry-after-ms → пауза рівно стільки', () => {
      const { service } = build();
      const before = Date.now();
      handle(service, { status: 429, headers: { 'retry-after-ms': '2500' } });
      const until = (WordGenerationService as any).openAiQuotaBlockedUntil;
      expect(until - before).toBeGreaterThanOrEqual(2400);
      expect(until - before).toBeLessThanOrEqual(3500);
    });

    it('retry-after більший за 30 с обрізається до 30 с; без заголовків — 5 с', () => {
      const { service } = build();
      let before = Date.now();
      handle(service, { status: 429, headers: { get: (n: string) => (n === 'retry-after' ? '600' : null) } });
      expect((WordGenerationService as any).openAiQuotaBlockedUntil - before).toBeLessThanOrEqual(31_000);
      (WordGenerationService as any).openAiQuotaBlockedUntil = null;
      before = Date.now();
      handle(service, { status: 429 });
      expect((WordGenerationService as any).openAiQuotaBlockedUntil - before).toBeLessThanOrEqual(6_000);
    });

    it('коротша пауза не скорочує вже довшу', () => {
      const { service } = build();
      handle(service, { status: 429, code: 'insufficient_quota' });
      const longUntil = (WordGenerationService as any).openAiQuotaBlockedUntil;
      handle(service, { status: 429 });
      expect((WordGenerationService as any).openAiQuotaBlockedUntil).toBe(longUntil);
    });

    it('інша помилка → 500 без тексту від OpenAI, пауза не ставиться', () => {
      const { service } = build();
      const err: any = handle(service, { status: 400, message: 'Invalid schema: sk-proj-secret-detail' });
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err.message).not.toContain('sk-proj');
      expect((WordGenerationService as any).openAiQuotaBlockedUntil).toBeNull();
    });
  });

  // Переклад форми слова ("climbed" → "піднявся") — у word-form-translation.spec.ts.
});
