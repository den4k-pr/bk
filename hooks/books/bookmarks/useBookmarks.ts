import { colors } from '../../../styles/theme';
import { useCallback, useEffect, useMemo } from 'react';
import { SavedBookmark } from '../../../components/Books/Bookmarks/BookmarksMenu';
import { BackBookmark, BookLevel, ReaderPage } from '../../../types/books';
import { BackBookMeta } from '../content/useBookManager';

interface UseBookmarksParams {
  bookId: number;
  currentBook: BackBookMeta | null;
  myBookmarks: BackBookmark[];
  fetchMyBookmarks: () => Promise<void>;
  setBookmark: (pageId: number, color: string) => Promise<void>;
  removeBookmark: (pageId: number) => Promise<void>;
  chapterPages: ReaderPage[];
  displayIndex: number;
  /**
   * 🔴 Єдина точка входу для програмної навігації.
   * Раніше цей хук сам смикав flatListRef + setDisplayChapterIndex +
   * notifyPageHandled, тобто був ТРЕТІМ незалежним записувачем індексу
   * сторінки. Тепер він лише просить навігаційний хук перейти.
   */
  goToPageId: (pageId: number) => boolean;
  /** Закладка з іншої книги: відкрити ту книгу одразу на цій сторінці. */
  onOpenOtherBook?: (bookId: number, level: BookLevel, pageId: number) => void;
}

interface UseBookmarksResult {
  formattedBookmarks: SavedBookmark[];
  /** Усі закладки користувача (усі книги) — для спільного ліміту 100. */
  totalBookmarksCount: number;
  currentPageInfoPath: string;
  handleSaveBookmark: (color: string, title: string, path: string) => Promise<void>;
  handleNavigateToBookmark: (bookmark: SavedBookmark) => void;
  handleDeleteBookmark: (bookmark: SavedBookmark) => Promise<void>;
}

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

export function useBookmarks({
  bookId,
  currentBook,
  myBookmarks,
  fetchMyBookmarks,
  setBookmark,
  removeBookmark,
  chapterPages,
  displayIndex,
  goToPageId,
  onOpenOtherBook,
}: UseBookmarksParams): UseBookmarksResult {
  useEffect(() => {
    fetchMyBookmarks();
  }, [bookId, fetchMyBookmarks]);

  const formattedBookmarks: SavedBookmark[] = useMemo(() => {
    const safeBookmarks = Array.isArray(myBookmarks) ? myBookmarks : [];

    // /books/me/bookmarks повертає закладки з усіх книг — у читалці показуємо
    // лише закладки книги, яку зараз читають.
    return safeBookmarks
      .filter((b) => b?.page?.chapter?.book?.id === bookId && isValidId(b?.page?.id))
      .map((b) => {
        const bookTitle = b?.page?.chapter?.book?.title || 'Невідома книга';
        const chapterTitle = b?.page?.chapter?.title || 'Невідомий розділ';

        return {
          color: b?.color || colors.black,
          title: `${bookTitle} — ${chapterTitle}`,
          bookTitle,
          chapterTitle,
          path: JSON.stringify({
            bookId: b?.page?.chapter?.book?.id,
            pageId: b?.page?.id,
          }),
        };
      });
  }, [myBookmarks, bookId]);

  const currentPageInfoPath = useMemo(() => {
    return JSON.stringify({
      bookId: currentBook?.id,
      pageId: chapterPages[displayIndex]?.id,
    });
  }, [currentBook?.id, chapterPages, displayIndex]);

  const handleSaveBookmark = useCallback(
    async (color: string, title: string, path: string): Promise<void> => {
      try {
        const { pageId } = JSON.parse(path);
        if (isValidId(pageId)) {
          await setBookmark(pageId, color);
        } else {
          console.warn('Помилка збереження закладки: некоректний pageId у шляху', path);
        }
      } catch (error) {
        console.error('Помилка збереження закладки:', error);
      }
    },
    [setBookmark],
  );

  const handleDeleteBookmark = useCallback(
    async (bookmark: SavedBookmark): Promise<void> => {
      try {
        const { pageId } = JSON.parse(bookmark.path);
        if (isValidId(pageId)) {
          await removeBookmark(pageId);
        } else {
          console.warn('Помилка видалення закладки: некоректний pageId у шляху', bookmark.path);
        }
      } catch (error) {
        console.error('Помилка видалення закладки:', error);
      }
    },
    [removeBookmark],
  );

  const handleNavigateToBookmark = useCallback(
    (bookmark: SavedBookmark): void => {
      try {
        const { bookId: targetBookId, pageId: targetPageId } = JSON.parse(bookmark.path);

        if (!isValidId(targetPageId)) {
          console.warn('Некоректний pageId у закладці:', bookmark.path);
          return;
        }

        if (targetBookId === bookId) {
          const moved = goToPageId(targetPageId);
          if (!moved) {
            console.warn('Сторінку закладки не знайдено в поточній книзі:', targetPageId);
          }
          return;
        }

        // Закладка іншої книги — відкриваємо ту книгу одразу на сторінці.
        if (!isValidId(targetBookId) || !onOpenOtherBook) return;
        const source = (Array.isArray(myBookmarks) ? myBookmarks : []).find(
          (b) => b?.page?.id === targetPageId,
        );
        const level = String(source?.page?.chapter?.book?.level || 'A1').toUpperCase().trim() as BookLevel;
        onOpenOtherBook(targetBookId, level, targetPageId);
      } catch (e) {
        console.error('Помилка парсингу шляху закладки:', e);
      }
    },
    [bookId, goToPageId, onOpenOtherBook, myBookmarks],
  );

  const totalBookmarksCount = Array.isArray(myBookmarks) ? myBookmarks.length : 0;

  return {
    formattedBookmarks,
    totalBookmarksCount,
    currentPageInfoPath,
    handleSaveBookmark,
    handleNavigateToBookmark,
    handleDeleteBookmark,
  };
}
