import React, { useRef, useEffect, useCallback } from 'react';
import {
  PanResponder,
  Pressable,
  View,
  Animated,
  Easing,
  ScrollView,
  Image,
} from 'react-native';
import { styles, localStyles } from './BookmarksMenu.styles';

const SWIPE_ANIM_MS = 180;

// Ширина кнопки "Видалити", що виїжджає при свайпі вліво.
const DELETE_PANEL_WIDTH = 70;

// Поріг, після якого рух пальця розпізнається як горизонтальний свайп.
const SWIPE_START_THRESHOLD = 10;

interface SwipeableBookmarkRowProps {
  onPress: () => void;
  /** Якщо не передано — свайп для видалення вимкнено. */
  onDelete?: () => void;
  onSwipeStart: () => void;
  onSwipeEnd: () => void;
  children: React.ReactNode;
}

export const SwipeableBookmarkRow: React.FC<SwipeableBookmarkRowProps> = ({
  onPress,
  onDelete,
  onSwipeStart,
  onSwipeEnd,
  children,
}) => {
  const translateX = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const settledOffset = useRef(0);
  const isSwipingRef = useRef(false);
  const deletingRef = useRef(false);

  const canDelete = !!onDelete;

  // PanResponder створюється один раз, тому актуальні значення пропсів
  // читаємо через ref-и (інакше в обробниках лишались би застарілі замикання).
  const canDeleteRef = useRef(canDelete);
  const onSwipeStartRef = useRef(onSwipeStart);
  const onSwipeEndRef = useRef(onSwipeEnd);
  useEffect(() => {
    canDeleteRef.current = canDelete;
    onSwipeStartRef.current = onSwipeStart;
    onSwipeEndRef.current = onSwipeEnd;
  });

  // Якщо видалення стало недоступним — закриваємо панель.
  useEffect(() => {
    if (!canDelete) {
      translateX.setValue(0);
      settledOffset.current = 0;
    }
  }, [canDelete, translateX]);

  // Якщо рядок зник посеред свайпу — обов'язково розблоковуємо скрол списку.
  useEffect(() => {
    return () => {
      if (isSwipingRef.current) {
        isSwipingRef.current = false;
        onSwipeEndRef.current();
      }
    };
  }, []);

  const settleTo = useCallback(
    (value: number) => {
      settledOffset.current = value;
      Animated.timing(translateX, {
        toValue: value,
        duration: SWIPE_ANIM_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [translateX],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        if (!canDeleteRef.current || deletingRef.current) return false;
        return (
          Math.abs(gestureState.dx) > SWIPE_START_THRESHOLD &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.8
        );
      },
      // Не віддаємо жест ScrollView посеред свайпу.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isSwipingRef.current = true;
        onSwipeStartRef.current();
      },
      onPanResponderMove: (_, gestureState) => {
        const next = Math.min(
          0,
          Math.max(settledOffset.current + gestureState.dx, -DELETE_PANEL_WIDTH),
        );
        translateX.setValue(next);
      },
      onPanResponderRelease: (_, gestureState) => finishSwipe(gestureState.dx),
      onPanResponderTerminate: (_, gestureState) => finishSwipe(gestureState.dx),
    }),
  ).current;

  function finishSwipe(dx: number) {
    const projected = settledOffset.current + dx;
    settleTo(projected < -DELETE_PANEL_WIDTH / 2 ? -DELETE_PANEL_WIDTH : 0);
    if (isSwipingRef.current) {
      isSwipingRef.current = false;
      onSwipeEndRef.current();
    }
  }

  const handleRowPress = () => {
    if (deletingRef.current) return;
    // Тап по відкритому рядку лише закриває панель видалення.
    if (settledOffset.current !== 0) {
      settleTo(0);
      return;
    }
    onPress();
  };

  const handleDeletePress = useCallback(() => {
    // Гвард від подвійного тапу: інакше onDelete викликався б двічі.
    if (deletingRef.current) return;
    deletingRef.current = true;

    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => {
      // Батько прибирає рядок зі списку, тож назад його не проявляємо
      // (раніше це давало коротке «блимання» видаленого рядка).
      onDelete?.();
    });
  }, [fadeAnim, onDelete]);

  const deletePanelOpacity = translateX.interpolate({
    inputRange: [-DELETE_PANEL_WIDTH, -DELETE_PANEL_WIDTH * 0.4, 0],
    outputRange: [1, 0, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={localStyles.swipeRowWrapper}>
      <Animated.View style={{ opacity: fadeAnim }}>
        {canDelete && (
          <Animated.View
            style={[
              localStyles.swipeDeleteBackground,
              { width: DELETE_PANEL_WIDTH, opacity: deletePanelOpacity },
            ]}
          >
            <Pressable
              onPress={handleDeletePress}
              style={({ pressed }) => [
                localStyles.swipeDeleteButton,
                pressed && localStyles.swipeDeleteButtonPressed,
              ]}
            >
              <Image
                source={require('../../../../assets/images/icons/delete_2.png')}
                style={localStyles.swipeDeleteIcon}
                resizeMode="contain"
              />
            </Pressable>
          </Animated.View>
        )}

        <Animated.View
          {...panResponder.panHandlers}
          style={{ transform: [{ translateX }] }}
        >
          <Pressable
            onPress={handleRowPress}
            style={({ pressed }) => [
              styles.rowContent,
              pressed && localStyles.rowContentPressedBg,
            ]}
          >
            {children}
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
};
