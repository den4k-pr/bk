import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

/** Локальна копія пройдених гайдів (працює офлайн і поки сервер не відповів). */
export const LOCAL_COMPLETED_GUIDES_KEY = '@completed_guides_local';
// Ключ старої версії застосунку (GuideProvider) — щоб пройдене тоді не губилось.
const LEGACY_LOCAL_GUIDES_KEY = 'LOCAL_COMPLETED_GUIDES';

interface GuideState {
  completedGuides: string[];
  status: 'idle' | 'loading' | 'succeeded' | 'failed';
  // Гайди, які зараз АКТИВНІ на екрані (по одному на екран, але через стек
  // навігації їх може бути кілька). Потрібно, щоб глобальні оверлеї
  // (напр. NotificationModal) не накладалися на гайд і не конфліктували
  // двома Modal одночасно.
  activeGuides: string[];
}

const initialState: GuideState = {
  completedGuides: [],
  status: 'idle',
  activeGuides: [],
};

const readList = async (key: string): Promise<string[]> => {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((g) => typeof g === 'string') : [];
  } catch {
    return [];
  }
};

export const readLocalCompletedGuides = async (): Promise<string[]> => {
  const [current, legacy] = await Promise.all([
    readList(LOCAL_COMPLETED_GUIDES_KEY),
    readList(LEGACY_LOCAL_GUIDES_KEY),
  ]);
  return Array.from(new Set([...current, ...legacy]));
};

export const addLocalCompletedGuides = async (guides: string[]): Promise<void> => {
  if (!guides.length) return;
  try {
    const current = await readList(LOCAL_COMPLETED_GUIDES_KEY);
    const merged = Array.from(new Set([...current, ...guides]));
    if (merged.length !== current.length) {
      await AsyncStorage.setItem(LOCAL_COMPLETED_GUIDES_KEY, JSON.stringify(merged));
    }
  } catch {
    return;
  }
};

/**
 * Пройдені гайди з сервера + двостороння синхронізація з локальною копією:
 *  - серверний список зберігається локально — якщо наступного разу сервер
 *    не відповість (немає мережі, оновлюється токен), пройдений гайд усе
 *    одно не покажеться;
 *  - гайди, пройдені офлайн (POST тоді не дійшов), дописуються на сервер.
 */
export const fetchCompletedGuides = createAsyncThunk(
  'guide/fetchCompletedGuides',
  async () => {
    const response = await api.get('/users/me');
    const serverGuides: string[] = Array.isArray(response.data?.completedGuides)
      ? response.data.completedGuides
      : [];

    const localGuides = await readLocalCompletedGuides();
    await addLocalCompletedGuides(serverGuides);

    const missingOnServer = localGuides.filter((g) => !serverGuides.includes(g));
    missingOnServer.forEach((guideKey) => {
      api.post('/users/guide-completed', { guideKey }).catch(() => {});
    });

    return Array.from(new Set([...serverGuides, ...localGuides]));
  },
  {
    // Повторюємо й після збою — раніше один невдалий запит на старті
    // лишав статус 'failed' до кінця сесії.
    condition: (_, { getState }) => {
      const state = getState() as { guide: GuideState };
      return state.guide.status === 'idle' || state.guide.status === 'failed';
    },
  },
);

export const markGuideCompleted = createAsyncThunk(
  'guide/markGuideCompleted',
  async (guideKey: string) => {
    await addLocalCompletedGuides([guideKey]);
    const response = await api.post('/users/guide-completed', { guideKey });
    return Array.isArray(response.data?.completedGuides) ? (response.data.completedGuides as string[]) : null;
  },
);

const guideSlice = createSlice({
  name: 'guide',
  initialState,
  reducers: {
    // Вихід з акаунта: наступний користувач має отримати СВІЙ список.
    resetGuides: () => initialState,
    guideStarted: (state, action: PayloadAction<string>) => {
      if (!state.activeGuides.includes(action.payload)) {
        state.activeGuides.push(action.payload);
      }
    },
    guideFinished: (state, action: PayloadAction<string>) => {
      state.activeGuides = state.activeGuides.filter((name) => name !== action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCompletedGuides.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchCompletedGuides.fulfilled, (state, action: PayloadAction<string[]>) => {
        // Об'єднання: гайд, позначений поки йшов запит, не зникає.
        state.completedGuides = Array.from(new Set([...state.completedGuides, ...action.payload]));
        state.status = 'succeeded';
      })
      .addCase(fetchCompletedGuides.rejected, (state) => {
        state.status = 'failed';
      })
      .addCase(markGuideCompleted.pending, (state, action) => {
        const guideKey = action.meta.arg;
        if (!state.completedGuides.includes(guideKey)) {
          state.completedGuides = [...state.completedGuides, guideKey];
        }
      })
      .addCase(markGuideCompleted.fulfilled, (state, action: PayloadAction<string[] | null>) => {
        // Лише додаємо: відповідь сервера не може "забрати" пройдений гайд.
        if (action.payload) {
          state.completedGuides = Array.from(new Set([...state.completedGuides, ...action.payload]));
        }
      });
  },
});

export const { resetGuides, guideStarted, guideFinished } = guideSlice.actions;
export default guideSlice.reducer;
