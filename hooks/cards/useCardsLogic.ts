import { useState, useRef, useEffect, useCallback } from 'react';
import { Animated } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { useRoute, RouteProp } from '@react-navigation/native';
import { AppDispatch, RootState } from '../../../store';
import { useInterstitialAd } from '../adds/useInterstitialAd';
import { registerCompletedCardCycle } from '../adds/cardsAdCounter';
import {
  fetchNewWordCycle,
  fetchRandomWords,
  resetStepDisabled,
  resetProgramCounter,
  syncCurrentProgramWords,
} from '../../features/learnSlice';
import { cardsResumeStore } from './cardsResumeStore';

const TRANSITION_DURATION = 350;

// 🟢 НОВЕ: параметри екрана Cards. category — опційна: якщо перехід
// стався з CardFiltersScreen (натискання на тематичний набір), сюди
// прилітає назва категорії, і весь подальший потік (перше завантаження
// + кожен наступний цикл через fetchNewWordCycle) фільтрується саме по
// ній. Якщо category відсутня — поведінка НЕ змінюється: той самий
// "змішаний" потік по всіх доступних програмах, що працював раніше.
//
// ⚠️ Якщо назва роута Cards у вашому навігаторі відрізняється, або
// параметр іменується інакше — підправте RouteProp/route.params нижче
// під фактичну конфігурацію навігації проєкту.
type CardsRouteParams = { category?: string } | undefined;

export const useCardsLogic = () => {
  const dispatch = useDispatch<AppDispatch>();
  const route = useRoute<RouteProp<Record<string, CardsRouteParams>, string>>();
  const category = route.params?.category;

  const { words, status, step3Disabled, cycleId } = useSelector(
    (state: RootState) => state.learn,
  );
  const { showInterstitialAd } = useInterstitialAd();

  // Повернулись на вкладку посеред колоди — продовжуємо її, без нового запиту.
  const resumeRef = useRef(status === 'succeeded' && cardsResumeStore.canResume(words, category));

  const [step, setStep] = useState<'first' | 'second'>(() =>
    resumeRef.current ? cardsResumeStore.step(words) : 'first',
  );
  const [isSwitching, setIsSwitching] = useState(false);
  const [displayWords, setDisplayWords] = useState(words);


  const opacityFirst = useRef(new Animated.Value(0)).current;
  const opacitySecond = useRef(new Animated.Value(0)).current;

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Вихід з карток посеред циклу — не губимо вже переглянуті слова.
      dispatch(syncCurrentProgramWords());
    };
  }, [dispatch]);

  useEffect(() => {
    if (status === 'loading') setDisplayWords([]);
    if (!isSwitching && status === 'succeeded' && Array.isArray(words)) {
      setDisplayWords(words);
    }
  }, [words, status, isSwitching]);

  useEffect(() => {
    // 🟢 ЗМІНЕНО: передаємо category у перший запит слів. Коли
    // category === undefined, getRandomNotLearnedWords() працює точно
    // так само, як і раніше (без жодного фільтра).
    if (resumeRef.current) {
      resumeRef.current = false;
      dispatch(resetStepDisabled());
      return;
    }
    dispatch(resetProgramCounter());
    dispatch(fetchRandomWords(category));
    dispatch(resetStepDisabled());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, category]);

  // Запам'ятовуємо поточну колоду і етап (картка / мікрофон).
  useEffect(() => {
    if (status === 'succeeded' && displayWords.length > 0 && !isSwitching) {
      cardsResumeStore.save(displayWords, category, { step });
    }
  }, [status, displayWords, step, isSwitching, category]);

  useEffect(() => {
    if (status === 'succeeded' && displayWords.length > 0 && !isSwitching) {
      const targetAnim = step === 'first' ? opacityFirst : opacitySecond;
      Animated.timing(targetAnim, {
        toValue: 1,
        duration: TRANSITION_DURATION,
        useNativeDriver: true,
      }).start();
    }
  }, [status, displayWords, step, isSwitching]);

  const handleDeckComplete = useCallback(
    async (action: 'second' | 'complite') => {
      if (isSwitching) return;
      setIsSwitching(true);

      const activeAnim = step === 'first' ? opacityFirst : opacitySecond;

      Animated.timing(activeAnim, {
        toValue: 0,
        duration: TRANSITION_DURATION,
        useNativeDriver: true,
      }).start(async () => {
        try {
          if (action === 'second' && !step3Disabled) {
            if (isMountedRef.current) setStep('second');
          } else {
            // 🔴 ФІКС: локальний лічильник замість state.learn.cycleId.
            // Інкрементується ЛИШЕ коли ЦЕЙ потік (картки) реально
            // завершує колоду і генерує наступні 3 слова — саме той
            // момент, коли й має вирішуватись питання реклами.
            const shouldShowAd = registerCompletedCardCycle();

            // Категорію для наступного циклу передавати тут повторно НЕ
            // потрібно — fetchNewWordCycle сам бере її з
            // state.learn.currentCategory (той самий category, з яким
            // стартував цей екран).
            if (shouldShowAd) {
              try {
                await dispatch(fetchNewWordCycle({ showAd: showInterstitialAd }));
              } catch (adOrFetchError) {
                console.warn(
                  '[useCardsLogic] fetchNewWordCycle with ad failed, retrying without ad:',
                  adOrFetchError,
                );
                await dispatch(fetchNewWordCycle({ showAd: () => {} }));
              }
            } else {
              await dispatch(fetchNewWordCycle({ showAd: () => {} }));
            }

            if (isMountedRef.current) setStep('first');
          }
        } catch (error) {
          console.warn('[useCardsLogic] handleDeckComplete failed:', error);
          if (isMountedRef.current) setStep('first');
        } finally {
          if (isMountedRef.current) setIsSwitching(false);
        }
      });
    },
    [step, step3Disabled, isSwitching, dispatch, showInterstitialAd],
  );

  const handleRetry = useCallback(() => {
    dispatch(fetchRandomWords(category));
  }, [dispatch, category]);

  return {
    step,
    words: displayWords,
    status,
    isError: status === 'failed',
    isSwitching,
    opacities: { first: opacityFirst, second: opacitySecond },
    isContentLoaded: status === 'succeeded' || status === 'failed',
    cycleId,
    category,
    handleDeckComplete,
    step3Disabled,
    handleRetry,
  };
};