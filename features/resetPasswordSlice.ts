import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { resetPassword } from '../services/authService';

interface ResetPasswordState {
  email: string;
  code: string;
  newPassword: string;
  status: 'idle' | 'loading' | 'succeeded' | 'failed';
  error: string | null;
}

const initialState: ResetPasswordState = {
  email: '',
  code: '',
  newPassword: '',
  status: 'idle',
  error: null,
};

// Async thunk — відправка на бекенд
export const submitResetPassword = createAsyncThunk(
  'resetPassword/submit',
  async (_, { getState, rejectWithValue }) => {
    const state = getState() as { resetPassword: ResetPasswordState };
    const { email, code, newPassword } = state.resetPassword;

    try {
      const response = await resetPassword({ email, code, newPassword });
      return response;
    } catch (error: any) {
      return rejectWithValue(error.response?.data?.message || 'Reset failed');
    }
  }
);

const resetPasswordSlice = createSlice({
  name: 'resetPassword',
  initialState,
  reducers: {
    setEmail(state, action) {
      state.email = action.payload;
    },
    setCode(state, action) {
      state.code = action.payload;
    },
    setNewPassword(state, action) {
      state.newPassword = action.payload;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(submitResetPassword.pending, state => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(submitResetPassword.fulfilled, state => {
        state.status = 'succeeded';
      })
      .addCase(submitResetPassword.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload as string;
      });
  },
});

export const { setEmail, setCode, setNewPassword } = resetPasswordSlice.actions;

export default resetPasswordSlice.reducer;
