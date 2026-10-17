import { BookLevel } from '../types/books';

export interface BookReaderQuickSessionSnapshot {
  bookId: number;
  level: BookLevel;
  pageId: number;
}

interface LiveBookReaderPointer {
  bookId: number;
  level: BookLevel;
  getSnapshot: () => { pageId: number } | null;
}

// Скільки пам'ятаємо «читав цю книгу на цій сторінці»: повернення на вкладку
// «Книги» веде прямо туди.
export const QUICK_SESSION_TTL_MS = 30 * 60 * 1000;
// Скільки відкрита читалка лишається в пам'яті після переходу на іншу вкладку
// (повернення миттєве, без повторного завантаження).
export const READER_KEEP_ALIVE_MS = 3 * 60 * 1000;

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

let livePointer: LiveBookReaderPointer | null = null;
let storedSession: { snapshot: BookReaderQuickSessionSnapshot; capturedAt: number } | null = null;

export function registerLiveBookReaderPointer(pointer: LiveBookReaderPointer): void {
  livePointer = pointer;
  // Читалка відкрита зараз — давніший знімок більше не актуальний.
  storedSession = null;
}

export function unregisterLiveBookReaderPointer(pointer: LiveBookReaderPointer): void {
  if (livePointer === pointer) {
    livePointer = null;
  }
}

/** Читалка зараз змонтована (вкладку «Книги» ще не вивантажено). */
export function isBookReaderLive(): boolean {
  return livePointer !== null;
}

export function captureBookReaderQuickSession(): void {
  if (!livePointer) return;

  const snapshot = livePointer.getSnapshot();
  if (!snapshot || !isValidId(snapshot.pageId)) return;

  storedSession = {
    snapshot: {
      bookId: livePointer.bookId,
      level: livePointer.level,
      pageId: snapshot.pageId,
    },
    capturedAt: Date.now(),
  };
}

export function consumeBookReaderQuickSession(): BookReaderQuickSessionSnapshot | null {
  if (!storedSession) return null;

  const { snapshot, capturedAt } = storedSession;
  storedSession = null;

  if (Date.now() - capturedAt >= QUICK_SESSION_TTL_MS) {
    return null;
  }

  return snapshot;
}

export function clearBookReaderQuickSession(): void {
  storedSession = null;
}