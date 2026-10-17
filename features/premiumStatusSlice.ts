import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { getPremiumStatus, PremiumStatusResponse } from '../services/subscriptionService';

interface PremiumStatusState {
  isPremium: boolean;
  plan: 'monthly' | 'yearly' | null;
  expiresAt: string | null;
  autoRenew: boolean;
  pendingPlan: 'monthly' | 'yearly' | null;
  /** Преміум дає лише бонусний місяць за купівлю курсу. */
  isBonus: boolean;
  status: 'idle' | 'loading' | 'succeeded' | 'failed';
}

const initialState: PremiumStatusState = {
  isPremium: false,
  plan: null,
  expiresAt: null,
  autoRenew: false,
  pendingPlan: null,
  isBonus: false,
  status: 'idle',
};

// 🟢 Єдине джерело правди для преміум-статусу в усьому застосунку.
// Наповнюється РІВНО тим самим ендпоінтом (/users/premium-status), який
// вже використовує Membership.tsx — тому будь-яке місце, що читає
// state.premiumStatus, завжди узгоджене з тим, що бачить юзер на екрані
// підписки. Раніше useInterstitialAd читав окреме поле state.user.userDate
// (someDate на бекенді) — воно НЕ повʼязане з оплаченою підпискою і
// призводило до того, що реклама вмикалась/вимикалась за неправильною
// ознакою.
// Лічильник змін акаунта: відповідь, запитана ще попереднім акаунтом, але
// отримана вже після виходу, відкидається (інакше його преміум «повертався»).
let accountEpoch = 0;
export const bumpPremiumAccountEpoch = () => {
  accountEpoch += 1;
};

export const fetchPremiumStatus = createAsyncThunk('premiumStatus/fetch', async () => {
  const epoch = accountEpoch;
  const status = await getPremiumStatus();
  if (epoch !== accountEpoch) throw new Error('premium-status: відповідь для попереднього акаунта');
  return status;
});

const premiumStatusSlice = createSlice({
  name: 'premiumStatus',
  initialState,
  reducers: {
    setPremiumStatus(state, action: PayloadAction<PremiumStatusResponse>) {
      state.isPremium = action.payload.isPremium;
      state.plan = action.payload.plan;
      state.expiresAt = action.payload.expiresAt;
      state.autoRenew = action.payload.autoRenew;
      state.pendingPlan = action.payload.pendingPlan ?? null;
      state.isBonus = !!action.payload.isBonus;
      state.status = 'succeeded';
    },
    // 🔒 Вихід / зміна акаунта: преміум попереднього акаунта не повинен
    // «прилипнути» до наступного (rejected нижче навмисно зберігає старе
    // значення, тож без скидання при збої мережі реклама лишалась вимкненою).
    resetPremiumStatus() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchPremiumStatus.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchPremiumStatus.fulfilled, (state, action) => {
        state.isPremium = action.payload.isPremium;
        state.plan = action.payload.plan;
        state.expiresAt = action.payload.expiresAt;
        state.autoRenew = action.payload.autoRenew;
        state.pendingPlan = action.payload.pendingPlan ?? null;
        state.isBonus = !!action.payload.isBonus;
        state.status = 'succeeded';
      })
      .addCase(fetchPremiumStatus.rejected, (state) => {
        // 🟢 Навмисно НЕ скидаємо isPremium в false при помилці мережі —
        // якщо запит на /users/premium-status тимчасово не пройшов
        // (наприклад, немає інтернету на старті застосунку), не хочемо
        // раптово почати показувати рекламу вже оплаченому користувачу
        // лише через мережевий збій. Лишаємо попереднє відоме значення.
        state.status = 'failed';
      });
  },
});

export const { setPremiumStatus, resetPremiumStatus } = premiumStatusSlice.actions;
export default premiumStatusSlice.reducer;