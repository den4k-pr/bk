import { ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Місткість особистого словника.
 *
 * Безкоштовно — DICTIONARY_FREE_LIMIT слів. Ліміт ніде не показується, доки
 * людина його не досягне; тоді застосунок пропонує разову покупку
 * "Безлімітний словник" (user.dictionaryUnlimited = true назавжди).
 * Активна Premium-підписка теж знімає ліміт.
 *
 * Значення за замовчуванням — 200; змінити без зміни коду можна змінною
 * оточення DICTIONARY_FREE_WORD_LIMIT.
 */
export const DEFAULT_DICTIONARY_FREE_LIMIT = 200;

export function getDictionaryFreeLimit(): number {
  const fromEnv = Number(process.env.DICTIONARY_FREE_WORD_LIMIT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_DICTIONARY_FREE_LIMIT;
}

export const DICTIONARY_LIMIT_REACHED = 'DICTIONARY_LIMIT_REACHED';

export interface DictionaryCapacity {
  limit: number;
  count: number;
  unlimited: boolean;
  /** Скільки ще можна додати (null — без обмеження). */
  remaining: number | null;
  /** Словник заповнено — нові слова не додаються. */
  reached: boolean;
}

export function computeDictionaryCapacity(params: {
  count: number;
  dictionaryUnlimited: boolean;
  premiumExpiresAt?: Date | string | null;
  now?: number;
  limit?: number;
}): DictionaryCapacity {
  const limit = params.limit ?? getDictionaryFreeLimit();
  const now = params.now ?? Date.now();
  const premiumUntil = params.premiumExpiresAt ? new Date(params.premiumExpiresAt).getTime() : NaN;
  const unlimited = !!params.dictionaryUnlimited || (Number.isFinite(premiumUntil) && premiumUntil > now);
  const count = Math.max(0, Number(params.count) || 0);
  if (unlimited) return { limit, count, unlimited: true, remaining: null, reached: false };
  const remaining = Math.max(0, limit - count);
  return { limit, count, unlimited: false, remaining, reached: remaining === 0 };
}

/** 403 з кодом, за яким застосунок показує пропозицію розширити словник. */
export class DictionaryLimitReachedException extends ForbiddenException {
  constructor(capacity: DictionaryCapacity) {
    super({
      statusCode: 403,
      code: DICTIONARY_LIMIT_REACHED,
      message: 'Словник заповнено',
      limit: capacity.limit,
      count: capacity.count,
    });
  }
}

/** Стан словника користувача (у транзакції або поза нею). */
export async function loadDictionaryCapacity(em: EntityManager, userId: number): Promise<DictionaryCapacity> {
  const [userRow] = await em.query(
    'SELECT "dictionaryUnlimited", "premiumExpiresAt" FROM "user" WHERE "id" = $1',
    [userId],
  );
  const [countRow] = await em.query('SELECT COUNT(*)::int AS count FROM "user_word" WHERE "userId" = $1', [userId]);
  return computeDictionaryCapacity({
    count: Number(countRow?.count ?? 0),
    dictionaryUnlimited: !!userRow?.dictionaryUnlimited,
    premiumExpiresAt: userRow?.premiumExpiresAt ?? null,
  });
}

/**
 * Перевірка перед ДОДАВАННЯМ adding нових слів — викликати всередині
 * транзакції, що вставляє записи. Блокування на користувача: два паралельні
 * додавання при 9/10 не дадуть 11/10.
 */
export async function assertDictionaryCapacity(em: EntityManager, userId: number, adding: number): Promise<void> {
  if (adding <= 0) return;
  await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dict_capacity:${userId}`]);
  const capacity = await loadDictionaryCapacity(em, userId);
  if (capacity.unlimited) return;
  if (capacity.count + adding > capacity.limit) {
    throw new DictionaryLimitReachedException({ ...capacity, reached: true });
  }
}
