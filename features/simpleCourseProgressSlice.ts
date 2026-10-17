import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { VideoItem } from '../types/courseVideo';

interface SimpleProgressState {
  href: 'ComponentOfVideoSimple' | null;
  videoData: VideoItem | null;
}

const initialState: SimpleProgressState = {
  href: null,
  videoData: null,
};

const simpleCourseProgressSlice = createSlice({
  name: 'simpleCourseProgress',
  initialState,
  reducers: {
    setSimpleProgress: (state, action: PayloadAction<Partial<SimpleProgressState>>) => {
      Object.assign(state, action.payload);
    },
    resetSimpleProgress: (state) => {
      state.href = null;
      state.videoData = null;
    }
  }
});

export const { setSimpleProgress, resetSimpleProgress } = simpleCourseProgressSlice.actions;
export default simpleCourseProgressSlice.reducer;