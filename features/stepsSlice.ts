import { createSlice, PayloadAction, createAsyncThunk } from "@reduxjs/toolkit";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RootState } from "../../store";

export interface Step {
  id: any;
  type: string;
  url: string;
  stepIndex: number;
  title?: string;
  totalPages?: number;
  audioTitle?: string | null;
  audioImage?: string | null;
  audioSubtitle?: string | null;
  audioList?: string[] | null;
}

export interface Task {
  id: number;
  title: string;
  steps: Step[];
}

export interface Progress {
  id: number;
  courseId: number;
  learned: { [taskId: string]: number[] };
}

interface StepsState {
  tasks: Task[];
  currentTaskIndex: number;
  currentStepIndex: number;
  progress: Progress | null;
  pendingLearnedSteps: { taskId: number; stepId: number }[];
  progressPercent: number;
}

const initialState: StepsState = {
  tasks: [],
  currentTaskIndex: 0,
  currentStepIndex: 0,
  progress: null,
  pendingLearnedSteps: [],
  progressPercent: 0,
};

export const loadProgressFromCache = createAsyncThunk(
  "steps/loadProgressFromCache",
  async (courseId: number, { rejectWithValue }) => {
    try {
      const userId = await AsyncStorage.getItem("userId");
      if (!userId) throw new Error("UserId not found in AsyncStorage");

      const cacheKey = `progress_${userId}_${courseId}`;
      const cachedProgress = await AsyncStorage.getItem(cacheKey);

      if (cachedProgress) {
        console.log("Progress loaded from cache for:", cacheKey);
        return JSON.parse(cachedProgress) as Progress;
      } else {
        console.log("No progress in cache for:", cacheKey, ". Creating new one.");
        return {
          id: Date.now(),
          courseId,
          learned: {},
        } as Progress;
      }
    } catch (error: any) {
      console.error("Failed to load progress from cache:", error);
      return rejectWithValue({ message: error.message });
    }
  }
);

export const saveProgressToCache = createAsyncThunk(
  "steps/saveProgressToCache",
  async (_, { getState, rejectWithValue }) => {
    const state = getState() as RootState;
    const { progress, pendingLearnedSteps } = state.steps;

    if (!progress || !progress.courseId) {
      return rejectWithValue("Save aborted: No progress data.");
    }

    const userId = await AsyncStorage.getItem("userId");
    if (!userId) return rejectWithValue("UserId not found in AsyncStorage");

    const cacheKey = `progress_${userId}_${progress.courseId}`;

    if (pendingLearnedSteps.length === 0) {
      console.log("No new steps to save to cache.");
      return progress;
    }

    const combinedLearned = { ...progress.learned };
    pendingLearnedSteps.forEach(({ taskId, stepId }) => {
      const taskIdStr = String(taskId);
      if (!combinedLearned[taskIdStr]) {
        combinedLearned[taskIdStr] = [];
      }
      if (!combinedLearned[taskIdStr].includes(stepId)) {
        combinedLearned[taskIdStr].push(stepId);
      }
    });

    const updatedProgress: Progress = {
      ...progress,
      learned: combinedLearned,
    };

    try {
      await AsyncStorage.setItem(cacheKey, JSON.stringify(updatedProgress));
      console.log("Saved progress to cache:", cacheKey);
      return updatedProgress;
    } catch (error: any) {
      console.error("Failed to save progress to cache:", error);
      return rejectWithValue({ message: error.message });
    }
  }
);

const stepsSlice = createSlice({
  name: "steps",
  initialState,
  reducers: {
    setTasks(state, action: PayloadAction<Task[]>) {
      const sortedTasks = [...action.payload].sort((a, b) => a.id - b.id);
      sortedTasks.forEach(task => {
        task.steps.sort((a, b) => a.stepIndex - b.stepIndex);
      });
      state.tasks = sortedTasks;
    },
    setCurrentTaskIndex(state, action: PayloadAction<number>) {
      if (action.payload < state.tasks.length) {
        state.currentTaskIndex = action.payload;
      }
    },
    setCurrentStepIndex(state, action: PayloadAction<number>) {
      state.currentStepIndex = action.payload;
    },
    markStepLearned(state, action: PayloadAction<{ taskId: number; stepId: number }>) {
      if (!state.progress) return;
      const { taskId, stepId } = action.payload;
      const taskIdStr = String(taskId);

      if (state.progress.learned[taskIdStr]?.includes(stepId)) {
        console.log(`Step ${stepId} in task ${taskId} is already learned. Skipping.`);
        return;
      }

      if (!state.progress.learned[taskIdStr]) {
        state.progress.learned[taskIdStr] = [];
      }
      state.progress.learned[taskIdStr].push(stepId);
      state.pendingLearnedSteps.push({ taskId, stepId });
    },
    clearCourseData(state) {
      state.tasks = [];
      state.progress = null;
      state.currentTaskIndex = 0;
      state.currentStepIndex = 0;
      state.pendingLearnedSteps = [];
    },
    setCachedProgress(state, action: PayloadAction<Progress | null>) {
      state.progress = action.payload;
    },
    setProgressPercent(state, action: PayloadAction<number>) {
      state.progressPercent = action.payload;
    },
    // Записує в state прогрес, отриманий напряму з сервера (джерело
    // правди при відкритті курсу), не чіпаючи pendingLearnedSteps —
    // локальні ще не відправлені зміни не повинні губитись, якщо
    // серверна відповідь прийшла з затримкою вже після того, як
    // користувач встиг позначити нові кроки вивченими.
    hydrateProgress(state, action: PayloadAction<{ learned: { [taskId: string]: number[] } }>) {
      if (!state.progress) {
        state.progress = {
          id: Date.now(),
          courseId: 0,
          learned: action.payload.learned,
        };
        return;
      }

      const mergedLearned: { [taskId: string]: number[] } = { ...action.payload.learned };

      for (const taskIdStr of Object.keys(state.progress.learned)) {
        const localStepIds = state.progress.learned[taskIdStr] || [];
        const serverStepIds = mergedLearned[taskIdStr] || [];
        mergedLearned[taskIdStr] = Array.from(new Set([...serverStepIds, ...localStepIds]));
      }

      state.progress.learned = mergedLearned;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(loadProgressFromCache.fulfilled, (state, action) => {
        state.progress = action.payload;
        state.pendingLearnedSteps = [];
      })
      .addCase(saveProgressToCache.fulfilled, (state, action) => {
        state.progress = action.payload;
        state.pendingLearnedSteps = [];
      })
      .addCase(saveProgressToCache.rejected, (state) => {
        console.error("Failed to save progress to cache, pending steps are not cleared.");
      });
  },
});

export const {
  setTasks,
  setCurrentTaskIndex,
  setCurrentStepIndex,
  markStepLearned,
  clearCourseData,
  setCachedProgress,
  setProgressPercent,
  hydrateProgress,
} = stepsSlice.actions;

export default stepsSlice.reducer;