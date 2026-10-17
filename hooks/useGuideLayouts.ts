import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, InteractionManager } from 'react-native';
import { ElementLayout } from '../guides/guideManage/GuidedTour';
import { logLifecycleEvent } from '../utils/lifecycleLogger';

// Локальний трейс гайду в консоль (Metro) — НЕ через logLifecycleEvent, щоб
// не засмічувати діагностичний буфер і не ламати тести, які рахують лише
// "справжні" діагностичні події (navigation_error тощо).
const guideTrace = (stage: string, data?: Record<string, unknown>) => {
  if (__DEV__) {
    console.log(`🎯 [GUIDE] ${stage}`, data ?? '');
  }
};

// 🔴 ФІКС (CRITICAL, продуктивність): попередня версія опитувала
// measureInWindow() КОЖНІ 400мс БЕЗКІНЕЧНО, поки isGuideActive і не всі
// ключі виміряні. Кожен виклик measureInWindow — це синхронний
// bridge round-trip (JS thread чекає відповідь від UI thread). Якщо
// хоч один targetKey ніколи не отримує ненульових розмірів (екран ще
// вантажиться, елемент умовно не рендериться, гайд лишився активним
// довше очікуваного через ререндер/навігацію) — цей цикл ЖИВЕ ВІЧНО,
// віднімаючи джс-час у решти застосунку. На слабших CPU (напр. iPhone
// 12) вартість кожного round-trip вища, а накопичення таких циклів
// (Home + Books можуть мати активний гайд одночасно в різних екранах
// стека навігації) — це реальний, вимірюваний, стабільно відтворюваний
// механізм "весь UI гальмує" саме на слабших пристроях, незалежно від
// мережі.
//
// Тепер опитування має ЖОРСТКУ стелю за часом: якщо за
// MAX_TOTAL_POLL_MS ми так і не виміряли все — здаємось назавжди для
// цієї сесії гайду, звільняємо таймер і показуємо тур із тим, що
// встигли виміряти (SpotlightGuidedTour вже вміє коректно
// пропускати кроки з відсутнім layout — див. effectiveLastIndex).
const FAST_ATTEMPTS = 20;
const FAST_ATTEMPT_INTERVAL = 80;
const SLOW_ATTEMPT_INTERVAL = 400;

// 🟢 НОВЕ: жорстка стеля сумарного часу опитування одного гайду.
// 12с — це набагато більше, ніж будь-який реалістичний "холодний"
// рендер елемента гайду, але вже не "назавжди".
const MAX_TOTAL_POLL_MS = 12000;
// 🔴 Абсолютний ліміт СПРОБ на один гайд — страховка поверх стелі 12с. Якщо
// з якоїсь причини стеля за часом не спрацює (напр. pollingStartedAtRef обнулився),
// цей ліміт ГАРАНТУЄ, що опитування не крутитиметься вічно й не заблокує JS-потік.
const MAX_TOTAL_ATTEMPTS = 60;

// 🔧 Позиція вважається стабільною, коли вона однакова (±1px) у
// STABLE_ROUNDS_REQUIRED + 1 вимірюваннях поспіль (~160–240мс).
const STABLE_ROUNDS_REQUIRED = 2;
const LAYOUT_TOLERANCE_PX = 1;
// Після стабілізації ще стільки часу рідко перевіряємо пізні зсуви.
const SETTLED_WATCH_INTERVAL = 500;
const SETTLED_WATCH_DURATION_MS = 4000;

const isSameLayout = (a: ElementLayout, b: ElementLayout) =>
  Math.abs(a.x - b.x) <= LAYOUT_TOLERANCE_PX &&
  Math.abs(a.y - b.y) <= LAYOUT_TOLERANCE_PX &&
  Math.abs(a.width - b.width) <= LAYOUT_TOLERANCE_PX &&
  Math.abs(a.height - b.height) <= LAYOUT_TOLERANCE_PX;

interface GuideLayoutStep {
  targetKey: string;
}

export const useGuideLayouts = (
  isGuideActive: boolean,
  steps: GuideLayoutStep[],
  isReady: boolean,
) => {
  const [layouts, setLayouts] = useState<{ [key: string]: ElementLayout | null }>({});
  const [isAllMeasured, setIsAllMeasured] = useState(false);
  // 🔴 Окремий сигнал "вимірювання ЗАВЕРШЕНО назовсім" (всі цілі стабільні або
  // минув таймаут). Відрізняється від isAllMeasured, яке стає true щойно
  // опубліковано ПЕРШУ позицію — тур має почати показуватись, але ще не має
  // права робити висновок "крок ніколи не з'явиться".
  const [isMeasurementDone, setIsMeasurementDone] = useState(false);
  const [hiddenElementKey, setHiddenElementKey] = useState<string | null>(null);

  const attemptRef = useRef(0);
  const pollingStartedAtRef = useRef<number | null>(null);
  const hasGivenUpRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const interactionHandleRef = useRef<{ cancel: () => void } | null>(null);
  // Опубліковані (стабільні) позиції — саме вони йдуть у тур.
  const accumulatedRef = useRef<{ [key: string]: ElementLayout }>({});
  // Останнє сире вимірювання кожного елемента та скільки разів поспіль воно не змінювалось.
  const latestRef = useRef<{ [key: string]: ElementLayout }>({});
  const stableRoundsRef = useRef<{ [key: string]: number }>({});

  const refs = useMemo(() => {
    const elementRefs: { [key: string]: React.RefObject<View | null> } = {};
    steps.forEach((step) => {
      elementRefs[step.targetKey] = React.createRef<View | null>();
    });
    return elementRefs;
  }, [steps]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (interactionHandleRef.current) interactionHandleRef.current.cancel();
    };
  }, []);

  const stopPollingPermanently = useCallback((reason: 'all_measured' | 'timed_out') => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    hasGivenUpRef.current = true;
    if (reason === 'timed_out') {
      logLifecycleEvent('navigation_error', {
        boundary: 'guide_layout_measurement',
        message: `Guide measurement gave up after ${MAX_TOTAL_POLL_MS}ms`,
      });
    }
    guideTrace('poll_stop', { reason });
    setIsAllMeasured(true);
    setIsMeasurementDone(true);
  }, []);

  const measureAll = useCallback(() => {
    // 🟢 Захист від "зомбі"-таймера: якщо десь між плановим
    // setTimeout і його спрацюванням ми вже здались або гайд
    // деактивувався — нічого не робимо і НЕ плануємо наступну спробу.
    if (hasGivenUpRef.current || !isMountedRef.current) return;

    requestAnimationFrame(() => {
      if (!isMountedRef.current || hasGivenUpRef.current) return;

      const keys = Object.keys(refs);

      // 🔧 Вимірюємо ВСІ елементи на кожному кроці (а не лише ще не
      // виміряні): перше ненульове вимірювання часто робиться, поки екран
      // ще "доростає" (скелетони, панелі, що підвантажують дані), і
      // раніше саме воно назавжди ставало позицією підсвітки — рамка
      // стояла вище/нижче реального елемента і "стрибала".
      const measurements = keys.map((key) => {
        return new Promise<void>((resolve) => {
          const ref = refs[key];
          if (!ref.current) {
            resolve();
            return;
          }
          try {
            ref.current.measureInWindow((x, y, width, height) => {
              if (width > 0 && height > 0) {
                const next = { x, y, width, height };
                const prev = latestRef.current[key];
                stableRoundsRef.current[key] =
                  prev && isSameLayout(prev, next) ? (stableRoundsRef.current[key] ?? 0) + 1 : 0;
                latestRef.current[key] = next;
              }
              resolve();
            });
          } catch {
            resolve();
          }
        });
      });

      Promise.all(measurements).then(() => {
        if (!isMountedRef.current || hasGivenUpRef.current) return;

        attemptRef.current += 1;

        // Абсолютна страховка: навіть якщо pollingStartedAtRef виявився
        // обнуленим (зомбі-цикл), зупиняємось після MAX_TOTAL_ATTEMPTS.
        if (attemptRef.current >= MAX_TOTAL_ATTEMPTS) {
          stopPollingPermanently('timed_out');
          return;
        }

        const elapsedMs = pollingStartedAtRef.current
          ? Date.now() - pollingStartedAtRef.current
          : 0;
        const timedOut = elapsedMs >= MAX_TOTAL_POLL_MS;

        // Публікуємо позицію елемента лише тоді, коли вона стабільна
        // (однакова в STABLE_ROUNDS_REQUIRED+1 вимірюваннях поспіль), або
        // коли вийшов час — тоді беремо останнє відоме значення.
        let changed = false;
        keys.forEach((key) => {
          const latest = latestRef.current[key];
          if (!latest) return;
          const isStable = (stableRoundsRef.current[key] ?? 0) >= STABLE_ROUNDS_REQUIRED;
          if (!isStable && !timedOut) return;
          const published = accumulatedRef.current[key];
          if (!published || !isSameLayout(published, latest)) {
            accumulatedRef.current[key] = latest;
            changed = true;
          }
        });

        if (changed) {
          setLayouts({ ...accumulatedRef.current });
        }

        const publishedCount = Object.keys(accumulatedRef.current).length;

        if (timedOut) {
          stopPollingPermanently(publishedCount === steps.length ? 'all_measured' : 'timed_out');
          return;
        }

        const allStable = keys.every(
          (key) => (stableRoundsRef.current[key] ?? 0) >= STABLE_ROUNDS_REQUIRED,
        );

        if (publishedCount > 0) {
          setIsAllMeasured(true);
        }

        // Коли все стабільне — тур уже показано з точними координатами.
        // Ще кілька секунд рідко перевіряємо позиції: якщо щось зсунеться
        // пізніше (напр. дані прийшли з повільної мережі), підсвітка тихо
        // підлаштується. Стеля MAX_TOTAL_POLL_MS діє і тут.
        const interval = allStable
          ? SETTLED_WATCH_INTERVAL
          : attemptRef.current < FAST_ATTEMPTS
            ? FAST_ATTEMPT_INTERVAL
            : SLOW_ATTEMPT_INTERVAL;

        if (allStable && publishedCount === steps.length && elapsedMs >= SETTLED_WATCH_DURATION_MS) {
          stopPollingPermanently('all_measured');
          return;
        }

        timerRef.current = setTimeout(measureAll, interval);
      });
    });
  }, [refs, steps.length, stopPollingPermanently]);

  useEffect(() => {
    if (!isGuideActive || !isReady) {
      guideTrace('poll_deactivate');
      setIsAllMeasured(false);
      setIsMeasurementDone(false);
      setLayouts({});
      accumulatedRef.current = {};
      latestRef.current = {};
      stableRoundsRef.current = {};
      attemptRef.current = 0;
      pollingStartedAtRef.current = null;
      // 🔴 ФІКС "зомбі-опитування": раніше тут стояло `= false`. Якщо measureAll
      // саме був "у польоті" (всередині requestAnimationFrame / Promise.all),
      // він після деактивації бачив hasGivenUpRef=false і ПЛАНУВАВ наступний
      // setTimeout → опитування жило ВІЧНО (pollingStartedAtRef уже null, тому
      // стеля 12с не працювала), вічно смикаючи measureInWindow і гальмуючи
      // увесь UI. Тепер true зупиняє будь-який незавершений ланцюжок.
      hasGivenUpRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (interactionHandleRef.current) interactionHandleRef.current.cancel();
      return;
    }

    guideTrace('poll_activate');
    attemptRef.current = 0;
    pollingStartedAtRef.current = Date.now();
    hasGivenUpRef.current = false;

    interactionHandleRef.current = InteractionManager.runAfterInteractions(() => {
      measureAll();
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (interactionHandleRef.current) interactionHandleRef.current.cancel();
    };
  }, [isGuideActive, isReady, measureAll]);

  const remeasure = useCallback(() => {
    guideTrace('poll_remeasure');
    if (timerRef.current) clearTimeout(timerRef.current);
    accumulatedRef.current = {};
    latestRef.current = {};
    stableRoundsRef.current = {};
    attemptRef.current = 0;
    pollingStartedAtRef.current = Date.now();
    hasGivenUpRef.current = false;
    setIsMeasurementDone(false);
    measureAll();
  }, [measureAll]);

  return {
    layouts,
    isAllMeasured,
    isMeasurementDone,
    hiddenElementKey,
    setHiddenElementKey,
    refs,
    remeasure,
  };
};