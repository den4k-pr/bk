import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { addSimpleWord, resetSingleWordProgress } from '../services/wordService';
import { DictionaryAddSource, UserWord, WordType } from '../types/words';
import { scheduleDeletion } from './navQueue';
import { DICTIONARY_LIMIT_REACHED, isDictionaryLimitError } from '../services/dictionaryLimitBus';
import { bumpDictionaryDataVersion } from '../services/dictionaryMutationBus';

export const deleteWordOptimistic = createAsyncThunk(
  'words/deleteWord',
  async (userWordId: number) => {
    return new Promise<boolean>((resolve, reject) => {
      scheduleDeletion(userWordId, { resolve, reject });
    });
  },
);

export const resetProgressOptimistic = createAsyncThunk(
  'words/resetProgress',
  async (userWordId: number, { rejectWithValue }) => {
    try {
      await resetSingleWordProgress(userWordId);
      return userWordId;
    } catch (error: any) {
      return rejectWithValue(error.message as string);
    }
  },
);

/** Тимчасовий id запису, поки сервер не відповів (завжди від'ємний). */
const optimisticIds = new Map<string, number>();
let nextOptimisticId = -1;

export const isOptimisticUserWordId = (id: number | null | undefined): boolean =>
  typeof id === 'number' && id < 0;

export const addWordOptimistic = createAsyncThunk(
  'words/addWord',
  async (
    payload: { word: WordType; source?: DictionaryAddSource },
    { rejectWithValue },
  ) => {
    try {
      return await addSimpleWord(payload.word.text, payload.source, payload.word.id);
    } catch (error: any) {
      // "Словник заповнено" — окремим кодом: викликачі не показують свою
      // помилку (вікно DictionaryLimitPaywall відкривається з api.ts).
      if (isDictionaryLimitError(error)) return rejectWithValue(DICTIONARY_LIMIT_REACHED);
      return rejectWithValue(error.message as string);
    }
  },
);

interface DictionaryStats {
  total: number;
  learned: number;
  toLearn: number;
}

interface WordsState {
  words: UserWord[];
  loadingStatus: 'idle' | 'loading' | 'failed';
  error: string | null;
  refreshTrigger: number;
  searchQuery: string;
  level: string;
  status: 'all' | 'new' | 'learning' | 'learned' | 'favorite' | any;
  type: 'all' | 'word' | 'phrase' | 'phrasal_verb';
  page: number;
  rollbackData: Record<string, { word: UserWord; index: number }>;
  stats: DictionaryStats;
}

const initialState: WordsState = {
  words: [],
  loadingStatus: 'idle',
  error: null,
  refreshTrigger: 0,
  searchQuery: '',
  status: 'all',
  level: 'Всі',
  type: 'word',
  page: 1,
  rollbackData: {},
  stats: { total: 0, learned: 0, toLearn: 0 },
};

function getWordStatus(word: UserWord | undefined): string | undefined {
  if (!word) return undefined;
  // @ts-ignore
  return (word as any).status ?? (word as any).word?.status;
}

function decrementStatsForWord(stats: DictionaryStats, word: UserWord | undefined): void {
  const status = getWordStatus(word);
  stats.total = Math.max(0, stats.total - 1);
  if (status === 'learned') {
    stats.learned = Math.max(0, stats.learned - 1);
  } else {
    stats.toLearn = Math.max(0, stats.toLearn - 1);
  }
}

function incrementStatsForWord(stats: DictionaryStats, word: UserWord | undefined): void {
  const status = getWordStatus(word);
  stats.total += 1;
  if (status === 'learned') {
    stats.learned += 1;
  } else {
    stats.toLearn += 1;
  }
}

function applyResetToStats(stats: DictionaryStats, previousStatus: string | undefined): void {
  if (previousStatus === 'learned') {
    stats.learned = Math.max(0, stats.learned - 1);
    stats.toLearn += 1;
  }
}

function revertResetStatsAdjustment(stats: DictionaryStats, previousStatus: string | undefined): void {
  if (previousStatus === 'learned') {
    stats.learned += 1;
    stats.toLearn = Math.max(0, stats.toLearn - 1);
  }
}

const wordsSlice = createSlice({
  name: 'words',
  initialState,
  reducers: {
    setWords(state, action: PayloadAction<UserWord[]>) {
      state.words = action.payload;
    },

    prependUserWord(state, action: PayloadAction<UserWord>) {
      const word = action.payload;
      const alreadyExists = state.words.some(w => w.id === word.id);
      // Лічильники Словника тут не чіпаємо — їх оновлює wordAddedToDictionary
      // (один раз на додавання, див. services/dictionaryStatsSync).
      if (!alreadyExists) {
        state.words.unshift(word);
      }
    },

    /** Нове слово в Словнику: +1 до цифр аналітики, якщо підходить під фільтри. */
    wordAddedToDictionary(
      state,
      action: PayloadAction<{ wordType: string | null; level: string | null }>,
    ) {
      const { wordType, level } = action.payload;
      if (state.status === 'favorite') return; // нове слово ще не в обраному
      if (state.type !== 'all' && wordType && wordType !== state.type) return;
      if (state.level !== 'Всі' && level && !state.level.split(',').includes(level.trim().toUpperCase())) return;
      state.stats.total += 1;
      state.stats.toLearn += 1;
    },

    appendWords(state, action: PayloadAction<UserWord[]>) {
      const existingIds = new Set(state.words.map(w => w.id));
      const newUniqueWords = action.payload.filter(w => !existingIds.has(w.id));
      if (newUniqueWords.length > 0) {
        state.words.push(...newUniqueWords);
      }
    },

    setLoading(state, action: PayloadAction<'idle' | 'loading' | 'failed'>) {
      state.loadingStatus = action.payload;
    },

    triggerRefresh(state) {
      state.refreshTrigger += 1;
      state.page = 1;
    },

    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
      state.page = 1;
    },

    setStatus(
      state,
      action: PayloadAction<'all' | 'new' | 'learning' | 'learned' | 'favorite'>,
    ) {
      state.status = action.payload;
      state.page = 1;
    },

    setType(
      state,
      action: PayloadAction<'all' | 'word' | 'phrase' | 'phrasal_verb'>,
    ) {
      state.type = action.payload;
      state.page = 1;
    },

    /** Рівні слів у Словнику: 'Всі' або 'A1,B2' (див. WordLevelChips). */
    setDictionaryLevel(state, action: PayloadAction<string>) {
      state.level = action.payload || 'Всі';
      state.page = 1;
    },

    /**
     * Вихід зі Словника: пошук, статус, тип і рівень — до стандартних.
     * Раніше запит пошуку лишався в стані після виходу, і повернення в
     * Словник показувало "порожньо" при вже закритому полі пошуку.
     */
    resetDictionaryView(state) {
      state.searchQuery = '';
      state.status = 'all';
      state.type = 'word';
      state.level = 'Всі';
      state.page = 1;
    },

    /**
     * Слово додано (звідки завгодно) — Словник відкриється на його вкладці
     * (слово / фраза / фразове дієслово) і без фільтрів, щоб його було видно.
     */
    showAddedWordInDictionary(state, action: PayloadAction<{ wordType?: string | null }>) {
      const wordType = action.payload.wordType;
      state.type = wordType === 'phrase' || wordType === 'phrasal_verb' ? wordType : 'word';
      state.searchQuery = '';
      state.status = 'all';
      state.level = 'Всі';
      state.page = 1;
    },

    setPage(state, action: PayloadAction<number>) {
      state.page = action.payload;
    },

    setStats(state, action: PayloadAction<DictionaryStats>) {
      state.stats = action.payload;
    },

    updateWordLocalData(
      state,
      action: PayloadAction<{ id: number; notes?: string; isFavorite?: boolean }>
    ) {
      const index = state.words.findIndex(w => w.id === action.payload.id);
      if (index !== -1) {
        const target = state.words[index];

        if (action.payload.notes !== undefined) {
          if (target.word) target.word.notes = action.payload.notes;
          // @ts-ignore
          target.notes = action.payload.notes;
        }

        if (action.payload.isFavorite !== undefined) {
          if (target.word) target.word.isFavorite = action.payload.isFavorite;
          // @ts-ignore
          target.isFavorite = action.payload.isFavorite;
        }
      }
    },
  },

  extraReducers: builder => {
    builder
      .addCase(addWordOptimistic.pending, (state, action) => {
        state.loadingStatus = 'loading';
        state.error = null;

        // Слово одразу у списку (до відповіді сервера), якщо його ще немає
        // і воно підходить під відкриту вкладку без фільтрів.
        const word = action.meta.arg.word as any;
        const wordType = word?.type ?? 'word';
        const fitsView =
          !state.searchQuery &&
          (state.status === 'all' || state.status === 'new') &&
          state.level === 'Всі' &&
          wordType === state.type;
        const alreadyInList = state.words.some(w => w.word?.id === word?.id);
        if (word?.id && word?.text && fitsView && !alreadyInList) {
          const tempId = nextOptimisticId--;
          optimisticIds.set(action.meta.requestId, tempId);
          state.words.unshift({
            id: tempId,
            isInDictionary: true,
            word: { ...word, level: word.level ?? null },
            notes: '',
            isFavorite: false,
            userText: word.userText ?? '',
            userTranslation: word.userTranslation,
            status: 'new',
            addedAt: new Date().toISOString(),
          } as UserWord);

          bumpDictionaryDataVersion();
        }
      })
      .addCase(addWordOptimistic.fulfilled, (state, action) => {
        const tempId = optimisticIds.get(action.meta.requestId);
        optimisticIds.delete(action.meta.requestId);
        const added = action.payload as UserWord;
        const tempIndex = tempId !== undefined ? state.words.findIndex(w => w.id === tempId) : -1;
        const alreadyExists = state.words.some(w => w.id === added?.id);
        // Лічильники — у wordAddedToDictionary (services/dictionaryStatsSync).
        if (tempIndex !== -1) {
          if (alreadyExists) state.words.splice(tempIndex, 1);
          else state.words[tempIndex] = added;
        } else if (added?.id && !alreadyExists) {
          state.words.unshift(added);
        }
        state.loadingStatus = 'idle';
      })
      .addCase(addWordOptimistic.rejected, (state, action) => {
        const tempId = optimisticIds.get(action.meta.requestId);
        optimisticIds.delete(action.meta.requestId);
        if (tempId !== undefined) {
          state.words = state.words.filter(w => w.id !== tempId);
        }
        state.loadingStatus = 'failed';
        state.error = action.payload as string ?? 'Не вдалося додати слово';
      })

      .addCase(deleteWordOptimistic.pending, (state, action) => {
        state.loadingStatus = 'loading';
        state.error = null;

        const wordIdToRemove = action.meta.arg;
        const index = state.words.findIndex(w => w.id === wordIdToRemove);

        if (index !== -1) {
          const removedWord = state.words[index];
          state.rollbackData[action.meta.requestId] = {
            word: removedWord,
            index,
          };
          state.words.splice(index, 1);

          decrementStatsForWord(state.stats, removedWord);

          // Знецінюємо відповіді списку, що вже летять: інакше stale-відповідь
          // поверне щойно видалене слово назад у список.
          bumpDictionaryDataVersion();
        }
      })
      .addCase(deleteWordOptimistic.fulfilled, (state, action) => {
        state.loadingStatus = 'idle';
        delete state.rollbackData[action.meta.requestId];
      })
      .addCase(deleteWordOptimistic.rejected, (state, action) => {
        state.loadingStatus = 'idle';
        state.error = 'Не вдалося видалити слово';

        const data = state.rollbackData[action.meta.requestId];
        if (data) {
          state.words.splice(data.index, 0, data.word);
          delete state.rollbackData[action.meta.requestId];

          incrementStatsForWord(state.stats, data.word);
        }
      })

      .addCase(resetProgressOptimistic.pending, (state, action) => {
        state.loadingStatus = 'loading';
        state.error = null;

        const wordIdToReset = action.meta.arg;
        const index = state.words.findIndex(w => w.id === wordIdToReset);

        if (index !== -1) {
          const wordBeingReset = state.words[index];
          state.rollbackData[action.meta.requestId] = {
            word: wordBeingReset,
            index,
          };
          state.words.splice(index, 1);

          const previousStatus = getWordStatus(wordBeingReset);
          applyResetToStats(state.stats, previousStatus);

          bumpDictionaryDataVersion();
        }
      })
      .addCase(resetProgressOptimistic.fulfilled, (state, action) => {
        state.loadingStatus = 'idle';
        delete state.rollbackData[action.meta.requestId];
      })
      .addCase(resetProgressOptimistic.rejected, (state, action) => {
        state.loadingStatus = 'idle';
        state.error = 'Не вдалося скинути прогрес';

        const data = state.rollbackData[action.meta.requestId];
        if (data) {
          state.words.splice(data.index, 0, data.word);
          delete state.rollbackData[action.meta.requestId];

          const previousStatus = getWordStatus(data.word);
          revertResetStatsAdjustment(state.stats, previousStatus);
        }
      });
  },
});

export const {
  setWords,
  setLoading,
  appendWords,
  prependUserWord,
  wordAddedToDictionary,
  triggerRefresh,
  setSearchQuery,
  setStatus,
  setType,
  setPage,
  setDictionaryLevel,
  resetDictionaryView,
  showAddedWordInDictionary,
  setStats,
  updateWordLocalData,
} = wordsSlice.actions;

export default wordsSlice.reducer;