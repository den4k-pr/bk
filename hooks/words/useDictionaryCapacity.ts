import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { DictionaryCapacity, getDictionaryCapacity } from '../../services/dictionaryCapacityService';
import {
  subscribeDictionaryCapacityChanged,
  subscribeDictionaryLimitReached,
} from '../../services/dictionaryLimitBus';
import { subscribeDictionaryWordsMutated } from '../../services/dictionaryMutationBus';

/**
 * Стан словника (ліміт) для Словника. Оновлюється при відкритті екрана,
 * після додавання / видалення слів, після покупки і коли сервер відмовив
 * додати слово. Помилка мережі — просто без кнопки (нічого не показуємо).
 */
export const useDictionaryCapacity = () => {
  const [capacity, setCapacity] = useState<DictionaryCapacity | null>(null);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const next = await getDictionaryCapacity();
      if (requestId === requestIdRef.current) setCapacity(next);
    } catch {
      // залишаємо попередній стан
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  useEffect(() => {
    const unsubs = [
      subscribeDictionaryWordsMutated(reload),
      subscribeDictionaryCapacityChanged(reload),
      subscribeDictionaryLimitReached(() => reload()),
    ];
    return () => unsubs.forEach(unsub => unsub());
  }, [reload]);

  return capacity;
};

/** Показувати кнопку "Додати місце" — лише коли словник заповнено. */
export const shouldShowCapacityButton = (capacity: DictionaryCapacity | null): boolean =>
  !!capacity && !capacity.unlimited && capacity.reached;
