import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BackProgress } from '../../../types/books';
import api from '../../../services/api';
import { setDiagnosticContext } from '../../../utils/jsThreadWatchdog';

export const SERVER_SYNC_MIN_INTERVAL_MS = 60000;
export const LOCAL_PERSIST_THROTTLE_MS = 4000;
export const PROGRESS_REFETCH_TTL_MS = 30000;
export const NETWORK_HARD_TIMEOUT_MS = 15000;
export const POSITION_HISTORY_LIMIT_PER_BOOK = 80;

export function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('Request hard timeout exceeded'), { name: 'HardTimeoutError' }));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface ApiErrorResponse {
  response?: {
    status?: number;
    data?: {
      message?: string;
    };
  };
  message?: string;
}

export interface ProgressRecord {
  data: BackProgress;
  totalBookPages: number;
  pagesProgress: Record<string, number>;
  localUpdatedAt: number;
  lastServerFetchAt: number;
  isDirty: boolean;
}

export const progressStore = new Map<number, ProgressRecord>();
export const positionStore = new Map<number, Record<string, number>>();
export const positionLruOrder = new Map<number, number[]>();

export function touchPositionLru(bookId: number, pageId: number): void {
  let order = positionLruOrder.get(bookId);
  if (!order) {
    order = [];
    positionLruOrder.set(bookId, order);
  }

  const idx = order.indexOf(pageId);
  if (idx !== -1) order.splice(idx, 1);
  order.push(pageId);

  while (order.length > POSITION_HISTORY_LIMIT_PER_BOOK) {
    const evicted = order.shift();
    if (evicted === undefined) break;

    const positions = positionStore.get(bookId);
    if (positions && Object.prototype.hasOwnProperty.call(positions, String(evicted))) {
      const next = { ...positions };
      delete next[String(evicted)];
      positionStore.set(bookId, next);
    }
  }
}

export const progressListeners = new Set<() => void>();

export interface InFlightEntry {
  promise: Promise<void>;
  startedAt: number;
}

export const IN_FLIGHT_STALE_MS = NETWORK_HARD_TIMEOUT_MS + 8000;

export const progressFetchInFlight = new Map<number, InFlightEntry>();
export const hydratedProgressBooks = new Set<number>();
export const hydratedPositionBooks = new Set<number>();

export const serverSyncTimers = new Map<number, ReturnType<typeof setTimeout>>();
export const serverSyncPending = new Map<number, { pageId: number; progress: number; lastReadPageId: number }>();
export const serverSyncLastAttemptAt = new Map<number, number>();
export const serverSyncLastValue = new Map<number, { pageId: number; progress: number }>();

export const progressPersistTimers = new Map<number, ReturnType<typeof setTimeout>>();
export const positionPersistTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const getCacheKey = (bookId: number) => `@book_progress_${bookId}`;
export const getLastPositionCacheKey = (bookId: number) => `@book_last_position_${bookId}`;

export const isValidId = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const isValidProgress = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const clampPercentage = (value: number): number =>
  Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));

export function notifyProgressListeners(): void {
  progressListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      return;
    }
  });
}

/**
 * Поточний прогрес книги з робочого стану — того самого, що показує екран
 * книги (BookDetails) і читалка. null — для книги ще нічого не завантажено.
 */
export function getProgressSnapshot(bookId: number): { percentage: number; totalBookPages: number } | null {
  const record = progressStore.get(bookId);
  if (!record) return null;
  const percentage = Number((record.data as any)?.percentage);
  if (!Number.isFinite(percentage)) return null;
  return { percentage: clampPercentage(percentage), totalBookPages: record.totalBookPages };
}

/** Підписка на зміни прогресу (список книг оновлюється одразу, без повторного входу). */
export function subscribeToProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/**
 * Відсоток для списку книг за тим самим правилом, що й mergeServerIntoStore
 * на екрані книги: прогрес сторінок лише зростає, тож береться більше з
 * локального і серверного значень. Якщо кількість сторінок книги змінилась
 * (книгу відредагували), правильний лише серверний перерахунок.
 */
export function resolveListPercentage(
  local: { percentage: number; totalBookPages?: number } | null,
  server: { percentage: number; totalPages?: number } | null
): number {
  const localValue = local && Number.isFinite(local.percentage) ? clampPercentage(local.percentage) : null;
  const serverValue = server && Number.isFinite(server.percentage) ? clampPercentage(server.percentage) : null;
  if (localValue === null) return serverValue ?? 0;
  if (serverValue === null) return localValue;
  const localTotal = local?.totalBookPages ?? 0;
  const serverTotal = server?.totalPages ?? 0;
  if (localTotal > 0 && serverTotal > 0 && localTotal !== serverTotal) return serverValue;
  return Math.max(localValue, serverValue);
}

export function computeOverallProgress(
  pagesProgress: Record<string, number>,
  totalBookPages: number
): { percentage: number; readPagesCount: number } {
  const values = Object.values(pagesProgress);
  const totalSum = values.reduce((sum, val) => sum + val, 0);
  const readPagesCount = values.filter((p) => p >= 90).length;
  const percentage = totalBookPages > 0 ? Math.min(100, Math.round(totalSum / totalBookPages)) : 0;
  return { percentage, readPagesCount };
}

export function mergePagesProgress(
  base: Record<string, number>,
  incoming: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = { ...base };
  Object.keys(incoming).forEach((key) => {
    const incomingValue = clampPercentage(incoming[key]);
    const baseValue = typeof merged[key] === 'number' ? merged[key] : 0;
    merged[key] = Math.max(baseValue, incomingValue);
  });
  return merged;
}

export function schedulePersistProgress(bookId: number): void {
  if (progressPersistTimers.has(bookId)) return;

  const timer = setTimeout(() => {
    progressPersistTimers.delete(bookId);
    const record = progressStore.get(bookId);
    if (!record) return;

    InteractionManager.runAfterInteractions(() => {
      setDiagnosticContext({ lastHeavyOp: 'reading-progress-persist', lastHeavyOpAt: Date.now() });
      AsyncStorage.setItem(getCacheKey(bookId), JSON.stringify(record.data))
        .catch(() => {})
        .finally(() => setDiagnosticContext({ lastHeavyOp: null }));
    });
  }, LOCAL_PERSIST_THROTTLE_MS);

  progressPersistTimers.set(bookId, timer);
}

export function flushPersistProgress(bookId: number): void {
  const timer = progressPersistTimers.get(bookId);
  if (timer) {
    clearTimeout(timer);
    progressPersistTimers.delete(bookId);
  }
  const record = progressStore.get(bookId);
  if (!record) return;
  AsyncStorage.setItem(getCacheKey(bookId), JSON.stringify(record.data)).catch(() => {});
}

export function schedulePersistPositions(bookId: number): void {
  if (positionPersistTimers.has(bookId)) return;

  const timer = setTimeout(() => {
    positionPersistTimers.delete(bookId);
    const positions = positionStore.get(bookId);
    if (!positions) return;

    InteractionManager.runAfterInteractions(() => {
      AsyncStorage.setItem(getLastPositionCacheKey(bookId), JSON.stringify(positions)).catch(() => {});
    });
  }, LOCAL_PERSIST_THROTTLE_MS);

  positionPersistTimers.set(bookId, timer);
}

export function flushPersistPositions(bookId: number): void {
  const timer = positionPersistTimers.get(bookId);
  if (timer) {
    clearTimeout(timer);
    positionPersistTimers.delete(bookId);
  }
  const positions = positionStore.get(bookId);
  if (!positions) return;
  AsyncStorage.setItem(getLastPositionCacheKey(bookId), JSON.stringify(positions)).catch(() => {});
}

export function adoptRecord(bookId: number, data: BackProgress, isDirty: boolean, markFetched: boolean): void {
  const previous = progressStore.get(bookId);
  const now = Date.now();
  const record: ProgressRecord = {
    data,
    totalBookPages: (data as any)?.totalBookPages || previous?.totalBookPages || 0,
    pagesProgress: (data as any)?.pagesProgress || {},
    localUpdatedAt: isDirty ? now : previous?.localUpdatedAt ?? 0,
    lastServerFetchAt: markFetched ? now : previous?.lastServerFetchAt ?? 0,
    isDirty,
  };
  progressStore.set(bookId, record);
  notifyProgressListeners();
}

export async function performServerSync(
  bookId: number,
  pageId: number,
  progress: number,
  lastReadPageId: number
): Promise<void> {
  if (!isValidId(bookId) || !isValidId(pageId) || !isValidProgress(progress)) return;

  const lastValue = serverSyncLastValue.get(bookId);
  if (lastValue && lastValue.pageId === pageId && lastValue.progress === progress) {
    return;
  }

  serverSyncLastAttemptAt.set(bookId, Date.now());
  serverSyncLastValue.set(bookId, { pageId, progress });

  try {
    const response = await withHardTimeout(
      api.post(`/books/${bookId}/progress/sync`, {
        pageId,
        progress,
        lastReadPageId,
      }),
      NETWORK_HARD_TIMEOUT_MS
    );

    const serverData = response.data as BackProgress;
    if (!serverData) return;

    const record = progressStore.get(bookId);
    const stillDirty = !!record && record.localUpdatedAt > (serverSyncLastAttemptAt.get(bookId) ?? 0);

    if (!stillDirty) {
      adoptRecord(bookId, serverData, false, true);
      schedulePersistProgress(bookId);
    }
  } catch (error: unknown) {
    const apiError = error as ApiErrorResponse;
    if (apiError?.response?.status !== 429) {
      console.error('Помилка при збереженні прогресу сторінки:', error);
    }
    serverSyncLastValue.delete(bookId);
  }
}

export function scheduleServerSync(
  bookId: number,
  pageId: number,
  progress: number,
  lastReadPageId: number
): void {
  serverSyncPending.set(bookId, { pageId, progress, lastReadPageId });

  const lastAttemptAt = serverSyncLastAttemptAt.get(bookId) ?? 0;
  const elapsed = Date.now() - lastAttemptAt;

  const existingTimer = serverSyncTimers.get(bookId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    serverSyncTimers.delete(bookId);
  }

  if (elapsed >= SERVER_SYNC_MIN_INTERVAL_MS) {
    const args = serverSyncPending.get(bookId);
    serverSyncPending.delete(bookId);
    if (args) {
      performServerSync(bookId, args.pageId, args.progress, args.lastReadPageId).catch(() => {});
    }
    return;
  }

  const timer = setTimeout(() => {
    serverSyncTimers.delete(bookId);
    const args = serverSyncPending.get(bookId);
    serverSyncPending.delete(bookId);
    if (args) {
      performServerSync(bookId, args.pageId, args.progress, args.lastReadPageId).catch(() => {});
    }
  }, SERVER_SYNC_MIN_INTERVAL_MS - elapsed);

  serverSyncTimers.set(bookId, timer);
}

export function flushServerSync(bookId: number): void {
  const timer = serverSyncTimers.get(bookId);
  if (timer) {
    clearTimeout(timer);
    serverSyncTimers.delete(bookId);
  }
  const args = serverSyncPending.get(bookId);
  serverSyncPending.delete(bookId);
  if (args) {
    performServerSync(bookId, args.pageId, args.progress, args.lastReadPageId).catch(() => {});
  }
}

export async function hydrateProgressFromDisk(bookId: number): Promise<void> {
  if (hydratedProgressBooks.has(bookId)) return;
  hydratedProgressBooks.add(bookId);

  if (progressStore.has(bookId)) return;

  try {
    const raw = await AsyncStorage.getItem(getCacheKey(bookId));
    if (!raw) return;
    if (progressStore.has(bookId)) return;

    const parsed = JSON.parse(raw) as BackProgress;
    if (parsed) {
      adoptRecord(bookId, parsed, false, false);
    }
  } catch (error) {
    return;
  }
}

export async function hydratePositionsFromDisk(bookId: number): Promise<void> {
  if (hydratedPositionBooks.has(bookId)) return;
  hydratedPositionBooks.add(bookId);

  if (positionStore.has(bookId)) return;

  try {
    const raw = await AsyncStorage.getItem(getLastPositionCacheKey(bookId));
    if (!raw) return;
    if (positionStore.has(bookId)) return;

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const entries = Object.entries(parsed as Record<string, number>);
      const trimmedEntries = entries.slice(-POSITION_HISTORY_LIMIT_PER_BOOK);
      const trimmed: Record<string, number> = {};
      trimmedEntries.forEach(([key, value]) => {
        trimmed[key] = value;
      });

      positionStore.set(bookId, trimmed);
      positionLruOrder.set(
        bookId,
        trimmedEntries.map(([key]) => Number(key)).filter(isValidId)
      );
    }
  } catch (error) {
    return;
  }
}

export function mergeServerIntoStore(bookId: number, serverData: BackProgress, requestStartedAt: number): void {
  const existing = progressStore.get(bookId);

  if (!existing) {
    adoptRecord(bookId, serverData, false, true);
    return;
  }

  const localIsNewer = existing.isDirty || existing.localUpdatedAt > requestStartedAt;

  if (!localIsNewer) {
    adoptRecord(bookId, serverData, false, true);
    return;
  }

  const serverPages = ((serverData as any)?.pagesProgress || {}) as Record<string, number>;
  const mergedPages = mergePagesProgress(serverPages, existing.pagesProgress);
  const totalBookPages = (serverData as any)?.totalBookPages || existing.totalBookPages || 0;
  const { percentage, readPagesCount } = computeOverallProgress(mergedPages, totalBookPages);

  const mergedData = {
    ...(serverData as any),
    totalBookPages,
    pagesProgress: mergedPages,
    lastReadPageId: existing.data?.lastReadPageId ?? (serverData as any)?.lastReadPageId ?? null,
    percentage: totalBookPages > 0 ? percentage : (existing.data as any)?.percentage ?? 0,
    readPagesCount: totalBookPages > 0 ? readPagesCount : (existing.data as any)?.readPagesCount ?? 0,
  } as BackProgress;

  progressStore.set(bookId, {
    data: mergedData,
    totalBookPages,
    pagesProgress: mergedPages,
    localUpdatedAt: existing.localUpdatedAt,
    lastServerFetchAt: Date.now(),
    isDirty: true,
  });

  notifyProgressListeners();
  schedulePersistProgress(bookId);
}
