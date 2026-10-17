import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const HINT_KEY_PREFIX = '@discovery_hint_seen6:';

export const useDiscoveryHint = (hintKey: string) => {
  const [shouldShowHint, setShouldShowHint] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    AsyncStorage.getItem(`${HINT_KEY_PREFIX}${hintKey}`)
      .then((value) => {
        if (isMountedRef.current && value !== 'true') {
          setShouldShowHint(true);
        }
      })
      .catch(() => {
        if (isMountedRef.current) {
          setShouldShowHint(false);
        }
      });

    return () => {
      isMountedRef.current = false;
    };
  }, [hintKey]);

  const markSeen = useCallback(() => {
    if (isMountedRef.current) {
      setShouldShowHint(false);
    }
    AsyncStorage.setItem(`${HINT_KEY_PREFIX}${hintKey}`, 'true').catch(() => {});
  }, [hintKey]);

  return { shouldShowHint, markSeen };
};