import { useCallback, useRef } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import { ReaderPage } from '../../../../types/books';
import { ReaderPageItemHandle } from '../Page/ReaderPageItem';
import { SCREEN_WIDTH } from '../BookReader.constants';

interface UseProgressScrubberParams {
  chapterPages: ReaderPage[];
  displayIndex: number;
  scrollProgressAnim: Animated.Value;
  pageRefsMap: React.MutableRefObject<Map<number, ReaderPageItemHandle>>;
  setIsFontMenuVisible: (visible: boolean) => void;
  clearSelection: () => void;
}

export function useProgressScrubber({
  chapterPages,
  displayIndex,
  scrollProgressAnim,
  pageRefsMap,
  setIsFontMenuVisible,
  clearSelection,
}: UseProgressScrubberParams) {
  const progressBarRef = useRef<View>(null);
  const progressBarMetricsRef = useRef<{ x: number; width: number }>({ x: 0, width: SCREEN_WIDTH });

  const measureProgressBar = useCallback(() => {
    requestAnimationFrame(() => {
      progressBarRef.current?.measureInWindow((x, _y, width) => {
        if (width > 0) {
          progressBarMetricsRef.current = { x, width };
        }
      });
    });
  }, []);

  const scrubActiveAnim = useRef(new Animated.Value(0)).current;

  const handleScrubStart = useCallback(() => {
    setIsFontMenuVisible(false);
    clearSelection();
    Animated.spring(scrubActiveAnim, {
      toValue: 1,
      friction: 7,
      tension: 90,
      useNativeDriver: false,
    }).start();
  }, [clearSelection, scrubActiveAnim]);

  const handleScrubEnd = useCallback(() => {
    Animated.spring(scrubActiveAnim, {
      toValue: 0,
      friction: 8,
      tension: 90,
      useNativeDriver: false,
    }).start();
  }, [scrubActiveAnim]);

  const computeProgressFromPageX = useCallback((pageX: number): number => {
    const { x, width } = progressBarMetricsRef.current;
    if (width <= 0) return 0;
    const clampedX = Math.min(Math.max(pageX - x, 0), width);
    return clampedX / width;
  }, []);

  const applyScrubProgress = useCallback(
    (progress: number) => {
      scrollProgressAnim.setValue(progress);
      const activePageId = chapterPages[displayIndex]?.id;
      if (activePageId === undefined) return;
      const pageRef = pageRefsMap.current.get(activePageId);
      pageRef?.scrollToProgress(progress);
    },
    [chapterPages, displayIndex, scrollProgressAnim],
  );

  const latestScrubRef = useRef({
    computeProgressFromPageX,
    applyScrubProgress,
    handleScrubStart,
    handleScrubEnd,
  });
  latestScrubRef.current = {
    computeProgressFromPageX,
    applyScrubProgress,
    handleScrubStart,
    handleScrubEnd,
  };

  const progressBarPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onShouldBlockNativeResponder: () => true,

      onPanResponderGrant: (evt) => {
        const { handleScrubStart: start, applyScrubProgress: apply, computeProgressFromPageX: compute } =
          latestScrubRef.current;
        start();
        apply(compute(evt.nativeEvent.pageX));
      },

      onPanResponderMove: (evt) => {
        const { applyScrubProgress: apply, computeProgressFromPageX: compute } = latestScrubRef.current;
        apply(compute(evt.nativeEvent.pageX));
      },

      onPanResponderRelease: (evt) => {
        const {
          applyScrubProgress: apply,
          computeProgressFromPageX: compute,
          handleScrubEnd: end,
        } = latestScrubRef.current;
        apply(compute(evt.nativeEvent.pageX));
        end();
      },

      onPanResponderTerminate: () => {
        latestScrubRef.current.handleScrubEnd();
      },
    }),
  ).current;

  return { progressBarRef, measureProgressBar, scrubActiveAnim, progressBarPanResponder };
}
