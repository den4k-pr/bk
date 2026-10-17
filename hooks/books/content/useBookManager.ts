import { useState, useCallback, useRef, useEffect } from 'react';
import api from '../../../services/api';
import {
  BackPage,
  BackBookmark,
  BackHighlight,
} from '../../../types/books';
import {
  CACHE_TTL,
  invalidateCache,
  invalidateCacheWhere,
  isCacheFresh,
  peekCache,
  runCachedRequest,
  subscribeToCache,
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
  isNotFoundError,
  isValidId,
  sortBookmarks,
  withHardTimeout,
} from './bookManager.shared';
import {
  BOOKMARKS_KEY,
  BOOKMARKS_REFETCH_DEBOUNCE_MS,
  BOOKS_LIST_KEY,
  IN_FLIGHT_STALE_MS,
  REQUEST_TIMEOUT_MS,
  bookDetailsFetchInFlight,
  bookDetailsKey,
  bookVersionKey,
  bumpChapterVersion,
  chapterContentKey,
  chapterContentListeners,
  chapterLoadingSet,
  dropChaptersOfBook,
  fetchAndCacheChapterContent,
  highlightsKey,
  hydrateChapterContentFromDisk,
  notifyChapterListeners,
  pageDetailsKey,
  storeChapterContent,
  touchChapterLru,
} from './chapterContentCache';
export { useChapterContentVersionsForIds } from './chapterContentCache';
export type { BackBookMeta, BackChapterMeta, ReaderChapterContent } from './bookManager.shared';

export interface UseBookManagerReturn {
  isLoading: boolean;
  error: string | null;
  bookNotFound: boolean;
  books: BackBookMeta[];
  currentBook: BackBookMeta | null;
  currentPageData: BackPage | null;
  myBookmarks: BackBookmark[];
  pageHighlights: BackHighlight[];
  fetchAllBooks: () => Promise<void>;
  fetchBookDetails: (bookId: number) => Promise<BackBookMeta | undefined>;
  fetchPageDetails: (pageId: number) => Promise<BackPage | undefined>;
  getChapterContent: (chapterId: number) => ReaderChapterContent | undefined;
  isChapterLoading: (chapterId: number) => boolean;
  ensureChapterContent: (chapterId: number, force?: boolean) => Promise<ReaderChapterContent | undefined>;
  prefetchChapters: (chapterIds: number[]) => void;
  chapterContentVersion: number;
  fetchMyBookmarks: () => Promise<void>;
  toggleBookmark: (pageId: number, color: string) => Promise<void>;
  setBookmark: (pageId: number, color: string) => Promise<void>;
  removeBookmark: (pageId: number) => Promise<void>;
  fetchHighlightsForPage: (pageId: number) => Promise<BackHighlight[] | undefined>;
  fetchAllHighlightsForBook: (bookId: number) => Promise<BackHighlight[]>;
  addHighlight: (
    pageId: number,
    word: string,
    color: string,
    startIndex: number,
    endIndex: number
  ) => Promise<BackHighlight | undefined>;
  removeHighlight: (
    pageId: number,
    startIndex: number,
    endIndex: number
  ) => Promise<boolean>;
}

export const useBookManager = (): UseBookManagerReturn => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [bookNotFound, setBookNotFound] = useState<boolean>(false);

  const [books, setBooks] = useState<BackBookMeta[]>(
    () => peekCache<BackBookMeta[]>(BOOKS_LIST_KEY) ?? []
  );
  const [currentBook, setCurrentBook] = useState<BackBookMeta | null>(null);
  const [currentPageData, setCurrentPageData] = useState<BackPage | null>(null);
  const [myBookmarks, setMyBookmarks] = useState<BackBookmark[]>(
    () => peekCache<BackBookmark[]>(BOOKMARKS_KEY) ?? []
  );
  const [pageHighlights, setPageHighlights] = useState<BackHighlight[]>([]);

  const [chapterContentVersion, setChapterContentVersion] = useState(0);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const listener = () => {
      if (isMountedRef.current) {
        setChapterContentVersion((v) => v + 1);
      }
    };
    chapterContentListeners.add(listener);
    return () => {
      chapterContentListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    return subscribeToCache(() => {
      if (!isMountedRef.current) return;

      const cachedBooks = peekCache<BackBookMeta[]>(BOOKS_LIST_KEY);
      if (cachedBooks) {
        setBooks((prev) => (prev === cachedBooks ? prev : cachedBooks));
      }

      const cachedBookmarks = peekCache<BackBookmark[]>(BOOKMARKS_KEY);
      if (cachedBookmarks) {
        setMyBookmarks((prev) => (prev === cachedBookmarks ? prev : cachedBookmarks));
      }
    });
  }, []);

  const currentBookIdRef = useRef<number | null>(null);
  const bookmarksRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (bookmarksRefetchTimerRef.current) {
        clearTimeout(bookmarksRefetchTimerRef.current);
        bookmarksRefetchTimerRef.current = null;
      }
    };
  }, []);

  const getChapterContent = useCallback((chapterId: number): ReaderChapterContent | undefined => {
    if (!isValidId(chapterId)) return undefined;
    return peekCache<ReaderChapterContent>(chapterContentKey(chapterId));
  }, []);

  const isChapterLoading = useCallback((chapterId: number): boolean => {
    return chapterLoadingSet.has(chapterId);
  }, []);

  const ensureChapterContent = useCallback(
    async (chapterId: number, force: boolean = false): Promise<ReaderChapterContent | undefined> => {
      if (!isValidId(chapterId)) return undefined;

      const key = chapterContentKey(chapterId);
      const cached = peekCache<ReaderChapterContent>(key);

      if (cached && !force) {
        touchChapterLru(chapterId);
        return cached;
      }

      if (!force) {
        const diskCached = await hydrateChapterContentFromDisk(chapterId);
        if (diskCached) {
          writeCache(key, diskCached, true);
          touchChapterLru(chapterId);
          bumpChapterVersion(chapterId);
          if (diskCached.imageUrl) {
            Image.prefetch(diskCached.imageUrl).catch(() => {});
          }
          fetchAndCacheChapterContent(chapterId, true).catch(() => {});
          return diskCached;
        }
      }

      return fetchAndCacheChapterContent(chapterId, force);
    },
    []
  );

  const prefetchChapters = useCallback((chapterIds: number[]): void => {
    const missing = chapterIds.filter(
      (id) =>
        isValidId(id) &&
        !isCacheFresh(chapterContentKey(id), CACHE_TTL.CHAPTER_CONTENT) &&
        !chapterLoadingSet.has(id)
    );

    if (missing.length === 0) return;

    missing.forEach((id) => {
      chapterLoadingSet.add(id);
      bumpChapterVersion(id);
    });
    notifyChapterListeners();

    const { controller, clear } = createTimeoutController(REQUEST_TIMEOUT_MS);

    (async () => {
      try {
        const response = await api.get<ReaderChapterContent[]>('/books/chapters/content', {
          params: { ids: missing.join(',') },
          signal: controller.signal,
        });
        const list = Array.isArray(response.data) ? response.data : [];
        list.forEach(storeChapterContent);
      } catch (err: unknown) {
        if (!isAbortError(err)) {
          console.log('Префетч розділів не вдався (не критично):', getErrorMessage(err, ''));
        }
      } finally {
        clear();
        missing.forEach((id) => {
          chapterLoadingSet.delete(id);
          bumpChapterVersion(id);
        });
        notifyChapterListeners();
      }
    })();
  }, []);

  const fetchAllBooks = useCallback(async (): Promise<void> => {
    const cached = peekCache<BackBookMeta[]>(BOOKS_LIST_KEY);
    if (cached && isMountedRef.current) {
      setBooks(cached);
    }

    if (isCacheFresh(BOOKS_LIST_KEY, CACHE_TTL.BOOKS_LIST)) {
      if (isMountedRef.current) setIsLoading(false);
      return;
    }

    if (isMountedRef.current) {
      setIsLoading(!cached);
      setError(null);
    }

    const { controller, clear } = createTimeoutController(REQUEST_TIMEOUT_MS);

    try {
      const data = await runCachedRequest<BackBookMeta[]>(
        BOOKS_LIST_KEY,
        CACHE_TTL.BOOKS_LIST,
        async () => {
          const response = await api.get<BackBookMeta[]>('/books', { signal: controller.signal });
          return Array.isArray(response.data) ? response.data : [];
        }
      );
      if (isMountedRef.current) {
        setBooks(data);
      }
    } catch (err: unknown) {
      if (isAbortError(err)) return;
      if (isMountedRef.current) {
        setError(getErrorMessage(err, 'Не вдалося завантажити книги'));
      }
    } finally {
      clear();
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const fetchBookDetails = useCallback(
    async (bookId: number): Promise<BackBookMeta | undefined> => {
      if (!isValidId(bookId)) {
        if (isMountedRef.current) setError('Некоректний ідентифікатор книги');
        return undefined;
      }

      currentBookIdRef.current = bookId;

      const key = bookDetailsKey(bookId);
      const cached = peekCache<BackBookMeta>(key);

      if (cached && isMountedRef.current) {
        setCurrentBook(cached);
        setBookNotFound(false);
        setError(null);
      }

      if (isCacheFresh(key, CACHE_TTL.BOOK_DETAILS)) {
        if (isMountedRef.current) setIsLoading(false);
        return cached;
      }

      const existingEntry = bookDetailsFetchInFlight.get(bookId);
      if (existingEntry) {
        const age = Date.now() - existingEntry.startedAt;
        if (age < IN_FLIGHT_STALE_MS) {
          if (isMountedRef.current) setIsLoading(!cached);
          const result = await existingEntry.promise;
          if (isMountedRef.current && currentBookIdRef.current === bookId) {
            setCurrentBook(result ?? null);
          }
          if (isMountedRef.current) setIsLoading(false);
          return result;
        }
        bookDetailsFetchInFlight.delete(bookId);
      }

      if (isMountedRef.current) {
        setIsLoading(!cached);
        setError(null);
        setBookNotFound(false);
      }

      const { controller, clear } = createTimeoutController(REQUEST_TIMEOUT_MS);

      const request = (async (): Promise<BackBookMeta | undefined> => {
        try {
          const data = await withHardTimeout(
            runCachedRequest<BackBookMeta>(
              key,
              CACHE_TTL.BOOK_DETAILS,
              async () => {
                const response = await api.get<BackBookMeta>(`/books/${bookId}`, {
                  signal: controller.signal,
                });
                return response.data;
              }
            ),
            REQUEST_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS
          );

          if (data) {
            const previousVersion = peekCache<number>(bookVersionKey(bookId));
            if (previousVersion !== undefined && previousVersion !== data.contentVersion) {
              dropChaptersOfBook(data);
              notifyChapterListeners();
            }
            writeCache(bookVersionKey(bookId), data.contentVersion, true);
          }

          if (isMountedRef.current && currentBookIdRef.current === bookId) {
            setCurrentBook(data ?? null);
          }
          return data;
        } catch (err: unknown) {
          if (isAbortError(err)) return undefined;

          if (isNotFoundError(err)) {
            if (isMountedRef.current) {
              setError(getErrorMessage(err, 'Помилка завантаження деталей книги'));
              setBookNotFound(true);
              setCurrentBook(null);
            }
            return undefined;
          }

          if (isMountedRef.current) {
            setError(getErrorMessage(err, 'Помилка завантаження деталей книги'));
          }
          return undefined;
        } finally {
          clear();
          bookDetailsFetchInFlight.delete(bookId);
        }
      })();

      bookDetailsFetchInFlight.set(bookId, { promise: request, startedAt: Date.now() });
      const result = await request;

      if (isMountedRef.current) {
        setIsLoading(false);
      }

      return result;
    },
    []
  );

  const fetchPageDetails = useCallback(async (pageId: number): Promise<BackPage | undefined> => {
    if (!isValidId(pageId)) return undefined;

    const key = pageDetailsKey(pageId);
    const cached = peekCache<BackPage>(key);

    if (cached) {
      if (isMountedRef.current) setCurrentPageData(cached);
      if (isCacheFresh(key, CACHE_TTL.PAGE_DETAILS)) {
        return cached;
      }
    }

    const { controller, clear } = createTimeoutController(REQUEST_TIMEOUT_MS);

    try {
      const data = await withHardTimeout(
        runCachedRequest<BackPage>(key, CACHE_TTL.PAGE_DETAILS, async () => {
          const response = await api.get<BackPage>(`/books/page/${pageId}`, {
            signal: controller.signal,
          });
          return response.data;
        }),
        REQUEST_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS
      );

      if (isMountedRef.current) {
        setCurrentPageData(data ?? null);
      }
      return data;
    } catch (err: unknown) {
      if (isAbortError(err)) return undefined;
      if (isMountedRef.current) {
        setError(getErrorMessage(err, 'Помилка завантаження сторінки'));
      }
      return undefined;
    } finally {
      clear();
    }
  }, []);

  const fetchMyBookmarks = useCallback(async (): Promise<void> => {
    const cached = peekCache<BackBookmark[]>(BOOKMARKS_KEY);
    if (cached && isMountedRef.current) {
      setMyBookmarks(cached);
    }

    if (isCacheFresh(BOOKMARKS_KEY, CACHE_TTL.BOOKMARKS)) {
      return;
    }

    try {
      const data = await runCachedRequest<BackBookmark[]>(
        BOOKMARKS_KEY,
        CACHE_TTL.BOOKMARKS,
        async () => {
          const response = await api.get<BackBookmark[]>('/books/me/bookmarks');
          return sortBookmarks(response.data);
        }
      );
      if (isMountedRef.current) {
        setMyBookmarks(data);
      }
    } catch (err: unknown) {
      console.error('Помилка завантаження закладок:', getErrorMessage(err, 'Невідома помилка'));
    }
  }, []);

  const toggleBookmark = useCallback(
    async (pageId: number, color: string): Promise<void> => {
      if (!isValidId(pageId)) return;
      try {
        await api.post('/books/bookmarks', { pageId, color });

        invalidateCache(BOOKMARKS_KEY);

        // Оптимістично оновлюємо стан одразу, не чекаючи refetch: закладка тепер
        // прив'язана до СТОРІНКИ, тож якщо сторінка вже має закладку — це
        // toggle-off (видалення). Інакше при швидкому перевідкритті меню видалена
        // закладка «поверталась».
        setMyBookmarks((prev) => {
          const existing = prev.find((b) => b?.page?.id === pageId);
          if (existing) {
            return prev.filter((b) => b?.page?.id !== pageId);
          }
          return prev;
        });

        if (bookmarksRefetchTimerRef.current) {
          clearTimeout(bookmarksRefetchTimerRef.current);
        }
        bookmarksRefetchTimerRef.current = setTimeout(() => {
          bookmarksRefetchTimerRef.current = null;
          runCachedRequest<BackBookmark[]>(
            BOOKMARKS_KEY,
            CACHE_TTL.BOOKMARKS,
            async () => {
              const response = await api.get<BackBookmark[]>('/books/me/bookmarks');
              return sortBookmarks(response.data);
            },
            true
          )
            .then((data) => {
              if (isMountedRef.current) {
                setMyBookmarks(data);
              }
            })
            .catch((err: unknown) => {
              console.error('Помилка оновлення списку закладок:', getErrorMessage(err, 'Невідома помилка'));
            });
        }, BOOKMARKS_REFETCH_DEBOUNCE_MS);
      } catch (err: unknown) {
        console.error('Помилка збереження закладки:', getErrorMessage(err, 'Невідома помилка'));
      }
    },
    []
  );

  // Список закладок з сервера — після будь-якої зміни (з невеликою затримкою,
  // щоб кілька швидких дій дали один запит).
  const scheduleBookmarksRefetch = useCallback((): void => {
    if (bookmarksRefetchTimerRef.current) {
      clearTimeout(bookmarksRefetchTimerRef.current);
    }
    bookmarksRefetchTimerRef.current = setTimeout(() => {
      bookmarksRefetchTimerRef.current = null;
      runCachedRequest<BackBookmark[]>(
        BOOKMARKS_KEY,
        CACHE_TTL.BOOKMARKS,
        async () => {
          const response = await api.get<BackBookmark[]>('/books/me/bookmarks');
          return sortBookmarks(response.data);
        },
        true
      )
        .then((data) => {
          if (isMountedRef.current) {
            setMyBookmarks(data);
          }
        })
        .catch((err: unknown) => {
          console.error('Помилка оновлення списку закладок:', getErrorMessage(err, 'Невідома помилка'));
        });
    }, BOOKMARKS_REFETCH_DEBOUNCE_MS);
  }, []);

  /**
   * Явні дії замість перемикача: «поставити» ніколи не знімає закладку, а
   * «прибрати» ніколи не створює. Раніше обидві йшли через toggle — при
   * подвійному тапі чи застарілому списку видалена закладка поверталась.
   */
  const setBookmark = useCallback(
    async (pageId: number, color: string): Promise<void> => {
      if (!isValidId(pageId)) return;
      try {
        await api.put('/books/bookmarks', { pageId, color });
        invalidateCache(BOOKMARKS_KEY);
        scheduleBookmarksRefetch();
      } catch (err: unknown) {
        console.error('Помилка збереження закладки:', getErrorMessage(err, 'Невідома помилка'));
      }
    },
    [scheduleBookmarksRefetch]
  );

  const removeBookmark = useCallback(
    async (pageId: number): Promise<void> => {
      if (!isValidId(pageId)) return;
      // Одразу прибираємо з екрана — і всі записи цієї сторінки.
      setMyBookmarks((prev) => prev.filter((b) => b?.page?.id !== pageId));
      try {
        await api.delete(`/books/bookmarks/${pageId}`);
      } catch (err: unknown) {
        console.error('Помилка видалення закладки:', getErrorMessage(err, 'Невідома помилка'));
      } finally {
        invalidateCache(BOOKMARKS_KEY);
        scheduleBookmarksRefetch();
      }
    },
    [scheduleBookmarksRefetch]
  );

  const fetchHighlightsForPage = useCallback(
    async (pageId: number): Promise<BackHighlight[] | undefined> => {
      if (!isValidId(pageId)) return undefined;
      try {
        const response = await api.get<BackHighlight[]>(`/books/page/${pageId}/highlights`);
        const data = Array.isArray(response.data) ? response.data : [];
        if (isMountedRef.current) {
          setPageHighlights(data);
        }
        return data;
      } catch (err: unknown) {
        console.error('Помилка завантаження хайлайтів:', getErrorMessage(err, 'Невідома помилка'));
        return undefined;
      }
    },
    []
  );

  const fetchAllHighlightsForBook = useCallback(
    async (bookId: number): Promise<BackHighlight[]> => {
      if (!isValidId(bookId)) return [];

      const key = highlightsKey(bookId);

      try {
        const data = await runCachedRequest<BackHighlight[]>(
          key,
          CACHE_TTL.HIGHLIGHTS,
          async () => {
            const response = await api.get<BackHighlight[]>(`/books/${bookId}/highlights`);
            return Array.isArray(response.data) ? response.data : [];
          }
        );
        return data;
      } catch (err: unknown) {
        console.error(
          'Помилка завантаження всіх хайлайтів:',
          getErrorMessage(err, 'Невідома помилка')
        );
        return peekCache<BackHighlight[]>(key) ?? [];
      }
    },
    []
  );

  const addHighlight = useCallback(
    async (
      pageId: number,
      word: string,
      color: string,
      startIndex: number,
      endIndex: number
    ): Promise<BackHighlight | undefined> => {
      if (!isValidId(pageId) || !Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
        return undefined;
      }
      try {
        const response = await api.post<BackHighlight>('/books/highlights', {
          pageId,
          word,
          color,
          startIndex,
          endIndex,
        });

        invalidateCacheWhere((key) => key.startsWith('books:highlights:'));

        return response.data;
      } catch (err: unknown) {
        console.error('Помилка збереження хайлайту:', getErrorMessage(err, 'Невідома помилка'));
        return undefined;
      }
    },
    []
  );

  const removeHighlight = useCallback(
    async (pageId: number, startIndex: number, endIndex: number): Promise<boolean> => {
      if (!isValidId(pageId) || !Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
        return false;
      }
      try {
        await api.post('/books/highlights/delete', {
          pageId,
          startIndex,
          endIndex,
        });
        invalidateCacheWhere((key) => key.startsWith('books:highlights:'));
        return true;
      } catch (err: unknown) {
        console.error('Помилка видалення хайлайту:', getErrorMessage(err, 'Невідома помилка'));
        return false;
      }
    },
    []
  );

  return {
    isLoading,
    error,
    bookNotFound,
    books,
    currentBook,
    currentPageData,
    myBookmarks,
    pageHighlights,
    fetchAllBooks,
    fetchBookDetails,
    fetchPageDetails,
    getChapterContent,
    isChapterLoading,
    ensureChapterContent,
    prefetchChapters,
    chapterContentVersion,
    fetchMyBookmarks,
    toggleBookmark,
    setBookmark,
    removeBookmark,
    fetchHighlightsForPage,
    fetchAllHighlightsForBook,
    addHighlight,
    removeHighlight,
  };
};