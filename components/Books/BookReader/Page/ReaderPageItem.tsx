import { isProperNameAt, learnNamesFromChunks } from '../Phrases/properNameDetection';
import { isStandaloneArticleAt } from '../Phrases/articleDetection';
import { findManualPhraseAt, findPhraseMatchWithOverrides } from '../Phrases/phraseOverrides';
import React, {
  useMemo,
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
} from 'react';
import {
  View,
  ScrollView,
  PanResponder,
  TouchableWithoutFeedback,
  Animated,
  Easing,
  DeviceEventEmitter,
} from 'react-native';
import { ExtendedSelectedPhrase } from '../../../../types/BookReader.internal.types';
import { BackHighlight } from '../../../../types/books';
import { stylesReader } from '../BookReader.styles';
import { ChapterTitle } from '../../../../widgets/ChapterTitle';
import { SCREEN_WIDTH } from '../BookReader.constants';
import {
  CONTAINER_PADDING_LEFT,
  CONTAINER_PADDING_TOP,
  DEFAULT_VIEWPORT_HEIGHT_GUESS,
  PARAGRAPH_WINDOW_BUFFER_MULTIPLIER,
} from './page.constants';
import {
  CalibrationEntry,
  addCalibrationSample,
  commitCalibrationSample,
  computeRawEstimateHeight,
  getSeedCalibration,
} from './heightCalibration';
import { lowerBoundBlockEnd, upperBoundBlockStart } from './paragraphWindow.utils';
import { PageHeaderImage } from './PageHeaderImage';
import {
  BlockLayout,
  ParagraphBlock,
  ReaderPageItemHandle,
  ReaderPageItemProps,
  WordLayout,
} from './page.types';
import {
  buildHighlightColorMap,
  computeSelectionRanges,
  parseBoldIndices,
  splitIntoParagraphBlocks,
} from './pageText.utils';
import { ParagraphBlockRenderer } from './ParagraphBlockRenderer';

const SCROLL_CLOSE_THRESHOLD = 14;
// Скільки часу після програмного автоскролу (тап по слову внизу екрана)
// handleScroll не має закривати щойно відкритий вибір слова. Покриває всю
// анімацію scrollTo, навіть якщо вона переривається ре-лейаутом і
// onMomentumScrollEnd спрацьовує раніше, ніж скрол реально зупинився.
const PROGRAMMATIC_SCROLL_GRACE_MS = 800;
// Відступ між низом натиснутого слова і верхом панелі перекладу.
export const REVEAL_MARGIN = 16;
// Автоскрол лише для слів у нижніх 40% екрана (низ слова нижче 60% висоти).
export const REVEAL_ZONE_START = 0.6;
// І лише трохи: слово піднімається не вище 55% висоти екрана.
export const REVEAL_MAX_LIFT_TO = 0.55;
// Скільки триває плавне прибирання запасу внизу сторінки після закриття панелі.
const EXTRA_SPACE_RELEASE_MS = 350;


export type { ReaderPageItemHandle } from './page.types';

export const ReaderPageItem = React.memo(
  React.forwardRef<ReaderPageItemHandle, ReaderPageItemProps>(
    (
      {
        item,
        width,
        fontSize,
        selectedPhrase,
        pageHighlights,
        isContentLoading,
        initialScrollProgress,
        onWordPress,
        onWordLongPress,
        onSentenceSelect,
        onSelectionModeChange,
        onScrollBeginDrag,
        onEmptyPress,
        onScrollProgress,
        onHighlightedWordPress,
      },
      ref,
    ) => {
      const pageWidth = width > 0 ? width : SCREEN_WIDTH;

      const parsedBoldIndices = useMemo(() => parseBoldIndices(item.boldIndices), [item.boldIndices]);

      const boldSet = useMemo(() => new Set(parsedBoldIndices), [parsedBoldIndices]);

      const highlightColorByIndex = useMemo(() => buildHighlightColorMap(pageHighlights), [pageHighlights]);

      const pageHighlightsRef = useRef<BackHighlight[]>(pageHighlights);
      useEffect(() => {
        pageHighlightsRef.current = pageHighlights;
      }, [pageHighlights]);

      const [localSelectedPhrase, setLocalSelectedPhrase] =
        useState<ExtendedSelectedPhrase | null>(selectedPhrase);

      useEffect(() => {
        setLocalSelectedPhrase(selectedPhrase);
      }, [selectedPhrase]);

      const localSelectedPhraseRef = useRef(localSelectedPhrase);
      localSelectedPhraseRef.current = localSelectedPhrase;

      const [draggedRange, setDraggedRange] = useState<{ start: number; end: number } | null>(null);
      const draggedRangeRef = useRef<{ start: number; end: number } | null>(null);

      useEffect(() => {
        const subscription = DeviceEventEmitter.addListener('CLEAR_HIGHLIGHT_INSTANTLY', () => {
          setLocalSelectedPhrase(null);
          setDraggedRange(null);
          draggedRangeRef.current = null;
        });
        return () => subscription.remove();
      }, []);

      const latestProps = useRef({
        selectedPhrase,
        onWordPress,
        onWordLongPress,
        onSentenceSelect,
        onEmptyPress,
        onSelectionModeChange,
        onScrollProgress,
        onHighlightedWordPress,
      });

      // PanResponder нижче створюється ОДИН раз — сторінку (текст, назву
      // книжки, ручну розмітку фраз) він має брати звідси, а не з замикання:
      // при першому показі item — ще "скелет" без тексту й розмітки.
      const itemRef = useRef(item);
      itemRef.current = item;

      latestProps.current = {
        selectedPhrase,
        onWordPress,
        onWordLongPress,
        onSentenceSelect,
        onEmptyPress,
        onSelectionModeChange,
        onScrollProgress,
        onHighlightedWordPress,
      };

      const textChunks: string[] = useMemo(
        () => (item.content || '').split(/(\s+)/),
        [item.content],
      );
      const textChunksRef = useRef<string[]>([]);
      useEffect(() => {
        textChunksRef.current = textChunks;
        // Сусідні сторінки рендеряться наперед — імена з них теж запам'ятовуємо.
        learnNamesFromChunks(textChunks, item.bookTitle ?? '');
      }, [textChunks, item.bookTitle]);

      const paragraphBlocks: ParagraphBlock[] = useMemo(() => splitIntoParagraphBlocks(textChunks), [textChunks]);

      const chunkSlicesByBlock: string[][] = useMemo(() => {
        return paragraphBlocks.map((block) => textChunks.slice(block.startIdx, block.endIdx + 1));
      }, [paragraphBlocks, textChunks]);

      const chunkSlicesByBlockRef = useRef<string[][]>(chunkSlicesByBlock);
      useEffect(() => {
        chunkSlicesByBlockRef.current = chunkSlicesByBlock;
      }, [chunkSlicesByBlock]);

      const fontSizeRef = useRef(fontSize);
      useEffect(() => {
        fontSizeRef.current = fontSize;
      }, [fontSize]);

      const pageWidthRef = useRef(pageWidth);
      useEffect(() => {
        pageWidthRef.current = pageWidth;
      }, [pageWidth]);

      const containerRef = useRef<View>(null);

      const wordsLayouts = useRef<Record<number, WordLayout>>({});
      const wordsByBlock = useRef<Record<number, number[]>>({});
      const blockLayouts = useRef<Record<number, BlockLayout>>({});

      const measuredHeights = useRef<Record<number, number>>({});
      const [measurementVersion, setMeasurementVersion] = useState<number>(0);
      const pendingMeasureFlushRef = useRef<boolean>(false);
      const heightCalibrationRef = useRef<CalibrationEntry>(getSeedCalibration(fontSize));

      // Координати слів приходять лише з onLayout, а він спрацьовує тільки
      // коли рамка елемента справді змінилась. Тому разом зі стиранням таблиць
      // абзаци монтуються заново (новий key) — інакше таблиці могли лишитись
      // порожніми, і текст переставав реагувати на дотики.
      const layoutEpochRef = useRef(0);
      useMemo(() => {
        wordsLayouts.current = {};
        wordsByBlock.current = {};
        blockLayouts.current = {};
        measuredHeights.current = {};
        heightCalibrationRef.current = getSeedCalibration(fontSize);
        layoutEpochRef.current += 1;
      }, [textChunks, fontSize, pageWidth]);
      const layoutEpoch = layoutEpochRef.current;

      const [localSelectionMode, setLocalSelectionMode] = useState<boolean>(false);

      const scrollViewLayoutHeight = useRef<number>(0);
      const hasRestoredScrollRef = useRef<boolean>(false);
      const scrollViewRef = useRef<ScrollView>(null);
      const longPressTimeout = useRef<any>(null);
      const releaseTimeout = useRef<any>(null);
      const startTouchPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
      const isLongPressed = useRef<boolean>(false);
      const initialWordIdx = useRef<number>(-1);
      const lastFoundIndex = useRef<number>(-1);
      const isMountedRef = useRef(true);

      const measuredContentHeightRef = useRef<number>(0);

      useEffect(() => {
        hasRestoredScrollRef.current = false;
      }, [item.id]);

      useEffect(() => {
        isMountedRef.current = true;
        return () => {
          isMountedRef.current = false;
          if (longPressTimeout.current) clearTimeout(longPressTimeout.current);
          if (releaseTimeout.current) clearTimeout(releaseTimeout.current);
        };
      }, []);

      const contentOpacity = useRef(new Animated.Value(0)).current;
      const contentTranslateY = useRef(new Animated.Value(10)).current;

      useEffect(() => {
        if (!isContentLoading && item.content) {
          Animated.parallel([
            Animated.timing(contentOpacity, {
              toValue: 1,
              duration: 320,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(contentTranslateY, {
              toValue: 0,
              duration: 320,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
          ]).start();
        } else {
          contentOpacity.setValue(0);
          contentTranslateY.setValue(10);
        }
      }, [isContentLoading, item.content, contentOpacity, contentTranslateY]);

      const lastScrollY = useRef(0);
      const hasClosedForGesture = useRef(false);

      const estimateBlockHeight = useCallback(
        (chunks: string[]): number => {
          const raw = computeRawEstimateHeight(chunks, fontSize, pageWidth);
          const calib = heightCalibrationRef.current;
          const factor = calib.count > 0 ? calib.sumRatio / calib.count : 1;
          return raw * factor;
        },
        [fontSize, pageWidth],
      );

      const getBlockHeight = useCallback(
        (blockIndex: number): number => {
          const measured = measuredHeights.current[blockIndex];
          if (measured !== undefined) return measured;
          const chunks = chunkSlicesByBlock[blockIndex];
          if (!chunks) return 0;
          return estimateBlockHeight(chunks);
        },
        [chunkSlicesByBlock, estimateBlockHeight],
      );

      const recordBlockLayout = useCallback((blockIndex: number, y: number, height: number) => {
        blockLayouts.current[blockIndex] = { y, height };

        const chunks = chunkSlicesByBlockRef.current[blockIndex];
        if (chunks && height > 0) {
          const raw = computeRawEstimateHeight(chunks, fontSizeRef.current, pageWidthRef.current);
          if (raw > 0) {
            const ratio = height / raw;
            if (Number.isFinite(ratio) && ratio > 0 && ratio < 10) {
              // 🔴 ФІКС "самовільного" повзучого скролу без активності
              // користувача: раніше тут ЖИВИЙ heightCalibrationRef цього
              // інстансу сторінки теж мутувався на кожен щойно виміряний
              // абзац (addCalibrationSample(heightCalibrationRef.current, ...)).
              // Через це коефіцієнт оцінки висоти ще НЕ виміряних абзаців
              // ВИЩЕ поточної позиції скролу (spacer-блоків) тихо змінювався
              // щоразу, коли сусідній абзац у буфері монтувався і мірявся —
              // а ScrollView тримає абсолютний offset, тож зміна висоти
              // контенту НАД видимою областю зсуває те, що фізично видно,
              // без жодного реального скролу користувача. Тепер локальний
              // коефіцієнт ЦЬОГО інстансу лишається зафіксованим на
              // значенні, з яким сторінка змонтувалась (з preloadHeightCalibration),
              // і ніколи не змінюється "наживо" — лише глобальний кеш
              // (рядок нижче) продовжує накопичуватись для майбутніх
              // відкриттів сторінок.
              commitCalibrationSample(fontSizeRef.current, ratio);
            }
          }
        }

        const prev = measuredHeights.current[blockIndex];
        if (prev === undefined || Math.abs(prev - height) >= 1) {
          measuredHeights.current[blockIndex] = height;
          if (!pendingMeasureFlushRef.current) {
            pendingMeasureFlushRef.current = true;
            requestAnimationFrame(() => {
              pendingMeasureFlushRef.current = false;
              if (isMountedRef.current) {
                setMeasurementVersion((v) => v + 1);
              }
            });
          }
        }
      }, []);

      const cumulativeOffsets = useMemo(() => {
        const offsets: number[] = new Array(paragraphBlocks.length + 1);
        offsets[0] = 0;
        for (let i = 0; i < paragraphBlocks.length; i++) {
          offsets[i + 1] = offsets[i] + getBlockHeight(i);
        }
        return offsets;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [paragraphBlocks, getBlockHeight, measurementVersion]);

      const computeVisibleRange = useCallback(
        (scrollTop: number, viewportHeight: number): { start: number; end: number } => {
          const n = paragraphBlocks.length;
          if (n === 0) return { start: 0, end: 0 };

          const viewport = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT_GUESS;
          const buffer = viewport * PARAGRAPH_WINDOW_BUFFER_MULTIPLIER;
          const rangeTop = Math.max(0, scrollTop - buffer);
          const rangeBottom = scrollTop + viewport + buffer;

          const startBlock = lowerBoundBlockEnd(cumulativeOffsets, rangeTop, n);
          let endBlock = upperBoundBlockStart(cumulativeOffsets, rangeBottom, n);

          if (endBlock < startBlock) endBlock = startBlock;
          return { start: startBlock, end: endBlock };
        },
        [paragraphBlocks, cumulativeOffsets],
      );

      const [visibleParagraphRange, setVisibleParagraphRange] = useState<{
        start: number;
        end: number;
      }>({ start: 0, end: 0 });
      const prevMountedRangeRef = useRef<{ start: number; end: number }>({ start: -1, end: -1 });

      useEffect(() => {
        if (paragraphBlocks.length > 0) {
          const viewport =
            scrollViewLayoutHeight.current > 0
              ? scrollViewLayoutHeight.current
              : DEFAULT_VIEWPORT_HEIGHT_GUESS;
          const nextRange = computeVisibleRange(lastScrollY.current, viewport);
          setVisibleParagraphRange((prev) => {
            if (prev.start === nextRange.start && prev.end === nextRange.end) return prev;
            return nextRange;
          });
        }
      }, [paragraphBlocks, cumulativeOffsets, computeVisibleRange]);

      useEffect(() => {
        const prev = prevMountedRangeRef.current;
        const removeBlockRange = (fromBlock: number, toBlock: number) => {
          for (let b = fromBlock; b <= toBlock; b++) {
            const block = paragraphBlocks[b];
            if (!block) continue;
            for (let i = block.startIdx; i <= block.endIdx; i++) {
              delete wordsLayouts.current[i];
            }
            delete wordsByBlock.current[b];
            delete blockLayouts.current[b];
          }
        };
        if (prev.start !== -1) {
          if (visibleParagraphRange.start > prev.start) {
            removeBlockRange(prev.start, visibleParagraphRange.start - 1);
          }
          if (visibleParagraphRange.end < prev.end) {
            removeBlockRange(visibleParagraphRange.end + 1, prev.end);
          }
        }
        prevMountedRangeRef.current = visibleParagraphRange;
      }, [visibleParagraphRange, paragraphBlocks]);

      const lastComputedScrollYRef = useRef(0);
      // Час, до якого програмний скрол (автоскрол при тапі по слову) вважається
      // активним. Поки він активний — handleScroll не закриває вибір слова.
      const programmaticScrollUntilRef = useRef(0);
      const RECOMPUTE_DISTANCE_RATIO = 1;

      const handleScroll = useCallback(
        (e: any) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const y = contentOffset.y as number;
          const maxScroll = Math.max(contentSize.height - layoutMeasurement.height, 1);
          const progress = Math.min(Math.max(y / maxScroll, 0), 1);
          latestProps.current.onScrollProgress?.(item.id, progress);

          const viewport =
            layoutMeasurement.height > 0 ? layoutMeasurement.height : DEFAULT_VIEWPORT_HEIGHT_GUESS;
          const recomputeThreshold = viewport * RECOMPUTE_DISTANCE_RATIO;

          if (Math.abs(y - lastComputedScrollYRef.current) >= recomputeThreshold) {
            lastComputedScrollYRef.current = y;
            const nextRange = computeVisibleRange(y, layoutMeasurement.height);

            setVisibleParagraphRange((prevRange) => {
              if (prevRange.start === nextRange.start && prevRange.end === nextRange.end) {
                return prevRange;
              }
              return nextRange;
            });
          }

          const delta = y - lastScrollY.current;
          lastScrollY.current = y;

          const isProgrammaticGraceActive = Date.now() < programmaticScrollUntilRef.current;

          if (
            Math.abs(delta) > SCROLL_CLOSE_THRESHOLD &&
            !hasClosedForGesture.current &&
            !isProgrammaticGraceActive &&
            (latestProps.current.selectedPhrase || localSelectedPhraseRef.current)
          ) {
            hasClosedForGesture.current = true;
            setLocalSelectedPhrase(null);
            latestProps.current.onEmptyPress();
          }
        },
        [item.id, computeVisibleRange],
      );

      const resetScrollGesture = useCallback(() => {
        hasClosedForGesture.current = false;
      }, []);

      const findWordIndexByCoords = useCallback((localX: number, localY: number): number => {
        const HITBOX_PAD_X = 8;
        const HITBOX_PAD_Y = 12;

        let candidateBlocks: number[] = [];
        let nearestBlockIndex = -1;
        let nearestBlockDistance = Infinity;

        for (const key in blockLayouts.current) {
          const blockIndex = Number(key);
          const layout = blockLayouts.current[blockIndex];
          if (!layout) continue;

          const top = layout.y;
          const bottom = layout.y + layout.height;

          if (localY >= top - HITBOX_PAD_Y && localY <= bottom + HITBOX_PAD_Y) {
            candidateBlocks.push(blockIndex);
          } else {
            const distance = localY < top ? top - localY : localY - bottom;
            if (distance < nearestBlockDistance) {
              nearestBlockDistance = distance;
              nearestBlockIndex = blockIndex;
            }
          }
        }

        if (candidateBlocks.length === 0 && nearestBlockIndex !== -1) {
          candidateBlocks = [nearestBlockIndex];
        }

        let bestMatch = -1;
        let minDistance = Infinity;

        for (const blockIndex of candidateBlocks) {
          const blockLayout = blockLayouts.current[blockIndex];
          const bucket = wordsByBlock.current[blockIndex];
          if (!blockLayout || !bucket) continue;

          for (const wordIndex of bucket) {
            const wordLayout = wordsLayouts.current[wordIndex];
            if (!wordLayout) continue;

            const wordX = wordLayout.x;
            const wordY = blockLayout.y + wordLayout.y;
            const wordRight = wordX + wordLayout.w;
            const wordBottom = wordY + wordLayout.h;

            if (
              localX >= wordX - HITBOX_PAD_X &&
              localX <= wordRight + HITBOX_PAD_X &&
              localY >= wordY - HITBOX_PAD_Y &&
              localY <= wordBottom + HITBOX_PAD_Y
            ) {
              if (localX >= wordX && localX <= wordRight && localY >= wordY && localY <= wordBottom) {
                return wordIndex;
              }
              const distX = Math.max(0, wordX - localX, localX - wordRight);
              const distY = Math.max(0, wordY - localY, localY - wordBottom);
              const distance = distX * distX + distY * distY;

              if (distance < minDistance) {
                minDistance = distance;
                bestMatch = wordIndex;
              }
            }
          }
        }
        return bestMatch;
      }, []);

      const handleWordLayout = useCallback(
        (index: number, x: number, y: number, w: number, h: number, blockIndex: number) => {
          wordsLayouts.current[index] = { x, y, w, h, blockIndex };
          const bucket = wordsByBlock.current[blockIndex];
          if (bucket) {
            bucket.push(index);
          } else {
            wordsByBlock.current[blockIndex] = [index];
          }
        },
        [],
      );

      const panResponder = useRef(
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onShouldBlockNativeResponder: () => false,
          onPanResponderTerminationRequest: () => true,

          onPanResponderGrant: (evt) => {
            if (releaseTimeout.current) clearTimeout(releaseTimeout.current);

            const { locationX, locationY } = evt.nativeEvent;
            startTouchPos.current = { x: locationX, y: locationY };
            isLongPressed.current = false;

            const idx = findWordIndexByCoords(locationX, locationY);
            initialWordIdx.current = idx;
            lastFoundIndex.current = idx;

            longPressTimeout.current = setTimeout(() => {
              if (!isMountedRef.current) return;
              isLongPressed.current = true;
              setLocalSelectionMode(true);
              latestProps.current.onSelectionModeChange(true);

              if (initialWordIdx.current !== -1) {
                const initialRange = {
                  start: initialWordIdx.current,
                  end: initialWordIdx.current,
                };
                draggedRangeRef.current = initialRange;
                setDraggedRange(initialRange);
              }
            }, 400);
          },

          onPanResponderMove: (evt) => {
            const { locationX, locationY } = evt.nativeEvent;

            if (!isLongPressed.current) {
              const dx = Math.abs(locationX - startTouchPos.current.x);
              const dy = Math.abs(locationY - startTouchPos.current.y);
              if (dx > 10 || dy > 10) {
                if (longPressTimeout.current) {
                  clearTimeout(longPressTimeout.current);
                  longPressTimeout.current = null;
                }
              }
              return;
            }

            const currentWordIdx = findWordIndexByCoords(locationX, locationY);

            if (currentWordIdx !== -1 && initialWordIdx.current !== -1) {
              if (currentWordIdx !== lastFoundIndex.current) {
                lastFoundIndex.current = currentWordIdx;
                const start = Math.min(initialWordIdx.current, currentWordIdx);
                const end = Math.max(initialWordIdx.current, currentWordIdx);

                const newRange = { start, end };
                draggedRangeRef.current = newRange;
                setDraggedRange(newRange);
              }
            }
          },

          onPanResponderRelease: (evt) => {
            if (longPressTimeout.current) {
              clearTimeout(longPressTimeout.current);
              longPressTimeout.current = null;
            }
            if (!isMountedRef.current) return;

            const { locationX, locationY, pageX, pageY } = evt.nativeEvent;
            const props = latestProps.current;
            const currentSelected = localSelectedPhraseRef.current || props.selectedPhrase;

            if (currentSelected) {
              setLocalSelectedPhrase(null);
              setLocalSelectionMode(false);
              props.onSelectionModeChange(false);
              draggedRangeRef.current = null;
              setDraggedRange(null);
              isLongPressed.current = false;
              props.onEmptyPress();
              return;
            }

            if (!isLongPressed.current) {
              const clickedIndex = findWordIndexByCoords(locationX, locationY);

              // Ім'я / назва або артикль (a / an / the) сам по собі: тап не
              // відкриває переклад і не підсвічує слово. Якщо таке слово в
              // межах виділення — показуємо меню виділення, як і для будь-якого
              // виділеного слова; інакше — як тап по порожньому.
              const isProperName =
                clickedIndex !== -1 &&
                !findManualPhraseAt(textChunksRef.current, clickedIndex, itemRef.current.phraseOverrides) &&
                isProperNameAt(textChunksRef.current, clickedIndex, itemRef.current.bookTitle ?? '');
              const isLoneArticle =
                clickedIndex !== -1 &&
                isStandaloneArticleAt(textChunksRef.current, clickedIndex, itemRef.current.phraseOverrides);
              if (isProperName || isLoneArticle) {
                const highlightOnName = pageHighlightsRef.current.find(
                  (h) => clickedIndex >= h.startIndex && clickedIndex <= h.endIndex,
                );
                if (highlightOnName) {
                  props.onHighlightedWordPress?.(item.id, highlightOnName, pageX, pageY);
                } else {
                  props.onEmptyPress();
                }
                setLocalSelectionMode(false);
                props.onSelectionModeChange(false);
                draggedRangeRef.current = null;
                setDraggedRange(null);
                isLongPressed.current = false;
                return;
              }

              if (clickedIndex !== -1) {
                // Ручна розмітка сторінки з CRM — поверх бібліотеки фраз.
                const bestMatch = findPhraseMatchWithOverrides(
                  textChunksRef.current,
                  clickedIndex,
                  itemRef.current.phraseOverrides,
                );

                const instantPhrase: ExtendedSelectedPhrase = bestMatch
                  ? {
                      startIdx: bestMatch.exactIndicesToHighlight[0],
                      endIdx:
                        bestMatch.exactIndicesToHighlight[
                          bestMatch.exactIndicesToHighlight.length - 1
                        ],
                      exactIndicesToHighlight: bestMatch.exactIndicesToHighlight,
                      type: 'word',
                      text: bestMatch.baseForm,
                    }
                  : {
                      startIdx: clickedIndex,
                      endIdx: clickedIndex,
                      type: 'word',
                      text: textChunksRef.current[clickedIndex],
                    };

                setLocalSelectedPhrase(instantPhrase);
                props.onWordPress(textChunksRef.current, clickedIndex, pageX, pageY, bestMatch);

                const matchedHighlight = pageHighlightsRef.current.find(
                  (h) => clickedIndex >= h.startIndex && clickedIndex <= h.endIndex,
                );
                if (matchedHighlight) {
                  props.onHighlightedWordPress?.(item.id, matchedHighlight, pageX, pageY);
                }
              } else {
                props.onEmptyPress();
              }

              setLocalSelectionMode(false);
              props.onSelectionModeChange(false);
              draggedRangeRef.current = null;
              setDraggedRange(null);
              isLongPressed.current = false;
            } else {
              if (draggedRangeRef.current) {
                const { start, end } = draggedRangeRef.current;
                if (start === end) {
                  setLocalSelectedPhrase({
                    type: 'sentence',
                    startIdx: start,
                    endIdx: end,
                    text: '',
                  });
                  props.onWordLongPress(textChunksRef.current, start, pageX, pageY);
                } else {
                  const selectedText = textChunksRef.current
                    .slice(start, end + 1)
                    .map((c) => c.trim())
                    .filter(Boolean)
                    .join(' ');

                  if (selectedText) {
                    setLocalSelectedPhrase({
                      type: 'sentence',
                      startIdx: start,
                      endIdx: end,
                      text: selectedText,
                    });

                    // Меню має ставати НАД верхнім рядком виділення, а не на
                    // місці пальця (release point), яке при виділенні кількох
                    // рядків опиняється посередині/внизу вибору й перекриває
                    // верхній рядок. Обчислюємо верх діапазону з розкладок слів
                    // і ВИМІРЮЄМО реальну позицію текстового контейнера у вікні,
                    // щоб позиція меню взагалі не залежала від точки пальця.
                    let topContentY: number | null = null;
                    let topWordCenterX: number | null = null;
                    for (let i = start; i <= end; i++) {
                      const wl = wordsLayouts.current[i];
                      const bl = wl ? blockLayouts.current[wl.blockIndex] : null;
                      if (!wl || !bl) continue;
                      const contentY = bl.y + wl.y;
                      if (topContentY === null || contentY < topContentY) {
                        topContentY = contentY;
                        topWordCenterX = wl.x + wl.w / 2;
                      }
                    }

                    const finishSentenceSelect = (menuPageX: number, menuPageY: number) => {
                      props.onSentenceSelect({
                        startIdx: start,
                        endIdx: end,
                        text: selectedText,
                        pageX: menuPageX,
                        pageY: menuPageY,
                      });
                    };

                    const container = containerRef.current;
                    if (container && topContentY !== null && topWordCenterX !== null) {
                      // Реальна позиція блоку тексту у вікні (вже враховує скрол,
                      // хедер і safe-area). Конвертуємо верхній рядок виділення
                      // у віконні координати.
                      container.measureInWindow((wx, wy) => {
                        if (!isMountedRef.current) return;
                        finishSentenceSelect(
                          wx + CONTAINER_PADDING_LEFT + topWordCenterX,
                          wy + CONTAINER_PADDING_TOP + topContentY,
                        );
                      });
                    } else {
                      // Fallback, якщо розкладки ще не виміряні: ставимо меню
                      // над точкою відпускання пальця, як раніше.
                      finishSentenceSelect(pageX, pageY);
                    }
                  }
                }
              }

              releaseTimeout.current = setTimeout(() => {
                if (!isMountedRef.current) return;
                setLocalSelectionMode(false);
                props.onSelectionModeChange(false);
                draggedRangeRef.current = null;
                setDraggedRange(null);
                isLongPressed.current = false;
              }, 150);
            }
          },

          onPanResponderTerminate: () => {
            if (longPressTimeout.current) clearTimeout(longPressTimeout.current);
            if (releaseTimeout.current) clearTimeout(releaseTimeout.current);

            if (!isMountedRef.current) return;
            const props = latestProps.current;
            setLocalSelectionMode(false);
            props.onSelectionModeChange(false);
            draggedRangeRef.current = null;
            setDraggedRange(null);
            isLongPressed.current = false;
          },
        }),
      ).current;

      const selectionRanges = useMemo(
        () => computeSelectionRanges(localSelectedPhrase, draggedRange),
        [localSelectedPhrase, draggedRange],
      );

      const scrollToProgress = useCallback((progress: number) => {
        const maxScroll = measuredContentHeightRef.current - scrollViewLayoutHeight.current;
        if (maxScroll <= 0) return;

        const clamped = Math.min(1, Math.max(0, progress));
        const targetY = maxScroll * clamped;

        hasRestoredScrollRef.current = true;

        scrollViewRef.current?.scrollTo({ y: targetY, animated: false });
        lastScrollY.current = targetY;
      }, []);

      // ── Автоскрол над панеллю перекладу ─────────────────────────────────
      // Позиція тексту в контенті ScrollView не залежить від прокрутки, тож
      // ціль рахується абсолютно: де стоїть низ слова в контенті і де верх
      // панелі у вікні сторінки. Повторний виклик (панель стала вищою після
      // завантаження перекладу) дає ту саму або нижчу ціль — без стрибків.
      const contentWrapperYRef = useRef(0);
      const animatedBlockYRef = useRef(0);
      const textContainerYRef = useRef(0);
      // Запас унизу сторінки, щоб останні рядки теж можна було підняти над
      // панеллю. Діє лише поки відкрито переклад.
      const [extraBottomSpace, setExtraBottomSpace] = useState(0);
      const extraBottomSpaceRef = useRef(0);
      const pendingRevealYRef = useRef<number | null>(null);
      // Ціль, до якої їдемо, щойно внизу з'явиться додаткове місце.
      const scrollAfterGrowRef = useRef<number | null>(null);
      const extraReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

      const scrollToRevealTarget = useCallback((targetY: number) => {
        pendingRevealYRef.current = targetY;
        programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
        scrollViewRef.current?.scrollTo({ y: targetY, animated: true });
      }, []);

      const revealIndices = useCallback(
        (indices: number[], coveredHeight: number) => {
          const viewport = scrollViewLayoutHeight.current;
          if (!viewport || !Array.isArray(indices) || indices.length === 0) return;
          const visibleBottom = viewport - Math.max(0, coveredHeight);
          // Панель закриває майже всю сторінку — прокрутка не допоможе.
          if (visibleBottom < 80) return;

          let wordBottom = -1;
          for (const index of indices) {
            const wl = wordsLayouts.current[index];
            const bl = wl ? blockLayouts.current[wl.blockIndex] : null;
            if (!wl || !bl) continue;
            wordBottom = Math.max(wordBottom, bl.y + wl.y + wl.h);
          }
          if (wordBottom < 0) return;

          const contentBottom =
            contentWrapperYRef.current + animatedBlockYRef.current + textContainerYRef.current + wordBottom;
          const isAutoScrolling = Date.now() < programmaticScrollUntilRef.current;
          const currentY =
            isAutoScrolling && pendingRevealYRef.current !== null
              ? Math.max(lastScrollY.current, pendingRevealYRef.current)
              : lastScrollY.current;
          // Слово у верхніх 60% екрана — сторінку не рухаємо.
          if (contentBottom - lastScrollY.current <= viewport * REVEAL_ZONE_START) return;
          // Рівно стільки, щоб слово стало над панеллю, але не вище 55% екрана.
          const targetY = Math.round(
            Math.min(
              contentBottom + REVEAL_MARGIN - visibleBottom,
              contentBottom - viewport * REVEAL_MAX_LIFT_TO,
            ),
          );
          // Слово вже над панеллю — нічого не рухаємо (і ніколи не крутимо вгору).
          if (targetY <= currentY + 1) return;

          if (extraReleaseTimerRef.current) {
            clearTimeout(extraReleaseTimerRef.current);
            extraReleaseTimerRef.current = null;
          }
          const contentWithoutExtra = measuredContentHeightRef.current - extraBottomSpaceRef.current;
          const maxScrollWithoutExtra = Math.max(0, contentWithoutExtra - viewport);
          const neededExtra = Math.ceil(Math.max(0, targetY - maxScrollWithoutExtra));
          if (neededExtra > extraBottomSpaceRef.current) {
            // Спершу з'являється місце внизу, потім прокрутка (onContentSizeChange).
            extraBottomSpaceRef.current = neededExtra;
            pendingRevealYRef.current = targetY;
            scrollAfterGrowRef.current = targetY;
            setExtraBottomSpace(neededExtra);
            return;
          }
          if (scrollAfterGrowRef.current !== null) {
            // Місце внизу ще додається — поїдемо одразу до найдальшої цілі.
            scrollAfterGrowRef.current = Math.max(scrollAfterGrowRef.current, targetY);
            return;
          }
          scrollToRevealTarget(targetY);
        },
        [scrollToRevealTarget],
      );

      const hasAnySelection = !!selectedPhrase || !!localSelectedPhrase;
      useEffect(() => {
        if (hasAnySelection) {
          // Нове слово відкрили, поки запас ще прибирався, — запас лишається.
          if (extraReleaseTimerRef.current) {
            clearTimeout(extraReleaseTimerRef.current);
            extraReleaseTimerRef.current = null;
          }
          return;
        }
        if (extraBottomSpaceRef.current === 0) return;
        // Переклад закрито: запас унизу прибираємо плавно — спершу повертаємось
        // у межі тексту, потім забираємо місце (без ривка контенту).
        const viewport = scrollViewLayoutHeight.current;
        const maxScrollWithoutExtra = Math.max(
          0,
          measuredContentHeightRef.current - extraBottomSpaceRef.current - viewport,
        );
        const release = () => {
          extraReleaseTimerRef.current = null;
          extraBottomSpaceRef.current = 0;
          pendingRevealYRef.current = null;
          scrollAfterGrowRef.current = null;
          if (isMountedRef.current) setExtraBottomSpace(0);
        };
        if (lastScrollY.current > maxScrollWithoutExtra + 1) {
          programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
          scrollViewRef.current?.scrollTo({ y: maxScrollWithoutExtra, animated: true });
          extraReleaseTimerRef.current = setTimeout(release, EXTRA_SPACE_RELEASE_MS);
        } else {
          release();
        }
      }, [hasAnySelection]);

      useEffect(
        () => () => {
          if (extraReleaseTimerRef.current) clearTimeout(extraReleaseTimerRef.current);
        },
        [],
      );

      // Плавний автоскрол на задану кількість пікселів — коли панель перекладу
      // перекриває натиснуте слово знизу екрана.
      const scrollByOffset = useCallback((delta: number) => {
        if (!delta) return;
        const maxScroll = measuredContentHeightRef.current - scrollViewLayoutHeight.current;
        if (maxScroll <= 0) return;
        const nextY = Math.min(Math.max(lastScrollY.current + delta, 0), maxScroll);
        if (Math.abs(nextY - lastScrollY.current) < 1) return;
        // Позначаємо програмний скрол з запасом часу, щоб handleScroll не
        // сприйняв його за жест користувача і не закрив щойно відкритий вибір.
        programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
        scrollViewRef.current?.scrollTo({ y: nextY, animated: true });
        // НЕ ставимо lastScrollY.current = nextY одразу: позиція змінюється
        // плавно під час анімації, і передчасне присвоєння давало великий
        // хибний delta в handleScroll (звідси й «миготіння» панелі перекладу).
      }, []);

      useImperativeHandle(
        ref,
        () => ({ scrollToProgress, scrollByOffset, revealIndices }),
        [scrollToProgress, scrollByOffset, revealIndices],
      );

      return (
        <View style={[stylesReader.pageContainer, { width: pageWidth }]}>
          <ScrollView
            ref={scrollViewRef}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[stylesReader.scrollPadding, { flexGrow: 1 }]}
            scrollEnabled={!localSelectionMode}
            onScrollBeginDrag={onScrollBeginDrag}
            onScroll={handleScroll}
            scrollEventThrottle={32}
            onScrollEndDrag={resetScrollGesture}
            onMomentumScrollEnd={resetScrollGesture}
            onLayout={(e) => {
              scrollViewLayoutHeight.current = e.nativeEvent.layout.height;
              const nextRange = computeVisibleRange(
                lastScrollY.current,
                e.nativeEvent.layout.height,
              );
              setVisibleParagraphRange((prev) => {
                if (prev.start === nextRange.start && prev.end === nextRange.end) return prev;
                return nextRange;
              });
            }}
            onContentSizeChange={(w, h) => {
              measuredContentHeightRef.current = h;

              // Місце внизу для автоскролу з'явилось — їдемо до відкладеної цілі.
              const growTarget = scrollAfterGrowRef.current;
              if (growTarget !== null && h - scrollViewLayoutHeight.current >= growTarget - 1) {
                scrollAfterGrowRef.current = null;
                scrollToRevealTarget(growTarget);
              }

              if (h > 0 && scrollViewLayoutHeight.current > 0) {
                if (h <= scrollViewLayoutHeight.current) {
                  latestProps.current.onScrollProgress?.(item.id, 1);
                }

                if (
                  !hasRestoredScrollRef.current &&
                  !isContentLoading &&
                  !!item.content &&
                  typeof initialScrollProgress === 'number' &&
                  initialScrollProgress > 0
                ) {
                  const maxScroll = h - scrollViewLayoutHeight.current;
                  if (maxScroll > 0) {
                    const targetY = Math.min(maxScroll, maxScroll * initialScrollProgress);
                    hasRestoredScrollRef.current = true;
                    scrollViewRef.current?.scrollTo({ y: targetY, animated: false });
                    lastScrollY.current = targetY;
                  }
                }
              }
            }}
          >
            {!!item.imageUrl && <PageHeaderImage imageUrl={item.imageUrl} />}

            <View
              style={{ flexGrow: 1 }}
              onLayout={(e) => {
                contentWrapperYRef.current = e.nativeEvent.layout.y;
              }}
            >
              <TouchableWithoutFeedback onPress={onEmptyPress}>
                <Animated.View
                  onLayout={(e) => {
                    animatedBlockYRef.current = e.nativeEvent.layout.y;
                  }}
                  style={{
                    flexGrow: 1,
                    opacity: contentOpacity,
                    transform: [{ translateY: contentTranslateY }],
                  }}
                >
                  <ChapterTitle
                    title={item.title || item.chapterTitle}
                    maxFontSize={28}
                    minFontScale={0.4}
                  />

                  <View
                    ref={containerRef}
                    onLayout={(e) => {
                      textContainerYRef.current = e.nativeEvent.layout.y;
                    }}
                    {...panResponder.panHandlers}
                    style={[
                      stylesReader.textBlockContainer,
                      {
                        padding: 0,
                        paddingHorizontal: 0,
                        paddingTop: 0,
                        paddingBottom: 0,
                        margin: 0,
                      },
                    ]}
                  >
                    <View
                      pointerEvents="none"
                      style={{ paddingHorizontal: 4, paddingTop: CONTAINER_PADDING_TOP }}
                    >
                      {paragraphBlocks.map((block, blockIndex) => {
                        const isMounted =
                          blockIndex >= visibleParagraphRange.start &&
                          blockIndex <= visibleParagraphRange.end;

                        if (isMounted) {
                          return (
                            <ParagraphBlockRenderer
                              key={`block-${layoutEpoch}-${blockIndex}`}
                              blockIndex={blockIndex}
                              chunks={chunkSlicesByBlock[blockIndex]}
                              baseIndex={block.startIdx}
                              fontSize={fontSize}
                              boldSet={boldSet}
                              highlightColorByIndex={highlightColorByIndex}
                              translatedMin={selectionRanges.translatedMin}
                              translatedMax={selectionRanges.translatedMax}
                              translatedExact={selectionRanges.translatedExact}
                              highlightingMin={selectionRanges.highlightingMin}
                              highlightingMax={selectionRanges.highlightingMax}
                              onWordLayout={handleWordLayout}
                              onBlockLayout={recordBlockLayout}
                            />
                          );
                        }

                        return (
                          <View
                            key={`spacer-${blockIndex}`}
                            style={{ width: '100%', height: getBlockHeight(blockIndex) }}
                          />
                        );
                      })}
                    </View>
                  </View>
                </Animated.View>
              </TouchableWithoutFeedback>
            </View>
            {extraBottomSpace > 0 && <View style={{ height: extraBottomSpace }} />}
          </ScrollView>
        </View>
      );
    },
  ),
);
