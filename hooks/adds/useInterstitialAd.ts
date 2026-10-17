import { useEffect, useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { InterstitialAd, AdEventType } from 'react-native-google-mobile-ads';
import { getTrackingStatus } from 'react-native-tracking-transparency';
import { useSelector } from 'react-redux';
import { RootState } from '../../../store';
import { INTERSTITIAL_AD_UNIT_ID } from '../../config/ads';
import { markFullscreenAdEnd, markFullscreenAdStart } from './fullscreenAdState';

// ========================
// 📌 Інстанс реклами (один на весь застосунок), створюється ліниво.
// Персоналізація залежить від відповіді на запит ATT (App.tsx):
// iOS — персоналізована реклама лише якщо користувач дозволив
// відстеження, інакше неперсоналізована; Android — як і раніше,
// неперсоналізована.
// ========================
let interstitialPromise: Promise<InterstitialAd> | null = null;
let interstitialInstance: InterstitialAd | null = null;

// Пауза між спробами завантаження після помилок (немає реклами / немає
// мережі). Раніше після ERROR наступний load() дозволявся одразу, а
// відеоуроки просили рекламу щосекунди (onProgress) — тобто при "no fill"
// застосунок робив новий нативний запит реклами кожну секунду перегляду.
// Було 30 с → 10 хв: після кількох "no fill" поспіль реклама фактично
// зникала до кінця сесії. Тепер пауза зростає лише до 2 хв.
const LOAD_RETRY_BASE_MS = 15 * 1000;
const LOAD_RETRY_MAX_MS = 2 * 60 * 1000;
// Скільки чекати завантаження, коли рекламу вже пора показати.
const SHOW_LOAD_TIMEOUT_MS = 8000;
// Якщо після load() не прийшло ні LOADED, ні ERROR — скидаємо прапорець
// завантаження, щоб наступні спроби не блокувались назавжди.
const LOAD_STUCK_TIMEOUT_MS = 30_000;
let consecutiveLoadFailures = 0;
let nextLoadAllowedAt = 0;

const canStartLoad = (): boolean => Date.now() >= nextLoadAllowedAt;

const getInterstitial = (): Promise<InterstitialAd> => {
  if (!interstitialPromise) {
    interstitialPromise = (async () => {
      let nonPersonalized = true;
      if (Platform.OS === 'ios') {
        try {
          nonPersonalized = (await getTrackingStatus()) !== 'authorized';
        } catch {
          nonPersonalized = true;
        }
      }
      console.log(
        `[Ad] Створюю interstitial: unit=${INTERSTITIAL_AD_UNIT_ID}, ` +
          `nonPersonalized=${nonPersonalized}, __DEV__=${__DEV__}`,
      );
      const ad = InterstitialAd.createForAdRequest(INTERSTITIAL_AD_UNIT_ID, {
        requestNonPersonalizedAdsOnly: nonPersonalized,
      });

      // Спільні для всього застосунку лічильники (один раз на інстанс, а не
      // в кожному екрані, що використовує хук).
      ad.addAdEventListener(AdEventType.LOADED, () => {
        consecutiveLoadFailures = 0;
        nextLoadAllowedAt = 0;
      });
      ad.addAdEventListener(AdEventType.ERROR, (error: any) => {
        consecutiveLoadFailures += 1;
        // Код 3 / "no-fill" — AdMob не має реклами для показу (типово для
        // нового акаунта чи блоку, поки AdMob не перевірив застосунок).
        console.warn(
          `[Ad] Помилка реклами (${error?.code ?? 'unknown'}): ${error?.message ?? error}. ` +
            `Спроба №${consecutiveLoadFailures}, блок ${INTERSTITIAL_AD_UNIT_ID}`,
        );
        nextLoadAllowedAt =
          Date.now() + Math.min(LOAD_RETRY_BASE_MS * 2 ** (consecutiveLoadFailures - 1), LOAD_RETRY_MAX_MS);
        markFullscreenAdEnd();
      });
      ad.addAdEventListener(AdEventType.CLOSED, () => {
        markFullscreenAdEnd();
      });

      interstitialInstance = ad;
      return ad;
    })();
  }
  return interstitialPromise;
};

export const useInterstitialAd = () => {
  // 🟢 ВИПРАВЛЕНО: раніше тут читалось state.user.userDate (someDate на
  // бекенді) — поле, НЕ повʼязане з оплаченою підпискою. Тепер читаємо
  // єдине джерело правди premiumStatusSlice, яке наповнюється тим самим
  // /users/premium-status, що й Membership.tsx, і оновлюється одразу
  // після будь-якої покупки/продовження через usePremiumPurchase.
  const isPremiumActive = useSelector((state: RootState) => state.premiumStatus.isPremium);

  const [isAdLoaded, setIsAdLoaded] = useState(interstitialInstance?.loaded ?? false);
  const isLoading = useRef(false);
  const loadWaiters = useRef<((success: boolean) => void)[]>([]);
  const loadStuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ========================
  // 📌 Функція завантаження реклами
  // ========================
  const clearLoadStuckTimer = () => {
    if (loadStuckTimer.current) {
      clearTimeout(loadStuckTimer.current);
      loadStuckTimer.current = null;
    }
  };

  const loadAd = () => {
    if (isPremiumActive) {
      console.log('[Ad] Skip load — premium active');
      return;
    }

    const ad = interstitialInstance;
    if (!ad || ad.loaded || isLoading.current || !canStartLoad()) return;

    console.log('[Ad] Loading...', INTERSTITIAL_AD_UNIT_ID);
    isLoading.current = true;
    clearLoadStuckTimer();
    loadStuckTimer.current = setTimeout(() => {
      if (isLoading.current) {
        console.warn('[Ad] load() завис (ні LOADED, ні ERROR) — скидаю прапорець для наступних спроб.');
        isLoading.current = false;
      }
      loadStuckTimer.current = null;
    }, LOAD_STUCK_TIMEOUT_MS);

    try {
      ad.load();
    } catch (error) {
      console.warn('[Ad] load() failed', error);
      isLoading.current = false;
      clearLoadStuckTimer();
    }
  };

  // ========================
  // 📌 Обробка івентів
  // ========================
  useEffect(() => {
    if (isPremiumActive) {
      console.log('[Ad] Disabled — premium user');
      return;
    }

    let cancelled = false;
    let subs: (() => void)[] = [];

    getInterstitial().then(interstitial => {
      if (cancelled) return;

      subs = [
      interstitial.addAdEventListener(AdEventType.LOADED, () => {
        console.log('[Ad] LOADED');
        setIsAdLoaded(true);
        isLoading.current = false;
        if (loadStuckTimer.current) { clearTimeout(loadStuckTimer.current); loadStuckTimer.current = null; }

        loadWaiters.current.forEach(res => res(true));
        loadWaiters.current = [];
      }),

      interstitial.addAdEventListener(AdEventType.ERROR, error => {
        console.log('[Ad] ERROR', error);

        setIsAdLoaded(false);
        isLoading.current = false;
        if (loadStuckTimer.current) { clearTimeout(loadStuckTimer.current); loadStuckTimer.current = null; }

        loadWaiters.current.forEach(res => res(false));
        loadWaiters.current = [];
      }),

      interstitial.addAdEventListener(AdEventType.CLOSED, () => {
        console.log('[Ad] CLOSED — preparing reload');
        setIsAdLoaded(false);
        loadAd();
      }),
      ];

      loadAd();
    });

    return () => {
      cancelled = true;
      subs.forEach(unsub => unsub());
      loadWaiters.current.forEach(res => res(false));
      loadWaiters.current = [];
    };
  }, [isPremiumActive]);

  // ========================
  // 📌 Показ міжсторінкової реклами
  // ========================
  const showInterstitialAd = useCallback(async (): Promise<void> => {
    if (isPremiumActive) {
      console.log('[Ad] No show — premium active');
      return;
    }

    // Інстанс міг ще не створитись (екран щойно відкрито).
    const ad = await getInterstitial();

    // ⚠️ Дивимось на реальний стан реклами, а не на isAdLoaded цього екрана:
    // якщо рекламу завантажив інший екран, локальний стан лишався false,
    // хук 5 с "чекав" завантаження, яке вже відбулось, і показ пропускався.
    if (ad.loaded) {
      console.log('[Ad] Show — already loaded');
      await safeShow(ad);
      return;
    }

    // Пора показувати, а реклами ще немає — дозволяємо позачергову спробу
    // завантаження навіть під час паузи після помилок.
    nextLoadAllowedAt = 0;
    console.log('[Ad] Not loaded — waiting...');

    const loaded = await new Promise<boolean>(res => {
      loadWaiters.current.push(res);
      loadAd();

      setTimeout(() => {
        const idx = loadWaiters.current.indexOf(res);
        if (idx !== -1) {
          console.warn(`[Ad] Timeout (${SHOW_LOAD_TIMEOUT_MS / 1000}s)`);
          loadWaiters.current.splice(idx, 1);
          res(false);
        }
      }, SHOW_LOAD_TIMEOUT_MS);
    });

    if (loaded && ad.loaded) {
      console.log('[Ad] Show');
      await safeShow(ad);
    } else {
      console.log('[Ad] Skip — failed to load');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPremiumActive]);

  /**
   * Показати ВЖЕ завантажену рекламу і дочекатися, поки її закриють.
   * Якщо реклама ще не готова — нічого не показує (лише запускає
   * завантаження на наступний раз) і одразу повертає false. Використовується
   * у відеоуроках, де чекати завантаження з паузою відео не можна.
   */
  const showLoadedAdAndWait = useCallback((): Promise<boolean> => {
    const ad = interstitialInstance;
    if (isPremiumActive || !ad) return Promise.resolve(false);
    if (!ad.loaded) {
      loadAd();
      return Promise.resolve(false);
    }

    return new Promise<boolean>(resolve => {
      let finished = false;
      const unsubscribers: (() => void)[] = [];
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (shown: boolean) => {
        if (finished) return;
        finished = true;
        unsubscribers.forEach(unsub => unsub());
        if (safetyTimer) clearTimeout(safetyTimer);
        resolve(shown);
      };
      unsubscribers.push(ad.addAdEventListener(AdEventType.CLOSED, () => finish(true)));
      unsubscribers.push(ad.addAdEventListener(AdEventType.ERROR, () => finish(false)));
      // Страховка: якщо подія закриття так і не прийде, не тримаємо відео на паузі вічно.
      safetyTimer = setTimeout(() => {
        markFullscreenAdEnd();
        finish(true);
      }, 2 * 60 * 1000);
      safeShow(ad).then((started) => {
        if (!started) finish(false);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPremiumActive]);

  return {
    isAdLoaded,
    showInterstitialAd,
    showLoadedAdAndWait,
  };
};

/**
 * show() бібліотеки кидає СИНХРОННО, якщо реклама вже не "loaded" (напр.
 * протухла між перевіркою й показом), а проміс відхиляється, якщо показ не
 * вдався нативно. Тут обидва випадки → false, і позначка "реклама на
 * екрані" ставиться лише на час показу.
 */
const safeShow = async (ad: InterstitialAd): Promise<boolean> => {
  markFullscreenAdStart();
  try {
    await ad.show();
    return true;
  } catch (error) {
    console.warn('[Ad] show() failed', error);
    markFullscreenAdEnd();
    return false;
  }
};

/** Чи є зараз готова до показу реклама (без запуску завантаження). */
export const isInterstitialReady = (): boolean => !!interstitialInstance?.loaded;