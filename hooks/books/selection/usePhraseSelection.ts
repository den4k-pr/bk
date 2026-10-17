import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert, Animated, DeviceEventEmitter } from 'react-native';
import { isDictionaryLimitError } from '../../../services/dictionaryLimitBus';
import { HighlightMenuCoords } from '../../../types/BookReader.types';
import { ExtendedSelectedPhrase } from '../../../types/BookReader.internal.types';
import {
  PhraseMatch,
  cleanToken,
  cleanWordForLookup,
  extractSentenceContext,
} from '../../../components/Books/BookReader/Phrases/phraseDetection';
import { SearchOrCreateResponse, WordType } from '../../../types/words';
import { AppDispatch } from '../../../../store';
import { searchOrCreateGlobalWord, deleteUserWord, reportWordLookup } from '../../../services/wordService';
import { addWordOptimistic, deleteWordOptimistic } from '../../../features/wordSlice';
import { ReaderSelectionSnapshot, readerSelectionStore } from './readerSelectionStore';
import {
  LookupRequest,
  initialTranslationState,
  translationReducer,
} from './translationReducer';
import {
  LOOKUP_RETRY_DELAY_MS,
  buildCacheKey,
  describeLookupError,
  invalidateCachedWord,
  isSameLookupResult,
  isTransientLookupError,
  readCache,
  writeCache,
} from './translationCache';

interface UsePhraseSelectionParams {
  setIsFontMenuVisible: (visible: boolean) => void;
  dispatch: AppDispatch;
  bookId?: number;
  bookTitle?: string;
}

interface UsePhraseSelectionResult {
  selectedPhrase: ExtendedSelectedPhrase | null;
  wordDetails: WordType | null;
  isLoadingTranslation: boolean;
  isAdded: boolean;
  isRemoving: boolean;
  highlightMenuCoords: HighlightMenuCoords | null;
  setHighlightMenuCoords: React.Dispatch<React.SetStateAction<HighlightMenuCoords | null>>;
  isSelectionMode: boolean;
  setIsSelectionMode: (mode: boolean) => void;
  slideAnim: Animated.Value;
  fadeAnim: Animated.Value;
  handleClearSelection: () => void;
  clearPhraseState: () => void;
  handleWordPress: (chunks: string[], clickedIndex: number, eventX: number, eventY: number, precomputedMatch: PhraseMatch | null) => void;
  handleWordLongPress: (chunks: string[], clickedIndex: number, eventX: number, eventY: number) => void;
  handleSentenceSelect: (phrase: { startIdx: number; endIdx: number; text: string; pageX: number; pageY: number }) => void;
  handleAddWord: () => void;
  handleRemoveWord: () => void;
  /** Слово в тексті, якщо воно відрізняється від показаної леми ("trained" → "train"). */
  surfaceText: string | null;
  /** Дослівний переклад форми слова в тексті ("sharing" → "поділ / ділячись"). */
  surfaceTranslation: string | null;
  /** Форми дієслова для картки ("went", "gone", "going"). */
  verbForms: string[] | null;
  isReported: boolean;
  handleReportWord: () => void;
  /** Повторити запит перекладу після помилки. */
  handleRetryTranslation: () => void;
  /** Поточний стан виділення — для збереження між відкриттями книги. */
  selectionSnapshot: ReaderSelectionSnapshot;
  /** Повернути збережене виділення і картку перекладу (повернення в книгу). */
  restoreSelection: (snapshot: ReaderSelectionSnapshot) => void;
}

/** Що саме і з яким контекстом запитувати в сервера для поточного тапу. */
export function usePhraseSelection({
  setIsFontMenuVisible,
  dispatch,
  bookId,
  bookTitle,
}: UsePhraseSelectionParams): UsePhraseSelectionResult {
  const [state, localDispatch] = useReducer(translationReducer, initialTranslationState);

  const [highlightMenuCoords, setHighlightMenuCoords] = useState<HighlightMenuCoords | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState<boolean>(false);

  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const requestIdRef = useRef(0);
  // Лічильник дій користувача з карткою (додав / видалив слово): відповідь
  // сервера, запитана ДО дії, не має перезаписувати її результат.
  const userActionSeqRef = useRef(0);

  const hideSheetInstantly = useCallback((): void => {
    slideAnim.stopAnimation();
    fadeAnim.stopAnimation();
    slideAnim.setValue(300);
    fadeAnim.setValue(0);
  }, [slideAnim, fadeAnim]);

  const handleClearSelection = useCallback((): void => {
    DeviceEventEmitter.emit('CLEAR_HIGHLIGHT_INSTANTLY');

    // Користувач сам закрив переклад / зняв виділення / перегорнув сторінку —
    // при поверненні в книгу відновлювати нічого.
    readerSelectionStore.clear(bookId);
    localDispatch({ type: 'CLEAR' });
    setHighlightMenuCoords(null);
    setIsFontMenuVisible(false);

    hideSheetInstantly();
  }, [setIsFontMenuVisible, hideSheetInstantly, bookId]);

  const clearPhraseState = useCallback((): void => {
    DeviceEventEmitter.emit('CLEAR_HIGHLIGHT_INSTANTLY');
    readerSelectionStore.clear(bookId);
    localDispatch({ type: 'CLEAR' });
  }, [bookId]);

  const handleWordPress = useCallback(
    (chunks: string[], clickedIndex: number, eventX: number, eventY: number, precomputedMatch: PhraseMatch | null): void => {
      const isTapOnAlreadySelectedWord =
        !!state.selectedPhrase &&
        state.selectedPhrase.type === 'word' &&
        clickedIndex >= state.selectedPhrase.startIdx &&
        clickedIndex <= state.selectedPhrase.endIdx;

      if (isTapOnAlreadySelectedWord) {
        handleClearSelection();
        return;
      }

      const singleText = cleanWordForLookup(chunks[clickedIndex] ?? '');
      const newRequestId = ++requestIdRef.current;

      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          stiffness: 350,
          damping: 25,
          mass: 0.8,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0.4,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();

      setHighlightMenuCoords({ x: eventX, y: eventY });
      setIsFontMenuVisible(false);

      const bestMatch = precomputedMatch;

      const lookup: LookupRequest = {
        context: extractSentenceContext(chunks, clickedIndex),
        ...(bestMatch
          ? {
              fallbackQuery: singleText || undefined,
              fallbackIndex: clickedIndex,
              phraseSurface: bestMatch.exactIndicesToHighlight
                .map(i => cleanToken(chunks, i))
                .filter(Boolean)
                .join(' '),
            }
          : {}),
      };

      localDispatch({
        type: 'SELECT_WORD',
        requestId: newRequestId,
        lookup,
        phrase: bestMatch ? {
          startIdx: bestMatch.exactIndicesToHighlight[0],
          endIdx: bestMatch.exactIndicesToHighlight[bestMatch.exactIndicesToHighlight.length - 1],
          text: bestMatch.baseForm,
          type: 'word',
          exactIndicesToHighlight: bestMatch.exactIndicesToHighlight,
          baseForm: bestMatch.baseForm,
          partOfSpeech: bestMatch.partOfSpeech,
        } : {
          startIdx: clickedIndex,
          endIdx: clickedIndex,
          text: singleText,
          type: 'word',
          partOfSpeech: undefined,
        },
      });
    },
    [state.selectedPhrase, slideAnim, fadeAnim, setIsFontMenuVisible, handleClearSelection]
  );

  const handleWordLongPress = useCallback(
    (chunks: string[], clickedIndex: number, eventX: number, eventY: number): void => {
      if (state.selectedPhrase) {
        handleClearSelection();
        return;
      }

      hideSheetInstantly();

      const singleText = cleanWordForLookup(chunks[clickedIndex] ?? '');

      localDispatch({
        type: 'SELECT_SENTENCE',
        phrase: {
          startIdx: clickedIndex,
          endIdx: clickedIndex,
          text: singleText,
          type: 'sentence',
        },
      });
      setHighlightMenuCoords({ x: eventX, y: eventY });
      setIsFontMenuVisible(false);
    },
    [state.selectedPhrase, hideSheetInstantly, setIsFontMenuVisible, handleClearSelection]
  );

  const handleSentenceSelect = useCallback(
    (phrase: { startIdx: number; endIdx: number; text: string; pageX: number; pageY: number }) => {
      hideSheetInstantly();

      localDispatch({
        type: 'SELECT_SENTENCE',
        phrase: {
          startIdx: phrase.startIdx,
          endIdx: phrase.endIdx,
          text: phrase.text,
          type: 'sentence',
        },
      });
      setHighlightMenuCoords({ x: phrase.pageX, y: phrase.pageY });
      setIsFontMenuVisible(false);
    },
    [hideSheetInstantly, setIsFontMenuVisible]
  );

  // Запит перекладу запускається лише при новому виборі слова (новий
  // requestId). Коли сервер відхиляє фразу, selectedPhrase змінюється на
  // одне слово — це НЕ має запускати повторний запит.
  const selectedPhraseRef = useRef(state.selectedPhrase);
  selectedPhraseRef.current = state.selectedPhrase;
  const lookupRef = useRef(state.lookup);
  lookupRef.current = state.lookup;

  useEffect(() => {
    const phrase = selectedPhraseRef.current;
    if (!phrase || phrase.type !== 'word') {
      return;
    }

    let isCancelled = false;
    const currentRequestId = state.requestId;
    const wordToSearch = phrase.text.trim().toLowerCase();
    const lookup = lookupRef.current;
    const cacheKey = buildCacheKey(wordToSearch, lookup);
    const actionSeqAtStart = userActionSeqRef.current;

    const applyResponse = (data: SearchOrCreateResponse): void => {
      if (data && 'word' in data && data.word) {
        localDispatch({
          type: 'TRANSLATION_LOADED',
          requestId: currentRequestId,
          word: data.word,
          isAdded: !!data.isAdded,
          userWordId: data.userWordId ?? null,
          surfaceTranslation: data.surfaceTranslation ?? null,
          surfaceAnalysis: data.surfaceAnalysis ?? null,
          verbForms: data.verbForms ?? null,
          phraseRejected: !!data.phraseRejected,
        });
      } else if (data && !('word' in data) && (data as unknown as WordType).text) {
        localDispatch({
          type: 'TRANSLATION_LOADED',
          requestId: currentRequestId,
          word: data as unknown as WordType,
          isAdded: false,
          userWordId: null,
        });
      } else {
        localDispatch({ type: 'TRANSLATION_FAILED', requestId: currentRequestId });
      }
    };

    const fetchTranslation = async (): Promise<void> => {
      if (!wordToSearch) {
        localDispatch({ type: 'TRANSLATION_FAILED', requestId: currentRequestId });
        return;
      }

      // Кешована картка — одразу на екран; далі все одно питаємо сервер:
      // слово могли видалити з бази й згенерувати заново (новий id, нові дані).
      const cached = readCache(cacheKey);
      if (cached) applyResponse(cached);

      const request = () => searchOrCreateGlobalWord(wordToSearch, undefined, lookup ?? undefined);
      try {
        let data: SearchOrCreateResponse;
        try {
          data = await request();
        } catch (first) {
          if (isCancelled || !isTransientLookupError(first)) throw first;
          await new Promise<void>(resolve => setTimeout(resolve, LOOKUP_RETRY_DELAY_MS));
          if (isCancelled) return;
          data = await request();
        }
        if (isCancelled) return;
        if (data && 'word' in data && data.word) writeCache(cacheKey, data);
        // Сервер підтвердив те саме, що вже показано з кешу, — екран не чіпаємо.
        // Виняток: «додано / не додано» змінилось десь поза карткою (слово
        // видалили у Словнику) — оновлюємо, якщо користувач тим часом сам
        // не натискав «додати» / «видалити» на цій картці.
        if (cached && isSameLookupResult(cached, data)) {
          const addedChanged =
            !!(cached as any).isAdded !== !!(data as any).isAdded ||
            ((cached as any).userWordId ?? null) !== ((data as any).userWordId ?? null);
          if (!addedChanged || userActionSeqRef.current !== actionSeqAtStart) return;
        }
        applyResponse(data);
      } catch (e) {
        // Картка з кешу вже на екрані — збій фонового перепитування її не ховає.
        if (cached) return;
        if (!isCancelled) {
          console.error('Помилка пошуку фрази:', e);
          localDispatch({ type: 'TRANSLATION_FAILED', requestId: currentRequestId, message: describeLookupError(e) });
        }
      }
    };

    fetchTranslation();

    return () => {
      isCancelled = true;
    };
  }, [state.requestId]);

  const handleAddWord = useCallback((): void => {
    // id = 0: переклад без збереженого запису (transient) — додавати нічого.
    if (!state.wordDetails || !state.wordDetails.id) return;

    userActionSeqRef.current += 1;
    localDispatch({ type: 'WORD_ADDED' });
    invalidateCachedWord(state.wordDetails.id);

    // Речення і форма в тексті зберігаються разом зі словом у словнику.
    const sentence = state.lookup?.context || undefined;
    const surface =
      state.lookup?.phraseSurface ||
      (state.selectedPhrase?.type === 'word' ? state.selectedPhrase.text : undefined);

    // Раніше кнопка показувала "додано" незалежно від відповіді сервера:
    // при відмові слово "додавалось" з анімацією, але в Словнику його не було.
    const wordId = state.wordDetails.id;
    dispatch(
      addWordOptimistic({
        word: state.wordDetails,
        source: bookId ? { type: 'book', bookId, bookTitle, sentence, surface } : undefined,
      }),
    )
      .unwrap()
      .then((added: any) => {
        localDispatch({ type: 'ADD_CONFIRMED', wordId, userWordId: added?.id ?? null });
      })
      .catch((e: unknown) => {
        localDispatch({ type: 'ADD_FAILED', wordId });
        // Словник заповнено — замість помилки відкривається вікно "Додати місце".
        if (isDictionaryLimitError(e)) return;
        console.warn('[BookReader] слово не додано:', e);
        Alert.alert('Не вдалося додати', 'Перевірте інтернет і спробуйте ще раз.');
      });
  }, [dispatch, state.wordDetails, state.lookup, state.selectedPhrase, bookId, bookTitle]);

  const handleRemoveWord = useCallback((): void => {
    if (!state.userWordId || state.isRemoving) return;

    const userWordIdToRemove = state.userWordId;
    const wordDetailsSnapshot = state.wordDetails;

    userActionSeqRef.current += 1;
    localDispatch({ type: 'REMOVE_STARTED' });

    deleteUserWord(userWordIdToRemove)
      .then(() => {
        localDispatch({ type: 'WORD_REMOVED' });
        invalidateCachedWord(wordDetailsSnapshot?.id);
        if (wordDetailsSnapshot) {
          try {
            dispatch(deleteWordOptimistic(wordDetailsSnapshot.id));
          } catch (e) {
            console.error('[BookReader] removeWordOptimistic dispatch error:', e);
          }
        }
      })
      .catch((e: any) => {
        console.error('[BookReader] handleRemoveWord error:', e);
        localDispatch({ type: 'REMOVE_FAILED' });
      });
  }, [state.userWordId, state.isRemoving, state.wordDetails, dispatch]);

  // "had" у "had imagined": сервер не видає переклад групи ("уявив") за
  // переклад допоміжного слова — показуємо його з усією групою.
  const auxiliaryGroup = (() => {
    const analysis = state.surfaceAnalysis;
    if (!analysis?.isAuxiliary || state.lookup?.phraseSurface) return null;
    const group = analysis.verbGroup?.trim();
    const translation = analysis.contextualTranslation?.trim();
    return group && translation ? { group, translation } : null;
  })();

  // Форма слова в тексті, якщо сервер звів його до іншої леми
  // ("trained" → "train", "children" → "child"). Для фраз не показуємо.
  const surfaceText = (() => {
    const phrase = state.selectedPhrase;
    const word = state.wordDetails;
    if (!phrase || phrase.type !== 'word' || !word || word.id === 0 || state.lookup?.phraseSurface) return null;
    if (auxiliaryGroup) return auxiliaryGroup.group;
    // Переклад зроблено для групи з кількох слів ("be liked") — підписуємо
    // саме її, щоб "у тексті: …" і переклад говорили про те саме.
    const group = state.surfaceAnalysis?.verbGroup?.trim();
    const tapped = phrase.text?.trim().toLowerCase();
    if (group && tapped && group.includes(' ') && group.toLowerCase().split(/\s+/).includes(tapped)) {
      return group;
    }
    const surface = phrase.text?.trim();
    if (!surface || surface.toLowerCase() === String(word.text ?? '').trim().toLowerCase()) return null;
    return surface;
  })();

  const handleRetryTranslation = useCallback((): void => {
    if (!state.selectedPhrase || state.selectedPhrase.type !== 'word' || state.isLoadingTranslation) return;
    localDispatch({ type: 'RETRY', requestId: ++requestIdRef.current });
  }, [state.selectedPhrase, state.isLoadingTranslation]);

  const handleReportWord = useCallback((): void => {
    if (state.isReported || !state.selectedPhrase) return;
    const surface = state.lookup?.phraseSurface || state.selectedPhrase.text;
    if (!surface) return;
    localDispatch({ type: 'REPORTED' });
    reportWordLookup({
      surface,
      context: state.lookup?.context || undefined,
      wordId: state.wordDetails?.id || undefined,
      bookId,
    }).catch((e: any) => console.error('[BookReader] reportWordLookup error:', e));
  }, [state.isReported, state.selectedPhrase, state.lookup, state.wordDetails, bookId]);

  // Усе, що потрібно, щоб після повернення в книгу показати те саме:
  // виділення, картку перекладу, «додано», переклад форми.
  const selectionSnapshot = useMemo(
    (): ReaderSelectionSnapshot => ({
      selectedPhrase: state.selectedPhrase,
      lookup: state.lookup,
      wordDetails: state.wordDetails,
      isAdded: state.isAdded,
      userWordId: state.userWordId,
      surfaceTranslation: state.surfaceTranslation,
      surfaceAnalysis: state.surfaceAnalysis,
      verbForms: state.verbForms,
      isReported: state.isReported,
      highlightMenuCoords,
    }),
    [
      state.selectedPhrase,
      state.lookup,
      state.wordDetails,
      state.isAdded,
      state.userWordId,
      state.surfaceTranslation,
      state.surfaceAnalysis,
      state.verbForms,
      state.isReported,
      highlightMenuCoords,
    ],
  );

  const restoreSelection = useCallback(
    (saved: ReaderSelectionSnapshot): void => {
      const phrase = saved?.selectedPhrase;
      if (!phrase) return;
      const requestId = ++requestIdRef.current;

      if (phrase.type === 'word') {
        // Збережена картка одразу на екрані (через кеш), а сервер
        // перепитується у фоні: «додано» могло змінитись у Словнику.
        if (saved.wordDetails && saved.wordDetails.id) {
          writeCache(buildCacheKey(phrase.text.trim().toLowerCase(), saved.lookup), {
            word: saved.wordDetails,
            isAdded: saved.isAdded,
            userWordId: saved.userWordId,
            surfaceTranslation: saved.surfaceTranslation,
            surfaceAnalysis: saved.surfaceAnalysis,
            verbForms: saved.verbForms,
          } as SearchOrCreateResponse);
        }
        // Картка перекладу — одразу у відкритому положенні, без анімації.
        slideAnim.stopAnimation();
        fadeAnim.stopAnimation();
        slideAnim.setValue(0);
        fadeAnim.setValue(0.4);
      }
      setHighlightMenuCoords(saved.highlightMenuCoords ?? null);
      localDispatch({ type: 'RESTORE', requestId, snapshot: saved });
    },
    [slideAnim, fadeAnim],
  );

  return {
    selectionSnapshot,
    restoreSelection,
    selectedPhrase: state.selectedPhrase,
    wordDetails: state.wordDetails,
    isLoadingTranslation: state.isLoadingTranslation,
    isAdded: state.isAdded,
    isRemoving: state.isRemoving,
    highlightMenuCoords,
    setHighlightMenuCoords,
    isSelectionMode,
    setIsSelectionMode,
    slideAnim,
    fadeAnim,
    handleClearSelection,
    clearPhraseState,
    handleWordPress,
    handleWordLongPress,
    handleSentenceSelect,
    handleAddWord,
    handleRemoveWord,
    surfaceText,
    surfaceTranslation: auxiliaryGroup ? auxiliaryGroup.translation : state.surfaceTranslation,
    verbForms: state.verbForms,
    isReported: state.isReported,
    handleReportWord,
    handleRetryTranslation,
  };
}
