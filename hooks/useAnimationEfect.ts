import { useEffect, useRef } from "react";
import { Animated } from "react-native";

export const useSuccessAnimation = (trigger: boolean) => {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (trigger) {
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 0.7,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [trigger]);

  return {transform: [{scale}]};
};