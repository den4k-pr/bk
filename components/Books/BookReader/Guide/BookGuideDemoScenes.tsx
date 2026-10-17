import { colors } from '../../../../styles/theme';
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, StyleSheet, Image } from 'react-native';
import { stylesReader } from '../BookReader.styles';
import { styles } from '../Translation/TranslationBottomSheet.styles';
import { HIGHLIGHT_COLORS } from '../BookReader.constants';

// 🟢 Демо-сцени НЕ вигадують власний дизайн — переклад-панель зібрана
// буквально з тих самих стилів, що й реальний TranslationBottomSheet, а
// текст слова — зі стилю stylesReader.bodyText і реального вигляду
// виділеного слова з WordChunk. Палітра кольорів маркування — точна
// копія меню з BookReaderScreen.tsx.

const DEMO_PARAGRAPH = [
  'The ', 'old ', 'lighthouse ', 'stood ', 'silently ', 'against ', 'the ', 'stormy ', 'sky ',
  'above ', 'the ', 'harbor', '. ',
  'Sailors ', 'always ', 'trusted ', 'its ', 'steady ', 'light ', 'to ', 'guide ', 'them ', 'safely ', 'home', '.',
];
const TAP_WORD_INDEX = 2; // 'lighthouse'
const DRAG_RANGE = { start: 7, end: 9 }; // 'stormy sky above'

// 🟢 Циклічні анімації повернуто — сцена безкінечно імітує: тап по
// слову -> показ перекладу -> пауза -> зникнення -> знову тап (і так
// само для виділення фрази -> палітра кольорів -> зникнення -> знову).
// Компонент грає, поки він реально змонтований — коли гайд переходить
// на інший крок, BookReaderGuidedTour розмонтовує цю картку, і цикл
// сам зупиняється (cleanup у useEffect чистить усі таймери).
const CYCLE_DELAY_MS = 900;
const CYCLE_HOLD_MS = 1600;
const CYCLE_RESET_MS = 400;
const DEMO_FONT_SIZE = 18;

export interface DemoSceneOnMeasure {
  onMeasure?: (width: number, height: number) => void;
}

export const TranslationDemoScene: React.FC<DemoSceneOnMeasure> = ({ onMeasure }) => {
  const [isTapped, setIsTapped] = useState(false);
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    let isMounted = true;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const runCycle = () => {
      if (!isMounted) return;

      setIsTapped(false);
      cardOpacity.setValue(0);
      cardScale.setValue(0.92);

      timers.push(
        setTimeout(() => {
          if (!isMounted) return;
          setIsTapped(true);
          Animated.parallel([
            Animated.timing(cardOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
            Animated.spring(cardScale, { toValue: 1, friction: 6, tension: 60, useNativeDriver: true }),
          ]).start();
        }, CYCLE_DELAY_MS),
      );

      timers.push(
        setTimeout(() => {
          if (!isMounted) return;
          Animated.timing(cardOpacity, { toValue: 0, duration: CYCLE_RESET_MS, useNativeDriver: true }).start(() => {
            if (isMounted) runCycle();
          });
        }, CYCLE_DELAY_MS + CYCLE_HOLD_MS),
      );
    };

    runCycle();

    return () => {
      isMounted = false;
      timers.forEach(clearTimeout);
    };
  }, [cardOpacity, cardScale]);

  return (
    <View
      style={demoStyles.wrap}
      onLayout={(e) => onMeasure?.(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
    >
      <Text style={[stylesReader.bodyText, demoStyles.paragraphText]}>
        {DEMO_PARAGRAPH.map((word, idx) =>
          idx === TAP_WORD_INDEX ? (
            <Text
              key={idx}
              style={[
                stylesReader.bodyText,
                demoStyles.paragraphText,
                isTapped && demoStyles.tappedWord,
              ]}
            >
              {word}
            </Text>
          ) : (
            <Text key={idx} style={[stylesReader.bodyText, demoStyles.paragraphText]}>
              {word}
            </Text>
          ),
        )}
      </Text>

      <Animated.View
        style={[demoStyles.sheetPreview, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}
      >
        <View style={[styles.sheetTopSection, demoStyles.sheetTopSectionCompact]}>
          <View style={[styles.wordHeaderRow, demoStyles.wordHeaderRowCompact]}>
            <View style={[styles.audioButtonOnly, demoStyles.audioButtonCompact]}>
              <Image
                source={require('../../../../../assets/images/icons/volume.png')}
                style={styles.audioIconCard}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.sheetWordText}>Lighthouse</Text>
          </View>
          <Text style={styles.transcriptionText}>/лайтхаус/</Text>
        </View>

        <View style={[styles.sheetBottomSection, demoStyles.sheetBottomSectionCompact]}>
          <Text style={styles.translationText}>маяк</Text>
        </View>
      </Animated.View>
    </View>
  );
};

export const HighlightDemoScene: React.FC<DemoSceneOnMeasure> = ({ onMeasure }) => {
  const [dragProgress, setDragProgress] = useState(0);
  const paletteOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let isMounted = true;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const runCycle = () => {
      if (!isMounted) return;

      setDragProgress(0);
      paletteOpacity.setValue(0);

      const wordsToSelect = DRAG_RANGE.end - DRAG_RANGE.start + 1;
      for (let i = 1; i <= wordsToSelect; i++) {
        timers.push(
          setTimeout(() => {
            if (isMounted) setDragProgress(i);
          }, CYCLE_DELAY_MS + i * 200),
        );
      }

      timers.push(
        setTimeout(() => {
          if (!isMounted) return;
          Animated.timing(paletteOpacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
        }, CYCLE_DELAY_MS + wordsToSelect * 200 + 150),
      );

      timers.push(
        setTimeout(() => {
          if (!isMounted) return;
          Animated.timing(paletteOpacity, { toValue: 0, duration: CYCLE_RESET_MS, useNativeDriver: true }).start(() => {
            if (isMounted) runCycle();
          });
        }, CYCLE_DELAY_MS + wordsToSelect * 200 + 150 + CYCLE_HOLD_MS),
      );
    };

    runCycle();

    return () => {
      isMounted = false;
      timers.forEach(clearTimeout);
    };
  }, [paletteOpacity]);

  return (
    <View
      style={demoStyles.wrap}
      onLayout={(e) => onMeasure?.(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
    >
      <Text style={[stylesReader.bodyText, demoStyles.paragraphText]}>
        {DEMO_PARAGRAPH.map((word, idx) => {
          const isInRange = idx >= DRAG_RANGE.start && idx < DRAG_RANGE.start + dragProgress;
          return (
            <Text
              key={idx}
              style={[
                stylesReader.bodyText,
                demoStyles.paragraphText,
                isInRange && demoStyles.draggedWord,
              ]}
            >
              {word}
            </Text>
          );
        })}
      </Text>

      <Animated.View style={[demoStyles.paletteMenu, { opacity: paletteOpacity }]}>
        {HIGHLIGHT_COLORS.map((color: any) => (
          <View key={color} style={[demoStyles.paletteDot, { backgroundColor: color }]} />
        ))}
      </Animated.View>
    </View>
  );
};

const demoStyles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
  },
  paragraphText: {
    fontSize: DEMO_FONT_SIZE,
    lineHeight: DEMO_FONT_SIZE * 1.5,
    textAlign: 'center',
  },
  tappedWord: {
    backgroundColor: '#dff5cf89',
    borderColor: '#10b981',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 3,
  },
  draggedWord: {
    backgroundColor: '#EDEFD9',
  },
  sheetPreview: {
    marginTop: 14,
    width: '100%',
  },
  sheetTopSectionCompact: {
    paddingTop: 10,
    paddingBottom: 6,
  },
  wordHeaderRowCompact: {
    paddingBottom: 2,
  },
  audioButtonCompact: {
    position: 'relative',
    left: 0,
    bottom: 0,
    marginRight: 6,
  },
  sheetBottomSectionCompact: {
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  paletteMenu: {
    flexDirection: 'row',
    backgroundColor: '#242424',
    padding: 8,
    borderRadius: 8,
    gap: 12,
    marginTop: 14,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
  paletteDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.white,
  },
});
