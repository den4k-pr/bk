import { useEffect, useRef } from 'react';
import { HighlightMenuCoords } from '../../../types/BookReader.types';
import { ExtendedSelectedPhrase } from '../../../types/BookReader.internal.types';
import { SurfaceAnalysis, WordType } from '../../../types/words';

/**
 * Стан виділення в читалці, який має пережити вихід із книги: натиснуте
 * слово / обведена фраза і відкрита картка перекладу.
 *
 * Навіщо: вкладка «Книги» розмонтовується, щойно користувач переходить на
 * іншу (наприклад, у Словник після додавання слова). Позиція читання
 * відновлювалась із прогресу, а виділення й картка перекладу жили лише в
 * стані компонента і зникали. Тепер вони зберігаються тут (на час роботи
 * застосунку) і відновлюються при поверненні на ту саму сторінку.
 *
 * Запис стирається, коли користувач сам закриває переклад / знімає
 * виділення або гортає на іншу сторінку (usePhraseSelection.handleClearSelection).
 */
export interface ReaderSelectionSnapshot {
  selectedPhrase: ExtendedSelectedPhrase | null;
  lookup: {
    context: string;
    fallbackQuery?: string;
    fallbackIndex?: number;
    phraseSurface?: string;
  } | null;
  wordDetails: WordType | null;
  isAdded: boolean;
  userWordId: number | null;
  surfaceTranslation: string | null;
  surfaceAnalysis: SurfaceAnalysis | null;
  verbForms: string[] | null;
  isReported: boolean;
  highlightMenuCoords: HighlightMenuCoords | null;
}

interface SavedReaderSelection {
  pageId: number;
  snapshot: ReaderSelectionSnapshot;
}

const savedByBook = new Map<number, SavedReaderSelection>();

export const readerSelectionStore = {
  get(bookId: number | undefined): SavedReaderSelection | null {
    return bookId === undefined ? null : savedByBook.get(bookId) ?? null;
  },
  set(bookId: number | undefined, pageId: number, snapshot: ReaderSelectionSnapshot): void {
    if (bookId === undefined) return;
    savedByBook.set(bookId, { pageId, snapshot });
  },
  clear(bookId: number | undefined): void {
    if (bookId === undefined) return;
    savedByBook.delete(bookId);
  },
  /** Вихід з акаунта / тести. */
  reset(): void {
    savedByBook.clear();
  },
};

interface UseReaderSelectionPersistenceParams {
  bookId: number | undefined;
  /** Сторінка, що зараз на екрані (undefined — ще не відома). */
  currentPageId: number | undefined;
  /** Поточний стан виділення з usePhraseSelection. */
  snapshot: ReaderSelectionSnapshot;
  restoreSelection: (snapshot: ReaderSelectionSnapshot) => void;
}

/**
 * Зберігає поточне виділення і відновлює його при поверненні в книгу.
 *  - Є виділення → запис оновлюється (разом зі сторінкою, на якій воно зроблене).
 *  - Читалка відкрилась без виділення, а запис для цієї сторінки є →
 *    відновлюємо один раз.
 * Стирання запису — лише явною дією користувача (handleClearSelection), тож
 * розмонтування читалки його не чіпає.
 */
export function useReaderSelectionPersistence({
  bookId,
  currentPageId,
  snapshot,
  restoreSelection,
}: UseReaderSelectionPersistenceParams): void {
  const restoredForBookRef = useRef<number | null>(null);
  const restoreRef = useRef(restoreSelection);
  restoreRef.current = restoreSelection;

  const hasSelection = !!snapshot.selectedPhrase;

  // Відновлення: один раз на відкриття книги, щойно на екрані потрібна сторінка.
  useEffect(() => {
    if (bookId === undefined || currentPageId === undefined) return;
    if (restoredForBookRef.current === bookId) return;
    if (hasSelection) {
      // Користувач уже щось виділив — відновлювати нічого.
      restoredForBookRef.current = bookId;
      return;
    }
    const saved = readerSelectionStore.get(bookId);
    if (!saved) {
      restoredForBookRef.current = bookId;
      return;
    }
    // Запис є, але на екрані ще інша сторінка (читалка саме переходить до
    // збереженої позиції) — чекаємо, поки сторінки збіжаться.
    if (saved.pageId !== currentPageId) return;
    restoredForBookRef.current = bookId;
    restoreRef.current(saved.snapshot);
  }, [bookId, currentPageId, hasSelection]);

  // Збереження: будь-яка зміна стану виділення на поточній сторінці.
  useEffect(() => {
    if (bookId === undefined || currentPageId === undefined || !snapshot.selectedPhrase) return;
    readerSelectionStore.set(bookId, currentPageId, snapshot);
  }, [bookId, currentPageId, snapshot]);
}
