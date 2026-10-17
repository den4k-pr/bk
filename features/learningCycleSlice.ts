// src/features/learningCycleSlice.ts

import { createSlice } from '@reduxjs/toolkit';
// Переконайтесь, що ці типи імпортуються правильно з вашого store
import { AppDispatch, RootState } from '../../store'; 

interface LearningCycleState {
  completedCycles: number;
}

const initialState: LearningCycleState = {
  completedCycles: 0,
};

const learningCycleSlice = createSlice({
  name: 'learningCycle',
  initialState,
  reducers: {
    // Ця дія просто збільшує лічильник. Вона буде приватною для нашого thunk.
    incrementCompletedCycles(state) {
      state.completedCycles += 1;
    },
  },
});

// Експортуємо лише приватну дію
export const { incrementCompletedCycles } = learningCycleSlice.actions;
export default learningCycleSlice.reducer;


export const completeCycleAndShowAdIfNeeded = (showAd: () => Promise<void>) => // ✅ Тип showAd змінено
  async (dispatch: AppDispatch, getState: () => RootState) => {

    dispatch(incrementCompletedCycles());
    const { completedCycles } = getState().learningCycle;
    console.log(`Цикл завершено. Загальна кількість: ${completedCycles}`);

    if (completedCycles > 0 && completedCycles % 3 === 0) {
      console.log(`🎯 Умову виконано (${completedCycles})! Спроба показати рекламу.`);
      // ✅ Додано await: thunk буде "чекати", поки реклама не закриється
      await showAd(); 
    }
};