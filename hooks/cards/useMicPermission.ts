

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  checkAudioPermission,
  requestAudioPermission,
  openAppSettings,
  type MicPermission,
} from '../../components/Cards/Microphone/requestAudioPermission';

export const useMicPermission = (enabled: boolean = true) => {
  // null = ще не перевіряли (перший рендер, нічого не показуємо).
  const [status, setStatus] = useState<MicPermission | null>(null);
  const isMounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await checkAudioPermission();
    if (isMounted.current) {
      setStatus(next);
    }
    return next;
  }, []);

  /**
   * Повний сценарій для натискання кнопки мікрофона:
   * якщо дозвіл ще можна запитати — показуємо системний діалог,
   * інакше просто повертаємо поточний стан.
   */
  const ensurePermission = useCallback(async (): Promise<MicPermission> => {
    let current = await checkAudioPermission();

    if (current === 'denied') {
      current = await requestAudioPermission();
    }

    if (isMounted.current) {
      setStatus(current);
    }
    return current;
  }, []);

  useEffect(() => {
    isMounted.current = true;

    if (!enabled) {
      return () => {
        isMounted.current = false;
      };
    }

    refresh();

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        refresh();
      }
    });

    return () => {
      isMounted.current = false;
      subscription.remove();
    };
  }, [enabled, refresh]);

  return {
    status,
    isGranted: status === 'granted',
    isBlocked: status === 'blocked',
    isUnavailable: status === 'unavailable',
    refresh,
    ensurePermission,
    openAppSettings,
  };
};