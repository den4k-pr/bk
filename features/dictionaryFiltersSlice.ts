import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface DictionarySourceFilters {
  bookIds: string[];
  packages: boolean;
  manual: boolean;
  favoritesOnly: boolean;
  /** Рівні слів (A1…C2); [] — усі рівні. */
  levels: string[];
  label: string | null;
}

const initialState: DictionarySourceFilters = {
  bookIds: [],
  packages: false,
  manual: false,
  favoritesOnly: false,
  levels: [],
  label: null,
};

const dictionaryFiltersSlice = createSlice({
  name: 'dictionaryFilters',
  initialState,
  reducers: {
    setDictionaryFilters: (state, action: PayloadAction<DictionarySourceFilters>) => {
      state.bookIds = action.payload.bookIds;
      state.packages = action.payload.packages;
      state.manual = action.payload.manual;
      state.favoritesOnly = action.payload.favoritesOnly;
      state.levels = action.payload.levels ?? [];
      state.label = action.payload.label;
    },
    resetDictionaryFilters: (state) => {
      state.bookIds = [];
      state.packages = false;
      state.manual = false;
      state.favoritesOnly = false;
      state.levels = [];
      state.label = null;
    },
  },
});

export const { setDictionaryFilters, resetDictionaryFilters } = dictionaryFiltersSlice.actions;
export default dictionaryFiltersSlice.reducer;