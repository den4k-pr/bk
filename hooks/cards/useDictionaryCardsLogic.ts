import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../../store';
import {
  fetchRandomDictionaryWords,
  prefetchMoreDictionaryWords,
  syncDictionarySrsProgress,
  shiftDictionaryWord,
  applyDictionaryAnswerLocally,
  resetStepDisabled,
  WordState,
} from '../../features/learnSlice';
import { getDailyLimitStatus, DailyLimitStatus } from '../../services/Dailylimitservice';
import { DictionarySourceFilters } from '../../features/dictionaryFiltersSlice';
import {
  CardDirection,
  DEFAULT_CARD_DIRECTION,
  LastAnswer,
  pickCardDirection,
} from '../../utils/cardDirection';

const QUEUE_BATCH_SIZE = 3;
// Підвантажуємо наперед більшою порцією — менше запитів /dictionary/random.
const PREFETCH_COUNT = 6;
const PREFETCH_THRESHOLD = 1;
const INITIAL_SEED_COUNT = QUEUE_BATCH_SIZE;
// Звірка ліміту з сервером не частіше (екран і так рахує його оптимістично).
const LIMIT_RECONCILE_MIN_INTERVAL_MS = 10_000;

const filtersAreEqual = (a: DictionarySourceFilters, b: DictionarySourceFilters): boolean => {
  if (a.manual !== b.manual) return false;
  if (a.packages !== b.packages) return false;
  if (a.favoritesOnly !== b.favoritesOnly) return false;
  if (a.bookIds.length !== b.bookIds.length) return false;
  if ((a.levels ?? []).join(',') !== (b.levels ?? []).join(',')) return false;

  const aBookIds = [...a.bookIds].sort();
  const bBookIds = [...b.bookIds].sort();
  for (let i = 0; i < aBookIds.length; i++) {
    if (aBookIds[i] !== bBookIds[i]) return false;
  }

  return true;
};

export const useDictionaryCardsLogic = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { dictionaryWords: words, dictionaryStatus: status } = useSelector(
    (state: RootState) => state.learn,
  );
  const dictionaryFilters = useSelector((state: RootState) => state.dictionaryFilters);

  const [limitStatus, setLimitStatus] = useState<DailyLimitStatus | null>(null);
  // Статус ліміту не вдалося отримати (немає мережі / помилка сервера).
  // Без цього прапорця екран назавжди лишався на прелоадері.
  const [limitStatusFailed, setLimitStatusFailed] = useState(false);
  const [answeredCount, setAnsweredCount] = useState(0);

  const [isFetchingWords, setIsFetchingWords] = useState(false);
  const [lastFetchWasEmpty, setLastFetchWasEmpty] = useState(false);

  const pendingSyncRef = useRef<
    { id: number; userWordId?: number; success: boolean; direction: CardDirection }[]
  >([]);
  const wordsRef = useRef<WordState[]>(words);
  const hasSeededRef = useRef(false);
  // 🔧 Скільки синхронізацій відповідей зараз "в польоті". Раніше тут був
  // один спільний прапорець: перша завершена синхронізація скидала його,
  // поки інша ще йшла, — і статус ліміту з сервера (ще без її відповіді)
  // перезаписував оптимістичний лічильник, тож "+1" на очах відкочувався.
  const inFlightSyncsRef = useRef(0);
  // Лічильник відповідей користувача: статус ліміту, запитаний ДО
  // останньої відповіді, вже застарілий і не повинен перезаписувати екран.
  const answerSeqRef = useRef(0);
  const filtersRef = useRef<DictionarySourceFilters>(dictionaryFilters);
  const dictionaryFiltersRef = useRef<DictionarySourceFilters>(dictionaryFilters);

  // Що і як відповіли по кожному слову в ЦІЙ сесії. Сервер оновиться з запізненням
  // (синк іде паралельно з підвантаженням нових слів), тому для слова, яке
  // повернулось вдруге за сесію, довіряємо цій пам'яті, а не відповіді сервера.
  const lastAnswersRef = useRef<Map<number, LastAnswer>>(new Map());
  // Різна для кожного відкриття екрана — щоб «рандом» напрямку не повторювався сесія в сесію
  const sessionSaltRef = useRef<number>(Math.floor(Math.random() * 1_000_000_000));

  useEffect(() => {
    wordsRef.current = words;
  }, [words]);

  useEffect(() => {
    dictionaryFiltersRef.current = dictionaryFilters;
  }, [dictionaryFilters]);

  const lastLimitLoadAtRef = useRef(0);
  const limitReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnlimitedRef = useRef(false);
  // Один запит слів за раз: стан isFetchingWords оновлюється з запізненням
  // і пропускав паралельні дублікати.
  const fetchInFlightRef = useRef(false);

  const loadLimitStatus = useCallback(async () => {
    lastLimitLoadAtRef.current = Date.now();
    const seqAtRequest = answerSeqRef.current;
    try {
      const status = await getDailyLimitStatus();
      setLimitStatusFailed(false);

      if (
        pendingSyncRef.current.length > 0 ||
        inFlightSyncsRef.current > 0 ||
        answerSeqRef.current !== seqAtRequest
      ) {
        return;
      }

      isUnlimitedRef.current = !!status?.unlimited;
      setLimitStatus(status);
    } catch (error) {
      console.log('Не вдалося завантажити статус ліміту', error);
      setLimitStatusFailed(true);
    }
  }, []);

  const bumpLimitOptimistically = useCallback(() => {
    setLimitStatus(prev => {
      if (!prev || prev.unlimited) return prev;
      const nextRemaining = Math.max(0, prev.remaining - 1);
      return { ...prev, current: prev.current + 1, remaining: nextRemaining };
    });
  }, []);

  const flushPendingSync = useCallback(() => {
    if (pendingSyncRef.current.length === 0) return;

    const toSync = pendingSyncRef.current;
    pendingSyncRef.current = [];

    inFlightSyncsRef.current += 1;

    dispatch(syncDictionarySrsProgress(toSync))
      .unwrap()
      .catch((err) => {
        console.error('Помилка синхронізації:', err);
      })
      .finally(() => {
        inFlightSyncsRef.current = Math.max(0, inFlightSyncsRef.current - 1);
        // Звіряємось із сервером лише коли всі відповіді вже там, для преміуму
        // не звіряємось зовсім, і не частіше ніж раз на 10 с (решта — оптимістично).
        if (inFlightSyncsRef.current === 0 && !isUnlimitedRef.current) {
          const wait = LIMIT_RECONCILE_MIN_INTERVAL_MS - (Date.now() - lastLimitLoadAtRef.current);
          if (limitReconcileTimerRef.current) clearTimeout(limitReconcileTimerRef.current);
          limitReconcileTimerRef.current = setTimeout(() => {
            limitReconcileTimerRef.current = null;
            if (inFlightSyncsRef.current === 0) loadLimitStatus();
          }, Math.max(0, wait));
        }
      });
  }, [dispatch, loadLimitStatus]);

  const attemptFetchMore = useCallback((count: number, replaceQueue: boolean) => {
    // Підвантаження поки йде попереднє — пропускаємо (заміну черги — ні:
    // вона потрібна при зміні фільтрів і має пріоритет).
    if (fetchInFlightRef.current && !replaceQueue) return;
    fetchInFlightRef.current = true;
    setIsFetchingWords(true);
    const activeFilters = dictionaryFiltersRef.current;
    const action = replaceQueue
      ? fetchRandomDictionaryWords({ count, filters: activeFilters })
      : prefetchMoreDictionaryWords({ count, filters: activeFilters });

    dispatch(action)
      .unwrap()
      .then((result: WordState[] | undefined) => {
        const gotAny = !!result && result.length > 0;
        setLastFetchWasEmpty(!gotAny);
      })
      .catch(() => {})
      .finally(() => {
        fetchInFlightRef.current = false;
        setIsFetchingWords(false);
      });
  }, [dispatch]);

  useEffect(() => {
    if (hasSeededRef.current) return;
    hasSeededRef.current = true;
    filtersRef.current = dictionaryFilters;
    attemptFetchMore(INITIAL_SEED_COUNT, true);
    dispatch(resetStepDisabled());
    loadLimitStatus();
  }, [dispatch, loadLimitStatus, attemptFetchMore, dictionaryFilters]);

  useEffect(() => {
    if (!hasSeededRef.current) return;
    if (filtersAreEqual(filtersRef.current, dictionaryFilters)) return;

    filtersRef.current = dictionaryFilters;
    pendingSyncRef.current = [];
    setAnsweredCount(0);
    setLastFetchWasEmpty(false);
    attemptFetchMore(INITIAL_SEED_COUNT, true);
  }, [dictionaryFilters, attemptFetchMore]);

  useEffect(() => {
    return () => {
      flushPendingSync();
      if (limitReconcileTimerRef.current) clearTimeout(limitReconcileTimerRef.current);
    };
  }, [flushPendingSync]);

  useEffect(() => {
    if (!hasSeededRef.current) return;
    if (words.length > 0) return;
    if (isFetchingWords) return;
    if (lastFetchWasEmpty) return;
    attemptFetchMore(QUEUE_BATCH_SIZE, false);
  }, [words.length, isFetchingWords, lastFetchWasEmpty, attemptFetchMore]);

  const handleAnswerRecognized = useCallback((_success: boolean) => {
  }, []);

  /**
   * direction — у якому напрямку показували картку (для голосового режиму
   * завжди відтворення, тому за замовчуванням ua_to_en).
   */
  const handleWordAnswered = useCallback((
    answeredWord: WordState,
    direction: CardDirection = DEFAULT_CARD_DIRECTION,
  ) => {
    answerSeqRef.current += 1;
    bumpLimitOptimistically();

    const success = !!answeredWord.progress?.step1 && !!answeredWord.progress?.step3;
    const globalWordId = answeredWord.word?.id;

    if (typeof globalWordId === 'number') {
      dispatch(applyDictionaryAnswerLocally({ globalWordId, success }));
      lastAnswersRef.current.set(globalWordId, { direction, success });
    }

    dispatch(shiftDictionaryWord());
    setAnsweredCount(prev => prev + 1);
    setLastFetchWasEmpty(false);

    pendingSyncRef.current.push({
      id: answeredWord.word?.id,
      userWordId: answeredWord.id ?? undefined,
      success,
      direction,
    });
    flushPendingSync();

    const remainingAfterShift = wordsRef.current.length - 1;
    if (remainingAfterShift <= PREFETCH_THRESHOLD) {
      attemptFetchMore(PREFETCH_COUNT, false);
    }
  }, [dispatch, flushPendingSync, attemptFetchMore, bumpLimitOptimistically]);

  const refillIfEmpty = useCallback(() => {
    if (wordsRef.current.length === 0) {
      attemptFetchMore(INITIAL_SEED_COUNT, false);
    }
  }, [attemptFetchMore]);

  const isLimitExhausted = !!limitStatus && !limitStatus.unlimited && limitStatus.remaining <= 0;

  const isConfirmedEmptyDictionary =
    words.length === 0 && !isLimitExhausted && !isFetchingWords && lastFetchWasEmpty;

  const currentWord = words[0] ?? null;
  const currentWordGlobalId: number | undefined = currentWord?.word?.id;

  // Напрямок для поточної картки. Залежить лише від слова і кроку сесії
  // (детермінований «рандом»), тому не змінюється, поки картка на екрані.
  const currentDirection = useMemo<CardDirection>(() => {
    if (!currentWord) return DEFAULT_CARD_DIRECTION;

    return pickCardDirection({
      wordId: currentWordGlobalId ?? 0,
      studyStatus: currentWord.studyStatus,
      lastDirection: currentWord.lastDirection,
      lastAnswer:
        typeof currentWordGlobalId === 'number'
          ? lastAnswersRef.current.get(currentWordGlobalId) ?? null
          : null,
      salt: sessionSaltRef.current + answeredCount,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWordGlobalId, currentWord?.id, answeredCount]);

  return {
    words,
    currentWord,
    currentDirection,
    queueWords: words,
    answeredCount,
    status,
    isError: status === 'failed',
    limitStatus,
    isLimitExhausted,
    isFetchingWords,
    isConfirmedEmptyDictionary,
    limitStatusFailed,
    isContentLoaded: (!!limitStatus || limitStatusFailed) && (status === 'succeeded' || status === 'failed'),
    handleAnswerRecognized,
    handleWordAnswered,
    loadLimitStatus,
    refillIfEmpty,
  };
};