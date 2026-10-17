import { useCallback, useEffect, useRef, useState } from 'react';
import { cardsResumeStore } from './cardsResumeStore';
import { Animated, Easing, GestureResponderEvent, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../../store';
import { useTts } from '../useTts';
import { useRandomImage } from './useRandomImage';
import { useCardAnimations } from './useCardAnimations';
import { setStepProgress, submitProgramWordAnswer } from '../../features/learnSlice';
import { addWordOptimistic } from '../../features/wordSlice';
import { isDictionaryLimitError } from '../../services/dictionaryLimitBus';
import { imagesOfCard } from '../../lists/cardsAssetsList';
import { flyFromView } from '../../services/dictionaryAddFx';

const SWIPE_HINT_VISIBLE_DURATION = 2400;
const SWIPE_HINT_FADE_IN_DURATION = 420;
const SWIPE_HINT_FADE_OUT_DURATION = 260;
const SWIPE_HINT_CHEVRON_LOOP_DURATION = 700;

type CardDeckWords = RootState['learn']['words'];


/**
 * Уся логіка колоди карток (Card.tsx): анімації входу картки, свайп-хінт,
 * стан "додано в словник", вимірювання меж блоку прикладів для свайп-жесту,
 * тап-по-слову-щоб-озвучити. JSX-компонент лишається тільки з рендером.
 *
 * ⚠️ Поведінка перенесена 1-в-1. Зокрема isPhraseOrPhrasalVerb навмисно
 * дорівнює лише isPhrase (без isPhrasalVerb) — так було і в оригіналі.
 */
export function useCardDeck(
  wordsList: CardDeckWords,
  handleDeckComplete: (step: string) => void,
) {
  const dispatch = useDispatch<AppDispatch>();
  const step3Disabled = useSelector((state: RootState) => state.learn.step3Disabled);
  const step3DisabledRef = useRef(step3Disabled);
  step3DisabledRef.current = step3Disabled;
  const { speak: triggerTextToSpeech } = useTts();

  const [currentWordIndex, setCurrentWordIndex] = useState<number>(() =>
    cardsResumeStore.wordIndex(wordsList),
  );
  useEffect(() => {
    cardsResumeStore.saveIndex(wordsList, currentWordIndex);
  }, [wordsList, currentWordIndex]);
  const [locallyAddedWords, setLocallyAddedWords] = useState<Record<number, boolean>>({});

  const cardScaleAnimation = useRef(new Animated.Value(1)).current;
  const cardOpacityAnimation = useRef(new Animated.Value(1)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;

  const isFirstWordAlreadyInDictionary = !!wordsList[0]?.isInDictionary;
  const checkmarkScale = useRef(new Animated.Value(isFirstWordAlreadyInDictionary ? 1 : 0)).current;

  // 0 — "Додати в словник", 1 — "Додано в словник". Один прогрес керує
  // перетіканням фону, зміною напису та появою галочки (усе на нативному
  // драйвері — плавно навіть на слабких телефонах).
  const addedProgress = useRef(new Animated.Value(isFirstWordAlreadyInDictionary ? 1 : 0)).current;
  const addButtonRef = useRef<View>(null);
  const contentFlashOpacity = useRef(new Animated.Value(0)).current;
  const userJustAddedRef = useRef(false);

  const touchStartRef = useRef({ x: 0, y: 0 });

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const { image: backgroundRandomImage, refreshImage: triggerImageRefresh } = useRandomImage(imagesOfCard);

  const executeCardEntranceAnimation = useCallback(() => {
    cardScaleAnimation.setValue(0.95); // Зменшено scale для більш м'якої появи на місці
    cardOpacityAnimation.setValue(0);

    Animated.parallel([
      Animated.timing(cardOpacityAnimation, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }),
      Animated.spring(cardScaleAnimation, {
        toValue: 1,
        friction: 7,
        tension: 40,
        useNativeDriver: true,
      }),
    ]).start();
  }, [cardScaleAnimation, cardOpacityAnimation]);

  useEffect(() => {
    executeCardEntranceAnimation();
  }, [currentWordIndex, executeCardEntranceAnimation]);

  const advanceToNextCard = useCallback(() => {
    const currentWordData = wordsList[currentWordIndex];
    if (!currentWordData) return;

    triggerImageRefresh();

    // 🔴 ФІКС: раніше тут стояв currentWordData.id — це id запису в
    // ОСОБИСТОМУ словнику (null для слів програми). setStepProgress шукає
    // слово за глобальним word.id, тож "переглянуто" (step1) не ставилось
    // НІКОЛИ, і з вимкненим «Можу говорити» слово ніколи не зараховувалось.
    const globalWordId = currentWordData.word?.id;
    if (typeof globalWordId === 'number') {
      dispatch(setStepProgress({ id: globalWordId, step: 'step1', value: true }));
      // Крок вимови вимкнено — перегляд картки і є відповіддю: одразу "+1"
      // у смужці і відправка на сервер.
      if (step3DisabledRef.current) {
        dispatch(submitProgramWordAnswer(globalWordId));
      }
    }

    if (currentWordIndex >= wordsList.length - 1) {
      handleDeckComplete('second');
    } else {
      setCurrentWordIndex((prev) => prev + 1);
    }
  }, [currentWordIndex, wordsList, dispatch, handleDeckComplete, triggerImageRefresh]);

  const programLearned = useSelector((state: RootState) => state.learn.programLearned);
  const programTotal = useSelector((state: RootState) => state.learn.programTotal);

  const [optimisticallyAdded, setOptimisticallyAdded] = useState(false);
  const userIdRef = useRef<string | null>(null);
  const { loadingStatus } = useSelector((state: RootState) => state.words);
  const isAdding = loadingStatus === 'loading';

  const examplesSectionRef = useRef<View>(null);
  const examplesBoundsRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 });
  const boundsSettleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExamplesBounds = useCallback(() => {
    examplesBoundsRef.current = { left: 0, top: 0, right: 0, bottom: 0 };
  }, []);

  const measureExamplesBoundsNow = useCallback(() => {
    const node = examplesSectionRef.current;
    if (!node) {
      clearExamplesBounds();
      return;
    }
    node.measureInWindow((x: number, y: number, width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      examplesBoundsRef.current = { left: x, top: y, right: x + width, bottom: y + height };
    });
  }, [clearExamplesBounds]);

  const updateExamplesBounds = useCallback(() => {
    requestAnimationFrame(measureExamplesBoundsNow);

    if (boundsSettleTimeoutRef.current) {
      clearTimeout(boundsSettleTimeoutRef.current);
    }
    boundsSettleTimeoutRef.current = setTimeout(() => {
      measureExamplesBoundsNow();
      boundsSettleTimeoutRef.current = null;
    }, 380);
  }, [measureExamplesBoundsNow]);

  useEffect(() => {
    return () => {
      if (boundsSettleTimeoutRef.current) {
        clearTimeout(boundsSettleTimeoutRef.current);
      }
    };
  }, []);

  const isPointInsideExamplesBlock = useCallback((pageX: number, pageY: number) => {
    const bounds = examplesBoundsRef.current;
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return false;
    return pageX >= bounds.left && pageX <= bounds.right && pageY >= bounds.top && pageY <= bounds.bottom;
  }, []);

  const {
    panResponder: cardPanResponder,
    animatedStyle: cardAnimatedStyles,
    setIsFrontUkr,
    swipe: executeSwipeAnimation,
    isAnimating: isCardSwipeAnimating,
  } = useCardAnimations(() => advanceToNextCard(), isPointInsideExamplesBlock);

  const [isSwipeHintVisible, setIsSwipeHintVisible] = useState(false);
  const swipeHintShownRef = useRef(false);
  const swipeHintOpacity = useRef(new Animated.Value(0)).current;
  const swipeHintChevronShift = useRef(new Animated.Value(0)).current;
  const swipeHintLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (currentWordIndex === 0 && !swipeHintShownRef.current) {
      swipeHintShownRef.current = true;
      setIsSwipeHintVisible(true);
    }
  }, [currentWordIndex]);

  useEffect(() => {
    if (!isSwipeHintVisible) return;

    Animated.timing(swipeHintOpacity, {
      toValue: 1,
      duration: SWIPE_HINT_FADE_IN_DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    swipeHintLoopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(swipeHintChevronShift, {
          toValue: 1,
          duration: SWIPE_HINT_CHEVRON_LOOP_DURATION,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(swipeHintChevronShift, {
          toValue: 0,
          duration: SWIPE_HINT_CHEVRON_LOOP_DURATION,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    swipeHintLoopRef.current.start();

    const hideTimer = setTimeout(() => {
      Animated.timing(swipeHintOpacity, {
        toValue: 0,
        duration: SWIPE_HINT_FADE_OUT_DURATION,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setIsSwipeHintVisible(false);
      });
    }, SWIPE_HINT_VISIBLE_DURATION);

    return () => {
      swipeHintLoopRef.current?.stop();
      swipeHintLoopRef.current = null;
      clearTimeout(hideTimer);
    };
  }, [isSwipeHintVisible, swipeHintOpacity, swipeHintChevronShift]);

  useEffect(() => {
    if (isCardSwipeAnimating && isSwipeHintVisible) {
      swipeHintLoopRef.current?.stop();
      swipeHintLoopRef.current = null;

      Animated.timing(swipeHintOpacity, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setIsSwipeHintVisible(false);
      });
    }
  }, [isCardSwipeAnimating, isSwipeHintVisible, swipeHintOpacity]);

  const handleButtonSwipe = useCallback((direction: 'left' | 'right') => {
    executeSwipeAnimation(direction);
  }, [executeSwipeAnimation]);

  // «←»: картка відлітає вліво (у бік стрілки) і показується попередня.
  const handleGoBack = useCallback(() => {
    if (currentWordIndex === 0) return;
    executeSwipeAnimation('left', () => {
      triggerImageRefresh();
      setCurrentWordIndex((previousIndex) => Math.max(0, previousIndex - 1));
    });
  }, [currentWordIndex, triggerImageRefresh, executeSwipeAnimation]);

  useEffect(() => {
    // ВАЖЛИВО: Видалено LayoutAnimation.configureNext
    // Це запобігає "вискакуванню" і зміщенню елементів при перемиканні карток.
    // Тепер структура змінюється миттєво, а плавність досягається тільки через загальне Opacity картки.
    setOptimisticallyAdded(false);
    userJustAddedRef.current = false;
    setIsFrontUkr(true);
    clearExamplesBounds();
    updateExamplesBounds();
  }, [
    currentWordIndex,
    setIsFrontUkr,
    clearExamplesBounds,
    updateExamplesBounds,
  ]);

  const currentWordData = wordsList[currentWordIndex];
  const currentActiveWord = currentWordData?.word;
  const currentCategory = currentWordData?.category;

  const isWordInDictionary =
    currentWordData?.isInDictionary ||
    (currentActiveWord && locallyAddedWords[currentActiveWord.id]) ||
    false;

  const activeIsAdded = isWordInDictionary || optimisticallyAdded;

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;

    if (activeIsAdded) {
      if (userJustAddedRef.current) {
        // Відгук на натискання: коротке "стискання" кнопки з пружним
        // поверненням, паралельно — перехід у стан "Додано" і поява галочки
        // з легким перебігом (pop). ~450 мс, без жодного JS-кадру.
        checkmarkScale.setValue(0.3);
        animation = Animated.parallel([
          Animated.sequence([
            Animated.timing(buttonScale, {
              toValue: 0.94,
              duration: 90,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.spring(buttonScale, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }),
          ]),
          Animated.timing(addedProgress, {
            toValue: 1,
            duration: 260,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.sequence([
            Animated.delay(90),
            Animated.spring(checkmarkScale, { toValue: 1, friction: 4.5, tension: 170, useNativeDriver: true }),
          ]),
        ]);

        animation.start();
      } else {
        buttonScale.setValue(1);
        checkmarkScale.setValue(1);
        addedProgress.setValue(1);
      }
    } else {
      userJustAddedRef.current = false;
      buttonScale.setValue(1);
      checkmarkScale.setValue(0);
      addedProgress.setValue(0);
    }

    return () => { if (animation) animation.stop(); };
  }, [activeIsAdded]);

  const handleAddWord = useCallback(async () => {
    if (!currentActiveWord || activeIsAdded) return;
    try {
      const wordSnapshot = currentActiveWord;
      const safeWordText = wordSnapshot.text ?? '';

      userJustAddedRef.current = true;
      setOptimisticallyAdded(true);

      // "Політ" слова від кнопки до іконки Словника у футері.
      flyFromView(addButtonRef.current, wordSnapshot.text);

      const userId = userIdRef.current ?? await AsyncStorage.getItem('userId');
      if (userId) userIdRef.current = userId;
      const addedKey = userId ? `userWord${userId}_${safeWordText}:v2` : null;

      dispatch(addWordOptimistic({ word: wordSnapshot }))
        .unwrap()
        .catch((e: unknown) => {
          // Словник заповнено — слово НЕ додано: прибираємо позначку "додано"
          // (інакше картка назавжди показувала б галочку). Вікно покупки
          // місця відкривається само (api.ts).
          if (!isDictionaryLimitError(e)) return;
          if (addedKey) AsyncStorage.removeItem(addedKey).catch(() => {});
          if (!isMountedRef.current) return;
          setLocallyAddedWords(prev => {
            const next = { ...prev };
            delete next[wordSnapshot.id];
            return next;
          });
          setOptimisticallyAdded(false);
          userJustAddedRef.current = false;
        });

      if (addedKey) {
        await AsyncStorage.setItem(addedKey, 'true');
      }

      if (!isMountedRef.current) return;

      setLocallyAddedWords(prev => ({ ...prev, [wordSnapshot.id]: true }));
    } catch (error) {
      if (isMountedRef.current) {
        setOptimisticallyAdded(false);
        userJustAddedRef.current = false;
      }
    }
  }, [dispatch, currentActiveWord, activeIsAdded]);

  const handleTouchStart = useCallback((e: GestureResponderEvent) => {
    touchStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
  }, []);

  const handlePassiveTap = useCallback((text: string, e: GestureResponderEvent) => {
    if (!text) return;

    const distanceX = Math.abs(e.nativeEvent.pageX - touchStartRef.current.x);
    const distanceY = Math.abs(e.nativeEvent.pageY - touchStartRef.current.y);

    if (distanceX < 15 && distanceY < 15) {
      triggerTextToSpeech(text);
    }
  }, [triggerTextToSpeech]);

  const isFirstWord = currentWordIndex === 0;

  // Живий лічильник (сервер + миттєві "+1"), як у Dictionary Cards.
  const overallTotal = programTotal || currentCategory?.total || 0;
  const overallLearned = programTotal ? programLearned : currentCategory?.learned ?? 0;
  const overallProgressPercentage = overallTotal > 0
    ? Math.min(100, Math.max(0, (overallLearned / overallTotal) * 100))
    : 0;

  const safeType = (currentActiveWord?.type || '').toLowerCase();
  const isPhrasalVerb = safeType.includes('phrasal');
  const isPhrase = safeType === 'phrase';
  // ⚠️ Навмисно ідентично оригіналу: НЕ "isPhrase || isPhrasalVerb".
  // Якщо це мало охоплювати і фразові дієслова теж — виправляти тут,
  // а не мовчки під час рефакторингу.
  const isPhraseOrPhrasalVerb = isPhrase;

  return {
    // Дані поточного слова
    currentActiveWord,
    currentCategory,
    isPhrasalVerb,
    isPhraseOrPhrasalVerb,
    overallLearned,
    overallTotal,
    overallProgressPercentage,

    // Тло і вхідна анімація картки
    backgroundRandomImage,
    cardScaleAnimation,
    cardOpacityAnimation,
    contentFlashOpacity,

    // Свайп/жести
    cardPanResponder,
    cardAnimatedStyles,
    isCardSwipeAnimating,
    handleButtonSwipe,
    handleGoBack,
    isFirstWord,

    // Свайп-хінт
    isSwipeHintVisible,
    swipeHintOpacity,
    swipeHintChevronShift,

    // Кнопка "Додати в словник"
    buttonScale,
    checkmarkScale,
    addedProgress,
    addButtonRef,
    activeIsAdded,
    isAdding,
    handleAddWord,

    // Озвучення тапом
    handleTouchStart,
    handlePassiveTap,

    // Вимірювання блоку прикладів (для свайп-жесту картки)
    examplesSectionRef,
    updateExamplesBounds,
  };
}
