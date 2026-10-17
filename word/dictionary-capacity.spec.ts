import {
  assertDictionaryCapacity,
  computeDictionaryCapacity,
  DICTIONARY_LIMIT_REACHED,
  DictionaryLimitReachedException,
  getDictionaryFreeLimit,
  loadDictionaryCapacity,
} from './dictionary-capacity';

/** Мінімальний EntityManager: відповідає на запити рядком користувача й кількістю слів. */
const fakeEm = (user: { dictionaryUnlimited?: boolean; premiumExpiresAt?: Date | null } | null, count: number) => {
  const calls: string[] = [];
  const em: any = {
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [{}];
      if (sql.includes('FROM "user"')) return user ? [user] : [];
      if (sql.includes('FROM "user_word"')) return [{ count }];
      return [];
    }),
  };
  return { em, calls };
};

describe('dictionary capacity', () => {
  const OLD_ENV = process.env.DICTIONARY_FREE_WORD_LIMIT;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.DICTIONARY_FREE_WORD_LIMIT;
    else process.env.DICTIONARY_FREE_WORD_LIMIT = OLD_ENV;
  });

  describe('ліміт', () => {
    it('за замовчуванням 200, з оточення — будь-яке додатне ціле', () => {
      delete process.env.DICTIONARY_FREE_WORD_LIMIT;
      expect(getDictionaryFreeLimit()).toBe(200);
      process.env.DICTIONARY_FREE_WORD_LIMIT = '300';
      expect(getDictionaryFreeLimit()).toBe(300);
    });
    it('сміття в оточенні → значення за замовчуванням', () => {
      for (const bad of ['', 'abc', '0', '-5', '1.5', '2.9']) {
        process.env.DICTIONARY_FREE_WORD_LIMIT = bad;
        expect(getDictionaryFreeLimit()).toBe(200);
      }
    });
  });

  describe('computeDictionaryCapacity', () => {
    it('9 з 10 — ще можна 1', () => {
      expect(computeDictionaryCapacity({ count: 9, dictionaryUnlimited: false, limit: 10 })).toEqual({
        limit: 10, count: 9, unlimited: false, remaining: 1, reached: false,
      });
    });
    it('10 з 10 — заповнено', () => {
      expect(computeDictionaryCapacity({ count: 10, dictionaryUnlimited: false, limit: 10 }).reached).toBe(true);
    });
    it('більше за ліміт (старі акаунти) — заповнено, remaining 0', () => {
      const c = computeDictionaryCapacity({ count: 57, dictionaryUnlimited: false, limit: 10 });
      expect(c).toMatchObject({ reached: true, remaining: 0 });
    });
    it('куплений безлімітний словник — без обмеження', () => {
      expect(computeDictionaryCapacity({ count: 500, dictionaryUnlimited: true, limit: 10 })).toMatchObject({
        unlimited: true, reached: false, remaining: null,
      });
    });
    it('активний Premium — без обмеження; прострочений — з обмеженням', () => {
      const now = Date.parse('2026-10-11T12:00:00Z');
      const active = computeDictionaryCapacity({ count: 50, dictionaryUnlimited: false, premiumExpiresAt: '2026-11-01T00:00:00Z', now, limit: 10 });
      const expired = computeDictionaryCapacity({ count: 50, dictionaryUnlimited: false, premiumExpiresAt: '2026-10-01T00:00:00Z', now, limit: 10 });
      expect(active.unlimited).toBe(true);
      expect(expired).toMatchObject({ unlimited: false, reached: true });
    });
    it('некоректні дані не ламають розрахунок', () => {
      expect(computeDictionaryCapacity({ count: NaN, dictionaryUnlimited: false, premiumExpiresAt: 'not-a-date', limit: 10 })).toMatchObject({
        count: 0, unlimited: false, remaining: 10,
      });
    });
  });

  describe('assertDictionaryCapacity (у транзакції)', () => {
    beforeEach(() => { process.env.DICTIONARY_FREE_WORD_LIMIT = '10'; });

    it('додати 1 при 9/10 — можна, з блокуванням на користувача', async () => {
      const { em, calls } = fakeEm({ dictionaryUnlimited: false }, 9);
      await expect(assertDictionaryCapacity(em, 7, 1)).resolves.toBeUndefined();
      expect(calls[0]).toContain('pg_advisory_xact_lock');
      expect(em.query.mock.calls[0][1]).toEqual(['dict_capacity:7']);
    });

    it('додати 1 при 10/10 — 403 з кодом DICTIONARY_LIMIT_REACHED', async () => {
      const { em } = fakeEm({ dictionaryUnlimited: false }, 10);
      const error = await assertDictionaryCapacity(em, 7, 1).catch(e => e);
      expect(error).toBeInstanceOf(DictionaryLimitReachedException);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({ code: DICTIONARY_LIMIT_REACHED, limit: 10, count: 10 });
    });

    it('пачка, що не влазить (8 + 3 > 10), — відхиляється повністю', async () => {
      const { em } = fakeEm({ dictionaryUnlimited: false }, 8);
      await expect(assertDictionaryCapacity(em, 7, 3)).rejects.toBeInstanceOf(DictionaryLimitReachedException);
      await expect(assertDictionaryCapacity(em, 7, 2)).resolves.toBeUndefined();
    });

    it('безлімітний словник — будь-яка кількість', async () => {
      const { em } = fakeEm({ dictionaryUnlimited: true }, 999);
      await expect(assertDictionaryCapacity(em, 7, 50)).resolves.toBeUndefined();
    });

    it('нічого не додається — без запитів до бази', async () => {
      const { em } = fakeEm({ dictionaryUnlimited: false }, 10);
      await assertDictionaryCapacity(em, 7, 0);
      expect(em.query).not.toHaveBeenCalled();
    });

    it('стан для застосунку', async () => {
      const { em } = fakeEm({ dictionaryUnlimited: false }, 4);
      await expect(loadDictionaryCapacity(em, 7)).resolves.toEqual({
        limit: 10, count: 4, unlimited: false, remaining: 6, reached: false,
      });
    });
  });
});
