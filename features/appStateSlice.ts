import { createSlice, createAsyncThunk, PayloadAction } from "@reduxjs/toolkit";
import { getInitialAppData, InitialDataResponse } from "../services/apiService";
import { loadProgressFromCache } from "./progressSimpleSlice";
import { loadUserProgressFromCache } from "./userProgress";
import { AppError } from "../pages/ErrorScreen";
import { TimeoutError } from "../utils/withTimeout";
import { isSessionExpiredError } from "../utils/sessionExpiredError";

// Причина відхилення initializeApp, коли сесія просто закінчилась.
// Це не помилка: мережевий шар уже розлогінив користувача (екран входу),
// тож ErrorScreen для цього не показується.
export const INIT_SESSION_EXPIRED = "__SESSION_EXPIRED__";

interface AppState {
  isAppReady: boolean;
  isLoading: boolean;
  error: string | null;
  globalError: AppError | null;
  /**
   * Дані вже хоч раз успішно завантажились у цій сесії. Повторні
   * initializeApp (повернення з фону, після покупки) тоді йдуть "тихо":
   * без прелоадера на весь екран і без ErrorScreen при збої — застосунок
   * лишається з наявними даними.
   */
  hasInitializedOnce: boolean;
}

const initialState: AppState = {
  isAppReady: false,
  isLoading: false,
  error: null,
  globalError: null,
  hasInitializedOnce: false,
};

// 🟢 Мовчазний ретрай перед тим, як здатись і показати ErrorScreen.
// Юзер весь цей час бачить ЛИШЕ Preloader (isLoading залишається true) —
// жодного натяку на помилку, поки не вичерпані всі спроби.
const INIT_RETRY_ATTEMPTS = 3;
const INIT_RETRY_DELAY_MS = 1500;

// 🔴 ФІКС (критично): раніше App.tsx мав ОКРЕМИЙ, жорстко зашитий
// INIT_WATCHDOG_MS = 20000, зовсім не пов'язаний з реальним найгіршим
// часом циклу нижче. У найгіршому випадку (усі спроби впали через
// мережевий таймаут) цей цикл виконується:
//   INIT_REQUEST_TIMEOUT_MS_ASSUMED * INIT_RETRY_ATTEMPTS
//   + INIT_RETRY_DELAY_MS * (сума затримок між спробами)
// Якщо зовнішній watchdog в App.tsx спрацьовує РАНІШЕ, ніж цей цикл
// встигає легітимно завершитись, він показує ErrorScreen ПОКИ thunk ще
// мовчки повторює спроби — і раніше, якщо thunk потім все ж успішно
// резолвився, цей хибний ErrorScreen НІКОЛИ не зникав (бо
// initializeApp.fulfilled не чистив globalError — див. фікс нижче).
// Тепер App.tsx імпортує саме це число замість власного довільного.
//
// ⚠️ ПРИПУЩЕННЯ: getInitialAppData() (apiService.ts) обгорнутий власним
// withTimeout з припущеним таймаутом INIT_REQUEST_TIMEOUT_MS_ASSUMED мс
// на спробу (той самий патерн, що й AUTH_CHECK_TIMEOUT_MS в
// AuthContext.tsx, і той самий REQUEST_TIMEOUT_MS, що в api.ts). Якщо
// реальний таймаут усередині apiService.getInitialAppData інший —
// онови це число, щоб воно точно відповідало реальності.
const INIT_REQUEST_TIMEOUT_MS_ASSUMED = 15000;

export const INIT_WORST_CASE_MS =
  INIT_REQUEST_TIMEOUT_MS_ASSUMED * INIT_RETRY_ATTEMPTS +
  INIT_RETRY_DELAY_MS * ((INIT_RETRY_ATTEMPTS - 1) * INIT_RETRY_ATTEMPTS) / 2;

const sleep = (ms: number) => new Promise((resolve: any) => setTimeout(resolve, ms));

export const initializeApp = createAsyncThunk<InitialDataResponse>(
  "app/initializeApp",
  async (_, { rejectWithValue, dispatch }) => {
    // Кеш вантажимо паралельно, без очікування — це не мережеві запити,
    // тож ризику зависання тут немає.
    dispatch(loadProgressFromCache());
    dispatch(loadUserProgressFromCache());

    let lastErrorMessage = 'Не вдалося завантажити дані застосунку';

    for (let attempt = 1; attempt <= INIT_RETRY_ATTEMPTS; attempt++) {
      try {
        // getInitialAppData вже сам обгорнутий withTimeout всередині apiService,
        // тож ця обіцянка гарантовано або резолвиться, або зареджектиться
        // максимум за ~15 секунд на спробу.
        const data = await getInitialAppData();
        return data;
      } catch (err: any) {
        // Сесія закінчилась — повтори марні, користувача вже перекинуто на вхід.
        if (isSessionExpiredError(err)) {
          console.log('[INIT] Сесія закінчилась — без ErrorScreen, перехід на екран входу.');
          return rejectWithValue(INIT_SESSION_EXPIRED);
        }

        const isTimeout = err instanceof TimeoutError;
        const status = err?.response?.status;

        lastErrorMessage = isTimeout
          ? 'Сервер не відповідає. Перевірте інтернет-з’єднання та спробуйте ще раз.'
          : (err.response?.data?.message || err.message || 'Не вдалося завантажити дані застосунку');

        console.warn(
          `[INIT] Спроба ${attempt}/${INIT_RETRY_ATTEMPTS} не вдалась: ${lastErrorMessage}` +
          (isTimeout ? ' (TIMEOUT)' : status ? ` (HTTP ${status})` : ''),
        );

        const isLastAttempt = attempt === INIT_RETRY_ATTEMPTS;
        if (isLastAttempt) {
          console.error('[INIT] Усі спроби вичерпано, показуємо помилку:', lastErrorMessage);
          return rejectWithValue(lastErrorMessage);
        }

        // Коротка пауза перед наступною мовчазною спробою — юзер весь цей
        // час бачить лише Preloader, нічого не змінюється на екрані.
        await sleep(INIT_RETRY_DELAY_MS * attempt);
      }
    }

    return rejectWithValue(lastErrorMessage);
  }
);

const appStateSlice = createSlice({
  name: "appState",
  initialState,
  reducers: {
    setAppReady(state, action: PayloadAction<boolean>) {
      state.isAppReady = action.payload;
    },
    // Вихід з акаунта: наступний вхід — знову "перший" запуск (з прелоадером
    // і ErrorScreen, якщо даних отримати не вдалося).
    resetAppInit(state) {
      state.hasInitializedOnce = false;
      state.isAppReady = false;
      state.isLoading = false;
      state.error = null;
      state.globalError = null;
    },
    setGlobalError(state, action: PayloadAction<AppError>) {
      state.globalError = action.payload;
      state.isLoading = false;
      state.isAppReady = false;
    },
    clearGlobalError(state) {
      state.globalError = null;
      state.isLoading = true;
      state.error = null;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(initializeApp.pending, (state) => {
        // Повторне оновлення — тихо, поверх уже показаних даних.
        if (!state.hasInitializedOnce) {
          state.isLoading = true;
          state.isAppReady = false;
        }
        state.error = null;
        state.globalError = null;
      })
      .addCase(initializeApp.fulfilled, (state) => {
        state.isLoading = false;
        state.isAppReady = true;
        state.hasInitializedOnce = true;
        // 🔴 ФІКС (критично): раніше globalError/error НЕ чистились тут.
        // Якщо зовнішній watchdog (App.tsx) встиг виставити globalError
        // ПОКИ цей thunk ще мовчки ретраївся, а thunk потім УСЕ Ж
        // успішно резолвився — без цього фіксу застосунок назавжди
        // застрягав на ErrorScreen поверх повністю завантаженого
        // AppStack, бо жодна гілка коду більше ніколи не чистила
        // globalError після цього моменту.
        state.error = null;
        state.globalError = null;
      })
      .addCase(initializeApp.rejected, (state, action) => {
        state.isLoading = false;
        // Сесія закінчилась — це не помилка (див. INIT_SESSION_EXPIRED).
        // Повторне оновлення не вдалося — лишаємось з наявними даними.
        if (action.payload === INIT_SESSION_EXPIRED || state.hasInitializedOnce) {
          state.isAppReady = state.hasInitializedOnce;
          state.error = null;
          state.globalError = null;
          return;
        }
        state.isAppReady = false;
        state.error = action.payload as string;
        // 🔴 ФІКС: гарантуємо, що одночасно існує ЛИШЕ ОДНЕ джерело
        // помилки (error АБО globalError, не обидва) — інакше
        // RootNavigation's `error || globalError` міг непередбачувано
        // рендерити застарілий globalError замість щойно отриманого
        // (і правильно типізованого) error.
        state.globalError = null;
        console.error("[APP ERROR]", state.error);
      });
  },
});

export const { setAppReady, setGlobalError, clearGlobalError, resetAppInit } = appStateSlice.actions;
export default appStateSlice.reducer;