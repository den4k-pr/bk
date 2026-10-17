import { useState, useRef, useCallback } from 'react';

const LONG_PRESS_MS = 250; // Зроблено трохи швидшим для кращого відчуття
const HOLD_MOVE_THRESHOLD = 8;
const DOUBLE_TAP_DELAY = 300; // Час між тапами для подвійного кліку

export const useTextSelection = () => {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const selectionModeRef = useRef(false);

  const setSelection = useCallback((val: boolean) => {
    selectionModeRef.current = val;
    setSelectionMode(val);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelection(false);
    setSelectedText('');
  }, [setSelection]);

  const updateSelected = useCallback((text: string) => {
    setSelectedText(text);
  }, []);

  const clearSelected = useCallback(() => {
    setSelectedText('');
  }, []);

  // Таймери та змінні для жестів
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpMoved = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  
  // Для Double Tap
  const lastTap = useRef<number | null>(null);

  const onTouchStart = useCallback((e: any) => {
    if (selectionModeRef.current) return; 

    const now = Date.now();
    const t = e.nativeEvent.touches?.[0] ?? e.nativeEvent;
    
    // Перевірка на Double Tap
    if (lastTap.current && (now - lastTap.current) < DOUBLE_TAP_DELAY) {
      setSelection(true);
      if (lpTimer.current) clearTimeout(lpTimer.current);
      return;
    }
    
    lastTap.current = now;
    lpStart.current = { x: t.pageX, y: t.pageY };
    lpMoved.current = false;

    lpTimer.current = setTimeout(() => {
      if (!lpMoved.current) {
        setSelection(true);
      }
    }, LONG_PRESS_MS);
  }, [setSelection]);

  const onTouchMove = useCallback((e: any) => {
    if (!lpStart.current || selectionModeRef.current) return;
    const t = e.nativeEvent.touches?.[0] ?? e.nativeEvent;
    const dx = Math.abs(t.pageX - lpStart.current.x);
    const dy = Math.abs(t.pageY - lpStart.current.y);
    
    if (dx > HOLD_MOVE_THRESHOLD || dy > HOLD_MOVE_THRESHOLD) {
      lpMoved.current = true;
      if (lpTimer.current) {
        clearTimeout(lpTimer.current);
        lpTimer.current = null;
      }
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (lpTimer.current) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  }, []);

  return {
    selectionMode,
    selectionModeRef,
    selectedText,
    exitSelectionMode,
    updateSelected,
    clearSelected,
    textTouchHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
  };
};