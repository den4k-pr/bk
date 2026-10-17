import { SearchOrCreateResponse } from '../../../types/words';
import {
  LookupRequest,
} from './translationReducer';

// Кеш відповідей на час сесії: повторний тап по тому ж слову в тому ж
// реченні показує картку МИТТЄВО. Запис живе 2 хв і скидається, коли слово
// додають / видаляють зі словника (інакше isAdded був би застарілим).
// Кеш — лише для миттєвого показу: сервер перепитується на кожен тап
// (див. fetchTranslation). Раніше 2 хв сервер не питали взагалі — слово,
// видалене з бази, далі показувалось зі старого кешу зі старим id.
export const TRANSLATION_CACHE_TTL_MS = 2 * 60 * 1000;
export const TRANSLATION_CACHE_MAX = 200;
export const translationCache = new Map<string, { data: SearchOrCreateResponse; at: number }>();

// Версія формату відповіді: після оновлення сервера (розбір форми v3) старі
// записи кешу з неточним перекладом форми не використовуються.
export const CACHE_SCHEMA_VERSION = 'v3';

export const buildCacheKey = (query: string, lookup: LookupRequest | null): string =>
  [CACHE_SCHEMA_VERSION, query, lookup?.context ?? '', lookup?.fallbackQuery ?? ''].join('|');

export const readCache = (key: string): SearchOrCreateResponse | null => {
  const hit = translationCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TRANSLATION_CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  return hit.data;
};

/**
 * Чи це той самий запис словника з тими самими даними. Якщо так — свіжа
 * відповідь сервера нічого не змінює на екрані (і не перезаписує стан, який
 * користувач міг змінити: «додано» тощо).
 */
export const isSameLookupResult = (a: SearchOrCreateResponse, b: SearchOrCreateResponse): boolean => {
  const pick = (r: any) => {
    const w = r?.word ?? {};
    return JSON.stringify([
      w.id, w.text, w.translation, w.pronunciation, w.partOfSpeech, w.type,
      w.examples ?? null, w.forms ?? null,
      r?.surfaceTranslation ?? null, r?.verbForms ?? null,
    ]);
  };
  return pick(a) === pick(b);
};

export const writeCache = (key: string, data: SearchOrCreateResponse): void => {
  if (translationCache.size >= TRANSLATION_CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
  translationCache.set(key, { data, at: Date.now() });
};

/** Текст помилки для картки: що сталося і чи варто повторити. */
export const describeLookupError = (error: any): string => {
  const status = error?.response?.status;
  if (status === 404) return 'Переклад не знайдено';
  if (status === 429) return 'Забагато запитів — зачекайте кілька секунд';
  if (status === 503) return 'Сервіс перекладу тимчасово перевантажений';
  if (typeof status === 'number' && status >= 500) return 'Помилка сервера — спробуйте ще раз';
  if (error?.code === 'ECONNABORTED') return 'Сервер довго відповідає — спробуйте ще раз';
  if (!error?.response && error?.request) return 'Немає з’єднання з сервером';
  return 'Не вдалося знайти переклад';
};

/** Збій, після якого один тихий повтор має сенс (обрив мережі, шлюз). */
export const isTransientLookupError = (error: any): boolean => {
  const status = error?.response?.status;
  if (status === 502 || status === 504) return true;
  return !error?.response && !!error?.request && error?.code !== 'ECONNABORTED';
};

export const LOOKUP_RETRY_DELAY_MS = 700;

export const invalidateCachedWord = (wordId: number | undefined): void => {
  if (wordId === undefined) return;
  translationCache.forEach((entry, key) => {
    if (entry.data?.word?.id === wordId) translationCache.delete(key);
  });
};
