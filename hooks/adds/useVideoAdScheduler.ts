import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../../store';
import { isInterstitialReady, useInterstitialAd } from './useInterstitialAd';

/**
 * Коли показувати повноекранну рекламу у відеоуроках стандартних курсів.
 *
 * Ідея — присутність без нав'язливості (а не "як на YouTube"):
 *  - рахується лише РЕАЛЬНО переглянутий час (секунди відтворення; перемотки
 *    й паузи не враховуються);
 *  - mid-roll: після 4–8 хв перегляду з моменту минулої реклами (поріг щоразу
 *    випадковий, тож показ не прив'язаний до "розкладу"); відео ставиться на
 *    паузу, після реклами продовжується з того ж місця. Не в перші 40 с
 *    ролика, не в останні 45 с і не в повноекранному режимі (відкладається);
 *  - pre-roll: при відкритті наступного уроку, якщо з минулої реклами вже
 *    переглянуто 2+ хв — з імовірністю 60 % (тобто "на рандомі").
 *    Перше відео сесії — завжди без реклами;
 *  - не частіше ніж раз на 3 хв і не більше 8 показів за годину;
 *  - показується лише вже завантажена реклама — відео ніколи не "висить"
 *    на паузі в очікуванні завантаження;
 *  - з активним Premium реклами немає.
 *
 * Стан спільний на всю сесію застосунку (між різними відео й курсами).
 */
const MID_ROLL_MIN_SEC = 4 * 60;
const MID_ROLL_MAX_SEC = 8 * 60;
const PRE_ROLL_MIN_WATCH_SEC = 2 * 60;
const PRE_ROLL_CHANCE = 0.6;
const MIN_GAP_MS = 3 * 60 * 1000;
const MAX_ADS_PER_HOUR = 8;
const MIN_POSITION_SEC = 40;
const END_GUARD_SEC = 45;
// Приріст часу між двома onProgress більший за це — перемотка, а не перегляд.
const MAX_PROGRESS_STEP_SEC = 3;

const randomThreshold = () => MID_ROLL_MIN_SEC + Math.random() * (MID_ROLL_MAX_SEC - MID_ROLL_MIN_SEC);

const session = {
  watchedSec: 0,
  threshold: randomThreshold(),
  shownAt: [] as number[],
};

const canShowByFrequency = (): boolean => {
  const now = Date.now();
  session.shownAt = session.shownAt.filter(time => now - time < 60 * 60 * 1000);
  const last = session.shownAt[session.shownAt.length - 1];
  if (last && now - last < MIN_GAP_MS) return false;
  return session.shownAt.length < MAX_ADS_PER_HOUR;
};

export const useVideoAdScheduler = () => {
  const isPremium = useSelector((state: RootState) => state.premiumStatus.isPremium);
  // Хук реклами також заздалегідь підвантажує оголошення, поки відкрито плеєр.
  const { showLoadedAdAndWait } = useInterstitialAd();

  const [isAdShowing, setIsAdShowing] = useState(false);
  const busyRef = useRef(false);
  const fullscreenRef = useRef(false);
  const lastTimeRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const runAd = useCallback(async () => {
    if (busyRef.current) return;
    if (!isInterstitialReady()) {
      // Не готова: showLoadedAdAndWait лише запускає завантаження (з паузою
      // між невдалими спробами — див. useInterstitialAd) і одразу повертає false.
      showLoadedAdAndWait().catch(() => {});
      return;
    }
    busyRef.current = true;
    setIsAdShowing(true);
    try {
      const shown = await showLoadedAdAndWait();
      if (shown) {
        session.shownAt.push(Date.now());
        session.watchedSec = 0;
        session.threshold = randomThreshold();
      }
    } catch (error) {
      console.warn('[VideoAd] Показ реклами не вдався:', error);
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setIsAdShowing(false);
    }
  }, [showLoadedAdAndWait]);

  /** Відкрито нове відео: можливий pre-roll. */
  const onVideoStart = useCallback(() => {
    lastTimeRef.current = null;
    if (isPremium) return;
    if (
      session.watchedSec >= PRE_ROLL_MIN_WATCH_SEC &&
      canShowByFrequency() &&
      Math.random() < PRE_ROLL_CHANCE
    ) {
      runAd();
    }
  }, [isPremium, runAd]);

  /** Викликати з onProgress плеєра. */
  const onProgress = useCallback(
    (currentTime: number, duration: number) => {
      const last = lastTimeRef.current;
      lastTimeRef.current = currentTime;
      if (last !== null) {
        const step = currentTime - last;
        if (step > 0 && step <= MAX_PROGRESS_STEP_SEC) session.watchedSec += step;
      }

      if (isPremium || busyRef.current || fullscreenRef.current) return;
      if (session.watchedSec < session.threshold) return;
      if (currentTime < MIN_POSITION_SEC) return;
      if (duration > 0 && duration - currentTime < END_GUARD_SEC) return;
      if (!canShowByFrequency()) return;
      runAd();
    },
    [isPremium, runAd],
  );

  const setFullscreen = useCallback((value: boolean) => {
    fullscreenRef.current = value;
  }, []);

  return { isAdShowing, onVideoStart, onProgress, setFullscreen };
};
