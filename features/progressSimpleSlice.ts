import { createSlice, createAsyncThunk, PayloadAction, createSelector } from "@reduxjs/toolkit";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RootState } from "../../store";
import { CategoryWithProgress } from "../types/courseCategories";
import { createSimpleProgress } from "../services/simpleProgressService";

export type ProgressStatus = "not_started" | "in_progress" | "completed";

export interface ProgressRecord {
  id: number;
  videoId: number;
  status: ProgressStatus;
  /** Переглянуто відсотків (0–100, лише зростає) — смужка на превʼю. */
  watchedPercent?: number;
}

export interface ProgressState {
  progressRecords: ProgressRecord[];
  loading: boolean;
  error: string | null;
}

const STORAGE_KEY = "video_progress_cache";

export const STATUS_PRIORITY: Record<string, number> = {
  not_started: 0,
  mid: 1,
  in_progress: 1,
  completed: 2,
};

export const normalizeStatus = (raw?: string | null): ProgressStatus => {
  if (raw === "completed") return "completed";
  if (raw === "in_progress" || raw === "mid") return "in_progress";
  return "not_started";
};

const initialState: ProgressState = {
  progressRecords: [],
  loading: false,
  error: null,
};

export const clampWatchedPercent = (value: unknown): number => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
};

const applyRecord = (
  state: ProgressState,
  videoId: number,
  status: ProgressStatus,
  watchedPercent?: number,
) => {
  const id = Number(videoId);
  if (!Number.isFinite(id)) return;

  const watched = watchedPercent === undefined ? 0 : clampWatchedPercent(watchedPercent);
  const existing = state.progressRecords.find((p) => p.videoId === id);

  if (!existing) {
    if (status === "not_started" && watched === 0) return;
    state.progressRecords.push({ id, videoId: id, status, watchedPercent: watched });
    return;
  }

  const nextPriority = STATUS_PRIORITY[status] ?? 0;
  const currentPriority = STATUS_PRIORITY[existing.status] ?? 0;

  if (nextPriority > currentPriority) {
    existing.status = status;
  }
  if (watched > (existing.watchedPercent ?? 0)) {
    existing.watchedPercent = watched;
  }
};

const saveProgressToCache = async (progressRecords: ProgressRecord[]) => {
  try {
    const userId = await AsyncStorage.getItem("userId");
    if (!userId) return;
    await AsyncStorage.setItem(`${STORAGE_KEY}_${userId}`, JSON.stringify(progressRecords));
  } catch (e) {
    console.warn("[PROGRESS] Save cache error", e);
  }
};

export const loadProgressFromCache = createAsyncThunk<ProgressRecord[]>(
  "progress/loadCache",
  async () => {
    try {
      const userId = await AsyncStorage.getItem("userId");
      if (!userId) return [];

      const json = await AsyncStorage.getItem(`${STORAGE_KEY}_${userId}`);
      if (!json) return [];

      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((r: any) => r && Number.isFinite(Number(r.videoId)))
        .map((r: any) => ({
          id: Number(r.videoId),
          videoId: Number(r.videoId),
          status: normalizeStatus(r.status),
          watchedPercent: clampWatchedPercent(r.watchedPercent),
        }));
    } catch (e) {
      console.warn("[PROGRESS] Load cache error", e);
      return [];
    }
  }
);

export const clearProgressCache = createAsyncThunk("progress/clearCache", async () => {
  try {
    const userId = await AsyncStorage.getItem("userId");
    if (userId) {
      await AsyncStorage.removeItem(`${STORAGE_KEY}_${userId}`);
    }
  } catch (e) {
    console.warn("[PROGRESS] Clear cache error", e);
  }
});

export const commitVideoProgress = createAsyncThunk<
  void,
  { videoId: number | string; status: string; watchedPercent?: number; skipServer?: boolean },
  { state: RootState }
>("progress/commit", async ({ videoId, status, watchedPercent, skipServer }, { getState, dispatch }) => {
  const numericId = Number(videoId);
  const normalized = normalizeStatus(status);

  if (!Number.isFinite(numericId) || normalized === "not_started") return;

  const watched = watchedPercent === undefined ? undefined : clampWatchedPercent(watchedPercent);
  dispatch(setLocalProgress({ videoId: numericId, status: normalized, watchedPercent: watched }));

  await saveProgressToCache(getState().progressSimple.progressRecords);

  if (skipServer) return;

  try {
    await createSimpleProgress(
      numericId,
      watched === undefined ? { status: normalized } : { status: normalized, watchedPercent: watched },
    );
  } catch (e: any) {
    console.error(
      "[PROGRESS] Server sync FAILED",
      numericId,
      normalized,
      e?.response?.status,
      JSON.stringify(e?.response?.data ?? e?.message)
    );
    throw e;
  }
});

const progressSlice = createSlice({
  name: "progressSimple",
  initialState,
  reducers: {
    setLocalProgress: (
      state,
      action: PayloadAction<{ videoId: number | string; status: string; watchedPercent?: number }>
    ) => {
      applyRecord(
        state,
        Number(action.payload.videoId),
        normalizeStatus(action.payload.status),
        action.payload.watchedPercent,
      );
    },
    mergeServerProgress: (
      state,
      action: PayloadAction<Array<{ videoId: number | string; status: string; watchedPercent?: number }>>
    ) => {
      action.payload.forEach((item) => {
        applyRecord(state, Number(item.videoId), normalizeStatus(item.status), item.watchedPercent);
      });
    },
    resetProgress: (state) => {
      state.progressRecords = [];
      state.loading = false;
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadProgressFromCache.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(loadProgressFromCache.fulfilled, (state, action) => {
        action.payload.forEach((cached) => {
          applyRecord(state, cached.videoId, cached.status, cached.watchedPercent);
        });
        state.loading = false;
      })
      .addCase(loadProgressFromCache.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || "Error loading cache";
      })
      .addCase(clearProgressCache.fulfilled, (state) => {
        state.progressRecords = [];
      });
  },
});

export const { setLocalProgress, mergeServerProgress, resetProgress } = progressSlice.actions;
export default progressSlice.reducer;

const selectProgressRecords = (state: RootState) => state.progressSimple.progressRecords;
const selectCategoryProp = (_: RootState, category?: CategoryWithProgress) => category;
const selectVideoIdProp = (_: RootState, videoId: number) => Number(videoId);

export const makeSelectCourseProgress = () =>
  createSelector([selectProgressRecords, selectCategoryProp], (records, category) => {
    if (!category || !category.videos || category.videos.length === 0) {
      return { totalVideos: 0, completedVideos: 0, progressPercent: 0 };
    }

    const totalVideos = category.videos.length;
    const statusByVideo = new Map<number, string>();

    records.forEach((r) => statusByVideo.set(Number(r.videoId), r.status));

    let completedVideos = 0;

    category.videos.forEach((video: any) => {
      const id = Number(video.id);
      const localStatus = statusByVideo.get(id);
      const serverStatus = normalizeStatus(video.status);

      const effective =
        (STATUS_PRIORITY[localStatus ?? "not_started"] ?? 0) >=
        (STATUS_PRIORITY[serverStatus] ?? 0)
          ? localStatus ?? "not_started"
          : serverStatus;

      if (effective === "completed") completedVideos++;
    });

    return {
      totalVideos,
      completedVideos,
      progressPercent: Math.round((completedVideos / totalVideos) * 100),
    };
  });

export const makeSelectProgressForVideo = () =>
  createSelector([selectProgressRecords, selectVideoIdProp], (records, videoId) =>
    records.find((p) => p.videoId === videoId)
  );