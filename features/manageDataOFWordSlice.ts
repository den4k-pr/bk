import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { addSimpleWord } from '../services/wordService';
import { UserWord, WordType } from '../types/words';
import { syncService } from './requestQueue';

// ─────────────────────────────────────────────
// Thunks
// ─────────────────────────────────────────────

export const deleteDataOptimistic = createAsyncThunk(
  'manageDataOFWord/deleteData',
  async (userWordId: number) => {
    return await syncService.enqueueDelete(userWordId);
  },
);

export const resetProgressDataOptimistic = createAsyncThunk(
  'manageDataOFWord/resetProgress',
  async (userWordId: number) => {
    return await syncService.enqueueReset(userWordId);
  },
);

export const addDataOptimistic = createAsyncThunk(
  'manageDataOFWord/addData',
  async (word: WordType, { rejectWithValue }) => {
    try {
      return await addSimpleWord(word.text, undefined, word.id);
    } catch (error: any) {
      return rejectWithValue(error.message as string);
    }
  },
);

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

interface ManageDataOFWordState {
  data: UserWord[];
  loadingStatus: 'idle' | 'loading' | 'failed';
  error: string | null;
  refreshTrigger: number;
  refreshListTrigger: number;
  searchQuery: string;
  status: 'all' | 'new' | 'learning' | 'learned';
  page: number;
  /**
   * rollbackData — зберігає snapshot для відкату.
   * Ключ — requestId щоб підтримувати паралельні операції
   * (оригінал зберігав лише один запис — при паралельному delete/reset
   * другий запит перезаписував rollbackData першого).
   */
  rollbackData: Record<string, { item: UserWord; index: number }>;
}

const initialState: ManageDataOFWordState = {
  data: [],
  loadingStatus: 'idle',
  error: null,
  refreshTrigger: 0,
  refreshListTrigger: 0,
  searchQuery: '',
  status: 'new',
  page: 1,
  rollbackData: {},
};

// ─────────────────────────────────────────────
// Slice
// ─────────────────────────────────────────────

const manageDataOFWordSlice = createSlice({
  name: 'manageDataOFWord',
  initialState,
  reducers: {
    setData(state, action: PayloadAction<UserWord[]>) {
      state.data = action.payload;
    },

    appendData(state, action: PayloadAction<UserWord[]>) {
      const existingIds = new Set(state.data.map(item => item.id));
      const newUniqueItems = action.payload.filter(item => !existingIds.has(item.id));
      if (newUniqueItems.length > 0) {
        state.data.push(...newUniqueItems);
      }
    },

    setLoading(state, action: PayloadAction<'idle' | 'loading' | 'failed'>) {
      state.loadingStatus = action.payload;
    },

    triggerRefresh(state) {
      state.refreshTrigger += 1;
    },

    triggerRefreshList(state) {
      state.refreshListTrigger += 1;
    },

    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
      state.page = 1;
    },

    setStatus(
      state,
      action: PayloadAction<'all' | 'new' | 'learning' | 'learned'>,
    ) {
      state.status = action.payload;
      state.page = 1;
    },

    setPage(state, action: PayloadAction<number>) {
      state.page = action.payload;
    },
  },

  extraReducers: builder => {
    builder

      // ── ADD ───────────────────────────────────

      .addCase(addDataOptimistic.pending, state => {
        state.loadingStatus = 'loading';
        state.error = null;
      })
      .addCase(
        addDataOptimistic.fulfilled,
        (state, action: PayloadAction<UserWord>) => {
          const alreadyExists = state.data.some(item => item.id === action.payload.id);
          if (!alreadyExists) {
            state.data.unshift(action.payload);
          }
          state.loadingStatus = 'idle';
        },
      )
      .addCase(addDataOptimistic.rejected, (state, action) => {
        state.loadingStatus = 'failed';
        state.error = action.payload as string ?? 'Не вдалося додати';
      })

      // ── DELETE (Optimistic) ───────────────────

      .addCase(deleteDataOptimistic.pending, (state, action) => {
        state.loadingStatus = 'loading';
        state.error = null;

        const idToRemove = action.meta.arg;
        const index = state.data.findIndex(item => item.id === idToRemove);

        if (index !== -1) {
          state.rollbackData[action.meta.requestId] = {
            item: state.data[index],
            index,
          };
          state.data.splice(index, 1);
        }
      })
      .addCase(deleteDataOptimistic.fulfilled, (state, action) => {
        state.loadingStatus = 'idle';
        delete state.rollbackData[action.meta.requestId];
      })
      .addCase(deleteDataOptimistic.rejected, (state, action) => {
        state.loadingStatus = 'idle';
        state.error = `Не вдалося видалити: ${action.error.message}`;

        const data = state.rollbackData[action.meta.requestId];
        if (data) {
          state.data.splice(data.index, 0, data.item);
          delete state.rollbackData[action.meta.requestId];
        }
      })

      // ── RESET PROGRESS (Optimistic) ───────────

      .addCase(resetProgressDataOptimistic.pending, (state, action) => {
        state.loadingStatus = 'loading';
        state.error = null;

        const idToReset = action.meta.arg;
        const index = state.data.findIndex(item => item.id === idToReset);

        if (index !== -1) {
          state.rollbackData[action.meta.requestId] = {
            item: state.data[index],
            index,
          };

          // Якщо фільтр по активних статусах — просто видаляємо зі списку,
          // бо після reset слово буде 'new' і не пройде поточний фільтр.
          if (state.status === 'learning' || state.status === 'learned') {
            state.data.splice(index, 1);
          } else {
            // Інакше — показуємо оновлений статус одразу
            state.data[index] = {
              ...state.data[index],
              status: 'new' as const,
              progress: 0,
            };
          }
        }
      })
      .addCase(resetProgressDataOptimistic.fulfilled, (state, action) => {
        state.loadingStatus = 'idle';
        delete state.rollbackData[action.meta.requestId];
      })
      .addCase(resetProgressDataOptimistic.rejected, (state, action) => {
        state.loadingStatus = 'idle';
        state.error = `Не вдалося скинути прогрес: ${action.error.message}`;

        const data = state.rollbackData[action.meta.requestId];
        if (data) {
          // Видаляємо некоректно оновлений елемент (якщо він ще є)
          const currentIndex = state.data.findIndex(item => item.id === data.item.id);
          if (currentIndex !== -1) {
            state.data.splice(currentIndex, 1);
          }
          // Повертаємо оригінал на місце
          state.data.splice(data.index, 0, data.item);
          delete state.rollbackData[action.meta.requestId];
        }
      });
  },
});

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export const {
  setData,
  appendData,
  setLoading,
  triggerRefresh,
  triggerRefreshList,
  setSearchQuery,
  setStatus,
  setPage,
} = manageDataOFWordSlice.actions;

export default manageDataOFWordSlice.reducer;