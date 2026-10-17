import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useIAP, getAvailablePurchases as fetchStorePurchases, type Purchase } from 'react-native-iap';
import { DICTIONARY_PRODUCT_IDS } from '../config/iap';
import { MOCK_PROGRAM_PURCHASES_ENABLED } from '../config/mockPurchases';
import {
  mockDictionaryPurchase,
  verifyAppleDictionaryPurchase,
  verifyGoogleDictionaryPurchase,
} from '../services/dictionaryCapacityService';
import { notifyDictionaryCapacityChanged } from '../services/dictionaryLimitBus';

/**
 * Разова покупка "Безлімітний словник" (Non-Consumable). Та сама схема, що й
 * usePackagePurchase: магазин → перевірка квитанції на сервері →
 * finishTransaction; "Відновити покупки"; тестова покупка під тим самим
 * прапорцем MOCK_PROGRAM_PURCHASES_ENABLED.
 */
const SKU = Platform.OS === 'ios' ? DICTIONARY_PRODUCT_IDS.apple : DICTIONARY_PRODUCT_IDS.google;
const isDictionarySku = (sku?: string | null) =>
  sku === DICTIONARY_PRODUCT_IDS.apple || sku === DICTIONARY_PRODUCT_IDS.google;

export function useDictionaryPurchase(onPurchased?: () => void) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const finishPurchased = useCallback(() => {
    notifyDictionaryCapacityChanged();
    onPurchased?.();
  }, [onPurchased]);

  const { connected, products, fetchProducts, requestPurchase, finishTransaction } = useIAP({
    onPurchaseSuccess: async (purchase: Purchase) => {
      await handlePurchaseSuccess(purchase);
    },
    onPurchaseError: (error) => {
      console.log('[IAP-DICTIONARY] onPurchaseError', error?.code, error?.message);
      setIsVerifying(false);
      setIsPurchasing(false);
      setPurchaseError(error?.message || 'Не вдалося завершити покупку. Спробуйте ще раз трохи пізніше.');
    },
  });

  useEffect(() => {
    if (!connected) return;
    fetchProducts({ skus: [SKU], type: 'in-app' }).catch((err: unknown) => {
      // Каталог ще не готовий (товар не пройшов рев'ю) — ціна просто не з'явиться.
      console.log('[IAP-DICTIONARY] fetchProducts error', err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const handlePurchaseSuccess = useCallback(
    async (purchase: Purchase, transfer = false) => {
      if (!isDictionarySku(purchase.productId)) return;
      setIsVerifying(true);
      setPurchaseError(null);
      try {
        if (Platform.OS === 'ios') {
          await verifyAppleDictionaryPurchase(purchase.purchaseToken as string, transfer);
        } else {
          await verifyGoogleDictionaryPurchase(purchase.productId, purchase.purchaseToken as string, transfer);
        }
        try {
          await finishTransaction({ purchase, isConsumable: false });
        } catch (finishErr) {
          // Сервер уже видав доступ — це не помилка покупки для людини.
          console.log('[IAP-DICTIONARY] finishTransaction error', finishErr);
        }
        finishPurchased();
      } catch (error) {
        console.log('[IAP-DICTIONARY] verify error', error);
        setPurchaseError(
          'Не вдалося підтвердити покупку на сервері. Кошти не втрачено — спробуйте «Відновити покупки» трохи пізніше.',
        );
      } finally {
        setIsVerifying(false);
        setIsPurchasing(false);
      }
    },
    [finishTransaction, finishPurchased],
  );

  const buy = useCallback(async () => {
    setPurchaseError(null);
    setIsPurchasing(true);

    if (MOCK_PROGRAM_PURCHASES_ENABLED) {
      try {
        await mockDictionaryPurchase();
        finishPurchased();
      } catch (error: any) {
        setPurchaseError(
          error?.response?.data?.message || error?.message || 'Не вдалося виконати тестову покупку.',
        );
      } finally {
        setIsPurchasing(false);
      }
      return;
    }

    if (!connected) {
      setPurchaseError('Магазин ще не готовий. Спробуйте, будь ласка, за кілька секунд.');
      setIsPurchasing(false);
      return;
    }

    try {
      if (Platform.OS === 'ios') {
        await requestPurchase({ request: { apple: { sku: SKU } }, type: 'in-app' });
      } else {
        await requestPurchase({ request: { google: { skus: [SKU] } }, type: 'in-app' });
      }
    } catch (error: any) {
      setIsPurchasing(false);
      setPurchaseError(error?.message || 'Не вдалося почати покупку. Спробуйте ще раз.');
    }
  }, [connected, requestPurchase, finishPurchased]);

  const restore = useCallback(async () => {
    setIsRestoring(true);
    setPurchaseError(null);
    try {
      const storePurchases = await fetchStorePurchases();
      const relevant = (storePurchases ?? []).filter(p => isDictionarySku(p.productId));
      for (const purchase of relevant) {
        await handlePurchaseSuccess(purchase, true);
      }
      if (relevant.length === 0) setPurchaseError('Покупку безлімітного словника не знайдено.');
    } catch (error) {
      console.log('[IAP-DICTIONARY] restore error', error);
      setPurchaseError('Не вдалося відновити покупки. Спробуйте ще раз.');
    } finally {
      setIsRestoring(false);
    }
  }, [handlePurchaseSuccess]);

  const price = useMemo(() => {
    const product = products?.find((p: any) => p.id === SKU || p.productId === SKU) as any;
    return (product?.displayPrice ?? product?.localizedPrice ?? null) as string | null;
  }, [products]);

  return {
    connected,
    buy,
    restore,
    price,
    isBusy: isPurchasing || isVerifying || isRestoring,
    isRestoring,
    purchaseError,
  };
}
