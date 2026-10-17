import { useRef, useEffect } from "react";
import { Animated } from "react-native";

export const useFadeInAnimation = (visible: boolean, key: any, duration: number = 300) => {
 // Використовуємо 0 для scale, оскільки це просто контролер анімації
 const animationValue = useRef(new Animated.Value(0)).current;

 useEffect(() => {
  // Визначаємо кінцеве значення: 1 для видимості, 0 для невидимості
  const toValue = visible ? 1 : 0;
  
  // Не скидаємо setValue на початку, а просто запускаємо анімацію
  Animated.spring(animationValue, {
   toValue: toValue,
   friction: 6,
   tension: 40, // Додаємо tension для більш динамічної пружини
   useNativeDriver: true,
  }).start();
  
 }, [visible, key, animationValue]);

 // Інтерполюємо, щоб scale переходив від 0.55 до 1.0 (для появи)
 const scale = animationValue.interpolate({
  inputRange: [0, 1],
  outputRange: [0.55, 1], // Змінюється з 0.55 (зникнення) до 1 (поява)
 });
  
 // Інтерполюємо, щоб opacity переходив від 0 до 1
 const opacity = animationValue.interpolate({
  inputRange: [0, 1],
  outputRange: [0, 1], // Змінюється з 0 (зникнення) до 1 (поява)
 });

 const animatedStyle = {
  opacity, // Додаємо анімацію прозорості
  transform: [{ scale }],
 };

 return { animatedStyle };
};