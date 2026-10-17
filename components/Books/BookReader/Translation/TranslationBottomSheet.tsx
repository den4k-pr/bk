import { colors } from '../../../../styles/theme';
import React, { useRef, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  ActivityIndicator,
  Animated,
  StyleSheet,
  PanResponder,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { styles, COLORS } from './TranslationBottomSheet.styles';
import { localStyles } from './TranslationBottomSheet.local.styles';
import { normalizeFormsList, partOfSpeechMap } from './translationSheet.utils';
import { useAddWordAnimation } from './useAddWordAnimation';
import { WordType } from '../../../../types/words';
import { SelectedPhrase } from '../../../../types/BookReader.types';
import { capitalizeStandaloneI } from '../../../../utils/textFormatting';
import { flyFromView } from '../../../../services/dictionaryAddFx';
import { phraseFontSize } from '../../../../utils/longPhraseFont';

// 🟢 Статичні ресурси
const ICON_VOLUME = require('../../../../../assets/images/icons/volume.png');
const ICON_DELETE = require('../../../../../assets/images/icons/delete_2.png');
const ICON_ADD_TO_NOTES = require('../../../../../assets/images/icons/add-to-notes.webp');

interface TranslationBottomSheetProps {
  selectedPhrase: SelectedPhrase | null;
  wordDetails: WordType | null;
  isLoadingTranslation: boolean;
  isAdded: boolean;
  isRemoving: boolean;
  slideAnim: Animated.Value;
  fadeAnim: Animated.Value;
  onSpeak: (text: string) => void;
  onAddWord: () => void;
  onRemoveWord: () => void;
  onClose: () => void;
  /** Слово в тексті, якщо показано іншу (словникову) форму: "trained" → "train". */
  surfaceText?: string | null;
  /** Переклад форми саме в цьому реченні ("am walking" → "йду"). */
  surfaceTranslation?: string | null;
  /** Форми дієслова з сервера ("went", "gone", "going"). */
  verbForms?: string[] | null;
  isReported?: boolean;
  onReport?: () => void;
  /** Повторити запит після помилки перекладу. */
  onRetry?: () => void;
  /** Повна висота панелі (для автоскролу читалки над нею). */
  onSheetLayout?: (height: number) => void;
}

export const TranslationBottomSheet: React.FC<TranslationBottomSheetProps> = React.memo(({
  selectedPhrase,
  wordDetails,
  isLoadingTranslation,
  isAdded,
  isRemoving,
  slideAnim,
  fadeAnim,
  onSpeak,
  onAddWord,
  onRemoveWord,
  onClose,
  surfaceText,
  surfaceTranslation,
  verbForms,
  isReported,
  onReport,
  onRetry,
  onSheetLayout,
}) => {
  const callbacksRef = useRef({ onClose, onSpeak, onAddWord, onRemoveWord, onReport, onRetry });
  const addButtonRef = useRef<View>(null);
  callbacksRef.current = { onClose, onSpeak, onAddWord, onRemoveWord, onReport, onRetry };

  const phraseRef = useRef(selectedPhrase);
  phraseRef.current = selectedPhrase;

  const isPreload = !selectedPhrase || isLoadingTranslation || !wordDetails;

  const isFullyHidden = !selectedPhrase;
  const lastHeightRef = useRef<number>(100);

  const isTranslationFailed = wordDetails?.id === 0;
  const activeIsAdded = isAdded;

  const rawText = wordDetails?.text || selectedPhrase?.text || '';
  const displayWordText = capitalizeStandaloneI(rawText);
  // Довга фраза (понад 3 слова) — шрифт на 20% менший.
  const wordFontStyle = { fontSize: phraseFontSize(styles.sheetWordText.fontSize as number, displayWordText) };
  const displayBookDescription = wordDetails?.bookDescription ? ` (${wordDetails.bookDescription})` : '';

  const safeSpeakText = displayWordText;
  const isPhraseOrPhrasalVerb =
    wordDetails?.partOfSpeech === 'phrase' ||
    wordDetails?.partOfSpeech === 'phrasal_verb' ||
    wordDetails?.partOfSpeech === 'idiom';

  // Форми для картки: дієслова — з сервера, прикметники / прислівники —
  // ступені порівняння з самого запису (як і раніше).
  const displayForms = useMemo((): string => {
    if (isTranslationFailed || !wordDetails) return '';
    const fromServer = Array.isArray(verbForms)
      ? verbForms.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : [];
    if (fromServer.length > 0) return normalizeFormsList(fromServer);
    const pos = wordDetails.partOfSpeech;
    if ((pos === 'adjective' || pos === 'adverb') && Array.isArray(wordDetails.forms)) {
      return normalizeFormsList(wordDetails.forms.filter((f): f is string => typeof f === 'string'));
    }
    return '';
  }, [isTranslationFailed, wordDetails, verbForms]);

  const retryLink = isTranslationFailed && onRetry ? (
    <Pressable style={localStyles.retryLink} hitSlop={10} onPress={() => callbacksRef.current.onRetry?.()}>
      <Text style={localStyles.retryLinkText}>Спробувати ще раз</Text>
    </Pressable>
  ) : null;

  const [wordRowWidth, setWordRowWidth] = useState(0);
  const [wordRowContainerWidth, setWordRowContainerWidth] = useState(0);

  const shouldOffsetWordRow =
    wordRowContainerWidth > 0 &&
    wordRowWidth > 0 &&
    wordRowWidth / wordRowContainerWidth > 0.7;

  const userJustAddedRef = useRef(false);

  const currentSlideY = useRef(0);
  useEffect(() => {
    const id = slideAnim.addListener(({ value }) => {
      currentSlideY.current = value;
    });
    return () => slideAnim.removeListener(id);
  }, [slideAnim]);

  const {
    animatedCardStyle,
    animatedSweepStyle,
    animatedRingStyle,
    animatedSecondRingStyle,
    animatedButtonStyle,
    animatedFillStyle,
    animatedCheckmarkStyle,
  } = useAddWordAnimation(isAdded, userJustAddedRef);

  const isDraggingSheetRef = useRef(false);
  const lastDy = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        if (currentSlideY.current > 50) return false;
        return gestureState.dy > 5 && gestureState.dy > Math.abs(gestureState.dx);
      },
      onPanResponderGrant: () => {
        isDraggingSheetRef.current = true;
        lastDy.current = 0;
        slideAnim.stopAnimation();
      },
      onPanResponderMove: (_, gestureState) => {
        lastDy.current = gestureState.dy;
        if (gestureState.dy > 0) {
          slideAnim.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        isDraggingSheetRef.current = false;
        lastDy.current = 0;

        if (gestureState.dy > 35 || gestureState.vy > 0.3) {
          callbacksRef.current.onClose();
        } else {
          Animated.spring(slideAnim, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 8,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        const wasDraggingSheet = isDraggingSheetRef.current;
        isDraggingSheetRef.current = false;

        if (wasDraggingSheet && phraseRef.current) {
          if (lastDy.current > 35) {
            callbacksRef.current.onClose();
          } else {
            Animated.spring(slideAnim, {
              toValue: 0,
              useNativeDriver: true,
            }).start();
          }
        }
        lastDy.current = 0;
      }
    })
  ).current;

  useEffect(() => {
    if (!selectedPhrase) {
      isDraggingSheetRef.current = false;
    } else {
      userJustAddedRef.current = false;
    }
  }, [selectedPhrase]);

  const animatedSheetStyle = useMemo(() => [
    styles.bottomSheet,
    {
      transform: [{ translateY: slideAnim }],
      opacity: isFullyHidden ? 0 : 1
    },
  ], [slideAnim, isFullyHidden]);

  // Дзеркально до мітки частини мови: та сама панель, ті самі відступи.
  const reportLink = !isTranslationFailed && onReport ? (
    <Pressable
      style={localStyles.reportLink}
      hitSlop={10}
      disabled={!!isReported}
      onPress={() => callbacksRef.current.onReport?.()}
    >
      <Text style={localStyles.reportLinkText}>
        {isReported ? 'Дякуємо ✓' : 'Неточно?'}
      </Text>
    </Pressable>
  ) : null;

  const showAsJustAdded = activeIsAdded && userJustAddedRef.current;
  const showAsRemove = activeIsAdded && !userJustAddedRef.current;

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={animatedSheetStyle}
      pointerEvents={selectedPhrase ? 'auto' : 'none'}
      onLayout={(e) => onSheetLayout?.(e.nativeEvent.layout.height)}
    >
      <View style={localStyles.dragPillWrapper}>
        <View style={localStyles.dragPill} />
      </View>
      
      <View style={{ width: '100%', alignItems: 'center' }}>
        <Animated.View
          style={animatedCardStyle}
          onLayout={(e) => {
            if (selectedPhrase && !isPreload) {
              lastHeightRef.current = Math.max(150, e.nativeEvent.layout.height);
            }
          }}
        >

          {!selectedPhrase ? (
            <View style={{ height: lastHeightRef.current }} />
          ) : isPreload ? (
            <View style={{ height: 150, justifyContent: 'center', alignItems: 'center'}}>
              <ActivityIndicator size="large" color={COLORS.green} />
            </View>
          ) : (
            <>
              <View pointerEvents="none" style={localStyles.sweepClip}>
                <Animated.View style={animatedSweepStyle}>
                  <LinearGradient
                    colors={['rgba(143,199,165,0)', 'rgba(143,199,165,0.55)', 'rgba(143,199,165,0)']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={StyleSheet.absoluteFill}
                  />
                </Animated.View>
              </View>

              {!isPhraseOrPhrasalVerb && (
                <>
                  <View
                    style={styles.sheetTopSection}
                    onLayout={(e) => setWordRowContainerWidth(e.nativeEvent.layout.width)}
                  >
                    {reportLink}

                    {wordDetails?.partOfSpeech && wordDetails.partOfSpeech !== 'none' && (
                      <View style={localStyles.partOfSpeechTag}>
                        <Text style={localStyles.partOfSpeechText}>
                          {partOfSpeechMap[wordDetails.partOfSpeech] || wordDetails.partOfSpeech}
                        </Text>
                      </View>
                    )}

                    <View
                      style={[styles.wordHeaderRow, { maxWidth: '100%' }]}
                      onLayout={(e) => setWordRowWidth(e.nativeEvent.layout.width)}
                    >
                      <Pressable
                        style={({ pressed }) => [styles.audioButtonOnly, pressed && localStyles.buttonPressed]}
                        hitSlop={8}
                        onPress={() => safeSpeakText && callbacksRef.current.onSpeak(safeSpeakText)}
                      >
                        <Image
                          source={ICON_VOLUME}
                          style={styles.audioIconCard}
                          resizeMode="contain"
                        />
                      </Pressable>

                      <Text
                        style={[styles.sheetWordText, wordFontStyle, shouldOffsetWordRow && { flexShrink: 1 }]}
                        numberOfLines={2}
                      >
                        {displayWordText}
                      </Text>
                    </View>

                    <View style={styles.transcriptionContainer}>
                      <Text style={styles.transcriptionText}>
                        {wordDetails?.pronunciation ? `/${wordDetails.pronunciation}/` : ''}
                      </Text>
                    </View>

                    {/* Переклад у реченні — окремо від словникового перекладу леми нижче:
                        "у тексті: telling → розповідає", а під ним "казати / розповідати". */}
                    {(!!surfaceText || !!surfaceTranslation) && (
                      <Text style={localStyles.surfaceText} numberOfLines={2}>
                        {surfaceText ? `у тексті: ${surfaceText}` : 'у цьому реченні'}
                        {!!surfaceTranslation && (
                          <Text style={localStyles.surfaceTranslation}>{`  →  ${surfaceTranslation}`}</Text>
                        )}
                      </Text>
                    )}
                  </View>

                  <View style={styles.sheetBottomSection}>
                    {!!displayForms && (
                      <View style={styles.formsContainerWrapper}>
                        <View style={styles.forms_element}>
                          <Text style={styles.forms_element_text}>{displayForms}</Text>
                        </View>
                      </View>
                    )}

                    <View style={styles.translationContainer}>
                      {wordDetails?.translation && (
                        <Text style={styles.translationText}>
                          {wordDetails.translation}{displayBookDescription}
                        </Text>
                      )}
                    </View>
                    {retryLink}
                  </View>
                </>
              )}

              {isPhraseOrPhrasalVerb && (
                <View style={{ width: '100%' }}>
                  <View
                    style={styles.sheetTopSection}
                    onLayout={(e) => setWordRowContainerWidth(e.nativeEvent.layout.width)}
                  >
                    {reportLink}

                    {wordDetails?.partOfSpeech && wordDetails.partOfSpeech !== 'none' && (
                      <View style={localStyles.partOfSpeechTag}>
                        <Text style={localStyles.partOfSpeechText}>
                          {partOfSpeechMap[wordDetails.partOfSpeech] || wordDetails.partOfSpeech}
                        </Text>
                      </View>
                    )}

                    <View
                      style={[styles.wordHeaderRow, { maxWidth: '100%' }]}
                      onLayout={(e) => setWordRowWidth(e.nativeEvent.layout.width)}
                    >
                      <Pressable
                        style={({ pressed }) => [styles.audioButtonOnly, pressed && localStyles.buttonPressed]}
                        hitSlop={8}
                        onPress={() => safeSpeakText && callbacksRef.current.onSpeak(safeSpeakText)}
                      >
                        <Image
                          source={ICON_VOLUME}
                          style={styles.audioIconCard}
                          resizeMode="contain"
                        />
                      </Pressable>

                      <Text
                        style={[styles.sheetWordText, wordFontStyle, { flexShrink: 1 }]}
                        numberOfLines={2}
                      >
                        {displayWordText}
                      </Text>
                    </View>

                    {wordDetails?.pronunciation ? (
                      <Text style={[styles.transcriptionText, { marginTop: 2 }]}>
                        {`/${wordDetails.pronunciation}/`}
                      </Text>
                    ) : null}
                  </View>

                  <View style={styles.sheetBottomSection}>
                    {!!displayForms && (
                      <View style={styles.formsContainerWrapper}>
                        <View style={styles.forms_element}>
                          <Text style={styles.forms_element_text}>{displayForms}</Text>
                        </View>
                      </View>
                    )}

                    {wordDetails?.translation && (
                      <Text style={[styles.translationText, { marginBottom: 12 }]}>
                        {wordDetails.translation}{displayBookDescription}
                      </Text>
                    )}

                    {wordDetails?.examples && wordDetails.examples.length >= 2 && (
                      <View style={styles.examples}>
                        <Text style={styles.example_eng}>
                          {capitalizeStandaloneI(wordDetails.examples[0]?.replace(/\.\s*$/, '') || '')}
                        </Text>
                        <Text style={styles.example_ukr}>
                          {wordDetails.examples[1]?.replace(/\.\s*$/, '')}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              )}

              <View style={localStyles.actionButtonWrapper}>
                <Animated.View pointerEvents="none" style={animatedSecondRingStyle} />
                <Animated.View pointerEvents="none" style={animatedRingStyle} />

                <Animated.View style={animatedButtonStyle}>
                  <Pressable
                    ref={addButtonRef}
                    style={({ pressed }) => [
                      localStyles.exactCenterButton,
                      pressed && localStyles.buttonPressed,
                      (showAsRemove || isRemoving) && localStyles.buttonRemovingState,
                    ]}
                    onPress={() => {
                      if (showAsRemove) {
                        callbacksRef.current.onRemoveWord();
                      } else if (!activeIsAdded) {
                        userJustAddedRef.current = true;
                        // "Політ" слова до іконки Словника у футері.
                        flyFromView(addButtonRef.current);
                        callbacksRef.current.onAddWord();
                      }
                    }}
                    disabled={isPreload || isTranslationFailed || isRemoving || showAsJustAdded}
                  >
                    {showAsJustAdded && (
                      <Animated.View pointerEvents="none" style={animatedFillStyle} />
                    )}

                    {isRemoving ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : showAsJustAdded ? (
                      <Animated.View style={[localStyles.checkmarkBox, animatedCheckmarkStyle]}>
                        <View style={localStyles.checkShort} />
                        <View style={localStyles.checkLong} />
                      </Animated.View>
                    ) : showAsRemove ? (
                      <Animated.View style={animatedCheckmarkStyle}>
                        <Image
                          style={styles.floatingRemoveIcon}
                          source={ICON_DELETE}
                          resizeMode="contain"
                        />
                      </Animated.View>
                    ) : (
                      <Image
                        style={styles.floatingAddIcon}
                        source={ICON_ADD_TO_NOTES}
                        resizeMode="contain"
                      />
                    )}
                  </Pressable>
                </Animated.View>
              </View>

            </>
          )}

        </Animated.View>
      </View>
    </Animated.View>
  );
});
