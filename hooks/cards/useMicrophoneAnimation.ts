import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

export const useMicrophoneAnimations = (isListening: boolean, isProcessing: boolean) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const handOpacity = useRef(new Animated.Value(0)).current;
  const handScale = useRef(new Animated.Value(1)).current;
  const firstInteraction = useRef(false);
  const inactivityTimer = useRef<any>(null);

  useEffect(() => {
    if (isListening) {
      animationRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.2,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ]),
      );
      animationRef.current.start();
    } else {
      if (animationRef.current) {
        animationRef.current.stop();
        animationRef.current = null;
      }
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [isListening, scaleAnim]);

  useEffect(() => {
    if (isListening || isProcessing) {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      Animated.timing(handOpacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
    } else {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => {
        if (!firstInteraction.current) {
          Animated.sequence([
            Animated.timing(handOpacity, {
              toValue: 1,
              duration: 600,
              useNativeDriver: true,
            }),
            Animated.loop(
              Animated.sequence([
                Animated.timing(handScale, {
                  toValue: 0.95,
                  duration: 300,
                  useNativeDriver: true,
                }),
                Animated.timing(handScale, {
                  toValue: 1,
                  duration: 300,
                  useNativeDriver: true,
                }),
              ]),
            ),
          ]).start();
        }
      }, 5000);
    }
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [isListening, isProcessing]);

  const stopHandAnimation = () => {
    firstInteraction.current = true;
    Animated.timing(handOpacity, {
      toValue: 0,
      duration: 400,
      useNativeDriver: true,
    }).start();
  };

  return {
    scaleAnim,
    handOpacity,
    handScale,
    stopHandAnimation
  };
};