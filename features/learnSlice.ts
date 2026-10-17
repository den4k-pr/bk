import { notifyCardsWordAnswered } from '../services/cardsLimitBus';
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { getRandomNotLearnedWords, getRandomDictionaryWords } from '../services/wordService';
import { enqueueDictionarySrs } from '../services/progressOutbox';
import { enqueueLearnUpdateProgressBatch } from '../services/requestQueueLearnService';
import { triggerRefresh } from './wordSlice';
import { RootState } from '../../store';
import { syncService } from './requestQueue';
import { DictionarySourceFilters } from './dictionaryFiltersSlice';
import type { CardDirection } from '../utils/cardDirection';

export interface WordCategory {
  type: string;
  total: number;
  learned: number;
  position: number;
}

export interface StageProgress {
  step1: boolean;
  step3: boolean;
  /** Мікрофонний етап для цього слова реально відбувся (була відповідь). */
  step3Attempted?: boolean;
}

export interface WordState {
  id: number;
  index: number;
  word: any;
  category?: WordCategory;
  progress: StageProgress;
  isInDictionary?: boolean;
  srsLevel?: number;
  isMastered?: boolean;
  /** 'new' | 'learning' | 'learned' — стан слова у словнику (для вибору напрямку картки) */
  studyStatus?: string | null;
  /** Напрямок останнього повторення слова (з сервера); null — ще не було */
  lastDirection?: CardDirection | null;
}

export interface FetchDictionaryWordsArgs {
  count: number;
  filters?: DictionarySourceFilters;
}

export interface LearnSliceState {
  words: WordState[];
  previousWords: WordState[];
  status: 'idle' | 'loading' | 'succeeded' | 'failed';
  step3Disabled: boolean;
  cycleId: number;
  currentCategory: string | null;

  dictionaryWords: WordState[];
  dictionaryPreviousWords: WordState[];
  dictionaryStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  dictionaryCycleId: number;
  dictionaryTotalWords: number;
  dictionaryLearnedWords: number;

  dictionaryCurrentFilters: DictionarySourceFilters | null;

  answeredWordIds: number[];

  /** Лічильник смужки в звичайних картках: з сервера + миттєві "+1" за сесію. */
  programLearned: number;
  programTotal: number;
  /** Слова поточного циклу, чию відповідь уже відправлено на сервер. */
  syncedProgramWordIds: number[];
  /** Слова, вже зараховані вивченими в цій сесії (щоб не рахувати двічі). */
  countedProgramWordIds: number[];
}

const MAX_TRACKED_ANSWERED_IDS = 200;
const DICTIONARY_SRS_MAX_LEVEL = 5;

const initialState: LearnSliceState = {
  words: [],
  previousWords: [],
  status: 'idle',
  step3Disabled: false,
  cycleId: 0,
  currentCategory: null,

  dictionaryWords: [],
  dictionaryPreviousWords: [],
  dictionaryStatus: 'idle',
  dictionaryCycleId: 0,
  dictionaryTotalWords: 0,
  dictionaryLearnedWords: 0,

  dictionaryCurrentFilters: null,

  answeredWordIds: [],

  programLearned: 0,
  programTotal: 0,
  syncedProgramWordIds: [],
  countedProgramWordIds: [],
};

const buildProgressSyncPayload = (words: WordState[]) =>
  words.map(word => ({
    id: word.word?.id,
    userWordId: word.id ?? null,
    progress: word.progress,
  }));

/** Те саме правило, що й на сервері (UserWordProgressService.isLearnedByCards). */
const isProgramWordLearned = (word: WordState, speechStageSkipped: boolean): boolean =>
  !!word.progress.step3 ||
  (!!word.progress.step1 && speechStageSkipped && !word.progress.step3Attempted);

/**
 * Звичайні картки (програма): якщо мікрофонний етап пропущено або вимкнено,
 * слово, яке людина переглянула (step1) і не пробувала вимовити, сервер
 * зараховує вивченим за step3Skipped. Невдала спроба вимови — не зараховується.
 */
const buildProgramProgressSyncPayload = (words: WordState[], speechStageSkipped: boolean) =>
  words.map(word => ({
    id: word.word?.id,
    userWordId: word.id ?? null,
    progress: {
      step1: word.progress.step1,
      step3: word.progress.step3,
      step3Skipped: speechStageSkipped && !word.progress.step3Attempted,
    },
  }));

const pushAnsweredWordId = (state: LearnSliceState, globalId: number) => {
  if (state.answeredWordIds.includes(globalId)) {
    return;
  }

  state.answeredWordIds.push(globalId);

  if (state.answeredWordIds.length > MAX_TRACKED_ANSWERED_IDS) {
    state.answeredWordIds.splice(0, state.answeredWordIds.length - MAX_TRACKED_ANSWERED_IDS);
  }
};

const applyFreshDictionaryStats = (state: LearnSliceState, payload: WordState[]) => {
  const category = payload[0]?.category;

  if (!category) {
    return;
  }

  state.dictionaryTotalWords = category.total;
  state.dictionaryLearnedWords = category.learned;
};

/**
 * Єдине місце, де відповідь сервера (/words/me/dictionary/random) перетворюється
 * на WordState. Раніше цей код був продубльований у двох thunk-ах.
 */
const mapDictionaryWordDto = (word: any, index: number, data: any): WordState => ({
  id: word.id,
  index,
  word: {
    ...word.word,
    userText: word.userText,
    userTranslation: word.userTranslation,
  },
  category: {
    type: 'dictionary',
    total: data.totalDictionaryWords || 0,
    learned: data.learnedDictionaryWords || 0,
    position: data.learnedDictionaryWords || 0,
  },
  isInDictionary: true,
  srsLevel: word.srsLevel ?? 0,
  isMastered: word.isMastered ?? word.status === 'learned',
  studyStatus: word.status ?? null,
  lastDirection: word.lastDirection ?? null,
  progress: { step1: false, step3: false } as StageProgress,
});

export const updateWordsProgressBatch = createAsyncThunk(
  'learn/updateWordsProgressBatch',
  async (words: { id: number; progress: StageProgress }[], { dispatch, rejectWithValue }) => {
    if (words.length === 0) {
      return;
    }

    try {
      await enqueueLearnUpdateProgressBatch(words);
      dispatch(triggerRefresh());
    } catch (error) {
      return rejectWithValue('Update failed');
    }
  },
);

export const fetchRandomWords = createAsyncThunk(
  'learn/fetchRandom',
  async (category: string | undefined, { rejectWithValue, getState }) => {
    try {
      const data = await getRandomNotLearnedWords(category);

      if (!Array.isArray(data)) {
        console.error('Expected array from server, got:', data);
        return [];
      }

      const state = getState() as RootState;
      const answeredThisSession = new Set(state.learn.answeredWordIds ?? []);

      return data
        .filter((word: any) => !answeredThisSession.has(word.word?.id))
        .map((word: any, index: number) => ({
          id: word.id,
          index,
          word: {
            ...word.word,
            userText: word.userText,
            userTranslation: word.userTranslation,
          },
          category: word.category,
          isInDictionary: word.isInDictionary,
          progress: { step1: false, step3: false } as StageProgress,
        }));
    } catch (error) {
      return rejectWithValue('Network error');
    }
  },
);

export const fetchNewWordCycle = createAsyncThunk(
  'learn/fetchNewWordCycle',
  async ({ showAd }: { showAd: () => void }, { getState, dispatch }) => {
    const state = (getState() as RootState).learn;
    const alreadySynced = new Set(state.syncedProgramWordIds);
    const wordsToUpdate = state.words.filter(word => !alreadySynced.has(word.word?.id));

    if (wordsToUpdate.length > 0) {
      const syncPayload = buildProgramProgressSyncPayload(wordsToUpdate, state.step3Disabled);
      syncService.enqueue(syncPayload);

      dispatch(markWordsAnsweredThisSession(wordsToUpdate));

      // Денний ліміт карток: цикл з 3 слів пройдено повністю — саме тепер
      // і лише раз "+3" (сервер списує ці ж слова з цього ж запиту).
      notifyCardsWordAnswered(wordsToUpdate.length);

      try {
        await syncService.flushSyncQueue();
      } catch (error) {
        console.error('Помилка синхронізації, але продовжуємо:', error);
      }
    }

    try {
      await showAd();
    } catch (adError) {
      console.error('[Ad] Error during ad playback:', adError);
    }

    const response = await dispatch(fetchRandomWords(state.currentCategory ?? undefined)).unwrap();
    return response;
  },
);

/**
 * Вихід з карток посеред циклу: раніше прогрес ішов на сервер лише після
 * завершення всіх 3 слів, тож переглянуті слова губились. Надсилаємо ті,
 * що вже пройшли перший етап; поточний цикл не чіпаємо.
 */
export const syncCurrentProgramWords = createAsyncThunk(
  'learn/syncCurrentProgramWords',
  async (_: void, { getState, dispatch }) => {
    const state = (getState() as RootState).learn;
    // Цикл саме синхронізується (fetchNewWordCycle) — ці слова вже в дорозі.
    if (state.status === 'loading') return;
    const alreadySynced = new Set(state.syncedProgramWordIds);
    const seenWords = state.words.filter(
      word => word.progress.step1 && !alreadySynced.has(word.word?.id),
    );
    if (seenWords.length === 0) return;

    // Цикл не завершено — прогрес зберігаємо, але денний ліміт не списуємо
    // (partial): ліміт рахується лише за повністю пройдений цикл.
    syncService.enqueue(
      buildProgramProgressSyncPayload(seenWords, state.step3Disabled).map(item => ({
        ...item,
        partial: true,
      })),
    );
    try {
      await syncService.flushSyncQueue();
    } catch (error) {
      console.error('[learn] Помилка синхронізації при виході з карток:', error);
    }
  },
);

/**
 * Відповідь по одному слову звичайних карток: якщо слово зараховано, смужка
 * "вивчено" одразу показує "+1". На сервер і в денний ліміт слова йдуть
 * лише разом, коли весь цикл з 3 слів пройдено (fetchNewWordCycle) —
 * раніше ліміт списувався то на першому етапі, то на мікрофоні, а при
 * виході посеред циклу ті самі слова поверталися і списувались удруге.
 */
export const submitProgramWordAnswer = createAsyncThunk(
  'learn/submitProgramWordAnswer',
  async (globalWordId: number, { getState, dispatch }) => {
    const state = (getState() as RootState).learn;
    const word = state.words.find(w => w.word?.id === globalWordId);
    if (!word) return;

    if (isProgramWordLearned(word, state.step3Disabled)) {
      dispatch(programWordCounted(globalWordId));
    }
  },
);

export const fetchRandomDictionaryWords = createAsyncThunk(
  'learn/fetchRandomDictionaryWords',
  async (args: FetchDictionaryWordsArgs, { rejectWithValue }) => {
    const { count, filters } = args;

    try {
      const data = await getRandomDictionaryWords(count, filters);

      if (!data || !Array.isArray(data.words)) {
        return [];
      }

      return data.words.map((word: any, index: number) => mapDictionaryWordDto(word, index, data));
    } catch (error) {
      return rejectWithValue('Network error');
    }
  },
);

export const prefetchMoreDictionaryWords = createAsyncThunk(
  'learn/prefetchMoreDictionaryWords',
  async (args: FetchDictionaryWordsArgs, { rejectWithValue }) => {
    const { count, filters } = args;

    try {
      const data = await getRandomDictionaryWords(count, filters);

      if (!data || !Array.isArray(data.words)) {
        return [];
      }

      return data.words.map((word: any, index: number) => mapDictionaryWordDto(word, index, data));
    } catch (error) {
      return rejectWithValue('Network error');
    }
  },
);

export const fetchNewDictionaryWordCycle = createAsyncThunk(
  'learn/fetchNewDictionaryWordCycle',
  async ({ showAd }: { showAd: () => void }, { getState, dispatch }) => {
    const state = (getState() as RootState).learn;
    const wordsToUpdate = state.dictionaryWords;

    if (wordsToUpdate.length > 0) {
      const syncPayload = buildProgressSyncPayload(wordsToUpdate);
      syncService.enqueue(syncPayload);

      dispatch(markWordsAnsweredThisSession(wordsToUpdate));

      try {
        await syncService.flushSyncQueue();
      } catch (error) {
        console.error('Помилка синхронізації словника:', error);
      }
    }

    try {
      await showAd();
    } catch (adError) {
      console.error('[Ad] Error during ad playback:', adError);
    }

    const response = await dispatch(
      fetchRandomDictionaryWords({ count: 3, filters: state.dictionaryCurrentFilters ?? undefined }),
    ).unwrap();
    return response;
  },
);

export const syncDictionaryWordsProgress = createAsyncThunk(
  'learn/syncDictionaryWordsProgress',
  async (words: WordState[], { rejectWithValue }) => {
    if (!words || words.length === 0) {
      return;
    }

    try {
      const syncPayload = buildProgressSyncPayload(words);
      syncService.enqueue(syncPayload);
      await syncService.flushSyncQueue();
    } catch (error) {
      console.error('[learn] Помилка пачкової синхронізації словника:', error);
      return rejectWithValue('Sync failed');
    }
  },
);

export const syncDictionarySrsProgress = createAsyncThunk(
  'learn/syncDictionarySrsProgress',
  async (
    words: { id: number; userWordId?: number; success: boolean; direction?: CardDirection }[],
    { rejectWithValue },
  ) => {
    if (!words || words.length === 0) {
      return;
    }

    try {
      // Через надійну чергу: збереглась на пристрої, піде навіть після збою мережі.
      await enqueueDictionarySrs(words);
    } catch (error) {
      console.error('[learn] Помилка синхронізації SRS-прогресу словника:', error);
      return rejectWithValue('Sync failed');
    }
  },
);

const learnSlice = createSlice({
  name: 'learn',
  initialState,
  reducers: {
    clearCompletedWords: state => {
      state.words = state.words.filter(word => !(word.progress.step1 && word.progress.step3));
      state.status = 'idle';
    },

    prepareForNewCycle: state => {
      state.status = 'loading';
    },

    shiftDictionaryWord: state => {
      state.dictionaryWords.shift();
    },

    applyDictionaryAnswerLocally: (
      state,
      action: PayloadAction<{ globalWordId: number; success: boolean }>,
    ) => {
      const { globalWordId, success } = action.payload;

      pushAnsweredWordId(state, globalWordId);

      const word = state.dictionaryWords.find(w => w.word?.id === globalWordId);
      if (!word) return;

      const wasMastered = word.isMastered ?? false;
      const nextLevel = success ? Math.min(DICTIONARY_SRS_MAX_LEVEL, (word.srsLevel ?? 0) + 1) : 0;
      const nextMastered = success;

      word.srsLevel = nextLevel;
      word.isMastered = nextMastered;

      if (nextMastered && !wasMastered) {
        state.dictionaryLearnedWords = Math.min(
          state.dictionaryTotalWords,
          state.dictionaryLearnedWords + 1,
        );
      } else if (!nextMastered && wasMastered) {
        state.dictionaryLearnedWords = Math.max(0, state.dictionaryLearnedWords - 1);
      }
    },

    markWordsAnsweredThisSession: (state, action: PayloadAction<WordState[]>) => {
      action.payload.forEach(word => {
        const globalId = word.word?.id;
        const wasLearned = !!word.progress?.step1 && !!word.progress?.step3;

        if (typeof globalId === 'number' && wasLearned) {
          pushAnsweredWordId(state, globalId);
        }
      });
    },

    wordProgressResetExternally: (state, action: PayloadAction<number>) => {
      const globalWordId = action.payload;

      if (state.dictionaryLearnedWords > 0) {
        state.dictionaryLearnedWords -= 1;
      }

      state.answeredWordIds = state.answeredWordIds.filter(id => id !== globalWordId);

      const wordInMain = state.words.find(word => word.word?.id === globalWordId);
      if (wordInMain) {
        wordInMain.progress.step1 = false;
        wordInMain.progress.step3 = false;
      }

      const wordInDictionary = state.dictionaryWords.find(word => word.word?.id === globalWordId);
      if (wordInDictionary) {
        wordInDictionary.progress.step1 = false;
        wordInDictionary.progress.step3 = false;
      }
    },

    setStepProgress: (
      state,
      action: PayloadAction<{ id: number; step: keyof StageProgress; value: boolean }>,
    ) => {
      const { id, step, value } = action.payload;
      let found = false;

      const wordInMain = state.words.find(word => word.word?.id === id);
      if (wordInMain) {
        wordInMain.progress[step] = value;
        found = true;
      }

      const wordInDictionary = state.dictionaryWords.find(word => word.word?.id === id);
      if (wordInDictionary) {
        wordInDictionary.progress[step] = value;
        found = true;
      }
    },

    setStepProgressBatch: (
      state,
      action: PayloadAction<{
        step: keyof StageProgress;
        values: { id: number; value: boolean }[];
      }>,
    ) => {
      action.payload.values.forEach(({ id, value }) => {
        const wordInMain = state.words.find(word => word.word?.id === id);
        if (wordInMain) {
          wordInMain.progress[action.payload.step] = value;
        }

        const wordInDictionary = state.dictionaryWords.find(word => word.word?.id === id);
        if (wordInDictionary) {
          wordInDictionary.progress[action.payload.step] = value;
        }
      });
    },

    programWordCounted: (state, action: PayloadAction<number>) => {
      if (state.countedProgramWordIds.includes(action.payload)) return;
      state.countedProgramWordIds.push(action.payload);
      state.programLearned = state.programTotal > 0
        ? Math.min(state.programTotal, state.programLearned + 1)
        : state.programLearned + 1;
    },

    resetProgramCounter: state => {
      state.programLearned = 0;
      state.programTotal = 0;
      state.countedProgramWordIds = [];
      state.syncedProgramWordIds = [];
    },

    programWordSynced: (state, action: PayloadAction<number>) => {
      if (!state.syncedProgramWordIds.includes(action.payload)) {
        state.syncedProgramWordIds.push(action.payload);
      }
    },

    setStepDisabled: (
      state,
      action: PayloadAction<{ step: 'step3'; disabled: boolean }>,
    ) => {
      const { step, disabled } = action.payload;
      if (step === 'step3') {
        state.step3Disabled = disabled;
      }
    },

    resetStepDisabled: state => {
      state.step3Disabled = false;
    },
  },

  extraReducers: builder => {
    builder
      .addCase(fetchRandomWords.pending, (state, action) => {
        state.status = 'loading';
        state.words = [];
        const nextCategory = action.meta.arg ?? null;
        if (nextCategory !== state.currentCategory) {
          // Інший набір (фільтр) — інший лічильник.
          state.programLearned = 0;
          state.programTotal = 0;
        }
        state.currentCategory = nextCategory;
      })
      .addCase(fetchRandomWords.fulfilled, (state, action: PayloadAction<WordState[]>) => {
        state.status = 'succeeded';
        state.words = action.payload;
        state.cycleId += 1;
        state.syncedProgramWordIds = [];
        // Сервер рахує вже з усіма відправленими відповідями — беремо його число,
        // але не менше за те, що людина щойно бачила (кеш сервера може відставати).
        const category = action.payload[0]?.category;
        if (category) {
          state.programTotal = category.total;
          state.programLearned = Math.max(category.learned, state.programLearned);
        }
      })
      .addCase(fetchRandomWords.rejected, state => {
        state.status = 'failed';
      })

      .addCase(fetchNewWordCycle.pending, state => {
        state.previousWords = state.words;
        state.status = 'loading';
      })
      .addCase(fetchNewWordCycle.fulfilled, state => {
        state.status = 'succeeded';
      })
      .addCase(fetchNewWordCycle.rejected, state => {
        state.status = 'failed';
      })

      .addCase(fetchRandomDictionaryWords.pending, (state, action) => {
        state.dictionaryStatus = 'loading';
        state.dictionaryWords = [];
        state.dictionaryCurrentFilters = action.meta.arg.filters ?? null;
        state.dictionaryTotalWords = 0;
        state.dictionaryLearnedWords = 0;
      })
      .addCase(fetchRandomDictionaryWords.fulfilled, (state, action: PayloadAction<WordState[]>) => {
        state.dictionaryStatus = 'succeeded';
        state.dictionaryWords = action.payload;
        state.dictionaryCycleId += 1;
        applyFreshDictionaryStats(state, action.payload);
      })
      .addCase(fetchRandomDictionaryWords.rejected, state => {
        state.dictionaryStatus = 'failed';
      })

      .addCase(fetchNewDictionaryWordCycle.pending, state => {
        state.dictionaryPreviousWords = state.dictionaryWords;
        state.dictionaryStatus = 'loading';
      })
      .addCase(fetchNewDictionaryWordCycle.fulfilled, state => {
        state.dictionaryStatus = 'succeeded';
      })
      .addCase(fetchNewDictionaryWordCycle.rejected, state => {
        state.dictionaryStatus = 'failed';
      })

      .addCase(prefetchMoreDictionaryWords.fulfilled, (state, action: PayloadAction<WordState[]>) => {
        const existingIds = new Set(state.dictionaryWords.map(word => word.word?.id));
        const answeredIds = new Set(state.answeredWordIds);
        
        let newOnes = action.payload.filter(word => 
          !existingIds.has(word.word?.id) && !answeredIds.has(word.word?.id)
        );

        // Якщо малий словник і ми вивчили всі слова, бекенд надішле їх знову.
        // Щоб не було зависання, очищаємо історію і пускаємо слова на друге коло.
        if (newOnes.length === 0 && action.payload.length > 0) {
          newOnes = action.payload.filter(word => !existingIds.has(word.word?.id));
          state.answeredWordIds = [];
        }

        state.dictionaryWords.push(...newOnes);
      })
      .addCase(prefetchMoreDictionaryWords.rejected, () => {});
  },
});

export const {
  clearCompletedWords,
  prepareForNewCycle,
  shiftDictionaryWord,
  applyDictionaryAnswerLocally,
  markWordsAnsweredThisSession,
  wordProgressResetExternally,
  setStepProgress,
  setStepProgressBatch,
  setStepDisabled,
  resetStepDisabled,
  programWordCounted,
  programWordSynced,
  resetProgramCounter,
} = learnSlice.actions;

export default learnSlice.reducer;