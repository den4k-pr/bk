import { useReducer, useCallback, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useIsFocused } from '@react-navigation/native';
import { RootState } from '../../../store';
import { UserWord } from '../../types/words';
import { fetchPaginatedDictionaryWords } from '../../services/dictionaryApi';
import { setWords, appendWords, setPage } from '../../features/wordSlice';
import { sanitizeSearchQuery } from '../../utils/sanitizeSearchQuery';
import {
  readThroughCacheWithSource,
  writeThroughCache,
  invalidateDictionaryListCache,
} from '../../services/dictionaryCache';
import {
  getDictionaryDataVersion,
  subscribeDictionaryWordsMutated,
} from '../../services/dictionaryMutationBus';

const PAGE_SIZE = 10;
const DEBOUNCE_TIME = 400;
const MAX_CONSECUTIVE_EMPTY_PAGES = 2;
const MIN_MS_BETWEEN_REQUESTS = 350;
const MAX_PAGES_PER_SESSION = 500;
const LIST_MEMORY_TTL_MS = 20000;
const LIST_PERSIST_TTL_MS = 180000;
// Кілька змін поспіль (швидке додавання слів) — одне перечитування.
const MUTATION_REFETCH_DEBOUNCE_MS = 300;

interface PaginationState {
  status: 'idle' | 'loading' | 'paginating' | 'error';
  hasMore: boolean;
  circuitBroken: boolean;
}

const initialState: PaginationState = {
  status: 'idle',
  hasMore: true,
  circuitBroken: false,
};

type PaginationAction =
  | { type: 'FETCH_START' }
  | { type: 'PAGINATE_START' }
  | { type: 'FETCH_SUCCESS'; hasMore: boolean }
  | { type: 'ERROR' }
  | { type: 'CIRCUIT_BREAK' }
  | { type: 'RESET' };

function paginationReducer(state: PaginationState, action: PaginationAction): PaginationState {
  switch (action.type) {
    case 'FETCH_START':
      return { status: 'loading', hasMore: true, circuitBroken: false };
    case 'PAGINATE_START':
      return { ...state, status: 'paginating' };
    case 'FETCH_SUCCESS':
      return {
        status: 'idle',
        hasMore: state.circuitBroken ? false : action.hasMore,
        circuitBroken: state.circuitBroken,
      };
    case 'ERROR':
      return { status: 'error', hasMore: false, circuitBroken: state.circuitBroken };
    case 'CIRCUIT_BREAK':
      return { status: 'idle', hasMore: false, circuitBroken: true };
    case 'RESET':
      return { ...initialState };
    default:
      return state;
  }
}

interface FetchParams {
  page: number;
  isReset: boolean;
  userLevel: string | null | undefined;
  filterStatus: 'all' | 'new' | 'learning' | 'learned';
  searchQuery: string;
  wordType: 'all' | 'word' | 'phrase' | 'phrasal_verb';
  /** Номер автоповтору після тимчасової помилки (немає мережі / 5xx). */
  retryAttempt?: number;
}

// 502/503 під час деплою сервера чи коротке зникнення мережі — тимчасово:
// повторюємо самі, а не лишаємо порожній список з помилкою.
const TRANSIENT_RETRY_DELAYS_MS = [2000, 4000];

const isTransientError = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return typeof status !== 'number' || status >= 500;
};

const isAbortError = (error: unknown): boolean => {
  const err = error as { name?: string; code?: string } | null;
  return err?.name === 'AbortError' || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
};

const isRateLimitError = (error: unknown): boolean => {
  const err = error as { response?: { status?: number }; status?: number } | null;
  return err?.response?.status === 429 || err?.status === 429;
};

function buildListCacheKey(params: {
  page: number;
  level: string | null | undefined;
  status: string;
  type: string;
  searchQuery: string;
}): string {
  const normalizedLevel = params.level && params.level !== 'Всі' ? params.level : 'all';
  const normalizedQuery = params.searchQuery.trim().toLowerCase();
  return `dictionary:list:${params.page}:${normalizedLevel}:${params.status}:${params.type}:${normalizedQuery}`;
}

export const useWordPagination = () => {
  const [state, dispatchState] = useReducer(paginationReducer, initialState);
  const reduxDispatch = useDispatch();

  const isFocused = useIsFocused();
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const pendingRefetchRef = useRef(false);

  const words = useSelector((s: RootState) => s.words.words);

  // Рівні слів зі Словника (кнопка біля зірочки): 'Всі' або 'A1,B2'.
  const userLevel = useSelector((s: RootState) => s.words.level);

  const filterStatus = useSelector((s: RootState) => s.words.status);
  const rawSearchQuery = useSelector((s: RootState) => s.words.searchQuery);
  const wordType = useSelector((s: RootState) => s.words.type);
  const refreshTrigger = useSelector((s: RootState) => s.words.refreshTrigger);

  const searchQuery = sanitizeSearchQuery(rawSearchQuery).value;

  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isPaginatingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtersRef = useRef<{
    userLevel: string | null | undefined;
    filterStatus: 'all' | 'new' | 'learning' | 'learned';
    searchQuery: string;
    wordType: 'all' | 'word' | 'phrase' | 'phrasal_verb';
  }>({ userLevel, filterStatus, searchQuery, wordType });

  filtersRef.current = { userLevel, filterStatus, searchQuery, wordType };

  const wordsRef = useRef(words);
  wordsRef.current = words;

  const hasMoreRef = useRef(state.hasMore);
  hasMoreRef.current = state.hasMore;

  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const circuitBrokenRef = useRef(false);
  const consecutiveEmptyPagesRef = useRef(0);
  const lastRequestAtRef = useRef(0);
  const pagesRequestedRef = useRef(0);

  const executeFetchRef = useRef<(params: FetchParams) => Promise<void>>(async () => {});
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeFetch = useCallback(
    async (params: FetchParams) => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const { page: pageToLoad, isReset } = params;

      if (!isReset && circuitBrokenRef.current) {
        console.warn('[useWordPagination] Circuit broken — pagination request blocked.');
        return;
      }

      const now = Date.now();
      if (!isReset && now - lastRequestAtRef.current < MIN_MS_BETWEEN_REQUESTS) {
        console.warn('[useWordPagination] Request throttled — too soon after previous request.');
        return;
      }

      if (!isReset && pagesRequestedRef.current >= MAX_PAGES_PER_SESSION) {
        console.error('[useWordPagination] MAX_PAGES_PER_SESSION reached — forcing circuit break.');
        circuitBrokenRef.current = true;
        dispatchState({ type: 'CIRCUIT_BREAK' });
        return;
      }

      lastRequestAtRef.current = now;
      if (!isReset) {
        pagesRequestedRef.current += 1;
      } else {
        pagesRequestedRef.current = 0;
      }

      requestIdRef.current += 1;
      const currentRequestId = requestIdRef.current;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      dispatchState(isReset || pageToLoad === 1 ? { type: 'FETCH_START' } : { type: 'PAGINATE_START' });
      if (isReset) {
        circuitBrokenRef.current = false;
        consecutiveEmptyPagesRef.current = 0;
      }

      // Дані Словника змінились під час запиту — його відповідь застаріла.
      const startDataVersion = getDictionaryDataVersion();

      try {
        const { userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt } = params;

        const level = lvl && lvl !== 'Всі' ? lvl : undefined;
        const status = st === 'all' ? undefined : st;
        const query = q && q.trim() ? q.trim() : undefined;
        const type = wt === 'all' ? undefined : wt;

        const fetchedWords = await fetchPaginatedDictionaryWords({
          page: pageToLoad,
          level,
          status,
          searchQuery: query,
          type,
          signal: controller.signal,
        });

        if (requestIdRef.current !== currentRequestId) {
          return;
        }

        // Запит пішов до додавання/видалення слова, а відповів після: не
        // затираємо ним список і не кешуємо (інакше щойно додане слово
        // "зникало"). Свіже перечитування вже заплановане підпискою нижче.
        if (getDictionaryDataVersion() !== startDataVersion) {
          return;
        }

        const existingIds = new Set(wordsRef.current.map(w => w.id));
        const newUniqueWords = isReset ? fetchedWords : fetchedWords.filter(w => !existingIds.has(w.id));
        const newUniqueCount = newUniqueWords.length;

        if (isReset || pageToLoad === 1) {
          reduxDispatch(setWords(fetchedWords));

          const cacheKey = buildListCacheKey({ page: 1, level: lvl, status: st, type: wt, searchQuery: q });
          await writeThroughCache(cacheKey, fetchedWords, LIST_MEMORY_TTL_MS, LIST_PERSIST_TTL_MS);
        } else {
          reduxDispatch(appendWords(fetchedWords));
        }

        reduxDispatch(setPage(pageToLoad));

        if (!isReset) {
          if (fetchedWords.length === 0 || newUniqueCount === 0) {
            consecutiveEmptyPagesRef.current += 1;
          } else {
            consecutiveEmptyPagesRef.current = 0;
          }
        } else {
          consecutiveEmptyPagesRef.current = 0;
        }

        if (consecutiveEmptyPagesRef.current >= MAX_CONSECUTIVE_EMPTY_PAGES) {
          console.error('[useWordPagination] Detected repeated empty/duplicate pages — breaking pagination circuit.');
          circuitBrokenRef.current = true;
          dispatchState({ type: 'CIRCUIT_BREAK' });
          return;
        }

        dispatchState({
          type: 'FETCH_SUCCESS',
          hasMore: fetchedWords.length >= PAGE_SIZE && (isReset || newUniqueCount > 0),
        });
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        if (requestIdRef.current !== currentRequestId) return;

        if (isRateLimitError(error)) {
          console.error('[useWordPagination] Received 429 Too Many Requests — breaking pagination circuit.');
          circuitBrokenRef.current = true;
          dispatchState({ type: 'CIRCUIT_BREAK' });
          return;
        }

        const attempt = params.retryAttempt ?? 0;
        if (isTransientError(error) && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          // warn, а не error: у dev-збірці console.error відкриває червоний LogBox.
          console.warn(`[useWordPagination] Тимчасова помилка, повтор ${attempt + 1}:`, (error as Error)?.message);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (requestIdRef.current !== currentRequestId) return; // уже інший запит
            executeFetchRef.current({ ...params, retryAttempt: attempt + 1 });
          }, TRANSIENT_RETRY_DELAYS_MS[attempt]);
          return;
        }

        console.warn('[useWordPagination] Fetch error:', (error as Error)?.message);
        dispatchState({ type: 'ERROR' });
      } finally {
        isPaginatingRef.current = false;
      }
    },
    [reduxDispatch],
  );
  executeFetchRef.current = executeFetch;

  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  const performReset = useCallback(async () => {
    circuitBrokenRef.current = false;
    consecutiveEmptyPagesRef.current = 0;
    pagesRequestedRef.current = 0;

    const { userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt } = filtersRef.current;
    const cacheKey = buildListCacheKey({ page: 1, level: lvl, status: st, type: wt, searchQuery: q });

    const cached = await readThroughCacheWithSource<UserWord[]>(cacheKey);

    if (cached) {
      reduxDispatch(setWords(cached.value));
      reduxDispatch(setPage(1));
      dispatchState({ type: 'FETCH_SUCCESS', hasMore: cached.value.length >= PAGE_SIZE });

      if (cached.source === 'memory') {
        return;
      }

      executeFetch({ page: 1, isReset: true, userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt });
      return;
    }

    dispatchState({ type: 'RESET' });
    executeFetch({ page: 1, isReset: true, userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt });
  }, [executeFetch, reduxDispatch]);

  const performHardReset = useCallback(() => {
    invalidateDictionaryListCache();
    circuitBrokenRef.current = false;
    consecutiveEmptyPagesRef.current = 0;
    pagesRequestedRef.current = 0;
    dispatchState({ type: 'RESET' });

    const { userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt } = filtersRef.current;
    executeFetch({ page: 1, isReset: true, userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt });
  }, [executeFetch]);

  const isFirstRefreshRenderRef = useRef(true);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    isPaginatingRef.current = false;

    if (!isFocusedRef.current) {
      pendingRefetchRef.current = true;
      return;
    }

    if (isFirstRefreshRenderRef.current) {
      isFirstRefreshRenderRef.current = false;
      performReset();
    } else {
      performHardReset();
    }
  }, [refreshTrigger, performReset, performHardReset]);

  const isFirstFilterRender = useRef(true);

  useEffect(() => {
    if (isFirstFilterRender.current) {
      isFirstFilterRender.current = false;
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    isPaginatingRef.current = false;

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;

      if (!isFocusedRef.current) {
        pendingRefetchRef.current = true;
        return;
      }

      performReset();
    }, DEBOUNCE_TIME);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [userLevel, filterStatus, searchQuery, wordType, performReset]);

  // Слово додано / видалено / змінено (будь-де в застосунку) — список
  // перечитується: одразу, якщо Словник відкритий, інакше — при поверненні.
  // Раніше на цю подію реагувала лише статистика в шапці.
  const mutationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeDictionaryWordsMutated(() => {
      if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current);
      if (!isFocusedRef.current) {
        pendingRefetchRef.current = true;
        return;
      }
      mutationTimerRef.current = setTimeout(() => {
        mutationTimerRef.current = null;
        if (!isFocusedRef.current) {
          pendingRefetchRef.current = true;
          return;
        }
        performHardReset();
      }, MUTATION_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current);
    };
  }, [performHardReset]);

  useEffect(() => {
    if (isFocused && pendingRefetchRef.current) {
      pendingRefetchRef.current = false;
      performHardReset();
    }
  }, [isFocused, performHardReset]);

  const loadMore = useCallback(() => {
    if (circuitBrokenRef.current || isPaginatingRef.current || statusRef.current !== 'idle' || !hasMoreRef.current) {
      return;
    }

    isPaginatingRef.current = true;

    const { userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt } = filtersRef.current;
    const nextPage = Math.floor(wordsRef.current.length / PAGE_SIZE) + 1;

    executeFetch({ page: nextPage, isReset: false, userLevel: lvl, filterStatus: st, searchQuery: q, wordType: wt });
  }, [executeFetch]);

  const retry = useCallback(() => {
    performHardReset();
  }, [performHardReset]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      abortControllerRef.current?.abort();
      requestIdRef.current += 1;
    };
  }, []);

  return {
    words,
    isLoading: state.status === 'loading',
    isPaginating: state.status === 'paginating',
    hasMore: state.hasMore,
    error: state.status === 'error',
    circuitBroken: state.circuitBroken,
    loadMore,
    retry,
  };
};