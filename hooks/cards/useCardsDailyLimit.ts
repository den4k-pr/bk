import { useCallback, useEffect, useRef, useState } from 'react';
import { DailyLimitStatus, getDailyLimitStatus } from '../../services/Dailylimitservice';
import { subscribeCardsWordAnswered } from '../../services/cardsLimitBus';

/**
 * Денний ліміт звичайних карток — окремий від Dictionary Cards (свій
 * лічильник на сервері, kind=cards). Рахує сервер; тут — показ:
 * статус на вході, +N одразу після завершення циклу (без очікування
 * сервера) і перевірка вичерпання. Преміум — unlimited, нічого не рахуємо.
 */
export const useCardsDailyLimit = () => {
  const [limitStatus, setLimitStatus] = useState<DailyLimitStatus | null>(null);
  const [limitStatusFailed, setLimitStatusFailed] = useState(false);
  const isMountedRef = useRef(true);

  const loadLimitStatus = useCallback(async () => {
    try {
      const status = await getDailyLimitStatus('cards');
      if (!isMountedRef.current) return;
      setLimitStatus(status);
      setLimitStatusFailed(false);
    } catch (e) {
      console.warn('[useCardsDailyLimit] не вдалося отримати ліміт:', e);
      if (isMountedRef.current) setLimitStatusFailed(true);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    loadLimitStatus();
    return () => {
      isMountedRef.current = false;
    };
  }, [loadLimitStatus]);

  useEffect(
    () =>
      subscribeCardsWordAnswered(count => {
        setLimitStatus(prev => {
          if (!prev || prev.unlimited) return prev;
          const current = Math.min(prev.current + count, prev.total);
          return { ...prev, current, remaining: Math.max(prev.total - current, 0) };
        });
      }),
    [],
  );

  const isLimitExhausted = !!limitStatus && !limitStatus.unlimited && limitStatus.remaining <= 0;

  return { limitStatus, limitStatusFailed, isLimitExhausted, loadLimitStatus };
};
