import { deleteUserWordsBatch, resetSingleWordProgress } from '../services/wordService'; // 🟢 Замінили resetUserProgressBatch на новий сервіс
import { triggerRefresh } from '../features/manageDataOFWordSlice';
import { AppDispatch } from '../../store'; // Імпортуємо тільки тип
import { notifyDictionaryWordsMutated } from '../services/dictionaryMutationBus';

// === Зберігаємо dispatch у локальній змінній ===
let dispatch: AppDispatch | null = null;

/**
 * Ця функція має бути викликана один раз при старті додатку,
 * щоб передати dispatch в цей файл.
 */
export const setupQueue = (storeDispatch: AppDispatch) => {
  dispatch = storeDispatch;
};


type ThunkPromise = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

const BATCH_DELAY = 2000;

// ================== ЧЕРГА ДЛЯ ВИДАЛЕННЯ ==================
let deleteQueue: Map<number, ThunkPromise> = new Map();
let deleteTimeoutId: any = null;

const flushDeleteQueue = async () => {
  if (deleteQueue.size === 0) return;
  const batch = new Map(deleteQueue);
  deleteQueue.clear();
  const idsToDelete = Array.from(batch.keys());
  
  try {
    await deleteUserWordsBatch(idsToDelete);
    batch.forEach(promise => promise.resolve(true));
    // triggerRefresh нижче — з іншого слайса (manageDataOFWordSlice) і список
    // Словника не перечитує; Словник слухає шину змін.
    notifyDictionaryWordsMutated();

    // ОНОВЛЕНО: Використовуємо dispatch, який ми отримали через setupQueue
    if (dispatch) {
      dispatch(triggerRefresh());
      console.log(`[Queue] Batch deletion successful. Refresh triggered.`);
    }

  } catch (error) {
    batch.forEach(promise => promise.reject(error));
    console.error(`[Queue] Batch deletion failed.`, error);
  }
};

export const scheduleDeletion = (userWordId: number, promise: ThunkPromise) => {
  deleteQueue.set(userWordId, promise);
  if (deleteTimeoutId) clearTimeout(deleteTimeoutId);
  deleteTimeoutId = setTimeout(flushDeleteQueue, BATCH_DELAY);
};


// ================== ЧЕРГА ДЛЯ СКИДАННЯ ПРОГРЕСУ ==================
let resetQueue: Map<number, ThunkPromise> = new Map();
let resetTimeoutId: any = null;

const flushResetQueue = async () => {
  if (resetQueue.size === 0) return;
  const batch = new Map(resetQueue);
  resetQueue.clear();
  const idsToReset = Array.from(batch.keys());

  try {
    // 🟢 Замість пакетного запиту, викликаємо новий точковий ендпоінт для кожного id паралельно.
    // Це гарантує очищення кешу для кожного слова на бекенді і не ламає логіку черги на фронтенді.
    await Promise.all(idsToReset.map(id => resetSingleWordProgress(id)));
    
    batch.forEach(promise => promise.resolve(true));
    notifyDictionaryWordsMutated();

    if (dispatch) {
      dispatch(triggerRefresh());
      console.log(`[Queue] Single-word progress resets executed successfully. Refresh triggered.`);
    }

  } catch (error) {
    batch.forEach(promise => promise.reject(error));
    console.error(`[Queue] Progress reset execution failed.`, error);
  }
};

export const scheduleReset = (userWordId: number, promise: ThunkPromise) => {
  resetQueue.set(userWordId, promise);
  if (resetTimeoutId) clearTimeout(resetTimeoutId);
  resetTimeoutId = setTimeout(flushResetQueue, BATCH_DELAY);
};