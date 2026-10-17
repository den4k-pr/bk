import { createSlice, createAsyncThunk, PayloadAction } from "@reduxjs/toolkit";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RootState } from "../../store"; // 💡 Припускаємо, що RootState доступний для getState
import { initializeApp } from "./appStateSlice"; 

// --- Утиліти для кешування ---
const CACHE_PREFIX = "userProgress:";

// Ключ тепер залежить ТІЛЬКИ від userId, оскільки UserProgress є глобальним для користувача.
const getCacheKey = (userId: string) => `${CACHE_PREFIX}${userId}`; 

// --- Стан та інтерфейси ---
interface ProgressState {
    data: any | null;
    loading: boolean;
    error: string | null;
}

const initialState: ProgressState = {
    data: null,
    loading: true,
    error: null,
};

// =========================================================
//           ✅ THUNK ДЛЯ ЗАВАНТАЖЕННЯ (loadUserProgressFromCache)
// =========================================================

export const loadUserProgressFromCache = createAsyncThunk(
    "userProgress/loadFromCache",
    async (_, { rejectWithValue }) => {
        try {
            const userId = await AsyncStorage.getItem("userId");
            if (!userId) {
                // Це не помилка, просто користувач не залогінений
                return null;
            }

            const cacheKey = getCacheKey(userId);
            const cachedData = await AsyncStorage.getItem(cacheKey);

            if (cachedData) {
                console.log("[CACHE] UserProgress loaded from cache for:", cacheKey);
                return JSON.parse(cachedData) as any;
            }
            
            console.log("[CACHE] No UserProgress in cache for:", cacheKey);
            return null;
            
        } catch (error: any) {
            console.error("❌ Failed to load UserProgress from cache:", error);
            return rejectWithValue({ message: "Не вдалося завантажити кеш прогресу користувача." });
        }
    }
);


// =========================================================
//           ✅ THUNK ДЛЯ ЗБЕРЕЖЕННЯ (saveUserProgressToCache)
// =========================================================

export const saveUserProgressToCache = createAsyncThunk(
    "userProgress/saveToCache",
    async (progressToSave: any | null, { rejectWithValue, getState }) => {
        const state = getState() as RootState;
        
        // Використовуємо progressToSave, якщо передано, або поточний стан
        const progress = progressToSave ?? state.userProgress.data; 

        if (!progress) {
            // Це може бути виклик clearProgress. Просто очищаємо кеш.
            try {
                const userId = await AsyncStorage.getItem("userId");
                if (userId) {
                    await AsyncStorage.removeItem(getCacheKey(userId));
                    console.log("🗑 Cleared user progress cache for:", userId);
                }
                return null;
            } catch (error: any) {
                return rejectWithValue({ message: "Помилка при очищенні кешу прогресу." });
            }
        }

        const userId = await AsyncStorage.getItem("userId");
        if (!userId) {
            return rejectWithValue({ message: "Save aborted: UserId not found in AsyncStorage" });
        }

        const cacheKey = getCacheKey(userId);

        try {
            await AsyncStorage.setItem(cacheKey, JSON.stringify(progress));
            console.log("[CACHE] Saved UserProgress to cache:", cacheKey);
            return progress;
        } catch (error: any) {
            console.error("❌ Failed to save UserProgress to cache:", error);
            return rejectWithValue({ message: error.message });
        }
    }
);

export const clearUserProgress = createAsyncThunk(
    "userProgress/clear",
    async (_, { rejectWithValue }) => {
        try {
            console.log("LOGOUT: Attempting to clear user progress...");
            const userId = await AsyncStorage.getItem("userId");
            if (userId) {
                const cacheKey = getCacheKey(userId);
                await AsyncStorage.removeItem(cacheKey);
                console.log(`🗑️  Cache cleared for key: ${cacheKey}`);
            } else {
                console.log("LOGOUT: No user ID found, skipping cache clear.");
            }
            // Повертаємо успішний результат, щоб Redux міг оновити стан
            return true;
        } catch (error: any) {
            console.error("❌ Failed to clear user progress cache:", error);
            return rejectWithValue("Помилка при очищенні кешу прогресу.");
        }
    }
);


// --- Slice ---

const userProgressSlice = createSlice({
    name: "userProgress",
    initialState,
    reducers: {
        setProgress(state, action: PayloadAction<Partial<any>>) {
            // Цей редюсер просто оновлює стан Redux, а thunk saveanyToCache 
            // викликається окремо або вручну (як у випадку clearProgress)
            if (state.data) {
                state.data = { ...state.data, ...action.payload };
            } else {
                state.data = { id: 0, ...action.payload } as any;
            }
            // 💡 БІЛЬШЕ НЕ ВИКЛИКАЄМО saveProgressToCache НАПРЯМУ
        },
        setFullProgress(state, action: PayloadAction<any | null>) {
            state.data = action.payload;
            state.loading = false;
        },
        clearProgress(state) {
            state.data = null;
            // 💡 ВАЖЛИВО: Очищення кешу відбувається через thunk при виклику цього екшену ззовні
        },
    },
    extraReducers: (builder) => {
        builder
            // --- Обробка loadUserProgressFromCache ---
            .addCase(loadUserProgressFromCache.pending, (state) => {
                state.loading = true;
                state.error = null;
            })
            .addCase(loadUserProgressFromCache.fulfilled, (state, action) => {
                state.data = action.payload; // Завантажуємо дані, прив'язані до userId
                state.loading = false;
            })
            .addCase(loadUserProgressFromCache.rejected, (state, action) => {
                state.loading = false;
                state.error = (action.payload as { message: string })?.message || "Error loading cache";
                state.data = null;
            })

            // --- Обробка saveUserProgressToCache ---
            .addCase(saveUserProgressToCache.fulfilled, (state, action) => {
                // Якщо збереження успішне, ми можемо оновити стан, якщо дані прийшли з thunk
                if(action.payload) {
                    state.data = action.payload;
                }
            })
            .addCase(saveUserProgressToCache.rejected, (state) => {
                // Обробка помилки збереження
                console.error("Failed to save progress to cache (rejected thunk).");
                // Можливо, тут варто встановити прапорець помилки
            })
            
            // --- Обробка initializeApp (Синхронізація з сервером) ---
            .addCase(initializeApp.fulfilled, (state, action) => {
                const serverProgress = action.payload.userProgress;

                if (serverProgress) {
                    console.log("[USER_PROGRESS] Отримано свіжий прогрес з сервера. Оновлюємо.");
                    state.data = serverProgress;
                } 

                state.loading = false;
                state.error = null;
            })
            .addCase(initializeApp.rejected, (state, action) => {
                state.loading = false;
                state.error = action.payload as string;
            })
            .addCase(clearUserProgress.fulfilled, (state) => {
                state.data = null;      // Очищуємо дані в стані Redux
                state.loading = false;  // Скидаємо стан завантаження
                state.error = null;     // Скидаємо помилки
                console.log("LOGOUT: Redux state for userProgress has been cleared.");
            });
    },
});

export const { setProgress, setFullProgress, clearProgress } =
    userProgressSlice.actions;
export default userProgressSlice.reducer;