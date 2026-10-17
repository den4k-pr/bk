import { useNavigation } from '@react-navigation/native';
import { useEffect, useCallback, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import Tts from 'react-native-tts';

const TTS_PITCH             = 1.0;
const TTS_LANGUAGE          = 'en-US';
const TTS_VOICE_GENDER: 'male' | 'female' | '' = 'female';
const TTS_VOICE_NAME_FILTER = '';
const MAX_REINIT_ATTEMPTS   = 3;
// Android: якщо en-US у рушії немає (не завантажені дані) — пробуємо далі.
const ANDROID_FALLBACK_LANGUAGES = ['en-GB', 'en'];
// Android Google TTS: жіночі офлайн-голоси en-US (найближче до iOS-голосу).
const ANDROID_PREFERRED_VOICES = [
  'en-us-x-tpf-local',
  'en-us-x-sfg-local',
  'en-us-x-iob-local',
  'en-us-x-tpc-local',
];
const IS_ANDROID = Platform.OS === 'android';

/**
 * Android: голос, який точно зазвучить без мережі. Повертає null, якщо
 * краще лишити голос рушія за замовчуванням для мови (його й так виставляє
 * setDefaultLanguage).
 */
const pickAndroidVoice = (voices: any[]): string | null => {
  const usable = voices.filter(
    (v: any) =>
      (v.language === TTS_LANGUAGE || v.language?.startsWith(TTS_LANGUAGE)) &&
      !v.notInstalled &&
      !v.networkConnectionRequired,
  );
  for (const id of ANDROID_PREFERRED_VOICES) {
    if (usable.some((v: any) => v.id === id)) return id;
  }
  return null;
};

interface SpeakOptions {
  rate?: number;
}

interface UseTtsReturn {
  speak:         (text: string, options?: SpeakOptions) => void;
  stop:          (silent?: boolean) => void;
  isSpeaking:    boolean;
  // Передаємо поточну сторінку — хук сам стежить і зупиняє при зміні
  setActivePage: (page: number) => void;
}

export const useTts = (): UseTtsReturn => {
  const isReady            = useRef(false);
  const pendingTimeout     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reinitAttempts     = useRef(0);
  const isMountedRef       = useRef(true);
  const currentRate        = useRef<number>(0.5);
  const suppressNextCancel = useRef(false);

  const navigation = useNavigation();

  // Поточна сторінка — хук стежить за нею і зупиняє якщо змінилась
  const activePageRef      = useRef<number>(-1);

  // isSpeaking керується нашим кодом синхронно, не чекаємо нативних подій
  const isSpeakingRef      = useRef(false);
  const [isSpeaking, setIsSpeakingState] = useState(false);

  const setIsSpeaking = useCallback((val: boolean) => {
    isSpeakingRef.current = val;
    if (isMountedRef.current) setIsSpeakingState(val);
  }, []);

  // ── ПРИМУСОВА ЗУПИНКА — внутрішня ────────────────────────────────────────

  const forceStop = useCallback(() => {
    if (pendingTimeout.current) {
      clearTimeout(pendingTimeout.current);
      pendingTimeout.current = null;
    }
    suppressNextCancel.current = false;
    try { Tts.stop(); } catch {}
    setIsSpeaking(false);
  }, [setIsSpeaking]);

  // ── ІНІЦІАЛІЗАЦІЯ ─────────────────────────────────────────────────────────

  const initialize = useCallback(async () => {
    try {
      await Tts.getInitStatus();
    } catch (err: any) {
      const code = err?.code ?? err?.message ?? '';
      if (code === 'no_engine') {
        try { Tts.requestInstallEngine(); } catch {}
        return;
      }
    }

    try { await (Tts as any).setIgnoreSilentSwitch('ignore'); } catch {}
    try { await Tts.setDefaultPitch(TTS_PITCH); }              catch {}

    if (IS_ANDROID) {
      // На Android setLanguage() скидає голос на стандартний для мови, тому
      // порядок зворотний до iOS: спершу мова, потім (за потреби) голос.
      let languageSet = false;
      for (const language of [TTS_LANGUAGE, ...ANDROID_FALLBACK_LANGUAGES]) {
        try {
          await Tts.setDefaultLanguage(language);
          languageSet = true;
          break;
        } catch {}
      }
      if (!languageSet) {
        // Англійської в рушії немає — пропонуємо завантажити мовні дані.
        try { await (Tts as any).requestInstallData(); } catch {}
      }

      try {
        const voices = await Promise.race([
          Tts.voices(),
          new Promise<null>(r => setTimeout(() => r(null), 2000)),
        ]) as any[] | null;
        const voiceId = voices ? pickAndroidVoice(voices) : null;
        if (voiceId) {
          try { await Tts.setDefaultVoice(voiceId); } catch {}
        }
      } catch {}

      try { await Tts.setDucking(true); } catch {}

      if (isMountedRef.current) {
        isReady.current        = true;
        reinitAttempts.current = 0;
      }
      return;
    }

    try {
      const voices = await Promise.race([
        Tts.voices(),
        new Promise<null>(r => setTimeout(() => r(null), 2000)),
      ]) as any[] | null;

      if (voices && voices.length > 0) {
        const filtered = voices.filter((v: any) => {
          const matchLang   = v.language === TTS_LANGUAGE || v.language?.startsWith(TTS_LANGUAGE + '-');
          const matchGender = TTS_VOICE_GENDER ? v.gender === TTS_VOICE_GENDER : true;
          const matchName   = TTS_VOICE_NAME_FILTER
          // @ts-ignore
            ? v.name?.toLowerCase().includes(TTS_VOICE_NAME_FILTER.toLowerCase())
            : true;
          return matchLang && matchGender && matchName;
        });

        const pick =
          filtered.find((v: any) => v.quality === 'enhanced') ??
          filtered[0] ??
          voices.find((v: any) => v.language === TTS_LANGUAGE) ??
          voices.find((v: any) => v.language?.startsWith('en'));

        if (pick?.id) {
          try { await Tts.setDefaultVoice(pick.id); } catch {}
        }
      }
    } catch {}

    try { await Tts.setDefaultLanguage(TTS_LANGUAGE); } catch {}
    try { await Tts.setDucking(true); }                catch {}

    if (isMountedRef.current) {
      isReady.current        = true;
      reinitAttempts.current = 0;
    }
  }, []);

  const reinitialize = useCallback(async () => {
    if (reinitAttempts.current >= MAX_REINIT_ATTEMPTS) return;
    if (!isMountedRef.current) return;
    reinitAttempts.current += 1;
    isReady.current = false;
    try { Tts.stop(); } catch {}
    await initialize();
  }, [initialize]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('blur', () => {
      // Екран втратив фокус (перейшли на інший екран або повернулися назад)
      forceStop();
    });

    return unsubscribe;
  }, [navigation, forceStop]);
  
  // ── НАТИВНІ ПОДІЇ ─────────────────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true;
    initialize();

    // Тільки для відловлення природного завершення озвучки
    const handleFinish = () => {
      setIsSpeaking(false);
    };

    const handleCancel = () => {
      if (suppressNextCancel.current) {
        suppressNextCancel.current = false;
        return;
      }
      setIsSpeaking(false);
    };

    // Помилка синтезу (Android: напр. голос недоступний) — інакше кнопка
    // лишалась би в стані "говорить" назавжди.
    const handleError = () => {
      setIsSpeaking(false);
    };

    Tts.addEventListener('tts-finish', handleFinish);
    Tts.addEventListener('tts-cancel', handleCancel);
    // 'tts-error' існує лише в Android-модулі; на iOS addListener на
    // непідтримувану подію кидає червону помилку RCTEventEmitter.
    if (IS_ANDROID) Tts.addEventListener('tts-error', handleError);

    const handleAppState = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        // Гарантована зупинка при згортанні застосунку
        forceStop();
      } else if (next === 'active') {
        // 🔴 ФІКС: тут раніше стояло `if (!isReady.current || Platform.OS === 'ios') reinitialize();`.
        // Умова `Platform.OS === 'ios'` через `||` робила весь вираз ЗАВЖДИ
        // true на iOS — тобто reinitialize() викликався на КОЖНЕ повернення
        // застосунку з фону (сповіщення, дзвінок, Control Center — будь-яке
        // згортання), навіть якщо TTS вже й так був повністю готовий
        // (isReady.current === true). Кожен такий reinit — це Tts.stop(),
        // повторний запит голосів через Promise.race з 2-секундним
        // таймаутом і повторне setDefaultVoice/Language/Ducking. Це і
        // пояснює багаторазові "Error fetching voices" в лозі — не одна
        // помилка, а той самий цикл reinit, що виконувався знову й знову.
        // Прибрано зайву умову — reinit тепер лише тоді, коли TTS дійсно
        // ще не готовий.
        if (!isReady.current) reinitialize();
      }
    };
    const appSub = AppState.addEventListener('change', handleAppState);

    return () => {
      isMountedRef.current = false;
      appSub.remove();

      try {
        (Tts as any).removeEventListener('tts-finish', handleFinish);
        (Tts as any).removeEventListener('tts-cancel', handleCancel);
        if (IS_ANDROID) (Tts as any).removeEventListener('tts-error', handleError);
      } catch {}

      if (pendingTimeout.current) {
        clearTimeout(pendingTimeout.current);
        pendingTimeout.current = null;
      }

      try { Tts.stop(); } catch {}
    };
  }, [initialize, reinitialize, setIsSpeaking, forceStop]);

  // ── SPEAK ─────────────────────────────────────────────────────────────────

  const speak = useCallback((text: string, options?: SpeakOptions) => {
    if (!text?.trim()) return;

    const rate = options?.rate ?? currentRate.current;
    currentRate.current = rate;

    if (pendingTimeout.current) {
      clearTimeout(pendingTimeout.current);
      pendingTimeout.current = null;
    }

    try { Tts.stop(); } catch {}

    // Одразу виставляємо true — UI реагує без затримки
    setIsSpeaking(true);

    pendingTimeout.current = setTimeout(async () => {
      if (!isMountedRef.current) {
        setIsSpeaking(false);
        return;
      }

      // Шкали швидкості різні: на iOS 0.5 — звичайна швидкість, на Android
      // 1.0. Без skipTransform бібліотека сама переводить 0.5 → 1.0 на Android
      // (на iOS перетворення тотожне), тож звучання однакове на обох.
      try { await Tts.setDefaultRate(rate, !IS_ANDROID); } catch {}

      try {
        // Android відхиляє speak(), якщо не віддав аудіофокус (дзвінок тощо),
        // і тоді жодної події finish/cancel не буде — скидаємо стан самі.
        const result: any = Tts.speak(text);
        if (result && typeof result.catch === 'function') {
          result.catch(() => setIsSpeaking(false));
        }
      } catch (err: any) {
        console.error('[useTts] speak() error:', err?.message ?? err);
        setIsSpeaking(false);
        if (isReady.current) {
          isReady.current        = false;
          reinitAttempts.current = 0;
          initialize().catch(() => {});
        }
      }
    }, 150);
  }, [initialize, setIsSpeaking]);

  // ── STOP ──────────────────────────────────────────────────────────────────

  const stop = useCallback((silent?: boolean) => {
    if (pendingTimeout.current) {
      clearTimeout(pendingTimeout.current);
      pendingTimeout.current = null;
    }

    if (silent) {
      suppressNextCancel.current = true;
    } else {
      setIsSpeaking(false);
    }

    try { Tts.stop(); } catch {}
  }, [setIsSpeaking]);

  // ── SET ACTIVE PAGE — при зміні сторінки зупиняємо примусово ─────────────
  // Компонент передає поточну сторінку — якщо змінилась і йде озвучка → стоп

  const setActivePage = useCallback((page: number) => {
    if (activePageRef.current !== -1 && activePageRef.current !== page) {
      // Сторінка змінилась — примусово зупиняємо незалежно від будь-яких умов
      if (isSpeakingRef.current) {
        forceStop();
      }
    }
    activePageRef.current = page;
  }, [forceStop]);

  return { speak, stop, isSpeaking, setActivePage };
};