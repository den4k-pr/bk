import AsyncStorage from '@react-native-async-storage/async-storage';
import { InteractionManager } from 'react-native';
import { logLifecycleEvent } from '../utils/lifecycleLogger';
import { setDiagnosticContext } from '../utils/jsThreadWatchdog';

export const NAVIGATION_STATE_VERSION = 1;

// Скільки часу без активності "сесія" живе: після цього застосунок
// відкривається з Головної (і Словник знову прокручує цифри — див.
// dictionaryEntryTracker).
export const SESSION_MAX_AGE_MS = 60 * 60 * 1000;

const NAV_STATE_STORAGE_KEY = '@navigation_state';
const NAV_RESTORE_MARKER_KEY = '@navigation_restore_marker';

const MAX_PERSISTED_STATE_BYTES = 200_000;

const SAVE_DEBOUNCE_MS = 400;

const NON_RESTORABLE_FOCUSED_ROUTE_NAMES = new Set<string>(['Cards']);

// Екрани авторизації та відновлення пароля не зберігаємо і не відновлюємо:
// після холодного старту неавторизований користувач завжди починає зі
// StartScreen (initialRouteName для AuthStack). Екрани SendEmail /
// ResetPassword / CheckCode до того ж залежать від контексту (введена пошта,
// код із листа), тому після відновлення були б порожніми або зламаними.
const NON_PERSISTABLE_FOCUSED_ROUTE_NAMES = new Set<string>([
  'StartScreen',
  'LoginPage',
  'RegisterPage',
  'SendEmail',
  'ResetPassword',
  'CheckCode',
]);

export interface PersistableRoute {
  name: string;
  params?: Record<string, unknown>;
  state?: PersistableNavigationState;
}

export interface PersistableNavigationState {
  index?: number;
  routes: PersistableRoute[];
}

/**
 * Ключ "того самого екрана" — та сама логіка, що й getId у App.tsx (AppStack).
 * Екрани без ключа (форми Create/EditWord) лишаються як є.
 */
const routeIdentity = (route: PersistableRoute): string | null => {
  const p: any = route.params ?? {};
  switch (route.name) {
    case 'Gramer':
      return `Gramer:${p.categoryId ?? p.category?.id ?? ''}:${p.videoId ?? ''}`;
    case 'TasksPage':
      return `TasksPage:${p.courseId ?? ''}:${p.taskId ?? ''}:${p.stepId ?? ''}`;
    case 'ProductPage':
      return `ProductPage:${p.id ?? ''}`;
    case 'Create':
    case 'EditWord':
      return null;
    default:
      return route.name;
  }
};

/**
 * Прибирає дублікати екранів верхнього рівня (лишає останню копію, у тому
 * числі сфокусовану). Старі версії через navigate() накопичували стек на
 * кшталт Home→Course→Home→Course…, і відновлення монтувало всі копії разом —
 * це й давало шквал однакових запитів на старті.
 */
export function compactNavigationStack(state: PersistableNavigationState): PersistableNavigationState {
  if (!Array.isArray(state.routes) || state.routes.length < 2) return state;
  const focusedIndex = typeof state.index === 'number' ? state.index : state.routes.length - 1;
  const focused = state.routes[focusedIndex];

  const seen = new Set<string>();
  const kept: PersistableRoute[] = [];
  for (let i = state.routes.length - 1; i >= 0; i--) {
    const route = state.routes[i];
    const id = routeIdentity(route);
    if (route !== focused && id !== null && seen.has(id)) continue;
    if (id !== null) seen.add(id);
    kept.unshift(route);
  }

  if (kept.length === state.routes.length) return state;
  return { ...state, routes: kept, index: Math.max(0, kept.indexOf(focused)) };
}

interface PersistedEnvelope {
  version: number;
  savedAt: number;
  state: PersistableNavigationState;
}

let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSaveState: PersistableNavigationState | null = null;
let lastKnownState: PersistableNavigationState | null = null;

function isPlausibleRouteShape(route: unknown): route is PersistableRoute {
  if (!route || typeof route !== 'object') return false;
  const r = route as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return false;
  if (r.state !== undefined && !isPlausibleStateShape(r.state)) return false;
  return true;
}

function isPlausibleStateShape(state: unknown): state is PersistableNavigationState {
  if (!state || typeof state !== 'object') return false;
  const s = state as Record<string, unknown>;
  if (!Array.isArray(s.routes) || s.routes.length === 0) return false;
  if (s.index !== undefined && (typeof s.index !== 'number' || s.index < 0 || s.index >= s.routes.length)) {
    return false;
  }
  return s.routes.every(isPlausibleRouteShape);
}

const isFinitePositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;

const BOOKS_STACK_ROUTE_NAMES = new Set(['BookList', 'BookDetails', 'BookReader']);

function isValidBooksBranchState(state: PersistableNavigationState): boolean {
  return state.routes.every((route) => {
    if (!BOOKS_STACK_ROUTE_NAMES.has(route.name)) return false;
    if (route.name === 'BookList') return true;

    const params = route.params as { bookId?: unknown; level?: unknown; pageId?: unknown } | undefined;
    if (!params) return false;
    if (!isFinitePositiveInt(params.bookId)) return false;
    if (typeof params.level !== 'string' || params.level.length === 0) return false;

    if (route.name === 'BookReader' && params.pageId !== undefined && !isFinitePositiveInt(params.pageId)) {
      return false;
    }

    return true;
  });
}

function isBooksBranchValidIfPresent(state: PersistableNavigationState): boolean {
  for (const route of state.routes) {
    if (route.name === 'Books' && route.state) {
      return isValidBooksBranchState(route.state);
    }
    if (route.state && !isBooksBranchValidIfPresent(route.state)) {
      return false;
    }
  }
  return true;
}

export function getDeepestFocusedRouteName(state: PersistableNavigationState | undefined): string | undefined {
  if (!state || !Array.isArray(state.routes) || state.routes.length === 0) return undefined;
  const index = typeof state.index === 'number' ? state.index : state.routes.length - 1;
  const route = state.routes[index];
  if (!route) return undefined;
  if (route.state) return getDeepestFocusedRouteName(route.state);
  return route.name;
}

function isPlausibleNavigationState(
  candidate: unknown,
  allowedTopLevelRouteNames: ReadonlySet<string>,
): candidate is PersistableNavigationState {
  if (!isPlausibleStateShape(candidate)) return false;

  const topLevelNamesValid = candidate.routes.every((r) => allowedTopLevelRouteNames.has(r.name));
  if (!topLevelNamesValid) return false;

  return isBooksBranchValidIfPresent(candidate);
}

export interface LoadNavigationStateResult {
  state: PersistableNavigationState | undefined;
  restoredIntoBookReader: boolean;
}

export async function loadPersistedNavigationState(
  allowedTopLevelRouteNames: ReadonlyArray<string>,
): Promise<LoadNavigationStateResult> {
  const safeResult: LoadNavigationStateResult = { state: undefined, restoredIntoBookReader: false };

  try {
    const incompleteLastTime = await wasLastRestoreAttemptIncomplete();
    if (incompleteLastTime) {
      logLifecycleEvent('navigation_restore_skipped_crash_loop', {
        reason: 'previous session never reached onReady after restoring persisted state',
      });
      await clearPersistedNavigationState();
      return safeResult;
    }

    const raw = await AsyncStorage.getItem(NAV_STATE_STORAGE_KEY);
    if (!raw) return safeResult;

    let envelope: PersistedEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch (parseError) {
      logLifecycleEvent('navigation_restore_failed', { reason: 'invalid_json' });
      await clearPersistedNavigationState();
      return safeResult;
    }

    if (!envelope || envelope.version !== NAVIGATION_STATE_VERSION) {
      logLifecycleEvent('navigation_restore_failed', {
        reason: 'version_mismatch',
        storedVersion: envelope?.version,
        currentVersion: NAVIGATION_STATE_VERSION,
      });
      await clearPersistedNavigationState();
      return safeResult;
    }

    const ageMs = Date.now() - envelope.savedAt;
    if (ageMs >= SESSION_MAX_AGE_MS) {
      logLifecycleEvent('navigation_restore_failed', {
        reason: 'session_expired',
        ageMs,
        maxAgeMs: SESSION_MAX_AGE_MS,
      });
      await clearPersistedNavigationState();
      return safeResult;
    }

    const allowedSet = new Set(allowedTopLevelRouteNames);
    if (!isPlausibleNavigationState(envelope.state, allowedSet)) {
      logLifecycleEvent('navigation_restore_failed', { reason: 'schema_validation_failed' });
      await clearPersistedNavigationState();
      return safeResult;
    }

    const deepestFocusedRouteName = getDeepestFocusedRouteName(envelope.state);

    // Блокуємо і «нестабільні» екрани (Cards), і екрани авторизації —
    // останнє також відкидає стан, який міг лишитися на пристроях від
    // попередніх версій застосунку.
    if (
      deepestFocusedRouteName &&
      (NON_RESTORABLE_FOCUSED_ROUTE_NAMES.has(deepestFocusedRouteName) ||
        NON_PERSISTABLE_FOCUSED_ROUTE_NAMES.has(deepestFocusedRouteName))
    ) {
      logLifecycleEvent('navigation_restore_skipped_blocked_route', {
        routeName: deepestFocusedRouteName,
      });
      await clearPersistedNavigationState();
      return safeResult;
    }

    const restoredIntoBookReader = deepestFocusedRouteName === 'BookReader';

    logLifecycleEvent('navigation_restore_completed', { restoredIntoBookReader });
    return { state: compactNavigationStack(envelope.state), restoredIntoBookReader };
  } catch (error) {
    logLifecycleEvent('persistence_error', { where: 'loadPersistedNavigationState' });
    return safeResult;
  }
}

async function persistNavigationStateNow(state: PersistableNavigationState): Promise<void> {
  // Єдине місце запису на диск (його викликають і scheduleNavigationStatePersist,
  // і flushPendingNavigationStateSave), тому перевірка тут закриває всі шляхи.
  const focusedRouteName = getDeepestFocusedRouteName(state);
  if (focusedRouteName && NON_PERSISTABLE_FOCUSED_ROUTE_NAMES.has(focusedRouteName)) {
    // Не просто пропускаємо запис, а стираємо і старий стан: інакше після
    // виходу з акаунта на диску лишився б стан із попередньої сесії
    // (наприклад, Books), і холодний старт відновив би його.
    await clearPersistedNavigationState();
    return;
  }

  try {
    setDiagnosticContext({ lastHeavyOp: 'nav-state-persist', lastHeavyOpAt: Date.now() });

    const envelope: PersistedEnvelope = {
      version: NAVIGATION_STATE_VERSION,
      savedAt: Date.now(),
      state: compactNavigationStack(state),
    };
    const serialized = JSON.stringify(envelope);

    if (serialized.length > MAX_PERSISTED_STATE_BYTES) {
      logLifecycleEvent('navigation_state_persist_failed', {
        reason: 'state_too_large',
        bytes: serialized.length,
      });
      return;
    }

    await AsyncStorage.setItem(NAV_STATE_STORAGE_KEY, serialized);
    logLifecycleEvent('navigation_state_persisted', {
      focusedRoute: getDeepestFocusedRouteName(state),
    });
  } catch (error) {
    logLifecycleEvent('navigation_state_persist_failed', { reason: 'storage_error' });
  } finally {
    setDiagnosticContext({ lastHeavyOp: null });
  }
}

export function scheduleNavigationStatePersist(state: PersistableNavigationState | undefined): void {
  if (!state) return;

  lastKnownState = state;
  pendingSaveState = state;

  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    const toSave = pendingSaveState;
    pendingSaveState = null;
    if (toSave) {
      InteractionManager.runAfterInteractions(() => {
        persistNavigationStateNow(toSave).catch(() => {});
      });
    }
  }, SAVE_DEBOUNCE_MS);
}

export async function flushPendingNavigationStateSave(): Promise<void> {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  const toSave = pendingSaveState ?? lastKnownState;
  pendingSaveState = null;
  if (toSave) {
    await persistNavigationStateNow(toSave);
  }
}

export async function clearPersistedNavigationState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(NAV_STATE_STORAGE_KEY);
  } catch (error) {
    logLifecycleEvent('persistence_error', { where: 'clearPersistedNavigationState' });
  }
}

export async function markNavigationRestoreAttemptStarted(): Promise<void> {
  try {
    await AsyncStorage.setItem(NAV_RESTORE_MARKER_KEY, 'pending');
  } catch (error) {

  }
}

export async function markNavigationRestoreAttemptCompleted(): Promise<void> {
  try {
    await AsyncStorage.removeItem(NAV_RESTORE_MARKER_KEY);
  } catch (error) {

  }
}

async function wasLastRestoreAttemptIncomplete(): Promise<boolean> {
  try {
    const marker = await AsyncStorage.getItem(NAV_RESTORE_MARKER_KEY);
    return marker === 'pending';
  } catch (error) {
    return false;
  }
}