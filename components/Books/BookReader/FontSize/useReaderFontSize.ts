import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  peekReaderFontSize,
  hydrateReaderFontSize,
  setReaderFontSize,
} from './readerFontSize';
import { preloadHeightCalibration } from '../Page/heightCalibration';

const FONT_SIZE_DEBOUNCE_MS = 120;

export function useReaderFontSize() {
  const [fontSize, setFontSize] = useState<number>(
    () => peekReaderFontSize() ?? DEFAULT_FONT_SIZE,
  );
  const [isFontSizeReady, setIsFontSizeReady] = useState<boolean>(
    () => peekReaderFontSize() !== null,
  );
  const [isHeightCalibrationReady, setIsHeightCalibrationReady] = useState<boolean>(false);

  const pendingFontSizeRef = useRef<number>(fontSize);
  const fontSizeDebounceTimerRef = useRef<any>(null);

  useEffect(() => {
    pendingFontSizeRef.current = fontSize;
  }, [fontSize]);

  useEffect(() => {
    if (isFontSizeReady) return;

    let isMounted = true;
    hydrateReaderFontSize().then((resolved) => {
      if (!isMounted) return;
      setFontSize(resolved);
      pendingFontSizeRef.current = resolved;
      setIsFontSizeReady(true);
    });

    return () => {
      isMounted = false;
    };
  }, [isFontSizeReady]);

  useEffect(() => {
    if (!isFontSizeReady) return;
    let isMounted = true;
    preloadHeightCalibration(fontSize).finally(() => {
      if (isMounted) setIsHeightCalibrationReady(true);
    });
    return () => {
      isMounted = false;
    };
  }, [isFontSizeReady, fontSize]);

  const changeFontSize = useCallback((type: 'increase' | 'decrease'): void => {
    const current = pendingFontSizeRef.current;
    const desired = type === 'increase' ? current + FONT_SIZE_STEP : current - FONT_SIZE_STEP;

    const applied = setReaderFontSize(desired);
    if (applied === current) return;

    pendingFontSizeRef.current = applied;

    if (fontSizeDebounceTimerRef.current) clearTimeout(fontSizeDebounceTimerRef.current);
    fontSizeDebounceTimerRef.current = setTimeout(() => {
      setFontSize(pendingFontSizeRef.current);
    }, FONT_SIZE_DEBOUNCE_MS);
  }, []);

  const decreaseFontSize = useCallback(() => changeFontSize('decrease'), [changeFontSize]);
  const increaseFontSize = useCallback(() => changeFontSize('increase'), [changeFontSize]);

  return {
    fontSize,
    isFontSizeReady,
    isHeightCalibrationReady,
    fontSizeDebounceTimerRef,
    decreaseFontSize,
    increaseFontSize,
  };
}
