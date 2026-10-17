import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { useIAP, getAvailablePurchases as fetchStorePurchases, type Purchase } from "react-native-iap";
import { mockProgramPurchase, verifyAppleProgramPurchase, verifyGoogleProgramPurchase } from "../services/programPurchaseService";
import { APPLE_PROGRAM_PRODUCT_IDS, GOOGLE_PROGRAM_PRODUCT_IDS, ProgramLevel } from "../config/iap";
import { MOCK_PROGRAM_PURCHASES_ENABLED } from "../config/mockPurchases";

type LevelPricing = Record<ProgramLevel, string | null>;

const PROGRAM_LEVELS = Object.keys(APPLE_PROGRAM_PRODUCT_IDS) as ProgramLevel[];

const LOG_TAG = "[IAP-PROGRAM]";

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(
      value,
      (_key, val) => (val === undefined ? "__undefined__" : val),
      2,
    );
  } catch (err) {
    return `<не вдалося серіалізувати: ${String(err)}>`;
  }
};

const logErrorFull = (label: string, error: any) => {
  console.log(`${LOG_TAG} ❌ ${label} — RAW ERROR OBJECT:`, error);
  console.log(`${LOG_TAG} ❌ ${label} — error.message:`, error?.message);
  console.log(`${LOG_TAG} ❌ ${label} — error.code:`, error?.code);
  console.log(`${LOG_TAG} ❌ ${label} — error.responseCode:`, error?.responseCode);
  console.log(`${LOG_TAG} ❌ ${label} — error.debugMessage:`, error?.debugMessage);
  console.log(`${LOG_TAG} ❌ ${label} — error.userInfo:`, safeStringify(error?.userInfo));
  console.log(`${LOG_TAG} ❌ ${label} — error.stack:`, error?.stack);
  console.log(`${LOG_TAG} ❌ ${label} — Object.keys(error):`, error ? Object.keys(error) : null);
};

const findSkuForLevel = (level: ProgramLevel): string | null => {
  try {
    return Platform.OS === "ios" ? APPLE_PROGRAM_PRODUCT_IDS[level] : GOOGLE_PROGRAM_PRODUCT_IDS[level];
  } catch (err) {
    console.log(`${LOG_TAG} 🔴 findSkuForLevel: не вдалося визначити sku для рівня`, level, err);
    return null;
  }
};

const findLevelForSku = (sku: string | undefined | null): ProgramLevel | null => {
  if (!sku) return null;

  const appleEntry = (Object.entries(APPLE_PROGRAM_PRODUCT_IDS) as [ProgramLevel, string][]).find(
    ([, value]) => value === sku,
  );
  if (appleEntry) return appleEntry[0];

  const googleEntry = (Object.entries(GOOGLE_PROGRAM_PRODUCT_IDS) as [ProgramLevel, string][]).find(
    ([, value]) => value === sku,
  );
  if (googleEntry) return googleEntry[0];

  return null;
};

export function usePackagePurchase(onPurchased?: (level: ProgramLevel) => void) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchasingLevel, setPurchasingLevel] = useState<ProgramLevel | null>(null);

  const {
    connected,
    products,
    fetchProducts,
    requestPurchase,
    finishTransaction,
  } = useIAP({
    onPurchaseSuccess: async (purchase: Purchase) => {
      console.log(`${LOG_TAG} ✅ onPurchaseSuccess ВИКЛИКАНО`);
      console.log(`${LOG_TAG} ✅ purchase full object:`, safeStringify(purchase));
      await handlePurchaseSuccess(purchase);
    },
    onPurchaseError: (error) => {
      console.log(`${LOG_TAG} 🔴 onPurchaseError ВИКЛИКАНО`);
      logErrorFull("onPurchaseError", error);
      setIsVerifying(false);
      setPurchasingLevel(null);
      setPurchaseError(
        error?.message || "Не вдалося завершити покупку. Спробуйте ще раз трохи пізніше.",
      );
    },
  });

  useEffect(() => {
    console.log(`${LOG_TAG} 🔌 connected змінився:`, connected);
  }, [connected]);

  useEffect(() => {
    if (!connected) {
      console.log(`${LOG_TAG} ⏸ fetchProducts пропущено — connected=false`);
      return;
    }

   const productIds: string[] = (
  Platform.OS === "ios"
    ? Object.values(APPLE_PROGRAM_PRODUCT_IDS)
    : Object.values(GOOGLE_PROGRAM_PRODUCT_IDS)
).filter((sku): sku is string => typeof sku === "string");

    (async () => {
      try {
        const result = await fetchProducts({ skus: productIds, type: "in-app" });
        console.log(`${LOG_TAG} ✅ fetchProducts (in-app) УСПІШНО завершився`);
        console.log(`${LOG_TAG} ✅ fetchProducts result:`, safeStringify(result));
      } catch (err) {
        console.log(`${LOG_TAG} 🔴 fetchProducts (in-app) ВИКИНУВ ПОМИЛКУ`);
        logErrorFull("fetchProducts", err);
        // 🟢 Навмисно НЕ виставляємо purchaseError тут: відсутність
        // каталогу продуктів (напр. поки Apple/Google ще не
        // проревʼювили In-App Purchase) не повинна блокувати весь
        // екран — просто ціни в pricing лишаться null і UI покаже
        // резервну ціну з LEVEL_PACKAGES.
      }
    })();
  }, [connected]);

  const handlePurchaseSuccess = useCallback(
    async (purchase: Purchase, transfer: boolean = false) => {
      const level = findLevelForSku(purchase.productId);

      if (!level) {
        console.log(`${LOG_TAG} 🔴 handlePurchaseSuccess: невідомий productId, ігнорую`, purchase.productId);
        return;
      }

      setIsVerifying(true);
      setPurchaseError(null);

      try {
        if (Platform.OS === "ios") {
          const verifyResult = await verifyAppleProgramPurchase(level, purchase.purchaseToken as string, transfer);
          console.log(`${LOG_TAG} ✅ verifyAppleProgramPurchase result:`, safeStringify(verifyResult));
        } else {
          const verifyResult = await verifyGoogleProgramPurchase(
            level,
            purchase.productId,
            purchase.purchaseToken as string,
            transfer,
          );
          console.log(`${LOG_TAG} ✅ verifyGoogleProgramPurchase result:`, safeStringify(verifyResult));
        }

        try {
          await finishTransaction({ purchase, isConsumable: false });
          console.log(`${LOG_TAG} ✅ finishTransaction завершено успішно`);
        } catch (finishErr) {
          // 🟢 Навіть якщо finishTransaction не вдався (рідкісний
          // платформний збій), сервер уже підтвердив доступ вище — тому
          // не показуємо це як помилку покупки користувачу, лише логуємо.
          console.log(`${LOG_TAG} 🔴 finishTransaction ВИКИНУВ ПОМИЛКУ (доступ вже видано)`);
          logErrorFull("finishTransaction", finishErr);
        }

        onPurchased?.(level);
      } catch (error) {
        console.log(`${LOG_TAG} 🔴 handlePurchaseSuccess: помилка верифікації на бекенді`);
        logErrorFull("handlePurchaseSuccess/verify", error);
        setPurchaseError(
          "Не вдалося підтвердити покупку на сервері. Кошти списані не будуть втрачені — спробуйте відновити покупки трохи пізніше.",
        );
      } finally {
        setIsVerifying(false);
        setPurchasingLevel(null);
      }
    },
    [finishTransaction, onPurchased],
  );

 const buy = useCallback(
  async (level: ProgramLevel) => {
    setPurchaseError(null);
    setPurchasingLevel(level);

    // 🟡 ТИМЧАСОВО: мок-шлях замість реального App Store / Google Play
    // флоу — див. src/config/mockPurchases.ts.
    if (MOCK_PROGRAM_PURCHASES_ENABLED) {
      try {
        const access = await mockProgramPurchase(level);
        console.log(`${LOG_TAG} 🟡 mockProgramPurchase result:`, safeStringify(access));
        onPurchased?.(level);
      } catch (error: any) {
        console.log(`${LOG_TAG} 🔴 mockProgramPurchase ВИКИНУВ ПОМИЛКУ`);
        logErrorFull("mockProgramPurchase", error);
        setPurchaseError(
          error?.response?.data?.message ||
            error?.message ||
            "Не вдалося виконати тестову покупку. Перевірте, чи ввімкнено ENABLE_MOCK_PROGRAM_PURCHASES на сервері.",
        );
      } finally {
        setPurchasingLevel(null);
      }
      return;
    }

    if (!connected) {
      setPurchaseError("Магазин ще не готовий. Спробуйте, будь ласка, за кілька секунд.");
      setPurchasingLevel(null);
      return;
    }

    const sku = findSkuForLevel(level);
    if (!sku) {
      console.log(`${LOG_TAG} 🔴 buy(): не знайдено sku для рівня`, level);
      setPurchaseError("Цей пакет тимчасово недоступний для покупки.");
      setPurchasingLevel(null);
      return;
    }

    try {
      if (Platform.OS === "ios") {
        await requestPurchase({
          request: {
            apple: { sku },
          },
          type: "in-app",
        });
      } else {
        await requestPurchase({
          request: {
            google: { skus: [sku] },
          },
          type: "in-app",
        });
      }
    } catch (error: any) {
      console.log(`${LOG_TAG} 🔴 buy(): requestPurchase ВИКИНУВ ПОМИЛКУ`);
      logErrorFull("buy/requestPurchase", error);
      setPurchasingLevel(null);
      setPurchaseError(error?.message || "Не вдалося почати покупку. Спробуйте ще раз.");
    }
  },
  [requestPurchase, connected, onPurchased],
);

  const restore = useCallback(async () => {
    setIsRestoring(true);
    setPurchaseError(null);

    try {
      // Беремо результат напряму зі стора: стан availablePurchases з useIAP
      // у цьому замиканні ще старий, тож перше "Відновити" нічого не знаходило.
      const storePurchases = await fetchStorePurchases();

      const relevantPurchases = (storePurchases ?? []).filter((purchase) =>
        !!findLevelForSku(purchase.productId),
      );

      // Явне «Відновити покупки» — переносимо покупки на поточний акаунт.
      for (const purchase of relevantPurchases) {
        await handlePurchaseSuccess(purchase, true);
      }

      if (relevantPurchases.length === 0) {
        setPurchaseError("Активних покупок для відновлення не знайдено.");
      }
    } catch (error) {
      console.log(`${LOG_TAG} 🔴 restore(): помилка`);
      logErrorFull("restore", error);
      setPurchaseError("Не вдалося відновити покупки. Спробуйте ще раз.");
    } finally {
      setIsRestoring(false);
    }
  }, [handlePurchaseSuccess]);

  const pricing: LevelPricing = useMemo(() => {
    const result = {} as LevelPricing;
    for (const level of PROGRAM_LEVELS) {
      try {
        const sku = findSkuForLevel(level);
        const product = products?.find((p: any) => p.id === sku || p.productId === sku) as any;
        result[level] = product?.displayPrice ?? product?.localizedPrice ?? null;
      } catch (err) {
        console.log(`${LOG_TAG} 🔴 pricing: помилка обчислення для рівня`, level, err);
        result[level] = null;
      }
    }
    return result;
  }, [products]);

  return {
    connected,
    buy,
    restore,
    isVerifying,
    isRestoring,
    purchasingLevel,
    purchaseError,
    pricing,
  };
}