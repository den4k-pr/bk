import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { ReaderPage } from '../../../types/books';

export type NavigationSource = 'gesture' | 'external';

interface UseReaderNavigationParams {
  bookId: number;
  chapterPages: ReaderPage[];
  /**
   * ТІЛЬКИ явний намір навігації: параметр маршруту, закладка,
   * відновлена позиція при холодному старті.
   * НЕ передавати сюди сторінку, на яку користувач долистав свайпом.
   */
  requestedPageId?: number;
  onNotFound: () => void;
  onPageChange?: (pageId: number) => void;
  markPageAsRead: (bookId: number, pageId: number) => void;
  stop: () => void;
  clearSelection: () => void;
}

interface UseReaderNavigationResult {
  listRef: React.RefObject<FlatList<ReaderPage> | null>;
  /** Дзеркало для рендеру. НІКОЛИ не використовується для логіки. */
  displayIndex: number;
  /** Виміряна ширина контейнера. Поки 0 — FlatList не монтується. */
  pageWidth: number;
  onContainerLayout: (event: LayoutChangeEvent) => void;
  getItemLayout: (
    data: unknown,
    index: number,
  ) => { length: number; offset: number; index: number };
  initialScrollIndex: number;
  onMomentumScrollEnd: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Єдина публічна точка програмної навігації (закладки тощо). */
  goToPageId: (pageId: number) => boolean;
  /** Інкрементується ЛИШЕ при зовнішній навігації. Свайп його не чіпає. */
  navigationEpoch: number;
  /** Сторінка, що є явною ціллю навігації прямо зараз (або null). */
  getExplicitTargetPageId: () => number | null;
}

const trace = (event: string, payload: Record<string, unknown>): void => {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log(`[reader] ${event}`, { ...payload, ts: Date.now() });
  }
};

export function useReaderNavigation({
  bookId,
  chapterPages,
  requestedPageId,
  onNotFound,
  onPageChange,
  markPageAsRead,
  stop,
  clearSelection,
}: UseReaderNavigationParams): UseReaderNavigationResult {
  const listRef = useRef<FlatList<ReaderPage>>(null);

  // ── ЄДИНЕ ДЖЕРЕЛО ІСТИНИ ────────────────────────────────────────────────
  // indexRef авторитетний і оновлюється СИНХРОННО всередині gesture-колбеків.
  // displayIndex — лише дзеркало для рендеру (заголовок, підсвітка тощо).
  const indexRef = useRef<number>(0);
  const [displayIndex, setDisplayIndex] = useState<number>(0);

  // Явна ціль навігації тримається в ref, а не в state, щоб її скидання
  // під час свайпу не перестворювало renderItem і не ре-рендерило сторінки
  // посеред жесту.
  const explicitTargetPageIdRef = useRef<number | null>(null);
  const [navigationEpoch, setNavigationEpoch] = useState<number>(0);

  // Який саме явний запит ми вже задовольнили.
  // 🔴 КЛЮЧОВЕ: ЖОДЕН код у gesture-гілці не має права писати в цей ref.
  // Саме перезапис цього латча зі свайпу і був коренем скидання на 1-шу сторінку.
  const consumedRequestRef = useRef<number | null>(null);

  const [pageWidth, setPageWidth] = useState<number>(0);
  const pageWidthRef = useRef<number>(0);

  const pagesRef = useRef<ReaderPage[]>(chapterPages);
  pagesRef.current = chapterPages;

  // Змінюється лише тоді, коли змінюється НАБІР сторінок.
  // Прихід контенту розділу, тіки префетчу і chapterContentSignal
  // не змінюють id сторінок — отже, більше не можуть перезапустити навігацію.
  const pageIdSignature = useMemo(
    () => chapterPages.map((p) => p.id).join('|'),
    [chapterPages],
  );

  const cb = useRef({ onNotFound, onPageChange, markPageAsRead, stop, clearSelection });
  cb.current = { onNotFound, onPageChange, markPageAsRead, stop, clearSelection };

  // ── Зміна книги — єдиний повний ресет ──────────────────────────────────
  useEffect(() => {
    trace('BOOK_OPEN', { bookId });
    indexRef.current = 0;
    consumedRequestRef.current = null;
    explicitTargetPageIdRef.current = null;
    setDisplayIndex(0);
    setNavigationEpoch(0);
  }, [bookId]);

  // ── Застосування нового індексу ────────────────────────────────────────
  const apply = useCallback(
    (index: number, source: NavigationSource): void => {
      const pages = pagesRef.current;
      const page = pages[index];
      if (!page) return;

      const previous = indexRef.current;
      indexRef.current = index;
      setDisplayIndex(index);

      trace('PAGE_CHANGE', {
        chapter: index,
        previous,
        next: index,
        source,
        pageId: page.id,
      });

      if (source === 'gesture') {
        // Звичайне гортання НІКОЛИ не відновлює збережений скрол-прогрес.
        explicitTargetPageIdRef.current = null;
        cb.current.clearSelection();
        cb.current.stop();
      } else {
        explicitTargetPageIdRef.current = page.id;
        setNavigationEpoch((v) => v + 1);
        if (pageWidthRef.current > 0) {
          listRef.current?.scrollToOffset({
            offset: index * pageWidthRef.current,
            animated: false,
          });
        }
      }

      cb.current.onPageChange?.(page.id);
      cb.current.markPageAsRead(bookId, page.id);
    },
    [bookId],
  );

  // ── Явний намір навігації ──────────────────────────────────────────────
  useEffect(() => {
    const pages = pagesRef.current;
    if (pages.length === 0) return;
    if (requestedPageId === undefined) return;
    if (consumedRequestRef.current === requestedPageId) return;

    const targetIndex = pages.findIndex((p) => p.id === requestedPageId);

    // Споживаємо токен ОДРАЗУ — і при успіху, і при невдачі.
    consumedRequestRef.current = requestedPageId;

    if (targetIndex === -1) {
      trace('PAGE_STATE_RESTORE_FAILED', { requestedPageId });
      cb.current.onNotFound();
      return;
    }

    const alreadyExplicitlyOnThisPage = explicitTargetPageIdRef.current === requestedPageId;

    if (targetIndex === indexRef.current && alreadyExplicitlyOnThisPage) {
      trace('PAGE_STATE_RESTORED_NOOP', { requestedPageId, targetIndex });
      return;
    }

    trace('PAGE_STATE_RESTORED', { requestedPageId, targetIndex });
    apply(targetIndex, 'external');
  }, [bookId, requestedPageId, pageIdSignature, apply]);

  // ── Жести ──────────────────────────────────────────────────────────────
  const commitFromOffset = useCallback(
    (offsetX: number): void => {
      const width = pageWidthRef.current;
      if (width <= 0) return;

      const pages = pagesRef.current;
      if (pages.length === 0) return;

      const raw = Math.round(offsetX / width);
      const index = Math.min(Math.max(raw, 0), pages.length - 1);

      // Порівняння з ref, а не зі state — два колбеки в одному кадрі
      // не можуть розсинхронізуватись через застиглий замикач.
      if (index === indexRef.current) return;

      apply(index, 'gesture');
    },
    [apply],
  );

  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      commitFromOffset(event.nativeEvent.contentOffset.x);
    },
    [commitFromOffset],
  );

  // Комітимо на кінці драгу лише якщо інерції не буде — інакше зафіксували б
  // індекс з офсету, на якому список ще не зупинився.
  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const velocityX = event.nativeEvent.velocity?.x ?? 0;
      if (Math.abs(velocityX) > 0.05) return;
      commitFromOffset(event.nativeEvent.contentOffset.x);
    },
    [commitFromOffset],
  );

  // ── Геометрія ──────────────────────────────────────────────────────────
  const onContainerLayout = useCallback((event: LayoutChangeEvent): void => {
    const width = Math.round(event.nativeEvent.layout.width);
    if (width <= 0) return;
    if (width === pageWidthRef.current) return;
    pageWidthRef.current = width;
    setPageWidth(width);
  }, []);

  // Поворот / зміна розмірів: переприв'язуємось туди, де користувач Є,
  // і ніколи не на 0.
  const isFirstWidthRef = useRef(true);
  useEffect(() => {
    if (pageWidth <= 0) return;
    if (isFirstWidthRef.current) {
      isFirstWidthRef.current = false;
      return;
    }
    listRef.current?.scrollToOffset({
      offset: indexRef.current * pageWidth,
      animated: false,
    });
  }, [pageWidth]);

  const getItemLayout = useCallback(
    (_data: unknown, index: number) => ({
      length: pageWidth,
      offset: pageWidth * index,
      index,
    }),
    [pageWidth],
  );

  // Заморожується на першому монтуванні списку і більше НІКОЛИ не читається.
  const initialScrollIndexRef = useRef<number | null>(null);
  if (
    initialScrollIndexRef.current === null &&
    pageWidth > 0 &&
    chapterPages.length > 0
  ) {
    initialScrollIndexRef.current = indexRef.current;
  }

  const goToPageId = useCallback(
    (pageId: number): boolean => {
      const index = pagesRef.current.findIndex((p) => p.id === pageId);
      if (index === -1) return false;
      consumedRequestRef.current = pageId;
      apply(index, 'external');
      return true;
    },
    [apply],
  );

  const getExplicitTargetPageId = useCallback(
    (): number | null => explicitTargetPageIdRef.current,
    [],
  );

  return {
    listRef,
    displayIndex,
    pageWidth,
    onContainerLayout,
    getItemLayout,
    initialScrollIndex: initialScrollIndexRef.current ?? 0,
    onMomentumScrollEnd,
    onScrollEndDrag,
    goToPageId,
    navigationEpoch,
    getExplicitTargetPageId,
  };
}
