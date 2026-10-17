/**
 * courseQuickSession.ts
 *
 * Аналог bookReaderQuickSession, але для Просунутих курсів (Advanced).
 * Запам'ятовує, на якому саме уроці (courseId / taskId / stepId) зупинився
 * користувач, щоб при поверненні на вкладку «Курс» через нижнє меню ми
 * відновлювали TasksPage (відео/аудіо/PDF) замість того, щоб скидати
 * користувача на список курсів (а раніше — фактично на головний екран).
 *
 * Сховище in-memory: повне закриття застосунку (kill) природно очищає його,
 * що відповідає вимозі «reset при kill допустимий».
 */

export type CourseQuickSessionSnapshot =
  | { kind: 'advanced'; courseId: number; taskId: number; stepId: number }
  | { kind: 'simple'; categoryId: number; videoId: number | null };

interface LiveCoursePointer {
  getSnapshot: () => CourseQuickSessionSnapshot | null;
}

// Великий TTL — фактично «назавжди» в межах сесії застосунку: футер «Курс»
// має вертати на останнє переглянуте відео, а не скидати на початок.
const QUICK_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

let livePointer: LiveCoursePointer | null = null;
let storedSession: { snapshot: CourseQuickSessionSnapshot; capturedAt: number } | null = null;

export function registerLiveCoursePointer(pointer: LiveCoursePointer): void {
  livePointer = pointer;
}

export function unregisterLiveCoursePointer(pointer: LiveCoursePointer): void {
  if (livePointer === pointer) {
    livePointer = null;
  }
}

export function captureCourseQuickSession(): void {
  if (!livePointer) return;

  const snapshot = livePointer.getSnapshot();
  if (!snapshot) return;

  storedSession = { snapshot, capturedAt: Date.now() };
}

export function consumeCourseQuickSession(): CourseQuickSessionSnapshot | null {
  if (!storedSession) return null;

  const { snapshot, capturedAt } = storedSession;
  storedSession = null;

  if (Date.now() - capturedAt >= QUICK_SESSION_TTL_MS) {
    return null;
  }

  return snapshot;
}

export function clearCourseQuickSession(): void {
  storedSession = null;
}
