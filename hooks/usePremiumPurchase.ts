import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useIAP, getAvailablePurchases as fetchStorePurchases, type Purchase } from "react-native-iap";
import {
  verifyAppleSubscription,
  verifyGoogleSubscription,
  mockSubscriptionPurchase,
  getStoreAccountToken,
} from "../services/subscriptionService";
import { APPLE_PRODUCT_IDS, GOOGLE_PRODUCT_IDS, PremiumPlan } from "../config/iap";
import { MOCK_SUBSCRIPTION_PURCHASES_ENABLED } from "../config/mockPurchases";
import { AppDispatch } from "../../store";
import { useDispatch } from "react-redux";
import { fetchPremiumStatus } from "../features/premiumStatusSlice";
import { classifyIapError, ClassifiedPurchaseError } from "../utils/iapErrors";
import { verifyWithRetry } from "../utils/verifyWithRetry";
import { beginExternalFlow } from "./adds/fullscreenAdState";

interface PlanPricing {
  monthly: string | null;
  yearly: string | null;
  /** Числові ціни з магазину (для розрахунку економії річного плану). */
  monthlyValue: number | null;
  yearlyValue: number | null;
}

const toPriceNumber = (product: any): number | null => {
  const value = Number(product?.price);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const LOG_TAG = "[IAP]";

const CATALOG_FETCH_RETRY_ATTEMPTS = 3;
const CATALOG_FETCH_RETRY_DELAY_MS = 1500;
const PURCHASE_WATCHDOG_MS = 60000;
const RESTORE_WATCHDOG_MS = 30000;
const LATE_REPLY_WINDOW_MS = 5 * 60 * 1000;

// 🟢 Скільки чекати після повернення застосунку на передній план (з
// системного алерту/App Store), перш ніж вважати, що подія від StoreKit
// вже не прийде і треба самим розблокувати UI. Це не вирішує сам факт,
// що iOS показує "Vous êtes déjà abonné" замість штатної purchase-події —
// це поведінка Sandbox/StoreKit, яку контролювати з коду неможливо. Це
// лише прибирає "вічне зависання" кнопки, коли подія так і не прийшла.
// Було 2,5 с: після аркуша оплати (Face ID / пароль / "Готово") подія
// успіху часто приходить пізніше, і користувач бачив хибну помилку, а
// за мить — успішну покупку. Тепер чекаємо довше і знімаємо лоадер МОВЧКИ.
const FOREGROUND_RECOVERY_DELAY_MS = 8000;

// 🟢 Рівні планів мають ЗБІГАТИСЯ з порядком рівнів (levels), які ви
// виставили у Subscription Group в App Store Connect (річна має бути
// вище місячної в перетягуваному списку). Тут вони потрібні окремо для
// Android-гілки, де proration mode треба вибрати explicit — Google Play
// (на відміну від Apple) не визначає це сам через жодні налаштування
// в консолі, це вирішується ТІЛЬКИ параметром коду при виклику покупки.
const PLAN_RANK: Record<PremiumPlan, number> = {
  monthly: 1,
  yearly: 2,
};

// Значення відповідають Google Play Billing ProrationMode /
// react-native-iap ReplacementModeAndroid:
// 1 = IMMEDIATE_WITH_TIME_PRORATION
// 2 = IMMEDIATE_AND_CHARGE_PRORATED_PRICE  (апгрейд: миттєво, з доплатою пропорційно)
// 3 = IMMEDIATE_WITHOUT_PRORATION
// 4 = DEFERRED                              (даунгрейд: набуває чинності на дату поновлення)
// 5 = IMMEDIATE_AND_CHARGE_FULL_PRICE
// react-native-iap v16: режим заміни передається рядком у
// subscriptionProductReplacementParams (старі числові purchaseTokenAndroid /
// replacementModeAndroid бібліотека мовчки ігнорувала — і "зміна плану"
// ставала окремою новою покупкою без заміни поточної підписки).
//
// Апгрейд monthly→yearly: 'with-time-proration' — діє одразу, невикористаний
// залишок місячної зараховується часом. ('charge-prorated-price' Google
// дозволяє лише коли ціна за одиницю часу ЗРОСТАЄ, а в річної вона нижча —
// такий запит відхилявся.) Даунгрейд yearly→monthly: 'deferred' — з дати
// поновлення.
function resolveAndroidReplacementMode(
  currentPlan: PremiumPlan,
  targetPlan: PremiumPlan,
): "with-time-proration" | "deferred" {
  return PLAN_RANK[targetPlan] > PLAN_RANK[currentPlan] ? "with-time-proration" : "deferred";
}

export function usePremiumPurchase(onVerified?: () => void, currentPlan?: PremiumPlan | null) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const [error, setError] = useState<ClassifiedPurchaseError | null>(null);

  const dispatch = useDispatch<AppDispatch>();

  const isPurchaseInFlightRef = useRef(false);
  const isRestoreInFlightRef = useRef(false);
  const awaitingLateReplyRef = useRef(false);
  const lateReplyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const purchaseWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foregroundRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionsRef = useRef<any[]>([]);
  // Остання відмова сервера при тихій синхронізації (напр. «покупка іншого
  // акаунта») — показуємо її замість загального «вже придбано».
  const lastSyncRejectionRef = useRef<ClassifiedPurchaseError | null>(null);
  const currentPlanRef = useRef<PremiumPlan | null | undefined>(currentPlan);
  // Позначка "відкрито вікно оплати магазину" для App.tsx (див. fullscreenAdState).
  const endStoreFlowRef = useRef<(() => void) | null>(null);

  const startStoreFlow = useCallback(() => {
    endStoreFlowRef.current?.();
    endStoreFlowRef.current = beginExternalFlow("purchase");
  }, []);

  const endStoreFlow = useCallback(() => {
    endStoreFlowRef.current?.();
    endStoreFlowRef.current = null;
  }, []);

  useEffect(() => {
    currentPlanRef.current = currentPlan;
  }, [currentPlan]);

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

  const clearForegroundRecovery = useCallback(() => {
    if (foregroundRecoveryTimeoutRef.current) {
      clearTimeout(foregroundRecoveryTimeoutRef.current);
      foregroundRecoveryTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearPurchaseWatchdog();
      clearRestoreWatchdog();
      clearForegroundRecovery();
      if (lateReplyTimeoutRef.current) clearTimeout(lateReplyTimeoutRef.current);
      endStoreFlowRef.current?.();
    };
  }, [clearPurchaseWatchdog, clearRestoreWatchdog, clearForegroundRecovery]);

  // 🟢 НОВЕ: страховка саме під "мовчазний" нативний алерт StoreKit
  // ("Vous êtes déjà abonné" / "You're currently subscribed to this").
  // Це системне вікно iOS може НЕ породжувати жодної purchase-події —
  // ні success, ні error — тому raw watchdog на 60с це єдине, що
  // спрацьовувало раніше. Тепер додатково: коли застосунок повертається
  // з фону (з системного алерту/App Store) під час активної покупки,
  // і подія все ще не прийшла — знімаємо лоадер значно швидше, ніж
  // через повну watchdog-затримку.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (!isPurchaseInFlightRef.current) return;

      clearForegroundRecovery();
      foregroundRecoveryTimeoutRef.current = setTimeout(() => {
        if (!isPurchaseInFlightRef.current) return;

        // Подія від магазину не прийшла. Найчастіше це системне вікно
        // "Ви вже підписані" (підписка є на Apple ID / Google-акаунті, але
        // не на цьому акаунті застосунку, напр. після його перестворення) —
        // тихо підтягуємо її з магазину. Пізня подія все одно буде прийнята
        // ("вікно пізньої відповіді").
        clearPurchaseWatchdog();
        isPurchaseInFlightRef.current = false;
        setIsPurchasing(false);
        armLateReplyWindow();
        endStoreFlow();
        setIsVerifying(true);
        syncStoreSubscriptionsRef.current(true).finally(() => setIsVerifying(false));
      }, FOREGROUND_RECOVERY_DELAY_MS);
    });

    return () => sub.remove();
  }, [clearForegroundRecovery, clearPurchaseWatchdog, armLateReplyWindow, endStoreFlow]);

  const {
    connected,
    subscriptions,
    fetchProducts,
    requestPurchase,
    finishTransaction,
  } = useIAP({
    onPurchaseSuccess: async (purchase: Purchase) => {
      const isUserInitiated =
        isPurchaseInFlightRef.current || isRestoreInFlightRef.current || awaitingLateReplyRef.current;
      clearPurchaseWatchdog();
      clearForegroundRecovery();
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
      clearForegroundRecovery();
      isPurchaseInFlightRef.current = false;
      setIsPurchasing(false);
      endStoreFlow();

      const classified = classifyIapError(rawError);
      console.log(`${LOG_TAG} onPurchaseError`, classified.kind, rawError?.code, rawError?.message);

      if (classified.kind === "already_owned" && isUserInitiated) {
        // Підписка вже є в магазині. Якщо вона оформлена на ЦЬОМУ акаунті
        // (напр. перевірка колись не дійшла до сервера) — сервер її прийме.
        // Якщо на іншому акаунті — сервер відмовить, і ми покажемо чому.
        setIsVerifying(true);
        syncStoreSubscriptionsRef
          .current()
          .then((verified) => {
            if (!verified) setError(lastSyncRejectionRef.current ?? classified);
          })
          .finally(() => setIsVerifying(false));
        return;
      }

      if (!classified.silent && isUserInitiated) {
        setError(classified);
      }
    },
  });

  useEffect(() => {
    subscriptionsRef.current = subscriptions ?? [];
  }, [subscriptions]);

  useEffect(() => {
    if (!connected) return;

    const productIds = Platform.OS === "ios" ? Object.values(APPLE_PRODUCT_IDS) : Object.values(GOOGLE_PRODUCT_IDS);
    let cancelled = false;

    const attemptFetch = async (attemptsLeft: number) => {
      try {
        await fetchProducts({ skus: productIds, type: "subs" });
      } catch (err) {
        console.log(`${LOG_TAG} fetchProducts error`, err);
      }

      if (cancelled) return;

      setTimeout(() => {
        if (cancelled) return;

        if (subscriptionsRef.current.length > 0) {
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
  }, [connected]);

  useEffect(() => {
    if (subscriptions && subscriptions.length > 0) {
      setIsCatalogLoading(false);
    }
  }, [subscriptions]);

  // transfer = true лише для явних дій користувача (див. subscriptionService).
  const verifyPurchaseOnServer = (purchase: Purchase, transfer = false) =>
    verifyWithRetry(() =>
      Platform.OS === "ios"
        ? verifyAppleSubscription(purchase.purchaseToken as string, transfer)
        : verifyGoogleSubscription(purchase.productId, purchase.purchaseToken as string, transfer),
    );

  const handlePurchaseSuccess = useCallback(
    async (purchase: Purchase, isUserInitiated: boolean) => {
      // Android: відкладений платіж (напр. готівкою в терміналі) ще не
      // оплачений — не видаємо доступ і НЕ завершуємо транзакцію (Google
      // Play дозволяє acknowledge лише оплачених покупок). Коли платіж
      // пройде, магазин надішле ту саму покупку вже зі станом "purchased".
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

      if (!isUserInitiated) {
        // Незавершена транзакція з минулого запуску (застосунок закрили під
        // час покупки, перевірка не встигла тощо). Раніше її лише закривали —
        // і оплачена підписка так і не потрапляла на сервер. Тепер тихо
        // перевіряємо; закриваємо, якщо сервер її прийняв або свідомо відхилив.
        let settled = false;
        try {
          await verifyPurchaseOnServer(purchase);
          settled = true;
          dispatch(fetchPremiumStatus());
          onVerified?.();
        } catch (verifyErr: any) {
          const status = verifyErr?.response?.status;
          settled = typeof status === "number" && status >= 400 && status < 500;
          console.log(`${LOG_TAG} Тиха перевірка replay-транзакції не вдалась`, status ?? verifyErr?.message);
        }
        if (settled) {
          await finishTransaction({ purchase, isConsumable: false }).catch(() => {});
        }
        return;
      }

      clearLateReplyWindow();
      setIsVerifying(true);
      setError(null);

      let verifiedOk = false;
      try {
        // Сервер прийме лише покупку цього акаунта (токен у квитанції);
        // покупку іншого акаунта відхилить з 403 і поясненням.
        await verifyPurchaseOnServer(purchase);
        verifiedOk = true;
      } catch (verifyErr: any) {
        const classified = classifyIapError(verifyErr);
        setError({
          ...classified,
          message:
            classified.kind === "server_validation"
              ? classified.message
              : "Оплату прийнято, але підтвердження на сервері не пройшло. Спробуйте натиснути «Відновити покупки» за хвилину.",
        });
      }

      try {
        await finishTransaction({ purchase, isConsumable: false });
      } catch (finishErr) {
        console.log(`${LOG_TAG} finishTransaction error (доступ уже видано, якщо verifiedOk=true)`, finishErr);
      }

      if (verifiedOk) {
        dispatch(fetchPremiumStatus());
        onVerified?.();
      }

      setIsVerifying(false);
    },
    [finishTransaction, onVerified, dispatch, clearLateReplyWindow],
  );

  /**
   * Тиха синхронізація: надсилає на сервер активні підписки з магазину. Рятує,
   * коли магазин не надіслав подію покупки (iOS "Ви вже підписані", Android
   * "вже придбано") для покупки, оформленої на ЦЬОМУ акаунті. Покупки інших
   * (зокрема видалених) акаунтів сервер відхиляє — на новому акаунті підписку
   * треба оформити заново. Помилок не показує.
   */
  const syncStoreSubscriptions = useCallback(async (transfer: boolean = false): Promise<boolean> => {
    let storePurchases: Purchase[] = [];
    try {
      storePurchases = (await fetchStorePurchases()) ?? [];
    } catch (err) {
      console.log(`${LOG_TAG} getAvailablePurchases (sync) error`, err);
      return false;
    }

    const subscriptionSkus = new Set<string>(
      Platform.OS === "ios" ? Object.values(APPLE_PRODUCT_IDS) : Object.values(GOOGLE_PRODUCT_IDS),
    );
    const candidates = storePurchases.filter(
      (p) => subscriptionSkus.has(p.productId) && !!p.purchaseToken && p.purchaseState !== "pending",
    );

    let verified = false;
    lastSyncRejectionRef.current = null;
    for (const purchase of candidates) {
      try {
        await verifyPurchaseOnServer(purchase, transfer);
        verified = true;
      } catch (err: any) {
        const classified = classifyIapError(err);
        if (classified.kind === "server_validation") lastSyncRejectionRef.current = classified;
        console.log(`${LOG_TAG} Тиха синхронізація: сервер не прийняв покупку`, err?.response?.status ?? err?.message);
      }
    }

    if (verified) {
      dispatch(fetchPremiumStatus());
      onVerified?.();
    }
    return verified;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, onVerified]);

  const syncStoreSubscriptionsRef = useRef(syncStoreSubscriptions);
  useEffect(() => {
    syncStoreSubscriptionsRef.current = syncStoreSubscriptions;
  }, [syncStoreSubscriptions]);

  // 🟢 НОВЕ: для Android-апгрейду/даунгрейду Google Play ОБОВ'ЯЗКОВО
  // потребує purchaseToken ПОТОЧНОЇ активної підписки — без нього запит
  // трактується як покупка нового окремого продукту, а не зміна
  // існуючого, і саме тому річна раніше не спрацьовувала при активній
  // місячній. subscriptionsRef/pricing тут не допоможуть — потрібен
  // саме токен реальної активної покупки з historичних даних стора.
  const resolveActiveAndroidSubscription = useCallback(async (): Promise<{
    purchaseToken: string;
    productId: string;
  } | null> => {
    let storePurchases: Purchase[] = [];
    try {
      storePurchases = await fetchStorePurchases();
    } catch (err) {
      console.log(`${LOG_TAG} getAvailablePurchases (android upgrade lookup) error`, err);
      return null;
    }

    const googleSkus = new Set(Object.values(GOOGLE_PRODUCT_IDS));
    const candidates = (storePurchases ?? []).filter(
      (p: any) => googleSkus.has(p.productId) && !!p.purchaseToken,
    );
    // Спершу — покупка саме поточного плану з сервера.
    const currentSku = currentPlanRef.current ? GOOGLE_PRODUCT_IDS[currentPlanRef.current] : null;
    const active: any = candidates.find((p: any) => p.productId === currentSku) ?? candidates[0];

    return active ? { purchaseToken: active.purchaseToken, productId: active.productId } : null;
  }, []);

  const buy = useCallback(
    async (plan: PremiumPlan) => {
      if (isPurchaseInFlightRef.current) return;

      setError(null);

      if (MOCK_SUBSCRIPTION_PURCHASES_ENABLED) {
        setIsVerifying(true);
        try {
          await mockSubscriptionPurchase(plan);
          dispatch(fetchPremiumStatus());
          onVerified?.();
        } catch (mockErr) {
          setError(classifyIapError(mockErr));
        } finally {
          setIsVerifying(false);
        }
        return;
      }

      if (!connected || isCatalogLoading) return;

      let sku: string;
      if (Platform.OS === "ios") {
        sku = APPLE_PRODUCT_IDS[plan];
        const skuExistsInCatalog = subscriptionsRef.current.some((s: any) => s.id === sku || s.productId === sku);
        if (!skuExistsInCatalog) {
          setError({
            kind: "product_unavailable",
            message: "Цей план тимчасово недоступний. Спробуйте, будь ласка, за кілька хвилин.",
            silent: false,
            retryable: true,
            raw: null,
          });
          return;
        }
      } else {
        sku = GOOGLE_PRODUCT_IDS[plan];
        const product = subscriptionsRef.current.find((p: any) => p.id === sku || p.productId === sku);
        if (!product) {
          setError({
            kind: "product_unavailable",
            message: "Цей план тимчасово недоступний. Спробуйте, будь ласка, за кілька хвилин.",
            silent: false,
            retryable: true,
            raw: null,
          });
          return;
        }
      }

      // 🔒 Покупка підписується в магазині токеном ПОТОЧНОГО акаунта — інакше
      // сервер не зможе відрізнити її від покупки іншого акаунта на цьому
      // телефоні. Без токена покупку не починаємо.
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
            "Обробка триває довше очікуваного. Якщо кошти списано, підписка з'явиться автоматично, або натисніть «Відновити покупки».",
          silent: false,
          retryable: true,
          raw: null,
        });
      }, PURCHASE_WATCHDOG_MS);

      try {
        if (Platform.OS === "ios") {
          // На iOS апгрейд/даунгрейд визначається виключно рівнями (levels)
          // у Subscription Group в App Store Connect — жодних додаткових
          // параметрів з коду передавати не потрібно і не можна.
          await requestPurchase({ request: { apple: { sku, appAccountToken: accountToken } }, type: "subs" });
        } else {
          const product = subscriptionsRef.current.find((p: any) => p.id === sku || p.productId === sku);
          const offerToken = (product as any)?.subscriptionOfferDetailsAndroid?.[0]?.offerToken;

          const hasExistingSubscription = !!currentPlanRef.current;
          let replacement: {
            purchaseToken: string;
            subscriptionProductReplacementParams: {
              oldProductId: string;
              replacementMode: "with-time-proration" | "deferred";
            };
          } | null = null;

          if (hasExistingSubscription) {
            const active = await resolveActiveAndroidSubscription();
            if (active && active.productId !== sku) {
              replacement = {
                purchaseToken: active.purchaseToken,
                subscriptionProductReplacementParams: {
                  oldProductId: active.productId,
                  replacementMode: resolveAndroidReplacementMode(currentPlanRef.current as PremiumPlan, plan),
                },
              };
            } else if (!active) {
              console.log(
                `${LOG_TAG} Не знайдено активну підписку в Google Play для зміни плану — виконую як звичайну покупку.`,
              );
            }
          }

          await requestPurchase({
            request: {
              google: {
                skus: [sku],
                obfuscatedAccountId: accountToken,
                ...(offerToken ? { subscriptionOffers: [{ sku, offerToken }] } : {}),
                ...(replacement ?? {}),
              },
            },
            type: "subs",
          });
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
    },
    [
      requestPurchase,
      connected,
      isCatalogLoading,
      onVerified,
      dispatch,
      clearPurchaseWatchdog,
      armLateReplyWindow,
      resolveActiveAndroidSubscription,
      startStoreFlow,
      endStoreFlow,
    ],
  );

  const restore = useCallback(async () => {
    if (isRestoreInFlightRef.current) return;

    isRestoreInFlightRef.current = true;
    setIsRestoring(true);
    setError(null);
    // Відновлення на iOS може показати вікно входу в Apple ID.
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

      // Лише підписки Premium: куплені курси (non-consumable) теж є в
      // цьому списку, але перевіряються своїм хуком (useCoursePurchase) —
      // тут вони давали б хибну помилку "підтвердження не пройшло".
      const subscriptionSkus = new Set<string>(
        Platform.OS === "ios" ? Object.values(APPLE_PRODUCT_IDS) : Object.values(GOOGLE_PRODUCT_IDS),
      );
      const subscriptionPurchases = (storePurchases ?? []).filter((p) => subscriptionSkus.has(p.productId));

      for (const purchase of subscriptionPurchases) {
        await handlePurchaseSuccess(purchase, true);
      }

      if (subscriptionPurchases.length === 0) {
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
  }, [handlePurchaseSuccess, clearRestoreWatchdog, startStoreFlow, endStoreFlow]);

  const pricing: PlanPricing = useMemo(() => {
    const monthlySku = Platform.OS === "ios" ? APPLE_PRODUCT_IDS.monthly : GOOGLE_PRODUCT_IDS.monthly;
    const yearlySku = Platform.OS === "ios" ? APPLE_PRODUCT_IDS.yearly : GOOGLE_PRODUCT_IDS.yearly;

    const monthlyProduct = subscriptions?.find((p: any) => p.id === monthlySku || p.productId === monthlySku);
    const yearlyProduct = subscriptions?.find((p: any) => p.id === yearlySku || p.productId === yearlySku);

    return {
      monthly: (monthlyProduct as any)?.displayPrice ?? (monthlyProduct as any)?.localizedPrice ?? null,
      yearly: (yearlyProduct as any)?.displayPrice ?? (yearlyProduct as any)?.localizedPrice ?? null,
      monthlyValue: toPriceNumber(monthlyProduct),
      yearlyValue: toPriceNumber(yearlyProduct),
    };
  }, [subscriptions]);

  const isCatalogReady = connected && !isCatalogLoading && (subscriptions?.length ?? 0) > 0;

  return {
    connected,
    buy,
    restore,
    syncStoreSubscriptions,
    isVerifying,
    isPurchasing,
    isRestoring,
    isCatalogReady,
    error,
    pricing,
  };
}