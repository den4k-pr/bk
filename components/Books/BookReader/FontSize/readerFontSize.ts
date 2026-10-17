import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Єдине джерело істини для розміру шрифту рідера.
 *
 * Навіщо окремий модуль, а не useState + AsyncStorage у компоненті:
 *
 * 1. Значення кешується на рівні МОДУЛЯ, тож живе між монтуваннями екрана.
 *    Друге і всі наступні відкриття книги отримують правильний розмір
 *    СИНХРОННО, без проміжного кадру з DEFAULT_FONT_SIZE.
 *
 * 2. Запис на диск дебаунситься тут, а не в компоненті. Раніше таймер
 *    запису жив у ref компонента і clearTimeout у cleanup при розмонтуванні
 *    ПРОСТО ВБИВАВ незбережене значення: змінив розмір → одразу вийшов
 *    з рідера → на диск нічого не потрапило → наступного разу старий розмір.
 *    Тепер таймер поза компонентом, а flush можна викликати явно.
 *
 * 3. Читання з диска — рівно одне на сесію застосунку (hydration promise
 *    ділиться між усіма викликачами).
 */

export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 28;
export const DEFAULT_FONT_SIZE = 18;
export const FONT_SIZE_STEP = 2;

const STORAGE_KEY = '@reader_font_size';
const PERSIST_DEBOUNCE_MS = 400;

let cachedFontSize: number | null = null;
let hydrationPromise: Promise<number> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistValue: number | null = null;

const isValidFontSize = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= MIN_FONT_SIZE &&
  value <= MAX_FONT_SIZE;

export const clampFontSize = (value: number): number =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));

/**
 * Синхронно повертає вже відомий розмір або null, якщо диск ще не читали.
 * Використовується як ініціалізатор useState — саме це прибирає «стрибок».
 */
export function peekReaderFontSize(): number | null {
  return cachedFontSize;
}

/**
 * Одноразове читання з диска. Ніколи не реджектиться: у найгіршому
 * випадку резолвиться дефолтом, щоб гейт готовності не завис назавжди.
 */
export function hydrateReaderFontSize(): Promise<number> {
  if (cachedFontSize !== null) return Promise.resolve(cachedFontSize);
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      // Якщо користувач устиг змінити розмір, поки читався диск —
      // його дія важливіша за збережене значення.
      if (cachedFontSize !== null) return cachedFontSize;

      const parsed = raw !== null ? parseInt(raw, 10) : NaN;
      cachedFontSize = isValidFontSize(parsed) ? parsed : DEFAULT_FONT_SIZE;
      return cachedFontSize;
    })
    .catch(() => {
      if (cachedFontSize === null) cachedFontSize = DEFAULT_FONT_SIZE;
      return cachedFontSize;
    });

  return hydrationPromise;
}

/**
 * Оновлює розмір: кеш — миттєво, диск — з дебаунсом.
 * Повертає застосоване (обрізане межами) значення.
 */
export function setReaderFontSize(next: number): number {
  const safe = clampFontSize(next);

  cachedFontSize = safe;
  pendingPersistValue = safe;

  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushReaderFontSize, PERSIST_DEBOUNCE_MS);

  return safe;
}

/**
 * Негайний запис незбереженого значення. Викликати при розмонтуванні
 * рідера і при переході застосунку у фон.
 */
export function flushReaderFontSize(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingPersistValue === null) return;

  const value = pendingPersistValue;
  pendingPersistValue = null;

  AsyncStorage.setItem(STORAGE_KEY, String(value)).catch(() => {
    // Запис не вдався — повертаємо значення в чергу, наступний
    // flush спробує ще раз. Кеш при цьому лишається коректним.
    pendingPersistValue = value;
  });
}