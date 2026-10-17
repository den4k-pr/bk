import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface QueueState {
  isProcessing: boolean;
  isCoolingDown: boolean;
}

const initialState: QueueState = {
  isProcessing: false,
  isCoolingDown: false,
};

const queueSlice = createSlice({
  name: "queue",
  initialState,
  reducers: {
    setProcessing(state, action: PayloadAction<boolean>) {
      state.isProcessing = action.payload;
    },
    setCoolingDown(state, action: PayloadAction<boolean>) {
      state.isCoolingDown = action.payload;
    },
  },
});

export const { setProcessing, setCoolingDown } = queueSlice.actions;
export default queueSlice.reducer;
