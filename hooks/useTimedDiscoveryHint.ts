import { useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TIMED_HINT_KEY_PREFIX = '@timed_discovery_hint:';

export const useTimedDiscoveryHint = (hintKey: string, ttlMs: number) => {
  const [shouldShowHint, setShouldShowHint] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    const storageKey = `${TIMED_HINT_KEY_PREFIX}${hintKey}`;

    AsyncStorage.getItem(storageKey)
      .then((value) => {
        if (!isMountedRef.current) return;

        const lastShownAt = value ? parseInt(value, 10) : 0;
        const now = Date.now();

        if (Number.isNaN(lastShownAt) || now - lastShownAt >= ttlMs) {
          setShouldShowHint(true);
          AsyncStorage.setItem(storageKey, String(now)).catch(() => {});
        }
      })
      .catch(() => {});

    return () => {
      isMountedRef.current = false;
    };
  }, [hintKey, ttlMs]);

  const dismissHint = () => setShouldShowHint(false);

  return { shouldShowHint, dismissHint };
};