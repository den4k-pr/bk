import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../../services/api';
import {
  CACHE_TTL,
  invalidateCache,
  peekCache,
  runCachedRequest,
  writeCache,
} from '../../../services/requestCache';
import { Image } from 'react-native';
import {
  BackBookMeta,
  HARD_TIMEOUT_GRACE_MS,
  ReaderChapterContent,
  createTimeoutController,
  getErrorMessage,
  isAbortError,
  isValidId,
  withHardTimeout,
} from './bookManager.shared';

export const CHAPTER_CONTENT_CACHE_LIMIT = 24;
export const REQUEST_TIMEOUT_MS = 15000;
export const BOOKMARKS_REFETCH_DEBOUNCE_MS = 400;

export const BOOKS_LIST_KEY = 'books:list';
export const BOOKMARKS_KEY = 'books:bookmarks';
export const bookDetailsKey = (bookId: number) => `books:details:${bookId}`;
export const bookVersionKey = (bookId: number) => `books:version:${bookId}`;
export const highlightsKey = (bookId: number) => `books:highlights:${bookId}`;
export const pageDetailsKey = (pageId: number) => `books:page:${pageId}`;
export const chapterContentKey = (chapterId: number) => `books:chapter:${chapterId}`;

export const chapterLruOrder: number[] = [];
export const chapterLoadingSet = new Set<number>();
export const chapterContentListeners = new Set<() => void>();
export const chapterListenersByChapter = new Map<number, Set<() => void>>();

export interface InFlightEntry<T> {
  promise: Promise<T>;
  startedAt: number;
}

export const IN_FLIGHT_STALE_MS = REQUEST_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS + 5000;

export const bookDetailsFetchInFlight = new Map<number, InFlightEntry<BackBookMeta | undefined>>();
export const chapterFetchInFlight = new Map<number, InFlightEntry<ReaderChapterContent | undefined>>();

export const CHAPTER_DISK_CACHE_PREFIX = '@book_chapter_content_';
export const chapterDiskCacheKey = (chapterId: number) => `${CHAPTER_DISK_CACHE_PREFIX}${chapterId}`;
export const diskHydrationAttempted = new Set<number>();

export async function persistChapterContentToDisk(content: ReaderChapterContent): Promise<void> {
  try {
    await AsyncStorage.setItem(chapterDiskCacheKey(content.chapterId), JSON.stringify(content));
  } catch (error) {
    return;
  }
}

export async function hydrateChapterContentFromDisk(chapterId: number): Promise<ReaderChapterContent | undefined> {
  if (diskHydrationAttempted.has(chapterId)) return undefined;
  diskHydrationAttempted.add(chapterId);

  try {
    const raw = await AsyncStorage.getItem(chapterDiskCacheKey(chapterId));
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as ReaderChapterContent;
    if (parsed && isValidId(parsed.chapterId)) {
      return parsed;
    }
    return undefined;
  } catch (error) {
    return undefined;
  }
}

export async function removeChapterContentFromDisk(chapterId: number): Promise<void> {
  try {
    await AsyncStorage.removeItem(chapterDiskCacheKey(chapterId));
  } catch (error) {
    return;
  }
}

export function notifyChapterListeners(): void {
  chapterContentListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      return;
    }
  });
}

export function bumpChapterVersion(chapterId: number): void {
  const listeners = chapterListenersByChapter.get(chapterId);
  if (listeners) {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        return;
      }
    });
  }
}

export function useChapterContentVersionsForIds(chapterIds: number[]): number {
  const [tick, setTick] = useState(0);
  const idsKey = chapterIds.join(',');

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',').map(Number).filter(isValidId) : [];
    const listener = () => setTick((v) => v + 1);

    ids.forEach((id) => {
      let set = chapterListenersByChapter.get(id);
      if (!set) {
        set = new Set();
        chapterListenersByChapter.set(id, set);
      }
      set.add(listener);
    });

    return () => {
      ids.forEach((id) => {
        const set = chapterListenersByChapter.get(id);
        if (set) {
          set.delete(listener);
          if (set.size === 0) {
            chapterListenersByChapter.delete(id);
          }
        }
      });
    };
  }, [idsKey]);

  return tick;
}

export function touchChapterLru(chapterId: number): void {
  const idx = chapterLruOrder.indexOf(chapterId);
  if (idx !== -1) chapterLruOrder.splice(idx, 1);
  chapterLruOrder.push(chapterId);

  while (chapterLruOrder.length > CHAPTER_CONTENT_CACHE_LIMIT) {
    const evicted = chapterLruOrder.shift();
    if (evicted !== undefined) {
      invalidateCache(chapterContentKey(evicted));
    }
  }
}

export function storeChapterContent(content: ReaderChapterContent): void {
  if (!content || !isValidId(content.chapterId)) return;
  writeCache(chapterContentKey(content.chapterId), content, true);
  touchChapterLru(content.chapterId);
  if (content.imageUrl) {
    Image.prefetch(content.imageUrl).catch(() => {});
  }
  persistChapterContentToDisk(content).catch(() => {});
  bumpChapterVersion(content.chapterId);
}

export function dropChaptersOfBook(book: BackBookMeta): void {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  chapters.forEach((chapter) => {
    if (isValidId(chapter?.id)) {
      invalidateCache(chapterContentKey(chapter.id));
      const idx = chapterLruOrder.indexOf(chapter.id);
      if (idx !== -1) chapterLruOrder.splice(idx, 1);
      removeChapterContentFromDisk(chapter.id).catch(() => {});
      diskHydrationAttempted.delete(chapter.id);
      bumpChapterVersion(chapter.id);
    }
  });
}

export async function fetchAndCacheChapterContent(
  chapterId: number,
  force: boolean
): Promise<ReaderChapterContent | undefined> {
  const key = chapterContentKey(chapterId);

  if (!force) {
    const cached = peekCache<ReaderChapterContent>(key);
    if (cached) {
      touchChapterLru(chapterId);
      return cached;
    }
  }

  const existingEntry = chapterFetchInFlight.get(chapterId);
  if (existingEntry && !force) {
    const age = Date.now() - existingEntry.startedAt;
    if (age < IN_FLIGHT_STALE_MS) {
      return existingEntry.promise;
    }
    chapterFetchInFlight.delete(chapterId);
  }

  chapterLoadingSet.add(chapterId);
  notifyChapterListeners();
  bumpChapterVersion(chapterId);

  const { controller, clear } = createTimeoutController(REQUEST_TIMEOUT_MS);

  const request = (async (): Promise<ReaderChapterContent | undefined> => {
    try {
      const content = await withHardTimeout(
        runCachedRequest<ReaderChapterContent>(
          key,
          CACHE_TTL.CHAPTER_CONTENT,
          async () => {
            const response = await api.get<ReaderChapterContent>(
              `/books/chapter/${chapterId}/content`,
              { signal: controller.signal }
            );
            return response.data;
          },
          force
        ),
        REQUEST_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS
      );

      if (content) {
        touchChapterLru(chapterId);
        if (content.imageUrl) {
          Image.prefetch(content.imageUrl).catch(() => {});
        }
        persistChapterContentToDisk(content).catch(() => {});
      }
      return content;
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        console.error(
          'Помилка завантаження контенту розділу:',
          getErrorMessage(err, 'Невідома помилка')
        );
      }
      return undefined;
    } finally {
      clear();
      chapterFetchInFlight.delete(chapterId);
      chapterLoadingSet.delete(chapterId);
      notifyChapterListeners();
      bumpChapterVersion(chapterId);
    }
  })();

  chapterFetchInFlight.set(chapterId, { promise: request, startedAt: Date.now() });
  return request;
}
