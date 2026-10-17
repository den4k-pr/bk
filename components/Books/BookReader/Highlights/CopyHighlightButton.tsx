import { colors } from '../../../../styles/theme';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { Copy } from 'lucide-react-native';

const BUTTON_SIZE = 30;
const COPIED_DISPLAY_MS = 1100;

interface CopyHighlightButtonProps {
  /** Викликається лише в момент натискання — завжди повертає АКТУАЛЬНИЙ виділений текст. */
  getTextToCopy: () => string | null | undefined;
}

export const CopyHighlightButton: React.FC<CopyHighlightButtonProps> = ({ getTextToCopy }) => {
  const [isCopied, setIsCopied] = useState(false);
  const iconScale = useRef(new Animated.Value(1)).current;
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback((): void => {
    let text: string | null | undefined;
    try {
      text = getTextToCopy?.();
    } catch (error) {
      console.warn('[CopyHighlightButton] getTextToCopy кинув виняток:', error);
      return;
    }

    if (!text) return;

    try {
      if (Clipboard && typeof Clipboard.setString === 'function') {
        Clipboard.setString(text);
      } else {
        console.warn('[CopyHighlightButton] Clipboard-модуль недоступний — копіювання пропущено.');
        return;
      }
    } catch (error) {
      console.warn('[CopyHighlightButton] Не вдалося скопіювати текст:', error);
      return;
    }

    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    setIsCopied(true);
    Animated.sequence([
      Animated.spring(iconScale, { toValue: 0.7, useNativeDriver: true, speed: 30, bounciness: 0 }),
      Animated.spring(iconScale, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 10 }),
    ]).start();

    revertTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) setIsCopied(false);
    }, COPIED_DISPLAY_MS);
  }, [getTextToCopy, iconScale]);

  return (
    <Pressable
      onPress={handleCopy}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      accessibilityRole="button"
      accessibilityLabel="Копіювати виділений текст"
    >
      <Animated.View style={{ transform: [{ scale: iconScale }] }}>
        {isCopied ? (
          <Animated.Text style={styles.checkGlyph}>✓</Animated.Text>
        ) : (
          <Copy size={18} color={colors.white} strokeWidth={2.1} />
        )}
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: 8,
    backgroundColor: '#3a3a3a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: {
    opacity: 0.6,
  },
  checkGlyph: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 18,
  },
});