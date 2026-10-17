/**
 * videoPositionStore.ts
 *
 * In-memory сховище позиції відтворення відео для Просунутих курсів.
 * Ключ — courseId:taskId:stepId. Дозволяє відновити позицію, навіть якщо
 * компонент відео був розмонтований і змонтований знову (перехід між
 * вкладками, повторне створення плеєра після помилки тощо).
 *
 * Сховище ЛИШЕ в пам'яті JS-рушія: повне закриття застосунку (kill)
 * очищає його автоматично — саме так, як і задумано (reset при kill
 * допустимий; backgrounding та внутрішня навігація зберігають стан).
 */

const positions = new Map<string, number>();

// Обмеження, щоб сховище позицій не росло безкінечно за довгу сесію
// (кожен переглянутий курс/задача/крок — окремий ключ).
const MAX_POSITIONS = 200;

const keyOf = (courseId: number, taskId: number, stepId: number): string =>
  `${courseId}:${taskId}:${stepId}`;

export function saveVideoPosition(
  courseId: number,
  taskId: number,
  stepId: number,
  seconds: number,
): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;

  const key = keyOf(courseId, taskId, stepId);
  // Перевставляємо ключ, щоб оновити його «свіжість» (як у LRU).
  positions.delete(key);
  positions.set(key, seconds);

  if (positions.size > MAX_POSITIONS) {
    const oldestKey = positions.keys().next().value;
    if (oldestKey !== undefined) positions.delete(oldestKey);
  }
}

export function getVideoPosition(courseId: number, taskId: number, stepId: number): number {
  return positions.get(keyOf(courseId, taskId, stepId)) ?? 0;
}

export function clearVideoPosition(courseId: number, taskId: number, stepId: number): void {
  positions.delete(keyOf(courseId, taskId, stepId));
}
