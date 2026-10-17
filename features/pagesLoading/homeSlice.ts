import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { initializeApp } from "../appStateSlice";
import { getCurrentDailyWordAPI } from "../../services/apiService";
import { TimeoutError } from "../../utils/withTimeout";
import { DailyWordEntry } from "../../types/words";

interface HomeState {
  wordOfDay: { data: DailyWordEntry | null; loading: boolean; error: string | null };
  loading: boolean;
  error: string | null;
}

const initialState: HomeState = {
  wordOfDay: { data: null, loading: false, error: null },
  loading: false,
  error: null,
};

const WORD_FETCH_RETRY_ATTEMPTS = 3;
const WORD_FETCH_RETRY_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const fetchDailyWord = createAsyncThunk<DailyWordEntry | null>(
  "home/fetchDailyWord",
  async (_, { rejectWithValue }) => {
    let lastErrorMessage = 'Не вдалося завантажити слово дня';

    for (let attempt = 1; attempt <= WORD_FETCH_RETRY_ATTEMPTS; attempt++) {
      try {
        const word = await getCurrentDailyWordAPI();
        return word;
      } catch (err: any) {
        const isTimeout = err instanceof TimeoutError;
        const status = err?.response?.status;

        lastErrorMessage = isTimeout
          ? 'Сервер не відповідає під час завантаження слова дня.'
          : (err?.response?.data?.message || err?.message || lastErrorMessage);

        console.warn(
          `[HOME] fetchDailyWord: спроба ${attempt}/${WORD_FETCH_RETRY_ATTEMPTS} не вдалась: ${lastErrorMessage}` +
          (isTimeout ? ' (TIMEOUT)' : status ? ` (HTTP ${status})` : ''),
        );

        const isLastAttempt = attempt === WORD_FETCH_RETRY_ATTEMPTS;
        if (isLastAttempt) {
          return rejectWithValue(lastErrorMessage);
        }

        await sleep(WORD_FETCH_RETRY_DELAY_MS * attempt);
      }
    }

    return rejectWithValue(lastErrorMessage);
  },
  {
    // Кілька екранів/ефектів можуть попросити слово одночасно — запит один:
    // перевіряємо АКТУАЛЬНИЙ стан сховища, а не замикання компонента.
    condition: (_, { getState }) => {
      const wordOfDay = (getState() as { home: HomeState }).home.wordOfDay;
      return !wordOfDay.data && !wordOfDay.loading;
    },
  },
);

const homeSlice = createSlice({
  name: "home",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(initializeApp.pending, (state) => {
        state.loading = true;
        state.error = null;
        if (!state.wordOfDay.data) {
          state.wordOfDay.loading = true;
        }
      })
      .addCase(initializeApp.fulfilled, (state, action) => {
        state.loading = false;
        const incomingWord = action.payload.dailyWord;
        if (incomingWord) {
          state.wordOfDay.data = incomingWord;
        }
        state.wordOfDay.loading = false;
        state.wordOfDay.error = null;
      })
      .addCase(initializeApp.rejected, (state, action) => {
        state.loading = false;
        state.error = `Home page init failed: ${action.payload}`;
        state.wordOfDay.loading = false;
        if (!state.wordOfDay.data) {
          state.wordOfDay.error = action.payload as string;
        }
      })
      .addCase(fetchDailyWord.pending, (state) => {
        if (!state.wordOfDay.data) {
          state.wordOfDay.loading = true;
          state.wordOfDay.error = null;
        }
      })
      .addCase(fetchDailyWord.fulfilled, (state, action) => {
        state.wordOfDay.loading = false;
        if (action.payload) {
          state.wordOfDay.data = action.payload;
          state.wordOfDay.error = null;
        }
      })
      .addCase(fetchDailyWord.rejected, (state, action) => {
        state.wordOfDay.loading = false;
        if (!state.wordOfDay.data) {
          state.wordOfDay.error = action.payload as string;
        }
      });
  },
});

export default homeSlice.reducer;