/**
 * Реклама в картках: після кожних CYCLES_PER_AD завершених колод (3 колоди ×
 * 3 слова = 9 слів). Лічильник спільний для карток і карток словника й живе
 * всю сесію застосунку — раніше він обнулявся при кожному відкритті екрана,
 * тож вийшов-повернувся = реклама відкладалась знову з нуля.
 */
const CYCLES_PER_AD = 3;

let completedCycles = 0;

/** Зафіксувати завершену колоду. true — час показати рекламу. */
export const registerCompletedCardCycle = (): boolean => {
  completedCycles += 1;
  return completedCycles % CYCLES_PER_AD === 0;
};
