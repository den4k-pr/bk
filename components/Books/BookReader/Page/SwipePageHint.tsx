import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

const HINT_WIDTH = 46;
const CHEVRON_SIZE = 13;
// Той самий акцентний колір, що вже використовується в спінері
// Preloader-а і в заповненні прогрес-бару читалки (#F99511) — свідомо
// перевикористаний тут, а не вигаданий новий, щоб підказка виглядала
// частиною тієї самої візуальної мови застосунку, а не стороннім елементом.
const ACCENT_COLOR = '#F99511';

interface SwipePageHintProps {
  visible: boolean;
}

/**
 * SwipePageHint.tsx
 *
 * Мінімалістична одноразова підказка біля ПРАВОГО краю екрана читалки:
 * легкий акцентний відблиск і "дихаюча" шеврон-стрілка, що натякають —
 * сторінку можна гортати вбік. З'являється лише поки користувач ще
 * жодного разу не свайпнув сторінку (прапорець `visible` та сама
 * персистенція "більше не показувати" — на боці BookReaderScreen,
 * через AsyncStorage; цей компонент — чисто презентаційний).
 *
 * 🔴 pointerEvents="none" на КОЖНОМУ шарі — критично. Підказка лежить
 * ПОВЕРХ основного горизонтального FlatList і не повинна перехоплювати
 * ні свайп гортання сторінок, ні тапи по словах під нею.
 *
 * 🟢 Шеврон намальований однією маленькою View з border-top + border-
 * right, повернутою на 45° — класична, повністю детермінована техніка
 * (жодної залежності від системного шрифту чи emoji-набору), тому
 * виглядає піксель-в-піксель однаково на будь-якому пристрої.
 */
export const SwipePageHint: React.FC<SwipePageHintProps> = ({ visible }) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const chevronShift = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (visible) {
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();

      loopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(chevronShift, {
            toValue: 1,
            duration: 700,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(chevronShift, {
            toValue: 0,
            duration: 700,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      );
      loopRef.current.start();
    } else {
      loopRef.current?.stop();
      loopRef.current = null;
      Animated.timing(opacity, {
        toValue: 0,
        duration: 260,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }

    return () => {
      loopRef.current?.stop();
    };
  }, [visible, opacity, chevronShift]);

  const translateX = chevronShift.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });

  return (
    <Animated.View pointerEvents="none" style={[styles.wrap, { opacity }]}>
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', `${ACCENT_COLOR}22`]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View pointerEvents="none" style={[styles.chevronWrap, { transform: [{ translateX }] }]}>
        <View style={styles.chevron} />
      </Animated.View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: HINT_WIDTH,
    zIndex: 20,
  },
  chevronWrap: {
    position: 'absolute',
    right: 16,
    top: '50%',
    marginTop: -CHEVRON_SIZE / 2,
  },
  chevron: {
    width: CHEVRON_SIZE,
    height: CHEVRON_SIZE,
    borderTopWidth: 2.5,
    borderRightWidth: 2.5,
    borderColor: ACCENT_COLOR,
    transform: [{ rotate: '45deg' }],
  },
});