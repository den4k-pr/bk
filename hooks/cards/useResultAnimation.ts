import { useEffect, useRef } from "react";
import { Animated } from "react-native";

export const useResultAnimation = (
  showResult: boolean,
  onAnimationComplete: () => void
) => {
  const microphoneScale = useRef(new Animated.Value(1)).current;
  const resultScale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (showResult) {
      // Послідовна анімація:
      Animated.sequence([
        // 1. Плавно ховаємо мікрофон
        Animated.timing(microphoneScale, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        // 2. Плавно показуємо результат
        Animated.timing(resultScale, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // 3. Чекаємо 2 секунди
        Animated.delay(2000),
      ]).start(({ finished }) => {
        // 4. Після завершення всієї послідовності викликаємо колбек
        if (finished) {
          onAnimationComplete();
        }
      });
    } else {
      // Миттєво скидаємо значення для підготовки до наступного слова
      microphoneScale.setValue(1);
      resultScale.setValue(0);
    }
  }, [showResult, microphoneScale, resultScale, onAnimationComplete]);

  const microphoneAnimatedStyle = {
    transform: [{ scale: microphoneScale }],
  };

  const resultAnimatedStyle = {
    transform: [{ scale: resultScale }],
  };

  return { microphoneAnimatedStyle, resultAnimatedStyle };
};