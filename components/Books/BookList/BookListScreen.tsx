import { colors } from '../../../styles/theme';
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  Image,
  Pressable,
  InteractionManager,
  ImageSourcePropType,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { styles } from './BookList.styles';
import { BookLevel, BackBookmark } from '../../../types/books';
import { LEVEL_COLORS } from '../../../lists/books';
import { useBookManager } from '../../../hooks/books/content/useBookManager';
import {
  getProgressSnapshot,
  resolveListPercentage,
  subscribeToProgress,
} from '../../../hooks/books/progress/useBookProgress';
import { BookmarksMenu, SavedBookmark } from '../Bookmarks/BookmarksMenu';
import { useFocusEffect } from '@react-navigation/native';
import PreloaderAnim from '../../../widgets/PreloaderAnim';
import { FadeInImage } from '../../../widgets/FadeInImage';

const storeFon = require('../../../../assets/images/ilustrations/storeFon.png') as ImageSourcePropType;

const PROGRESS_KEY_PREFIX = '@book_progress_';

export interface LocalBookProgress {
  percentage: number;
  lastReadPageId?: number;
  totalBookPages?: number;
}

let cachedLocalProgress: Record<number, LocalBookProgress> = {};

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const readLocalProgressMap = async (): Promise<Record<number, LocalBookProgress>> => {
  const keys = await AsyncStorage.getAllKeys();
  const progressKeys = keys.filter((k) => k.startsWith(PROGRESS_KEY_PREFIX));
  if (progressKeys.length === 0) return {};

  const stores = await AsyncStorage.multiGet(progressKeys);
  const map: Record<number, LocalBookProgress> = {};

  stores.forEach(([key, value]) => {
    if (!value) return;
    const bookId = parseInt(key.replace(PROGRESS_KEY_PREFIX, ''), 10);
    if (!isValidId(bookId)) return;

    try {
      const parsed = JSON.parse(value);
      if (typeof parsed?.percentage === 'number' && Number.isFinite(parsed.percentage)) {
        map[bookId] = {
          percentage: parsed.percentage,
          lastReadPageId: isValidId(parsed.lastReadPageId) ? parsed.lastReadPageId : undefined,
          totalBookPages: Number.isFinite(parsed.totalBookPages) ? parsed.totalBookPages : undefined,
        };
      }
    } catch (e) {
      return;
    }
  });

  return map;
};

interface Props {
  onSelectBook: (bookId: number, level: BookLevel, pageId: number) => void;
  onOpenDetails: (bookId: number, level: BookLevel) => void;
}

const LEVEL_ORDER: Record<string, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
};

export const BookListScreen: React.FC<Props> = ({ onSelectBook, onOpenDetails }) => {
  const [selectedLevel, setSelectedLevel] = useState<string>('All');
  const [isBookmarksVisible, setIsBookmarksVisible] = useState(false);
  const [localProgress, setLocalProgress] =
    useState<Record<number, LocalBookProgress>>(cachedLocalProgress);

  const isRefreshingProgressRef = useRef(false);

  // Робочий стан прогресу (той самий, що на екрані книги) змінюється вже
  // після виходу з читалки — коли сервер підтверджує синхронізацію.
  // Підписка оновлює картки одразу, без повторного входу на екран.
  const [progressVersion, setProgressVersion] = useState(0);
  useEffect(() => subscribeToProgress(() => setProgressVersion((v) => v + 1)), []);

  const { books, isLoading, error, fetchAllBooks, myBookmarks, fetchMyBookmarks, removeBookmark } = useBookManager();

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      fetchAllBooks();
      if (fetchMyBookmarks) fetchMyBookmarks();

      const task = InteractionManager.runAfterInteractions(() => {
        if (!isActive) return;
        if (isRefreshingProgressRef.current) return;
        isRefreshingProgressRef.current = true;

        readLocalProgressMap()
          .then((map) => {
            cachedLocalProgress = map;
            if (isActive) {
              setLocalProgress(map);
            }
          })
          .catch((err) => {
            console.error('Помилка завантаження локального прогресу для списку:', err);
          })
          .finally(() => {
            isRefreshingProgressRef.current = false;
          });
      });

      return () => {
        isActive = false;
        task.cancel();
      };
    }, [fetchAllBooks, fetchMyBookmarks])
  );

  const processedBooks = useMemo(() => {
    return books
      .filter((b) => {
        if (selectedLevel === 'All') return true;
        if (!b.level) return false;
        const backendLvl = b.level.toUpperCase().trim();
        if (selectedLevel === 'A1-A2') return backendLvl === 'A1' || backendLvl === 'A2';
        if (selectedLevel === 'C1-C2') return backendLvl === 'C1' || backendLvl === 'C2';
        return backendLvl === selectedLevel.toUpperCase().trim();
      })
      .map((book, originalIndex) => ({ book, originalIndex }))
      .sort((a, b) => {
        const lvlA = (a.book.level || 'A1').toUpperCase().trim();
        const lvlB = (b.book.level || 'A1').toUpperCase().trim();
        const diff = (LEVEL_ORDER[lvlA] || 0) - (LEVEL_ORDER[lvlB] || 0);
        return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
      })
      .map(({ book }) => book);
  }, [books, selectedLevel]);

  const levels: string[] = ['All', 'A1-A2', 'B1', 'B2', 'C1-C2'];

  const formattedBookmarks: SavedBookmark[] = useMemo(() => {
    const safeBookmarks = Array.isArray(myBookmarks) ? myBookmarks : [];

    return safeBookmarks
      .map((bookmark: BackBookmark): SavedBookmark | null => {
        const book = bookmark?.page?.chapter?.book;
        const chapterTitle = bookmark?.page?.chapter?.title ?? 'Розділ';
        const pageNumber = bookmark?.page?.pageNumber ?? '?';
        const bookTitle = book?.title ?? 'Невідома книга';
        const bookId = book?.id;
        const targetPageId = bookmark?.page?.id;
        const bLvl = (book?.level || 'A1').toUpperCase().trim();

        if (!isValidId(bookId) || !isValidId(targetPageId)) return null;

        return {
          color: bookmark?.color ?? colors.black,
          title: `${bookTitle} — ${chapterTitle}`,
          bookTitle,
          chapterTitle,
          path: JSON.stringify({ bookId, level: bLvl, targetPageId }),
        };
      })
      .filter((b): b is SavedBookmark => b !== null);
  }, [myBookmarks]);

  const renderBookItem = useCallback(
    ({ item }: { item: any }) => {
      const cleanLvl = (item.level || 'A1').toUpperCase().trim() as BookLevel;

      // Те саме джерело і правило, що й на екрані книги: робочий стан
      // (або збережений на диску), зведений із серверним значенням каталогу.
      // Раніше диск мав пріоритет над сервером, тому список міг показувати
      // на 1% менше, ніж екран книги після її відкриття.
      const localData = getProgressSnapshot(item.id) ?? localProgress[item.id] ?? null;
      const serverRaw =
        item?.progressPercentage ?? item?.progress?.percentage ?? item?.userProgress?.percentage;
      const serverData =
        serverRaw !== undefined && serverRaw !== null && Number.isFinite(Number(serverRaw))
          ? { percentage: Number(serverRaw), totalPages: Number(item?.totalPagesCount) || 0 }
          : null;
      const progress = resolveListPercentage(localData, serverData);

      return (
        <Pressable style={styles.bookCard} onPress={() => onOpenDetails(item.id, cleanLvl)}>
          <FadeInImage
            source={item.coverImage ? { uri: item.coverImage } : storeFon}
            style={styles.bookCover}
            resizeMode="cover"
          />
          <View style={styles.cardInfo}>
            <Text style={styles.progressText}>{`${progress}% прогрес`}</Text>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${progress}%` }]} />
            </View>
          </View>
        </Pressable>
      );
    },
    [onOpenDetails, localProgress, progressVersion]
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerContainer}>
        <Text style={styles.headerTitle}>Бібліотека</Text>

        <View style={styles.headerActionsRow}>
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
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText}>Помилка: {error}</Text>
          <Pressable onPress={fetchAllBooks} style={styles.errorRetryButton}>
            <Text style={styles.errorRetryButtonText}>Спробувати ще раз</Text>
          </Pressable>
        </View>
      )}

      {isLoading && !error ? (
        <PreloaderAnim />
      ) : (
        <FlatList
          data={processedBooks}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          numColumns={2}
          columnWrapperStyle={styles.rowWrapper}
          ListEmptyComponent={
            !error ? <Text style={styles.emptyText}>У цьому розділі поки немає книг 📚</Text> : null
          }
          renderItem={renderBookItem}
          extraData={progressVersion}
          initialNumToRender={8}
          maxToRenderPerBatch={10}
          windowSize={5}
          // Вимкнено: на Android у новій архітектурі removeClippedSubviews може давати
          // нативне падіння при зміні елементів списку (IndexOutOfBoundsException).
          removeClippedSubviews={false}
        />
      )}

      <BookmarksMenu
        visible={isBookmarksVisible}
        setVisible={setIsBookmarksVisible}
        mode="view"
        savedBookmarks={formattedBookmarks}
        onDeleteBookmark={(bookmark: SavedBookmark) => {
          try {
            const target = JSON.parse(bookmark.path);
            if (isValidId(target?.targetPageId)) removeBookmark(target.targetPageId);
          } catch (e) {
            console.error('Помилка видалення закладки', e);
          }
        }}
        onNavigateToBookmark={(bookmark: SavedBookmark) => {
          try {
            const target = JSON.parse(bookmark.path);
            if (!isValidId(target?.bookId) || !isValidId(target?.targetPageId)) return;
            setIsBookmarksVisible(false);
            onSelectBook(target.bookId, target.level as BookLevel, target.targetPageId);
          } catch (e) {
            console.error('Помилка навігації', e);
          }
        }}
      />
    </View>
  );
};