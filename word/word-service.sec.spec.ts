const openAiCreate = jest.fn(async () => {
  throw new Error('OpenAI НЕ повинен викликатись');
});
jest.mock('openai', () => ({ OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })) }));
jest.mock('openai/client.js', () => ({ OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })) }));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DICTIONARY_LIMIT_REACHED } from './dictionary-capacity';
import { WordController } from './word.controller';
import { WordService } from './word.service';

const throttle = (name: string) => Reflect.getMetadata('THROTTLER:LIMITdefault', (WordController.prototype as any)[name]);

describe('WordService — словник користувача', () => {
  let userWordRepo: any;
  let em: any;
  let emQueries: { sql: string; params: any[] }[];
  let userRow: any;
  let dictCount: number;
  let spell: any;
  let gen: any;
  let cache: any;
  let service: WordService;

  beforeEach(() => {
    openAiCreate.mockClear();
    emQueries = [];
    userRow = { dictionaryUnlimited: false, premiumExpiresAt: null };
    dictCount = 0;
    em = {
      query: jest.fn(async (sql: string, params: any[]) => {
        emQueries.push({ sql, params });
        if (sql.includes('FROM "user"')) return [userRow];
        if (sql.includes('FROM "user_word"')) return [{ count: dictCount }];
        return [];
      }),
      findOne: jest.fn(async () => null),
      create: jest.fn((_e: any, d: any) => ({ ...d })),
      save: jest.fn(async (row: any) => ({ id: 500, addedAt: new Date(), ...row })),
    };
    userWordRepo = {
      manager: { ...em, transaction: jest.fn(async (fn: any) => fn(em)) },
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (x: any) => x),
    };
    spell = { resolve: jest.fn(async (t: string) => ({ query: t, originalQuery: t, corrected: false, method: 'none', confidence: 1 })) };
    gen = { searchOrCreateGlobalWord: jest.fn(async () => ({ id: 9, text: 'apple', examples: [] })), resolveUkrainianQuery: jest.fn() };
    cache = { clearByPattern: jest.fn(), clearByPatterns: jest.fn(), get: jest.fn(), set: jest.fn() };
    const wordRepo: any = { findOne: jest.fn(async () => null), update: jest.fn() };
    const userRepo: any = { findOne: jest.fn(async () => ({ id: 7 })) };
    service = new WordService(wordRepo, userWordRepo, userRepo, {} as any, {} as any, cache, {} as any, gen, {} as any, spell);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
  });

  describe('ліміт словника', () => {
    it('словник заповнено → 403 DICTIONARY_LIMIT_REACHED ДО корекції і генерації (OpenAI не викликається)', async () => {
      dictCount = 200;
      const err: any = await service.addOrGetUserWord(7, 'serendipity').catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: DICTIONARY_LIMIT_REACHED, limit: 200, count: 200 });
      expect(spell.resolve).not.toHaveBeenCalled();
      expect(gen.searchOrCreateGlobalWord).not.toHaveBeenCalled();
      expect(openAiCreate).not.toHaveBeenCalled();
    });

    it('безлімітний словник (покупка) або активний преміум → ліміт не діє', async () => {
      dictCount = 10_000;
      userRow = { dictionaryUnlimited: true, premiumExpiresAt: null };
      await expect(service.addOrGetUserWord(7, 'apple')).resolves.toMatchObject({ id: 500 });
      userRow = { dictionaryUnlimited: false, premiumExpiresAt: new Date(Date.now() + 60_000) };
      await expect(service.addOrGetUserWord(7, 'apple')).resolves.toMatchObject({ id: 500 });
    });

    it('прострочений преміум ліміт не знімає', async () => {
      dictCount = 200;
      userRow = { dictionaryUnlimited: false, premiumExpiresAt: new Date(Date.now() - 1000) };
      await expect(service.addOrGetUserWord(7, 'apple')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('перевірка і вставка — у транзакції під advisory-lock на пару (user, word) і на ліміт користувача', async () => {
      await service.addOrGetUserWord(7, 'apple');
      const locks = emQueries.filter((q) => q.sql.includes('pg_advisory_xact_lock')).map((q) => q.params[0]);
      expect(locks).toEqual(['user_word:7:9', 'dict_capacity:7']);
    });

    it('слово вже в словнику → повертається наявний запис, ліміт не перевіряється повторно (199→ок навіть при 200)', async () => {
      em.findOne.mockResolvedValue({ id: 42, userTranslation: null, userText: null });
      const result: any = await service.addOrGetUserWord(7, 'apple');
      expect(result.id).toBe(42);
      expect(em.save).not.toHaveBeenCalled();
      expect(emQueries.some((q) => q.params?.[0] === 'dict_capacity:7')).toBe(false);
    });

    it('порожній текст → null без жодних запитів', async () => {
      await expect(service.addOrGetUserWord(7, '  .  ')).resolves.toBeNull();
      expect(em.query).not.toHaveBeenCalled();
    });
  });

  describe('ізоляція: кожна зміна запису словника фільтрується за userId', () => {
    it('deleteUserWord: умова містить і id запису, і власника; чужий запис → 404', async () => {
      userWordRepo.delete.mockResolvedValueOnce({ affected: 0 });
      await expect(service.deleteUserWord(7, 99)).rejects.toBeInstanceOf(NotFoundException);
      expect(userWordRepo.delete).toHaveBeenCalledWith({ id: 99, user: { id: 7 } });
    });

    it('deleteUserWordsBatch: IN(ids) + власник', async () => {
      await service.deleteUserWordsBatch(7, [1, 2, 3]);
      const where = userWordRepo.delete.mock.calls[0][0];
      expect(where.user).toEqual({ id: 7 });
      expect(where.id._value).toEqual([1, 2, 3]);
    });

    it('deleteUserWordsBatch з порожнім списком → без запиту (не "видалити все")', async () => {
      await expect(service.deleteUserWordsBatch(7, [])).resolves.toEqual({ success: true, deletedCount: 0 });
      expect(userWordRepo.delete).not.toHaveBeenCalled();
    });

    it('resetUserWordProgress / resetUserProgressBatch — лише власні записи', async () => {
      userWordRepo.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.resetUserWordProgress(7, 99)).rejects.toBeInstanceOf(NotFoundException);
      expect(userWordRepo.update.mock.calls[0][0]).toEqual({ id: 99, user: { id: 7 } });
      await service.resetUserProgressBatch(7, [5]);
      expect(userWordRepo.update.mock.calls[1][0].user).toEqual({ id: 7 });
      await expect(service.resetUserProgressBatch(7, [])).resolves.toEqual({ success: true, updatedCount: 0 });
      expect(userWordRepo.update).toHaveBeenCalledTimes(2);
    });

    it.each(['toggleFavorite', 'updateUserWordNotes', 'updateUserWordCustomData', 'getUserWordById'])(
      '%s шукає запис за (id, власник); чужий/неіснуючий → 404 або null',
      async (method) => {
        const result = await (service as any)[method](7, 99, 'x').catch((e: any) => e);
        expect(userWordRepo.findOne.mock.calls[0][0].where).toEqual({ id: 99, user: { id: 7 } });
        if (method === 'getUserWordById') expect(result).toBeNull();
        else expect(result).toBeInstanceOf(NotFoundException);
      },
    );

    it('нотатки: порожній рядок → null, пробіли обрізаються', async () => {
      userWordRepo.findOne.mockResolvedValue({ id: 99, notes: 'old' });
      await expect(service.updateUserWordNotes(7, 99, '   ')).resolves.toMatchObject({ notes: null });
      await expect(service.updateUserWordNotes(7, 99, '  hi  ')).resolves.toMatchObject({ notes: 'hi' });
    });
  });

  describe('getUserWordsPaginated — межі', () => {
    const qb: any = {};
    beforeEach(() => {
      for (const m of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'offset', 'limit']) qb[m] = jest.fn(() => qb);
      qb.getMany = jest.fn(async () => []);
      userWordRepo.createQueryBuilder = jest.fn(() => qb);
    });

    it('pageSize обмежено 100, сторінка ≥ 1; фільтр за власником завжди', async () => {
      await service.getUserWordsPaginated(7, -5, 100_000);
      expect(qb.limit).toHaveBeenCalledWith(100);
      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(qb.where).toHaveBeenCalledWith('"userWord"."userId" = :userId', { userId: 7 });
    });

    it('пошук — параметром (LIKE з %), не конкатенацією', async () => {
      await service.getUserWordsPaginated(7, 1, 10, undefined, undefined, "a' OR '1'='1");
      const call = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes('LIKE'));
      expect(call[1]).toEqual({ search: "%a' OR '1'='1%" });
    });
  });
});

describe('WordController', () => {
  let service: any;
  let controller: WordController;
  const oldSecret = process.env.ADMIN_SECRET;
  const req = (headers: Record<string, string> = {}, user: any = { id: 7 }) => ({ user, headers }) as any;

  beforeEach(() => {
    delete process.env.ADMIN_SECRET;
    service = new Proxy({}, { get: (t: any, k) => (t[k] ??= jest.fn().mockResolvedValue({})) });
    controller = new WordController(service, {} as any, { clear: jest.fn(), clearUserProgressCaches: jest.fn() } as any, service);
    jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    if (oldSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = oldSecret;
  });

  it('увесь контролер під JwtAuthGuard', () => {
    expect(Reflect.getMetadata('__guards__', WordController)).toEqual([JwtAuthGuard]);
  });

  it('ліміти на дорогих AI-маршрутах', () => {
    expect(throttle('searchOrCreateGlobalWord')).toBe(60);
    expect(throttle('addWord')).toBe(20);
    expect(throttle('reportLookup')).toBe(20);
  });

  describe('адмінські маршрути /words/admin/* та /words/all*', () => {
    const adminCalls: [string, any[]][] = [
      ['nukeAllWordData', []],
      ['deleteWord', [1]],
      ['getAllWords', []],
      ['getAllWordsShort', []],
      ['getAllWordsPronunciations', []],
      ['startCategoryAnalysis', []],
    ];

    it.each(adminCalls)('%s: звичайний користувач → 403, сервіс не викликається', async (method, args) => {
      await expect((controller as any)[method](req(), ...args)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ADMIN_SECRET не задано → порожній/будь-який заголовок не дає доступу', async () => {
      await expect(controller.nukeAllWordData(req({ 'x-admin-secret': '' }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.nukeAllWordData(req({ 'x-admin-secret': 'undefined' }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.clearAllData).not.toHaveBeenCalled();
    });

    it('невірний секрет → 403; вірний → доступ', async () => {
      process.env.ADMIN_SECRET = 'static-secret';
      await expect(controller.getAllWords(req({ 'x-admin-secret': 'static-secre' }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.getAllWords(req({ 'x-admin-secret': 'static-secret' }))).resolves.toBeDefined();
    });

    it('role у req.user береться лише з JwtStrategy (там її немає) — підробити через тіло не можна', async () => {
      const r: any = req();
      r.body = { role: 'admin' };
      await expect(controller.getAllWords(r)).rejects.toBeInstanceOf(ForbiddenException);
    });

    // БЕЗПЕКА: /words/admin/* (включно з DELETE /words/admin/nuke-all-data —
    // TRUNCATE word і user_word) захищені статичним спільним секретом у
    // заголовку x-admin-secret, а не AdminJwtAuthGuard+MFA, без аудиту і з
    // порівнянням не за сталий час. Будь-який власник секрету + будь-який
    // користувацький акаунт = повне знищення словника.
    // Виправлення: перенести на AdminJwtAuthGuard + PermissionsGuard
    // ('words:delete') як у /admin/words, або видалити ці маршрути.
    it.failing('БЕЗПЕКА: nuke-all-data має вимагати адмінського JWT з MFA, а не статичного секрету', async () => {
      process.env.ADMIN_SECRET = 'leaked-secret';
      await expect(controller.nukeAllWordData(req({ 'x-admin-secret': 'leaked-secret' }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('вхідні дані', () => {
    it.each([[''], ['   '], [undefined], [123], [['apple']], [{ q: 1 }]])('search-or-create з query=%p → 400 без звернення до сервісу', async (q) => {
      await expect(controller.searchOrCreateGlobalWord(req(), q as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(service.searchOrCreateGlobalWord).not.toHaveBeenCalled();
    });

    it('запит довше 150 символів → 400 (не перетворюється на дорогий AI-запит)', async () => {
      await expect(controller.searchOrCreateGlobalWord(req(), 'a'.repeat(151))).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.addWord(req(), 'a'.repeat(151))).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.reportLookup(req(), 'a'.repeat(151))).rejects.toBeInstanceOf(BadRequestException);
      expect(service.searchOrCreateGlobalWord).not.toHaveBeenCalled();
      expect(service.addOrGetUserWord).not.toHaveBeenCalled();
    });

    it('150 символів — ще ок; query обрізається; не-рядковий context відкидається', async () => {
      await controller.searchOrCreateGlobalWord(req(), ` ${'a'.repeat(150)} `, undefined, { evil: 1 } as any);
      expect(service.searchOrCreateGlobalWord).toHaveBeenCalledWith(7, 'a'.repeat(150), undefined, undefined);
    });

    it('userId завжди з JWT', async () => {
      service.addOrGetUserWord.mockResolvedValue({ id: 1, word: {}, addedAt: new Date() });
      await controller.addWord(req(), 'apple');
      expect(service.addOrGetUserWord.mock.calls[0][0]).toBe(7);
    });

    it('нотатки > 400 символів → 400', async () => {
      await expect(controller.updateUserWordNotes(req(), 1, 'x'.repeat(401))).rejects.toBeInstanceOf(BadRequestException);
      expect(service.updateUserWordNotes).not.toHaveBeenCalled();
    });

    it('me/paginated: page/pageSize/status/type валідуються', async () => {
      await expect(controller.getUserWordsPaginated(req(), '0')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getUserWordsPaginated(req(), 'abc')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getUserWordsPaginated(req(), '1', '-1')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getUserWordsPaginated(req(), '1', '10', undefined, 'hacked')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getUserWordsPaginated(req(), '1', '10', undefined, undefined, undefined, 'sql')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('dictionary/random: count обмежено 1..5', async () => {
      await controller.getUserRandomDictionaryWords(req(), '1000');
      await controller.getUserRandomDictionaryWords(req(), '-3');
      await controller.getUserRandomDictionaryWords(req(), 'NaN');
      expect(service.getUserRandomDictionaryWordsForStudy.mock.calls.map((c: any[]) => c[1])).toEqual([5, 1, 1]);
    });

    // ПРОДУКТИВНІСТЬ / DoS: bulk-add приймає масив будь-якої довжини (тіло до
    // 2 МБ ≈ 200 тис. слів) і на кожне слово бере окремий advisory-lock у
    // транзакції; маршрут без власного @Throttle. Виправлення: DTO з
    // @ArrayMaxSize(200) + @MaxLength на елементах, @Throttle.
    it.failing('DoS: bulk-add має відхиляти тисячі слів за раз', async () => {
      await expect(controller.addManyUserWords(req(), Array.from({ length: 50_000 }, (_, i) => `w${i}`))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
