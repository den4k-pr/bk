/**
 * NavigationRestorationContext.tsx
 *
 * Проблема, яку вирішує цей файл:
 *
 * Коли ми відновлюємо навігаційний стан після холодного старту і
 * найглибший сфокусований роут виявляється саме "BookReader", параметр
 * `pageId` у цьому роуті — це те, яким він був ПІД ЧАС ОСТАННЬОГО
 * збереження навігаційного стану (дебаунс на кожну зміну РОУТУ, а не на
 * кожен гортання сторінки всередині читалки — див. коментар у
 * navigationPersistence.ts, чому це навмисно). Тобто цей `pageId` може
 * бути СТАРІШИМ за реальне місце, де користувач зупинився — набагато
 * свіжіше джерело цього — currentProgress.lastReadPageId з
 * useBookProgress, що оновлюється при кожній зміні сторінки й (після
 * фіксу в BookReaderScreen) флашиться і при згортанні застосунку.
 *
 * АЛЕ віддавати перевагу збереженому прогресу треба ЛИШЕ для цього
 * єдиного, "холодного" монтування читалки — усі наступні ЖИВІ переходи
 * в читалку протягом цієї ж сесії (кнопка "Продовжити читання", вибір
 * розділу, перехід із закладки) вже самі явно й свідомо обирають
 * потрібний pageId, і їх не можна "перебивати" збереженим прогресом.
 *
 * Тому прапорець нижче:
 *  1. Обчислюється ОДИН РАЗ при завантаженні persisted-стану (App.tsx),
 *     і є `true` лише якщо відновлений стан веде НАПРЯМУ в BookReader.
 *  2. "Споживається" (consume) РІВНО один раз за весь час життя
 *     застосунку — перше монтування BookReaderScreen після старту, якщо
 *     прапорець true, забирає його собі; усі наступні монтування (в
 *     тій самій сесії) завжди отримують false, незалежно від значення
 *     контексту.
 */

import React, { createContext, useContext, useState } from 'react';

interface NavigationRestorationContextValue {
  restoredIntoBookReader: boolean;
}

const NavigationRestorationContext = createContext<NavigationRestorationContextValue>({
  restoredIntoBookReader: false,
});

export const NavigationRestorationProvider: React.FC<{
  restoredIntoBookReader: boolean;
  children: React.ReactNode;
}> = ({ restoredIntoBookReader, children }) => (
  <NavigationRestorationContext.Provider value={{ restoredIntoBookReader }}>
    {children}
  </NavigationRestorationContext.Provider>
);

// 🟢 Модульний (не React) прапорець — навмисно, щоб "спожити" сигнал
// рівно один раз за весь час життя JS-модуля (тобто за весь час життя
// поточного інстансу застосунку), незалежно від того, скільки разів
// компонент BookReaderScreen монтується/розмонтується протягом сесії.
// Скидається сам собою при повному перезапуску JS-рушія (холодний
// старт) або при жорсткому перемонтуванні застосунку через
// HardRemountContext у App.tsx — в обох випадках це коректно
// відповідає новому "початку сесії", для якого прапорець має право
// спрацювати знову.
let hasConsumedBookReaderRestorationFlag = false;

/** Викликати РІВНО з тіла BookReaderScreen (або обгортки над ним). */
export function useShouldPreferSavedProgressOnMount(): boolean {
  const { restoredIntoBookReader } = useContext(NavigationRestorationContext);

  // Лінива ініціалізація useState гарантовано виконується один раз за
  // монтування ЦЬОГО конкретного інстансу компонента — саме тут ми й
  // атомарно "забираємо" модульний прапорець собі, якщо він ще ніким не
  // спожитий.
  const [shouldPrefer] = useState<boolean>(() => {
    if (!restoredIntoBookReader) return false;
    if (hasConsumedBookReaderRestorationFlag) return false;
    hasConsumedBookReaderRestorationFlag = true;
    return true;
  });

  return shouldPrefer;
}

/** Викликати з App.tsx при кожному жорсткому перемонтуванні (новий appInstanceKey). */
export function resetBookReaderRestorationConsumption(): void {
  hasConsumedBookReaderRestorationFlag = false;
}