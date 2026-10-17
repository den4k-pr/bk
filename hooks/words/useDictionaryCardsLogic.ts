import { useState, useRef, useEffect, useCallback } from 'react';
import { Animated } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../../store';
import { useInterstitialAd } from '../adds/useInterstitialAd';
import { registerCompletedCardCycle } from '../adds/cardsAdCounter';
import {
  fetchNewDictionaryWordCycle,
  fetchRandomDictionaryWords,
} from '../../features/learnSlice';

const TRANSITION_DURATION = 350;

export const useDictionaryCardsLogic = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { words, status } = useSelector((state: RootState) => state.learn);
  const { showInterstitialAd } = useInterstitialAd();

  const [isSwitching, setIsSwitching] = useState(false);
  const [displayWords, setDisplayWords] = useState(words);
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (status === 'loading') setDisplayWords([]);
    if (!isSwitching && status === 'succeeded' && words.length > 0) {
      setDisplayWords(words);
    }
  }, [words, status, isSwitching]);

  useEffect(() => {
    dispatch(fetchRandomDictionaryWords());
  }, [dispatch]);

  useEffect(() => {
    if (status === 'succeeded' && displayWords.length > 0 && !isSwitching) {
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: TRANSITION_DURATION,
        useNativeDriver: true,
      }).start();
    }
  }, [status, displayWords, isSwitching]);

  const handleDeckComplete = useCallback(() => {
    if (isSwitching) return;
    setIsSwitching(true);

    Animated.timing(opacityAnim, {
      toValue: 0,
      duration: TRANSITION_DURATION,
      useNativeDriver: true,
    }).start(async () => {
      // 🔴 ФІКС: локальний лічильник замість state.learn.cycleId.
      const shouldShowAd = registerCompletedCardCycle();

      try {
        if (shouldShowAd) {
          await dispatch(fetchNewDictionaryWordCycle({ showAd: showInterstitialAd }));
        } else {
          await dispatch(fetchNewDictionaryWordCycle({ showAd: () => {} }));
        }
      } catch (error) {
        console.warn('[useDictionaryCardsLogic] fetchNewDictionaryWordCycle failed:', error);
      } finally {
        setIsSwitching(false);
      }
    });
  }, [isSwitching, opacityAnim, dispatch, showInterstitialAd]);

  return {
    words: displayWords,
    status,
    isError: status === 'failed',
    isSwitching,
    opacityAnim,
    isContentLoaded: (status === 'succeeded' && displayWords.length > 0) || (status === 'succeeded' && words.length === 0),
    handleDeckComplete,
  };
};