import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { useIAP, getAvailablePurchases as fetchStorePurchases, type Purchase } from "react-native-iap";
import {
  mockCoursePurchase,
  verifyAppleCoursePurchase,
  verifyGoogleCoursePurchase,
} from "../services/coursePurchaseService";
import { getStoreAccountToken } from "../services/subscriptionService";
import { COURSE_PRODUCT_IDS } from "../config/iap";
import { MOCK_COURSE_PURCHASES_ENABLED } from "../config/mockPurchases";
import { ClassifiedPurchaseError, classifyIapError } from "../utils/iapErrors";
import { verifyWithRetry } from "../utils/verifyWithRetry";
import { beginExternalFlow } from "./adds/fullscreenAdState";

const LOG_TAG = "[IAP-COURSE]";

const CATALOG_FETCH_RETRY_ATTEMPTS = 3;
const CATALOG_FETCH_RETRY_DELAY_MS = 1500;
const PURCHASE_WATCHDOG_MS = 60000;
const RESTORE_WATCHDOG_MS = 30000;
const LATE_REPLY_WINDOW_MS = 5 * 60 * 1000;

function getSkuForCourse(courseStoreId: number): string | null {
  const entry = COURSE_PRODUCT_IDS[courseStoreId];
  if (!entry) return null;
  return Platform.OS === "ios" ? entry.apple : entry.google;
}

function getCourseStoreIdForSku(sku: string | undefined | null): number | null {
  if (!sku) return null;
  const entry = Object.entries(COURSE_PRODUCT_IDS).find(
    ([, ids]) => ids.apple === sku || ids.google === sku,
  );
  return entry ? Number(entry[0]) : null;
}

export function useCoursePurchase(
  courseStoreId: number | null,
  onPurchased?: (result?: { bonusGranted?: boolean }) => void,
) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const [error, setError] = useState<ClassifiedPurchaseError | null>(null);

  const isPurchaseInFlightRef = useRef(false);
  const isRestoreInFlightRef = useRef(false);
  const awaitingLateReplyRef = useRef(false);
  const lateReplyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const purchaseWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productsRef = useRef<any[]>([]);
  // Позначка "відкрито вікно оплати магазину" для App.tsx: повернення з
  // нього не повинно обривати запит перевірки покупки (див. fullscreenAdState).
  const endStoreFlowRef = useRef<(() => void) | null>(null);

  const startStoreFlow = useCallback(() => {
    endStoreFlowRef.current?.();
    endStoreFlowRef.current = beginExternalFlow("purchase");
  }, []);

  const endStoreFlow = useCallback(() => {
    endStoreFlowRef.current?.();
    endStoreFlowRef.current = null;
  }, []);

  const armLateReplyWindow = useCallback(() => {
    awaitingLateReplyRef.current = true;
    if (lateReplyTimeoutRef.current) clearTimeout(lateReplyTimeoutRef.current);
    lateReplyTimeoutRef.current = setTimeout(() => {
      awaitingLateReplyRef.current = false;
    }, LATE_REPLY_WINDOW_MS);
  }, []);

  const clearLateReplyWindow = useCallback(() => {
    awaitingLateReplyRef.current = false;
    if (lateReplyTimeoutRef.current) {
      clearTimeout(lateReplyTimeoutRef.current);
      lateReplyTimeoutRef.current = null;
    }
  }, []);

  const clearPurchaseWatchdog = useCallback(() => {
    if (purchaseWatchdogRef.current) {
      clearTimeout(purchaseWatchdogRef.current);
      purchaseWatchdogRef.current = null;
    }
  }, []);

  const clearRestoreWatchdog = useCallback(() => {
    if (restoreWatchdogRef.current) {
      clearTimeout(restoreWatchdogRef.current);
      restoreWatchdogRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearPurchaseWatchdog();
      clearRestoreWatchdog();
      if (lateReplyTimeoutRef.current) clearTimeout(lateReplyTimeoutRef.current);
      endStoreFlowRef.current?.();
    };
  }, [clearPurchaseWatchdog, clearRestoreWatchdog]);

  const {
    connected,
    products,
    fetchProducts,
    requestPurchase,
    finishTransaction,
  } = useIAP({
    onPurchaseSuccess: async (purchase: Purchase) => {
      const isUserInitiated =
        isPurchaseInFlightRef.current || isRestoreInFlightRef.current || awaitingLateReplyRef.current;
      clearPurchaseWatchdog();
      isPurchaseInFlightRef.current = false;
      setIsPurchasing(false);
      try {
        await handlePurchaseSuccess(purchase, isUserInitiated);
      } finally {
        endStoreFlow();
      }
    },
    onPurchaseError: (rawError) => {
      const isUserInitiated =
        isPurchaseInFlightRef.current || isRestoreInFlightRef.current || awaitingLateReplyRef.current;
      clearPurchaseWatchdog();
      isPurchaseInFlightRef.current = false;
      setIsPurchasing(false);
      endStoreFlow();

      const classified = classifyIapError(rawError);
      console.log(`${LOG_TAG} onPurchaseError`, classified.kind, rawError?.code, rawError?.message);

      if (!classified.silent && isUserInitiated) {
        setError(classified);
      }
    },
  });

  useEffect(() => {
    productsRef.current = products ?? [];
  }, [products]);

  useEffect(() => {
    if (!connected || courseStoreId === null) return;

    const sku = getSkuForCourse(courseStoreId);
    if (!sku) {
      console.log(`${LOG_TAG} Немає sku для courseStoreId=${courseStoreId} — перевір COURSE_PRODUCT_IDS в config/iap.ts`);
      setIsCatalogLoading(false);
      setError({
        kind: "product_unavailable",
        message: "Цей курс тимчасово недоступний для покупки.",
        silent: false,
        retryable: false,
        raw: null,
      });
      return;
    }

    let cancelled = false;

    const attemptFetch = async (attemptsLeft: number) => {
      try {
        await fetchProducts({ skus: [sku], type: "in-app" });
      } catch (err) {
        console.log(`${LOG_TAG} fetchProducts error`, err);
      }

      if (cancelled) return;

      setTimeout(() => {
        if (cancelled) return;

        if (productsRef.current.length > 0) {
          setIsCatalogLoading(false);
          return;
        }

        if (attemptsLeft > 1) {
          attemptFetch(attemptsLeft - 1);
        } else {
          setIsCatalogLoading(false);
        }
      }, CATALOG_FETCH_RETRY_DELAY_MS);
    };

    attemptFetch(CATALOG_FETCH_RETRY_ATTEMPTS);

    return () => {
      cancelled = true;
    };
  }, [connected, courseStoreId]);

  useEffect(() => {
    if (products && products.length > 0) {
      setIsCatalogLoading(false);
    }
  }, [products]);

  const handlePurchaseSuccess = useCallback(
    async (purchase: Purchase, isUserInitiated: boolean) => {
      // Android: відкладений платіж ще не оплачений — доступ не видаємо і
      // транзакцію не завершуємо; магазин надішле покупку повторно, коли
      // платіж пройде.
      if (purchase.purchaseState === "pending") {
        if (isUserInitiated) {
          setError({
            kind: "unknown",
            message: "Оплата очікує підтвердження магазином. Доступ з\u2019явиться автоматично, щойно платіж буде завершено.",
            silent: false,
            retryable: false,
            raw: null,
          });
        }
        return;
      }

      const resolvedCourseStoreId = courseStoreId ?? getCourseStoreIdForSku(purchase.productId);

      if (resolvedCourseStoreId === null) {
        try {
          await finishTransaction({ purchase, isConsumable: false });
        } catch (finishErr) {
          console.log(`${LOG_TAG} finishTransaction (unresolvable courseStoreId) error`, finishErr);
        }
        return;
      }

      if (!isUserInitiated) {
        try {
          await finishTransaction({ purchase, isConsumable: false });
          console.log(`${LOG_TAG} Тиха фіналізація replay-транзакції зі старої черги`, purchase.productId);
        } catch (finishErr) {
          console.log(`${LOG_TAG} Не вдалося тихо фіналізувати replay-транзакцію`, finishErr);
        }
        return;
      }

      clearLateReplyWindow();
      setIsVerifying(true);
      setError(null);

      let verifiedOk = false;
      let bonusGranted = false;
      try {
        // Сервер прийме лише покупку цього акаунта (токен у квитанції);
        // покупку іншого чи видаленого акаунта відхилить з поясненням.
        const result = await verifyWithRetry(() =>
          Platform.OS === "ios"
            ? verifyAppleCoursePurchase(resolvedCourseStoreId, purchase.purchaseToken as string)
            : verifyGoogleCoursePurchase(resolvedCourseStoreId, purchase.productId, purchase.purchaseToken as string),
        );
        verifiedOk = true;
        bonusGranted = !!result?.bonusGranted;
      } catch (verifyErr) {
        const classified = classifyIapError(verifyErr);
        setError({
          ...classified,
          message:
            classified.kind === "server_validation"
              ? classified.message
              : "Оплату прийнято, але підтвердження на сервері не пройшло. Натисніть «Відновити покупку» за хвилину.",
        });
      }

      try {
        // Android: курс записано на акаунт на сервері — «споживаємо» покупку,
        // щоб інший акаунт на цьому Google-акаунті міг купити курс заново
        // (сервер теж робить consume; повторний виклик просто дасть помилку).
        await finishTransaction({ purchase, isConsumable: Platform.OS === "android" && verifiedOk });
      } catch (finishErr) {
        console.log(`${LOG_TAG} finishTransaction error (доступ уже видано, якщо verifiedOk=true)`, finishErr);
      }

      if (verifiedOk) {
        onPurchased?.({ bonusGranted });
      }

      setIsVerifying(false);
    },
    [finishTransaction, onPurchased, courseStoreId, clearLateReplyWindow],
  );

  const buy = useCallback(async () => {
    if (courseStoreId === null) return;
    if (isPurchaseInFlightRef.current) return;

    setError(null);

    if (MOCK_COURSE_PURCHASES_ENABLED) {
      setIsVerifying(true);
      try {
        const result = await mockCoursePurchase(courseStoreId);
        onPurchased?.({ bonusGranted: !!result?.bonusGranted });
      } catch (mockErr) {
        setError(classifyIapError(mockErr));
      } finally {
        setIsVerifying(false);
      }
      return;
    }

    if (!connected || isCatalogLoading) return;

    const sku = getSkuForCourse(courseStoreId);
    if (!sku) {
      setError({
        kind: "product_unavailable",
        message: "Цей курс тимчасово недоступний для покупки.",
        silent: false,
        retryable: false,
        raw: null,
      });
      return;
    }

    const skuExistsInCatalog = productsRef.current.some((p: any) => p.id === sku || p.productId === sku);
    if (!skuExistsInCatalog) {
      setError({
        kind: "product_unavailable",
        message: "Цей курс тимчасово недоступний. Спробуйте, будь ласка, за кілька хвилин.",
        silent: false,
        retryable: true,
        raw: null,
      });
      return;
    }

    // 🔒 Покупка підписується в магазині токеном ПОТОЧНОГО акаунта (див.
    // getStoreAccountToken). Без токена покупку не починаємо.
    isPurchaseInFlightRef.current = true;
    setIsPurchasing(true);
    let accountToken: string;
    try {
      accountToken = await getStoreAccountToken();
    } catch (tokenErr) {
      isPurchaseInFlightRef.current = false;
      setIsPurchasing(false);
      setError(classifyIapError(tokenErr));
      return;
    }

    startStoreFlow();

    clearPurchaseWatchdog();
    purchaseWatchdogRef.current = setTimeout(() => {
      isPurchaseInFlightRef.current = false;
      setIsPurchasing(false);
      armLateReplyWindow();
      endStoreFlow();
      setError({
        kind: "unknown",
        message:
          "Обробка триває довше очікуваного. Якщо кошти списано, покупка з'явиться автоматично, або натисніть «Відновити покупку».",
        silent: false,
        retryable: true,
        raw: null,
      });
    }, PURCHASE_WATCHDOG_MS);

    try {
      if (Platform.OS === "ios") {
        await requestPurchase({ request: { apple: { sku, appAccountToken: accountToken } }, type: "in-app" });
      } else {
        await requestPurchase({ request: { google: { skus: [sku], obfuscatedAccountId: accountToken } }, type: "in-app" });
      }
    } catch (requestErr: any) {
      clearPurchaseWatchdog();
      isPurchaseInFlightRef.current = false;
      setIsPurchasing(false);
      endStoreFlow();

      const classified = classifyIapError(requestErr);
      if (!classified.silent) {
        setError(classified);
      }
    }
  }, [requestPurchase, connected, isCatalogLoading, courseStoreId, onPurchased, clearPurchaseWatchdog, armLateReplyWindow, startStoreFlow, endStoreFlow]);

  const restore = useCallback(async () => {
    if (isRestoreInFlightRef.current) return;

    isRestoreInFlightRef.current = true;
    setIsRestoring(true);
    setError(null);
    startStoreFlow();

    clearRestoreWatchdog();
    restoreWatchdogRef.current = setTimeout(() => {
      isRestoreInFlightRef.current = false;
      setIsRestoring(false);
      setError({
        kind: "unknown",
        message: "Відновлення покупок триває довше очікуваного. Спробуйте, будь ласка, ще раз.",
        silent: false,
        retryable: true,
        raw: null,
      });
    }, RESTORE_WATCHDOG_MS);

    try {
      // Беремо результат напряму зі стора: стан availablePurchases з useIAP
      // у цьому замиканні ще старий, тож перше "Відновити" нічого не знаходило.
      const storePurchases = await fetchStorePurchases();

      const sku = courseStoreId !== null ? getSkuForCourse(courseStoreId) : null;
      const relevant = (storePurchases ?? []).filter((p) => !sku || p.productId === sku);

      for (const purchase of relevant) {
        await handlePurchaseSuccess(purchase, true);
      }

      if (relevant.length === 0) {
        setError({
          kind: "unknown",
          message: "Активних покупок для відновлення не знайдено.",
          silent: false,
          retryable: false,
          raw: null,
        });
      }
    } catch (restoreErr) {
      setError(classifyIapError(restoreErr));
    } finally {
      clearRestoreWatchdog();
      isRestoreInFlightRef.current = false;
      setIsRestoring(false);
      endStoreFlow();
    }
  }, [handlePurchaseSuccess, courseStoreId, clearRestoreWatchdog, startStoreFlow, endStoreFlow]);

  const price = useMemo(() => {
    if (courseStoreId === null) return null;
    const sku = getSkuForCourse(courseStoreId);
    const product = products?.find((p: any) => p.id === sku || p.productId === sku);
    return (product as any)?.displayPrice ?? (product as any)?.localizedPrice ?? null;
  }, [products, courseStoreId]);

  const isCatalogReady = connected && !isCatalogLoading && (products?.length ?? 0) > 0;

  return {
    connected,
    buy,
    restore,
    isVerifying,
    isPurchasing,
    isRestoring,
    isCatalogReady,
    error,
    price,
  };
}