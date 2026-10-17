import { colors } from '../../../../styles/theme';
import React from 'react';
import { Animated, GestureResponderHandlers, StyleSheet, View } from 'react-native';

interface ReaderProgressBarProps {
  barRef: React.RefObject<View | null>;
  onLayout: () => void;
  panHandlers: GestureResponderHandlers;
  scrollProgressAnim: Animated.Value;
  scrubActiveAnim: Animated.Value;
}

export const ReaderProgressBar: React.FC<ReaderProgressBarProps> = ({
  barRef,
  onLayout,
  panHandlers,
  scrollProgressAnim,
  scrubActiveAnim,
}) => {
  return (
    <View
      ref={barRef}
      onLayout={onLayout}
      style={localStyles.progressHitArea}
      {...panHandlers}
    >
      <Animated.View
        style={[
          localStyles.progressTrack,
          {
            height: scrubActiveAnim.interpolate({ inputRange: [0, 1], outputRange: [4, 7] }),
            transform: [
              { scaleY: scrubActiveAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) },
            ],
          },
        ]}
      >
        <Animated.View
          style={[
            localStyles.progressFill,
            {
              width: scrollProgressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />

        <Animated.View
          pointerEvents="none"
          style={[
            localStyles.progressKnob,
            {
              left: scrollProgressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
              opacity: scrubActiveAnim,
              transform: [
                { translateX: -6 },
                { scale: scrubActiveAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
              ],
            },
          ]}
        />
      </Animated.View>
    </View>
  );
};

const localStyles = StyleSheet.create({
  progressHitArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 28,
    justifyContent: 'flex-end',
    zIndex: 15,
  },
  progressTrack: {
    backgroundColor: 'rgba(20,33,28,0.06)',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    overflow: 'visible',
    justifyContent: 'center',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#F99511',
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  progressKnob: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#F99511',
    borderWidth: 2,
    borderColor: colors.white,
  },
});
