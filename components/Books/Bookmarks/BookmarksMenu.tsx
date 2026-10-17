import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  Text,
  View,
  StyleSheet,
  Animated,
  Easing,
  ScrollView,
  Image, // Використовуємо стандартний Image для 100% стабільності з tintColor
  useWindowDimensions,
} from 'react-native';
import { styles, localStyles } from './BookmarksMenu.styles';
import { SwipeableBookmarkRow } from './SwipeableBookmarkRow';

// Використовується лише як стартове зміщення анімації появи/зникнення.
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const MODAL_ANIM_OPEN_MS = 200;
const MODAL_ANIM_CLOSE_MS = 140;


const BOOKMARK_COLORS = [
  '#E76F51', // Теплий кораловий
  '#2A9D8F', // Глибокий бірюзово-м'ятний
  '#E9C46A', // Теплий гірчично-жовтий
  '#F4A261', // Пісочно-персиковий
  '#264653', // Темний петрол (синьо-зелений)
  '#9B5DE5', // Теплий фіолетовий
  '#F15BB5', // Насичений рожевий
];

// Максимальна кількість закладок (має збігатися із серверним лімітом).
const MAX_BOOKMARKS = 100;

// Вікно займає не більше 75% висоти екрана; список усередині скролиться.
const MODAL_MAX_HEIGHT_RATIO = 0.70;

export interface SavedBookmark {
  color: string;
  title: string;
  /** Назва книги — окремим полем, щоб показувати «Книга — Розділ» у два рядки. */
  bookTitle?: string;
  /** Назва розділу — окремим полем для підзаголовка рядка. */
  chapterTitle?: string;
  path: string;
}

interface BookmarksMenuProps {
  visible: boolean;
  setVisible: (visible: boolean) => void;
  mode: 'view' | 'edit';

  currentPageTitle?: string;
  currentPageBookTitle?: string;
  currentPagePath?: string;

  savedBookmarks: SavedBookmark[];

  onNavigateToBookmark: (bookmark: SavedBookmark) => void;
  /**
   * УВАГА: колір — лише оформлення і може повторюватись (закладок до 100,
   * кольорів 7). Обробник має ідентифікувати закладку за `path`, а не за кольором.
   */
  onSaveBookmark?: (color: string, title: string, path: string) => void;
  onDeleteBookmark?: (bookmark: SavedBookmark) => void;
  /**
   * Скільки закладок у користувача загалом (усі книги). Ліміт 100 спільний,
   * а savedBookmarks у читалці — лише закладки цієї книги.
   */
  totalBookmarksCount?: number;
}

export const BookmarksMenu: React.FC<BookmarksMenuProps> = ({
  visible,
  setVisible,
  mode,
  currentPageTitle = '',
  currentPageBookTitle = '',
  currentPagePath = '',
  savedBookmarks,
  onNavigateToBookmark,
  onSaveBookmark,
  onDeleteBookmark,
  totalBookmarksCount,
}) => {
  const { height: windowHeight } = useWindowDimensions();

  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const contentTranslateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const openAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Гвард від повторного закриття (подвійний тап по фону / по рядку):
  // без нього колбек навігації міг спрацювати двічі.
  const closingRef = useRef(false);

  // Синхронний гвард проти дабл-кліку по «Додати»: стан React оновлюється
  // асинхронно, тож два швидкі тапи надіслали б два запити. Зберігаємо path,
  // щоб після видалення цієї закладки її можна було додати знову.
  const addingPathRef = useRef<string | null>(null);

  const [deletedPaths, setDeletedPaths] = useState<string[]>([]);
  // Оптимістично додані закладки — з кольором, зафіксованим у момент додавання.
  const [pendingAdds, setPendingAdds] = useState<SavedBookmark[]>([]);

  const [isSwipingRow, setIsSwipingRow] = useState(false);
  const handleSwipeStart = useCallback(() => setIsSwipingRow(true), []);
  const handleSwipeEnd = useCallback(() => setIsSwipingRow(false), []);

  useEffect(() => {
    if (!visible) return;

    closingRef.current = false;
    addingPathRef.current = null;
    setDeletedPaths([]);
    setPendingAdds([]);
    setIsSwipingRow(false);

    backdropOpacity.setValue(0);
    contentTranslateY.setValue(SCREEN_HEIGHT * 0.9);
    openAnimRef.current?.stop();

    openAnimRef.current = Animated.parallel([
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: MODAL_ANIM_OPEN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentTranslateY, {
        toValue: 0,
        duration: MODAL_ANIM_OPEN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    openAnimRef.current.start();
    return () => openAnimRef.current?.stop();
  }, [visible, backdropOpacity, contentTranslateY]);

  const closeModal = useCallback(
    (onClosedCallback?: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;

      openAnimRef.current?.stop();
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: MODAL_ANIM_CLOSE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(contentTranslateY, {
          toValue: SCREEN_HEIGHT * 0.9,
          duration: MODAL_ANIM_CLOSE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        setVisible(false);
        onClosedCallback?.();
      });
    },
    [setVisible, backdropOpacity, contentTranslateY],
  );

  // Наявні закладки без оптимістично видалених. Додатково дедуплікуємо за
  // path (pageId): старі дані могли містити кілька закладок на одну сторінку,
  // що давало дублі-ключі в React.
  const visibleBookmarks = useMemo(() => {
    const seen = new Set<string>();
    return savedBookmarks.filter((b) => {
      if (seen.has(b.path)) return false;
      seen.add(b.path);
      return !deletedPaths.includes(b.path);
    });
  }, [savedBookmarks, deletedPaths]);

  // Підсумковий список: збережені + оптимістично додані, яких ще немає в збережених.
  const rows = useMemo(() => {
    const extra = pendingAdds.filter(
      (p) => !deletedPaths.includes(p.path) && !visibleBookmarks.some((b) => b.path === p.path),
    );
    return extra.length ? [...visibleBookmarks, ...extra] : visibleBookmarks;
  }, [visibleBookmarks, pendingAdds, deletedPaths]);

  // Колір для нової закладки: найменш уживаний у списку. Перші 7 закладок
  // отримують різні кольори, далі кольори рівномірно повторюються.
  const nextColor = useMemo(() => {
    const counts = new Map<string, number>();
    BOOKMARK_COLORS.forEach((c) => counts.set(c, 0));
    rows.forEach((b) => {
      const n = counts.get(b.color);
      if (n !== undefined) counts.set(b.color, n + 1);
    });
    let best = BOOKMARK_COLORS[0];
    BOOKMARK_COLORS.forEach((c) => {
      if ((counts.get(c) ?? 0) < (counts.get(best) ?? 0)) best = c;
    });
    return best;
  }, [rows]);

  const isCurrentPageBookmarked = useMemo(
    () => !!currentPagePath && rows.some((b) => b.path === currentPagePath),
    [rows, currentPagePath],
  );

  const otherBooksCount =
    typeof totalBookmarksCount === 'number' ? Math.max(0, totalBookmarksCount - savedBookmarks.length) : 0;
  const canAddMore = rows.length + otherBooksCount < MAX_BOOKMARKS;
  const canEdit = mode === 'edit' && !!onSaveBookmark;
  const addDisabled = isCurrentPageBookmarked || !canAddMore || !currentPagePath;

  const handleAddBookmark = useCallback(() => {
    if (!canEdit || !onSaveBookmark || addDisabled) return;
    if (addingPathRef.current === currentPagePath) return;
    addingPathRef.current = currentPagePath;

    // Якщо цю сторінку щойно видаляли в цій же сесії — знімаємо позначку видалення.
    setDeletedPaths((prev) => prev.filter((p) => p !== currentPagePath));
    setPendingAdds((prev) => [
      ...prev.filter((p) => p.path !== currentPagePath),
      {
        color: nextColor,
        title: currentPageTitle,
        bookTitle: currentPageBookTitle,
        chapterTitle: currentPageTitle,
        path: currentPagePath,
      },
    ]);
    onSaveBookmark(nextColor, currentPageTitle, currentPagePath);

    // Нова закладка з'являється в кінці списку — прокручуємо до неї.
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [
    canEdit,
    onSaveBookmark,
    addDisabled,
    currentPagePath,
    nextColor,
    currentPageTitle,
    currentPageBookTitle,
  ]);

  // Тап по закладці — завжди ПЕРЕХІД до неї (і в списку книг, і в читалці).
  // Раніше в режимі 'edit' (читалка) тап нічого не робив: перейти до
  // збереженої закладки під час читання було неможливо. Тап нічого не
  // зберігає і не перезаписує — додавання лише кнопкою «Додати», видалення
  // лише свайпом.
  const handleRowPress = useCallback(
    (bookmark: SavedBookmark) => {
      // Закладка поточної сторінки: ми вже тут — просто закриваємо вікно.
      if (mode === 'edit' && !!currentPagePath && bookmark.path === currentPagePath) {
        closeModal();
        return;
      }
      closeModal(() => onNavigateToBookmark(bookmark));
    },
    [mode, currentPagePath, closeModal, onNavigateToBookmark],
  );

  const handleRowDelete = useCallback(
    (bookmark: SavedBookmark) => {
      // Дозволяємо знову додати цю сторінку після видалення
      // (раніше гвард лишався ввімкненим до повторного відкриття вікна).
      if (addingPathRef.current === bookmark.path) addingPathRef.current = null;

      setPendingAdds((prev) => prev.filter((p) => p.path !== bookmark.path));
      setDeletedPaths((prev) => (prev.includes(bookmark.path) ? prev : [...prev, bookmark.path]));
      onDeleteBookmark?.(bookmark);
    },
    [onDeleteBookmark],
  );

  let addRowLabel = 'Додати поточну сторінку';
  if (isCurrentPageBookmarked) addRowLabel = 'Поточна сторінка вже в закладках';
  else if (!canAddMore) addRowLabel = `Досягнуто ліміту — ${MAX_BOOKMARKS} закладок`;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={() => closeModal()}
      statusBarTranslucent={true}
    >
      <Animated.View style={[styles.overlay, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => closeModal()} />

        <Animated.View
          style={[
            styles.container,
            { maxHeight: windowHeight * MODAL_MAX_HEIGHT_RATIO },
            { transform: [{ translateY: contentTranslateY }] },
          ]}
        >
          <View style={styles.header}>
            <View style={styles.headerSpacer} />
            <Text style={styles.title}>Закладки</Text>
            <Pressable
              onPress={() => closeModal()}
              hitSlop={8}
              style={({ pressed }) => [styles.closeButtonCircle, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.closeButtonIcon}>✕</Text>
            </Pressable>
          </View>

          {mode === 'edit' && (
            <View style={styles.pageInfoBlock}>
              <Text style={styles.pageInfoHint}>Поточна сторінка</Text>
              <Text style={styles.pageInfoTitle} numberOfLines={2}>
                {currentPageBookTitle
                  ? `${currentPageBookTitle} — ${currentPageTitle}`
                  : currentPageTitle}
              </Text>
            </View>
          )}

          {/* Список скролиться всередині вікна; шапка та кнопка «Додати» — завжди на місці. */}
          <ScrollView
            ref={scrollRef}
            scrollEnabled={!isSwipingRow}
            showsVerticalScrollIndicator={false}
            style={styles.scrollArea}
            contentContainerStyle={styles.listContainer}
          >
            {rows.map((bookmark, index) => {
              const mainTitle = bookmark.bookTitle || bookmark.title;
              const subtitle =
                bookmark.chapterTitle && bookmark.chapterTitle !== mainTitle
                  ? bookmark.chapterTitle
                  : undefined;
              const isLast = index === rows.length - 1;

              return (
                <View
                  key={bookmark.path}
                  style={[styles.rowWrapper, isLast && styles.rowWrapperLast]}
                >
                  <SwipeableBookmarkRow
                    onPress={() => handleRowPress(bookmark)}
                    // Видаляти свайпом можна будь-де: у читалці, у списку книг,
                    // на сторінці книги — якщо екран передав onDeleteBookmark.
                    onDelete={onDeleteBookmark ? () => handleRowDelete(bookmark) : undefined}
                    onSwipeStart={handleSwipeStart}
                    onSwipeEnd={handleSwipeEnd}
                  >
                    <View style={styles.iconWrapper}>
                      <Image
                        source={require('../../../../assets/images/icons/bookmark-2.png')}
                        style={[styles.bookmarkIcon, { tintColor: bookmark.color }]}
                        resizeMode="contain"
                      />
                    </View>
                    <View style={styles.textsColumn}>
                      <Text style={styles.bookmarkTitle} numberOfLines={1}>
                        {mainTitle}
                      </Text>
                      {!!subtitle && (
                        <Text style={styles.bookmarkSubtitle} numberOfLines={1}>
                          {subtitle}
                        </Text>
                      )}
                    </View>
                  </SwipeableBookmarkRow>
                </View>
              );
            })}

            {rows.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>Закладок поки немає</Text>
              </View>
            )}
          </ScrollView>

          {canEdit && (
            <View style={styles.footer}>
              <Pressable
                onPress={handleAddBookmark}
                disabled={addDisabled}
                style={({ pressed }) => [
                  styles.addRow,
                  pressed && !addDisabled && localStyles.rowContentPressedBg,
                  addDisabled && styles.addRowDisabled,
                ]}
              >
                <View style={styles.addIconWrapper}>
                  <Text style={styles.addIconText}>{isCurrentPageBookmarked ? '✓' : '+'}</Text>
                </View>
                <View style={styles.textsColumn}>
                  <Text style={styles.addRowTitle}>{addRowLabel}</Text>
                </View>
                {!addDisabled && (
                  <View style={[styles.addColorDot, { backgroundColor: nextColor }]} />
                )}
              </Pressable>
            </View>
          )}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
};
