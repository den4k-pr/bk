import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SWIPE_HINT_DISMISSED_STORAGE_KEY = '@reader_swipe_hint_dismissed';

interface UseSwipePageHintParams {
  hasInitiallyLoaded: boolean;
  bookChaptersCount: number;
  displayIndex: number;
}

export function useSwipePageHint({ hasInitiallyLoaded, bookChaptersCount, displayIndex }: UseSwipePageHintParams) {
  const [isSwipeHintVisible, setIsSwipeHintVisible] = useState<boolean>(false);
  const swipeHintCheckedRef = useRef<boolean>(false);

  useEffect(() => {
    if (
      !hasInitiallyLoaded ||
      bookChaptersCount <= 1 ||
      displayIndex !== 0 ||
      swipeHintCheckedRef.current
    ) {
      return;
    }

    swipeHintCheckedRef.current = true;
    let isMounted = true;

    AsyncStorage.getItem(SWIPE_HINT_DISMISSED_STORAGE_KEY)
      .then((value) => {
        if (isMounted && value !== '1') {
          setIsSwipeHintVisible(true);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [hasInitiallyLoaded, bookChaptersCount, displayIndex]);

  useEffect(() => {
    if (displayIndex !== 0) {
      setIsSwipeHintVisible((prev) => (prev ? false : prev));
    }
  }, [displayIndex]);

  const dismissSwipeHint = useCallback((): void => {
    setIsSwipeHintVisible((prev) => {
      if (!prev) return prev;
      AsyncStorage.setItem(SWIPE_HINT_DISMISSED_STORAGE_KEY, '1').catch(() => {});
      return false;
    });
  }, []);

  return { isSwipeHintVisible, dismissSwipeHint };
}
