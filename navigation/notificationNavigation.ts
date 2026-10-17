import { createNavigationContainerRef, StackActions } from '@react-navigation/native';
import type { FirebaseMessagingTypes } from '@react-native-firebase/messaging';

/** Посилання на кореневий NavigationContainer (для переходів поза компонентами). */
export const navigationRef = createNavigationContainerRef<any>();

type NotificationTarget =
  | { screen: 'Course' | 'CoursePlus' }
  /** Конкретний курс і (необов'язково) відео, яке одразу ввімкнути. */
  | { screen: 'Gramer'; categoryId: number; videoId?: number };

// Куди перейти, щойно навігація буде готова (холодний старт) або
// користувач увійде в акаунт (екрани курсів є лише в AppStack).
let pendingTarget: NotificationTarget | null = null;

const toId = (value: unknown): number | undefined => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/** Дані сповіщення про новий контент (push data або плашка в застосунку). */
export type NewContentData = Record<string, string | number | null | undefined>;

const targetFromData = (data: NewContentData | undefined): NotificationTarget | null => {
  if (!data || data.type !== 'new_content') return null;

  const categoryId = toId(data.categoryId);
  if (data.screen === 'Course' && categoryId) {
    return { screen: 'Gramer', categoryId, videoId: toId(data.videoId) };
  }
  // Старі пуші (без id) і преміум-курси — просто відповідний розділ.
  return data.screen === 'CoursePlus' ? { screen: 'CoursePlus' } : data.screen === 'Course' ? { screen: 'Course' } : null;
};

/** Перейти на екран, якщо навігація готова і цей екран зараз існує. */
export const flushPendingNotificationNavigation = () => {
  if (!pendingTarget || !navigationRef.isReady()) return;
  const routeNames = navigationRef.getRootState()?.routeNames ?? [];
  if (!routeNames.includes(pendingTarget.screen)) return; // напр. ще екран входу — чекаємо
  const target = pendingTarget;
  pendingTarget = null;

  if (target.screen === 'Gramer') {
    // push, а не navigate: якщо курс уже відкрито, новий відкриється поверх
    // з потрібним відео, а "назад" поверне туди, де людина була.
    navigationRef.dispatch(
      StackActions.push('Gramer', { categoryId: target.categoryId, videoId: target.videoId }),
    );
  } else {
    navigationRef.navigate(target.screen);
  }
};

/**
 * Натискання на push "новий контент": відкрити конкретний курс і одразу
 * ввімкнути нове відео; для старих пушів і преміум-курсів — відповідний
 * розділ. Інші сповіщення (слово дня тощо) просто відкривають застосунок.
 */
export const handleNotificationOpen = (message: FirebaseMessagingTypes.RemoteMessage | null) => {
  openNewContentTarget(message?.data as NewContentData | undefined);
};

/** Відкрити курс/відео з даних сповіщення (і push, і плашки в застосунку). */
export const openNewContentTarget = (data: NewContentData | undefined) => {
  const target = targetFromData(data);
  if (!target) return;
  pendingTarget = target;
  flushPendingNotificationNavigation();
};
