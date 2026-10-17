import { useRef, useState, useEffect } from "react";
import { Dimensions, PanResponder, Animated, PanResponderGestureState, GestureResponderEvent } from "react-native";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const SWIPE_THRESHOLD = 0.25 * SCREEN_WIDTH;
const SWIPE_OUT_DURATION = 350;
const CARD_HORIZONTAL_CLAIM_THRESHOLD = 8;

type SwipeDirection = "left" | "right";

type PointInsideRegionCheck = (pageX: number, pageY: number) => boolean;

export const useCardAnimations = (
  onSwipeEnd: (direction: SwipeDirection) => void,
  isPointInsideExamplesBlock?: PointInsideRegionCheck,
) => {
  const [isFrontUkr, setIsFrontUkr] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  const position = useRef(new Animated.ValueXY()).current;
  const scale = useRef(new Animated.Value(1)).current;

  const tapStartTime = useRef<number | null>(null);

  // ЗАХІД: gesture.x0/y0 у бібліотеці PanResponder — це координати НЕ початку
  // дотику, а моменту видачі responder'а САМЕ ЦЬОМУ PanResponder. Поки картка
  // ще не стала responder'ом (а вона свідомо цього уникає при дотику в examples),
  // x0/y0 всередині onMoveShouldSetPanResponder ненадійні. Тому фіксуємо реальну
  // точку дотику самостійно, одразу в onStartShouldSetPanResponder, і читаємо
  // її звідси — це той самий touch-цикл, тому значення завжди актуальне.
  const pendingTouchOriginRef = useRef({ pageX: 0, pageY: 0 });

  // Зберігаємо останню версію колбеку
  const onSwipeEndRef = useRef(onSwipeEnd);
  useEffect(() => {
    onSwipeEndRef.current = onSwipeEnd;
  }, [onSwipeEnd]);

  // ЗАХІД: PanResponder.create викликається лише один раз (через useRef),
  // тому всі колбеки всередині нього замикаються на ПОЧАТКОВІ значення
  // isAnimating/isFrontUkr і ніколи не бачать оновлень стейту (stale closure).
  // Без цих рефів захист `if (isAnimating) return` у onStartShouldSetPanResponder
  // фактично НЕ ПРАЦЮЄ — жест завжди приймається, навіть під час анімації.
  // Це дозволяє повторний swipe() під час вже запущеної анімації і
  // призводить до подвійного виклику onSwipeEndRef.current(dir),
  // а відповідно — до подвійного dispatch і переходу на наступний крок/цикл.
  const isAnimatingRef = useRef(isAnimating);
  const isFrontUkrRef = useRef(isFrontUkr);

  useEffect(() => {
    isAnimatingRef.current = isAnimating;
  }, [isAnimating]);

  useEffect(() => {
    isFrontUkrRef.current = isFrontUkr;
  }, [isFrontUkr]);

  const resetPosition = () => {
    Animated.spring(position, {
      toValue: { x: 0, y: 0 },
      friction: 5,
      useNativeDriver: true,
    }).start();
  };

  /**
   * onComplete — що зробити після вильоту картки замість звичайного "далі"
   * (кнопка «←»: картка летить вліво і показується попередня).
   */
  const swipe = (dir: SwipeDirection, onComplete?: () => void) => {
    // ЗАХІД: додаткова захисна перевірка через ref, а не тільки через
    // замкнений isAnimating зі стейту (для викликів ззовні, напр. з кнопок).
    if (isAnimatingRef.current) return;
    const x = dir === "right" ? SCREEN_WIDTH : -SCREEN_WIDTH;

    setIsAnimating(true);
    isAnimatingRef.current = true;

    Animated.timing(position, {
      toValue: { x, y: 0 },
      duration: SWIPE_OUT_DURATION,
      useNativeDriver: true,
    }).start(() => {
      // Викликаємо колбек
      try {
        if (onComplete) onComplete();
        else onSwipeEndRef.current(dir);
      } catch (e) {
        // ЗАХІД: колбек onSwipeEnd може кидати виняток (напр. dispatch впав) —
        // не даємо це зламати внутрішній ланцюжок анімацій/скидання стану.
        console.warn('[useCardAnimations] onSwipeEnd callback threw:', e);
      }

      // 🔹 Скидання після анімації з додатковою затримкою
      setTimeout(() => {
        requestAnimationFrame(() => {
          position.setValue({ x: 0, y: 0 });
          setIsFrontUkr(false);
          isFrontUkrRef.current = false;

          Animated.spring(scale, {
            toValue: 1,
            friction: 8,
            tension: 70,
            useNativeDriver: true,
          }).start(() => {
            // 🔹 Додаємо додаткову паузу перед активацією кнопок
            setTimeout(() => {
              setIsAnimating(false);
              isAnimatingRef.current = false;
            }, 400); // тут затримка 400 мс
          });
        });
      }, 100);
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      // ЗАХІД: якщо дотик почався геометрично всередині блоку прикладів — картка
      // НЕ забирає жест одразу на старті. Перевірка йде по реальних координатах
      // дотику (pageX/pageY) відносно виміряних меж блоку на екрані, тому не залежить
      // від порядку спрацювання інших подієвих систем (без гонки подій).
      onStartShouldSetPanResponder: (evt: GestureResponderEvent) => {
        pendingTouchOriginRef.current = { pageX: evt.nativeEvent.pageX, pageY: evt.nativeEvent.pageY };
        if (isAnimatingRef.current) return false;
        if (isPointInsideExamplesBlock?.(evt.nativeEvent.pageX, evt.nativeEvent.pageY)) return false;
        return true;
      },
      // ЗАХІД: якщо дотик почався в блоці прикладів і картка не забрала жест на старті,
      // даємо їй шанс забрати його вже під час руху — але тільки якщо рух явно
      // горизонтальний (це свайп картки, а не скрол прикладів). Використовуємо
      // pendingTouchOriginRef (справжню точку старту дотику), а не gesture.x0/y0.
      // Якщо блок examples вже забрав жест собі (вертикальний скрол), ця гілка
      // просто ніколи не отримає виклику — RN питає глибший View першим.
      onMoveShouldSetPanResponder: (_: GestureResponderEvent, gesture: PanResponderGestureState) => {
        if (isAnimatingRef.current) return false;
        const origin = pendingTouchOriginRef.current;
        if (!isPointInsideExamplesBlock?.(origin.pageX, origin.pageY)) return false;
        const isHorizontalDrag = Math.abs(gesture.dx) > Math.abs(gesture.dy);
        const passesThreshold = Math.abs(gesture.dx) > CARD_HORIZONTAL_CLAIM_THRESHOLD;
        return isHorizontalDrag && passesThreshold;
      },
      onPanResponderGrant: () => {
        tapStartTime.current = Date.now();
      },
      onPanResponderMove: (_: GestureResponderEvent, gesture: PanResponderGestureState) => {
        // ЗАХІД: додаткова перестраховка — якщо анімація вже пішла (isAnimatingRef
        // встиг стати true між grant і move), не рухаємо позицію картки руками,
        // щоб не конфліктувати з Animated.timing, який паралельно керує position.
        if (isAnimatingRef.current) return;
        position.setValue({ x: gesture.dx, y: gesture.dy });
      },
      onPanResponderRelease: (_: GestureResponderEvent, gesture: PanResponderGestureState) => {
        // ЗАХІД: якщо між grant і release анімація вже стартувала (напр. через
        // програмний swipe() з кнопки) — ігноруємо release, інакше можливий
        // повторний swipe() під час вже запущеної анімації.
        if (isAnimatingRef.current) return;

        const tapDuration = tapStartTime.current
          ? Date.now() - tapStartTime.current
          : 0;
        const moveDistance = Math.sqrt(gesture.dx ** 2 + gesture.dy ** 2);

        // Тап — просто переворот картки
        if (tapDuration < 200 && moveDistance < 10) {
          // ЗАХІД: читаємо isFrontUkrRef.current замість замкненого isFrontUkr
          if (!isFrontUkrRef.current) {
            setIsFrontUkr(true);
            isFrontUkrRef.current = true;
          }
          resetPosition();
          return;
        }

        // Свайп праворуч
        if (gesture.dx > SWIPE_THRESHOLD) {
          swipe("right");
          return;
        }

        // Свайп ліворуч
        if (gesture.dx < -SWIPE_THRESHOLD) {
          swipe("left");
          return;
        }

        resetPosition();
      },
      onPanResponderTerminationRequest: () => true,
    })
  ).current;

  const rotate = position.x.interpolate({
    inputRange: [-SCREEN_WIDTH, 0, SCREEN_WIDTH],
    outputRange: ["-10deg", "0deg", "10deg"],
  });

  const likeOpacity = position.x.interpolate({
    inputRange: [0, SCREEN_WIDTH / 2],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });

  const nopeOpacity = position.x.interpolate({
    inputRange: [-SCREEN_WIDTH / 2, 0],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  const animatedStyle = {
    transform: [
      { translateX: position.x },
      { translateY: position.y },
      { rotate },
      { scale },
    ],
  };

  const likeStyle = {
    position: "absolute" as const,
    zIndex: 9,
    top: 40,
    right: 20,
    opacity: likeOpacity,
    transform: [{ rotate: "-20deg" }],
  };

  const nopeStyle = {
    position: "absolute" as const,
    zIndex: 9,
    top: 40,
    left: 20,
    opacity: nopeOpacity,
    transform: [{ rotate: "20deg" }],
  };

  // 🔹 Тепер повертаємо swipe, щоб можна було викликати з кнопок
  return {
    panResponder,
    animatedStyle,
    likeStyle,
    nopeStyle,
    isFrontUkr,
    setIsFrontUkr,
    swipe,
    isAnimating
  };
};