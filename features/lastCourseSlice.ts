import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'last_opened_course';

export interface LastCourseState {
  categoryId: number | null;
  imageKey: string | null;
  openedAt: number | null;
  hydrated: boolean;
}

const initialState: LastCourseState = {
  categoryId: null,
  imageKey: null,
  openedAt: null,
  hydrated: false,
};

export const loadLastCourse = createAsyncThunk<Partial<LastCourseState> | null>(
  'lastCourse/load',
  async () => {
    try {
      const userId = await AsyncStorage.getItem('userId');
      if (!userId) return null;

      const json = await AsyncStorage.getItem(`${STORAGE_KEY}_${userId}`);
      if (!json) return null;

      const parsed = JSON.parse(json);
      if (!parsed || !Number.isFinite(Number(parsed.categoryId))) return null;

      return {
        categoryId: Number(parsed.categoryId),
        imageKey: parsed.imageKey ?? null,
        openedAt: Number(parsed.openedAt) || null,
      };
    } catch (e) {
      console.warn('[LAST_COURSE] load error', e);
      return null;
    }
  }
);

export const rememberLastCourse = createAsyncThunk<
  { categoryId: number; imageKey: string | null; openedAt: number } | null,
  { categoryId: number | string; imageKey?: string | null }
>('lastCourse/remember', async ({ categoryId, imageKey }) => {
  const numericId = Number(categoryId);
  if (!Number.isFinite(numericId)) return null;

  const payload = {
    categoryId: numericId,
    imageKey: imageKey ?? null,
    openedAt: Date.now(),
  };

  try {
    const userId = await AsyncStorage.getItem('userId');
    if (userId) {
      await AsyncStorage.setItem(`${STORAGE_KEY}_${userId}`, JSON.stringify(payload));
    }
  } catch (e) {
    console.warn('[LAST_COURSE] save error', e);
  }

  return payload;
});

export const clearLastCourse = createAsyncThunk('lastCourse/clear', async () => {
  try {
    const userId = await AsyncStorage.getItem('userId');
    if (userId) {
      await AsyncStorage.removeItem(`${STORAGE_KEY}_${userId}`);
    }
  } catch (e) {
    console.warn('[LAST_COURSE] clear error', e);
  }
});

const lastCourseSlice = createSlice({
  name: 'lastCourse',
  initialState,
  reducers: {
    setLastCourseLocal: (
      state,
      action: PayloadAction<{ categoryId: number; imageKey?: string | null }>
    ) => {
      state.categoryId = Number(action.payload.categoryId);
      state.imageKey = action.payload.imageKey ?? null;
      state.openedAt = Date.now();
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLastCourse.fulfilled, (state, action) => {
        if (action.payload) {
          state.categoryId = action.payload.categoryId ?? null;
          state.imageKey = action.payload.imageKey ?? null;
          state.openedAt = action.payload.openedAt ?? null;
        }
        state.hydrated = true;
      })
      .addCase(loadLastCourse.rejected, (state) => {
        state.hydrated = true;
      })
      .addCase(rememberLastCourse.fulfilled, (state, action) => {
        if (action.payload) {
          state.categoryId = action.payload.categoryId;
          state.imageKey = action.payload.imageKey;
          state.openedAt = action.payload.openedAt;
        }
      })
      .addCase(clearLastCourse.fulfilled, (state) => {
        state.categoryId = null;
        state.imageKey = null;
        state.openedAt = null;
      });
  },
});

export const { setLastCourseLocal } = lastCourseSlice.actions;
export default lastCourseSlice.reducer;