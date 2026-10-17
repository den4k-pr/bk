import { colors } from '../../../../styles/theme';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { styles, SHEET_WIDTH } from './TranslationBottomSheet.styles';
import { localStyles } from './TranslationBottomSheet.local.styles';

export function useAddWordAnimation(isAdded: boolean, userJustAddedRef: React.MutableRefObject<boolean>) {
  /* ── Анімовані значення ─────────────────────────────────── */
  const buttonScale = useRef(new Animated.Value(1)).current;
  const successRingScale = useRef(new Animated.Value(0.6)).current;
  const successRingOpacity = useRef(new Animated.Value(0)).current;
  const secondRingScale = useRef(new Animated.Value(0.6)).current;
  const secondRingOpacity = useRef(new Animated.Value(0)).current;
  const checkmarkScale = useRef(new Animated.Value(0)).current;
  const checkmarkTilt = useRef(new Animated.Value(0)).current;
  const successFill = useRef(new Animated.Value(0)).current;
  const contentFlashOpacity = useRef(new Animated.Value(0)).current;
  const sweepProgress = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;

    const settle = (added: boolean) => {
      buttonScale.setValue(1);
      checkmarkScale.setValue(added ? 1 : 0);
      checkmarkTilt.setValue(added ? 1 : 0);
      successFill.setValue(0);
      successRingScale.setValue(0.6);
      successRingOpacity.setValue(0);
      secondRingScale.setValue(0.6);
      secondRingOpacity.setValue(0);
      contentFlashOpacity.setValue(0);
      sweepProgress.setValue(0);
      cardScale.setValue(1);
    };

    if (isAdded) {
      if (userJustAddedRef.current) {
        checkmarkScale.setValue(0);
        checkmarkTilt.setValue(0);
        successFill.setValue(0);
        successRingScale.setValue(0.6);
        secondRingScale.setValue(0.6);
        sweepProgress.setValue(0);

        animation = Animated.parallel([
          Animated.sequence([
            Animated.timing(buttonScale, {
              toValue: 0.84, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true,
            }),
            Animated.spring(buttonScale, {
              toValue: 1, friction: 4.5, tension: 110, useNativeDriver: true,
            }),
          ]),

          Animated.timing(successFill, {
            toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true,
          }),

          Animated.sequence([
            Animated.delay(70),
            Animated.parallel([
              Animated.spring(checkmarkScale, {
                toValue: 1, friction: 5, tension: 130, useNativeDriver: true,
              }),
              Animated.timing(checkmarkTilt, {
                toValue: 1, duration: 340, easing: Easing.out(Easing.back(2)), useNativeDriver: true,
              }),
            ]),
          ]),

          Animated.parallel([
            Animated.timing(successRingScale, {
              toValue: 1.85, duration: 460, easing: Easing.out(Easing.cubic), useNativeDriver: true,
            }),
            Animated.sequence([
              Animated.timing(successRingOpacity, { toValue: 0.6, duration: 70, useNativeDriver: true }),
              Animated.timing(successRingOpacity, {
                toValue: 0, duration: 390, easing: Easing.out(Easing.quad), useNativeDriver: true,
              }),
            ]),
          ]),

          Animated.sequence([
            Animated.delay(110),
            Animated.parallel([
              Animated.timing(secondRingScale, {
                toValue: 2.7, duration: 540, easing: Easing.out(Easing.cubic), useNativeDriver: true,
              }),
              Animated.sequence([
                Animated.timing(secondRingOpacity, { toValue: 0.3, duration: 80, useNativeDriver: true }),
                Animated.timing(secondRingOpacity, {
                  toValue: 0, duration: 460, easing: Easing.out(Easing.quad), useNativeDriver: true,
                }),
              ]),
            ]),
          ]),

          Animated.sequence([
            Animated.delay(40),
            Animated.parallel([
              Animated.timing(sweepProgress, {
                toValue: 1, duration: 640, easing: Easing.inOut(Easing.cubic), useNativeDriver: true,
              }),
              Animated.sequence([
                Animated.timing(contentFlashOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
                Animated.timing(contentFlashOpacity, {
                  toValue: 0, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: true,
                }),
              ]),
            ]),
          ]),

          Animated.sequence([
            Animated.timing(cardScale, { toValue: 1.014, duration: 120, useNativeDriver: true }),
            Animated.spring(cardScale, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }),
          ]),
        ]);
        animation.start();
      } else {
        settle(true);
      }
    } else {
      userJustAddedRef.current = false;
      settle(false);
    }

    return () => { if (animation) animation.stop(); };
  }, [
    isAdded, buttonScale, checkmarkScale, checkmarkTilt, successFill,
    successRingOpacity, successRingScale, secondRingOpacity, secondRingScale,
    contentFlashOpacity, sweepProgress, cardScale,
  ]);

  // Змінено стиль картки для ГАРАНТОВАНОЇ глибокої темної тіні
  const animatedCardStyle = useMemo(() => [
    styles.sheetActions,
    { 
      overflow: 'visible' as const, 
      marginBottom: 38, 
      transform: [{ scale: cardScale }],
      
      // --- ПРАВИЛЬНА ТЕМНА ТІНЬ ---
      backgroundColor: '#fdfdfd', // ОБОВ'ЯЗКОВО для Android: без фону тінь не відкидається
      shadowColor: colors.black,     // Повністю чорна
      shadowOffset: { width: 0, height: 10 }, // Тінь б'є на всі боки, трохи вгору
      shadowOpacity: 0.45,        // Дуже темна (0.65 з 1.0)
      shadowRadius: 20,           // Сильно розсіяна
      elevation: 20,              // Екстремально високе значення для Android
      // ----------------------------
    },
  ], [cardScale]);

  const animatedSweepStyle = useMemo(() => ({
    ...StyleSheet.absoluteFillObject,
    width: SHEET_WIDTH * 0.55,
    opacity: contentFlashOpacity,
    transform: [{
      translateX: sweepProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [-SHEET_WIDTH * 0.6, SHEET_WIDTH * 1.05],
      }),
    }, { rotate: '12deg' }],
  }), [contentFlashOpacity, sweepProgress]);

  const animatedRingStyle = useMemo(() => [
    localStyles.animatedRing,
    {
      opacity: successRingOpacity,
      transform: [{ scale: successRingScale }]
    }
  ], [successRingOpacity, successRingScale]);

  const animatedSecondRingStyle = useMemo(() => [
    localStyles.animatedRing,
    localStyles.animatedRingThin,
    {
      opacity: secondRingOpacity,
      transform: [{ scale: secondRingScale }]
    }
  ], [secondRingOpacity, secondRingScale]);

  const animatedButtonStyle = useMemo(() => ({
    transform: [{ scale: buttonScale }]
  }), [buttonScale]);

  const animatedFillStyle = useMemo(() => [
    localStyles.buttonFill,
    { opacity: successFill },
  ], [successFill]);

  const animatedCheckmarkStyle = useMemo(() => ({
    transform: [
      { scale: checkmarkScale },
      {
        rotate: checkmarkTilt.interpolate({
          inputRange: [0, 1],
          outputRange: ['-28deg', '0deg'],
        }),
      },
    ],
  }), [checkmarkScale, checkmarkTilt]);

  return {
    animatedCardStyle,
    animatedSweepStyle,
    animatedRingStyle,
    animatedSecondRingStyle,
    animatedButtonStyle,
    animatedFillStyle,
    animatedCheckmarkStyle,
  };
}
