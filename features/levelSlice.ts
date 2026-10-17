import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface LevelState {
  selectedLevel: string | null;
}

const initialState: LevelState = {
  selectedLevel: null,
};

const levelSlice = createSlice({
  name: "level",
  initialState,
  reducers: {
    setLevel: (state, action: PayloadAction<string>) => {
      state.selectedLevel = action.payload;
    },
    resetLevel: (state) => {
      state.selectedLevel = null;
    },
  },
});

export const { setLevel, resetLevel } = levelSlice.actions;
export default levelSlice.reducer;
