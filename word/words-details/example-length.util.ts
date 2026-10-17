/**
 * Спільна утиліта для жорсткого обмеження довжини AI-згенерованих
 * прикладів речень (поле "examples" у Word).
 *
 * ⚠️ ВАЖЛИВО: OpenAI structured outputs (response_format: json_schema,
 * strict: true) НЕ гарантовано підтримують ключове слово "maxLength"
 * для рядків у строгому режимі — модель може його ігнорувати. Тому
 * реальне жорстке обмеження в 45 символів забезпечується НЕ схемою,
 * а цією утилітою: вона застосовується як обов'язковий пост-процесинг
 * після кожної відповіді AI, незалежно від того, що написано в промпті.
 */

export const MAX_EXAMPLE_LENGTH = 45;

/**
 * Обрізає рядок до ліміту символів (включно з пробілами й розділовими
 * знаками), намагаючись не розривати слово посередині: якщо пробіл
 * знайдено в другій половині доступного ліміту — ріжемо по ньому,
 * інакше ріжемо жорстко по символах.
 */
export function truncateExampleToLimit(
  text: string,
  limit: number = MAX_EXAMPLE_LENGTH,
): string {
  const trimmed = (text ?? '').toString().trim();
  if (trimmed.length <= limit) return trimmed;

  const hardCut = trimmed.slice(0, limit);
  const lastSpace = hardCut.lastIndexOf(' ');

  // Ріжемо по слову, лише якщо це не викидає забагато тексту
  // (інакше короткі приклади ставали б надто куцими).
  if (lastSpace > limit * 0.5) {
    return hardCut.slice(0, lastSpace).trim();
  }

  return hardCut.trim();
}

/**
 * Перевіряє, що рядок непорожній і вкладається у ліміт довжини.
 */
export function isWithinExampleLimit(
  text: unknown,
  limit: number = MAX_EXAMPLE_LENGTH,
): boolean {
  return typeof text === 'string' && text.trim().length > 0 && text.trim().length <= limit;
}

/**
 * Приводить будь-який масив (можливо, некоректний за формою) до
 * гарантовано валідного масиву з РІВНО 6 рядків, кожен з яких
 * вкладається у ліміт довжини. Використовується як аварійний
 * запобіжник, коли AI навіть після ретраїв не повернув коректний
 * результат — краще неідеальний, але короткий приклад, ніж збій.
 */
export function enforceExampleArrayConstraints(
  examples: unknown,
  limit: number = MAX_EXAMPLE_LENGTH,
  expectedCount = 6,
): string[] {
  const raw = Array.isArray(examples) ? examples.map((e) => String(e ?? '')) : [];
  const safe = raw.slice(0, expectedCount).map((e) => truncateExampleToLimit(e, limit));

  while (safe.length < expectedCount) {
    safe.push('');
  }

  return safe;
}