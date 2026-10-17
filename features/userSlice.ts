// src/features/userSlice.ts

import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { updateLevel as updateLevelAPI, getWordStats } from './../services/authService';
import { initializeApp } from './appStateSlice';
import { RootState } from '../../store';

// --- Інтерфейси ---
export interface ProgramStat {
  label: string;
  type: string;
  learned: number;
  total: number;
}

interface UserState {
  level: string | null;
  wordStats: ProgramStat[]; // Тепер це масив нової статистики
  userDate: string | null;
  status: 'idle' | 'loading' | 'failed';
  error: string | null;
  guideCompleted: boolean | null;
}

// --- Початковий стан ---
const initialState: UserState = {
  level: null,
  wordStats: [],
  userDate: null,
  status: 'idle',
  error: null,
  guideCompleted: null,
};

// --- Thunks ---
// В userSlice.ts
export const fetchWordStats = createAsyncThunk<ProgramStat[], string, { state: RootState }>(
  'user/fetchWordStats',
  async (level, { rejectWithValue }) => {
    try {
      // ПЕРЕДАЄМО РІВЕНЬ НА БЕКЕНД!
      // Припускаємо, що getWordStats приймає level як аргумент
      const data = await getWordStats(level);
      if (!data) throw new Error('Failed to fetch word stats');
      return data;
    } catch (error: any) {
      return rejectWithValue(error.message);
    }
  },
  {
    // 🔴 ФІКС (реальний, підтверджений логами баг): /programs/stats/A1
    // викликався до 4 разів поспіль в межах однієї секунди одразу після
    // /app/init. Причина — Analytics.tsx має
    // `useEffect(() => { if (level && !isQueueActive) dispatch(fetchWordStats(level)) }, [level, isQueueActive, dispatch])`.
    // Коли initializeApp.fulfilled виставляє level ('A1') і
    // isQueueActive перемикається кілька разів поспіль під час старту
    // (перехідні редюсер-стани), КОЖЕН такий перехід перезапускає цей
    // ефект — а замикання ефекту читає status на момент СВОГО рендеру,
    // тож встигає продиспатчити ще один запит ДО того, як попередній
    // dispatch синхронно виставив status='loading' (той самий клас
    // гонки, що вже виправлено в guideSlice.ts::fetchCompletedGuides).
    // До того ж ці дані вже прийшли БЕЗКОШТОВНО разом з /app/init
    // (initializeApp.fulfilled уже кладе wordStats) — цей запит у
    // переважній більшості випадків узагалі надлишковий.
    //
    // `condition` перевіряється проти АКТУАЛЬНОГО стану сховища в
    // момент диспатчу (не застарілого замикання компонента) — якщо
    // запит уже виконується, новий диспатч просто НЕ стартує (жодного
    // мережевого запиту, жодного зайвого pending/rejected).
    condition: (_level, { getState }) => {
      const state = getState();
      return state.user.status !== 'loading';
    },
  },
);

export const updateUserLevel = createAsyncThunk<
  { level: string; wordStats: ProgramStat[] },
  string,
  { state: RootState }
>('user/updateLevel', async (level, { rejectWithValue }) => {
  try {
    await updateLevelAPI(level); // 1. Оновлюємо рівень на бекенді

    // 2. Запитуємо статистику САМЕ ДЛЯ ЦЬОГО РІВНЯ
    const data = await getWordStats(level);

    return {
      level: level,
      wordStats: data || [],
    };
  } catch (error: any) {
    return rejectWithValue(error.message);
  }
});
// --- Слайс ---
const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    clearUserData: (state) => {
      state.level = null;
      state.wordStats = [];
      state.userDate = null;
      state.status = 'idle';
      state.error = null;
      state.guideCompleted = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // --- Update Level ---
      .addCase(updateUserLevel.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(updateUserLevel.fulfilled, (state, action) => {
        state.status = 'idle';
        state.level = action.payload.level;
        state.wordStats = action.payload.wordStats || [];
      })
      .addCase(updateUserLevel.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload as string;
      })
      // --- Initialize App ---
      .addCase(initializeApp.fulfilled, (state, action) => {
        const payload = action.payload as any;

        if (payload.userStats) {
          // Дістаємо масив статистики
          state.wordStats = payload.userStats || [];

          // Витягуємо дані користувача з вкладеного об'єкта
          const userData = payload.dailyWord?.user;

          if (userData) {
            state.level = userData.level || 'A1';
            state.userDate = userData.someDate || null; // В інсомнії дата називається someDate
            state.guideCompleted = Boolean(userData.guideCompleted);
          } else {
            state.level = 'A1'; // Фоллбек
          }

          state.status = 'idle';
        } else {
          console.error('❌ Дані статистики відсутні в payload');
        }
      })
      // --- Fetch Word Stats ---
      .addCase(fetchWordStats.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchWordStats.fulfilled, (state, action: PayloadAction<ProgramStat[]>) => {
        state.status = 'idle';
        state.wordStats = action.payload || [];
      })
      .addCase(fetchWordStats.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload as string;
      });
  },
});

export const { clearUserData } = userSlice.actions;
export default userSlice.reducer;