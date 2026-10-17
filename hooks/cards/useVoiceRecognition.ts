import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { AppState } from 'react-native';
import { useVoice, VoiceMode } from 'react-native-voicekit';
import { checkMatchDetailed, MatchTier } from '../../utils/speach/speechMatcher';
import { setMicrophoneBusy } from '../../services/soundEffects';

const SILENCE_AFTER_SPEECH = 500;
const MAX_PROCESSING_TIME = 3000;

// Час, який людина має на те, щоб ПОЧАТИ говорити після натискання на мікрофон.
// Рахується ЛИШЕ після старту прослуховування, а не з моменту появи картки —
// людина може відійти й повернутись, картка на це жодним чином не реагує.
// Якщо за цей час взагалі не пролунало жодного звуку — сесія просто тихо
// скидається в 'idle' без будь-якого штрафу чи вердикту, спробувати можна знову.
export const NO_SPEECH_TIMEOUT_MS = 15000;

interface VoiceRecognitionAlternative {
  text: string;
  confidence: number;
}

interface UseVoiceWithConfidence {
  available: boolean;
  listening: boolean;
  transcript: string;
  confidence: number;
  alternatives: VoiceRecognitionAlternative[];
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  resetTranscript: () => void;
}

const MIN_CONFIDENCE = 0.35;

interface RecognitionCandidate {
  text: string;
  confidence: number;
  source: string;
}

export const useVoiceRecognition = (
  expectedWord: string,
  onFinish: (success: boolean, recognizedText: string) => void,
  // 🟢 НОВЕ: необов'язковий список іншиї слів поточного заняття (наприклад,
  // усі англійські цільові слова з черги). Передається розпізнавачу як
  // "підказка" (contextualStrings), щоб він розпізнавав саме слова з
  // відомого словника вправи, а не будь-яку статистично ймовірнішу фразу
  // загальної англійської мови.
  vocabularyHints?: string[]
) => {
  const [status, setStatus] = useState<'idle' | 'listening' | 'processing'>('idle');
  const [error, setError] = useState('');
  // Дзеркало hasSpeechStartedRef у стані — щоб UI (кільце-таймер, підказка)
  // міг реагувати на момент, коли людина реально почала говорити.
  const [hasSpeechStarted, setHasSpeechStarted] = useState(false);

  // 🟢 НОВЕ: список слів, до яких треба змістити мовну модель розпізнавача.
  // Завжди включає поточне очікуване слово навіть якщо vocabularyHints
  // цього не передав.
  const contextualStrings = useMemo(() => {
    const set = new Set<string>();
    const clean = (w?: string) => (w || '').trim().toLowerCase();
    if (expectedWord) set.add(clean(expectedWord));
    (vocabularyHints || []).forEach((w) => {
      const c = clean(w);
      if (c) set.add(c);
    });
    return Array.from(set);
  }, [expectedWord, vocabularyHints]);

  const {
    listening,
    transcript,
    confidence,
    alternatives,
    startListening: startUnderlyingListening,
    stopListening: stopUnderlyingListening,
    available,
  } = useVoice({
    locale: 'en-US',
    mode: VoiceMode.Continuous,
    contextualStrings,
    // 🔴 ФІКС: раніше цей прапорець взагалі не передавався, тому JS
    // отримував "transcript" ЛИШЕ у момент, коли натив уже сам вирішив,
    // що мовлення завершилось (після власного ~1с debounce). Через це:
    //   1) hasSpeechStarted спрацьовував із запізненням майже на секунду
    //      замість "одразу як людина почала говорити";
    //   2) наш debug-блок з "живою" розшифровкою насправді не був живим —
    //      оновлювався один раз в кінці.
    // enablePartialResults: true дозволяє бачити проміжні гіпотези в
    // реальному часі, поки людина ще говорить.
    enablePartialResults: true,
  } as any) as UseVoiceWithConfidence;

  const statusRef = useRef(status);
  const expectedWordRef = useRef(expectedWord);
  const finishRef = useRef(onFinish);

  const fullTranscriptRef = useRef('');
  const lastConfidenceRef = useRef<number>(-1);
  const lastAlternativesRef = useRef<VoiceRecognitionAlternative[]>([]);
  const hasSpeechStartedRef = useRef(false);
  const silenceTimerRef = useRef<any>(null);
  const processingTimeoutRef = useRef<any>(null);
  const prevListeningRef = useRef(false);
  const stopDelayTimerRef = useRef<any>(null);
  const noSpeechTimeoutRef = useRef<any>(null);

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    statusRef.current = status;
    expectedWordRef.current = expectedWord;
    finishRef.current = onFinish;
  }, [status, expectedWord, onFinish]);

  useEffect(() => {
    if (transcript && transcript.trim().length > 0) {
      fullTranscriptRef.current = transcript;
      lastConfidenceRef.current = typeof confidence === 'number' ? confidence : -1;
      lastAlternativesRef.current = Array.isArray(alternatives) ? alternatives : [];

      if (!hasSpeechStartedRef.current) {
        hasSpeechStartedRef.current = true;
        setHasSpeechStarted(true);

        // Мовлення почалось — таймаут очікування більше не потрібен,
        // тиску часу для людини більше нема.
        if (noSpeechTimeoutRef.current) {
          clearTimeout(noSpeechTimeoutRef.current);
          noSpeechTimeoutRef.current = null;
        }
      }

      console.log('🗣️ [Voice Live Stream]:', {
        expected: expectedWordRef.current,
        rawTranscript: transcript,
        confidence: lastConfidenceRef.current,
        alternatives: lastAlternativesRef.current,
      });
    }
  }, [transcript, confidence, alternatives]);

  // Поки нативне прослуховування активне, звукові ефекти не чіпають
  // аудіо-сесію (див. soundEffects) — інакше зламали б запис.
  useEffect(() => {
    setMicrophoneBusy(listening);
  }, [listening]);

  useEffect(() => () => setMicrophoneBusy(false), []);

  const stopListeningInternal = useCallback(async () => {
    if (statusRef.current !== 'listening') return;

    if (noSpeechTimeoutRef.current) {
      clearTimeout(noSpeechTimeoutRef.current);
      noSpeechTimeoutRef.current = null;
    }

    if (!hasSpeechStartedRef.current) {
      console.log('🔇 [Voice] Stopped: No speech was detected — silent reset, no penalty.');
      setStatus('idle');
      stopUnderlyingListening().catch((e) => {
        console.log('⚠️ [Voice] Error stopping (no speech) listening:', e);
      });
      return;
    }

    console.log('⏳ [Voice] Speech finished, status set to processing...');
    setStatus('processing');

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (stopDelayTimerRef.current) clearTimeout(stopDelayTimerRef.current);

    stopDelayTimerRef.current = setTimeout(async () => {
      if (!isMountedRef.current) return;
      try {
        await stopUnderlyingListening();
      } catch (e) {
        console.log('⚠️ [Voice] Error stopping underlying listening:', e);
      }
    }, 300);

    processingTimeoutRef.current = setTimeout(() => {
      if (statusRef.current === 'processing') {
        console.log('⏱️ [Voice Timeout] Force finishing due to MAX_PROCESSING_TIME');
        finishRef.current(false, fullTranscriptRef.current || '');
        setStatus('idle');
      }
    }, MAX_PROCESSING_TIME);
  }, [stopUnderlyingListening]);

  const resetSilenceTimer = useCallback(() => {
    if (!hasSpeechStartedRef.current) return;

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    silenceTimerRef.current = setTimeout(() => {
      if (statusRef.current === 'listening') {
        console.log('🤫 [Voice Silence] 500ms silence detected after speech.');
        setStatus('processing');

        stopUnderlyingListening().catch((e) => {
          console.log('⚠️ [Voice] Error stopping on silence:', e);
        });

        processingTimeoutRef.current = setTimeout(() => {
          console.log('⏱️ [Voice Silence Timeout] Force finishing');
          finishRef.current(false, fullTranscriptRef.current || '');
          setStatus('idle');
        }, MAX_PROCESSING_TIME);
      }
    }, SILENCE_AFTER_SPEECH);
  }, [stopUnderlyingListening]);

  const startListening = useCallback(async () => {
    if (!available || statusRef.current !== 'idle') return;

    console.log('🎤 [Voice Start] Listening initialized.', {
      expectedWord: expectedWordRef.current,
      contextualStrings,
    });

    setError('');
    setStatus('listening');

    fullTranscriptRef.current = '';
    lastConfidenceRef.current = -1;
    lastAlternativesRef.current = [];
    hasSpeechStartedRef.current = false;
    setHasSpeechStarted(false);

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
    if (stopDelayTimerRef.current) clearTimeout(stopDelayTimerRef.current);
    if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);

    try {
      await startUnderlyingListening();

      if (isMountedRef.current) {
        noSpeechTimeoutRef.current = setTimeout(() => {
          if (statusRef.current === 'listening' && !hasSpeechStartedRef.current) {
            console.log('⌛ [Voice] No speech within timeout window — silent reset.');
            stopListeningInternal();
          }
        }, NO_SPEECH_TIMEOUT_MS);
      }
    } catch (e: any) {
      console.log('❌ [Voice Start Error]:', e?.message);
      setError(e?.message ?? 'Не вдалося запустити розпізнавання голосу');
      setStatus('idle');
    }
  }, [available, startUnderlyingListening, stopListeningInternal, contextualStrings]);

  useEffect(() => {
    if (statusRef.current === 'listening' && transcript) {
      resetSilenceTimer();
    }
  }, [transcript, resetSilenceTimer]);

  useEffect(() => {
    const wasListening = prevListeningRef.current;

    if (wasListening && !listening && statusRef.current === 'processing') {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);

      const finalText = fullTranscriptRef.current.trim();
      const expected = expectedWordRef.current;

      if (!finalText) {
        console.log('⚠️ [Voice Evaluation] Final text is empty.');
        setStatus('idle');
        return;
      }

      // 🟢 НОВЕ: раніше перевірялась ЛИШЕ найкраща гіпотеза розпізнавача
      // (finalText). Але нативний шар (iOS: buildPayload) уже давно
      // рахує й надсилає до 3 альтернативних гіпотез (N-best) — ці дані
      // просто ігнорувались. Для фонетично складних слів очікуваний
      // варіант часто присутній серед альтернатив, навіть якщо
      // найкраща гіпотеза розпізнавача — інше слово.
      const seen = new Set<string>();
      const candidates: RecognitionCandidate[] = [];
      const pushCandidate = (text: string, conf: number, source: string) => {
        const trimmed = (text || '').trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ text: trimmed, confidence: conf, source });
      };

      pushCandidate(finalText, lastConfidenceRef.current, 'best');
      lastAlternativesRef.current.forEach((alt, index) => {
        pushCandidate(alt?.text, typeof alt?.confidence === 'number' ? alt.confidence : -1, `alt${index}`);
      });

      let success = false;
      let matchedText = '';
      let matchedTier: MatchTier = 'none';
      let matchedSource = 'best';

      for (const candidate of candidates) {
        const matchResult = checkMatchDetailed(candidate.text, expected ?? '');
        if (!matchResult.matched) continue;

        const isFuzzyTier = matchResult.tier === 'phonetic' || matchResult.tier === 'levenshtein';
        const confidenceOk =
          !isFuzzyTier || candidate.confidence < 0 || candidate.confidence >= MIN_CONFIDENCE;

        if (confidenceOk) {
          success = true;
          matchedText = candidate.text;
          matchedTier = matchResult.tier;
          matchedSource = candidate.source;
          break;
        }
      }

      console.log('==============================================');
      console.log('🎯 [VOICE MATCH FINAL EVALUATION]');
      console.log(`📌 Expected Word:       "${expected}"`);
      console.log(`🎙️ Best Hypothesis:    "${finalText}"`);
      console.log(`🧩 All Candidates:`, JSON.stringify(candidates));
      console.log(`✅ Matched Candidate:   ${success ? `"${matchedText}" (${matchedSource}, tier: ${matchedTier})` : 'none'}`);
      console.log(`🚀 FINAL SUCCESS:       ${success ? '✅ PASSED' : '❌ FAILED'}`);
      console.log('==============================================');

      finishRef.current(success, success ? matchedText : finalText);
      setStatus('idle');
    }

    prevListeningRef.current = listening;
  }, [listening]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && statusRef.current === 'listening') {
        console.log('📱 [Voice] App state changed to inactive, stopping listening.');
        stopListeningInternal();
      }
    });
    return () => sub.remove();
  }, [stopListeningInternal]);

  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
      if (stopDelayTimerRef.current) clearTimeout(stopDelayTimerRef.current);
      if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);
      stopUnderlyingListening().catch(() => {});
    };
  }, [stopUnderlyingListening]);

  return {
    isListening: status === 'listening',
    isProcessing: status === 'processing',
    hasSpeechStarted,
    error,
    startListening,
    stopListening: stopListeningInternal,
    // 🟡 Дебаг-дані для відображення "живої" розшифровки на екрані.
    liveTranscript: transcript,
    liveConfidence: confidence,
    liveAlternatives: alternatives,
  };
};