import React, { useState, useCallback, useEffect } from 'react';
import { Dimensions } from 'react-native';

const { width } = Dimensions.get('window');
const INITIAL_FONT_SIZE = width * 0.09;
const MAX_ALLOWED_WIDTH = width * 0.32;

export const useDynamicTitleSize = (titleText: string) => {
  const [fontSize, setFontSize] = useState(INITIAL_FONT_SIZE);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setFontSize(INITIAL_FONT_SIZE);
    setIsReady(false);
  }, [titleText]);

  const handleLayout = useCallback((event: any) => {
    if (isReady) return;

    const { width: textWidth } = event.nativeEvent.layout;

    if (textWidth > MAX_ALLOWED_WIDTH) {
      const ratio = textWidth / MAX_ALLOWED_WIDTH;
      setFontSize((INITIAL_FONT_SIZE / ratio) * 0.88);
    }
    
    setIsReady(true);
  }, [isReady]);

  return { fontSize, isReady, handleLayout };
};