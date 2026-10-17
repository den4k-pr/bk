import { AppState, AppStateStatus } from 'react-native';
import { 
  updateUserWordProgressBatch, 
  deleteUserWord, 
  resetUserWordProgress 
} from '../services/wordService';
import { enqueueProgramProgress, flushProgressOutbox } from '../services/progressOutbox';

type TaskType = 'update' | 'delete' | 'reset';

interface QueueTask {
  id: number;
  type: TaskType;
  payload?: any;
  timestamp: number;
}

class SyncService {
  private queue: QueueTask[] = [];
  private isProcessing = false;
  private debounceTimer: any = null;
  private readonly FLUSH_THRESHOLD = 5; // Кількість запитів для миттєвого спуску
  private readonly DEBOUNCE_MS = 2000;  // Максимальне очікування

  constructor() {
    // Слухач стану додатка (автоматичний запис при виході)
    AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState.match(/inactive|background/)) {
        this.flushSyncQueue();
      }
    });
  }

  // Публічні методи (інтерфейс збережено)
  
  /**
   * Прогрес карток іде через надійну чергу (progressOutbox): зберігається на
   * пристрої, надсилається послідовно і повторюється при збоях мережі/5xx.
   * Раніше помилка запиту мовчки губила відповідь.
   */
  public enqueue(words: { id: number; userWordId?: number | null; progress: any; partial?: boolean }[]) {
    enqueueProgramProgress(
      words.map(w => ({
        id: w.id,
        userWordId: w.userWordId ?? null,
        progress: w.progress,
        ...(w.partial ? { partial: true } : {}),
      })),
    ).catch(() => {});
  }

  public async enqueueDelete(id: number) {
    this.addToQueue({ id, type: 'delete' });
    this.planFlush();
  }

  public async enqueueReset(id: number) {
    this.addToQueue({ id, type: 'reset' });
    this.planFlush();
  }

  // Приватна логіка
  
  private addToQueue(task: Omit<QueueTask, 'timestamp'>) {
    // Дедуплікація: якщо це оновлення (update), видаляємо старе таке саме завдання з черги
    if (task.type === 'update') {
      this.queue = this.queue.filter(t => !(t.id === task.id && t.type === 'update'));
    }
    
    this.queue.push({ ...task, timestamp: Date.now() });
  }

  private planFlush() {
    // 1. Якщо черга велика — очищуємо негайно
    if (this.queue.length >= this.FLUSH_THRESHOLD) {
      this.flushSyncQueue();
      return;
    }

    // 2. Якщо маленька — ставимо таймер (debounce)
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushSyncQueue();
    }, this.DEBOUNCE_MS);
  }

 // В середині класу SyncService
private currentFlushPromise: Promise<void> | null = null;

public flushSyncQueue = async () => {
  await flushProgressOutbox();
  // Нижче — стара черга (лишилась для сумісності; update-записи сюди вже не йдуть).
  // Якщо вже йде запит, чекаємо саме його, а не виходимо просто так
  if (this.isProcessing && this.currentFlushPromise) {
    return this.currentFlushPromise;
  }
  
  if (this.queue.length === 0) return;

  this.isProcessing = true;
  
  // Створюємо проміс поточної операції
  this.currentFlushPromise = (async () => {
    const currentBatch = [...this.queue];
    this.queue = [];

    try {
      const updates = currentBatch.filter(t => t.type === 'update');
      if (updates.length > 0) {
        await updateUserWordProgressBatch(
          updates.map(u => ({ id: u.id, progress: u.payload }))
        );
      }
      // Раніше видалення/скидання з цієї черги мовчки викидались (тут
      // стояла заглушка) — завдання "виконувалось", а на сервер не йшло.
      for (const task of currentBatch) {
        if (task.type === 'delete') await deleteUserWord(task.id);
        else if (task.type === 'reset') await resetUserWordProgress(task.id);
      }
    } catch (error) {
      this.queue = [...currentBatch, ...this.queue];
      throw error;
    } finally {
      this.isProcessing = false;
      this.currentFlushPromise = null;
    }
  })();

  return this.currentFlushPromise;
};
}

// Експортуємо екземпляр
export const syncService = new SyncService();

// Для зворотної сумісності, якщо десь викликається функція напряму
export const flushSyncQueue = () => syncService.flushSyncQueue();