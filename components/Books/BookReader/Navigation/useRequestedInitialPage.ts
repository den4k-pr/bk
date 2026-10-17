import { useEffect, useMemo, useRef, useState } from 'react';
import { useShouldPreferSavedProgressOnMount } from '../../../../navigation/NavigationRestoratIoncontext';

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

interface UseRequestedInitialPageParams {
  bookId: number;
  initialPageId?: number;
  isLoadingProgress: boolean;
  progressBookId: number | null | undefined;
  currentProgress: { lastReadPageId?: number | null } | null | undefined;
}

export function useRequestedInitialPage({
  bookId,
  initialPageId,
  isLoadingProgress,
  progressBookId,
  currentProgress,
}: UseRequestedInitialPageParams) {
  const preferSavedProgress = useShouldPreferSavedProgressOnMount();

  const [progressWaitTimeout, setProgressWaitTimeout] = useState(false);
  useEffect(() => {
    setProgressWaitTimeout(false);
    const t = setTimeout(() => setProgressWaitTimeout(true), 2500);
    return () => clearTimeout(t);
  }, [bookId]);

  const resolvedOnceForBookRef = useRef<number | null>(null);
  useEffect(() => {
    resolvedOnceForBookRef.current = null;
  }, [bookId]);

  // Після холодного старту (iOS вивантажив застосунок, повне
  // перемонтування) чекаємо на збережений прогрес НАВІТЬ якщо в маршруті є
  // pageId: той pageId — сторінка, з якої книжку ВІДКРИЛИ, а не де людина
  // зупинилась.
  const isRequestedPageIdPending =
    preferSavedProgress &&
    resolvedOnceForBookRef.current !== bookId &&
    isLoadingProgress &&
    !progressWaitTimeout;

  // Вибір сторінки при відновленні фіксуємо один раз: інакше після
  // першого вирішення memo повернувся б до старого pageId з маршруту і
  // читалка перескочила б туди.
  // Новий явний перехід (інший pageId у маршруті) цей вибір скасовує.
  const coldRestorePickRef = useRef<{ bookId: number; pageId: number; routePageId?: number } | null>(null);

  const requestedInitialPageId = useMemo((): number | undefined => {
    const pick = coldRestorePickRef.current;
    if (pick && pick.bookId === bookId && pick.routePageId === initialPageId) return pick.pageId;

    // Холодне відновлення прямо в читалку: збережене місце (локальне —
    // працює й без мережі) важливіше за pageId з маршруту. Раніше маршрут
    // перемагав, і після повернення в застосунок кидало на сторінку, з
    // якої книжку колись відкрили (початок розділу).
    if (preferSavedProgress && resolvedOnceForBookRef.current !== bookId) {
      if (isLoadingProgress && !progressWaitTimeout) return undefined;
      const saved = progressBookId === bookId ? currentProgress?.lastReadPageId : undefined;
      if (isValidId(saved)) {
        coldRestorePickRef.current = { bookId, pageId: saved, routePageId: initialPageId };
        return saved;
      }
    }

    if (isValidId(initialPageId)) return initialPageId;
    if (!preferSavedProgress) return undefined;
    if (resolvedOnceForBookRef.current === bookId) return undefined;
    if (isLoadingProgress && !progressWaitTimeout) return undefined;
    if (progressBookId !== bookId) return undefined;
    const saved = currentProgress?.lastReadPageId;
    return isValidId(saved) ? saved : undefined;
  }, [
    initialPageId,
    preferSavedProgress,
    isLoadingProgress,
    progressWaitTimeout,
    progressBookId,
    bookId,
    currentProgress,
  ]);

  return { requestedInitialPageId, isRequestedPageIdPending, resolvedOnceForBookRef };
}
