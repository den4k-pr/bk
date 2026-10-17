import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

export const useSuccessAnimation = (trigger: boolean) => {
  const bgScale = useRef(new Animated.Value(0)).current;      // фон
  const contentScale = useRef(new Animated.Value(0)).current; // чек та обгортка

  useEffect(() => {
    if (trigger) {
      Animated.sequence([
        Animated.timing(bgScale, {
          toValue: 1,
          duration: 400,
          easing: Easing.out(Easing.exp),
          useNativeDriver: true,
        }),
        Animated.spring(contentScale, {
          toValue: 1,
          friction: 4,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      // Скидаємо все, щоб анімація могла спрацювати знову
      bgScale.setValue(0);
      contentScale.setValue(0);
    }
  }, [trigger]);

  return {
    bgScaleStyle: { transform: [{ scale: bgScale }] },
    contentScaleStyle: { transform: [{ scale: contentScale }] },
  };
};
