import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  FlatList,
  Animated,
  Easing,
  AppState,
  AppStateStatus,
} from 'react-native';
import { useDispatch } from 'react-redux';
import { useIsFocused } from '@react-navigation/native';
import { BookReaderProps } from '../../../types/BookReader.types';
import { AppDispatch } from '../../../../store';
import { useBookProgress } from '../../../hooks/books/progress/useBookProgress';
import { useTts } from '../../../hooks/useTts';
import { useBookManager, useChapterContentVersionsForIds } from '../../../hooks/books/content/useBookManager';
import { useBookData } from '../../../hooks/books/content/useBookData';
import { useHighlights } from '../../../hooks/books/highlights/useHighlights';
import { usePhraseSelection } from '../../../hooks/books/selection/usePhraseSelection';
import { useReaderNavigation } from '../../../hooks/books/navigation/useReaderNavigation';
import { useBookmarks } from '../../../hooks/books/bookmarks/useBookmarks';
import { BackHighlight, BookLevel, ReaderPage } from '../../../types/books';
import { ReaderPageItem, ReaderPageItemHandle } from './Page/ReaderPageItem';
import PreloaderAnim from '../../../widgets/PreloaderAnim';
import { stylesReader } from './BookReader.styles';
import { TranslationBottomSheet } from './Translation/TranslationBottomSheet';
import { BookmarksMenu } from '../Bookmarks/BookmarksMenu';
import { useReaderSelectionPersistence } from '../../../hooks/books/selection/readerSelectionStore';
import { flushReaderFontSize } from './FontSize/readerFontSize';
import { ensurePhraseDictionaryLoaded } from './Phrases/phraseLibraryLoader';
import { logLifecycleEvent } from '../../../utils/lifecycleLogger';
import { HighlightActionMenu } from './Highlights/HighlightActionMenu';
import { ReaderHeaderBar } from './Header/ReaderHeaderBar';
import { useReaderFontSize } from './FontSize/useReaderFontSize';
import { FontSizePanel } from './FontSize/FontSizePanel';
import { useSwipePageHint } from './Page/useSwipePageHint';
import { useProgressScrubber } from './Progress/useProgressScrubber';
import { ReaderProgressBar } from './Progress/ReaderProgressBar';
import { useScrollProgressSync } from './Progress/useScrollProgressSync';
import { useRequestedInitialPage } from './Navigation/useRequestedInitialPage';
import { SwipePageHint } from './Page/SwipePageHint';
import {
  clearBookReaderQuickSession,
  registerLiveBookReaderPointer,
  unregisterLiveBookReaderPointer,
} from '../../../navigation/bookReaderQuickSession';

const EMPTY_HIGHLIGHTS: BackHighlight[] = [];

const READER_WINDOW_SIZE = 3;
const READER_INITIAL_NUM_TO_RENDER = 2;
const READER_MAX_TO_RENDER_PER_BATCH = 2;
// Вимкнено: у новій архітектурі на Android removeClippedSubviews при зміні
// елементів списку дає нативне падіння (IndexOutOfBoundsException у
// ReactViewGroup). Сторінок змонтовано максимум READER_WINDOW_SIZE, тож
// виграш у пам'яті мізерний.
const REMOVE_CLIPPED_SUBVIEWS = false;

const BASE_DATA_STALL_TIMEOUT_MS = 6000;

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const trace = (event: string, payload: Record<string, unknown>): void => {
  if (__DEV__) {
    console.log(`[reader] ${event}`, { ...payload, ts: Date.now() });
  }
};

interface BookReaderScreenProps extends BookReaderProps {
  level: BookLevel;
  onPageChange?: (pageId: number) => void;
  contentAreaRef?: React.RefObject<View | null>;
  bookmarkButtonRef?: React.RefObject<View | null>;
  dotsButtonRef?: React.RefObject<View | null>;
  fontPanelAreaRef?: React.RefObject<View | null>;
  forceFontMenuOpen?: boolean;
  /** Закладка з іншої книги: відкрити ту книгу на сторінці закладки. */
  onOpenBook?: (bookId: number, level: BookLevel, pageId: number) => void;
}

// Висота панелі перекладу, поки її ще не виміряно (перший тап у сесії).
const SHEET_HEIGHT_ESTIMATE = 230;
// Скільки після тапу ще доводимо скрол, якщо панель стала вищою.
const REVEAL_FOLLOW_UP_MS = 5000;

export const BookReaderScreen: React.FC<BookReaderScreenProps> = ({
  bookId,
  level,
  initialPageId,
  onBack,
  onPageChange,
  onNotFound,
  contentAreaRef,
  bookmarkButtonRef,
  dotsButtonRef,
  fontPanelAreaRef,
  forceFontMenuOpen,
  onOpenBook,
}) => {
  const dispatch = useDispatch<AppDispatch>();

  const isFocused = useIsFocused();

  const onNotFoundRef = useRef(onNotFound);
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onNotFoundRef.current = onNotFound;
    onBackRef.current = onBack;
  }, [onNotFound, onBack]);

  useEffect(() => {
    trace('READER_MOUNT', { bookId });
    return () => trace('READER_UNMOUNT', { bookId });
  }, [bookId]);

  useEffect(() => {
    trace(isFocused ? 'READER_FOCUS' : 'READER_BLUR', { bookId });
  }, [isFocused, bookId]);

  const {
    syncPageProgress,
    flushPendingProgress,
    fetchProgress,
    currentProgress,
    progressBookId,
    isLoadingProgress,
    lastPositions,
    isLastPositionsReady,
    loadLastPositions,
    saveLastPosition,
    getLastPosition,
  } = useBookProgress();

  const { speak, stop } = useTts();
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    if (!isValidId(bookId)) return;
    fetchProgress(bookId);
    loadLastPositions(bookId);
  }, [bookId, fetchProgress, loadLastPositions]);

  const { requestedInitialPageId, isRequestedPageIdPending, resolvedOnceForBookRef } = useRequestedInitialPage({
    bookId,
    initialPageId,
    isLoadingProgress,
    progressBookId,
    currentProgress,
  });

  const {
    currentBook,
    isLoading,
    bookNotFound,
    myBookmarks,
    fetchBookDetails,
    fetchPageDetails,
    fetchAllHighlightsForBook,
    addHighlight,
    removeHighlight,
    fetchMyBookmarks,
    setBookmark,
    removeBookmark,
    ensureChapterContent,
    prefetchChapters,
    getChapterContent,
    isChapterLoading,
  } = useBookManager();

  const {
    fontSize,
    isFontSizeReady,
    isHeightCalibrationReady,
    fontSizeDebounceTimerRef,
    decreaseFontSize,
    increaseFontSize,
  } = useReaderFontSize();
  const [isFontMenuVisible, setIsFontMenuVisible] = useState<boolean>(false);
  const [isBookmarksVisible, setIsBookmarksVisible] = useState<boolean>(false);

  useEffect(() => {
    if (forceFontMenuOpen !== undefined) {
      setIsFontMenuVisible(forceFontMenuOpen);
    } else {
      setIsFontMenuVisible(false);
    }
  }, [forceFontMenuOpen]);

  useEffect(() => {
    ensurePhraseDictionaryLoaded();
  }, []);

  const { chapterPages: pageSkeletons, chapterIdByIndex } = useBookData({
    bookId,
    currentBook,
    isLoading,
    bookNotFound,
    fetchBookDetails,
    onNotFound,
    isFocused,
  });

  const chapterEntryPageIds = useMemo(
    () => pageSkeletons.map((skeleton) => skeleton.id),
    [pageSkeletons],
  );

  const [resolvedInitialPageId, setResolvedInitialPageId] = useState<number | undefined>(undefined);
  const [isInitialPageResolved, setIsInitialPageResolved] = useState<boolean>(false);
  const resolutionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    resolutionKeyRef.current = null;
    setResolvedInitialPageId(undefined);
    setIsInitialPageResolved(false);
  }, [bookId]);

  useEffect(() => {
    if (isRequestedPageIdPending) return;
    if (pageSkeletons.length === 0) return;

    const key = `${bookId}:${requestedInitialPageId ?? 'none'}`;
    if (resolutionKeyRef.current === key) return;
    resolutionKeyRef.current = key;

    const fallbackPageId = pageSkeletons[0].id;

    const markResolvedOnce = () => {
      resolvedOnceForBookRef.current = bookId;
    };

    if (!isValidId(requestedInitialPageId)) {
      setResolvedInitialPageId(fallbackPageId);
      setIsInitialPageResolved(true);
      markResolvedOnce();
      return;
    }

    if (chapterEntryPageIds.indexOf(requestedInitialPageId) !== -1) {
      setResolvedInitialPageId(requestedInitialPageId);
      setIsInitialPageResolved(true);
      markResolvedOnce();
      return;
    }

    let isCancelled = false;
    setIsInitialPageResolved(false);

    fetchPageDetails(requestedInitialPageId)
      .then((page) => {
        if (isCancelled) return;
        const rawChapterId =
          (page as any)?.chapterId ?? (page as any)?.chapter?.id ?? undefined;
        const chapterIndex = isValidId(rawChapterId)
          ? chapterIdByIndex.indexOf(rawChapterId)
          : -1;
        if (chapterIndex >= 0 && pageSkeletons[chapterIndex]) {
          setResolvedInitialPageId(pageSkeletons[chapterIndex].id);
        } else {
          setResolvedInitialPageId(fallbackPageId);
        }
      })
      .catch(() => {
        if (isCancelled) return;
        setResolvedInitialPageId(fallbackPageId);
      })
      .finally(() => {
        if (isCancelled) return;
        setIsInitialPageResolved(true);
        markResolvedOnce();
      });

    return () => {
      isCancelled = true;
    };
  }, [
    bookId,
    isRequestedPageIdPending,
    requestedInitialPageId,
    pageSkeletons,
    chapterEntryPageIds,
    chapterIdByIndex,
    fetchPageDetails,
  ]);

  const handleReaderPageNotFound = useCallback((): void => {
    logLifecycleEvent('navigation_error', {
      where: 'BookReaderScreen',
      reason: 'chapter_navigation_page_not_found',
      bookId,
    });
  }, [bookId]);

  const bookChaptersCount = currentBook?.chapters?.length ?? 0;
  const chapterContentSignal = useChapterContentVersionsForIds(chapterIdByIndex);

  const chapterPages: ReaderPage[] = useMemo(() => {
    return pageSkeletons.map((skeleton, idx) => {
      const chapterId = chapterIdByIndex[idx];
      const loaded = chapterId !== undefined ? getChapterContent(chapterId) : undefined;
      if (!loaded) return skeleton;

      return {
        ...skeleton,
        content: loaded.content,
        title: loaded.title,
        boldIndices: loaded.boldIndices,
        phraseOverrides: loaded.phraseOverrides ?? null,
        imageUrl: loaded.imageUrl ?? skeleton.imageUrl,
      };
    });
  }, [pageSkeletons, chapterIdByIndex, getChapterContent, chapterContentSignal]);

  const { localHighlights, handleSaveHighlight, handleRemoveHighlight } = useHighlights({
    bookId,
    fetchAllHighlightsForBook,
    addHighlight,
    removeHighlight,
  });

  const {
    selectedPhrase,
    wordDetails,
    isLoadingTranslation,
    isAdded,
    isRemoving,
    highlightMenuCoords,
    setHighlightMenuCoords,
    isSelectionMode,
    setIsSelectionMode,
    slideAnim,
    fadeAnim,
    handleClearSelection,
    clearPhraseState,
    handleWordPress,
    handleWordLongPress,
    handleSentenceSelect,
    handleAddWord,
    handleRemoveWord,
    surfaceText,
    surfaceTranslation,
    verbForms,
    isReported,
    handleReportWord,
    handleRetryTranslation,
    selectionSnapshot,
    restoreSelection,
  } = usePhraseSelection({
    setIsFontMenuVisible,
    dispatch,
    bookId: isValidId(bookId) ? bookId : undefined,
    bookTitle: currentBook?.title,
  });

  const combinedClearSelection = handleClearSelection;

  const markPageAsReadWrapper = useCallback(
    (bId: number, pId: number) => {
      syncPageProgress(bId, pId, 0);
    },
    [syncPageProgress],
  );

  const {
    listRef,
    displayIndex,
    pageWidth,
    onContainerLayout,
    getItemLayout,
    initialScrollIndex,
    onMomentumScrollEnd,
    onScrollEndDrag,
    goToPageId,
    navigationEpoch,
    getExplicitTargetPageId,
  } = useReaderNavigation({
    bookId,
    chapterPages,
    requestedPageId: resolvedInitialPageId,
    onNotFound: handleReaderPageNotFound,
    onPageChange,
    markPageAsRead: markPageAsReadWrapper,
    stop,
    clearSelection: combinedClearSelection,
  });

  const currentPageId: number | undefined = chapterPages[displayIndex]?.id;

  // Виділення і відкрита картка перекладу переживають вихід із книги
  // (перехід у Словник і назад): зберігаються разом зі сторінкою і
  // відновлюються, щойно ця сторінка знову на екрані.
  useReaderSelectionPersistence({
    bookId: isValidId(bookId) ? bookId : undefined,
    currentPageId,
    snapshot: selectionSnapshot,
    restoreSelection,
  });

  const currentPageIdRef = useRef<number | undefined>(currentPageId);
  currentPageIdRef.current = currentPageId;

  const overlappingHighlightForSelection = useMemo((): BackHighlight | null => {
    if (!selectedPhrase || selectedPhrase.type !== 'sentence' || currentPageId === undefined) {
      return null;
    }
    const pageHighlights: BackHighlight[] = localHighlights[currentPageId] || EMPTY_HIGHLIGHTS;
    return (
      pageHighlights.find(
        (h) => selectedPhrase.startIdx <= h.endIndex && selectedPhrase.endIdx >= h.startIndex,
      ) || null
    );
  }, [selectedPhrase, currentPageId, localHighlights]);

  const handleRemoveHighlightFromColorPanel = useCallback(async (): Promise<void> => {
    if (!overlappingHighlightForSelection || currentPageId === undefined) return;
    const { startIndex, endIndex } = overlappingHighlightForSelection;
    clearPhraseState();
    setHighlightMenuCoords(null);
    await handleRemoveHighlight(currentPageId, startIndex, endIndex);
  }, [
    overlappingHighlightForSelection,
    currentPageId,
    clearPhraseState,
    setHighlightMenuCoords,
    handleRemoveHighlight,
  ]);

  useEffect(() => {
    const currentChapterId = chapterIdByIndex[displayIndex];
    if (currentChapterId === undefined) return;

    ensureChapterContent(currentChapterId);
    const neighborIndices = [displayIndex - 1, displayIndex + 1];
    const neighborIds = neighborIndices
      .map((idx) => chapterIdByIndex[idx])
      .filter((id): id is number => id !== undefined);

    if (neighborIds.length > 0) {
      prefetchChapters(neighborIds);
    }
  }, [displayIndex, chapterIdByIndex, ensureChapterContent, prefetchChapters]);

  const appStateHandlerDataRef = useRef({
    bookId,
    displayIndex,
    chapterIdByIndex,
    getChapterContent,
    isChapterLoading,
    ensureChapterContent,
    fetchProgress,
    loadLastPositions,
    isFocused,
    flushLatestScrollProgress: () => {},
    flushPendingProgress: (_bookId: number) => {},
  });

  appStateHandlerDataRef.current.bookId = bookId;
  appStateHandlerDataRef.current.displayIndex = displayIndex;
  appStateHandlerDataRef.current.chapterIdByIndex = chapterIdByIndex;
  appStateHandlerDataRef.current.getChapterContent = getChapterContent;
  appStateHandlerDataRef.current.isChapterLoading = isChapterLoading;
  appStateHandlerDataRef.current.ensureChapterContent = ensureChapterContent;
  appStateHandlerDataRef.current.fetchProgress = fetchProgress;
  appStateHandlerDataRef.current.loadLastPositions = loadLastPositions;
  appStateHandlerDataRef.current.isFocused = isFocused;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const data = appStateHandlerDataRef.current;

      if (nextState === 'background' || nextState === 'inactive') {
        data.flushLatestScrollProgress();
        data.flushPendingProgress(data.bookId);
        flushReaderFontSize();
        return;
      }

      if (nextState !== 'active') return;
      if (!data.isFocused) return;

      const currentChapterId = data.chapterIdByIndex[data.displayIndex];
      if (currentChapterId === undefined) return;

      const hasContent = !!data.getChapterContent(currentChapterId);
      const stillLoading = data.isChapterLoading(currentChapterId);

      if (!hasContent && !stillLoading) {
        data.ensureChapterContent(currentChapterId, true);
      }

      data.fetchProgress(data.bookId);
      data.loadLastPositions(data.bookId);
    });

    return () => subscription.remove();
  }, []);

  const hasSkippedInitialFocusEffectRef = useRef(false);
  useEffect(() => {
    if (!hasSkippedInitialFocusEffectRef.current) {
      hasSkippedInitialFocusEffectRef.current = true;
      return;
    }
    const data = appStateHandlerDataRef.current;
    if (!isFocused) {
      // Пішли на іншу вкладку, а книга лишилась відкритою: зберігаємо те саме,
      // що й при закритті читалки.
      stopRef.current();
      data.flushLatestScrollProgress();
      data.flushPendingProgress(data.bookId);
      flushReaderFontSize();
      return;
    }

    const currentChapterId = data.chapterIdByIndex[data.displayIndex];
    if (currentChapterId === undefined) return;

    const hasContent = !!data.getChapterContent(currentChapterId);
    const stillLoading = data.isChapterLoading(currentChapterId);

    if (!hasContent && !stillLoading) {
      data.ensureChapterContent(currentChapterId, true);
    }

    data.fetchProgress(data.bookId);
    data.loadLastPositions(data.bookId);
  }, [isFocused]);

  const {
    formattedBookmarks,
    totalBookmarksCount,
    currentPageInfoPath,
    handleSaveBookmark,
    handleNavigateToBookmark,
    handleDeleteBookmark,
  } = useBookmarks({
    bookId,
    currentBook,
    myBookmarks,
    fetchMyBookmarks,
    setBookmark,
    removeBookmark,
    chapterPages,
    displayIndex,
    goToPageId,
    onOpenOtherBook: onOpenBook,
  });

  const { scrollProgressAnim, handleScrollProgress, flushLatestScrollProgress, progressTimeoutRef } =
    useScrollProgressSync({
      bookId,
      chapterPages,
      displayIndex,
      chapterIdByIndex,
      isChapterLoading,
      syncPageProgress,
      saveLastPosition,
    });

  appStateHandlerDataRef.current.flushLatestScrollProgress = flushLatestScrollProgress;
  appStateHandlerDataRef.current.flushPendingProgress = flushPendingProgress;

  const flushLatestScrollProgressRef = useRef(flushLatestScrollProgress);
  flushLatestScrollProgressRef.current = flushLatestScrollProgress;

  const getLastPositionRef = useRef(getLastPosition);
  getLastPositionRef.current = getLastPosition;

  useEffect(() => {
    if (!isValidId(bookId)) return undefined;

    const pointer = {
      bookId,
      level,
      getSnapshot: () => {
        const pageId = currentPageIdRef.current;
        if (!isValidId(pageId)) return null;
        flushLatestScrollProgressRef.current();
        return { pageId };
      },
    };

    registerLiveBookReaderPointer(pointer);

    return () => {
      unregisterLiveBookReaderPointer(pointer);
    };
  }, [bookId, level]);

  const prevDisplayIndexRef = useRef<number>(displayIndex);

  useEffect(() => {
    if (prevDisplayIndexRef.current !== displayIndex) {
      flushLatestScrollProgress();
      prevDisplayIndexRef.current = displayIndex;
    }
  }, [displayIndex, flushLatestScrollProgress]);

  useEffect(() => {
    return () => {
      stop();
      flushLatestScrollProgress();
      flushPendingProgress(bookId);
      flushReaderFontSize();
      if (progressTimeoutRef.current) clearTimeout(progressTimeoutRef.current);
      if (fontSizeDebounceTimerRef.current) clearTimeout(fontSizeDebounceTimerRef.current);
    };
  }, [stop, flushLatestScrollProgress, flushPendingProgress, bookId]);

  useEffect(() => {
    Animated.timing(scrollProgressAnim, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [displayIndex, scrollProgressAnim]);

  const contentFadeAnim = useRef(new Animated.Value(0)).current;
  const activePageContent = chapterPages[displayIndex]?.content;

  const isBaseDataReady =
    chapterPages.length > 0 &&
    isInitialPageResolved &&
    isLastPositionsReady &&
    isFontSizeReady &&
    isHeightCalibrationReady;

  const [isStalled, setIsStalled] = useState<boolean>(false);

  useEffect(() => {
    setIsStalled(false);
    if (isBaseDataReady) return;

    const timer = setTimeout(() => {
      setIsStalled(true);
    }, BASE_DATA_STALL_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [isBaseDataReady, bookId]);

  const stallFiredRef = useRef(false);
  useEffect(() => {
    stallFiredRef.current = false;
  }, [bookId]);

  const [hasInitiallyLoaded, setHasInitiallyLoaded] = useState(false);

  const hasInitiallyLoadedRef = useRef(false);
  useEffect(() => {
    hasInitiallyLoadedRef.current = hasInitiallyLoaded;
  }, [hasInitiallyLoaded]);

  useEffect(() => {
    if (isStalled && !stallFiredRef.current && !hasInitiallyLoadedRef.current) {
      stallFiredRef.current = true;
      onNotFoundRef.current();
    }
  }, [isStalled]);

  useEffect(() => {
    if (hasInitiallyLoaded) return;
    if (isBaseDataReady && !!activePageContent) {
      setHasInitiallyLoaded(true);
    }
  }, [isBaseDataReady, activePageContent, hasInitiallyLoaded]);

  useEffect(() => {
    if (hasInitiallyLoaded) return;
    if (!isInitialPageResolved) return;
    if (!isFontSizeReady) return;

    const timer = setTimeout(() => {
      setHasInitiallyLoaded(true);
    }, 4000);
    return () => clearTimeout(timer);
  }, [hasInitiallyLoaded, isInitialPageResolved, isFontSizeReady]);

  useEffect(() => {
    if (hasInitiallyLoaded) {
      Animated.timing(contentFadeAnim, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [hasInitiallyLoaded, contentFadeAnim]);

  const { isSwipeHintVisible, dismissSwipeHint } = useSwipePageHint({
    hasInitiallyLoaded,
    bookChaptersCount,
    displayIndex,
  });

  const handleCloseBook = useCallback((): void => {
    stop();
    flushLatestScrollProgress();
    flushPendingProgress(bookId);
    flushReaderFontSize();
    clearBookReaderQuickSession();
    onBackRef.current();
  }, [stop, flushLatestScrollProgress, flushPendingProgress, bookId]);

  const openBookmarksMenu = useCallback((): void => setIsBookmarksVisible(true), []);
  const toggleFontMenu = useCallback((): void => setIsFontMenuVisible((v) => !v), []);
  const closeFontMenu = useCallback((): void => setIsFontMenuVisible(false), []);

  const onSaveHighlightForCurrentPage = useCallback(
    async (color: string): Promise<void> => {
      if (!selectedPhrase || !chapterPages[displayIndex]) return;
      const pageIdForHighlight = chapterPages[displayIndex].id;
      const { text, startIdx, endIdx } = selectedPhrase;

      clearPhraseState();
      setHighlightMenuCoords(null);
      await handleSaveHighlight(pageIdForHighlight, { text, startIdx, endIdx }, color);
    },
    [
      selectedPhrase,
      chapterPages,
      displayIndex,
      handleSaveHighlight,
      clearPhraseState,
      setHighlightMenuCoords,
    ],
  );

  const getSelectedPhraseText = useCallback((): string => {
    return selectedPhrase?.text ?? '';
  }, [selectedPhrase]);

  const pageRefsMap = useRef<Map<number, ReaderPageItemHandle>>(new Map());

  const registerPageRef = useCallback((pageId: number, instance: ReaderPageItemHandle | null) => {
    if (instance) pageRefsMap.current.set(pageId, instance);
    else pageRefsMap.current.delete(pageId);
  }, []);

  // 🟢 Автоскрол при тапі на слово: панель перекладу не має закривати
  // натиснуте слово / фразу. Сторінка рахує ціль сама за реальною позицією
  // слова і реальною висотою панелі; коли переклад завантажився і панель
  // стала вищою — доводимо ще трохи (лише вниз, без стрибків назад).
  const sheetHeightRef = useRef(0);
  const activeRevealRef = useRef<{ pageId: number; indices: number[]; at: number } | null>(null);

  const revealOnPage = useCallback((pageId: number, indices: number[]) => {
    const covered = Math.max(sheetHeightRef.current, SHEET_HEIGHT_ESTIMATE);
    pageRefsMap.current.get(pageId)?.revealIndices(indices, covered);
  }, []);

  const handleWordPressWithAutoScroll = useCallback(
    (chunks: string[], clickedIndex: number, eventX: number, eventY: number, precomputedMatch: unknown) => {
      handleWordPress(chunks, clickedIndex, eventX, eventY, precomputedMatch as any);

      const pageId = currentPageIdRef.current;
      if (pageId === undefined) return;
      const match = precomputedMatch as { exactIndicesToHighlight?: number[] } | null;
      const indices =
        Array.isArray(match?.exactIndicesToHighlight) && match!.exactIndicesToHighlight!.length > 0
          ? match!.exactIndicesToHighlight!
          : [clickedIndex];
      activeRevealRef.current = { pageId, indices, at: Date.now() };
      revealOnPage(pageId, indices);
    },
    [handleWordPress, revealOnPage],
  );

  const handleSheetLayout = useCallback(
    (height: number) => {
      if (!(height > 0) || Math.abs(height - sheetHeightRef.current) < 1) return;
      sheetHeightRef.current = height;
      const active = activeRevealRef.current;
      if (!active || Date.now() - active.at > REVEAL_FOLLOW_UP_MS) return;
      if (active.pageId !== currentPageIdRef.current) return;
      revealOnPage(active.pageId, active.indices);
    },
    [revealOnPage],
  );

  useEffect(() => {
    if (!selectedPhrase || selectedPhrase.type !== 'word') activeRevealRef.current = null;
  }, [selectedPhrase]);

  const lastPositionsRef = useRef(lastPositions);
  lastPositionsRef.current = lastPositions;

  const explicitTargetRef = useRef<() => number | null>(getExplicitTargetPageId);
  explicitTargetRef.current = getExplicitTargetPageId;

  useEffect(() => {
    if (navigationEpoch === 0) return;
    const pageId = explicitTargetRef.current();
    if (pageId === null) return;

    const saved = lastPositionsRef.current[String(pageId)];
    if (typeof saved !== 'number' || saved <= 0) return;

    const progress = Math.min(1, Math.max(0, saved / 100));
    const frame = requestAnimationFrame(() => {
      pageRefsMap.current.get(pageId)?.scrollToProgress(progress);
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationEpoch]);

  // Позиція readerContainer у вікні. HighlightActionMenu рендериться всередині
  // readerContainer і позиціонується через absolute-координати, але pageX/pageY
  // та measureInWindow дають ВІКОННІ координати. На iPhone/Android корінь
  // застосунку має paddingTop = safe-area, тож readerContainer зсунутий вниз
  // відносно вікна — віднімаємо цей зсув, щоб меню ставало точно над текстом.
  const readerContainerRef = useRef<View>(null);
  const readerContainerOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const measureReaderContainer = useCallback(() => {
    requestAnimationFrame(() => {
      readerContainerRef.current?.measureInWindow((x, y) => {
        if (x !== undefined && y !== undefined) {
          readerContainerOffsetRef.current = { x, y };
        }
      });
    });
  }, []);

  const { progressBarRef, measureProgressBar, scrubActiveAnim, progressBarPanResponder } = useProgressScrubber({
    chapterPages,
    displayIndex,
    scrollProgressAnim,
    pageRefsMap,
    setIsFontMenuVisible,
    clearSelection: combinedClearSelection,
  });

  const keyExtractor = useCallback((item: ReaderPage) => String(item.id), []);

  const renderItem = useCallback(
    ({ item, index }: { item: ReaderPage; index: number }) => {
      if (!item) return null;

      const currentHighlights = localHighlights[item.id] || EMPTY_HIGHLIGHTS;
      const chapterId = chapterIdByIndex[index];
      const contentIsLoading = chapterId !== undefined ? isChapterLoading(chapterId) : false;
      const contentIsEmpty = !item.content;

      const isExplicitNavigationTarget = item.id === explicitTargetRef.current();
      const savedLastPosition = isExplicitNavigationTarget
        ? lastPositionsRef.current[String(item.id)]
        : undefined;
      const initialScrollProgress =
        typeof savedLastPosition === 'number'
          ? Math.min(1, Math.max(0, savedLastPosition / 100))
          : 0;

      return (
        <ReaderPageItem
          ref={(instance) => registerPageRef(item.id, instance)}
          item={item}
          width={pageWidth}
          fontSize={fontSize}
          selectedPhrase={selectedPhrase}
          pageHighlights={currentHighlights}
          isContentLoading={contentIsLoading || contentIsEmpty}
          initialScrollProgress={initialScrollProgress}
          onWordPress={handleWordPressWithAutoScroll}
          onWordLongPress={handleWordLongPress}
          onSentenceSelect={handleSentenceSelect}
          onSelectionModeChange={setIsSelectionMode}
          onEmptyPress={combinedClearSelection}
          onScrollBeginDrag={closeFontMenu}
          onScrollProgress={handleScrollProgress}
        />
      );
    },
    [
      pageWidth,
      fontSize,
      selectedPhrase,
      localHighlights,
      chapterIdByIndex,
      isChapterLoading,
      handleWordPressWithAutoScroll,
      handleWordLongPress,
      handleSentenceSelect,
      combinedClearSelection,
      closeFontMenu,
      setIsSelectionMode,
      handleScrollProgress,
      registerPageRef,
    ],
  );

  const listExtraData = useMemo(
    () => ({
      fontSize,
      selectedPhrase,
      localHighlights,
      chapterPages,
      navigationEpoch,
    }),
    [fontSize, selectedPhrase, localHighlights, chapterPages, navigationEpoch],
  );

  if (!hasInitiallyLoaded) {
    return <PreloaderAnim />;
  }

  return (
    <Animated.View
      ref={readerContainerRef}
      onLayout={measureReaderContainer}
      style={[stylesReader.readerContainer, { opacity: contentFadeAnim }]}
    >
      <ReaderHeaderBar
        title={chapterPages[displayIndex]?.chapterTitle || ''}
        onBack={handleCloseBook}
        onBookmarkPress={openBookmarksMenu}
        onDotsPress={toggleFontMenu}
        bookmarkButtonRef={bookmarkButtonRef}
        dotsButtonRef={dotsButtonRef}
      />

      <View style={stylesReader.sliderWrapper} ref={contentAreaRef} onLayout={onContainerLayout}>
        {isFontMenuVisible && (
          <FontSizePanel
            fontSize={fontSize}
            onDecrease={decreaseFontSize}
            onIncrease={increaseFontSize}
            onClose={closeFontMenu}
            panelRef={fontPanelAreaRef}
          />
        )}

        {pageWidth > 0 && (
          <FlatList<ReaderPage>
            ref={listRef}
            data={chapterPages}
            extraData={listExtraData}
            horizontal
            pagingEnabled
            snapToInterval={pageWidth}
            disableIntervalMomentum
            decelerationRate="fast"
            scrollEnabled={!isSelectionMode && chapterPages.length > 1}
            showsHorizontalScrollIndicator={false}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            initialNumToRender={READER_INITIAL_NUM_TO_RENDER}
            maxToRenderPerBatch={READER_MAX_TO_RENDER_PER_BATCH}
            windowSize={READER_WINDOW_SIZE}
            removeClippedSubviews={REMOVE_CLIPPED_SUBVIEWS}
            getItemLayout={getItemLayout}
            initialScrollIndex={initialScrollIndex}
            onMomentumScrollEnd={onMomentumScrollEnd}
            onScrollEndDrag={onScrollEndDrag}
            onScrollBeginDrag={dismissSwipeHint}
            bounces={false}
            overScrollMode="never"
          />
        )}

        <SwipePageHint visible={isSwipeHintVisible} />

        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            opacity: fadeAnim,
            zIndex: 500,
          }}
        />

        <TranslationBottomSheet
          selectedPhrase={selectedPhrase?.type === 'word' ? selectedPhrase : null}
          wordDetails={wordDetails}
          isLoadingTranslation={isLoadingTranslation}
          isAdded={isAdded}
          isRemoving={isRemoving}
          slideAnim={slideAnim}
          fadeAnim={fadeAnim}
          onSpeak={(text) => {
            if (!text) return;
            speak(text);
          }}
          onAddWord={handleAddWord}
          onRemoveWord={handleRemoveWord}
          onClose={combinedClearSelection}
          surfaceText={surfaceText}
          surfaceTranslation={surfaceTranslation}
          verbForms={verbForms}
          isReported={isReported}
          onReport={handleReportWord}
          onRetry={handleRetryTranslation}
          onSheetLayout={handleSheetLayout}
        />
      </View>

      {selectedPhrase && selectedPhrase.type === 'sentence' && highlightMenuCoords && (
        <HighlightActionMenu
          coords={highlightMenuCoords}
          containerOffset={readerContainerOffsetRef.current}
          onColorSelect={onSaveHighlightForCurrentPage}
          onCopyText={getSelectedPhraseText}
          onRemove={overlappingHighlightForSelection ? handleRemoveHighlightFromColorPanel : undefined}
        />
      )}

      <BookmarksMenu
        visible={isBookmarksVisible}
        setVisible={setIsBookmarksVisible}
        mode="edit"
        currentPageTitle={
          chapterPages[displayIndex]?.chapterTitle
            ? `${chapterPages[displayIndex].chapterTitle}`
            : 'Невідомий розділ'
        }
        currentPageBookTitle={chapterPages[displayIndex]?.bookTitle ?? ''}
        currentPagePath={currentPageInfoPath}
        savedBookmarks={formattedBookmarks}
        totalBookmarksCount={totalBookmarksCount}
        onSaveBookmark={handleSaveBookmark}
        onNavigateToBookmark={handleNavigateToBookmark}
        onDeleteBookmark={handleDeleteBookmark}
      />

      <ReaderProgressBar
        barRef={progressBarRef}
        onLayout={measureProgressBar}
        panHandlers={progressBarPanResponder.panHandlers}
        scrollProgressAnim={scrollProgressAnim}
        scrubActiveAnim={scrubActiveAnim}
      />
    </Animated.View>
  );
};
