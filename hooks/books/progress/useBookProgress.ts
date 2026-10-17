import { useState, useCallback, useRef, useEffect } from 'react';
import { BackProgress } from '../../../types/books';
import api from '../../../services/api';
import {
  IN_FLIGHT_STALE_MS,
  NETWORK_HARD_TIMEOUT_MS,
  PROGRESS_REFETCH_TTL_MS,
  clampPercentage,
  computeOverallProgress,
  flushPersistPositions,
  flushPersistProgress,
  flushServerSync,
  hydratePositionsFromDisk,
  hydrateProgressFromDisk,
  hydratedPositionBooks,
  hydratedProgressBooks,
  isValidId,
  isValidProgress,
  mergeServerIntoStore,
  notifyProgressListeners,
  positionLruOrder,
  positionPersistTimers,
  positionStore,
  progressFetchInFlight,
  progressListeners,
  progressPersistTimers,
  progressStore,
  schedulePersistPositions,
  schedulePersistProgress,
  scheduleServerSync,
  serverSyncLastAttemptAt,
  serverSyncLastValue,
  serverSyncPending,
  serverSyncTimers,
  touchPositionLru,
  withHardTimeout,
} from './progressStore';
export { getProgressSnapshot, resolveListPercentage, subscribeToProgress } from './progressStore';

export interface UseBookProgressReturn {
  currentProgress: BackProgress | null;
  progressBookId: number | null;
  isLoadingProgress: boolean;
  progressError: string | null;
  fetchProgress: (bookId: number) => Promise<void>;
  syncPageProgress: (
    bookId: number,
    pageId: number,
    progressPercentage: number,
    markAsCurrent?: boolean
  ) => void;
  flushPendingProgress: (bookId: number) => void;
  clearProgress: () => void;
  lastPositions: Record<string, number>;
  lastPositionsBookId: number | null;
  isLastPositionsReady: boolean;
  loadLastPositions: (bookId: number) => Promise<void>;
  saveLastPosition: (bookId: number, pageId: number, progressPercentage: number) => void;
  getLastPosition: (bookId: number, pageId: number) => number;
  getStartPageId: (bookId: number) => number | null;
}

export const useBookProgress = (): UseBookProgressReturn => {
  const [activeBookId, setActiveBookId] = useState<number | null>(null);
  const [storeVersion, setStoreVersion] = useState<number>(0);
  const [isLoadingProgress, setIsLoadingProgress] = useState<boolean>(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [isLastPositionsReady, setIsLastPositionsReady] = useState<boolean>(false);
  const [lastPositionsBookId, setLastPositionsBookId] = useState<number | null>(null);

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
        setStoreVersion((v) => v + 1);
      }
    };
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  }, []);

  const activeRecord = activeBookId !== null ? progressStore.get(activeBookId) : undefined;
  const currentProgress = activeRecord ? activeRecord.data : null;
  const progressBookId = activeBookId;
  const lastPositions =
    lastPositionsBookId !== null ? positionStore.get(lastPositionsBookId) ?? {} : {};

  const fetchProgress = useCallback(async (bookId: number): Promise<void> => {
    if (!isValidId(bookId)) {
      if (isMountedRef.current) setActiveBookId(null);
      return;
    }

    if (isMountedRef.current) {
      setActiveBookId(bookId);
      setProgressError(null);
    }

    await hydrateProgressFromDisk(bookId);

    const existing = progressStore.get(bookId);
    const isFresh =
      !!existing &&
      !existing.isDirty &&
      Date.now() - existing.lastServerFetchAt < PROGRESS_REFETCH_TTL_MS;

    if (isFresh) {
      if (isMountedRef.current) setIsLoadingProgress(false);
      return;
    }

    const existingEntry = progressFetchInFlight.get(bookId);
    if (existingEntry) {
      const age = Date.now() - existingEntry.startedAt;
      if (age < IN_FLIGHT_STALE_MS) {
        if (isMountedRef.current) setIsLoadingProgress(!existing);
        await existingEntry.promise;
        if (isMountedRef.current) setIsLoadingProgress(false);
        return;
      }
      progressFetchInFlight.delete(bookId);
    }

    if (isMountedRef.current) {
      setIsLoadingProgress(!existing);
    }

    const requestStartedAt = Date.now();

    const request = (async () => {
      try {
        const response = await withHardTimeout(
          api.get(`/books/${bookId}/progress`),
          NETWORK_HARD_TIMEOUT_MS
        );
        const serverData = response.data as BackProgress;
        if (serverData) {
          mergeServerIntoStore(bookId, serverData, requestStartedAt);
          schedulePersistProgress(bookId);
        }
      } catch (error: any) {
        console.error('Помилка при завантаженні прогресу:', error);
        if (isMountedRef.current) {
          setProgressError(error?.message || 'Не вдалося завантажити прогрес');
        }
      } finally {
        progressFetchInFlight.delete(bookId);
      }
    })();

    progressFetchInFlight.set(bookId, { promise: request, startedAt: Date.now() });
    await request;

    if (isMountedRef.current) {
      setIsLoadingProgress(false);
    }
  }, []);

  const loadLastPositions = useCallback(async (bookId: number): Promise<void> => {
    if (!isValidId(bookId)) {
      if (isMountedRef.current) {
        setLastPositionsBookId(null);
        setIsLastPositionsReady(true);
      }
      return;
    }

    if (positionStore.has(bookId)) {
      if (isMountedRef.current) {
        setLastPositionsBookId(bookId);
        setIsLastPositionsReady(true);
      }
      return;
    }

    if (isMountedRef.current) {
      setLastPositionsBookId(bookId);
      setIsLastPositionsReady(false);
    }

    await hydratePositionsFromDisk(bookId);

    if (!positionStore.has(bookId)) {
      positionStore.set(bookId, {});
    }

    if (isMountedRef.current) {
      setIsLastPositionsReady(true);
    }
  }, []);

  const saveLastPosition = useCallback(
    (bookId: number, pageId: number, progressPercentage: number): void => {
      if (!isValidId(bookId) || !isValidId(pageId)) return;

      const safeProgress = clampPercentage(progressPercentage);
      const positions = positionStore.get(bookId) ?? {};

      if (positions[String(pageId)] === safeProgress) return;

      positionStore.set(bookId, { ...positions, [String(pageId)]: safeProgress });
      touchPositionLru(bookId, pageId);
      schedulePersistPositions(bookId);
    },
    []
  );

  const getLastPosition = useCallback((bookId: number, pageId: number): number => {
    if (!isValidId(bookId) || !isValidId(pageId)) return 0;
    const positions = positionStore.get(bookId);
    if (!positions) return 0;
    const value = positions[String(pageId)];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }, []);

  const getStartPageId = useCallback((bookId: number): number | null => {
    if (!isValidId(bookId)) return null;
    const record = progressStore.get(bookId);
    const candidate = record?.data?.lastReadPageId;
    return isValidId(candidate) ? candidate : null;
  }, []);

  const syncPageProgress = useCallback(
    (
      bookId: number,
      pageId: number,
      progressPercentage: number,
      markAsCurrent: boolean = true
    ): void => {
      if (!isValidId(bookId) || !isValidId(pageId) || !isValidProgress(progressPercentage)) {
        return;
      }

      const existing = progressStore.get(bookId);
      const basePages = existing?.pagesProgress ?? {};
      const totalBookPages = existing?.totalBookPages ?? 0;

      const pageKey = String(pageId);
      const safePageProgress = clampPercentage(progressPercentage);
      const previousPageProgress =
        typeof basePages[pageKey] === 'number' ? basePages[pageKey] : 0;
      const nextPageProgress = Math.max(previousPageProgress, safePageProgress);

      const existingLastReadPageId = existing?.data?.lastReadPageId;
      const nextLastReadPageId = markAsCurrent
        ? pageId
        : isValidId(existingLastReadPageId)
          ? existingLastReadPageId
          : pageId;

      const isSamePage = existingLastReadPageId === nextLastReadPageId;
      const isSameProgress = previousPageProgress === nextPageProgress;

      if (isSamePage && isSameProgress) {
        return;
      }

      const updatedPages = { ...basePages, [pageKey]: nextPageProgress };
      const hasKnownTotalPages = totalBookPages > 0;
      const { percentage, readPagesCount } = computeOverallProgress(updatedPages, totalBookPages);

      const baseData: any = existing?.data ?? {
        totalBookPages,
        readPagesCount: 0,
        percentage: 0,
        lastReadPageId: nextLastReadPageId,
        pagesProgress: {},
      };

      const nextData = {
        ...baseData,
        totalBookPages,
        lastReadPageId: nextLastReadPageId,
        pagesProgress: updatedPages,
        readPagesCount: hasKnownTotalPages ? readPagesCount : baseData.readPagesCount,
        percentage: hasKnownTotalPages ? percentage : baseData.percentage,
      } as BackProgress;

      progressStore.set(bookId, {
        data: nextData,
        totalBookPages,
        pagesProgress: updatedPages,
        localUpdatedAt: Date.now(),
        lastServerFetchAt: existing?.lastServerFetchAt ?? 0,
        isDirty: true,
      });

      notifyProgressListeners();
      schedulePersistProgress(bookId);
      scheduleServerSync(bookId, pageId, safePageProgress, nextLastReadPageId);
    },
    []
  );

  const flushPendingProgress = useCallback((bookId: number): void => {
    if (!isValidId(bookId)) return;
    flushServerSync(bookId);
    flushPersistProgress(bookId);
    flushPersistPositions(bookId);
  }, []);

  const clearProgress = useCallback((): void => {
    progressStore.clear();
    positionStore.clear();
    positionLruOrder.clear();
    hydratedProgressBooks.clear();
    hydratedPositionBooks.clear();
    progressFetchInFlight.clear();
    serverSyncPending.clear();
    serverSyncLastAttemptAt.clear();
    serverSyncLastValue.clear();

    serverSyncTimers.forEach((timer) => clearTimeout(timer));
    serverSyncTimers.clear();
    progressPersistTimers.forEach((timer) => clearTimeout(timer));
    progressPersistTimers.clear();
    positionPersistTimers.forEach((timer) => clearTimeout(timer));
    positionPersistTimers.clear();

    if (isMountedRef.current) {
      setActiveBookId(null);
      setLastPositionsBookId(null);
      setIsLastPositionsReady(false);
      setIsLoadingProgress(false);
      setProgressError(null);
    }

    notifyProgressListeners();
  }, []);

  return {
    currentProgress,
    progressBookId,
    isLoadingProgress,
    progressError,
    fetchProgress,
    syncPageProgress,
    flushPendingProgress,
    clearProgress,
    lastPositions,
    lastPositionsBookId,
    isLastPositionsReady,
    loadLastPositions,
    saveLastPosition,
    getLastPosition,
    getStartPageId,
  };
};