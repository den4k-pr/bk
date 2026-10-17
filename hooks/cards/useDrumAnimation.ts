import { useRef, useEffect } from 'react';
import { Animated } from 'react-native';

export const useDrumAnimation = (dependency: any) => {
  const animatedValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Скидаємо значення перед новою анімацією
    animatedValue.setValue(0);
    
    // Запускаємо пружинну анімацію для реалістичного ефекту "відскоку" барабана
    Animated.spring(animatedValue, {
      toValue: 1,
      friction: 6, // Тертя (менше = більше коливань)
      tension: 40, // Натяг
      useNativeDriver: true,
    }).start();
  }, [dependency, animatedValue]);

  const drumStyle = {
    opacity: animatedValue.interpolate({
      inputRange: [0, 0.5, 1],
      outputRange: [0, 0.5, 1],
    }),
    transform: [
      {
        translateY: animatedValue.interpolate({
          inputRange: [0, 1],
          outputRange: [-40, 0], // Слово падає зверху
        }),
      },
      {
        rotateX: animatedValue.interpolate({
          inputRange: [0, 1],
          outputRange: ['-90deg', '0deg'], // 3D обертання по осі X
        }),
      },
    ],
  };

  return drumStyle;
};