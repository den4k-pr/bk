export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/**
 * Фільтр за рівнем самого слова (word.level) у Словнику й Повторенні.
 * Приймає 'A1', 'A1,B2', масив або 'Всі'/'all'. Повертає список рівнів;
 * порожній список — без фільтра (усі рівні).
 */
export const parseLevelsFilter = (raw?: string | string[] | null): string[] => {
  if (!raw) return [];
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((part) => String(part).trim().toUpperCase())
    .filter((part) => (CEFR_LEVELS as readonly string[]).includes(part));
  const unique = Array.from(new Set(parts));
  return unique.length >= CEFR_LEVELS.length ? [] : unique;
};
