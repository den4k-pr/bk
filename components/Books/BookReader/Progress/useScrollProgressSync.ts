import { useCallback, useRef } from 'react';
import { Animated } from 'react-native';
import { ReaderPage } from '../../../../types/books';

const SCROLL_DWELL_MS = 3000;
const LOCAL_SCROLL_SAVE_THROTTLE_MS = 800;

interface UseScrollProgressSyncParams {
  bookId: number;
  chapterPages: ReaderPage[];
  displayIndex: number;
  chapterIdByIndex: (number | undefined)[];
  isChapterLoading: (chapterId: number) => boolean;
  syncPageProgress: (bookId: number, pageId: number, progress: number, isCompleted: boolean) => unknown;
  saveLastPosition: (bookId: number, pageId: number, progress: number) => unknown;
}

export function useScrollProgressSync({
  bookId,
  chapterPages,
  displayIndex,
  chapterIdByIndex,
  isChapterLoading,
  syncPageProgress,
  saveLastPosition,
}: UseScrollProgressSyncParams) {
  const progressTimeoutRef = useRef<any>(null);
  const latestScrollProgressRef = useRef<{ pageId: number; progress: number } | null>(null);
  const localSaveThrottleRef = useRef<{ pageId: number; lastSavedAt: number } | null>(null);

  const scrollProgressAnim = useRef(new Animated.Value(0)).current;

  const handleScrollProgress = useCallback(
    (pageId: number, progress: number) => {
      const activePageId = chapterPages[displayIndex]?.id;
      if (pageId !== activePageId) return;

      const activeChapterId = chapterIdByIndex[displayIndex];
      const stillLoading = activeChapterId !== undefined && isChapterLoading(activeChapterId);
      if (stillLoading) return;

      scrollProgressAnim.setValue(progress);
      latestScrollProgressRef.current = { pageId, progress };

      const now = Date.now();
      const throttleState = localSaveThrottleRef.current;
      const shouldSaveLocallyNow =
        !throttleState ||
        throttleState.pageId !== pageId ||
        now - throttleState.lastSavedAt >= LOCAL_SCROLL_SAVE_THROTTLE_MS;

      if (shouldSaveLocallyNow) {
        localSaveThrottleRef.current = { pageId, lastSavedAt: now };
        saveLastPosition(bookId, pageId, Math.round(progress * 100));
      }

      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current);
      }
      progressTimeoutRef.current = setTimeout(() => {
        const percentage = Math.round(progress * 100);
        syncPageProgress(bookId, pageId, percentage, false);
        saveLastPosition(bookId, pageId, percentage);
        localSaveThrottleRef.current = { pageId, lastSavedAt: Date.now() };
        latestScrollProgressRef.current = null;
      }, SCROLL_DWELL_MS);
    },
    [
      chapterPages,
      displayIndex,
      chapterIdByIndex,
      isChapterLoading,
      scrollProgressAnim,
      bookId,
      syncPageProgress,
      saveLastPosition,
    ],
  );

  const flushLatestScrollProgress = useCallback(() => {
    if (progressTimeoutRef.current) {
      clearTimeout(progressTimeoutRef.current);
      progressTimeoutRef.current = null;
    }
    const latest = latestScrollProgressRef.current;
    if (latest) {
      const percentage = Math.round(latest.progress * 100);
      syncPageProgress(bookId, latest.pageId, percentage, false);
      saveLastPosition(bookId, latest.pageId, percentage);
      localSaveThrottleRef.current = { pageId: latest.pageId, lastSavedAt: Date.now() };
      latestScrollProgressRef.current = null;
    }
  }, [bookId, syncPageProgress, saveLastPosition]);

  return { scrollProgressAnim, handleScrollProgress, flushLatestScrollProgress, progressTimeoutRef };
}
