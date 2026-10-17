

import { Platform, Linking } from 'react-native';
import {
  check,
  request,
  openSettings,
  PERMISSIONS,
  RESULTS,
  type Permission,
  type PermissionStatus,
} from 'react-native-permissions';

export type MicPermission = 'granted' | 'denied' | 'blocked' | 'unavailable';

const MICROPHONE_PERMISSION: Permission = Platform.select({
  ios: PERMISSIONS.IOS.MICROPHONE,
  android: PERMISSIONS.ANDROID.RECORD_AUDIO,
  default: PERMISSIONS.ANDROID.RECORD_AUDIO,
});

// На Android дозвіл на розпізнавання окремо не потрібен — його дає
// системний RecognitionService. На iOS це окремий дозвіл користувача.
const SPEECH_PERMISSION: Permission | null =
  Platform.OS === 'ios' ? PERMISSIONS.IOS.SPEECH_RECOGNITION : null;

const normalizeStatus = (status: PermissionStatus): MicPermission => {
  switch (status) {
    case RESULTS.GRANTED:
    case RESULTS.LIMITED:
      return 'granted';
    case RESULTS.DENIED:
      // Ще можна показати системний діалог.
      return 'denied';
    case RESULTS.BLOCKED:
      // Системний діалог більше не з'явиться. Тільки Налаштування.
      // Увага: на Android 11+ дві відмови поспіль дають саме цей стан,
      // навіть якщо людина не тиснула "більше не питати".
      return 'blocked';
    case RESULTS.UNAVAILABLE:
    default:
      return 'unavailable';
  }
};

/**
 * Тиха перевірка стану дозволу. Системний діалог НЕ показується.
 * Використовується для рендеру UI (як має виглядати кнопка).
 */
export const checkAudioPermission = async (): Promise<MicPermission> => {
  try {
    const micStatus = normalizeStatus(await check(MICROPHONE_PERMISSION));
    if (micStatus !== 'granted' || !SPEECH_PERMISSION) {
      return micStatus;
    }
    return normalizeStatus(await check(SPEECH_PERMISSION));
  } catch (e) {
    console.warn('[permissions] checkAudioPermission error:', e);
    return 'unavailable';
  }
};

/**
 * Активний запит дозволу. Показує системний діалог, якщо це ще можливо.
 * Якщо стан вже 'blocked' — діалог не з'явиться, повернеться 'blocked'.
 */
export const requestAudioPermission = async (): Promise<MicPermission> => {
  try {
    const micStatus = normalizeStatus(await request(MICROPHONE_PERMISSION));
    if (micStatus !== 'granted' || !SPEECH_PERMISSION) {
      return micStatus;
    }
    return normalizeStatus(await request(SPEECH_PERMISSION));
  } catch (e) {
    console.warn('[permissions] requestAudioPermission error:', e);
    return 'unavailable';
  }
};

/**
 * Відкриває сторінку налаштувань саме цього додатка.
 * Працює однаково на iOS та Android.
 *
 * Важливо про iOS: після зміни дозволу на мікрофон система ВБИВАЄ
 * процес додатка. Він перезапуститься з нуля, стан сесії втратиться.
 * Це нормальна поведінка iOS — про неї треба попередити в тексті діалогу.
 */
export const openAppSettings = async (): Promise<void> => {
  try {
    await openSettings();
  } catch (e) {
    console.warn('[permissions] openSettings error, fallback to Linking:', e);
    try {
      await Linking.openSettings();
    } catch (fallbackError) {
      console.warn('[permissions] Linking.openSettings error:', fallbackError);
    }
  }
};

/**
 * Сумісність зі старим кодом, який ще очікує boolean.
 * У нових місцях використовуй requestAudioPermission напряму.
 */
export const requestAudioPermissionLegacy = async (): Promise<boolean> => {
  const status = await requestAudioPermission();
  return status === 'granted';
};