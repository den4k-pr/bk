import { useState, useEffect, useCallback, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useIsFocused } from '@react-navigation/native';
import { RootState, AppDispatch } from '../../store';
import { fetchCompletedGuides, markGuideCompleted, readLocalCompletedGuides, guideStarted, guideFinished } from '../features/guideSlice';
import { logLifecycleEvent } from '../utils/lifecycleLogger';

// Повтор запиту пройдених гайдів, якщо сервер не відповів (мережа, токен).
const GUIDE_FETCH_RETRY_MS = 5000;

export const useGuide = (guideName: string, stepsCount: number, enabled: boolean = true) => {
  const dispatch = useDispatch<AppDispatch>();
  const completedGuides = useSelector((state: RootState) => state.guide.completedGuides);
  const status = useSelector((state: RootState) => state.guide.status);

  const isFocused = useIsFocused();

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<boolean[]>(() => Array(stepsCount).fill(false));

  const [isGuideWanted, setIsGuideWanted] = useState(false);

  const isGuideActive = isGuideWanted && isFocused && enabled;

  const hasStartedRef = useRef(false);
  const finishedHereRef = useRef(false);
  const hasCheckedLocalCacheRef = useRef(false);

  // 🔴 ФІКС "спалаху вже пройденого гайду": раніше локальний кеш і
  // серверний Redux-стан були двома незалежними джерелами, і локальний
  // кеш міг ОДРАЗУ вмикати гайд (isGuideWanted=true), не чекаючи
  // відповіді сервера. Якщо локальний кеш був застарілим/відсутнім
  // (перевстановлення застосунку, очищення сховища, позначення
  // завершення відбулося лише на іншому пристрої), а сервер насправді
  // вже мав цей гайд у completedGuides — гайд встигав на мить
  // з'явитися, і лише потім, коли Redux-запит завершувався, ховався.
  // Тепер isGuideWanted вмикається ЛИШЕ коли отримано ОБИДВА сигнали
  // (локальний кеш прочитано І Redux-запит завершився) — і жоден з них
  // не каже "вже пройдено". Будь-який сигнал "пройдено" (з будь-якого
  // джерела) назавжди блокує показ, без проміжного рендеру.
  const isLocalCacheCheckedRef = useRef(false);
  const localCompletedRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setCompletedSteps(Array(stepsCount).fill(false));
  }, [stepsCount]);

  useEffect(() => {
    if (status === 'idle') {
      dispatch(fetchCompletedGuides());
    }
  }, [status, dispatch]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (hasCheckedLocalCacheRef.current || stepsCount <= 0) {
      return;
    }
    hasCheckedLocalCacheRef.current = true;

    (async () => {
      try {
        const localCompleted = await readLocalCompletedGuides();

        if (!isMountedRef.current) {
          return;
        }

        localCompletedRef.current = localCompleted.includes(guideName);
        isLocalCacheCheckedRef.current = true;
      } catch {
        // Навіть при помилці читання позначаємо перевірку завершеною —
        // інакше гайд ніколи б не зміг стартувати офлайн/при збої диска.
        localCompletedRef.current = false;
        isLocalCacheCheckedRef.current = true;
      }

      evaluateGuideStart();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideName, stepsCount, enabled]);

  const evaluateGuideStart = useCallback((): void => {
    if (!enabled) return;
    if (hasStartedRef.current) return;
    if (stepsCount <= 0) return;

    if (!isLocalCacheCheckedRef.current) return;

    // Пройдено за локальною копією — не показуємо, сервер не потрібен.
    if (localCompletedRef.current || completedGuides.includes(guideName)) {
      hasStartedRef.current = true;
      if (isGuideWanted) setIsGuideWanted(false);
      return;
    }

    // 🔴 ФІКС "гайд вискакує повторно": раніше при НЕВДАЛОМУ запиті
    // (status 'failed' — немає мережі, оновлюється токен, сервер не
    // встиг) гайд показувався, якщо на пристрої не було локальної копії
    // (перевстановлення, інший телефон, пройдено в старій версії). Тепер
    // гайд стартує ЛИШЕ коли сервер ТОЧНО відповів, що гайд не пройдено;
    // після збою запит повторюється.
    if (status !== 'succeeded') return;

    hasStartedRef.current = true;

    setCurrentStepIndex(0);
    setIsGuideWanted(true);
    dispatch(guideStarted(guideName));
    logLifecycleEvent('guide_trace', { guide: guideName, stage: 'start' });
  }, [enabled, stepsCount, status, completedGuides, guideName, isGuideWanted, dispatch]);

  useEffect(() => {
    evaluateGuideStart();
  }, [evaluateGuideStart]);

  // Сервер не відповів — повторюємо (лише поки рішення про показ не ухвалено).
  useEffect(() => {
    if (!enabled || !isFocused || hasStartedRef.current || status !== 'failed') return;
    const timer = setTimeout(() => {
      dispatch(fetchCompletedGuides());
    }, GUIDE_FETCH_RETRY_MS);
    return () => clearTimeout(timer);
  }, [enabled, isFocused, status, dispatch]);

  // Гайд уже на екрані, а сервер (із запізненням) каже, що його пройдено.
  useEffect(() => {
    if (isGuideWanted && completedGuides.includes(guideName) && !finishedHereRef.current) {
      setIsGuideWanted(false);
      dispatch(guideFinished(guideName));
    }
  }, [isGuideWanted, completedGuides, guideName, dispatch]);

  // Підчищаємо активний статус, якщо екран розмонтовується, поки гайд іще
  // показаний (наприклад, навігація назад/вихід) — інакше NotificationModal
  // назавжди чекатиме, що гайд активний.
  useEffect(() => {
    return () => {
      dispatch(guideFinished(guideName));
    };
  }, [dispatch, guideName]);

  const finishGuide = useCallback(() => {
    // 🔴 ФІКС "подвійний тап → 2 POST": раніше повторний виклик в межах одного
    // кадру (до ререндера) знову диспатчив markGuideCompleted. Гвард робить
    // завершення ідемпотентним — лише ОДИН запит/запис на гайд.
    if (finishedHereRef.current) return;
    finishedHereRef.current = true;
    setIsGuideWanted(false);
    logLifecycleEvent('guide_trace', { guide: guideName, stage: 'finish' });
    dispatch(guideFinished(guideName));
    // markGuideCompleted спершу пише локальну копію, потім сервер; якщо
    // сервер недоступний — fetchCompletedGuides допише гайд пізніше.
    dispatch(markGuideCompleted(guideName));
  }, [dispatch, guideName]);

  const nextStep = useCallback(() => {
    logLifecycleEvent('guide_trace', {
      guide: guideName,
      stage: 'next',
      from: currentStepIndex,
      to: currentStepIndex + 1 >= stepsCount ? 'finish' : currentStepIndex + 1,
    });
    setCompletedSteps((prev) => {
      const updated = [...prev];
      updated[currentStepIndex] = true;
      return updated;
    });

    if (currentStepIndex + 1 >= stepsCount) {
      finishGuide();
    } else {
      setCurrentStepIndex(currentStepIndex + 1);
    }
  }, [currentStepIndex, stepsCount, finishGuide, guideName]);

  const prevStep = useCallback(() => {
    logLifecycleEvent('guide_trace', { guide: guideName, stage: 'prev', from: currentStepIndex });
    setCurrentStepIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, [currentStepIndex, guideName]);

  const skipGuide = useCallback(() => {
    logLifecycleEvent('guide_trace', { guide: guideName, stage: 'skip' });
    finishGuide();
  }, [finishGuide, guideName]);

  // Прямий перехід на крок — використовується SpotlightGuidedTour, щоб
  // перестрибнути невиміряний крок (напр. WordOfDay не завантажився) до
  // найближчого виміряного, не залишаючи порожній блокуючий Modal.
  const jumpToStep = useCallback(
    (index: number) => {
      if (!Number.isInteger(index) || index < 0 || index >= stepsCount) return;
      logLifecycleEvent('guide_trace', {
        guide: guideName,
        stage: 'jump',
        from: currentStepIndex,
        to: index,
      });
      setCurrentStepIndex(index);
    },
    [stepsCount, guideName, currentStepIndex],
  );

  return {
    isGuideActive,
    currentStepIndex,
    nextStep,
    prevStep,
    skipGuide,
    jumpToStep,
    completedSteps,
  };
};