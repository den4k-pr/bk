import { colors } from '../../../styles/theme';
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  FlatList,
  ImageSourcePropType,
  StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { styles } from './BookDetails.styles';
import { LEVEL_COLORS } from '../../../lists/books';
import { BookLevel, BackBookmark } from '../../../types/books';
import { BookmarksMenu, SavedBookmark } from '../Bookmarks/BookmarksMenu';
import { useBookManager, BackBookMeta, BackChapterMeta } from '../../../hooks/books/content/useBookManager';
import { useBookProgress } from '../../../hooks/books/progress/useBookProgress';
import PreloaderAnim from '../../../widgets/PreloaderAnim';
import { ChapterTitle } from '../../../widgets/ChapterTitle';
import { FadeInImage } from '../../../widgets/FadeInImage';

const storeFon = require('../../../../assets/images/ilustrations/storeFon.png') as ImageSourcePropType;

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const BOOK_DETAILS_RETRY_ATTEMPTS = 3;
const BOOK_DETAILS_RETRY_DELAY_MS = 1500;

interface Props {
  bookId: number;
  level: BookLevel;
  onBack: () => void;
  onStartReading: (pageId?: number) => void;
  onNotFound: () => void;
}

export const BookDetailsScreen: React.FC<Props> = ({
  bookId,
  level,
  onBack,
  onStartReading,
  onNotFound,
}) => {
  const {
    isLoading,
    currentBook,
    bookNotFound,
    error,
    myBookmarks,
    fetchBookDetails,
    fetchMyBookmarks,
    removeBookmark,
  } = useBookManager();

  const {
    currentProgress,
    progressBookId,
    isLoadingProgress,
    fetchProgress,
    getStartPageId,
  } = useBookProgress();

  const onNotFoundRef = useRef(onNotFound);
  useEffect(() => {
    onNotFoundRef.current = onNotFound;
  }, [onNotFound]);

  const onStartReadingRef = useRef(onStartReading);
  useEffect(() => {
    onStartReadingRef.current = onStartReading;
  }, [onStartReading]);

  const notFoundFiredForRef = useRef<number | null>(null);
  useEffect(() => {
    notFoundFiredForRef.current = null;
  }, [bookId]);

  // 🟢 НОВЕ: дзеркало bookNotFound у ref — потрібне лише для того, щоб
  // ретрай-цикл нижче міг перевірити "а може це взагалі 404, а не
  // тимчасовий збій мережі" без залежності від того, встиг React вже
  // перерендерити компонент чи ні (значення в ref читається одразу,
  // без затримки рендер-циклу).
  const bookNotFoundRef = useRef(bookNotFound);
  useEffect(() => {
    bookNotFoundRef.current = bookNotFound;
  }, [bookNotFound]);

  useEffect(() => {
    if (!bookNotFound) return;
    if (notFoundFiredForRef.current === bookId) return;
    notFoundFiredForRef.current = bookId;
    onNotFoundRef.current();
  }, [bookNotFound, bookId]);


  const fetchAttemptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchGenerationRef = useRef(0);

  const runFetchWithRetry = useCallback(
    (targetBookId: number) => {
      if (fetchAttemptTimerRef.current) {
        clearTimeout(fetchAttemptTimerRef.current);
        fetchAttemptTimerRef.current = null;
      }
      // 🟢 "Покоління" запиту — якщо запуститься новий цикл (напр. bookId
      // змінився або користувач ще раз тицьнув "Оновити" не чекаючи), усі
      // заплановані кроки СТАРОГО циклу самі себе тихо зупинять.
      const generation = ++fetchGenerationRef.current;

      const attemptFetch = async (attempt: number): Promise<void> => {
        const result = await fetchBookDetails(targetBookId);
        if (fetchGenerationRef.current !== generation) return;
        if (result) return; // успіх
        if (bookNotFoundRef.current) return; // 404 — ретраїти немає сенсу
        if (attempt >= BOOK_DETAILS_RETRY_ATTEMPTS) return; // спроби вичерпано — покажемо помилку з кнопкою "Оновити"

        await new Promise<void>((resolve) => {
          fetchAttemptTimerRef.current = setTimeout(resolve, BOOK_DETAILS_RETRY_DELAY_MS * attempt);
        });
        if (fetchGenerationRef.current !== generation) return;
        await attemptFetch(attempt + 1);
      };

      attemptFetch(1);
    },
    [fetchBookDetails]
  );

  useEffect(() => {
    if (!isValidId(bookId)) return;
    fetchMyBookmarks();
    runFetchWithRetry(bookId);

    return () => {
      // Скасовуємо будь-який цикл ретраю цього bookId, що ще не завершився.
      fetchGenerationRef.current += 1;
      if (fetchAttemptTimerRef.current) {
        clearTimeout(fetchAttemptTimerRef.current);
        fetchAttemptTimerRef.current = null;
      }
    };
  }, [bookId, fetchMyBookmarks, runFetchWithRetry]);

  useFocusEffect(
    useCallback(() => {
      if (!isValidId(bookId)) return;
      fetchProgress(bookId);
    }, [bookId, fetchProgress])
  );

  const [isBookmarksVisible, setIsBookmarksVisible] = useState<boolean>(false);

  const formattedBookmarks: SavedBookmark[] = useMemo(() => {
    const safeBookmarks = Array.isArray(myBookmarks) ? myBookmarks : [];
    return safeBookmarks
      .filter((bookmark: BackBookmark) => bookmark?.page?.chapter?.book?.id === bookId)
      .map((bookmark: BackBookmark): SavedBookmark | null => {
        const bookTitle = bookmark?.page?.chapter?.book?.title ?? 'Невідома книга';
        const chapterTitle = bookmark?.page?.chapter?.title ?? 'Розділ';
        const pageId = bookmark?.page?.id;
        if (!isValidId(pageId)) return null;
        return {
          color: bookmark?.color ?? colors.black,
          title: `${bookTitle} — ${chapterTitle}`,
          bookTitle,
          chapterTitle,
          path: String(pageId),
        };
      })
      .filter((b): b is SavedBookmark => b !== null);
  }, [myBookmarks, bookId]);

  const sortedChapters: BackChapterMeta[] = useMemo(() => {
    const chapters = Array.isArray(currentBook?.chapters) ? currentBook!.chapters : [];
    return chapters
      .map((chapter, originalIndex) => ({ chapter, originalIndex }))
      .sort((a, b) => (a.chapter.order - b.chapter.order) || (a.originalIndex - b.originalIndex))
      .map(({ chapter }) => chapter);
  }, [currentBook]);

  const firstPageId: number | null = useMemo(() => {
    const found = sortedChapters
      .map((chapter) => chapter.firstPageId)
      .find((id): id is number => isValidId(id));
    return found ?? null;
  }, [sortedChapters]);

  const savedPageId: number | null = useMemo(() => {
    return getStartPageId(bookId);
  }, [getStartPageId, bookId, progressBookId, currentProgress]);

  const displayedPercentage: number = useMemo(() => {
    if (progressBookId !== bookId) return 0;
    const raw = Number((currentProgress as any)?.percentage);
    if (!Number.isFinite(raw)) return 0;
    return Math.min(100, Math.max(0, Math.round(raw)));
  }, [progressBookId, bookId, currentProgress]);

  const hasSavedProgress = savedPageId !== null;
  const targetPageId = savedPageId ?? firstPageId;
  const isReadingDisabled = targetPageId === null;

  const handleContinueReading = useCallback((): void => {
    const freshSavedPageId = getStartPageId(bookId);
    const target = freshSavedPageId ?? firstPageId;
    if (target === null) {
      console.warn('У книзі немає доступних сторінок для читання');
      return;
    }
    onStartReadingRef.current(target);
  }, [getStartPageId, bookId, firstPageId]);

  const handleChapterPress = useCallback((chapter: BackChapterMeta): void => {
    if (isValidId(chapter?.firstPageId)) {
      onStartReadingRef.current(chapter.firstPageId as number);
      return;
    }
    console.warn('Цей розділ порожній');
  }, []);

  const renderHeader = useCallback(() => {
    if (!currentBook) return null;
    return (
      <View style={styles.posterSection}>
        <View style={styles.imageWrapper}>
          <FadeInImage
            source={currentBook.detailsImage ? { uri: currentBook.detailsImage } : storeFon}
            style={styles.posterImage}
            resizeMode="cover"
          />
          <View style={[styles.posterOverlay, StyleSheet.absoluteFillObject]}>
            <View style={styles.posterFooter}>
              <Text style={styles.progressText}>{displayedPercentage}%</Text>

              <Pressable
                style={({ pressed }) => [
                  styles.continueButton,
                  pressed && styles.continueButtonActive,
                  isReadingDisabled && localStyles.buttonDisabled,
                ]}
                disabled={isReadingDisabled}
                onPress={handleContinueReading}
              >
                <Text style={styles.continueButtonText}>
                  {hasSavedProgress ? 'Продовжити' : 'Розпочати'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  }, [
    currentBook,
    displayedPercentage,
    hasSavedProgress,
    isReadingDisabled,
    handleContinueReading,
  ]);

  const renderChapterItem = useCallback(
    ({ item: chapter }: { item: BackChapterMeta }) => (
      <Pressable style={styles.chapterCard} onPress={() => handleChapterPress(chapter)}>
        <FadeInImage
          source={chapter.imageUrl ? { uri: chapter.imageUrl } : storeFon}
          style={styles.chapterImage}
          resizeMode="cover"
        />
        <View style={styles.chapterInfo}>
          <Text style={styles.chapterName}>{chapter.title}</Text>
          <View style={styles.readAction}>
            <Text style={styles.actionText}>Читати</Text>
            <Image
              source={require('../../../../assets/images/icons/arrowBack.png')}
              style={styles.arrowIcon}
            />
          </View>
        </View>
      </Pressable>
    ),
    [handleChapterPress]
  );

  // 🟢 ГЛОБАЛЬНИЙ ФІКС: якщо книга не завантажилася при авто-відновленні (або через скидання у фоні) - не показуємо нескінченний лоадер
  if (!currentBook) {
    if (isLoading) {
      return <PreloaderAnim />;
    }
    
    return (
      <View style={[styles.container, localStyles.errorWrap]}>
        <Text style={localStyles.errorText}>
          {error || 'Не вдалося завантажити книгу. Перевірте підключення до мережі.'}
        </Text>
        <Pressable
          style={({ pressed }) => [
            localStyles.retryButton,
            pressed && localStyles.retryButtonPressed,
          ]}
          onPress={() => runFetchWithRetry(bookId)}
        >
          <Text style={localStyles.retryButtonText}>Оновити</Text>
        </Pressable>
        <Pressable style={{ marginTop: 24, padding: 10 }} onPress={onBack}>
          <Text style={{ color: '#F99511', fontSize: 16 }}>Повернутися назад</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.iconButton} onPress={onBack}>
          <Image
            style={styles.backButton_img}
            source={require('../../../../assets/images/icons/arrowBack.png')}
          />
        </Pressable>

        <View style={styles.headerTitle}>
          <ChapterTitle
            title={currentBook.title || ''}
            maxFontSize={14}
            minFontScale={0.4}
            wrapper_width={0.5}
            numberOfLines={2}
          />
        </View>

        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.buttonActive]}
          onPress={() => setIsBookmarksVisible(true)}
        >
          <Image
            style={styles.iconButton_img}
            source={require('../../../../assets/images/icons/bookmark-4.png')}
          />
        </Pressable>
      </View>

      <FlatList
        data={sortedChapters}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={renderHeader}
        renderItem={renderChapterItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scrollContent, styles.chaptersContainer]}
        initialNumToRender={5}
        maxToRenderPerBatch={10}
        windowSize={5}
        // Вимкнено: на Android у новій архітектурі removeClippedSubviews може давати
        // нативне падіння при зміні елементів списку (IndexOutOfBoundsException).
        removeClippedSubviews={false}
      />

      <BookmarksMenu
        visible={isBookmarksVisible}
        setVisible={setIsBookmarksVisible}
        mode="view"
        savedBookmarks={formattedBookmarks}
        onDeleteBookmark={(bookmark: SavedBookmark) => {
          const pageId = parseInt(bookmark.path, 10);
          if (isValidId(pageId)) removeBookmark(pageId);
        }}
        onNavigateToBookmark={(bookmark: SavedBookmark) => {
          const parsedPageId = parseInt(bookmark.path, 10);
          if (isValidId(parsedPageId)) {
            setIsBookmarksVisible(false);
            onStartReadingRef.current(parsedPageId);
          }
        }}
      />
    </View>
  );
};

const localStyles = StyleSheet.create({
  errorWrap: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    flex: 1,
  },
  errorText: {
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 16,
    color: colors.textPrimary,
  },
  retryButton: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 24,
    backgroundColor: '#F99511',
  },
  retryButtonPressed: {
    opacity: 0.7,
  },
  retryButtonText: {
    color: colors.white,
    fontWeight: '600',
    fontSize: 15
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
